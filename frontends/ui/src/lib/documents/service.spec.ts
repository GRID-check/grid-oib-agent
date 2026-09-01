import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/storage/service', () => ({
  // The quota check is exercised in src/lib/storage/service.spec.ts; here it is
  // stubbed to a no-op so these specs keep testing the upload path itself
  // rather than reaching Postgres for org settings.
  assertWithinStorageQuota: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(),
}))

// Clients doubled, key builders real. `buildStorageKey` used to be stubbed to
// a fabricated `'org/proj/doc/file.pdf'` that the production builder has never
// produced, which meant this suite could not have caught a key-layout
// regression — the exact class of bug that makes an object unreachable.
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: vi.fn().mockResolvedValue(undefined) },
  signingS3Client: { send: vi.fn().mockResolvedValue(undefined) },
  bucketAdminS3Client: { send: vi.fn().mockResolvedValue(undefined) },
  bucketName: 'test-bucket',
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://seaweedfs.internal/presigned'),
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

// The server-side allow-list consults the derived VLM capability. Mock it so
// tests drive the (flag × capability) matrix directly, without a backend probe.
vi.mock('@/lib/documents/vlm-capability', () => ({
  isVlmConfigured: vi.fn().mockResolvedValue(false),
}))

// The admitting insert, not the repository's. Recording a document now goes
// through `admitOrDiscard`, which applies the organization's quota in the same
// transaction as the insert and deletes the just-written object if it refuses
// (ADR-0042). Asserting on it here keeps these tests about WHAT would be
// recorded; the admission and compensation behaviour has its own spec.
vi.mock('@/lib/storage/admission', () => ({
  admitOrDiscard: vi.fn().mockResolvedValue(undefined),
  admitReplacementOrDiscard: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./repository', () => ({
  setDocumentIngestJob: vi.fn().mockResolvedValue(undefined),
  markDocumentIngestFailed: vi.fn().mockResolvedValue(undefined),
  findFolderPathInProject: vi.fn().mockResolvedValue(null),
  findDocumentInOrg: vi.fn(),
  // Default: no collision, so the upload path is the insert path it has always
  // been. The replace path is driven per-test.
  findLiveDocumentByFilename: vi.fn().mockResolvedValue(null),
  listProjectDocuments: vi.fn(),
  deleteProjectDocument: vi.fn().mockResolvedValue(undefined),
  setDocumentDisplayName: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./reconcile-status', () => ({
  reconcileDocumentStatuses: vi.fn(),
}))

import { findProjectInOrg } from '@/lib/projects/repository'
import { requireProjectAccess } from '@/lib/authz/projects'
import { recordAuditEvent } from '@/lib/audit/service'
import { admitOrDiscard, admitReplacementOrDiscard } from '@/lib/storage/admission'
import {
  setDocumentIngestJob,
  markDocumentIngestFailed,
  findDocumentInOrg,
  findLiveDocumentByFilename,
  findFolderPathInProject,
  listProjectDocuments,
  deleteProjectDocument,
  setDocumentDisplayName,
} from './repository'
import {
  listDocuments,
  uploadDocument,
  reingestDocument,
  deleteDocument,
  renameDocument,
  getDocumentStatus,
  getDocumentVisualDetails,
  updateDocumentTags,
  reindexProject,
  searchProjectDocuments,
  joinHitsToFiles,
  deriveSearchTopK,
  dispatchDocument,
  getDocumentTextPreview,
  AgentAuthoredDocumentNotIndexableError,
  INGEST_DISPATCH_FAILED_MESSAGE,
} from './service'
import {
  reconcileDocumentStatuses,
  type DocumentMetadata,
  type ReconcilableDocument,
} from './reconcile-status'
import type { DocumentListRow } from './repository'
import { isVlmConfigured } from '@/lib/documents/vlm-capability'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { makeDocument, makeProject } from '@/test-utils/db-fixtures'
import { s3Client, bucketAdminS3Client } from '@/lib/s3'
import { __resetBucketCache, tenantBucketName } from '@/lib/storage/bucket'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { AuthorizedSession } from '@/lib/auth/types'

const session: AuthorizedSession = {
  userId: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  accessToken: 'test-access-token',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const makeInput = (overrides: { name?: string; type?: string } = {}) => ({
  projectId: 'proj-1',
  folderId: null,
  file: {
    name: overrides.name ?? 'plan.pdf',
    type: overrides.type ?? 'application/pdf',
    size: 1234,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as unknown as File,
})

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  // happy-dom's crypto has no randomUUID; the id value is irrelevant here.
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'doc-uuid' })
  }
  mockFetch.mockReset()
  vi.mocked(findProjectInOrg).mockResolvedValue(makeProject())
  // `dispatchDocument` reads the row it is about to ingest and refuses when
  // there is none — the row always exists in production, because
  // `admitOrDiscard` commits it before the dispatch. A spec that leaves this
  // unmocked puts every upload path on a shape the application cannot produce,
  // and would have made the guard look breakable when it is not.
  vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('dispatchDocument reads the row, and needs one', () => {
  it('refuses a document whose row it cannot read', async () => {
    // The guard is an allow-list on a row that must EXIST. `if (row && …)` read
    // a missing row as permission to ingest — trusting the caller about the one
    // thing reading the row was meant to stop trusting them about. Unreachable
    // today (every path inserts before dispatching), which is exactly when a
    // default is cheap to fix and expensive to discover.
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)

    await expect(
      dispatchDocument({
        organizationId: 'org-1',
        projectId: 'proj-1',
        documentId: 'doc-vanished',
        filename: 'plan.pdf',
        storageKey: 'k',
        storageBucket: 'b',
        collectionName: 'proj_abc',
      })
    ).rejects.toBeInstanceOf(AgentAuthoredDocumentNotIndexableError)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('uploadDocument server-side type gate', () => {
  // Availability = image-upload flag AND VLM capability. The env accept-list is
  // irrelevant for images: these cases list them in env to prove it can't force
  // them in without the capability.
  it('rejects an image with a 400 when the image-upload flag is off (capability on)', async () => {
    vi.mocked(isVlmConfigured).mockResolvedValue(true)
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    const gatedSession = { ...session, featureFlags: [] }

    await expect(
      uploadDocument(
        gatedSession,
        makeInput({ name: 'photo.png', type: 'image/png' }),
        new Request('http://x')
      )
    ).rejects.toBeInstanceOf(BadRequestError)

    // Rejected before any storage/ingest side effects.
    expect(admitOrDiscard).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects an image when the capability is absent/unconfirmed even with the flag on (fail-closed)', async () => {
    // Explicit env images + flag on, but no VLM → still rejected. This is the
    // silent-failure hole the derived capability closes.
    vi.mocked(isVlmConfigured).mockResolvedValue(false)
    vi.stubEnv('FILE_UPLOAD_ACCEPTED_TYPES', '.pdf,.docx,.txt,.md,.png,.jpg,.jpeg')
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    const gatedSession = { ...session, featureFlags: ['image-upload'] }

    await expect(
      uploadDocument(
        gatedSession,
        makeInput({ name: 'photo.png', type: 'image/png' }),
        new Request('http://x')
      )
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(admitOrDiscard).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('accepts an image when the flag is on AND the VLM capability is confirmed', async () => {
    // No env opt-in needed — the capability alone (plus the flag) admits images.
    vi.mocked(isVlmConfigured).mockResolvedValue(true)
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    const gatedSession = { ...session, featureFlags: ['image-upload'] }
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-img' }),
    })

    const result = await uploadDocument(
      gatedSession,
      makeInput({ name: 'photo.png', type: 'image/png' }),
      new Request('http://x')
    )

    expect(result.status).toBe('pending')
    expect(admitOrDiscard).toHaveBeenCalled()
  })

  it('rejects a type outside the accepted list regardless of flags (general allow-list)', async () => {
    // Enforcement off (default) → image-upload fails open, but .exe is still
    // not in the accepted-types list, so the server rejects it.
    await expect(
      uploadDocument(
        session,
        makeInput({ name: 'malware.exe', type: 'application/octet-stream' }),
        new Request('http://x')
      )
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(admitOrDiscard).not.toHaveBeenCalled()
  })
})

/**
 * Per-organization buckets (ADR-0043). Three separate things have to hold, and
 * all three were provably untested before this block existed: the bytes go to
 * the tenant bucket, the ROW records which bucket that was, and the ingest
 * dispatch presigns against the same one. Break any of them and the object is
 * written somewhere no read path will ever look — with no error at write time.
 */
describe('uploadDocument bucket selection', () => {
  beforeEach(() => {
    __resetBucketCache()
    vi.mocked(bucketAdminS3Client.send).mockResolvedValue(undefined as never)
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('writes to the shared bucket and records it when the feature is off', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'false')
    await uploadDocument(session, makeInput(), new Request('http://x'))

    const put = vi.mocked(s3Client.send).mock.calls.at(-1)![0] as unknown as {
      input: { Bucket: string }
    }
    expect(put.input.Bucket).toBe('test-bucket')
    expect(admitOrDiscard).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ storageBucket: 'test-bucket' })
    )
    // No bucket-lifecycle call at all — not even a HeadBucket.
    expect(bucketAdminS3Client.send).not.toHaveBeenCalled()
  })

  it('provisions and writes to the organization bucket when the feature is on', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    await uploadDocument(session, makeInput(), new Request('http://x'))

    const expected = tenantBucketName('org-1')
    // Provisioned with the LIFECYCLE credential, not the object one.
    expect(vi.mocked(bucketAdminS3Client.send)).toHaveBeenCalled()
    const put = vi.mocked(s3Client.send).mock.calls.at(-1)![0] as unknown as {
      input: { Bucket: string }
    }
    expect(put.input.Bucket).toBe(expected)
    expect(admitOrDiscard).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ storageBucket: expected })
    )
  })

  it('presigns the ingest download and the thumbnail slot against that same bucket', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    vi.mocked(getSignedUrl).mockClear()
    await uploadDocument(session, makeInput(), new Request('http://x'))

    const expected = tenantBucketName('org-1')
    const buckets = vi
      .mocked(getSignedUrl)
      .mock.calls.map((call) => (call[1] as unknown as { input: { Bucket: string } }).input.Bucket)
    // Both of them: the GET the backend reads from, and the PUT it writes the
    // thumbnail back to. A thumbnail written to the wrong bucket is invisible
    // to every read path AND survives the document's own deletion.
    expect(buckets.length).toBeGreaterThanOrEqual(2)
    expect(new Set(buckets)).toEqual(new Set([expected]))
  })
})

describe('uploadDocument ingest dispatch', () => {
  it('success path: uploaded -> pending with the backend job id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-42' }),
    })

    const result = await uploadDocument(session, makeInput(), new Request('http://x'))

    expect(result.status).toBe('pending')
    expect(result.jobId).toBe('job-42')
    expect(setDocumentIngestJob).toHaveBeenCalledWith(result.documentId, 'org-1', 'job-42')
    expect(markDocumentIngestFailed).not.toHaveBeenCalled()
    // Document is first inserted as 'uploaded' before the job id lands.
    expect(admitOrDiscard).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ status: 'uploaded' })
    )
  })

  it('dispatch throws: persists status failed + errorMessage', async () => {
    mockFetch.mockRejectedValue(new Error('network down'))

    const result = await uploadDocument(session, makeInput(), new Request('http://x'))

    expect(result.status).toBe('failed')
    expect(result.jobId).toBeNull()
    expect(markDocumentIngestFailed).toHaveBeenCalledWith(
      result.documentId,
      'org-1',
      INGEST_DISPATCH_FAILED_MESSAGE
    )
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })

  it('dispatch non-OK: persists status failed + errorMessage', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    })

    const result = await uploadDocument(session, makeInput(), new Request('http://x'))

    expect(result.status).toBe('failed')
    expect(result.jobId).toBeNull()
    expect(markDocumentIngestFailed).toHaveBeenCalledWith(
      result.documentId,
      'org-1',
      INGEST_DISPATCH_FAILED_MESSAGE
    )
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })
})

describe('uploadDocument ingest dispatch — backend fetch is time-bounded', () => {
  it('sends the ingest dispatch with an AbortSignal so a hung backend cannot stall the request', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-42' }),
    })

    await uploadDocument(session, makeInput(), new Request('http://x'))

    const ingestCall = mockFetch.mock.calls.find(([url]) => String(url).endsWith('/v1/ingest'))
    expect(ingestCall).toBeDefined()
    expect((ingestCall?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
    // The org id is forwarded so the backend can resolve the org's BYOK vision
    // credential + runtime model override for VLM captioning during ingestion.
    expect((ingestCall?.[1] as RequestInit).headers).toMatchObject({
      'x-grid-organization-id': 'org-1',
    })
  })

  it('a timeout abort fails open exactly like a network error (persists failed, no crash)', async () => {
    // AbortSignal.timeout() rejects fetch with a DOMException named TimeoutError.
    mockFetch.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))

    const result = await uploadDocument(session, makeInput(), new Request('http://x'))

    expect(result.status).toBe('failed')
    expect(result.jobId).toBeNull()
    expect(markDocumentIngestFailed).toHaveBeenCalledWith(
      result.documentId,
      'org-1',
      INGEST_DISPATCH_FAILED_MESSAGE
    )
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })
})

describe('listDocuments', () => {
  it('pushes the author filter down to the query instead of filtering the result', async () => {
    // The „Von Piloti" chip asks for the small minority of rows a machine
    // wrote, and migration 0063 gave that predicate its own partial index.
    // Filtering after the fact would read the whole corpus — then reconcile and
    // assignment-hydrate every row of it — to return a handful, so the
    // parameter has to reach the repository. It also has to reach it in the
    // right ARGUMENT SLOT: `limit` sits between, and passing the author there
    // would silently cap the listing at zero rows instead of filtering it.
    vi.mocked(listProjectDocuments).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])

    await listDocuments(session, 'proj-1', { authoredBy: 'agent' })

    expect(listProjectDocuments).toHaveBeenCalledWith(
      'proj-1',
      session.organizationId,
      undefined,
      'agent'
    )
  })

  it('asks for every author when the caller states no filter', async () => {
    vi.mocked(listProjectDocuments).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])

    await listDocuments(session, 'proj-1')

    expect(listProjectDocuments).toHaveBeenCalledWith(
      'proj-1',
      session.organizationId,
      undefined,
      undefined
    )
  })

  it('carries the curated metadata subset through and strips the internal metadata column', async () => {
    vi.mocked(listProjectDocuments).mockResolvedValue([])
    // reconcile returns rows with the internal `metadata` jsonb (ingestJobId)
    // plus the curated read-only fields layered on top.
    // The production instantiation of `reconcileDocumentStatuses`: repository
    // rows with the curated backend metadata layered on top.
    const reconciled: Array<DocumentListRow & DocumentMetadata> = [
      {
        id: 'doc-1',
        filename: 'plan.pdf',
        displayName: null,
        fileSize: 1024,
        contentType: 'application/pdf',
        status: 'completed',
        authoredBy: 'user',
        collectionName: 'proj_abc',
        folderId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        errorMessage: null,
        metadata: { ingestJobId: 'job-1' },
        summary: 'A ground-floor plan.',
        pageCount: 4,
        chunkCount: 12,
        contentTypes: ['text', 'table'],
        tags: ['Grundriss', 'Brandschutz'],
      },
    ]
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue(reconciled)

    const [row] = await listDocuments(session, 'proj-1')

    // Internal metadata jsonb (with ingestJobId) never leaves the BFF.
    expect(row).not.toHaveProperty('metadata')
    // Curated read-only fields ride alongside as top-level properties.
    expect(row.summary).toBe('A ground-floor plan.')
    expect(row.pageCount).toBe(4)
    expect(row.chunkCount).toBe(12)
    expect(row.contentTypes).toEqual(['text', 'table'])
    expect(row.tags).toEqual(['Grundriss', 'Brandschutz'])
  })
})

describe('joinHitsToFiles', () => {
  const older = {
    filename: 'plan.pdf',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    id: 'old',
    authoredBy: 'user',
  }
  const newer = {
    filename: 'plan.pdf',
    createdAt: new Date('2026-02-01T00:00:00Z'),
    id: 'new',
    authoredBy: 'user',
  }
  const other = {
    filename: 'permit.pdf',
    createdAt: new Date('2026-01-05T00:00:00Z'),
    id: 'permit',
    authoredBy: 'user',
  }

  it('joins by filename and augments each row with snippet/page/score', () => {
    const hits = [
      {
        file_name: 'permit.pdf',
        score: 0.42,
        snippet: 'permit text',
        page_number: 3,
        collection: 'c',
      },
    ]
    const [row] = joinHitsToFiles(hits, [older, other])
    expect(row).toMatchObject({ id: 'permit', snippet: 'permit text', page: 3, score: 0.42 })
  })

  it('preserves hit order (backend guarantees score-descending)', () => {
    const hits = [
      { file_name: 'permit.pdf', score: 0.9, snippet: 'b', page_number: null, collection: 'c' },
      { file_name: 'plan.pdf', score: 0.5, snippet: 'a', page_number: 1, collection: 'c' },
    ]
    const result = joinHitsToFiles(hits, [older, other])
    expect(result.map((r) => r.id)).toEqual(['permit', 'old'])
  })

  it('drops hits whose filename is not among the file rows', () => {
    const hits = [
      { file_name: 'ghost.pdf', score: 0.8, snippet: 'x', page_number: null, collection: 'c' },
    ]
    expect(joinHitsToFiles(hits, [older, other])).toEqual([])
  })

  it('resolves a filename collision to the most-recent row', () => {
    const hits = [
      { file_name: 'plan.pdf', score: 0.7, snippet: 'x', page_number: null, collection: 'c' },
    ]
    // Feed the older row first so first-seen would pick it; recency must win.
    const [row] = joinHitsToFiles(hits, [older, newer])
    expect(row.id).toBe('new')
  })

  it('coerces a missing page_number to null', () => {
    const hits = [
      { file_name: 'plan.pdf', score: 0.3, snippet: 'x', page_number: null, collection: 'c' },
    ]
    const [row] = joinHitsToFiles(hits, [older])
    expect(row.page).toBeNull()
  })

  // A machine-authored document is not Projektwissen: it is never indexed, so a
  // hit can only reach one by way of a filename collision. `generatedFilename`
  // builds `slug(title)-YYYY-MM-DD.ext` out of a title the model itself wrote,
  // which makes that collision reachable by the model, not just by accident.
  it('never returns a machine-authored row, even on an exact filename match', () => {
    const generated = {
      filename: 'plan.pdf',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      id: 'generated',
      authoredBy: 'agent',
    }
    const hits = [
      { file_name: 'plan.pdf', score: 0.7, snippet: 'x', page_number: 2, collection: 'c' },
    ]
    expect(joinHitsToFiles(hits, [generated])).toEqual([])
  })

  it('lets the user row win a collision a newer machine-authored row would take', () => {
    // Recency alone would hand the hit to the generated row, and with it the
    // real Gutachten's snippet and page number under a „Von Piloti erstellt" label.
    const userRow = { ...older, authoredBy: 'user' }
    const generated = {
      filename: 'plan.pdf',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      id: 'generated',
      authoredBy: 'agent',
    }
    const hits = [
      { file_name: 'plan.pdf', score: 0.7, snippet: 'x', page_number: null, collection: 'c' },
    ]
    const [row] = joinHitsToFiles(hits, [userRow, generated])
    expect(row.id).toBe('old')
  })

  it('admits only `user`, so an author value nobody has added yet stays out', () => {
    // The check must be an allow-list, not `=== 'agent'`. `document-authors.ts`
    // anticipates a later `system` or `import`, and the column carries no CHECK
    // (migration 0063), so an unknown value is reachable. A deny-list would let
    // each new author ride in until someone remembers to extend it — the same
    // mistake `findStorageKeyByCollectionAndFilename` was corrected for.
    const unknownAuthor = {
      filename: 'plan.pdf',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      id: 'imported',
      authoredBy: 'import',
    }
    const hits = [
      { file_name: 'plan.pdf', score: 0.7, snippet: 'x', page_number: null, collection: 'c' },
    ]
    expect(joinHitsToFiles(hits, [unknownAuthor])).toEqual([])
  })

  // There is deliberately no test for a row that omits `authoredBy`: the
  // signature requires the column, so a caller that forgets it is a compile
  // error, not a runtime fail-open. Both callers select it — `listProjectDocuments`
  // (documents/repository.ts) and `listArchiv` (archiv/repository.ts).
  it('takes the authorship of each row, not of the first one seen', () => {
    // Guards the loop shape: a `break`-like early exit, or hoisting the check out
    // of the loop, would let a generated row ride in behind a user row.
    const generated = {
      filename: 'permit.pdf',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      id: 'generated',
      authoredBy: 'agent',
    }
    const hits = [
      { file_name: 'plan.pdf', score: 0.9, snippet: 'a', page_number: null, collection: 'c' },
      { file_name: 'permit.pdf', score: 0.4, snippet: 'x', page_number: null, collection: 'c' },
    ]
    expect(joinHitsToFiles(hits, [older, generated]).map((r) => r.id)).toEqual(['old'])
  })
})

describe('deriveSearchTopK', () => {
  it('derives the passage budget from top_k_files and holds top_k >= top_k_files', () => {
    // 20 files → 60 passages (3×), never the old fixed 40 that capped scale.
    expect(deriveSearchTopK(20)).toBe(60)
    expect(deriveSearchTopK(1)).toBe(3)
    // The invariant that makes the aggregation contract hold across the whole
    // allowed 1..100 range: the chunk budget can never starve top_k_files.
    for (const files of [1, 10, 20, 33, 50, 99, 100]) {
      expect(deriveSearchTopK(files)).toBeGreaterThanOrEqual(files)
    }
  })

  it('clamps to the backend top_k ceiling (100)', () => {
    // 100 files × 3 = 300, clamped to the DocumentSearchRequest le=100 bound.
    expect(deriveSearchTopK(100)).toBe(100)
    expect(deriveSearchTopK(40)).toBe(100)
  })
})

describe('searchProjectDocuments', () => {
  // `listProjectDocuments` selects `authoredBy` (repository.ts), so every row
  // reaching the join carries it. Building these rows without the column would
  // put the search seam on a shape production never produces — and would hide a
  // regression in the authorship filter behind the Archiv fallback.
  const fileRows: Array<ReconcilableDocument & { createdAt: Date; authoredBy: string }> = [
    {
      id: 'doc-a',
      filename: 'plan.pdf',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      status: 'completed',
      collectionName: 'proj_abc',
      errorMessage: null,
      authoredBy: 'user',
    },
    {
      id: 'doc-b',
      filename: 'permit.pdf',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      status: 'completed',
      collectionName: 'proj_abc',
      errorMessage: null,
      authoredBy: 'user',
    },
  ]

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    vi.mocked(listProjectDocuments).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue(
      fileRows.map((r) => ({ ...r, metadata: { ingestJobId: 'j' } }))
    )
    vi.mocked(findProjectInOrg).mockResolvedValue(makeProject())
  })

  it('enforces project:view, POSTs to the collection search, and joins hits reordered by score', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          hits: [
            {
              file_name: 'permit.pdf',
              score: 0.91,
              snippet: 'permit snippet',
              page_number: 2,
              collection: 'proj_abc',
            },
            {
              file_name: 'plan.pdf',
              score: 0.44,
              snippet: 'plan snippet',
              page_number: null,
              collection: 'proj_abc',
            },
          ],
        }),
    })

    const { hits } = await searchProjectDocuments(session, 'proj-1', 'fire escape', 20)

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:view')
    const call = mockFetch.mock.calls.find(([url]) => String(url).endsWith('/search'))
    expect(call?.[0]).toBe('http://backend:8000/v1/collections/proj_abc/search')
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
      query: 'fire escape',
      // Derived from top_k_files (20 × 3 = 60), not a fixed 40 that would cap the
      // achievable file count below top_k_files.
      top_k: 60,
      top_k_files: 20,
    })
    // Defense-in-depth: the signed request-context envelope is forwarded, scoped
    // to exactly the collection being searched (decodes back to ['proj_abc']).
    const headers = (call?.[1] as RequestInit).headers as Record<string, string>
    const envelope = headers['X-Grid-Request-Context']
    expect(envelope).toBeTruthy()
    const payload = JSON.parse(Buffer.from(envelope, 'base64url').toString('utf8'))
    expect(payload.collectionScope).toEqual(['proj_abc'])
    // Time-bounded like the other backend calls.
    expect((call?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
    // Reordered by score (permit first), each augmented with match evidence.
    expect(hits.map((h) => h.id)).toEqual(['doc-b', 'doc-a'])
    expect(hits[0]).toMatchObject({ snippet: 'permit snippet', page: 2, score: 0.91 })
  })

  // The end-to-end half of the `joinHitsToFiles` authorship guard: the unit test
  // pins the function, this pins the seam that actually calls it. A filed report
  // takes its filename from a title the model wrote, so a collision with a real
  // Gutachten is reachable by the model — and recency would hand the hit to the
  // newer generated row, returning the Gutachten's snippet and page under a
  // „Von Piloti erstellt" label.
  it('never surfaces a machine-authored row, even when it wins the collision on recency', async () => {
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([
      ...fileRows.map((r) => ({ ...r, metadata: { ingestJobId: 'j' } })),
      {
        id: 'doc-generated',
        filename: 'plan.pdf',
        createdAt: new Date('2026-06-01T00:00:00Z'),
        status: 'completed',
        collectionName: 'proj_abc',
        errorMessage: null,
        authoredBy: 'agent',
        metadata: { ingestJobId: 'j' },
      },
    ] as unknown as Awaited<ReturnType<typeof reconcileDocumentStatuses>>)
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          hits: [
            {
              file_name: 'plan.pdf',
              score: 0.9,
              snippet: 'plan snippet',
              page_number: 7,
              collection: 'proj_abc',
            },
          ],
        }),
    })

    const { hits } = await searchProjectDocuments(session, 'proj-1', 'fire escape')

    expect(hits.map((h) => h.id)).toEqual(['doc-a'])
  })

  it('fails open to no hits when the backend errors (non-OK)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) })
    const { hits } = await searchProjectDocuments(session, 'proj-1', 'q')
    expect(hits).toEqual([])
  })

  it('fails open to no hits when the backend times out / throws', async () => {
    mockFetch.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    const { hits } = await searchProjectDocuments(session, 'proj-1', 'q')
    expect(hits).toEqual([])
  })

  it('404s when the project is not in the org (no backend call)', async () => {
    vi.mocked(findProjectInOrg).mockResolvedValue(null)
    await expect(searchProjectDocuments(session, 'proj-1', 'q')).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('reingestDocument', () => {
  const failedDoc = makeDocument({
    id: 'doc-99',
    status: 'failed',
    storageKey: 'org/proj/doc/file.pdf',
  })

  it('happy path: failed -> pending with a fresh job id', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(failedDoc)
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-77' }),
    })

    const result = await reingestDocument(session, 'doc-99')

    expect(result).toEqual({ id: 'doc-99', status: 'pending', jobId: 'job-77' })
    expect(setDocumentIngestJob).toHaveBeenCalledWith('doc-99', 'org-1', 'job-77')
    expect(markDocumentIngestFailed).not.toHaveBeenCalled()
  })

  // The row's bucket, NOT the bucket a new upload would go to. Both presigned
  // URLs have to name where the object actually IS: a retry against the shared
  // bucket 404s forever (the document can never be recovered through the UI),
  // and the thumbnail PUT lands somewhere no read path looks and no delete
  // sweeps.
  it('presigns against the bucket the document is actually in', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({
        id: 'doc-99',
        status: 'failed',
        storageKey: 'org/org-1/project/proj-1/doc/doc-99/plan.pdf',
        storageBucket: 'grid-org-org-1-deadbeef1234',
      })
    )
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })
    vi.mocked(getSignedUrl).mockClear()

    await reingestDocument(session, 'doc-99')

    const buckets = vi
      .mocked(getSignedUrl)
      .mock.calls.map((call) => (call[1] as unknown as { input: { Bucket: string } }).input.Bucket)
    expect(buckets.length).toBeGreaterThanOrEqual(2)
    expect(new Set(buckets)).toEqual(new Set(['grid-org-org-1-deadbeef1234']))
    vi.unstubAllEnvs()
  })

  it('rejects documents that are not in a failed state (409)', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...failedDoc, status: 'ready' })

    await expect(reingestDocument(session, 'doc-99')).rejects.toBeInstanceOf(ConflictError)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })

  it('dispatch failure re-marks the document failed', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(failedDoc)
    mockFetch.mockRejectedValue(new Error('network down'))

    const result = await reingestDocument(session, 'doc-99')

    expect(result.status).toBe('failed')
    expect(result.jobId).toBeNull()
    expect(markDocumentIngestFailed).toHaveBeenCalledWith(
      'doc-99',
      'org-1',
      INGEST_DISPATCH_FAILED_MESSAGE
    )
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })
})

/**
 * The folder the user filed the document in has to reach the backend, or the
 * agent never learns it (ADR-0049).
 *
 * `uploadDocument` already resolves the path to build the storage key, so the
 * failure mode is not "we cannot know it" — it is "we knew it and did not say
 * it". Re-ingest is the same call again and has to re-supply the same value, or
 * retrying a failed document silently un-files it.
 *
 * The backend twin asserting the same `folder_path` key is
 * `frontends/aiq_api/tests/test_ingest_folder_path.py`.
 */
describe('the folder a document is filed in reaches the ingest dispatch', () => {
  const ingestBody = (): Record<string, unknown> => {
    const call = mockFetch.mock.calls.find(([url]) => String(url).endsWith('/v1/ingest'))
    if (!call) throw new Error('no /v1/ingest call was made')
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>
  }

  beforeEach(() => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-1' }),
    })
  })

  it('sends the folder path an upload was filed into', async () => {
    vi.mocked(findFolderPathInProject).mockResolvedValue('Brandschutz/Fluchtwege')

    await uploadDocument(session, { ...makeInput(), folderId: 'folder-1' }, new Request('http://x'))

    expect(ingestBody().folder_path).toBe('Brandschutz/Fluchtwege')
  })

  it('sends null for an upload at the project root', async () => {
    vi.mocked(findFolderPathInProject).mockResolvedValue(null)

    await uploadDocument(session, makeInput(), new Request('http://x'))

    expect(ingestBody().folder_path).toBeNull()
  })

  it('re-supplies the folder path when a failed document is re-ingested', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({
        id: 'doc-99',
        status: 'failed',
        storageKey: 'org/org-1/project/proj-1/doc/doc-99/plan.pdf',
        projectId: 'proj-1',
        folderId: 'folder-1',
      })
    )
    vi.mocked(findFolderPathInProject).mockResolvedValue('Brandschutz')

    await reingestDocument(session, 'doc-99')

    expect(ingestBody().folder_path).toBe('Brandschutz')
  })

  it('sends null on re-ingest for a document that was never filed', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({
        id: 'doc-99',
        status: 'failed',
        storageKey: 'org/org-1/project/proj-1/doc/doc-99/plan.pdf',
        projectId: 'proj-1',
        folderId: null,
      })
    )

    await reingestDocument(session, 'doc-99')

    expect(ingestBody().folder_path).toBeNull()
    // No folder id, no lookup: an Archiv or session document has no folder tree
    // to resolve against at all.
    expect(findFolderPathInProject).not.toHaveBeenCalled()
  })
})

describe('deleteDocument', () => {
  const projectDoc = makeDocument()

  it('404s when the document is not in the org', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)

    await expect(
      deleteDocument(session, 'missing', new Request('http://x'))
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(deleteProjectDocument).not.toHaveBeenCalled()
  })

  it('404s for an org-wide Archiv document (NULL projectId) — not deletable via the project route', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({
      ...projectDoc,
      projectId: null,
      scope: 'archiv',
    })

    await expect(deleteDocument(session, 'doc-1', new Request('http://x'))).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(deleteProjectDocument).not.toHaveBeenCalled()
  })

  it('rejects callers without project:edit (403) before any side effects', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new ForbiddenError())

    await expect(deleteDocument(session, 'doc-1', new Request('http://x'))).rejects.toBeInstanceOf(
      ForbiddenError
    )
    expect(deleteProjectDocument).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('purges chunks, deletes the object + row, and audits', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    mockFetch.mockResolvedValue({ ok: true })

    await deleteDocument(session, 'doc-1', new Request('http://x'))

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', [
      'project:documents:write',
      'project:edit',
    ])
    // Best-effort backend chunk purge, keyed by the document's collection + filename.
    const purgeCall = mockFetch.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/documents') && (init as RequestInit)?.method === 'DELETE'
    )
    expect(purgeCall?.[0]).toBe('http://backend:8000/v1/collections/proj_abc/documents')
    expect(deleteProjectDocument).toHaveBeenCalledWith('doc-1', 'org-1', 'proj-1')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.deleted', organizationId: 'org-1' })
    )
  })

  it('still deletes the row + audits when the best-effort chunk purge fails', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    mockFetch.mockRejectedValue(new Error('backend down'))

    await deleteDocument(session, 'doc-1', new Request('http://x'))

    expect(deleteProjectDocument).toHaveBeenCalledWith('doc-1', 'org-1', 'proj-1')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.deleted' })
    )
  })
})

describe('renameDocument', () => {
  const projectDoc = makeDocument()
  const request = () => new Request('http://x')

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
  })

  it('stores the trimmed name and mirrors it to the backend metadata row', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)

    const result = await renameDocument(session, 'doc-1', '  Einreichplan.pdf  ', request())

    expect(result).toEqual({ id: 'doc-1', filename: 'plan.pdf', displayName: 'Einreichplan.pdf' })
    expect(setDocumentDisplayName).toHaveBeenCalledWith('doc-1', 'org-1', 'Einreichplan.pdf')

    // The mirror keeps citation chips honest without a re-ingest — keyed by the
    // document's UNCHANGED (collection, filename) pair.
    const [url, init] = mockFetch.mock.calls.at(-1) ?? []
    expect(String(url)).toBe(
      'http://backend:8000/v1/collections/proj_abc/documents/plan.pdf/display-title'
    )
    expect((init as RequestInit)?.method).toBe('PATCH')
    expect(JSON.parse(String((init as RequestInit)?.body))).toEqual({
      display_title: 'Einreichplan.pdf',
    })
  })

  it('never touches the file name — the join key to the object and the chunks', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)

    await renameDocument(session, 'doc-1', 'Einreichplan.pdf', request())

    // `setDocumentDisplayName` is the ONLY writer this path has; if a rename
    // ever grows a second one, this fails and the reasoning gets re-read.
    expect(setDocumentDisplayName).toHaveBeenCalledTimes(1)
    expect(deleteProjectDocument).not.toHaveBeenCalled()
  })

  it('treats a rename back to the file name as a clear, not a stored duplicate', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({
      ...projectDoc,
      displayName: 'Einreichplan.pdf',
    })

    const result = await renameDocument(session, 'doc-1', 'plan.pdf', request())

    expect(result.displayName).toBeNull()
    expect(setDocumentDisplayName).toHaveBeenCalledWith('doc-1', 'org-1', null)
  })

  it('clears the rename on null', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({
      ...projectDoc,
      displayName: 'Einreichplan.pdf',
    })

    await renameDocument(session, 'doc-1', null, request())

    expect(setDocumentDisplayName).toHaveBeenCalledWith('doc-1', 'org-1', null)
    expect(JSON.parse(String((mockFetch.mock.calls.at(-1) ?? [])[1]?.body))).toEqual({
      display_title: null,
    })
  })

  it('refuses an unusable name (400) before writing anything', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)

    await expect(
      renameDocument(session, 'doc-1', 'plans/EG.pdf', request())
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(setDocumentDisplayName).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('404s when the document is not in the org', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)

    await expect(renameDocument(session, 'missing', 'x.pdf', request())).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(setDocumentDisplayName).not.toHaveBeenCalled()
  })

  it('rejects a caller without write access (403) before any side effect', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new ForbiddenError())

    await expect(renameDocument(session, 'doc-1', 'x.pdf', request())).rejects.toBeInstanceOf(
      ForbiddenError
    )
    expect(setDocumentDisplayName).not.toHaveBeenCalled()
  })

  it('keeps the rename when the backend mirror fails — the row is the durable one', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    mockFetch.mockRejectedValue(new Error('backend down'))

    const result = await renameDocument(session, 'doc-1', 'Einreichplan.pdf', request())

    expect(result.displayName).toBe('Einreichplan.pdf')
    expect(setDocumentDisplayName).toHaveBeenCalledWith('doc-1', 'org-1', 'Einreichplan.pdf')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.renamed' })
    )
  })

  it('records both names in the audit trail, under the scope-correct action', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...projectDoc, displayName: 'Alt.pdf' })

    await renameDocument(session, 'doc-1', 'Neu.pdf', request())

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'document.renamed',
        targetType: 'document',
        targetId: 'doc-1',
        metadata: expect.objectContaining({
          filename: 'plan.pdf',
          previousName: 'Alt.pdf',
          displayName: 'Neu.pdf',
        }),
      })
    )
  })

  it('renames an Archiv document too, under the Archiv action', async () => {
    // Scope-aware: the Archiv has no project, so `getAccessibleDocument` applies
    // the org-level manage check instead of project FGA. The session here holds
    // it (admin role in `canManageArchiv` terms is asserted in the archiv specs);
    // what this asserts is that the path is not project-only, as DELETE is.
    vi.mocked(findDocumentInOrg).mockResolvedValue({
      ...projectDoc,
      projectId: null,
      scope: 'archiv',
      collectionName: 'archiv_org-1',
    })

    await expect(
      renameDocument({ ...session, role: 'admin' }, 'doc-1', 'Musterordner.pdf', request())
    ).resolves.toMatchObject({ displayName: 'Musterordner.pdf' })
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'archiv.document.renamed' })
    )
  })
})

describe('getDocumentStatus', () => {
  // The composer's "Asking about <file>" bar rebuilds a restored subject from
  // this payload alone, so a field missing here is a field that silently stops
  // reaching the agent: no `scope` means no `focus_shelf` on the wire, and no
  // `displayName` means a renamed document is labelled by its raw filename in
  // the composer while every other surface shows the new name.
  const projectDoc = makeDocument({ displayName: 'Aufsicht 1:100' })

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(reconcileDocumentStatuses).mockImplementation(
      async (rows) => rows.map((row) => ({ ...row })) as never
    )
  })

  it('projects the identity, the label and the shelf', async () => {
    await expect(getDocumentStatus(session, 'doc-1')).resolves.toMatchObject({
      id: projectDoc.id,
      filename: projectDoc.filename,
      displayName: 'Aufsicht 1:100',
      scope: 'project',
    })
  })

  it('carries the shelf for a document that is not on the project shelf', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({
      ...projectDoc,
      projectId: null,
      scope: 'archiv',
      collectionName: 'archiv_org-1',
    })

    await expect(getDocumentStatus(session, 'doc-1')).resolves.toMatchObject({ scope: 'archiv' })
  })

  it('reports a null displayName rather than omitting the key', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...projectDoc, displayName: null })

    const status = await getDocumentStatus(session, 'doc-1')

    expect(status).toHaveProperty('displayName', null)
  })
})

/**
 * Every `(collectionName, filename)` call this service makes, exercised against
 * the collision `generatedFilename` puts within the model's reach.
 *
 * The scenario is one project. A person uploaded
 * `brandschutz-gutachten-2026-08-20.pdf`; the same day Piloti filed a report
 * whose own H1 slugged to the same stem, into the SAME project collection,
 * because that is where a filed report goes. Two rows, one name over there, and
 * the backend has an entry for only the human one — nothing machine-authored is
 * ever dispatched to `/v1/ingest`.
 *
 * Both rows are addressed here by id, so nothing about these cases depends on
 * the collision being *detected*: the agent row must make no
 * `(collection, filename)` call AT ALL, because it owns nothing under that pair
 * whether or not somebody else does.
 */
describe('the authorship gate on the (collection, filename) join', () => {
  const collidingName = 'brandschutz-gutachten-2026-08-20.pdf'

  const humanDoc = makeDocument({ filename: collidingName })

  // `authoredBy: 'agent'` obliges the other three provenance columns —
  // `documents_authorship_requires_provenance` (migration 0063) rejects the row
  // otherwise, so a fixture that set only `authoredBy` would describe a row the
  // database cannot hold.
  const agentDoc = makeDocument({
    id: 'doc-agent',
    filename: collidingName,
    authoredBy: 'agent',
    authoredByProducer: 'deep_research',
    authoredByRef: 'run-7',
    authoredByRefKind: 'agent_run',
    status: 'stored',
    storageKey: 'org/org-1/project/proj-1/doc/doc-agent/' + collidingName,
  })

  /** Backend calls that name a document — the ones a filename identity reaches. */
  const documentCalls = () =>
    mockFetch.mock.calls.filter(([url]) => String(url).includes('/v1/collections/'))

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
  })

  describe('deleteDocument', () => {
    it("does not purge chunks for a machine-authored row — they are somebody else's", async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(agentDoc)

      await deleteDocument(session, 'doc-agent', new Request('http://x'))

      // The DELETE was unconditional. For an agent row it is always wrong (the
      // row owns no chunks), and on this collision it removed the HUMAN
      // Gutachten's chunks while that document kept `status: 'completed'`, its
      // green „zitierbar“ badge and its Ask affordance — and answered nothing
      // from then on.
      expect(documentCalls()).toHaveLength(0)
      // The delete itself still completes: the row and the object are this
      // function's durable job and neither depends on the backend.
      expect(deleteProjectDocument).toHaveBeenCalledWith('doc-agent', 'org-1', 'proj-1')
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'document.deleted' })
      )
    })

    it('still purges chunks for the human document that owns the same filename', async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(humanDoc)

      await deleteDocument(session, 'doc-1', new Request('http://x'))

      const [url, init] = documentCalls()[0] ?? []
      expect(String(url)).toBe('http://backend:8000/v1/collections/proj_abc/documents')
      expect((init as RequestInit)?.method).toBe('DELETE')
      expect(JSON.parse(String((init as RequestInit)?.body))).toEqual({ file_ids: [collidingName] })
    })
  })

  describe('getDocumentVisualDetails', () => {
    it('returns no page text for a machine-authored row, and asks for none', async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(agentDoc)

      // Per-page VLM text is fetched by (collection, filename); unGated, this
      // panel showed another document's extracted drawings.
      await expect(getDocumentVisualDetails(session, 'doc-agent')).resolves.toEqual({
        id: 'doc-agent',
        details: [],
      })
      expect(documentCalls()).toHaveLength(0)
    })

    it('still fetches page text for the human document with the same filename', async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(humanDoc)
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          details: [{ page: 3, content_type: 'drawing', text: 'Schnitt A-A' }],
        }),
      })

      const result = await getDocumentVisualDetails(session, 'doc-1')

      // A chunk indexed before the structured schema carries no `structured`
      // payload, and the mapper defaults rather than dropping the row.
      expect(result.details).toEqual([
        {
          page: 3,
          contentType: 'drawing',
          drawingType: '',
          scale: '',
          text: 'Schnitt A-A',
          segment: 0,
          structured: null,
        },
      ])
      expect(String(documentCalls()[0]?.[0])).toBe(
        `http://backend:8000/v1/collections/proj_abc/documents/${collidingName}/visual-details`
      )
    })
  })

  describe('updateDocumentTags', () => {
    it('404s a machine-authored row instead of retagging the colliding document', async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(agentDoc)

      // 404 is what the backend itself answers for a NON-colliding agent row
      // (no summary row was ever written for it). The gate makes the colliding
      // one answer the same way rather than PATCHing the human document's
      // controlled OIB tags.
      await expect(updateDocumentTags(session, 'doc-agent', ['Gutachten'])).rejects.toBeInstanceOf(
        NotFoundError
      )
      expect(documentCalls()).toHaveLength(0)
    })

    it('still retags the human document with the same filename', async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(humanDoc)
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ tags: ['Gutachten'] }),
      })

      await expect(updateDocumentTags(session, 'doc-1', ['Gutachten'])).resolves.toEqual({
        id: 'doc-1',
        tags: ['Gutachten'],
      })
      expect(String(documentCalls()[0]?.[0])).toBe(
        `http://backend:8000/v1/collections/proj_abc/documents/${collidingName}/tags`
      )
    })
  })

  describe('renameDocument', () => {
    it('renames a machine-authored row without retitling the colliding document', async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(agentDoc)

      await renameDocument(session, 'doc-agent', 'Piloti-Bericht.pdf', new Request('http://x'))

      // The durable rename is the row, and it happens.
      expect(setDocumentDisplayName).toHaveBeenCalledWith(
        'doc-agent',
        'org-1',
        'Piloti-Bericht.pdf'
      )
      // The best-effort mirror does not: it would have renamed the human
      // Gutachten's citation chips to „Piloti-Bericht.pdf“.
      expect(documentCalls()).toHaveLength(0)
    })

    it('still mirrors the rename for the human document with the same filename', async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(humanDoc)

      await renameDocument(session, 'doc-1', 'Einreichplan.pdf', new Request('http://x'))

      expect(String(documentCalls()[0]?.[0])).toBe(
        `http://backend:8000/v1/collections/proj_abc/documents/${collidingName}/display-title`
      )
    })
  })

  describe('reindexProject', () => {
    it('skips a machine-authored row rather than deleting the colliding chunks', async () => {
      // Belt to the `'user'` filter the listing already applies: a row that
      // reaches the rebuild loop machine-authored is counted as never-eligible,
      // and — the point — its chunk DELETE is never issued. The delete is the
      // destructive half of this function and runs BEFORE the dispatcher's own
      // refusal would.
      vi.mocked(listProjectDocuments).mockResolvedValue([
        {
          id: 'doc-agent',
          filename: collidingName,
          displayName: null,
          fileSize: 1024,
          contentType: 'application/pdf',
          status: 'stored',
          authoredBy: 'agent',
          collectionName: 'proj_abc',
          folderId: null,
          createdAt: new Date('2026-08-20T00:00:00Z'),
          updatedAt: new Date('2026-08-20T00:00:00Z'),
          errorMessage: null,
          metadata: null,
        },
      ])
      vi.mocked(findDocumentInOrg).mockResolvedValue(agentDoc)

      const result = await reindexProject(session, 'proj-1')

      expect(result).toEqual({ projectId: 'proj-1', queued: 0, skipped: 1, failed: [] })
      expect(documentCalls()).toHaveLength(0)
    })
  })
})

describe('getDocumentTextPreview', () => {
  const textDoc = (contentType: string) =>
    makeDocument({
      id: 'doc-text',
      filename: 'katalog.csv',
      contentType,
      storageKey: 'org/org-1/project/proj-1/doc/doc-text/katalog.csv',
    })

  const bodyOf = (text: string) => ({
    transformToByteArray: async () => new TextEncoder().encode(text),
  })

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
  })

  it('returns the bytes as text for a format the pane renders itself', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(textDoc('text/csv'))
    vi.mocked(s3Client.send).mockResolvedValue({ Body: bodyOf('a;b\n1;2\n') } as never)

    await expect(getDocumentTextPreview(session, 'doc-text')).resolves.toMatchObject({
      text: 'a;b\n1;2\n',
      truncated: false,
    })
  })

  /**
   * The route exists so the pane can render text; handing it a PDF would let a
   * caller pull arbitrary bytes through a JSON string. The presign route is
   * where a PDF belongs.
   */
  it('refuses a content type it is not for', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(textDoc('application/pdf'))

    await expect(getDocumentTextPreview(session, 'doc-text')).rejects.toMatchObject({
      status: 415,
    })
  })

  it('never serves HTML, which would be script in a same-origin response', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(textDoc('text/html'))

    await expect(getDocumentTextPreview(session, 'doc-text')).rejects.toMatchObject({
      status: 415,
    })
  })

  it('bounds the response and says it did, rather than cutting the file silently', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(textDoc('text/plain'))
    // One byte past the cap is what makes the range request report truncation.
    const oversized = 'x'.repeat(256 * 1024) + '\nlast'
    vi.mocked(s3Client.send).mockResolvedValue({ Body: bodyOf(oversized) } as never)

    const result = await getDocumentTextPreview(session, 'doc-text')

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(256 * 1024)
  })

  it('asks the object store for a bounded range, not for the whole object', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(textDoc('text/plain'))
    vi.mocked(s3Client.send).mockResolvedValue({ Body: bodyOf('short') } as never)

    await getDocumentTextPreview(session, 'doc-text')

    const command = vi.mocked(s3Client.send).mock.calls.at(-1)?.[0] as
      | { input?: { Range?: string } }
      | undefined
    expect(command?.input?.Range).toBe(`bytes=0-${256 * 1024}`)
  })

  it('404s a document with no stored object', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-text', contentType: 'text/plain', storageKey: undefined })
    )

    await expect(getDocumentTextPreview(session, 'doc-text')).rejects.toBeInstanceOf(NotFoundError)
  })
})


describe('re-uploading a filename this collection already holds', () => {
  /**
   * A RE-UPLOAD USED TO LEAVE A GHOST.
   *
   * `uploadDocument` minted a fresh id and inserted unconditionally — there is
   * no unique index on (collection, filename) — while the ingest pipeline's
   * `_replace_previous_versions` deletes chunks BY FILENAME. So the second
   * upload's chunks replaced the first's and the first row survived: listed,
   * downloadable, cited by nothing, findable by nothing, and charged to the
   * organization's quota twice. A ghost, and a paid-for one.
   */
  const existing = {
    id: 'doc-existing',
    storageKey: 'org/org-1/project/proj-1/doc/doc-existing/plan.pdf',
    storageBucket: 'test-bucket',
    fileSize: 900,
  }

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    vi.mocked(findProjectInOrg).mockResolvedValue(
      makeProject({ id: 'proj-1', collectionName: 'proj_abc' }),
    )
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue(existing)
  })

  afterEach(() => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue(null)
  })

  it('keeps the document id, so nothing that referenced it breaks', async () => {
    const result = await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

    // Every citation, chat subject and folder assignment already points here.
    expect(result.documentId).toBe('doc-existing')
  })

  it('replaces the row instead of inserting a second one', async () => {
    await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

    expect(admitOrDiscard).not.toHaveBeenCalled()
    expect(admitReplacementOrDiscard).toHaveBeenCalled()
    // The quota is charged the DELTA, under the same lock: the row being
    // replaced already contributes its old size to the usage this is measured
    // against, so it is excluded there rather than double-counted here.
    const call = vi.mocked(admitReplacementOrDiscard).mock.calls.at(-1)
    expect(call?.[3]).toBe('doc-existing')
  })

  it('records that these are new bytes rather than a new document', async () => {
    await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

    const event = vi.mocked(recordAuditEvent).mock.calls.at(-1)?.[0]
    expect(event?.targetId).toBe('doc-existing')
    expect(event?.metadata).toMatchObject({ replaced: true })
  })

  it('still inserts when the filename is genuinely new', async () => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue(null)

    const result = await uploadDocument(session, makeInput({ name: 'neu.pdf' }), new Request('http://x'))

    expect(admitOrDiscard).toHaveBeenCalled()
    expect(result.documentId).not.toBe('doc-existing')
  })

  it('dispatches the replaced document for ingestion under its own id', async () => {
    // The chunks have to be rebuilt from the NEW bytes; a replace that skipped
    // this would leave the old text answering questions about the new file.
    const result = await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

    expect(result.documentId).toBe('doc-existing')
    const dispatched = mockFetch.mock.calls.some(([url]) => String(url).includes('/v1/ingest'))
    expect(dispatched).toBe(true)
  })
})

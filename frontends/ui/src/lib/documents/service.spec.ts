import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

/**
 * `document_versions` is not this suite's subject (ADR-0054). The upload path
 * records a version through the lifecycle; here that reduces to "it was asked
 * for", and the version table's own behaviour is `lifecycle.spec.ts`'s.
 */
vi.mock('./version-repository', () => ({
  DOCUMENT_VERSION_LIST_LIMIT: 200,
  insertDocumentVersion: vi.fn(async (values: Record<string, unknown>) => ({
    id: 'version_1',
    state: 'published',
    versionNumber: 1,
    ...values,
  })),
  // The born-published insert: supersede, insert and pointer in one
  // transaction, because the unique index is not deferrable (migration 0082).
  insertPublishedVersion: vi.fn(async (values: Record<string, unknown>) => ({
    version: { id: 'version_1', state: 'published', versionNumber: 1, ...values },
    superseded: [],
  })),
  listDocumentVersions: vi.fn().mockResolvedValue([]),
  findDocumentVersion: vi.fn().mockResolvedValue(null),
  findPublishedVersion: vi.fn().mockResolvedValue(null),
  findOpenVersion: vi.fn().mockResolvedValue(null),
  listDocumentVersionSummaries: vi.fn().mockResolvedValue([]),
  // 2: the only caller asks for it on the REPLACE path, where the next version
  // is by definition not the first.
  nextVersionNumber: vi.fn().mockResolvedValue(2),
  compareAndSwapVersionState: vi.fn().mockResolvedValue(null),
  promoteVersionToPublished: vi.fn().mockResolvedValue(null),
  setDocumentLifecycle: vi.fn(),
  listDocumentVersionObjects: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/storage/service', () => ({
  // The quota check is exercised in src/lib/storage/service.spec.ts; here it is
  // stubbed to a no-op so these specs keep testing the upload path itself
  // rather than reaching Postgres for org settings.
  assertWithinStorageQuota: vi.fn().mockResolvedValue(undefined),
}))

// The per-organization size limit, likewise: exercised in
// src/lib/storage/upload-limit.spec.ts, stubbed here so an upload spec does not
// reach Postgres for the organization's settings.
vi.mock('@/lib/storage/upload-limit', () => ({
  assertFileSizeAllowed: vi.fn().mockResolvedValue(undefined),
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

// The upload-screening policy (ADR-0085) is read off the organization's
// settings; an office that never saved one is on Piloti's suggestion.
vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: vi.fn().mockResolvedValue({ displayName: null, defaultLocale: 'de', settings: {} }),
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
  findFolderPathInArchiv: vi.fn().mockResolvedValue(null),
  findDocumentInOrg: vi.fn(),
  // Default: no collision, so the upload path is the insert path it has always
  // been. The replace path is driven per-test.
  findLiveDocumentByFilename: vi.fn().mockResolvedValue(null),
  listProjectDocuments: vi.fn(),
  listProjectDocumentPage: vi.fn().mockResolvedValue({ rows: [], nextCursor: null }),
  findProjectDocumentsByFilenames: vi.fn().mockResolvedValue([]),
  findProjectDocumentsByNames: vi.fn().mockResolvedValue([]),
  deleteProjectDocument: vi.fn().mockResolvedValue(undefined),
  setDocumentDisplayName: vi.fn().mockResolvedValue(undefined),
  setDocumentReconciledStatus: vi.fn().mockResolvedValue(undefined),
  listFailedDocumentPageInOrg: vi.fn().mockResolvedValue({ ids: [], nextCursor: null }),
}))

// The queue is `lib/jobs-queue`'s subject. Here a reindex is "one bulk job was
// asked for, with who asked", and a slice is the work the job does.
vi.mock('@/lib/jobs-queue/enqueue', () => ({
  enqueueJob: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
}))
vi.mock('@/lib/jobs-queue/repository', () => ({
  findOpenJobId: vi.fn().mockResolvedValue(null),
}))

vi.mock('./reconcile-status', () => ({
  reconcileDocumentStatuses: vi.fn(),
  describeBackendIngestState: vi.fn(),
}))

// The hold predicate is SQL (`grid_legal_hold_blocks`, migration 0093), proven
// against Postgres in `legal-hold.integration.spec.ts`; the gate runs for real.
// The erasure of a document's objects is `object-cleanup.spec.ts`'s subject;
// here it is what the delete asks for, and what the delete does when it fails.
vi.mock('@/lib/documents/object-cleanup', () => ({
  eraseDocumentObjectsOrKeepRow: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/compliance/repository', () => ({
  isCoveredByActiveHold: vi.fn().mockResolvedValue(false),
}))

import { findProjectInOrg } from '@/lib/projects/repository'
import { isCoveredByActiveHold } from '@/lib/compliance/repository'
import { eraseDocumentObjectsOrKeepRow } from '@/lib/documents/object-cleanup'
import { requireProjectAccess } from '@/lib/authz/projects'
import { recordAuditEvent } from '@/lib/audit/service'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { emptyCounts, type ReindexProjectPayload, type ReingestFailedPayload } from '@/lib/jobs-queue/types'
import { admitOrDiscard, admitReplacementOrDiscard } from '@/lib/storage/admission'
import {
  setDocumentIngestJob,
  markDocumentIngestFailed,
  findDocumentInOrg,
  findLiveDocumentByFilename,
  findFolderPathInProject,
  findFolderPathInArchiv,
  listProjectDocumentPage,
  findProjectDocumentsByFilenames,
  findProjectDocumentsByNames,
  deleteProjectDocument,
  setDocumentDisplayName,
  setDocumentReconciledStatus,
  listFailedDocumentPageInOrg,
} from './repository'
import {
  listDocuments,
  listDocumentsPage,
  probeProjectDocumentNames,
  uploadDocument,
  reingestDocument,
  deleteDocument,
  renameDocument,
  getDocumentStatus,
  getDocumentVisualDetails,
  updateDocumentTags,
  reindexProject,
  runReindexSlice,
  reingestFailedOrgDocuments,
  runReingestFailedSlice,
  REINDEX_SLICE_DOCUMENTS,
  REINGEST_SLICE_DOCUMENTS,
  resolveProjectDocumentsByName,
  searchProjectDocuments,
  joinHitsToFiles,
  deriveSearchTopK,
  dispatchDocument,
  getDocumentTextPreview,
  getDocumentThumbnail,
  getDocumentDownload,
  getDocumentPreview,
  streamDocumentFile,
  streamDocumentImage,
  AgentAuthoredDocumentNotIndexableError,
  INGEST_DISPATCH_FAILED_MESSAGE,
} from './service'
import { encodeDocumentListCursor } from './list-cursor'
import {
  reconcileDocumentStatuses,
  describeBackendIngestState,
  type DocumentMetadata,
  type ReconcilableDocument,
} from './reconcile-status'
import type { DocumentListRow } from './repository'
import {
  insertPublishedVersion,
  listDocumentVersionSummaries,
  nextVersionNumber,
} from './version-repository'
import { LiveFilenameTakenError, ReplacedDocumentGoneError } from './unique-conflicts'
import { isVlmConfigured } from '@/lib/documents/vlm-capability'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import { makeDocument, makeProject } from '@/test-utils/db-fixtures'
import { INGEST_ALREADY_DONE, INGEST_NOT_ELIGIBLE, INGEST_RUNNING } from './reingest-codes'
import { s3Client, bucketAdminS3Client } from '@/lib/s3'
import { __resetBucketCache, tenantBucketName } from '@/lib/storage/bucket'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { AuthorizedSession } from '@/lib/auth/types'
import { buildDocumentImageUrl } from '@/lib/images/signed-image-url'

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

/** A fresh reindex job's saved state: the first slice, nothing counted yet. */
const sliceState = (overrides: Partial<ReindexProjectPayload> = {}): ReindexProjectPayload => ({
  projectId: 'proj-1',
  requester: {
    userId: session.userId,
    email: session.email,
    organizationMembershipId: session.organizationMembershipId,
    role: session.role,
    permissions: session.permissions,
  },
  cursor: null,
  counts: emptyCounts(),
  ...overrides,
})

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
 * The name gate's server-side repeat (ADR-0085). The browser checks first and
 * never sends an excluded file; this is what makes a client that skipped the
 * check harmless. It runs before a byte is written, and an explicit release by
 * the uploader is honoured and audited rather than refused.
 */
describe('uploadDocument server-side name screening', () => {
  it('refuses a file whose name matches the policy, before anything is stored', async () => {
    await expect(
      uploadDocument(session, makeInput({ name: 'Schlussrechnung 2026.pdf' }), new Request('http://x'))
    ).rejects.toMatchObject({ status: 422, code: 'UPLOAD_SCREENED' })
    expect(s3Client.send).not.toHaveBeenCalled()
    expect(admitOrDiscard).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('refuses a file because of the folder it sat in, and names the folder', async () => {
    const error = await uploadDocument(
      session,
      { ...makeInput({ name: 'scan_0042.pdf' }), originPath: 'Akt/Personalunterlagen/scan_0042.pdf' },
      new Request('http://x')
    ).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      details: { matches: [{ term: 'Personal', segment: 'Personalunterlagen', kind: 'folder' }] },
    })
  })

  it('stores a matching file the uploader released, and audits the override', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ job_id: 'job-1' }) })
    const result = await uploadDocument(
      session,
      { ...makeInput({ name: 'Architektenvertrag.pdf' }), screeningRelease: true },
      new Request('http://x')
    )
    expect(result.status).toBe('pending')
    expect(admitOrDiscard).toHaveBeenCalled()
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'document.screening_overridden',
        metadata: expect.objectContaining({ terms: 'Vertrag' }),
      })
    )
  })

  it('lets an ordinary plan through without an override event', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ job_id: 'job-1' }) })
    await uploadDocument(session, makeInput({ name: 'Statische Berechnung.pdf' }), new Request('http://x'))
    expect(admitOrDiscard).toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.screening_overridden' })
    )
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

  it('dispatch OK without a job id: persists failed, never a green birth status', async () => {
    // The backend answers 202 with a `job_id` on every success, so an OK
    // response without one is not a quieter success. The old code left the
    // row at its 'uploaded' birth status, which the badge rendered as a green
    // "Ready" for a document nothing ever indexed.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
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
    vi.mocked(listProjectDocumentPage).mockResolvedValue({ rows: [], nextCursor: null })
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])

    await listDocuments(session, 'proj-1', { authoredBy: 'agent' })

    expect(listProjectDocumentPage).toHaveBeenCalledWith(
      'proj-1',
      session.organizationId,
      expect.objectContaining({ authoredBy: 'agent' })
    )
  })

  it('leaves archived documents out of the default listing', async () => {
    // „Archiviert" purged the chunks and wrote `documents.lifecycle`, and no
    // listing read that column — so the file stayed exactly where it was in the
    // Files pane and the whole gesture was an audit event nobody could see.
    await listDocuments(session, 'proj-1')
    expect(listProjectDocumentPage).toHaveBeenCalledWith(
      'proj-1',
      session.organizationId,
      expect.objectContaining({ includeArchived: undefined })
    )
  })

  it('widens to the archived ones when the caller asks', async () => {
    await listDocuments(session, 'proj-1', { includeArchived: true })
    expect(listProjectDocumentPage).toHaveBeenCalledWith(
      'proj-1',
      session.organizationId,
      expect.objectContaining({ includeArchived: true })
    )
  })

  // The listing is paged, not capped: the cursor reaches the query, and the
  // next page's position leaves encoded (list-cursor.ts).
  it('threads the cursor down and encodes the next one', async () => {
    const cursor = { createdAt: '2026-01-01T00:00:00.123456', id: '00000000-0000-4000-8000-000000000001' }
    const next = { createdAt: '2025-12-01T00:00:00.000001', id: '00000000-0000-4000-8000-000000000002' }
    vi.mocked(listProjectDocumentPage).mockResolvedValueOnce({ rows: [], nextCursor: next })
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])

    const page = await listDocumentsPage(session, 'proj-1', { cursor })

    expect(listProjectDocumentPage).toHaveBeenCalledWith(
      'proj-1',
      session.organizationId,
      expect.objectContaining({ cursor })
    )
    expect(page.nextCursor).toBe(encodeDocumentListCursor(next))
  })

  it('reports no next page on the last one', async () => {
    vi.mocked(listProjectDocumentPage).mockResolvedValue({ rows: [], nextCursor: null })
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])
    const page = await listDocumentsPage(session, 'proj-1')
    expect(page.nextCursor).toBeNull()
  })

  it('asks for every author when the caller states no filter', async () => {
    vi.mocked(listProjectDocumentPage).mockResolvedValue({ rows: [], nextCursor: null })
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])

    await listDocuments(session, 'proj-1')

    expect(listProjectDocumentPage).toHaveBeenCalledWith(
      'proj-1',
      session.organizationId,
      expect.objectContaining({ authoredBy: undefined })
    )
  })

  it('carries the curated metadata subset through and strips the internal metadata column', async () => {
    vi.mocked(listProjectDocumentPage).mockResolvedValue({ rows: [], nextCursor: null })
    // reconcile returns rows with the internal `metadata` jsonb (ingestJobId)
    // plus the curated read-only fields layered on top.
    // The production instantiation of `reconcileDocumentStatuses`: repository
    // rows with the curated backend metadata layered on top.
    const reconciled: Array<DocumentListRow & DocumentMetadata> = [
      {
        id: 'doc-1',
        filename: 'plan.pdf',
        displayName: null,
        lifecycle: 'active',
        publishedVersionId: null,
        originPath: null,
        contentHash: null,
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


describe('probeProjectDocumentNames', () => {
  it('asks the listing gate, then the database, for the dropped names', async () => {
    const match = {
      id: 'doc-1',
      filename: 'EG.pdf',
      displayName: null,
      fileSize: 1,
      contentHash: null,
      folderId: null,
      authoredBy: 'user' as const,
      lifecycle: 'archived' as const,
    }
    vi.mocked(findProjectDocumentsByNames).mockResolvedValueOnce([match])

    expect(await probeProjectDocumentNames(session, 'proj-1', ['EG.pdf'])).toEqual([match])
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:view')
    expect(findProjectDocumentsByNames).toHaveBeenCalledWith('proj-1', session.organizationId, ['EG.pdf'])
  })

  it('reads nothing for a reader without the project', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new Error('forbidden'))
    await expect(probeProjectDocumentNames(session, 'proj-1', ['EG.pdf'])).rejects.toThrow('forbidden')
    expect(findProjectDocumentsByNames).not.toHaveBeenCalled()
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

describe('resolveProjectDocumentsByName', () => {
  it('gates on project:view, looks the names up directly, and hydrates like the listing', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    const row = {
      id: 'doc-old',
      filename: 'Bestand-1962.pdf',
      createdAt: new Date('2019-01-01T00:00:00Z'),
      status: 'completed',
      collectionName: 'proj_abc',
      errorMessage: null,
      authoredBy: 'user',
      publishedVersionId: null,
    }
    vi.mocked(findProjectDocumentsByFilenames).mockResolvedValue([row] as never)
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([{ ...row, metadata: { ingestJobId: 'j' } }] as never)

    const documents = await resolveProjectDocumentsByName(session, 'proj-1', ['bestand-1962.pdf'])

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:view')
    expect(findProjectDocumentsByFilenames).toHaveBeenCalledWith('proj-1', 'org-1', ['bestand-1962.pdf'])
    expect(listProjectDocumentPage).not.toHaveBeenCalled()
    expect(documents).toEqual([expect.objectContaining({ id: 'doc-old', assignees: [] })])
    expect(documents[0]).not.toHaveProperty('metadata')
  })

  it('reads nothing for a caller without access', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new ForbiddenError())
    await expect(resolveProjectDocumentsByName(session, 'proj-1', ['a.pdf'])).rejects.toBeInstanceOf(ForbiddenError)
    expect(findProjectDocumentsByFilenames).not.toHaveBeenCalled()
  })
})

describe('searchProjectDocuments', () => {
  // `documentListColumns` selects `authoredBy` (repository.ts), so every row
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
      publishedVersionId: null,
    },
    {
      id: 'doc-b',
      filename: 'permit.pdf',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      status: 'completed',
      collectionName: 'proj_abc',
      errorMessage: null,
      authoredBy: 'user',
      publishedVersionId: null,
    },
  ]

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    vi.mocked(findProjectDocumentsByFilenames).mockResolvedValue([])
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
    // The rows are looked up by the hit names, not read from the paged
    // listing: a hit on a document past the first page must still resolve.
    expect(findProjectDocumentsByFilenames).toHaveBeenCalledWith('proj-1', 'org-1', [
      'permit.pdf',
      'plan.pdf',
    ])
    expect(listProjectDocumentPage).not.toHaveBeenCalled()
  })

  it('asks for no rows when the search found nothing', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ hits: [] }) })

    const { hits } = await searchProjectDocuments(session, 'proj-1', 'q')

    expect(hits).toEqual([])
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:view')
    expect(findProjectDocumentsByFilenames).not.toHaveBeenCalled()
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

  it('re-reads an indexed document a person uploaded, through the same dispatch', async () => {
    // ADR-0071 taught Word and PowerPoint to read their pictures; an unchanged
    // file only picks that up by being read again. No backend question first
    // (the row is terminal) and no chunk delete: the backend keeps the old
    // chunks until the new version has indexed.
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...failedDoc, status: 'completed' })
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-80' }),
    })

    const result = await reingestDocument(session, 'doc-99')

    expect(result).toEqual({ id: 'doc-99', status: 'pending', jobId: 'job-80' })
    expect(describeBackendIngestState).not.toHaveBeenCalled()
    const methods = mockFetch.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method)
    expect(methods).not.toContain('DELETE')
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('/v1/ingest')
  })

  it('refuses to re-read an indexed agent-authored document (409 INGEST_NOT_ELIGIBLE)', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({
        id: 'doc-99',
        status: 'completed',
        storageKey: 'org/proj/doc/file.pdf',
        authoredBy: 'agent',
        authoredByProducer: 'deep_research',
        authoredByRef: 'run-7',
        authoredByRefKind: 'agent_run',
      })
    )

    await expect(reingestDocument(session, 'doc-99')).rejects.toMatchObject({
      status: 409,
      details: { code: INGEST_NOT_ELIGIBLE },
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('refuses a row re-ingest does not apply to (409 INGEST_NOT_ELIGIBLE)', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...failedDoc, status: 'stored' })

    await expect(reingestDocument(session, 'doc-99')).rejects.toMatchObject({
      status: 409,
      details: { status: 'stored', code: INGEST_NOT_ELIGIBLE },
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })

  it('retries a stuck processing row the backend has lost, keeping the id', async () => {
    // A backend restart wiped the job registry and the file never landed: the
    // row says `processing`, the backend knows nothing. The retry re-dispatches
    // under the SAME id, so citations, chat subjects and assignments survive —
    // the old answer here was 409 and delete + re-upload under a new id.
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-99', status: 'processing', storageKey: 'org/proj/doc/file.pdf' })
    )
    vi.mocked(describeBackendIngestState).mockResolvedValue({ state: 'absent' })
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-78' }),
    })

    const result = await reingestDocument(session, 'doc-99')

    expect(result).toEqual({ id: 'doc-99', status: 'pending', jobId: 'job-78' })
    expect(setDocumentIngestJob).toHaveBeenCalledWith('doc-99', 'org-1', 'job-78')
  })

  it('refuses while the backend is genuinely still working (409, no double dispatch)', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-99', status: 'processing', storageKey: 'org/proj/doc/file.pdf' })
    )
    vi.mocked(describeBackendIngestState).mockResolvedValue({ state: 'in-progress' })

    await expect(reingestDocument(session, 'doc-99')).rejects.toBeInstanceOf(ConflictError)
    await expect(reingestDocument(session, 'doc-99')).rejects.toMatchObject({
      details: { status: 'processing', code: INGEST_RUNNING },
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })

  it('heals the row instead of retrying when the backend already finished', async () => {
    // No listing read reconciled the terminal state yet. Re-dispatching now
    // would churn the chunks citations point at, so the row is written back
    // and the retry refused.
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-99', status: 'processing', storageKey: 'org/proj/doc/file.pdf' })
    )
    vi.mocked(describeBackendIngestState).mockResolvedValue({
      state: 'terminal',
      resolution: { status: 'completed', errorMessage: null },
    })

    await expect(reingestDocument(session, 'doc-99')).rejects.toMatchObject({
      status: 409,
      details: { status: 'completed', code: INGEST_ALREADY_DONE },
    })
    expect(setDocumentReconciledStatus).toHaveBeenCalledWith(
      'doc-99',
      'org-1',
      { status: 'completed', errorMessage: null }
    )
    expect(mockFetch).not.toHaveBeenCalled()
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })

  it('heals a row the backend already failed, then retries it', async () => {
    // The reader clicked retry on what looked stuck; it had failed. That is
    // exactly what they were retrying, so it is dispatched rather than 409'd.
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-99', status: 'processing', storageKey: 'org/proj/doc/file.pdf' })
    )
    vi.mocked(describeBackendIngestState).mockResolvedValue({
      state: 'terminal',
      resolution: { status: 'failed', errorMessage: 'boom' },
    })
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-81' }),
    })

    const result = await reingestDocument(session, 'doc-99')

    expect(setDocumentReconciledStatus).toHaveBeenCalledWith('doc-99', 'org-1', {
      status: 'failed',
      errorMessage: 'boom',
    })
    expect(result).toEqual({ id: 'doc-99', status: 'pending', jobId: 'job-81' })
  })

  it('refuses when the backend cannot be asked (fail-closed, row untouched)', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-99', status: 'processing', storageKey: 'org/proj/doc/file.pdf' })
    )
    vi.mocked(describeBackendIngestState).mockResolvedValue({ state: 'unreachable' })

    await expect(reingestDocument(session, 'doc-99')).rejects.toBeInstanceOf(UpstreamError)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
    expect(markDocumentIngestFailed).not.toHaveBeenCalled()
  })

  it('retries a row stranded at the uploaded birth status without asking the backend', async () => {
    // Nothing was ever dispatched for it, so there is nothing running to
    // double and nothing to ask about — straight to re-dispatch.
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-99', status: 'uploaded', storageKey: 'org/proj/doc/file.pdf' })
    )
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-79' }),
    })

    const result = await reingestDocument(session, 'doc-99')

    expect(result).toEqual({ id: 'doc-99', status: 'pending', jobId: 'job-79' })
    expect(describeBackendIngestState).not.toHaveBeenCalled()
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

  // ADR-0078: an Archiv document can be filed too, and a re-ingest that dropped
  // its folder would un-file it on the backend while the database still has it.
  it('re-supplies an ARCHIV document\u2019s folder path on re-ingest', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({
        id: 'doc-99',
        status: 'failed',
        storageKey: 'org/org-1/archiv/doc/doc-99/norm.pdf',
        projectId: null,
        scope: 'archiv',
        collectionName: 'archiv_org-1',
        folderId: 'folder-1',
      })
    )
    vi.mocked(findFolderPathInArchiv).mockResolvedValue('Normen/Brandschutz')

    // An admin holds `org:archiv:manage`, which re-ingesting an Archiv document takes.
    await reingestDocument({ ...session, role: 'admin' }, 'doc-99')

    expect(findFolderPathInArchiv).toHaveBeenCalledWith('folder-1', 'org-1')
    expect(findFolderPathInProject).not.toHaveBeenCalled()
    expect(ingestBody().folder_path).toBe('Normen/Brandschutz')
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

  it('refuses a held document with a 409 before erasing anything', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    vi.mocked(isCoveredByActiveHold).mockResolvedValueOnce(true)
    vi.mocked(s3Client.send).mockClear()
    mockFetch.mockClear()

    const error = await deleteDocument(session, 'doc-1', new Request('http://x')).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).details).toEqual({ reason: 'legal_hold', entityType: 'document' })
    expect(isCoveredByActiveHold).toHaveBeenCalledWith('org-1', 'document', 'doc-1')
    // Nothing went: no chunk purge, no object, no row, no audit.
    expect(mockFetch).not.toHaveBeenCalled()
    expect(s3Client.send).not.toHaveBeenCalled()
    expect(eraseDocumentObjectsOrKeepRow).not.toHaveBeenCalled()
    expect(deleteProjectDocument).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('asks about the hold only after the access check', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError())

    await expect(deleteDocument(session, 'doc-1', new Request('http://x'))).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(isCoveredByActiveHold).not.toHaveBeenCalled()
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

  it('erases every stored object (each version, _thumb, _img/, _bim/) before the row', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    mockFetch.mockResolvedValue({ ok: true })
    const order: string[] = []
    vi.mocked(eraseDocumentObjectsOrKeepRow).mockImplementationOnce(async () => {
      order.push('objects')
    })
    vi.mocked(deleteProjectDocument).mockImplementationOnce(async () => {
      order.push('row')
    })

    await deleteDocument(session, 'doc-1', new Request('http://x'))

    expect(eraseDocumentObjectsOrKeepRow).toHaveBeenCalledWith(projectDoc, 'org-1')
    expect(order).toEqual(['objects', 'row'])
  })

  it('keeps the row, and audits nothing, when the objects could not be erased', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    mockFetch.mockResolvedValue({ ok: true })
    vi.mocked(eraseDocumentObjectsOrKeepRow).mockRejectedValueOnce(new UpstreamError('nope'))

    await expect(deleteDocument(session, 'doc-1', new Request('http://x'))).rejects.toBeInstanceOf(
      UpstreamError
    )
    // The row is the only handle a retry has on the bytes that stayed.
    expect(deleteProjectDocument).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
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

  // An ingest asks whether its document still exists once it has indexed. One
  // that asked before the row went saw it, and kept the chunks it inserted
  // after the first purge; the purge after the row takes those, and every
  // later ask reads „gone“ (ADR-0054, correction 18).
  it('purges the chunks again once the row is gone', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    const order: string[] = []
    mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/documents') && init?.method === 'DELETE') order.push('purge')
      return { ok: true }
    })
    vi.mocked(eraseDocumentObjectsOrKeepRow).mockImplementationOnce(async () => {
      order.push('objects')
    })
    vi.mocked(deleteProjectDocument).mockImplementationOnce(async () => {
      order.push('row')
    })

    await deleteDocument(session, 'doc-1', new Request('http://x'))

    expect(order).toEqual(['purge', 'objects', 'row', 'purge'])
  })

  it('audits and answers normally when only the purge after the row fails', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    mockFetch.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('backend down'))

    await deleteDocument(session, 'doc-1', new Request('http://x'))

    // The row is gone either way; the orphaned-vector sweep is the net, and
    // the audit still says the first purge was confirmed.
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'document.deleted',
        metadata: expect.objectContaining({ chunksPurged: true }),
      })
    )
  })

  it('does not purge after a row it kept', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    mockFetch.mockClear()
    mockFetch.mockResolvedValue({ ok: true })
    vi.mocked(eraseDocumentObjectsOrKeepRow).mockRejectedValueOnce(new UpstreamError('nope'))

    await expect(deleteDocument(session, 'doc-1', new Request('http://x'))).rejects.toBeInstanceOf(
      UpstreamError
    )
    const purges = mockFetch.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/documents') && (init as RequestInit)?.method === 'DELETE'
    )
    expect(purges).toHaveLength(1)
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

  // The chat peek reads this count to tell a failed re-upload (the previous
  // version is still cited) from a file that never indexed at all.
  it('carries the version count from the document_versions summary', async () => {
    vi.mocked(listDocumentVersionSummaries).mockResolvedValueOnce([
      { documentId: projectDoc.id, versionCount: 2, state: 'published' },
    ])

    const status = await getDocumentStatus(session, 'doc-1')

    expect(status).toHaveProperty('versionCount', 2)
    expect(listDocumentVersionSummaries).toHaveBeenCalledWith([projectDoc.id], session.organizationId)
  })

  it('reports a null versionCount when the document has no version row', async () => {
    vi.mocked(listDocumentVersionSummaries).mockResolvedValueOnce([])

    const status = await getDocumentStatus(session, 'doc-1')

    expect(status).toHaveProperty('versionCount', null)
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
      // payload and no `segment_count`, and the mapper defaults rather than
      // dropping the row.
      expect(result.details).toEqual([
        {
          page: 3,
          contentType: 'drawing',
          drawingType: '',
          scale: '',
          text: 'Schnitt A-A',
          segment: 0,
          segmentCount: 1,
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
    it('skips a machine-authored row without touching the colliding chunks', async () => {
      // Belt to the `'user'` filter the listing already applies: a row that
      // reaches the rebuild loop machine-authored is counted as never-eligible,
      // and nothing naming the colliding human document's chunks is sent.
      vi.mocked(listProjectDocumentPage).mockResolvedValueOnce({ nextCursor: null, rows: [
        {
          id: 'doc-agent',
          filename: collidingName,
          displayName: null,
          lifecycle: 'active',
          // Nothing published: an agent DRAFT, which is what a row filed by
          // `fileGeneratedDocument` is until somebody releases a version of it.
          publishedVersionId: null,
          originPath: null,
          contentHash: null,
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
      ] })
      vi.mocked(findDocumentInOrg).mockResolvedValue(agentDoc)

      const result = await runReindexSlice(session, sliceState())

      expect(result.done).toBe(true)
      expect(result.payload.counts).toEqual({ queued: 0, skipped: 1, failed: 0, failedNames: [] })
      expect(documentCalls()).toHaveLength(0)
    })
  })
})

/**
 * „Projekt neu indizieren“ must never leave a document with fewer chunks than
 * it started with. The backend retires the previous version only once the new
 * one has indexed (`_retire_previous_version`), so a delete sent from here
 * first turned every failed dispatch or ingest into an empty document.
 */
describe('reindexProject', () => {
  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
  })

  it('checks the caller may rebuild the project, then queues ONE bulk job and answers with its id', async () => {
    const result = await reindexProject(session, 'proj-1')

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', ['project:documents:write', 'project:edit'])
    expect(result).toEqual({ projectId: 'proj-1', jobId: 'job-1' })
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    const queued = vi.mocked(enqueueJob).mock.calls[0][0]
    expect(queued).toMatchObject({ kind: 'reindex_project', organizationId: 'org-1' })
    expect(queued.priority).toBeUndefined() // the queue's default: bulk
    expect(queued.payload).toEqual({
      projectId: 'proj-1',
      requester: {
        userId: 'user-1',
        email: 'user@example.com',
        organizationMembershipId: 'om-1',
        role: 'member',
        permissions: [],
      },
      cursor: null,
      counts: emptyCounts(),
    })
  })

  it('does not copy the access token into the job', async () => {
    await reindexProject(session, 'proj-1')

    expect(JSON.stringify(vi.mocked(enqueueJob).mock.calls[0][0])).not.toContain('test-access-token')
  })

  it('queues nothing for a caller who may not rebuild the project', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())

    await expect(reindexProject(session, 'proj-1')).rejects.toBeInstanceOf(NotFoundError)

    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('answers a second click with the job already doing it', async () => {
    vi.mocked(findOpenJobId).mockResolvedValueOnce('job-open')

    const result = await reindexProject(session, 'proj-1')

    expect(result).toEqual({ projectId: 'proj-1', jobId: 'job-open' })
    expect(findOpenJobId).toHaveBeenCalledWith({
      kind: 'reindex_project',
      organizationId: 'org-1',
      matching: { projectId: 'proj-1' },
    })
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})

describe('runReindexSlice', () => {
  const listRow = (id: string, filename: string): DocumentListRow => ({
    id,
    filename,
    displayName: null,
    lifecycle: 'active',
    publishedVersionId: null,
    originPath: null,
    contentHash: null,
    fileSize: 1024,
    contentType: 'application/pdf',
    status: 'completed',
    authoredBy: 'user' as const,
    collectionName: 'proj_abc',
    folderId: null,
    createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'),
    errorMessage: null,
    metadata: null,
  })

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
  })

  it('re-dispatches without deleting the current chunks first', async () => {
    vi.mocked(listProjectDocumentPage).mockResolvedValueOnce({ rows: [listRow('doc-1', 'plan.pdf')], nextCursor: null })
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-1', filename: 'plan.pdf', status: 'completed', storageKey: 'k/plan.pdf' })
    )
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ job_id: 'job-1' }) })

    const result = await runReindexSlice(session, sliceState())

    expect(result.done).toBe(true)
    expect(result.payload.counts).toEqual({ queued: 1, skipped: 0, failed: 0, failedNames: [] })
    const methods = mockFetch.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method)
    expect(methods).not.toContain('DELETE')
    expect(mockFetch.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/v1/ingest'),
    ])
    expect(setDocumentIngestJob).toHaveBeenCalledWith('doc-1', 'org-1', 'job-1')
  })

  it('dispatches every document with bulk priority, so a person’s upload goes first', async () => {
    vi.mocked(listProjectDocumentPage).mockResolvedValueOnce({ rows: [listRow('doc-1', 'plan.pdf')], nextCursor: null })
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-1', filename: 'plan.pdf', status: 'completed', storageKey: 'k/plan.pdf' })
    )
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ job_id: 'job-1' }) })

    await runReindexSlice(session, sliceState())

    const body = JSON.parse(String((mockFetch.mock.calls[0][1] as RequestInit).body))
    expect(body.priority).toBe('bulk')
  })

  it('reports a failed dispatch by name, and sends nothing that removes chunks', async () => {
    vi.mocked(listProjectDocumentPage).mockResolvedValueOnce({ rows: [listRow('doc-1', 'plan.pdf')], nextCursor: null })
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-1', filename: 'plan.pdf', status: 'completed', storageKey: 'k/plan.pdf' })
    )
    mockFetch.mockRejectedValue(new Error('backend down'))

    const result = await runReindexSlice(session, sliceState())

    expect(result.payload.counts).toEqual({ queued: 0, skipped: 0, failed: 1, failedNames: ['plan.pdf'] })
    const methods = mockFetch.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method)
    expect(methods).not.toContain('DELETE')
  })

  it('skips every in-flight spelling, not just pending and processing', async () => {
    vi.mocked(listProjectDocumentPage).mockResolvedValueOnce({ rows: [listRow('doc-1', 'plan.pdf')], nextCursor: null })
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-1', filename: 'plan.pdf', status: 'ingesting', storageKey: 'k/plan.pdf' })
    )

    const result = await runReindexSlice(session, sliceState())

    expect(result.payload.counts).toEqual({ queued: 0, skipped: 1, failed: 0, failedNames: [] })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  /**
   * The walk used to read the newest `DOCUMENT_LIST_LIMIT` rows and stop, so
   * a project-wide reindex of a large project left its oldest documents on the
   * old chunks and said nothing. Now a slice is one small page and the job
   * resumes from the cursor it returns, wherever it is claimed next.
   */
  it('takes one page, returns the cursor to resume from, and carries the counts across slices', async () => {
    const cursor = { createdAt: '2026-08-20T00:00:00.000000', id: 'doc-1' }
    vi.mocked(listProjectDocumentPage)
      .mockResolvedValueOnce({ rows: [listRow('doc-1', 'plan.pdf')], nextCursor: cursor })
      .mockResolvedValueOnce({ rows: [listRow('doc-2', 'old.pdf')], nextCursor: null })
    vi.mocked(findDocumentInOrg).mockImplementation(async (id: string) =>
      makeDocument({ id, filename: `${id}.pdf`, status: 'completed', storageKey: `k/${id}.pdf` })
    )
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ job_id: 'job-1' }) })

    const first = await runReindexSlice(session, sliceState())
    expect(first.done).toBe(false)
    expect(first.payload.cursor).toEqual(cursor)
    expect(first.payload.counts.queued).toBe(1)

    // A different worker reads the saved state back and resumes.
    const saved: ReindexProjectPayload = JSON.parse(JSON.stringify(first.payload))
    const second = await runReindexSlice(session, saved)

    expect(second.done).toBe(true)
    expect(second.payload.counts.queued).toBe(2)
    expect(listProjectDocumentPage).toHaveBeenNthCalledWith(1, 'proj-1', 'org-1', {
      authoredBy: 'user',
      cursor: undefined,
      limit: REINDEX_SLICE_DOCUMENTS,
    })
    expect(listProjectDocumentPage).toHaveBeenNthCalledWith(2, 'proj-1', 'org-1', {
      authoredBy: 'user',
      cursor,
      limit: REINDEX_SLICE_DOCUMENTS,
    })
  })

  it('stops, without an error, when the requester has lost access since the job was queued', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())

    const result = await runReindexSlice(session, sliceState())

    expect(result.done).toBe(true)
    expect(listProjectDocumentPage).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('lets any other failure of the access check fail the attempt', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new UpstreamError('WorkOS is down'))

    await expect(runReindexSlice(session, sliceState())).rejects.toBeInstanceOf(UpstreamError)
  })

  it('keeps the first names of failures but counts every one', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => listRow(`doc-${i}`, `plan-${i}.pdf`))
    vi.mocked(listProjectDocumentPage).mockResolvedValueOnce({ rows, nextCursor: null })
    vi.mocked(findDocumentInOrg).mockImplementation(async (id: string) =>
      makeDocument({ id, filename: `${id}.pdf`, status: 'completed', storageKey: `k/${id}.pdf` })
    )
    mockFetch.mockRejectedValue(new Error('backend down'))

    const result = await runReindexSlice(session, sliceState())

    expect(result.payload.counts.failed).toBe(25)
    expect(result.payload.counts.failedNames).toHaveLength(20)
  })
})

describe('the org-wide rescan of failed ingestions', () => {
  const rescanState = (overrides: Partial<ReingestFailedPayload> = {}): ReingestFailedPayload => ({
    requester: sliceState().requester,
    cursor: null,
    counts: emptyCounts(),
    ...overrides,
  })

  describe('reingestFailedOrgDocuments', () => {
    it('queues ONE bulk job for the organization and answers with its id', async () => {
      const result = await reingestFailedOrgDocuments(session)

      expect(result).toEqual({ jobId: 'job-1' })
      expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({
        kind: 'reingest_failed',
        organizationId: 'org-1',
        payload: { cursor: null, counts: emptyCounts() },
      })
    })

    it('answers a second click with the rescan already running', async () => {
      vi.mocked(findOpenJobId).mockResolvedValueOnce('job-open')

      expect(await reingestFailedOrgDocuments(session)).toEqual({ jobId: 'job-open' })
      expect(enqueueJob).not.toHaveBeenCalled()
    })
  })

  describe('runReingestFailedSlice', () => {
    const failedDoc = (id: string) =>
      makeDocument({ id, filename: `${id}.pdf`, status: 'failed', authoredBy: 'user', storageKey: `k/${id}.pdf` })

    // The requester as they are today: an admin, who holds the permission the route is gated on.
    const admin: AuthorizedSession = { ...session, role: 'admin', permissions: ['org:settings:manage'] }

    beforeEach(() => {
      vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ job_id: 'job-1' }) })
    })

    it('stops, without touching a document, when the requester no longer holds the permission the route is gated on', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      const result = await runReingestFailedSlice(session, rescanState()) // `session` is a plain member

      expect(result.done).toBe(true)
      expect(listFailedDocumentPageInOrg).not.toHaveBeenCalled()
      expect(mockFetch).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    it('sends a page of failed documents back with bulk priority and counts them', async () => {
      vi.mocked(listFailedDocumentPageInOrg).mockResolvedValueOnce({ ids: ['doc-1'], nextCursor: null })
      vi.mocked(findDocumentInOrg).mockResolvedValue(failedDoc('doc-1'))

      const result = await runReingestFailedSlice(admin, rescanState())

      expect(result.done).toBe(true)
      expect(result.payload.counts).toEqual({ queued: 1, skipped: 0, failed: 0, failedNames: [] })
      expect(JSON.parse(String((mockFetch.mock.calls[0][1] as RequestInit).body)).priority).toBe('bulk')
      expect(listFailedDocumentPageInOrg).toHaveBeenCalledWith('org-1', {
        limit: REINGEST_SLICE_DOCUMENTS,
        cursor: null,
      })
    })

    it('resumes the walk from the cursor it returned, and audits only when the set is exhausted', async () => {
      const cursor = { createdAt: '2026-08-20T00:00:00.000000', id: 'doc-1' }
      vi.mocked(listFailedDocumentPageInOrg)
        .mockResolvedValueOnce({ ids: ['doc-1'], nextCursor: cursor })
        .mockResolvedValueOnce({ ids: ['doc-2'], nextCursor: null })
      vi.mocked(findDocumentInOrg).mockImplementation(async (id: string) => failedDoc(id))

      const first = await runReingestFailedSlice(admin, rescanState())
      expect(first.done).toBe(false)
      expect(first.payload.cursor).toEqual(cursor)
      expect(recordAuditEvent).not.toHaveBeenCalled()

      const second = await runReingestFailedSlice(admin, JSON.parse(JSON.stringify(first.payload)))

      expect(second.done).toBe(true)
      expect(listFailedDocumentPageInOrg).toHaveBeenLastCalledWith('org-1', {
        limit: REINGEST_SLICE_DOCUMENTS,
        cursor,
      })
      expect(recordAuditEvent).toHaveBeenCalledTimes(1)
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'org.documents.reingested',
          actor: { userId: 'user-1', email: 'user@example.com' },
          metadata: { total: 2, queued: 2, skipped: 0, failed: 0, truncated: false },
        })
      )
    })

    it('counts a row that is not retryable as skipped, never as a failure', async () => {
      vi.mocked(listFailedDocumentPageInOrg).mockResolvedValueOnce({ ids: ['doc-1', 'doc-2', 'doc-3'], nextCursor: null })
      vi.mocked(findDocumentInOrg).mockImplementation(async (id: string) =>
        id === 'doc-1' ? failedDoc(id) : id === 'doc-2' ? makeDocument({ id, status: 'completed', authoredBy: 'agent', storageKey: 'k' }) : (null as never)
      )

      const result = await runReingestFailedSlice(admin, rescanState())

      // doc-1 goes back; doc-2 is an indexed machine document (not eligible); doc-3 is gone.
      expect(result.payload.counts).toEqual({ queued: 1, skipped: 2, failed: 0, failedNames: [] })
    })

    it('records the id of a document whose retry itself went wrong', async () => {
      vi.mocked(listFailedDocumentPageInOrg).mockResolvedValueOnce({ ids: ['doc-1'], nextCursor: null })
      vi.mocked(findDocumentInOrg).mockResolvedValue(failedDoc('doc-1'))
      mockFetch.mockRejectedValue(new Error('backend down'))

      const result = await runReingestFailedSlice(admin, rescanState())

      expect(result.payload.counts).toEqual({ queued: 0, skipped: 0, failed: 1, failedNames: ['doc-1'] })
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ failed: 1 }) })
      )
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

  /** A Windows export: „Maß;Höhe" in cp1252 used to preview as „Ma�;H�he". */
  it('previews a cp1252 CSV as its text, not as replacement glyphs', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(textDoc('text/csv'))
    const cp1252 = Uint8Array.from([0x4d, 0x61, 0xdf, 0x3b, 0x48, 0xf6, 0x68, 0x65, 0x0a, 0x80, 0x0a])
    vi.mocked(s3Client.send).mockResolvedValue({
      Body: { transformToByteArray: async () => cp1252 },
    } as never)

    const { text } = await getDocumentTextPreview(session, 'doc-text')

    expect(text).toBe('Maß;Höhe\n€\n')
  })

  it('keeps a UTF-8 file UTF-8 when the range cut lands inside a character', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(textDoc('text/plain'))
    // 'ä' is two bytes; the cap falls between them, so the prefix is not valid
    // UTF-8 on its own — which must not demote the whole text to cp1252.
    const head = 'x'.repeat(256 * 1024 - 4) + '\n'
    vi.mocked(s3Client.send).mockResolvedValue({ Body: bodyOf(head + 'ä'.repeat(4)) } as never)

    const { text, truncated } = await getDocumentTextPreview(session, 'doc-text')

    expect(truncated).toBe(true)
    expect(text).toBe('x'.repeat(256 * 1024 - 4))
    expect(text).not.toContain('Ã')
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
    contentHash: null,
    folderId: null,
    status: 'ready',
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
    // Admitted under the same lock, at the full new size: the replaced bytes
    // stay as the superseded version (`replaceDocumentWithinQuota`).
    const call = vi.mocked(admitReplacementOrDiscard).mock.calls.at(-1)
    expect(call?.[3]).toBe('doc-existing')
  })

  it('writes its bytes to a key no overlapping re-upload can share', async () => {
    // Two uploads of plan.pdf that overlap both read `nextVersionNumber` = 2.
    // Before the write id they both PUT `…/v2/plan.pdf`, the second silently
    // replacing the first one's bytes.
    await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))
    await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

    const keys = vi
      .mocked(s3Client.send)
      .mock.calls.map(([command]) => (command as unknown as { input: { Key?: string } }).input.Key)
      .filter((key): key is string => typeof key === 'string' && key.endsWith('/plan.pdf'))
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatch(/\/doc\/doc-existing\/v2\/[0-9a-f]{12}\/plan\.pdf$/)
    expect(keys[0]).not.toBe(keys[1])
  })

  it('records the version with the key THIS upload stored, not whatever the row says now', async () => {
    // An overlapping upload may have rewritten the item row between this
    // request's admission and its version insert. Reading the key back off the
    // row recorded the OTHER upload's object twice and this one's never.
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({
        id: 'doc-existing',
        storageKey: 'org/org-1/project/proj-1/doc/doc-existing/v2/000000000000/plan.pdf',
      }),
    )

    await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

    const put = vi
      .mocked(s3Client.send)
      .mock.calls.map(([command]) => (command as unknown as { input: { Key?: string } }).input.Key)
      .find((key) => typeof key === 'string' && key.endsWith('/plan.pdf'))
    const recorded = vi.mocked(insertPublishedVersion).mock.calls.at(-1)?.[0]
    expect(recorded?.storageKey).toBe(put)
    expect(recorded?.storageKey).not.toContain('/000000000000/')
    // The number is not the caller's to hand in: it is allocated at insert.
    expect(recorded).not.toHaveProperty('versionNumber')
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

  /*
   * THE FOLDER RE-SYNC.
   *
   * A büro drops the project directory again to bring three corrected drawings
   * in, and five hundred unchanged files come along with them. The planner
   * skips the ones it can prove are identical, but it can only prove it where
   * the row already carries a digest — so a corpus older than `content_hash`, a
   * browser without `crypto.subtle` and every non-secure context arrive here
   * instead. This tier holds both the bytes and the row, so it can answer.
   */
  describe('and the bytes are the ones already stored', () => {
    const digestOfInput = 'sha256:' + createHash('sha256').update(Buffer.from(new ArrayBuffer(8))).digest('hex')

    it('writes nothing, ingests nothing, and keeps the document', async () => {
      vi.mocked(findLiveDocumentByFilename).mockResolvedValue({
        ...existing,
        contentHash: digestOfInput,
      })

      const result = await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

      expect(result.documentId).toBe('doc-existing')
      expect(admitReplacementOrDiscard).not.toHaveBeenCalled()
      expect(admitOrDiscard).not.toHaveBeenCalled()
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/v1/ingest'))).toBe(false)
    })

    it('still re-ingests when the document has not landed — a failure must be retryable', async () => {
      vi.mocked(findLiveDocumentByFilename).mockResolvedValue({
        ...existing,
        contentHash: digestOfInput,
        status: 'failed',
      })

      await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

      expect(admitReplacementOrDiscard).toHaveBeenCalled()
    })

    it('still runs when the upload re-files it, because the move is the point', async () => {
      vi.mocked(findLiveDocumentByFilename).mockResolvedValue({
        ...existing,
        contentHash: digestOfInput,
        folderId: 'folder-elsewhere',
      })

      await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

      expect(admitReplacementOrDiscard).toHaveBeenCalled()
    })
  })

  /*
   * macOS decomposes the umlaut it stores; Piloti and Windows compose it. The
   * two render identically, and a raw `=` probe misses — so a re-synced folder
   * put a SECOND row beside every document whose name carries one, under a name
   * nobody could tell apart from the first, while the ingest pipeline replaced
   * the chunks of the row it had not created.
   */
  it('probes and stores the name in one Unicode form', async () => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue(null)

    const result = await uploadDocument(
      session,
      makeInput({ name: 'Pru\u0308fbericht.pdf' }),
      new Request('http://x'),
    )

    expect(vi.mocked(findLiveDocumentByFilename).mock.calls.at(-1)?.[2]).toBe('Pr\u00fcfbericht.pdf')
    expect(vi.mocked(admitOrDiscard).mock.calls.at(-1)?.[2]).toMatchObject({
      filename: 'Pr\u00fcfbericht.pdf',
    })
    expect(result.filename).toBe('Pr\u00fcfbericht.pdf')
  })
})

describe('a delete that lands after the upload wrote its row', () => {
  /**
   * The row is written and points at this upload's bytes; a delete commits
   * before the version is recorded. `recordUploadedVersion` used to return
   * null, which nobody read: the upload dispatched the deleted document for
   * ingest and answered 200. It is a 409 now, and nothing downstream runs.
   */
  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    vi.mocked(findProjectInOrg).mockResolvedValue(
      makeProject({ id: 'proj-1', collectionName: 'proj_abc' }),
    )
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue(null)
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)
  })

  it('answers 409, dispatches nothing and takes its object back', async () => {
    await expect(
      uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x')),
    ).rejects.toMatchObject({ status: 409, details: { reason: 'deleted_during_upload' } })

    expect(insertPublishedVersion).not.toHaveBeenCalled()
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/v1/ingest'))).toBe(false)
    expect(recordAuditEvent).not.toHaveBeenCalled()
    // The object this upload PUT is deleted again (the delete usually took it
    // already; deleting a missing key is a no-op).
    const commands = vi.mocked(s3Client.send).mock.calls.map(([command]) => command as unknown as {
      constructor: { name: string }
      input: { Key?: string }
    })
    const put = commands.find((command) => command.constructor.name === 'PutObjectCommand')
    const removed = commands.filter((command) => command.constructor.name === 'DeleteObjectCommand')
    expect(removed.map((command) => command.input.Key)).toContain(put?.input.Key)
  })

  it('does not retry it as a first upload', async () => {
    // Upload, then delete, in commit order: the file being gone is the
    // delete's outcome, so nothing is filed a second time.
    await expect(
      uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x')),
    ).rejects.toMatchObject({ status: 409 })
    expect(admitOrDiscard).toHaveBeenCalledTimes(1)
  })
})

describe('a re-upload whose document is deleted underneath it', () => {
  /**
   * The probe found the document, and a delete committed before the
   * replacement's update. The update matched no row and used to report
   * success: the new object was named by nothing, and a version was recorded
   * for a document that no longer existed. Now it is a first upload of the
   * name again — what the same drop after the delete would have been.
   */
  const existing = {
    id: 'doc-deleted',
    storageKey: 'org/org-1/project/proj-1/doc/doc-deleted/plan.pdf',
    storageBucket: 'test-bucket',
    fileSize: 900,
    contentHash: null,
    folderId: null,
    status: 'ready',
  }

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    vi.mocked(findProjectInOrg).mockResolvedValue(
      makeProject({ id: 'proj-1', collectionName: 'proj_abc' }),
    )
    vi.mocked(findLiveDocumentByFilename).mockResolvedValueOnce(existing).mockResolvedValueOnce(null)
    vi.mocked(admitReplacementOrDiscard).mockRejectedValueOnce(
      new ReplacedDocumentGoneError('doc-deleted'),
    )
  })

  afterEach(() => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue(null)
  })

  it('files the bytes as a first upload under a new id', async () => {
    const result = await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

    expect(admitReplacementOrDiscard).toHaveBeenCalledTimes(1)
    expect(admitOrDiscard).toHaveBeenCalledTimes(1)
    const inserted = vi.mocked(admitOrDiscard).mock.calls.at(-1)
    expect(inserted?.[2]).toMatchObject({ filename: 'plan.pdf' })
    expect(inserted?.[2].id).not.toBe('doc-deleted')
    expect(result.documentId).toBe(inserted?.[2].id)
    // A new document, so the trail does not call it a replacement.
    expect(vi.mocked(recordAuditEvent).mock.calls.at(-1)?.[0]?.metadata).not.toHaveProperty('replaced')
  })
})

describe('two FIRST uploads of one filename at once', () => {
  /**
   * Both probes miss, both PUT under their own fresh id, and
   * `uniq_documents_live_name_per_collection` refuses the second insert. That
   * used to be a 500 after the loser's bytes had landed. The loser becomes the
   * next version of the winner's document \u2014 what the same two drops one after
   * the other would have produced (ADR-0054 correction 14).
   */
  const winner = {
    id: 'doc-winner',
    storageKey: 'org/org-1/project/proj-1/doc/doc-winner/plan.pdf',
    storageBucket: 'test-bucket',
    fileSize: 8,
    contentHash: null,
    folderId: null,
    status: 'uploaded',
  }

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    vi.mocked(findProjectInOrg).mockResolvedValue(
      makeProject({ id: 'proj-1', collectionName: 'proj_abc' }),
    )
    // The loser's probe ran before the winner inserted; its retry's does not.
    vi.mocked(findLiveDocumentByFilename).mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    vi.mocked(admitOrDiscard).mockRejectedValueOnce(new LiveFilenameTakenError('plan.pdf'))
    // No version recorded for the winner yet: the hint reads 1.
    vi.mocked(nextVersionNumber).mockResolvedValueOnce(1)
  })

  afterEach(() => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue(null)
  })

  it('records the loser as a new version of the winner\u2019s document', async () => {
    const result = await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

    expect(result.documentId).toBe('doc-winner')
    expect(admitOrDiscard).toHaveBeenCalledTimes(1)
    expect(vi.mocked(admitReplacementOrDiscard).mock.calls.at(-1)?.[3]).toBe('doc-winner')
    // The version is recorded against the winner's row (the double answers
    // any id with its fixture, so the lookup is what is asserted).
    expect(vi.mocked(findDocumentInOrg).mock.calls.at(-1)?.[0]).toBe('doc-winner')
    expect(insertPublishedVersion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordAuditEvent).mock.calls.at(-1)?.[0]?.metadata).toMatchObject({
      replaced: true,
    })
  })

  it('writes the retry under a write key of its own, never over the winner\u2019s bytes', async () => {
    await uploadDocument(session, makeInput({ name: 'plan.pdf' }), new Request('http://x'))

    const keys = vi
      .mocked(s3Client.send)
      .mock.calls.map(([command]) => (command as unknown as { input: { Key?: string } }).input.Key)
      .filter((key): key is string => typeof key === 'string' && key.endsWith('/plan.pdf'))
    // First attempt under the loser's own fresh id; the retry under the
    // winner's id \u2014 with a write segment even though the hint read 1, because
    // the version-1 shortcut would have been the winner's own flat key.
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toContain('doc-winner')
    expect(keys[1]).toMatch(/\/doc\/doc-winner\/v1\/[0-9a-f]{12}\/plan\.pdf$/)
    expect(keys[1]).not.toBe(winner.storageKey)
    // What is kept is what is charged: the retry's key, at the full size.
    expect(vi.mocked(admitReplacementOrDiscard).mock.calls.at(-1)?.[1]).toBe(keys[1])
    expect(vi.mocked(admitReplacementOrDiscard).mock.calls.at(-1)?.[4]).toMatchObject({
      storageKey: keys[1],
      fileSize: 1234,
    })
  })
})

/*
 * An empty object in the thumbnail slot is no thumbnail. A failed ingest
 * render can leave a 0-byte `_thumb.jpg` behind, which passes the HeadObject
 * existence check and then fails the image optimizer's decode — "isn't a
 * valid image … received null", recurring for the same documents across days
 * (#366, #395).
 */
describe('thumbnails ignore empty objects', () => {
  it('getDocumentThumbnail returns null when the thumbnail object is empty', async () => {
    vi.mocked(s3Client.send).mockResolvedValue({ ContentLength: 0 } as never)

    await expect(getDocumentThumbnail(session, 'doc-1')).resolves.toEqual({ url: null })
    // No signing attempted: there is nothing to point at.
    expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled()
  })

  it('getDocumentThumbnail still serves a non-empty thumbnail', async () => {
    vi.mocked(s3Client.send).mockResolvedValue({ ContentLength: 48211 } as never)

    await expect(getDocumentThumbnail(session, 'doc-1')).resolves.toEqual({
      url: 'https://seaweedfs.internal/presigned',
    })
  })

  it('streamDocumentImage 404s an empty thumbnail object', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'test-secret')
    const imageUrl = new URL(buildDocumentImageUrl('org-1', 'doc-1', 'thumb')!, 'https://grid.test')
    vi.mocked(s3Client.send).mockResolvedValue({ ContentLength: 0, Body: undefined } as never)

    await expect(streamDocumentImage('doc-1', imageUrl.searchParams)).rejects.toBeInstanceOf(
      NotFoundError
    )
  })
})

/**
 * ADR-0070 end to end through the real rendition module, with only the object
 * store and the converter doubled: the preview and the file stream serve the
 * PDF beside an office file, and the download keeps serving the file itself.
 */
describe('an office document is viewed through its PDF rendition', () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const ORIGINAL_KEY = 'org/org-1/project/proj-1/doc/doc-office/v1/Baubeschreibung.docx'
  const RENDITION_KEY = 'org/org-1/project/proj-1/doc/doc-office/v1/_render.pdf'
  const officeDoc = () =>
    makeDocument({ id: 'doc-office', filename: 'Baubeschreibung.docx', contentType: DOCX, storageKey: ORIGINAL_KEY })
  const signedInputs = () =>
    vi.mocked(getSignedUrl).mock.calls.map(([, command]) => (command as { input: Record<string, unknown> }).input)
  const commandOf = (call: number) =>
    (vi.mocked(s3Client.send).mock.calls[call][0] as unknown as { input: Record<string, unknown> }).input

  beforeEach(() => {
    vi.stubEnv('GOTENBERG_URL', 'http://gotenberg:3000')
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    vi.mocked(findDocumentInOrg).mockResolvedValue(officeDoc())
    vi.mocked(getSignedUrl).mockClear()
    vi.mocked(s3Client.send).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.mocked(s3Client.send).mockReset().mockResolvedValue(undefined as never)
  })

  it('previews an existing rendition without converting again', async () => {
    vi.mocked(s3Client.send).mockResolvedValue({ ContentLength: 2048 } as never)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(getDocumentPreview(session, 'doc-office')).resolves.toMatchObject({
      contentType: 'application/pdf',
      rendition: true,
      sourceContentType: DOCX,
      filename: 'Baubeschreibung.docx',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(signedInputs()[0]).toMatchObject({ Key: RENDITION_KEY, ResponseContentType: 'application/pdf' })
  })

  it('converts on first read when no rendition exists yet', async () => {
    vi.mocked(s3Client.send).mockImplementation((async (command: unknown) => {
      if (command instanceof HeadObjectCommand) throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
      if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new Uint8Array([1]) } }
      return {}
    }) as never)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new TextEncoder().encode('%PDF-1.7'))))

    await getDocumentPreview(session, 'doc-office')

    const put = vi
      .mocked(s3Client.send)
      .mock.calls.map(([c]) => c as unknown)
      .find((c): c is PutObjectCommand => c instanceof PutObjectCommand)
    expect(put?.input).toMatchObject({ Key: RENDITION_KEY, ContentType: 'application/pdf' })
  })

  it('streams the rendition, not the original, to the viewer', async () => {
    vi.mocked(s3Client.send)
      .mockResolvedValueOnce({ ContentLength: 2048 } as never)
      .mockResolvedValueOnce({ Body: { transformToWebStream: () => new ReadableStream() } } as never)

    const response = await streamDocumentFile(session, 'doc-office')

    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(commandOf(1)).toMatchObject({ Key: RENDITION_KEY })
  })

  it('downloads the ORIGINAL — the rendition is only ever a view', async () => {
    const download = await getDocumentDownload(session, 'doc-office')

    expect(download).toMatchObject({ filename: 'Baubeschreibung.docx', contentType: DOCX })
    expect(signedInputs()[0]).toMatchObject({ Key: ORIGINAL_KEY })
    expect(String(signedInputs()[0].ResponseContentDisposition)).toContain('attachment')
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('is the old 415 when conversion is not configured', async () => {
    vi.stubEnv('GOTENBERG_URL', '')

    await expect(getDocumentPreview(session, 'doc-office')).rejects.toMatchObject({ status: 415 })
    await expect(streamDocumentFile(session, 'doc-office')).rejects.toMatchObject({ status: 415 })
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('is a 502 RENDITION_FAILED when the converter fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(s3Client.send).mockImplementation((async (command: unknown) => {
      if (command instanceof HeadObjectCommand) throw new Error('NotFound')
      return { Body: { transformToByteArray: async () => new Uint8Array([1]) } }
    }) as never)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('down', { status: 503 })))

    await expect(getDocumentPreview(session, 'doc-office')).rejects.toMatchObject({
      status: 502,
      code: 'RENDITION_FAILED',
    })
  })

  it('answers a file that just failed to convert at once, instead of converting it on every open', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(s3Client.send).mockImplementation((async (command: unknown) => {
      if (command instanceof HeadObjectCommand) throw new Error('NotFound')
      return { Body: { transformToByteArray: async () => new Uint8Array([1]) } }
    }) as never)
    const fetchSpy = vi.fn().mockResolvedValue(new Response('LibreOffice cannot read this', { status: 400 }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(getDocumentPreview(session, 'doc-office')).rejects.toMatchObject({ status: 502 })
    const conversions = fetchSpy.mock.calls.length
    await expect(getDocumentPreview(session, 'doc-office')).rejects.toMatchObject({
      status: 502,
      code: 'RENDITION_FAILED',
    })
    await expect(streamDocumentFile(session, 'doc-office')).rejects.toMatchObject({ status: 502 })
    expect(fetchSpy).toHaveBeenCalledTimes(conversions)
  })
})

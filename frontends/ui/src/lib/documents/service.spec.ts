import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(),
}))

vi.mock('@/lib/s3', () => ({
  s3Client: { send: vi.fn().mockResolvedValue(undefined) },
  signingS3Client: { send: vi.fn().mockResolvedValue(undefined) },
  bucketName: 'test-bucket',
  buildStorageKey: vi.fn().mockReturnValue('org/proj/doc/file.pdf'),
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

vi.mock('./repository', () => ({
  insertDocument: vi.fn().mockResolvedValue(undefined),
  setDocumentIngestJob: vi.fn().mockResolvedValue(undefined),
  markDocumentIngestFailed: vi.fn().mockResolvedValue(undefined),
  findFolderPathInProject: vi.fn().mockResolvedValue(null),
  findDocumentInOrg: vi.fn(),
  listProjectDocuments: vi.fn(),
  deleteProjectDocument: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./reconcile-status', () => ({
  reconcileDocumentStatuses: vi.fn(),
}))

import { findProjectInOrg } from '@/lib/projects/repository'
import { requireProjectAccess } from '@/lib/authz/projects'
import { recordAuditEvent } from '@/lib/audit/service'
import {
  insertDocument,
  setDocumentIngestJob,
  markDocumentIngestFailed,
  findDocumentInOrg,
  listProjectDocuments,
  deleteProjectDocument,
} from './repository'
import {
  listDocuments,
  uploadDocument,
  reingestDocument,
  deleteDocument,
  searchProjectDocuments,
  joinHitsToFiles,
  deriveSearchTopK,
  INGEST_DISPATCH_FAILED_MESSAGE,
} from './service'
import { reconcileDocumentStatuses } from './reconcile-status'
import { isVlmConfigured } from '@/lib/documents/vlm-capability'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'

const session = {
  userId: 'user-1',
  email: 'user@example.com',
  organizationId: 'org-1',
  featureFlags: null,
} as any

const makeInput = (
  overrides: { name?: string; type?: string } = {},
) => ({
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
  vi.mocked(findProjectInOrg).mockResolvedValue({ collectionName: 'proj_abc' } as any)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
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
      uploadDocument(gatedSession, makeInput({ name: 'photo.png', type: 'image/png' }), new Request('http://x')),
    ).rejects.toBeInstanceOf(BadRequestError)

    // Rejected before any storage/ingest side effects.
    expect(insertDocument).not.toHaveBeenCalled()
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
      uploadDocument(gatedSession, makeInput({ name: 'photo.png', type: 'image/png' }), new Request('http://x')),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(insertDocument).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('accepts an image when the flag is on AND the VLM capability is confirmed', async () => {
    // No env opt-in needed — the capability alone (plus the flag) admits images.
    vi.mocked(isVlmConfigured).mockResolvedValue(true)
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    const gatedSession = { ...session, featureFlags: ['image-upload'] }
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ job_id: 'job-img' }) })

    const result = await uploadDocument(
      gatedSession,
      makeInput({ name: 'photo.png', type: 'image/png' }),
      new Request('http://x'),
    )

    expect(result.status).toBe('pending')
    expect(insertDocument).toHaveBeenCalled()
  })

  it('rejects a type outside the accepted list regardless of flags (general allow-list)', async () => {
    // Enforcement off (default) → image-upload fails open, but .exe is still
    // not in the accepted-types list, so the server rejects it.
    await expect(
      uploadDocument(session, makeInput({ name: 'malware.exe', type: 'application/octet-stream' }), new Request('http://x')),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(insertDocument).not.toHaveBeenCalled()
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
    expect(setDocumentIngestJob).toHaveBeenCalledWith(result.documentId, 'job-42')
    expect(markDocumentIngestFailed).not.toHaveBeenCalled()
    // Document is first inserted as 'uploaded' before the job id lands.
    expect(insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'uploaded' }),
    )
  })

  it('dispatch throws: persists status failed + errorMessage', async () => {
    mockFetch.mockRejectedValue(new Error('network down'))

    const result = await uploadDocument(session, makeInput(), new Request('http://x'))

    expect(result.status).toBe('failed')
    expect(result.jobId).toBeNull()
    expect(markDocumentIngestFailed).toHaveBeenCalledWith(
      result.documentId,
      INGEST_DISPATCH_FAILED_MESSAGE,
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
      INGEST_DISPATCH_FAILED_MESSAGE,
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
    expect(markDocumentIngestFailed).toHaveBeenCalledWith(result.documentId, INGEST_DISPATCH_FAILED_MESSAGE)
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })
})

describe('listDocuments', () => {
  it('carries the curated metadata subset through and strips the internal metadata column', async () => {
    vi.mocked(listProjectDocuments).mockResolvedValue([] as any)
    // reconcile returns rows with the internal `metadata` jsonb (ingestJobId)
    // plus the curated read-only fields layered on top.
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([
      {
        id: 'doc-1',
        filename: 'plan.pdf',
        fileSize: 1024,
        contentType: 'application/pdf',
        status: 'completed',
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
    ] as any)

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
  const older = { filename: 'plan.pdf', createdAt: new Date('2026-01-01T00:00:00Z'), id: 'old' }
  const newer = { filename: 'plan.pdf', createdAt: new Date('2026-02-01T00:00:00Z'), id: 'new' }
  const other = { filename: 'permit.pdf', createdAt: new Date('2026-01-05T00:00:00Z'), id: 'permit' }

  it('joins by filename and augments each row with snippet/page/score', () => {
    const hits = [
      { file_name: 'permit.pdf', score: 0.42, snippet: 'permit text', page_number: 3, collection: 'c' },
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
    const hits = [{ file_name: 'ghost.pdf', score: 0.8, snippet: 'x', page_number: null, collection: 'c' }]
    expect(joinHitsToFiles(hits, [older, other])).toEqual([])
  })

  it('resolves a filename collision to the most-recent row', () => {
    const hits = [{ file_name: 'plan.pdf', score: 0.7, snippet: 'x', page_number: null, collection: 'c' }]
    // Feed the older row first so first-seen would pick it; recency must win.
    const [row] = joinHitsToFiles(hits, [older, newer])
    expect(row.id).toBe('new')
  })

  it('coerces a missing page_number to null', () => {
    const hits = [{ file_name: 'plan.pdf', score: 0.3, snippet: 'x', page_number: null, collection: 'c' }]
    const [row] = joinHitsToFiles(hits, [older])
    expect(row.page).toBeNull()
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
  const fileRows = [
    {
      id: 'doc-a',
      filename: 'plan.pdf',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      status: 'completed',
    },
    {
      id: 'doc-b',
      filename: 'permit.pdf',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      status: 'completed',
    },
  ]

  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockResolvedValue(undefined as any)
    vi.mocked(listProjectDocuments).mockResolvedValue([] as any)
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue(
      fileRows.map((r) => ({ ...r, metadata: { ingestJobId: 'j' } })) as any,
    )
    vi.mocked(findProjectInOrg).mockResolvedValue({ collectionName: 'proj_abc' } as any)
  })

  it('enforces project:view, POSTs to the collection search, and joins hits reordered by score', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          hits: [
            { file_name: 'permit.pdf', score: 0.91, snippet: 'permit snippet', page_number: 2, collection: 'proj_abc' },
            { file_name: 'plan.pdf', score: 0.44, snippet: 'plan snippet', page_number: null, collection: 'proj_abc' },
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
    vi.mocked(findProjectInOrg).mockResolvedValue(null as any)
    await expect(searchProjectDocuments(session, 'proj-1', 'q')).rejects.toBeInstanceOf(NotFoundError)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('reingestDocument', () => {
  const failedDoc = {
    id: 'doc-99',
    projectId: 'proj-1',
    organizationId: 'org-1',
    status: 'failed',
    collectionName: 'proj_abc',
    storageKey: 'org/proj/doc/file.pdf',
  } as any

  it('happy path: failed -> pending with a fresh job id', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(failedDoc)
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ job_id: 'job-77' }),
    })

    const result = await reingestDocument(session, 'doc-99')

    expect(result).toEqual({ id: 'doc-99', status: 'pending', jobId: 'job-77' })
    expect(setDocumentIngestJob).toHaveBeenCalledWith('doc-99', 'job-77')
    expect(markDocumentIngestFailed).not.toHaveBeenCalled()
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
    expect(markDocumentIngestFailed).toHaveBeenCalledWith('doc-99', INGEST_DISPATCH_FAILED_MESSAGE)
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })
})

describe('deleteDocument', () => {
  const projectDoc = {
    id: 'doc-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    scope: 'project',
    filename: 'plan.pdf',
    collectionName: 'proj_abc',
    storageKey: 'org/org-1/project/proj-1/doc/doc-1/plan.pdf',
  } as any

  it('404s when the document is not in the org', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)

    await expect(deleteDocument(session, 'missing', new Request('http://x'))).rejects.toBeInstanceOf(NotFoundError)
    expect(deleteProjectDocument).not.toHaveBeenCalled()
  })

  it('404s for an org-wide Archiv document (NULL projectId) — not deletable via the project route', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...projectDoc, projectId: null, scope: 'archiv' })

    await expect(deleteDocument(session, 'doc-1', new Request('http://x'))).rejects.toBeInstanceOf(NotFoundError)
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(deleteProjectDocument).not.toHaveBeenCalled()
  })

  it('rejects callers without project:edit (403) before any side effects', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new ForbiddenError())

    await expect(deleteDocument(session, 'doc-1', new Request('http://x'))).rejects.toBeInstanceOf(ForbiddenError)
    expect(deleteProjectDocument).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('purges chunks, deletes the object + row, and audits', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue(undefined as any)
    mockFetch.mockResolvedValue({ ok: true })

    await deleteDocument(session, 'doc-1', new Request('http://x'))

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:edit')
    // Best-effort backend chunk purge, keyed by the document's collection + filename.
    const purgeCall = mockFetch.mock.calls.find(
      ([url, init]) => String(url).endsWith('/documents') && (init as RequestInit)?.method === 'DELETE',
    )
    expect(purgeCall?.[0]).toBe('http://backend:8000/v1/collections/proj_abc/documents')
    expect(deleteProjectDocument).toHaveBeenCalledWith('doc-1', 'org-1', 'proj-1')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.deleted', organizationId: 'org-1' }),
    )
  })

  it('still deletes the row + audits when the best-effort chunk purge fails', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(projectDoc)
    vi.mocked(requireProjectAccess).mockResolvedValue(undefined as any)
    mockFetch.mockRejectedValue(new Error('backend down'))

    await deleteDocument(session, 'doc-1', new Request('http://x'))

    expect(deleteProjectDocument).toHaveBeenCalledWith('doc-1', 'org-1', 'proj-1')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.deleted' }),
    )
  })
})

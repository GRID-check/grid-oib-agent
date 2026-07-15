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
  buildMinioKey: vi.fn().mockReturnValue('org/proj/doc/file.pdf'),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://minio.internal/presigned'),
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./repository', () => ({
  insertDocument: vi.fn().mockResolvedValue(undefined),
  setDocumentIngestJob: vi.fn().mockResolvedValue(undefined),
  markDocumentIngestFailed: vi.fn().mockResolvedValue(undefined),
  findFolderPathInProject: vi.fn().mockResolvedValue(null),
  findDocumentInOrg: vi.fn(),
  listProjectDocuments: vi.fn(),
}))

vi.mock('./reconcile-status', () => ({
  reconcileDocumentStatuses: vi.fn(),
}))

import { findProjectInOrg } from '@/lib/projects/repository'
import {
  insertDocument,
  setDocumentIngestJob,
  markDocumentIngestFailed,
  findDocumentInOrg,
  listProjectDocuments,
} from './repository'
import { listDocuments, uploadDocument, reingestDocument, INGEST_DISPATCH_FAILED_MESSAGE } from './service'
import { reconcileDocumentStatuses } from './reconcile-status'
import { BadRequestError, ConflictError } from '@/lib/api/errors'

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
  it('rejects an image with a 400 when the image-upload flag is off', async () => {
    // Deployment opted images into the accepted-types list (VLM configured), but
    // flag enforcement is ON and the session lacks image-upload → images stripped.
    vi.stubEnv('FILE_UPLOAD_ACCEPTED_TYPES', '.pdf,.docx,.txt,.md,.png,.jpg,.jpeg')
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    const gatedSession = { ...session, featureFlags: [] }

    await expect(
      uploadDocument(gatedSession, makeInput({ name: 'photo.png', type: 'image/png' }), new Request('http://x')),
    ).rejects.toBeInstanceOf(BadRequestError)

    // Rejected before any storage/ingest side effects.
    expect(insertDocument).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('accepts an image when the image-upload flag is on', async () => {
    // Deployment opted images into the accepted-types list (VLM configured); with
    // the flag on they are permitted. (Images are no longer a shipped default.)
    vi.stubEnv('FILE_UPLOAD_ACCEPTED_TYPES', '.pdf,.docx,.txt,.md,.png,.jpg,.jpeg')
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

describe('reingestDocument', () => {
  const failedDoc = {
    id: 'doc-99',
    projectId: 'proj-1',
    organizationId: 'org-1',
    status: 'failed',
    collectionName: 'proj_abc',
    minioKey: 'org/proj/doc/file.pdf',
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

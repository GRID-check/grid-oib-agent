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
} from './repository'
import { uploadDocument, reingestDocument, INGEST_DISPATCH_FAILED_MESSAGE } from './service'
import { ConflictError } from '@/lib/api/errors'

const session = {
  userId: 'user-1',
  email: 'user@example.com',
  organizationId: 'org-1',
} as any

const makeInput = () => ({
  projectId: 'proj-1',
  folderId: null,
  file: {
    name: 'plan.pdf',
    type: 'application/pdf',
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
  vi.clearAllMocks()
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

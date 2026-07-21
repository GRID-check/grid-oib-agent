import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/organizations', () => ({
  canManageArchiv: vi.fn(),
}))

vi.mock('@/lib/s3', () => ({
  s3Client: { send: vi.fn().mockResolvedValue(undefined) },
  bucketName: 'test-bucket',
  buildArchivMinioKey: vi.fn().mockReturnValue('org/org-1/archiv/doc/d1/plan.pdf'),
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

// Shared document machinery reused by the Archiv — mocked so these tests focus
// on the Archiv service's own orchestration/authorization.
vi.mock('@/lib/documents/service', () => ({
  assertUploadTypeAllowed: vi.fn().mockResolvedValue(undefined),
  dispatchIngest: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
}))

vi.mock('@/lib/documents/reconcile-status', () => ({
  reconcileDocumentStatuses: vi.fn(),
}))

vi.mock('./repository', () => ({
  listArchivDocuments: vi.fn(),
  findArchivDocument: vi.fn(),
  insertArchivDocument: vi.fn().mockResolvedValue(undefined),
  deleteArchivDocument: vi.fn().mockResolvedValue(undefined),
}))

import { canManageArchiv } from '@/lib/authz/organizations'
import { assertUploadTypeAllowed, dispatchIngest } from '@/lib/documents/service'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { recordAuditEvent } from '@/lib/audit/service'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import {
  listArchivDocuments,
  findArchivDocument,
  insertArchivDocument,
  deleteArchivDocument as deleteArchivDocumentRow,
} from './repository'
import { listArchiv, uploadArchivDocument, deleteArchivDocument } from './service'

const session = {
  userId: 'user-1',
  email: 'user@example.com',
  organizationId: 'org-1',
} as any

const makeFile = (name = 'plan.pdf') =>
  ({
    name,
    size: 1024,
    type: 'application/pdf',
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  }) as unknown as File

const request = new Request('http://localhost/api/archiv/documents/upload')

beforeEach(() => {
  // happy-dom's crypto has no randomUUID; the id value is irrelevant here.
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'doc-uuid' })
  }
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('listArchiv', () => {
  it('returns the org archive collection name and the caller manage flag', async () => {
    vi.mocked(listArchivDocuments).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])
    vi.mocked(canManageArchiv).mockReturnValue(true)

    const result = await listArchiv(session)

    expect(result.collectionName).toBe('archiv_org-1')
    expect(result.canManage).toBe(true)
    expect(listArchivDocuments).toHaveBeenCalledWith('org-1')
  })

  it('strips the internal metadata jsonb from every returned row', async () => {
    vi.mocked(listArchivDocuments).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([
      { id: 'd1', filename: 'a.pdf', metadata: { ingestJobId: 'secret' }, summary: 's' } as any,
    ])
    vi.mocked(canManageArchiv).mockReturnValue(false)

    const result = await listArchiv(session)

    expect(result.canManage).toBe(false)
    expect(result.documents[0]).not.toHaveProperty('metadata')
    expect(result.documents[0]).toMatchObject({ id: 'd1', summary: 's' })
  })
})

describe('uploadArchivDocument', () => {
  it('rejects callers without org:archiv:manage (403)', async () => {
    vi.mocked(canManageArchiv).mockReturnValue(false)

    await expect(uploadArchivDocument(session, makeFile(), request)).rejects.toBeInstanceOf(ForbiddenError)
    expect(insertArchivDocument).not.toHaveBeenCalled()
    expect(assertUploadTypeAllowed).not.toHaveBeenCalled()
  })

  it('stores, records, dispatches ingest, and audits on the happy path', async () => {
    vi.mocked(canManageArchiv).mockReturnValue(true)

    const result = await uploadArchivDocument(session, makeFile(), request)

    expect(assertUploadTypeAllowed).toHaveBeenCalledWith(session, 'plan.pdf')
    expect(insertArchivDocument).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', scope: 'archiv', projectId: null, collectionName: 'archiv_org-1' }),
    )
    expect(dispatchIngest).toHaveBeenCalledWith(expect.any(String), 'archiv_org-1', expect.any(String), 'org-1')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'archiv.document.uploaded', organizationId: 'org-1' }),
    )
    expect(result).toMatchObject({ jobId: 'job-1', status: 'pending', filename: 'plan.pdf' })
  })
})

describe('deleteArchivDocument', () => {
  it('rejects callers without org:archiv:manage (403)', async () => {
    vi.mocked(canManageArchiv).mockReturnValue(false)

    await expect(deleteArchivDocument(session, 'd1', request)).rejects.toBeInstanceOf(ForbiddenError)
    expect(deleteArchivDocumentRow).not.toHaveBeenCalled()
  })

  it('404s when the document is not in the org archive', async () => {
    vi.mocked(canManageArchiv).mockReturnValue(true)
    vi.mocked(findArchivDocument).mockResolvedValue(null)

    await expect(deleteArchivDocument(session, 'missing', request)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('purges chunks, deletes the row, and audits', async () => {
    vi.mocked(canManageArchiv).mockReturnValue(true)
    vi.mocked(findArchivDocument).mockResolvedValue({
      id: 'd1',
      filename: 'plan.pdf',
      collectionName: 'archiv_org-1',
      minioKey: 'org/org-1/archiv/doc/d1/plan.pdf',
    } as any)
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    await deleteArchivDocument(session, 'd1', request)

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://backend:8000/v1/collections/archiv_org-1/documents',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(deleteArchivDocumentRow).toHaveBeenCalledWith('d1', 'org-1')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'archiv.document.deleted' }),
    )
  })
})

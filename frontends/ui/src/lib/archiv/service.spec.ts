import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/organizations', () => ({
  canManageArchiv: vi.fn(),
}))

vi.mock('@/lib/s3', () => ({
  s3Client: { send: vi.fn().mockResolvedValue(undefined) },
  bucketName: 'test-bucket',
  buildArchivStorageKey: vi.fn().mockReturnValue('org/org-1/archiv/doc/d1/plan.pdf'),
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
  // The semantic-search join is unit-tested in the documents service; here we
  // assert the Archiv service wires the collection + hits through it correctly.
  fetchSemanticHits: vi.fn(),
  joinHitsToFiles: vi.fn(),
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
import { assertUploadTypeAllowed, dispatchIngest, fetchSemanticHits, joinHitsToFiles } from '@/lib/documents/service'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { recordAuditEvent } from '@/lib/audit/service'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import {
  listArchivDocuments,
  findArchivDocument,
  insertArchivDocument,
  deleteArchivDocument as deleteArchivDocumentRow,
} from './repository'
import { listArchiv, uploadArchivDocument, deleteArchivDocument, searchArchivDocuments } from './service'

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

describe('searchArchivDocuments', () => {
  it('resolves the org archiv collection, runs the search, and returns the joined hits', async () => {
    const docs = [{ id: 'd1', filename: 'plan.pdf', createdAt: new Date('2026-01-01T00:00:00Z') }]
    vi.mocked(listArchivDocuments).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue(docs.map((d) => ({ ...d, metadata: {} })) as any)
    vi.mocked(canManageArchiv).mockReturnValue(false)
    const backendHits = [{ file_name: 'plan.pdf', score: 0.8, snippet: 's', page_number: 1, collection: 'archiv_org-1' }]
    vi.mocked(fetchSemanticHits).mockResolvedValue(backendHits as any)
    vi.mocked(joinHitsToFiles).mockReturnValue([{ id: 'd1', snippet: 's', page: 1, score: 0.8 }] as any)

    const { hits } = await searchArchivDocuments(session, 'fire escape', 20)

    expect(fetchSemanticHits).toHaveBeenCalledWith('archiv_org-1', 'fire escape', 20)
    // Joined against the Archiv's own reconciled rows (not the raw backend hits).
    expect(joinHitsToFiles).toHaveBeenCalledWith(backendHits, expect.arrayContaining([expect.objectContaining({ id: 'd1' })]))
    expect(hits).toEqual([{ id: 'd1', snippet: 's', page: 1, score: 0.8 }])
  })

  it('defaults topK to 20 when omitted', async () => {
    vi.mocked(listArchivDocuments).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])
    vi.mocked(canManageArchiv).mockReturnValue(false)
    vi.mocked(fetchSemanticHits).mockResolvedValue([])
    vi.mocked(joinHitsToFiles).mockReturnValue([])

    await searchArchivDocuments(session, 'q')

    expect(fetchSemanticHits).toHaveBeenCalledWith('archiv_org-1', 'q', 20)
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
      storageKey: 'org/org-1/archiv/doc/d1/plan.pdf',
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

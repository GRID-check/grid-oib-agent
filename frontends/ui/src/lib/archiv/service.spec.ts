import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/storage/service', () => ({
  // The quota check is exercised in src/lib/storage/service.spec.ts; here it is
  // stubbed to a no-op so these specs keep testing the upload path itself
  // rather than reaching Postgres for org settings.
  assertWithinStorageQuota: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/authz/organizations', () => ({
  canManageArchiv: vi.fn(),
}))

// Clients doubled, key builders real — see the note in
// `@/lib/documents/service.spec.ts` for why a stubbed builder made the key
// assertions vacuous.
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: vi.fn().mockResolvedValue(undefined) },
  bucketAdminS3Client: { send: vi.fn().mockResolvedValue(undefined) },
  bucketName: 'test-bucket',
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
  assertFileSizeAllowed: vi.fn(),
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

// The admitting insert, not the repository's — see the note in
// `documents/service.spec.ts`. The Archiv shares the tenant's bytes, so it goes
// through the same quota admission and the same compensating delete.
vi.mock('@/lib/storage/admission', () => ({
  admitOrDiscard: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./repository', () => ({
  listArchivDocuments: vi.fn(),
  findArchivDocument: vi.fn(),
  deleteArchivDocument: vi.fn().mockResolvedValue(undefined),
}))

import { canManageArchiv } from '@/lib/authz/organizations'
import { assertUploadTypeAllowed, dispatchIngest, fetchSemanticHits, joinHitsToFiles } from '@/lib/documents/service'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { recordAuditEvent } from '@/lib/audit/service'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { admitOrDiscard } from '@/lib/storage/admission'
import {
  listArchivDocuments,
  findArchivDocument,
  deleteArchivDocument as deleteArchivDocumentRow,
} from './repository'
import { listArchiv, uploadArchivDocument, deleteArchivDocument, searchArchivDocuments } from './service'
import { makeDocument } from '@/test-utils/db-fixtures'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentMetadata, ReconcilableDocument } from '@/lib/documents/reconcile-status'
import type { SearchedDocument } from '@/lib/documents/service'

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
    const reconciled: Array<ReconcilableDocument & DocumentMetadata> = [
      {
        id: 'd1',
        filename: 'a.pdf',
        status: 'completed',
        collectionName: 'archiv_org-1',
        errorMessage: null,
        metadata: { ingestJobId: 'secret' },
        summary: 's',
      },
    ]
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue(reconciled)
    vi.mocked(canManageArchiv).mockReturnValue(false)

    const result = await listArchiv(session)

    expect(result.canManage).toBe(false)
    expect(result.documents[0]).not.toHaveProperty('metadata')
    expect(result.documents[0]).toMatchObject({ id: 'd1', summary: 's' })
  })
})

describe('searchArchivDocuments', () => {
  it('resolves the org archiv collection, runs the search, and returns the joined hits', async () => {
    const docs: Array<ReconcilableDocument & { createdAt: Date }> = [
      {
        id: 'd1',
        filename: 'plan.pdf',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        status: 'completed',
        collectionName: 'archiv_org-1',
        errorMessage: null,
      },
    ]
    vi.mocked(listArchivDocuments).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue(docs.map((d) => ({ ...d, metadata: {} })))
    vi.mocked(canManageArchiv).mockReturnValue(false)
    const backendHits = [{ file_name: 'plan.pdf', score: 0.8, snippet: 's', page_number: 1, collection: 'archiv_org-1' }]
    vi.mocked(fetchSemanticHits).mockResolvedValue(backendHits)
    const joinedHits: Array<SearchedDocument<(typeof docs)[number]>> = [
      { ...docs[0], snippet: 's', page: 1, score: 0.8 },
    ]
    vi.mocked(joinHitsToFiles).mockReturnValue(joinedHits)

    const { hits } = await searchArchivDocuments(session, 'fire escape', 20)

    expect(fetchSemanticHits).toHaveBeenCalledWith('archiv_org-1', 'fire escape', 20)
    // Joined against the Archiv's own reconciled rows (not the raw backend hits).
    expect(joinHitsToFiles).toHaveBeenCalledWith(backendHits, expect.arrayContaining([expect.objectContaining({ id: 'd1' })]))
    // The service returns the join result untouched — the document row plus
    // its match evidence, not a trimmed projection of it.
    expect(hits).toEqual(joinedHits)
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
    expect(admitOrDiscard).not.toHaveBeenCalled()
    expect(assertUploadTypeAllowed).not.toHaveBeenCalled()
  })

  it('stores, records, dispatches ingest, and audits on the happy path', async () => {
    vi.mocked(canManageArchiv).mockReturnValue(true)

    const result = await uploadArchivDocument(session, makeFile(), request)

    expect(assertUploadTypeAllowed).toHaveBeenCalledWith(session, 'plan.pdf')
    expect(admitOrDiscard).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ organizationId: 'org-1', scope: 'archiv', projectId: null, collectionName: 'archiv_org-1' }),
    )
    // The bucket travels with the key (ADR-0043): both presigned URLs the
    // ingest dispatch mints — the download and the thumbnail slot — have to
    // name the bucket the object was actually written to, and with the flag
    // off that is the shared one.
    expect(dispatchIngest).toHaveBeenCalledWith(
      expect.any(String),
      'archiv_org-1',
      expect.stringMatching(/^org\/org-1\/archiv\/doc\/[^/]+\/plan\.pdf$/),
      'org-1',
      'test-bucket',
    )
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
    vi.mocked(findArchivDocument).mockResolvedValue(
      makeDocument({
        id: 'd1',
        scope: 'archiv',
        projectId: null,
        collectionName: 'archiv_org-1',
        storageKey: 'org/org-1/archiv/doc/d1/plan.pdf',
      }),
    )
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

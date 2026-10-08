import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `document_versions` is not this suite's subject (ADR-0054). The upload path
 * records a version through the lifecycle; here that reduces to "it was asked
 * for", and the version table's own behaviour is `lifecycle.spec.ts`'s.
 */
vi.mock('@/lib/documents/version-repository', () => ({
  DOCUMENT_VERSION_LIST_LIMIT: 200,
  insertDocumentVersion: vi.fn(async (values: Record<string, unknown>) => ({
    id: 'version_1',
    state: 'published',
    versionNumber: 1,
    ...values,
  })),
  // The born-published insert every upload records its version with.
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

// The upload-screening policy (ADR-0085) the name gate reads: an office on
// Piloti's suggested list. Unreadable settings refuse the upload outright.
vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: vi.fn(async () => ({ displayName: null, defaultLocale: 'de', settings: {} })),
  writeDedicatedOrgSetting: vi.fn(),
}))
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

// Shared document machinery reused by the Archiv — mocked so these tests focus
// on the Archiv service's own orchestration/authorization.
vi.mock('@/lib/documents/service', () => ({
  assertFileSizeAllowed: vi.fn(),
  assertUploadTypeAllowed: vi.fn().mockResolvedValue(undefined),
  // The ONE model-vs-ingest dispatcher every shelf shares. The Archiv used to
  // call `dispatchIngest` with its own `isIfcFilename` branch beside it; the
  // branch now lives in `dispatchDocument`, which is what this asserts on.
  dispatchDocument: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
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
// The re-upload collision lookup. Default: no collision, so the Archiv upload
// path is the insert path it has always been.
vi.mock('@/lib/documents/repository', () => ({
  findLiveDocumentByFilename: vi.fn().mockResolvedValue(null),
  // The folder an upload is filed into, resolved on the Archiv shelf. Default:
  // no such folder, so an upload that names one is a 404 unless a test says
  // otherwise.
  findFolderPathInArchiv: vi.fn().mockResolvedValue(null),
  // Read back by `recordUploadedVersion` (ADR-0054) before it records version
  // 1. The row the upload just wrote: a miss means the document was deleted
  // mid-upload, which is a 409 of its own (ADR-0054 correction 17), so the
  // default is the row existing.
  findDocumentInOrg: vi.fn(async (id: string) =>
    (await import('@/test-utils/db-fixtures')).makeDocument({ id, projectId: null, scope: 'archiv' }),
  ),
}))

vi.mock('@/lib/storage/admission', () => ({
  admitOrDiscard: vi.fn().mockResolvedValue(undefined),
  admitReplacementOrDiscard: vi.fn().mockResolvedValue(undefined),
}))

// The hold predicate is SQL (`grid_legal_hold_blocks`, migration 0093) and is
// exercised against Postgres in `legal-hold.integration.spec.ts`; here the gate
// itself runs for real over a doubled answer.
// The erasure of a document's objects is `object-cleanup.spec.ts`'s subject;
// here it is what the delete asks for, and what the delete does when it fails.
vi.mock('@/lib/documents/object-cleanup', () => ({
  eraseDocumentObjectsOrKeepRow: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/compliance/repository', () => ({
  isCoveredByActiveHold: vi.fn().mockResolvedValue(false),
}))

vi.mock('./repository', () => ({
  listArchivDocuments: vi.fn(),
  findArchivDocumentsByFilenames: vi.fn(),
  findArchivDocument: vi.fn(),
  deleteArchivDocument: vi.fn().mockResolvedValue(undefined),
}))

import { canManageArchiv } from '@/lib/authz/organizations'
import { assertUploadTypeAllowed, dispatchDocument, fetchSemanticHits, joinHitsToFiles } from '@/lib/documents/service'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { recordAuditEvent } from '@/lib/audit/service'
import { ConflictError, ForbiddenError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import { isCoveredByActiveHold } from '@/lib/compliance/repository'
import { eraseDocumentObjectsOrKeepRow } from '@/lib/documents/object-cleanup'
import { s3Client } from '@/lib/s3'
import { admitOrDiscard, admitReplacementOrDiscard } from '@/lib/storage/admission'
import { findDocumentInOrg, findFolderPathInArchiv, findLiveDocumentByFilename } from '@/lib/documents/repository'
import { LiveFilenameTakenError, ReplacedDocumentGoneError } from '@/lib/documents/unique-conflicts'
import {
  listArchivDocuments,
  findArchivDocument,
  findArchivDocumentsByFilenames,
  deleteArchivDocument as deleteArchivDocumentRow,
} from './repository'
import { decodeDocumentListCursor, encodeDocumentListCursor } from '@/lib/documents/list-cursor'
import {
  listArchiv,
  uploadArchivDocument,
  deleteArchivDocument,
  resolveArchivDocumentsByName,
  searchArchivDocuments,
} from './service'
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
    vi.mocked(listArchivDocuments).mockResolvedValue({ rows: [], nextCursor: null })
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])
    vi.mocked(canManageArchiv).mockReturnValue(true)

    const result = await listArchiv(session)

    expect(result.collectionName).toBe('archiv_org-1')
    expect(result.canManage).toBe(true)
    expect(listArchivDocuments).toHaveBeenCalledWith('org-1', { cursor: undefined })
    expect(result.nextCursor).toBeNull()
  })

  // The Archiv is paged, not capped: the next page's position leaves as an
  // opaque cursor and comes back decoded to the repository.
  it('encodes the next page position and passes a decoded cursor through', async () => {
    const next = { createdAt: '2026-01-01T00:00:00.123456', id: '00000000-0000-4000-8000-000000000001' }
    vi.mocked(listArchivDocuments).mockResolvedValue({ rows: [], nextCursor: next })
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])
    const cursor = { createdAt: '2026-02-01T00:00:00.000001', id: '00000000-0000-4000-8000-000000000002' }

    const result = await listArchiv(session, { cursor })

    expect(listArchivDocuments).toHaveBeenCalledWith('org-1', { cursor })
    expect(result.nextCursor).toBe(encodeDocumentListCursor(next))
    expect(decodeDocumentListCursor(result.nextCursor ?? '')).toEqual(next)
  })

  it('strips the internal metadata jsonb from every returned row', async () => {
    vi.mocked(listArchivDocuments).mockResolvedValue({ rows: [], nextCursor: null })
    const reconciled: Array<ReconcilableDocument & DocumentMetadata> = [
      {
        id: 'd1',
        filename: 'a.pdf',
        status: 'completed',
        collectionName: 'archiv_org-1',
        authoredBy: 'user',
        publishedVersionId: null,
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

  // The Archiv's listing takes the options a project's does, and hands them to
  // the shared shelf query unchanged — it is not a second place that decides what
  // an archived or agent-written document is.
  it('passes the lifecycle and author filters to the shelf listing', async () => {
    vi.mocked(listArchivDocuments).mockResolvedValue({ rows: [], nextCursor: null })
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])

    await listArchiv(session, { includeArchived: true, authoredBy: 'agent' })

    expect(listArchivDocuments).toHaveBeenCalledWith('org-1', { includeArchived: true, authoredBy: 'agent' })
  })

  // Every row carries the fields a project's listing carries, assignees
  // included: it is the same hydration (`toListedDocuments`).
  it('hydrates rows exactly as a project listing does', async () => {
    vi.mocked(listArchivDocuments).mockResolvedValue({ rows: [], nextCursor: null })
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([
      {
        id: 'd1',
        filename: 'a.pdf',
        status: 'completed',
        collectionName: 'archiv_org-1',
        authoredBy: 'user',
        publishedVersionId: null,
        errorMessage: null,
        metadata: {},
      },
    ])

    const result = await listArchiv(session)

    expect(result.documents[0]).toMatchObject({ id: 'd1', assignees: [] })
  })
})

describe('searchArchivDocuments', () => {
  it('resolves the org archiv collection, runs the search, and returns the joined hits', async () => {
    // `listArchiv` selects `authoredBy` (archiv/repository.ts), and
    // `joinHitsToFiles` requires it — a row without it would be a compile error,
    // which is the point: the authorship filter cannot be bypassed by a caller
    // that forgets the column.
    const docs: Array<ReconcilableDocument & { createdAt: Date; authoredBy: string }> = [
      {
        id: 'd1',
        filename: 'plan.pdf',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        status: 'completed',
        collectionName: 'archiv_org-1',
        errorMessage: null,
        authoredBy: 'user',
        publishedVersionId: null,
      },
    ]
    vi.mocked(findArchivDocumentsByFilenames).mockResolvedValue([])
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
    // The join reads the hit names directly, not the paged listing — a hit on
    // a document past the first page must still resolve.
    expect(findArchivDocumentsByFilenames).toHaveBeenCalledWith('org-1', ['plan.pdf'])
    expect(listArchivDocuments).not.toHaveBeenCalled()
    // Joined against the Archiv's own reconciled rows (not the raw backend hits).
    expect(joinHitsToFiles).toHaveBeenCalledWith(backendHits, expect.arrayContaining([expect.objectContaining({ id: 'd1' })]))
    // The service returns the join result untouched — the document row plus
    // its match evidence, not a trimmed projection of it.
    expect(hits).toEqual(joinedHits)
  })

  it('defaults topK to 20 when omitted', async () => {
    vi.mocked(findArchivDocumentsByFilenames).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])
    vi.mocked(canManageArchiv).mockReturnValue(false)
    vi.mocked(fetchSemanticHits).mockResolvedValue([])
    vi.mocked(joinHitsToFiles).mockReturnValue([])

    await searchArchivDocuments(session, 'q')

    expect(fetchSemanticHits).toHaveBeenCalledWith('archiv_org-1', 'q', 20)
    // No hits, no lookup.
    expect(findArchivDocumentsByFilenames).not.toHaveBeenCalled()
  })
})

describe('resolveArchivDocumentsByName', () => {
  it('looks the names up directly and hydrates them like the listing', async () => {
    const row = {
      id: 'd9',
      filename: 'Alt.pdf',
      createdAt: new Date('2019-01-01T00:00:00Z'),
      status: 'completed',
      collectionName: 'archiv_org-1',
      errorMessage: null,
      authoredBy: 'user',
      publishedVersionId: null,
    }
    vi.mocked(findArchivDocumentsByFilenames).mockResolvedValue([row] as never)
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([{ ...row, metadata: {} }] as never)

    const documents = await resolveArchivDocumentsByName(session, ['alt.pdf'])

    expect(findArchivDocumentsByFilenames).toHaveBeenCalledWith('org-1', ['alt.pdf'])
    expect(listArchivDocuments).not.toHaveBeenCalled()
    expect(documents.map((doc) => doc.id)).toEqual(['d9'])
    expect(documents[0]).not.toHaveProperty('metadata')
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
    expect(dispatchDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        projectId: null,
        filename: 'plan.pdf',
        collectionName: 'archiv_org-1',
        storageKey: expect.stringMatching(/^org\/org-1\/archiv\/doc\/[^/]+\/plan\.pdf$/),
        storageBucket: 'test-bucket',
      }),
    )
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'archiv.document.uploaded', organizationId: 'org-1' }),
    )
    expect(result).toMatchObject({ jobId: 'job-1', status: 'pending', filename: 'plan.pdf' })
  })

  describe('into a folder', () => {
    beforeEach(() => {
      vi.mocked(canManageArchiv).mockReturnValue(true)
    })

    it('files the document in an Archiv folder and tells the backend its PATH', async () => {
      vi.mocked(findFolderPathInArchiv).mockResolvedValueOnce('Normen/Brandschutz')

      await uploadArchivDocument(session, makeFile(), request, {
        folderId: 'folder-1',
        originPath: 'Normen/Brandschutz/plan.pdf',
      })

      expect(findFolderPathInArchiv).toHaveBeenCalledWith('folder-1', 'org-1')
      expect(admitOrDiscard).toHaveBeenCalledWith(
        expect.any(String),
        // The key carries the folder AT UPLOAD, as a project's does.
        expect.stringMatching(/^org\/org-1\/archiv\/Normen\/Brandschutz\/doc\/[^/]+\/plan\.pdf$/),
        expect.objectContaining({
          scope: 'archiv',
          projectId: null,
          folderId: 'folder-1',
          originPath: 'Normen/Brandschutz/plan.pdf',
        }),
      )
      // ADR-0049: the backend files it under the path from the first ingest on.
      expect(dispatchDocument).toHaveBeenCalledWith(
        expect.objectContaining({ folderPath: 'Normen/Brandschutz', collectionName: 'archiv_org-1' }),
      )
    })

    it('is a 404 for a folder that is not on this organization\u2019s Archiv shelf', async () => {
      // The default: another tenant's, a project's or a missing folder resolves
      // to nothing on the Archiv shelf.
      await expect(
        uploadArchivDocument(session, makeFile(), request, { folderId: 'folder-elsewhere' }),
      ).rejects.toBeInstanceOf(NotFoundError)
      expect(admitOrDiscard).not.toHaveBeenCalled()
      expect(s3Client.send).not.toHaveBeenCalled()
    })

    it('re-files the one document when the same name is uploaded into a different folder', async () => {
      vi.mocked(findFolderPathInArchiv).mockResolvedValueOnce('Pläne')
      vi.mocked(findLiveDocumentByFilename).mockResolvedValue({
        id: 'archiv-doc-1',
        storageKey: 'org/org-1/archiv/doc/archiv-doc-1/plan.pdf',
        storageBucket: 'test-bucket',
        fileSize: 8,
        contentHash: null,
        folderId: null,
        status: 'ready',
      })

      const result = await uploadArchivDocument(session, makeFile(), request, { folderId: 'folder-2' })

      expect(result.documentId).toBe('archiv-doc-1')
      expect(admitReplacementOrDiscard).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'org-1',
        'archiv-doc-1',
        expect.objectContaining({ folderId: 'folder-2' }),
      )
    })

    it('does nothing when the same bytes are already filed where this upload would file them', async () => {
      const { contentDigest } = await import('@/lib/documents/content-digest')
      const digest = contentDigest(Buffer.from(new ArrayBuffer(8)))
      vi.mocked(findLiveDocumentByFilename).mockResolvedValue({
        id: 'archiv-doc-1',
        storageKey: 'org/org-1/archiv/doc/archiv-doc-1/plan.pdf',
        storageBucket: 'test-bucket',
        fileSize: 8,
        contentHash: digest,
        folderId: null,
        status: 'completed',
      })

      const result = await uploadArchivDocument(session, makeFile(), request)

      expect(result).toMatchObject({ documentId: 'archiv-doc-1', unchanged: true, jobId: null })
      expect(s3Client.send).not.toHaveBeenCalled()
      expect(dispatchDocument).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })
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

  // An ingest that asked whether its document exists before the row went saw
  // it, and kept chunks inserted after the first purge; the purge after the
  // row takes those (ADR-0054, correction 18).
  it('purges the chunks again once the row is gone, and a failure there is not surfaced', async () => {
    const doc = makeDocument({
      id: 'd1',
      scope: 'archiv',
      projectId: null,
      collectionName: 'archiv_org-1',
      storageKey: 'org/org-1/archiv/doc/d1/plan.pdf',
    })
    vi.mocked(canManageArchiv).mockReturnValue(true)
    vi.mocked(findArchivDocument).mockResolvedValue(doc)
    const order: string[] = []
    let purges = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        order.push('purge')
        purges += 1
        if (purges === 2) throw new Error('backend down')
        return { ok: true }
      }),
    )
    vi.mocked(eraseDocumentObjectsOrKeepRow).mockImplementationOnce(async () => {
      order.push('objects')
    })
    vi.mocked(deleteArchivDocumentRow).mockImplementationOnce(async () => {
      order.push('row')
    })

    await deleteArchivDocument(session, 'd1', request)

    expect(order).toEqual(['purge', 'objects', 'row', 'purge'])
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'archiv.document.deleted',
        metadata: expect.objectContaining({ chunksPurged: true }),
      }),
    )
  })

  it('refuses a held document with a 409 before erasing anything', async () => {
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
    vi.mocked(isCoveredByActiveHold).mockResolvedValueOnce(true)
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
    vi.mocked(s3Client.send).mockClear()

    const error = await deleteArchivDocument(session, 'd1', request).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).details).toEqual({ reason: 'legal_hold', entityType: 'document' })
    expect(isCoveredByActiveHold).toHaveBeenCalledWith('org-1', 'document', 'd1')
    // Nothing went: no chunk purge, no object delete, no row, no audit.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(s3Client.send).not.toHaveBeenCalled()
    expect(eraseDocumentObjectsOrKeepRow).not.toHaveBeenCalled()
    expect(deleteArchivDocumentRow).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'archiv.document.deleted' }),
    )
  })

  it('erases every stored object through the shared cleanup, and keeps the row when it fails', async () => {
    const doc = makeDocument({
      id: 'd1',
      scope: 'archiv',
      projectId: null,
      collectionName: 'archiv_org-1',
      storageKey: 'org/org-1/archiv/doc/d1/plan.pdf',
    })
    vi.mocked(canManageArchiv).mockReturnValue(true)
    vi.mocked(findArchivDocument).mockResolvedValue(doc)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.mocked(eraseDocumentObjectsOrKeepRow).mockRejectedValueOnce(new UpstreamError('nope'))

    await expect(deleteArchivDocument(session, 'd1', request)).rejects.toBeInstanceOf(UpstreamError)

    // The `_img/` rasters used to be left behind here and every failure
    // swallowed; now the shared erasure runs, and a failure keeps the row.
    expect(eraseDocumentObjectsOrKeepRow).toHaveBeenCalledWith(doc, 'org-1')
    expect(deleteArchivDocumentRow).not.toHaveBeenCalled()
  })

  it('purges no chunks for a machine-authored row, and still deletes it', async () => {
    // An Archiv row cannot be machine-authored today: `fileGeneratedDocument`
    // sets no scope, so the column defaults to `project`. That is a coincidence
    // of a default, and this call — DELETE by `file_ids: [filename]` — is the
    // exact shape that took a human document's chunks out of retrieval when a
    // machine-written report shared its name. The row still goes; it is only
    // the purge that has nothing to do, because such a row owns no chunks.
    vi.mocked(canManageArchiv).mockReturnValue(true)
    vi.mocked(findArchivDocument).mockResolvedValue(
      makeDocument({
        id: 'd1',
        scope: 'archiv',
        projectId: null,
        authoredBy: 'agent',
        collectionName: 'archiv_org-1',
        storageKey: 'org/org-1/archiv/doc/d1/plan.pdf',
      }),
    )
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    await deleteArchivDocument(session, 'd1', request)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(deleteArchivDocumentRow).toHaveBeenCalledWith('d1', 'org-1')
  })

  /**
   * The Archiv is not a different filing system — it is the same `documents`
   * table with `scope = 'archiv'` — so it carried the same ghost: a second
   * upload of one filename wrote a second row and a second stored object, while
   * the ingest pipeline's filename-keyed chunk replacement killed the first
   * row's chunks. Listed, downloadable, findable by nothing, billed twice.
   */
  it('replaces an Archiv document of the same name instead of ghosting it', async () => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue({
      id: 'archiv-doc-1',
      storageKey: 'org/org-1/archiv/archiv-doc-1/norm.pdf',
      storageBucket: 'test-bucket',
      fileSize: 500,
      contentHash: null,
      folderId: null,
      status: 'ready',
    })

    vi.mocked(canManageArchiv).mockReturnValue(true)

    const result = await uploadArchivDocument(session, makeFile('norm.pdf'), request)

    expect(result.documentId).toBe('archiv-doc-1')
    expect(admitOrDiscard).not.toHaveBeenCalled()
    expect(admitReplacementOrDiscard).toHaveBeenCalled()
  })

  it('files a re-upload whose document was just deleted as a first upload', async () => {
    vi.mocked(findLiveDocumentByFilename)
      .mockResolvedValueOnce({
        id: 'archiv-deleted',
        storageKey: 'org/org-1/archiv/doc/archiv-deleted/norm.pdf',
        storageBucket: 'test-bucket',
        fileSize: 500,
        contentHash: null,
        folderId: null,
        status: 'ready',
      })
      .mockResolvedValueOnce(null)
    vi.mocked(admitReplacementOrDiscard).mockRejectedValueOnce(
      new ReplacedDocumentGoneError('archiv-deleted'),
    )
    vi.mocked(canManageArchiv).mockReturnValue(true)

    const result = await uploadArchivDocument(session, makeFile('norm.pdf'), request)

    const inserted = vi.mocked(admitOrDiscard).mock.calls.at(-1)
    expect(inserted?.[2]).toMatchObject({ scope: 'archiv', filename: 'norm.pdf' })
    expect(result.documentId).not.toBe('archiv-deleted')
    expect(result.documentId).toBe(inserted?.[2].id)
  })

  it('answers 409 and dispatches nothing when the document is deleted before its version is recorded', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValueOnce(null)
    vi.mocked(canManageArchiv).mockReturnValue(true)

    await expect(uploadArchivDocument(session, makeFile('norm.pdf'), request)).rejects.toMatchObject({
      status: 409,
      details: { reason: 'deleted_during_upload' },
    })
    expect(dispatchDocument).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('makes the loser of two concurrent first uploads a new version of the winner', async () => {
    // Both probes missed; the live-name index refused the loser's insert (and
    // `admitOrDiscard` took its object back). The retry finds the winner.
    const winner = {
      id: 'archiv-winner',
      storageKey: 'org/org-1/archiv/doc/archiv-winner/norm.pdf',
      storageBucket: 'test-bucket',
      fileSize: 500,
      contentHash: null,
      folderId: null,
      status: 'uploaded',
    }
    vi.mocked(findLiveDocumentByFilename).mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    vi.mocked(admitOrDiscard).mockRejectedValueOnce(new LiveFilenameTakenError('norm.pdf'))
    vi.mocked(canManageArchiv).mockReturnValue(true)

    const result = await uploadArchivDocument(session, makeFile('norm.pdf'), request)

    expect(result.documentId).toBe('archiv-winner')
    const replaced = vi.mocked(admitReplacementOrDiscard).mock.calls.at(-1)
    expect(replaced?.[3]).toBe('archiv-winner')
    // Its own write key under the winner's id — never the winner's own object.
    expect(replaced?.[1]).toMatch(/\/doc\/archiv-winner\/v\d+\/[0-9a-f]{12}\/norm\.pdf$/)
  })
})

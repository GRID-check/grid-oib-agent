/**
 * @vitest-environment node
 */
/**
 * A chat attachment dropped a second time under the same name.
 *
 * The project and Archiv paths already replaced instead of inserting; the
 * session path still minted a fresh id every time. Same table, same
 * filename-keyed chunk replacement in the ingest pipeline, same ghost: the
 * first row listed and downloadable, its passages already replaced by the
 * second's, and the conversation charged for both.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

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
  // 2: the only caller asks for it on the REPLACE path, where the next version
  // is by definition not the first.
  nextVersionNumber: vi.fn().mockResolvedValue(2),
  compareAndSwapVersionState: vi.fn().mockResolvedValue(null),
  promoteVersionToPublished: vi.fn().mockResolvedValue(null),
  setDocumentLifecycle: vi.fn(),
  listDocumentVersionObjects: vi.fn().mockResolvedValue([]),
}))

vi.mock('server-only', () => ({}))

const CONVERSATION_ID = 's_11111111-2222-3333-4444-555555555555'
const ORG_ID = 'org_1'
const USER_ID = 'user_me'

const s3Send = vi.fn()
vi.mock('@/lib/s3', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3')
  return {
    ...actual,
    s3Client: { send: (...args: unknown[]) => s3Send(...args) },
    bucketAdminS3Client: { send: vi.fn() },
  }
})
vi.mock('@/lib/storage/bucket', () => ({
  ensureTenantBucketChecked: vi.fn().mockResolvedValue('grid-org-org1-abc'),
  resolveDocumentBucket: (bucket: string | null) => bucket ?? 'grid-documents',
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
// The upload-screening policy (ADR-0085) the name gate reads: an office on
// Piloti's suggested list. Unreadable settings refuse the upload outright.
vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: vi.fn(async () => ({ displayName: null, defaultLocale: 'de', settings: {} })),
  writeDedicatedOrgSetting: vi.fn(),
}))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/conversations/service', () => ({
  assertConversationAcceptsUploads: vi.fn(),
  createConversation: vi.fn(),
}))
vi.mock('@/lib/documents/service', () => ({
  assertUploadTypeAllowed: vi.fn(),
  assertFileSizeAllowed: vi.fn(),
  dispatchDocument: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
}))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn() }))
vi.mock('@/lib/storage/service', () => ({ assertWithinStorageQuota: vi.fn() }))
vi.mock('@/lib/storage/admission', () => ({
  admitOrDiscard: vi.fn(),
  admitReplacementOrDiscard: vi.fn(),
}))
vi.mock('@/lib/documents/repository', () => ({
  findLiveDocumentByFilename: vi.fn(),
  // Read back by `recordUploadedVersionOrDiscard` (ADR-0054) before it records
  // the version. The row the upload just wrote: a miss means the attachment was
  // deleted mid-upload, a 409 of its own, so the default is the row existing.
  findDocumentInOrg: vi.fn(async (id: string) =>
    (await import('@/test-utils/db-fixtures')).makeDocument({
      id,
      projectId: null,
      scope: 'session',
      conversationId: 's_11111111-2222-3333-4444-555555555555',
    }),
  ),
}))
vi.mock('@/lib/documents/object-cleanup', () => ({
  deleteDocumentObjects: vi.fn(),
}))
vi.mock('./cleanup', () => ({ purgeCollectionChunks: vi.fn() }))
vi.mock('@/lib/compliance/repository', () => ({
  isCoveredByActiveHold: vi.fn().mockResolvedValue(false),
}))
vi.mock('./repository', () => ({
  deleteSessionDocument: vi.fn(),
  findSessionDocument: vi.fn(),
  listSessionDocuments: vi.fn(),
  SESSION_DOCUMENT_LIST_LIMIT: 100,
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import { dispatchDocument } from '@/lib/documents/service'
import { findDocumentInOrg, findLiveDocumentByFilename } from '@/lib/documents/repository'
import { admitOrDiscard, admitReplacementOrDiscard } from '@/lib/storage/admission'
import { ConflictError } from '@/lib/api/errors'
import { isCoveredByActiveHold } from '@/lib/compliance/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { deleteDocumentObjects } from '@/lib/documents/object-cleanup'
import { purgeCollectionChunks } from './cleanup'
import {
  deleteSessionDocument as deleteSessionDocumentRow,
  findSessionDocument,
  listSessionDocuments as listSessionDocumentRows,
} from './repository'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { deleteSessionDocument, listSessionDocuments, uploadSessionDocument } from './service'
import { LiveFilenameTakenError, ReplacedDocumentGoneError } from '@/lib/documents/unique-conflicts'
import { nextVersionNumber } from '@/lib/documents/version-repository'
import { makeLiveDocumentMatch } from '@/test-utils/db-fixtures'

const session = {
  userId: USER_ID,
  organizationId: ORG_ID,
  email: 'me@grid.test',
  permissions: [],
} as unknown as AuthorizedSession

function file(name = 'brandschutz.pdf'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' })
}

const existing = makeLiveDocumentMatch({
  id: 'doc-existing',
  storageKey: `org/${ORG_ID}/session/${CONVERSATION_ID}/doc/doc-existing/brandschutz.pdf`,
  storageBucket: 'grid-org-org1-abc',
  fileSize: 900,
  contentHash: null,
  folderId: null,
  status: 'ready',
})

beforeEach(() => {
  vi.clearAllMocks()
  s3Send.mockResolvedValue({})
  vi.mocked(findLiveDocumentByFilename).mockResolvedValue(null)
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'doc-fresh' })
})

describe('uploadSessionDocument, a file already attached under that name', () => {
  beforeEach(() => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue(existing)
  })

  it('probes the conversation\'s own collection, not the project\'s', async () => {
    await uploadSessionDocument(session, { conversationId: CONVERSATION_ID, file: file() }, new Request('http://x'))

    expect(findLiveDocumentByFilename).toHaveBeenCalledWith(ORG_ID, CONVERSATION_ID, 'brandschutz.pdf')
  })

  it('keeps the document id and replaces the row instead of inserting a second one', async () => {
    const result = await uploadSessionDocument(
      session,
      { conversationId: CONVERSATION_ID, file: file() },
      new Request('http://x'),
    )

    expect(result.documentId).toBe('doc-existing')
    expect(admitOrDiscard).not.toHaveBeenCalled()
    expect(admitReplacementOrDiscard).toHaveBeenCalled()
    // The quota is charged the delta, under the same lock, against THIS row.
    expect(vi.mocked(admitReplacementOrDiscard).mock.calls.at(-1)?.[3]).toBe('doc-existing')
  })

  /**
   * Since ADR-0054 a re-upload is a new VERSION, so it writes to a new key and
   * the previous bytes stay where the previous version's row says they are. The
   * old expectation — new bytes on the old key, then discard the derivatives —
   * described exactly the behaviour that made a version history impossible.
   */
  it('writes the new bytes under a v2 key and leaves the previous object alone', async () => {
    await uploadSessionDocument(session, { conversationId: CONVERSATION_ID, file: file() }, new Request('http://x'))

    const put = s3Send.mock.calls.find((call) => call[0] instanceof PutObjectCommand)?.[0] as PutObjectCommand
    expect(put.input.Key).not.toBe(existing.storageKey)
    expect(put.input.Key).toContain('/v2/')
    const deleted = s3Send.mock.calls
      .map((call) => call[0])
      .filter((command) => command instanceof DeleteObjectCommand)
    expect(deleted).toEqual([])
  })

  it('re-dispatches under the kept id and records the replacement', async () => {
    await uploadSessionDocument(session, { conversationId: CONVERSATION_ID, file: file() }, new Request('http://x'))

    expect(dispatchDocument).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc-existing' }))
    const event = vi.mocked(recordAuditEvent).mock.calls.at(-1)?.[0]
    expect(event?.targetId).toBe('doc-existing')
    expect(event?.metadata).toMatchObject({ replaced: true })
  })
})

// A re-upload keeps the replaced bytes as an earlier version (ADR-0054), so
// replacing somebody else's quarantined attachment would hand its held-back
// bytes to the whole chat (ADR-0085).
describe("uploadSessionDocument onto somebody else's quarantined attachment", () => {
  it('is refused like a taken name, and nothing is admitted', async () => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue({
      ...existing,
      scope: 'session',
      projectId: null,
      createdBy: 'user-other',
      status: 'quarantined',
    })

    await expect(
      uploadSessionDocument(
        { ...session, permissions: [] } as unknown as AuthorizedSession,
        { conversationId: CONVERSATION_ID, file: file() },
        new Request('http://x'),
      ),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(admitReplacementOrDiscard).not.toHaveBeenCalled()
  })
})

describe('uploadSessionDocument, a genuinely new file', () => {
  it('inserts under a fresh id and never touches the replace path', async () => {
    const result = await uploadSessionDocument(
      session,
      { conversationId: CONVERSATION_ID, file: file('neu.pdf') },
      new Request('http://x'),
    )

    expect(result.documentId).toBe('doc-fresh')
    expect(admitOrDiscard).toHaveBeenCalledWith(
      'grid-org-org1-abc',
      expect.stringContaining('/doc/doc-fresh/neu.pdf'),
      expect.objectContaining({ id: 'doc-fresh', scope: 'session', conversationId: CONVERSATION_ID }),
    )
    expect(admitReplacementOrDiscard).not.toHaveBeenCalled()
  })
})

/**
 * The races the project and Archiv shelves already answer, on the chat shelf.
 * Session documents version like the others (ADR-0054), so the loser of two
 * simultaneous first uploads of one name becomes the winner's next version
 * rather than a 409, and a re-upload whose attachment was deleted underneath it
 * becomes a first upload. The losing attempt's object is discarded by the
 * admission, which these mocks stand in for.
 */
describe('uploadSessionDocument, when the shelf changes under the probe', () => {
  it('retries a lost first-upload race as a new version of the winner', async () => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValueOnce(null).mockResolvedValueOnce(existing)
    vi.mocked(admitOrDiscard).mockRejectedValueOnce(new LiveFilenameTakenError('brandschutz.pdf'))

    const result = await uploadSessionDocument(
      session,
      { conversationId: CONVERSATION_ID, file: file() },
      new Request('http://x'),
    )

    expect(result.documentId).toBe('doc-existing')
    expect(admitOrDiscard).toHaveBeenCalledTimes(1)
    expect(admitReplacementOrDiscard).toHaveBeenCalledTimes(1)
    const puts = s3Send.mock.calls.map((call) => call[0]).filter((c) => c instanceof PutObjectCommand)
    expect(puts).toHaveLength(2)
    // The retry never aims at the winner's flat key.
    expect((puts[1] as PutObjectCommand).input.Key).not.toBe(existing.storageKey)
    expect((puts[1] as PutObjectCommand).input.Key).toMatch(/\/doc\/doc-existing\/v\d+\/[0-9a-f]{12}\/brandschutz\.pdf$/)
  })

  it('retries a re-upload of a just-deleted attachment as a first upload', async () => {
    vi.mocked(findLiveDocumentByFilename).mockResolvedValueOnce(existing).mockResolvedValueOnce(null)
    vi.mocked(admitReplacementOrDiscard).mockRejectedValueOnce(new ReplacedDocumentGoneError('doc-existing'))

    const result = await uploadSessionDocument(
      session,
      { conversationId: CONVERSATION_ID, file: file() },
      new Request('http://x'),
    )

    expect(result.documentId).toBe('doc-fresh')
    expect(admitOrDiscard).toHaveBeenCalledWith(
      'grid-org-org1-abc',
      expect.stringContaining('/doc/doc-fresh/brandschutz.pdf'),
      expect.objectContaining({ id: 'doc-fresh', scope: 'session' }),
    )
  })

  it('answers 409 when the shelf changes twice in one request', async () => {
    vi.mocked(admitOrDiscard)
      .mockRejectedValueOnce(new LiveFilenameTakenError('brandschutz.pdf'))
      .mockRejectedValueOnce(new LiveFilenameTakenError('brandschutz.pdf'))

    const error = await uploadSessionDocument(
      session,
      { conversationId: CONVERSATION_ID, file: file() },
      new Request('http://x'),
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(dispatchDocument).not.toHaveBeenCalled()
  })

  it('writes a re-upload under a write key even when the version number reads 1', async () => {
    // The hint reads 1 while a concurrent first upload has its row but not
    // yet its version. The old version-1 shortcut put this PUT on that
    // upload's own key.
    vi.mocked(nextVersionNumber).mockResolvedValueOnce(1)
    vi.mocked(findLiveDocumentByFilename).mockResolvedValue(existing)

    await uploadSessionDocument(session, { conversationId: CONVERSATION_ID, file: file() }, new Request('http://x'))

    const put = s3Send.mock.calls.find((call) => call[0] instanceof PutObjectCommand)?.[0] as PutObjectCommand
    expect(put.input.Key).not.toBe(existing.storageKey)
    expect(put.input.Key).toMatch(/\/doc\/doc-existing\/v1\/[0-9a-f]{12}\/brandschutz\.pdf$/)
  })
})

/**
 * An attachment deleted, or its chat discarded, after the admission and before
 * the version is recorded. The lenient recorder answered null and the upload
 * went on: it dispatched a gone document for ingest, audited it as uploaded and
 * left its object in the bucket with no row naming it.
 */
describe('uploadSessionDocument, when the attachment is deleted mid-upload', () => {
  it('answers 409, discards the stored object, and neither dispatches nor audits', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValueOnce(null)

    await expect(
      uploadSessionDocument(session, { conversationId: CONVERSATION_ID, file: file('neu.pdf') }, new Request('http://x')),
    ).rejects.toMatchObject({ status: 409, details: { reason: 'deleted_during_upload' } })

    const put = s3Send.mock.calls.find((call) => call[0] instanceof PutObjectCommand)?.[0] as PutObjectCommand
    const deletedKeys = s3Send.mock.calls
      .map((call) => call[0])
      .filter((command): command is DeleteObjectCommand => command instanceof DeleteObjectCommand)
      .map((command) => command.input.Key)
    expect(deletedKeys).toContain(put.input.Key)
    expect(dispatchDocument).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})

describe('deleteSessionDocument under a legal hold', () => {
  const attached = {
    ...existing,
    conversationId: CONVERSATION_ID,
    collectionName: CONVERSATION_ID,
    filename: 'brandschutz.pdf',
  }

  it('refuses with a 409 after the access check and before the first erasure', async () => {
    vi.mocked(findSessionDocument).mockResolvedValue(attached as never)
    vi.mocked(isCoveredByActiveHold).mockResolvedValueOnce(true)

    const error = await deleteSessionDocument(session, 'doc-existing', new Request('http://x')).catch(
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(ConflictError)
    expect(requireResourceAccess).toHaveBeenCalledWith(session, 'conversation', CONVERSATION_ID, 'collaborator')
    expect(isCoveredByActiveHold).toHaveBeenCalledWith(ORG_ID, 'document', 'doc-existing')
    expect(purgeCollectionChunks).not.toHaveBeenCalled()
    expect(deleteDocumentObjects).not.toHaveBeenCalled()
    expect(deleteSessionDocumentRow).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})

/**
 * An ingest whose existence check landed before the row delete still saw the
 * row and kept the chunks it inserted after the first purge (ADR-0054,
 * correction 18). The delete purges once more after the row is gone.
 */
describe('deleteSessionDocument purges the chunks again after the row', () => {
  const attached = {
    ...existing,
    conversationId: CONVERSATION_ID,
    collectionName: CONVERSATION_ID,
    filename: 'brandschutz.pdf',
    authoredBy: 'user',
  }

  it('purges, erases the objects, deletes the row, then purges again', async () => {
    const order: string[] = []
    vi.mocked(findSessionDocument).mockResolvedValue(attached as never)
    vi.mocked(purgeCollectionChunks).mockImplementation(async () => {
      order.push('purge')
      return { ok: true }
    })
    vi.mocked(deleteDocumentObjects).mockImplementation(async () => {
      order.push('objects')
      return { ok: true }
    })
    vi.mocked(deleteSessionDocumentRow).mockImplementation(async () => {
      order.push('row')
    })

    await deleteSessionDocument(session, 'doc-existing', new Request('http://x'))

    expect(order).toEqual(['purge', 'objects', 'row', 'purge'])
    const calls = vi.mocked(purgeCollectionChunks).mock.calls
    expect(calls[1]).toEqual(calls[0])
  })

  it('logs a failed second purge and still completes the delete', async () => {
    vi.mocked(findSessionDocument).mockResolvedValue(attached as never)
    vi.mocked(purgeCollectionChunks)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: 'answered 502' })
    vi.mocked(deleteDocumentObjects).mockResolvedValue({ ok: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      deleteSessionDocument(session, 'doc-existing', new Request('http://x')),
    ).resolves.toBeUndefined()

    expect(deleteSessionDocumentRow).toHaveBeenCalled()
    expect(recordAuditEvent).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('second chunk purge'),
      'doc-existing',
      'answered 502',
    )
    warn.mockRestore()
  })

  it('makes no second purge when the first erase failed and the row is kept', async () => {
    vi.mocked(findSessionDocument).mockResolvedValue(attached as never)
    vi.mocked(purgeCollectionChunks).mockResolvedValue({ ok: true })
    vi.mocked(deleteDocumentObjects).mockResolvedValue({ ok: false, reason: 'SeaweedFS 500' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      deleteSessionDocument(session, 'doc-existing', new Request('http://x')),
    ).rejects.toThrow()

    expect(purgeCollectionChunks).toHaveBeenCalledTimes(1)
    expect(deleteSessionDocumentRow).not.toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('listSessionDocuments and a quarantined attachment (ADR-0085)', () => {
  beforeEach(() => {
    vi.mocked(listSessionDocumentRows).mockResolvedValue([])
    vi.mocked(reconcileDocumentStatuses).mockResolvedValue([])
  })

  it("keeps a participant to the quarantined files they attached: only the organization's admins review a chat's", async () => {
    const participant = { ...session, permissions: [] } as unknown as AuthorizedSession
    await listSessionDocuments(participant, 'conv_1')
    expect(listSessionDocumentRows).toHaveBeenCalledWith('conv_1', ORG_ID, { kind: 'member', userId: USER_ID }, 100)
  })

  // The first read after the verdict finds the row `pending`, which the query
  // keeps; the reconcile turns it `quarantined` on the way out.
  it('narrows again after the reconcile turns a row quarantined', async () => {
    const row = (id: string, createdBy: string) =>
      ({ id, filename: `${id}.pdf`, status: 'pending', createdBy, metadata: null }) as never
    vi.mocked(listSessionDocumentRows).mockResolvedValue([row('mine', USER_ID), row('theirs', 'user-other')])
    vi.mocked(reconcileDocumentStatuses).mockImplementation(async (rows) =>
      rows.map((r) => ({ ...r, status: 'quarantined' }))
    )
    const participant = { ...session, permissions: [] } as unknown as AuthorizedSession

    const { documents } = await listSessionDocuments(participant, 'conv_1')

    expect(documents.map((doc) => doc.id)).toEqual(['mine'])
    expect(documents[0]).not.toHaveProperty('createdBy')
  })

  it("lists every attachment to an organization's admin", async () => {
    const admin = { ...session, permissions: ['org:projects:administer'] } as unknown as AuthorizedSession
    await listSessionDocuments(admin, 'conv_1')
    expect(listSessionDocumentRows).toHaveBeenCalledWith('conv_1', ORG_ID, { kind: 'reviewer' }, 100)
  })
})

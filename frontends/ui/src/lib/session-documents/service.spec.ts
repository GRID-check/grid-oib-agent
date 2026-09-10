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
  // Read back by `recordUploadedVersion` (ADR-0054); see the Archiv suite for
  // why null is the honest default.
  findDocumentInOrg: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/documents/object-cleanup', () => ({
  deleteDocumentObjects: vi.fn(),
}))
vi.mock('./cleanup', () => ({ purgeCollectionChunks: vi.fn() }))
vi.mock('./repository', () => ({
  deleteSessionDocument: vi.fn(),
  findSessionDocument: vi.fn(),
  listSessionDocuments: vi.fn(),
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import { dispatchDocument } from '@/lib/documents/service'
import { findLiveDocumentByFilename } from '@/lib/documents/repository'
import { admitOrDiscard, admitReplacementOrDiscard } from '@/lib/storage/admission'
import { uploadSessionDocument } from './service'

const session = { userId: USER_ID, organizationId: ORG_ID, email: 'me@grid.test' } as unknown as AuthorizedSession

function file(name = 'brandschutz.pdf'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' })
}

const existing = {
  id: 'doc-existing',
  storageKey: `org/${ORG_ID}/session/${CONVERSATION_ID}/doc/doc-existing/brandschutz.pdf`,
  storageBucket: 'grid-org-org1-abc',
  fileSize: 900,
  contentHash: null,
  folderId: null,
  status: 'ready',
}

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

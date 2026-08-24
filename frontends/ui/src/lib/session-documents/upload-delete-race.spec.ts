/**
 * @vitest-environment node
 */
/**
 * An upload racing a chat discard.
 *
 * Discarding a chat is two steps that cannot be one: erase the attachments'
 * EXTERNAL state (SeaweedFS objects, retrieval chunks — neither reachable by a
 * foreign key), then delete the conversation row, whose `ON DELETE CASCADE`
 * takes the document rows with it.
 *
 * Between those two steps there used to be a hole. An upload that had already
 * passed `createConversation` — the conversation was still perfectly alive when
 * it did — went on to write its object and insert its row AFTER the purge had
 * finished walking. The cascade then removed that row, and its object and its
 * chunks stayed: private bytes in the tenant's bucket, private text in the
 * retrieval index, nothing naming either, no listing showing them, and the only
 * handle that could ever drive a retry deleted by the very statement that was
 * supposed to be cleaning up.
 *
 * The fix is a state, not a lock: the discard marks the conversation as
 * deleting BEFORE it purges anything, and the upload re-reads that mark
 * immediately before the object write. This file drives the interleaving by
 * hand — the upload is suspended inside its quota check, the discard is allowed
 * to run up to and including the mark, and only then is the upload released.
 *
 * Both services are the REAL ones, and so is `@/lib/sharing/access`: a test that
 * mocked the guard would assert nothing about whether the guard is reached
 * before `PutObjectCommand`, which is the entire claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PutObjectCommand } from '@aws-sdk/client-s3'

vi.mock('server-only', () => ({}))

const CONVERSATION_ID = 's_11111111-2222-3333-4444-555555555555'
const ORG_ID = 'org_1'
const USER_ID = 'user_me'
const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

/** The one row both flows contend over, held in memory so the race is visible. */
interface ConversationRow {
  id: string
  organizationId: string
  createdBy: string
  projectId: string | null
  visibility: 'private' | 'project' | 'organization'
  deletedAt: Date | null
  title: string | null
  tags: string[]
  engagement: null
}

let conversation: ConversationRow | null = null

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-editor' }),
}))

vi.mock('@/lib/conversations/repository', () => ({
  deleteConversationInOrg: vi.fn(async () => {
    conversation = null
  }),
  findConversationInOrg: vi.fn(async () => conversation),
  findConversationRead: vi.fn().mockResolvedValue(null),
  findConversationTenancy: vi.fn(async () =>
    conversation
      ? {
          organizationId: conversation.organizationId,
          projectId: conversation.projectId,
          visibility: conversation.visibility,
          createdBy: conversation.createdBy,
          deletedAt: conversation.deletedAt,
        }
      : null,
  ),
  findMessageInConversation: vi.fn(),
  insertConversation: vi.fn(async () => null),
  insertMessages: vi.fn(),
  listMessagesForConversation: vi.fn(),
  listVisibleConversations: vi.fn(),
  markConversationDeleting: vi.fn(async () => {
    if (!conversation) return null
    conversation = { ...conversation, deletedAt: new Date() }
    return conversation
  }),
  mergeMessageMetadata: vi.fn(),
  updateConversationMetaInOrg: vi.fn(),
  updateConversationTitleInOrg: vi.fn(),
  upsertConversationRead: vi.fn(),
}))

vi.mock('@/lib/sharing/repository', () => ({
  findGrantForSubject: vi.fn().mockResolvedValue(null),
  countGrantsForResource: vi.fn().mockResolvedValue(0),
}))
vi.mock('@/lib/sharing/service', () => ({ resolveParticipants: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/events/bus', () => ({ publishToUsers: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn().mockResolvedValue(0),
  markResourceItemsReadFor: vi.fn(),
}))
vi.mock('@/lib/inbox/registry', () => ({ inboxGroupKey: vi.fn(() => 'k') }))
vi.mock('@/lib/mentions/service', () => ({
  applyMessageMentions: vi.fn(),
  resolveRequestsOnReply: vi.fn(),
  threadIsAwaitingHuman: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/collaboration/cleanup', () => ({ purgeConversationCollaboration: vi.fn() }))
vi.mock('@/lib/conversations/engagement', () => ({
  resolveEngagement: vi.fn(),
  resolveEngagementFor: vi.fn(),
  setEngagement: vi.fn(),
}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))

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

vi.mock('@/lib/bim/service', () => ({ deleteBimDerivedObjects: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/documents/service', () => ({
  assertUploadTypeAllowed: vi.fn(),
  assertFileSizeAllowed: vi.fn(),
  dispatchDocument: vi.fn().mockResolvedValue({ jobId: null, status: 'uploaded' }),
}))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn() }))

/** The suspension point: the upload parks here until the test releases it. */
const quotaGate = { release: () => {} }
const assertWithinStorageQuota = vi.fn(
  (..._args: unknown[]) =>
    new Promise<void>((resolve) => {
      quotaGate.release = resolve
    }),
)
vi.mock('@/lib/storage/service', () => ({
  assertWithinStorageQuota: (...args: unknown[]) => assertWithinStorageQuota(...args),
}))

const admitOrDiscard = vi.fn()
vi.mock('@/lib/storage/admission', () => ({
  admitOrDiscard: (...args: unknown[]) => admitOrDiscard(...args),
}))

const listSessionDocumentsForCleanup = vi.fn()
vi.mock('./repository', () => ({
  listSessionDocumentsForCleanup: (...args: unknown[]) => listSessionDocumentsForCleanup(...args),
  deleteSessionDocumentsByIds: vi.fn(),
  deleteSessionDocument: vi.fn(),
  findSessionDocument: vi.fn(),
  listSessionDocuments: vi.fn(),
  SESSION_DOCUMENT_LIST_LIMIT: 100,
}))

import { ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { deleteConversation } from '@/lib/conversations/service'
import { deleteConversationInOrg, markConversationDeleting } from '@/lib/conversations/repository'
import { uploadSessionDocument } from './service'

const session = {
  userId: USER_ID,
  organizationId: ORG_ID,
  email: 'me@grid.test',
} as unknown as AuthorizedSession

function file(): File {
  return new File([new Uint8Array([1, 2, 3])], 'brandschutz.pdf', { type: 'application/pdf' })
}

/** Resolves once the given mock has been called at least once. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (!predicate()) throw new Error('condition never became true')
}

beforeEach(() => {
  vi.clearAllMocks()
  conversation = {
    id: CONVERSATION_ID,
    organizationId: ORG_ID,
    createdBy: USER_ID,
    projectId: PROJECT_ID,
    visibility: 'private',
    deletedAt: null,
    title: null,
    tags: [],
    engagement: null,
  }
  quotaGate.release = () => {}
  s3Send.mockResolvedValue({})
  admitOrDiscard.mockResolvedValue(undefined)
  listSessionDocumentsForCleanup.mockResolvedValue([])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
  // The suite-wide setup replaces `global.crypto` with a `getRandomValues`-only
  // stand-in, and the upload mints its document id with `randomUUID`.
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'doc-1' })
})

describe('an upload that races a conversation delete', () => {
  /**
   * The regression, driven step by step.
   *
   * Without the fix this test fails on its first assertion: the upload gets no
   * second look at the conversation, so `PutObjectCommand` is sent while the
   * discard is mid-purge, and the row that would have named that object is
   * removed moments later by the cascade.
   */
  it('is refused after the discard finished, before any byte is written', async () => {
    // (1) The upload starts on a live conversation and parks inside its quota
    //     check — i.e. it has already passed `createConversation`, which is the
    //     only authorization the old code performed.
    const upload = uploadSessionDocument(session, { conversationId: CONVERSATION_ID, file: file() }, new Request('http://x'))
    const settled = upload.catch((error: unknown) => error)
    await until(() => assertWithinStorageQuota.mock.calls.length > 0)
    expect(s3Send).not.toHaveBeenCalled()

    // (2) The discard runs to completion. It marks the conversation FIRST, and
    //     the purge below finds nothing because the upload has not landed.
    await deleteConversation(session, CONVERSATION_ID)
    expect(markConversationDeleting).toHaveBeenCalled()
    expect(deleteConversationInOrg).toHaveBeenCalled()

    // (3) Release the upload. It must now refuse rather than write.
    quotaGate.release()
    const outcome = await settled

    // The row is gone by now, so the honest answer is 404 rather than the 409 a
    // still-purging conversation gets. What matters is which side of the write
    // the refusal lands on.
    expect(outcome).toBeInstanceOf(NotFoundError)
    const puts = s3Send.mock.calls.filter((call) => call[0] instanceof PutObjectCommand)
    expect(puts).toHaveLength(0)
    // And nothing was recorded, so no row can be orphaned by the cascade.
    expect(admitOrDiscard).not.toHaveBeenCalled()
  })

  /**
   * The narrower window: the mark lands while the purge is still running, which
   * is the whole reason it is set BEFORE the purge rather than after it. Here
   * the discard is suspended inside `purgeSessionDocuments` and the upload is
   * released underneath it.
   */
  it('is refused while the purge is still walking the attachments', async () => {
    let releasePurge = (): void => {}
    listSessionDocumentsForCleanup.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePurge = () => resolve([])
        }),
    )

    const upload = uploadSessionDocument(session, { conversationId: CONVERSATION_ID, file: file() }, new Request('http://x'))
    const uploadSettled = upload.catch((error: unknown) => error)
    await until(() => assertWithinStorageQuota.mock.calls.length > 0)

    const discard = deleteConversation(session, CONVERSATION_ID)
    await until(() => listSessionDocumentsForCleanup.mock.calls.length > 0)
    // The conversation row still EXISTS at this instant — only the mark is set.
    expect(conversation?.deletedAt).toBeInstanceOf(Date)
    expect(deleteConversationInOrg).not.toHaveBeenCalled()

    quotaGate.release()
    expect(await uploadSettled).toBeInstanceOf(ConflictError)
    expect(s3Send.mock.calls.filter((call) => call[0] instanceof PutObjectCommand)).toHaveLength(0)

    releasePurge()
    await discard
  })

  it('still accepts an upload into a conversation nobody is deleting', async () => {
    const upload = uploadSessionDocument(session, { conversationId: CONVERSATION_ID, file: file() }, new Request('http://x'))
    await until(() => assertWithinStorageQuota.mock.calls.length > 0)
    quotaGate.release()

    const result = await upload

    expect(result.filename).toBe('brandschutz.pdf')
    expect(s3Send.mock.calls.filter((call) => call[0] instanceof PutObjectCommand)).toHaveLength(1)
    expect(admitOrDiscard).toHaveBeenCalled()
  })
})

describe('a discard whose cleanup fails', () => {
  it('keeps the conversation row so the erasure can be retried', async () => {
    listSessionDocumentsForCleanup.mockResolvedValue([
      {
        id: 'doc-1',
        organizationId: ORG_ID,
        conversationId: CONVERSATION_ID,
        scope: 'session',
        filename: 'brandschutz.pdf',
        collectionName: CONVERSATION_ID,
        storageKey: `org/${ORG_ID}/session/${CONVERSATION_ID}/doc/doc-1/brandschutz.pdf`,
        storageBucket: 'grid-org-org1-abc',
      },
    ])
    s3Send.mockRejectedValue(new Error('SeaweedFS 500'))

    await expect(deleteConversation(session, CONVERSATION_ID)).rejects.toThrow(/attachments failed/)

    // The row survives — deleting it would cascade away the document rows that
    // are the only handle on the object still sitting in the bucket.
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
    expect(conversation).not.toBeNull()
    expect(conversation?.deletedAt).toBeInstanceOf(Date)
  })

  /**
   * And the retry has to be able to authorize. A conversation carrying the
   * deleting mark is a 404 to `resolveResourceAccess`, so without the narrow
   * creator path in `authorizeConversationDelete` the retained rows would be
   * unreachable — which is the same outcome as not retaining them.
   */
  it('lets the creator run the delete again once the store recovers', async () => {
    conversation = { ...conversation!, deletedAt: new Date('2026-08-13T09:00:00Z') }
    listSessionDocumentsForCleanup.mockResolvedValue([])

    await expect(deleteConversation(session, CONVERSATION_ID)).resolves.toBeUndefined()
    expect(deleteConversationInOrg).toHaveBeenCalled()
  })

  it('does not let anybody else reach a conversation the mark has hidden', async () => {
    conversation = { ...conversation!, createdBy: 'user_other', deletedAt: new Date() }

    await expect(deleteConversation(session, CONVERSATION_ID)).rejects.toThrow()
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })
})

/**
 * The conversations service is where the collaboration feature's security fix
 * lives: a conversation used to be resolved **org-scoped only**, so any signed-in
 * colleague holding an id could read the thread and the unfiltered list returned
 * every chat in the organization (spec §3 fact 1, ADR-0032).
 *
 * The access rules are therefore exercised through the REAL
 * `@/lib/sharing/access` — only the registry's probe, the grant lookup and the
 * container check are mocked. A test that mocked `requireResourceAccess` would
 * assert nothing about whether access is actually enforced.
 *
 * Covered here, each a way access could leak or a way the single-player
 * experience could be disturbed:
 *   - cross-tenant, and someone else's `private` thread → 404 (the fix itself);
 *   - `project` visibility and an explicit grant → readable;
 *   - authorship on write, creator-attribution of legacy rows on read (CC-3/MG-3);
 *   - the addressee ruling that decides whether the agent answers (MN-1/MN-7);
 *   - a solo thread produces NO events and NO notifications (NF-8).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))

// The service reaches the naming backend through `@/lib/backend-proxy`, which
// pulls in the WorkOS AuthKit session helpers. Stubbed so importing the module
// under test does not need the Next.js request context.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
  authzErrorResponse: () => null,
}))

vi.mock('@/lib/conversations/repository', () => ({
  deleteConversationInOrg: vi.fn(),
  findConversationInOrg: vi.fn(),
  findConversationRead: vi.fn(),
  findConversationTenancy: vi.fn(),
  findMessageInConversation: vi.fn(),
  insertConversation: vi.fn(),
  insertMessages: vi.fn(),
  listMessagesForConversation: vi.fn(),
  listVisibleConversations: vi.fn(),
  mergeMessageMetadata: vi.fn(),
  updateConversationMetaInOrg: vi.fn(),
  updateConversationTitleInOrg: vi.fn(),
  upsertConversationRead: vi.fn(),
}))

vi.mock('@/lib/sharing/repository', () => ({
  findGrantForSubject: vi.fn(),
  countGrantsForResource: vi.fn(),
}))

vi.mock('@/lib/sharing/service', () => ({ resolveParticipants: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ publishToUsers: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(),
  markResourceItemsReadFor: vi.fn(),
}))
vi.mock('@/lib/mentions/service', () => ({
  applyMessageMentions: vi.fn(),
  resolveRequestsOnReply: vi.fn(),
}))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess, type ProjectRole } from '@/lib/authz/projects'
import type { Message, ResourceVisibility } from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import { emitInboxItems, markResourceItemsReadFor } from '@/lib/inbox/service'
import { applyMessageMentions, resolveRequestsOnReply } from '@/lib/mentions/service'
import { countGrantsForResource, findGrantForSubject } from '@/lib/sharing/repository'
import { resolveParticipants } from '@/lib/sharing/service'
import {
  deleteConversationInOrg,
  findConversationInOrg,
  findConversationRead,
  findConversationTenancy,
  findMessageInConversation,
  insertConversation,
  insertMessages,
  listMessagesForConversation,
  listVisibleConversations,
  updateConversationTitleInOrg,
  upsertConversationRead,
} from './repository'
import {
  createConversation,
  createConversationMessages,
  deleteConversation,
  getConversation,
  listConversationMessages,
  listConversations,
  markConversationRead,
  updateConversationTitle,
} from './service'

const CONVERSATION_ID = 'conv_1'
const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

/** The registry's single probe: existence, tenancy, container, visibility, creator. */
function stubConversation(
  overrides: Partial<{
    organizationId: string
    projectId: string | null
    visibility: ResourceVisibility
    createdBy: string
    deletedAt: Date | null
  }> = {},
): void {
  const tenancy = {
    organizationId: 'org_1',
    projectId: PROJECT_ID,
    visibility: 'private' as ResourceVisibility,
    createdBy: 'user_creator',
    deletedAt: null,
    ...overrides,
  }
  vi.mocked(findConversationTenancy).mockResolvedValue(tenancy)
  vi.mocked(findConversationInOrg).mockResolvedValue({
    id: CONVERSATION_ID,
    title: 'Brandschutz Stiegenhaus',
    tags: [],
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-02T10:00:00Z'),
    ...tenancy,
  })
}

/** Whether the caller can reach the container project at all (spec SH-5). */
function stubContainer(role: ProjectRole | 'denied'): void {
  if (role === 'denied') {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    return
  }
  vi.mocked(requireProjectAccess).mockResolvedValue({ role } as never)
}

function messageRow(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    conversationId: CONVERSATION_ID,
    role: 'user',
    authorUserId: null,
    content: 'Ist das Atrium OIB 2.3?',
    metadata: {},
    createdAt: new Date('2026-07-02T10:00:00Z'),
    ...overrides,
  } as Message
}

beforeEach(() => {
  vi.clearAllMocks()
  stubConversation()
  stubContainer('project-editor')
  vi.mocked(findGrantForSubject).mockResolvedValue(null)
  vi.mocked(countGrantsForResource).mockResolvedValue(0)
  vi.mocked(findConversationRead).mockResolvedValue(null)
  vi.mocked(resolveParticipants).mockResolvedValue([])
  vi.mocked(emitInboxItems).mockResolvedValue(0)
  vi.mocked(resolveRequestsOnReply).mockResolvedValue({ answered: 0, askerUserIds: [] })
  vi.mocked(findMessageInConversation).mockResolvedValue(null)
  vi.mocked(insertMessages).mockImplementation(async (rows) => rows as Message[])
})

describe('reading a conversation — the access rules', () => {
  it('404s a conversation in ANOTHER organization (tenancy is checked first)', async () => {
    stubConversation({ organizationId: 'org_2' })

    await expect(getConversation(session, CONVERSATION_ID)).rejects.toThrow(NotFoundError)
    // Never even asks about the container: another tenant's row does not exist.
    expect(requireProjectAccess).not.toHaveBeenCalled()
  })

  it("404s someone else's PRIVATE conversation in the same org and project", async () => {
    // THE regression this slice exists for. Before the fix this returned the row:
    // org scope alone was the only gate, so "private" did not exist.
    stubConversation({ visibility: 'private', createdBy: 'user_other' })

    await expect(getConversation(session, CONVERSATION_ID)).rejects.toThrow(NotFoundError)
    await expect(listConversationMessages(session, CONVERSATION_ID)).rejects.toThrow(NotFoundError)
    expect(listMessagesForConversation).not.toHaveBeenCalled()
  })

  it('lets another project member read a PROJECT-visible conversation', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_other' })

    const conversation = await getConversation(session, CONVERSATION_ID)

    expect(conversation.id).toBe(CONVERSATION_ID)
    expect(conversation.myRole).toBe('collaborator')
    expect(conversation.visibility).toBe('project')
    // Not private → the server is authoritative for the thread (ADR-0033).
    expect(conversation.shared).toBe(true)
  })

  it('lets a grantee read a PRIVATE conversation they were invited to', async () => {
    stubConversation({ visibility: 'private', createdBy: 'user_other' })
    vi.mocked(findGrantForSubject).mockResolvedValue({ role: 'viewer' } as never)
    vi.mocked(countGrantsForResource).mockResolvedValue(1)

    const conversation = await getConversation(session, CONVERSATION_ID)

    expect(conversation.myRole).toBe('viewer')
    expect(conversation.shared).toBe(true)
  })

  it('404s when the caller lost access to the container project', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_me' })
    stubContainer('denied')

    await expect(getConversation(session, CONVERSATION_ID)).rejects.toThrow(NotFoundError)
  })

  it('reports a solo thread as NOT shared, so it keeps the local-first path', async () => {
    stubConversation({ visibility: 'private', createdBy: 'user_me' })

    const conversation = await getConversation(session, CONVERSATION_ID)

    expect(conversation.myRole).toBe('owner')
    expect(conversation.shared).toBe(false)
  })
})

describe('listing conversations', () => {
  beforeEach(() => {
    vi.mocked(listVisibleConversations).mockResolvedValue([])
  })

  it('passes the CALLER, not just the org, so the SQL can filter by visibility', async () => {
    await listConversations(session, { projectId: PROJECT_ID })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT_ID, 'project:view')
    expect(listVisibleConversations).toHaveBeenCalledWith('org_1', 'user_me', { projectId: PROJECT_ID })
  })

  it('never reaches the repository for a project the caller cannot see', async () => {
    stubContainer('denied')

    await expect(listConversations(session, { projectId: PROJECT_ID })).rejects.toThrow(NotFoundError)
    expect(listVisibleConversations).not.toHaveBeenCalled()
  })

  it('lists without a project scope, narrowed to the caller (spec MG-1)', async () => {
    await listConversations(session)

    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(listVisibleConversations).toHaveBeenCalledWith('org_1', 'user_me', { projectId: undefined })
  })
})

describe('creating a conversation on an id that already exists', () => {
  beforeEach(() => {
    vi.mocked(insertConversation).mockResolvedValue(null) // id conflict
  })

  it('is idempotent for a participant of the existing thread', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_other' })

    const conversation = await createConversation(session, { id: CONVERSATION_ID })

    expect(conversation.id).toBe(CONVERSATION_ID)
  })

  it("never hands back a thread the caller cannot contribute to", async () => {
    // The response carries a title and a project id. A colliding id that is not
    // the caller's to reach must not leak either of them.
    stubConversation({ visibility: 'private', createdBy: 'user_other' })

    await expect(createConversation(session, { id: CONVERSATION_ID })).rejects.toThrow(NotFoundError)
    expect(findConversationInOrg).not.toHaveBeenCalled()
  })
})

describe('writing requires more than reading', () => {
  it('lets a viewer read but not rename (rename is an owner call)', async () => {
    stubConversation({ visibility: 'private', createdBy: 'user_other' })
    vi.mocked(findGrantForSubject).mockResolvedValue({ role: 'viewer' } as never)

    await expect(getConversation(session, CONVERSATION_ID)).resolves.toBeDefined()
    await expect(updateConversationTitle(session, CONVERSATION_ID, 'Neu')).rejects.toThrow(NotFoundError)
    expect(updateConversationTitleInOrg).not.toHaveBeenCalled()
  })

  it('refuses to append messages as a viewer (collaborator is the minimum)', async () => {
    stubConversation({ visibility: 'private', createdBy: 'user_other' })
    vi.mocked(findGrantForSubject).mockResolvedValue({ role: 'viewer' } as never)

    await expect(
      createConversationMessages(session, CONVERSATION_ID, [{ id: 'msg_1', role: 'user', content: 'hi' }]),
    ).rejects.toThrow(NotFoundError)
    expect(insertMessages).not.toHaveBeenCalled()
  })

  it('refuses to delete a conversation the caller does not own', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_other' })

    await expect(deleteConversation(session, CONVERSATION_ID)).rejects.toThrow(NotFoundError)
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })

  it('stays a silent no-op when deleting an id that does not exist at all', async () => {
    // The chat store deletes server rows for conversations that may only ever
    // have lived in the browser; a 404 there is noise, not a signal.
    vi.mocked(findConversationTenancy).mockResolvedValue(null)

    await expect(deleteConversation(session, CONVERSATION_ID)).resolves.toBeUndefined()
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })
})

describe('message authorship (spec CC-3, MG-3)', () => {
  it('stamps a user message with WHICH person wrote it, and never the agent', async () => {
    stubConversation({ createdBy: 'user_me' })

    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Frage' },
      { id: 'msg_2', role: 'assistant', content: 'Antwort' },
    ])

    const rows = vi.mocked(insertMessages).mock.calls[0][0]
    expect(rows[0]).toMatchObject({ id: 'msg_1', role: 'user', authorUserId: 'user_me' })
    // The agent wrote this one — a user id here would be a lie.
    expect(rows[1]).toMatchObject({ id: 'msg_2', role: 'assistant', authorUserId: null })
  })

  it('attributes a legacy authorless user message to the creator AT READ TIME', async () => {
    stubConversation({ createdBy: 'user_creator', visibility: 'project' })
    vi.mocked(listMessagesForConversation).mockResolvedValue([
      messageRow({ id: 'legacy_user', role: 'user', authorUserId: null }),
      messageRow({ id: 'legacy_agent', role: 'assistant', authorUserId: null }),
      messageRow({ id: 'stamped', role: 'user', authorUserId: 'user_me' }),
    ])

    const messages = await listConversationMessages(session, CONVERSATION_ID)

    expect(messages[0].authorUserId).toBe('user_creator')
    // Not backfilled — the stored row is untouched (MG-3).
    expect(vi.mocked(listMessagesForConversation).mock.results).toHaveLength(1)
    // An authorless assistant row is correct as it stands.
    expect(messages[1].authorUserId).toBeNull()
    // A real author is never overwritten.
    expect(messages[2].authorUserId).toBe('user_me')
  })
})

describe('the addressee ruling (spec MN-1, MN-2, MN-7)', () => {
  beforeEach(() => {
    stubConversation({ createdBy: 'user_me', visibility: 'project' })
  })

  it('addresses the agent when a message carries no mentions', async () => {
    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Frage' },
    ])

    expect(persisted.addressees).toEqual({ agent: true, users: [] })
    expect(applyMessageMentions).not.toHaveBeenCalled()
    // Stored on the row, so it is never re-derived from the text later (MN-2).
    expect(vi.mocked(insertMessages).mock.calls[0][0][0].metadata).toMatchObject({
      addressees: { agent: true, users: [] },
    })
  })

  it('hands off to a human — the agent is NOT addressed, so no turn is opened', async () => {
    vi.mocked(applyMessageMentions).mockResolvedValue({
      addressees: { agent: false, users: ['user_anna'] },
      createdRequests: 1,
      awaitingUserIds: ['user_anna'],
    })
    vi.mocked(resolveParticipants).mockResolvedValue(['user_me', 'user_anna'])

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: '@Anna richtig?', mentions: [{ targetId: 'user_anna' }] },
    ])

    expect(persisted.addressees).toEqual({ agent: false, users: ['user_anna'] })
    expect(persisted.createdRequests).toBe(1)
    expect(applyMessageMentions).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: CONVERSATION_ID, anchorId: 'msg_1' }),
    )
    // MN-7: nothing is started, so no turn event claims one is running.
    const turnEvents = vi
      .mocked(publishToUsers)
      .mock.calls.filter(([, event]) => event.kind === 'conversation.turn')
    expect(turnEvents).toHaveLength(0)
  })

  it('re-uses the ruling a replayed message id already stored, without asking again', async () => {
    vi.mocked(findMessageInConversation).mockResolvedValue(
      messageRow({ metadata: { addressees: { agent: false, users: ['user_anna'] } } }),
    )

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: '@Anna richtig?', mentions: [{ targetId: 'user_anna' }] },
    ])

    expect(applyMessageMentions).not.toHaveBeenCalled()
    expect(persisted.addressees).toEqual({ agent: false, users: ['user_anna'] })
  })

  it('closes what the author was asked, because they just contributed (MN-9.1)', async () => {
    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Ja, stimmt.' },
    ])

    expect(resolveRequestsOnReply).toHaveBeenCalledWith({
      organizationId: 'org_1',
      resourceType: 'conversation',
      resourceId: CONVERSATION_ID,
      authorUserId: 'user_me',
    })
  })

  it('does not close anything for a message the agent wrote', async () => {
    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'assistant', content: 'Antwort' },
    ])

    expect(resolveRequestsOnReply).not.toHaveBeenCalled()
  })
})

describe('participant fan-out (spec CC-9, CC-20, NF-8)', () => {
  it('emits NOTHING for a solo thread — private, no grants', async () => {
    stubConversation({ visibility: 'private', createdBy: 'user_me' })
    vi.mocked(countGrantsForResource).mockResolvedValue(0)

    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Frage' },
    ])

    // A user who never shares anything must not notice this feature exists.
    expect(publishToUsers).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(resolveParticipants).not.toHaveBeenCalled()
  })

  it('tells participants about the message and the turn it opened', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_me' })
    vi.mocked(resolveParticipants).mockResolvedValue(['user_me', 'user_anna'])

    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Frage' },
      { id: 'msg_2', role: 'assistant', content: 'Antwort' },
    ])

    const events = vi.mocked(publishToUsers).mock.calls.map(([recipients, event]) => ({ recipients, event }))
    expect(events).toEqual([
      {
        recipients: ['user_me', 'user_anna'],
        event: {
          kind: 'conversation.message',
          conversationId: CONVERSATION_ID,
          authorUserId: 'user_me',
          messageId: 'msg_1',
        },
      },
      {
        recipients: ['user_me', 'user_anna'],
        event: {
          kind: 'conversation.turn',
          conversationId: CONVERSATION_ID,
          phase: 'started',
          actorUserId: 'user_me',
        },
      },
      {
        recipients: ['user_me', 'user_anna'],
        event: {
          kind: 'conversation.message',
          conversationId: CONVERSATION_ID,
          authorUserId: null,
          messageId: 'msg_2',
        },
      },
      {
        recipients: ['user_me', 'user_anna'],
        event: {
          kind: 'conversation.turn',
          conversationId: CONVERSATION_ID,
          phase: 'ended',
          actorUserId: 'user_me',
        },
      },
    ])
  })

  it('folds ONE collapsing ambient item per participant, not one per message', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_me' })
    vi.mocked(resolveParticipants).mockResolvedValue(['user_me', 'user_anna'])

    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'eins' },
      { id: 'msg_2', role: 'user', content: 'zwei' },
      { id: 'msg_3', role: 'user', content: 'drei' },
    ])

    expect(emitInboxItems).toHaveBeenCalledTimes(1)
    const emissions = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emissions).toHaveLength(2)
    expect(emissions.every((item) => item.type === 'conversation.activity')).toBe(true)
    // The group key carries no anchor, which is what makes twenty messages one row.
    expect(new Set(emissions.map((item) => item.groupKey))).toEqual(
      new Set(['conversation.activity:conversation:conv_1']),
    )
    // The actor is stamped so `emitInboxItems` can drop the self-notification.
    expect(emissions.every((item) => item.actorUserId === 'user_me')).toBe(true)
  })

  it('never fails the message write because notification failed', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_me' })
    vi.mocked(resolveParticipants).mockResolvedValue(['user_anna'])
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('inbox down'))

    const persisted = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Frage' },
    ])

    expect(persisted).toHaveLength(1)
  })
})

describe('read state (spec CC-18, IB-9)', () => {
  it('moves the caller mark and clears ambient items only', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_other' })
    vi.mocked(upsertConversationRead).mockResolvedValue({
      conversationId: CONVERSATION_ID,
      userId: 'user_me',
      lastReadAt: new Date('2026-07-02T12:00:00Z'),
      lastReadMessageId: 'msg_9',
      updatedAt: new Date('2026-07-02T12:00:00Z'),
    })

    const mark = await markConversationRead(session, CONVERSATION_ID, { lastReadMessageId: 'msg_9' })

    expect(upsertConversationRead).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: 'user_me',
      lastReadMessageId: 'msg_9',
    })
    expect(markResourceItemsReadFor).toHaveBeenCalledWith(session, 'conversation', CONVERSATION_ID)
    // Reading a thread is NOT answering the question someone asked in it (MN-16).
    expect(resolveRequestsOnReply).not.toHaveBeenCalled()
    expect(mark.lastReadMessageId).toBe('msg_9')
  })

  it('lets a VIEWER mark read — reading is not contributing', async () => {
    stubConversation({ visibility: 'private', createdBy: 'user_other' })
    vi.mocked(findGrantForSubject).mockResolvedValue({ role: 'viewer' } as never)
    vi.mocked(upsertConversationRead).mockResolvedValue({} as never)

    await expect(markConversationRead(session, CONVERSATION_ID)).resolves.toBeDefined()
  })

  it('404s a mark on a conversation the caller cannot see', async () => {
    stubConversation({ visibility: 'private', createdBy: 'user_other' })

    await expect(markConversationRead(session, CONVERSATION_ID)).rejects.toThrow(NotFoundError)
    expect(upsertConversationRead).not.toHaveBeenCalled()
  })
})

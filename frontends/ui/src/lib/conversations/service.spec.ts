/**
 * @vitest-environment node
 */
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  threadIsAwaitingHuman: vi.fn(),
}))

// The engagement mode (ADR-0036) is mocked at the module boundary: what this
// suite asserts is that the RULING obeys it, while how the mode is stored and
// derived has its own tests in engagement.spec.ts.
vi.mock('./engagement', () => ({
  resolveEngagement: vi.fn(),
  resolveEngagementFor: vi.fn(),
  setEngagement: vi.fn(),
}))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess, type ProjectRole } from '@/lib/authz/projects'
import { threadIsAwaitingHuman } from '@/lib/mentions/service'
import type { Message, ResourceVisibility } from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import { emitInboxItems, markResourceItemsReadFor } from '@/lib/inbox/service'
import { applyMessageMentions, resolveRequestsOnReply } from '@/lib/mentions/service'
import { countGrantsForResource, findGrantForSubject } from '@/lib/sharing/repository'
import { resolveParticipants } from '@/lib/sharing/service'
import { resolveEngagement, resolveEngagementFor, setEngagement } from './engagement'
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
  updateConversationMetaInOrg,
  updateConversationTitleInOrg,
  upsertConversationRead,
} from './repository'
import {
  createConversation,
  createConversationMessages,
  deleteConversation,
  generateConversationTitle,
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
    // Unset, so the mode derives from the thread's author count (ADR-0036).
    engagement: null,
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
  // The collaboration feature is dark-launched (spec NF-7): without an operator
  // opt-in the mention path refuses outright, so the tests that exercise it must
  // enable it. The flag-OFF behaviour has its own tests.
  process.env.GRID_COLLABORATION_ENABLED = 'true'
  stubConversation()
  stubContainer('project-editor')
  vi.mocked(findGrantForSubject).mockResolvedValue(null)
  vi.mocked(countGrantsForResource).mockResolvedValue(0)
  // Default: no outstanding hand-off, so a plain message asks Piloti. Set
  // explicitly because `clearAllMocks` clears CALLS but not a `mockResolvedValue`,
  // so a test that opts into "awaiting" would otherwise leak into its neighbours.
  vi.mocked(threadIsAwaitingHuman).mockResolvedValue(false)
  // Default: `ask`, so a plain message asks Piloti. Set explicitly for the same
  // reason as `threadIsAwaitingHuman` above — `clearAllMocks` does not clear a
  // `mockResolvedValue`, so a test opting into `mention` would leak.
  vi.mocked(resolveEngagementFor).mockResolvedValue({ mode: 'ask', stored: null, suggestion: null })
  vi.mocked(resolveEngagement).mockResolvedValue({ mode: 'ask', stored: null, suggestion: null })
  vi.mocked(findConversationRead).mockResolvedValue(null)
  vi.mocked(resolveParticipants).mockResolvedValue([])
  vi.mocked(emitInboxItems).mockResolvedValue(0)
  vi.mocked(resolveRequestsOnReply).mockResolvedValue({ answered: 0, askedBack: 0, askerUserIds: [] })
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

  it('answers the SAME refusal for an id that does not exist at all (spec SH-6)', async () => {
    // This assertion used to be `resolves.toBeUndefined()`, pinning a silent
    // no-op — which made the service, and through it the endpoint, an existence
    // oracle: 204 for an unknown id, 404 for one that exists in another tenant or
    // belongs to a colleague. Any signed-in member could sort guessed ids into
    // "real" and "not real" with it.
    //
    // The service now reports one truth for both, and the DELETE route turns that
    // truth into ONE response (204 either way) so the chat store can still delete
    // ids that only ever lived in a browser — see `[id]/route.spec.ts`.
    vi.mocked(findConversationTenancy).mockResolvedValue(null)

    await expect(deleteConversation(session, CONVERSATION_ID)).rejects.toThrow(NotFoundError)
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

  it('does NOT wake the agent for a plain message while the thread awaits a human', async () => {
    // The defect this pins: a colleague's answer carries no mentions, so the
    // "no mentions means ask the agent" rule would have Piloti answer a message
    // that was written to a person. Same for "thanks, take your time" from the
    // asker. While a wait is open, a plain message is a remark to the thread.
    vi.mocked(threadIsAwaitingHuman).mockResolvedValue(true)

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Ja, das passt so.' },
    ])

    expect(persisted.addressees).toEqual({ agent: false, users: [] })
  })

  it('asks the agent again once the wait has cleared', async () => {
    vi.mocked(threadIsAwaitingHuman).mockResolvedValue(false)

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Und wie sieht es im EG aus?' },
    ])

    expect(persisted.addressees).toEqual({ agent: true, users: [] })
  })

  /**
   * The fourth row of the routing table (ADR-0036) — the only one in question.
   *
   * `@Piloti` always answers, a humans-only tag never starts a turn, tagging both
   * answers. Those three are absolute. A message that tags NOBODY is governed by
   * the thread's engagement mode, and the reason that exists is the reported bug:
   * Anna answers, Matthias replies TO ANNA, and Piloti answers a message that was
   * never for it.
   */
  it('sends a plain message to the chat, not to Piloti, in a mention-mode thread', async () => {
    vi.mocked(resolveEngagementFor).mockResolvedValue({ mode: 'mention', stored: 'mention', suggestion: null })

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Danke Anna, dann nehmen wir 1,20 m.' },
    ])

    expect(persisted.addressees).toEqual({ agent: false, users: [] })
  })

  it('still answers a plain message in an ask-mode thread — the default is unchanged', async () => {
    vi.mocked(resolveEngagementFor).mockResolvedValue({ mode: 'ask', stored: null, suggestion: null })

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Und wie sieht es im EG aus?' },
    ])

    expect(persisted.addressees).toEqual({ agent: true, users: [] })
  })

  it('an outstanding wait outranks the mode — a waiting thread is asking nobody', async () => {
    // Both would send the message to the chat; what this pins is the ORDER, so a
    // thread explicitly waiting on Anna never pays for the mode lookup and can
    // never be overridden by an `ask` mode into waking the agent.
    vi.mocked(threadIsAwaitingHuman).mockResolvedValue(true)
    vi.mocked(resolveEngagementFor).mockResolvedValue({ mode: 'ask', stored: 'ask', suggestion: null })

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Kein Stress, wann du dazu kommst.' },
    ])

    expect(persisted.addressees).toEqual({ agent: false, users: [] })
    // …and the mode is never even looked up: a waiting thread does not ask the
    // question, so it pays for no query and cannot be talked out of waiting.
    expect(resolveEngagementFor).not.toHaveBeenCalled()
  })

  it('resolves the mode at most once for a batch, however many messages it carries', async () => {
    // The ruling and the settle-the-flip step both need the mode. Resolving it
    // twice was a duplicate query on every plain message in every shared thread.
    vi.mocked(resolveEngagementFor).mockResolvedValue({ mode: 'mention', stored: null, suggestion: null })

    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Erstens…' },
      { id: 'msg_2', role: 'user', content: 'Zweitens…' },
    ])

    expect(resolveEngagementFor).toHaveBeenCalledTimes(1)
  })

  it('writing a message never changes the thread\u2019s own mode', async () => {
    // The load-bearing constraint. Piloti is the point of this product, not a guest
    // in someone else\u2019s chat app, so `ask` stays the default however many people
    // are talking — a colleague typing "danke" must not silently rewire who answers
    // next. A second person writing produces an OFFER on read, never a write here.
    vi.mocked(resolveEngagementFor).mockResolvedValue({
      mode: 'ask',
      stored: null,
      suggestion: 'mention',
    })

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Passt.' },
    ])

    // Still answered by Piloti, and nothing was persisted about the mode.
    expect(persisted.addressees).toEqual({ agent: true, users: [] })
    expect(setEngagement).not.toHaveBeenCalled()
  })

  it('never pays for the awaiting lookup on a solo thread', async () => {
    // A private thread with no grants cannot hold a request, so the default path
    // — a plain question to Piloti — must stay query-free.
    stubConversation({ createdBy: 'user_me', visibility: 'private' })
    vi.mocked(threadIsAwaitingHuman).mockResolvedValue(true)

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Frage an Piloti' },
    ])

    expect(threadIsAwaitingHuman).not.toHaveBeenCalled()
    expect(persisted.addressees).toEqual({ agent: true, users: [] })
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
      // A plain contribution addresses nobody by name, so nothing is recorded as
      // a question back — this is the "they really did answer" case.
      addressedUserIds: [],
    })
  })

  it('passes on who the reply addressed, so a question back is not filed as an answer', async () => {
    // The message that used to produce two contradictory notifications: Anna,
    // who was asked, replies by asking Matthias something.
    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: '@Anna welche Halle meinst du?', mentions: [{ targetId: 'user_anna' }] },
    ])

    // Whatever the ruling addressed is what resolution is judged against — the
    // routing decision is made once, server-side, and never re-derived from text.
    expect(resolveRequestsOnReply).toHaveBeenCalledWith(
      expect.objectContaining({ addressedUserIds: ['user_anna'] }),
    )
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

  it("names the thread in every recipient's row, so the inbox is not ten identical lines", async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_me' })
    vi.mocked(resolveParticipants).mockResolvedValue(['user_me', 'user_anna'])

    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Frage' },
    ])

    // Without the payload this row — the commonest type in the inbox — rendered
    // "3 new messages in Untitled conversation", so ten threads read the same.
    const emissions = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emissions.map((item) => [item.recipientUserId, item.payload])).toEqual([
      ['user_me', { subject: 'Brandschutz Stiegenhaus' }],
      ['user_anna', { subject: 'Brandschutz Stiegenhaus' }],
    ])
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

describe('the addressee ruling is the SERVER\'s, and only the server\'s (spec MN-2)', () => {
  it('strips a client-supplied `addressees` from metadata on a NON-user row', async () => {
    // The server writes its ruling only when it HAS one, and it has none for an
    // assistant/system/tool row — so a client-supplied value used to survive
    // untouched on exactly those rows, and `storedAddressees` would read it back
    // as authoritative when the id was replayed.
    stubConversation({ visibility: 'project', createdBy: session.userId })

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      {
        id: 'msg_1',
        role: 'assistant',
        content: 'Antwort',
        messageType: 'agent_response',
        metadata: {
          addressees: { agent: false, users: ['user_victim'] },
          cards: [{ kind: 'memory_proposal' }],
        },
      },
    ])

    const metadata = persisted.metadata as Record<string, unknown>
    expect(metadata.addressees).toBeUndefined()
    // Everything else the client legitimately stores is untouched.
    expect(metadata.cards).toEqual([{ kind: 'memory_proposal' }])
    expect(metadata.messageType).toBe('agent_response')
  })

  it('overwrites a client-supplied ruling on a USER row with the server\'s own', async () => {
    stubConversation({ visibility: 'project', createdBy: session.userId })
    vi.mocked(applyMessageMentions).mockResolvedValue({
      addressees: { agent: false, users: ['user_anna'] },
      createdRequests: 1,
      awaitingUserIds: ['user_anna'],
    })

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      {
        id: 'msg_1',
        role: 'user',
        content: '@Anna richtig?',
        mentions: [{ targetId: 'user_anna' }],
        metadata: { addressees: { agent: true, users: ['user_victim'] } },
      },
    ])

    expect((persisted.metadata as Record<string, unknown>).addressees).toEqual({
      agent: false,
      users: ['user_anna'],
    })
  })
})

describe('the collaboration flag is off (spec NF-8, NF-7)', () => {
  beforeEach(() => {
    // A deployment that never opted in. The chat path must be the product it was
    // before this feature existed — the flag is the operator's decision, and the
    // feature must not switch itself on by being POSTed to.
    delete process.env.GRID_COLLABORATION_ENABLED
  })

  it('refuses a message carrying mentions, and grants/asks/notifies nobody', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_me' })

    const failure = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: '@Anna richtig?', mentions: [{ targetId: 'user_anna' }] },
    ]).catch((error: unknown) => error)

    expect((failure as ForbiddenError).status).toBe(403)
    expect((failure as ForbiddenError).details).toEqual({
      reason: 'feature-disabled',
      feature: 'collaboration',
    })
    // No grant, no mention request, no inbox row — and the message itself is not
    // stored either, because a refused mention must not leave a half-sent trail.
    expect(applyMessageMentions).not.toHaveBeenCalled()
    expect(insertMessages).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('still persists an ordinary message exactly as before, agent addressed', async () => {
    stubConversation({ visibility: 'private', createdBy: 'user_me' })

    const [persisted] = await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Welche OIB-Richtlinie gilt hier?' },
    ])

    expect(persisted.id).toBe('msg_1')
    expect(persisted.addressees).toEqual({ agent: true, users: [] })
    expect(insertMessages).toHaveBeenCalled()
  })

  it('records the read mark but never touches the inbox', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_other' })
    vi.mocked(upsertConversationRead).mockResolvedValue({} as never)

    await markConversationRead(session, CONVERSATION_ID, { lastReadMessageId: 'msg_9' })

    // CC-18/CC-19 read state is ordinary chat state and keeps working…
    expect(upsertConversationRead).toHaveBeenCalled()
    // …but the ambient-item clearing is collaboration behaviour.
    expect(markResourceItemsReadFor).not.toHaveBeenCalled()
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

/**
 * Naming a conversation is cosmetic, and its log severity has to say so
 * (issue #233). The backend answers HTTP 200 for every LLM outcome it knows how
 * to degrade from, so an `error` code on a 200 is a handled degradation: the
 * chat keeps the provisional first-message name and nothing a user can see is
 * broken. Logging that at ERROR made err2issue file a GitHub issue every time a
 * model phrased its JSON slightly differently. A non-2xx is the opposite case —
 * the endpoint broke its own always-200 contract — and stays at ERROR.
 */
describe('generating a conversation title — severity of a handled failure', () => {
  const titleInput = { messages: [{ role: 'user' as const, content: 'Brandschutz im Stiegenhaus?' }] }

  function backendReturns(body: unknown, ok = true, status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      })),
    )
  }

  beforeEach(() => {
    // The namer requires `owner`, which in practice is the person whose opening
    // exchange is being named.
    stubConversation({ createdBy: 'user_me' })
    vi.mocked(updateConversationMetaInOrg).mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('logs a handled generation failure as a WARNING, never an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    backendReturns({ title: '', tags: [], error: 'llm_response_malformed' })

    const result = await generateConversationTitle(session, CONVERSATION_ID, titleInput)

    expect(result).toEqual({ title: '', tags: [], error: 'llm_response_malformed' })
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[GenerateConversationTitle]'),
      'llm_response_malformed',
    )
    // An empty title must never clobber the provisional first-message name.
    expect(updateConversationMetaInOrg).not.toHaveBeenCalled()
  })

  it('keeps ERROR for a non-2xx, which breaks the always-200 contract', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    backendReturns({ detail: 'boom' }, false, 500)

    const result = await generateConversationTitle(session, CONVERSATION_ID, titleInput)

    expect(result).toEqual({ title: '', tags: [], error: 'backend_error' })
    expect(error).toHaveBeenCalled()
  })

  it('persists a generated title with only known tag keys', async () => {
    backendReturns({ title: 'Brandschutz Stiegenhaus', tags: ['brandschutz', 'nicht-existent'] })

    const result = await generateConversationTitle(session, CONVERSATION_ID, titleInput)

    expect(result).toEqual({ title: 'Brandschutz Stiegenhaus', tags: ['brandschutz'] })
    expect(updateConversationMetaInOrg).toHaveBeenCalledWith(CONVERSATION_ID, 'org_1', {
      title: 'Brandschutz Stiegenhaus',
      tags: ['brandschutz'],
    })
  })
})

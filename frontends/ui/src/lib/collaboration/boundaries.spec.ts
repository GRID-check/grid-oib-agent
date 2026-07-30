/**
 * Boundaries and degenerate inputs (spec SH-16, MN-13, IB-3, IB-8, MG-2).
 *
 * Every bound here exists because the unbounded version is an abuse vector or a
 * silent data-loss bug: a message naming two hundred people, a roster shared with
 * the whole organization, a padded note copied verbatim into someone's inbox, a
 * per-anchor group key with no anchor (which would collapse and DROP every mention
 * after the first), a legacy conversation with no container to gate on, a directory
 * lookup that comes back empty.
 *
 * The real registry, the real access resolution and the real rate-limit constants
 * are used throughout — only the counters and the repositories are stubbed, because
 * the bounds themselves are the thing under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/lib/events/bus', () => ({
  publishToUser: vi.fn().mockResolvedValue(undefined),
  publishToUsers: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))

vi.mock('@/lib/authz/project-membership', () => ({
  canUserAccessProject: vi.fn(),
  filterUsersWithProjectAccess: vi.fn(),
  isUserInOrganization: vi.fn(),
}))

vi.mock('@/lib/conversations/repository', () => ({
  findConversationInOrg: vi.fn(),
  findConversationTenancy: vi.fn(),
  updateConversationVisibilityInOrg: vi.fn(),
}))

vi.mock('@/lib/sharing/repository', () => ({
  SHARE_ROSTER_LIMIT: 200,
  countGrantsForResource: vi.fn(),
  deleteGrant: vi.fn(),
  findGrantForSubject: vi.fn(),
  listGrantsForResource: vi.fn(),
  upsertGrant: vi.fn(),
}))

vi.mock('@/lib/mentions/repository', () => ({
  findRequestById: vi.fn(),
  insertMentionRequests: vi.fn(),
  listOpenRequestsForResource: vi.fn(),
  listOpenRequestsForSubject: vi.fn(),
  resolveRequests: vi.fn(),
  voidOpenRequestsForResource: vi.fn(),
  voidOpenRequestsForSubject: vi.fn(),
}))

vi.mock('@/lib/inbox/repository', () => ({
  INBOX_LIST_LIMIT: 50,
  archiveInboxItem: vi.fn(),
  countPendingInboxItems: vi.fn(),
  listInboxItems: vi.fn(),
  markAllInboxItemsRead: vi.fn(),
  markInboxItemsRead: vi.fn(),
  markItemsInertForResource: vi.fn(),
  markItemsInertForSubjectRow: vi.fn(),
  markResourceItemsRead: vi.fn(),
  resolveInboxItemsForTargets: vi.fn(),
  upsertInboxItems: vi.fn(),
}))

// The real `unknownPerson` fallback is exactly what row E32 protects.
vi.mock('@/lib/sharing/directory', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/sharing/directory')>()),
  loadOrganizationDirectory: vi.fn(),
}))

// The real bounds (10 mentions per message, 200 per roster) are the rules under
// test; only the counter is stubbed.
vi.mock('@/lib/sharing/rate-limit', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/sharing/rate-limit')>()),
  consumeRateLimit: vi.fn(),
}))

import { ConflictError, ForbiddenError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  canUserAccessProject,
  filterUsersWithProjectAccess,
  isUserInOrganization,
} from '@/lib/authz/project-membership'
import { requireProjectAccess, type ProjectRole } from '@/lib/authz/projects'
import { findConversationInOrg, findConversationTenancy } from '@/lib/conversations/repository'
import type { MentionRequest, NewInboxItem, ResourceRole, ResourceVisibility } from '@/lib/db/schema'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { countPendingInboxItems, upsertInboxItems } from '@/lib/inbox/repository'
import {
  insertMentionRequests,
  listOpenRequestsForResource,
  listOpenRequestsForSubject,
} from '@/lib/mentions/repository'
import { applyMessageMentions, getAwaitingState } from '@/lib/mentions/service'
import { MAX_MENTIONS_PER_MESSAGE, consumeRateLimit } from '@/lib/sharing/rate-limit'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import {
  SHARE_ROSTER_LIMIT,
  countGrantsForResource,
  findGrantForSubject,
  listGrantsForResource,
  upsertGrant,
} from '@/lib/sharing/repository'
import { getSharingState, grantResourceAccess } from '@/lib/sharing/service'

const CONVERSATION_ID = 'conv_1'
const ANNA = 'user_anna'
const BOB = 'user_bob'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

function person(userId: string, name: string) {
  return { userId, email: `${name.toLowerCase()}@grid.test`, name, profilePictureUrl: null }
}

function stubConversation(
  overrides: Partial<{
    organizationId: string
    projectId: string | null
    visibility: ResourceVisibility
    createdBy: string | null
    deletedAt: Date | null
  }> = {},
): void {
  vi.mocked(findConversationTenancy).mockResolvedValue({
    organizationId: 'org_1',
    projectId: 'proj_1',
    visibility: 'private' as ResourceVisibility,
    createdBy: session.userId,
    deletedAt: null,
    ...overrides,
  } as never)
}

function stubContainer(role: ProjectRole | 'denied'): void {
  if (role === 'denied') {
    vi.mocked(requireProjectAccess).mockRejectedValue(new Error('should not be reached'))
    return
  }
  vi.mocked(requireProjectAccess).mockResolvedValue({ role } as never)
}

function stubGrants(grants: Array<{ subjectUserId: string; role: ResourceRole }>): void {
  vi.mocked(listGrantsForResource).mockResolvedValue(
    grants.map((grant, index) => ({
      id: `share_${index}`,
      organizationId: 'org_1',
      resourceType: 'conversation',
      resourceId: CONVERSATION_ID,
      subjectUserId: grant.subjectUserId,
      role: grant.role,
      grantedBy: session.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as never,
  )
}

function requestRow(overrides: Partial<MentionRequest> = {}): MentionRequest {
  return {
    id: 'req_1',
    organizationId: 'org_1',
    resourceType: 'conversation',
    resourceId: CONVERSATION_ID,
    anchorId: 'msg_1',
    requestedBy: session.userId,
    requestedOf: ANNA,
    note: 'Atrium als OIB 2.3?',
    status: 'open',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date('2026-07-29T10:00:00.000Z'),
    ...overrides,
  }
}

function send(mentions: string[], extra: { note?: string; excerpt?: string } = {}) {
  return applyMessageMentions({
    session,
    resourceType: 'conversation',
    resourceId: CONVERSATION_ID,
    anchorId: 'msg_1',
    mentions: mentions.map((targetId) => ({ targetId })),
    ...extra,
  })
}

beforeEach(() => {
  stubConversation()
  stubContainer('project-editor')
  // Anna already holds a grant, so mentioning her needs no invitation.
  vi.mocked(findGrantForSubject).mockResolvedValue(null)
  stubGrants([{ subjectUserId: ANNA, role: 'collaborator' }])
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      [session.userId, person(session.userId, 'Matthias')],
      [ANNA, person(ANNA, 'Anna')],
      [BOB, person(BOB, 'Bob')],
    ]),
  )
  vi.mocked(consumeRateLimit).mockResolvedValue({ allowed: true, current: 1, limit: 100 })
  vi.mocked(countGrantsForResource).mockResolvedValue(1)
  vi.mocked(countPendingInboxItems).mockResolvedValue(0)
  vi.mocked(canUserAccessProject).mockResolvedValue(true)
  vi.mocked(isUserInOrganization).mockResolvedValue(true)
  // Every candidate reaches the project unless a test says otherwise — the
  // mention path now asserts the container precondition for participants too
  // (spec MN-6), so this mirrors `canUserAccessProject` above.
  vi.mocked(filterUsersWithProjectAccess).mockImplementation(
    async (_session, _projectId, candidateUserIds) => new Set(candidateUserIds),
  )
  vi.mocked(upsertGrant).mockResolvedValue({} as never)
  vi.mocked(upsertInboxItems).mockImplementation(async (rows) => rows as never)
  vi.mocked(listOpenRequestsForResource).mockResolvedValue([])
  vi.mocked(listOpenRequestsForSubject).mockResolvedValue([])
  vi.mocked(findConversationInOrg).mockResolvedValue({ title: 'Halle 3' } as never)
  vi.mocked(insertMentionRequests).mockImplementation(async (values) =>
    values.map((value, index) => requestRow({ ...(value as Partial<MentionRequest>), id: `req_${index + 1}` })),
  )
})

describe('the per-message mention cap (matrix E26, spec MN-13)', () => {
  it('refuses the whole message rather than sending the first ten mentions', async () => {
    // Mention-bombing is the attack, and a message naming two hundred people is
    // what it looks like. A partial send would be worse than a refusal: the author
    // could not tell which names took effect.
    const many = Array.from({ length: MAX_MENTIONS_PER_MESSAGE + 1 }, (_, index) => `user_${index}`)

    const failure = await send(many).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ForbiddenError)
    expect((failure as ForbiddenError).details).toEqual({ reason: 'mention-rate-limited' })
    // Bounded before the authorization probe, let alone a write.
    expect(findConversationTenancy).not.toHaveBeenCalled()
    expect(insertMentionRequests).not.toHaveBeenCalled()
    expect(upsertInboxItems).not.toHaveBeenCalled()
  })

  it('accepts a message exactly at the cap', async () => {
    // The bound is a ceiling, not an off-by-one refusal at the limit.
    const atCap = Array.from({ length: MAX_MENTIONS_PER_MESSAGE }, (_, index) => `user_${index}`)

    await expect(send(atCap)).resolves.toBeDefined()
    expect(consumeRateLimit).toHaveBeenCalledWith(expect.anything(), session.userId, MAX_MENTIONS_PER_MESSAGE)
  })
})

describe('the grant roster cap (matrix E27, spec SH-16)', () => {
  it('refuses a grant once the roster is full, and writes nothing', async () => {
    vi.mocked(countGrantsForResource).mockResolvedValue(SHARE_ROSTER_LIMIT)

    const failure = await grantResourceAccess(session, 'conversation', CONVERSATION_ID, {
      subjectUserId: BOB,
      role: 'collaborator',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConflictError)
    expect((failure as ConflictError).message).toContain(String(SHARE_ROSTER_LIMIT))
    // "Share with everyone" is not a feature: no grant, no audit entry.
    expect(upsertGrant).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('still allows the grant that lands exactly under the cap', async () => {
    vi.mocked(countGrantsForResource).mockResolvedValue(SHARE_ROSTER_LIMIT - 1)

    await expect(
      grantResourceAccess(session, 'conversation', CONVERSATION_ID, {
        subjectUserId: BOB,
        role: 'collaborator',
      }),
    ).resolves.toBeDefined()
    expect(upsertGrant).toHaveBeenCalledTimes(1)
  })
})

describe('user-controlled text in a notification (matrix E28, spec IB-3, MN-12)', () => {
  it('truncates an oversized note instead of storing and copying it whole', async () => {
    const note = 'A'.repeat(1000)

    await send([ANNA], { note })

    const storedNote = (vi.mocked(insertMentionRequests).mock.calls[0]![0][0] as { note: string | null })
      .note!
    const payload = (vi.mocked(upsertInboxItems).mock.calls[0]![0][0] as NewInboxItem).payload as {
      excerpt: string | null
    }

    // Bounded on BOTH sides of the hand-off: the stored request and the copy that
    // rides into someone else's inbox and is re-read on every render.
    expect(storedNote.length).toBeLessThan(note.length)
    expect(storedNote.endsWith('…')).toBe(true)
    expect(payload.excerpt).toBe(storedNote)
    expect(payload.excerpt!.length).toBe(storedNote.length)
  })

  it('leaves a reasonable note exactly as written', async () => {
    await send([ANNA], { note: '  Ist das Atrium OIB 2.3?  ' })

    const storedNote = (vi.mocked(insertMentionRequests).mock.calls[0]![0][0] as { note: string | null })
      .note
    expect(storedNote).toBe('Ist das Atrium OIB 2.3?')
  })

  it('drops a whitespace-only note rather than storing an empty question', async () => {
    await send([ANNA], { note: '   \n  ' })

    const storedNote = (vi.mocked(insertMentionRequests).mock.calls[0]![0][0] as { note: string | null })
      .note
    expect(storedNote).toBeNull()
  })
})

describe('the per-anchor group key (matrix E29, spec IB-8)', () => {
  it('throws for a per-anchor type with no anchor instead of collapsing mentions together', () => {
    // Collapsing would make the second mention in a thread overwrite the first —
    // a lost request for help, which is the one failure this feature must not have.
    for (const anchor of [undefined, null, '']) {
      expect(() =>
        inboxGroupKey('mention.requested', 'conversation', CONVERSATION_ID, anchor),
      ).toThrow(/groups per anchor/)
    }
  })

  it('keeps two mentions in one thread on two distinct rows', () => {
    expect(inboxGroupKey('mention.requested', 'conversation', CONVERSATION_ID, 'msg_1')).not.toBe(
      inboxGroupKey('mention.requested', 'conversation', CONVERSATION_ID, 'msg_2'),
    )
  })

  it('does collapse the type that MUST collapse, anchor or not', () => {
    // Ambient activity is the opposite requirement: twenty messages, one row.
    expect(inboxGroupKey('conversation.activity', 'conversation', CONVERSATION_ID, 'msg_9')).toBe(
      inboxGroupKey('conversation.activity', 'conversation', CONVERSATION_ID),
    )
  })
})

describe('a legacy conversation with no container (matrix E30, spec MG-2)', () => {
  beforeEach(() => {
    // Pre-project-stamping rows: no project membership could describe them, so
    // there is nothing to gate on and nothing to crash on.
    stubConversation({ projectId: null })
    stubContainer('denied')
  })

  it('resolves its sharing state without a container check', async () => {
    const state = await getSharingState(session, 'conversation', CONVERSATION_ID)

    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(state.myRole).toBe('owner')
    expect(state.visibility).toBe('private')
  })

  it('grants access without asking whether the invitee can reach a project that does not exist', async () => {
    await grantResourceAccess(session, 'conversation', CONVERSATION_ID, {
      subjectUserId: BOB,
      role: 'collaborator',
    })

    expect(canUserAccessProject).not.toHaveBeenCalled()
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ subjectUserId: BOB }))
  })

  it('still checks that the invitee is in the ORGANIZATION — no container is not no precondition', async () => {
    // "Nothing to gate on" used to mean "nothing checked": a grant could name a
    // user in another tenant, and the fan-out would publish to their channel.
    await grantResourceAccess(session, 'conversation', CONVERSATION_ID, {
      subjectUserId: BOB,
      role: 'collaborator',
    })

    expect(isUserInOrganization).toHaveBeenCalledWith(session, BOB)
  })
})

describe('duplicate mention targets in one message (matrix E31, spec MN-13)', () => {
  it('costs one request, one notification and one unit of budget', async () => {
    // The composer can emit the same target twice (typed once, re-picked once).
    const result = await send([ANNA, ANNA, ANNA])

    expect(result.addressees).toEqual({ agent: false, users: [ANNA] })
    expect(vi.mocked(insertMentionRequests).mock.calls[0]![0]).toHaveLength(1)
    expect(vi.mocked(upsertInboxItems).mock.calls[0]![0]).toHaveLength(1)
    expect(consumeRateLimit).toHaveBeenCalledWith(expect.anything(), session.userId, 1)
  })
})

describe('an unresolvable person (matrix E32, spec SH-17)', () => {
  it('still renders a roster entry when the directory comes back empty', async () => {
    // WorkOS is authoritative for identity and the app keeps no user table, so a
    // directory outage must degrade to ids and initials, never to a broken page.
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
    stubGrants([{ subjectUserId: ANNA, role: 'collaborator' }])

    const state = await getSharingState(session, 'conversation', CONVERSATION_ID)

    expect(state.entries).toHaveLength(2)
    expect(state.entries.map((entry) => entry.person.userId)).toEqual([session.userId, ANNA])
    expect(state.entries[1]!.person).toEqual({
      userId: ANNA,
      email: null,
      name: ANNA,
      profilePictureUrl: null,
    })
  })

  it('still renders the awaiting banner for a person the directory does not know', async () => {
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
    vi.mocked(listOpenRequestsForResource).mockResolvedValue([requestRow({ requestedOf: 'user_ghost' })])

    const state = await getAwaitingState(session, CONVERSATION_ID)

    expect(state.pending[0]!.person.name).toBe('user_ghost')
    // The asker stays null rather than fabricating a person out of an id.
    expect(state.pending[0]!.requestedBy).toBeNull()
  })

  it('drops an unresolvable mention target rather than failing the message', async () => {
    const result = await send(['user_ghost'])

    // A stale picker entry is not something to fail a send over — but the message
    // still has to be answered by somebody, so it falls back to the agent.
    expect(result.addressees).toEqual({ agent: true, users: [] })
    expect(insertMentionRequests).not.toHaveBeenCalled()
  })
})

describe('the mention text bound is shared with the inbox projection (matrix E28)', () => {
  it('caps the payload the inbox reads back, whatever was stored', async () => {
    await send([ANNA], { note: 'B'.repeat(400) })

    const payload = (vi.mocked(upsertInboxItems).mock.calls[0]![0][0] as NewInboxItem).payload as {
      subject: string | null
      excerpt: string | null
    }
    expect(payload.subject).toBe('Halle 3')
    expect(payload.excerpt!.length).toBeLessThanOrEqual(280)
  })
})

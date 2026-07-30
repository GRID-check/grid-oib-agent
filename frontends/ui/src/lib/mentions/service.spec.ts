/**
 * The mention hand-off (ADR-0034, spec MN-1…MN-16).
 *
 * The behaviour under test is *the agent deliberately not answering*, which is
 * indistinguishable from a bug unless it is exactly right. So the addressing rule
 * gets a case per branch, and every refusal is asserted to have written nothing —
 * a refused mention that still granted access or still notified someone would be
 * the worst kind of failure here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/sharing/access', () => ({
  requireResourceAccess: vi.fn(),
}))

vi.mock('@/lib/sharing/service', () => ({
  grantResourceAccess: vi.fn(),
  resolveParticipants: vi.fn(),
}))

vi.mock('@/lib/sharing/directory', () => ({
  loadOrganizationDirectory: vi.fn(),
  unknownPerson: (userId: string) => ({ userId, email: null, name: userId, profilePictureUrl: null }),
}))

// The real bounds (10 per message, 100 per hour) are part of the rule under test;
// only the counter itself is stubbed.
vi.mock('@/lib/sharing/rate-limit', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/sharing/rate-limit')>()),
  consumeRateLimit: vi.fn(),
}))

vi.mock('@/lib/authz/project-membership', () => ({
  filterUsersWithProjectAccess: vi.fn(),
}))

vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(),
  resolveInboxItemsFor: vi.fn(),
}))

vi.mock('@/lib/events/bus', () => ({
  publishToUsers: vi.fn(),
}))

vi.mock('@/lib/conversations/repository', () => ({
  findConversationInOrg: vi.fn(),
  findConversationTenancy: vi.fn(),
}))

vi.mock('./repository', () => ({
  findRequestById: vi.fn(),
  insertMentionRequests: vi.fn(),
  listOpenRequestsForResource: vi.fn(),
  listOpenRequestsForSubject: vi.fn(),
  resolveRequests: vi.fn(),
  voidOpenRequestsForResource: vi.fn(),
  voidOpenRequestsForSubject: vi.fn(),
}))

import { BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { filterUsersWithProjectAccess } from '@/lib/authz/project-membership'
import { findConversationInOrg } from '@/lib/conversations/repository'
import type { MentionRequest, ResourceRole } from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import { emitInboxItems, resolveInboxItemsFor } from '@/lib/inbox/service'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { consumeRateLimit } from '@/lib/sharing/rate-limit'
import { grantResourceAccess, resolveParticipants } from '@/lib/sharing/service'
import {
  findRequestById,
  insertMentionRequests,
  listOpenRequestsForResource,
  listOpenRequestsForSubject,
  resolveRequests,
} from './repository'
import {
  applyMessageMentions,
  getAwaitingState,
  listMentionCandidates,
  releaseRequest,
  resolveRequestsOnReply,
} from './service'
import { AGENT_MENTION_ID, MENTION_ERROR_REASONS } from './types'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

const ANNA = 'user_anna'
const BOB = 'user_bob'
const CAROL = 'user_carol'

function person(userId: string, name: string) {
  return { userId, email: `${name.toLowerCase()}@grid.test`, name, profilePictureUrl: null }
}

function requestRow(overrides: Partial<MentionRequest> = {}): MentionRequest {
  return {
    id: 'req_1',
    organizationId: 'org_1',
    resourceType: 'conversation',
    resourceId: 'conv_1',
    anchorId: 'msg_1',
    requestedBy: 'user_me',
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

/** The caller's role on the conversation — the thing MN-5's invite policy turns on. */
function stubCallerRole(role: ResourceRole): void {
  vi.mocked(requireResourceAccess).mockResolvedValue({
    role,
    reason: 'grant',
    visibility: 'private',
    container: { organizationId: 'org_1', projectId: 'proj_1' },
    canEscalate: false,
  })
}

function send(mentions: string[], extra: { note?: string; excerpt?: string } = {}) {
  return applyMessageMentions({
    session,
    resourceType: 'conversation',
    resourceId: 'conv_1',
    anchorId: 'msg_1',
    mentions: mentions.map((targetId) => ({ targetId })),
    ...extra,
  })
}

beforeEach(() => {
  stubCallerRole('owner')
  // Anna is already in the room; Bob and Carol are not.
  vi.mocked(resolveParticipants).mockResolvedValue(['user_me', ANNA])
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      ['user_me', person('user_me', 'Matthias')],
      [ANNA, person(ANNA, 'Anna')],
      [BOB, person(BOB, 'Bob')],
      [CAROL, person(CAROL, 'Carol')],
    ]),
  )
  vi.mocked(consumeRateLimit).mockResolvedValue({ allowed: true, current: 1, limit: 100 })
  vi.mocked(insertMentionRequests).mockImplementation(async (values) =>
    values.map((value, index) => requestRow({ ...(value as Partial<MentionRequest>), id: `req_${index + 1}` })),
  )
  vi.mocked(listOpenRequestsForResource).mockResolvedValue([])
  vi.mocked(listOpenRequestsForSubject).mockResolvedValue([])
  vi.mocked(resolveRequests).mockResolvedValue([])
  vi.mocked(emitInboxItems).mockResolvedValue(1)
  vi.mocked(resolveInboxItemsFor).mockResolvedValue(1)
  vi.mocked(publishToUsers).mockResolvedValue(undefined)
  vi.mocked(grantResourceAccess).mockResolvedValue({} as never)
  vi.mocked(filterUsersWithProjectAccess).mockResolvedValue(new Set([ANNA, BOB]))
  vi.mocked(findConversationInOrg).mockResolvedValue({ title: 'Atrium' } as never)
})

describe('applyMessageMentions — addressing (spec MN-1)', () => {
  it('addresses the agent when there are no mentions, without touching anything', async () => {
    const result = await send([])

    expect(result.addressees).toEqual({ agent: true, users: [] })
    expect(result.createdRequests).toBe(0)
    // The hot path: an ordinary question to the agent must cost no probe, no
    // rate-limit write and no query.
    expect(requireResourceAccess).not.toHaveBeenCalled()
    expect(consumeRateLimit).not.toHaveBeenCalled()
    expect(insertMentionRequests).not.toHaveBeenCalled()
  })

  it('silences the agent when a human is mentioned', async () => {
    const result = await send([ANNA])

    expect(result.addressees).toEqual({ agent: false, users: [ANNA] })
    expect(result.createdRequests).toBe(1)
  })

  it('addresses BOTH when the agent is tagged alongside a human', async () => {
    const result = await send([AGENT_MENTION_ID, ANNA])

    expect(result.addressees).toEqual({ agent: true, users: [ANNA] })
    expect(result.createdRequests).toBe(1)
  })

  it('falls back to the agent when every mentioned id is unresolvable', async () => {
    // Spec MN-3: a stale picker entry is dropped, not refused — but the message
    // still has to be answered by somebody.
    const result = await send(['user_ghost'])

    expect(result.addressees).toEqual({ agent: true, users: [] })
    expect(insertMentionRequests).not.toHaveBeenCalled()
  })

  it('drops a self-mention rather than waiting for the author', async () => {
    const result = await send([session.userId])

    expect(result.addressees).toEqual({ agent: true, users: [] })
    expect(insertMentionRequests).not.toHaveBeenCalled()
  })

  it('deduplicates a target picked twice', async () => {
    await send([ANNA, ANNA])

    expect(vi.mocked(insertMentionRequests).mock.calls[0][0]).toHaveLength(1)
    expect(consumeRateLimit).toHaveBeenCalledWith(expect.anything(), session.userId, 1)
  })
})

describe('applyMessageMentions — the invite policy (spec MN-5, MN-6, OQ-3)', () => {
  it('refuses a collaborator mentioning a non-participant, and writes nothing', async () => {
    stubCallerRole('collaborator')

    const failure = await send([BOB]).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BadRequestError)
    expect((failure as BadRequestError).details).toEqual({
      reason: MENTION_ERROR_REASONS.inviteRequiresOwner,
      targetId: BOB,
    })

    // No invitation, no request, no notification: a refused mention leaves no trail.
    expect(grantResourceAccess).not.toHaveBeenCalled()
    expect(insertMentionRequests).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('lets a collaborator mention an existing participant', async () => {
    stubCallerRole('collaborator')

    const result = await send([ANNA])

    expect(result.addressees).toEqual({ agent: false, users: [ANNA] })
    expect(grantResourceAccess).not.toHaveBeenCalled()
  })

  it('invites a non-participant as collaborator when the actor is an owner', async () => {
    const result = await send([BOB])

    expect(grantResourceAccess).toHaveBeenCalledWith(session, 'conversation', 'conv_1', {
      subjectUserId: BOB,
      role: 'collaborator',
    })
    expect(result.addressees).toEqual({ agent: false, users: [BOB] })
    expect(emitInboxItems).toHaveBeenCalledTimes(1)
  })

  it('refuses a mention of someone who cannot reach the container project', async () => {
    // Surfaced from grantResourceAccess rather than re-checked here (spec SH-5):
    // one implementation of the rule, one place to keep correct.
    vi.mocked(grantResourceAccess).mockRejectedValue(
      new BadRequestError('not in the project', {
        reason: 'container-access-required',
        projectId: 'proj_1',
      }),
    )

    const failure = await send([BOB]).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BadRequestError)
    expect((failure as BadRequestError).details).toEqual({
      reason: MENTION_ERROR_REASONS.containerAccessRequired,
      targetId: BOB,
    })
    expect(insertMentionRequests).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('applyMessageMentions — bounds (spec MN-13)', () => {
  it('refuses a message that mentions too many people', async () => {
    const many = Array.from({ length: 11 }, (_, index) => `user_${index}`)

    const failure = await send(many).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ForbiddenError)
    expect((failure as ForbiddenError).details).toEqual({
      reason: MENTION_ERROR_REASONS.rateLimited,
    })
    // Refused before the authorization probe, let alone a write.
    expect(requireResourceAccess).not.toHaveBeenCalled()
    expect(insertMentionRequests).not.toHaveBeenCalled()
  })

  it('refuses when the actor has exhausted their hourly mention budget', async () => {
    vi.mocked(consumeRateLimit).mockResolvedValue({ allowed: false, current: 101, limit: 100 })

    const failure = await send([ANNA]).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ForbiddenError)
    expect((failure as ForbiddenError).details).toEqual({
      reason: MENTION_ERROR_REASONS.rateLimited,
    })
    expect(insertMentionRequests).not.toHaveBeenCalled()
  })
})

describe('applyMessageMentions — notification (spec MN-14, MN-15)', () => {
  it('emits one actionable item per recipient, anchored on the message', async () => {
    await send([ANNA], { note: 'Richtig, das Atrium als OIB 2.3 zu behandeln?', excerpt: 'quote' })

    expect(emitInboxItems).toHaveBeenCalledWith([
      {
        organizationId: 'org_1',
        recipientUserId: ANNA,
        type: 'mention.requested',
        resourceType: 'conversation',
        resourceId: 'conv_1',
        anchorId: 'msg_1',
        actorUserId: session.userId,
        groupKey: 'mention.requested:conversation:conv_1:msg_1',
        payload: {
          subject: 'Atrium',
          // The question beats the quote (spec MN-12).
          excerpt: 'Richtig, das Atrium als OIB 2.3 zu behandeln?',
        },
      },
    ])
  })

  it('falls back to the message excerpt when there is no question', async () => {
    await send([ANNA], { excerpt: 'Das Atrium ist 400 m² groß.' })

    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0].payload).toEqual({
      subject: 'Atrium',
      excerpt: 'Das Atrium ist 400 m² groß.',
    })
  })

  it('publishes the derived awaiting set to the participants', async () => {
    vi.mocked(listOpenRequestsForResource).mockResolvedValue([requestRow()])

    const result = await send([ANNA])

    expect(result.awaitingUserIds).toEqual([ANNA])
    expect(publishToUsers).toHaveBeenCalledWith(
      expect.arrayContaining(['user_me', ANNA]),
      { kind: 'conversation.awaiting', conversationId: 'conv_1', awaitingUserIds: [ANNA] },
    )
  })

  it('hands the thread back to the agent when it is tagged explicitly (spec MN-9.3)', async () => {
    vi.mocked(listOpenRequestsForResource).mockResolvedValueOnce([requestRow()]).mockResolvedValue([])
    vi.mocked(resolveRequests).mockResolvedValue([
      requestRow({ status: 'released', resolution: 'released' }),
    ])

    const result = await send([AGENT_MENTION_ID])

    expect(result.addressees).toEqual({ agent: true, users: [] })
    expect(resolveRequests).toHaveBeenCalledWith(['req_1'], 'released', session.userId)
    expect(result.awaitingUserIds).toEqual([])
  })
})

describe('resolveRequestsOnReply (spec MN-9.1, MN-16, MN-18)', () => {
  const input = {
    organizationId: 'org_1',
    resourceType: 'conversation' as const,
    resourceId: 'conv_1',
    authorUserId: ANNA,
  }

  it('closes only the requests addressed to the author, and tells the asker', async () => {
    vi.mocked(listOpenRequestsForSubject).mockResolvedValue([requestRow()])
    vi.mocked(resolveRequests).mockResolvedValue([
      requestRow({ status: 'answered', resolution: 'answered', resolvedBy: ANNA }),
    ])

    const result = await resolveRequestsOnReply(input)

    // Scoped to the author: someone else's outstanding request is untouched
    // (spec MN-10 — each person's request resolves independently).
    expect(listOpenRequestsForSubject).toHaveBeenCalledWith('conversation', 'conv_1', ANNA)
    expect(resolveRequests).toHaveBeenCalledWith(['req_1'], 'answered', ANNA)
    expect(result).toEqual({ answered: 1, askerUserIds: ['user_me'] })

    // The recipient's own item resolves without them dismissing anything (MN-16)…
    expect(resolveInboxItemsFor).toHaveBeenCalledWith(
      ['mention.requested:conversation:conv_1:msg_1'],
      [ANNA],
    )
    // …and the asker is told (MN-18).
    expect(emitInboxItems).toHaveBeenCalledWith([
      expect.objectContaining({
        recipientUserId: 'user_me',
        type: 'mention.answered',
        actorUserId: ANNA,
        groupKey: 'mention.answered:conversation:conv_1:msg_1',
      }),
    ])
  })

  it('does nothing when the author was not being awaited', async () => {
    vi.mocked(listOpenRequestsForSubject).mockResolvedValue([])

    const result = await resolveRequestsOnReply(input)

    expect(result).toEqual({ answered: 0, askerUserIds: [] })
    expect(resolveRequests).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })
})

describe('releaseRequest (spec MN-9.2)', () => {
  it('closes the request as released and clears the awaiting set', async () => {
    vi.mocked(findRequestById).mockResolvedValue(requestRow())
    vi.mocked(resolveRequests).mockResolvedValue([
      requestRow({ status: 'released', resolution: 'released', resolvedBy: session.userId }),
    ])
    vi.mocked(listOpenRequestsForResource).mockResolvedValue([])

    const state = await releaseRequest(session, 'req_1')

    expect(resolveRequests).toHaveBeenCalledWith(['req_1'], 'released', session.userId)
    expect(resolveInboxItemsFor).toHaveBeenCalledWith(
      ['mention.requested:conversation:conv_1:msg_1'],
      [ANNA],
    )
    expect(publishToUsers).toHaveBeenCalledWith(expect.arrayContaining(['user_me', ANNA]), {
      kind: 'conversation.awaiting',
      conversationId: 'conv_1',
      awaitingUserIds: [],
    })
    expect(state).toEqual({ pending: [], awaitingMe: false })
  })

  it('needs contributor rights, not ownership', async () => {
    vi.mocked(findRequestById).mockResolvedValue(requestRow())
    vi.mocked(resolveRequests).mockResolvedValue([requestRow({ status: 'released' })])
    vi.mocked(listOpenRequestsForResource).mockResolvedValue([])

    await releaseRequest(session, 'req_1')

    expect(requireResourceAccess).toHaveBeenCalledWith(session, 'conversation', 'conv_1', 'collaborator')
  })

  it('hides a request from another organization behind a 404', async () => {
    vi.mocked(findRequestById).mockResolvedValue(requestRow({ organizationId: 'org_other' }))

    await expect(releaseRequest(session, 'req_1')).rejects.toBeInstanceOf(NotFoundError)
    expect(resolveRequests).not.toHaveBeenCalled()
  })
})

describe('getAwaitingState (spec MN-8)', () => {
  it('renders the derived wait with resolved people', async () => {
    vi.mocked(listOpenRequestsForResource).mockResolvedValue([requestRow()])

    const state = await getAwaitingState(session, 'conv_1')

    expect(state.pending).toEqual([
      {
        id: 'req_1',
        person: person(ANNA, 'Anna'),
        requestedBy: person('user_me', 'Matthias'),
        note: 'Atrium als OIB 2.3?',
        anchorId: 'msg_1',
        createdAt: '2026-07-29T10:00:00.000Z',
      },
    ])
    expect(state.awaitingMe).toBe(false)
  })

  it('tells the awaited person that it is their turn', async () => {
    vi.mocked(listOpenRequestsForResource).mockResolvedValue([requestRow({ requestedOf: session.userId })])

    const state = await getAwaitingState(session, 'conv_1')
    expect(state.awaitingMe).toBe(true)
  })

  it('reads as idle with no open requests, and requires only viewer', async () => {
    const state = await getAwaitingState(session, 'conv_1')

    expect(state).toEqual({ pending: [], awaitingMe: false })
    expect(requireResourceAccess).toHaveBeenCalledWith(session, 'conversation', 'conv_1', 'viewer')
  })
})

describe('listMentionCandidates (spec MN-4, SH-19)', () => {
  it('offers the agent, participants, and invitable project members only', async () => {
    // Carol is in the organization but cannot reach the project.
    vi.mocked(filterUsersWithProjectAccess).mockResolvedValue(new Set([ANNA, BOB]))

    const { candidates, canInvite } = await listMentionCandidates(session, 'conv_1')

    expect(candidates.map((candidate) => candidate.targetId)).toEqual([AGENT_MENTION_ID, ANNA, BOB])
    expect(candidates[0]).toMatchObject({ isAgent: true, needsInvite: false })
    expect(candidates[1]).toMatchObject({ isParticipant: true, needsInvite: false })
    expect(candidates[2]).toMatchObject({ isParticipant: false, needsInvite: true })
    // Nobody outside the project appears at all — offering a name that can only
    // ever be refused reads as a bug (spec MN-6).
    expect(candidates.some((candidate) => candidate.targetId === CAROL)).toBe(false)
    expect(canInvite).toBe(true)
  })

  it('reports canInvite false for a collaborator, who may only tag participants', async () => {
    stubCallerRole('collaborator')

    const { canInvite } = await listMentionCandidates(session, 'conv_1')
    expect(canInvite).toBe(false)
  })
})

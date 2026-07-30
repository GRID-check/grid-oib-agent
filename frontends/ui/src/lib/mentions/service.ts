/**
 * Mentions service — addressee resolution, the hand-off lifecycle, and the
 * revocation hook (ADR-0034).
 *
 * The rule this module exists to enforce (spec MN-1):
 *   - no mentions            → the agent answers (today's behaviour, unchanged);
 *   - a human is mentioned   → the agent stays SILENT and the thread waits;
 *   - the agent is mentioned → the agent answers, alongside any humans.
 *
 * The addressee set is computed HERE, once, at persist time, and stored on the
 * message. It is never re-derived from the message text later, and never taken on
 * trust from the client.
 *
 * **Nothing here trusts the client's mention list** (spec MN-2/MN-3). The browser
 * sends structured target ids; this module decides which of them are real people
 * in the organization, which of them may legitimately be addressed on this
 * resource, and who — if anyone — the thread ends up waiting for. Everything the
 * caller stores on the message comes back out of {@link applyMessageMentions}.
 *
 * **The thread-level awaiting state is never stored.** It is `listOpenRequests…`
 * being non-empty, so the banner, the participant view and the recipient's inbox
 * cannot drift apart (ADR-0034 §2).
 */

import 'server-only'
import { ApiError, BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { filterUsersWithProjectAccess } from '@/lib/authz/project-membership'
import { PRODUCT_NAME } from '@/lib/brand'
import type { MentionRequest, ShareableResourceType } from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, resolveInboxItemsFor } from '@/lib/inbox/service'
import { requireResourceAccess, type ResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory, unknownPerson } from '@/lib/sharing/directory'
import { roleSatisfies } from '@/lib/sharing/registry'
import { consumeRateLimit, MAX_MENTIONS_PER_MESSAGE, MENTION_RATE_LIMIT } from '@/lib/sharing/rate-limit'
import { grantResourceAccess, resolveParticipants } from '@/lib/sharing/service'
import type { DirectoryPerson, ShareCandidate } from '@/lib/sharing/types'
import {
  findRequestById,
  insertMentionRequests,
  listOpenRequestsForResource,
  listOpenRequestsForSubject,
  resolveRequests,
  voidOpenRequestsForResource,
  voidOpenRequestsForSubject,
} from './repository'
import {
  AGENT_MENTION_ID,
  MENTION_ERROR_REASONS,
  type AddresseeSet,
  type AwaitingStateResponse,
  type MentionCandidate,
  type MentionCandidatesResponse,
  type MentionInput,
  type PendingMentionView,
} from './types'

/**
 * The resource types mentions are written on today. Deliberately narrower than
 * `ShareableResourceType`: the repository, the anchor column and every helper
 * below are already generic (spec MN-19), but until a second surface exists the
 * public signatures stay honest about what has actually been exercised.
 */
type MentionResourceType = 'conversation'

/**
 * Cap on the free text copied into an inbox payload. The note is user-controlled
 * and the payload is read back on every inbox render, so it is bounded here
 * rather than trusting the composer to be reasonable.
 */
const INBOX_TEXT_LIMIT = 280

/**
 * A 403 that carries a machine-readable reason.
 *
 * `ForbiddenError` takes no `details` (unlike `BadRequestError`/`ConflictError`),
 * and the composer must be able to tell "you hit the mention limit" apart from
 * "you may not post here" without parsing prose (spec MN-13). Subclassing keeps
 * `instanceof ForbiddenError` true for every existing handler while adding the
 * reason the UI localises from.
 */
class MentionRateLimitedError extends ForbiddenError {
  constructor(message: string) {
    super(message)
    // `ApiError.details` is a readonly constructor property, so it is attached
    // here rather than passed through a constructor that does not accept it.
    Object.assign(this, { details: { reason: MENTION_ERROR_REASONS.rateLimited } })
  }
}

/**
 * Void every open request against one person on one resource, in the SAME
 * operation that revokes their access (spec MN-9.4).
 *
 * Two things must happen together: the request stops holding the thread hostage
 * (it can never be answered by someone who cannot read it), and the recipient's
 * corresponding inbox item is resolved so it does not sit in their list forever
 * pointing at something they can no longer open.
 *
 * Session-less: the caller (`@/lib/sharing/service`) has already authorized the
 * revocation.
 */
export async function voidRequestsForSubject(
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
): Promise<number> {
  const voided = await voidOpenRequestsForSubject(resourceType, resourceId, subjectUserId)
  if (voided.length === 0) return 0

  // `anchor_id` is nullable and `mention.requested` groups per anchor, so mapping
  // blind would make `inboxGroupKey` throw on an anchor-less request. That throw
  // would escape into the middle of `revokeResourceAccess` — after the grant is
  // gone, but BEFORE the inbox payloads are wiped and before the revoked event is
  // published — leaving a quoted snippet alive for someone who just lost access
  // (spec IB-14). `requestedGroupKeys` skips those rows for exactly this reason.
  await resolveInboxItemsFor(
    requestedGroupKeys(voided),
    voided.map((request) => request.requestedOf),
  )
  return voided.length
}

/**
 * Void every open request on a resource — for a soft-delete, where no request can
 * still be meaningfully answered.
 */
export async function voidRequestsForResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  const voided = await voidOpenRequestsForResource(resourceType, resourceId)
  if (voided.length === 0) return 0

  // Anchor-less rows are skipped, not defaulted — see the note in
  // {@link voidRequestsForSubject}.
  await resolveInboxItemsFor(
    requestedGroupKeys(voided),
    voided.map((request) => request.requestedOf),
  )
  return voided.length
}

// ---------------------------------------------------------------------------
// Sending: addressee resolution + request creation (spec MN-1…MN-15)
// ---------------------------------------------------------------------------

export interface ApplyMessageMentionsInput {
  session: AuthorizedSession
  resourceType: MentionResourceType
  resourceId: string
  /** The anchor carrying the mentions — the message id, for a chat. */
  anchorId: string
  /** Client-supplied and therefore untrusted; validated here (spec MN-2). */
  mentions: MentionInput[]
  /** The asker's question, which becomes the inbox body (spec MN-12). */
  note?: string | null
  /** Short quote of the message, used when there is no explicit question. */
  excerpt?: string | null
}

export interface ApplyMessageMentionsResult {
  /** What the caller MUST store on the message (spec MN-2). */
  addressees: AddresseeSet
  createdRequests: number
  /**
   * The thread's derived awaiting set after this message, or `[]` when this
   * message changed nothing about the wait. Empty is therefore "nothing to
   * re-publish", not "nobody is awaited" — read the state back with
   * {@link getAwaitingState} if you need the authoritative answer.
   */
  awaitingUserIds: string[]
}

/**
 * Resolve a message's addressees, create the mention requests, notify the
 * recipients — the one place the hand-off begins.
 *
 * Called from the message-persist path, which has already authorized the write;
 * this function re-authorizes anyway (`collaborator` on the resource) because
 * mentioning is the operation that grants other people access, and a mistake
 * upstream must not turn into an invitation.
 *
 * Order of operations is deliberate and load-bearing:
 *   1. bound the request (spec MN-13) — before anything is written;
 *   2. classify every target and REFUSE the whole message if any target is
 *      illegitimate, so a refused mention never leaves a half-sent trail of
 *      grants and notifications;
 *   3. only then grant, insert and notify.
 */
export async function applyMessageMentions(
  input: ApplyMessageMentionsInput,
): Promise<ApplyMessageMentionsResult> {
  const { session, resourceType, resourceId, anchorId } = input

  // Deduplicate first: the composer can emit the same target twice (typed once,
  // re-picked once) and that must not cost two requests, two inbox items or two
  // units of rate-limit budget.
  const targets = [...new Set(input.mentions.map((mention) => mention.targetId).filter(Boolean))]
  const agentMentioned = targets.includes(AGENT_MENTION_ID)
  const humanTargets = targets.filter(
    // A self-mention is dropped rather than refused: it is a typo, and turning it
    // into a request would leave the thread waiting for the person who just wrote.
    (targetId) => targetId !== AGENT_MENTION_ID && targetId !== session.userId,
  )

  // The overwhelmingly common case: an ordinary message to the agent. No probe,
  // no query, no rate-limit write — the hot path must stay free.
  if (targets.length === 0) {
    return { addressees: { agent: true, users: [] }, createdRequests: 0, awaitingUserIds: [] }
  }

  await enforceMentionBounds(session, targets.length)

  // `collaborator` is the contribute threshold (spec SH-10). Denial is a 404,
  // indistinguishable from a conversation that does not exist (spec SH-6).
  const access = await requireResourceAccess(session, resourceType, resourceId, 'collaborator')

  const [directory, participants] = await Promise.all([
    loadOrganizationDirectory(session.organizationId),
    resolveParticipants(session.organizationId, resourceType, resourceId),
  ])
  const participantSet = new Set(participants)

  // Phase 1 — classify, and refuse before writing anything.
  const addressed: string[] = []
  const toInvite: string[] = []
  for (const targetId of humanTargets) {
    // Unresolvable ids are DROPPED, not refused (spec MN-3): a stale picker entry
    // or a deactivated colleague is not something to fail a message over, and an
    // id that resolves to nobody can neither be notified nor answer.
    if (!directory.has(targetId)) continue

    if (participantSet.has(targetId)) {
      addressed.push(targetId)
      continue
    }

    // A non-participant can only be addressed by an owner, who is thereby
    // inviting them (spec MN-5, OQ-3). A collaborator is refused explicitly —
    // silently dropping the mention would make the agent answer a message its
    // author addressed to a human.
    if (!roleSatisfies(access.role, 'owner')) {
      throw new BadRequestError(
        'You can only mention people who are already in this conversation. Ask an owner to invite them.',
        { reason: MENTION_ERROR_REASONS.inviteRequiresOwner, targetId },
      )
    }
    addressed.push(targetId)
    toInvite.push(targetId)
  }

  const addressees: AddresseeSet = {
    // MN-1, stated once: a human addressee silences the agent, and only an
    // explicit `@Piloti` brings it back. An empty addressee list falls back to
    // the agent so a message whose every mention was dropped still gets answered.
    agent: agentMentioned || addressed.length === 0,
    users: addressed,
  }

  // Phase 2 — write. Grants go first: `grantResourceAccess` is what enforces the
  // container precondition (spec MN-6/SH-5), so a mention of someone outside the
  // project must fail before any request row or notification exists.
  for (const targetId of toInvite) {
    await inviteMentionTarget(session, resourceType, resourceId, targetId)
  }

  // An explicit `@Piloti` clears an existing wait (spec MN-9.3): the thread is
  // being handed back to the agent on purpose. Captured BEFORE the new requests
  // are inserted, so tagging the agent and a colleague in one message does not
  // release the colleague we just started waiting for.
  const supersededByAgent = agentMentioned
    ? await releaseOpenRequests(await listOpenRequestsForResource(resourceType, resourceId), session.userId)
    : 0

  const created =
    addressed.length > 0
      ? await insertMentionRequests(
          addressed.map((requestedOf) => ({
            organizationId: session.organizationId,
            resourceType,
            resourceId,
            anchorId,
            requestedBy: session.userId,
            requestedOf,
            note: truncate(input.note),
          })),
        )
      : []

  if (created.length > 0) {
    await notifyMentionRecipients(session, resourceType, resourceId, anchorId, created, input)
  }

  if (created.length === 0 && supersededByAgent === 0) {
    return { addressees, createdRequests: 0, awaitingUserIds: [] }
  }

  const awaitingUserIds = await publishAwaiting(session.organizationId, resourceType, resourceId)
  return { addressees, createdRequests: created.length, awaitingUserIds }
}

/**
 * Bound one actor's mention volume (spec MN-13) — per message and per hour.
 *
 * Both bounds count TARGETS rather than messages, because the abuse being
 * prevented is mention-bombing: one message naming two hundred people is the
 * attack, and a per-message counter would not see it. The hourly budget is
 * consumed BEFORE any write, so a refused message costs its budget too — a loop
 * that keeps failing must still run out.
 *
 * `@Piloti` counts against the budget like a person. It is an abuse bound, not
 * accounting (see `@/lib/sharing/rate-limit`), and erring toward more limiting is
 * the deliberate direction.
 */
async function enforceMentionBounds(session: AuthorizedSession, count: number): Promise<void> {
  if (count > MAX_MENTIONS_PER_MESSAGE) {
    throw new MentionRateLimitedError(
      `A message may mention at most ${MAX_MENTIONS_PER_MESSAGE} people.`,
    )
  }

  const limit = await consumeRateLimit(MENTION_RATE_LIMIT, session.userId, count)
  if (!limit.allowed) {
    throw new MentionRateLimitedError('Too many mentions. Please wait a while before mentioning more people.')
  }
}

/**
 * Invite a mentioned non-participant as `collaborator` (spec MN-5).
 *
 * The container check lives in `grantResourceAccess`, not here: duplicating it
 * would give two places to keep in agreement, and the refusal we need to surface
 * is exactly the one it already produces. We only re-label it with the mention
 * vocabulary and the target it was about, so the composer can say *which* name it
 * is complaining about (spec MN-6).
 */
async function inviteMentionTarget(
  session: AuthorizedSession,
  resourceType: MentionResourceType,
  resourceId: string,
  targetId: string,
): Promise<void> {
  try {
    await grantResourceAccess(session, resourceType, resourceId, {
      subjectUserId: targetId,
      role: 'collaborator',
    })
  } catch (error) {
    const reason = errorReason(error)
    if (reason === MENTION_ERROR_REASONS.containerAccessRequired) {
      throw new BadRequestError(
        'That person cannot see this project yet. Add them to the project first — mentioning someone is never a back door into it.',
        { reason: MENTION_ERROR_REASONS.containerAccessRequired, targetId },
      )
    }
    throw error
  }
}

/** The machine-readable `reason` an `ApiError` carries, when it carries one. */
function errorReason(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  const details = error.details
  if (!details || typeof details !== 'object') return null
  const reason = (details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : null
}

/**
 * One actionable inbox item per mentioned person (spec MN-14, MN-15).
 *
 * It must reach them whether or not they have ever opened the thread, which is
 * why this is a stored item rather than an event on the chat socket: the socket
 * only exists for someone who has the conversation open.
 */
async function notifyMentionRecipients(
  session: AuthorizedSession,
  resourceType: MentionResourceType,
  resourceId: string,
  anchorId: string,
  created: MentionRequest[],
  input: Pick<ApplyMessageMentionsInput, 'note' | 'excerpt'>,
): Promise<void> {
  const subject = await resolveSubjectLine(resourceType, resourceId, session.organizationId)
  // The question beats the quote: "is this the right assumption about the
  // atrium?" is actionable, "you were mentioned" is not (spec MN-12).
  const excerpt = truncate(input.note ?? input.excerpt)

  await emitInboxItems(
    created.map((request) => ({
      organizationId: session.organizationId,
      recipientUserId: request.requestedOf,
      type: 'mention.requested' as const,
      resourceType,
      resourceId,
      anchorId,
      actorUserId: session.userId,
      groupKey: inboxGroupKey('mention.requested', resourceType, resourceId, anchorId),
      payload: { subject, excerpt },
    })),
  )
}

// ---------------------------------------------------------------------------
// Resolution: the wait clears (spec MN-9, MN-16, MN-18)
// ---------------------------------------------------------------------------

export interface ResolveRequestsOnReplyInput {
  organizationId: string
  resourceType: MentionResourceType
  resourceId: string
  /** Whoever just contributed. */
  authorUserId: string
}

/**
 * Close the requests this author was asked to answer, because they just
 * contributed (spec MN-9.1).
 *
 * Session-less by design: the caller is the message-persist path, which has
 * already authorized the write, and resolution must also work for a contribution
 * that arrives on the internal path.
 *
 * Returns the askers so they can be told their request was answered (spec MN-18)
 * — waiting for a colleague must not be a polling exercise.
 */
export async function resolveRequestsOnReply(
  input: ResolveRequestsOnReplyInput,
): Promise<{ answered: number; askerUserIds: string[] }> {
  const { organizationId, resourceType, resourceId, authorUserId } = input

  // Only the author's OWN open requests: someone else's outstanding request is
  // not answered by a third party writing something (spec MN-10 — each person's
  // request resolves independently).
  const open = await listOpenRequestsForSubject(resourceType, resourceId, authorUserId)
  if (open.length === 0) return { answered: 0, askerUserIds: [] }

  const closed = await resolveRequests(
    open.map((request) => request.id),
    'answered',
    authorUserId,
  )
  if (closed.length === 0) return { answered: 0, askerUserIds: [] }

  // The recipient never has to tidy up for the inbox to stay accurate (MN-16).
  await resolveInboxItemsFor(requestedGroupKeys(closed), [authorUserId])

  const askerUserIds = [...new Set(closed.map((request) => request.requestedBy))]
  const subject = await resolveSubjectLine(resourceType, resourceId, organizationId)
  await emitInboxItems(
    closed.map((request) => ({
      organizationId,
      recipientUserId: request.requestedBy,
      type: 'mention.answered' as const,
      resourceType,
      resourceId,
      anchorId: request.anchorId,
      actorUserId: authorUserId,
      groupKey: answeredGroupKey(request),
      payload: { subject, excerpt: request.note },
    })),
  )

  await publishAwaiting(organizationId, resourceType, resourceId)
  return { answered: closed.length, askerUserIds }
}

/**
 * Continue without the person we are waiting for (spec MN-9.2).
 *
 * Any contributor may release — not just the asker and not just an owner. An
 * abandoned wait is the failure mode ADR-0034 calls out, and the mitigation is
 * that getting out of it is always available to whoever is in the room.
 */
export async function releaseRequest(
  session: AuthorizedSession,
  requestId: string,
): Promise<AwaitingStateResponse> {
  const request = await findRequestById(requestId)
  // Tenancy before anything else, and a 404 either way: a request id from another
  // organization must be indistinguishable from one that does not exist.
  if (!request || request.organizationId !== session.organizationId) throw new NotFoundError()

  const resourceType = request.resourceType as MentionResourceType
  await requireResourceAccess(session, resourceType, request.resourceId, 'collaborator')

  // A no-op when the request already settled: `resolveRequests` only touches
  // `open` rows, so a double-click cannot rewrite a resolution.
  const released = await releaseOpenRequests([request], session.userId)
  if (released > 0) {
    await publishAwaiting(session.organizationId, resourceType, request.resourceId)
  }

  return buildAwaitingState(session, resourceType, request.resourceId)
}

/**
 * Close requests as `released` and resolve the corresponding inbox items.
 * Shared by the explicit release and by the `@Piloti` hand-back.
 */
async function releaseOpenRequests(requests: MentionRequest[], resolvedBy: string): Promise<number> {
  if (requests.length === 0) return 0
  const closed = await resolveRequests(
    requests.map((request) => request.id),
    'released',
    resolvedBy,
  )
  if (closed.length === 0) return 0
  await resolveInboxItemsFor(
    requestedGroupKeys(closed),
    closed.map((request) => request.requestedOf),
  )
  return closed.length
}

// ---------------------------------------------------------------------------
// Reading: the awaiting banner and the `@` picker
// ---------------------------------------------------------------------------

/**
 * The derived hand-off state of a conversation (spec MN-8).
 *
 * Requires `viewer`: everyone who can read the thread is entitled to know why it
 * is quiet. The silence must never be unexplained.
 */
export async function getAwaitingState(
  session: AuthorizedSession,
  conversationId: string,
): Promise<AwaitingStateResponse> {
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
  return buildAwaitingState(session, 'conversation', conversationId)
}

/**
 * Render the derived state. Authorization is the CALLER's job — every entry point
 * above has already established at least `viewer` on the resource.
 */
async function buildAwaitingState(
  session: AuthorizedSession,
  resourceType: MentionResourceType,
  resourceId: string,
): Promise<AwaitingStateResponse> {
  const open = await listOpenRequestsForResource(resourceType, resourceId)
  if (open.length === 0) return { pending: [], awaitingMe: false }

  const directory = await loadOrganizationDirectory(session.organizationId)
  const pending: PendingMentionView[] = open.map((request) => ({
    id: request.id,
    person: directory.get(request.requestedOf) ?? unknownPerson(request.requestedOf),
    requestedBy: directory.get(request.requestedBy) ?? null,
    note: request.note,
    anchorId: request.anchorId,
    createdAt: request.createdAt.toISOString(),
  }))

  return {
    pending,
    awaitingMe: open.some((request) => request.requestedOf === session.userId),
  }
}

/**
 * Candidates for the `@` picker (spec MN-4, SH-19).
 *
 * Requires `collaborator`: the picker exists to compose a contribution, and a
 * viewer has no composer. Three groups come back, and the difference matters:
 *   - the **agent**, always offered, never needing an invitation;
 *   - **participants**, who can simply be tagged;
 *   - **org members who can reach the project**, who can only be tagged by an
 *     owner (`needsInvite`), because tagging them invites them.
 *
 * People who cannot reach the container project are absent entirely — mentioning
 * them is impossible (spec MN-6), and offering a name that can only ever be
 * refused reads as a bug. The share dialog *does* list them, disabled with the
 * reason, because there the actor can do something about it.
 */
export async function listMentionCandidates(
  session: AuthorizedSession,
  conversationId: string,
): Promise<MentionCandidatesResponse> {
  const roster = await loadCandidateRoster(session, 'conversation', conversationId, 'collaborator')
  const canInvite = roleSatisfies(roster.access.role, 'owner')

  const candidates: MentionCandidate[] = [
    {
      targetId: AGENT_MENTION_ID,
      person: {
        userId: AGENT_MENTION_ID,
        email: null,
        name: PRODUCT_NAME,
        profilePictureUrl: null,
      },
      isAgent: true,
      // The agent is always in the room, so it is a participant in the only sense
      // the picker cares about: tagging it requires nothing.
      isParticipant: true,
      needsInvite: false,
    },
  ]

  for (const person of roster.people) {
    candidates.push({
      targetId: person.userId,
      person,
      isAgent: false,
      isParticipant: roster.participants.has(person.userId),
      needsInvite: !roster.participants.has(person.userId),
    })
  }

  return { candidates, canInvite }
}

/**
 * Candidates for the share dialog's invite picker (spec SH-19).
 *
 * Same question as the mention picker — "who may be added to this resource" — so
 * it shares the roster resolution. Two deliberate differences: the agent is not a
 * grantee, and people who cannot reach the container project ARE listed, flagged
 * `needsProjectAccess`, because SH-19 requires the block to be explicable and an
 * owner may be entitled to fix it by adding them to the project first.
 *
 * Requires `owner`: the list exists in order to invite.
 *
 * Lives in this module rather than `@/lib/sharing/service` because it is the same
 * computation as {@link listMentionCandidates}; if a third consumer appears it
 * should move down into the sharing domain.
 */
export async function listShareCandidates(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<ShareCandidate[]> {
  const roster = await loadCandidateRoster(session, resourceType, resourceId, 'owner', {
    includeUnreachable: true,
  })

  return roster.people.map((person) => ({
    person,
    alreadyHasAccess: roster.participants.has(person.userId),
    needsProjectAccess: !roster.reachable.has(person.userId),
  }))
}

interface CandidateRoster {
  access: ResourceAccess
  /** Directory people, participants first, then alphabetically. */
  people: DirectoryPerson[]
  /** Creator + explicit grant holders — the people already in the room. */
  participants: Set<string>
  /** People who satisfy the container precondition (spec SH-5). */
  reachable: Set<string>
}

/**
 * The shared roster behind both pickers.
 *
 * "Participant" is deliberately *creator + grant holders*, not "everyone who can
 * read it": under `project` visibility the latter is the whole project, and
 * access is not subscription (spec OQ-9). That is why mentioning a project member
 * who holds no grant still goes through the invite path — the grant is what makes
 * notifications reach them.
 */
async function loadCandidateRoster(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  minimum: 'collaborator' | 'owner',
  options: { includeUnreachable?: boolean } = {},
): Promise<CandidateRoster> {
  const access = await requireResourceAccess(session, resourceType, resourceId, minimum)
  const [directory, participants] = await Promise.all([
    loadOrganizationDirectory(session.organizationId),
    resolveParticipants(session.organizationId, resourceType, resourceId),
  ])

  const participantSet = new Set(participants)
  // Never offer the caller themselves: you cannot invite or await yourself.
  const others = [...directory.values()].filter((person) => person.userId !== session.userId)

  const projectId = access.container.projectId
  const reachable = projectId
    ? await filterUsersWithProjectAccess(
        session,
        projectId,
        others.map((person) => person.userId),
      )
    // No container to gate on (a legacy organization-level conversation): every
    // member of the organization satisfies the precondition by definition.
    : new Set(others.map((person) => person.userId))

  // A participant is reachable by construction — they hold a grant, which the
  // container check already gated when it was issued. Keeping them in the set
  // means a stale FGA read cannot make an existing participant look invalid.
  for (const userId of participantSet) reachable.add(userId)

  const visible = options.includeUnreachable
    ? others
    : others.filter((person) => reachable.has(person.userId))

  visible.sort((a, b) => {
    const aParticipant = participantSet.has(a.userId) ? 0 : 1
    const bParticipant = participantSet.has(b.userId) ? 0 : 1
    if (aParticipant !== bParticipant) return aParticipant - bParticipant
    return a.name.localeCompare(b.name)
  })

  return { access, people: visible, participants: participantSet, reachable }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Publish the derived awaiting set to the resource's participants (spec RT-3).
 *
 * Called whenever the set may have changed, and returns it so the caller can hand
 * it back to its own client. The event is a hint only — every receiver re-reads
 * `GET …/awaiting`, so a dropped publish costs latency and nothing else.
 */
async function publishAwaiting(
  organizationId: string,
  resourceType: MentionResourceType,
  resourceId: string,
): Promise<string[]> {
  const open = await listOpenRequestsForResource(resourceType, resourceId)
  const awaitingUserIds = [...new Set(open.map((request) => request.requestedOf))]
  const participants = await resolveParticipants(organizationId, resourceType, resourceId)
  await publishToUsers([...participants, ...awaitingUserIds], {
    kind: 'conversation.awaiting',
    conversationId: resourceId,
    awaitingUserIds,
  })
  return awaitingUserIds
}

/**
 * Group keys of the `mention.requested` items belonging to these requests.
 *
 * Anchor-less requests are skipped rather than defaulted: `mention.requested`
 * groups per anchor, so there is no item to resolve for a request that never had
 * one, and `inboxGroupKey` would (correctly) throw.
 */
function requestedGroupKeys(requests: MentionRequest[]): string[] {
  return requests
    .filter((request) => request.anchorId)
    .map((request) =>
      inboxGroupKey('mention.requested', request.resourceType, request.resourceId, request.anchorId),
    )
}

/**
 * Group key for the asker's "answered" item. Falls back to the request id when
 * the request carries no anchor, so one asker awaiting two people gets two
 * distinct notifications instead of one that overwrites the other.
 */
function answeredGroupKey(request: MentionRequest): string {
  return inboxGroupKey(
    'mention.answered',
    request.resourceType,
    request.resourceId,
    request.anchorId ?? request.id,
  )
}

/**
 * The resource's one-line title, for the inbox item's context line.
 *
 * Dynamically imported per type, mirroring `applyVisibility` in
 * `@/lib/sharing/service`: the notification is generic, only the lookup is
 * domain-specific, and a static import would make this module depend on every
 * shareable domain at once.
 */
async function resolveSubjectLine(
  resourceType: MentionResourceType,
  resourceId: string,
  organizationId: string,
): Promise<string | null> {
  switch (resourceType) {
    case 'conversation': {
      const { findConversationInOrg } = await import('@/lib/conversations/repository')
      const row = await findConversationInOrg(resourceId, organizationId)
      return row?.title ?? null
    }
  }
}

/** Bound user-controlled text before it is stored or copied into a payload. */
function truncate(text: string | null | undefined): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > INBOX_TEXT_LIMIT ? `${trimmed.slice(0, INBOX_TEXT_LIMIT - 1)}…` : trimmed
}

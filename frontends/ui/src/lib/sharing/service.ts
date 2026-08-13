/**
 * Sharing service — visibility changes, grants, the roster, and the participant
 * set (ADR-0032, spec SH-1…SH-20).
 *
 * Owns authorization: every mutation requires `owner` on the resource, every
 * read requires at least `viewer`, and both go through
 * `@/lib/sharing/access`. Route handlers stay thin.
 *
 * Invariants enforced here, each with a test:
 *   - a person cannot be granted access to a resource whose CONTAINER they
 *     cannot reach (spec SH-5) — sharing is never a back door into a project;
 *   - a resource always keeps at least one owner (spec SH-11);
 *   - only visibilities the registry permits for the type can be set (spec SH-2);
 *   - every mutation is audited (spec SH-14), with self-escalation by a project
 *     admin distinguishable from a normal grant (spec SH-10).
 */

import 'server-only'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { ResourceRole, ResourceVisibility, ShareableResourceType } from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import { resolveResourceAccess, requireResourceAccess } from './access'
import { loadOrganizationDirectory, unknownPerson } from './directory'
import { describeResource, roleSatisfies } from './registry'
import { consumeLimit, memberSubject, SHARE_LIMIT } from '@/lib/limits'
import {
  countGrantsForResource,
  deleteGrant,
  listGrantsForResource,
  upsertGrant,
  SHARE_ROSTER_LIMIT,
} from './repository'
import { SHARING_ERROR_REASONS, type ResourceAccessEntry, type ResourceSharingState } from './types'

export type { ResourceAccessEntry, ResourceSharingState }

/**
 * Read a resource's sharing state. Requires `viewer` — a participant is entitled
 * to know who else is in the room, which is also what the participant strip
 * renders.
 */
export async function getSharingState(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<ResourceSharingState> {
  const access = await requireResourceAccess(session, resourceType, resourceId, 'viewer')
  const descriptor = describeResource(resourceType)
  const probe = await descriptor.probe(resourceId)
  const grants = await listGrantsForResource(session.organizationId, resourceType, resourceId)
  const directory = await loadOrganizationDirectory(session.organizationId)

  const entries: ResourceAccessEntry[] = []

  // The creator is always an owner, and is listed first so the roster reads
  // "whose thread is this" at a glance.
  if (probe?.createdBy) {
    entries.push({
      person: directory.get(probe.createdBy) ?? unknownPerson(probe.createdBy),
      role: 'owner',
      reason: 'creator',
      grantedBy: null,
    })
  }

  for (const grant of grants) {
    if (grant.subjectUserId === probe?.createdBy) continue // already listed as creator
    entries.push({
      person: directory.get(grant.subjectUserId) ?? unknownPerson(grant.subjectUserId),
      role: grant.role,
      reason: 'grant',
      grantedBy: grant.grantedBy,
    })
  }

  return {
    resourceType,
    resourceId,
    visibility: access.visibility,
    allowedVisibilities: descriptor.allowedVisibilities,
    myRole: access.role,
    canManage: roleSatisfies(access.role, 'owner'),
    canEscalate: access.canEscalate,
    entries,
    shared: access.visibility !== 'private' || grants.length > 0,
  }
}

/**
 * Change a resource's blanket visibility (spec SH-2, SH-13).
 *
 * Narrowing is the interesting direction: everyone who only had project-derived
 * access loses it immediately, which is why the change is announced to the
 * previous participant set — losing sight of a thread must not be silent.
 */
export async function setResourceVisibility(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  visibility: ResourceVisibility,
  request?: Request,
): Promise<ResourceSharingState> {
  const access = await requireResourceAccess(session, resourceType, resourceId, 'owner')
  const descriptor = describeResource(resourceType)

  if (!descriptor.allowedVisibilities.includes(visibility)) {
    throw new BadRequestError(`Visibility "${visibility}" is not available for this resource`, {
      allowed: descriptor.allowedVisibilities,
    })
  }

  if (visibility === access.visibility) {
    // No-op saves must not produce an audit entry or an event storm.
    return getSharingState(session, resourceType, resourceId)
  }

  // Capture who could see it BEFORE the change, so a narrowing can tell the
  // people who are about to lose it.
  const previousAudience = await resolveParticipants(session.organizationId, resourceType, resourceId)

  const written = await descriptor.setVisibility(resourceId, session.organizationId, visibility)
  if (!written) throw new NotFoundError()

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'resource.visibility.changed',
    targetType: resourceType,
    targetId: resourceId,
    metadata: { from: access.visibility, to: visibility },
    request,
  })

  const nextAudience = await resolveParticipants(session.organizationId, resourceType, resourceId)
  await publishToUsers([...new Set([...previousAudience, ...nextAudience])], {
    kind: 'resource.access.changed',
    resourceType,
    resourceId,
    change: 'visibility',
  })

  return getSharingState(session, resourceType, resourceId)
}

export interface GrantAccessInput {
  subjectUserId: string
  role: ResourceRole
}

/**
 * Grant (or re-grant) a person access (spec SH-3, SH-5, SH-16).
 *
 * The container check is the security-critical part: the invitee must ALREADY be
 * able to reach the resource's container. Inviting someone who cannot is refused
 * with an explanation, and never accompanied by a silent container grant.
 */
export async function grantResourceAccess(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  input: GrantAccessInput,
  request?: Request,
): Promise<ResourceSharingState> {
  const access = await requireResourceAccess(session, resourceType, resourceId, 'owner')

  if (input.subjectUserId === session.userId) {
    throw new BadRequestError('You already have access to this resource')
  }

  const descriptor = describeResource(resourceType)
  if (!descriptor.roles.includes(input.role)) {
    throw new BadRequestError(`Role "${input.role}" is not available for this resource`)
  }

  // Rate limit BEFORE any write (spec SH-16, NF-5).
  const limit = await consumeLimit(SHARE_LIMIT, memberSubject(session))
  if (!limit.allowed) {
    throw new ForbiddenError('Too many sharing changes. Please wait a few minutes and try again.', {
      reason: SHARING_ERROR_REASONS.rateLimited,
    })
  }

  // Roster cap — a "share with everyone" action is not a feature (spec SH-16).
  const existing = await countGrantsForResource(resourceType, resourceId)
  if (existing >= SHARE_ROSTER_LIMIT) {
    throw new ConflictError(`This resource already has the maximum of ${SHARE_ROSTER_LIMIT} people.`, {
      reason: SHARING_ERROR_REASONS.rosterFull,
    })
  }

  await assertInviteeCanReachContainer(session, resourceType, resourceId, input.subjectUserId)

  await upsertGrant({
    organizationId: session.organizationId,
    resourceType,
    resourceId,
    subjectUserId: input.subjectUserId,
    role: input.role,
    grantedBy: session.userId,
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'resource.shared',
    targetType: resourceType,
    targetId: resourceId,
    metadata: { subject: input.subjectUserId, role: input.role, visibility: access.visibility },
    request,
  })

  await publishToUsers([input.subjectUserId], {
    kind: 'resource.access.changed',
    resourceType,
    resourceId,
    change: 'granted',
  })

  return getSharingState(session, resourceType, resourceId)
}

/**
 * The invitee preconditions (spec SH-5), stated as their own function because
 * they are the rules most likely to be forgotten by a future caller.
 *
 * **Two of them, and the second one is easy to lose.**
 *
 *   1. Same organization. Always. There is no shape of resource for which a grant
 *      may name a stranger: a grant row for a foreign user id is unreachable
 *      nonsense on the read path, but `publishToUsers` would still write to that
 *      foreign user's event channel, and the roster would claim they have access.
 *   2. The container, when there IS one. A person who cannot reach the container
 *      must not receive a grant, because the grant would be inert at best (access
 *      resolution gates on the container anyway) and misleading at worst.
 *
 * Rule 2 subsumes rule 1 — `canUserAccessProject` fails closed on a subject with
 * no membership in the caller's organization — which is exactly why the
 * no-container path has to state rule 1 for itself instead of returning early.
 */
async function assertInviteeCanReachContainer(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
): Promise<void> {
  const descriptor = describeResource(resourceType)
  const probe = await descriptor.probe(resourceId)
  if (!probe) throw new NotFoundError()

  const { canUserAccessProject, isUserInOrganization } = await import(
    '@/lib/authz/project-membership'
  )

  if (!probe.projectId) {
    // No container to gate on (a legacy organization-level resource), so the
    // organization membership IS the whole precondition — and it is checked here
    // rather than deferred to "tenancy is checked when they read it", because a
    // grant and a published event are written before anyone reads anything.
    if (!(await isUserInOrganization(session, subjectUserId))) {
      throw new BadRequestError(
        'That person is not a member of this organization.',
        { reason: SHARING_ERROR_REASONS.organizationMembershipRequired },
      )
    }
    return
  }

  const reachable = await canUserAccessProject(session, probe.projectId, subjectUserId)
  if (!reachable) {
    throw new BadRequestError(
      'That person is not a member of this project yet. Add them to the project first — sharing a resource never grants project access.',
      { reason: SHARING_ERROR_REASONS.containerAccessRequired, projectId: probe.projectId },
    )
  }
}

/**
 * Change an existing person's role, enforcing the last-owner invariant
 * (spec SH-11).
 *
 * "Existing" is a precondition, not a description: `upsertGrant` is
 * create-or-update, so without the check below a `role_changed` call naming an
 * arbitrary user id would be a second, unchecked GRANT path — one that skips
 * every invitee precondition `grantResourceAccess` enforces (the container check
 * of spec SH-5, organization membership, the roster cap, the rate limit) and
 * publishes no `resource.access.changed`, so the subject would gain access their
 * clients never hear about. Access is only ever created by
 * `grantResourceAccess`.
 */
export async function changeResourceRole(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  input: GrantAccessInput,
  request?: Request,
): Promise<ResourceSharingState> {
  await requireResourceAccess(session, resourceType, resourceId, 'owner')

  // Party to the resource by grant, or by having created it — the creator's
  // ownership is not a grant row, yet the roster offers their role like any
  // other (a no-op in effect, since resolution always re-adds `owner`).
  const grants = await listGrantsForResource(session.organizationId, resourceType, resourceId)
  const currentRole = grants.find((grant) => grant.subjectUserId === input.subjectUserId)?.role
  if (!currentRole) {
    const probe = await describeResource(resourceType).probe(resourceId)
    if (probe?.createdBy !== input.subjectUserId) throw new NotFoundError()
  }

  // Already what was asked for. Returning here keeps a repeated click out of the
  // audit log and off the subject's event channel: a no-op is not a change, and a
  // change is what both of those record.
  if (currentRole === input.role) {
    return getSharingState(session, resourceType, resourceId)
  }

  await assertNotLastOwner(session, resourceType, resourceId, input.subjectUserId, input.role === 'owner')

  await upsertGrant({
    organizationId: session.organizationId,
    resourceType,
    resourceId,
    subjectUserId: input.subjectUserId,
    role: input.role,
    grantedBy: session.userId,
  })

  // Downgrading to `viewer` removes the ability to CONTRIBUTE, so any request
  // waiting on this person can no longer be answered by them — the thread would
  // wait forever on someone the product has just silenced. Void it, exactly as a
  // revocation does (spec MN-9.4). Upgrades need no cleanup.
  if (input.role === 'viewer') {
    const { voidRequestsForSubject } = await import('@/lib/mentions/service')
    await voidRequestsForSubject(resourceType, resourceId, input.subjectUserId)
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'resource.share.role_changed',
    targetType: resourceType,
    targetId: resourceId,
    metadata: { subject: input.subjectUserId, from: currentRole ?? null, role: input.role },
    request,
  })

  // The subject's own clients have to learn. A downgrade to `viewer` takes the
  // composer away, and a UI that only finds out on its next full reload lets
  // somebody keep typing into a thread they may no longer contribute to — and lets
  // an upgrade go unnoticed until then too. `role_changed` rather than `granted`
  // because they already had access; what changed is what they may DO.
  await publishToUsers([input.subjectUserId], {
    kind: 'resource.access.changed',
    resourceType,
    resourceId,
    change: 'role_changed',
  })

  return getSharingState(session, resourceType, resourceId)
}

/**
 * Revoke a person's grant (spec SH-13). Access ends immediately; the event tells
 * their open sessions to drop the resource from view rather than leaving a stale
 * thread on screen.
 */
export async function revokeResourceAccess(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
  request?: Request,
): Promise<ResourceSharingState> {
  // Leaving your own share needs no ownership; removing someone else does.
  const isSelfRemoval = subjectUserId === session.userId
  await requireResourceAccess(session, resourceType, resourceId, isSelfRemoval ? 'viewer' : 'owner')
  await assertNotLastOwner(session, resourceType, resourceId, subjectUserId, false)

  const removed = await deleteGrant(session.organizationId, resourceType, resourceId, subjectUserId)
  if (!removed) throw new NotFoundError()

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'resource.share.revoked',
    targetType: resourceType,
    targetId: resourceId,
    metadata: { subject: subjectUserId, self: isSelfRemoval },
    request,
  })

  // Void any outstanding request against them, and neutralise their inbox items
  // for this resource — an inbox must never be a loophole for revoked access
  // (spec IB-14, MN-9).
  const { voidRequestsForSubject } = await import('@/lib/mentions/service')
  await voidRequestsForSubject(resourceType, resourceId, subjectUserId)
  const { markItemsInertForSubject } = await import('@/lib/inbox/service')
  await markItemsInertForSubject(resourceType, resourceId, subjectUserId)

  await publishToUsers([subjectUserId], {
    kind: 'resource.access.changed',
    resourceType,
    resourceId,
    change: 'revoked',
  })

  // Self-removal means the caller can no longer read the state they just changed.
  if (isSelfRemoval) {
    return {
      resourceType,
      resourceId,
      visibility: 'private',
      allowedVisibilities: describeResource(resourceType).allowedVisibilities,
      myRole: null,
      canManage: false,
      canEscalate: false,
      entries: [],
      shared: false,
    }
  }
  return getSharingState(session, resourceType, resourceId)
}

/**
 * A resource must never be left with zero owners and no in-app way to recover
 * (spec SH-11). Mirrors the project last-admin invariant, including the
 * machine-readable reason so the UI can localise the block.
 *
 * The creator counts as an owner and cannot be stripped of it, so the invariant
 * can only be violated by demoting/removing an explicit owner grant on a
 * resource whose creator is gone.
 */
async function assertNotLastOwner(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  targetUserId: string,
  willRemainOwner: boolean,
): Promise<void> {
  if (willRemainOwner) return

  const descriptor = describeResource(resourceType)
  const probe = await descriptor.probe(resourceId)
  // The creator is an immovable owner; while they exist the invariant holds.
  if (probe?.createdBy && probe.createdBy !== targetUserId) return

  const grants = await listGrantsForResource(session.organizationId, resourceType, resourceId)
  const owners = grants.filter((grant) => grant.role === 'owner').map((grant) => grant.subjectUserId)
  const remaining = owners.filter((userId) => userId !== targetUserId)
  if (remaining.length === 0) {
    throw new ConflictError(
      'This resource must keep at least one owner. Make someone else an owner before removing this one.',
      { reason: 'last-owner' },
    )
  }
}

/**
 * A project admin takes ownership of a resource in their project (spec SH-10).
 *
 * Deliberately an explicit, audited action rather than an implicit right: if
 * project admins silently owned every private thread in the project, `private`
 * would be a lie. This gives them the operational capability without the
 * dishonesty, and leaves a trail distinguishable from a normal grant.
 */
export async function escalateToOwner(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  request?: Request,
): Promise<ResourceSharingState> {
  const access = await resolveResourceAccess(session, resourceType, resourceId)
  if (!access.canEscalate) {
    throw new NotFoundError()
  }

  await upsertGrant({
    organizationId: session.organizationId,
    resourceType,
    resourceId,
    subjectUserId: session.userId,
    role: 'owner',
    grantedBy: session.userId,
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'resource.ownership.escalated',
    targetType: resourceType,
    targetId: resourceId,
    // The distinguishing marker: this was a project admin taking ownership of
    // something they were not previously party to.
    metadata: { previousRole: access.role ?? 'none', via: 'project-admin' },
    request,
  })

  // Every other mutation in this module publishes; this one did not, so an owner
  // watching the same thread kept seeing a roster without the new owner in it
  // until a focus event or the disconnected poll came round a minute later.
  //
  // Best-effort, like the conversation fan-out: the grant and its audit record
  // are already committed by the time we get here, and the participant lookup
  // this needs is two further reads that are no part of them. Letting either
  // throw answered 500 for an escalation that had in fact succeeded, so the
  // admin retried an act already in the audit log. Live delivery is latency, not
  // mechanism — the roster is one plain fetch away either way.
  try {
    await publishToUsers(
      await resolveParticipants(session.organizationId, resourceType, resourceId),
      { kind: 'resource.access.changed', resourceType, resourceId, change: 'granted' },
    )
  } catch (error) {
    console.warn('[sharing] escalation fan-out failed (non-fatal):', error)
  }

  return getSharingState(session, resourceType, resourceId)
}

/**
 * Everyone who should receive live updates and notifications about a resource.
 *
 * This is the participant set used for fan-out, and it is deliberately NOT
 * "everyone who can read it": under `project` visibility that would be the whole
 * project, and access is not subscription (spec OQ-9/CC-20). It is the creator
 * plus everyone holding an explicit grant — the people who were invited, or who
 * chose to be involved.
 *
 * Session-less on purpose: notification fan-out runs from paths that have already
 * authorized (a message persist, a mention) and needs the audience, not a check.
 */
export async function resolveParticipants(
  organizationId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<string[]> {
  const descriptor = describeResource(resourceType)
  const [probe, grants] = await Promise.all([
    descriptor.probe(resourceId),
    listGrantsForResource(organizationId, resourceType, resourceId),
  ])
  const participants = new Set<string>()
  if (probe?.createdBy) participants.add(probe.createdBy)
  for (const grant of grants) participants.add(grant.subjectUserId)
  return [...participants]
}

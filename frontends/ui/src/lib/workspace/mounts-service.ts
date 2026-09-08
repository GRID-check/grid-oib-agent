/**
 * Mounting a project into a Büro conversation — the ONE place the permission is
 * checked and the ONE place the cap is enforced (ADR-0054, spec MT-1…MT-16).
 *
 * Two adapters reach this service and they must not be able to diverge: the
 * session route a person's scope tree calls, and the internal twin the agent's
 * `open_project` tool calls. MT-2 says both go through one endpoint precisely so
 * there is one permission check; the internal twin therefore authorizes **as
 * the user the turn runs for**, reconstructed from the signed envelope's
 * identity, and never as the service. A service-token endpoint that mounted on
 * its own authority would be a prompt-injection primitive: "read project X"
 * would become a read.
 *
 * ## The order of the checks, and why it is this order
 *
 *  1. The CONVERSATION, `collaborator`. Mounting changes what a thread reads
 *     from here on; that is contributing to it, not looking at it.
 *  2. The PROJECT, `project:chat` — the same permission the project scope
 *     builder demands, because a mount is exactly "let this turn retrieve from
 *     that project". A reader gets a project's documents through the documents
 *     API; they do not get the agent pointed at them.
 *  3. The CAP, here and nowhere else (`maxMountedProjects()`).
 *  4. The PARTICIPANTS, when the mount is new: a shared thread may not gain a
 *     project that would shut somebody already in it out of it (spec AC-8).
 *  5. The row, idempotent on the unique index.
 *  6. The grant, minted fresh on every answer.
 *
 * ## Refusals say as little as possible
 *
 * A caller who cannot see the project at all gets `NotFoundError` — MT-4: a
 * refusal must be indistinguishable from the project not existing, and the
 * agent must not be able to learn that a project it may not read exists. A
 * caller who CAN see it (`project:view`) but may not chat in it gets
 * `ForbiddenError`: they already know it exists, so 404 would only be a lie
 * that costs them the reason.
 */

import 'server-only'
import { ApiError, BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { resolveMembershipRole } from '@/lib/authz/membership-role'
import { requireProjectAccess } from '@/lib/authz/projects'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { requireResourceAccess } from '@/lib/sharing/access'
import { resolveParticipants } from '@/lib/sharing/service'
import { resolvePeople, unknownPerson } from '@/lib/sharing/directory'
import { createConversation } from '@/lib/conversations/service'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { usersExcludedByProject } from './conversation-sharing'
import { projectSetForMount } from './project-sets-service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MountActor } from '@/lib/db/schema'
import { maxMountedProjects } from './config'
import { mintMountGrant, type WireGrant } from './grant'
import {
  deleteConversationMount,
  insertConversationMount,
  listConversationMounts,
  type MountRow,
} from './mounts-repository'

/** One mounted project, as the wire carries it (ADR-0054 §1). */
export interface Mount {
  projectId: string
  projectName: string
  mountedBy: MountActor
  /** ISO-8601 instant. */
  mountedAt: string
}

/** What `POST …/mounts` answers with. */
export interface MountResult {
  mount: Mount
  grant: WireGrant
  /**
   * Whether this call created the row. `false` is the idempotent re-mount,
   * which the route answers `200` to rather than `201` — the same mount, said
   * twice, is not a second mount and consumes no cap.
   */
  created: boolean
}

/**
 * The cap, refused.
 *
 * Carries the cap and the projects already mounted BY NAME, because both
 * surfaces have to say the same sentence: the UI renders "5 von 5 Projekten
 * eingeblendet — entferne eines" beside the list, and the agent's tool turns
 * the same two facts into the refusal string that offers deep research (MT-9).
 * One error, two renderings, no second source for the number.
 */
export class WorkspaceMountCapError extends ApiError {
  constructor(
    readonly cap: number,
    readonly mounted: string[],
    /**
     * The Sammlung this refusal is about, when a SET was what did not fit
     * (spec GR-2). Both surfaces need it in the same sentence — "Bezirk 3 hat
     * mehr Projekte, als eine Unterhaltung gleichzeitig lesen kann (5)" — and a
     * set refusal that named only the cap would leave the person guessing which
     * of the two things they clicked was too big.
     */
    readonly set?: string
  ) {
    super(
      409,
      'WORKSPACE_MOUNT_CAP',
      set
        ? `The Sammlung “${set}” does not fit: a conversation reads at most ${cap} project(s)`
        : `This conversation already has the maximum of ${cap} mounted project(s)`,
      { cap, mounted, set }
    )
  }
}

/**
 * The mount that would have shut somebody out, refused (spec AC-8).
 *
 * Carries the people BY NAME for the same reason the cap carries the projects:
 * the refusal has to be actionable on both surfaces. A person sees "Anna Meier
 * und Bernd Huber könnten dieses Projekt nicht sehen" beside the add row; the
 * agent turns the same list into a sentence offering to unshare or to leave the
 * project out. Names, not ids — an id is not something anyone can act on.
 *
 * 409 rather than 403: nothing about the caller is wrong. The conversation is
 * in a state that this mount would break, which is what a conflict is.
 */
export class WorkspaceMountExclusionError extends ApiError {
  constructor(readonly excluded: string[]) {
    super(
      409,
      'WORKSPACE_MOUNT_WOULD_EXCLUDE',
      `Mounting this project would shut ${excluded.length} participant(s) out of the conversation`,
      { excluded }
    )
  }
}

function toMount(row: MountRow): Mount {
  return {
    projectId: row.projectId,
    projectName: row.projectName,
    mountedBy: row.mountedBy,
    mountedAt: row.mountedAt.toISOString(),
  }
}

/**
 * The mounted set of one conversation, plus the cap it is measured against.
 *
 * `viewer`, not `collaborator`: MT-14 makes the mounted set a property of the
 * conversation that everyone who can READ the thread sees — the same set and
 * the same provenance for its answers. Changing it is contributing and is
 * gated below; being told what a thread reads is part of reading it.
 *
 * A conversation that does not exist yet — the ordinary first-turn case, since
 * ids are client-generated — has no mounts and is not an error.
 */
export async function listMounts(
  session: AuthorizedSession,
  conversationId: string
): Promise<{ mounts: Mount[]; cap: number }> {
  const cap = maxMountedProjects()
  const existing = await findConversationInOrg(conversationId, session.organizationId)
  if (!existing) return { mounts: [], cap }

  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
  const rows = await listConversationMounts(conversationId, session.organizationId)
  return { mounts: rows.map(toMount), cap }
}

export interface MountProjectInput {
  session: AuthorizedSession
  conversationId: string
  projectId: string
  /** `user` from the scope tree, `agent` from `open_project` (MT-5). */
  mountedBy: MountActor
}

/**
 * Mount one project into one conversation.
 *
 * Idempotent: mounting what is already mounted returns the STORED row — whose
 * `mountedBy` is whoever mounted it first — and mints a fresh grant, so the
 * agent re-opening a project it opened last turn gets a working grant without
 * rewriting the attribution a reader has already seen.
 */
export async function mountProject(input: MountProjectInput): Promise<MountResult> {
  const { session, conversationId, projectId, mountedBy } = input
  const { organizationId } = session

  await authorizeMountableConversation(session, conversationId)
  await authorizeMountableProject(session, projectId)

  const cap = maxMountedProjects()
  const before = await listConversationMounts(conversationId, organizationId)
  const already = before.some((row) => row.projectId === projectId)

  if (!already && before.length >= cap) {
    // Checked BEFORE the insert, so a refused mount writes nothing at all —
    // the row and the refusal are not two outcomes of one call.
    throw new WorkspaceMountCapError(
      cap,
      before.map((row) => row.projectName)
    )
  }

  if (!already) await assertMountsKeepEveryone(session, conversationId, [projectId])

  return commitMount({ session, conversationId, projectId, mountedBy, already })
}

/**
 * The write, once the conversation, the project, the cap and the participants
 * have all said yes.
 *
 * Extracted so that mounting a Sammlung and mounting one project are the same
 * write and the same grant rather than two implementations of them (spec GR-2:
 * one mechanism). Everything that DECIDES is above it, which is also why this
 * function takes `already` rather than working it out again — the caller has
 * already read the mounted set to answer the cap, and reading it twice is how
 * two answers to one question appear.
 */
async function commitMount(input: MountProjectInput & { already: boolean }): Promise<MountResult> {
  const { session, conversationId, projectId, mountedBy, already } = input
  const { organizationId } = session

  const created = already
    ? false
    : await insertConversationMount({
        conversationId,
        organizationId,
        projectId,
        mountedBy,
        // The biconditional CHECK in 0083: a user mount names a user, an agent
        // mount names none. Expressed here as the same either/or rather than as
        // two call sites that could drift.
        mountedByUserId: mountedBy === 'user' ? session.userId : null,
      })

  // Read the stored row back rather than describing what was attempted: a
  // concurrent mount of the same project (two tabs, a retried tool call) races
  // to the unique index, and the row that won is the one a reader will see.
  const after = await listConversationMounts(conversationId, organizationId)
  const row = after.find((entry) => entry.projectId === projectId)
  if (!row) {
    // The insert reported success and the row is gone: the project was purged
    // between the two statements, and the cascade took it. Nothing to grant.
    throw new NotFoundError()
  }

  return {
    mount: toMount(row),
    grant: mintMountGrant({
      collection: row.collectionName,
      projectId: row.projectId,
      projectName: row.projectName,
      conversationId,
      organizationId,
    }),
    created,
  }
}

/** Why a member of a Sammlung was left out of the mount it produced. */
export type MountSkipReason = 'forbidden'

/**
 * One member of a Sammlung that was NOT mounted, and why.
 *
 * The only reason that ever appears here is `forbidden`: a project the caller
 * may `project:view` but not `project:chat` in. They already know it exists and
 * already know its name, so naming it is the actionable half of the refusal —
 * "ask for chat access in Nordbahnhof" — and costs them nothing.
 *
 * A member the caller may not view AT ALL is not in this list and not counted
 * anywhere in the answer. It is invisible, exactly as it is on the projects
 * grid and in the register recall (spec AC-3, AC-4, MT-4): a Sammlung must not
 * become the door through which somebody learns that a project they may not
 * read exists.
 */
export interface SkippedMount {
  projectId: string
  projectName: string
  reason: MountSkipReason
}

/** What mounting a Sammlung answers with. */
export interface MountSetResult {
  set: { id: string; name: string }
  /** One entry per mounted project, each with its own grant. */
  mounts: MountResult[]
  skipped: SkippedMount[]
}

export interface MountProjectSetInput {
  session: AuthorizedSession
  conversationId: string
  projectSetId: string
  /** `user` from the scope tree, `agent` from `open_project` (MT-5). */
  mountedBy: MountActor
}

/**
 * Mount a Sammlung — every project in it the caller may chat in — as ONE unit
 * (spec GR-2).
 *
 * There is no set-shaped scope anywhere downstream: this expands to the same
 * `conversation_mounts` rows the same five clicks would have written, through
 * the same {@link commitMount}, so a conversation records the PROJECTS it
 * mounted and not the set it mounted them from. A Sammlung that gains a project
 * tomorrow therefore does not silently widen a thread that mounted it today,
 * and every rule that holds for a mount holds for each row this makes.
 *
 * ## Everything is decided before anything is written
 *
 * The three refusals a mount has are all evaluated over the WHOLE set first:
 *
 *  - the PROJECT gate, per member, by the same `authorizeMountableProject` a
 *    single mount runs — which is what makes the three-way verdict
 *    (mountable / visible-but-not-chattable / invisible) the same judgement
 *    made in one place;
 *  - the CAP, ONCE, against `existing + new distinct`. A set that does not fit
 *    is refused whole, naming the cap and the set, rather than mounting three
 *    of five and leaving the person to work out which two are missing;
 *  - the PARTICIPANTS (spec AC-8), over the union of the new projects. A shared
 *    thread may not gain a Sammlung that would shut somebody already in it out
 *    of it, and refusing project-by-project would already have written the rows
 *    for the harmless half of the set.
 *
 * So a refused set mount leaves the conversation exactly as it found it, which
 * is the same promise a refused single mount makes.
 */
export async function mountProjectSet(input: MountProjectSetInput): Promise<MountSetResult> {
  const { session, conversationId, projectSetId, mountedBy } = input
  const { organizationId } = session

  await authorizeMountableConversation(session, conversationId)
  const { set, members } = await projectSetForMount(session, projectSetId)

  const verdicts = await Promise.all(
    members.map(async (member) => {
      try {
        await authorizeMountableProject(session, member.projectId)
        return { member, verdict: 'mountable' as const }
      } catch (error) {
        // The same two refusals a single mount makes, read as classifications
        // rather than as failures: 403 means "you know this project, you may
        // not chat in it", 404 means "you may not know it at all".
        if (error instanceof ForbiddenError) return { member, verdict: 'forbidden' as const }
        if (error instanceof NotFoundError) return { member, verdict: 'invisible' as const }
        throw error
      }
    })
  )

  const mountable = verdicts
    .filter((entry) => entry.verdict === 'mountable')
    .map((entry) => entry.member)
  const skipped: SkippedMount[] = verdicts
    .filter((entry) => entry.verdict === 'forbidden')
    .map((entry) => ({
      projectId: entry.member.projectId,
      projectName: entry.member.projectName,
      reason: 'forbidden',
    }))

  const cap = maxMountedProjects()
  const before = await listConversationMounts(conversationId, organizationId)
  const mountedIds = new Set(before.map((row) => row.projectId))
  const fresh = mountable.filter((member) => !mountedIds.has(member.projectId))

  if (before.length + fresh.length > cap) {
    throw new WorkspaceMountCapError(
      cap,
      before.map((row) => row.projectName),
      set.name
    )
  }

  await assertMountsKeepEveryone(
    session,
    conversationId,
    fresh.map((member) => member.projectId)
  )

  // Sequential on purpose. Each write reads the mounted set back to answer with
  // the STORED row (see `commitMount`), and concurrent writes racing their own
  // read-backs would make the attribution a reader sees depend on scheduling.
  // At most `cap` of them, so the cost is bounded by the number the deployment
  // already decided a conversation may read.
  const mounts: MountResult[] = []
  for (const member of mountable) {
    mounts.push(
      await commitMount({
        session,
        conversationId,
        projectId: member.projectId,
        mountedBy,
        already: mountedIds.has(member.projectId),
      })
    )
  }

  return { set: { id: set.id, name: set.name }, mounts, skipped }
}

/**
 * Remove one mount (MT-13).
 *
 * Idempotent, and deliberately says nothing about whether a row was there:
 * "this conversation no longer reads that project" is the outcome the caller
 * asked for either way. Answers already given are untouched — a mount decides
 * what the NEXT turn may read, never what an earlier one said.
 *
 * One consequence of the AC-7 read gate worth knowing: somebody who has LOST
 * `project:view` on a mounted project can no longer reach the conversation at
 * all, so they cannot unmount their way back into it either. That is the
 * intended direction — the thread quotes the project they may no longer see —
 * and the ways out are the ordinary ones: regain the project, or have another
 * participant unmount it.
 */
export async function unmountProject(
  session: AuthorizedSession,
  conversationId: string,
  projectId: string
): Promise<void> {
  await requireResourceAccess(session, 'conversation', conversationId, 'collaborator')
  await deleteConversationMount(conversationId, projectId, session.organizationId)
}

/**
 * The persisted mounts this caller may STILL read, for the scope builder
 * (spec MT-7).
 *
 * This is the revocation path. The rows say what the conversation mounted; this
 * says what it may read NOW, by re-running `project:chat` per project on every
 * upgrade. Concurrent, and each project fails CLOSED on its own: a project
 * whose check errors is dropped from the scope rather than taking the whole
 * turn down, because the alternative to a narrower answer is no answer at all.
 *
 * Never throws. A conversation nobody can read, a database that is unavailable,
 * an FGA outage — each of them costs the turn its mounted projects and leaves
 * the base corpus, the Archiv and the register in place. That is the same
 * fail-open posture the archiv and memory legs of this builder already take,
 * and it is safe here for the reason it is safe there: failing this way can
 * only ever REMOVE collections from a scope.
 */
export async function listAuthorizedMounts(
  session: AuthorizedSession,
  conversationId: string
): Promise<MountRow[]> {
  let rows: MountRow[]
  try {
    rows = await listConversationMounts(conversationId, session.organizationId)
  } catch (error) {
    console.warn('[mounts] could not read the conversation’s mounts (non-fatal):', error)
    return []
  }
  if (rows.length === 0) return []

  const decisions = await Promise.all(
    rows.map(async (row) => {
      try {
        await requireProjectAccess(session, row.projectId, CHAT_PERMISSIONS)
        return row
      } catch {
        return null
      }
    })
  )
  return decisions.filter((row): row is MountRow => row !== null)
}

/**
 * The conversation half of the gate.
 *
 * A conversation id is client-generated and the row is created by the first
 * message, so "mount before the first turn is persisted" is the ordinary case,
 * not an edge one (spec MT-16: the `?mount=` deep link lands on an empty Büro).
 * Creating it here goes through `createConversation`, which is where `org:chat`
 * is checked and where the workspace shape is decided — so the right to open an
 * office conversation is enforced by the same function whether the client
 * created it or a mount did.
 *
 * A PROJECT-scoped conversation is never mountable: it already has its project
 * and mounting a second one would make the lock chip a lie.
 */
async function authorizeMountableConversation(
  session: AuthorizedSession,
  conversationId: string
): Promise<void> {
  const existing = await findConversationInOrg(conversationId, session.organizationId)
  if (!existing) {
    await createConversation(session, { id: conversationId, scope: 'workspace' })
    return
  }
  await requireResourceAccess(session, 'conversation', conversationId, 'collaborator')
  if (existing.scope !== 'workspace') {
    throw new BadRequestError(
      'A project conversation already has its project; only a workspace conversation mounts projects',
      { scope: existing.scope }
    )
  }
}

/**
 * The sharing half of the gate: a mount must not evict anyone (spec AC-8).
 *
 * A shared Büro thread is readable only by people who may view every mounted
 * project (AC-7), so mounting a NEW project into one is the moment that rule
 * could quietly stop holding. The two silent outcomes are both wrong — widening
 * the project to whoever is in the thread, or leaving them with a conversation
 * they can no longer open — so the mount is refused and says who it would have
 * shut out.
 *
 * Takes a LIST because a Sammlung is mounted as one unit (GR-2): the rule then
 * has to be answered over the whole set before any of it is written, or the
 * harmless half of a set would already be in the conversation when the other
 * half is refused. One project is the same call with one element.
 *
 * Four deliberate narrowings, so the common mount costs nothing:
 *
 *   - Only mounts that are actually NEW; the caller filters those out before
 *     asking. Re-mounting what is already mounted changes nobody's access and
 *     must stay idempotent.
 *   - Only the participants — the creator plus explicit grants
 *     (`resolveParticipants`), which is the same set the fan-out uses. A
 *     private thread with no grants has exactly one participant, the person
 *     mounting, and the check ends there.
 *   - Only the projects being mounted, not every project already mounted. The
 *     ones already there were checked when they were mounted or granted; a
 *     revocation since then is caught at READ time, which is where a rule that
 *     can stop holding belongs.
 *   - One `resolveParticipants` for the whole set, and the excluded people are
 *     UNIONed across it, so a person who would lose the thread over three of
 *     its projects is named once.
 *
 * The acting user is skipped: they have just proved `project:chat` on these
 * projects, which is strictly more than the `project:view` being asked of
 * everyone else.
 */
async function assertMountsKeepEveryone(
  session: AuthorizedSession,
  conversationId: string,
  projectIds: readonly string[]
): Promise<void> {
  if (projectIds.length === 0) return
  const participants = (
    await resolveParticipants(session.organizationId, 'conversation', conversationId)
  ).filter((userId) => userId !== session.userId)
  if (participants.length === 0) return

  const perProject = await Promise.all(
    projectIds.map((projectId) => usersExcludedByProject(session, projectId, participants))
  )
  const excluded = [...new Set(perProject.flat())]
  if (excluded.length === 0) return

  const people = await resolvePeople(session.organizationId, excluded)
  throw new WorkspaceMountExclusionError(
    excluded.map((userId) => (people.get(userId) ?? unknownPerson(userId)).name)
  )
}

/**
 * The project half of the gate — and the one place the 403/404 distinction is
 * made (MT-3, MT-4).
 *
 * The happy path is one `requireProjectAccess`. The extra `project:view` probe
 * runs ONLY on the refusal path, where a second round trip costs nothing and
 * buys the caller the difference between "you may not chat here" and "there is
 * no such project".
 */
async function authorizeMountableProject(
  session: AuthorizedSession,
  projectId: string
): Promise<void> {
  try {
    await requireProjectAccess(session, projectId, CHAT_PERMISSIONS)
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
    const visible = await requireProjectAccess(session, projectId, 'project:view').then(
      () => true,
      () => false
    )
    if (!visible) throw error
    throw new ForbiddenError('Missing permission: project:chat')
  }
}

export interface InternalMountIdentity {
  organizationId: string
  userId: string
  organizationMembershipId: string
}

/**
 * The session the internal twin authorizes as.
 *
 * Everything in it comes from the turn's signed envelope except the ROLE, which
 * is resolved from WorkOS by membership id and cached org-keyed for a minute
 * (`lib/authz/membership-role`). The role is what lets `hasPermission` answer
 * the org-tier questions this path needs — `org:chat` to open an office
 * conversation, `org:projects:administer` for the administrator bypass inside
 * `requireProjectAccess` — by catalog implication rather than by a role-name
 * comparison (ADR-0038). Without it the agent's mount would be strictly weaker
 * than the same person's own click, which is the divergence MT-2 forbids.
 *
 * `permissions` is empty and `email` blank on purpose: the envelope carries
 * neither, and inventing either would make this look like a session rather than
 * the reconstruction it is. Nothing on this path reads them.
 */
export async function sessionForInternalMount(
  identity: InternalMountIdentity
): Promise<AuthorizedSession> {
  const role = await resolveMembershipRole(
    identity.organizationId,
    identity.organizationMembershipId
  )
  return {
    userId: identity.userId,
    email: '',
    name: null,
    accessToken: '',
    organizationId: identity.organizationId,
    organizationMembershipId: identity.organizationMembershipId,
    role: role ?? '',
    permissions: [],
    featureFlags: null,
  }
}

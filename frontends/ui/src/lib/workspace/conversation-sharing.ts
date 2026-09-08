/**
 * Sharing a Büro conversation without leaking a project through it
 * (spec AC-7, AC-8, AC-9; ADR-0032, ADR-0054).
 *
 * A workspace conversation belongs to the organization and reads whatever it
 * has mounted, so its transcript quotes project documents and its next turn
 * retrieves from project collections. Handing someone the thread therefore
 * hands them those projects' contents, and the rule that makes that safe is one
 * sentence:
 *
 *   **A person may be party to a workspace conversation only while they may
 *   view every project it has mounted.**
 *
 * "Only while" is why the rule is checked in three places rather than one:
 *
 *   1. **At grant time** ({@link assertSubjectMayJoinConversation}) — the
 *      invitation is refused, naming the projects, so the sharer learns why.
 *   2. **At read time** ({@link assertMountedProjectsReadable}) — because a
 *      grant is durable and `project:view` is not. A revocation after the fact
 *      must close the thread, and it does so as a `NotFoundError`: denial is
 *      indistinguishable from non-existence (spec AC-9).
 *   3. **At mount time** ({@link usersExcludedByProject}, used by the mounts
 *      service) — mounting into a SHARED thread would otherwise widen it
 *      silently, or quietly evict the people already in it. Neither is an
 *      outcome anyone chose, so the mount is refused instead (spec AC-8).
 *
 * ## Layering
 *
 * This module is reached from the sharing registry's descriptor, so it may talk
 * to repositories and to `lib/authz`, and must NOT import `lib/sharing/access`
 * or `lib/sharing/service` — those import the registry, and the cycle would be
 * real. The mount-time half consequently lives in `./mounts-service`, which is
 * free to use the sharing service's participant set.
 */

import 'server-only'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { canUserAccessProject } from '@/lib/authz/project-membership'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { AuthorizedSession } from '@/lib/auth/types'
import { SHARING_ERROR_REASONS } from '@/lib/sharing/types'
import { listConversationMounts } from './mounts-repository'

/**
 * The projects `conversationId` has mounted that `subjectUserId` may not view.
 *
 * `project:view`, not `project:chat`: the question is what the person will be
 * able to READ once they are in the thread, and reading a project's documents
 * is the viewer rung (ADR-0038). Mounting demands the stronger `project:chat`
 * of the person doing the mounting, which is a different question about a
 * different person.
 *
 * Fails closed by construction — `canUserAccessProject` answers `false` for an
 * unknown user, a user outside the organization and a failed check alike — so
 * an outage narrows the roster instead of widening the thread.
 */
export async function unviewableMountedProjects(
  session: AuthorizedSession,
  conversationId: string,
  subjectUserId: string
): Promise<string[]> {
  const mounts = await listConversationMounts(conversationId, session.organizationId)
  if (mounts.length === 0) return []

  const verdicts = await Promise.all(
    mounts.map(async (mount) => ({
      name: mount.projectName,
      viewable: await canUserAccessProject(session, mount.projectId, subjectUserId),
    }))
  )
  return verdicts.filter((verdict) => !verdict.viewable).map((verdict) => verdict.name)
}

/**
 * Grant-time half of AC-7: refuse an invitation that would give somebody a
 * thread reading a project they may not view.
 *
 * A `BadRequestError` rather than a 404, and it names the projects: the sharer
 * can already see this conversation and everything mounted into it, so the
 * refusal tells them nothing they did not know, and the only actionable version
 * of "no" is the one that says which project to fix. That is the same shape as
 * the container refusal beside it in `lib/sharing/service`.
 *
 * It reuses that refusal's `reason` on purpose, and the reuse is load-bearing
 * twice over. The remedy the share dialog renders for
 * `container-access-required` — "add them to the project first" — is exactly
 * the remedy here, where a new reason with no dictionary entry would render as
 * the generic "that change could not be saved". And the MENTION path invites
 * through `grantResourceAccess`, catching that same reason to re-label it with
 * the name it was about (`lib/mentions/service.ts`), so mentioning someone into
 * a Büro thread they may not fully read is refused in the mention vocabulary
 * without that module learning what a mount is. The project NAMES ride in
 * `details.projects` for the surface that wants to say which.
 */
export async function assertSubjectMayJoinConversation(
  session: AuthorizedSession,
  conversationId: string,
  subjectUserId: string
): Promise<void> {
  const blocked = await unviewableMountedProjects(session, conversationId, subjectUserId)
  if (blocked.length === 0) return

  throw new BadRequestError(
    `That person may not view ${blocked.join(', ')}, which this Büro conversation reads. ` +
      'Give them access to the project first, or remove the mount — sharing a conversation ' +
      'never grants project access.',
    { reason: SHARING_ERROR_REASONS.containerAccessRequired, projects: blocked }
  )
}

/**
 * Read-time half of AC-7, and the reason a grant is not a key.
 *
 * Runs on every access resolution for an organization-level conversation, which
 * is the one shape a mount can attach to — a project conversation has its
 * project and mounts nothing, so the check costs it nothing at all. A thread
 * with no mounts costs one indexed read; the FGA calls only happen for a thread
 * that actually mounted something.
 *
 * Denial is `NotFoundError`, thrown for the reader who lost `project:view`
 * exactly as it is for the reader who never had it (spec AC-9). It applies to
 * the creator too: the transcript quotes the project either way, and "I mounted
 * it" is not a right to keep reading it after the project stopped being theirs.
 */
export async function assertMountedProjectsReadable(
  session: AuthorizedSession,
  conversationId: string
): Promise<void> {
  const mounts = await listConversationMounts(conversationId, session.organizationId)
  if (mounts.length === 0) return

  const readable = await Promise.all(
    mounts.map((mount) =>
      requireProjectAccess(session, mount.projectId, 'project:view').then(
        () => true,
        () => false
      )
    )
  )
  // Fails closed on an FGA outage as well as on a revocation, deliberately: the
  // alternative is serving a project's contents on the strength of a lookup
  // that did not answer.
  if (!readable.every(Boolean)) throw new NotFoundError()
}

/**
 * Which of `userIds` may not view `projectId` — the mount-time half of AC-8,
 * asked of a project that is about to be mounted rather than of one that
 * already is.
 *
 * Returns ids; the caller turns them into names, because only the caller knows
 * whether anybody is going to see them.
 */
export async function usersExcludedByProject(
  session: AuthorizedSession,
  projectId: string,
  userIds: readonly string[]
): Promise<string[]> {
  if (userIds.length === 0) return []
  const verdicts = await Promise.all(
    userIds.map(async (userId) => ({
      userId,
      viewable: await canUserAccessProject(session, projectId, userId),
    }))
  )
  return verdicts.filter((verdict) => !verdict.viewable).map((verdict) => verdict.userId)
}

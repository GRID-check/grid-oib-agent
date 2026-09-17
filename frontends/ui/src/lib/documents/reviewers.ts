/**
 * Who is asked to release a version — and the one case where nobody can be.
 *
 * ## Why this is not „whoever the document is assigned to"
 *
 * It was, and it made `submit` unreachable for exactly the documents the
 * lifecycle was built for. A draft Piloti files is `Unvergeben` BY
 * CONSTRUCTION — ADR-0047's whole point is that a machine-written report
 * arrives with nobody on the hook — so the assignment fallback resolved to the
 * empty set, and the submission was refused with „name a reviewer or assign the
 * document first" on a path (the agent's `submit_draft`, the draft card, the
 * lifecycle panel) that had no way to name one.
 *
 * So the fallback is a chain, and each link is a different sentence:
 *
 *   1. **the people the caller named.** A picker, or `reviewerUserIds` on the
 *      wire. Nothing is inferred when somebody has said.
 *   2. **whoever is on the hook** (`resource_assignments`, ADR-0047). If a
 *      person has taken the file, they are the reviewer — that is what taking
 *      it means.
 *   3. **the project's editors**, minus the submitter. „Wer darf das
 *      freigeben" has an answer that does not depend on anybody having done
 *      anything first: it is `project:edit`, the permission the approve
 *      transition itself asks for. Asking all of them is the honest reading of
 *      an unassigned draft — the round is open, and whoever gets there first
 *      answers it.
 *   4. **the submitter**, and only when 3 is empty. A one-person project has
 *      nobody else, and refusing the submission would make the lifecycle
 *      unusable for a sole Ziviltechniker. This is a WAIVER and it is recorded
 *      as one (`selfReview` on the audit event), never a silent equivalence.
 *
 * The submitter is excluded from 2 and 3 for the reason the approve guard
 * exists: an assertion nobody but the author has read is not one.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { filterUsersWithProjectPermission } from '@/lib/authz/project-membership'
import { listAssignmentsForResources } from '@/lib/assignments/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { Document } from '@/lib/db/schema'

/** One person a version may be sent to, as the picker renders them. */
export interface ReviewCandidate {
  userId: string
  name: string
  email: string | null
}

/**
 * Everyone in this organization who may release a version of this document,
 * except the person asking.
 *
 * `project:edit` and not `project:view`, which is what the assignment picker
 * filters on: being able to open a project does not make somebody able to
 * approve a Brandschutzkonzept, and offering them in a reviewer picker would
 * put a round in front of somebody whose decision the transition then refuses.
 *
 * A document with no project — the org-wide Archiv, a chat attachment — has no
 * project roster to ask, so the answer is empty and the chain above falls
 * through to its waiver.
 */
export async function listReviewCandidates(
  session: AuthorizedSession,
  document: Document,
): Promise<ReviewCandidate[]> {
  if (!document.projectId) return []
  const directory = await loadOrganizationDirectory(session.organizationId)
  const others = [...directory.values()].filter((person) => person.userId !== session.userId)
  if (others.length === 0) return []
  const allowed = await filterUsersWithProjectPermission(
    session,
    document.projectId,
    others.map((person) => person.userId),
    'project:edit',
  )
  return others
    .filter((person) => allowed.has(person.userId))
    .map((person) => ({ userId: person.userId, name: person.name, email: person.email }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The outcome of the chain in this module's header. */
export interface ResolvedReviewers {
  reviewers: readonly string[]
  /**
   * Nobody else in this project may release the version, so the submitter is
   * reviewing their own work.
   *
   * Carried out of here rather than inferred at the call site because the two
   * things that read it are far apart: the audit event records it, and the
   * approve guard waives „der Einreichende darf nicht freigeben" on it. Both
   * have to mean the same thing or the trail says one and the door does the
   * other.
   */
  selfReview: boolean
}

export async function resolveReviewers(
  session: AuthorizedSession,
  document: Document,
  named: readonly string[] | undefined,
): Promise<ResolvedReviewers> {
  const stated = [...new Set([...(named ?? [])].filter(Boolean))]
  if (stated.length > 0) return { reviewers: stated, selfReview: false }

  const assignments = await listAssignmentsForResources(session.organizationId, 'document', [
    document.id,
  ])
  const assignees = [
    ...new Set(
      assignments.map((row) => row.subjectUserId).filter((userId) => userId !== session.userId),
    ),
  ]
  if (assignees.length > 0) return { reviewers: assignees, selfReview: false }

  const candidates = await listReviewCandidates(session, document)
  if (candidates.length > 0) {
    return { reviewers: candidates.map((person) => person.userId), selfReview: false }
  }

  // The waiver. A sole editor has nobody to ask, and „Freigabe" by the only
  // person who could ever give it is still a decision — it is simply not a
  // second pair of eyes, which is exactly what the audit event now says.
  return { reviewers: [session.userId], selfReview: true }
}

/**
 * Resolve a reviewer the AGENT named, by display name or e-mail.
 *
 * The Python tool's `submit_draft` takes a person the way the user said them
 * („leg das der Anna vor"), and a user id is not something the model has or
 * should have. Resolution therefore happens on this side, against the same
 * candidate list the picker offers, so a name the project cannot identify is a
 * refusal the tool can show rather than a round opened for the wrong colleague.
 *
 * Exact match, case- and whitespace-insensitive, and AMBIGUITY IS A REFUSAL:
 * two people called „Anna" means the caller has not said which, and picking one
 * would put a Freigabe in front of somebody who was never asked.
 */
export function matchReviewCandidate(
  candidates: readonly ReviewCandidate[],
  stated: string,
): { ok: true; userId: string } | { ok: false; reason: 'unknown' | 'ambiguous' } {
  const wanted = stated.trim().toLowerCase()
  const matches = candidates.filter(
    (person) =>
      person.name.trim().toLowerCase() === wanted ||
      (person.email ?? '').trim().toLowerCase() === wanted,
  )
  if (matches.length === 1) return { ok: true, userId: matches[0].userId }
  return { ok: false, reason: matches.length === 0 ? 'unknown' : 'ambiguous' }
}

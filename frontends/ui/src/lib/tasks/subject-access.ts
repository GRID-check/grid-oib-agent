/**
 * Whether a person may see a revision task: whether they may read the folder
 * its document is in NOW (ADR-0089, ADR-0085).
 *
 * A `revision` task quotes its draft's text into the run, its title and goal
 * are the reviewer's words about that draft, and its thread holds the revised
 * draft. Since ADR-0084 a draft in a folder some member may not read gets no
 * task (`openRevisionTask`), but a task opened before its folder was
 * restricted, or before the document moved into such a folder, stayed listed
 * to the whole project. So a task is judged when it is READ, like a shared
 * chat (`lockedConversationIds`): listing and opening one ask the document's
 * current folder, with the reader's clearance as it is now. Nothing is stored:
 * a role given back shows the task again.
 *
 * A task with no subject is not judged here. A subject whose document is gone
 * (documents are deleted outright) has no current folder; it is judged as the
 * project's, as it was when the task was opened, because withholding it would
 * hide every revision task of a deleted document from everyone, its thread
 * included. A document in another project than the task's is withheld.
 */

import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { atLeast, clearanceOf, effectiveFolderLevel, folderTree } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import type { TaskPlan } from '@/lib/db/schema'
import { findSubjectDocumentPlaces } from './repository'

/** Anything that carries a task's plan: a run or a definition. */
export interface WithPlan {
  plan: TaskPlan | null
}

function subjectOf(row: WithPlan): string | null {
  return row.plan?.subject?.documentId ?? null
}

/** A predicate over rows: may the session read each one's subject now. */
async function subjectReader(
  session: AuthorizedSession,
  projectId: string,
  rows: readonly WithPlan[],
): Promise<(row: WithPlan) => boolean> {
  const documentIds = [...new Set(rows.map(subjectOf).filter((id): id is string => id !== null))]
  if (documentIds.length === 0) return () => true
  const places = await findSubjectDocumentPlaces(session.organizationId, documentIds)
  const restricting = [...places.values()].some((place) => place.projectId !== projectId || place.folderId !== null)
  if (!restricting) return () => true
  const tree = folderTree(await listProjectFolderTree(session.organizationId, projectId))
  const clearance = await clearanceOf(session, projectId)
  return (row) => {
    const documentId = subjectOf(row)
    if (documentId === null) return true
    const place = places.get(documentId)
    if (!place) return true
    if (place.projectId !== projectId) return false
    if (place.folderId === null) return true
    return atLeast(effectiveFolderLevel(tree, clearance, place.folderId), 'read')
  }
}

/** `rows` without the revision tasks whose document the session may not read now. Order kept. */
export async function withoutUnreadableSubjects<T extends WithPlan>(
  session: AuthorizedSession,
  projectId: string,
  rows: readonly T[],
): Promise<T[]> {
  const mayRead = await subjectReader(session, projectId, rows)
  return rows.filter(mayRead)
}

/**
 * Refuse a revision task whose document the session may not read now, with the
 * 404 an unknown task gets: "this task exists but not for you" is the sentence
 * that makes an id worth guessing.
 */
export async function requireMaySeeSubject(
  session: AuthorizedSession,
  projectId: string,
  row: WithPlan,
  message = 'Task not found',
): Promise<void> {
  const mayRead = await subjectReader(session, projectId, [row])
  if (!mayRead(row)) throw new NotFoundError(message)
}

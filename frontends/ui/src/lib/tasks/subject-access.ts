/**
 * Whether a person may see a revision task: whether they may read the folder
 * its document is in NOW (ADR-0091, ADR-0087).
 *
 * A `revision` task quotes its draft's text into the run, its title and goal
 * are the reviewer's words about that draft, and its thread holds the revised
 * draft. Since ADR-0086 a draft in a folder some member may not read gets no
 * task (`openRevisionTask`), but a task opened before its folder was
 * restricted, or before the document moved into such a folder, stayed listed
 * to the whole project. So a task is judged when it is READ, like a shared
 * chat (`lockedConversationIds`): listing and opening one ask the document's
 * current folder, with the reader's clearance as it is now. Nothing is stored:
 * a role given back shows the task again.
 *
 * The inbox is a listing too: a run's `job.*` row carries the task's title and
 * a deep link into its thread, so {@link unreadableRunIds} redacts it on the
 * same rule (`lib/inbox/service.ts`).
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
import type { TaskPlan, TaskRun } from '@/lib/db/schema'
import { findSubjectDocumentPlaces, listRunsByIds } from './repository'

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

/** A run an inbox row names, and the project the row is filed under. */
export interface RunRef {
  projectId: string
  runId: string
}

/**
 * The ids among these runs the session may not see now: a revision task whose
 * document sits where the session may not read, or a run filed under another
 * project than the row names. A run that no longer exists is not judged here
 * (its project's own access still decides the row). One read for the runs and
 * one per project for the folders.
 */
export async function unreadableRunIds(session: AuthorizedSession, refs: readonly RunRef[]): Promise<Set<string>> {
  const unreadable = new Set<string>()
  if (refs.length === 0) return unreadable
  const runs = new Map(
    (await listRunsByIds(session.organizationId, refs.map((ref) => ref.runId))).map((run) => [run.id, run]),
  )
  const byProject = new Map<string, TaskRun[]>()
  for (const ref of refs) {
    const run = runs.get(ref.runId)
    if (!run) continue
    if (run.projectId !== ref.projectId) {
      unreadable.add(ref.runId)
      continue
    }
    byProject.set(ref.projectId, [...(byProject.get(ref.projectId) ?? []), run])
  }
  for (const [projectId, projectRuns] of byProject) {
    const mayRead = await subjectReader(session, projectId, projectRuns)
    for (const run of projectRuns) {
      if (!mayRead(run)) unreadable.add(run.id)
    }
  }
  return unreadable
}

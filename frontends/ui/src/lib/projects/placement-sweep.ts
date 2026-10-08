/**
 * The sweep that finishes a restriction a backend outage interrupted
 * (ADR-0080).
 *
 * Placement purges a document's chunks from its old collection before it
 * re-points the row. When the purge fails the row stays where it was, and so
 * do its chunks: a document filed under a restricted folder, hidden from every
 * listing, would still be found by a chat turn searching the project's open
 * collection until something placed the project again. The scheduler calls
 * this on its tick so that something always does.
 *
 * Only projects that restrict a folder are swept, because that is the
 * direction that leaks. A restriction lifted while the backend was down leaves
 * documents in a collection only those cleared before the lift can search:
 * narrower than intended, never wider, and placed again by the next change to
 * the tree.
 *
 * Every such project is reached. A sweep places at most
 * `PLACEMENT_SWEEP_PROJECTS` of them, and stops starting new ones after
 * `PLACEMENT_SWEEP_BUDGET_MS`; the next sweep carries on from the last project
 * placed, in project-id order, wrapping round at the end. The cursor lives in
 * the process and starts at a random id, so replicas spread over the id space
 * rather than all starting from the same projects, and a restart loses at most
 * a lap. A placement that leaves work `pending` (its move budget spent, an
 * ingest in flight) is finished when the walk comes round again.
 *
 * Replica-safe: a re-point is guarded on the collection it read, so two sweeps
 * (or a sweep and a person restricting a folder) move a document once.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { listProjectsWithRestrictedFolders } from '@/lib/authz/folder-access-repository'
import { retryProjectPlacement } from './collection-placement'

/** Projects one sweep places at most. Placement of a project with nothing to move is a few small reads. */
export const PLACEMENT_SWEEP_PROJECTS = 50

/**
 * After this long a sweep starts no further project. Under the scheduler's
 * two-minute request timeout, so a sweep answers before the scheduler gives up
 * on it and the next tick does not overlap it.
 */
export const PLACEMENT_SWEEP_BUDGET_MS = 60_000

export interface PlacementSweepResult {
  checked: number
  moved: number
  /** Documents still in the wrong collection after this sweep; a later one retries them. */
  pending: number
  failed: number
}

/** The last project id a sweep in this process placed; the next sweep starts after it. */
let cursor: string = randomUUID()

type RestrictedProject = { organizationId: string; projectId: string }

/** The next projects after the cursor, wrapping round to the start of the id space. */
async function nextProjects(limit: number): Promise<RestrictedProject[]> {
  const tail = await listProjectsWithRestrictedFolders({ after: cursor, upTo: null, limit })
  if (tail.length === limit) return tail
  const head = await listProjectsWithRestrictedFolders({ after: null, upTo: cursor, limit: limit - tail.length })
  return [...tail, ...head]
}

export async function sweepCollectionPlacement(): Promise<PlacementSweepResult> {
  const deadline = Date.now() + PLACEMENT_SWEEP_BUDGET_MS
  const result: PlacementSweepResult = { checked: 0, moved: 0, pending: 0, failed: 0 }
  for (const { organizationId, projectId } of await nextProjects(PLACEMENT_SWEEP_PROJECTS)) {
    if (Date.now() >= deadline) break
    cursor = projectId
    result.checked += 1
    try {
      const placed = await retryProjectPlacement(organizationId, projectId)
      result.moved += placed.moved
      result.pending += placed.failed.length + placed.pending
    } catch (error) {
      result.failed += 1
      console.warn(`[placement] sweep could not place project ${projectId}:`, error)
    }
  }
  return result
}

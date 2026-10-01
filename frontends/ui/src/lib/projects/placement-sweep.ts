/**
 * The sweep that finishes a restriction a backend outage interrupted
 * (ADR-0078).
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
 * documents in a collection only the formerly cleared can search: narrower than
 * intended, never wider, and placed again by the next change to the tree.
 *
 * Replica-safe: a re-point is guarded on the collection it read, so two sweeps
 * (or a sweep and a person restricting a folder) move a document once.
 */

import 'server-only'
import { listProjectsWithRestrictedFolders } from '@/lib/authz/folder-access-repository'
import { placeProjectDocuments } from './collection-placement'

/** Projects one sweep places. Placement of a project with nothing to move is three small reads. */
export const PLACEMENT_SWEEP_PROJECTS = 50

export interface PlacementSweepResult {
  checked: number
  moved: number
  /** Documents still in the wrong collection after this sweep; the next one retries them. */
  pending: number
  failed: number
}

export async function sweepCollectionPlacement(): Promise<PlacementSweepResult> {
  const restricted = await listProjectsWithRestrictedFolders(PLACEMENT_SWEEP_PROJECTS)
  const result: PlacementSweepResult = { checked: restricted.length, moved: 0, pending: 0, failed: 0 }
  for (const { organizationId, projectId } of restricted) {
    try {
      const placed = await placeProjectDocuments(organizationId, projectId)
      result.moved += placed.moved
      result.pending += placed.failed.length
    } catch (error) {
      result.failed += 1
      console.warn(`[placement] sweep could not place project ${projectId}:`, error)
    }
  }
  return result
}

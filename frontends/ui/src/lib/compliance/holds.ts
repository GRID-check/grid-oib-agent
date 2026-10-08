/**
 * The legal-hold gate every immediate erasure passes before it destroys
 * anything (GDPR Art. 18 restriction; `docs/architecture/deletion-pipeline.md`).
 *
 * The purger reads a hold before it erases a project. Deleting a document, an
 * Archiv document, a chat or a chat's attachment is an immediate hard delete in
 * this tier, so each of those paths
 * calls {@link assertNoActiveHold} after its access check and before its first
 * destructive step — objects, chunks, grants, rows.
 *
 * What "covered" means is not written here. It is the database function
 * `grid_legal_hold_blocks` (migration 0093), the same one the purger's claim
 * and the delete triggers call, so the three readers cannot disagree: the
 * entity itself, what contains it, what it contains, the user who created it,
 * and the organization.
 *
 * Kept apart from `./service` so the delete paths that import it do not also
 * import the hold-management API and its audit writes.
 */

import 'server-only'
import { ConflictError } from '@/lib/api/errors'
import type { DeletionEntityType } from '@/lib/db/schema'
import { LEGAL_HOLD_MESSAGE, LEGAL_HOLD_REASON } from './legal-hold-codes'
import { isCoveredByActiveHold } from './repository'

/**
 * Throw a 409 when an active legal hold covers erasing this entity.
 *
 * Says only THAT a hold applies, never which one or why: the reason field is
 * written for counsel, and the person deleting a file is not necessarily
 * entitled to read it. `GET /api/holds` is where the compliance role sees the
 * rest.
 */
export async function assertNoActiveHold(
  organizationId: string,
  entityType: DeletionEntityType,
  entityId: string,
): Promise<void> {
  if (!(await isCoveredByActiveHold(organizationId, entityType, entityId))) return
  throw new ConflictError(LEGAL_HOLD_MESSAGE, { reason: LEGAL_HOLD_REASON, entityType })
}

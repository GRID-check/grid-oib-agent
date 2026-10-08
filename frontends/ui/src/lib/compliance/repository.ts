/**
 * Compliance repository — the only module that talks to the `legal_holds`
 * and `deletion_queue` tables for the compliance domain.
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no WorkOS.
 *   - Every query that serves tenant data takes `organizationId` and scopes
 *     the WHERE clause with it — tenancy is enforced in SQL, not in JS.
 *   - List queries are always bounded (`limit`).
 */

import 'server-only'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import {
  deletionQueue,
  legalHolds,
  type DeletionEntityType,
  type LegalHold,
  type NewLegalHold,
} from '@/lib/db/schema'

/** Hard cap for unpaginated org-wide compliance lists. */
export const COMPLIANCE_LIST_LIMIT = 200

/** Open (unreleased) legal holds for an organization, newest first. */
export async function listOpenHoldsInOrg(
  organizationId: string,
  limit = COMPLIANCE_LIST_LIMIT,
): Promise<LegalHold[]> {
  const db = getDb()
  return db
    .select()
    .from(legalHolds)
    .where(and(eq(legalHolds.organizationId, organizationId), isNull(legalHolds.releasedAt)))
    .orderBy(desc(legalHolds.createdAt))
    .limit(limit)
}

/**
 * Whether an active legal hold covers erasing this entity.
 *
 * The predicate is the database's `grid_legal_hold_blocks` (migration 0093) and
 * nothing else: the purger's claim and the delete triggers call the same
 * function, so this tier cannot answer "free" for an entity the purger would
 * refuse. Run in the entity's own tenant, which is the set of holds that can
 * cover it (`legal_holds` is tenant-scoped under row-level security).
 */
export async function isCoveredByActiveHold(
  organizationId: string,
  entityType: DeletionEntityType,
  entityId: string,
): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db.execute<{ held: boolean }>(
      sql`select grid_legal_hold_blocks(${entityType}, ${entityId}, ${organizationId}) as held`,
    ),
  )
  // Coerced at the boundary: postgres-js returns a real boolean for a boolean
  // column, and anything else is not a "yes".
  return Array.from(rows)[0]?.held === true
}

export async function insertHold(
  values: Pick<NewLegalHold, 'entityType' | 'entityId' | 'reason' | 'organizationId' | 'createdBy'>,
): Promise<LegalHold> {
  const db = getDb()
  const [row] = await db.insert(legalHolds).values(values).returning()
  return row
}

/**
 * Release an open hold scoped to an organization. Returns the released row,
 * or null when no open hold matches (missing, cross-tenant, or already
 * released) — the caller decides that means 404.
 */
export async function releaseHoldInOrg(holdId: string, organizationId: string): Promise<LegalHold | null> {
  const db = getDb()
  const [row] = await db
    .update(legalHolds)
    .set({ releasedAt: new Date() })
    .where(
      and(
        eq(legalHolds.id, holdId),
        eq(legalHolds.organizationId, organizationId),
        isNull(legalHolds.releasedAt),
      ),
    )
    .returning()
  return row ?? null
}

/** Summary shape served to the "Recently deleted" / stuck-purge UI. */
export interface DeletionQueueSummary {
  id: string
  entityType: (typeof deletionQueue.$inferSelect)['entityType']
  entityId: string
  displayName: string
  requestedBy: string
  requestedAt: Date
  purgeAfter: Date
  status: (typeof deletionQueue.$inferSelect)['status']
  lastError: string | null
}

/** Pending/failed deletion-queue entries for an organization, newest first. */
export async function listPendingDeletionsInOrg(
  organizationId: string,
  limit = COMPLIANCE_LIST_LIMIT,
): Promise<DeletionQueueSummary[]> {
  const db = getDb()
  return db
    .select({
      id: deletionQueue.id,
      entityType: deletionQueue.entityType,
      entityId: deletionQueue.entityId,
      displayName: deletionQueue.displayName,
      requestedBy: deletionQueue.requestedBy,
      requestedAt: deletionQueue.requestedAt,
      purgeAfter: deletionQueue.purgeAfter,
      status: deletionQueue.status,
      lastError: deletionQueue.lastError,
    })
    .from(deletionQueue)
    .where(
      and(
        eq(deletionQueue.organizationId, organizationId),
        inArray(deletionQueue.status, ['pending', 'failed']),
      ),
    )
    .orderBy(desc(deletionQueue.requestedAt))
    .limit(limit)
}

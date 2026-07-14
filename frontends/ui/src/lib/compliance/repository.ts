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
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { getDb } from '@/lib/db'
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
 * Is destruction of a document blocked by an active (unreleased) legal hold?
 *
 * Same predicate the purger enforces (`purger/db.js` hasActiveHold), generalized
 * to the document case: a hold covers this delete if, within the org, there is an
 * unreleased hold that is org-wide, targets the parent project, or targets the
 * specific document. This is the SYNCHRONOUS gate the file-gateway calls before a
 * drive `rm` destroys bytes (ADR-0024 §3) — bytes must never be destroyed under a
 * hold. `documentId` is optional: a raw drive file not yet reconciled into a
 * `documents` row is still covered by any org- or project-level hold.
 */
export async function isDeletionUnderHold(params: {
  organizationId: string
  projectId: string
  documentId?: string | null
}): Promise<boolean> {
  const db = getDb()
  const targets: Array<{ type: DeletionEntityType; id: string }> = [
    { type: 'organization', id: params.organizationId },
    { type: 'project', id: params.projectId },
  ]
  if (params.documentId) targets.push({ type: 'document', id: params.documentId })

  const rows = await db
    .select({ id: legalHolds.id })
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.organizationId, params.organizationId),
        isNull(legalHolds.releasedAt),
        or(
          ...targets.map((t) => and(eq(legalHolds.entityType, t.type), eq(legalHolds.entityId, t.id))),
        ),
      ),
    )
    .limit(1)
  return rows.length > 0
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

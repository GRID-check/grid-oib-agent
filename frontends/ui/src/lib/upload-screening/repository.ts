/**
 * The content gate's quarantine decisions still owed to the audit trail
 * (migration 0117, ADR-0083). Written by `setDocumentReconciledStatus`, in the
 * transaction that moves the row; read and marked here.
 */

import 'server-only'
import { and, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documentQuarantineDecisions, type DocumentQuarantineDecision } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'

/** The decisions about these documents that the trail does not have yet. */
export async function listOwedQuarantineDecisions(
  organizationId: string,
  documentIds: readonly string[]
): Promise<DocumentQuarantineDecision[]> {
  if (documentIds.length === 0) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(documentQuarantineDecisions)
      .where(
        and(
          eq(documentQuarantineDecisions.organizationId, organizationId),
          inArray(documentQuarantineDecisions.documentId, [...documentIds]),
          isNull(documentQuarantineDecisions.auditedAt)
        )
      )
  )
}

/**
 * The sweep's discovery, across organizations: decisions still owed that were
 * taken in the window. The caller runs it under `withPlatformAccess` and sends
 * each inside `withTenant` for its own organization. Newest first, as the
 * batch sweep, so a decision WorkOS keeps refusing does not starve the ones
 * behind it.
 */
export async function listOwedQuarantineDecisionsBetween(
  decidedAfter: Date,
  decidedBefore: Date,
  limit: number
): Promise<DocumentQuarantineDecision[]> {
  const db = getDb()
  return db
    .select()
    .from(documentQuarantineDecisions)
    .where(
      and(
        isNull(documentQuarantineDecisions.auditedAt),
        lt(documentQuarantineDecisions.decidedAt, decidedBefore),
        gt(documentQuarantineDecisions.decidedAt, decidedAfter)
      )
    )
    .orderBy(desc(documentQuarantineDecisions.decidedAt))
    .limit(limit)
}

/** The trail has it. Guarded, so a second sender marks nothing. Returns whether this call marked it. */
export async function markQuarantineDecisionAudited(
  organizationId: string,
  decisionId: string,
  auditedAt: Date
): Promise<boolean> {
  const db = getDb()
  const marked = await withTenant({ organizationId }, () =>
    db
      .update(documentQuarantineDecisions)
      .set({ auditedAt })
      .where(
        and(
          eq(documentQuarantineDecisions.id, decisionId),
          eq(documentQuarantineDecisions.organizationId, organizationId),
          isNull(documentQuarantineDecisions.auditedAt)
        )
      )
      .returning({ id: documentQuarantineDecisions.id })
  )
  return marked.length > 0
}

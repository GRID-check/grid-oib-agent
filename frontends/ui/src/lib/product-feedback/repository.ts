/**
 * Product-feedback repository — the only module that queries `product_feedback`
 * (ADR-0017).
 *
 * Two audiences, and the split is the security story of this file:
 *
 *   - the REPORTER writes one row into their own organization; the row carries
 *     the session's `organizationId`, and RLS's WITH CHECK refuses any other.
 *   - the PLATFORM reads and triages across every organization. Those
 *     functions are deliberately not organization-scoped, because the platform
 *     owner's job is the cross-org view; the guard lives in the service
 *     (`requirePlatformPermission`) and the queries run under the audited
 *     platform bypass that `platformApiRoute` opens. Do not reach them from a
 *     tenant route.
 *
 * Every list is bounded.
 */

import 'server-only'
import { and, count, desc, eq, lt, or, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  organizations,
  productFeedback,
  type NewProductFeedback,
  type ProductFeedback,
  type ProductFeedbackKind,
  type ProductFeedbackStatus,
} from '@/lib/db/schema'

/** Hard cap for one page of the platform triage list. */
export const PRODUCT_FEEDBACK_LIST_LIMIT = 50

/** Insert one report, in the reporter's own organization. */
export async function insertProductFeedback(values: NewProductFeedback): Promise<ProductFeedback> {
  const db = getDb()
  const [row] = await db.insert(productFeedback).values(values).returning()
  return row
}

// ---------------------------------------------------------------------------
// Platform side — cross-tenant, guarded by the service
// ---------------------------------------------------------------------------

/** One report with the name of the organization it came from. */
export interface ProductFeedbackRow extends ProductFeedback {
  organizationName: string | null
}

export interface ListProductFeedbackOptions {
  status?: ProductFeedbackStatus
  kind?: ProductFeedbackKind
  /** Keyset cursor: rows strictly older than this report. */
  before?: { createdAt: Date; id: string }
  limit?: number
}

function listFilters(options: ListProductFeedbackOptions): SQL | undefined {
  const clauses: SQL[] = []
  if (options.status) clauses.push(eq(productFeedback.status, options.status))
  if (options.kind) clauses.push(eq(productFeedback.kind, options.kind))
  if (options.before) {
    const { createdAt, id } = options.before
    const older = or(
      lt(productFeedback.createdAt, createdAt),
      and(eq(productFeedback.createdAt, createdAt), lt(productFeedback.id, id))
    )
    if (older) clauses.push(older)
  }
  return clauses.length > 0 ? and(...clauses) : undefined
}

/** One page of reports across every organization, newest first. */
export async function listProductFeedback(
  options: ListProductFeedbackOptions = {}
): Promise<ProductFeedbackRow[]> {
  const db = getDb()
  const limit = Math.min(options.limit ?? PRODUCT_FEEDBACK_LIST_LIMIT, PRODUCT_FEEDBACK_LIST_LIMIT)
  const rows = await db
    .select({ report: productFeedback, organizationName: organizations.displayName })
    .from(productFeedback)
    .leftJoin(organizations, eq(organizations.workosOrganizationId, productFeedback.organizationId))
    .where(listFilters(options))
    .orderBy(desc(productFeedback.createdAt), desc(productFeedback.id))
    .limit(limit)
  return rows.map((row) => ({ ...row.report, organizationName: row.organizationName ?? null }))
}

/** One report by id, across organizations. */
export async function getProductFeedback(id: string): Promise<ProductFeedbackRow | null> {
  const db = getDb()
  const [row] = await db
    .select({ report: productFeedback, organizationName: organizations.displayName })
    .from(productFeedback)
    .leftJoin(organizations, eq(organizations.workosOrganizationId, productFeedback.organizationId))
    .where(eq(productFeedback.id, id))
    .limit(1)
  return row ? { ...row.report, organizationName: row.organizationName ?? null } : null
}

/** Report counts per status, for the filter chips. One grouped query. */
export async function countProductFeedbackByStatus(): Promise<Record<ProductFeedbackStatus, number>> {
  const db = getDb()
  const rows = await db
    .select({ status: productFeedback.status, value: count() })
    .from(productFeedback)
    .groupBy(productFeedback.status)
  const counts: Record<ProductFeedbackStatus, number> = {
    new: 0,
    in_progress: 0,
    resolved: 0,
    dismissed: 0,
  }
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = Number(row.value)
  }
  return counts
}

/**
 * Move a report to a triage status, attributed to whoever moved it.
 *
 * Moving it back to `new` clears the attribution, because `new` means "nobody
 * on the platform side has looked at it" and the CHECK allows no half state.
 */
export async function updateProductFeedbackStatus(
  id: string,
  status: ProductFeedbackStatus,
  triagedBy: string
): Promise<ProductFeedback | null> {
  const db = getDb()
  const now = new Date()
  const [row] = await db
    .update(productFeedback)
    .set(
      status === 'new'
        ? { status, triagedBy: null, triagedAt: null, updatedAt: now }
        : { status, triagedBy, triagedAt: now, updatedAt: now }
    )
    .where(eq(productFeedback.id, id))
    .returning()
  return row ?? null
}

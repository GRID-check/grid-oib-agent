/**
 * Product feedback — submission by any member, triage by the platform.
 *
 * Owns authorization for both halves (ADR-0017): the routes are thin adapters.
 *
 *   - Submitting needs nothing but a signed-in member: telling us about a bug
 *     must not depend on a feature flag or a role.
 *   - Reading and triaging are platform surfaces and ask for the specific
 *     `platform:*` permission each needs, here as well as on the route, so a
 *     second caller cannot lose the gate.
 *
 * Submission is bounded by the route's `FEEDBACK_REPORT_LIMIT` rather than by
 * anything here: every report becomes an inbox item per platform owner, so the
 * budget is per person and far below the default mutation budget.
 */

import { after } from 'next/server'
import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { requirePlatformPermission } from '@/lib/authz/platform'
import type { ProductFeedback } from '@/lib/db/schema'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { findOrganization } from '@/lib/organizations/repository'
import { announceProductFeedback } from './announce'
import { fileProductFeedbackIssue } from './github'
import {
  countProductFeedbackByStatus,
  getProductFeedback,
  insertProductFeedback,
  listProductFeedback,
  PRODUCT_FEEDBACK_LIST_LIMIT,
  updateProductFeedbackStatus,
  type ProductFeedbackRow,
} from './repository'
import {
  type ListProductFeedbackQuery,
  type ProductFeedbackListResponse,
  type ProductFeedbackReportView,
  type ProductFeedbackStatus,
  type SubmitProductFeedbackInput,
  type SubmittedProductFeedbackView,
} from './types'

/**
 * Store one report from the caller, announce it to the platform owners and,
 * for a bug, file it as a GitHub issue once the response has gone.
 *
 * Neither can fail the request (see `announceProductFeedback` and
 * `fileProductFeedbackIssue`): the stored report is the record, and the triage
 * page lists it whether or not anybody's inbox or the issue tracker heard
 * about it.
 */
export async function submitProductFeedback(
  session: AuthorizedSession,
  input: SubmitProductFeedbackInput
): Promise<SubmittedProductFeedbackView> {
  const report = await insertProductFeedback({
    organizationId: session.organizationId,
    userId: session.userId,
    userName: session.name,
    userEmail: session.email || null,
    kind: input.kind,
    message: input.message,
    pagePath: input.pagePath ?? null,
    context: input.context,
    allowContact: input.allowContact,
  })

  const organization = await findOrganization(session.organizationId).catch(() => null)
  await announceProductFeedback(report, organization?.displayName ?? null)
  // After the response: the reporter's confirmation must not wait on GitHub,
  // whose request is allowed ten seconds. `after` throws outside a Next request
  // lifecycle (unit tests, a script), where waiting is the only way to file.
  try {
    after(() => fileProductFeedbackIssue(report))
  } catch {
    await fileProductFeedbackIssue(report)
  }

  return { id: report.id, kind: report.kind, createdAt: report.createdAt.toISOString() }
}

// ---------------------------------------------------------------------------
// Platform triage
// ---------------------------------------------------------------------------

function toReportView(row: ProductFeedbackRow): ProductFeedbackReportView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    message: row.message,
    pagePath: row.pagePath,
    context: row.context ?? {},
    allowContact: row.allowContact,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    // The address is only handed over when the reporter agreed to be contacted.
    reporter: {
      userId: row.userId,
      name: row.userName,
      email: row.allowContact ? row.userEmail : null,
    },
    triagedBy: row.triagedBy,
    triagedAt: row.triagedAt ? new Date(row.triagedAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

/** `<createdAt ISO>|<id>` — opaque to the client, validated here. */
export function encodeCursor(row: Pick<ProductFeedback, 'createdAt' | 'id'>): string {
  return `${new Date(row.createdAt).toISOString()}|${row.id}`
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined
  const [iso, id] = cursor.split('|')
  const createdAt = new Date(iso ?? '')
  if (!id || Number.isNaN(createdAt.getTime())) return undefined
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined
  return { createdAt, id }
}

/** One page of reports across every organization, plus the status counts. */
export async function listProductFeedbackForPlatform(
  session: GridSession | null,
  query: ListProductFeedbackQuery
): Promise<ProductFeedbackListResponse> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsView)
  return withPlatformAccess('product feedback: triage list', async () => {
    const [rows, counts] = await Promise.all([
      listProductFeedback({
        status: query.status,
        kind: query.kind,
        before: decodeCursor(query.cursor),
        limit: PRODUCT_FEEDBACK_LIST_LIMIT,
      }),
      countProductFeedbackByStatus(),
    ])
    const last = rows.at(-1)
    return {
      reports: rows.map(toReportView),
      counts,
      nextCursor: rows.length === PRODUCT_FEEDBACK_LIST_LIMIT && last ? encodeCursor(last) : null,
    }
  })
}

/** One report, for the deep link an inbox row lands on. */
export async function getProductFeedbackForPlatform(
  session: GridSession | null,
  id: string
): Promise<ProductFeedbackReportView> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsView)
  const row = await withPlatformAccess('product feedback: one report', () => getProductFeedback(id))
  if (!row) throw new NotFoundError('Unknown feedback report.')
  return toReportView(row)
}

/** Move a report through triage, attributed to the caller. */
export async function triageProductFeedback(
  session: GridSession | null,
  id: string,
  status: ProductFeedbackStatus
): Promise<ProductFeedbackReportView> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.settingsManage)
  // requirePlatformPermission throws unless the session is non-null.
  const actor = (session as GridSession).email || (session as GridSession).userId
  return withPlatformAccess('product feedback: triage', async () => {
    const updated = await updateProductFeedbackStatus(id, status, actor)
    if (!updated) throw new NotFoundError('Unknown feedback report.')
    const row = await getProductFeedback(id)
    if (!row) throw new NotFoundError('Unknown feedback report.')
    return toReportView(row)
  })
}

/**
 * The answer-feedback export: which votes, named and linked for the reader,
 * plus what the workbook says about them.
 *
 * Behind the same gate as the page (`platform:organizations:view`), and for the
 * same reason it bypasses row-level security: the reader is the platform owner
 * and the question is cross-tenant. The gate sits here, before any read, so no
 * caller reaches the rows without it.
 *
 * **Scope.** The default export is EVERY vote in the window, both directions,
 * because "give me the feedback" means all of it — the old export followed the
 * drill-in, which defaults to the failures, and handed people a file of
 * down-votes named like the whole thing. `scope: 'selection'` is the explicit
 * other choice: the page's organization, topic, direction, reason and search.
 */

import 'server-only'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { requirePlatformPermission } from '@/lib/authz/platform'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import type { GridSession } from '@/lib/auth/types'
import { configuredAppOrigin } from '@/lib/app-origin'
import { PRODUCT_NAME } from '@/lib/brand'
import { describeResource } from '@/lib/sharing/registry'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import { langfuseTraceUrl, langfuseUiConfig } from '@/lib/langfuse/config'
import {
  FEEDBACK_EXPORT_ROW_CAP,
  FEEDBACK_HEALTH_WINDOW_DAYS,
  getFeedbackWeeklySummary,
  weeklyWindowStart,
  type FeedbackHealthFilters,
} from './repository'
import {
  getFeedbackExportTotals,
  listFeedbackExportRows,
  type FeedbackExportFilters,
  type FeedbackExportRow,
  type FeedbackExportTotals,
} from './export-repository'
import type { FeedbackExportRecord, FeedbackWeeklyRecord } from './export-columns'
import { feedbackWindowStart } from './trend'

export type FeedbackExportScope = 'all' | 'selection'

export interface FeedbackExportRequest {
  scope: FeedbackExportScope
  /** The page's filters, as `parseFeedbackFilters` read them. Only `windowDays` applies to `scope: 'all'`. */
  filters: FeedbackHealthFilters
  /** The workbook's other sheets (totals, weeks). A CSV of the rows does not need them. */
  withSummary: boolean
}

/** Everything the two formats render. */
export interface FeedbackExport {
  generatedAt: Date
  /** UTC midnight of the window's first day: the same calendar days the page counts. */
  windowFrom: Date
  windowTo: Date
  scope: FeedbackExportScope
  /** What was applied, named for the reader; empty for `scope: 'all'`. */
  applied: FeedbackExportFilters & { organizationName: string | null }
  records: FeedbackExportRecord[]
  /** True when the window held more than `cap` votes; the newest `cap` are kept. */
  truncated: boolean
  cap: number
  /** Over the whole set, uncapped. Null without `withSummary`. */
  totals: FeedbackExportTotals | null
  /** Per organization and ISO week; empty without `withSummary`. */
  weeks: FeedbackWeeklyRecord[]
  weeksTruncated: boolean
}

/** The page's filters narrowed to what one scope applies. */
export function exportFilters(scope: FeedbackExportScope, filters: FeedbackHealthFilters): FeedbackExportFilters {
  const windowDays = filters.windowDays ?? FEEDBACK_HEALTH_WINDOW_DAYS
  if (scope === 'all') {
    return { windowDays, verdict: null, reason: null, organizationId: null, topic: null, query: null }
  }
  const verdict = filters.verdict ?? null
  return {
    windowDays,
    verdict,
    reason: verdict === 'down' ? (filters.reason ?? null) : null,
    organizationId: filters.organizationId ?? null,
    topic: filters.topic ?? null,
    query: filters.query ?? null,
  }
}

/**
 * The link to the rated answer in its conversation, or null.
 *
 * Built from the deployment's pinned origin (never the request's Host) and the
 * conversation's own deep link, so it is the link a member of that organization
 * would follow from their inbox. Null when the conversation has no row in the
 * voter's organization: a link to a deleted chat is a 404 with extra steps.
 */
function answerLink(row: FeedbackExportRow, origin: string | null): string | null {
  if (!origin || !row.conversationFound || !row.conversationId) return null
  const path = describeResource('conversation').deepLink(row.conversationId, {
    anchorId: row.messageId,
    projectId: row.projectId,
  })
  return `${origin}${path}`
}

export async function getAnswerFeedbackExport(
  session: GridSession | null,
  request: FeedbackExportRequest,
  now: Date = new Date()
): Promise<FeedbackExport> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsView)
  const filters = exportFilters(request.scope, request.filters)

  const { rows, totals, weekly } = await withPlatformAccess(
    'answer feedback export: cross-organization votes',
    async () => {
      // One row over the cap tells "exactly full" apart from "cut".
      const rows = await listFeedbackExportRows(filters, FEEDBACK_EXPORT_ROW_CAP + 1)
      if (!request.withSummary) return { rows, totals: null, weekly: null }
      const totals = await getFeedbackExportTotals(filters)
      const weekly = await getFeedbackWeeklySummary({
        windowDays: filters.windowDays,
        organizationId: filters.organizationId,
      })
      return { rows, totals, weekly }
    }
  )

  const truncated = rows.length > FEEDBACK_EXPORT_ROW_CAP
  const kept = truncated ? rows.slice(0, FEEDBACK_EXPORT_ROW_CAP) : rows
  const weeks = weekly?.weeks ?? []
  const names = await getOrganizationDisplayNames([
    ...kept.map((row) => row.organizationId),
    ...weeks.map((week) => week.organizationId),
    ...(filters.organizationId ? [filters.organizationId] : []),
  ])
  const nameOf = (organizationId: string): string | null => names.get(organizationId) ?? null
  const ui = langfuseUiConfig()
  const origin = configuredAppOrigin()

  return {
    generatedAt: now,
    windowFrom: feedbackWindowStart(filters.windowDays, now),
    windowTo: now,
    scope: request.scope,
    applied: {
      ...filters,
      organizationName: filters.organizationId ? nameOf(filters.organizationId) : null,
    },
    records: kept.map((row) => ({
      ...row,
      organizationName: nameOf(row.organizationId),
      appUrl: answerLink(row, origin),
      langfuseTraceUrl: langfuseTraceUrl(row.traceId, ui),
    })),
    truncated,
    cap: FEEDBACK_EXPORT_ROW_CAP,
    totals,
    weeks: weeks.map((week) => ({ ...week, organizationName: nameOf(week.organizationId) })),
    weeksTruncated: weekly?.truncated ?? false,
  }
}

/** The weekly rows on their own, for `?summary=weekly`. */
export interface FeedbackWeeklyExport {
  windowFrom: Date
  windowTo: Date
  weeks: FeedbackWeeklyRecord[]
  truncated: boolean
  cap: number
}

/**
 * Per organization and ISO week: answers, rated answers, up- and down-votes —
 * the inputs of a rate. Same gate and same cross-tenant bypass as the rows.
 */
export async function getAnswerFeedbackWeeklyExport(
  session: GridSession | null,
  filters: FeedbackHealthFilters = {},
  now: Date = new Date()
): Promise<FeedbackWeeklyExport> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsView)
  const windowDays = filters.windowDays ?? FEEDBACK_HEALTH_WINDOW_DAYS
  const summary = await withPlatformAccess('answer feedback: weekly rate inputs across organizations', () =>
    getFeedbackWeeklySummary({ windowDays, organizationId: filters.organizationId ?? null })
  )
  const names = await getOrganizationDisplayNames(summary.weeks.map((week) => week.organizationId))
  return {
    windowFrom: new Date(weeklyWindowStart(windowDays, now)),
    windowTo: now,
    weeks: summary.weeks.map((week) => ({ ...week, organizationName: names.get(week.organizationId) ?? null })),
    truncated: summary.truncated,
    cap: summary.cap,
  }
}

/** File-name stem shared by the workbook and the CSV: `piloti-bewertungen`. */
const FILE_STEM = `${PRODUCT_NAME.toLowerCase()}-bewertungen`

const day = (instant: Date): string => instant.toISOString().slice(0, 10)

/**
 * `piloti-bewertungen_<from>_<to>[_auswahl][_erste-<cap>].<ext>`, dates UTC.
 *
 * The window and the scope are in the name because two downloads of the same
 * page are otherwise one folder away from being indistinguishable, and a cut
 * file says so in its name for the person who never sees the response header.
 */
export function feedbackExportFileName(
  data: Pick<FeedbackExport, 'windowFrom' | 'windowTo' | 'scope' | 'truncated' | 'cap'>,
  extension: 'xlsx' | 'csv'
): string {
  const scope = data.scope === 'selection' ? '_auswahl' : ''
  const cut = data.truncated ? `_erste-${data.cap}` : ''
  return `${FILE_STEM}_${day(data.windowFrom)}_${day(data.windowTo)}${scope}${cut}.${extension}`
}

/** `piloti-bewertungen-wochen_<from>_<to>[_erste-<cap>].csv`. */
export function feedbackWeeklyFileName(data: Pick<FeedbackWeeklyExport, 'windowFrom' | 'windowTo' | 'truncated' | 'cap'>): string {
  const cut = data.truncated ? `_erste-${data.cap}` : ''
  return `${FILE_STEM}-wochen_${day(data.windowFrom)}_${day(data.windowTo)}${cut}.csv`
}

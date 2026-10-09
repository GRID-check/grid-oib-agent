/**
 * The answer-feedback export: which votes, named and linked for the reader,
 * plus what the workbook says about them — and the count and per-value numbers
 * the filter pickers and the export dialog show before anything is downloaded.
 *
 * Behind the same gate as the page (`platform:organizations:view`, which the
 * read-only Platform Support role holds), and for the same reason it bypasses
 * row-level security: the reader is the platform owner and the question is
 * cross-tenant. The gate sits here, before any read, so no caller reaches the
 * rows without it.
 *
 * **Which votes.** Exactly the ones the page shows: the page-wide scope (date
 * range, organizations, projects) and the ratings tab's filters, as one
 * `FeedbackQuery`, read in SQL by the same `voteScope` the figures use. "Every
 * vote in the scope" is the same query with the ratings filters cleared
 * (`scope=all` on the route), never a second code path.
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
import { fileSlug } from '@/lib/text/latinize'
import {
  FEEDBACK_EXPORT_ROW_CAP,
  getFeedbackWeeklySummary,
  WEEKLY_APPLIED_RATINGS_FILTERS,
  weeklyWindowStart,
} from './repository'
import {
  countFeedbackVotes,
  getFeedbackExportTotals,
  getFeedbackFacets,
  getProjectNames,
  listFeedbackExportRows,
  type FeedbackExportRow,
  type FeedbackExportTotals,
  type FeedbackFacets,
} from './export-repository'
import type { FeedbackExportRecord, FeedbackWeeklyRecord } from './export-columns'
import { activeRatingsFilterKeys, ratingsFiltered, type FeedbackQuery, type RatingsFilterKey } from './filters'

export interface FeedbackExportRequest {
  query: FeedbackQuery
  /** The workbook's other sheets (totals, weeks). A CSV of the rows does not need them. */
  withSummary: boolean
}

/** An organization or project the request named, with its display name when one resolved. */
export interface NamedScopeEntry {
  id: string
  name: string | null
}

/** The scope's entries, named for the reader. */
export interface NamedScope {
  organizations: NamedScopeEntry[]
  projects: NamedScopeEntry[]
}

/** Everything the two formats render. */
export interface FeedbackExport {
  generatedAt: Date
  /** What was asked for: the scope and the ratings filters. */
  query: FeedbackQuery
  /** The scope's organizations and projects with their names, for the overview and the file name. */
  named: NamedScope
  records: FeedbackExportRecord[]
  /** True when the set held more than `cap` votes; the newest `cap` are kept. */
  truncated: boolean
  cap: number
  /** Over the whole set, uncapped. Null without `withSummary`. */
  totals: FeedbackExportTotals | null
  /** Per organization and ISO week; empty without `withSummary`. */
  weeks: FeedbackWeeklyRecord[]
  weeksTruncated: boolean
  /** The ratings filters the request set that the weekly sheet could not apply (see `WEEKLY_APPLIED_RATINGS_FILTERS`). */
  weeksIgnored: RatingsFilterKey[]
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

/** The ratings filters the weekly sheet leaves out, in the order the page lists them. */
export function weeklyIgnoredFilters(query: FeedbackQuery): RatingsFilterKey[] {
  const applied: readonly RatingsFilterKey[] = WEEKLY_APPLIED_RATINGS_FILTERS
  return activeRatingsFilterKeys(query.ratings).filter((key) => !applied.includes(key))
}

/** Project names for the scope's projects. Read inside the caller's platform bypass. */
async function nameScope(query: FeedbackQuery, organizationNames: Map<string, string>): Promise<NamedScope> {
  const projectNames = await getProjectNames(query.scope.projectIds)
  return {
    organizations: query.scope.organizationIds.map((id) => ({ id, name: organizationNames.get(id) ?? null })),
    projects: query.scope.projectIds.map((id) => ({ id, name: projectNames.get(id) ?? null })),
  }
}

export async function getAnswerFeedbackExport(
  session: GridSession | null,
  request: FeedbackExportRequest,
  now: Date = new Date()
): Promise<FeedbackExport> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsView)
  const { query } = request

  const { rows, totals, weekly, projectNames } = await withPlatformAccess(
    'answer feedback export: cross-organization votes',
    async () => {
      // One row over the cap tells "exactly full" apart from "cut".
      const rows = await listFeedbackExportRows(query, FEEDBACK_EXPORT_ROW_CAP + 1)
      const projectNames = await getProjectNames(query.scope.projectIds)
      if (!request.withSummary) return { rows, totals: null, weekly: null, projectNames }
      const totals = await getFeedbackExportTotals(query)
      const weekly = await getFeedbackWeeklySummary(query)
      return { rows, totals, weekly, projectNames }
    }
  )

  const truncated = rows.length > FEEDBACK_EXPORT_ROW_CAP
  const kept = truncated ? rows.slice(0, FEEDBACK_EXPORT_ROW_CAP) : rows
  const weeks = weekly?.weeks ?? []
  const names = await getOrganizationDisplayNames([
    ...kept.map((row) => row.organizationId),
    ...weeks.map((week) => week.organizationId),
    ...query.scope.organizationIds,
  ])
  const nameOf = (organizationId: string): string | null => names.get(organizationId) ?? null
  const ui = langfuseUiConfig()
  const origin = configuredAppOrigin()

  return {
    generatedAt: now,
    query,
    named: {
      organizations: query.scope.organizationIds.map((id) => ({ id, name: nameOf(id) })),
      projects: query.scope.projectIds.map((id) => ({ id, name: projectNames.get(id) ?? null })),
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
    weeksIgnored: request.withSummary ? weeklyIgnoredFilters(query) : [],
  }
}

/** The weekly rows on their own, for `?summary=weekly`. */
export interface FeedbackWeeklyExport {
  /** Monday of the scope's first ISO week. */
  windowFrom: Date
  query: FeedbackQuery
  named: NamedScope
  weeks: FeedbackWeeklyRecord[]
  truncated: boolean
  cap: number
  /** The ratings filters the request set that a rate cannot honour. */
  ignored: RatingsFilterKey[]
}

/**
 * Per organization and ISO week: answers, rated answers, up- and down-votes —
 * the inputs of a rate. Same gate and same cross-tenant bypass as the rows.
 */
export async function getAnswerFeedbackWeeklyExport(
  session: GridSession | null,
  query: FeedbackQuery
): Promise<FeedbackWeeklyExport> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsView)
  const { summary, organizationNames, named } = await withPlatformAccess(
    'answer feedback: weekly rate inputs across organizations',
    async () => {
      const summary = await getFeedbackWeeklySummary(query)
      const organizationNames = await getOrganizationDisplayNames([
        ...summary.weeks.map((week) => week.organizationId),
        ...query.scope.organizationIds,
      ])
      return { summary, organizationNames, named: await nameScope(query, organizationNames) }
    }
  )
  return {
    windowFrom: new Date(weeklyWindowStart(query.scope)),
    query,
    named,
    weeks: summary.weeks.map((week) => ({ ...week, organizationName: organizationNames.get(week.organizationId) ?? null })),
    truncated: summary.truncated,
    cap: summary.cap,
    ignored: weeklyIgnoredFilters(query),
  }
}

/** What the filter row and the export dialog show before a download: the count and the per-value counts. */
export interface FeedbackFilterOptions extends FeedbackFacets {
  /** Votes matching the whole request, counted up to `cap` (see `overCap`). */
  total: number
  /** Votes in the scope alone, ratings filters ignored: what "every vote in the range" would export. */
  scopeTotal: number
  /** The export's row cap. */
  cap: number
  /** True when more than `cap` votes match; only the newest `cap` would be exported. */
  overCap: boolean
}

/**
 * The live numbers behind the filter pickers and the export dialog. Two bounded
 * reads: the capped count of the whole request and the per-value counts over
 * the scope. Same gate and bypass as the export itself.
 */
export async function getAnswerFeedbackFilterOptions(
  session: GridSession | null,
  query: FeedbackQuery
): Promise<FeedbackFilterOptions> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsView)
  const { counted, facets } = await withPlatformAccess(
    'answer feedback: filter options across organizations',
    async () => ({
      counted: await countFeedbackVotes(query, FEEDBACK_EXPORT_ROW_CAP),
      facets: await getFeedbackFacets(query),
    })
  )
  return {
    ...facets,
    total: Math.min(counted, FEEDBACK_EXPORT_ROW_CAP),
    scopeTotal: facets.verdicts.up + facets.verdicts.down,
    cap: FEEDBACK_EXPORT_ROW_CAP,
    overCap: counted > FEEDBACK_EXPORT_ROW_CAP,
  }
}

/** File-name stem shared by the workbook and the CSV: `piloti-bewertungen`. */
const FILE_STEM = `${PRODUCT_NAME.toLowerCase()}-bewertungen`

const day = (instant: Date): string => instant.toISOString().slice(0, 10)

/** The organization's slug when the request names exactly one, else nothing. */
function organizationSegment(named: NamedScope): string {
  if (named.organizations.length !== 1) return ''
  const [only] = named.organizations
  const slug = fileSlug(only.name ?? only.id, { maxLength: 40 })
  return slug ? `_${slug}` : ''
}

/**
 * True when the file holds less than "every vote of the named organization (or
 * of all of them) in the range": a ratings filter, a project, or more than one
 * organization (one is already in the name).
 */
function narrowedBeyondName(query: FeedbackQuery): boolean {
  return (
    ratingsFiltered(query.ratings) || query.scope.projectIds.length > 0 || query.scope.organizationIds.length > 1
  )
}

/**
 * `piloti-bewertungen[_<org>]_<from>_<to>[_gefiltert][_erste-<cap>].<ext>`, dates UTC.
 *
 * The organization is named when the file is about exactly one, because that is
 * the file somebody forwards to that customer. `_gefiltert` says the file is a
 * subset of what its name otherwise promises, and a cut file says so for the
 * person who never sees the response header.
 */
export function feedbackExportFileName(
  data: Pick<FeedbackExport, 'query' | 'named' | 'truncated' | 'cap'>,
  extension: 'xlsx' | 'csv'
): string {
  const { scope } = data.query
  const filtered = narrowedBeyondName(data.query) ? '_gefiltert' : ''
  const cut = data.truncated ? `_erste-${data.cap}` : ''
  return `${FILE_STEM}${organizationSegment(data.named)}_${scope.from}_${scope.to}${filtered}${cut}.${extension}`
}

/** `piloti-bewertungen-wochen[_<org>]_<monday>_<to>[_erste-<cap>].csv`. */
export function feedbackWeeklyFileName(
  data: Pick<FeedbackWeeklyExport, 'windowFrom' | 'query' | 'named' | 'truncated' | 'cap'>
): string {
  const cut = data.truncated ? `_erste-${data.cap}` : ''
  return `${FILE_STEM}-wochen${organizationSegment(data.named)}_${day(data.windowFrom)}_${data.query.scope.to}${cut}.csv`
}

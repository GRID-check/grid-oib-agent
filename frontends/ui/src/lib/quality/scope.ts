/**
 * The scope every view on Platform → Answer quality is read in: a date range
 * and, optionally, a set of organizations and projects.
 *
 * One definition shared by the page's filter bar, the URL, and every endpoint
 * the three views call (ratings, citation checks, runtime) and the export, so
 * "these two organizations, last quarter" means the same rows on every tab.
 * The parameter names are the same on the page URL and on the API: `from`,
 * `to`, `org` (repeatable), `project` (repeatable).
 *
 * Dates are UTC calendar days, inclusive at both ends, matching how the
 * ratings and citation windows already bucket (`YYYY-MM-DD`). A preset (7, 30,
 * 90 days) is only a shorthand for a range that ends today.
 */

export const QUALITY_RANGE_PRESETS = [7, 30, 90] as const
export type QualityRangePreset = (typeof QUALITY_RANGE_PRESETS)[number]

/** The longest range any quality endpoint accepts, in days (inclusive). */
export const QUALITY_MAX_RANGE_DAYS = 366

export const DEFAULT_QUALITY_RANGE_DAYS: QualityRangePreset = 30

export interface QualityScope {
  /** First day, `YYYY-MM-DD`, UTC, inclusive. */
  from: string
  /** Last day, `YYYY-MM-DD`, UTC, inclusive. */
  to: string
  /** Empty means every organization. */
  organizationIds: string[]
  /** Empty means every project (within the chosen organizations). */
  projectIds: string[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` for a Date, in UTC. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** True for a real calendar day written `YYYY-MM-DD`. */
export function isIsoDay(value: string | null | undefined): value is string {
  if (!value || !ISO_DAY.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === value
}

/** Inclusive length of a range in days (`from == to` is 1). */
export function rangeDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}

/** The range a preset stands for: the last `days` days, ending today (UTC). */
export function presetRange(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = utcDay(now)
  const from = utcDay(new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS))
  return { from, to }
}

/** The preset a range equals, if it is one (ends today and spans 7/30/90 days). */
export function matchingPreset(
  scope: Pick<QualityScope, 'from' | 'to'>,
  now: Date = new Date()
): QualityRangePreset | null {
  if (scope.to !== utcDay(now)) return null
  const days = rangeDays(scope.from, scope.to)
  return (QUALITY_RANGE_PRESETS as readonly number[]).includes(days)
    ? (days as QualityRangePreset)
    : null
}

/** Distinct, non-empty, trimmed values of a repeatable parameter, in first-seen order. */
function idList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/**
 * Read a scope from URL parameters, falling back to the default range for
 * anything missing or invalid. Lenient on purpose: this reads the PAGE URL,
 * where a stale or hand-edited link should open a sensible view rather than an
 * error. The API side validates strictly (`parseQualityScopeStrict`).
 *
 * Accepts the older `days=7|30|90` shorthand so links made before the range
 * picker keep working.
 */
export function readQualityScope(params: URLSearchParams, now: Date = new Date()): QualityScope {
  const organizationIds = idList(params.getAll('org'))
  const projectIds = idList(params.getAll('project'))
  const from = params.get('from')
  const to = params.get('to')
  if (
    isIsoDay(from) &&
    isIsoDay(to) &&
    from <= to &&
    rangeDays(from, to) <= QUALITY_MAX_RANGE_DAYS
  ) {
    return { from, to, organizationIds, projectIds }
  }
  const days = Number(params.get('days'))
  const preset = (QUALITY_RANGE_PRESETS as readonly number[]).includes(days)
    ? days
    : DEFAULT_QUALITY_RANGE_DAYS
  return { ...presetRange(preset, now), organizationIds, projectIds }
}

export type QualityScopeError = 'invalid_from' | 'invalid_to' | 'range_inverted' | 'range_too_long'

/**
 * Read a scope from API query parameters, strictly: a malformed or oversized
 * range is an error the route answers with 400, never a silent fallback that
 * returns a different window than the caller asked for. Missing `from`/`to`
 * fall back to `days` (7/30/90, default 30) so existing callers keep working.
 */
export function parseQualityScopeStrict(
  params: URLSearchParams,
  now: Date = new Date()
): { ok: true; scope: QualityScope } | { ok: false; error: QualityScopeError } {
  const organizationIds = idList(params.getAll('org'))
  const projectIds = idList(params.getAll('project'))
  const from = params.get('from')
  const to = params.get('to')
  if (from === null && to === null) {
    const days = Number(params.get('days'))
    const preset = (QUALITY_RANGE_PRESETS as readonly number[]).includes(days)
      ? days
      : DEFAULT_QUALITY_RANGE_DAYS
    return { ok: true, scope: { ...presetRange(preset, now), organizationIds, projectIds } }
  }
  if (!isIsoDay(from)) return { ok: false, error: 'invalid_from' }
  if (!isIsoDay(to)) return { ok: false, error: 'invalid_to' }
  if (from > to) return { ok: false, error: 'range_inverted' }
  if (rangeDays(from, to) > QUALITY_MAX_RANGE_DAYS) return { ok: false, error: 'range_too_long' }
  return { ok: true, scope: { from, to, organizationIds, projectIds } }
}

/** Write a scope into URL parameters (replacing any scope keys already there). */
export function writeQualityScope(params: URLSearchParams, scope: QualityScope): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const key of ['from', 'to', 'days', 'org', 'project']) next.delete(key)
  next.set('from', scope.from)
  next.set('to', scope.to)
  for (const id of scope.organizationIds) next.append('org', id)
  for (const id of scope.projectIds) next.append('project', id)
  return next
}

/** The scope as an API query string, for fetches and download links. */
export function qualityScopeQuery(scope: QualityScope): string {
  return writeQualityScope(new URLSearchParams(), scope).toString()
}

/**
 * Server-side bounds for SQL: `[start, endExclusive)` as Dates, UTC midnight.
 * Every quality query filters `created_at >= start and created_at < endExclusive`.
 */
export function scopeBounds(scope: Pick<QualityScope, 'from' | 'to'>): {
  start: Date
  endExclusive: Date
} {
  const start = new Date(`${scope.from}T00:00:00Z`)
  const endExclusive = new Date(Date.parse(`${scope.to}T00:00:00Z`) + DAY_MS)
  return { start, endExclusive }
}

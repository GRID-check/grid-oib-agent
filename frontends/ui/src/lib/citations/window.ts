/**
 * Citation-health window parsing. Deliberately dependency-free (no
 * `server-only`, no DB): the routes need it, and route tests that mock the
 * service module must still exercise the REAL parsing rather than a stub.
 */

/** Window bounds, matching the platform spend trend's 1–90 day range. */
export const MIN_WINDOW_DAYS = 1
export const MAX_WINDOW_DAYS = 90
export const DEFAULT_WINDOW_DAYS = 30

export function clampWindowDays(days: number | undefined): number {
  if (!Number.isFinite(days)) return DEFAULT_WINDOW_DAYS
  return Math.min(Math.max(Math.floor(days as number), MIN_WINDOW_DAYS), MAX_WINDOW_DAYS)
}

/**
 * Read a `?days=` query param into a window, or `undefined` to take the default.
 *
 * Absent, blank, non-numeric and non-positive values all mean "unspecified" and
 * must fall through to the 30-day default — NOT to the 1-day floor
 * `clampWindowDays` would produce. (`Number(null)` and `Number('')` are both 0,
 * which is finite, so a naive `Number()` turns a missing param into a one-day
 * window and shows the operator a near-empty dashboard.)
 */
export function parseWindowDaysParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

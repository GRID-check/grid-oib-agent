/**
 * Cron scheduling helpers for workflows (ADR-0023, docs/architecture/workflows.md).
 *
 * All cron expressions are 5-field (minute hour day-of-month month day-of-week)
 * with a per-workflow IANA timezone. `cron-parser` handles DST. Validation runs
 * at save time in the BFF; the scheduler reuses `nextOccurrence` to advance a
 * claimed row before firing (at-most-once semantics).
 */

import { CronExpressionParser } from 'cron-parser'
import { BadRequestError } from '@/lib/api/errors'

export const DEFAULT_MIN_INTERVAL_MINUTES = 15

/** Minimum cadence accepted at save time (GRID_WORKFLOW_MIN_INTERVAL_MINUTES). */
export function minIntervalMinutesFromEnv(): number {
  const raw = Number.parseInt(process.env.GRID_WORKFLOW_MIN_INTERVAL_MINUTES ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_INTERVAL_MINUTES
}

/** True when `tz` is an IANA timezone the runtime's Intl database recognizes. */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false
  try {
    // Throws RangeError for an unknown/ill-formed timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Exactly 5 whitespace-separated fields (reject 6-field "with seconds" cron). */
export function isFiveFieldCron(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5
}

/** Lightweight format+parse check (no min-interval); used by zod refinements. */
export function isValidCronExpression(expr: string, tz = 'UTC'): boolean {
  if (!isFiveFieldCron(expr)) return false
  try {
    CronExpressionParser.parse(expr, { tz: isValidTimezone(tz) ? tz : 'UTC' })
    return true
  } catch {
    return false
  }
}

/**
 * The next occurrence STRICTLY after `after`, in the workflow's timezone.
 * `cron-parser` excludes `currentDate` itself, so this is always in the future
 * relative to `after` — the property the scheduler relies on to advance a row
 * past the occurrence it just claimed (misfires coalesce, no backfill).
 */
export function nextOccurrence(expr: string, tz: string, after: Date): Date {
  const interval = CronExpressionParser.parse(expr, { tz, currentDate: after })
  // next() is already exclusive of currentDate, but guard against any
  // sub-second edge so the "strictly > after" contract always holds — the
  // scheduler's copy (scheduler/cron.js) carries the identical guard; keep
  // both aligned or a save-time next_run_at could be immediately "due".
  let next = interval.next().toDate()
  while (next.getTime() <= after.getTime()) {
    next = interval.next().toDate()
  }
  return next
}

/**
 * Full save-time validation: 5-field shape, valid IANA timezone, parseable, and
 * a smallest gap between successive occurrences ≥ the minimum interval. Throws
 * BadRequestError (→ 400) on any failure so routes surface a clear message.
 */
export function validateCron(
  expr: string,
  tz: string,
  minIntervalMinutes: number = minIntervalMinutesFromEnv(),
): void {
  if (!isFiveFieldCron(expr)) {
    throw new BadRequestError(
      'Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week).',
    )
  }
  if (!isValidTimezone(tz)) {
    throw new BadRequestError(`Unknown timezone: ${tz}`)
  }

  let interval: ReturnType<typeof CronExpressionParser.parse>
  try {
    interval = CronExpressionParser.parse(expr, { tz, currentDate: new Date() })
  } catch (err) {
    throw new BadRequestError(`Invalid cron expression: ${(err as Error).message}`)
  }

  // Sample successive occurrences and enforce the minimum gap. Sampling (rather
  // than parsing the fields) is DST-correct because the library computes real
  // wall-clock occurrences in the target timezone.
  const minMs = minIntervalMinutes * 60_000
  let prev = interval.next().toDate()
  for (let i = 0; i < 6; i += 1) {
    const current = interval.next().toDate()
    if (current.getTime() - prev.getTime() < minMs) {
      throw new BadRequestError(
        `Schedule fires more frequently than the minimum interval of ${minIntervalMinutes} minutes.`,
      )
    }
    prev = current
  }
}

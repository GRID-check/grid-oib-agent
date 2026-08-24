/**
 * Cron helper for the skill scheduler.
 *
 * `nextOccurrence(expr, tz, after)` returns the next firing time of a 5-field
 * cron expression in the given IANA timezone that is STRICTLY after `after`,
 * as a JS Date. The scheduler always passes `now` (not the stale next_run_at),
 * so misfire coalescing comes for free: after downtime a skill fires once
 * and jumps straight to its next future slot instead of backfilling every
 * missed occurrence.
 *
 * Timezone/DST handling is delegated to cron-parser (v5).
 */

const { CronExpressionParser } = require('cron-parser')

/**
 * @param {string} expr - 5-field cron expression (validated at save time).
 * @param {string} [tz] - IANA timezone name; defaults to UTC.
 * @param {Date}   after - occurrences must be strictly greater than this.
 * @returns {Date} the next occurrence, strictly > after.
 * @throws if the expression is unparseable.
 */
function nextOccurrence(expr, tz, after) {
  const timezone = tz || 'UTC'
  const interval = CronExpressionParser.parse(expr, {
    currentDate: after,
    tz: timezone,
  })
  // cron-parser's next() is already exclusive of currentDate, but guard against
  // any sub-second edge so the contract ("strictly > after") always holds.
  let next = interval.next().toDate()
  while (next.getTime() <= after.getTime()) {
    next = interval.next().toDate()
  }
  return next
}

module.exports = { nextOccurrence }

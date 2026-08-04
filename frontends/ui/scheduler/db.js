/**
 * grid_app SQL helpers for the workflow scheduler (purger idiom: a small
 * createSql() over the `postgres` client, plus pure functions that take a
 * postgres.js tagged-template so they are trivially unit-testable with a fake).
 */

const postgres = require('postgres')

function createSql() {
  const url = process.env.GRID_APP_DATABASE_URL
  if (!url) throw new Error('GRID_APP_DATABASE_URL is not defined')
  return postgres(url, { prepare: false })
}

const LOG = '[workflow-scheduler]'
const PRUNE_BATCH = 1000

// The scheduler scans every organization's workflows for the ones due now, so
// its statements run under the shared platform step-up (ADR-0041). Without it
// the due-scan returns zero rows and the scheduler goes quiet rather than
// failing — the worst way for a timer to break.
const { PLATFORM_ROLE, enterPlatformScope } = require('../workers/platform-scope')

/**
 * Claim due workflows and advance their schedules — the whole thing in ONE
 * transaction so the claim + the next_run_at advance commit atomically. Only
 * after this commits does the caller fire the runs. That ordering is what makes
 * scheduling at-most-once per occurrence across any number of replicas
 * (FOR UPDATE SKIP LOCKED) and across crashes (a crash after commit but before
 * firing misses one occurrence rather than double-firing an expensive job).
 *
 * For each claimed row `computeNext(schedule_cron, schedule_timezone)` returns
 * the next occurrence strictly in the future. A row whose cron is unparseable
 * (should be impossible — validated at write time) is disabled with a loud log
 * and skipped, so one bad row can never wedge the due-scan.
 *
 * @param sql      postgres.js client (or fake) exposing `.begin`.
 * @param batch    max rows to claim this tick.
 * @param computeNext (cron, tz) => Date strictly in the future.
 * @returns the array of claimed rows that were fired-worthy (advanced, enabled).
 */
async function claimDue(sql, batch, computeNext) {
  return sql.begin(async (tx) => {
    await enterPlatformScope(tx)
    const rows = await tx`
      SELECT id, schedule_cron, schedule_timezone
      FROM workflows
      WHERE enabled AND schedule_cron IS NOT NULL AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    `
    const claimed = []
    for (const row of rows) {
      let next
      try {
        next = computeNext(row.schedule_cron, row.schedule_timezone)
      } catch (error) {
        // Unparseable cron on an enabled, scheduled row is a should-be-impossible
        // invariant break (cron is validated in the BFF at save time). Disable
        // the row loudly instead of letting it wedge every subsequent due-scan.
        console.error(
          `${LOG} workflow ${row.id} has an unparseable cron ${JSON.stringify(row.schedule_cron)} ` +
            `(tz ${JSON.stringify(row.schedule_timezone)}) — disabling it. This should be impossible; ` +
            `cron is validated at save time.`,
          error,
        )
        await tx`
          UPDATE workflows SET enabled = false, next_run_at = NULL WHERE id = ${row.id}
        `
        continue
      }
      await tx`
        UPDATE workflows SET next_run_at = ${next} WHERE id = ${row.id}
      `
      claimed.push(row)
    }
    return claimed
  })
}

/**
 * Retention: delete workflow_runs older than the window, in index-friendly
 * batches (id-subselect with LIMIT so each statement locks a bounded set and
 * the created_at index does the work). Returns the total rows deleted.
 */
async function pruneOldRuns(sql, retentionDays) {
  let total = 0
  for (;;) {
    // One transaction per batch: the platform scope has to be re-entered for
    // each, and keeping them separate preserves the existing batching contract
    // (a long backlog is worked off without one long lock).
    const deleted = await sql.begin(async (tx) => {
      await enterPlatformScope(tx)
      return tx`
        DELETE FROM workflow_runs
        WHERE id IN (
          SELECT id FROM workflow_runs
          WHERE created_at < now() - make_interval(days => ${retentionDays})
          ORDER BY created_at
          LIMIT ${PRUNE_BATCH}
        )
        RETURNING id
      `
    })
    total += deleted.length
    if (deleted.length < PRUNE_BATCH) break
  }
  return total
}

module.exports = { createSql, claimDue, pruneOldRuns, PRUNE_BATCH, PLATFORM_ROLE }

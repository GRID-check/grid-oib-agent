/**
 * grid_app SQL helpers for the job scheduler (purger idiom: a small
 * createSql() over the `postgres` client, plus pure functions that take a
 * postgres.js tagged-template so they are trivially unit-testable with a fake).
 */

const postgres = require('postgres')

/**
 * The scheduler's own postgres-js client, connecting as `grid_app_rw` like the
 * BFF. Its work spans tenants, so every transaction steps up to the platform
 * role explicitly (see `withPlatformScope`) rather than this connection being
 * privileged (ADR-0041).
 */
function createSql() {
  const url = process.env.GRID_APP_DATABASE_URL
  if (!url) throw new Error('GRID_APP_DATABASE_URL is not defined')
  return postgres(url, { prepare: false })
}

const LOG = '[job-scheduler]'
const PRUNE_BATCH = 1000

// The scheduler scans every organization's jobs for the ones due now, so its
// statements run under the shared platform step-up (ADR-0041).
// Without it the due-scan returns zero rows and the scheduler goes quiet
// rather than failing — the worst way for a timer to break.
const { PLATFORM_ROLE, enterPlatformScope } = require('../workers/platform-scope')

/**
 * Claim due definitions and advance them — the whole thing in ONE
 * transaction so the claim + the next_run_at advance commit atomically. Only
 * after this commits does the caller fire the runs. That ordering is what makes
 * scheduling at-most-once per occurrence across any number of replicas
 * (FOR UPDATE SKIP LOCKED) and across crashes (a crash after commit but before
 * firing misses one occurrence rather than double-firing an expensive run).
 *
 * The due-scan is backed by the partial index `idx_task_definitions_due`
 * (next_run_at WHERE enabled AND next_run_at IS NOT NULL, migration 0090),
 * whose predicate this WHERE clause must keep matching for the scan to stay an
 * index scan. The claim lives on `task_definitions` since migration 0086
 * collapsed jobs and delegated tasks into one entity — the trigger is a
 * property of the work.
 *
 * TWO shapes come off that scan, and the difference is what happens after the
 * claim, not how it is found:
 *
 *   - `schedule` — recurring. `computeNext(schedule_cron, schedule_timezone)`
 *     returns the next occurrence strictly in the future and the row keeps its
 *     place in the index. A row whose cron is unparseable (should be impossible
 *     — validated at write time) is disabled with a loud log and skipped, so
 *     one bad row can never wedge the due-scan.
 *   - `once` — a one-shot with a due date (0090). Its `next_run_at` is NULLED,
 *     which takes it out of the partial index and out of `next_run_at <= now()`
 *     forever. That is the SAME at-most-once mechanism the recurring path gets
 *     from advancing, rather than a second one invented for one-shots.
 *
 * `enabled` is deliberately untouched on a fired one-shot: it is the person's
 * pause switch, and a finished task is not a paused one.
 *
 * @param sql      postgres.js client (or fake) exposing `.begin`.
 * @param batch    max rows to claim this tick.
 * @param computeNext (cron, tz) => Date strictly in the future.
 * @returns the array of claimed rows that were fired-worthy (retired or advanced).
 */
async function claimDue(sql, batch, computeNext) {
  return sql.begin(async (tx) => {
    await enterPlatformScope(tx)
    const rows = await tx`
      SELECT id, trigger, schedule_cron, schedule_timezone
      FROM task_definitions
      WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    `
    const claimed = []
    for (const row of rows) {
      // A one-shot retires instead of advancing: NULL takes it out of the
      // partial index and out of `next_run_at <= now()`, so it can never be
      // claimed a second time. `enabled` stays as the person left it.
      if (row.trigger === 'once') {
        await tx`
          UPDATE task_definitions SET next_run_at = NULL WHERE id = ${row.id}
        `
        claimed.push(row)
        continue
      }
      // Neither recurring nor a one-shot, yet holding a due time: the write
      // boundary cannot produce this. Clear the stale time so it leaves the
      // index, and do NOT fire — a `manual` definition runs when a person says
      // so, and guessing otherwise would spend somebody's budget unasked.
      if (row.trigger !== 'schedule') {
        console.error(
          `${LOG} definition ${row.id} is ${JSON.stringify(row.trigger)} but had a due time — ` +
            `clearing it without firing. This should be impossible.`,
        )
        await tx`
          UPDATE task_definitions SET next_run_at = NULL WHERE id = ${row.id}
        `
        continue
      }
      let next
      try {
        next = computeNext(row.schedule_cron, row.schedule_timezone)
      } catch (error) {
        // Unparseable cron on an enabled, scheduled row is a should-be-impossible
        // invariant break (cron is validated in the BFF at save time). Disable
        // the row loudly instead of letting it wedge every subsequent due-scan.
        console.error(
          `${LOG} definition ${row.id} has an unparseable cron ${JSON.stringify(row.schedule_cron)} ` +
            `(tz ${JSON.stringify(row.schedule_timezone)}) — disabling it. This should be impossible; ` +
            `cron is validated at save time.`,
          error,
        )
        await tx`
          UPDATE task_definitions SET enabled = false, next_run_at = NULL WHERE id = ${row.id}
        `
        continue
      }
      await tx`
        UPDATE task_definitions SET next_run_at = ${next} WHERE id = ${row.id}
      `
      claimed.push(row)
    }
    return claimed
  })
}

/**
 * Retention: delete task_runs older than the window, in index-friendly
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
        DELETE FROM task_runs
        WHERE id IN (
          SELECT id FROM task_runs
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

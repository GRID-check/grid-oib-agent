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

/**
 * How long after a chat was erased its traces are still looked for. The BFF
 * erases a chat in the delete request and closes its queue row as 'purged';
 * this is the window in which the scheduler goes back for the traces. Past it
 * the retention sweep (`GRID_LANGFUSE_TRACE_RETENTION_DAYS`) is what removes
 * them, so it need only outlast the longest outage worth recovering from.
 */
const TRACE_ERASURE_WINDOW_DAYS = 35
/**
 * How long a chat must have been gone before its traces are looked for. A turn
 * still streaming when the chat was deleted exports spans for a little while
 * afterwards, and an erasure that ran first would be stamped done and miss them.
 */
const TRACE_ERASURE_SETTLE_MINUTES = 15

/**
 * Conversations the BFF has erased (its queue row is 'purged') whose Langfuse
 * traces have not been erased yet, oldest first. A chat the purger erased
 * itself is in here too: its traces were just erased, the repeat is a list
 * that finds nothing, and one code path is cheaper than a second one to tell
 * them apart.
 *
 * A conversation under a legal hold is not returned: the hold keeps its traces,
 * exactly as it keeps everything else (`grid_legal_hold_blocks`, the one
 * predicate the purger and the BFF's deletes share). It becomes a candidate
 * again, inside the window, once the hold is released.
 *
 * @param {object} sql  postgres.js client (or fake) exposing `.begin`
 * @param {number} limit
 * @returns {Promise<{ id: string, entity_id: string, organization_id: string }[]>}
 */
async function findConversationsAwaitingTraceErasure(sql, limit) {
  return sql.begin(async (tx) => {
    await enterPlatformScope(tx)
    return tx`
      SELECT q.id, q.entity_id, q.organization_id
      FROM deletion_queue q
      WHERE q.entity_type = 'conversation'
        AND q.status = 'purged'
        AND q.purged_at >= now() - make_interval(days => ${TRACE_ERASURE_WINDOW_DAYS})
        AND q.purged_at <= now() - make_interval(mins => ${TRACE_ERASURE_SETTLE_MINUTES})
        AND (q.payload IS NULL OR q.payload->>'langfuseTracesErasedAt' IS NULL)
        AND NOT grid_legal_hold_blocks(q.entity_type, q.entity_id, q.organization_id)
      ORDER BY q.purged_at
      LIMIT ${limit}
    `
  })
}

/**
 * The hold re-check made immediately before a conversation's traces are
 * deleted: a hold placed since the candidates were read still keeps them.
 *
 * @param {object} sql
 * @param {{ entity_id: string, organization_id: string }} row
 * @returns {Promise<boolean>}
 */
async function conversationIsHeld(sql, row) {
  const rows = await sql.begin(async (tx) => {
    await enterPlatformScope(tx)
    return tx`
      SELECT grid_legal_hold_blocks('conversation', ${row.entity_id}, ${row.organization_id}) AS held
    `
  })
  return rows[0]?.held === true
}

/**
 * Record that a conversation's traces were erased, on its queue row
 * (`payload.langfuseTracesErasedAt`), so no later run repeats it. A payload
 * that is not a JSON object is replaced rather than appended to.
 *
 * @param {object} sql
 * @param {string} queueId
 * @returns {Promise<void>}
 */
async function markConversationTracesErased(sql, queueId) {
  await sql.begin(async (tx) => {
    await enterPlatformScope(tx)
    await tx`
      UPDATE deletion_queue
      SET payload = (CASE WHEN jsonb_typeof(payload) = 'object' THEN payload ELSE '{}'::jsonb END)
                    || jsonb_build_object('langfuseTracesErasedAt', now())
      WHERE id = ${queueId}
    `
  })
}

/**
 * The download log's retention (migration 0114, `lib/download-log/kinds.ts`):
 * twelve months at most, whatever anyone stored, and an organization may choose
 * a shorter time between 30 and 364 days (`organizations.settings
 * .downloadLogRetentionDays`; 365 is the default and needs no row). A stored
 * value outside 30-365, or not a whole number, counts as unset, exactly as the
 * app reads it (`retentionDaysFromSettings`), so the sweep never purges earlier
 * than the page promises.
 */
const DOWNLOAD_LOG_MAX_DAYS = 365
const DOWNLOAD_LOG_MIN_DAYS = 30
const DOWNLOAD_LOG_BATCH = 1000

/**
 * Delete download-log rows past their retention, in bounded batches: one
 * statement per batch, each in its own platform-scope transaction (the table is
 * RLS-secured and only the platform role may delete, by trigger), at most
 * `maxBatches` statements in all so a backlog drains over several runs.
 *
 * First everything older than the longest retention, for every organization
 * (`document_access_log_occurred_idx`), then, per organization with a shorter
 * setting, its own cutoff (`document_access_log_org_time_idx`).
 *
 * @param {object} sql  postgres.js client (or fake) exposing `.begin`
 * @param {{ batch?: number, maxBatches?: number }} [options]
 * @returns {Promise<{ deleted: number, capped: boolean }>} `capped` when the
 *   budget ran out with a full batch still being deleted, so more may remain.
 */
async function pruneDownloadLog(sql, { batch = DOWNLOAD_LOG_BATCH, maxBatches = 50 } = {}) {
  let deleted = 0
  let used = 0

  // One batch; true when it was full, i.e. there may be more behind it.
  const deleteBatch = async (organizationId, days) => {
    used += 1
    const rows = await sql.begin(async (tx) => {
      await enterPlatformScope(tx)
      if (organizationId === null) {
        return tx`
          DELETE FROM document_access_log
          WHERE id IN (
            SELECT id FROM document_access_log
            WHERE occurred_at < now() - make_interval(days => ${days})
            ORDER BY occurred_at
            LIMIT ${batch}
          )
          RETURNING id
        `
      }
      return tx`
        DELETE FROM document_access_log
        WHERE id IN (
          SELECT id FROM document_access_log
          WHERE organization_id = ${organizationId}
            AND occurred_at < now() - make_interval(days => ${days})
          ORDER BY occurred_at
          LIMIT ${batch}
        )
        RETURNING id
      `
    })
    deleted += rows.length
    return rows.length === batch
  }

  while (used < maxBatches && (await deleteBatch(null, DOWNLOAD_LOG_MAX_DAYS))) {
    /* keep going while batches are full */
  }
  if (used >= maxBatches) return { deleted, capped: true }

  const organizations = await sql.begin(async (tx) => {
    await enterPlatformScope(tx)
    // The CASE keeps the cast from running on a value the regex rejected: the
    // planner is free to evaluate the AND arms in either order.
    return tx`
      SELECT workos_organization_id AS organization_id,
             (settings->>'downloadLogRetentionDays')::int AS days
      FROM organizations
      WHERE CASE
        WHEN settings->>'downloadLogRetentionDays' ~ '^[0-9]{1,4}$'
          THEN (settings->>'downloadLogRetentionDays')::int BETWEEN ${DOWNLOAD_LOG_MIN_DAYS} AND ${DOWNLOAD_LOG_MAX_DAYS - 1}
        ELSE false
      END
      ORDER BY workos_organization_id
      LIMIT 10000
    `
  })
  for (const organization of organizations) {
    while (used < maxBatches && (await deleteBatch(organization.organization_id, organization.days))) {
      /* keep going while batches are full */
    }
    if (used >= maxBatches) return { deleted, capped: true }
  }
  return { deleted, capped: false }
}

module.exports = {
  createSql,
  pruneDownloadLog,
  DOWNLOAD_LOG_MAX_DAYS,
  DOWNLOAD_LOG_MIN_DAYS,
  claimDue,
  pruneOldRuns,
  findConversationsAwaitingTraceErasure,
  conversationIsHeld,
  markConversationTracesErased,
  PRUNE_BATCH,
  PLATFORM_ROLE,
  TRACE_ERASURE_SETTLE_MINUTES,
  TRACE_ERASURE_WINDOW_DAYS,
}

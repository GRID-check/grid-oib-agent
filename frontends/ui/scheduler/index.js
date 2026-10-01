/**
 * GRID job scheduler service.
 *
 * Dedicated container (frontend image, `node scheduler/index.js`) — the exact
 * deployment shape of the purger. Each tick (default 30s) it:
 *   1. claims due `task_definitions` and advances their next_run_at, atomically,
 *      via FOR UPDATE SKIP LOCKED (db.claimDue) — replica- and crash-safe;
 *   2. AFTER that transaction commits, POSTs each claimed definition to the BFF
 *      internal fire endpoint (which records the run row + submits the run);
 *   3. prunes `task_runs` older than the retention window;
 *   4. POSTs the BFF's run reconciler (`/api/internal/runs/reconcile`), which
 *      closes the runs whose ending never reached the BFF by asking the job
 *      store, and settles the block of any closed run that still reads
 *      „läuft" (`lib/runs/reconcile.ts`, backlog T3-11).
 * See ADR-0046 and docs/architecture/agent-skills.md ("Scheduler worker").
 *
 * Environment:
 *   GRID_APP_DATABASE_URL              - grid_app Postgres DSN (required)
 *   FRONTEND_INTERNAL_URL              - BFF base URL (default http://frontend:3000)
 *   GRID_INTERNAL_API_TOKEN            - shared token for the internal fire endpoint
 *   GRID_SKILL_SCHEDULER_POLL_MS       - tick interval (default 30000)
 *   GRID_SKILL_SCHEDULER_BATCH         - max claims per tick (default 20)
 *   GRID_SKILL_RUNS_RETENTION_DAYS     - run-history retention (default 90)
 *
 * Schedules gate (steps 1-3): only when GRID_SKILLS_ENABLED=true or
 * GRID_ENFORCE_FEATURE_FLAGS=true. Step 4 runs regardless, because runs exist
 * without Agent Skills: a chat question escalated to deep research is a
 * `task_runs` row with no definition behind it (ADR-0062). With the gate off the
 * container is a reconcile-only worker rather than exiting.
 */

const { createSql, claimDue, pruneOldRuns } = require('./db')
const { nextOccurrence } = require('./cron')
const { initOtelLogs } = require('../observability/otel-logs')
const {
  createFailureStreak,
  databaseOutage,
  describeFailedResponse,
  describeTransportError,
  escalationTicks,
  isTransientStatus,
} = require('../workers/failure-streak')

const LOG = '[job-scheduler]'

// Must match src/lib/internal-auth.ts INTERNAL_TOKEN_HEADER — the header the
// `internalApiRoute` factory guarding /api/internal/skills/fire expects.
const INTERNAL_TOKEN_HEADER = 'x-grid-internal-token'
const FIRE_TIMEOUT_MS = 30000
// One sweep claims at most 25 runs and asks the backend about 5 at a time, each
// with a 10 s timeout: about a minute in the worst case. The reentrancy guard in
// main() keeps a slow sweep from overlapping the next tick.
const RECONCILE_TIMEOUT_MS = 120000

/**
 * The schedules gate. Due definitions are claimed and fired only when the
 * skills feature is turned on for this deployment — either the dark-launch env
 * opt-in (GRID_SKILLS_ENABLED) or enforced WorkOS flags
 * (GRID_ENFORCE_FEATURE_FLAGS). The run reconciler runs either way.
 */
function schedulesEnabled(env) {
  // Case-insensitive, matching how the BFF reads these vars
  // (feature-flags.ts lowercases before comparing) — 'TRUE' must not enable
  // the UI while silently no-op'ing this container.
  const on = (v) => (v || '').toLowerCase() === 'true'
  return on(env.GRID_SKILLS_ENABLED) || on(env.GRID_ENFORCE_FEATURE_FLAGS)
}

function toPositiveInt(raw, fallback) {
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function readConfig(env) {
  return {
    frontendUrl: (env.FRONTEND_INTERNAL_URL || 'http://frontend:3000').replace(/\/$/, ''),
    internalToken: env.GRID_INTERNAL_API_TOKEN || '',
    pollMs: toPositiveInt(env.GRID_SKILL_SCHEDULER_POLL_MS, 30000),
    batch: toPositiveInt(env.GRID_SKILL_SCHEDULER_BATCH, 20),
    retentionDays: toPositiveInt(env.GRID_SKILL_RUNS_RETENTION_DAYS, 90),
    schedulesEnabled: schedulesEnabled(env),
  }
}

/**
 * The streaks the tick loop keeps between ticks (`workers/failure-streak.js`):
 * the reconcile POST, and the database work behind firing (claim and prune).
 * A transient failure of either is a WARN until it has lasted about five
 * minutes, which logs one ERROR, and the first success after logs a recovery.
 */
function createStreaks(config) {
  const escalateAfter = escalationTicks(config.pollMs)
  return {
    reconcile: createFailureStreak({ label: `${LOG} run reconcile`, escalateAfter }),
    uploads: createFailureStreak({ label: `${LOG} upload sweep`, escalateAfter }),
    database: createFailureStreak({ label: `${LOG} schedule claim`, escalateAfter }),
  }
}

/**
 * One run-reconciler sweep: POST {frontendUrl}/api/internal/runs/reconcile.
 *
 * The BFF does the work — it owns the run lifecycle, and closing a run through
 * any path but its outcome service would be a second author of the row. This
 * container only supplies the clock, as it does for firing. The sweep is
 * replica-safe on the BFF side (the claim stamps each run it takes), so running
 * this from every scheduler replica is fine. Logs only when it changed
 * something or failed; never throws. Returns the sweep's counts, or null.
 *
 * A transport error, or a 404/502/503/504 (a rollout's old frontend pod, the
 * BFF answering a database outage), goes to `streak` as transient. Any other
 * status is a real fault and logs at ERROR at once. No failure logs an HTML
 * body (`describeFailedResponse`).
 */
async function reconcileRuns(config, fetchImpl, streak) {
  return postInternalSweep(config, fetchImpl, streak, {
    path: '/api/internal/runs/reconcile',
    label: 'run reconcile',
    describe: (counts) =>
      counts.closed > 0 || counts.healed > 0 || counts.failed > 0
        ? `checked ${counts.checked}, closed ${counts.closed}, ` +
          `already closed ${counts.alreadyClosed}, waiting ${counts.waiting}, ` +
          `healed ${counts.healed ?? 0}, failed ${counts.failed}`
        : null,
  })
}

/**
 * One upload sweep: POST {frontendUrl}/api/internal/upload-batches/sweep
 * (ADR-0077). Settles the uploads whose browser is gone, so their uploader is
 * told when everything was read. Same posture as the run reconciler: the BFF
 * does the work, this container supplies the clock, nothing throws, and it
 * logs only when it settled something or failed.
 */
async function sweepUploads(config, fetchImpl, streak) {
  return postInternalSweep(config, fetchImpl, streak, {
    path: '/api/internal/upload-batches/sweep',
    label: 'upload sweep',
    describe: (counts) =>
      counts.sealed > 0 || counts.completed > 0 || counts.failed > 0
        ? `checked ${counts.checked}, sealed ${counts.sealed}, completed ${counts.completed}, failed ${counts.failed}`
        : null,
  })
}

/**
 * POST one internal sweep with the internal token. A transport error, or a
 * 404/502/503/504 (a rollout's old frontend pod, the BFF answering a database
 * outage), goes to `streak` as transient; any other status is a real fault and
 * logs at ERROR at once. No failure logs an HTML body. Returns the sweep's
 * counts, or null.
 */
async function postInternalSweep(config, fetchImpl, streak, { path, label, describe }) {
  const url = `${config.frontendUrl}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RECONCILE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { [INTERNAL_TOKEN_HEADER]: config.internalToken },
      signal: controller.signal,
    })
    if (!res.ok) {
      const failure = await describeFailedResponse(res)
      if (isTransientStatus(res.status)) {
        streak.failed(failure)
      } else {
        console.error(`${LOG} ${label} failed: ${failure.detail}`)
      }
      return null
    }
    streak.succeeded()
    let counts = null
    try {
      counts = await res.json()
    } catch {
      /* non-JSON 200 — nothing to report */
    }
    const line = counts ? describe(counts) : null
    if (line) console.log(`${LOG} ${label}: ${line}`)
    return counts
  } catch (error) {
    streak.failed(describeTransportError(error))
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fire one claimed definition: POST {frontendUrl}/api/internal/skills/fire with
 * the shared internal token and body {scheduleId} (the pre-jobs wire spelling,
 * kept because this container and the BFF deploy separately — see the route).
 * It names a `task_definitions.id`; the id space is the same one jobs used,
 * because 0086 reuses job ids for their definitions. Non-2xx and transport
 * errors are logged loudly and swallowed (returns false) — a fire failure must
 * never throw out of the tick loop. They stay ERROR even when transient, unlike
 * the reconcile POST's: a failed fire is an occurrence somebody scheduled that
 * did not run, and no later tick brings it back. The BFF records run rows; if
 * the BFF itself was unreachable the occurrence is missed-once and the next
 * occurrence heals it (ADR-0023 risks). A ~30s AbortController timeout bounds
 * each request. No failure logs an HTML body (`describeFailedResponse`).
 */
async function fireOne(config, scheduleId, fetchImpl = fetch) {
  const url = `${config.frontendUrl}/api/internal/skills/fire`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FIRE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: config.internalToken,
      },
      body: JSON.stringify({ scheduleId }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const { detail } = await describeFailedResponse(res)
      console.error(`${LOG} fire failed for job ${scheduleId}: ${detail}`)
      return false
    }
    // A 200 is not always a fire: the BFF returns {fired:false, reason} for
    // disabled/feature-gated rows. Log skips as skips so operators see them.
    let outcome = null
    try {
      outcome = await res.json()
    } catch {
      /* non-JSON 200 — treat as fired, the BFF contract says it is */
    }
    if (outcome && outcome.fired === false) {
      console.warn(`${LOG} job ${scheduleId} not fired: ${outcome.reason || 'unknown reason'}`)
      return false
    }
    console.log(`${LOG} fired job ${scheduleId}`)
    return true
  } catch (error) {
    console.error(
      `${LOG} fire request errored for job ${scheduleId}:`,
      error && error.message ? error.message : error,
    )
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One scheduler tick: the schedules (when their gate is on), then the run
 * reconciler (always). Neither can throw out of the tick. Returns the count
 * fired (for logs). `streaks` must outlive the tick (`createStreaks`): a fresh
 * one per tick would never reach its escalation.
 */
async function tick(sql, config, fetchImpl, streaks) {
  const fired = config.schedulesEnabled ? await fireDue(sql, config, streaks.database) : 0
  await reconcileRuns(config, fetchImpl, streaks.reconcile)
  await sweepUploads(config, fetchImpl, streaks.uploads)
  return fired
}

/**
 * Claim + advance (atomic), then fire the claimed rows concurrently
 * (batch <= 20), then prune. Every stage is defended so nothing throws — a
 * failed claim skips this tick's fires, a failed fire is logged, a failed prune
 * is logged. Returns the count fired.
 *
 * The claim is one transaction, so a claim that fails with the database
 * unavailable has claimed nothing and advanced nothing: the rows are still due
 * and the next tick fires them. That is a transient failure for `streak`. Any
 * other claim or prune error is a real fault, logged at ERROR.
 */
async function fireDue(sql, config, streak) {
  let claimed = []
  try {
    claimed = await claimDue(sql, config.batch, (cron, tz) => nextOccurrence(cron, tz, new Date()))
  } catch (error) {
    const outage = databaseOutage(error)
    if (outage) streak.failed(outage)
    else console.error(`${LOG} claim transaction failed — skipping fires this tick:`, error)
    return 0
  }

  // Fire the batch concurrently: schedules cluster on popular cron slots
  // (daily-at-9 etc.), and sequential 30s-timeout fires would let one slow
  // BFF hop stall the whole tick (batch × timeout ≫ poll interval). fireOne
  // never rejects, so allSettled is belt-and-braces.
  const results = await Promise.allSettled(claimed.map((row) => fireOne(config, row.id)))
  const fired = results.filter((r) => r.status === 'fulfilled' && r.value === true).length

  try {
    const pruned = await pruneOldRuns(sql, config.retentionDays)
    if (pruned > 0) {
      console.log(`${LOG} pruned ${pruned} task_runs older than ${config.retentionDays} days`)
    }
    streak.succeeded()
  } catch (error) {
    // Retention is idempotent: an outage here only defers it to a later tick.
    const outage = databaseOutage(error)
    if (outage) streak.failed(outage)
    else console.error(`${LOG} run-history prune failed:`, error)
  }

  return fired
}

function main() {
  // No-op without OTEL_EXPORTER_OTLP_ENDPOINT (ADR-0029 capability gate).
  initOtelLogs()
  const config = readConfig(process.env)
  const sql = createSql()
  const streaks = createStreaks(config)

  // Reentrancy guard, exactly like purger/index.js: a slow tick (many fires,
  // a slow prune) must never overlap the next interval firing.
  let running = false
  const runTick = async () => {
    if (running) return
    running = true
    try {
      await tick(sql, config, fetch, streaks)
    } catch (error) {
      console.error(`${LOG} unexpected tick error:`, error)
    } finally {
      running = false
    }
  }

  if (config.schedulesEnabled) {
    console.log(
      `${LOG} started, polling every ${config.pollMs}ms ` +
        `(batch ${config.batch}, retention ${config.retentionDays}d, target ${config.frontendUrl})`,
    )
  } else {
    console.log(
      `${LOG} skills feature is off for this deployment ` +
        `(set GRID_SKILLS_ENABLED=true or GRID_ENFORCE_FEATURE_FLAGS=true to fire schedules) — ` +
        `running the run reconciler only, every ${config.pollMs}ms (target ${config.frontendUrl})`,
    )
  }
  void runTick()
  setInterval(() => void runTick(), config.pollMs)
}

if (require.main === module) {
  main()
}

module.exports = {
  schedulesEnabled,
  readConfig,
  toPositiveInt,
  createStreaks,
  fireOne,
  reconcileRuns,
  sweepUploads,
  tick,
  INTERNAL_TOKEN_HEADER,
}

/**
 * GRID skill scheduler service.
 *
 * Dedicated container (frontend image, `node scheduler/index.js`) — the exact
 * deployment shape of the purger. Each tick (default 30s) it:
 *   1. claims due skill_schedules and advances their next_run_at, atomically,
 *      via FOR UPDATE SKIP LOCKED (db.claimDue) — replica- and crash-safe;
 *   2. AFTER that transaction commits, POSTs each claimed schedule to the BFF
 *      internal fire endpoint (which records the run row + submits the job);
 *   3. prunes skill_runs older than the retention window.
 * See ADR-0046 and docs/architecture/agent-skills.md ("Scheduler worker").
 *
 * Environment:
 *   GRID_APP_DATABASE_URL              - grid_app Postgres DSN (required)
 *   FRONTEND_INTERNAL_URL              - BFF base URL (default http://frontend:3000)
 *   GRID_INTERNAL_API_TOKEN            - shared token for the internal fire endpoint
 *   GRID_SKILL_SCHEDULER_POLL_MS       - tick interval (default 30000)
 *   GRID_SKILL_SCHEDULER_BATCH         - max claims per tick (default 20)
 *   GRID_SKILL_RUNS_RETENTION_DAYS     - run-history retention (default 90)
 * Start gate (deployment-level): refuses to run unless GRID_SKILLS_ENABLED=true
 * or GRID_ENFORCE_FEATURE_FLAGS=true — a clean no-op container otherwise.
 */

const { createSql, claimDue, pruneOldRuns } = require('./db')
const { nextOccurrence } = require('./cron')
const { initOtelLogs } = require('../observability/otel-logs')

// No-op without OTEL_EXPORTER_OTLP_ENDPOINT (ADR-0029 capability gate).
initOtelLogs()

const LOG = '[skill-scheduler]'

// Must match src/lib/internal-auth.ts INTERNAL_TOKEN_HEADER — the header the
// `internalApiRoute` factory guarding /api/internal/skills/fire expects.
const INTERNAL_TOKEN_HEADER = 'x-grid-internal-token'
const FIRE_TIMEOUT_MS = 30000
const FIRE_BODY_SNIPPET = 500

/**
 * Deployment start gate. The scheduler is a clean no-op unless the skills
 * feature is turned on for this deployment — either the dark-launch env opt-in
 * (GRID_SKILLS_ENABLED) or enforced WorkOS flags (GRID_ENFORCE_FEATURE_FLAGS).
 */
function shouldStart(env) {
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
  }
}

/**
 * Fire one claimed schedule: POST {frontendUrl}/api/internal/skills/fire with
 * the shared internal token and body {scheduleId}. Non-2xx and transport errors
 * are logged loudly and swallowed (returns false) — a fire failure must never
 * throw out of the tick loop. The BFF records run rows; if the BFF itself was
 * unreachable the occurrence is missed-once and the next occurrence heals it
 * (ADR-0023 risks). A ~30s AbortController timeout bounds each request.
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
      let body = ''
      try {
        body = (await res.text()).slice(0, FIRE_BODY_SNIPPET)
      } catch {
        /* body unreadable — status is enough to act on */
      }
      console.error(`${LOG} fire failed for schedule ${scheduleId}: HTTP ${res.status} ${body}`)
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
      console.warn(`${LOG} schedule ${scheduleId} not fired: ${outcome.reason || 'unknown reason'}`)
      return false
    }
    console.log(`${LOG} fired schedule ${scheduleId}`)
    return true
  } catch (error) {
    console.error(
      `${LOG} fire request errored for schedule ${scheduleId}:`,
      error && error.message ? error.message : error,
    )
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One scheduler tick. Claim + advance (atomic), then fire the claimed rows
 * concurrently (batch <= 20), then prune. Every stage is defended so nothing
 * throws out of the tick — a failed claim skips this tick's fires, a failed
 * fire is logged, a failed prune is logged. Returns the count fired (for logs).
 */
async function tick(sql, config) {
  let claimed = []
  try {
    claimed = await claimDue(sql, config.batch, (cron, tz) => nextOccurrence(cron, tz, new Date()))
  } catch (error) {
    console.error(`${LOG} claim transaction failed — skipping fires this tick:`, error)
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
      console.log(`${LOG} pruned ${pruned} skill_runs older than ${config.retentionDays} days`)
    }
  } catch (error) {
    console.error(`${LOG} run-history prune failed:`, error)
  }

  return fired
}

function main() {
  const config = readConfig(process.env)
  const sql = createSql()

  // Reentrancy guard, exactly like purger/index.js: a slow tick (many fires,
  // a slow prune) must never overlap the next interval firing.
  let running = false
  const runTick = async () => {
    if (running) return
    running = true
    try {
      await tick(sql, config)
    } catch (error) {
      console.error(`${LOG} unexpected tick error:`, error)
    } finally {
      running = false
    }
  }

  console.log(
    `${LOG} started, polling every ${config.pollMs}ms ` +
      `(batch ${config.batch}, retention ${config.retentionDays}d, target ${config.frontendUrl})`,
  )
  void runTick()
  setInterval(() => void runTick(), config.pollMs)
}

if (require.main === module) {
  if (!shouldStart(process.env)) {
    console.log(
      `${LOG} skills feature is off for this deployment ` +
        `(set GRID_SKILLS_ENABLED=true or GRID_ENFORCE_FEATURE_FLAGS=true to enable) — ` +
        `nothing to do, exiting cleanly.`,
    )
    process.exit(0)
  }
  main()
}

module.exports = {
  shouldStart,
  readConfig,
  toPositiveInt,
  fireOne,
  tick,
  INTERNAL_TOKEN_HEADER,
}

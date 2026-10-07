// @ts-check
/**
 * GRID BFF job runner — the entry point of the `bff-jobs` pool (ADR-0078).
 *
 * Dedicated pod (frontend image, `node workers/jobs/index.js`), internal only:
 * no Service, no HTTPRoute. One process supervises two things:
 *
 *   1. the BFF itself (`node server.js`, a child process), so the heavy work a
 *      job does (walking ten thousand documents, converting an office file,
 *      parsing an IFC) runs in THIS pod and never in a user-facing frontend
 *      pod that also proxies chat;
 *   2. the claim loop (`./runner.js`), which takes jobs from `bff_job_queue`
 *      fairly across organizations and has that BFF run them one slice at a
 *      time over `POST /api/internal/jobs/run`.
 *
 * ONE PROCESS, NOT TWO CONTAINERS, because shutdown has an order. On SIGTERM
 * the loop stops claiming and lets the slices in hand finish, and only THEN may
 * the BFF go away: two containers in a pod are signalled at the same moment, so
 * the BFF would be gone under the slice that is still using it. Here the BFF
 * gets its SIGTERM after the drain.
 *
 * Environment (the BFF's own, `frontendEnv`, plus):
 *   GRID_APP_DATABASE_URL            - grid_app Postgres DSN (the queue lives there)
 *   GRID_INTERNAL_API_TOKEN          - shared token for the internal run route
 *   GRID_BFF_JOBS_URL                - the pod's own BFF (default http://127.0.0.1:$PORT)
 *   GRID_BFF_JOBS_CONCURRENCY        - jobs one replica runs at once (default 2)
 *   GRID_BFF_JOBS_POLL_MS            - idle wait between claims (default 2000)
 *   GRID_BFF_JOBS_DRAIN_SECONDS      - SIGTERM budget to finish a slice (default 60)
 *   GRID_BFF_JOBS_STALE_SECONDS      - a claim silent this long is claimed again (default 180)
 *   GRID_BFF_JOBS_MAX_ATTEMPTS       - claims one job gets before it is dead (default 3)
 *   GRID_BFF_JOBS_RETRY_BACKOFF_SECONDS - wait before a failed job's second attempt, doubling per attempt, at most 15 min; 0 retries at once (default 30)
 *   GRID_BFF_JOBS_DEAD_RETENTION_DAYS - how long a dead job is kept before it is deleted (default 14)
 *   GRID_BFF_JOBS_MAX_PER_ORG        - most jobs one organization runs fleet-wide; 0 = no cap (default 0)
 *   GRID_BFF_JOBS_SLICE_TIMEOUT_MS   - ceiling on one slice's request (default 300000)
 */

const { spawn } = require('node:child_process')
const os = require('node:os')
const postgres = require('postgres')
const queue = require('../job-queue')
const { createFailureStreak, escalationTicks } = require('../failure-streak')
const { createRunner, createSliceRunner } = require('./runner')
const { initOtelLogs } = require('../../observability/otel-logs')

const LOG = '[bff-jobs]'

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {{ min?: number }} [bounds]
 */
function toInt(raw, fallback, bounds = {}) {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= (bounds.min ?? 1) ? n : fallback
}

/** @param {NodeJS.ProcessEnv} env */
function readConfig(env) {
  const port = toInt(env.PORT, 3000)
  const heartbeatMs = 15_000
  return {
    url: (env.GRID_BFF_JOBS_URL || `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    internalToken: env.GRID_INTERNAL_API_TOKEN || '',
    drainMs: toInt(env.GRID_BFF_JOBS_DRAIN_SECONDS, 60) * 1000,
    sliceTimeoutMs: toInt(env.GRID_BFF_JOBS_SLICE_TIMEOUT_MS, 300_000),
    runner: {
      workerPrefix: `bff-jobs-${env.HOSTNAME || os.hostname()}`,
      concurrency: toInt(env.GRID_BFF_JOBS_CONCURRENCY, 2),
      pollMs: toInt(env.GRID_BFF_JOBS_POLL_MS, 2000),
      heartbeatMs,
      // Never shorter than a few beats, or a healthy slice's claim would look dead.
      staleSeconds: Math.max(toInt(env.GRID_BFF_JOBS_STALE_SECONDS, 180), (heartbeatMs / 1000) * 4),
      maxAttempts: toInt(env.GRID_BFF_JOBS_MAX_ATTEMPTS, 3),
      perLaneCap: toInt(env.GRID_BFF_JOBS_MAX_PER_ORG, 0, { min: 0 }),
      reapEveryMs: 60_000,
      transientBackoffMs: 5_000,
      retryBackoffSeconds: toInt(env.GRID_BFF_JOBS_RETRY_BACKOFF_SECONDS, queue.DEFAULT_RETRY_BACKOFF_SECONDS, { min: 0 }),
      deadRetentionSeconds: toInt(env.GRID_BFF_JOBS_DEAD_RETENTION_DAYS, 14) * 86_400,
      purgeEveryMs: 600_000,
    },
  }
}

/**
 * Wait until the pod's BFF answers its health route, so the first claims do not
 * meet a server that is still booting.
 *
 * @param {string} url
 * @param {{ attempts?: number, intervalMs?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<boolean>}
 */
async function waitForServer(url, { attempts = 120, intervalMs = 1000, fetchImpl = fetch, sleep } = {}) {
  const wait = sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetchImpl(`${url}/api/healthz`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
    } catch {
      /* not listening yet */
    }
    await wait(intervalMs)
  }
  return false
}

async function main() {
  // No-op without OTEL_EXPORTER_OTLP_ENDPOINT (ADR-0029 capability gate).
  initOtelLogs()
  const config = readConfig(process.env)
  if (!config.internalToken) throw new Error('GRID_INTERNAL_API_TOKEN is not defined')
  const databaseUrl = process.env.GRID_APP_DATABASE_URL
  if (!databaseUrl) throw new Error('GRID_APP_DATABASE_URL is not defined')

  const sql = postgres(databaseUrl, { prepare: false, max: config.runner.concurrency + 2 })
  const server = spawn(process.execPath, ['server.js'], { stdio: 'inherit', env: process.env })
  let draining = false

  const runner = createRunner(config.runner, {
    sql,
    queue,
    runSlice: createSliceRunner({ url: config.url, token: config.internalToken, timeoutMs: config.sliceTimeoutMs }),
    streak: createFailureStreak({ label: `${LOG} queue`, escalateAfter: escalationTicks(config.runner.pollMs) }),
  })

  /** @param {string} signal */
  async function shutdown(signal) {
    if (draining) return
    draining = true
    console.log(`${LOG} ${signal}: draining for up to ${config.drainMs}ms`)
    const released = await runner.drain(config.drainMs)
    if (released > 0) console.warn(`${LOG} drain budget spent; ${released} claim(s) released mid-job`)
    await sql.end({ timeout: 5 }).catch(() => {})
    server.kill('SIGTERM')
    setTimeout(() => process.exit(0), 10_000).unref()
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
  server.once('exit', async (code, signal) => {
    if (draining) return process.exit(0)
    // The BFF died under us: give the claims back and let Kubernetes restart the pod.
    console.error(`${LOG} the BFF process exited (${signal ?? code}); stopping`)
    await runner.drain(5_000)
    process.exit(1)
  })

  if (!(await waitForServer(config.url))) {
    console.error(`${LOG} the BFF did not answer ${config.url}/api/healthz in time; exiting`)
    server.kill('SIGTERM')
    process.exit(1)
  }
  console.log(
    `${LOG} claiming from bff_job_queue as ${config.runner.workerPrefix} ` +
      `(concurrency ${config.runner.concurrency}, cap ${config.runner.perLaneCap || 'none'})`,
  )
  runner.start()
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${LOG} failed to start:`, error)
    process.exit(1)
  })
}

module.exports = { readConfig, waitForServer }

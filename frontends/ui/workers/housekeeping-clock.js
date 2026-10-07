// @ts-check
/**
 * The backend's housekeeping clock, for Docker Compose (ADR-0082 step A1).
 *
 * The backend runs no housekeeping loop of its own: each cycle is an internal
 * route (`POST /v1/maintenance/housekeeping/<route>`), and something outside the
 * process has to call it. On Kubernetes that is one CronJob per route
 * (`deploy/pulumi/src/app/workers.ts`); Compose has no CronJobs, so this process
 * calls the same routes on the same cadences. `housekeeping.spec.ts` in the
 * Pulumi program checks that both name exactly the routes the backend registers.
 *
 * Failures follow the scheduler's rule (`failure-streak.js`): a transient one is
 * a WARN, a streak escalates once, and anything else is an ERROR.
 */

const {
  createFailureStreak,
  describeFailedResponse,
  describeTransportError,
  escalationTicks,
  isTransientStatus,
} = require('./failure-streak')

const LOG = '[housekeeping]'
const INTERNAL_TOKEN_HEADER = 'x-grid-internal-token'

/** Every route and its period. The same cadences as the Kubernetes CronJobs. */
const ROUTES = [
  { route: 'ghost-jobs', everyMs: 2 * 60 * 1000, timeoutMs: 90 * 1000 },
  { route: 'job-events', everyMs: 60 * 60 * 1000, timeoutMs: 15 * 60 * 1000 },
  { route: 'chat-checkpoints', everyMs: 60 * 60 * 1000, timeoutMs: 15 * 60 * 1000 },
  { route: 'base-corpus', everyMs: 10 * 60 * 1000, timeoutMs: 10 * 60 * 1000 },
]

/**
 * One cycle of one route. Returns the route's JSON answer, or null when it failed.
 *
 * @param {{ backendUrl: string, internalToken: string }} config
 * @param {typeof fetch} fetchImpl
 * @param {{ failed(f: { kind: string, detail: string }): void, succeeded(): void }} streak
 * @param {{ route: string, timeoutMs: number }} job
 * @param {Pick<Console, 'log' | 'error'>} [log]
 */
async function runOnce(config, fetchImpl, streak, { route, timeoutMs }, log = console) {
  try {
    const res = await fetchImpl(`${config.backendUrl}/v1/maintenance/housekeeping/${route}`, {
      method: 'POST',
      headers: { [INTERNAL_TOKEN_HEADER]: config.internalToken },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const failure = await describeFailedResponse(res)
      if (isTransientStatus(res.status)) streak.failed(failure)
      else log.error(`${LOG} ${route} failed: ${failure.detail}`)
      return null
    }
    streak.succeeded()
    const body = await res.json()
    log.log(`${LOG} ${route} ${JSON.stringify(body)}`)
    return body
  } catch (error) {
    streak.failed(describeTransportError(error))
    return null
  }
}

/**
 * Run every route now, then each on its own period, one cycle at a time per route.
 *
 * @param {{ backendUrl: string, internalToken: string }} config
 * @param {typeof fetch} [fetchImpl]
 */
function start(config, fetchImpl = fetch) {
  for (const job of ROUTES) {
    const streak = createFailureStreak({ label: `${LOG} ${job.route}`, escalateAfter: escalationTicks(job.everyMs) })
    const tick = async () => {
      await runOnce(config, fetchImpl, streak, job)
      setTimeout(tick, job.everyMs)
    }
    void tick()
  }
}

/** @returns {{ backendUrl: string, internalToken: string }} */
function configFromEnv(env = process.env) {
  const backendUrl = (env.BACKEND_URL ?? '').replace(/\/+$/, '')
  const internalToken = env.GRID_INTERNAL_API_TOKEN ?? ''
  if (!backendUrl || !internalToken) {
    throw new Error(`${LOG} BACKEND_URL and GRID_INTERNAL_API_TOKEN are required`)
  }
  return { backendUrl, internalToken }
}

if (require.main === module) {
  start(configFromEnv())
}

module.exports = { ROUTES, configFromEnv, runOnce, start }

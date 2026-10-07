// @ts-check
/**
 * The claim loop of the `bff-jobs` pool (ADR-0079).
 *
 * A replica claims jobs from `bff_job_queue` fairly across organizations
 * (`../job-queue.js`) and hands each to the BFF that runs in the SAME pod, one
 * slice at a time, over `POST /api/internal/jobs/run`. The loop owns the
 * claim: the heartbeat, the release, the failure and the finish. The BFF owns
 * the work: which kind does what, and the progress a slice leaves behind in the
 * job's payload.
 *
 * A SLICE IS THE UNIT OF DRAINING. A job is not one long request. Each POST
 * does a bounded step (a page of documents, say) and answers `done: false` with
 * where it got to, which this loop saves as the job's progress, until the job
 * is finished. So a SIGTERM never has to
 * cut a request off or ask the BFF to stop: the loop stops asking for the next
 * slice, gives the claim back WITHOUT spending an attempt, and the next worker
 * resumes from the saved progress. A slice that outlives the drain budget is
 * abandoned the same way (the claim is released, so the progress the slice
 * would have saved is refused: the write is conditional on the claim).
 *
 * WHY A SEPARATE PROCESS FROM THE WORK. The claim loop is plain Node with no
 * build step, like the purger and the scheduler, so it cannot import the
 * TypeScript services. They run behind the internal route, in the pod's own
 * BFF, which is the point: the heavy work lands on `bff-jobs` pods and never on
 * the user-facing frontend pods that proxy chat.
 *
 * The functions here take their collaborators as arguments, so the specs drive
 * a whole claim without a database or a server.
 */

const { databaseOutage, describeTransportError, describeFailedResponse, isTransientStatus } = require('../failure-streak')

/** @typedef {import('../job-queue').Claim} Claim */

/**
 * @typedef {object} RunnerConfig
 * @property {string} workerPrefix  worker ids are `<prefix>-<slot>`
 * @property {number} concurrency   jobs this replica runs at once
 * @property {number} pollMs        idle wait between claims
 * @property {number} heartbeatMs   how often a running claim is refreshed
 * @property {number} staleSeconds  a claim silent this long is claimed again
 * @property {number} maxAttempts   a job is claimed at most this many times
 * @property {number} perLaneCap    most live claims one organization may hold; 0 is no cap
 * @property {number} reapEveryMs   how often exhausted claims are marked dead
 * @property {number} transientBackoffMs  wait after the BFF was briefly unavailable
 */

/**
 * What one slice came to, from the loop's point of view.
 *
 * @typedef {{ kind: 'done' } | { kind: 'more', payload: Record<string, unknown> } | { kind: 'lost' }
 *   | { kind: 'transient', failure: { kind: string, detail?: string } }
 *   | { kind: 'error', message: string }} SliceOutcome
 */

/**
 * @typedef {object} RunnerDeps
 * @property {import('postgres').Sql} sql
 * @property {typeof import('../job-queue')} queue
 * @property {(claim: Claim, worker: string) => Promise<SliceOutcome>} runSlice
 * @property {import('../failure-streak').FailureStreak} streak
 * @property {Pick<Console, 'log' | 'warn' | 'error'>} [log]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ask the pod's BFF to run one slice of a claimed job.
 *
 * The request names the job and the worker and nothing else: the BFF reads the
 * row itself and refuses a job that is not claimed by that worker, so the route
 * cannot be made to run work the queue never handed out.
 *
 * @param {{ url: string, token: string, timeoutMs: number, fetchImpl?: typeof fetch }} options
 * @returns {(claim: Claim, worker: string) => Promise<SliceOutcome>}
 */
function createSliceRunner({ url, token, timeoutMs, fetchImpl = fetch }) {
  return async (claim, worker) => {
    try {
      const res = await fetchImpl(`${url}/api/internal/jobs/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-grid-internal-token': token },
        body: JSON.stringify({ jobId: claim.jobId, worker }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 409) return { kind: 'lost' }
      if (!res.ok) {
        const failure = await describeFailedResponse(res)
        return isTransientStatus(res.status) ? { kind: 'transient', failure } : { kind: 'error', message: failure.detail ?? failure.kind }
      }
      const body = /** @type {{ done?: unknown, payload?: Record<string, unknown> }} */ (await res.json())
      return body.done === true ? { kind: 'done' } : { kind: 'more', payload: body.payload ?? {} }
    } catch (error) {
      return { kind: 'transient', failure: describeTransportError(error) }
    }
  }
}

/**
 * @param {RunnerConfig} config
 * @param {RunnerDeps} deps
 */
function createRunner(config, deps) {
  const { sql, queue, runSlice, streak } = deps
  const log = deps.log ?? console
  const sleep = deps.sleep ?? defaultSleep
  const options = { staleSeconds: config.staleSeconds, maxAttempts: config.maxAttempts, perLaneCap: config.perLaneCap }

  let stopping = false
  /** @type {Map<string, { claim: Claim, worker: string, lost: boolean }>} */
  const inFlight = new Map()
  /** @type {Promise<void>[]} */
  const slots = []
  let lastReapAt = 0

  /**
   * Keep the claim alive while a slice runs. A heartbeat that says the claim is
   * no longer ours marks it lost; the loop stops after the slice in hand.
   *
   * @param {{ claim: Claim, worker: string, lost: boolean }} held
   */
  function startHeartbeat(held) {
    const timer = setInterval(async () => {
      try {
        if (!(await queue.heartbeat(sql, held.claim.jobId, held.worker))) held.lost = true
      } catch (error) {
        // A missed beat is not a lost claim: the stale window is several beats wide.
        log.warn(`[bff-jobs] heartbeat for job ${held.claim.jobId} failed: ${describe(error)}`)
      }
    }, config.heartbeatMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /**
   * Run one claimed job to its end, a slice at a time.
   *
   * @param {Claim} claim
   * @param {string} worker
   */
  async function runClaim(claim, worker) {
    const held = { claim, worker, lost: false }
    inFlight.set(claim.jobId, held)
    const stopHeartbeat = startHeartbeat(held)
    try {
      for (;;) {
        if (held.lost) return log.warn(`[bff-jobs] job ${claim.jobId} (${claim.kind}) lost its claim; stopping`)
        if (stopping) return await giveBack(held, 'draining')
        const outcome = await runSlice(claim, worker)
        if (outcome.kind !== 'more') return await settle(held, outcome)
        // The slice's progress is what the next worker resumes from, so a
        // claim that cannot save it has been lost and must stop here.
        if (!(await queue.saveProgress(sql, claim.jobId, worker, outcome.payload))) held.lost = true
      }
    } finally {
      stopHeartbeat()
      inFlight.delete(claim.jobId)
    }
  }

  /**
   * @param {{ claim: Claim, worker: string, lost: boolean }} held
   * @param {Exclude<SliceOutcome, { kind: 'more' }>} outcome
   */
  async function settle(held, outcome) {
    const { claim, worker } = held
    if (outcome.kind === 'done') {
      streak.succeeded()
      if (await queue.complete(sql, claim.jobId, worker)) log.log(`[bff-jobs] job ${claim.jobId} (${claim.kind}) done`)
      return
    }
    if (outcome.kind === 'lost') return log.warn(`[bff-jobs] job ${claim.jobId} (${claim.kind}) is no longer this worker's`)
    if (outcome.kind === 'transient') {
      // The BFF in this pod is not answering yet (it is booting, or a request
      // met a database outage). The job did nothing wrong, so it keeps its attempt.
      streak.failed(outcome.failure)
      await giveBack(held, outcome.failure.kind)
      return stopping ? undefined : sleep(config.transientBackoffMs)
    }
    const verdict = await queue.fail(sql, claim.jobId, worker, outcome.message, config.maxAttempts)
    log.error(`[bff-jobs] job ${claim.jobId} (${claim.kind}) attempt ${claim.attempts} failed: ${outcome.message}`)
    if (verdict === 'dead') log.error(`[bff-jobs] a job failed every attempt and is now dead: ${claim.jobId} (${claim.kind})`)
  }

  /**
   * Hand a claim back without spending an attempt.
   *
   * @param {{ claim: Claim, worker: string }} held
   * @param {string} why
   */
  async function giveBack(held, why) {
    const gave = await queue.release(sql, held.claim.jobId, held.worker)
    if (gave) log.log(`[bff-jobs] job ${held.claim.jobId} (${held.claim.kind}) released (${why}); its progress is kept`)
  }

  /** Mark claims dead whose worker vanished on their last attempt. At most once per `reapEveryMs`. */
  async function reapIfDue() {
    const now = Date.now()
    if (now - lastReapAt < config.reapEveryMs) return
    lastReapAt = now
    const dead = await queue.reapExhausted(sql, options)
    if (dead.length === 0) return
    log.error(`[bff-jobs] ${dead.length} job(s) lost their worker on their last attempt and are now dead`)
    log.warn(`[bff-jobs] dead jobs: ${dead.join(', ')}`)
  }

  /**
   * One pass of one slot: reap if due, claim, run. True when it ran a job.
   *
   * @param {string} worker
   */
  async function step(worker) {
    try {
      await reapIfDue()
      const claim = await queue.claimNext(sql, worker, options)
      if (!claim) {
        streak.succeeded()
        return false
      }
      await runClaim(claim, worker)
      return true
    } catch (error) {
      const outage = databaseOutage(error)
      if (outage) streak.failed(outage)
      else log.error('[bff-jobs] a claim failed, retrying on the next poll:', error)
      return false
    }
  }

  /** @param {number} index */
  async function slot(index) {
    const worker = `${config.workerPrefix}-${index}`
    while (!stopping) {
      if (!(await step(worker))) await sleep(config.pollMs)
    }
  }

  return {
    /** Start `concurrency` slots. They run until {@link drain}. */
    start() {
      for (let index = 0; index < config.concurrency; index += 1) slots.push(slot(index))
    },

    /**
     * Stop claiming, let every running job finish the slice it is in, and give
     * its claim back. After `timeoutMs` whatever is still running is released
     * as it stands. Resolves with the number of claims given back.
     *
     * @param {number} timeoutMs
     */
    async drain(timeoutMs) {
      stopping = true
      const timedOut = Symbol('timeout')
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs)
      })
      const result = await Promise.race([Promise.allSettled(slots), deadline])
      clearTimeout(timer)
      if (result !== timedOut) return 0
      const stranded = [...inFlight.values()]
      for (const held of stranded) await giveBack(held, 'drain budget spent').catch(() => {})
      return stranded.length
    },

    /** The claims this runner holds right now. */
    inFlight: () => inFlight.size,
    step,
    runClaim,
  }
}

/** @param {unknown} error */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

module.exports = { createRunner, createSliceRunner }

// @ts-check
/**
 * How a background worker logs a failure that heals itself.
 *
 * The scheduler and the purger poll. When the database restarts, or a rollout
 * briefly routes the scheduler's POST to a frontend pod that has not got the
 * route yet, every tick fails the same way and the next tick after the cause
 * clears succeeds with nothing lost. That is the design working. Logged at
 * ERROR, each failed tick would become its own GitHub issue: err2issue files
 * every ERROR record (ADR-0031). A rollout's HTML 404 would file one more per
 * deploy, because the page carries per-build CSS hashes and so a new
 * fingerprint every time.
 *
 * So a transient failure is a WARN, and a streak of them is what escalates:
 * the tick that makes it {@link escalationTicks} in a row logs ONE fixed ERROR
 * line (one issue, the same fingerprint every time), and the first success
 * after any failure logs one recovery line. A failure that is not transient (a
 * 401 from a wrong token, a 500) is the caller's to log at ERROR.
 *
 * Lives in `workers/` beside `database-unavailable.js`, whose code set decides
 * what counts as a database outage.
 */

const { databaseUnavailableCode, findCauseCode } = require('./database-unavailable')

/**
 * How long a transient failure may persist before it files an issue.
 *
 * Five minutes. A rolling update replaces the frontend pods within a minute or
 * two, and a Postgres failover or pod restart usually clears inside two or
 * three, so neither files anything. A route that is
 * really missing, or a database that is really gone, files exactly one issue
 * within five minutes, instead of none (all WARN) or one per tick. The BFF's
 * own `[db] database unavailable` line (`lib/api/handler.ts`) still reports a
 * database outage from its side the moment a request meets it.
 */
const ESCALATE_AFTER_MS = 5 * 60 * 1000

/** Never escalate on fewer ticks than this, however long the poll interval. */
const MIN_ESCALATION_TICKS = 3

/**
 * The number of consecutive failed ticks that spans {@link ESCALATE_AFTER_MS}
 * at this poll interval: 10 for the scheduler's 30 s, 5 for the purger's 60 s.
 *
 * @param {number} pollMs
 * @returns {number}
 */
function escalationTicks(pollMs) {
  const ticks = Number.isFinite(pollMs) && pollMs > 0 ? Math.ceil(ESCALATE_AFTER_MS / pollMs) : 0
  return Math.max(MIN_ESCALATION_TICKS, ticks)
}

/**
 * @typedef {object} Failure
 * @property {string} kind   stable class of the failure (`HTTP 404 text/html`,
 *   `database unavailable (57P03)`): the only text the escalation ERROR carries,
 *   so every escalation of the same cause is the same issue.
 * @property {string} [detail] extra context for the WARN line only (a short
 *   non-HTML response snippet, an error message).
 */

/**
 * @typedef {object} FailureStreak
 * @property {(failure: Failure) => void} failed  record one failed tick
 * @property {() => void} succeeded  record one good tick; logs the recovery
 * @property {() => number} count  consecutive failed ticks so far
 */

/**
 * Count one kind of failure across ticks. Call `failed` or `succeeded` once
 * per tick, never both.
 *
 * @param {{ label: string, escalateAfter: number, log?: Pick<Console, 'log' | 'warn' | 'error'> }} options
 *   `label` prefixes every line (`[job-scheduler] run reconcile`).
 * @returns {FailureStreak}
 */
function createFailureStreak({ label, escalateAfter, log = console }) {
  let count = 0
  return {
    failed({ kind, detail }) {
      count += 1
      if (count === escalateAfter) {
        log.error(`${label} still failing after ${escalateAfter} consecutive ticks: ${kind}`)
        return
      }
      const extra = detail ? ` — ${detail}` : ''
      log.warn(`${label} failed (${kind}), retrying on the next tick [${count} in a row]${extra}`)
    },
    succeeded() {
      if (count === 0) return
      log.log(`${label} recovered after ${count} failed tick${count === 1 ? '' : 's'}`)
      count = 0
    },
    count: () => count,
  }
}

/** How much of a non-HTML error body a log line may carry. */
const BODY_SNIPPET = 200

/**
 * @typedef {object} ResponseLike
 * @property {number} status
 * @property {{ get(name: string): string | null }} [headers]
 * @property {() => Promise<string>} [text]
 */

/**
 * A failed HTTP response, described for a log line: the status, the media
 * type, and a short snippet of the body only when it is not HTML.
 *
 * An HTML body is never logged. It says nothing a status does not, and a
 * Next.js error page carries per-build asset hashes, so logging it would give
 * every deploy a new issue fingerprint.
 *
 * @param {ResponseLike} res
 * @returns {Promise<{ kind: string, detail: string }>}
 */
async function describeFailedResponse(res) {
  const mediaType = (res.headers?.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const kind = `HTTP ${res.status}${mediaType ? ` ${mediaType}` : ''}`
  if (mediaType.includes('html') || typeof res.text !== 'function') return { kind, detail: kind }
  let body = ''
  try {
    body = (await res.text()).replace(/\s+/g, ' ').trim()
  } catch {
    /* body unreadable — the status is enough to act on */
  }
  // An HTML page served without its content type is still an HTML page.
  if (!body || /^<(!doctype|html)/i.test(body)) return { kind, detail: kind }
  return { kind, detail: `${kind} ${body.slice(0, BODY_SNIPPET)}` }
}

/**
 * The statuses a worker's POST to the BFF gets while the BFF, not the worker,
 * is briefly wrong: 404 from a frontend pod a rollout has not replaced yet,
 * and the gateway and database-outage statuses (the BFF answers a database
 * outage with 503).
 */
const TRANSIENT_STATUSES = new Set([404, 502, 503, 504])

/** @param {number} status */
function isTransientStatus(status) {
  return TRANSIENT_STATUSES.has(status)
}

/**
 * A `fetch` that rejected, described: the request never got an HTTP answer, so
 * it is a transport failure (refused, unreachable, reset, timed out). The code
 * is the socket's, which undici hangs on `cause`.
 *
 * @param {unknown} error
 * @returns {{ kind: string, detail: string }}
 */
function describeTransportError(error) {
  const code = findCauseCode(error, () => true)
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  return { kind: `transport error (${code ?? name})`, detail: message }
}

/**
 * A database-unavailable error as a {@link Failure}, or undefined for any
 * other error (which the caller logs at ERROR, as a real fault).
 *
 * @param {unknown} error
 * @returns {{ kind: string, detail: string } | undefined}
 */
function databaseOutage(error) {
  const code = databaseUnavailableCode(error)
  if (!code) return undefined
  return { kind: `database unavailable (${code})`, detail: error instanceof Error ? error.message : String(error) }
}

module.exports = {
  ESCALATE_AFTER_MS,
  createFailureStreak,
  databaseOutage,
  describeFailedResponse,
  describeTransportError,
  escalationTicks,
  isTransientStatus,
}

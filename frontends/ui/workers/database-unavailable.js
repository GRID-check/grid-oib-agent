// @ts-check
/**
 * Is this failure the database being unreachable, rather than a query being
 * wrong? The ONE definition, for every process that talks to Postgres.
 *
 * Three readers ask this question, in three module systems:
 *
 *   - the BFF (`src/lib/db/errors.ts`, TypeScript, bundled by Next), which
 *     answers an outage with one fixed ERROR line and a 503;
 *   - the log bridge (`observability/otel-logs.js`), which builds the regex
 *     that recognises the same outage in Next's own `⨯ Error: Failed query`
 *     records from {@link UNAVAILABLE_CODE_PATTERN};
 *   - the background workers (`scheduler/`, `purger/`), plain `node` processes
 *     with no build step, which log an outage as a warning until it persists
 *     (`./failure-streak.js`).
 *
 * It is CommonJS so all three can load it, and it lives in `workers/` because
 * that directory is copied into the runtime image whole (`deploy/Dockerfile`),
 * so a worker's `require` of it cannot go missing the way a single-file COPY
 * can. It used to be three copies, and they had already drifted: the log
 * bridge's regex lacked `EPIPE`. `database-unavailable.spec.mjs` fails when a
 * code is spelled anywhere else.
 *
 * Drizzle wraps every driver failure as `Failed query: … params: …` and hangs
 * the real reason on `cause`: a SQLSTATE from the server, a Node errno from the
 * socket, or a postgres.js connection code. A worker's postgres.js error
 * carries the code itself; `fetch` puts the socket's on `cause`. The walk below
 * reads all of them the same way.
 */

/** SQLSTATEs that mean "no session", not "bad statement": class 08, and the three shutdown codes. */
const UNAVAILABLE_SQLSTATE_PATTERN = '08[0-9A-Z]{3}|57P0[123]'

/** Socket-level errnos a connect or a live connection fails with. */
const UNAVAILABLE_ERRNOS = Object.freeze([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
])

/** postgres.js's own connection codes (`Errors.connection` in the driver). */
const UNAVAILABLE_DRIVER_CODES = Object.freeze([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
])

/**
 * Every unavailable code as one regex alternation, unanchored and ungrouped,
 * for a caller matching printed output (`code: '<code>'` in Node's inspect).
 */
const UNAVAILABLE_CODE_PATTERN = [
  UNAVAILABLE_SQLSTATE_PATTERN,
  ...UNAVAILABLE_ERRNOS,
  ...UNAVAILABLE_DRIVER_CODES,
].join('|')

const UNAVAILABLE_CODE = new RegExp(`^(${UNAVAILABLE_CODE_PATTERN})$`)

/** How deep `cause` is followed; Drizzle → driver → socket is three. */
const MAX_CAUSE_DEPTH = 5

/**
 * The first string `code` on the error or its causes that `accept` takes, or
 * undefined.
 *
 * @param {unknown} error
 * @param {(code: string) => boolean} accept
 * @returns {string | undefined}
 */
function findCauseCode(error, accept) {
  let current = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const code = /** @type {{ code: unknown }} */ (current).code
      if (typeof code === 'string' && accept(code)) return code
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return undefined
}

/**
 * @param {string} code
 * @returns {boolean}
 */
function isDatabaseUnavailableCode(code) {
  return UNAVAILABLE_CODE.test(code)
}

/**
 * The first `code` on the error or its causes that says the database is
 * unreachable, or undefined.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
function databaseUnavailableCode(error) {
  return findCauseCode(error, isDatabaseUnavailableCode)
}

module.exports = {
  MAX_CAUSE_DEPTH,
  UNAVAILABLE_CODE_PATTERN,
  UNAVAILABLE_DRIVER_CODES,
  UNAVAILABLE_ERRNOS,
  databaseUnavailableCode,
  findCauseCode,
  isDatabaseUnavailableCode,
}

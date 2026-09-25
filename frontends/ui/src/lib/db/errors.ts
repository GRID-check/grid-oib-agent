/**
 * Is this failure the database being unreachable, rather than a query being wrong?
 *
 * Drizzle wraps every driver failure as `Failed query: … params: …` and hangs
 * the real reason on `cause`: a SQLSTATE from the server, a Node errno from the
 * socket, or a postgres.js connection code. The difference decides what the
 * caller is owed. A wrong query is a bug and a 500. An unreachable database is
 * an outage, and every request during it fails the same way: the 2026-09-25
 * restart filed nine issues (#733-#741) for one event, each at the path that
 * happened to hit it. Walk the chain once, here, so every caller asks the same
 * question the same way.
 */

/** SQLSTATEs that mean "no session", not "bad statement": class 08, and the three shutdown codes. */
const UNAVAILABLE_SQLSTATE = /^(08[0-9A-Z]{3}|57P0[123])$/

/** Socket-level errnos a connect or a live connection fails with. */
const UNAVAILABLE_ERRNO = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'])

/** postgres.js's own connection codes (`Errors.connection` in the driver). */
const UNAVAILABLE_DRIVER_CODE = new Set(['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT'])

/** How deep `cause` is followed; Drizzle → driver → socket is three. */
const MAX_DEPTH = 5

/** The first `code` on the error or its causes that says the database is unreachable, or undefined. */
export function databaseUnavailableCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < MAX_DEPTH && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const code: unknown = (current as { code: unknown }).code
      if (typeof code === 'string' && isUnavailableCode(code)) return code
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return undefined
}

function isUnavailableCode(code: string): boolean {
  return UNAVAILABLE_SQLSTATE.test(code) || UNAVAILABLE_ERRNO.has(code) || UNAVAILABLE_DRIVER_CODE.has(code)
}

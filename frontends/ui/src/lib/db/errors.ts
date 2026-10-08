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

/**
 * The code set and the cause-chain walk live in `workers/database-unavailable.js`,
 * CommonJS so the background workers and the log bridge read the same
 * definition this module does. Re-exported here so the app keeps importing it
 * from `@/lib/db/errors`.
 */
import { MAX_CAUSE_DEPTH, databaseUnavailableCode } from '../../../workers/database-unavailable.js'

export { databaseUnavailableCode }

/**
 * Postgres' `unique_violation`. The ONE spelling: a bare `'23505'` anywhere else
 * is refused by lint, because every copy of it was compared against the wrong
 * object (see {@link isUniqueViolation}).
 */
// eslint-disable-next-line no-restricted-syntax -- the one place the SQLSTATE is spelled
export const UNIQUE_VIOLATION = '23505'

/**
 * Is this failure a unique violation — optionally, of ONE named constraint?
 *
 * ## Why `error.code` is the wrong question
 *
 * Every drizzle query failure is a `DrizzleQueryError` ("Failed query: …")
 * whose own `code` is undefined; the driver's `PostgresError`, the one carrying
 * `code` and `constraint_name`, is its `cause`. The catch sites that compared
 * `error.code === '23505'` on the wrapper (a folder name, a filed report, a
 * memory fact, a lesson) were race backstops that never ran in production, so
 * the loser got a 500. Walked the way {@link databaseUnavailableCode} walks it.
 *
 * Name the constraint whenever the recovery is right for ONE index only: a
 * 23505 from another index on the same table is a different fault, and a
 * recovery written for the first one would hide it.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return violates(error, UNIQUE_VIOLATION, constraint)
}

/** Postgres' `foreign_key_violation`, spelled once for the same reason. */
export const FOREIGN_KEY_VIOLATION = '23503'

/**
 * Is this failure a foreign-key violation — optionally, of ONE named constraint?
 * The twin of {@link isUniqueViolation}, reading the same cause chain.
 */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  return violates(error, FOREIGN_KEY_VIOLATION, constraint)
}

/** Does the error or one of its causes carry `sqlstate` — on `constraint`, if named? */
function violates(error: unknown, sqlstate: string, constraint: string | undefined): boolean {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const { code, constraint_name: name } = current as { code: unknown; constraint_name?: unknown }
      if (code === sqlstate) return constraint === undefined || name === constraint
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

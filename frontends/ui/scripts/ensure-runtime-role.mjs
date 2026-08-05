/**
 * Give the row-level-security runtime role the login it needs (ADR-0041).
 *
 * Migration 0030 creates `grid_app_rw`, its grants and every policy — but not a
 * password, because a password is a deployment secret and does not belong in a
 * migration checked into git. On a FRESH compose volume `init-db.sql` supplies
 * one; on an existing volume it never runs again, because Postgres only
 * executes `docker-entrypoint-initdb.d` when it initialises the data directory.
 * Without this step, upgrading an existing stack would leave the app connecting
 * as a role that cannot authenticate.
 *
 * The password is not a separate variable to keep in sync: it is read from
 * `GRID_APP_DATABASE_URL`, which already carries the credential the app is about
 * to connect with. One source of truth, and the two cannot drift.
 *
 * Runs AFTER `drizzle-kit migrate` (the migration must have applied the grants
 * first), using the OWNER credential. Idempotent and fail-soft on every path
 * that is merely "not applicable", so it can never block a boot it was not
 * needed for.
 *
 * Not used on Kubernetes: there CloudNativePG reconciles the role and its
 * password declaratively from the Cluster spec, and the frontend Deployment
 * overrides the image CMD anyway.
 */

import postgres from "postgres";

/** Only ever this role — never an arbitrary name taken from a URL. */
const RUNTIME_ROLE = "grid_app_rw";

const runtimeUrl = process.env.GRID_APP_DATABASE_URL;
const ownerUrl = process.env.GRID_APP_MIGRATION_DATABASE_URL;

function log(message) {
  console.log(`[ensure-runtime-role] ${message}`);
}

if (!runtimeUrl || !ownerUrl) {
  // Single-credential setup (a local checkout against a throwaway database).
  // There is no privilege split to bootstrap.
  log("GRID_APP_MIGRATION_DATABASE_URL not set — nothing to do.");
  process.exit(0);
}

let parsed;
try {
  parsed = new URL(runtimeUrl);
} catch {
  log("GRID_APP_DATABASE_URL is not a parseable URL — leaving it to the app to report.");
  process.exit(0);
}

const runtimeUser = decodeURIComponent(parsed.username || "");
const runtimePassword = decodeURIComponent(parsed.password || "");

if (runtimeUser !== RUNTIME_ROLE) {
  // Deliberately not an error: pointing the app at the owner credential is the
  // documented break-glass rollback, and it must not fail the boot.
  log(`runtime user is "${runtimeUser}", not ${RUNTIME_ROLE} — skipping.`);
  process.exit(0);
}
if (!runtimePassword) {
  log(`no password in GRID_APP_DATABASE_URL — assuming trust auth, skipping.`);
  process.exit(0);
}

const sql = postgres(ownerUrl, { max: 1, prepare: false, connect_timeout: 10 });
try {
  // The role may not exist yet on a database that has never had migration 0030
  // applied; that run is about to create it, and the next boot sets the password.
  const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${RUNTIME_ROLE}`;
  if (!role) {
    log(`${RUNTIME_ROLE} does not exist yet — migration 0030 will create it.`);
  } else {
    // ALTER ROLE takes no bind parameters, so the statement is built by
    // Postgres itself: format(%I/%L) quotes the identifier and the literal
    // correctly, and the values reach it as parameters rather than as string
    // concatenation here. The ::text casts are required — the parameters appear
    // only inside format(), so Postgres cannot infer their type.
    const [built] = await sql`
      SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', ${RUNTIME_ROLE}::text, ${runtimePassword}::text) AS statement
    `;
    await sql.unsafe(built.statement);
    log(`${RUNTIME_ROLE} login synchronised with GRID_APP_DATABASE_URL.`);
  }
} catch (error) {
  // Fail soft: the app's own connection attempt is the real gate, and it
  // reports a far clearer error than this script could.
  log(`could not synchronise ${RUNTIME_ROLE} (${error.message}) — continuing.`);
} finally {
  await sql.end({ timeout: 5 });
}

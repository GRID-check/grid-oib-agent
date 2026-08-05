/**
 * Provision the row-level-security roles, for deployments that have no
 * declarative role manager (ADR-0041).
 *
 * Kubernetes does not need this: CloudNativePG reconciles `managed.roles`
 * continuously. Compose does, and the gap is an UPGRADE break rather than a
 * fresh-install one: `init-db.sql` runs only when Postgres initialises a fresh
 * data directory, so on an existing volume the roles never appear — and
 * migration 0030 then aborts with "row-level security roles are missing",
 * taking the container with it.
 *
 * So this runs BEFORE `drizzle-kit migrate`, with the migration credential
 * (a superuser in compose), and:
 *
 *   1. creates `grid_app_platform` and `grid_app_rw` if they are absent,
 *   2. grants the membership that makes the platform step-up legal,
 *   3. syncs `grid_app_rw`'s password to whatever `GRID_APP_DATABASE_URL` says.
 *
 * The password is not a separate variable to keep in sync: it is read from the
 * URL the app is about to connect with, so the two cannot drift.
 *
 * Fail-soft on every path that is merely "not applicable" — a single-credential
 * local checkout, or a deployment whose credential lacks CREATEROLE (Kubernetes,
 * where this is not needed anyway). It must never block a boot it was not
 * required for; the app's own connection attempt is the real gate and reports a
 * far clearer error.
 */

import postgres from "postgres";

/** Only ever these roles — never a name taken from a URL. */
const RUNTIME_ROLE = "grid_app_rw";
const PLATFORM_ROLE = "grid_app_platform";

const runtimeUrl = process.env.GRID_APP_DATABASE_URL;
const ownerUrl = process.env.GRID_APP_MIGRATION_DATABASE_URL;

function log(message) {
  console.log(`[ensure-rls-roles] ${message}`);
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
  const [existing] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${RUNTIME_ROLE}`;

  if (!existing) {
    // Identifiers and passwords are quoted by Postgres via format(%I/%L), never
    // concatenated here. The casts are required: the parameters appear only
    // inside format(), so their type cannot be inferred.
    const [created] = await sql`
      SELECT format(
        'CREATE ROLE %I LOGIN NOINHERIT PASSWORD %L', ${RUNTIME_ROLE}::text, ${runtimePassword}::text
      ) AS statement
    `;
    await sql.unsafe(`CREATE ROLE ${PLATFORM_ROLE} NOLOGIN BYPASSRLS`).catch((error) => {
      // Already there is the common case on a re-run.
      if (!/already exists/i.test(error.message)) throw error;
    });
    await sql.unsafe(created.statement);
    log(`created ${RUNTIME_ROLE} and ${PLATFORM_ROLE}.`);
  } else {
    const [built] = await sql`
      SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', ${RUNTIME_ROLE}::text, ${runtimePassword}::text) AS statement
    `;
    await sql.unsafe(built.statement);
    log(`${RUNTIME_ROLE} login synchronised with GRID_APP_DATABASE_URL.`);
  }

  // Idempotent, and the step-up is useless without it.
  await sql.unsafe(`GRANT ${PLATFORM_ROLE} TO ${RUNTIME_ROLE}`);
} catch (error) {
  log(`could not provision the row-level-security roles (${error.message}) — continuing.`);
  log(`if migration 0030 then reports missing roles, create them as an admin:`);
  log(`  CREATE ROLE ${PLATFORM_ROLE} NOLOGIN BYPASSRLS;`);
  log(`  CREATE ROLE ${RUNTIME_ROLE} LOGIN NOINHERIT PASSWORD '<the one in GRID_APP_DATABASE_URL>';`);
  log(`  GRANT ${PLATFORM_ROLE} TO ${RUNTIME_ROLE};`);
} finally {
  await sql.end({ timeout: 5 });
}

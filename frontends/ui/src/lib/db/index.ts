import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

let client: ReturnType<typeof postgres> | null = null;
let dbInstance: ReturnType<typeof drizzle> | null = null;

// Default upper bound on pooled connections when GRID_DB_POOL_MAX is unset.
const DEFAULT_DB_POOL_MAX = 10;
// Cancel any single statement that runs longer than this (ms). Keeps a runaway
// query from hanging a request past Cloudflare's ~100s origin timeout.
const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Resolve the pool ceiling from GRID_DB_POOL_MAX, falling back to a safe
 * default. An unbounded postgres-js pool lets a slow/unreachable backend or a
 * burst of concurrent requests exhaust Postgres' connection slots, compounding
 * the request pile-up behind Cloudflare's origin timeout. Invalid / non-positive
 * values fall back to the default rather than silently disabling the bound.
 */
export function resolveDbPoolMax(): number {
  const raw = process.env.GRID_DB_POOL_MAX;
  if (!raw) return DEFAULT_DB_POOL_MAX;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_DB_POOL_MAX;
}

export function createDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const connectionString = process.env.GRID_APP_DATABASE_URL;

  if (!connectionString) {
    throw new Error("GRID_APP_DATABASE_URL is not defined");
  }

  client = postgres(connectionString, {
    // Bound the pool so connection acquisition fails fast under load instead of
    // the process hanging on an exhausted or unreachable database.
    max: resolveDbPoolMax(),
    // Fail a stalled connection attempt in 10s rather than hanging the request.
    connect_timeout: 10,
    // Reap idle connections after 30s so the pool shrinks under low load.
    idle_timeout: 30,
    // Server-side per-statement ceiling: a runaway query is cancelled well
    // before it can hang past Cloudflare's ~100s origin timeout.
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    // Keep prepared statements off for transaction-pooler (PgBouncer) safety.
    prepare: false,
  });
  dbInstance = drizzle(client);

  return dbInstance;
}

export function getDb() {
  if (!dbInstance) {
    return createDb();
  }

  return dbInstance;
}

export async function closeDb() {
  if (client) {
    await client.end();
    client = null;
    dbInstance = null;
  }
}

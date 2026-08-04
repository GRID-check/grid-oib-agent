import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  MissingTenantContextError,
  ORGANIZATION_SETTING,
  PLATFORM_ROLE,
  USER_SETTING,
  getTenantContext,
  type TenantContext,
} from "./tenant-context";

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

/** A postgres-js connection, as handed to us inside `begin`. */
type Connection = postgres.TransactionSql<Record<string, never>>;

/**
 * Apply the caller's context to a connection, inside the open transaction.
 *
 * `set_config(..., true)` and `SET LOCAL` are both transaction-local, so
 * nothing survives to the next borrower of this pooled connection — the
 * property that makes a shared pool safe to use with row-level security at all.
 */
async function applyContext(connection: Connection, context: TenantContext): Promise<void> {
  if (context.kind === "platform") {
    // A constant, never interpolated from input: SET ROLE takes an identifier,
    // which cannot be a bind parameter.
    await connection.unsafe(`SET LOCAL ROLE ${PLATFORM_ROLE}`);
    return;
  }
  await connection.unsafe(
    `SELECT set_config($1, $2, true), set_config($3, $4, true)`,
    [ORGANIZATION_SETTING, context.organizationId, USER_SETTING, context.userId ?? ""],
  );
}

/**
 * The query shape drizzle's postgres-js driver expects back from `unsafe`:
 * awaitable for row objects, or `.values()` for positional arrays.
 */
interface PendingQuery<T> extends PromiseLike<T> {
  values(): Promise<T>;
  execute(): Promise<T>;
}

/**
 * Wrap the postgres-js client so that every statement carries the caller's
 * tenant context — the single chokepoint this feature rests on.
 *
 * drizzle's postgres-js driver reaches the database through exactly two methods:
 * `client.unsafe()` for statements and `client.begin()` for transactions. Both
 * are intercepted here, so the context is applied to all database access
 * without a single repository or query changing, and there is no second way in
 * that could be left out. Each statement runs inside its own transaction so the
 * settings apply to it and expire with it; postgres-js pipelines the statements
 * of a transaction, so the added cost is well under one round trip.
 *
 * Access with no context throws rather than silently returning nothing —
 * see {@link MissingTenantContextError}.
 */
function tenantScopedClient(base: ReturnType<typeof postgres>): ReturnType<typeof postgres> {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "unsafe") {
        return (query: string, params?: unknown[], options?: unknown): PendingQuery<unknown> => {
          const context = getTenantContext();
          if (!context) throw new MissingTenantContextError();

          // One execution per returned object, however many times it is awaited.
          let started: Promise<unknown> | null = null;
          const run = (positional: boolean): Promise<unknown> => {
            started ??= target.begin(async (connection) => {
              await applyContext(connection, context);
              const pending = connection.unsafe(
                query,
                params as never,
                options as never,
              ) as unknown as PendingQuery<unknown>;
              return positional ? await pending.values() : await pending;
            }) as Promise<unknown>;
            return started;
          };

          return {
            values: () => run(true),
            execute: () => run(false),
            then: (resolve, reject) => run(false).then(resolve, reject),
          } as PendingQuery<unknown>;
        };
      }

      if (property === "begin") {
        return (fn: (connection: Connection) => Promise<unknown>) => {
          const context = getTenantContext();
          if (!context) throw new MissingTenantContextError();
          return target.begin(async (connection) => {
            // Applied once at BEGIN, so it covers every statement the
            // transaction goes on to run.
            await applyContext(connection, context);
            return fn(connection);
          });
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReturnType<typeof postgres>;
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
  dbInstance = drizzle(tenantScopedClient(client));

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

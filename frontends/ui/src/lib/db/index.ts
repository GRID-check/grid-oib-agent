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
 * Identifiers we will interpolate into a `SET LOCAL`. Deliberately narrower
 * than what WorkOS emits (`org_01H…`, `user_01H…`): `SET LOCAL` takes no bind
 * parameters, so the only safe input is one that cannot carry quoting at all.
 * Anything else fails closed rather than being escaped and hoped about.
 */
const SAFE_SETTING_VALUE = /^[A-Za-z0-9_-]*$/;

function settingLiteral(name: string, value: string): string {
  if (!SAFE_SETTING_VALUE.test(value)) {
    throw new Error(`[db] refusing to set ${name}: value is not a plain identifier`);
  }
  return `SET LOCAL "${name}" = '${value}'`;
}

/**
 * Apply the caller's context to a connection, inside the open transaction.
 *
 * Both branches are `SET LOCAL`, and that they are UTILITY statements rather
 * than queries is load-bearing. An earlier version used
 * `SELECT set_config(...)`, which counts as a query — so drizzle's
 * `db.transaction(fn, { isolationLevel })` then failed with
 * "SET TRANSACTION ISOLATION LEVEL must be called before any query", but ONLY
 * for tenant scopes: the platform branch already used `SET LOCAL ROLE` and was
 * unaffected. A trap that fires on the read-modify-write paths most likely to
 * reach for `serializable`, and nowhere else.
 *
 * `SET LOCAL` is transaction-local, so nothing survives to the next borrower of
 * this pooled connection — the property that makes a shared pool safe to use
 * with row-level security at all.
 */
async function applyContext(connection: Connection, context: TenantContext): Promise<void> {
  if (context.kind === "platform") {
    // A constant, never interpolated from input.
    await connection.unsafe(`SET LOCAL ROLE ${PLATFORM_ROLE}`);
    return;
  }
  await connection.unsafe(
    [
      settingLiteral(ORGANIZATION_SETTING, context.organizationId),
      settingLiteral(USER_SETTING, context.userId ?? ""),
    ].join("; "),
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
 * without a single repository or query changing. The raw client is callable as
 * a tagged template and exposes `reserve`/`listen`/`notify`/`file`, which would
 * each be a way around this — so they are refused rather than left as a gap
 * that reads like coverage.
 *
 * ## Cost, measured
 *
 * Each statement runs inside its own transaction so the settings apply to it
 * and expire with it. That is BEGIN, the `SET LOCAL`s, the statement, COMMIT.
 * They are NOT pipelined — postgres-js awaits its own BEGIN before invoking the
 * callback — so it is roughly 4 round trips per statement, measured at ~4-5x a
 * bare statement over a unix socket (an earlier version of this comment claimed
 * "well under one round trip", which was simply wrong). On a fast link that is
 * microseconds; on a 1 ms network it is ~3 ms per statement, and it holds a
 * pool slot throughout. If that ever bites, the fix is a connection reserved
 * per REQUEST with the settings applied once — not a return to unscoped
 * queries.
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

          // One execution per returned object, PER SHAPE. Memoising a single
          // promise regardless of `positional` would let a later `.values()`
          // receive row objects (or the reverse) — and drizzle indexes
          // positional rows by number, so the result is silently `undefined`
          // columns rather than an error.
          const started: { rows?: Promise<unknown>; values?: Promise<unknown> } = {};
          const run = (positional: boolean): Promise<unknown> => {
            const key = positional ? "values" : "rows";
            started[key] ??= target.begin(async (connection) => {
              await applyContext(connection, context);
              const pending = connection.unsafe(
                query,
                params as never,
                options as never,
              ) as unknown as PendingQuery<unknown>;
              return positional ? await pending.values() : await pending;
            }) as Promise<unknown>;
            return started[key];
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
          // Rejected, not thrown: drizzle's `db.transaction(...)` returns this
          // synchronously, so a throw here escapes as a synchronous exception
          // while `db.execute()` rejects. Callers should not have to handle
          // both shapes for the same condition.
          if (!context) return Promise.reject(new MissingTenantContextError());
          return target.begin(async (connection) => {
            // Applied once at BEGIN, so it covers every statement the
            // transaction goes on to run.
            await applyContext(connection, context);
            return fn(connection);
          });
        };
      }

      // Ways to reach Postgres that would not carry a context. None is used in
      // this codebase; refusing them keeps "there is no second way in" true
      // rather than aspirational.
      if (property === "reserve" || property === "listen" || property === "notify" || property === "file") {
        return () => {
          throw new Error(
            `[db] client.${String(property)}() bypasses the tenant context. Use getDb() ` +
              `inside withTenant()/withPlatformAccess(), or add an interception here.`,
          );
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },

    // The postgres-js client is itself callable as a tagged template, so
    // `db.$client\`select …\`` would otherwise run entirely outside the
    // chokepoint. There is no context to apply to a template literal here, so
    // refuse it rather than let it through unscoped.
    apply() {
      throw new Error(
        "[db] the raw postgres client is not callable through this proxy — every " +
          "statement must go through getDb() so it carries a tenant context.",
      );
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
    // Bound the pool so a slow or unreachable database cannot open unlimited
    // connections. NOTE: postgres-js has no ACQUISITION timeout — `connect_timeout`
    // bounds the TCP/startup handshake only — so past this bound callers queue
    // rather than failing fast. Since every statement now takes a slot for a
    // transaction, a `getDb()` call made INSIDE an open `db.transaction()` needs
    // a second slot and can deadlock a saturated pool; always use the `tx`
    // handle inside a transaction body.
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

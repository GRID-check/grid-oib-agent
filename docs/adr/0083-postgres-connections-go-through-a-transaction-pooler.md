---
status: proposed
date: 2026-10-07
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Postgres connections go through a transaction pooler; session features take a direct connection

## Context and Problem Statement

`grid-pg` runs with `max_connections: 200` (`POSTGRES_TUNING`), and nothing pooled
on the server side. Every client held its own connections open. Counted from the
code, one Python process can open about 130 server connections: seven or eight
SQLAlchemy engines at pool 5 plus overflow 10, the NAT job store's asyncpg engines,
and the LangGraph checkpoint pool at up to 10. Production runs one web, three
agent-worker and five ingest-worker Python processes, and the BFF tiers add about
100 more (postgres.js `max` 10 per pod: frontend 3, bff-jobs 4 with a runner each,
the purger, the scheduler). The sum is several times 200. It held only because
most of those pools sit mostly idle, and the first replica added to any tier (KEDA
scales three of them) spends connections that nothing accounts for. A primary out
of slots does not slow down; new sessions get "too many clients" while old ones
keep running, so whichever tier reconnects first fails, which is a deploy, a
failover or a scale-out.

Tuning every pool down would hold the number, but it would put the budget in a
dozen places that no one reads together. A pooler puts it in one.

A transaction pooler is not free, though. It hands a server connection to one
client for one transaction, so anything that needs the same server connection
across statements stops working, and does so without an error:

- `LISTEN` (the job SSE streams) registers on a server connection the client does
  not keep, so no notification arrives and the stream silently degrades to polling.
- A session advisory lock (`leader_lock`, `keyed_lock`, the ghost-job reaper's
  lock) is taken on one server connection and "released" on another. Measured
  against PgBouncer 1.22: two successive lock attempts through the pooler both
  succeeded, and the lock was still held on the server after both clients had
  closed, so every later holder on a direct connection was refused.
- postgres.js sends `statement_timeout` as a startup parameter, which PgBouncer
  rejects (`unsupported startup parameter: statement_timeout`), so the BFF could
  not open a connection at all.
- Protocol-level prepared statements (psycopg3 after the fifth run of a statement,
  asyncpg for every statement) need PgBouncer's `max_prepared_statements`. Without
  it asyncpg fails with `InvalidSQLStatementNameError: prepared statement
  "__asyncpg_stmt_6__" does not exist`.

## Decision Drivers

* The primary's `max_connections` is the one hard ceiling, and a breach shows up on
  whichever tier reconnects, not where the change was made.
* The product owner's rule: no fallbacks, no compatibility switches, one path per
  concern. A session feature must not have a pooled path "just in case".
* A session-feature regression has to fail in development (Docker Compose) and in
  a spec, not first in production.
* Complexity that belongs to someone else's domain is a dependency, not a module.

## Considered Options

* No pooler; tune every client's pool down.
* CloudNativePG `Pooler` in session mode.
* CloudNativePG `Pooler` in transaction mode; session features on a direct DSN.
* An external pooler service (a standalone PgBouncer Deployment or a managed one).

## Decision Outcome

Chosen option: "CloudNativePG `Pooler` in transaction mode; session features on a
direct DSN", because it is the only option that bounds server connections by a
number set in one place, keeps clients' own pools and their cheap `SET LOCAL`
tenant context (ADR-0041), and costs one declarative resource.

The rules:

* **`grid-pg-pooler-rw`** is a `Pooler` of `type: rw` with `poolMode: transaction`,
  `max_client_conn` 2000, `default_pool_size` from `pgPoolerPoolSize` (default 12)
  and `max_prepared_statements` 200, on `pgPoolerInstances` PgBouncers (default 2,
  dev 1), spread across nodes with a PodDisruptionBudget when there is more than
  one. The image is CloudNativePG's own build, pinned by tag and digest in
  `config.ts` and scanned by the same trivy job as the other pinned images.
* **Every DSN states its route.** The `dsn()` helper takes `via: "pooler" | "direct"`
  with no default. Pooled: `NAT_JOB_STORE_DB_URL`, `AIQ_CHECKPOINT_DB`,
  `AIQ_DEEP_CHECKPOINT_DB`, `AIQ_SUMMARY_DB`, `GRID_APP_DATABASE_URL`. Direct
  (`grid-pg-rw`): `AIQ_LISTEN_DB_URL`, the new `AIQ_LOCK_DB_URL`,
  `GRID_APP_MIGRATION_DATABASE_URL`, KEDA's scaler DSNs, the init and grants Jobs,
  Langfuse (Prisma migrates under a session advisory lock of its own) and the
  SeaweedFS filer's store.
* **Session-scoped features use the direct DSN and nowhere else.** Every session
  advisory lock is taken through `aiq_agent.knowledge.leader_lock` on an engine
  built from `AIQ_LOCK_DB_URL` that never pools (`NullPool`, autocommit). The
  ghost-job reaper uses it instead of its own SQL. The locks fail closed: when
  a leader election cannot be held nobody leads that cycle (logged, and every
  caller is on a schedule that retries), and `keyed_lock` raises so the file
  fails instead of replacing a document unguarded across replicas. A process
  with no Postgres at all keeps its in-process behaviour, which is a
  configuration and not a fallback.
* **A missing direct DSN stops the boot, once.** `require_direct_dsns` runs at
  start in the web tier (both DSNs, it serves the SSE streams and takes locks),
  the research worker and the ingest worker (the lock DSN only; they never
  LISTEN). There is no default to the pooled job-store URL, so a deployment that
  was never given its direct DSN fails to start instead of failing every request.
  Transaction-scoped locks (`pg_advisory_xact_lock`) and `FOR UPDATE SKIP LOCKED`
  work through the pooler and are unchanged.
* **The BFF's statement timeout is `SET LOCAL`.** `statement_timeout` leaves the
  postgres.js startup packet and rides in the same batch as the tenant context
  that opens each statement's transaction, for the tenant and the platform branch
  alike (`contextStatement`, one round trip). The bff-jobs runner, the purger and
  the scheduler open their own clients and send no startup parameters beyond
  postgres.js's defaults, so they needed no change.
* **Prepared statements stay on** in the Python drivers. With
  `max_prepared_statements` set, the SQLAlchemy asyncpg dialect works with its
  default statement names and cache; the dynamic-name and `NullPool` workaround in
  its documentation is for PgBouncer before 1.21. No `prepare_threshold=None`.
* **A connection budget fails the plan.** `assertPgConnectionBudget` requires
  `pgPoolerInstances x (pooled database/role pairs x pgPoolerPoolSize + 1 auth
  session) + the direct reserve <= max_connections`. The reserve is named by part
  in `POSTGRES_DIRECT_RESERVE`: the superuser reserve (3), CloudNativePG (6),
  job SSE LISTEN streams (20, an allowance: no code caps the streams), session
  locks (ingest jobs in flight plus 4), migration and bootstrap Jobs (6), KEDA's
  scaler login (its `connectionLimit`, 8), Langfuse (20, when deployed) and the
  filer (40 per replica, when it keeps its store in Postgres). Production: 74
  pooled + 82 direct = 156 of 200. A fresh stack with everything on: 196.
* **Docker Compose mirrors it**, with a standalone `edoburu/pgbouncer` (CloudNativePG's
  image expects its operator to write the config; Bitnami's free images are
  discontinued), the same parameters and the same pooled and direct split, so a
  session-feature regression fails in development.

### Consequences

* Good, because server connections are bounded by one budget the plan checks, and
  adding a replica to a tier no longer spends slots nobody counted.
* Good, because the failure modes above, each silent, now have a place where they
  are impossible by construction (`via` has no default, the lock engine has one
  source) and a spec where they are caught.
* Good, because Compose runs the same topology, so a pooled `LISTEN` or lock fails
  on a laptop.
* Bad, because a pooler is another component to run, patch and upgrade, and a hop
  on every pooled statement. A PgBouncer pod replaced during a rollout drops the
  transactions in flight on it; clients retry on their next statement.
* Bad, because clients past `pgPoolerPoolSize` wait in PgBouncer (`cl_waiting`)
  instead of failing, which hides saturation behind latency.
* Bad, because the direct reserve is an estimate in several parts, and the SSE
  allowance in particular is not backed by a cap in code.
* Bad, because failing closed costs availability: with the lock database down no
  replica runs the TTL cleanup or the reaper for that tick, and every re-ingest
  fails until it is back. That is the intended trade against two replicas acting
  at once.
* Bad, because a session feature that is added later and takes the pooled DSN
  fails silently. Only the specs and review hold that line.

### Confirmation

* `deploy/pulumi/index-pooler.spec.ts` builds the whole program and asserts, for
  every Postgres DSN it emits, whether its host is the pooler Service or
  `grid-pg-rw`, and fails on a DSN that is not in the table. It also asserts the
  Pooler manifest (transaction mode, parameters, pinned image, spread and PDB),
  that the filer reads `grid-pg-rw`, and that the pooled (database, role) pairs
  are the ones the budget pays for. `index-pooler-single.spec.ts` covers one
  instance.
* `deploy/pulumi/src/pg-budget.spec.ts` covers `assertPgConnectionBudget`: the
  arithmetic, production and the fresh-stack worst case fitting, and the refusal
  naming every number.
* `tests/aiq_agent/knowledge/test_leader_lock.py` and `test_keyed_lock.py` pin the
  lock engine's URL, statements, release and fail-closed behaviour, and the
  start-up check; `frontends/aiq_api/tests/test_direct_dsn_startup.py` drives each
  tier's entry point without the DSNs; `tests/test_compose_pooler_routes.py` holds
  both Compose files to the same split; `frontends/aiq_api/tests/test_reaper_lock.py`
  and `test_sse_stream.py` pin the reaper and the SSE listener to their direct DSNs.
* `frontends/ui/src/lib/db/index.spec.ts` pins the BFF: no startup parameters, and
  the timeout in the opening batch of every transaction path.
* The `image-scan` job in `.github/workflows/security.yml` fails when the pinned
  PgBouncer image is missing or stale.

## Pros and Cons of the Options

### No pooler; tune every client's pool down

* Good, because it adds no component.
* Bad, because the budget lives in a dozen pool settings across two languages, and
  every replica KEDA adds multiplies it again.
* Bad, because pools tuned down to fit leave each process unable to use the
  connections it is allowed in a burst.

### CloudNativePG `Pooler` in session mode

* Good, because LISTEN and session locks would work through it unchanged.
* Bad, because a session pooler holds a server connection for a client's whole
  life, so it bounds nothing: the sum of idle client pools is still the sum.

### CloudNativePG `Pooler` in transaction mode (chosen)

* Good, because it bounds the server by `pgPoolerPoolSize`, is one declarative
  resource the operator keeps in step with the primary, and keeps the BFF's
  per-transaction `SET LOCAL` context safe, since nothing outlives a transaction.
* Bad, because session features need a second, direct route and discipline to use
  it.

### An external pooler service

* Good, because it could be shared and sized apart from the cluster.
* Bad, because it is a second stateful-ish service to deploy and secure, outside
  the operator that already tracks the primary through a failover and manages the
  auth query. Nothing here needs it.

## More Information

Revisit if the primary's `max_connections` is raised past what a single node's
memory supports (the budget's ceiling moves with it), if `cl_waiting` shows
sustained queueing at the default pool size, or if the SSE streams are capped in
code (the allowance can then become a limit).

Related: ADR-0041 (row-level security and the per-transaction tenant context),
ADR-0079 (the claim queues and KEDA's scaler login), ADR-0043 (the SeaweedFS filer
store). Scaling review item 8: `docs/architecture/scaling-review-2026-07.md`.

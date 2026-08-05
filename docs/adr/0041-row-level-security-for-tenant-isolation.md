# ADR-0041: Row-level security as the last line of tenant isolation

- **Status:** Accepted
- **Date:** 2026-08-04
- **Deciders:** Platform / backend
- **Related:** ADR-0004 (tenancy, ownership and access model), ADR-0017 (BFF repository/service architecture), ADR-0038 (one authorization catalog and decision point), [`../database/row-level-security.md`](../database/row-level-security.md)

## Context

Tenant isolation in `grid_app` rested entirely on application code. ADR-0017
requires every repository query to carry `organization_id` in its `WHERE`
clause, and `lib/projects/repository.ts` says so in its header. That convention
is well followed — and it is the only thing there is.

Which means the failure mode is a single missing predicate. Seventeen
repositories query the database today and the number grows with every feature.
A query that forgets its organization filter returns other tenants' rows, the
response is a valid-looking list, no test fails, no alert fires, and nothing in
the stack objects. The same is true of a `WHERE` that scopes on the wrong
column, a join that widens the result set, and a new table whose repository is
written from memory rather than from the pattern.

The authorization tier is genuinely strong — ADR-0038 gave it one catalog and
one decision point — but it answers a different question. `decide.ts` rules on
whether a caller may perform an action on a resource. It says nothing about
which rows a query returns once the handler is running, and by construction it
cannot: it never sees the SQL.

Postgres can enforce the row rule directly, underneath the application, where
the query cannot get around it. It was not being used.

## Decision

We will enforce tenant isolation in the database with row-level security, as a
second, independent layer beneath the application's `WHERE` clauses — not as a
replacement for them.

**Three database roles**, so the runtime credential is not the credential that
owns the schema:

| Role | Used by | RLS | Privileges |
|---|---|---|---|
| the table owner (`aiq` in compose/Kubernetes) | drizzle migrations | exempt (owner; we do not `FORCE`) | DDL + DML |
| `grid_app_rw` | the BFF and both workers | **enforced** | DML only, per-table grants |
| `grid_app_platform` | deliberate cross-tenant work | bypassed (`BYPASSRLS`) | DML only |

The owner is exempt on purpose: `FORCE ROW LEVEL SECURITY` would apply the
policies to migrations too, and a data backfill would then silently update zero
rows — a migration that reports success and does nothing. `grid_app_platform`
is `NOLOGIN` and reachable only through `SET LOCAL ROLE`, so a cross-tenant
read is recorded as `current_user` in `pg_stat_activity` and the query log
rather than merely asserted in application code.

What membership does and does not confer, precisely, because the difference is
the whole security argument:

- Role **attributes** (`BYPASSRLS`, `SUPERUSER`, `CREATEROLE`) are never
  inherited. Granting `grid_app_platform` to `grid_app_rw` does not give the
  runtime role `BYPASSRLS`; only the explicit `SET LOCAL ROLE` step-up does.
- Role **object privileges** (the table grants) *are* inherited — but only by an
  `INHERIT` role. `grid_app_rw` is created `NOINHERIT` for exactly this reason,
  so even the platform tables' grants require the step-up. Both provisioning
  paths in `ensure-rls-roles.mjs` set it: the `CREATE ROLE` path and the
  `ALTER ROLE` path taken when the role already exists. Missing it on the second
  was a real defect — an upgraded `INHERIT` role would have picked up
  platform-table writes silently.

**One policy per table**, from two settings the caller supplies:
`grid.organization_id` and `grid.user_id`. `current_setting(name, true)` yields
NULL when unset and `organization_id = NULL` is not TRUE, so a query with no
context matches no rows — fail-closed by default rather than by remembering.
Migration `0030_row_level_security.sql` puts all 28 tables inside the boundary
through a `grid_secure_table(table, predicate)` helper, so joining the boundary
is one line stating the tenancy rule.

**The context comes from `getGridSession()`.** It is the one funnel every
authenticated path already passes through — API routes via
`requireAuthorizedSession`, pages and server actions via
`requireAuthorizedPageSession` — so the function that resolves *who is asking*
also publishes it, into an `AsyncLocalStorage`. Repository signatures do not
change and no call site can forget to pass an organization, which is the exact
mistake this ADR exists to prevent. Callers with no session state it
explicitly: `withTenant`, `withPlatformAccess`, `withOptionalTenant`.

**Route factories open the scope with `run()`; `enterWith()` is a bounded
fallback.** This is a correctness requirement and it was found the hard way. `enterWith` has no scope
end: it writes into the current async resource, and Node reuses that resource
for the next request on the same keep-alive socket. Reproduced against a plain
`node:http` server — one request published a tenant, awaited, and the two
requests that followed it on that socket inherited it. An enclosing `run()` on
a different `AsyncLocalStorage` did not contain it either.

The danger is not the request that sets a tenant. It is a later request that
sets NONE, should therefore fail closed, and instead reads or writes as whoever
used the socket last — turning this feature's central guarantee inside out, and
turning `internalApiRoute`'s "the handler must open its own scope" from a
fail-closed contract into a fail-open one.

So every route factory opens an empty, request-scoped **slot** with `run()`,
and `getGridSession()` fills it in. `run()` bounds it: the request starts with
no inherited tenant and leaves none behind. `enterWith` survives only as the
fallback for server components and server actions, which no factory wraps — and
even there it installs a fresh slot object rather than a bare value, so a
leaked slot is replaced rather than read.

**`lib/db` applies it at one chokepoint.** drizzle's postgres-js driver reaches
the database through exactly two methods — `client.unsafe()` for statements and
`client.begin()` for transactions — and both are wrapped, so every statement
carries the settings and there is no second way in. Access with no context
throws `MissingTenantContextError` rather than returning an empty result,
because a silent empty list is a bug report about missing data instead of about
missing authorization.

**`internalApiRoute` requires a `tenancy` declaration**, the same doctrine
ADR-0038 applied to `authz`: either `{ fromPayload }`, naming where the
organization arrives, or `{ crossTenant }`, recording why there is none.

## Consequences

### Positive

- A missing or wrong `WHERE organization_id` stops being a data leak. It
  becomes an empty result — a visible bug with no cross-tenant consequence.
- The runtime credential can no longer run DDL or write platform-wide
    configuration by accident: `platform_*` tables grant it `SELECT` only, so an
    ordinary tenant-facing bug cannot rewrite platform defaults. (It can still
    `SET ROLE grid_app_platform` deliberately — see the boundary note below —
    and `CONNECT` to the other databases on the cluster is not revoked, though
    it holds no table grants there.)
- Cross-tenant access is explicit, greppable and attributable: a named
  `withPlatformAccess(reason, …)` in the code and a distinct `current_user` in
  the database log.
- `rls-coverage.spec.ts` fails when a table in the drizzle schema is missing
  from the migration, so a new table cannot ship outside the boundary. There is
  also no `ALTER DEFAULT PRIVILEGES`: forgetting produces `permission denied`,
  not a quiet cross-tenant read.

### Negative

- Every statement now runs inside a transaction so the settings are
  transaction-local: BEGIN, the `SET LOCAL`s, the statement, COMMIT. These are
  NOT pipelined — postgres-js awaits its own BEGIN before invoking the callback
  — so it is ~4 round trips per statement, measured at 4-5x a bare statement
  over a unix socket. Negligible on a local link, ~3 ms per statement on a 1 ms
  network, and a pool slot is held throughout. If it bites, the fix is a
  connection reserved per REQUEST with the settings applied once.
- Two tables (`agent_profiler_spans`, `citation_events`) have a nullable
  `organization_id`. Such a row belongs to no tenant and satisfies no tenant
  predicate, so it is written under `withOptionalTenant` and is thereafter
  visible only to the platform tier.
- Deployments now distinguish the migration credential from the runtime one
  (`GRID_APP_MIGRATION_DATABASE_URL` vs `GRID_APP_DATABASE_URL`).

### Risks

- **A path that never establishes context breaks loudly.** That is the intended
  trade — fail-closed and obvious beats fail-open and quiet — but it is a
  rollout risk. Mitigated by the coverage spec, by the compiler (`tenancy` does
  not typecheck without a decision), and by an integration suite that runs the
  real `getDb()` as `grid_app_rw` against real policies.
- **A worker that loses its step-up goes quiet rather than failing.** RLS would
  hide every row, the queue would look empty, and the tick would report healthy.
  The purger and scheduler share one helper and both have specs asserting the
  step-up is issued.
- **A refactor could drop a factory's `run()`** and reintroduce the keep-alive
  leak, which fails open and silently. `tenant-context.spec.ts` asserts every
  factory opens a slot and that `enterWith` has exactly one call site. The
  keep-alive reproduction itself is deliberately not a test: it asserts Node's
  scheduling rather than our code and does not fire under the vitest runner, so
  it would be a flake that proves nothing.

### What this does NOT defend against

Stated plainly so the boundary is not mistaken for a stronger one: settings are
unprivileged, so anyone holding the `grid_app_rw` credential can set
`grid.organization_id` to any value and read any tenant. RLS defends against
**application bugs**, not against a compromised application or a stolen
credential. Defending against those requires per-tenant credentials — a
connection pool per tenant — which we are not buying. Least privilege still
bounds what a BUG can do — no DDL, no ownership — but not what deliberate SQL
can: `grid_app_rw` is a member of `grid_app_platform`, so `SET ROLE` is always
available to it, and `CONNECT` to the cluster's other databases is not
revoked.

## Alternatives Considered

- **Keep relying on `WHERE` clauses, and add a lint rule.** A linter can see
  that `organization_id` appears; it cannot see that it is the *right* one, that
  the join did not widen the set, or that the raw `sql` fragment is scoped. It
  addresses the typo and not the class.
- **A `grid.platform` setting instead of a bypass role.** Simpler by one
  concept, but the bypass would then be a string comparison inside every policy,
  invisible in the database's own logs. The role makes each tenant policy a
  single predicate with no bypass branch, and makes the bypass auditable.
- **Denormalise `organization_id` onto `messages`, `conversation_reads` and
  `project_folders`** for a uniform policy. Rejected at first, then **adopted for
  `messages` and `conversation_reads`** in migration `0031` once the cost was
  measured rather than assumed. The rejection rested on two claims that did not
  survive: that the subquery plans as a semi-join (it does not — a policy's
  `EXISTS` is expanded after sublink pull-up, giving a per-row correlated
  SubPlan for a large tenant), and that a denormalised copy is a second source of
  truth (it is not, once a composite foreign key makes
  `(conversation_id, organization_id)` reference
  `conversations (id, organization_id)` — Postgres then refuses a row whose
  organization disagrees with its parent's). Measured on 395k messages:
  4.01 ms → 0.70 ms, buffers 7 075 → 55. `project_folders` was **not**
  denormalised; a composite foreign key alone was enough there.
- **A second connection pool, or a separate login, for platform access.**
  Rejected. The obvious form of the objection — a compromised BFF can
  `SET LOCAL ROLE grid_app_platform`, so give the workers their own login and
  withhold the membership from the BFF — does not hold, because the BFF has its
  own legitimate platform surface: every platform-owner route runs under
  `platformApiRoute`, which steps up. Withholding the membership would break
  those routes; keeping a second credential *as well* would add a secret to
  manage without removing the capability from the process that worried us. And
  since a stolen `grid_app_rw` credential can set any `grid.organization_id`
  regardless, neither variant raises the floor. What does the work is that the
  step-up is explicit (`NOINHERIT`), transaction-scoped, and visible as
  `current_user` in the query log.
- **Wrap each request in one long transaction.** Rejected: a request that waits
  on WorkOS or the agent backend would hold a pooled connection for its whole
  duration. The context holds plain data instead, and connections are taken per
  statement.

## Open Questions / Follow-ups

- **`messages` should carry its own `organization_id`.** Its policy resolves
  tenancy through `conversations`, and a policy's `EXISTS` never becomes a
  semi-join — for a large tenant it degrades to a per-row correlated subplan.
  Measured on 395k messages: loading 1000 rows for a tenant with 100k
  conversations is 6.7x slower and touches 104x the buffers versus the same
  query as the owner, and the cost scales with the tenant's conversation count
  rather than the page size. Adding the column with a composite foreign key to
  `conversations (id, organization_id)` measured 4.01 ms → 0.70 ms and answers
  the "second source of truth" objection, because the database then refuses to
  let the copy diverge. **Done** in migration `0031`, in this same change.

- `pgRuntimePassword` is required and has no fallback. It briefly defaulted to
  `pgAppPassword` so existing stacks could deploy without a coordinated
  rotation, on the reasoning that what bounds `grid_app_rw` is its privileges
  rather than password distinctness. Review caught the flaw: Postgres
  authenticates by (role, password), so a shared password let anyone holding the
  runtime DSN authenticate as `aiq`, the schema owner, who is exempt from every
  policy — the privilege split is worth exactly what the credential split is
  worth. Existing stacks must set and rotate it before their next deploy.
- Roles are provisioned by each deployment rather than by the migration, and
  migration 0030 asserts them. An earlier draft created them in SQL and could
  not run on Kubernetes at all: `CREATE ROLE ... BYPASSRLS` requires the creator
  to hold `BYPASSRLS`, which CloudNativePG's application user does not — and
  granting it would defeat the purpose. Roles are cluster objects; schema
  migrations are the wrong place for them.

## References

- [`docs/database/row-level-security.md`](../database/row-level-security.md) — operator and contributor runbook
- `frontends/ui/drizzle/0030_row_level_security.sql` — the boundary itself
- `frontends/ui/src/lib/db/tenant-context.ts` — where context comes from
- `frontends/ui/src/lib/db/index.ts` — the chokepoint that applies it
- PostgreSQL manual, [Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)

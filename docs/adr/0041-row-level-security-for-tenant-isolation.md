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
| `grid_app_owner` | drizzle migrations | exempt (owner; we do not `FORCE`) | DDL + DML |
| `grid_app_rw` | the BFF and both workers | **enforced** | DML only, per-table grants |
| `grid_app_platform` | deliberate cross-tenant work | bypassed (`BYPASSRLS`) | DML only |

The owner is exempt on purpose: `FORCE ROW LEVEL SECURITY` would apply the
policies to migrations too, and a data backfill would then silently update zero
rows — a migration that reports success and does nothing. `grid_app_platform`
is `NOLOGIN` and reachable only through `SET LOCAL ROLE`, so a cross-tenant
read is recorded as `current_user` in `pg_stat_activity` and the query log
rather than merely asserted in application code. Role *attributes* are not
inherited through membership, so granting it to `grid_app_rw` does not leak
`BYPASSRLS`; only the explicit step-up does.

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
- The runtime credential can no longer run DDL, reach another database, or
  write platform-wide configuration. `platform_*` tables grant `SELECT` only to
  `grid_app_rw`, so a tenant-facing bug cannot rewrite platform defaults.
- Cross-tenant access is explicit, greppable and attributable: a named
  `withPlatformAccess(reason, …)` in the code and a distinct `current_user` in
  the database log.
- `rls-coverage.spec.ts` fails when a table in the drizzle schema is missing
  from the migration, so a new table cannot ship outside the boundary. There is
  also no `ALTER DEFAULT PRIVILEGES`: forgetting produces `permission denied`,
  not a quiet cross-tenant read.

### Negative

- Every statement now runs inside a transaction so the settings are
  transaction-local. postgres-js pipelines a transaction's statements, so the
  cost is well under one extra round trip, but it is not zero.
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

### What this does NOT defend against

Stated plainly so the boundary is not mistaken for a stronger one: settings are
unprivileged, so anyone holding the `grid_app_rw` credential can set
`grid.organization_id` to any value and read any tenant. RLS defends against
**application bugs**, not against a compromised application or a stolen
credential. Defending against those requires per-tenant credentials — a
connection pool per tenant — which we are not buying. Least privilege still
bounds the blast radius: no DDL, no other database, no platform writes.

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
  `project_folders`** for a uniform policy. Rejected: it creates a second source
  of a fact that can disagree with the parent, plus a backfill and a drizzle
  schema change, to avoid a primary-key probe that Postgres plans as a
  semi-join.
- **A second connection pool for platform access.** Rejected as cost without
  benefit: since a stolen credential can set any organization anyway, a separate
  pool does not raise the floor, and it doubles the connection budget.
- **Wrap each request in one long transaction.** Rejected: a request that waits
  on WorkOS or the agent backend would hold a pooled connection for its whole
  duration. The context holds plain data instead, and connections are taken per
  statement.

## Open Questions / Follow-ups

- `pgRuntimePassword` currently defaults to `pgAppPassword`, so existing stacks
  deploy without a coordinated rotation. What bounds `grid_app_rw` is its
  privileges rather than password distinctness, but separating them is
  recommended and should become the default once stacks have rotated.
- The migration creates roles, so the migrating role needs `CREATEROLE`. On a
  managed provider that forbids it, the roles must be pre-created; the runbook
  covers this.

## References

- [`docs/database/row-level-security.md`](../database/row-level-security.md) — operator and contributor runbook
- `frontends/ui/drizzle/0030_row_level_security.sql` — the boundary itself
- `frontends/ui/src/lib/db/tenant-context.ts` — where context comes from
- `frontends/ui/src/lib/db/index.ts` — the chokepoint that applies it
- PostgreSQL manual, [Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)

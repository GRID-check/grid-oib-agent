# Row-level security in `grid_app`

Postgres enforces tenant isolation underneath the application, so a repository
that forgets `WHERE organization_id = …` returns **no rows** instead of another
tenant's. Rationale and the boundary's limits: **[ADR-0041](../adr/0041-row-level-security-for-tenant-isolation.md)**.

This page is the working reference: what to do when you add a table, what to do
when something returns nothing, and how to run it locally.

---

## The shape of it

```
getGridSession()          ← the one funnel every authenticated path passes through
    │                       publishes { organizationId, userId } into AsyncLocalStorage
    ▼
lib/db (the chokepoint)   ← wraps client.unsafe() and client.begin(), the only two
    │                       ways drizzle reaches Postgres. Applies the settings to
    │                       every statement, inside its own transaction.
    ▼
Postgres as grid_app_rw   ← one policy per table:
                            organization_id = current_setting('grid.organization_id')
```

No repository changed. No query changed. A query with no context throws
`MissingTenantContextError` before it is sent, and would match zero rows if it
somehow were.

### The three roles

| Role | Who uses it | RLS | May do |
|---|---|---|---|
| `grid_app_owner` | drizzle migrations | **exempt** (owner) | DDL + DML |
| `grid_app_rw` | BFF, purger, scheduler | **enforced** | DML on granted tables |
| `grid_app_platform` | deliberate cross-tenant work | **bypassed** | DML on granted tables |

The owner is exempt deliberately: with `FORCE ROW LEVEL SECURITY` a migration
that backfills data would silently update zero rows and report success.

`grid_app_platform` is `NOLOGIN`. It is reached only by `SET LOCAL ROLE`, which
means a cross-tenant read shows up as `current_user` in `pg_stat_activity` and
the query log. Role attributes are not inherited, so `grid_app_rw`'s membership
grants nothing until it explicitly steps up.

---

## Adding a table

Two lines, and the build tells you if you forget.

1. Declare it in `src/lib/db/schema/` as usual.
2. In the same migration that creates it, put it inside the boundary:

```sql
-- Tenant data: the row carries its own organization.
SELECT grid_secure_table('my_table', 'organization_id = grid_current_org()');

-- A child table with no organization_id: resolve through the parent.
SELECT grid_secure_table('my_child_table',
  'EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');

-- Platform-wide configuration: every tenant reads it, only the platform writes it.
SELECT grid_secure_platform_table('my_platform_table');
```

`grid_secure_table` enables RLS, installs the single `grid_tenant_isolation`
policy and grants DML — three statements that must agree, so they are one call.

If you skip it, `rls-coverage.spec.ts` fails by name:

```
These tables are outside the tenant boundary. Add a grid_secure_table() line
for each one to a migration: expected [ 'my_table' ] to deeply equal []
```

There is deliberately **no `ALTER DEFAULT PRIVILEGES`**. An unsecured table is
not readable-by-everyone; it is not readable at all, and you get
`permission denied for table my_table`. The safe default is worth the line.

> **One policy per table.** Two permissive policies OR together, so a second one
> silently *widens* the first. The coverage spec asserts exactly one.

---

## Writing code that touches the database

**Authenticated requests need nothing.** `getGridSession()` already published
the context — routes, server components and server actions alike.

**Everything else states its scope:**

```ts
import { withTenant, withPlatformAccess, withOptionalTenant } from '@/lib/db/tenant-context'

// One organization. For callers with no session (internal routes, workers).
await withTenant({ organizationId, userId }, () => repository.list(organizationId))

// Genuinely cross-tenant. The reason is required and shows up in review.
await withPlatformAccess('nightly retention sweep across all organizations', () => …)

// The column is nullable and this row may belong to no tenant.
await withOptionalTenant(organizationId, 'telemetry from a session with no org', () => …)
```

Internal routes must declare where their tenant comes from — it does not
compile otherwise:

```ts
export const POST = internalApiRoute('Label', handler, {
  tenancy: { fromPayload: 'body.organizationId' },   // handler opens the scope
  // or
  tenancy: { crossTenant: 'why this serves no single tenant' },  // factory does
})
```

> **Await inside the scope.** `withTenant` awaits your callback for you, so
> `withTenant(scope, () => db.select().from(projects))` is correct — a drizzle
> query builder is lazy and would otherwise execute after the scope closed.

---

## When something returns nothing

Symptoms map to causes almost one-to-one.

| Symptom | Cause | Fix |
|---|---|---|
| `MissingTenantContextError` | Code path never established a scope | Wrap it in `withTenant` / `withPlatformAccess` |
| `permission denied for table X` | Table not in the boundary, or a tenant writing a `platform_*` table | Add `grid_secure_table('X', …)`; platform writes go through `withPlatformAccess` |
| `new row violates row-level security policy` | The row's organization ≠ the active one | Usually correct behaviour — check which tenant you meant |
| Query returns `[]`, no error | Right context, wrong tenant — or a `NULL` `organization_id` row | `SELECT grid_current_org();` inside the same transaction |
| A worker goes quiet, ticks look healthy | Lost its `SET LOCAL ROLE` step-up | See `workers/platform-scope.js`; both workers have specs asserting it |

Confirm what the database thinks it is answering as:

```sql
BEGIN;
  SELECT set_config('grid.organization_id', 'org_123', true);
  SELECT current_user, grid_current_org();
COMMIT;
```

---

## Running it locally

The unit-level guard needs no database:

```bash
cd frontends/ui && npx vitest run src/lib/db/rls-coverage.spec.ts
```

The isolation suite needs a real Postgres, because the claim is that the
*database* refuses. It connects as `grid_app_rw`; connecting as the owner would
pass every assertion while proving nothing.

```bash
task db:test:rls          # throwaway cluster, full migration chain, then the suite
```

or against your own database:

```bash
export PGPASSWORD=...   # the password you gave grid_app_rw
export GRID_TEST_DATABASE_URL="postgres://grid_app_rw:$PGPASSWORD@localhost:5432/grid_app"
npx vitest run src/lib/db/tenant-isolation.integration.spec.ts
```

---

## Deploying

Migrations and runtime use **different credentials**:

| Variable | Role | Set on |
|---|---|---|
| `GRID_APP_DATABASE_URL` | `grid_app_rw` | frontend, purger, workflow-scheduler |
| `GRID_APP_MIGRATION_DATABASE_URL` | owner (`aiq`) | whatever runs `drizzle-kit migrate` |

`drizzle.config.ts` prefers the migration URL and falls back to the runtime one,
so a local checkout pointed at a throwaway database still works with one
variable.

- **Compose** — `deploy/compose/init-db.sql` gives `grid_app_rw` its LOGIN
  password (dev default `grid_app_rw_dev`; override with
  `GRID_APP_RUNTIME_PASSWORD`). That file runs only when Postgres initialises a
  **fresh** data directory, so on an upgraded stack the frontend container's
  `scripts/ensure-runtime-role.mjs` step synchronises the role's password from
  `GRID_APP_DATABASE_URL` before the server starts — one source of truth, and
  no manual step. The purger and scheduler connect as the same role, so on a
  first boot they may restart once or twice until the frontend has run that
  step; both are restart-safe and no state is lost.
- **Kubernetes** — the `pg-init-tables` Job sets it from the Pulumi secret.
  `pgRuntimePassword` defaults to `pgAppPassword` so an existing stack deploys
  without a coordinated rotation; setting it separately is recommended. What
  bounds this role is its *privileges*, not password distinctness.
- **The migrating role needs `CREATEROLE`**, because migration 0030 creates the
  roles — the invariant travels with the schema. On a managed provider that
  forbids it, pre-create `grid_app_owner`, `grid_app_rw` and `grid_app_platform`
  and the migration adopts them.

### Rolling back

Point `GRID_APP_DATABASE_URL` back at the owner credential. RLS does not apply
to a table's owner, so enforcement stops immediately with no schema change and
no downtime — useful as a break-glass step while a missed code path is fixed.
`0030_row_level_security.down.sql` removes the policies entirely; it leaves the
roles alone, since dropping a role a live deployment is connected as would take
the deployment with it.

---

## What this does not defend against

Settings are unprivileged. Anyone holding the `grid_app_rw` credential can set
`grid.organization_id` to any value and read any tenant. **RLS defends against
application bugs, not against a compromised application or a stolen
credential.** Least privilege still bounds the damage — no DDL, no other
database, no writes to platform configuration — but do not describe this
boundary as more than it is.

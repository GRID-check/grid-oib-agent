# Grid Application Database (`grid_app`)

This document describes the Next.js BFF's application database: what it stores, how it connects, and how schemas are managed.

---

## What `grid_app` stores

`grid_app` is the PostgreSQL database owned by the Next.js BFF/application tier. It holds all Grid-specific application state that is not already owned by the Python AI-Q agent:

| Area | Tables |
|---|---|
| Tenancy & ownership | `organizations`, `projects`, `project_members` |
| Conversations | `conversations`, `messages` |
| Documents | `documents` |

### Note on `organizations`

`organizations` is **not** a WorkOS mirror. It stores Grid-specific app settings keyed by the WorkOS org ID (`workos_org_id`): default project, retention policy, base knowledge config, etc. Users, memberships, roles, and permissions remain authoritative in WorkOS per [ADR-0007](../adr/0007-no-local-identity-sync.md).

The Python agent continues to own `aiq_jobs` (job metadata, summaries) and `aiq_checkpoints` (LangGraph graph state) directly. All three databases run on the same PostgreSQL server in Docker but are logically separate systems of record.

---

## Connection

The BFF connects via **Drizzle ORM** with the **`postgres` driver**.

- **Environment variable:** `GRID_APP_DATABASE_URL`
- **Example:** `postgresql://postgres:postgres@localhost:5432/grid_app`
- **Client file:** `frontends/ui/src/lib/db/index.ts`

```typescript
import { getDb } from "@/lib/db";

const db = getDb();
const result = await db.select().from(conversations);
```

### Lazy connection

The client is created lazily on the first call to `getDb()` or `createDb()`. This avoids making a database connection as a module side effect (which breaks tests, SSR, and scripts that import the module transitively).

```typescript
export function getDb() {
  if (!dbInstance) {
    return createDb();
  }
  return dbInstance;
}
```

Use `closeDb()` to close the connection in tests or during graceful shutdown.

---

## Schema management

Schemas live in `frontends/ui/src/lib/db/schema/` as TypeScript files using Drizzle's PostgreSQL column builders. They are exported from `frontends/ui/src/lib/db/schema/index.ts`.

Drizzle Kit is configured in `frontends/ui/drizzle.config.ts`:

```typescript
export default defineConfig({
  schema: "./src/lib/db/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.GRID_APP_DATABASE_URL!,
  },
});
```

### Adding a new table

1. Create or extend a file under `frontends/ui/src/lib/db/schema/`.
2. Export the table from `frontends/ui/src/lib/db/schema/index.ts`.
3. Generate a migration:

```bash
cd frontends/ui
npm run db:generate   # or: npx drizzle-kit generate
```

4. Apply the migration:

```bash
npm run db:migrate    # or: npx drizzle-kit migrate
```

### Migration files

Generated migrations are written to `frontends/ui/drizzle/` and committed to git.

---

## Docker setup

The `grid_app` database is created alongside `aiq_jobs` and `aiq_checkpoints` in the PostgreSQL container defined in `deploy/compose/docker-compose.yaml`.

- **Init script:** `deploy/compose/init-db.sql`
- **Mount point:** `/docker-entrypoint-initdb.d/init-db.sql` inside the `postgres` container
- **Databases created:** `aiq_jobs`, `aiq_checkpoints`, `grid_app`
- **Default user/password:** `aiq` / `aiq_dev`

The init script is idempotent (`IF NOT EXISTS`) and runs automatically when the PostgreSQL container starts with an empty data directory. The BFF service receives `GRID_APP_DATABASE_URL` via the environment.

---

## Why Drizzle?

- Type-safe SQL-like query builder that matches the team's existing TypeScript toolchain.
- Lightweight migration workflow (`drizzle-kit`) without requiring a full ORM.
- Clear separation between the BFF's application schema (Drizzle) and the Python agent's existing SQLAlchemy Core/raw SQL usage.

---

## Related docs

- [Architecture Overview](overview.md) — container/topology diagram showing the three databases.
- [Multitenancy & Auth Spec](multitenancy-and-auth-spec.md) — data model and ownership rules.
- ADR-0003 — Next.js BFF + stateless Python agent.

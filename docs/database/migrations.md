# Database Migrations

## Drizzle Kit Setup

**Config file:** `frontends/ui/drizzle.config.ts`

```typescript
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/lib/db/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.GRID_APP_DATABASE_URL,
  },
})
```

- **Schema source:** `./src/lib/db/schema/*.ts` (6 files, barrel-exported)
- **Output directory:** `./drizzle/`
- **Dialect:** PostgreSQL
- **Connection:** via `GRID_APP_DATABASE_URL` environment variable — must point to the `grid_app` database.

---

## Workflow

### 1. Modify Schema

Edit or create `.ts` files in `src/lib/db/schema/`. The barrel export in `index.ts` re-exports all tables.

### 2. Generate Migration SQL

```bash
cd frontends/ui
npx drizzle-kit generate
```

This reads the current schema, diffs against the last snapshot in `drizzle/meta/`, and produces a new `.sql` file in `drizzle/` (e.g., `0004_next_migration.sql`) plus a snapshot JSON.

### 3. Apply Migration

```bash
# Locally
npx drizzle-kit migrate

# Or via npm script
npm run db:migrate
```

This reads `drizzle/meta/_journal.json` and applies all pending migrations in order.

### Docker

In the Dockerfile, migrations run automatically via the container CMD:

```dockerfile
CMD node node_modules/drizzle-kit/bin.js migrate
```

This executes on container start, so schema changes are applied before the frontend server begins accepting traffic.

---

## Migration History

Journal file: `frontends/ui/drizzle/meta/_journal.json`

### 0000 — `amused_grey_gargoyle` (Initial Schema)

Creates the first two tables:

```sql
CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "created_by" text NOT NULL,
  "collection_name" text NOT NULL,
  "workos_resource_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "projects_workos_resource_id_unique" UNIQUE("workos_resource_id")
);

CREATE TABLE "user_preferences" (
  "workos_user_id" text PRIMARY KEY NOT NULL,
  "prefs" jsonb DEFAULT '{}'::jsonb NOT NULL
);
```

**Tables:** `projects`, `user_preferences`

---

### 0001 — `talented_cyclops` (Conversations + Messages)

```sql
CREATE TABLE "conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "created_by" text NOT NULL,
  "title" text,
  "project_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" text NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

**Tables:** `conversations`, `messages`
**Note:** No foreign key constraints yet — added in 0002.

---

### 0002 — `tough_squadron_supreme` (Foreign Keys)

```sql
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE SET NULL;

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id")
  ON DELETE CASCADE;
```

**Changes:**
- `conversations.project_id` → FK to `projects.id` (ON DELETE SET NULL)
- `messages.conversation_id` → FK to `conversations.id` (ON DELETE CASCADE)

---

### 0003 — `clammy_ted_forrester` (Documents Table)

```sql
CREATE TABLE "documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "created_by" text NOT NULL,
  "filename" text NOT NULL,
  "minio_key" text NOT NULL,
  "collection_name" text NOT NULL,
  "file_size" integer,
  "content_type" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "error_message" text,
  "metadata" jsonb
);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE CASCADE;

CREATE INDEX "documents_project_idx" ON "documents" ("project_id");
CREATE INDEX "documents_collection_idx" ON "documents" ("collection_name");
CREATE INDEX "documents_status_idx" ON "documents" ("status");
```

**Tables:** `documents`
**Indexes:** `project_idx`, `collection_idx`, `status_idx`

---

## Migration Timeline

```
0000 ──→ 0001 ──→ 0002 ──→ 0003
  │        │        │        │
projects  convs    FKs      docs
+ prefs   + msgs   on       + indexes
                   convs
                   & msgs
```

Timestamps from journal:
| Migration | Timestamp | Time Elapsed |
|-----------|-----------|-------------|
| 0000 | T+0s | Initial creation |
| 0001 | T+43min | Conversations + messages |
| 0002 | T+43min (1s later) | FK constraints (separated intentionally to apply after data migration if needed) |
| 0003 | T+45min | Documents table |

---

## init-db.sql

**File:** `deploy/compose/init-db.sql`

This is **not** a Drizzle migration — it is a PostgreSQL `psql` entrypoint script that runs on **first container startup** of the database container. It is:

- **Idempotent** — all statements use `IF NOT EXISTS` / `CREATE ... IF NOT EXISTS`.
- **Responsible for:** creating the `aiq_checkpoints` and `grid_app` databases (if absent), granting privileges, and creating tables in `aiq_jobs` and `aiq_checkpoints`.

These tables are separate from Drizzle ORM (the Next.js app only manages `grid_app`). The `aiq_jobs` and `aiq_checkpoints` databases are managed by the Python backend but must exist before the backend connects.

---

## Safety Notes

- **Generated migrations are idempotent** — `drizzle-kit generate` always produces SQL that can be safely reapplied (though `drizzle-kit migrate` only applies pending ones).
- **Snapshot diffing** — Drizzle stores snapshots in `drizzle/meta/` for each migration. These are used to compute the diff for the next `generate` run.
- **Never edit generated SQL manually** — always modify the schema `.ts` file and re-generate. Manual edits will be overwritten on the next `generate` run.
- **Rollbacks** — Drizzle Kit does not support down migrations. To revert, create a new migration that reverses the change.

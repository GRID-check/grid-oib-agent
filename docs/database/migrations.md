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
    // The OWNER credential — migrations run DDL and backfills, and `grid_app_rw`
    // can do neither (ADR-0041). The fallback exists only so a local checkout
    // pointed at a single-credential throwaway database still works; it is not a
    // supported way to migrate a deployment.
    url:
      process.env.GRID_APP_MIGRATION_DATABASE_URL ?? process.env.GRID_APP_DATABASE_URL,
  },
})
```

- **Schema source:** `./src/lib/db/schema/*.ts` (one file per area, barrel-exported from `index.ts`)
- **Output directory:** `./drizzle/`
- **Dialect:** PostgreSQL
- **Connection:** via `GRID_APP_MIGRATION_DATABASE_URL` — the schema OWNER, and what every deployment must use. `GRID_APP_DATABASE_URL` is only a fallback for a local single-credential database; it is the DML-only runtime role, which cannot run DDL and whose backfills would touch zero rows under row-level security (ADR-0041). Either way it must point at the `grid_app` database.

---

## Workflow

### 1. Modify Schema

Edit or create `.ts` files in `src/lib/db/schema/`. The barrel export in `index.ts` re-exports all tables.

### 2. Write the Migration SQL

Migrations are written by hand; `drizzle-kit generate` has not been used since
0011, and the snapshots in `drizzle/meta/` stop there. For a new migration:

- Take the number from `drizzle/meta/_journal.json`: the highest `idx` plus one.
  Look it up, do not remember it.
- Write `drizzle/NNNN_name.sql`, and its hand-run rollback
  `drizzle/NNNN_name.down.sql`.
- Add the journal entry, with a `when` greater than the last entry's (see
  Safety Notes).
- Add a verification block for it to `scripts/rls-test-db.sh` when it touches
  the tenant boundary or carries an invariant worth proving against PostgreSQL.

### 3. Apply Migration

> **Migrations connect as the schema OWNER.** `GRID_APP_DATABASE_URL` now points
> at `grid_app_rw`, which holds DML only and is subject to row-level security —
> correct for serving requests, useless for DDL, and actively dangerous for a
> data backfill, which would silently touch zero rows. Set
> `GRID_APP_MIGRATION_DATABASE_URL` to the owner credential; `drizzle.config.ts`
> prefers it and falls back to `GRID_APP_DATABASE_URL` for a throwaway local
> database. See [row-level-security.md](row-level-security.md) and ADR-0041.
>
> **A new table must join the tenant boundary in the same migration that creates
> it** — one `SELECT grid_secure_table('<table>', '<predicate>');` line.
> `src/lib/db/rls-coverage.spec.ts` fails by name until it does.

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

> **Note:** `minio_key` was later renamed to `storage_key` by migration
> `0023_rename_minio_key_to_storage_key` when object storage moved from MinIO to
> SeaweedFS (both S3-compatible — a pure `RENAME COLUMN`, values unchanged). The
> live schema (`docs/database/schema.md`) reflects the post-rename name.

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

## Runtime schema migration: `document_metadata` (rename + column adds)

The Python backend has **no migration framework** for its own tables (`aiq_jobs`) — `DocumentMetadataStore` (`src/aiq_agent/knowledge/document_metadata_store.py`) creates and evolves the `document_metadata` table itself at store init (both the sync `_ensure_table_sync` and async `_ensure_table_async` paths call the shared `_run_schema`).

This table was originally named `summaries` (class `SummaryStore`) and has since grown a `tags TEXT` column (controlled ingestion tags), a `doc_class TEXT` column (explicit "Dokumentart"), a `display_title TEXT` column (the user-facing citation-chip name — the OIB corpus never shows a raw filename), and a `folder_path TEXT` column (the materialised project-folder path the BFF filed the document under — ADR-0049; `NULL` means the project root). Because it now holds far more than summaries, both the table and the store class were renamed to `document_metadata`. `_run_schema` reconciles any prior shape on first access, idempotently:

- **Legacy `summaries` table present, `document_metadata` absent** (an existing deployment): `ALTER TABLE summaries RENAME TO document_metadata` — the rows are preserved untouched — then the collection index is recreated under `idx_document_metadata_collection` and the old `idx_summaries_collection` is dropped.
- **Fresh table** (neither present): `document_metadata` is created with all columns.
- **Every open**: `document_revision_retained` (the Fassung facts a reversible purge keeps, `docs/architecture/revisions.md`) is created with `CREATE TABLE IF NOT EXISTS`, under the same schema lock. A table still named `document_fassung_retained` is renamed in place; one a pod that has not rolled yet created again beside it has its rows moved across and is emptied (`LEGACY_RETAINED_TABLE_NAME`).
- **Dokumentart keys** (every open): a `doc_class` or `doc_class_suggestion` still spelled the German way (`oib_richtlinie` …, `gesetz`, `sonstiges`) is rewritten to the English key (`LEGACY_DOC_CLASSES`). The vector store keeps the German spelling until its rebuild; `qdrant_doc_class` is the one place the two meet.
- **Column backfill** (always, after the above): each optional column (`tags`, `doc_class`, `display_title`) is added if missing.
  - **PostgreSQL** — `ALTER TABLE document_metadata ADD COLUMN IF NOT EXISTS <col> TEXT`.
  - **SQLite** — no `IF NOT EXISTS` for columns, so a `PRAGMA table_info(document_metadata)` existence check runs first, then `ALTER TABLE ... ADD COLUMN` only when missing.

The migration reports success/failure: the store URL is added to the in-memory `_tables_initialized` cache **only when the schema is confirmed ready**, so a failed migration is retried on the next access instead of caching a half-initialized store. This mirrors the `job_access` migration pattern in `frontends/aiq_api/src/aiq_api/jobs/access.py`. `init-db.sql` now pre-creates `document_metadata` (with only `summary`) on fresh deployments; the rename path above is what carries an already-running deployment across the name change, and the column-adds are still exercised on every deployment.

> **Back-compat note:** the DB *file* (default `summaries.db`), the `AIQ_SUMMARY_DB` env var, and the NAT `summary_db` config field intentionally keep their names — they identify the *database*, not the table, and renaming them would orphan existing databases / break deployment configs.

---

## Safety Notes

- **A migration file without a journal entry is never applied.** `drizzle-kit migrate` executes what `drizzle/meta/_journal.json` lists, not what is on disk — so a hand-written `NNNN_*.sql` added without its entry is inert, and every check passes while reporting success: the file is in the diff, review sees it, and the migrate step "succeeds" having skipped it. The first symptom is a 500 from the route that queries the table (issue #283, `relation "platform_retrieval_settings" does not exist`). `frontends/ui/tests/db/migrations-journal.test.ts` now fails the build on that mismatch in both directions; `*.down.sql` companions are hand-run rollbacks and deliberately stay out of the journal.
- **An entry whose `when` is not greater than the last applied one is skipped, silently.** Drizzle compares only `when` (`lastDbMigration.created_at < migration.folderMillis`), not `idx` and not the hash, and `migrate()` still reports success. The journal carries hand-picked round values rather than `Date.now()`, so two migrations written on one day collide easily. Give a new entry a `when` above the last entry's; `migrations-journal.test.ts` fails the build on a duplicate or an out-of-order value.
- **The hand-written SQL is the migration.** What `drizzle/NNNN_name.sql` says is what the deploy runs; nothing regenerates or overwrites it. Change the schema `.ts` in the same commit so the types match the database, but do not run `drizzle-kit generate`: its snapshots in `drizzle/meta/` stop at 0011, so it would diff the schema against 0011 and emit everything since. A migration that already ran anywhere is not edited; a correction is the next migration.
- **Rollbacks** — Drizzle Kit does not run down migrations; the deploy never applies a `*.down.sql`. They are hand-run rollbacks. `scripts/rls-test-db.sh` (`task db:test:rls`) proves them: from 0133 on, a migration's verification block applies its `*.down.sql` (`apply_in`) and round-trips it against the forward migration. To revert in production, create a new migration that reverses the change.

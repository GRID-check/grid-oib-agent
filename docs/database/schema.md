# Database Schema — grid_app

The `grid_app` database stores application state managed by the Next.js BFF. It uses **Drizzle ORM** (PostgreSQL dialect) with schema definitions in `frontends/ui/src/lib/db/schema/`.

---

## Schema Files

All schemas are in `frontends/ui/src/lib/db/schema/` and barrel-exported from `index.ts`:

| File | Table |
|------|-------|
| `projects.ts` | `projects` |
| `conversations.ts` | `conversations` |
| `messages.ts` | `messages` |
| `documents.ts` | `documents` |
| `user-preferences.ts` | `user_preferences` |
| `answer-feedback.ts` | `answer_feedback` |

---

## projects

```typescript
// frontends/ui/src/lib/db/schema/projects.ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull(),
  collectionName: text('collection_name').notNull(),
  workosResourceId: text('workos_resource_id').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK, `defaultRandom()` | Auto-generated |
| `organization_id` | `text` | NOT NULL | WorkOS organization ID |
| `name` | `text` | NOT NULL | Project display name |
| `created_by` | `text` | NOT NULL | WorkOS user ID of creator |
| `collection_name` | `text` | NOT NULL | Milvus collection name for this project's knowledge base |
| `workos_resource_id` | `text` | UNIQUE | Optional WorkOS FGA resource ID |
| `created_at` | `timestamptz` | NOT NULL, `defaultNow()` | |

**Indexes:** `projects_org_deleted_created_idx` on `(organization_id, deleted_at, created_at)` — tenant list queries (migration `0014`).

---

## conversations

```typescript
// frontends/ui/src/lib/db/schema/conversations.ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  createdBy: text('created_by').notNull(),
  title: text('title'),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `text` | PK | Client-generated (format: `s_` prefix) |
| `organization_id` | `text` | NOT NULL | WorkOS organization ID |
| `created_by` | `text` | NOT NULL | WorkOS user ID |
| `title` | `text` | | Auto-generated or user-set title |
| `project_id` | `uuid` | FK → `projects.id` ON DELETE SET NULL | Scopes knowledge collection |
| `created_at` | `timestamptz` | NOT NULL, `defaultNow()` | |
| `updated_at` | `timestamptz` | NOT NULL, `defaultNow()` | Updated on message activity |

**Indexes:** `conversations_org_updated_idx` on `(organization_id, updated_at)` — tenant list ordered by activity; `conversations_project_idx` on `(project_id)` — FK lookups/cascades (migration `0014`).

---

## messages

```typescript
// frontends/ui/src/lib/db/schema/messages.ts
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { conversations } from './conversations'

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: text('conversation_id').notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK, `defaultRandom()` | Auto-generated |
| `conversation_id` | `text` | NOT NULL, FK → `conversations.id` ON DELETE CASCADE | |
| `role` | `text` | NOT NULL | `user`, `assistant`, `system`, or agent name |
| `content` | `text` | NOT NULL | Message body |
| `metadata` | `jsonb` | | Flexible: sources, tool_calls, agent info |
| `created_at` | `timestamptz` | NOT NULL, `defaultNow()` | |

**Indexes:** `messages_conversation_created_idx` on `(conversation_id, created_at)` — conversation history reads (migration `0014`; Postgres does not auto-index FK columns).

---

## documents

```typescript
// frontends/ui/src/lib/db/schema/documents.ts
import { pgTable, uuid, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core'
import { projects } from './projects'

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  projectId: uuid('project_id').notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull(),
  filename: text('filename').notNull(),
  storageKey: text('storage_key').notNull(),
  collectionName: text('collection_name').notNull(),
  fileSize: integer('file_size'),
  contentType: text('content_type'),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata'),
}, (table) => ({
  projectIdx: index('documents_project_idx').on(table.projectId),
  collectionIdx: index('documents_collection_idx').on(table.collectionName),
  statusIdx: index('documents_status_idx').on(table.status),
}))
```

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK, `defaultRandom()` | |
| `organization_id` | `text` | NOT NULL | |
| `project_id` | `uuid` | FK → `projects.id` ON DELETE CASCADE | **Nullable since ADR-0024**: `NULL` for org-wide `archiv` documents; set for `project` documents. |
| `scope` | `text` | NOT NULL, DEFAULT `'project'` | ADR-0024 discriminator: `'project'` (hangs off `project_id`) or `'archiv'` (org-wide, `project_id` NULL, `collection_name = archiv_<orgId>`). |
| `created_by` | `text` | NOT NULL | Uploading user ID |
| `filename` | `text` | NOT NULL | Original filename |
| `storage_key` | `text` | NOT NULL | Object storage key |
| `collection_name` | `text` | NOT NULL | Milvus collection for the vectorized content |
| `file_size` | `integer` | | Size in bytes |
| `content_type` | `text` | | MIME type |
| `status` | `text` | NOT NULL, DEFAULT `'pending'` | `pending` → `processing` → `processed` / `error` |
| `error_message` | `text` | | Error details if status is `error` |
| `metadata` | `jsonb` | | Flexible metadata |
| `created_at` | `timestamptz` | NOT NULL, `defaultNow()` | |
| `updated_at` | `timestamptz` | NOT NULL, `defaultNow()` | |

**Indexes:**
- `documents_project_idx` — on `project_id`
- `documents_collection_idx` — on `collection_name`
- `documents_status_idx` — on `status`
- `documents_org_scope_idx` — on (`organization_id`, `scope`) — bounds the org-wide Archiv listing (ADR-0024)

---

## user_preferences

```typescript
// frontends/ui/src/lib/db/schema/user-preferences.ts
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core'

export const userPreferences = pgTable('user_preferences', {
  workosUserId: text('workos_user_id').primaryKey(),
  prefs: jsonb('prefs').notNull().default({}),
})
```

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `workos_user_id` | `text` | PK | Maps 1:1 to a WorkOS user |
| `prefs` | `jsonb` | NOT NULL, DEFAULT `{}` | Arbitrary user preferences |

---

## Database Relationships

```
projects ──1:N──→ conversations
projects ──1:N──→ documents
conversations ──1:N──→ messages (CASCADE delete)
```

---

## Relationship Diagram

```
┌──────────────┐       ┌──────────────────┐
│   projects   │       │ user_preferences │
├──────────────┤       ├──────────────────┤
│ id (uuid) PK │       │ workos_user_id   │
│ organization │       │ (text) PK        │
│ name         │       │ prefs (jsonb)    │
│ created_by   │       └──────────────────┘
│ collection   │
│ workosres_id │       ┌──────────────────┐
│ created_at   │       │    messages      │
└──────┬───────┘       ├──────────────────┤
       │               │ id (uuid) PK     │
       │ 1:N           │ conversation_id  │──FK──→ conversations.id CASCADE
       ▼               │ role (text)      │
┌──────────────┐       │ content (text)   │
│conversations │       │ metadata (jsonb) │
├──────────────┤       │ created_at       │
│ id (text) PK │       └──────────────────┘
│ organization │
│ created_by   │       ┌──────────────────┐
│ title        │       │   documents      │
│ project_id───┼─FK──→│ projects.id      │
│ created_at   │       ├──────────────────┤
│ updated_at   │       │ id (uuid) PK     │
└──────────────┘       │ project_id ──FK──│ projects.id CASCADE
                       │ filename         │
                       │ storage_key      │
                       │ status           │
                       │ ...              │
                       └──────────────────┘
```

---

## init-db.sql Tables

**File:** `deploy/compose/init-db.sql`

This PostgreSQL entrypoint script runs on first container startup and creates two additional databases alongside `grid_app`:

### aiq_jobs database

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `job_info` | NAT JobStore metadata | `job_id` (PK), `status`, `config_file`, `error`, `output_path`, `created_at`, `updated_at`, `expiry_seconds`, `is_expired` |
| `job_access` | Job ownership/access control | `job_id` (PK), `owner_auth_type`, `owner_subject`, `owner_email` |
| `job_events` | SSE streaming event persistence | `id` (serial PK), `job_id`, `event_type`, `event_data`, `created_at` |
| `summaries` | Document summaries + controlled tags | `collection` + `filename` (composite PK), `summary`, `tags` (`TEXT`, JSON-encoded list of controlled tags; nullable) |

Indexes: `job_info(status)`, `job_info(created_at)`, `job_access(owner_auth_type, owner_subject)`, `job_events(job_id)`, `job_events(job_id, id)`, `summaries(collection)`.

> **`summaries.tags`** stores each document's controlled ingestion tags (document-type + OIB discipline vocabulary) as a JSON list, e.g. `["Grundriss","Brandschutz"]`, or SQL `NULL`/absent when untagged. **`init-db.sql` deliberately pre-creates the `summaries` table without this column** (see below), so the column is added at runtime by `SummaryStore` on first access — the in-place migration is always exercised on an existing deployment. See `docs/database/migrations.md` (init-db.sql section) for the ALTER-TABLE mechanics.

### aiq_checkpoints database

LangGraph conversation checkpoint tables:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `checkpoints` | Conversation state checkpoints | `thread_id`, `checkpoint_ns`, `checkpoint_id` (composite PK), `parent_checkpoint_id`, `type`, `checkpoint` (JSONB), `metadata` (JSONB) |
| `checkpoint_blobs` | Binary state data | `thread_id`, `checkpoint_ns`, `channel`, `version` (composite PK), `type`, `blob` (BYTEA) |
| `checkpoint_writes` | Pending writes | `thread_id`, `checkpoint_ns`, `checkpoint_id`, `task_id`, `idx` (composite PK), `channel`, `type`, `blob` (BYTEA) |
| `checkpoint_migrations` | Schema version tracking | `v` (PK) |

## org_model_configs / org_model_config_versions (migration 0012)

Org-level runtime model configuration (ADR-0014). `org_model_configs` holds
one row per WorkOS org with the pointer to the currently active version
(`active_version_id`, NULL = workflow YAML defaults) plus `updated_by`.
`org_model_config_versions` is immutable append-only history: `version`
(monotonic per org, unique `(organization_id, version)`), `overrides` jsonb
(`{agentGroup: {model}}`), `model_snapshot` jsonb (OpenRouter catalog
metadata at validation time), `comment`, `created_by`. Save = insert + repoint;
rollback = repoint. Schema: `frontends/ui/src/lib/db/schema/org-model-config.ts`.

## budget_policies / llm_usage_events (migration 0013)

LLM budgets and the usage ledger (ADR-0015).

- `budget_policies`: append-only limit configuration with the supersede idiom
  (`status` active/superseded + `supersedes_id`); `scope`
  (`organization`/`member`/`project`), `subject_id` (NULL / WorkOS user id /
  project uuid), `daily_limit`/`monthly_limit` numeric(12,4) in `currency`
  (EUR), `created_by`, `note`. A hand-written partial-unique index
  (`uniq_budget_policies_active`, COALESCE on subject) enforces one active
  policy per (org, scope, subject).
- `llm_usage_events`: one row per LLM generation — org/user/project/
  conversation/job attribution, `agent_group` (reserved), `requested_model`
  vs served `model`, OpenRouter `generation_id`, token counts (incl. cached +
  reasoning), `cost_usd numeric(14,8)` exactly as OpenRouter reported,
  `cost_source`, `is_byok`. Append-only; written only via
  `POST /api/internal/usage`. Indexes on (org,time), (org,user,time),
  (org,project,time), (org,model,time). Schema:
  `frontends/ui/src/lib/db/schema/budgets.ts`.
- `llm_usage_rollups` (migration 0015, ADR-0019): write-through daily spend
  aggregate — one row per (org, UTC day, user, project; empty string = none),
  `cost_usd`, `events`. Incremented in the same transaction as every ledger
  insert; budget enforcement reads these rows instead of aggregating the
  ledger per WebSocket upgrade. Backfilled from the ledger by the migration.

## workflows / workflow_runs (migration 0017)

Saved research briefs with cron scheduling (ADR-0023,
`docs/architecture/workflows.md`).

- `workflows`: one row per saved brief — `project_id` (cascade FK) +
  denormalized `organization_id`, `name`/`description`, versioned `definition`
  jsonb (block-based builder state), denormalized `compiled_prompt` (compiled
  once at save time; what the scheduler submits), `agent_type`
  (`deep_researcher`), `data_sources` jsonb (NULL = all), `enabled`,
  `schedule_cron` (5-field, NULL = manual-only) + `schedule_timezone` (IANA),
  `next_run_at`/`last_run_at`, `created_by`/`created_by_email`. Partial index
  `idx_workflows_due` on `next_run_at` (WHERE scheduled AND enabled) serves
  the scheduler's FOR UPDATE SKIP LOCKED due-scan.
- `workflow_runs`: append-only submission history — `workflow_id` (cascade
  FK), denormalized `project_id`/`organization_id`, `job_id` (backend async
  job; NULL when skipped/error), `trigger` (`manual`/`schedule`), `status`
  (`submitted`/`skipped`/`error`), `detail`, `prompt_snapshot`,
  `triggered_by`. Live job progress/results stay in the backend job store.
  `idx_workflow_runs_created_at` serves the scheduler's retention prune.
  Schema: `frontends/ui/src/lib/db/schema/workflows.ts`.

---

## answer_feedback (migration 0020)

Per-answer thumbs feedback (WS-7, click-dummy overhaul spec §1/§6; flag
`answer-feedback`). One row per (user, assistant answer).

- Columns: `organization_id` (denormalized, scopes every query in SQL),
  `project_id` (nullable, **cascade FK** to `projects` so a purged project
  takes its feedback along), `conversation_id` (nullable plain text — no FK,
  the vote must not race the async conversation insert), `message_id` (the
  **client-side** assistant message identifier; shallow chat turns are not
  persisted as `messages` rows, so no FK), `user_id`, `verdict`
  (`up`/`down`), `reason` (nullable, fixed keys
  `inaccurate`/`too_slow`/`wrong_source`/`other`; down-votes only),
  `created_at`/`updated_at`.
- Voting model (the simplest honest one): **re-vote = upsert** on the unique
  `(user_id, message_id)` index (`answer_feedback_user_message_uidx`);
  **toggle-off = delete** — no "retracted" tombstone state.
- Indexes: `answer_feedback_org_conversation_idx`
  (`organization_id`,`conversation_id`) serves the per-conversation hydration
  list; `answer_feedback_org_project_idx` (`organization_id`,`project_id`).
  Schema: `frontends/ui/src/lib/db/schema/answer-feedback.ts`.

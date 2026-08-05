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
| `agent-profiler.ts` | `agent_profiler_spans` |
| `citation-events.ts` | `citation_events` |
| `resource-shares.ts` | `resource_shares` |
| `inbox.ts` | `inbox_items` |
| `mention-requests.ts` | `mention_requests` |
| `conversation-reads.ts` | `conversation_reads` |

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
| `visibility` | `text` | NOT NULL, default `'private'` | `private` \| `project` \| `organization` (ADR-0032). Read on the hot path with the row, so access resolution costs no join. **Migration 0027 backfilled pre-existing rows with a `project_id` to `'project'`** — conversations used to be resolved org-scoped only, so any org member with an id could read any thread; `'project'` keeps access for everyone inside the project and withdraws the accidental org-wide read. Rows with a NULL `project_id` stayed `'private'` (no project membership could describe their audience). |
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
| `author_user_id` | `text` | | WorkOS user id of the human author; NULL for assistant/system/tool rows and for messages written before authorship existed. `role` only recorded the KIND of author, which was free with one human per thread and a defect with two. Legacy NULL-author `user` rows are attributed to the conversation's `created_by` **at read time**, never backfilled, so the column never claims a precision the data lacks (spec MG-3). |
| `content` | `text` | NOT NULL | Message body |
| `metadata` | `jsonb` | | Flexible: see the key list below |
| `created_at` | `timestamptz` | NOT NULL, `defaultNow()` | |

**`metadata` keys** written by the chat store (`_appendMessage`) and read back by
`server-message-mapper.ts` when a history rehydrates from the server:
`messageType`, `errorData`, `fileData`, `cards`, `cardInteractions`,
`enabledDataSources`, `messageFiles`.

`cardInteractions` is the user's answer to each interactive card of that answer
— `{ "<cardType>-<index>": { decision, decidedAt } }`, `decision` from a closed
union and `decidedAt` a UTC ISO instant (ADR-0030). It is why a settled
`project_profile_patch` / `memory_proposal` cannot re-offer a button that would
apply the same write twice. Unlike the other keys it is usually written *after*
the insert, via `PATCH /api/conversations/{id}/messages/{messageId}` (merged per
card key); it also rides the INSERT when a decision was already recorded
locally, which is how a decision made before the row existed still reaches the
server.

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
| `document_metadata` | Per-document metadata (was `summaries`) | `collection` + `filename` (composite PK), `summary`, `tags` (`TEXT`, JSON list; nullable), `doc_class` (`TEXT`; nullable), `display_title` (`TEXT`; nullable) |

Indexes: `job_info(status)`, `job_info(created_at)`, `job_access(owner_auth_type, owner_subject)`, `job_events(job_id)`, `job_events(job_id, id)`, `document_metadata(collection)`.

> **`document_metadata`** (renamed from `summaries`) is the per-document metadata store: the one-sentence `summary`, controlled ingestion `tags` (JSON list, e.g. `["Grundriss","Brandschutz"]`), the explicit `doc_class` ("Dokumentart"), and the user-facing `display_title` (the citation-chip name; the OIB corpus never shows a raw filename). **`init-db.sql` pre-creates only `summary`**; `tags`, `doc_class`, and `display_title` are added at runtime by `DocumentMetadataStore` on first access, and an existing `summaries` table is **renamed in place** to `document_metadata` (rows preserved) — so both the rename and the ALTER-TABLE column-adds are always exercised on a live deployment. See `docs/database/migrations.md` (init-db.sql section).

### aiq_checkpoints database

LangGraph conversation checkpoint tables:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `checkpoints` | Conversation state checkpoints | `thread_id`, `checkpoint_ns`, `checkpoint_id` (composite PK), `parent_checkpoint_id`, `type`, `checkpoint` (JSONB), `metadata` (JSONB) |
| `checkpoint_blobs` | Binary state data | `thread_id`, `checkpoint_ns`, `channel`, `version` (composite PK), `type`, `blob` (BYTEA) |
| `checkpoint_writes` | Pending writes | `thread_id`, `checkpoint_ns`, `checkpoint_id`, `task_id`, `idx` (composite PK), `channel`, `type`, `blob` (BYTEA) |
| `checkpoint_migrations` | Schema version tracking | `v` (PK) |

## platform_model_defaults (migration 0026)

The platform-controlled default model per agent group — the layer *under* every
tenant's own configuration (ADR-0014, extended). Global: no `organization_id`,
one row per `agent_group` (PK), carrying the catalog-validated `model`, a
`model_snapshot` jsonb (catalog metadata + `_zdr.safe`), an optional `note`, and
`updated_by`/`updated_by_email`. **No row = that group falls through to the
workflow YAML for organizations without an org override of their own** (an org
override still wins). A save replaces the whole set — groups omitted from the
payload are deleted, which is how a group is handed back to the YAML for those
organizations. Resolution at
runtime is per group: org override → platform default → YAML. Schema:
`frontends/ui/src/lib/db/schema/platform-model-defaults.ts`.

**Rows are provisioned on first boot, not by a migration.**
`lib/model-config/bootstrap-defaults.ts` fills the table when it is entirely
empty — without it the fleet ran on an undeclared YAML literal until an admin
visited Platform → Models. It is application code rather than SQL because it must
first ask the backend which provider the deployment actually runs
(`GET /v1/config/llm-defaults` → `baseUrls`) and skip any group not on the
platform catalog's provider: a platform default replaces the model id but not the
`base_url`, so an OpenRouter id written blindly into a Kimi or NVIDIA deployment
would fail every request. It also validates against the live catalog, records
`model_snapshot` (including `_zdr.safe`), invalidates the cache and emits
`platform.model_defaults.bootstrapped` — none of which SQL can do. Rows it writes
carry `updated_by = 'system:bootstrap'`.

## platform_reasoning_efforts (migration 0030)

The platform-controlled reasoning effort ("thinking level") per agent group —
how hard each part of the agent thinks before answering, for every organization
at once. Global: no `organization_id`, one row per `agent_group` (PK), carrying
an `effort` from OpenRouter's unified vocabulary (`none` | `minimal` | `low` |
`medium` | `high` | `xhigh`), an optional `note`, and
`updated_by`/`updated_by_email`. **No row = that group uses the workflow YAML
`reasoning_effort` for its role**, so deleting a row hands the group back to the
config file. Unlike the model, there is deliberately NO org layer — a tenant
choosing its own model is a product feature, a tenant dialling its own reasoning
spend is not. Read by the backend through `GET /api/internal/reasoning-efforts`
(TTL-cached, fail-open). A separate table rather than a column on
`platform_model_defaults` because `model` there is `NOT NULL`: a shared row would
force an owner to pin a model in order to change the thinking level. Schema:
`frontends/ui/src/lib/db/schema/platform-reasoning-efforts.ts`.

## platform_retrieval_settings (migration 0029)

The platform-controlled retrieval counts — how many chunks and results each
retrieval tool fetches per query, for every organization at once (see
`docs/architecture/backend-deep-dive.md` §Retrieval settings). Global: no
`organization_id`, one row per `key` (PK: `knowledge.top_k`,
`knowledge.max_chunks_per_document`, `surface.chunk_top_k`,
`surface.max_files`, `web.max_results`, `web.advanced_max_results`,
`ris.max_results`, `ris.page_size`, `ris_catalog.max_matches`), carrying the
catalog-validated integer `value`, an optional `note`, and
`updated_by`/`updated_by_email`. **No row = that count falls through to the
build-time config/YAML default.** A save replaces the whole set — keys omitted
from the payload are deleted, which is how a count is handed back to the
default. The BFF serves the pinned set to the backend over
`GET /api/internal/retrieval-settings` (TTL-cached, fail-open); the catalog of
keys, bounds and boot defaults is the single source of truth at
`frontends/ui/src/lib/retrieval-settings/catalog.ts` (mirrored in the backend
resolver `src/aiq_agent/common/retrieval_settings.py`, parity-tested). Schema:
`frontends/ui/src/lib/db/schema/platform-retrieval-settings.ts`.

## org_model_configs / org_model_config_versions (migration 0012)

Org-level runtime model configuration (ADR-0014). `org_model_configs` holds
one row per WorkOS org with the pointer to the currently active version
(`active_version_id`, NULL = the inherited default — the platform default,
or the workflow YAML where none is pinned) plus `updated_by`.
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

---

## citation_events

Citation-quality ledger written **only** by `POST /api/internal/citation-events`
(the backend emitter `src/aiq_agent/common/citation_events.py`) — the quality
sibling of the cost ledger (`llm_usage_events`) and the timing ledger
(`agent_profiler_spans`). Schema: `frontends/ui/src/lib/db/schema/citation-events.ts`;
migration `drizzle/0025_citation_events.sql`.

**One row per `(turn_id, kind)`.** Every observed research turn writes exactly
one `turn_verified` baseline row — the denominator behind the platform
dashboard's clean rate — plus one row per defect detected on that turn. That
shape makes "turns observed" and "turns with defect X" both a plain `COUNT`
instead of a jsonb scan. A unique index on `(turn_id, kind)` makes a retried
flush idempotent.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `organization_id` | `text` | Nullable; no FK (ops data outlives tenants) |
| `conversation_id` | `text` | Client-side chat id; no FK, survives conversation deletion |
| `turn_id` | `text` | Shared with `agent_profiler_spans.turn_id` — links a defect to its execution timeline |
| `job_id` | `text` | Async deep-research job id, when the turn ran in a Dask worker |
| `agent` | `text` | `shallow` \| `deep` |
| `kind` | `text` | `turn_verified` \| `citations_removed` \| `quote_unverified` \| `answer_ungrounded` \| `registry_empty` \| `citation_fallback` \| `confidence_capped` |
| `severity` | `text` | `ok` \| `info` \| `warn` \| `error` — derived from `kind` on the backend, never caller-supplied |
| `count` | `integer` | Items the row covers (citations dropped, quotes unverified, …) |
| `reasons` | `jsonb` | Machine reason key → occurrences, e.g. `{"url_not_in_registry": 2}` |
| `detail` | `jsonb` | Coarse context: source/cited counts, origin+lane+tool mixes, and the failed citation `targets` (`{target, reason}`) |
| `created_at` | `timestamptz` | Default `now()` |

**No user content.** The ledger carries machine reason keys, counts, coarse
source labels (origin/lane/tool), and source *identities* (a URL or a
`file.pdf, p.12` document key) — never answer prose, never a quoted span, never
a retrieved passage. That is what makes it safe to browse cross-organization
from the platform tier.

Read by the platform-owner-only citation-health surface
(`frontends/ui/src/lib/citations/*`, `GET /api/platform/citation-health` and its
`/export` sibling).

**Two counting rules the readers must respect**, because both were violated and
produced a dashboard that contradicted itself:

- `*_not_in_registry` (`url_not_in_registry`, `citation_key_not_in_registry`)
  means the cited source was **not among the sources retrieval returned on that
  turn** — NOT that the platform does not hold it. A document sitting indexed in
  the base corpus produces exactly this reason when retrieval fails to surface
  it, so the reason alone never proves the model invented the citation. The
  service resolves the ambiguity by cross-checking the corpus
  (`missing-sources.ts`): held → an indexing fault (`sources_unretrievable`);
  held nowhere → invention (`citations_invented`). The two are mutually
  exclusive by construction.
- **Per-kind and per-target turn counts are not additive.** One turn commonly
  carries several kinds and several rejected targets, so summing them reports
  more turns than the window contains. Rollups take `count(distinct turn_id)`
  (`countTurnsForTargets` for a set of targets); the trend chart's stack counts
  *findings*, not turns, and is labelled as such.

---

## Collaboration tables (ADR-0032 · ADR-0034 · ADR-0035)

Added by migration `0027_collaboration.sql`. Requirements:
`docs/design/collaboration-sharing-and-inbox-spec.md`.

### resource_shares

The **one generic** table of resource-level access grants. Sharing is modelled as
*visibility + additive grants*: visibility is a blanket rule living on the shared
resource's own row (`conversations.visibility`), while individual `(person, role)`
records live here — because grants are the part that must be queried in **both**
directions: "who can reach R" (the authorization check) and "what has been shared
with P" (the inbox, the history list, the badge, on every render).

Grants are stored here rather than in WorkOS FGA — where *project* roles live —
precisely because that reverse lookup is FGA's expensive direction and it sits on
a render path. WorkOS stays authoritative for the **container**; this table is
authoritative for **resources inside** it (ADR-0032).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK, `defaultRandom()` | |
| `organization_id` | `text` | NOT NULL | Tenant scope; never a cross-org grant |
| `resource_type` | `text` | NOT NULL | `conversation` today; exhaustive over the sharing registry |
| `resource_id` | `text` | NOT NULL | `text`, not `uuid`: shareable ids are heterogeneous (a conversation id is a client-generated string). No FK for the same reason — cascade cleanup is explicit |
| `subject_user_id` | `text` | NOT NULL | WorkOS user the grant is FOR |
| `role` | `text` | NOT NULL | `viewer` \| `collaborator` \| `owner`, weakest first |
| `granted_by` | `text` | NOT NULL | Actor, for the roster's "why" column |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL, `defaultNow()` | |

Indexes: `uniq_resource_shares_resource_subject` (one grant per person per
resource — re-sharing upserts the role); `idx_resource_shares_org_subject`
(the reverse lookup this table exists for); `idx_resource_shares_resource`
(roster + purge).

### inbox_items

One **fixed frame plus a typed `payload`**, so a new notification kind costs a
registry entry and two translations — never a schema change and never a new
component (ADR-0035).

Three properties come from **one constraint**: the unique index on
`(recipient_user_id, group_key)` combined with an incrementing upsert gives
**grouping** (twenty new messages → one row, count 20), **deduplication**, and
**idempotency** (a retried emission is a no-op). Callers choose the behaviour via
the group key — `inboxGroupKey()` includes an anchor for per-occurrence rows and
omits it to collapse.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK, `defaultRandom()` | |
| `organization_id` | `text` | NOT NULL | A user in two orgs has two inboxes; counts never mix |
| `recipient_user_id` | `text` | NOT NULL | WorkOS user this is FOR |
| `type` | `text` | NOT NULL | `mention.requested` \| `mention.answered` \| `conversation.shared_with_you` \| `conversation.activity` |
| `resource_type` / `resource_id` | `text` | NOT NULL | What it points AT — resolved through the sharing registry |
| `anchor_id` | `text` | | Exact spot inside the resource (a message id), for a deep link |
| `actor_user_id` | `text` | | Who caused it; NULL for system items |
| `group_key` | `text` | NOT NULL | Grouping / dedup / idempotency key (see above) |
| `actionable` | `boolean` | NOT NULL | Denormalized from the registry so the badge count is a plain indexed query. A type changing kind would need a backfill (accepted) |
| `count` | `integer` | NOT NULL, default `1` | Occurrences absorbed by grouping |
| `payload` | `jsonb` | NOT NULL, default `{}` | Display data only — never authoritative, never a source of access. **Wiped when an item goes inert** |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL, `defaultNow()` | List orders by `updated_at`; grouping touches it |
| `read_at` / `resolved_at` / `archived_at` / `inert_at` | `timestamptz` | | Lifecycle. `inert_at` = target became unreachable: render redacted, never linked |

Indexes: `uniq_inbox_items_recipient_group`;
`idx_inbox_items_recipient_org_updated` (the list);
`idx_inbox_items_target` (inert-marking + cascade); `idx_inbox_items_created_at`
(retention prune); and the **partial** `idx_inbox_items_pending` — hand-written in
the migration because the drizzle builder cannot express it — matching the badge
predicate exactly (`archived_at IS NULL AND inert_at IS NULL AND (read_at IS NULL
OR (actionable AND resolved_at IS NULL))`). Keep the predicate and
`pendingPredicate()` in `lib/inbox/repository.ts` in step, or the badge silently
stops using its index.

### mention_requests

An outstanding request for a **named person's** input — the durable home of the
product's headline behaviour: someone tags a colleague and the agent deliberately
stays silent until they answer (ADR-0034).

Not the agent's in-process HITL future: that is loop-bound to whichever replica
runs the turn, built for seconds, and explicitly not durable across restarts
(ADR-0028). A mention waits days, for a specific person, across deploys and
devices.

**The thread-level "awaiting" state is DERIVED from these rows** — a conversation
awaits input iff an `open` row exists for it. One source of truth, so the thread
banner and the recipient's inbox cannot drift apart.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `uuid` | PK, `defaultRandom()` | |
| `organization_id` | `text` | NOT NULL | |
| `resource_type` / `resource_id` | `text` | NOT NULL | Generic from day one, so a second mention surface reuses this table |
| `anchor_id` | `text` | | The message id carrying the mention. Deliberately not an FK: an addressable anchor, not a relation |
| `requested_by` / `requested_of` | `text` | NOT NULL | Who asked / whose input is wanted |
| `note` | `text` | | The asker's question, carried into the recipient's inbox body |
| `status` | `text` | NOT NULL, default `'open'` | `open` \| `answered` \| `released` \| `void` |
| `resolution` | `text` | | `answered` \| `released` \| `void` |
| `resolved_by` / `resolved_at` | `text` / `timestamptz` | | Who closed it, when |
| `created_at` | `timestamptz` | NOT NULL, `defaultNow()` | |

Indexes: `idx_mention_requests_resource_status` (the derived banner state);
`idx_mention_requests_requested_of_status` (resolution on reply, reminders);
`idx_mention_requests_org_requested_by` ("what have I asked of others").

Writes only ever transition `open` rows, so the first close wins and a late one
is a no-op rather than rewriting history.

### conversation_reads

How far each participant has read a conversation — per **person**, server-side,
because with two people in a thread "unread" is no longer a property of one
browser. Backs the unread divider and the grouped activity item (which is cleared
by reading the thread, not by dismissing the notification).

Deliberately a single high-water mark per `(conversation, person)`, not
per-message receipts: it answers every question the product asks at a fraction of
the write volume.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `conversation_id` | `text` | NOT NULL, FK → `conversations.id` ON DELETE CASCADE | |
| `user_id` | `text` | NOT NULL | WorkOS user |
| `last_read_at` | `timestamptz` | NOT NULL, `defaultNow()` | Everything at/before this is read |
| `last_read_message_id` | `text` | | For a stable "new since here" divider |
| `updated_at` | `timestamptz` | NOT NULL, `defaultNow()` | |

Primary key: `conversation_reads_pk (conversation_id, user_id)`.

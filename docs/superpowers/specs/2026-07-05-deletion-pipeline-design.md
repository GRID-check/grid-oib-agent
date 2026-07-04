# Deletion Pipeline: Projects, Documents, Conversations, Organizations

**Date:** 2026-07-05
**Status:** Approved
**Branch:** feature/applicable-oib-standards (or follow-up branch)

## Problem

GRID has no working deletion story. Today:

- `DELETE /api/projects/[id]` exists but no UI calls it, and it leaks: MinIO objects (no S3 delete code exists anywhere in the repo), the project's Chroma collection, `summaries` rows, `aiq_jobs` rows, and LangGraph checkpoints. `conversations.projectId` is `ON DELETE SET NULL`, so chats become permanent orphans and their checkpoints become unreachable.
- There is no way to delete a single document (no DB delete endpoint, no MinIO delete). The only existing path (`deleteFiles` → `DELETE /v1/collections/{name}/documents`) removes Chroma chunks only.
- Session/conversation deletion leaks LangGraph checkpoints.
- There is no organization offboarding at all.

Enterprise customers (~40 target orgs) require reliable data deletion (GDPR Art. 17 / security questionnaires). Deletion must span five stores that cannot be updated atomically: `grid_app` Postgres, `aiq_jobs` Postgres, `aiq_checkpoints` Postgres, MinIO, Chroma, plus WorkOS (FGA resources / orgs).

## Design principles

1. **Soft delete first, purge asynchronously.** Cross-store deletion cannot be atomic in one HTTP request. A tombstone keeps all pointers alive until every store confirms cleanup.
2. **The queue is a Postgres table.** No message broker. A row awaiting purge *is* the task; crash-safety comes from the row surviving.
3. **Idempotent steps, ordered, entity row last.** Every purge step is safe to re-run (deleting absent things is a no-op). Pointers (collection name, MinIO prefix, conversation ids) are gathered before anything is destroyed; the entity's own row is deleted last.
4. **One reaper, per-entity plug-ins.** A single poll loop dispatches to a step list per entity type. New deletable entities are added by writing a step list, not new infrastructure.

## Architecture

### Central deletion queue (grid_app Postgres)

New table `deletion_queue` — simultaneously tombstone, work queue, and surviving audit record:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `entity_type` | text | `'project' \| 'document' \| 'conversation' \| 'organization'` |
| `entity_id` | text | uuid for rows; WorkOS org id for organizations |
| `display_name` | text | snapshot for audit + restore UI (entity row may be gone later) |
| `organization_id` | text | scoping for admin views |
| `requested_by` | text | WorkOS user id |
| `requested_at` | timestamptz | |
| `purge_after` | timestamptz | `requested_at + grace period` |
| `purged_at` | timestamptz nullable | set only after ALL steps succeed |
| `status` | text | `'pending' \| 'purging' \| 'purged' \| 'restored' \| 'failed'` |
| `attempts` | int default 0 | |
| `last_error` | text nullable | |
| `payload` | jsonb | pointers snapshot (collection name, MinIO prefix, conversation ids) captured at enqueue time as a fallback |

Rationale for a central table (vs per-table columns only): organizations have **no DB row** in grid_app (ADR-0007 — they live in WorkOS), so there is nothing to put a `deleted_at` column on. The queue also gives one audit trail and one poller for all entity types.

Entities that do have rows additionally get a `deleted_at timestamptz` column (`projects`, `documents`, `conversations`) used **only** for query filtering — the reaper never scans entity tables.

### Legal holds (grid_app Postgres)

New table `legal_holds`: `id`, `entity_type`, `entity_id`, `organization_id`, `reason`, `created_by`, `created_at`, `released_at` (nullable). A hold is **active** while `released_at IS NULL`.

Semantics: a hold does **not** block soft delete (the entity still disappears from the UI as the requester expects) — it blocks **purge**. The reaper's claim query excludes any queue row with an active hold on the same entity, or on its parent organization (org-level holds freeze everything inside the org, including project-purge children enqueued by an org offboarding). When the hold is released, purge resumes on the next tick with no further action.

This doubles as GDPR **Art. 18 (restriction of processing)** support: restricted data is preserved but not actively processed.

API: `POST /api/holds` and `POST /api/holds/[id]/release` (org owner + internal support only), `GET /api/holds` (org admin). Management UI is out of scope for now — holds are rare, deliberate legal events; the API + audit trail is what compliance requires.

### Query filtering

All list/get queries for projects, documents, and conversations gain `WHERE deleted_at IS NULL`, via a small shared helper (e.g. `notDeleted(table)`) so the filter cannot be forgotten. Soft-deleted projects 404 on their routes. Documents and conversations inside a soft-deleted project are hidden transitively via the project check.

### Per-entity policy

| Entity | Confirm UX | Grace period | Restorable |
|---|---|---|---|
| Document | simple confirm dialog | 0 (purged on next reaper tick, ≤~60s) | no |
| Conversation | simple confirm (existing modal flow, upgraded) | 0 | no |
| Project | **type-to-confirm** (project name) | 7 days (config `PROJECT_PURGE_GRACE_DAYS`) | yes |
| Organization | **type-to-confirm** (org name), org owner only | 14 days (config `ORG_PURGE_GRACE_DAYS`) | yes |
| User (erasure) | support-initiated (API) or account-settings flow | 7 days | yes (within grace) |

Grace periods are config values; the architecture is identical at 0. All grace periods must stay ≤ 23 days so that grace + retry headroom keeps total erasure time within the GDPR "one month" response window (Art. 12(3)).

### Purger service

New docker-compose service `purger`: **same image as `aiq_api`, different command** (`python -m aiq_api.purger`). No new codebase, no inbound ports. It holds all credentials (grid_app DB, aiq_jobs DB, aiq_checkpoints DB, MinIO, Chroma dir/API, WorkOS API key) — acceptable as a privileged internal service. "Spawn on demand" was rejected: it requires docker-socket access from an app container (root-equivalent, fails enterprise security review). A sleeping poll loop costs ~zero.

Loop, every 60s:

```sql
SELECT q.* FROM deletion_queue q
WHERE q.status = 'pending' AND q.purge_after <= now()
  AND NOT EXISTS (
    SELECT 1 FROM legal_holds h
    WHERE h.released_at IS NULL
      AND (
        (h.entity_type = q.entity_type AND h.entity_id = q.entity_id)
        OR (h.entity_type = 'organization' AND h.entity_id = q.organization_id)
      )
  )
ORDER BY q.requested_at
FOR UPDATE SKIP LOCKED
LIMIT 10;
```

The hold guard lives in the claim query itself — same database, same transaction — so there is no failure mode where an external check being unavailable lets a held entity get purged.

For each row: set `status='purging'`, run the entity's step list, then set `purged_at`/`status='purged'`. Any step throws → record `last_error`, increment `attempts`, reset `status='pending'` → retried next tick from step 1 (all steps idempotent). After 10 consecutive failures → `status='failed'` + loud log; failed rows are surfaced, not retried forever. Restore (project/org, within grace) → `status='restored'`, clear entity `deleted_at`.

### Purge step lists

**Document** (`documents` row still present; pointers from row):
1. Delete MinIO object at `minio_key`
2. Delete Chroma chunks for that file (existing backend `DELETE /v1/collections/{collection}/documents`)
3. Delete `summaries` row (`aiq_jobs`) for (collection, filename)
4. Delete `documents` row

**Conversation**:
1. Delete LangGraph checkpoints (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes` in `aiq_checkpoints`) for `thread_id = conversation id`
2. Delete `conversations` row (`messages` cascade)

**Project**:
1. Gather pointers: `collectionName`, MinIO prefix `org/{orgId}/project/{projectId}/`, all conversation ids for the project
2. Delete Chroma collection (existing `DELETE /v1/collections/{name}`; also clears its `summaries`)
3. Delete `aiq_jobs` rows (`job_info`, `job_access`, `job_events`) for jobs referencing that collection
4. Delete LangGraph checkpoints for all gathered conversation ids
5. Delete all MinIO objects under the prefix (paginated `ListObjectsV2` + batched `DeleteObjects` — first S3 delete code in the repo)
6. Delete WorkOS FGA resource (`deleteResourceByExternalId`, `cascadeDelete: true`)
7. Delete `conversations` rows explicitly, then the `projects` row (cascades `documents`, `project_folders`, project-scoped `project_memory`; org-scoped memory untouched)

**User (GDPR erasure — Art. 17 requests come from individual data subjects, not orgs/projects):**

The subtlety: content a user authored inside an organization's workspace (messages, uploaded documents, research runs) is generally the *organization's* business data, not the individual's personal data — GDPR does not require destroying the org's records, only removing the person's identifiability. The standard, defensible approach is **delete the account, anonymize the authorship**:

1. Delete `user_preferences` row and any user-keyed rows
2. Anonymize identifiers in retained data: `messages` authorship, `deletion_queue.requested_by`, `legal_holds.created_by`, `project_memory` attribution → replaced with a stable pseudonym (`deleted-user:<hash>`), so org history remains coherent but unlinkable
3. Remove the user from WorkOS (memberships, then user object)
4. Finalize queue row

Content deletion (their messages' *text*, files they uploaded) stays with the owning project/org lifecycle — if an individual demands content removal, that's handled per-document/per-conversation via the other entity types.

**Organization** (composes; adds only two steps of its own):
1. Enqueue a project purge (grace 0, immediate) for every project in the org; wait until all reach `purged` (re-check each tick; org row stays `pending`/`purging` until children finish)
2. Delete org-scoped `project_memory` rows (`scope='organization'` for this org)
3. Delete the WorkOS organization (and remaining FGA resources)
4. Finalize queue row

Python-side steps are performed directly by the purger (it shares the `aiq_api` codebase — `delete_collection`, summaries helpers, checkpoint DB access). WorkOS calls use the WorkOS Python SDK (or REST) with the same API key the UI uses.

### API surface (Next.js BFF)

- `DELETE /api/projects/[id]` — reworked: permission check → set `projects.deleted_at` → insert `deletion_queue` row. No hard deletes, no WorkOS call here.
- `POST /api/projects/[id]/restore` — org admin; within grace; clears `deleted_at`, sets queue row `restored`.
- `DELETE /api/documents/[id]` — new; soft-delete + enqueue (grace 0).
- `DELETE /api/conversations/[id]` — new/reworked to soft-delete + enqueue (grace 0), replacing any direct-delete path.
- `DELETE /api/organizations/[id]` + `POST /api/organizations/[id]/restore` — org owner only.
- `GET /api/deletions?entity_type=…` — org-admin list of pending/failed deletions (powers "Recently deleted" UI).

### UI

- **Type-to-confirm dialog**: new shared component (`TypeToConfirmDialog`) built on existing `Dialog` primitives — destructive button disabled until input matches `display_name` exactly. Used by project and organization deletion. (No precedent exists in the codebase; the three existing delete modals stay simple-confirm.)
- **Delete project** action in project settings; **delete document** in the documents list/file views; conversation delete wired through the upgraded flow; **delete organization** in org settings (owner only).
- **Recently deleted** (org admins): lists pending project/org deletions with time-remaining and a **Restore** button. Without this, the grace period would require DB surgery to be useful.

### Migrations (grid_app)

1. `deletion_queue` table.
2. `deleted_at` on `projects`, `documents`, `conversations`.
3. `conversations.project_id` FK: `ON DELETE SET NULL` → `ON DELETE CASCADE` (belt-and-braces behind the purger's explicit delete).
4. `documents.folder_id` → `project_folders.id`: add `ON DELETE CASCADE` (currently no action; multi-path cascade from project delete is fragile without it).

## GDPR conformance mapping

How the design satisfies the articles enterprise DPAs and security questionnaires actually ask about:

| Obligation | Mechanism |
|---|---|
| **Art. 17** — right to erasure "without undue delay" | Deletion pipeline for all five entity types; grace + retry bounded within the Art. 12(3) one-month response window; `purged_at` timestamps are the evidence of completion |
| **Art. 12(3)** — respond within one month | Grace periods capped at ≤ 23 days; `attempts`/`failed` status surfaces stuck purges before the deadline |
| **Art. 18** — restriction of processing | Legal hold: data preserved, hidden from active use, purge blocked until release |
| **Art. 5(2) / Art. 30** — accountability, records of processing | `deletion_queue` rows survive purge as the record of what was erased, when, by whose request; `legal_holds` records restriction events |
| **Art. 28(3)(g)** — processor deletes/returns data at end of services | Organization offboarding entity: full customer purge incl. WorkOS org |
| **Art. 20** — data portability | Out of scope here (export is a separate feature, noted below); deletion never blocks on it |
| Backups | Purged data persists in DB/object-store backups until rotation; the rotation window must be documented in the DPA (standard practice — GDPR permits this when backups are access-controlled and expire) |

One caution for honest positioning: this makes the *product capable of* GDPR-conformant data handling. Actual compliance is organizational (DPA contracts, breach process, DPO, records) — don't market "GDPR compliant" on the strength of code alone.

## Error handling

- Partial purge failure: retried in full next tick (idempotent steps); state is always recoverable because the queue row and entity row survive until success.
- WorkOS/API outage: same retry path; `attempts` + `last_error` make it observable.
- Double-delete requests: enqueue is idempotent per (entity_type, entity_id) with an active row (unique partial index).
- Restore raced against purge: restore only valid while `status='pending'`; the `FOR UPDATE` claim makes purge-vs-restore serial.

## Testing (static verify workflow — no local docker runs)

- Unit: reaper claim query semantics **including the legal-hold guard (entity-level and org-level holds block purge; release resumes it)**; each step's idempotency with mocked stores (S3 client, Chroma adapter, DBs); org fan-out waiting logic; enqueue idempotency; user-erasure anonymization leaves org data coherent.
- Component: `TypeToConfirmDialog` (button disabled until exact match), Recently-deleted list + restore.
- Route tests: soft-delete endpoints set `deleted_at` + enqueue and never hard-delete; permission checks (org admin / owner).
- Migration reviewed statically; verify `notDeleted` filter applied to all list queries.

## Phasing

1. **Phase 1:** queue + `legal_holds` tables + migrations + reaper skeleton (incl. hold guard) + purger compose service + **project** deletion end-to-end (dialog, endpoints, purge steps, restore, Recently deleted).
2. **Phase 2:** **documents** (delete endpoint, dialog, purge steps — fixes MinIO/Chroma leak).
3. **Phase 3:** **conversations** (fixes checkpoint leak in session delete).
4. **Phase 4:** **organizations** (offboarding; fan-out + WorkOS org delete) + hold APIs.
5. **Phase 5:** **user erasure** (account delete + anonymization).

## Out of scope

- Scheduled retention policies ("auto-delete after X days") — the queue supports it later via `purge_after`.
- Folder deletion (composes from document deletion; follow-up).
- Legal-hold management UI (API only for now; holds are rare, deliberate events).
- Data export / portability (Art. 20) and export-before-delete — separate feature.
- Backup scrubbing — deleted data persists in backups until rotation; document the rotation window in the DPA (see GDPR section).

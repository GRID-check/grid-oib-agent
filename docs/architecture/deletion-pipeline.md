# Deletion Pipeline: Projects, Folders, Documents, Conversations, Organizations

**Date:** 2026-07-05
**Status:** Phase 1 implemented
**Branch:** feature/applicable-oib-standards (or follow-up branch)

## Problem

GRID has no working deletion story. Today:

- `DELETE /api/projects/[id]` exists but no UI calls it, and it leaks: SeaweedFS objects (no S3 delete code exists anywhere in the repo), the project's Chroma collection, `document_metadata` rows, `aiq_jobs` rows, and LangGraph checkpoints. `conversations.projectId` is `ON DELETE SET NULL`, so chats become permanent orphans and their checkpoints become unreachable.
- There is no way to delete a single document (no DB delete endpoint, no SeaweedFS delete). The only existing path (`deleteFiles` → `DELETE /v1/collections/{name}/documents`) removes Chroma chunks only.
- Session/conversation deletion leaks LangGraph checkpoints.
- There is no organization offboarding at all.

Enterprise customers (~40 target orgs) require reliable data deletion (GDPR Art. 17 / security questionnaires). Deletion must span five stores that cannot be updated atomically: `grid_app` Postgres, `aiq_jobs` Postgres, `aiq_checkpoints` Postgres, SeaweedFS, Chroma, plus WorkOS (FGA resources / orgs).

## Design principles

1. **Soft delete first, purge asynchronously.** Cross-store deletion cannot be atomic in one HTTP request. A tombstone keeps all pointers alive until every store confirms cleanup.
2. **The queue is a Postgres table.** No message broker. A row awaiting purge *is* the task; crash-safety comes from the row surviving.
3. **Idempotent steps, ordered, entity row last.** Every purge step is safe to re-run (deleting absent things is a no-op). Pointers (collection name, SeaweedFS prefix, conversation ids) are gathered before anything is destroyed; the entity's own row is deleted last.
4. **One reaper, per-entity plug-ins.** A single poll loop dispatches to a step list per entity type. New deletable entities are added by writing a step list, not new infrastructure.

## Architecture

### Central deletion queue (grid_app Postgres)

New table `deletion_queue` — simultaneously tombstone, work queue, and surviving audit record:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `entity_type` | text | `'project' \| 'folder' \| 'document' \| 'conversation' \| 'organization'` |
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
| `payload` | jsonb | pointers snapshot (collection name, SeaweedFS prefix, conversation ids) captured at enqueue time as a fallback |

Rationale for a central table (vs per-table columns only): organizations have **no DB row** in grid_app (ADR-0007 — they live in WorkOS), so there is nothing to put a `deleted_at` column on. The queue also gives one audit trail and one poller for all entity types.

Entities that do have rows additionally get a `deleted_at timestamptz` column (`projects`, `conversations`) used **only** for query filtering — the reaper never scans entity tables. `documents` had one too (migration 0009) but never soft-deleted — every document delete is a hard DELETE — and migration 0077 dropped the column, because a filter over a column nothing writes hides rows the day something does.

### Legal holds (grid_app Postgres)

New table `legal_holds`: `id`, `entity_type`, `entity_id`, `organization_id`, `reason`, `created_by`, `created_at`, `released_at` (nullable). A hold is **active** while `released_at IS NULL`.

Semantics: a hold does **not** block soft delete (a folder still goes to the Papierkorb) (the entity still disappears from the UI as the requester expects) — it blocks **purge**. The reaper's claim query excludes any queue row with an active hold on the same entity, or on its parent organization (org-level holds freeze everything inside the org, including project-purge children enqueued by an org offboarding). When the hold is released, purge resumes on the next tick with no further action.

This doubles as GDPR **Art. 18 (restriction of processing)** support: restricted data is preserved but not actively processed.

**What a hold covers, and who asks (migration 0093).** "Covered" is one database function, `grid_legal_hold_blocks(entity_type, entity_id, organization_id)`, and every reader calls it rather than restating it. An entity is covered by an active hold of its own organization on: the organization; the entity itself; what contains it (a document's project and conversation, a conversation's project); what it contains, since erasing it erases that too (a conversation's attachments; a project's documents, chats and the chats' attachments; for an organization, any hold in it at all); and the user who created it (a custodian hold: `documents.created_by`, `conversations.created_by`). Since migration 0112 a **folder** is covered by a hold on the folder, on a folder above it (which contains it) or below it, on a document in its subtree, on the project, on the creator of a document in it, or on the organization; a document is also covered by a hold on any folder on its path, and a project by a hold on any of its folders (`grid_folder_subtree`, `grid_folder_ancestry`). Three readers:

- **The purger** — its claim query and the TOCTOU re-checks in `purge-project.js` and `purge-conversation.js`. The predicate used to be written out in `purger/db.js` and saw only the project and the organization, so a held document inside a deleted project was purged with it.
- **The BFF's immediate deletes** — documents, Archiv documents, conversations and chat attachments are hard-deleted in the request, not queued, and a folder is purged in the request by „Endgültig löschen", so each calls `assertNoActiveHold` (`lib/compliance/holds.ts`) after its access check and before its first destructive step. A covered entity answers **409** `{ code: 'CONFLICT', details: { reason: 'legal_hold' } }` and nothing is erased; the chat is not even marked deleting. The response never names the hold or its reason.
- **The delete triggers** — `BEFORE DELETE` on `documents` and `conversations` raise SQLSTATE `GLH01` for a covered row, including a row reached by a cascade from a project. This is the backstop for a delete path that forgot to ask; `lib/api/handler.ts` maps `GLH01` to the same 409. It guards the rows only: object storage and the vector store are outside the transaction, which is why the application check comes first. A project row has no trigger of its own: its content has, and an empty project row is not content (its creation rollback, `deleteProjectRow`, must keep working under an organization hold).

Unlike the purge, an immediate delete is **refused**, not deferred: there is no queue row for a document to resume from once the hold is released, so the requester gets the refusal and deletes again after release. A chat is refused the same way when the hold exists at delete time. A hold placed after the chat was marked deleting, while its erasure waits in the queue for a retry, defers that retry instead (see **Conversation** below).

API: `POST /api/holds` and `POST /api/holds/[id]/release` (org owner + internal support only), `GET /api/holds` (org admin). Management UI is out of scope for now — holds are rare, deliberate legal events; the API + audit trail is what compliance requires.

### Query filtering

All list/get queries for projects and conversations gain `WHERE deleted_at IS NULL`, via a small shared helper (e.g. `notDeleted(table)`) so the filter cannot be forgotten. Soft-deleted projects 404 on their routes. Documents and conversations inside a soft-deleted project are hidden transitively via the project check; documents themselves are hard-deleted and carry no such filter (0077).

### Per-entity policy

| Entity | Confirm UX | Grace period | Restorable |
|---|---|---|---|
| Folder | simple confirm; „Endgültig löschen" (project admins) confirms again | 14 days (config `FOLDER_PURGE_GRACE_DAYS`) in the Papierkorb | yes, with its access, subfolders and documents |
| Document | simple confirm dialog | 0 (purged on next reaper tick, ≤~60s) | no |
| Conversation | simple confirm (existing modal flow, upgraded) | 0 | no |
| Project | **type-to-confirm** (project name) | 7 days (config `PROJECT_PURGE_GRACE_DAYS`) | yes |
| Organization | **type-to-confirm** (org name), org owner only | 14 days (config `ORG_PURGE_GRACE_DAYS`) | yes |
| User (erasure) | support-initiated (API) or account-settings flow | 7 days | yes (within grace) |

Grace periods are config values; the architecture is identical at 0. All grace periods must stay ≤ 23 days so that grace + retry headroom keeps total erasure time within the GDPR "one month" response window (Art. 12(3)).

### Purger service

New docker-compose service `purger`: **same image as the frontend, different command** (`node purger/index.js`). *(Revised from the original `aiq_api`-image idea during implementation planning: `grid_app` Postgres is owned by the frontend — single-writer rule — so the purger is plain-JS in `frontends/ui/purger/`, and the Python backend instead exposes one internal maintenance endpoint for its stores.)* No new codebase, no inbound ports. It holds all credentials (grid_app DB, aiq_jobs DB, aiq_checkpoints DB, SeaweedFS, Chroma dir/API, WorkOS API key) — acceptable as a privileged internal service. "Spawn on demand" was rejected: it requires docker-socket access from an app container (root-equivalent, fails enterprise security review). A sleeping poll loop costs ~zero.

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
1. Delete SeaweedFS object at `storage_key`
2. Delete Chroma chunks for that file (existing backend `DELETE /v1/collections/{collection}/documents`)
3. Delete `document_metadata` row (`aiq_jobs`) for (collection, filename)
4. Delete `documents` row

A re-upload under the same name is not a deletion and takes none of these
steps. The ingestor retires the previous version's chunks, by the ids it
collected before reading the file, only after the new version has indexed, and
keeps the `document_metadata` row with the Dokumentart, title and folder a
person set on it. A re-upload that fails to index leaves the previous version in
place and takes back out any of its own chunks that were already inserted; two
re-uploads of one name at once are serialised, so the later one is what stays
([document ingestion](../technical-reference/document-ingestion.md#a-re-upload-replaces-the-previous-version-once-it-has-indexed)).

A delete does not wait for an ingest of the same document. Step 2 removes the
chunks that are there, and an ingest still running (a re-upload on another
replica, or a dispatch that left after the upload recorded its version) inserts
the rest afterwards. The ingestor asks `GET /api/internal/document-exists` once
the file is indexed, and on `exists: false` takes back out exactly what it
inserted, retires nothing and writes no `document_metadata` row. It discards on
that definite answer only; an unreachable BFF leaves the chunks in. Because the
row is deleted last, an ingest that asks between step 2 and step 4 still finds
it and keeps what it inserted after step 2, so every immediate delete (project,
Archiv, a chat attachment, and a whole chat's attachments in step 4 of the
conversation delete below) purges the chunks once more after the row (logged,
never surfaced; the orphaned-vector sweep is the net)
([a document deleted while it indexed](../technical-reference/document-ingestion.md#a-document-deleted-while-it-indexed-takes-its-chunks-back-out)).

**Folder** (the Papierkorb, migration 0112, ADR-0081). A project folder only: an Archiv folder has no bin, and its delete re-files what it holds into its parent and removes the row in the request (ADR-0078). Deleting a project folder takes its subfolders and their documents with it, as one bin entry: `moveFolderToBin` (`lib/projects/folder-bin.ts`) needs write on the folder and on every folder below it (a subtree holding a folder the person may not read, or may only read, is refused with one generic 403, `folder-contents-protected`, that names nothing), takes the project's bin lock, marks every folder of the subtree `deleted_at` with `bin_root_id` = the deleted folder, and inserts the queue row (`purge_after` = now + `FOLDER_PURGE_GRACE_DAYS`, default 14, at most 23) in one transaction. The documents keep their `folder_id`: a deleted folder hides itself and what is filed in it from every listing, document read and the agent's internal routes, for everyone, admins included (`folder-access-rule.ts`, the restricted-folder enforcement). In the same request each document's chunks are purged from the vector store (`purgeIngestedChunks`); when the backend does not confirm one, the bin entry is undone (the documents purged so far are dispatched again) and the request answers 502, so a folder is never in the bin while its content is searchable. An ingest still running asks `document-exists`, which answers `false` for a document in a deleted folder, and takes its chunks back out. Placement never moves a document in the bin. Migration 0112's triggers refuse an insert or a move of a document or folder into a deleted folder (SQLSTATE `GFD01`, answered 404) under the same lock, so nothing lands in a folder between its check and its deletion.

Restoring (`restoreFolderFromBin`, within the grace period, while the purger has not claimed the row) needs what deleting needed. It closes the row as `restored`, takes the entry's folders out of the bin, puts the folder under its old parent or, when that is gone, at the project root (the answer says `restoredTo: 'root'`), refuses (409 `folder-name-taken`) while a living sibling holds its name, and dispatches every document again into the collection its folder puts it in now.

Purge steps (`purger/purge-folder.js` → `POST /api/internal/folders/[id]/purge` → `purgeBinnedFolder`; „Endgültig löschen" runs the same function in the request after claiming the row, and puts the row back to `pending` for the purger when anything fails):
1. Re-check the legal hold (409 `legal_hold` defers the row, like a held project).
2. Find the answers that drew on the folder's documents (stored cited and read sources, by document id or collection and file name), record the folder on their conversations (`conversation_restricted_folders`), mark them `metadata.sourceDeleted`, and mark the reports Piloti filed from them.
3. When the organization's setting is „Mit dem Ordner entfernen": the derived-content removal (below), its ids merged into the row's payload (`payload.derivedRemoval`).
4. Erase each document by the document delete's own steps (`eraseProjectDocument`: chunks, every version's objects, renditions, thumbnails and extracted images, grants and assignments, the row, the chunks once more).
5. Mark the entry's folders `purged_at`, last: they stay as permanent tombstones with their grants (ADR-0081).
6. The purger erases the Langfuse traces of the conversations step 3 touched and merges the counts into the payload.

Every step is idempotent; a retry after any failure finishes the work, and a folder already purged answers `already-purged` with the conversations whose traces step 6 still owes. A row that names a folder not in the bin is failed for good (`not_in_bin`).

**What is derived from a purged folder** is decided at read time by the folder rule, `effectiveFolderLevel`, from the organization's setting „Inhalte aus gelöschten Ordnern" (`organizations.settings.deletedFolderContent`): `unchanged` (default) keeps the tombstone's grants, `project` lets every project member read it, `admins` and `remove` leave it to organization admins. Memory notes (by their folder ids), conversations (by their record) and anything else asking the rule follow at once; nothing is rewritten when the setting changes.

**The derived-content removal** („Mit dem Ordner entfernen"): memory notes whose source folders include the folder, and notes learned in a conversation whose answers drew on it, are deleted (an open folder's notes carry no folder id, so the conversation is the only link; deleting one note too many is recoverable, keeping personal data is not); those answers' text becomes „Inhalt entfernt: Quelle gelöscht" and their metadata only `sourceRemoved` (citations, cards, findings, the Herleitung go; the message row stays, so the chat reads on); filed reports from those conversations are marked „Quelle gelöscht am …", never deleted; the conversations' Langfuse traces are deleted (a no-op without Langfuse configured). The record is the queue row: `requested_by`, `requested_at`, `purged_at`, `payload.derivedRemoval` (the ids of the conversations, messages, notes and reports) and `payload.purged` (counts). No content.

**GDPR, without a GDPR button.** There is no separate erasure action, and no user-facing copy names the GDPR (product owner, 6 Oct 2026). The ordinary pipeline meets Art. 17: a deleted folder is out of every listing, search and answer at once, and its purge removes the files, every version, renditions and previews, the index entries and (under „Mit dem Ordner entfernen") the derived content and its traces once `FOLDER_PURGE_GRACE_DAYS` is over, which is capped at 23 days so grace plus retries stay inside the one-month response window of Art. 12(3). A request that cannot wait is „Endgültig löschen" by a project admin. A legal hold (Art. 18) stops the purge and nothing else.

**Conversation**:
1. Delete LangGraph checkpoints (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes` in `aiq_checkpoints`) for `thread_id = conversation id`
2. Delete `conversations` row (`messages` cascade)
3. Delete the chat's Langfuse traces (below): in the purger's retry after the BFF's erasure, or, for a chat the delete request erased itself, by the scheduler afterwards; see **Langfuse traces**

What `DELETE /api/conversations/[id]` does today is immediate, with the queue
as its retry (`deleteConversation`, `lib/conversations/service.ts`), and every
step after the hold check is safe to repeat:

1. `owner` on the conversation (or the creator of one already marked deleting, so a failed erase can be retried).
2. `assertNoActiveHold`, before anything is marked or erased.
3. Mark the conversation `deleted_at`, which hides it and makes the session upload refuse new bytes, and in the same transaction insert a `deletion_queue` row (`entity_type = 'conversation'`, `purge_after` = now + 10 minutes, `CONVERSATION_ERASURE_RETRY_DELAY_MS`). The active-row index keeps one pending row per chat, so a repeated delete leaves the queued retry and its attempts alone.
4. `purgeSessionDocuments` (`lib/session-documents/cleanup.ts`): for each attachment row, its chunks, its objects, then the row, then its chunks once more (logged only). A row whose erase failed is kept, and so is the conversation.
5. `deleteSessionCollection`: the chat's whole `s_` collection through the backend's `DELETE /v1/collections/{name}`. This covers chunks no row names, such as attachments uploaded before session files were rows. A collection that does not exist (404), or a deployment with no knowledge layer (503), counts as erased. Any other failure keeps the conversation.
6. Delete the `conversations` row (`messages` and the remaining document rows cascade), then the collaboration rows; close the queue row (`pending` or `failed` → `purged`, never a row the purger has claimed); then the agent's drafts.

Steps 4 to 6 are one function (`eraseMarkedConversation`). When step 4 or 5
fails, typically because the agent service is down, the request answers 502 and
the chat stays marked, and the queue row is what brings it back. The purger
claims it like any other row (`FOR UPDATE SKIP LOCKED`, backoff from
`claimed_at`, `failed` after 10 attempts, `reapStranded`) and runs
`purger/purge-conversation.js`, which re-checks the hold and calls
`POST /api/internal/conversations/[id]/erase` on the BFF (`FRONTEND_INTERNAL_URL`,
`GRID_INTERNAL_API_TOKEN`, the queue row's organization as the tenant scope).
That route calls `retryConversationErasure`, which runs the same
`eraseMarkedConversation`. The steps are not copied into the purger: they need
the BFF's tenant scope, the session-document ledger and its backend clients, and
a JavaScript copy would drift from the TypeScript one. What the retry decides on
its own:

- **A legal hold placed after the mark defers the erasure.** The chat does not
  come back: the requester already saw it go, and its attachments may be half
  erased. The route answers 409 `legal_hold`, the purger puts the row back to
  `pending` without spending an attempt, and the claim skips it while the hold
  is active, the same semantics as a held project purge. It stays listed as
  pending in `GET /api/deletions`, and the erasure resumes on the tick after the
  release.
- **A chat that is not marked deleting is refused** (409 `not_deleting`), and the
  purger fails the row for good on the first such answer (`markFailedPermanent`,
  `last_error` saying the row names a live chat and nothing was erased) rather
  than retrying ten times for the same refusal. It is `failed`, not `purged`,
  because nothing was erased. A queue row that names a live chat is a bug to
  surface, not an instruction to follow.
- **A chat whose row is already gone is finished**, not a failure. A project purge
  takes its chats' rows, and a request can die after the row delete. The steps
  are keyed by the id and are no-ops on an absent row, so the collaboration rows,
  the drafts and the queue row are still dealt with.

**Langfuse traces (ADR-0044).** Traces hold the prompts and answers of every
turn, so the purger deletes a chat's after the BFF has erased it
(`purge-conversation.js` calls `deps.eraseConversationTraces`, built from
`workers/langfuse-traces.js`). The traces carry the conversation id as
`langfuse.session.id`, so the step lists the observations of that session,
`GET /api/public/v2/observations?sessionId=<id>` (cursor-paged, 1,000 a page),
and sends their distinct trace ids to `DELETE /api/public/traces` in batches of
at most 1,000. The legacy `GET /api/public/traces` is not used: Langfuse v4
answers it with 404 under its default write mode. Langfuse deletes
asynchronously (a worker, usually within about 15 minutes), and the step is
idempotent: a chat with no traces, or whose traces are gone or already queued,
finishes cleanly. Three outcomes, by design:

- **Langfuse not configured** (`LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`,
  `LANGFUSE_SECRET_KEY` not all set): a logged no-op, once per process and at boot,
  never a failure. A deployment without Langfuse has no traces to erase.
- **Langfuse unreachable, a 429 or a 5xx**: the step throws, the attempt is
  recorded and the queue row retries with its usual backoff. It runs after the
  BFF's erasure, so the retry finds the chat gone (`already-gone`) and goes
  straight back to the traces.
- **Langfuse answers something that is not the session's data** (a row of another
  session): the step throws before deleting anything. The client deletes what it
  is shown, and a filter Langfuse ignores returns everything.

A project purge runs the same step for every chat the project holds (step 2b of
**Project**), with the hold re-checked before each.

**A chat deleted by the request itself: the scheduler goes back for its traces.**
Only a retry or a project purge goes through the purger. A
`DELETE /api/conversations/[id]` that finishes erases in the BFF
(`eraseMarkedConversation`), closes its own queue row as `purged`, and the
purger never sees it. So the scheduler (`scheduler/index.js`,
`sweepConversationTraces`, on every tick) reads those rows
(`findConversationsAwaitingTraceErasure`, `scheduler/db.js`): `entity_type =
'conversation'`, `status = 'purged'`, `purged_at` within the last 35 days and at
least 15 minutes ago (a turn that was still streaming exports spans for a
little after the delete), no `payload.langfuseTracesErasedAt` yet, and not
blocked by `grid_legal_hold_blocks`. For each it asks the hold predicate once
more, deletes the chat's traces with the same client, and stamps
`payload.langfuseTracesErasedAt` on the row (a jsonb merge; no column). A chat
under a hold keeps its traces and is looked at again, inside the 35 days, after
the hold is released. A chat the purger erased itself is in the same set and is
simply repeated: the list finds nothing. Same failure semantics as the purger's
step: not configured is a no-op, a 429, a 5xx, a timeout or a database outage
stops the run and retries on the next tick (a WARN streak, one ERROR after about
five minutes), and any other failure (a 401, a 404 from a Langfuse outside a v4
write mode) logs one ERROR and backs off an hour. A run handles at most 100
chats and two minutes. The 15 minutes and the Langfuse delay mean the traces of
such a chat go within the hour, not at once; a span that arrives after the stamp
is removed by the retention sweep.

**Trace retention.** Langfuse's own retention is Enterprise-only, so the
scheduler (`scheduler/index.js`, `sweepTraceRetention`) does it once a day, the
first run on its first tick: it lists root observations that started before
`now - GRID_LANGFUSE_TRACE_RETENTION_DAYS` (default 30, never below Langfuse's
own minimum of 3) and deletes their traces in batches of 1,000. A run sends at
most 50 batches, reads at most 100 pages and stops after two minutes, so a
backlog drains over days; it logs how many it asked Langfuse to delete. A failed
run retries in an hour (a WARN streak for transient failures, one ERROR after
three, an ERROR at once for a 401 or a Langfuse outside a v4 write mode). It is a
no-op, logged at boot, without the Langfuse variables. Traces still being
written when a chat was erased can reappear after the erasure; this sweep
removes them. A trace whose root observation was never recorded is not found by
it.

A row that reaches `failed` stays in `GET /api/deletions` with its `last_error`
(the Recently deleted panel shows only projects). A person who deletes the chat
again gets a new pending row, and a successful erase closes both.
Migration 0095 queued the chats that were already stuck deleting before this
existed.

The browser's discard of an abandoned upload-only chat sends only this delete.
It used to send a collection delete through the v1 proxy alongside it, and when
the row went first that request was refused and the collection was left behind.

**Project**:
1. Gather pointers: `collectionName`, SeaweedFS prefix `org/{orgId}/project/{projectId}/`, all conversation ids for the project, and every other distinct `documents.collection_name` of the project — the restricted folders' collections, `<collectionName>_r<12 hex>` (ADR-0080), which hold chunks the project's own collection does not
2. Delete Chroma collection (existing `DELETE /v1/collections/{name}`; also clears its `document_metadata` rows), then each chat's `s_` collection and each restricted folder's collection, one backend call each with the legal hold re-checked before each; a failure aborts the purge before any row is deleted
2b. Delete the Langfuse traces of every gathered conversation id, one chat at a time with the hold re-checked before each; a failure aborts the purge before any row is deleted. A logged no-op without Langfuse configured
3. Delete `aiq_jobs` rows (`job_info`, `job_access`, `job_events`) for jobs referencing that collection
4. Delete LangGraph checkpoints for all gathered conversation ids
5. Delete all SeaweedFS objects under the prefix (paginated `ListObjectsV2` + batched `DeleteObjects` — first S3 delete code in the repo)
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

Python-side steps (Chroma collection + summaries, `aiq_jobs` rows, LangGraph checkpoints) are performed by the backend's internal `POST /v1/maintenance/purge-project-resources` endpoint, guarded by `GRID_INTERNAL_API_TOKEN`; the purger calls it as its first step. WorkOS calls use the same `@workos-inc/node` SDK and API key the UI uses.

Beside it, `POST /v1/maintenance/reconcile-summaries` (same guard) forgets summary rows — the agent's document inventory — whose file holds no chunks in the vector store, the rows a per-document delete orphaned before `delete_file` learned to forget both together. Body: `{ collections?: string[], dry_run?: boolean }`; answer: `{ status, dry_run, collections_scanned, orphans_found, orphans_forgotten, forgotten: [{ collection, file_name }], failures: [{ collection, error }] }`. It fails per collection, treats a file that is tracked in any status or still in flight as held, and refuses (503) rather than guesses when the vector store cannot be listed. The BFF's orphaned-vector sweep (`lib/platform/vector-reconcile.ts`, Platform → Vector maintenance) calls it as its second half over the collections it just chunk-reconciled, so the OIB corpus is never in scope from there. The same sweep runs on a clock: `POST /api/internal/maintenance/reconcile-vectors` (token-guarded `internalApiRoute`, cross-tenant by declaration) is called by the `vector-reconcile` CronJob in `deploy/pulumi/src/app/workers.ts` — the `storage-alerts` shape, weekly on Sunday 03:00 UTC by default (`vectorReconcileSchedule`, `vectorReconcileEnabled`; rows in `deploy/pulumi/README.md`). The manual run on the page and the scheduled one are the same function, so the page stays the place to run it now and read the counts. Compose has no scheduler for either sweep; an operator there points `cron` at the internal route.

### API surface (Next.js BFF)

- `DELETE /api/projects/[id]` — reworked: permission check → set `projects.deleted_at` → insert `deletion_queue` row. No hard deletes, no WorkOS call here.
- `POST /api/projects/[id]/restore` — org admin; within grace; clears `deleted_at`, sets queue row `restored`.
- `DELETE /api/projects/[id]/folders/[folderId]` — the folder, its subfolders and documents to the Papierkorb; enqueue (grace `FOLDER_PURGE_GRACE_DAYS`).
- `GET /api/projects/[id]/bin`, `POST /api/projects/[id]/bin/[folderId]/restore`, `DELETE /api/projects/[id]/bin/[folderId]` („Endgültig löschen", `project:manage`).
- `POST /api/internal/folders/[id]/purge` — token-guarded; the purger's purge of a bin entry, in the queue row's organization.
- `GET`/`PUT /api/organization/deleted-folder-content` — the setting; `PUT` needs `org:settings:manage`.
- `DELETE /api/documents/[id]` — new; soft-delete + enqueue (grace 0).
- `DELETE /api/conversations/[id]` — marks and enqueues, then erases in the request; the queue row is the retry when that erase fails (see **Conversation** above).
- `POST /api/internal/conversations/[id]/erase` — token-guarded; the purger's retry of that erase, in the queue row's organization.
- `DELETE /api/organizations/[id]` + `POST /api/organizations/[id]/restore` — org owner only.
- `GET /api/deletions?entity_type=…` — org-admin list of pending/failed deletions (powers "Recently deleted" UI).

### UI

- **Type-to-confirm dialog**: new shared component (`TypeToConfirmDialog`) built on existing `Dialog` primitives — destructive button disabled until input matches `display_name` exactly. Used by project and organization deletion. (No precedent exists in the codebase; the three existing delete modals stay simple-confirm.)
- **Delete project** action in project settings; **delete document** in the documents list/file views; conversation delete wired through the upgraded flow; **delete organization** in org settings (owner only).
- **Recently deleted** (org admins): lists pending project/org deletions with time-remaining and a **Restore** button. Without this, the grace period would require DB surgery to be useful.

### Migrations (grid_app)

1. `deletion_queue` table.
2. `deleted_at` on `projects`, `documents`, `conversations` (the `documents` one was never written and is dropped again by 0077).
3. `conversations.project_id` FK: `ON DELETE SET NULL` → `ON DELETE CASCADE` (belt-and-braces behind the purger's explicit delete).
4. `documents.folder_id` → `project_folders.id`: add `ON DELETE CASCADE` (currently no action; multi-path cascade from project delete is fragile without it).

## GDPR conformance mapping

How the design satisfies the articles enterprise DPAs and security questionnaires actually ask about:

| Obligation | Mechanism |
|---|---|
| **Art. 17** — right to erasure "without undue delay" | Deletion pipeline for all five entity types; grace + retry bounded within the Art. 12(3) one-month response window; `purged_at` timestamps are the evidence of completion |
| **Art. 17** — erasing a folder and what was derived from it | The folder's purge after at most 23 days (or at once by „Endgültig löschen"): the documents by the document delete's steps, and under „Mit dem Ordner entfernen" the memory notes drawn from it, the answers that drew on it (replaced), the conversations' Langfuse traces; the queue row (ids, counts, who, when; no content) is the proof. A legal hold defers it |
| **Art. 5(1)(e)** — derived content outliving a deleted folder | The organization's setting „Inhalte aus gelöschten Ordnern": unchanged, project, admins only, or removed with the folder; keeping derived personal data longer than its source is the organization's decision |
| **Art. 17 / Art. 5(1)(e)** — the prompts and answers in LLM traces | Langfuse traces are deleted by conversation id when the purger erases a chat or a project (native delete API, every edition; asynchronous, usually within about 15 minutes), and by the scheduler's daily sweep once older than `GRID_LANGFUSE_TRACE_RETENTION_DAYS` (default 30, minimum 3). A chat deleted by the request itself is picked up by a scheduler job from its closed queue row, within about the hour (legal-held chats keep theirs); the 30-day sweep is the net behind it. Langfuse does not remove copies saved into datasets; Piloti creates none |
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
- Database outage: the tick's reap and claim fail before anything is claimed, and the next poll retries. It logs one WARN per tick, and one ERROR (which err2issue files as an issue, ADR-0031) only once it has lasted about five minutes (5 ticks at the 60 s default; `workers/failure-streak.js`), then a recovery line on the first good tick. What counts as an outage is `workers/database-unavailable.js`, the code set the BFF uses too. A purge step that fails stays ERROR at once: its causes span four stores, and the row's attempts are the retry.
- Double-delete requests: enqueue is idempotent per (entity_type, entity_id) with an active row (unique partial index).
- Restore raced against purge: restore only valid while `status='pending'`; the `FOR UPDATE` claim makes purge-vs-restore serial.

## Testing (static verify workflow — no local docker runs)

- Unit: reaper claim query semantics **including the legal-hold guard (entity-level and org-level holds block purge; release resumes it)**; each step's idempotency with mocked stores (S3 client, Chroma adapter, DBs); org fan-out waiting logic; enqueue idempotency; user-erasure anonymization leaves org data coherent.
- Component: `TypeToConfirmDialog` (button disabled until exact match), Recently-deleted list + restore.
- Route tests: soft-delete endpoints set `deleted_at` + enqueue and never hard-delete; permission checks (org admin / owner).
- Migration reviewed statically; verify `notDeleted` filter applied to all list queries.

## Phasing

1. **Phase 1:** queue + `legal_holds` tables + migrations + reaper skeleton (incl. hold guard) + purger compose service + **project** deletion end-to-end (dialog, endpoints, purge steps, restore, Recently deleted).
2. **Phase 2:** **documents** (delete endpoint, dialog, purge steps — fixes SeaweedFS/Chroma leak).
3. **Phase 3:** **conversations** (fixes checkpoint leak in session delete).
4. **Phase 4:** **organizations** (offboarding; fan-out + WorkOS org delete) + hold APIs.
5. **Phase 5:** **user erasure** (account delete + anonymization).

## Out of scope

- Scheduled retention policies ("auto-delete after X days") — the queue supports it later via `purge_after`.
- Retention periods per folder („aufbewahren bis"); a deletion before it ends would be refused (later phase).
- LangGraph checkpoints of chats whose answers a folder purge replaced: the agent's per-thread state keeps the original answer until the checkpoint reaper removes the idle thread (`GRID_CHAT_CHECKPOINT_RETENTION_SECONDS`, default 14 days) or the chat is deleted; no per-thread checkpoint delete exists yet.
- Legal-hold management UI (API only for now; holds are rare, deliberate events).
- Data export / portability (Art. 20) and export-before-delete — separate feature.
- Backup scrubbing — deleted data persists in backups until rotation; document the rotation window in the DPA (see GDPR section).

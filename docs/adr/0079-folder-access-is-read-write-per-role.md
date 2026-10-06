---
status: accepted
date: 2026-10-06
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Folder access is read/write per role

## Context and Problem Statement

ADR-0078 gave a folder one switch: open, or restricted to some WorkOS roles.
Whoever could see a restricted folder could do everything in it their project
permission allowed. The product owner, 6 October 2026: "the whole file access,
simply restricted or not restricted, is way too simple; I want read write
access control." An office wants the site manager to read the contracts the
managing director edits, and every member to read the fee folder that only
accounting may change.

ADR-0078 also decided who may read a conversation that drew on a restricted
folder by a per-conversation mark and by role lists copied at the time. When a
folder's list changed, conversations and memory either stayed locked for
people who may now read the folder or were left open to people who may no
longer read it.

## Decision Drivers

* A rule people can predict: a subfolder never grants more than its parent.
* Retrieval stays restricted by construction: a collection is or is not in the scope.
* Writing is a second axis and must not change what anyone reads.
* What was derived from a folder (a chat's record, a remembered note) follows the folder's
  access as it is NOW, without a job that rewrites it.
* Roles stay in WorkOS (ADR-0007, ADR-0078).

## Considered Options

* **Per-role read/write grants on a folder, nesting only narrows** (chosen).
* Per-user grants on a folder.
* WorkOS FGA with a `folder` resource type and `reader`/`writer` relations.
* Keep restricted/open and add a project-wide "read-only" role.

## Decision Outcome

Chosen option: per-role read/write grants, because they extend ADR-0078's
roles without a second source of truth, keep retrieval's per-collection
boundary, and give one rule a test table can pin.

**The model.** A folder either inherits (`project_folders.access_mode =
'inherit'`, the default; a root folder inherits the project) or has its own
list (`'custom'`): rows of `project_folder_grants (folder_id, role_slug,
level)`, `level` `read` or `write`, `role_slug` a WorkOS role or the reserved
`*` for every project member. A role not on the list gets nothing. The
effective level of a folder for a person is the MINIMUM, over the folder and
every ancestor with its own list, of the best entry that person holds there
(`none < read < write`), so nesting only narrows. Organization admins
(`org:projects:administer`) write everywhere. The project permission
`project:documents:write` is the ceiling for write. An unknown folder or a
broken path is `none`. This is one pure function, `effectiveFolderLevel` in
`lib/authz/folder-access-rule.ts`. Changing a list needs `project:manage` and
is audited as `project.folder.access_changed` with each entry's level. An own
list is never empty, and holds at most 20 entries.

**Retrieval keys on READ.** A folder restricts reading when it has its own list
without `*`. Only such a folder gets its own collection
(`<project collection>_r<12 hex>`), and a document lives in the collection of
its nearest read-restricting folder, exactly as in ADR-0078. A list with `*`
decides only who may write; changing who may write moves nothing.

**Every write path asks one function**, `requireFolderWrite` (project ceiling,
then write on each folder touched: not readable is 404, read-only is 403 with
`reason: folder-read-only`): upload and replacement, new folder (and the
folder-upload resolver), folder rename, move and delete, a document's rename,
tags, re-read, move, delete and every lifecycle transition (through
`getAccessibleDocument(…, 'write')`), a generated document's filing, and a
quarantine release. The listing reports the reader's level per folder and for
the project root, so the UI marks a folder „Nur lesen" and hides its write
affordances.

**Roles for access decisions come from the WorkOS membership**, cached at most
60 s (`lib/auth/membership-roles.ts`), with the token's roles claim as the
fallback when WorkOS cannot be asked. A role taken away stops opening a folder
within a minute, not at the next token refresh.

**Deleting a folder leaves a tombstone.** The row is soft-deleted (`deleted_at`)
and keeps its mode and grants; its documents and subfolders move up as before.
Listings, the tree, placement and every read path ignore deleted folders; the
access rule still answers for a deleted folder's id.

**What is derived from restricted content records SOURCE FOLDER IDS** and is
judged against the current grants when it is read:

* a conversation's use, per person (`conversation_restricted_folders`, migration 0107): content
  from a folder not every member may read enters the model's context only after the BFF
  admitted that use against the asker and everyone the conversation is shared with, under the
  advisory lock every widening takes (`POST /api/internal/conversations/[id]/restricted-use`).
  The agent narrows each turn's scope to what may be drawn on, admits each tool round before
  the model reads it, and keeps restricted collections out of every listing. Sharing allows a
  person who may read every recorded folder now. This replaces ADR-0078's per-socket
  confinement check and its `4412` close;
* restricted memory (`project_memory.restricted_folder_ids`, migration 0109), shown to a person
  who may read all of its folders now, and served into a chat only after its folders are
  admitted for that conversation.

A folder opened to every member stops restricting what was recorded from it; a
narrowed one restricts it to fewer people. Nothing is rewritten when access
changes. Deep research and tasks from a conversation that recorded a restricted
folder stay refused for now, as do profile patches and filing outside the
recorded folders.

### Consequences

* Good, because "read but not edit" is expressible per role, including "everyone reads, a few
  edit" (`*` read plus a role with write), without a second collection.
* Good, because the rule is one pure function with a table of cases, and the database holds the
  shape (level CHECK, role CHECK, 1–20 entries by a deferred constraint trigger, RLS).
* Good, because a change of a folder's list takes effect for conversations and memory derived
  from it at the next read, with no revocation job.
* Bad, because read-vs-write is lost on the 0108 down migration: every grant becomes a role in
  `restricted_roles` and a `*` list becomes open, so an older build lets every reader write.
* Bad, because roles are looked up in WorkOS per person and organization at most once a minute;
  an outage falls back to the token's roles, which may be up to the token's lifetime stale.
* Bad, because the agent detects restricted content in a tool result by the collection name it
  carries (`Collection:` in the grounding block). A future tool that returns restricted content
  without naming its collection would bypass the admission; such a tool must be added to the
  admission or list nothing restricted.
* Bad, because listing is not use, so restricted files do not appear in the inventory block,
  `list_files` or the document cards at all, even for a reader who may open them; they are
  found by search.
* Bad, because a conversation that recorded a restricted folder still cannot commission deep
  research or a task, even after the folder is opened again, until that rule is revisited.
* Bad, because tombstones accumulate; nothing purges them yet.

### Confirmation

* `lib/authz/folder-access.spec.ts`: the 24-row table for `effectiveFolderLevel` (inherit,
  custom, nesting narrows, `*`, admin, unknown and broken paths, tombstones) and
  `withProjectCeiling`, `restrictsReading`, the collection keyed on read.
* `lib/authz/folder-access.integration.spec.ts` (real Postgres): listings per level, RLS on the
  grants, the deferred trigger refusing an emptied list, the level and role CHECKs, the
  tombstone that frees its name and still answers.
* `scripts/rls-test-db.sh`: 0107 backfill to folder ids, its down and re-apply; 0108 backfill
  (each role a write grant), its constraints (empty and 21-entry lists refused), a list
  replaced in one transaction, a tombstone freeing its name, the down (read-vs-write lost, `*` open, tombstones removed) and re-apply;
  0109 backfill (collection to folder, unknown to the nil UUID, twin superseded), down and
  re-apply.
* `projects/folder-access-settings.spec.ts`: validation (empty, over 20, a role twice, an unknown
  role), `project:manage` first, the audit metadata with levels, the IFC guard only for a list
  that restricts reading; `collection-placement.integration.spec.ts`: a `*` list moves nothing.
* `projects/folder-service.access-change.spec.ts`: rename, move and delete refuse a read-only
  folder with 403 and a hidden one with 404 under the real rule, the project ceiling, the admin,
  the tombstone; `folder-service.ensure.spec.ts`: nothing is created below a read-only folder.
* `documents/service.spec.ts`, `upload-screening/review.spec.ts`, `documents/generated.spec.ts`:
  delete, release and filing ask `requireFolderWrite` and stop on a read-only folder.
* `conversations/restricted-use.spec.ts` and `restricted-use.integration.spec.ts`: admission
  against the audience, the lock with widening, loosen and tighten judged at read time.
* `projects/memory-restricted.integration.spec.ts` and `projects/memory-service.spec.ts`:
  restricted notes by folder id, loosen, tighten and tombstone.
* `auth/membership-roles.spec.ts`: the membership lookup, the 60 s key, the fallback.
* `tests/aiq_agent/knowledge/test_restricted_use.py`, `turn/test_context.py`,
  `turn/test_subject_document.py`, `agents/piloti/test_confined_turn.py`: the agent asks before
  reading the scope, narrows it, admits and withholds tool results, and stays confined.
* `features/documents/components/folder-access-dialog.spec.tsx` and the `/dev/folder-access`
  preview: the dialog and the „Nur lesen" marks.
* Nothing enforces that a NEW write path calls `requireFolderWrite`; review is the gate.

## Pros and Cons of the Options

### Per-user grants on a folder

* Good, because "this one person" needs no role.
* Bad, because offices already think in roles (ADR-0078), and a person-by-person list goes stale
  as people join and leave; WorkOS has no per-user grant to mirror it.
* Bad, because the retrieval collection is per folder, not per person, so per-user grants would
  still collapse to "who may read" per folder.

### WorkOS FGA with `reader` and `writer` relations

* Good, because it is a managed authorization service with relations and inheritance.
* Bad, because FGA is additive: "a child folder is narrower than its parent" needs exclusions,
  which WorkOS lists as coming soon (the same reason ADR-0078 rejected it).
* Bad, because every folder and every change would be mirrored into WorkOS, a second source of
  truth for the tree, and every listing would call out per folder.

### Keep restricted/open and add a project-wide read-only role

* Good, because nothing in the folder model changes.
* Bad, because it cannot say "reads this folder, edits that one", which is the request.

## More Information

* Supersedes the parts of [ADR-0078](0078-folder-access-follows-workos-roles-and-a-restricted-folder-is-its-own-collection.md)
  that decided who may see a folder (roles on `restricted_roles`), the per-conversation mark and
  the per-socket confinement check, and restricted memory keyed by collection. ADR-0078's
  retrieval collection per restricted folder, its egress refusals and its IFC rule stand.
* User guide: [`sensitive-data-and-access.md`](../user-guides/sensitive-data-and-access.md#who-may-read-and-edit-a-folder).
* Where a later lifecycle feature would attach (participant notices, an organization setting for
  deleted-folder content, a download log): `setFolderAccess` after placement, the tombstone in
  `deleteProjectFolder`, `effectiveFolderLevel`, `resolveMembershipRoles`, `admitSourceFolders`
  and `widenConversationAudience`, `memoryVisibleTo` and `readableFolderIdsFor`.

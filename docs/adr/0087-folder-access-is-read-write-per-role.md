---
status: accepted
date: 2026-10-06
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Folder access is read/write per role

## Context and Problem Statement

ADR-0086 gave a folder one switch: open, or restricted to some WorkOS roles.
Whoever could see a restricted folder could do everything in it their project
permission allowed. The product owner, 6 October 2026: "the whole file access,
simply restricted or not restricted, is way too simple; I want read write
access control." An office wants the site manager to read the contracts the
managing director edits, and every member to read the fee folder that only
accounting may change.

ADR-0086 also decided who may read a conversation that drew on a restricted
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
* Roles stay in WorkOS (ADR-0007, ADR-0086).

## Considered Options

* **Per-role read/write grants on a folder, nesting only narrows** (chosen).
* Per-user grants on a folder.
* WorkOS FGA with a `folder` resource type and `reader`/`writer` relations.
* Keep restricted/open and add a project-wide "read-only" role.

## Decision Outcome

Chosen option: per-role read/write grants, because they extend ADR-0086's
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

**Changing a list is the strongest write on a folder**, so it needs
`project:manage` AND write on the folder (404 if unreadable, a typed 403 if
only readable; organization admins write everywhere). A manager with only Lesen
could otherwise give themselves Bearbeiten. Write on the folder is also what
stops a change granting the caller more than they hold: the level is the minimum
over the path, so whoever writes the folder already holds the most any list on it
could give, and no separate "not above your own level" check exists to drift.

**A move that changes which lists govern a subtree needs `project:manage`, and
is refused unless the mover can read every folder in it.** The subtree's own
lists travel with it, but the lists above change: taking a folder out from under
a restricting one widens who reads a custom subfolder the mover cannot see, and
putting it under one narrows it. Either is a change of who reads a folder made
blind. The rule is the narrow one: it applies only when the chain of own lists
above the folder differs before and after, and only when the subtree holds a
folder `effectiveFolderLevel` says the mover cannot read (`unreadableFoldersBelow`;
403, `reason: folder-subtree-unreadable`, naming no folder). Organization admins
read everything and are never refused. A move that leaves the lists above as they
were, or whose subtree the mover reads in full, is unaffected.

**Retrieval keys on READ.** A folder restricts reading when it has its own list
without `*`. Only such a folder gets its own collection
(`<project collection>_r<12 hex>`), and a document lives in the collection of
its nearest read-restricting folder, exactly as in ADR-0086. A list with `*`
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
within a minute, not at the next token refresh. **The admin bypass is derived
the same way**: `clearanceOf` asks what the membership's roles hold now
(`orgRoleHoldsPermission`, whose role-to-permission map is cached at most 60 s)
rather than reading `org:projects:administer` from the token, so a demoted
admin stops reaching every folder within a minute. Only when WorkOS cannot be
asked is the token's permission the answer, as it is for the roles. This
covers the folder decision; the project-level admin reach of
`requireProjectAccess` still reads the token.

**Deleting a folder puts it in the Papierkorb, then leaves a tombstone**
(migration 0114, `lib/projects/folder-bin.ts`, decided 6 Oct 2026). A project
folder only: the Archiv's folders (ADR-0078) keep the shelf's delete, which
re-files the contents into the parent and removes the row, and have no bin,
purge or tombstone (`project_folders_bin_state_check`). The folder goes with its subfolders and their documents, as one entry: moving the contents
up into the parent, as the first version did, lifted the folder's own list from
them, so a delete could widen who reads them, and nobody deleting a folder in a
document system expects its files to stay. Deleting needs write on the folder
and on every folder below it; a subtree with a folder the person may not read
or may only read is refused with one generic 403 (`folder-contents-protected`)
that names nothing. In the bin the folders are `deleted_at` with `bin_root_id`,
the documents keep their `folder_id`, and a deleted folder hides itself and
what is filed in it from everyone, admins included. The documents' chunks are
purged from retrieval in the request and read again on restore, rather than
hits being filtered by folder state wherever retrieval resolves them: a purged
chunk cannot be found by any path, the agent's included, and a filter would
leak through the first path that forgot it. A purge the index does not confirm
undoes the delete (502). Triggers refuse filing into a deleted folder under the
project's bin lock (`GFD01`). A restore within `FOLDER_PURGE_GRACE_DAYS`
(default 14) brings the folder back with its access, at the project root when
its parent is gone. Then the purge erases the documents and keeps the folder
rows, with their grants, as permanent tombstones (`purged_at`); the access rule
still answers for a deleted folder's id.

**What was derived from a purged folder is shown as the organization says**
(„Inhalte aus gelöschten Ordnern", `organizations.settings.deletedFolderContent`).
The one rule applies it: `effectiveFolderLevel` answers for a purged folder
from its kept grants (`unchanged`, the default), `read` for every member
(`project`), or nothing but the admin bypass (`admins`, and `remove`, under
which the purge also removes the derived content: notes deleted, answers
replaced by „Inhalt entfernt: Quelle gelöscht", their traces deleted). The
tree loader carries the setting on each purged folder, so memory notes,
conversations and every other caller of the rule follow it at read time. The
purge records the folder on each conversation whose answers drew on it (an open
folder's use was never recorded) and marks those answers and the reports filed
from them „Quelle gelöscht am …". There is no separate erasure action: the
ordinary purge removes the files, versions, previews, index entries and (with
`remove`) the derived content and its traces inside the 23-day grace ceiling,
and the queue row (ids, counts, who, when, no content) is the record (product
owner, 6 Oct 2026: users need not see the GDPR, the product must meet it). A
legal hold on the folder, a folder above or below it, a document in it, the
project, a document's creator or the organization blocks the purge.

**What is derived from restricted content records SOURCE FOLDER IDS** and is
judged against the current grants when it is read:

* a conversation's use, per person (`conversation_restricted_folders`, migration 0111): content
  from a folder not every member may read enters the model's context only after the BFF
  admitted that use against the asker and everyone the conversation is shared with, under the
  advisory lock every widening takes (`POST /api/internal/conversations/[id]/restricted-use`).
  The agent narrows each turn's scope to what may be drawn on, admits each tool round before
  the model reads it, and keeps restricted collections out of every listing. Sharing allows a
  person who may read every recorded folder now. This replaces ADR-0086's per-socket
  confinement check and its `4412` close.

  **The admission (amended 6 October 2026).** Every tool call REPORTS the collections it returns
  content from (`note_collections_read`): the grounding-block renderer reports every hit, the
  exact search every file its match table names, `view_knowledge_image` the collection of the
  image it returns. The Piloti `ToolNode`'s call wrapper (`report_collections_read`) stamps that
  set onto the call's result, beside NAT's text. Before anything reads a round,
  `admit_tool_results` takes, per result, what was reported plus any restricted collection its
  text names (the backstop for a producer that forgot to report), puts only the ones the turn may
  draw on to the BFF, and replaces every result carrying a restricted collection that was not
  admitted with a notice: not drawable this turn, refused, the BFF unreachable, or no restricted
  use bound at all. It fails closed whether or not a use is bound. Listing is not use, fallbacks
  included: `list_files` filters a restricted folder's rows out of whatever it lists (the
  inventory, or the scope when the inventory failed to load), and `read_passage` neither
  suggests nor counts a restricted folder's file, nor confirms one exists ("no such Punkt",
  "registered but empty"), until this turn admitted its collection (`may_name`).
  `view_knowledge_image` takes its collection from the model, so it refuses one outside the
  turn's scope, and a restricted one the turn may not draw on, before any lookup; it echoes the
  turn's signed envelope to `GET /api/internal/document-file`, which then answers only for a
  collection in the scope that envelope signs, in its organization, and for a restricted
  folder's collection only when the asker and the conversation's audience may read the folder
  now. Without an envelope (a job worker) that route never answers for a restricted folder's
  collection;
* restricted memory (`project_memory.restricted_folder_ids`, migration 0112), shown to a person
  who may read all of its folders now, and served into a chat only after its folders are
  admitted for that conversation.

**The cached prompt view is dropped by placement.** The `documents:` block of
the project prompt view (`lib/project-profile/prompt-view.ts`, cached 5 min, one
per project for every member) names no document in a folder not every member
reads. Every change of who reads what ends in `placeProjectDocuments` (a list
set, a folder or document moved, a folder deleted), which therefore drops the
project's prompt view first and last. The sweep calls `retryProjectPlacement`
instead, which changes nothing about access and leaves the cache alone.

**Review rounds and the projects grid follow folder read.** Who a version is
offered to for review is the editors who may also read the document's folder
(`filterUsersWhoMayReadFolder`), and the grid's per-project document count
leaves out the documents in folders the viewer cannot read, as the project's own
list does.

A folder opened to every member stops restricting what was recorded from it; a
narrowed one restricts it to fewer people. Nothing is rewritten when access
changes.

**The record is also the read gate (lifecycle, 6 Oct 2026).** A conversation's
role (creator, grantee, project visibility) says who is a party to it, not who
may read what it drew on. `resolveResourceAccess` asks `peopleWhoMayRead` for the
caller, through the descriptor's `readersAmong`: a person whose roles do not
reach every recorded folder that still restricts someone holds the role but is
`contentLocked`, creator included. `requireResourceAccess` then throws
`ResourceRightsLostError` (403 `RESOURCE_RIGHTS_LOST`, no title, no folder) unless
the caller passes `allowLocked`, which only the roster, leaving and deleting
one's own chat do. Closed by default, so every present and future reader of a
conversation (messages, detail, live stream, frames, the chat socket's scope,
export) is covered without being taught to ask. The list keeps a locked chat
without its title, tags and subject (`contentLocked: true`), the client shows
„Geteilter Chat“ and „Ihnen fehlen inzwischen die Rechte, um diesen Chat zu
sehen“, and the inbox redacts its items. The same function answers the share
dialog (candidates carry `lacksFolderAccess`; the server refusal stays the
authority) and the roster (`lostAccess`). A document's sharing and assignment
need a write in its folder (`requireWriteAccess` on the descriptor, backed by
`requireFolderWrite`).

**Deleting a role** that folders name asks for a confirmation that lists them
(`GET /api/organization/roles/{slug}/usage`, `DELETE …?confirmFolders=1`). Whatever
a restore can bring back counts, because it comes back with its list: a folder in
the Papierkorb, and every folder of a project pending deletion. The list marks
those two („im Papierkorb“, „Projekt gelöscht“), since neither is in the
project's folder tree. Grants
keep their slug, so a folder whose own list then names no role that exists
matches nobody: organization admins alone read it (`effectiveFolderLevel`), and
the project settings list it as „Ordner ohne gültige Rolle“
(`foldersWithoutValidRole`). A rename in WorkOS changes the name, never the slug
(`UpdateOrganizationRoleOptions` has no slug), so grants keep matching; creating
a role again under the same name restores the old grants. Deep research and tasks from a conversation that recorded a restricted
folder stay refused for now, as do profile patches and filing outside the
recorded folders.

### Consequences

* Good, because "read but not edit" is expressible per role, including "everyone reads, a few
  edit" (`*` read plus a role with write), without a second collection.
* Good, because the rule is one pure function with a table of cases, and the database holds the
  shape (level CHECK, role CHECK, 1–20 entries by a deferred constraint trigger, RLS).
* Good, because a change of a folder's list takes effect for conversations and memory derived
  from it at the next read, with no revocation job.
* Bad, because the 0110 down migration drops every access list: an older build knows no folder
  access, so every folder has to inherit again in the product first, or the documents filed in a
  `_r…` collection leave everybody's scope.
* Bad, because roles are looked up in WorkOS per person and organization at most once a minute;
  an outage falls back to the token's roles, which may be up to the token's lifetime stale.
* Bad, because the admission is only as complete as the reporting: a future tool that returns a
  restricted folder's content outside the grounding block, without calling
  `note_collections_read` and without naming the collection, would still pass it. What stands in
  the way is a test, not the type system: every registered NAT function must be classified in
  `tests/aiq_agent/knowledge/test_collection_read_inventory.py`, and a tool that reads must name
  the test proving it reports. A tool bound outside Piloti's `ToolNode` gets no admission at
  all; deep research is one, and stays safe only because a run's scope never holds a restricted
  collection (ADR-0086).
* Bad, because `GET /api/internal/document-file` still answers by name for an open collection
  when no envelope is presented (a job worker has none to forward); the envelope check binds the
  chat tool, which always echoes one, and the internal token is the same secret that signs
  envelopes anyway.
* Bad, because listing is not use, so restricted files do not appear in the inventory block,
  `list_files` or the document cards at all, even for a reader who may open them; they are
  found by search.
* Bad, because a conversation that recorded a restricted folder still cannot commission deep
  research or a task, even after the folder is opened again, until that rule is revisited.
* Bad, because tombstones accumulate: a purged folder's row and grants are kept for good, so
  the derived content's access can be decided.
* Bad, because a restore re-reads every document of the folder (an ingest each), and a
  Dokumentart or display title set on the backend's metadata row is lost, as with a placement
  move.
* Bad, because a deleted folder's chunks are purged in the request: a folder of many documents
  takes a while to delete, and a backend that does not confirm refuses the delete.
* Bad, because removing derived content cannot reach the agent's LangGraph checkpoints of the
  affected chats; they go with the idle-thread reaper (14 days) or the chat's deletion.
* Good, because a manager cannot widen their own access: changing a list needs write on the
  folder, so a project admin with only Lesen is refused (403) and the UI offers no „Zugriff …"
  on a read-only folder. Bad, because a list that names nobody who holds a role can then only be
  repaired by an organization admin, which is what the bypass is for.
* Good, because a move cannot change who reads a folder its mover cannot see. Bad, because a
  project admin who is not an organization admin cannot move a subtree containing a folder
  hidden from them out from under (or under) a restricting folder, and must ask one.
* Good, because the document-roles block of the prompt view follows an access change at once
  instead of for up to five minutes. Bad, because every placement now costs two cache deletes,
  and a view built by a turn that began before the change can still be served from a build
  that finished between the two (the second drop closes all but a race of milliseconds).
* Good, because the admin bypass follows the membership within a minute. Bad, because
  `requireProjectAccess` still reads `org:projects:administer` from the token, so a demoted
  admin keeps the project-level reach until the token refreshes; only what they may read and
  write inside a restricted folder changed. Bad, because the role-to-permission cache is now
  60 s instead of 10 min, one more WorkOS listing per minute and organization at most.
* Bad, because the reviewer fan-out filters by folder read, but a person named by the caller or
  assigned to the document (`resource_assignments`) is not checked against the folder.
* Good, because a person who loses a role loses the content of every chat that drew on the
  folder at the next request (membership roles are cached at most 60 s), and gets it back with
  the role, with nothing to rewrite, because the gate is judged at read time, not stored.
* Bad, because the gate costs one indexed read of `conversation_restricted_folders` on every
  conversation access, and a WorkOS lookup per person when something was recorded. A list
  costs one read for all its rows and one folder tree per project; the share dialog and the
  roster evaluate at most 200 people, 20 at a time.
* Bad, because a locked chat cannot be left from its own screen yet: it stays in the list
  until the folder is readable again, the share is removed by its owner, or the person
  leaves through the share dialog.
* Bad, because a person who lost a folder still holds what they copied or downloaded, and a
  chat the creator may no longer read is locked for the creator too: only deleting it stays
  open to them.
* Bad, because deleting a role cannot be undone from Piloti: its folders are admin-only until
  someone sets a valid role (or re-creates the role under the same name).

### Confirmation

* `lib/authz/folder-access.spec.ts`: the 24-row table for `effectiveFolderLevel` (inherit,
  custom, nesting narrows, `*`, admin, unknown and broken paths, tombstones) and
  `withProjectCeiling`, `restrictsReading`, the collection keyed on read.
* `lib/authz/folder-access.integration.spec.ts` (real Postgres): listings per level, RLS on the
  grants, the deferred trigger refusing an emptied list, the level and role CHECKs, the
  tombstone that frees its name and still answers.
* `scripts/rls-test-db.sh`: 0110's constraints (empty and 21-entry lists refused, an unknown
  level and a `*`-prefixed slug refused, no custom folder without grants), a list replaced in one
  transaction, a tombstone keeping its list and freeing its name, the down (tombstones, the grants
  table and the columns removed) and re-apply; 0111's order CHECK, down and re-apply; 0112's index
  (an open and a restricted note with one text both live), its CHECK, and a down that deletes
  restricted notes rather than opening them.
* `projects/folder-access-settings.spec.ts`: validation (empty, over 20, a role twice, an unknown
  role), `project:manage` first, the audit metadata with levels, the IFC guard only for a list
  that restricts reading; `collection-placement.integration.spec.ts`: a `*` list moves nothing.
* `projects/folder-access-settings.spec.ts` also pins that a manager who may only read the folder
  is refused with the typed 403 and nothing is written, and that an admin and a writer pass.
* `projects/collection-placement.prompt-view.spec.ts`: placement drops the project's prompt view
  before and after, also when it fails, and the sweep's `retryProjectPlacement` does not.
* `authz/folder-access.spec.ts`: `clearanceOf` takes the bypass from the membership's roles, not
  the token (a demoted admin loses it, a promoted one gains it, WorkOS down falls back to the
  token); `unreadableFoldersBelow`; `filterUsersWhoMayReadFolder`. `authz/org-role-permissions.spec.ts`:
  the role-to-permission cache lives at most 60 s.
* `projects/folder-service.access-change.spec.ts` also pins the move rule: a subtree holding a
  folder the mover cannot read is refused when the lists above change, an admin is not, a move
  that leaves them as they were is not. `documents/reviewers.spec.ts`: review candidates are
  filtered by folder read. `projects/service.spec.ts` and
  `projects/folder-visibility.integration.spec.ts` (real Postgres): the grid's count leaves out
  hidden folders.
* `projects/folder-service.access-change.spec.ts`: rename, move and delete refuse a read-only
  folder with 403 and a hidden one with 404 under the real rule, the project ceiling, the admin,
  the tombstone; `folder-service.ensure.spec.ts`: nothing is created below a read-only folder.
* `documents/service.spec.ts`, `upload-screening/review.spec.ts`, `documents/generated.spec.ts`:
  delete, release and filing ask `requireFolderWrite` and stop on a read-only folder.
* `conversations/restricted-use.spec.ts` and `restricted-use.integration.spec.ts`: admission
  against the audience, the lock with widening, loosen and tighten judged at read time.
* `conversations/restricted-use.spec.ts` and `.integration.spec.ts` (`peopleWhoMayRead`,
  `lockedConversationIds`): who reads now, creator included, loosened and tightened, tombstone,
  unknown folder, bounded concurrency and bound, one tree per project, real Postgres.
* `sharing/access.spec.ts`, `conversations/live.spec.ts`, `conversations/service.spec.ts`,
  `app/api/conversations/[id]/rights-lost.route.spec.ts`: the read gate for the creator, a
  grantee and a project-visible chat; the detail, messages, write, rename, read-mark and the
  live stream (an open stream closes at the next re-check); the typed 403 carries nothing of
  the chat; the list sends no title; deleting one's own stays open. `inbox/targets.spec.ts`:
  redacted.
* `sharing/service.spec.ts`, `mentions/service.spec.ts`, `features/collaboration/…`: the roster
  flag and the disabled picker rows; a document's sharing, visibility, role changes, removals,
  ownership and assignment (`assignments/service.spec.ts`, `sharing/registry.spec.ts`) refuse a
  folder the caller may only read, before any write or rate limit.
* `authz/custom-roles.spec.ts`, `organization/…/custom-roles-section.spec.tsx`,
  `app/api/organization/roles/[slug]/route.spec.ts`, `authz/folder-access.spec.ts`
  (`foldersWithoutValidRole`, admin-only after a role is deleted, a rename keeps matching),
  `projects/folder-access-settings.spec.ts`, `folder-access.integration.spec.ts`
  (`listFoldersNamingRole`): the deletion guard and the flagged folders.
* `chat/stores/sessions-store.rights-lost.spec.ts`, `layout/…/MainLayout.spec.tsx`,
  `SessionsPanel.spec.tsx` and the `/dev/sessions?variant=rights-lost`,
  `/dev/share-dialog?variant=folders`, `/dev/custom-roles?dialog=delete` and `/dev/settings`
  previews: the neutral title and the state in the browser.
* `projects/memory-restricted.integration.spec.ts` and `projects/memory-service.spec.ts`:
  restricted notes by folder id, loosen, tighten and tombstone.
* `auth/membership-roles.spec.ts`: the membership lookup, the 60 s key, the fallback.
* `tests/aiq_agent/knowledge/test_restricted_use.py`, `turn/test_context.py`,
  `turn/test_subject_document.py`, `agents/piloti/test_confined_turn.py`: the agent asks before
  reading the scope, narrows it, admits and withholds tool results, and stays confined;
  `test_restricted_use.py` also pins the fail-closed admission (no use bound, not drawable, an
  image result), the side channel (a reported read admitted or withheld whatever the text says,
  calls never sharing what they read, a note from a worker thread) and the text backstop.
* `agents/piloti/test_restricted_tool_round.py`: through NAT's LangChain wrapper and the compiled
  graph, a read reported only on the side channel is admitted, or withheld when refused.
* `tests/knowledge_layer_tests/test_restricted_reads.py`: `list_files` lists no restricted file,
  the failed-inventory fallback included; `read_passage` neither suggests, counts nor confirms
  one before admission, and reports what it reads; the exact search reports its match table;
  `view_knowledge_image` refuses a collection outside the turn (or restricted and not drawable)
  before any lookup, reports what it returns and echoes the envelope.
* `tests/aiq_agent/knowledge/test_collection_read_inventory.py`: every registered NAT function is
  classified by how it keeps restricted content from the model, and a tool that reads names the
  test proving it reports.
* `app/api/internal/document-file/route.spec.ts`: with an envelope, only a signed collection in the
  signed organization, a restricted one only when drawable now, a bad envelope a 401; without
  one, never a restricted collection.
* `features/documents/components/folder-access-dialog.spec.tsx` and the `/dev/folder-access`
  preview: the dialog and the „Nur lesen" marks.
* `projects/folder-bin.integration.spec.ts` (real Postgres, 38 cases): a deleted folder and its
  documents hidden from every listing, document read and the agent's restricted list, for admins
  too; chunks purged and `document-exists` answering gone; a refused purge undoing the delete;
  the generic refusal for a subtree with a hidden or read-only folder; the triggers refusing an
  upload, a move and a new subfolder, and an upload that started first being taken along;
  restore with exactly the access it had, to the root when the parent is gone, refused on a name
  clash; the purge keeping tombstones with grants and marking derived answers; idempotent
  purges; the hold coverage table and the 409s; each setting's read-time effect on a folder, a
  note and a conversation; „Mit dem Ordner entfernen" through „Endgültig löschen" (notes,
  answers, traces through a stubbed Langfuse, reports marked, the content-free record) and its
  retry.
* `authz/folder-access.spec.ts`: the four settings on a purged folder, the bin hidden even
  without own lists. `purger/purge-folder.spec.mjs`: the purger's folder step.
* `scripts/rls-test-db.sh`: 0114's backfill, its down refusing while the bin holds a folder, the
  down and the re-apply.
* Nothing enforces that a NEW write path calls `requireFolderWrite`; review is the gate. The
  0114 triggers are the backstop for filing into a deleted folder.

## Pros and Cons of the Options

### Per-user grants on a folder

* Good, because "this one person" needs no role.
* Bad, because offices already think in roles (ADR-0086), and a person-by-person list goes stale
  as people join and leave; WorkOS has no per-user grant to mirror it.
* Bad, because the retrieval collection is per folder, not per person, so per-user grants would
  still collapse to "who may read" per folder.

### WorkOS FGA with `reader` and `writer` relations

* Good, because it is a managed authorization service with relations and inheritance.
* Bad, because FGA is additive: "a child folder is narrower than its parent" needs exclusions,
  which WorkOS lists as coming soon (the same reason ADR-0086 rejected it).
* Bad, because every folder and every change would be mirrored into WorkOS, a second source of
  truth for the tree, and every listing would call out per folder.

### Keep restricted/open and add a project-wide read-only role

* Good, because nothing in the folder model changes.
* Bad, because it cannot say "reads this folder, edits that one", which is the request.

## More Information

* Supersedes the parts of [ADR-0086](0086-folder-access-follows-workos-roles-and-a-restricted-folder-is-its-own-collection.md)
  that decided who may see a folder (roles on `restricted_roles`), the per-conversation mark and
  the per-socket confinement check, and restricted memory keyed by collection. ADR-0086's
  retrieval collection per restricted folder, its egress refusals and its IFC rule stand.
* User guide: [`sensitive-data-and-access.md`](../user-guides/sensitive-data-and-access.md#who-may-read-and-edit-a-folder).
* The download log is built: [`user-guides/download-log.md`](../user-guides/download-log.md) (what it records,
  retention, who reads it, the works-council note), the table in
  [`database/schema.md`](../database/schema.md#document_access_log-migration-0113-adr-0085), and
  `lib/download-log/service.ts` — `recordDocumentAccess` is called by every function that hands a
  document's bytes to a person, held to the list by `coverage.spec.ts`.
* Decided by the product owner on 6 Oct 2026 (`plans/2026-10-06-folder-access-lifecycle.md`):
  the share dialog lists only people who qualify, a chat shared with someone who later loses a
  folder stays in their list without its content, and deleting a role folders name asks first.
* Where a later lifecycle feature would attach (participant notices, retention
  periods per folder): `setFolderAccess` after placement, the bin in `moveFolderToBin` and the
  purge in `purgeBinnedFolder`, `effectiveFolderLevel`, `resolveMembershipRoles`, `admitSourceFolders`
  and `widenConversationAudience`, `memoryVisibleTo` and `readableFolderIdsFor`.

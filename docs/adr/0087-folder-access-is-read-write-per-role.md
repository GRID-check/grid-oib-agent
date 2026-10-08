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
folder's list changed, conversations either stayed locked for people who may
now read the folder or were left open to people who may no longer read it.

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

**Deleting a folder leaves a tombstone.** The row is soft-deleted (`deleted_at`)
and keeps its mode and grants; its documents and subfolders move up as before.
Listings, the tree, placement and every read path ignore deleted folders; the
access rule still answers for a deleted folder's id.

**What is derived from restricted content records SOURCE FOLDER IDS** and is
judged against the current grants when it is read:

* a conversation's use, per person (`conversation_restricted_folders`, migration 0111): the
  source folders a conversation drew on. Sharing allows a person who may read every recorded
  folder now. This replaces ADR-0086's per-socket confinement check and its `4412` close.

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
changes. Deep research and tasks from a conversation that recorded a restricted
folder stay refused for now, as do profile patches and filing outside the
recorded folders.

### Consequences

* Good, because "read but not edit" is expressible per role, including "everyone reads, a few
  edit" (`*` read plus a role with write), without a second collection.
* Good, because the rule is one pure function with a table of cases, and the database holds the
  shape (level CHECK, role CHECK, 1–20 entries by a deferred constraint trigger, RLS).
* Good, because a change of a folder's list takes effect for conversations derived from it at
  the next read, with no revocation job.
* Bad, because the 0110 down migration drops every access list: an older build knows no folder
  access, so every folder has to inherit again in the product first, or the documents filed in a
  `_r…` collection leave everybody's scope.
* Bad, because roles are looked up in WorkOS per person and organization at most once a minute;
  an outage falls back to the token's roles, which may be up to the token's lifetime stale.
* Bad, because a conversation that recorded a restricted folder still cannot commission deep
  research or a task, even after the folder is opened again, until that rule is revisited.
* Bad, because tombstones accumulate; nothing purges them yet.
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
  table and the columns removed) and re-apply; 0111's order CHECK, down and re-apply.
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
* `conversations/restricted-use.spec.ts` and `restricted-use.integration.spec.ts`: the lock
  with widening, loosen and tighten judged at read time.
* `auth/membership-roles.spec.ts`: the membership lookup, the 60 s key, the fallback.
* `features/documents/components/folder-access-dialog.spec.tsx` and the `/dev/folder-access`
  preview: the dialog and the „Nur lesen" marks.
* Nothing enforces that a NEW write path calls `requireFolderWrite`; review is the gate.

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
  the per-socket confinement check. ADR-0086's retrieval collection per restricted folder, its
  egress refusals, its memory rule and its IFC rule stand.
* User guide: [`sensitive-data-and-access.md`](../user-guides/sensitive-data-and-access.md#who-may-read-and-edit-a-folder).
* Where a later lifecycle feature would attach (participant notices, an organization setting for
  deleted-folder content, a download log): `setFolderAccess` after placement, the tombstone in
  `deleteProjectFolder`, `effectiveFolderLevel`, `resolveMembershipRoles` and
  `widenConversationAudience`.

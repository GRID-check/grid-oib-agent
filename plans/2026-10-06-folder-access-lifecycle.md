# Folder access: read/write per role, and what happens when access changes

Status: decided by the product owner, 6 Oct 2026 (decisions at the end). Builds on
ADR-0078; becomes ADR-0079.

## The rule everything else follows

**Store where content came from, never who may see it.** Every piece of
content that leaves a restricted folder (a chat answer, a memory note, a
report, a task, an inbox item) is tagged with the **folder ids** it was drawn
from. Who may see it is computed at the moment it is shown: *can this person
read every one of those folders now?* One function answers that
(`lib/authz/folder-access.ts`), from the person's current roles and the
folders' current grants.

Today's code stores the opposite in places: memory notes carry retrieval
**collection names** (a lifted restriction makes the note invisible to
everyone), and the restricted-turn mark records *that* a chat was restricted,
not *what from*. Both turn into folder-id tags, so that tightening a folder
closes its derived content and loosening it opens it again, with no rewrite
job and nothing to forget.

## The access model

| | |
|---|---|
| Levels | **Lesen**: see, open, download, search, use in answers. **Bearbeiten**: Lesen plus upload, new folder, rename, move, delete, new version, file drafts/reports into it. |
| Who | WorkOS roles (org roles and custom `org-` roles). No per-person grants. |
| Default | A folder inherits its parent; a root folder inherits the project (what the person's project role allows). |
| Own list | A folder with its own list grants only the listed roles, at the listed level. An empty own list is not allowed. |
| Nesting | Narrows only: the effective level is the lowest along the path. |
| Ceiling | The project role: a project viewer never writes, whatever a folder says. |
| Admins | Organization admins read and write everywhere. |
| Managing access | `project:manage`; every change is audited with before/after. |
| Search index | A folder whose readers are not all project members gets its own index (as today, keyed on Lesen). |

## Lifecycle: every change and what follows

Two columns matter for each change: what the person sees, and how fast.

| Change | What follows | How fast |
|---|---|---|
| **Someone gets a role** | They see the folders the role reads/writes, and every chat, note, report and task tagged only with folders they can now read. | Next request (see "Latency"). |
| **Someone loses a role** | Folders, documents, search hits and every derived item tagged with a folder they can no longer read disappear for them. A chat shared with them that used such a folder **stays in their list** under a neutral title; opening it shows „Dir fehlen inzwischen die Rechte, um diesen Chat zu sehen" and nothing of its content. The owner sees the same on the share. An open chat closes before the next turn. | ≤ 60 s (roles cached from the membership); an answer already streaming finishes. |
| **Someone leaves the project / organization** | Same as losing every role in it. Their private chats stay theirs but the project is gone from them. Content they created stays in the project. | Next request. |
| **Folder tightened** (role removed, Bearbeiten → Lesen, inherit → own list) | Readers who lost access lose the folder and all derived content tagged with it. If the set of readers changed, its documents move to the matching search index (purge first, then re-index; documents show "Wird gelesen" meanwhile). Chats already shared with people who now lack access: they lose the chat (rule above). | Visibility: immediately. Index move: minutes. |
| **Folder loosened** | New readers see the folder and the derived content, automatically. Index move as above. | Immediately / minutes. |
| **Folder moved** under another parent | Its effective access is recomputed from the new path (narrowing parents apply). Same consequences as tightened/loosened. Needs `project:manage` when the move changes who can read. | As above. |
| **Document moved** to another folder | The document gets the destination's access. Content derived **before** the move keeps its tag (the folder it was read from): a move never widens what was already said about it. | Immediately. |
| **Folder deleted** | Its documents go with it (existing delete pipeline). The folder itself is kept as a tombstone with its access rules, so chats, answers and notes drawn from it are **not touched**: by default the same people as before keep seeing them, with the notice „Dieser Ordner wurde inzwischen gelöscht". An organization setting lets an admin choose instead: everyone in the project, or admins only. | Immediately. |
| **Role deleted / renamed in WorkOS** | Rename: nothing (grants use the stable slug). Delete: the role's grants stop matching anyone; a folder whose own list now matches no existing role is readable by admins only and flagged in the project settings ("Ordner ohne gültige Rolle"). Deleting a role that folders use asks for confirmation and names the folders. | Immediately. |
| **Chat shared** | Allowed with people who can read every folder the chat drew on; the share dialog lists only them. Each later turn may draw only on folders everyone in the chat can read. | Immediately. |
| **Chat unshared** | The person loses the chat. Turns afterwards may again draw on folders only the owner can read. | Immediately. |
| **Downloads, exports, copies** | Cannot be taken back. Said plainly in the user guide. **Every download is logged** (who, which document and version, when, from which folder), and opens of documents in folders with their own list; admins see the log. | — |

## Latency: roles come from the login token today

`getGridSession()` reads roles from the WorkOS access token's claims, so a
role change in WorkOS reaches Piloti only when the token refreshes.

**Decided:** read roles for access decisions from the WorkOS organization
membership, cached for at most 60 seconds (Piloti already fetches the
membership). A revoked role stops working within a minute. No webhook: it
would need an endpoint, a signing secret and WorkOS configuration per
environment for a gain from ≤ 60 s to seconds, which the product owner did not
want to pay for.

## What changes in the code (phases)

1. **Core model** (in progress): grants + levels, the one effective-level
   function, write checks on every write path, migration from
   `restricted_roles` (each role → Bearbeiten), dialog with Lesen/Bearbeiten,
   "Nur lesen" UI.
2. **Folder-id tags** for derived content: chats (record of folders used),
   memory notes (replace collection names; migrate), runs/tasks/reports/inbox
   items; one `mayRead(person, folderIds)` used by every list and every item
   route.
3. **Lifecycle plumbing**: membership-based role lookup with a 60 s cache,
   per-turn re-check on open chats (exists; switch to the new tags),
   share-dialog filtering, the "no longer has the rights" chat state, folder
   tombstones and the organization setting for content from deleted folders,
   role-deletion guard.
4. **Runs and tasks inherit**: a run or task started from a chat carries the
   chat's folder tags and is shown only to people who can read them (instead
   of being refused).
5. **Download log** for every download, plus opens in folders with an own
   list; an admin view.

## Tests that prove it (each with a revert check)

- The effective-level function: a table of paths, roles and levels.
- For every change in the lifecycle table: before/after visibility of the
  folder, a document, a search hit, a chat, a memory note and a task, for a
  person who gains and a person who loses access (real Postgres).
- Every write path refuses a read-only person at the service.
- A revoked role stops reading once the 60 s role cache expires.
- Index move after tightening/loosening: no chunk of the folder is searchable
  under the old index once the move finishes.

## Decisions (product owner, 6 Oct 2026)

1. **Revocation:** no webhook; roles from the membership with a ≤ 60 s cache.
2. **Shared chat after losing access:** the chat stays in the person's list,
   shows that they no longer have the rights to view it, and shows none of
   its content.
3. **Deleted folders:** derived chats and answers are not touched; the folder
   is kept as a tombstone with its access, a notice says it was deleted, and
   an organization admin can choose to show such content to everyone in the
   project instead (or to admins only).
4. **Logging:** every download is logged, not only those from folders with
   an own list; opens are logged in folders with an own list.

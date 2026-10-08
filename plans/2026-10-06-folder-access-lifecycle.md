# Folder access: read/write per role, and what happens when access changes

> **Numbers as written.** This branch's migrations 0104–0111 are 0108–0114 since develop took 0104–0106 (#847), and its ADR-0079, 0080, 0081 are ADR-0085, 0086, 0087. Older numbers here (0106–0114) are those before the stack's collapse; [`database/schema.md`](../docs/database/schema.md) has the numbers as shipped.

Status: decided by the product owner, 6 Oct 2026 (decisions at the end). Builds on
ADR-0080; becomes ADR-0081.

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
| **Folder deleted** | Papierkorb for 14 days (hidden, not searchable, restorable with its access); then purged, leaving a tombstone with its access rules. Derived chats, answers and notes follow the organization's setting (default: unchanged for the same people, with „Quelle gelöscht am …"; „Mit dem Ordner entfernen" removes it with the purge). See "Deleting folders, retention and GDPR". | Hidden at once; purge after 14 days. |
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

## Deleting folders, retention and GDPR

How document systems built for enterprises (SharePoint, Google Drive, Box)
handle this, and how it maps onto what Piloti already has: the deletion
pipeline (soft delete, grace period, background purge, legal holds that block
the purge; `docs/architecture/deletion-pipeline.md`, ADR-0011), where folders
are still listed as out of scope.

**Deleting is the GDPR path; nobody sees a GDPR button.** Decided 6 Oct
2026: users never deal with the GDPR; Piloti simply complies. A deleted
folder goes to a **Papierkorb**: hidden and no longer searchable at once,
restorable with its access for 14 days (a config value, kept ≤ 23 days like
every grace period, so the purge finishes inside the GDPR's one month for an
Art. 17 request too). Then the purge removes the files, versions, previews,
search index entries and the observability traces, and keeps the folder as a
**tombstone** (id, name, access rules, who deleted it, when). What was derived
from it follows the organization's setting (below). The deletion record (what,
when, by whom; no content) is the proof, as today's `deletion_queue` row is.
An earlier draft had a separate „Endgültig löschen (DSGVO)" action; the
product owner dropped it as over-designed.

**What blocks deletion.** A legal hold on the folder, on a document in it, on
the project or the organization blocks the purge and the erasure (it already
does for documents and projects; folders join the same check,
`grid_legal_hold_blocks`). Later phase: a **retention period** per folder
(„aufbewahren bis", e.g. 7 years for bookkeeping under BAO § 132): deleting
before it ends is refused.

**Content derived from a deleted folder: an organization setting**,
Organisation → Sensible Daten → „Inhalte aus gelöschten Ordnern":

- **Unverändert sichtbar** (default): the same people who could read the
  folder keep seeing chats, answers and notes drawn from it, with the notice
  „Quelle gelöscht am …".
- **Für alle im Projekt sichtbar**, with the same notice.
- **Nur für Admins**.
- **Mit dem Ordner entfernen**: the purge also removes what was derived: notes
  drawn from it are deleted, and answers that drew on it read „Inhalt entfernt:
  Quelle gelöscht".

Whatever the setting, keeping derived personal data longer than its source is
the organization's decision and its responsibility under GDPR's storage
limitation (Art. 5(1)(e)). The setting's help text says what each option
keeps, in plain words, without naming the regulation.

**The download log is personal data about staff.** It records who downloaded
which document and version, when, from which folder (and who opened documents
in folders with their own access list). Purpose: security and accountability,
nothing else (no activity statistics). Kept 12 months, then purged by the
scheduler; visible to organization admins only, and reading it is itself
logged. In Austria and Germany such a record can need the works council's
agreement (§ 96 ArbVG, § 87 Abs. 1 Nr. 6 BetrVG); the user guide and the
DPA template say so, and an organization can shorten the retention.

**Outside the application.**

- **Backups** keep purged data until they rotate out. A restore must re-apply
  the deletion record (the purged `deletion_queue` rows) before the system is
  used again; that step belongs in the restore runbook. The rotation window
  goes into the DPA.
- **Model providers** keep nothing (zero data retention, ADR-0074).
- **Langfuse traces keep prompts and answers forever** (ADR-0044: no retention
  in the free build; the purge does not reach them). This is an existing gap,
  not new: a deleted chat's content, including restricted folder content,
  stays in the trace store. What Langfuse offers natively (checked 6 Oct 2026):
  - **Deleting traces** (`DELETE /api/public/traces`, batches of up to 1,000
    ids) is in every edition, self-hosted included. Our traces carry the
    conversation id as `langfuse.session.id`, so **erasing a conversation
    deletes its traces** through that API: one purge step, nothing new to run.
    Langfuse notes that deleting a trace does not remove copies saved into
    datasets; Piloti creates none.
  - **Automatic retention** (per project, minimum 3 days, nightly purge) is an
    Enterprise Edition feature when self-hosted. **Decided:** no licence; a
    scheduler job deletes traces older than 30 days in batches through the same
    native delete API (the approach of the community tool `langfuse_cleaner`).
    If Piloti ever buys Enterprise, the job is replaced by the setting.
- **Masked chat text** never reaches the traces (ADR-0079's chat screening
  masks before the agent).

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
   list; an admin view; 12-month retention. **Built**: see
   [`docs/user-guides/download-log.md`](../docs/user-guides/download-log.md).
   A failed record refuses the hand-over under a folder with its own list
   (there the log is the control) and only warns elsewhere.
6. **Deletion**: folders join the deletion pipeline (Papierkorb, purge,
   tombstone, legal hold), the organization setting for derived content,
   Langfuse trace retention and erasure.
7. **Retention periods** per folder (later).

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

0. **Papierkorb** keeps deleted folders restorable for 14 days. **Retention
   periods** per folder: not now. **Langfuse**: per-conversation erasure and a
   30-day retention job, both through Langfuse's native delete API; no
   Enterprise licence.


1. **Revocation:** no webhook; roles from the membership with a ≤ 60 s cache.
2. **Shared chat after losing access:** the chat stays in the person's list,
   shows that they no longer have the rights to view it, and shows none of
   its content.
3. **Deleted folders:** derived chats and answers are not touched; the folder
   is kept as a tombstone with its access, a notice says it was deleted, and
   an organization admin can choose to show such content to everyone in the
   project instead (or to admins only). Refined by "Deleting folders,
   retention and GDPR" above (Papierkorb, a fourth setting).
5. **GDPR:** no separate erasure action and no GDPR wording users see; the
   ordinary deletion pipeline is what complies.
4. **Logging:** every download is logged, not only those from folders with
   an own list; opens are logged in folders with an own list.

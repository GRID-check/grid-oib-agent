# Upload & filing tickets: re-triage, 2026-10-06

> **Migration numbers are those at `8bb2200d3`.** Before it merged, the branch folded its
> intermediate 0106 (`restricted_roles`), 0107 (`conversation_restricted_turns`) and 0108
> (`restricted_collections`) into the final designs and renumbered: 0110→0106, 0109→0107,
> 0111→0108, 0112→0109, 0113→0110. [`database/schema.md`](../database/schema.md) has the
> numbers as shipped.
>
> Since then develop took migrations 0104–0106 and ADR-0079–0082 (#847), so these numbers moved again: migrations 0104→0107, 0105→0108, 0106→0109, 0107→0110, 0108→0111, 0109→0112, 0110→0113; ADR-0079→0083, ADR-0080→0084, ADR-0081→0085.

Six product tickets („Abgeschlossene Projekte mit Eckdaten", „Büroablage",
„Bibliothek", „Projekt aktualisieren und Versionen vergleichen", „Eigene
Richtlinien und Fachliteratur", „Zurück zur Originaldatei") were checked again,
this time against `8bb2200d3`. That is branch
`claude/nvidia-toolkit-data-validation-rbnyi6`, which contains `origin/develop`
up to `78b2aff9e`. The first triage
([`upload-and-filing-triage-2026-10.md`](upload-and-filing-triage-2026-10.md))
was written on 1 Oct against `f62552a`. Since then develop has shipped #848
(Archiv folders and the full Dateien browser) and #844 (a rescan of failed
ingestions). This branch has added folder access per role, upload screening,
upload batches and a download log. Ticket 9 stays out of scope.

**Tags.** *[V]* was read in the code, and the citation is a `file:line` from
`8bb2200d3` (paths under `frontends/ui/src/` unless they say otherwise), or a
URL for an external fact. *[I]* is an inference: check it before a decision
rests on it. Sizes are S / M / L / XL of engineering effort.

**How each ticket is laid out.** First a table with one row per checkbox:
what exists today, what is missing, and whether the checkbox can be met as
written. Then the blockers and interactions the ticket does not mention, then
questions for the product owner (each answerable in one line, each with a
recommended default), then a sliced plan.

---

## What changed since 1 Oct, and where the first triage is now wrong

| First triage said | Now | Tag |
|---|---|---|
| Büroablage: „No folders: `project_folders.project_id` is NOT NULL and `documents_folder_requires_project` is a CHECK" | **Stale.** #848 (migration 0102, ADR-0078) made folders a property of a shelf. `project_id` is nullable, tied to `scope` by `project_folders_scope_owner_check` (`lib/db/schema/project-folders.ts:112`). The CHECK now admits an Archiv row (`lib/db/schema/documents.ts:517-521`). The Archiv has nested folders, folder upload, filters, archived documents and `?folder=`/`?doc=` URLs. | [V] |
| Büroablage: „No way to move a document between a project and the Archiv" | Still true, and now enforced by the schema: a composite FK keeps a document's folder on its own shelf (`documents.ts`, `documents_folder_id_organization_id_scope_fkey`). Test: `lib/documents/shelf-folders.integration.spec.ts:189` „files an Archiv document, refuses a project document there". | [V] |
| Ticket 6 „restricted to roles", ADR-0080, migration 0106 | **Superseded.** Access is now read/write per role, nesting only narrows (ADR-0081; migrations 0109–0111). The rule is one pure function, `effectiveFolderLevel` (`lib/authz/folder-access-rule.ts:90`). Conversations and memory are judged against the folders' current access when read. | [V] |
| (not covered) | **Folder access does not reach the Archiv.** `requireShelfRead` returns for the Archiv without a check (`lib/documents/shelf-authz.ts:27-28`). `setFolderAccess` takes a `projectId` (`lib/projects/folder-access-settings.ts:142-151`). The Archiv is one collection per organization (`lib/archiv/collection.ts:12`). Every member reads every Archiv folder. | [V] |
| Ticket 4's decision record is „ADR-0079 (migration 0105)" | Upload batches are migration 0105. `docs/database/schema.md:703` files them under ADR-0079, but the ADR's text never mentions batches. Screening is ADR-0079 (0104). The download log is migration 0112. | [V] |
| Ticket 7 defect: `readVersionContent` decodes every version as UTF-8 | **Still present**: `lib/documents/version-content.ts:387`, `features/documents/components/document-version-list.tsx:266-270`. A test pins the link: `document-lifecycle-panel.spec.tsx:393-408`. | [V] |
| Ticket 10 defect: „Aktualisiert" renders `createdAt` | **Still present**: `features/documents/components/file-preview-pane.tsx:1286-1292`. The first triage's fix („show the latest version's date") is right; `updatedAt` would be wrong (see ticket 10). | [V] |
| Ticket 3: „One Chroma collection per project (ADR-0072)" | ADR-0072 picked LlamaIndex over ChromaDB. The collection per project comes from `computeCollectionScope` (`lib/collection-scope.ts:90-92`, `proj_<id>`), and retrieval is one call per collection (`sources/knowledge_layer/src/llamaindex/adapter.py:5588-5601`). The conclusion stands; the citation was wrong. | [V] |
| Ticket 8: „ÖNORM licensing" as an open product question | Researched (ticket 8 below): an ÖNORM that every member can open needs a multi-user licence. | [V] web |
| Ticket 9: storage-tier findings | Dropped by the product owner's decision. | — |
| (new on develop) #844 rescan of failed ingestions | `reingestFailedOrgDocuments` (`lib/documents/service.ts:1600`). It re-dispatches failed rows under their own ids, so citations and assignments keep working. No spec references it, and its docstring is pasted twice (`service.ts:1533-1550`, `1551-1599`). It affects none of these tickets except as the index rebuild a reopened or un-archived file would need. | [V] |

---

## Two things that cut across every ticket

### Three names for one shelf, and the tickets add a fourth meaning

The shelf `scope = 'archiv'` is called „Archiv" in the navigation
(`i18n/dictionaries/de/nav.ts:26`, `de/archiv.ts:3`). Chips and prompts call it
„Büroarchiv" (`src/aiq_agent/common/norm_registry.py:1264-1265`,
`de/archiv.ts:29`, `src/aiq_agent/agents/piloti/prompts/piloti_static.md:299`).
The comments in the batch and quarantine code already call it „Büroablage"
(`lib/upload-batches/service.ts:55`, `app/api/upload-batches/route.ts:37`).
Documents also have a separate „Archivieren" action, which purges a file's
index entries (`lib/documents/version-content.ts:552-599`). [V]

Ticket 3 says „das bisherige Archiv wird zur Bibliothek" and also that the
Bibliothek is „kein eigener Ablageort, sondern eine Ansicht". Those two
statements conflict, because today's Archiv *is* a place to file documents.
The reading consistent with the context paragraph: **today's Archiv shelf
becomes the Büroablage** (ticket 2), and the **Bibliothek is a new search
page** across projects (ticket 3). Every slice below assumes that reading.
Question Q-0 asks the product owner to confirm it.

### What folder access per role gives each ticket

The rule is one pure function. A folder either inherits its parent's access or
has its own list of role grants (`read` or `write`, or `*` for everyone who
can open the project). A person's level on a folder is the lowest level over
the folder and its ancestors that have their own lists
(`lib/authz/folder-access-rule.ts:62-70, 90-113`; 24-row table test in
`lib/authz/folder-access.spec.ts`). Roles are **organization** roles held in
WorkOS, not project roles, so a grant means the same thing in every project.
[V]

| Ticket | What it inherits, and what it must do |
|---|---|
| 1 Abgeschlossen | Grants survive closing unchanged. Read-only on close must go through the same write ceiling every write path already asks (`requireFolderWrite` → `requireProjectAccess`, `lib/authz/folder-access.ts:201-215`). |
| 2 Büroablage | Nothing: the Archiv cannot be restricted (above). Nothing in the database stops `access_mode = 'custom'` on an Archiv folder row either (`drizzle/0110_project_folder_grants.sql` has no scope check). That would *look* restricted and be open. |
| 3 Bibliothek | „Geschützte Dateien nur für Berechtigte" must call `getProjectFolderAccess` per project (`folder-access.ts:97-106`) and use `hiddenFolderIds` plus `clearedRestrictedCollections`, exactly as `searchProjectDocuments` already does (`lib/documents/service.ts:758-774`; test `service.spec.ts:2948`). No second rule. |
| 7 Versionen | Opening and comparing versions already goes through `getAccessibleDocument` (`version-content.ts:393-401`), and each side is logged in the download log (`version-content.ts:404-417`). The new „nicht mehr im Ordner" check must not judge documents in folders hidden from the uploader. |
| 8 Richtlinien | Office norms live in the Büroablage, so every member reads them. A licence held for named users only cannot be modelled. |
| 10 Originaldatei | The path is shown only to people who can read the document. Upload screening already screens the path (`features/documents/lib/folder-upload-plan.ts:253-263`). |

---

## 1. Abgeschlossene Projekte mit Eckdaten — L overall, first slice S–M

| Checkbox | Today | Missing | Can it be met as written? |
|---|---|---|---|
| Jede Datei ist eindeutig einem abgeschlossenen Projekt zugeordnet, und das ist überall sichtbar, wo die Datei auftaucht | [V] A project document has exactly one `project_id` (`lib/db/schema/documents.ts:97`, cascade). Archiv documents have none (`lib/documents/shelf.ts`, `documentShelf`). [V] Nothing tells an active project from a closed one: `projects` has `deletedAt` and no status (`lib/db/schema/projects.ts:7-23`). [V] Outside a project, a file shows its project in the download log (`lib/download-log/service.ts:174-175, 283-284`); most other surfaces are inside one project, where the project is implicit. | A status; a project-and-status chip on every surface that lists files from more than one project (the Bibliothek, the download log). A way to give today's Archiv files a project: no move between shelves exists (`shelf-folders.integration.spec.ts:189`). | **Yes** for files uploaded into a project. **Only after a move tool** for what was „dumped" in today's Archiv. The ticket's own context names exactly that content as the problem. |
| Steckbrief mit Adresse, Zeitraum und allen Personen, auch ohne Piloti-Konto | [V] Address is the profile fact `standort_adresse` (`lib/project-profile/intake-definition.ts:197-205`). Phase is `projektphase` (`:259-276`). Both are rendered by `buildProjectBriefView` (`lib/project-profile/brief-view.ts:92`; test `brief-view.test.ts:45`). The UI calls it „Projekt-Briefing" (`de/projects.ts:366`); „Steckbrief" appears nowhere. [V] There is no date or period field. [V] People are the WorkOS org roster annotated with project roles (`lib/projects/members-service.ts:118-160`). Someone who left the org resolves to their raw user id (`lib/sharing/directory.ts:97-100`). | Period (start and end). A people list with name, function and company that does not need an account. | **Yes.** Keep people out of the profile JSON, though: the profile feeds the prompt view on every turn (`lib/project-profile/prompt-view.ts:4, 225`), so names of former staff would go to the model on every turn. |
| Ein aktives Projekt lässt sich als abgeschlossen markieren und behält seine Eckdaten. Noch zu klären: „Ausmisten" | [V] The only lifecycle is soft delete then purge (`lib/projects/service.ts:233-279`, `lib/projects/repository.ts:188-212`). [V] Legal holds exist and block a purge (`lib/db/schema/legal-holds.ts`). | Status column, close and reopen, read-only enforcement, a list filter. A definition of „Ausmisten". | **Marking and keeping: yes.** „Ausmisten" is undefined, so it cannot be built as written. Q-1.5 proposes a definition. |

**Blockers and interactions the ticket does not mention**

- [V] **Closing must not purge.** The document „Archivieren" removes a file
  from search (`version-content.ts:552-599`; test
  `version-content.spec.ts:580` „an archived document stops answering").
  „Ausmisten" built on it would make closed projects unsearchable and break
  ticket 3. Deletion cascades to documents (`documents.ts:97`), so closing
  must never reuse it either.
- [V] **Read-only needs one seam.** Every project permission check loads the
  project row (`lib/authz/projects.ts:69-77`), and `requireFolderWrite` calls
  it first (`folder-access.ts:206`). Refusing write permissions there when the
  project is closed covers every document write path at once. The check must
  run **before** the org-admin bypass (`projects.ts:92`), or admins would keep
  writing. [I] Agent routes that act with a service token need an audit for
  paths that skip `requireProjectAccess`; `app/api/authz-coverage.spec.ts` is
  the place to pin it.
- [V] **Who sees a closed project decides whether ticket 3 has any value.**
  Project visibility is per-project WorkOS FGA. `listProjects` checks
  `project:view` once per project, and only `org:projects:administer` bypasses
  that (`lib/projects/service.ts:70-93`; tests `service.spec.ts:78, 98, 113`).
  Staff who left are gone from the org; staff who joined later were never
  members. Without a decision, most people's Bibliothek over closed projects
  is empty.
- [V] If closing opens a project to every member, folders granted to `*`
  open with it, because `*` matches anyone who can open the project
  (`folder-access-rule.ts:66`). Folders with their own role lists stay
  restricted.
- [V] **Archiv folders on develop.** Since #848 an office can keep a closed
  project as an Archiv folder. „Archiv-Ordner als abgeschlossenes Projekt
  anlegen" is the migration gesture this ticket needs. Tags are stored keyed
  by `(collection, filename)` (`src/aiq_agent/knowledge/factory.py:508-534`),
  so a cross-shelf move must carry them.
- **GDPR.** [V] The office decided that deleting is the GDPR path, with no
  separate „DSGVO" button (`plans/2026-10-06-folder-access-lifecycle.md:76-87`).
  [I] Names of former staff and externals are personal data collected from
  someone other than the person. Plausible basis: legitimate interest,
  Art. 6(1)(f); storage limitation, Art. 5(1)(e); information duty under
  Art. 14 with the disproportionate-effort exception in Art. 14(5)(b) (GDPR,
  https://eur-lex.europa.eu/eli/reg/2016/679/oj). Therefore: a person row must
  be deletable, carry as few fields as possible, and stay out of the prompt.
- **AI Act.** [I] Nothing new: no generated output is involved.

**Open product questions**

| # | Question | Recommended default |
|---|---|---|
| 1.1 | Who sees a closed project: its former members only, or every office member? | Every member may read it. Folders with their own lists stay restricted. |
| 1.2 | Is a closed project read-only? | Yes for files, folders, the Steckbrief's profile and memory. Chat stays allowed; deep research and tasks do not. |
| 1.3 | Can it be reopened, and by whom? | Yes, by whoever holds `project:manage`; audited. |
| 1.4 | Who may close a project? | `project:manage`. |
| 1.5 | „Ausmisten" means? | A checklist shown at close, nothing automatic: archived documents, drafts never published, old superseded versions, chats. Each is offered for deletion; nothing is removed without confirmation. |
| 1.6 | „Zeitraum": which dates? | Beginn and Abschluss, month precision; closing pre-fills Abschluss. |
| 1.7 | Fields per person? | Name, Funktion, Firma, von–bis, optional link to a Piloti account. No e-mail or phone. |
| 1.8 | Sort today's Archiv content into closed projects? | Yes, through „Archiv-Ordner als abgeschlossenes Projekt anlegen" (slice 1c). |

**Slices**

| Slice | Size | Touches | Migration | Risks | Proven by |
|---|---|---|---|---|---|
| 1a Status, close and reopen, read-only | S–M | `lib/db/schema/projects.ts`, `lib/projects/{service,repository}.ts`, `lib/authz/projects.ts` (closed check before the bypass), new `app/api/projects/[id]/status/route.ts`, projects grid (filter „Aktiv / Abgeschlossen" and a chip), `de`/`en` `projects.ts`, `docs/database/schema.md`, `docs/api/bff-routes.md`, release note | `0113_project_status`: `status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed'))`, `closed_at`, `closed_by`, `CHECK ((status = 'closed') = (closed_at IS NOT NULL))` | A write path that does not ask `requireProjectAccess`; Q-1.2 undecided | `scripts/rls-test-db.sh` (constraints and down migration); `authz/projects.spec.ts`: closed refuses `project:documents:write` for an editor and an org admin, allows `project:view`; `folder-service.access-change.spec.ts`: a folder write in a closed project → 404; `service.spec.ts`: close and reopen audited; grid filter test |
| 1b Steckbrief: period and people | M | `projects` period columns; new `lib/db/schema/project-people.ts`; a service and route; a section on the project overview beside `features/projects/components/project-brief.tsx` | `0114_project_people`: table with composite FK to `projects(id, organization_id)`, RLS, `CHECK (ended_on IS NULL OR ended_on >= started_on)` | Personal data | RLS integration spec (tenant); `prompt-view.spec.ts` asserts no person name reaches the prompt view; deleting a person removes the row |
| 1c Archiv → project move, and an Archiv folder → a closed project | L | New cross-shelf move beside `lib/documents/move-to-folder.ts`; re-ingest into the project collection (purge first, as placement does); carry tags; resolve filename collisions per collection | None for the row (scope, project_id, collection change); an ADR amending ADR-0078 | Chats that cited the old collection; filename collisions | Integration: a moved document leaves the Archiv collection before entering the project's; tags kept; a collision refused with a typed error |
| 1d „Ausmisten" checklist | S | Close dialog | None | Q-1.5 | Component spec |

---

## 2. Büroablage — S to rename, L to make it restrictable

| Checkbox | Today | Missing | Can it be met as written? |
|---|---|---|---|
| Klar getrennt von den Projekten | [V] Own shelf (`scope = 'archiv'`), own page `/app/archiv`, own collection `archiv_<org>` (`lib/archiv/collection.ts:12`). The schema refuses project documents in its folders (`shelf-folders.integration.spec.ts:189`). It has folders since #848 (`lib/archiv/folder-service.ts`; specs `app/api/archiv/folders/route.spec.ts`, `shelf-folders.integration.spec.ts:108-224`). Behind the `organization-archiv` flag (`lib/authz/feature-flags.ts:71-77`). | Its name (see „Three names"). | **Yes**: built, apart from the label. |
| Inhalte in Suche und Antworten verfügbar | [V] The Archiv collection is in every scope, project or not (`lib/collection-scope.ts:83-87`, `lib/collection-scope-request.ts:268, 279`). Semantic search: `/api/archiv/documents/search` (`features/documents/lib/file-shelf.ts:139-141`). Citations render as lane `buero` (`norm_registry.py:1264-1265`; test `tests/aiq_agent/common/test_norm_registry.py:407`). | Nothing. | **Yes**: built. |

**Blockers and interactions**

- [V] **No per-role access** (see the cross-cutting section). Personnel
  templates or fee calculations filed here are readable by every member and
  reach every project's chat. Until slice 2d, such files belong in a project.
- [V] **A missing guard, worth closing now.** Nothing in the database stops
  `access_mode = 'custom'` on an Archiv folder (`drizzle/0110_project_folder_grants.sql:33-38, 103-108`
  check only the value and the audit columns). Nothing reads it there either,
  so a future write would produce a folder that shows a lock and is open.
  Ratchet: `CHECK (scope = 'project' OR access_mode = 'inherit')`.
- [V] **No „Archivieren" and no version history in the Büroablage.** The
  lifecycle panel renders only for project documents
  (`file-preview-pane.tsx:1406-1410`). Ticket 8's „veraltet" and ticket 7's
  versions both need it here.
- [V] Upload screening and batches already cover it
  (`app/api/upload-batches/route.ts:37`;
  `app/api/documents/[id]/quarantine/release/route.ts:17`).
- **Renaming touches the prompt.** „Büroarchiv" is a shelf name in
  `piloti_static.md:60-63, 299-304` and a lane label. AGENTS.md requires
  `task be:eval:answer-suite` before and after a prompt change.
- **Licence.** Norms filed here are open to every member; see ticket 8.

**Open product questions**

| # | Question | Recommended default |
|---|---|---|
| Q-0 | Is the Büroablage today's Archiv under a new name, and the Bibliothek a new search page? | Yes. The code keeps `scope = 'archiv'`; only the copy changes. |
| 2.1 | Must some Büroablage folders be restricted to roles? | Not in this ticket. Such files stay in a project until slice 2d. |
| 2.2 | Does the Büroablage stay in every project's chat? | Yes, as today. |

**Slices**

| Slice | Size | Touches | Migration | Risks | Proven by |
|---|---|---|---|---|---|
| 2a Rename to „Büroablage" | S | `de`/`en` `nav.ts`, `archiv.ts`; lane label in `norm_registry.py` and the `buero` kind label in `src/aiq_agent/common/source_kinds.py`, plus its mirror `features/chat/lib/source-kinds.ts`; `piloti_static.md`; `docs/user-guides/documents.md`; release note | None | Model behaviour on a renamed shelf | `tests/aiq_agent/common/test_source_kinds.py`, the TS parity spec, the answer suite before and after |
| 2b Guard: Archiv folders cannot carry their own list | S | Schema comment in `project-folders.ts` | `CHECK (scope = 'project' OR access_mode = 'inherit')` | None | `scripts/rls-test-db.sh` asserts an Archiv folder refuses `custom` |
| 2c „Archivieren" and versions in the Büroablage pane | S–M | `file-preview-pane.tsx:1410` condition; permissions from `canManageArchiv`; `archiveDocument` already handles an Archiv document (`version-content.ts:557-563`) | None | Review controls that make no sense without a project | Pane spec for the Archiv; `version-content.spec.ts` for an Archiv document |
| 2d Folders restricted per role in the Büroablage | L | Per-folder collections `archiv_<org>_r<hex>`; an Archiv tree for `effectiveFolderLevel`; scope injection; `lib/conversations/restricted-use.ts` (today per project) | Grants keyed to Archiv folders | Restricted-use admission across shelves | ADR amending ADR-0078/0081; the ADR-0081 test set rerun for the Archiv |

---

## 3. Bibliothek — XL overall; first slice L

| Checkbox | Today | Missing | Can it be met as written? |
|---|---|---|---|
| Suche nach Kategorien und Themen über alle aktiven und abgeschlossenen Projekte | [V] Search is per project: semantic (`lib/documents/service.ts:747-776`) and a substring plus tag filter over the loaded page (`features/documents/lib/file-filters.ts:117-161`). Listing requires a `projectId` (`app/api/documents/route.ts:13`). Tags are fetched per collection from `/v1/collections/{name}/documents` (`lib/documents/reconcile-status.ts:291-293`). The vocabulary is closed: 12 document types and 6 OIB disciplines (`src/aiq_agent/knowledge/document_classification.py:55-80`), chosen by an LLM, fail-open (`:15-16`). | Everything cross-project. | **Yes** for „Kategorien" (the 12 types) and the 6 disciplines. Free topics such as „Dach" need semantic search. |
| Jeder Treffer zeigt Projekt und Status | [V] No project status exists. | Ticket 1a. | **After 1a.** |
| Filter, z. B. nur abgeschlossene oder ein Zeitraum | [V] Neither status nor period exists. | 1a, 1b. | **After 1a and 1b.** |
| Vom Treffer direkt zum Steckbrief | [V] The brief panel exists (`features/projects/components/project-brief.tsx`). | A link target. | **Yes.** |
| Geschützte Dateien nur für Berechtigte | [V] The project-level check is `listProjects` (`lib/projects/service.ts:70-93`). The folder-level check is `getProjectFolderAccess` (`folder-access.ts:97-106`), used by the per-project search (`service.ts:758-774`; test `service.spec.ts:2948`). | Applying both per project. | **Yes, by reusing the existing rule**, as long as no second rule is written. |
| Example: „alle Dachdetails von Holzbauten" | [V] „Detail" is a tag (`document_classification.py:62`), stored in the knowledge layer's metadata store keyed `(collection, filename)`. „Holzbau" is a profile fact `bauweise` (`intake-definition.ts:715-727`), asked only when the structure type `C1` is a building (`:645`) and optional. „Dach" is in neither vocabulary. | A join of the two stores plus semantic ranking. | **Approximately.** Recall depends on how complete the profiles are and how accurate the tagger is. Say so on the page. |

**Blockers and interactions**

- [V] **Cost grows with the number of projects.** N FGA checks
  (`service.ts:80-91`), N tag listings (one per collection), N semantic
  queries plus each project's restricted collections (`adapter.py:5588-5601`).
  [I] Fine for tens of projects; hundreds need the tags mirrored into Postgres
  (slice 3c).
- [V] **Ticket 1's Q-1.1** decides whether the Bibliothek shows anything
  beyond a person's own projects.
- [V] **Agent answers across projects are a different problem.** Restricted
  collections are resolved for one project per turn
  (`collection-scope-request.ts:255-263`). The admission record is per
  conversation and project (`lib/conversations/restricted-use.ts`; ADR-0081).
  A human search list needs only the BFF's `hiddenFolderIds`
  (`service.ts:769-774`). Keep the Bibliothek a search page; „Frag die
  Bibliothek" is a later ADR.
- [V] Opening a hit is logged by the existing download-log writer
  (`recordDocumentAccess`, called by every function that hands out a file's
  bytes; held to that list by `lib/download-log/coverage.spec.ts`).
- **GDPR.** [I] Opening closed projects to every member widens who sees the
  personal data in old files. Restricted folders are the tool for that, and
  the close dialog should say so.
- **AI Act.** [I] A ranked hit list is not generated content, so the
  Art. 50(2) marking duty does not apply. It would apply to an answer over the
  Bibliothek (https://eur-lex.europa.eu/eli/reg/2024/1689/oj).

**Open product questions**

| # | Question | Recommended default |
|---|---|---|
| Q-0 | (above) Is the Bibliothek a new page rather than the renamed Archiv? | Yes. |
| 3.1 | Does the Bibliothek include Büroablage hits? | Yes, labelled „Büroablage", without a status. |
| 3.2 | Does it show only projects the reader can open? | Yes, the project grid's rule, widened by the answer to Q-1.1. |
| 3.3 | Categories: the fixed 12 types and 6 disciplines, or office-defined ones? | Fixed for now. |
| 3.4 | A chat over the Bibliothek in this ticket? | No. |

**Slices**

| Slice | Size | Touches | Migration | Risks | Proven by |
|---|---|---|---|---|---|
| 3a Metadata library | L | New `GET /api/library` (type, discipline, status, period, name): reachable projects via `listProjects`; per project, `getProjectFolderAccess` and rows filtered by `hiddenFolderIds`; tags per collection, cached; page `/app/bibliothek`, hit row with project chip, status and Steckbrief link | None (needs 1a, 1b) | Latency with N calls; cap and page | `authz-coverage.spec.ts`; a document in a hidden folder never returned (unit and Postgres integration); a project without `project:view` not listed; status and period filters |
| 3b Semantic search across projects | M | Generalise `searchProjectDocuments` to a list of projects, reusing `fetchSemanticHits` and one merged ranking | None | Merging scores across collections | The `service.spec.ts:2948` case generalised to two projects with different clearances |
| 3c Tags in Postgres | M | Mirror tags into the app database when ingestion settles | `documents.tags text[]` and a GIN index | Two copies of tags drifting | Settlement test; a backfill script |
| 3d Agent answers over the Bibliothek | XL | Restricted use across projects; scope size | — | Leak paths | ADR first |

---

## 7. Projekt aktualisieren und Versionen vergleichen — M to fix and finish; L–XL for plans

| Checkbox | Today | Missing | Can it be met as written? |
|---|---|---|---|
| Dateien, die im Ordner nicht mehr da sind, werden markiert, nicht gelöscht | [V] The re-upload planner classifies only the dropped files: `new`, `update`, `unchanged`, `collision`, `duplicate` (`features/documents/lib/folder-upload-plan.ts:66-91`; tests `folder-upload-plan.spec.ts:129-519`). Nothing is deleted (`filesToUpload`, `:600-606`). The plan's documents come from a name probe for the dropped names only (`:233-238`), so it cannot see absent files. `origin_path` is written once and not rewritten on replacement (`documents.ts:283-298`; `shelf-upload.ts:263-277` vs `:297`). | A server query for the documents whose origin path starts with the dropped root; a `missing` outcome; a stored mark. | **Yes, within limits:** only for files that came in by folder upload (others have no origin path), only when the same root is dropped again, and never for documents in folders hidden from the uploader. |
| Ältere Fassungen öffnen und vollständig ansehen | [V] Every upload records a version and keeps the previous bytes (`shelf-upload.ts:263-277`, `lib/documents/lifecycle.ts:1192`). Each version stores its own `content_type` (`lib/db/schema/document-versions.ts:117`). Office renditions are kept per version (ADR-0070). **Defect:** the „Öffnen" link of any unpublished version goes to the text route (`document-version-list.tsx:266-270`), which decodes the bytes as UTF-8 (`version-content.ts:387`) and serves `text/plain`. A test pins the link (`document-lifecycle-panel.spec.tsx:393-408`). [I] An older PDF or plan shows as binary noise. The history exists only for project documents (`file-preview-pane.tsx:1410`). | A route that serves a version's real content type; history in the Büroablage (2c). | **Yes**: S. |
| Zwei Fassungen vergleichen: inhaltliche Änderungen, Maße, Auflagen | [V] Comparison is a line diff of two texts (jsdiff; `document-version-list.tsx:5-18`), written for Markdown. A superseded version's index entries, and with them its extracted text, are purged (`lifecycle.ts:448, 558-562`). `pdfjs-dist` is in the browser bundle (`frontends/ui/package.json:100`); `pdfplumber` and `pypdfium2` are in the knowledge layer (`sources/knowledge_layer/pyproject.toml:33-34`). | Text extracted from the old bytes; a word diff. | **Content: yes** for PDFs with a text layer and for DOCX. **„Maße": not reliably.** [I] CAD exports often turn text into vector outlines, and scans have no text. **„Auflagen"**: a text diff of two Bescheide shows them. A summary of „which Auflagen changed" is model output and needs labelling (AI Act Art. 50(2); `lib/ai-provenance.ts` already marks Piloti-written files). |
| Bei Plänen Änderungen im Plan farbig markiert | [V] None. | Rendering, alignment, colour overlay. | **Yes as an overlay**, the way Bluebeam does it (old red, new green, unchanged dark; https://support.bluebeam.com/user-manual/menus/document/overlay-pages.html), provided both sheets share size and scale. A moved title block or a shifted sheet produces noise or needs alignment points. [I] A diff of vector drawing operators is unreliable: exporters reorder and split paths. |
| Suche und Antworten nutzen nur die aktuelle Fassung | [V] Publishing purges the superseded version's passages before the new bytes are sent (`lifecycle.ts:448`; test `lifecycle.spec.ts:864`). | Nothing. | **Yes**: built. Q-7.1 decides whether a file marked „nicht mehr im Ordner" still answers. |

**Blockers and interactions**

- **Folder access.** [V] Replacing a file in a read-only folder is refused
  (commit `5b9aaa775`; `requireFolderWrite`). The missing check must skip
  `getHiddenFolderIds` (`folder-access.ts:111-116`). [V] A comparison logs
  two download-log entries (`version-content.ts:404-417`); that is correct,
  and the log's admins should know it.
- [V] **Archiv folder upload (#848)** uses the same planner through the shared
  `FileWorkspace`, so the `missing` outcome must work on both shelves.
- [V] **Storage**: every version is kept and counted
  (`lib/storage/repository.ts:189`, `versionOverheadBytes`); there is no
  version retention. Mentioned only because ticket 1's „Ausmisten" touches it.
- **GDPR.** [I] Older versions keep personal data until the document is
  deleted; a single version cannot be erased on its own. That belongs on the
  folder-lifecycle plan, not here.
- [I] **Closed projects (ticket 1).** A re-upload into a closed project is
  refused if Q-1.2 makes it read-only.
- [V] Do not add `missing` as a `lifecycle` value: the schema explains that a
  third value would silently hide documents (`documents.ts:383-392`). Use its
  own column.

**Open product questions**

| # | Question | Recommended default |
|---|---|---|
| 7.1 | Does a file missing from the re-dropped folder still answer questions? | Yes, marked „Nicht mehr im Büroordner", with a one-click „Archivieren". |
| 7.2 | Does the mark clear when the file comes back in a later drop? | Yes. |
| 7.3 | Is a colour overlay of the PDF sheets enough for plans (no automatic dimension reading)? | Yes. |
| 7.4 | „Auflagen": a text diff, or a Piloti summary of changed Auflagen? | Text diff now; the summary later as a labelled chat action. |
| 7.5 | Version history in the Büroablage too? | Yes (slice 2c). |

**Slices**

| Slice | Size | Touches | Migration | Risks | Proven by |
|---|---|---|---|---|---|
| 7a Open any version as itself (defect) | S | `app/api/documents/[id]/versions/[versionId]/content/route.ts` serves bytes with the version's `content_type` (or the file route takes `?version=`); the rendition for office files; the link in `document-version-list.tsx` | None | A changed contract for agent drafts (Markdown); keep text for `text/*` | Route spec: a PDF version returns `application/pdf` and logs `kind: 'version'`; update `document-lifecycle-panel.spec.tsx:393-408` |
| 7b „Nicht mehr im Ordner" | M | Shelf route listing documents under an origin root, minus hidden folders; planner outcome `missing`; upload summary lists them; a Files filter chip | `documents.missing_from_origin_at`, `missing_batch_id` | Origin path never rewritten (see 10c) | Planner spec; integration: a hidden-folder document is never marked; a later drop clears the mark |
| 7c Text compare for PDF and DOCX | M | pdf.js extraction of both versions (DOCX through its rendition), word diff with jsdiff, page by page | None | Large files on the client | Unit test on fixture PDF pairs; a component spec |
| 7d Plan overlay | L | pdf.js render to canvas, tint, compose; two-point manual alignment; a warning when page sizes differ. Check pixelmatch or odiff (MIT) before writing a pixel diff | None | Noise from title blocks | Fixture pair with a pixel snapshot |
| 7e Dimension-level or IFC model diff | XL | `packages/ifc-spatial`; ADR | — | — | Out of this ticket |

---

## 8. Eigene Richtlinien und Fachliteratur — M

| Checkbox | Today | Missing | Can it be met as written? |
|---|---|---|---|
| Büro lädt Normen, Richtlinien und Fachliteratur selbst hoch | [V] Upload to the Archiv needs `org:archiv:manage` (`shelf-authz.ts:32-37`). Folders since #848; upload screening applies. | A type for „Norm/Richtlinie"; a licence confirmation. | **Yes** technically. The licence is the office's to hold (below). |
| Gleichwertig mit OIB herangezogen und zitiert | [V] The Archiv is in every scope and is cited like any source (lane `buero`, `norm_registry.py:1264-1265`). No weighting by shelf turned up in the reranking code (`sources/knowledge_layer/src/register.py`, searched). The prompt says requirements come only from normative documents, including a „verbindlich erklärte Norm" (`norm_registry.py:131-137`), and that the Büroarchiv „is never the OIB corpus" (`piloti_static.md:63, 299`). [I] Whether the model treats an office ÖNORM as normative has not been tested. | A typed class, so the model and the chip know a document is a norm. | **Retrieval and citation: yes. Equal authority: not as written.** Fachliteratur is not binding, and an ÖNORM binds only where it has been declared binding. Recommend equal treatment in search and citation, with authority taken from the type. |
| Erkennbar, ob eine Quelle von Piloti oder vom Büro stammt | [V] Already true: base corpus → `baurecht`, Archiv → `buero`, in different colours. **Trap:** an explicit `doc_class` beats the shelf (`norm_registry.py:1256-1263`; test `test_norm_registry.py:440`), so `norm_extern` on an office file would turn it into Baurecht and erase its office origin. Today only the platform can set `doc_class` (`app/api/platform/knowledge/documents/[fileName]/doc-class/route.ts`), and ingestion leaves it empty outside the base corpus (`adapter.py:4518-4521`). | Office classes that map to a sub-lane inside `buero`. | **Yes**: holds today. The type field this ticket adds must not break it. |
| Ausgabe oder Stand angeben; veraltete Fassungen markierbar | [V] No edition field. ADR-0025 defers `binding_edition` until a consumer exists (`docs/adr/0025-norm-registry.md:124`); this ticket is that consumer. Editions are parsed only from OIB file names (`norm_registry.py:865-884`). There is no „Archivieren" in the Büroablage (`file-preview-pane.tsx:1410`). | Edition, „Stand", status „gültig / überholt", „ersetzt durch". | **Yes.** |
| Nur fürs eigene Büro sichtbar (Lizenz) | [V] Per-organization collection (`lib/archiv/collection.ts:12`), per-tenant buckets (`lib/storage/bucket.ts`), RLS (`lib/db/tenant-isolation.integration.spec.ts`). Inside the office, every member reads it (`shelf-authz.ts:27-28`). Passages go to the model provider on each turn (zero data retention by default, ADR-0074). | Nothing for „other offices". | **Yes against other offices.** „Lizenz" is satisfied only if the office holds a multi-user licence; Piloti cannot enforce that. |

**Licensing (external facts)**

- [V] ÖNORMen are protected by copyright and Austrian Standards holds the
  rights of use. Buying one grants a single-user licence for one named natural
  person. Offering standards on network drives, „via Dokumenten-Management-
  Systemen" or on an intranet, and scanning or copying them, needs a
  Nutzungslizenz for multiple use. Austrian Standards prices that by number of
  standards, staff and locations
  (https://cdn.austrian-standards.at/asset/dokumente/produkte-loesungen/staproman/AST_Folder%20A4_Legaler%20Umgang%20mit%20Standards_Web.pdf;
  https://austrian-standards.at/en/legal/terms/rights-of-use). The Büroablage
  is such a system: every member can open the file.
- [V] § 42h(6) UrhG allows anyone with lawful access to reproduce a work for
  automated text and data analysis, unless the rightholder has reserved this
  in an appropriate way (https://www.ris.bka.gv.at/eli/bgbl/1936/111/P42h/NOR40241407).
  [I] Retrieval that quotes passages back to users may go beyond analysis.
  Neither Austrian Standards page says anything about AI. This needs
  counsel, not code.
- Consequence: no DRM. Add a confirmation at upload for type Norm, audited,
  with help text saying what the licence must cover.

**Interactions:** [V] the Büroablage cannot be restricted (ticket 2), so a
licence held for named users only cannot be modelled until 2d. [I] AI Act:
citing office norms adds no new duty; existing Art. 50 labelling covers the
answers.

**Open product questions**

| # | Question | Recommended default |
|---|---|---|
| 8.1 | May an office norm ground a „muss"? | Yes for type „Norm" marked gültig, cited with „(Büro)". Fachliteratur never. |
| 8.2 | An überholte Fassung: out of search, or only flagged? | Out of search (reuse „Archivieren"), still openable and marked. |
| 8.3 | Confirm the licence at upload? | Yes: one checkbox, audited. |
| 8.4 | Who may set the type and the Stand? | `org:archiv:manage`. |
| 8.5 | If an office norm duplicates one in the base corpus, which wins? | Neither; both are cited. |

**Slices**

| Slice | Size | Touches | Migration | Risks | Proven by |
|---|---|---|---|---|---|
| 8a Office type and edition | M | Office classes (`buero_norm`, `buero_richtlinie`, `fachliteratur`) in `document_classification.py` mapped to lanes inside `buero`; a guard in `lane_for_hit` so an office class never leaves `buero` and a base class is never accepted on the Archiv; `source_kinds.py` and its TS mirror; `lib/knowledge/doc-class.ts` and its parity spec; an office edit route under `/api/archiv/documents/[id]`; edition and Stand stamped into chunk metadata; prompt text; answer suite | `documents.edition`, `valid_from`, `superseded_at`, `superseded_by` (FK, same shelf) | `doc_class` beats the shelf | New `test_norm_registry.py` cases; `test_source_kinds.py`; `doc-class.spec.ts`; route authz; answer suite before and after |
| 8b „Überholt" | S | „Archivieren" plus a mark in the Büroablage pane (shared with 2c) | None beyond 8a | — | `version-content.spec.ts` for an Archiv document |
| 8c Licence confirmation | S | Upload dialog for type Norm; audit event | None (audit metadata) | — | Component and audit spec |

---

## 10. Zurück zur Originaldatei — S for what a browser allows, XL for „im Explorer öffnen"

| Checkbox | Today | Missing | Can it be met as written? |
|---|---|---|---|
| Vollständiger Speicherort auf dem Büroserver in der Detailansicht | [V] `origin_path` is relative to the dropped folder (`folder-upload-plan.ts:266-268`) and shown in the pane (`file-preview-pane.tsx:1260-1284`). A picked file has none (`documents.ts:283-298`). The Archiv records it too since #848 (`lib/archiv/service.ts:147-160`). [V] Browsers expose only the path relative to the folder the user picked (https://developer.mozilla.org/en-US/docs/Web/API/File/webkitRelativePath). | The server root, as configuration. | **Only with a configured root**, and never for picked files. „Vollständig" means root + origin path. |
| Mit einem Klick kopieren | [V] Built: in the pane and as a menu action (`document-actions-menu.tsx:90-131`; `action-entries.spec.ts`). | The full path, once the root exists. | **Yes.** |
| Direkt im Explorer oder Finder öffnen | [V] None. | — | **Not from a web page.** Chrome and Edge refuse to navigate from an https page to `file://` („Not allowed to load local resource"; https://textslashplain.com/2019/10/09/navigating-to-file-urls/). Edge's `IntranetFileLinksEnabled` opens Explorer, but only on Windows, Edge 95+, and only when the Piloti page is itself in the Intranet zone, i.e. an IT-managed setup (https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/intranetfilelinksenabled). `registerProtocolHandler` accepts only `web+` or safelisted schemes, handled by an https page of the same origin, so it cannot launch Explorer (https://developer.mozilla.org/en-US/docs/Web/API/Navigator/registerProtocolHandler). What works is an installed helper that registers a URL scheme with the OS (Windows: https://learn.microsoft.com/en-us/previous-versions/windows/internet-explorer/ie-developer/platform-apis/aa767914(v=vs.85); macOS: https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app, title checked only). The browser asks before opening it. |
| Stand in Piloti daneben | [V] **Defect**: „Aktualisiert" renders `createdAt` (`file-preview-pane.tsx:1286-1292`), which a replacement never changes (`shelf-upload.ts:263-277`). `updatedAt` is no better: it also moves on rename, visibility and status (`lib/documents/repository.ts:537, 1046, 1064`). The right date is the published version's (`document-versions.ts:148, 172`). [V] The browser knows the server file's modification time (`File.lastModified`), and Piloti stores it nowhere (searched). | The version date, and the server's modification time at upload. | **Yes**: „Stand in Piloti" and „Stand auf dem Büroserver beim Hochladen". |
| Windows und Mac | [V] None. | Two path forms: `\\server\share\…` or a drive letter `P:\…`; Mac `smb://server/share/…` (Finder ⌘K) or `/Volumes/share/…`. Drive letters vary per person. | **Yes for copying.** Opening needs the helper on both systems. |

**Blockers and interactions**

- [V] **The origin path goes stale.** It is written once and kept on
  replacement (`documents.ts:290`; the replacement in
  `shelf-upload.ts:263-277` does not write it). A file moved on the server and
  uploaded again from its new place still shows the old path. Store it per
  version, or overwrite it on replacement (slice 10c).
- [V] Upload screening already screens origin paths; the path is shown only
  to readers of the document.
- **Helper security.** [I] If one is ever built, it may only reveal paths
  under the configured roots, never execute anything, and must be signed
  (Windows) and notarised (macOS).
- [V] No migration is needed for an organization setting
  (`lib/db/schema/organizations.ts:26`, `settings jsonb`) or a per-person
  override (`lib/db/schema/user-preferences.ts:5`, `prefs jsonb`).

**Open product questions**

| # | Question | Recommended default |
|---|---|---|
| 10.1 | Is the server root set per organization, with a per-person override for drive letters? | Yes. |
| 10.2 | For a folder dropped from deeper in the tree, ask at upload where it sits on the server? | Yes, pre-filled from the last drop into that project. |
| 10.3 | Will we ship and sign a desktop helper for Windows and macOS? | Not now. Offer the Edge intranet policy to Windows offices with IT. |
| 10.4 | After a re-upload from elsewhere, show the newest path? | Yes. |

**Slices**

| Slice | Size | Touches | Migration | Risks | Proven by |
|---|---|---|---|---|---|
| 10a Dates (defect) | S | Pane shows the published version's date; the upload sends `lastModified` | `document_versions.source_modified_at` | — | Pane spec with a replaced document; upload route spec |
| 10b Server roots | S–M | Organization setting (Windows root, Mac root); per-person override; root asked per upload; full path per OS, both copyable; help text („Explorer: Strg+L, einfügen" / „Finder: ⌘K") | `upload_batches.origin_root` or `documents.origin_root` | NFC/NFD names from Macs; UNC escaping | Table test of path composition: UNC, drive letter, `smb://`, spaces, umlauts, NFD |
| 10c Origin path per version | S | Replacement writes it | `document_versions.origin_path` | — | `shelf-upload` spec |
| 10d Desktop helper | XL | New signed installers, URL scheme, allow-list of roots | — | Security, distribution, support | Deferred |

---

## 9. Speicherkosten

Out of scope by the product owner's decision (1 Oct, reaffirmed 6 Oct); no research done.

---

## Dependencies and order

```
Q-0 naming ──► 2a rename ──► 3a (page names), 8a (lane labels)
1a status ──► 3a (chip, „nur abgeschlossene"), 1b ──► 3a (period, Steckbrief link)
Q-1.1 visibility ──► 3a is useful at all
1c Archiv → project ──► 3a covers legacy content
2c „Archivieren"/versions in the Büroablage ──► 8b („überholt"), 7 (versions there)
7a binary-safe versions ──► 7c compare ──► 7d overlay
10c origin path per version ──► 7b („nicht mehr im Ordner" trusts the path)
folder access per role (built) ──► 3a, 3b (reuse getProjectFolderAccess)
```

1. **7a and 10a, both S.** They are defects on shipped paths, and each
   misleads a user today.
2. **Q-0 and 2a, S.** A label change, but it decides the vocabulary of every
   other slice. It touches the prompt, so run the answer suite.
3. **2b, S.** A one-line CHECK that closes a silent-open hole before anyone
   builds on Archiv folders.
4. **1a, S–M.** It unblocks the status chip and filter in 3, and settles that
   closing never purges.
5. **8a, 8b, 2c, M.** High value in a legal product. The licence
   confirmation (8c) goes with it.
6. **1b, M.** The Steckbrief. Q-1.7 and the GDPR points come first.
7. **3a, L.** Only after 1a, 1b and Q-1.1; without them the page is a
   per-project search the product already has.
8. **7b, 10c, 7c, 10b.** Update, compare and path, each M or smaller.
9. **1c, L, with an ADR.** It makes 3 cover what was dumped in the Archiv.
10. **Later:** 7d, 3b, 3c, 2d, 3d, 10d.

---

## Found on the way (not fixed: this is a triage)

- [V] Version „Öffnen" decodes binary as UTF-8 (`version-content.ts:387`) → slice 7a.
- [V] „Aktualisiert" shows the first upload date (`file-preview-pane.tsx:1289`) → slice 10a.
- [V] No CHECK keeps Archiv folders off `access_mode = 'custom'` → slice 2b.
- [V] #844's `reingestFailedOrgDocuments` (`lib/documents/service.ts:1600`) has no spec, and its docstring appears twice (`:1533-1599`).
- [V] One shelf, three names: „Archiv", „Büroarchiv", „Büroablage" → Q-0 and slice 2a.

## External sources

- Austrian Standards, „Rechtssicherer Umgang mit Standards": https://cdn.austrian-standards.at/asset/dokumente/produkte-loesungen/staproman/AST_Folder%20A4_Legaler%20Umgang%20mit%20Standards_Web.pdf
- Austrian Standards, rights of use: https://austrian-standards.at/en/legal/terms/rights-of-use
- § 42h UrhG (RIS): https://www.ris.bka.gv.at/eli/bgbl/1936/111/P42h/NOR40241407
- File URL restrictions in Chromium browsers: https://textslashplain.com/2019/10/09/navigating-to-file-urls/
- Edge policy `IntranetFileLinksEnabled`: https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/intranetfilelinksenabled
- `registerProtocolHandler` (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Navigator/registerProtocolHandler
- `webkitRelativePath` (MDN): https://developer.mozilla.org/en-US/docs/Web/API/File/webkitRelativePath
- Registering a URI scheme on Windows: https://learn.microsoft.com/en-us/previous-versions/windows/internet-explorer/ie-developer/platform-apis/aa767914(v=vs.85)
- Custom URL scheme on Apple platforms: https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app
- Bluebeam Overlay Pages: https://support.bluebeam.com/user-manual/menus/document/overlay-pages.html
- GDPR: https://eur-lex.europa.eu/eli/reg/2016/679/oj
- AI Act: https://eur-lex.europa.eu/eli/reg/2024/1689/oj

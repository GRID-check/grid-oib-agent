# Upload & filing tickets — triage, 2026-10-01

> **Superseded for the unbuilt tickets (6 Oct 2026).** Tickets 1, 2, 3, 7, 8 and 10 were triaged again against the code after develop gave the Archiv folders: [`upload-and-filing-retriage-2026-10-06.md`](upload-and-filing-retriage-2026-10-06.md). What tickets 4, 5 and 6 delivered is traced to code and tests in [`upload-governance-traceability-2026-10-06.md`](upload-governance-traceability-2026-10-06.md).

Ten tickets („Tickets & Backlog — Upload & Datenablage", Jonathan, 1 Oct 2026),
each checked against the code at `f62552a` before anything was built. Three were
built in the same branch (4, 5, 6); one is out of scope by the product owner's
decision (9); the other six are triaged here with what exists, what is missing,
what blocks it that the ticket does not mention, and the smallest slice worth
shipping.

**Tags.** *[V]* was read in the code. *[I]* is inference and needs checking
before anyone relies on it. Sizes are S / M / L / XL of engineering effort.

The working log with the research behind the built tickets is
[`plans/2026-10-01-upload-governance-worklog.md`](../../plans/2026-10-01-upload-governance-worklog.md).

---

## Built in this branch

| Ticket | What shipped | Decision record |
|---|---|---|
| 4 Übersicht – Was ist angekommen? | Every upload is a batch. When everything it brought in has been read, the uploader gets an inbox item that opens a summary: what arrived, where it was filed, what each file is, what the screening held back and why, what failed. Project settings list every upload with its outcome and uploader | ADR-0079 (migration 0105) |
| 5 Blacklist | An office-defined list of sensitive terms. Names are screened in the browser before anything is sent and again on the server; content is screened locally after text extraction and before the first model call. A match waits in a quarantine an org or project admin clears. Unreadable content (scans) is checked by name only, and the summary says so | ADR-0079 (migration 0104) |
| 6 Zugriffsrechte für Ordner und Dateien | Offices build their own roles in Piloti, held in WorkOS as custom roles. A folder can be restricted to roles; its documents move into their own retrieval collection, which only cleared members' chat turns search. Org admins see everything | ADR-0080 (migration 0106) |

**NVIDIA Agent Toolkit.** The request asked whether NAT can stop sensitive data
being uploaded. It cannot: NAT 1.9 middleware wraps registered functions, never
document ingestion, and `nvidia-nat-security`'s `pii_defense` is English-only
Presidio applied to function *output*. The gate had to be ours, local and
rule-based. Details in the worklog.

**Not built, with reason.** Ticket 9 (Speicherkosten) is out of scope by the
product owner's decision on 2026-10-01; the findings are kept below so nobody
re-earns them.

---

## 1. Abgeschlossene Projekte + Steckbrief — M

**Exists.**
- [V] Documents stay attached to their project (`documents.project_id`).
- [V] The Project Brief builds a fact sheet from the profile (`lib/project-profile/brief-view.ts`).
- [V] Address (`standort_adresse`) and phase (`projektphase`, including
  `fertigstellung_uebergabe`) are already profile facts (`intake-definition.ts`).

**Missing.**
- [V] `projects` has no status, closed-at, start or end column; only `deletedAt`.
- [V] Members are WorkOS FGA assignments only; nothing models a person without
  a Piloti account (a former employee, an external planner).

**Blockers the ticket does not mention.**
- [V] The document „Archivieren" action purges chunks so the file stops
  answering. Building „Projekt aufräumen" on it would make closed projects
  unsearchable and break ticket 3 outright. Closing must not purge.
- [V] Project deletion cascades to documents; closing must never reuse it.
- [I] Names of former staff are personal data: retention and erasure need a decision.

**Product questions.** What does „aufräumen" mean: read-only, hidden from the
project switcher, or out of chat scope? Can a closed project be reopened? Who
may close one?

**Smallest slice.** `status` + `closed_at` with a CHECK, a close/reopen
action, an Aktiv/Abgeschlossen filter on the project list, and period plus
external people as Steckbrief fields.

## 2. Büroablage — S (mostly built)

**Exists.** [V] The Archiv is `scope='archiv'` with its own route, in every
project's retrieval scope, flag on by default, rendered as source kind `buero`.

**Missing.**
- [V] No folders: `project_folders.project_id` is NOT NULL and
  `documents_folder_requires_project` is a CHECK. Categories are the fixed
  ingestion tags only.
- [V] No way to move a document between a project and the Archiv.

**Product question.** Folders or categories? Categories are cheaper and are
also ticket 3's facets.

**Smallest slice.** Office-defined categories on Archiv documents, and „In
Büroablage verschieben" from a project.

Fixed on the way: a link to one Archiv document (`/app/archiv?doc=…`, used by
sharing and now by the upload summary) opened the grid instead of the document.

## 3. Bibliothek — L–XL, needs an ADR

**Exists.** [V] Retrieval fans out over a collection list; the scope is base +
Archiv + one project + session; the Files search is single-project.

**Missing.** Everything cross-project.

**Blockers.**
- [V] One Chroma collection per project (ADR-0072): semantic search across N
  projects is N queries. [I] Fine for tens, not for hundreds.
- [V] „Dachdetails von Holzbauten" joins two stores: `Detail` is an ingestion tag
  in the knowledge layer's metadata DB, `holzbau` a project-profile fact in the
  app's Postgres. „Dach" is in neither vocabulary.
- [V] Authorization is per project; a library must first list the reachable ones.
- Restricted folders (ticket 6) are now their own collections: a library that
  searches must add only the ones the reader is cleared for, through
  `lib/authz/folder-access.ts`.

**Smallest slice.** A metadata library, not semantic search: documents from
every reachable project, filtered by tag, project status, period and phase,
each with a project chip linking to the Steckbrief. Cross-project semantic
search and agent answers come after an ADR. Depends on 1 and 2.

## 7. Versionen & Vergleich — M to fix and finish, XL for a plan diff

**Exists.** [V] Every upload shelf records versions; superseded objects are
kept; a version list with a line diff; the folder re-upload planner classifies
new / update / unchanged / collision / duplicate by sha256. Search sees the
current version only. The quota counts every version.

**Defect.** [V] `readVersionContent` decodes any version as UTF-8 and the
version list links every non-published version to it. [I] Opening or comparing
an older PDF or plan version shows binary noise; the code was written for
Piloti's Markdown documents.

**Missing.** No „nicht mehr im Ordner" outcome in the planner; no version UI in
the Archiv; no plan overlay.

**Blocker for a PDF text diff.** [V] The old version's extracted text goes
with its chunks; it must be re-extracted from the old bytes or kept per version.

**Product question.** Files missing from a re-dropped folder: mark, or offer to archive?

**Smallest slice.** A binary-safe version route gated on content type, the
„nicht mehr im Ordner" outcome, then PDF text compare via pdf.js.

## 8. Eigene Richtlinien und Fachliteratur — M

**Exists.** [V] Archiv documents render on their own lane (`buero`, distinct
from `baurecht`), are organization-private, and are in every answer's scope.

**Missing.**
- [V] `doc_class` is settable only by the platform owner, on base knowledge.
- [V] No edition or „Stand" field on documents or `NormEntry`; ADR-0025 defers
  `binding_edition` „until a consumer exists" — this ticket is that consumer.
- [V] Superseded editions are handled for OIB only, by filename.

**Blocker.** [V] Setting `doc_class=norm_extern` on an office file makes it
`baurecht` (doc_class wins in `lane_for_hit`) and erases its office provenance.
It needs a `buero_norm` sub-lane.

**Product questions.** ÖNORM licensing; whether a superseded edition is hidden
from retrieval or only flagged; whether an office document may ground a
normative claim.

**Smallest slice.** An office-editable „Norm/Richtlinie" type with edition and
Stand on Archiv documents, an „überholt" flag that drops it from retrieval,
and the chip sub-label „Richtlinie (Büro)".

## 9. Speicherkosten — out of scope (findings kept)

- [V] „IPAX" appears nowhere in the repo; the documented provider is a managed
  k0s cluster with Lightbits block storage in classes `premium` (3 replicas),
  `standard` (2) and `single-replica` (1).
- [V] One `storageClass` serves every PVC; prod runs SeaweedFS `single`, 20 GiB
  on `premium`. No tiering.
- Growth drivers: version history (ticket 7) keeps every object, with no
  retention policy.
- At 20 GiB the saving is probably trivial. Measure before building; the first
  slice would be a per-workload storage class for the SeaweedFS volume.

## 10. Zurück zur Originaldatei — S for the honest scope, XL for „im Explorer öffnen"

**Exists.** [V] `origin_path` is written by folder uploads, shown with a copy
button and offered as a menu action.

**Platform facts.** `webkitRelativePath` starts at the dropped folder; no
browser API exposes absolute paths; Chrome, Edge and Firefox refuse `file://`
navigation from an https page. The office-server root can only come from
configuration, and „open in Explorer/Finder" needs installed software.

**Defect.** [V] „Aktualisiert" renders `createdAt`; a replacement keeps the row
and writes only `updatedAt`, so after a re-upload the pane shows the first
upload date.

**Product question.** Files dropped from different folder depths: is the root
per organization, per project or per upload?

**Smallest slice.** Show the latest version's date; an org setting with a
Windows and a Mac root; „Pfad kopieren (Windows/Mac)" with paste instructions.
Tell the product owner plainly that opening the folder needs a desktop component.

---

## Dependencies and order

```
7 fix (binary versions) ──► 7 compare ──► 10 („Stand in Piloti" = version date)
7 (version retention) ──► 9 (growth)
1 (status, period, Steckbrief) ──► 3 (chips, period filter, Steckbrief link)
2 (categories, shelf move) ──► 3 (facets), 8 (where office norms live)
6 (built) ──► 3 (only cleared restricted collections)
```

1. The defects on shipped paths (7 binary versions, 10 „Aktualisiert" date): S.
2. Ticket 1, which unblocks ticket 3 and settles „closing must not purge".
3. Ticket 10's root mapping, with the desktop-component caveat said out loud.
4. Ticket 8: mostly metadata and a sub-lane, high value in a legal product.
5. Ticket 2's categories and shelf move.
6. The rest of 7: the „nicht mehr im Ordner" outcome, then PDF text compare.
7. Ticket 3, once 1 and 2 have landed: metadata library first, then an ADR.

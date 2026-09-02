# Pilot feedback triage — 2026-09-01

Every item in Matthias's pre-pilot feedback, checked against the code before
anything was changed. Six verification passes ran first; several claims did not
survive contact with the repository, and two of the most valuable findings are
things the report did not mention.

**How to read the verdicts.** *True* means the code does what was reported.
*Partly true* means the symptom is real and the stated cause is not — those are
the dangerous ones, because fixing what was described would have left the fault
in place. *Not true as stated* means the feature works and something adjacent
explains the experience.

Fixed items name their commit. Everything else says what it would take, so the
next person starts from evidence rather than from the report.

---

## Fixed in this pass

| Report | Verdict | What was actually wrong |
|---|---|---|
| „@ Kollegin erwähnen" funktioniert nicht | Partly true | The feature is wired end to end — picker, invite, inbox item. What fails is the FIRST `@` in a new thread: the conversation row reaches the server only with its first persisted message, so the candidates read 404s, the retry ladder gives up, and nothing re-arms it. A fresh `@` now asks again |
| Grüner Rahmen / grüner Button | True | Both were `--accent-pop`, a carve-out against the design language's own first principle (*no brand accent colour on actions*). Withdrawn, tokens deleted, reasoning recorded in the design doc |
| Output-Herleitung wiederholt „OIB-Wissen, OIB-Wissen…" | Partly true | The panel shows far more than the report says (the question, the routing reason, per-source cards, a hit tally). The `Ausgeführt` row is the thin part, and it stuttered: dedup keyed on the internal tool name while labelling by rule, so three RIS tools printed three identical chips |
| Output Cards: zu klein, zu viele Typo-Arten | True, and understated | `comparison_table` carried **thirteen** distinct type treatments, none above 14px, entirely at 12px inside a 16px answer. Its title was smaller than the prose it interrupted. `kit.tsx` (chrome for nine cards) and both table cards are now on the charter's ramp |
| Quellen lassen sich oft nicht öffnen | True | „An dieser Stelle öffnen" was offered for every citation without an outbound URL, with no resolution attempted. On a source the viewer cannot render the click closed the popover and did nothing. It is now offered only when something will open, and says so when nothing will |
| Deep-Research bricht fast immer ab | Partly true | No route timeout, no client abort — the naive explanation is wrong. Two real causes: a source tool waiting for our own concurrency semaphore raised a bare `TimeoutError` that the agent read as an upstream cutoff and applied to the whole run; and neither SSE generator emitted anything during silence, so undici's 300 s inactivity timeout tore down healthy quiet runs |
| Kein Viewer für neue Dateiformate | True | `.txt`, `.md` and `.csv` are accepted at upload and drew the same grey placeholder as a `.dwg`. They now render. BMP/TIFF were a separate drift: the server would have served them, the client never asked |
| „Alle / Meine / Unvergeben / Von Piloti" unverständlich | True, and worse than reported | A filter matching nothing rendered the FIRST-RUN state — „Noch keine Dokumente", with an upload button — in a project full of files. The strings for the real states had been in both dictionaries with no call site. „Von Piloti" now explains itself where it matters |

### Two findings the report did not contain

**The building code was being dropped from the search.** `shelves_for_turn`
subtracted the OIB corpus whenever a subject file was bound. Attach a plan, ask
whether it meets the escape-route requirement, and retrieval held the plan and
no OIB at all — the product's central question, failing quietly and fluently.
The asymmetry that exposed it: the `project` PRESET kept the corpus, the
`project` SHELF did not, though a reader reaches for either to say the same
thing. This is very likely behind several separate reports at once: *„bei der
Dateisuche wird oft nur das Projekt durchsucht"*, *„hochgeladene Pläne werden
nicht ausgelesen"*, and some of *„Agent bezieht die visuellen Planunterlagen
kaum ein"*.

**The chat agent was never told to surface disagreement.** `writer.j2` has
instructed the deep-research writer to name conflicting sources for a long
time. The shallow prompt — which answers almost every question — mentioned
contradiction only as a reason to escalate or lower confidence, never as
something to tell the reader. In a legal product a smoothed-over difference is
the dangerous failure, because an unqualified answer reads as a settled one.

---

## Real, not fixed here

**Hochgeladene Session-Dateien werden nicht vom Vision-Modell ausgelesen.**
True, and the mechanism is not what it looks like. There is no inline vision
call on a chat attachment — ever. Ingestion is asynchronous on a pool of two
workers with a 180 s per-call VLM timeout, and *the send is never blocked*
(`InputArea.tsx`: "send is never blocked", with a tooltip as the entire
signal). So a plan attached and asked about in the same breath is answered
before its content exists. Nothing tells the agent the file is still
processing either: the per-turn inventory reads the summaries table, which is
written only when the job finishes. Fix has two slices — hold the turn while
uploads are in flight, and surface in-flight ingest jobs in the prompt
inventory.

**Agent bezieht die visuellen Planunterlagen kaum ein.** Visual chunks *are* in
the same index, reachable by the same tool, with no modality filter anywhere in
the query path — so the stated cause is wrong. The real gap: `view_knowledge_image`
is built, registered, documented as default-on, and **wired into no config** —
`grep -rn view_knowledge_image configs/` returns nothing, and it never appeared
there in the history. The model reads captions *of* plans, never a plan. Two
YAML lines, plus a check that the chat model is vision-capable and a token-cost
estimate. Beyond that sits a known ceiling: VLMs score 33–38% on floor-plan CAD
understanding, and `docs/architecture/visual-ingestion.md` already lists the
layout detector and visual-embedding channel as unbuilt.

**Vorschau zu Plänen wird oft nicht angezeigt.** True. Both thumbnail
generators handle PDF and raster images only; DWG, DXF, IFC, TIFF, DOCX and
XLSX get none. The fallback behaves correctly (a content-aware placeholder, not
a broken image) — the coverage is the gap, and closing it means a CAD/Office
rasteriser, which is a dependency decision and wants an ADR. The same wall
limits how far citation-opening can be widened: offering to open a format
nothing can render only moves the silent failure from the popover into the
viewer.

**Der Agent könnte öfter Rückfragen stellen.** Partly true — and the specific
thing asked for is out of scope by design. The capability exists (`ask_user`, a
blocking multiple-choice tool, with a `<clarification>` block instructing
proactive push-back). But its description forbids asking what a search could
establish, and nothing anywhere lets the agent ask *which shelves to search* —
shelf selection is a UI chip the agent receives and never negotiates. Worth
revisiting now that a subject no longer silently costs the turn its law.

**Ein erwähnter Kollege erfährt es nur in der App.** Not reported, found while
checking the mention claim. `notifyMentionRecipients` writes an inbox row and
publishes a live event; there is no email or push transport anywhere in the
product. Someone who does not open Piloti is never told — the most likely
honest basis for „funktioniert nicht".

**Drag & Drop in Ordner.** Literally true, but "no way to move files" is not:
`PATCH /api/documents/[id]/folder` exists and an overflow-menu „Verschieben"
uses it. Pure frontend work, no backend at all — with one hazard, that an
internal drag must be told apart from an OS file drag, which the workspace
already listens for.

**Office-Viewer (docx/xlsx/pptx).** Accepted at upload, no viewer, and the only
honest fix adds a conversion dependency. ADR first.

**Die Kartentypografie ist immer noch kleiner als der Fließtext.** The charter's
ramp tops out at 13.5px Body against 16px prose, so a migrated card is
internally consistent and externally undersized. Re-basing it is a product
decision across all 35 cards; §A2 of the charter now records the question as
open rather than leaving it implicit.

---

## The XL proposals, measured against what exists

**The archive premise is false, and this is the most useful thing in the
report to correct.** *„Aktuell haben wir zwei Ablageorte, die um dieselben
Dateien konkurrieren"* — there is one. ADR-0024 decided it in 2026-07 and says
so in its decision section: an Archiv document is a row in the same `documents`
table with `project_id = NULL` and `scope = 'archiv'`. **No parallel table.**
Same upload path, same ingest dispatcher, same item routes. And the Archiv is
*already* injected into every project's retrieval scope (`collection-scope.ts`).
A proposal premised on unifying two stores is proposing work that shipped.

What is genuinely missing there is small and specific: **a move between
shelves**. A document lives in exactly one retrieval collection, and there is no
promote/demote path — re-shelving today means delete and re-upload. Days, not a
rewrite.

The rest of proposal 2 is closer to built than it reads:

- **„Das Archiv ist eine Sicht, kein Ort."** Already true structurally. The
  cross-corpus grid (`use-surfaced-documents`) shows both shelves with a
  provenance badge, and the Archiv renders a category-chip filter over real
  tags. Missing: user-defined categories. The code says so out loud —
  *"no custom-category creation (that needs product work)"*.
- **„Abgeschlossene Projekte sind Projekte mit anderem Status."** Correct, and
  absent: `projects` has no status column at all. Small, genuinely new. The
  closing form is the valuable half of the idea and nothing in the schema
  prevents it.
- **„Bürowissen bekommt eigene Bereiche."** This is the Archiv, which is
  already a first-class source kind (`buero` — *"Büroarchiv: the organization's
  standards, details, experience"*) with its own permission and chip. What it
  lacks is subdivision: it is flat and folder-less by DB constraint. Naming a
  region „Bürostandards" is closer to a translation key than a feature.
- **„Gute Details werden befördert."** Needs the move-between-shelves
  operation above, and then it is a button.

**Upload, versioning, delta.** Here the report is right about nearly
everything, and two hidden blockers will decide the shape of the work:

- **Folder upload does not exist.** No `webkitdirectory`, no directory
  traversal; a dropped folder yields zero files. But the *sink* is built and
  ADR'd: `folder_path` already travels to ingestion and `knowledge_search(folder=)`
  filters a whole subtree by it (ADR-0049). Only the capture is missing, and the
  retrieval payoff is already paid for.
- **Resumable upload does not exist, and cannot be reached from here.** The
  three `@uppy/*` packages in `package.json` are imported by nothing —
  `project-uppy-upload.tsx` is a plain hidden `<input>`, and `@uppy/xhr-upload`
  has no resume regardless. Real resume needs tus or S3 multipart plus a
  server-side session store, and it collides with an architecture that buffers
  whole files in the Node process. The largest single item in the report.
- **A 100 MB batch ceiling applies to project and Archiv uploads**, and only
  the file-*count* cap is exempted for durable corpora. A folder drop of any
  real Einreichung is rejected wholesale today. Any bulk-upload plan must
  address this on day one.
- **Duplicate detection is client-side and localStorage-backed.** It vanishes
  in a new browser or an incognito window. Any delta feature must be
  server-side or it is theatre.
- **Re-upload was a live defect, and is fixed.** A second upload of one name
  used to create a second row and a second stored object charged to quota,
  while the ingest pipeline deleted the *first* row's chunks — a downloadable,
  unsearchable ghost. All three shelves now replace the existing row
  (`findLiveDocumentByFilename` + `admitReplacementOrDiscard`), and migration
  0074 makes one live human-uploaded document per `(organization, collection,
  filename)` a unique index, so the concurrent case cannot recreate it. There
  is still no content hash; versioning can be designed on top of a stable id
  now.
- **The four delta outcomes already exist** — new / changed / unchanged /
  disappeared, with a sha256 registry — for the OIB base corpus (`OibFileState`,
  `oib_sync.py`). Generalising a proven algorithm to a second corpus is not new
  design.
- **Versioning has no schema at all**, but the `supersedes_id` idiom is in this
  database twice already (project memory, budgets), so the pattern is settled
  even though the work is not.
- **A per-organization blacklist does not exist**; there is a deployment-wide
  extension allow-list and a global platform exclusion file. The org `settings`
  jsonb is the obvious empty home for it.
- **„Weiterarbeiten am Original"** needs the captured origin path from the
  folder-upload work and is then a field in the detail pane.

---

## Correcting one thing about how this was reported

Several items were already fixed and merged before the feedback was written —
deep-research cutoffs handing back partial work, the composer's grey outline,
clarifying questions, source-citation accuracy during research. They are in
`releasenotes/notes/` and on `develop`. If they were still visible in testing,
the deployment was behind the branch, and that is worth checking before the
pilot: it changes which of these reports are code problems and which are
release problems.

## The HTML mock-ups

*„Liegt als HTML bei"* — the redesigned output cards and chat outputs are not in
the repository and did not reach this session. The typography work here was
done from the charter and from measurement, not from that design. Worth
comparing against it before anything further is spent on card layout.

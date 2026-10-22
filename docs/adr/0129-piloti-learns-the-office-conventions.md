---
status: accepted
date: 2026-10-22
decision-makers: Grid engineering
consulted: product owner; north-star scene 7 and its exemplar `ns-learn-office`
informed: everyone working on filing, the turn context, project memory and the agent's file tools
---

# Piloti learns the office's conventions: counted from the office's own projects, stated as "usually"

## Context and Problem Statement

North-star scene 7 ([`agent-capabilities.md`](../architecture/agent-capabilities.md)):
"It learns where things are kept, what they are called and the drawing
conventions in use, so the next project starts already oriented." The register
row "Learn the office" read **Partial**: `remember` keeps durable facts, and
nothing learns a convention for naming, filing or drawings.

What the code had on 2026-10-21:

- **The facts are already recorded, one document at a time.** The app
  database holds every document's project, folder and file name
  (`documents`, `project_folders`). The backend's `document_metadata` holds the
  Dokumentart (the controlled tags, `doc_class`) and the title-block facts read
  off the Plankopf (`revision_facts`: Plannummer, Index, date, Maßstab). The
  BFF already joins the two for every listing
  (`lib/documents/reconcile-status.ts`).
- **One narrow learner exists.** `lib/filing/conventions.ts` learns the folder
  skeleton of the office's other projects and the Dokumentart per folder, for
  the filing judge that proposes where an upload belongs. It runs per upload,
  as the uploader, and nothing else reads it.
- **The agent never sees any of it.** A question "wo legen wir Gutachten ab?"
  or "wie nummerieren wir Pläne?" is answered from this project's tree alone,
  or by guessing. `remember` could hold a convention as an organization note,
  but only when a person happens to state it in a chat, and no count stands
  behind it.
- **Memory is the wrong home for a count.** Organization memory
  (`project_memory`, ADR-0087's restriction rules, `semantic-notes.md`) is a set
  of sentences with consolidation, supersede and a person's pin. A statistic
  recomputed from the documents is replaced wholesale on each refresh; written
  as notes it would churn the panel, compete with the digest's budget and look
  like something somebody said.

The question: what does Piloti learn about the office without a model, where
is it kept, how is it kept current, and how does it reach a turn without
overriding what a person decided?

## Decision Drivers

* **Deterministic first.** A convention is a count over records the office
  already made. Counting is reproducible, cheap, testable and cannot invent a
  folder; a model may summarise later, from the counts.
* **A convention is a pattern, not an instance.** The exemplar's Must-not:
  "Learn from one accidental move." A line needs several projects behind it and
  a majority of them.
* **Restraint.** It is a prior, never a rule: shown as "usually", never
  overriding a person's own folders, and never a reason to move anything
  without a proposal.
* **Tenancy and restriction.** Learned per organization, never across. A
  folder under its own access list (ADR-0087, ADR-0088), and everything filed
  below it, does not count. Only screened documents count (ADR-0086).
* **Every turn pays nothing it does not use.** The turn-context read is one
  primary-key row and one aggregate, and only on a question about filing or
  finding.

## Considered Options

* **A. Do nothing; let `remember` collect conventions as people state them.**
* **B. Compute on read, every turn.** Run the extractor inside the turn context.
* **C. An office-level record, refreshed when the office's documents change,
  read by the turn context.** (chosen)
* **D. Ask a model to describe the office's conventions** from a sample of
  listings, and store its prose.

## Decision Outcome

Chosen option: **C**, because the inputs span the whole office and half of
them live in the backend (one listing per project), which no turn should wait
on, while the result changes only when documents or folders change.

### What is learned (deterministic, `lib/office-conventions/extract.ts`)

Pure, over the office's most recent projects (`MAX_PROJECTS`, 30), from
documents every member may read (archived ones included: an archived document
still shows how the office named and filed it):

| Convention | Counted from | Example line |
|---|---|---|
| **Folder skeleton** | Folder paths (depth ≤ 2) that recur across projects, compared without case and without a leading ordinal (`03_Behörde` = `Behörde`) | `folders most projects keep: Grundlagen (7 of 7), Einreichung (6 of 7)` |
| **Where each Dokumentart is filed** | Per project, the folder most documents of that Dokumentart sit in, cut to depth 2 like the skeleton; then across projects | `Gutachten usually under Fachplaner/Gutachten (4 of 5 projects that file one)` |
| **Plannummer shape** | The title block's `document_number`, masked: a run of letters is `A`, each digit `0`, separators kept (`HUB-EP-01-003` → `A-A-00-000`) | `Plannummer usually shaped A-A-00-000` |
| **Index style** | The title block's `revision`: letters (A, B), numbers (1, 2), two-digit numbers (01, 02), letter plus number (A1) | `Index usually letters (A, B, C)` |
| **Date in file names** | Date tokens in file names: `YYYY-MM-DD` (any of `-_.`), `YYYYMMDD`, `DD.MM.YYYY`, `DD.MM.YY` (dots only: `01-02-03` is a Plannummer far more often), and six digits as `YYMMDD` or `DDMMYY` only when exactly one reading lands near the upload date | `file names usually write a date as YYMMDD` |

Each line is kept only when at least **three projects** show it and they are
**at least half** of the projects that could show it (`MIN_PROJECTS`,
`MIN_SHARE`). The threshold is the "pattern" the exemplar asks for, and it is
also the privacy floor: a folder name or a number shape that only one project
carries is never stated, so a project a reader cannot open contributes counts,
never its names. A Plannummer is stated only as a shape, never as an example.

**The audience is the organization, not the project.** Every member reads the
conventions, including about projects they are not on: they describe how the
office works, which is one row per organization, not per reader. Restricting
the count to the projects each asker can open would make it a per-person
record and break the one-row design. What keeps that safe is what a line may
name: counts, shapes, and folder paths no deeper than depth 2 (a filing line is
cut to the depth the skeleton shows, so `Fachplaner/Gutachten/Statik Müller`
is stated as `Fachplaner/Gutachten`), each shared by at least three projects.
A folder under an own access list never counts (ADR-0087).

**Not learned in this slice: Dokumentarten per phase.** The project phase is
one current value in the profile (`/facts/project_phase`), not a fact stamped
on each document when it was filed, so "which Dokumentarten arrive in which
phase" would be read off today's phase for documents filed in every earlier
one. It waits for a per-document phase or an upload-time stamp.

### Where it is kept

A new table, `office_conventions` (migration 0181): one row per organization,
the extractor's JSON (`conventions`, versioned by `extractor_version`), the
`source_fingerprint` it was computed from, `computed_at`, and
`refresh_requested_at`. RLS `organization_id = grid_current_org()`. A person's
decisions on its lines are a second table, `office_convention_decisions`
(migration 0182), keyed by organization and line key.

Existing tables checked first:

- `project_memory` (organization scope): sentences with consolidation and a
  person's pin. A recomputed statistic does not fit (see Context); a
  convention a person **confirms** belongs there, as an organization note
  (the later slice below).
- `organization_instructions`: a person's text, sent with every turn.
  Machine-derived counts there would be indistinguishable from the office's
  own instructions.
- `organizations.settings`: product configuration, not knowledge.

### How it is kept current

- **Change detection is a fingerprint**: the count and latest `updated_at` of
  the office's project documents (screened only) and of its project folders.
  An upload, a move, a rename, a delete or a folder change moves it. Two
  aggregates over the organization's rows, no backend call, read at most once a
  minute per organization and process (`FINGERPRINT_TTL_MS`): the question that
  asks for conventions is broad, and a minute late is nothing beside the
  ten-minute refresh limit.
- **It is requested lazily**, by the first filing or finding question that
  finds the stored fingerprint stale, at most once per ten minutes per
  organization (`refresh_requested_at`, claimed in one
  `INSERT … ON CONFLICT DO UPDATE … WHERE`). That turn is served the previous
  snapshot: a convention changes slowly, and no turn waits for a refresh.
- **The refresh runs detached in the BFF process that claimed it**: it reads
  the folders, the documents and one backend listing per project (the same
  enrichment every listing uses), runs the extractor and replaces the row. It
  is deliberately not a `bff_job_queue` kind (ADR-0121): the work is derived,
  idempotent and replaced whole, so a refresh lost to a restart costs nothing
  the next stale read after the interval does not redo, and a queue row would
  buy durability nothing needs. It becomes a job kind the day a refresh
  outgrows one request's worth of work (more projects, a model summary).

### How Piloti uses it

- **In the turn context**, as the last section of the WORKSPACE block
  (ADR-0123, `lib/turn-context/workspace-block.ts`), when the question is
  about filing or finding (`asksWhereThingsAre`, a word list: wo, ablegen,
  Ordner, finden, Plannummer, Index, Dateiname …). At most six lines, each
  bounded, under a header that carries the restraint:
  `office conventions (counted from N of the office's projects; usually, not always: this project's own folders and a person's choice win; propose, never move on a convention alone)`.
  The WORKSPACE block, not the memory channel: the memory header is already
  budgeted to its digest and decisions, and filing acts go through the
  workspace tools that block accompanies.
- **As a prior for list and search, not a filter.** The line names where a
  Dokumentart usually is, so a `list_files` or a folder-scoped search can look
  there first; a miss there is not an absence.
- **Behind a flag, off by default**: the `office-conventions` WorkOS feature
  flag, per organization (an entitlement; an office's on/off switch is never an
  environment variable). Off, no fingerprint is read, no refresh runs, and the block is byte-identical to
  before.
- **Observable**: the agent records `office_conventions_lines` (how many
  convention lines the turn was shown; 0 on a turn whose WORKSPACE block has
  none) as trace metadata, so Langfuse can compare filing answers with and
  without them; the refresh logs its counts.
- **Bounded**: at most six lines of at most 220 characters under the header,
  filing lines dropped before naming lines. The agent's cut of the WORKSPACE
  block (`WORKSPACE_MAX_CHARS`, `turn/context_client.py`) rises from 3000 to
  6500 so eight full proposals and the conventions both fit; the conventions
  come last, so any cut takes them before a proposal.

### What the person sees, and the later slices

Slices 1 and 2 are built (still behind the `office-conventions` flag); slice 3 is open.

1. **A read view, built.** `GET /api/organization/office-conventions`, its
   operation `office-conventions-list` (offered on the door like any office
   read), and a card on Organisation → Übersicht („Was Piloti über das Büro
   gelernt hat“). Each line has a stable key (`lib/office-conventions/lines.ts`:
   the kind and the value, never the counts), its counts and its decision. No
   example file is shown: the privacy floor says a name only one project carries
   is never stated, and the read is open to every member.
2. **Confirm or decline a line, built.** `POST` on the same path, operation
   `office-conventions-decide`, `org:settings:manage` (the decision changes what
   Piloti says to everyone, like the standing instructions). Decisions are rows
   of `office_convention_decisions` (migration 0182), not memory notes: a
   decision is the office's word and the count row is replaced whole, so it
   needs a home of its own, and the snapshot of the line kept with it lets a
   **confirmed line outlive a recount** that no longer clears the threshold. A
   **declined line never reaches the agent** (`linesForAgent`). A confirmed
   filing line also beats a counted one for the same Dokumentart. A decision can
   be taken back (`undecided`). Accepted `file_operation` moves (status
   `applied`) count: the moved document's Dokumentart votes for the target
   folder in its project, and within that project the moves replace where the
   documents happen to sit. The extractor version is 3.
3. **A model's summary from the counts**, only if the lines prove too terse in
   the `files` eval.

Not decided here: a declined proposal does not count against a line.

### Consequences

* Good, because a filing or finding question starts from the office's habits,
  counted, with the evidence ("4 of 5 projects") in the line the model reads.
* Good, because nothing new is guessed: every line is a count over records the
  office made, reproducible by running the extractor on the same rows.
* Good, because the turn pays one row read and one aggregate, and only when
  the switch is on and the question is about filing or finding.
* Bad, because the first question after a change sees the previous snapshot.
  Accepted; the alternative is a turn waiting on N backend listings.
* Bad, because a Dokumentart edited in the backend without touching the app
  row does not move the fingerprint; it is picked up by the next upload or
  move. Accepted for a statistic over many documents.
* Bad, because a small office (fewer than three projects) learns nothing.
  That is the "pattern" rule working, and the filing judge's Austrian default
  still covers a new project's folders.
* Bad, because the word list that decides "a question about filing or
  finding" misses paraphrases. The cost of a miss is the turn without the
  lines, which is today's behaviour.

### Confirmation

- `lib/office-conventions/extract.spec.ts` holds the thresholds, each
  pattern's reading and determinism (the same rows in another order give the
  same conventions).
- `lib/office-conventions/render.spec.ts` holds the bound, the header's
  restraint wording and the question classifier.
- `lib/office-conventions/service.spec.ts` holds what counts (no folder under
  an own access list, nothing filed below one, screened documents only), the
  switch, staleness and the claim.
- `lib/turn-context/workspace-block.spec.ts` holds that the block is unchanged
  without conventions and that they come last.
- `rls-coverage.spec.ts` lists migration 0181, and `task db:test:rls`
  (`scripts/rls-test-db.sh`) checks its tenant isolation, its
  computed-together CHECK and its down migration.
- `tests/aiq_agent/turn/test_office_conventions_trace.py` holds the trace
  metadata.
- Nothing yet measures whether the lines change filing answers: the `files`
  eval gets a row from `ns-learn-office` when the read view lands.

## Pros and Cons of the Options

### A. Do nothing

* Good, because no new table or job.
* Bad, because a convention exists only if a person says it in a chat, with no
  evidence behind it and no way to notice that the office changed its habit.

### B. Compute on read

* Good, because always current, no table.
* Bad, because the Dokumentart and the title-block facts live in the backend:
  one listing per project, on the time-to-first-byte path of every filing
  question.

### D. A model describes the conventions

* Good, because prose reads naturally and could catch what a count cannot.
* Bad, because it can invent a folder or a pattern no project has, costs a
  model call per refresh, and its output cannot be checked against the rows.
  It may come later as a summary *of* the counts.

## More Information

- North star: [`agent-capabilities.md`](../architecture/agent-capabilities.md)
  (star 7), [`north-star-answers.md`](../architecture/north-star-answers.md#ns-learn-office).
- Related: ADR-0121 (server-owned bulk work), ADR-0123 (the WORKSPACE block),
  ADR-0127 (search, list, read; folder cards), ADR-0086/0087/0088 (screening and
  restricted folders), `lib/filing/conventions.ts` (the filing judge's folder
  learner, which this does not replace).
- Project memory: [`project-memory-design.md`](../architecture/project-memory-design.md),
  [`semantic-notes.md`](../architecture/semantic-notes.md).

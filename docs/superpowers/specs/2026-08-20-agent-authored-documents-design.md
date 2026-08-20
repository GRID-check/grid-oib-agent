# Agent-authored documents — design

Date: 2026-08-20
Status: **built** — see [As built](#as-built-2026-08-20) for where the code
differs from this design, and why.
Branch: `claude/piloti-filesystem-write-design-mftg4d`

Related: [file-native work objects](2026-08-13-file-native-ownership-design.md)
(merged, PR #416), [ADR-0032](../../adr/0032-shareable-resource-model.md),
[ADR-0042](../../adr/0042-object-storage-durability-and-quota.md),
[ADR-0047](../../adr/0047-assignment-is-not-access.md),
[ADR-0038](../../adr/0038-one-authorization-catalog-and-decision-point.md),
[ADR-0011](../../adr/0011-deletion-pipeline.md).
Long-form exploration this narrows:
[`piloti-filesystem-design.md`](../../architecture/piloti-filesystem-design.md).

## Problem

A commissioned deep-research run costs minutes of compute and a budget draw and
produces exactly one thing the office wanted: a report. That report is written
by `writer-agent` to `/shared/output.md`, read back out by
`_extract_final_markdown`, returned as a chat message, and **discarded** — the
run's whole file system with it
(`src/aiq_agent/agents/deep_researcher/agent.py`, `deepagents_runtime.py`).
There is even a fallback that mines the last assistant message when the file is
missing, which is the code saying the file, not the message, was the artifact.

`docs/roadmap/feature-opportunities.md` rates "a deliverable an architect can
hand to the authority" **very high**. `frontends/ui/src/lib/answer-export/`
already renders a saved answer to an authorized `.docx`. The gap is not that the
deliverable cannot be produced — it is that it lands in *Downloads* instead of
in the project, where it could be found, assigned, previewed and deleted like
every other piece of evidence.

Two failure modes make the naive fix worse than the gap:

1. **Ingesting it.** A document the agent wrote, embedded into the project
   corpus, is retrievable as evidence *for the agent*. Turn 3 asserts a
   fire-compartment area; turn 9 cites it back with a green *Projektwissen*
   badge, indistinguishable from a stamped Gutachten. This is the default
   behaviour of a write-capable agent over its own RAG corpus, not a rare
   prompt going wrong.
2. **Writing it from the backend.** The agent's principal is **wider** than the
   user's, not narrower: it holds the shared `GRID_INTERNAL_API_TOKEN`, and the
   internal memory route says so in its own comment — *"this service-token
   endpoint cannot verify the human's org role"*
   (`app/api/internal/memory/route.ts`). A project-scoped write through
   `withOptionalTenant(undefined)` resolves to `withPlatformAccess`. Adding a
   second service-token write path widens that surface.

## Decisions

1. **An agent-authored deliverable is a `documents` row.** Not a node, not a
   blob store, not a new resource type. It rides the Files pages, assignment,
   sharing, quota, export and deletion that shipped with file-native work
   objects. ADR-0042 is explicit that there is one admitting path and that
   *"bytes written outside the document service have no row and are invisible
   to it"* — so a second store would silently defeat the quota that already
   exists (`lib/storage/admission.ts`, `admitOrDiscard`).

2. **Authorship is provenance, and provenance is never responsibility.** New
   columns `authored_by` (`user` | `agent`) and `authored_by_run_id`. The
   file-native spec already fixed this separation — *"Provenance — who put the
   bytes here (`createdBy`). Keep. Never render as 'verantwortlich'"* — and
   this is the change that makes it load-bearing rather than tidy.

3. **`Unvergeben` is the promotion primitive.** A generated report lands with
   **zero assignees**. The human act that turns Piloti's draft into somebody's
   work product is `Zuweisen`, the gesture that already exists, already renders
   as a word rather than an empty avatar, and already has a project-health
   ritual around it (F9, *"the lead clears Unvergeben before the
   Einreichung"*). There is no new card, no new modal, and no new word for
   "promotion". For a product where a Ziviltechniker carries the liability,
   "nobody is on the hook for this yet" is exactly the right default and it was
   already designed.

4. **The BFF writes it, in the commissioning user's session.** The report is
   already proxied through `GET /api/jobs/async/job/{id}/report`. On completion
   the BFF renders it with `answer-export/` and inserts it through
   `admitOrDiscard`, gated on `requireProjectAccess(session, projectId,
   ['project:documents:write'])`. **The agent never writes.** This deletes the
   principal problem rather than mitigating it, and it makes the capability a
   catalog fact an org can withhold, which is what ADR-0038 §3 created
   `project:documents:write` for.

5. **Agent-authored documents are never ingested.** No `/v1/ingest` dispatch,
   so no chunks ever exist. Self-citation becomes **unrepresentable rather than
   filtered** — which matters because the retrieval path's documented posture
   is fail-*open*: `rag-system-audit-2026-08.md` §9 records a filter that
   failed to translate, was logged at DEBUG, and *"produced a confident answer
   from an empty knowledge layer, invisibly."* A safety invariant must not be a
   predicate in that path.

6. **A new terminal status, `stored`.** `pending → processing → processed |
   error` has no state for "the bytes are here and indexing was deliberately
   skipped", and leaving such a row at `pending` renders a spinner that never
   resolves. `stored` is terminal, and its designed state is the honest one:
   no `Piloti dazu fragen`, hint *"Von Piloti erstellt — nicht in der
   Wissensbasis"*.

7. **Provenance survives the export.** The `.docx` carries a first-page
   *"KI-generiert — nicht geprüft"* block and a `docProps` custom property. The
   grey chip is chrome; the block is the artifact — and the artifact is what
   reaches the Behörde, which is where liability starts.

8. **One destination: a fixed `Berichte` folder, created on first use.** The
   deep-research submit form names it before the run, so authorization is
   **commissioned** — the user asked for a report and was told where it goes —
   rather than confirmed afterwards by a modal that is only ever answered yes.

   > **As built — there is no submit form.** This decision named a surface that
   > does not exist; the disclosure lives on the `starting` banner instead. See
   > [As built §1](#1-the-disclosure-verbatim).

   Build note: `project_folders` has **no uniqueness on `(project_id,
   parent_id, name)`** — the only unique constraint is `(id, project_id)`,
   which exists to satisfy the composite foreign keys. A naive get-or-create
   therefore duplicates the folder under two runs finishing at once. Add the
   unique index in this change and make the create an upsert; it is a
   one-line migration and the alternative is a project with two `Berichte`
   folders and no way to say which is real.

9. **The folder is a convenience; `authored_by` is the index.** How a report is
   *filed* and how it is *found* are different questions, and tying the second
   to the first is what makes a folder convention load-bearing. Every "show me
   what Piloti wrote" surface queries the column:

   - a partial index `documents_agent_authored_idx ON documents (project_id,
     created_at DESC) WHERE authored_by = 'agent'` — partial for the same
     reason `documents_conversation_idx` is, since agent rows are the small
     minority;
   - a `Von Piloti` filter chip beside the existing `Alle · Meine ·
     Unvergeben` strip, ANDed with folder and search like the others;
   - `authoredBy` as a listing filter on the documents API.

   So moving, renaming or abandoning `Berichte` later costs nothing, and a
   future "everything Piloti has written for this project" view is a query
   that already works rather than a migration. Cross-**project** aggregation is
   deliberately out of v1 — there is no cross-project document surface today
   (`cross-project-rag-vision.md` is a vision doc, not a feature) — but the
   column is what makes it a listing change rather than a data change.

10. **Interactive runs only.** A scheduled job (`jobs.schedule_cron`) has no live
   session, so its write would have to resolve `triggered_by`'s permission in
   the scheduler worker. That is a real design, and it is v1.1.

## What this is not

Cut deliberately, each with the reason:

| Cut | Why |
|---|---|
| A node / version / blob store, `fs_edit`, exact-string patches | Nothing in the repo reports an agent-authored report being edited. Versioning solves an unobserved problem and is the largest cost item in the exploration. |
| Mounts as an implementation | Nine mounts × seven capability bits is a second authorization model living outside `catalog.ts`. One writable destination, one catalog permission. |
| Saved `.view` selectors, the context digest | `shelves_for_turn` already implements ceiling ∩ intent, and the digest only wins on a measurement nobody has taken. |
| `run:/` streaming, a work drawer, the `/work` tier | Watchable runs are a real want and a separate change. Nothing here depends on them. |
| Modal / sandbox execution | A procurement decision (`compliance/external-dependencies.md` lists it as a non-default subprocessor), not a design decision. |
| Chat-turn writes, skills, memory, Archiv, re-ingestion | Each is a second consumer. One first. |

## Data model

Migration `00NN`:

```sql
ALTER TABLE documents
  ADD COLUMN authored_by text NOT NULL DEFAULT 'user',
  ADD COLUMN authored_by_run_id text;

-- Every existing row means exactly what the default says, so no backfill is
-- needed or wanted (the ADR-0043 `storage_bucket` reasoning, applied again).
ALTER TABLE documents
  ADD CONSTRAINT documents_agent_authorship_check
  CHECK (authored_by <> 'agent' OR authored_by_run_id IS NOT NULL);
```

Plus the partial index from decision 9 — `WHERE authored_by = 'agent'` — which
carries no entry for the overwhelming majority of rows and is what makes "show
me everything Piloti wrote" a point query rather than a scan. And the folder
uniqueness the fixed destination needs:

```sql
CREATE UNIQUE INDEX uniq_project_folders_parent_name
  ON project_folders (project_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
```

`createdBy` stays the commissioning user — they caused the bytes to exist, and
the export and the audit both need a human to name. `authored_by` says whose
hand wrote them. The two are different questions and ADR-0047's rule is that
they must not collapse.

## Flows

- **G1 — Commission.** Deep research submit form shows `Bericht wird abgelegt
  in: Projekt › Berichte`. Run completes. Report lands as a document,
  `authored_by = 'agent'`, `status = 'stored'`, zero assignees. Toast:
  *"Bericht abgelegt · Zuweisen · Öffnen"* — the existing ingest-toast pattern
  with its two actions.
- **G2 — Find it.** It appears in Files with `Unvergeben` in the footer and a
  quiet `Von Piloti erstellt` line. The `Unvergeben` filter chip finds it, which
  is the same chip the lead already uses before an Einreichung.
- **G3 — Take responsibility.** `Zuweisen` → `Mir zuweisen`. One
  `resource_assignments` row, one audit event. Nothing about the document
  changes except who is on the hook — which is the whole point.
- **G4 — Hand it over.** Download carries the marking block and the custom
  property.
- **G5 — Erase it.** Inherits `deleteDocument`, which already purges
  collaboration, assignments, chunks, the object, the thumbnail and the BIM
  siblings. **Verified: an agent-authored document is erasable on day one** —
  the missing `document` purger (`purger/index.js:61`) governs the *queued,
  graced, legal-hold* path, not erasure.
- **G6 — Failure.** The write happens at completion, so a run that dies leaves
  no partial document and nothing to clean up. A quota refusal deletes the
  object and surfaces `InsufficientStorageError` on the job result, unchanged
  from every other upload.

## Substrate lifts in this change

Correlated debt, per `AGENTS.md` — these are things this change trips over, so
they land here as their own commits rather than being worked around:

1. **The audit trail cannot name a non-human actor.** `lib/audit/service.ts`
   hardcodes `actor: {type: 'user', id: input.actor.userId}` and the emit
   *"Never throws"*. A `document.generated` event needs an agent actor kind, a
   `run_id`, and a non-swallowing emit **on this path** — an audit record that
   silently does not exist is worse than none, because the enterprise answer to
   *"who authorized this document"* has to be a record, not a log line.
2. **The `stored` status must be exhaustive.** Every switch over document
   status gets the new member as a compile error, the way `DOCUMENT_SCOPES`
   does it.

Explicitly **not** lifted here, with reasons: the `document` purger (owed for
grace/hold semantics, not a prerequisite — G5), and ADR-0042's backup posture
(a deployment decision; this change adds no new store, so it does not worsen
it). Both are named in the ADR addendum so neither goes unread.

## What the build changed about this design

Three things the design got wrong, found by building it and then attacking it.
Recorded here rather than quietly corrected, because each was a reasoned
position and the reason it failed is the useful part.

**1. "Commissioned" was weaker than claimed, and the form does not exist.**
Decision 8 rests on the user being told where the report goes *before* the run.
There is no submit form: interactive deep research escalates from a chat turn,
and `DeepResearchBanner` carries an `escalationReason` — so a run can start
because the classifier decided to, not because anyone asked for a report. Both
halves of "the user asked for a report and was told where it goes" were
therefore false. The disclosure now lives on the **starting banner**, which is
the moment the user can still stop it; the success banner links to the filed
document, and says nothing at all when filing did not happen.

**2. The no-ingest invariant belonged at the dispatch site, not in the writer.**
The spec put it in `fileGeneratedDocument` and the test asserted it there. That
proves the *filing path* does not ingest — a claim about one function, where the
design's claim is about the document. `reindexProject`, behind „Projekt neu
indizieren", enumerated every document in a project and re-dispatched it, and an
agent-authored row passed its guard: `stored` is neither `pending` nor
`processing`, and the row carries a real storage key and the project's own
collection. One click made the report citable Projektwissen — and because the
not-citable UI derives from `status` rather than from `authored_by`, it then
*looked* like an ordinary indexed document.

The invariant now sits in `dispatchDocument`, the one place every ingestion path
funnels through, and it reads the row instead of trusting an argument. The
general lesson is the one ADR-0042 already states about admission: an invariant
enforced at each caller is an invariant each caller can forget.

**3. `status` and `authored_by` are not interchangeable, and the UI conflated
them.** Every not-citable affordance derived from `status`. That was fine while
`stored` implied agent-authored, and wrong the instant anything moved the row
out of `stored`. Provenance is the durable fact; status is a lifecycle position.

## The weakness this design has, stated plainly

**Filing is a side effect of a GET, and no server-side completion signal
exists.** The backend does not call the BFF when a deep-research job finishes —
there is no internal jobs route and no callback — so the BFF only learns a run
completed when a client asks for its report. Filing therefore happens when
somebody's browser makes that request: once at success (`fileCompletedReport`),
and again on any later view of the report from history.

What follows from that, precisely:

- A report **nobody ever looks at again** is never filed. The starting banner's
  „wird abgelegt" is true for every report anyone opens, and false for one that
  is commissioned and then abandoned.
- **Scheduled runs cannot file at all** (already excluded by decision 10) for
  exactly this reason: there is no client.
- A GET carries a write. That is REST-unclean and would be dangerous if the
  write were not idempotent — migration 0064's unique index is what makes a
  prefetch, a double-open or a retry harmless rather than a duplicate.

The durable fix is one thing, not two: **a backend completion callback into an
internal BFF route.** It removes the client dependency, and it is the same seam
scheduled filing needs — so v1.1 should build one mechanism, not two. Until then
the honest description of this feature is *"a report is filed when it is
delivered"*, not *"when it is finished"*.

Rejected on the way here: intercepting the proxied SSE stream to file when the
completion event passes through. The BFF does see that event, but the job proxy
deliberately never buffers an SSE body, and threading a side effect through a
pass-through stream trades a clear dependency for a fragile one.

## Extension points

The scope is one producer, one destination. The *seams* are wider than the
scope on purpose, and only where widening is free now and expensive later. Each
of these is a shape, not a feature: nothing below is built in v1.

| Seam | Shape in v1 | What it costs to add the second one |
|---|---|---|
| **Who wrote it** | `authored_by` is a growable tuple (`user`, `agent` today), not a boolean. `authored_by_producer` names the producer; `authored_by_run_id` names the run. The CHECK generalises to *any non-`user` author must name both*. | A tuple member. No migration, no argument about what `agent` used to mean. A run id alone cannot tell a compliance export from a research report, and recovering the producer later is archaeology through pruned job history. |
| **What produced it** | One service function — `fileGeneratedDocument({ producer, runId, projectId, folder, render })` — is the only way a machine-authored document is created. The jobs completion path is its first *caller*, not its implementation. | A call site. This is ADR-0042's "one admitting path" applied one level up: a second producer that copies a route handler is how the quota, the audit emit and the no-ingest rule stop being true for half the rows. |
| **Whether it files automatically** | The commissioned-vs-confirmed choice is read from one resolver, not an `if` in the jobs route. v1's resolver returns a constant. | Replacing a constant with a lookup. Enterprise will want this per organization — the precedent is `platform_model_defaults` overridden by an org row (ADR-0014/0022): platform default, tenant override, explicit beats inherited. |
| **Where it lands** | A fixed `Berichte` folder, resolved by the same function that will later read a policy. Finding is by `authored_by`, never by folder. | A column on that policy. Moving or renaming the folder never breaks discovery, because discovery never used it. |
| **Whether it is retrievable** | Not ingested, so no chunks exist. | A deliberate decision with a name. If a tenant ever wants generated reports searchable, that is a *policy* granting ingestion for a producer — and it must arrive together with the labelled-citation work, never before it. |
| **What may be generated** | A research report, rendered by a caller-supplied `render` function. Shipped as a `.docx`; now a PDF — see [As built §6](#6-the-filed-report-is-a-pdf). | A renderer. The service takes a render function, so a BCF export, a Prüfbuch or a Massenermittlung is a new caller with a new renderer, not a new pipeline. |

What is deliberately **not** left open: agent-authored content becoming
instructions (`/skills`, the project profile), and any write path that does not
pass through the one service function above. Those two closed doors are what
keep the rest of the seams safe to open.

## Operational prerequisite

`document.generated` and the `agent_run` target must be registered in WorkOS
before the first real emit, or the audit write is rejected at the API:
`npm run provision:audit-schemas -- --apply`. This is a deploy step, not a code
step, and it is why the audit commit lands first.

## Atomic commit sequence

1. `feat(audit): the audit trail can name an agent actor` — actor kind, run id,
   non-swallowing emit on registered paths. Substrate lift, alone.
2. `feat(documents): authorship is a column, and it is not responsibility` —
   migration, schema, `stored` status + exhaustiveness, repository.
3. `feat(documents): a commissioned report is filed into the project` — the BFF
   commit path at job completion, `requireProjectAccess` + `admitOrDiscard`,
   behind a flag.
4. ~~`feat(research): the submit form names where the report lands`.~~
   **Landed as** `feat(research): the starting banner names where the report
   lands` — there is no submit form (see *What the build changed about this design* §1,
   and [As built §1](#1-the-disclosure-verbatim) for the copy).
5. `feat(export): a generated document says so, in the file itself`.
6. `feat(files): Piloti-authored files read as unclaimed` — authorship line,
   the `stored` state, toast actions, `/dev` preview.
7. `docs:` schema, ADR-0032/0047 addenda, the `filed` field in
   `docs/api/bff-routes.md`, the user guide, and the exploration doc marked as
   narrowed **and built** by this one — see [As built §3](#3-documentation-this-change-owed-and-where-it-landed).

## Testing

- **The ouroboros test, in CI, forever**: a document with `authored_by='agent'`
  produces no collection write and no chunks; asserted at the dispatch site, not
  by inspecting retrieval output.
- Quota: a refusal deletes the object and leaves no row (reuse the existing
  `admitOrDiscard` spec shape).
- Authorization: the commit path is refused for a session without
  `project:documents:write`; `authz-coverage` names the route.
- RLS: an agent-authored row is invisible cross-tenant.
- Assignment: zero assignees is valid; assigning writes one row and one audit
  event; delete cascades.
- Export: the marking block and the custom property are present; a
  `label-coverage`-style test so DE/EN both carry it.
- UI: `/dev` preview and screenshots for the authorship line, the `stored`
  state and the toast — the vertical is not done until F-style walkthroughs G1,
  G3 and G5 have been done in the browser.

## Cost

Two to three engineering weeks for commits 2–7, because assignment, sharing,
quota, export, preview and deletion all landed with PR #416 and this change
consumes them rather than building them. Commit 1 (audit) is the unknown: it
touches a WorkOS-schema-validated emit, and if the actor schema needs
registering upstream it is the long pole.

This estimate assumes the report renders through `answer-export/` unchanged. If
a research report needs a different block vocabulary than a saved answer, add a
week.

## As built (2026-08-20)

The section above says what the design got **wrong** and why. This one says what
the code now **does**, for the two places where reading the design would leave a
reader with the wrong picture, plus what the change owed elsewhere.

### 1. The disclosure, verbatim

Decision 8's surface does not exist (see *What the build changed about this
design* §1). What shipped instead:

**On the `starting` banner** — one quiet line under the existing subheading,
shown only when the chat is inside a project, because outside one nothing is
filed:

> DE: „Der fertige Bericht wird in diesem Projekt unter „Berichte“ abgelegt.“
>
> EN: "The finished report will be filed in this project under “Berichte”."

It is on the *starting* banner and nowhere else. That is the only moment the run
can still be stopped, and a disclosure the reader cannot act on is decoration.
It renders equally under an `escalationReason`, which is the case that needs it
most: nobody ordered that run, so this line is the whole of what they were told.

**On the `success` banner** — the report route's response carries an additive
`filed: { documentId, filename, alreadyFiled }`; the banner names the file and
adds one action beside *Bericht anzeigen*:

> DE: „Im Projekt abgelegt: {filename}“ · **Im Projekt öffnen**
>
> EN: "Filed in the project: {filename}" · **Open in Project**

Two actions, two destinations: the research panel, and the file in the project
through `documentFilesHref` — the same `/files?doc=` shape the Files feature and
the sharing registry's `document` descriptor already use, never a second URL for
the same place.

**When nothing was filed and nothing was promised, the banner says nothing about
a file.** Absence is a normal answer, not a pending one: a projectless chat, or
a run that finished before this existed. A hedge ("a file may have been
created") would be worse than silence, and a dead link worse than both.

**When a filing was promised and then failed, the banner takes the promise
back.** This is the one absence that is not silent, and it is a distinction the
first cut of this section did not draw. The report route separates the two
(`filingFailed`, see [`bff-routes.md`](../../api/bff-routes.md)): the flag is
raised only when a project was resolved — the same condition under which the
starting banner printed the disclosure. So the reader who was told „wird
abgelegt" is exactly the reader who is told it did not happen, and nobody else:

> DE: „Der Bericht konnte nicht unter „Berichte“ abgelegt werden.“
>
> EN: "The report could not be filed under “Berichte”."

The rule it obeys is still *never claim a file that does not exist* — a
retraction claims no file. What it adds is the reason that rule was not the
whole answer: **a promise was made.** Saying nothing does not spare the reader
the failure; it sends them to Berichte to discover it alone, with the only
record in a server log they cannot read. The disclosure is also what stands in
for a consent step (no modal, by decision), so a promise that can be silently
dropped is a consent step that can be silently voided.

It is said in the register the promise was made in: one muted line in the same
`text-subtle text-xs` slot, inside a banner that stays `success` because the
RESEARCH succeeded. No red, no icon, no `warning` variant — colour in this
product belongs to provenance — and **no reason**, because a refused quota, a
revoked `project:documents:write` and a report too long to render are one fact
to an architect: the document is not there. The reasons name buckets,
permissions and limits, and those are for the operator reading the log.

**No modal, no confirmation, no second consent step** — unchanged from the
design, and now held by a test rather than only by argument.

Filing is observed on `GET …/report`, so a run watched to completion in the tab
that started it asks for its own report once, at success, purely to trigger the
filing — best-effort, swallowed on failure, and skipped entirely without a
project. Evidence: `/dev/research-filing` and the `research-filing` screenshot
target, both themes, desktop and mobile.

### 2. Two things the design assumed were already true, and were not

Both meant the feature had **never once worked end to end** in a real
deployment, which is why they are recorded rather than folded into a fix:

- **The audit metadata key was unregistered.** `fileGeneratedDocument` sent
  `producer`; the WorkOS schema did not declare it. A schema with the wrong keys
  rejects an event exactly like a missing one — and because this path uses the
  *throwing* emitter (substrate lift 1), a rejection does not lose an audit
  line, it **unfiles the document the line was about**. Every commissioned
  report was filed and immediately deleted, and the reader saw neither a file
  nor an error. "Operational prerequisite" above is therefore not paperwork; it
  is a step whose omission is silent.
- **The compensation's two steps were coupled.** Sharing one `try` made the
  object delete conditional on the row delete succeeding, so the single failure
  the ordering was chosen to survive skipped the object and left a filed,
  quota-charged, visible „Von Piloti erstellt" row with no audit record. The
  ordering was always right; the coupling never was.

### 3. Documentation this change owed, and where it landed

- `docs/database/schema.md` — the columns, the CHECK, the partial index and the
  folder uniqueness.
- [ADR-0047 addendum](../../adr/0047-assignment-is-not-access.md) — provenance as
  a **fourth** relation, never rendered as responsibility; the `document` purger
  still unimplemented (so grace/hold semantics do not cover these rows, while
  immediate erasure does, via `deleteDocument`); ADR-0042's backup posture still
  Proposed.
- [ADR-0032 addendum](../../adr/0032-shareable-resource-model.md) — the shareable
  model needed no amendment for a machine-authored row, which is the finding.
- [`docs/api/bff-routes.md`](../../api/bff-routes.md) — the additive `filed`
  object and the `projectId` query parameter.
- [`docs/user-guides/agent-authored-reports.md`](../../user-guides/agent-authored-reports.md)
  — what an architect sees.
- [`docs/architecture/piloti-filesystem-design.md`](../../architecture/piloti-filesystem-design.md)
  — the exploration marked as narrowed **and built**, with the parts that remain
  unbuilt named so it is not read as a plan of record.

### 4. Still open, unchanged by the build

Open question 3 (filename search must not leak `stored` rows into a retrieval
surface) and open question 4 (scheduled runs, v1.1) are untouched. Decision 10
holds in the code by construction: the report route files nothing without a live
session and a `projectId`, and there is no BFF path on which a cron run reaches
that handler.

### 5. One permission was not a choice, so there are now two

Decision 4 gated the filing on `project:documents:write` and called that "a
capability an organization can withhold, which is what ADR-0038 §3 created
`project:documents:write` for". The second half was false. That permission also
authorizes an ordinary **human upload**, a delete and a whole-project re-index
(`lib/documents/service.ts`), so an organization that wanted Piloti to answer
without writing into its file system had exactly one lever, and pulling it
stopped its own architects uploading plans.

`project:documents:generate` is now required **in addition** at the seam, never
instead — a conjunction, argued at the checks themselves and recorded in
[ADR-0047's third addendum](../../adr/0047-assignment-is-not-access.md): that ADR
adds relations rather than substituting them; a standalone `generate` would let a
role write bytes it cannot upload and cannot delete, rebuilding in the catalog
the wider principal decision 4 deleted from the request path; and the conjunction
is what keeps ADR-0047's sentence about what `authored_by = 'agent'` *means*
literally true. The legacy `project:edit` umbrella is deliberately not accepted
for it — a permission every pre-split role already implicitly holds is exactly
the un-withholdable lever this one exists to replace, so nothing holds it until
`provision:authz --apply` has run.

The commit plan's "behind a flag" also landed, and it is a different instrument
rather than a duplicate. The permission is the tenant's, per project and per
role, withheld on a custom role. Withdrawing it fleet-wide would mean editing the
built-in project roles in the catalog, which `provision:authz --check` then fails
in CI — so the operator's kill switch has to be the `agent-authored-documents`
flag (`GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED`, default ON), checked at the same
seam so every producer rides one switch rather than one each.

### 6. The filed report is a PDF

The seam was real, and this is the proof: changing the output format was **a new
renderer at an existing call site**, not a new pipeline. `fileGeneratedDocument`
is untouched; `research-report.ts` swapped `answer-export/docx` for
`@/lib/pdf/markdown-pdf` and passed the same two provenance options.

**Why the format changed.** `PREVIEW_TYPES` in
`features/documents/components/file-preview-pane.tsx` lists what the Files pane
can render — `application/pdf` and images. `.docx` is not among them, so the
report a user had just commissioned landed in Berichte as a generic icon with no
in-app preview, download-only, for the one document in the project nobody had
read yet. An Einreichung attachment is a PDF anyway. The saved-answer `.docx`
export is untouched and stays: that document exists to be edited into a Befund,
this one to be read and handed on.

**What the marking cost.** Decision 7's two forms both survive, but only one of
them survives intact. The printed „KI-generiert — nicht geprüft" block is the
same block, from the same `answerExport.aiNotice.*` keys — there is still
exactly one German sentence and one English one, now shared by two renderers
through `@/lib/ai-provenance`, which also owns the property NAMES so the two
formats cannot drift apart on what a detector matches.

The machine-readable half is weaker in a PDF and that is worth stating rather
than glossing: **`@react-pdf/renderer` 4.6.0 exposes no custom-property or XMP
facility.** `<Document>` accepts only the PDF Info-dictionary fields, which the
library maps one-for-one onto PDFKit's `info` (checked in
`node_modules/@react-pdf/renderer/index.d.ts` and `lib/react-pdf.js`; PDFKit's
own `appendXML` is reachable only through the PDF/A/PDF-UA `subset` option,
which `<Document>` does not expose). So the four properties ride in `Keywords`
as `AIGenerated=true; AIGenerator=Piloti; AIHumanReviewed=false; AIRunId=…`,
with `Creator` = `Piloti` and `Subject` = the notice headline. A `.docx` names
its properties; a PDF only lists them. If react-pdf grows an XMP escape hatch,
`aiProvenanceKeywords` is the one function to change.

**A route that was outside every gate.** `POST /api/generate-pdf` — the research
panel's Download-PDF button — was a **Pages-Router** handler with no session
check at all: it rendered caller-supplied markdown for anyone who could reach
the origin. It was not an exempted route; `authz-coverage.spec.ts` walks
`app/api/**/route.ts`, so a handler under `pages/` was invisible to the
inventory and to `apiRoute`'s required `authz` argument alike. It is still used,
so it was moved rather than deleted: same path, now `app/api/generate-pdf/route.ts`
through `apiRoute` with `sessionOnly` and the factory's default mutation budget.
`src/pages/` no longer exists, which is what stops the next handler from landing
in the same blind spot.

**The move also dropped a limit nobody had written down.** The Pages handler
declared no `config`, so Next's `api.bodyParser.sizeLimit` default of 1mb
bounded every request to it. App Router handlers inherit no such default —
`serverActions.bodySizeLimit` governs Server Actions only — so after the move a
`markdown: z.string().min(1)` stood alone in front of `renderToStream`, whose
cost is superlinear in the input, against a budget that admits 300 mutations per
member per minute. Both bounds are now explicit (1 MiB body at the route,
64 KiB markdown in the renderer), each with its measurement.

**One measurement this document used to carry has been retracted.** It read
"32 KiB renders in 2.9 s, 64 KiB in 10.9 s, 128 KiB in 61 s". The 61 s could not
be reproduced — prose of that size renders in 1.4 s. The number was right about
the danger and wrong about the cause: what costs a minute is not 128 KiB, it is
128 KiB of TABLES, and the sharper edge is memory rather than time (1.2 GB of
peak RSS is not a slow response, it is an OOM that takes every request in the
container with it). The conclusion — 64 KiB — survives; the reasoning behind it
did not. `lib/pdf/markdown-pdf.ts` carries the corrected table, by shape rather
than by size, and is the source to trust over this paragraph. The general lesson is the same one the authz hole taught, from the
other side: **what a framework move deletes is not always a line — it can be a
default**, and a default leaves no diff to review.

## Open questions

1. ~~Which folder?~~ **Resolved:** a fixed `Berichte` folder, with finding
   them driven by `authored_by` rather than by the folder (decisions 8–9).
2. ~~Re-runs.~~ **Resolved:** a second run makes a second document. A report is
   dated; supersession is where versioning creeps back in.
3. **Should `stored` documents be searchable by *filename* in the Files pane?**
   Yes — they are files. Confirm this does not leak them into any retrieval
   surface that reads the same index.
4. **Scheduled runs (v1.1)**: the scheduler resolving `triggered_by`'s
   permission at fire time is the design; whether a revoked permission should
   fail the run or fall back to no filing is a product call.

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
   > [As built §1](#1-the-disclosure-moved-because-the-surface-it-named-does-not-exist).

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
| **What may be generated** | A `.docx` rendered from a research report. | A renderer. The service takes a render function, so a BCF export, a Prüfbuch or a Massenermittlung is a new caller with a new renderer, not a new pipeline. |

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
   lands` — there is no submit form (As built §1).
5. `feat(export): a generated document says so, in the file itself`.
6. `feat(files): Piloti-authored files read as unclaimed` — authorship line,
   the `stored` state, toast actions, `/dev` preview.
7. `docs:` schema, ADR-0032/0047 addendum, user guide, and the exploration doc
   marked as narrowed by this one.

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

What the code does where it differs from the design above, and what review found
that the design had got wrong. Nothing here is a change of intent; each is the
same intent surviving contact with the repository.

### 1. The disclosure moved, because the surface it named does not exist

Decision 8 rests the whole authorization argument on one sentence: the filing is
**commissioned** because *"the deep-research submit form names it before the
run"*. **There is no deep-research submit form.** Deep research escalates out of
an ordinary chat turn — `useDeepResearch` / `use-websocket-chat.ts` add a
`starting` banner when the backend reports a job, and that banner already
carries an `escalationReason`, which means **a run can begin because the
classifier decided it should, not because a person asked for a report.**

So the design's premise was false twice over: the user was never told where the
report goes, and "the user asked for a report" is not reliably true either.

The honest version, built:

- **The `starting` banner discloses the destination.** One quiet line under the
  existing subheading — DE *„Der fertige Bericht wird in diesem Projekt unter
  „Berichte“ abgelegt."*, EN *"The finished report will be filed in this project
  under “Berichte”."* — shown only inside a project, because outside one nothing
  is filed. It sits on the *starting* banner and nowhere else, because that is
  the only moment the run can still be stopped, which is the only thing that
  makes a disclosure worth anything.
- **The `success` banner offers the file, when there is one.** `filed:
  { documentId, filename, alreadyFiled }` rides back additively on the report
  route's response; the banner names the filename and adds one action,
  *Im Projekt öffnen*, through the same `/files?doc=` deep link the Files
  feature and the sharing registry already use. When `filed` is absent — a
  projectless chat, a withheld `project:documents:write`, a refused quota — the
  banner says **nothing** about a file rather than hedging about one.
- **No modal, no confirmation, no second consent step.** Unchanged from the
  design, and now guarded by a test rather than only argued for.

The evidence is `/dev/research-filing` and the `research-filing` screenshot
target (both themes, desktop and mobile).

### 2. The no-ingest invariant moved to the dispatch site

The design (decision 5, and the "ouroboros test" under Testing) says the
invariant is asserted *at the dispatch site, not by inspecting retrieval
output*. The first implementation did not do that: `generated.ts` proved only
that the **filing path** does not ingest — a claim about one function, where the
claim that matters is about the **document**.

Adversarial review found a second caller that defeated it. `reindexProject`,
behind *"Projekt neu indizieren"* in Project Settings, enumerated every document
in the project and re-dispatched it. An agent-authored row passed its guard —
`stored` is neither `pending` nor `processing`, and the row carries a real
storage key and the project's own collection — so **one click put Piloti's
report into the corpus Piloti retrieves from**, after which the not-citable UI
(which derives from `status`, not from `authoredBy`) rendered it green, *Bereit*,
with *Piloti dazu fragen* enabled.

The fix is the design's own sentence, taken literally: `dispatchDocument` itself
refuses a machine-authored row, and refuses **by reading the row** rather than by
trusting an argument — a caller can forget to pass authorship, and a caller can
pass it wrongly, which is precisely what happened. One primary-key select in
front of an operation that is about to make an HTTP call is not a cost worth
trading the invariant for.

The general lesson, which is the reason this is written down: *"asserted at the
dispatch site"* was in the spec from the start, and an implementation still
satisfied the words while missing the point, because the assertion was placed at
the site of the **new** caller instead of at the **shared** one. A safety
invariant belongs at the narrowest point every caller must pass through, and a
test for it must be able to fail because of code the feature never touched.

### 3. Two things the design assumed were already true, and were not

Both found by the same review, and both meant the feature had **never once
worked end to end** in a real deployment:

- **The audit metadata key was unregistered.** `fileGeneratedDocument` sent
  `producer`; the WorkOS schema did not declare it. A schema with the wrong keys
  rejects an event exactly like a missing one — and because this path uses the
  *throwing* emitter (substrate lift 1), a rejection does not lose an audit
  line, it **unfiles the document the line was about**. Every commissioned report
  was filed and immediately deleted, and the reader saw neither a file nor an
  error. The "Operational prerequisite" section above is therefore not optional
  paperwork; it is a step whose omission is silent.
- **The compensation's two steps were coupled.** Sharing one `try` made the
  object delete conditional on the row delete succeeding, so the single failure
  the ordering was chosen to survive skipped the object and left a filed,
  quota-charged, visible *„Von Piloti erstellt"* row with no audit record. The
  ordering was always right; the coupling never was.

### 4. Documentation this change owed, and where it landed

- `docs/database/schema.md` — the columns, the CHECK, the partial index and the
  folder uniqueness.
- [ADR-0047 addendum](../../adr/0047-assignment-is-not-access.md) — provenance as
  a **fourth** relation, never rendered as responsibility; the `document` purger
  still unimplemented (so grace/hold semantics do not cover these rows, while
  immediate erasure does); ADR-0042's backup posture still Proposed.
- [ADR-0032 addendum](../../adr/0032-shareable-resource-model.md) — the shareable
  model needed no amendment for a machine-authored row, which is the finding.
- [`docs/api/bff-routes.md`](../../api/bff-routes.md) — the additive `filed`
  object and the `projectId` query parameter.
- [`docs/user-guides/agent-authored-reports.md`](../../user-guides/agent-authored-reports.md)
  — what an architect sees.
- [`docs/architecture/piloti-filesystem-design.md`](../../architecture/piloti-filesystem-design.md)
  — the exploration marked as narrowed **and built**, with the parts that remain
  unbuilt named so the document is not read as a plan of record.

### 5. Still open, unchanged by the build

Open question 3 (filename search must not leak `stored` rows into a retrieval
surface) and open question 4 (scheduled runs, v1.1) are untouched. Decision 10
holds in the code by construction: the report route files nothing without a live
session and a `projectId`, and there is no BFF path on which a cron run reaches
that handler.

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

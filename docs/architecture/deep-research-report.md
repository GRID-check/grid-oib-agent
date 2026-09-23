# The deep research report: anatomy, findings, and the reader's lever

A planning office commissions a Prüfung, not a whitepaper: which requirements
apply to this project, is each one met, where is that written, and what is
still open. The unit of that work is a **Befund**, and since 2026-09 the deep
report is delivered around a list of them rather than as one wall of Markdown.

## What a finished report carries

| On the message | Produced by | Rendered as |
|---|---|---|
| `content` | the writer (`prompts/writer.j2`), verified and sanitised in `finalize.py` | the prose, with `[N]` markers and the sources row |
| `answer_meta` | one structured call over the finished report (`deep_researcher/anatomy.py`), gated by `common/answer_envelope.gate_answer_meta` | the same masthead a chat answer has: verdict when there is one copyable value, summary, topic, context; takeaways and callout after the prose |
| `findings` | the same call, under `common/findings.py` | the Befundmatrix between the masthead and the prose (`FindingsMatrix.tsx`), and a table in the Word export |
| `stages.followUps` | the follow-ups stage's own handler, run in the job runner under the org flag | the follow-up chips under the report |
| `retrieval_ledger`, `skills_hidden` | recorded on the deep state; lifted by `runner._extract_answer_transparency` | the Herleitung and the skills disclosure |

The extraction is post hoc on purpose: the writer's contract and the citation
verification stay untouched, the extraction cannot change a word of the report,
and a failure costs the reader the masthead and the matrix, never the report.
It runs beside the post-hoc cards and the memory reflection, in one gather.

## The findings contract

`common/findings.py` (pydantic) and `lib/conversations/message-findings.ts`
(sanitizer) describe one shape, pinned by `tests/fixtures/findings/wire_payload.json`,
which both sides validate. One row per requirement:

- `requirement`, `value` — the noun phrase and the copyable value.
- `status` — `erfuellt | nicht_erfuellt | offen | nicht_anwendbar`; `offen`
  means the report could not decide (a missing project fact, a pending Behörde).
  Null for a row the report states without judging it — a Vergleich's
  criterion, an Aktenvermerk's point — so the matrix is headed „Ergebnisse"
  rather than „Befunde" and wears no verdict it did not give
  (`Findings.judged()`, `hasFindingStatuses`).
- `grounding` — `belegt` when a cited passage states it, `abgeleitet` when it is
  computed from cited values, `offen` when no source carries it.
- `reference`, `citations` — the document and Punkt or page, and the `[N]` the
  report attaches; the matrix links each `[N]` to the answer's sources row.
- `comment`, `area` — what qualifies the status; the section it belongs to.

Every string is bounded on both sides, because the payload is jsonb and a table.

## The Rechercheplan, before the run

The plan is a row of its own, `research_plans`, with one HTTP API that the
clarifier, the reader and the worker all use (ADR-0065). Nobody owes it a
reply. The path of an escalated question:

1. The clarifier asks its clarifying questions, if any, then drafts the plan
   (`clarify.draft_plan`): sections, genre (`pruefbericht`, `aktenvermerk`,
   `vergleich`, `checkliste`, `bericht`), depth (`kurzpruefung`, `gutachten`),
   the documents to read and the ones to leave out. The decision model
   pre-selects genre and depth before the planner runs (`plan_decisions.py`).
2. The turn posts the plan and its run in one call (`POST /api/internal/tasks`,
   op `plan`, `turn/commission.commission_planned_run`). The run's block
   appears in the thread at once and carries the plan's id (`metadata.plan_id`).
3. The block shows the plan (`RunPlan.tsx`). Under `plan_approval: auto` it
   counts down `plan_grace_seconds` and the run starts on its own; „Anpassen"
   stops the clock and opens the plan as controls (`PlanChecklist.tsx`), every
   edit is a `PATCH`, and „Starten" approves. Under `plan_approval: ask` the
   plan is held from the start.
4. The worker takes its slot and waits on the plan
   (`aiq_api/jobs/plan_start.py`), asking `POST /api/internal/plans/{id}/start`
   until the plan may start. While the plan is held the ledger reads `wartet`,
   the status for a run waiting on a person; a countdown waits on nobody and
   leaves it `angelegt`, so no inbox row appears for an ordinary run. The plan
   it is handed then is the plan it runs, rendered into the same prompt text
   every deep-research prompt reads (`common/research_plan.render_plan_context`).
   Once started the plan is read-only.

„Bericht fortschreiben" on a run that had a plan carries that plan forward:
the new run's plan keeps the sections, genre, depth, Rahmen and exclusions,
adds the report's cited documents to its Grundlage, and is proposed with the
usual countdown (`carry-forward.continuationPlan`). A run without a plan
continues as before.

A reader can also write a plan from nothing: „Recherche planen" in the thread
header opens the same controls in a dialog (`PlanDialog.tsx`), and the plan is
created approved, so its run starts at once. The task card shows the plan as one
line (genre, depth, number of sections) from a copy frozen onto the run row
(`TaskPlan.research`).

Without a worker, the drafted plan runs in process as drafted: there is no
block to edit it on.

The approved plan is binding: it reaches the orchestrator, the planner and the
writer (`factory.py` `prompt_values`); the sections become the required
components in that order, the genre the answer type, the depth the length. The
`pruefbericht-writer` skill writes the genre's core, one Befund line per
Prüfpunkt in a fixed shape, which is also what the findings extraction reads.

### Unterlagen: what the run reads, and what it may not

The plan names documents as well as sections. It carries the turn's inventory
(`unterlagen`, the project's and the Archiv's documents by name, title and
shelf), and a dialog over the plan (`UnterlagenDialog.tsx`, mode `pick`) lets
the reader mark each one:

- **Grundlage** — read in full, whatever else the research finds. The planner
  is told to plan one dedicated query per document; the finalizer marks any it
  never opened (`## Nicht gelesene Unterlagen`, degraded token
  `grundlage_unread`), and the block's receipt lists each one as read, with
  the loci the rounds reached, or unread (`run-vocabulary.grundlageReceipt`).
- **Ausgeschlossen** — never used, not even when a search returns it. Enforced
  at the root, in the source registry: `SourceRegistryMiddleware` refuses the
  file name before it becomes a citable source, so no prompt discipline is
  relied on. An exclusion beats a Grundlage mark for the same name.
- **Rahmen** — the turn's data sources when the plan was drafted, shown as
  read-only chips. Fixed when the run is commissioned, because the worker
  filters its tools by the sources it was submitted with.

The plan names documents by file name, and the BFF resolves the names against
the plan's own inventory once, for every client (`lib/plans/service.ts`
`resolveNamedDocuments`). The worker reads the resolved lists off the plan it
is handed at start. `MAX_PLAN_DOCUMENTS` (20) bounds each list on every side.

While the run goes, „Dokument hinzufügen" on the block opens the same dialog
in mode `add`: the addition travels as a job event
(`POST /v1/jobs/async/job/{id}/documents` → `job.document_added`), the
worker's monitor hands it to the research tool before its next batch
(`deep_researcher/control.py` — `take_added_documents`, an
`ADDED_DOCUMENTS_NOTICE` on the batch result) and to the ledger fold, so the
receipt shows the new row at once. „Bericht fortschreiben" names the last
report's cited project and Archiv documents as the next run's Grundlage
(`carry-forward.ts` — `reportDocuments`).

## While the run is going

Each research round's notes state claims; the run ledger fold copies them onto
the round (`RunStep.findings`), so the block shows what has been established
so far and counts it in the header. The reader has one lever, „Jetzt
schreiben": the report is written from what is there
([`docs/design/run-block.md`](../design/run-block.md), *The actions*). The run
lands `unterbrochen`, with the truncation reason `user_requested` and a banner
that names the reader's choice rather than a limit.

## The report's afterlife

- **Into project memory.** The memory reflection over a finished report runs
  after the extraction and reads the report *with* its findings, one line per
  Befund, so a value lands as a fact and an open point as an open point
  (`runner._reflection_text`).
- **An open finding becomes a run.** A row whose status is `offen` or
  `nicht_erfuellt` offers „Klären": the thread commissions a research run
  briefed with that finding (`POST /api/projects/[id]/runs`,
  `commissionResearchRun`, the same door the agent's escalation uses), and the
  run's block appears in the same thread.
- **A report is carried forward.** A finished block offers „Bericht
  fortschreiben": a new run briefed with the report's findings
  (`features/runs/lib/carry-forward.ts`). The new report's matrix marks each
  finding `neu` or `geändert` against the most recent earlier run in the
  thread and names the ones that dropped out; the thread is the record, so
  the comparison needs no column.

## Language

The sources heading follows the report's language (`## Quellen` for German,
`## Sources` otherwise), and so does the honesty banner, detected off the
report itself (`finalize._prepend_honesty_banner`).

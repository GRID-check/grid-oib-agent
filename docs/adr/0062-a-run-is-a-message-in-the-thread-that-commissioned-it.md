---
status: proposed
date: 2026-09-16
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A run is one message in the thread that commissioned it, and its ledger is what the reader sees

## Context and Problem Statement

A deep-research run or a task run used to open a conversation of its own
(`createRunConversation`), and a person who clicked the task landed in a chat
that was not theirs: a banner, a side panel, and a stream of phase names
(`planning_started`, `citation_verification_started`) and tool names, held by
one `deepResearchJobId` slice that could follow exactly one run at a time.
Nothing about the run survived the run. `job_events` expire after 24 hours, the
report message carried no account of how it came to be, and a scheduled task
left one orphan conversation per fire.

The product owner's finding on 2026-09-15 was blunt: opening a task to see its
progress "is terrible", the deep researcher "is far too technical", and the
progress must stay in the main thread, never in a sidebar. The chat agent had
just gained a legible account of its own work, the retrieval ledger, rendered as
a Herleitung by intent (ADR-0061, `common/retrieval_ledger.py`). The run had no
equivalent, and the two agents shared none of the machinery that produced it.

## Decision Drivers

* One place. A person commissions work in a thread and expects to find its
  progress and its result there, as one thing they can scroll past.
* Durable and replayable. What a run did must outlive `job_events` and be the
  same whether read live, an hour later, or from a deep link.
* Legible. A step is named by the intent the runner stated, never by a tool
  name, and every document it reached is listed with its locus.
* Several at once. Two runs in one project must not share a singleton.
* One truth. Whatever a surface renders must be the same object the message
  stores; a client folding its own account from raw events is a second truth.

## Considered Options

1. Keep the run conversation and improve the side panel.
2. A `run_ledgers` table with its own page, joined to the task.
3. One assistant message per run in the commissioning thread, carrying the
   run's ledger as message metadata.

## Decision Outcome

Chosen option: 3. A run is a message, and the message is where the reader
already is.

What it consists of:

- **The run message.** Minted once the backend has accepted the work, in the
  conversation the work was commissioned from, with `run_id` set and
  `metadata.run_ledger` at `angelegt`, and recorded on
  `task_runs.run_message_id`. Its id is uuid5 of the run id
  (`lib/runs/service.ts`, `runMessageId`), so a retried submit is a no-op and
  a refused fire leaves nothing behind. The report is written into that same
  message when the run finishes: the worker, which holds only the backend job
  id, posts it to `/api/internal/runs/by-job/[backendJobId]/report` and the
  BFF resolves the pair; a 404 there means "this run has no message" and the
  worker writes the question-and-answer pair the old way, so the two services
  deploy in either order. The writer returns the id the report landed in, and
  that is what the ledger's `result.reportMessageId` names.
- **The ledger.** One contract, `RunLedger` (`lib/runs/run-ledger-types.ts`,
  zod), mirrored in Python (`common/run_ledger.py`, pydantic) and pinned by a
  committed JSON Schema (`tests/fixtures/run-ledger.schema.json`). Phases are
  the reader's words: `planen`, `recherchieren`, `pruefen`, `schreiben`,
  `abgelegt`. A step carries the intent the runner stated, the documents it
  reached with their loci, and open points. The terminal fact is a result (the
  filed report) or an error; never both. Sanitised on write and on read, like
  the retrieval ledger beside it.
- **Folding where the events are.** The Python job runner builds one
  `RunLedgerFold` per run (`aiq_api/jobs/run_ledger_fold.py`, never module
  level, ADR-0018) and wraps the event store, so every producer keeps writing
  as it did. The fold posts to the BFF through one primitive
  (`/api/internal/runs/[runId]/ledger`, ops `append` and `finish`, identity
  from the `task_runs` row and never from the body, ADR-0055) and emits a
  `run.ledger` snapshot into `job_events` on every flush. A fold failure never
  fails a run.
- **One stream per run.** The run id is the public key; the existing job
  event stream is reached through it, replayable from `last_event_id`, and a
  late subscriber gets the whole ledger with the next snapshot. A deep link is
  `?session=<conversation>&run=<runId>#message-<messageId>`, reusing the
  message anchor the sharing registry already emits; `?run=` alone resolves
  through `GET /api/projects/[id]/runs/[runId]`.
- **A definition owns a thread.** A task definition that fires gets one
  conversation, "Aufgabe: <title>", whose id is derived from the definition's
  (uuid5, `lib/tasks/task-thread.ts`), so "ensure the thread" is the primary
  key plus `ON CONFLICT DO NOTHING` and no unique index on
  `conversations.job_id` is needed (one could not be created on live data, where
  every earlier fire stamped its own conversation with that value). Every fire
  appends a run message there. Delegated work runs in the thread that asked
  for it, taken from the signed envelope, and falls back to the definition's
  thread when nobody typed.
- **The deep researcher speaks the same language as chat.** It opens the same
  lane-capture and retrieval-round scopes, states a conclusion per research
  batch, keeps the repeat-fetch guard, and records a retrieval ledger on the
  report, lifted into `common/` so neither agent owns it.

### Consequences

* Good, because the reader has one thing to look at, in the thread they were
  in, and it is the same object whether the run is live or a month old.
* Good, because several runs can be live in one project; nothing is a
  singleton any more.
* Good, because the surface that renders a run has one input, the ledger, and
  the vocabulary it renders is decided once, in the contract.
* Neutral, because the old run conversations stay as they are;
  `conversations.job_id` identifies them and nothing backfills a ledger for a
  run whose events have expired.
* Bad, because message metadata grows with the run. The sanitiser caps every
  list and string, and the tallies are derived, so the cap is the bound.
* Bad, because a cancelled run has no `finish` op: `abgebrochen` travels as
  the status of the last `append`, and a reader of the ops has to know that.
* Bad, because the UI that renders the ledger in the thread and retires the
  banner, the side panel and the `deepResearchJobId` slice is a second change
  (the Laufblock); until it lands, the run message shows its report and the
  old surfaces keep reading `job.phase`.

### Confirmation

The two languages cannot drift: `run-ledger-schema.spec.ts` exports the zod
contract to the committed JSON Schema and fails when it differs, and
`tests/aiq_agent/common/test_run_ledger.py` validates the pydantic mirror
against the same file. The route's op set is closed and its identity comes off
the run row (`route.spec.ts`). The fold never fails a run and posts nothing
without a run id (`test_run_ledger_fold.py`). The run message's identity is a
derivation, tested to be idempotent (`lib/runs/service.spec.ts`). Nothing in
the database enforces that a `run_id` on a message names a `task_runs` row;
review is the gate there, and the column is a plain text key on purpose, since
the row can outlive the run's backend job id.

## More Information

- The contract: `frontends/ui/src/lib/runs/run-ledger-types.ts`; the mirror:
  `src/aiq_agent/common/run_ledger.py`.
- The fold and its client: `frontends/aiq_api/src/aiq_api/jobs/run_ledger_fold.py`,
  `run_ledger_client.py`.
- The stream: [`docs/api/websocket-protocol.md`](../api/websocket-protocol.md),
  "Run event streams".
- The task row this builds on: [ADR-0051](0051-tasks-are-the-durable-unit-of-delegated-work.md);
  the record a step's documents come from: [ADR-0061](0061-a-grounding-hit-is-a-record-and-the-text-is-its-rendering.md).

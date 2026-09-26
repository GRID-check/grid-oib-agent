---
status: proposed
date: 2026-09-22
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# The research plan is a workspace primitive the run waits on, not a reply the reader owes

## Context and Problem Statement

Before a deep research runs, the clarifier drafts a Rechercheplan: sections,
genre, depth and, since the Unterlagen slice, the documents to read in full
and the ones never to use. That plan existed only as prose in an agent message
(a `plan_json` fence the client stripped), and the reader's verdict existed
only as a chat reply (`approve {json}`) the agent parsed back. Two things
followed from that shape.

The plan cost a turn every time. With approval on, no run started until the
person answered, even though the plan was right nearly every time and the
audit this branch is about
(`docs/architecture/turns-per-answer-audit-2026-09.md`) counts exactly such
turns. With approval off, the plan was never shown at all. There was no
"show me, and go unless I say otherwise".

The plan was nobody's record. It could not be reopened after the reply, read
by the task card, listed, or handed to a worker as data: the async path
carried it as free text inside the prompt (`clarifier_result`), and a reader
who wanted a plan of their own had no door to write one — only the agent could
propose, and only by being asked a question first.

## Decision Drivers

* ADR-0055: a workspace primitive is one HTTP API with a typed client, and
  the UI, the agent and the worker are equal clients of it.
* ADR-0062: a run is a message in the thread; what a run is about belongs on
  that block, not in a second message the reader has to find.
* The turn budget: the default path may cost the reader zero replies.
* The reader keeps the last word: editing, holding and starting must remain
  one press away for as long as they can still change what the run does.
* Nothing written by a person may be lost to a race with the worker.

## Considered Options

* Keep the plan in the message and make approval optional per org (a flag
  that skips the card).
* Store the plan on the run message's metadata and let the block edit it in
  place, with the worker reading it off the message.
* A `research_plans` primitive: its own row, its own routes, its own client;
  the run row and the run message point at it; the worker asks the primitive
  whether it may start and reads the plan at that moment.

## Decision Outcome

Chosen option: the primitive, because it is the only one of the three in which
the plan is data on every side at once — the block renders it, the reader
patches it, the agent creates it, the worker reads it — and because the start
rule then has exactly one home.

**Shape.** `research_plans` (migration, `grid_secure_table`): the question,
title, sections, genre, depth, Grundlage and Ausgeschlossen as resolved
documents, the Rahmen (data sources), the inventory the card may name
(`unterlagen`), the author (`agent` | `user`), the status, and the instants.
The contract is one zod source (`lib/plans/plan-types.ts`) exported as JSON
Schema (`tests/fixtures/research-plan.schema.json`) that the Python mirror
(`common/research_plan.py`) validates against — the arrangement the ledger
already uses.

**Lifecycle.** `proposed` → (`held`) → `approved` → `started`, or `superseded`.
The agent's plan is created `proposed` with `startsAt = now + grace`
(`clarifier.plan_grace_seconds`) under `plan_approval: auto`, and `held` under
`plan_approval: ask`. A plan the reader writes in the „Auftrag planen" dialog is
created `approved`. „Anpassen" holds a proposed plan (its clock stops);
„Starten" approves a proposed or held one. A `PATCH` is accepted until the plan
is `started`, never after: the worker read it at that instant, and a later edit
would be a plan the run is not running.

**The run waits on the plan.** The run is commissioned at once (`op: research`
with `planId`, the run message carrying `plan_id`), so the block exists from
the first second. The worker does not run the agent until
`POST /api/internal/plans/{id}/start` answers 200: the route starts an
`approved` plan, or a `proposed` one whose `startsAt` has passed, and answers
"not yet" as data with a retry hint otherwise. While the plan is HELD, the
ledger says `wartet` — the first producer of a status the vocabulary had
reserved for exactly this, a run that is waiting on a person. A countdown is
not that, and stays `angelegt`. Every plan write is conditioned on the status
it was decided against, in SQL, so an edit can never land on a started plan. The worker renders the plan it was given
into the same prompt text the chat path rendered (`approved_plan_context`)
and the same `plan_documents`, so nothing downstream of the state changes.

**One edit path.** The reader edits the plan on the run block, the same
`PlanChecklist` the message card used, backed by `PATCH` instead of an
approval reply. Grundlage and Ausgeschlossen are named by file name and
resolved against the plan's own inventory on the BFF, once, for every client.
A document the reader picks from the project's listing, which that inventory
lacks, travels with the edit (`unterlagen`) and joins it. Naming documents is
optional, because the run may read every document it finds. The Grundlage is
its focus unless the plan says `nurGrundlage` („Nur ausgewählte"). Then the
reader's own shelves are confined to it in the source registry, and norms and
laws stay available.
The `plan_json` fence, the `approve {json}` reply, `parse_plan_reply`,
`apply_plan_edits` and the feedback-regeneration loop are deleted: a reader
who wants a different plan changes it, they do not describe the change to a
model that then guesses.

### Consequences

* Good, because the default deep research costs the reader no reply, and the
  plan is still shown, still editable, and still theirs to stop.
* Good, because the plan is one record with one id: the block, the task card,
  the worker and a later integration read the same row.
* Good, because a reader can author a plan without asking first, and the run
  it commissions is indistinguishable from an agent-proposed one.
* Good, because `wartet` now has a producer, so the inbox row and the block's
  clock glyph the vocabulary promised finally appear.
* Bad, because the worker holds a queue slot while it waits. The grace is
  short by default and a held plan is a person's explicit choice; a plan held
  longer than the job's expiry ends the run as `abgebrochen` with the plan
  left `held` for a new run to pick up.
* Bad, because an edit after `started` is refused rather than applied. The
  alternative — live re-planning mid-run — is a second control channel with
  its own races; „Bericht fortschreiben" with the edited plan is the honest
  form of it and already exists.
* Bad, because two of the clarifier's config keys change meaning
  (`enable_plan_approval` → `plan_approval`, plus `plan_grace_seconds`), so a
  deployment's YAML has to move with this change.

### Confirmation

* `rls-coverage.spec.ts` names the table; `authz-coverage.spec.ts` names every
  route.
* `plan-schema.spec.ts` regenerates the fixture and fails when stale;
  `tests/aiq_agent/common/test_research_plan.py` validates the Python model
  against it.
* The worker's wait (`aiq_api/jobs/plan_start.await_plan_start`) is exercised by `frontends/aiq_api/tests/test_plan_start.py`
  (409 → wait → 200; cancel while waiting; a plan already started).
* `test_clarify.py` asserts the turn ends without an `ask_user` call when a plan
  is produced; the reply parser no longer exists to be called.
* Nothing yet enforces that every client resolves document names through the
  BFF rather than locally; review is the gate for that one.

## Pros and Cons of the Options

### Keep the plan in the message, make approval optional

* Good, because it is a one-line flag.
* Bad, because "off" means the reader never sees the plan, and "on" costs the
  turn. The thing wanted — shown, editable, not required — is neither.
* Bad, because the plan stays prose parsed by regexes on two sides.

### Store the plan on the run message's metadata

* Good, because the run message already exists and is already the block's
  data source.
* Neutral, because it is "API-first" only through the message routes, which
  are not the plan's shape and would grow plan-specific ops.
* Bad, because the worker would read the plan off a message whose metadata
  the ledger fold also writes, and the two writers would race on one jsonb.

### The primitive

* Good, because every consequence above; and because the plan outlives the
  run that ran it (a supersession chain for „Bericht fortschreiben" comes for
  free).
* Bad, because it is a table, a service, six routes and a client.

## More Information

* Revisit when live re-planning is asked for: the day a reader wants to add a
  section to a run in its third research round, the refusal after `started`
  becomes the wrong trade and the plan needs a control channel like the
  Unterlagen's `job.document_added`.
* Revisit the grace if the measured hold-to-start ratio shows readers pressing
  „Anpassen" on most runs; then `ask` is the better default.
* The lifecycle drawing this came out of is in the PR; the code map is the
  where-is-what rows for `research_plans`.

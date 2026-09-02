---
status: accepted
date: 2026-09-02
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A task row is the durable unit of delegated work

## Context and Problem Statement

Piloti could already work unattended. A job (`jobs`) says when a prompt
fires; a run (`job_runs`) says that it was submitted; the backend job store
says how the run went and expires the record after 24 hours; an inbox item
says it ended. Each of those solves one sixth of delegation. None of them is
the thing a person actually handed over: work that acts under somebody's
permission, moves through a lifecycle, lands its result somewhere durable,
and hears back when a person judges it.

Three consequences were visible to users. A scheduled deep-research report
was filed by nobody, because the only filing path is the interactive report
GET and nobody opens a 03:00 run from the history, so the report expired
with the job store. A reviewer's "no, the atrium is OIB 2.3" went into a chat
or nowhere, and the next run repeated the mistake. And the question "what did
Piloti do for this project last week, and did anyone check it" had no row to
answer from.

The agent-authored-documents design (2026-08-20, decision 10) had already
named the constraint on the first of these: a scheduled run may not file as
a service token. It must file as the person who asked, with that person's
permission resolved at completion, and the route comment that refused the
shortcut said the fix belongs to "the row that pins the requester".

## Decision Drivers

- Unattended work must act as a person, never as a token, on every write it
  makes into the tenant's data.
- A person's judgement of agent output has to reach the next attempt; a
  decision with nowhere to land is not a decision.
- The record must outlive the job store's 24 hours and the job itself.
- No new agent, no new execution path: the row hangs off seams that exist.

## Considered Options

1. **Columns on `job_runs`** — an `outcome_status`, a `filed_document_id`, a
   `review`. Cheapest; keeps "the run" one row.
2. **A `tasks` table** — one row per attempt, with the requester pinned, a
   frozen plan, lifecycle and review as separate axes, filing ledger, budget
   and deadline slots, and nullable links back to the job and the run.
3. **Keep filing interactive** and add a "file this report" button to the
   run history.

## Decision Outcome

Option 2. `job_runs` is a submission ledger and its status vocabulary ends
at `submitted`; making it also the lifecycle, the review and the filing
record would turn the scheduler's bookkeeping into the product's work
object. A task is that object. It is also the row the next kinds of work
need (`compliance_check`, `einreichcheck`, a request from a thread), and
those have a requester distinct from any job.

What the row carries, and why:

- `requester_user_id` — the job's creator, pinned at creation. Filing at
  completion resolves this person's membership, role and the organization's
  feature flags into a session (`lib/auth/pinned-session.ts`) and calls the
  same `fileResearchReport` the interactive GET calls, keyed on the same
  backend job id, so migration 0064's unique index makes the two paths
  collapse onto one document. A requester who has left the organization,
  lacks the permission, or whose organization has the feature off is a
  refusal recorded on the row, never a borrowed permission.
- `status` and `review` as separate axes — the `mention_requests` shape. A
  task is `succeeded` and `rejected` at the same time, and both are true.
- `review_reason` — quoted verbatim into the next run of the same job as a
  `PREVIOUS_DECISIONS` block on the fire prompt. Not into memory: a
  rejection of a report is a decision about this job's output.
- `plan` — the submitted prompt, skill snapshot and data sources, frozen, so
  the row explains itself after the job changed.
- `budget_usd`, `deadline_at` — recorded now, enforced by the budget guard and
  the scheduler in the next step.

The worker's outcome callback (`/api/internal/jobs/[jobId]/outcome`) now
carries the report and its cards, because at completion the worker is the
only party that holds them and the report GET requires a user JWT the BFF
does not have.

### Consequences

- Good: a scheduled report lands in Berichte, authored by the run, filed as
  the requester; the inbox item says where.
- Good: a reviewer's rejection reaches the next run's prompt, audited
  (`task.reviewed`).
- Good: three audit actions (`task.created`, `task.completed`,
  `task.reviewed`) give the lifecycle a trail.
- Neutral: the review surface is two routes (`GET /api/projects/[id]/tasks`,
  `POST /api/projects/[id]/tasks/[taskId]/review`); the UI for it belongs to
  the UI workstream.
- Bad: one more table inside the tenant boundary (secured by
  `grid_secure_table`, listed in `rls-coverage.spec.ts`).

## More Information

- The row's columns and their reasons: `frontends/ui/src/lib/db/schema/tasks.ts`.
- Lifecycle and filing: `frontends/ui/src/lib/tasks/service.ts`.
- The pinned session: `frontends/ui/src/lib/auth/pinned-session.ts`.
- ADR-0046 (skills and jobs), ADR-0035 (inbox), the agent-authored-documents
  design (decision 10), `docs/roadmap/agentic-workspace-architecture.md` §6
  and Loop C.

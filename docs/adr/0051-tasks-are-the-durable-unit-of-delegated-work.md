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

### Confirmation

The tenant boundary is a CHECK plus a test, not a comment. Migration
`0075_tasks.sql` calls `grid_secure_table` with the same org-and-project
predicate `jobs` uses, and names today's `status` / `review` /
`filing_status` members as CHECKs. `rls-coverage.spec.ts` lists `0075` in
`BOUNDARY_MIGRATIONS`; `task db:test:rls` (CI's tenant-isolation job) is
what proves the policy holds.

Filing as a person is three tests, not a route comment:
`pinned-session.spec.ts` (left the org, no role, feature-flag fail-closed),
`lib/tasks/service.spec.ts` (the outcome callback files through that
session, a refusal is recorded on the row, a rejection's reason is quoted
into the next fire prompt), and `test_job_outcome_notify.py` (the worker
is the party that holds the report, so the report rides the callback).

`budget_usd` and `deadline_at` are recorded. Nothing enforces them yet;
the budget guard and the scheduler are the next step, named in the
decision.

### Addendum (2026-09-10): three kinds of trigger, and four kinds of work

The record above said "`jobs` becomes one trigger that creates tasks. A chat
handoff becomes another." One existed. Both of the others named here are built
now, and the shape they took is worth recording because two of the obvious
builds were wrong.

**The kinds.** `TASK_KINDS` gains `compliance_check`, `einreichcheck`,
`document` and `revision` — the four the roadmap named, each already having an
engine. Migration `0075` gave `kind` no CHECK on purpose, so this was a
TypeScript change and nothing else. `DELEGATABLE_TASK_KINDS` is the four,
DERIVED as the complement of the two job outputs rather than listed a second
time: `deep-research` and `chat` say how a JOB delivers a result, and a caller
asking for one would be naming a delivery channel where a piece of work belongs.

**Chat as a trigger.** `create_task(kind, goal, due?)` (`src/aiq_agent/tools/
tasks/`) reaches `POST /api/internal/tasks`, which is the document-versions
route's identity pattern lifted into `lib/api/internal-envelope.ts` on its
second caller: the verified envelope names the acting person, the pinned session
is built from their WorkOS membership today, and the task's requester is pinned
to them — so the run spends their budget under their permissions. The op set is
`create` and nothing else. **A machine may ask for work and may never judge it**;
`reviewTask` stays a session route, because a machine that could accept its own
output would close the loop this record exists to open.

**Request-changes reaches the agent twice, and never both ways at once.** A
version filed from a live conversation carries `origin_conversation_id`
(migration `0084`, written from the verified envelope), and the next turn of THAT
conversation reads the reviewer's words verbatim as a `REVIEW_DECISIONS v1`
block on the memory channel — the same channel and the same shape
`PROPOSAL_DECISIONS` already uses, so it needed no new header. A version with no
origin has nobody typing, so the lifecycle's `openRevisionTask` effect opens a
`revision` task instead. The reviewer can also ask for one outright („Piloti
überarbeiten lassen"), which is a field on the existing `request_changes`
request rather than a fourth op: the version makes the same move either way.

Two builds were considered and rejected, and both would have looked cheaper:

1. **A hidden `jobs` row per delegation.** It reuses `fireJob` wholesale, which
   is genuinely attractive. It also puts a scheduled-job entry in the project's
   Aufträge list for a sentence somebody typed once. So a delegated task has no
   `job_runs` row at all; `job_runs.schedule_id` is NOT NULL and its RLS
   predicate requires a `jobs` row (migration `0043`), and making that column
   nullable would have moved the tenant boundary of a table this change has no
   business touching. The task row carries the backend job id itself —
   `uniq_tasks_backend_job_id` is what makes the outcome a lookup — and the
   outcome route tries the run first and falls back to the task. That fallback
   is the one branch the arrangement costs.
2. **Letting the run file its own draft.** The agent already has `file_draft`,
   and a `document` or `revision` task looks like a turn that should call it.
   It cannot, and the refusal is correct: the job worker injects three unsigned
   identity headers and never the signed envelope, so `file_draft` has no acting
   person and says so (`tools/AGENTS.md`, "echo, never sign"). The filing
   therefore happens at COMPLETION, in the pinned requester's session, through
   the same lifecycle service a person's own filing goes through — which is
   where `deep-research` already filed.

**A deep-research report is now a `draft` too**, submitted to the person who
commissioned it. Same producer, same PDF renderer, same idempotency key; what
changes is that a filed report stops looking, in the Files pane, exactly like a
document somebody checked. One vocabulary for humans and for Piloti was
ADR-0054's decision, and a report filed with no editorial state was the last
place it was not true.

Confirmation for all of it: `lib/tasks/delegation.spec.ts` (the requester
pinned, the engines, a submission failure recorded ON the row),
`lib/tasks/service.spec.ts` (each kind's filing, and the outcome that has no
run), `lib/documents/review-decisions.spec.ts` and `lifecycle.spec.ts` (the
condition, both ways, and that the effect is on exactly one transition),
`app/api/internal/tasks/route.spec.ts` (identity, tenancy, the closed op set),
and `tests/aiq_agent/tools/tasks/` (echo-never-sign, and every refusal before
the call).

## More Information

- The row's columns and their reasons: `frontends/ui/src/lib/db/schema/tasks.ts`.
- Lifecycle and filing: `frontends/ui/src/lib/tasks/service.ts`.
- The pinned session: `frontends/ui/src/lib/auth/pinned-session.ts`.
- Delegation and the revision loop: `frontends/ui/src/lib/tasks/delegation.ts`,
  `frontends/ui/src/lib/documents/review-decisions.ts`,
  `frontends/ui/src/lib/documents/revision.ts`, `src/aiq_agent/tools/tasks/`.
- ADR-0046 (skills and jobs), ADR-0035 (inbox), ADR-0054 (the version and the
  publish door), ADR-0055 (one HTTP surface per primitive), the
  agent-authored-documents design (decision 10),
  `docs/roadmap/agentic-workspace-architecture.md` §6 and Loop C, and
  `docs/roadmap/piloti-writes-artifacts-and-approval.md` §5.

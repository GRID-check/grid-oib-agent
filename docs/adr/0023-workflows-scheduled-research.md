# ADR-0023: Workflows — saved research briefs with cron scheduling

- **Status:** Proposed
- **Date:** 2026-07-16
- **Deciders:** Grid engineering
- **Related:** ADR-0003 (BFF + stateless agent), ADR-0004 (tenancy), ADR-0008 (single-writer grid_app), ADR-0011 (deletion pipeline / purger worker), ADR-0015 (spend limits), ADR-0016 (permission registry), ADR-0020 (Dragonfly cache-only), ADR-0021 (DB-claimed workers, no-broker verdict)

## Context

Users want to run the deep-research agent repeatedly with a *predefined* brief —
"every Monday morning, research X for this project" — instead of re-typing the
prompt into chat. That requires three new capabilities:

1. **Saved workflow definitions**: a named, editable research brief scoped to a
   project (and therefore to one organization), built in a WYSIWYG-style editor.
2. **Triggers**: manual ("Run now") and recurring (cron expression + timezone).
3. **A scheduler** that fires due workflows reliably on an enterprise-scale
   deployment: multiple orgs, many projects, and — per the 2026-07 scaling
   review — a future with multiple replicas of every service, where naive
   in-process timers double-fire.

Constraints inherited from prior decisions:

- `grid_app` is single-writer: only the Node/BFF side writes it (ADR-0008).
  The Python backend must not read or write workflow tables directly.
- Job/queue state belongs in Postgres, never in Dragonfly (ADR-0020).
- No message broker; multi-instance-safe background work uses DB-claimed rows
  via `FOR UPDATE SKIP LOCKED` — the purger is the model citizen (ADR-0011,
  ADR-0021, scaling-review §4).
- Deep research already has exactly one execution path — the async job API
  (`submit_agent_job` → Dask) — with admission control
  (`GRID_MAX_ACTIVE_JOBS[_PER_ORG]`), per-job ownership (`job_access`), cost
  tracking (ADR-0015), SSE streaming, cancellation, and a ghost-job reaper.
  A second execution path would duplicate all of that.
- Features launch dark behind WorkOS feature flags with an env-var fallback
  while `GRID_ENFORCE_FEATURE_FLAGS` is off (the `project-knowledge-page`
  pattern).

## Decision

### 1. Workflow state lives in `grid_app` (Drizzle), scoped org + project

Two tables, following the `project_memory` shape (denormalized
`organization_id` beside a cascading `project_id` FK):

- `workflows` — name, description, versioned `definition` JSONB (builder
  state), a **denormalized `compiled_prompt` text column**, `agent_type`
  (validated against the backend agent registry, `deep_researcher` today),
  optional `data_sources`, `enabled`, `schedule_cron` (5-field, nullable =
  manual-only), `schedule_timezone` (IANA), `next_run_at`, `last_run_at`,
  `created_by` / `created_by_email`, timestamps. Partial index on
  `next_run_at` for the due-scan.
- `workflow_runs` — append-only submission history: `workflow_id`, `job_id`
  (backend async-job id), `trigger` (`manual` | `schedule`), `status`
  (`submitted` | `skipped` | `error`), `detail`, `prompt_snapshot`,
  `triggered_by`. Live job progress/results stay in the backend job store —
  the run row records *that and how* a run was triggered, keyed to the job.

The prompt is compiled from the block definition **once, at save time, in the
BFF** and stored on the row. The scheduler and the manual-run path submit that
stored text; the editor previews exactly the same compiled output (that is the
"WYSIWYG" contract: what the preview shows is byte-for-byte what the agent
receives). Every run also snapshots the prompt it submitted, so history stays
auditable after edits.

### 2. The WYSIWYG editor is a block-based brief builder, not a node canvas

Today a workflow *is* one deep-research invocation, so a DAG/canvas editor
(react-flow etc.) would be a heavy new dependency modelling a graph with one
node. Instead: structured blocks (objective, context, research questions,
output format) + data-source scoping + a live preview pane of the compiled
prompt, built entirely from the existing form/UI primitives. The `definition`
JSONB carries a `version` field so a future multi-step builder can migrate.

### 3. Scheduler = dedicated Node worker container, DB-claimed ticks

A new compose service (`workflow-scheduler`, frontend image,
`node scheduler/index.js`) — the exact deployment shape of the purger. Each
tick (default 30 s) it claims due rows:

```sql
SELECT … FROM workflows
WHERE enabled AND schedule_cron IS NOT NULL AND next_run_at <= now()
ORDER BY next_run_at LIMIT $batch
FOR UPDATE SKIP LOCKED
```

then, **inside the claim transaction**, advances each row's `next_run_at` to
the next *future* occurrence (cron + timezone via `cron-parser`) and commits —
and only then fires the run. Consequences of that ordering:

- **At-most-once per occurrence** across any number of scheduler replicas
  (SKIP LOCKED) and across crashes (a crash after commit but before firing
  misses one occurrence rather than double-firing an expensive research job).
- **Misfire coalescing**: after downtime, a workflow fires once and jumps to
  the next future slot — no backfill stampede of stale occurrences.

Firing is an HTTP POST to the **BFF's internal fire endpoint**, not to the
backend directly, so budget headers, model overrides, run-row writes, and org
scoping are computed by the same TypeScript service code the manual "Run now"
route uses. The scheduler stays dumb: claim, advance, POST, log. It also
prunes `workflow_runs` older than a retention window (default 90 days).

### 4. One submission path, service-to-service auth

`BFF fireWorkflow(workflow, trigger, actor)` → backend
`POST /v1/internal/workflows/submit`, guarded by `GRID_INTERNAL_API_TOKEN`
(constant-time compare, dev-default refusal — the `maintenance.py` pattern;
never on the external-path allowlist). The route wraps `submit_agent_job` with
an explicitly supplied identity (`organization_id`, `user_id`, `project_id`)
so scheduled runs — which have no live user JWT — still get:

- **admission control**: org/global active-job caps apply; a 429 is recorded
  as a `skipped` run with the reason, and the occurrence is *not* retried
  until its next scheduled slot (no thundering herd against the caps);
- **cost tracking**: the usage ledger attributes scheduled-run spend to the
  org/project exactly like interactive runs;
- **ownership**: jobs are owned by the workflow's creator, so existing
  job-access authz keeps working.

Manual runs require project-edit permission on the project; reads require
project view. All routes live under `/api/projects/[id]/workflows…` and go
through `requireProjectAccess` (ADR-0004/0016 discipline).

### 5. Feature flag: `workflows`, dark launch

New registry entry `workflows` + `isWorkflowsEnabled(session)`: WorkOS flag
when `GRID_ENFORCE_FEATURE_FLAGS=true`, else the explicit
`GRID_WORKFLOWS_ENABLED=true` env opt-in (default **off**). Gates the nav
item, the page (404 when off), and every BFF workflow route. The scheduler
service refuses to start when the deployment-level gate is off.

## Consequences

### Positive

- Replica-safe scheduling from day one with zero new infrastructure (no
  broker, no APScheduler/Celery-beat, no Dragonfly persistence).
- Scheduled and manual runs are indistinguishable to the backend — every
  existing safety net (caps, budgets, reaper, SSE, cancellation) applies.
- The stored-compiled-prompt design keeps the scheduler free of TS build
  tooling and makes run history auditable.

### Negative

- A new always-on container per deployment (mitigated: it idles at one cheap
  indexed query per tick).
- Two hops per fire (scheduler → BFF → backend) — accepted for the shared
  code path; both hops are on the compose network.

### Risks

- **Per-org flag revocation and scheduled fires.** Flag delivery to sessions
  is JWT-based, but the scheduled-fire path re-evaluates the org's
  `workflows` flag server-side (`isOrgFeatureEnabled`, the cached fail-closed
  evaluator memory-reflection already uses) before firing: revoking an org's
  flag pauses its schedules within the cache TTL, recorded as visible
  `skipped` runs. Fail-closed means a WorkOS flag outage pauses scheduled
  research rather than running it ungated — the safe direction for an
  expensive gated feature.
- **Budget enforcement parity**: scheduled runs carry identity for the ledger,
  and the BFF fire path attaches the same budget context as interactive
  submits; if the budget-header builder is bypassed by a future refactor,
  scheduled runs would degrade to ledger-only. Covered by tests.
- Missed-once semantics on crash-between-advance-and-fire: acceptable for
  research cadences (next occurrence heals); documented.

## Alternatives Considered

- **Scheduler inside the Python backend** (asyncio loop like the ghost
  reaper): rejected — it would need to read `grid_app` workflow tables,
  breaking the single-writer/no-schema-coupling boundary (ADR-0008), and
  duplicate budget/override logic that lives in the BFF.
- **Scheduler inside the Next.js server process**: rejected — ties firing to
  web-replica lifecycle and violates the "web serves requests, workers do
  background work" separation the purger established.
- **APScheduler / Celery beat / a broker**: rejected per the standing
  no-broker verdict (ADR-0021, scaling review §4.1) — job state would live in
  two places and add an operational component without fixing a real gap.
- **Per-workflow `setTimeout`/in-memory timers**: rejected — not replica-safe,
  loses state on restart; the class of bug ADR-0020/0021 exist to prevent.
- **Node-canvas WYSIWYG (react-flow)**: rejected for v1 — a graph editor for
  a single-node graph; the versioned JSONB definition leaves the door open.
- **Storing run results in `grid_app`**: rejected — results already live in
  the backend job store with SSE/report endpoints; duplicating them invites
  divergence (ADR-0020's "one source of truth" discipline).

## Open Questions / Follow-ups

- Multi-step workflows (chained agents) — `definition.version` reserves room.
- Notifications on run completion (email/in-app) — today results appear in
  the project's research-runs surface.
- Org-level (project-less) workflows if demanded; the schema's denormalized
  `organization_id` makes that a nullable-`project_id` extension like
  `project_memory.scope`.

## References

- `docs/architecture/workflows.md` (subsystem design + contracts)
- `docs/architecture/scaling-review-2026-07.md` §4
- `frontends/ui/purger/index.js` (worker precedent)
- `frontends/aiq_api/src/aiq_api/jobs/submit.py` (admission control)

# Workflows — scheduled deep research (subsystem design)

Decision record: ADR-0023. This doc is the working design + contracts for the
workflows subsystem: saved research briefs per project, run manually or on a
cron schedule, executed through the existing async deep-research pipeline.

Feature gate: `FEATURE_FLAGS.workflows` (`workflows` in WorkOS) with the
dark-launch env fallback `GRID_WORKFLOWS_ENABLED` (default off) while
`GRID_ENFORCE_FEATURE_FLAGS` is off — the `project-knowledge-page` pattern.

## Components

| Component | Where | Role |
|---|---|---|
| Schema + migration | `frontends/ui/src/lib/db/schema/workflows.ts`, `frontends/ui/drizzle/0017_workflows.sql` | `workflows`, `workflow_runs` tables in `grid_app` |
| Service + compiler | `frontends/ui/src/lib/workflows/` | CRUD, definition→prompt compiler, `fireWorkflow()` |
| BFF routes | `frontends/ui/src/app/api/projects/[id]/workflows/…`, `frontends/ui/src/app/api/internal/workflows/fire` | user CRUD/run-now; internal fire endpoint for the scheduler |
| Scheduler worker | `frontends/ui/scheduler/` + compose service `workflow-scheduler` | DB-claimed cron ticks → POST internal fire endpoint |
| Backend submit route | `frontends/aiq_api/src/aiq_api/routes/workflows.py` | `POST /v1/internal/workflows/submit` → `submit_agent_job` |
| UI | `frontends/ui/src/features/workflows/`, page `app/projects/[id]/workflows` | Workflows tab: list, builder, schedule editor, run history |

## Data model (grid_app, Drizzle)

`workflows`
- `id` uuid PK default random
- `project_id` uuid NOT NULL → `projects.id` ON DELETE CASCADE
- `organization_id` text NOT NULL (denormalized WorkOS org id, never a FK — ADR-0007)
- `name` text NOT NULL (≤ 200 chars, enforced in zod)
- `description` text
- `definition` jsonb NOT NULL — versioned builder state (below)
- `compiled_prompt` text NOT NULL (≤ 32000 chars — matches backend `JobSubmitRequest.input` cap)
- `agent_type` text NOT NULL default `'deep_researcher'`
- `data_sources` jsonb — `string[] | null`; null = all sources available to the agent
- `enabled` boolean NOT NULL default true — master switch (schedule + run-now stay listed but a disabled workflow never fires and run-now is rejected)
- `schedule_cron` text — 5-field cron; NULL = manual-only
- `schedule_timezone` text NOT NULL default `'UTC'` (IANA name)
- `next_run_at` timestamptz — computed at save time by the BFF; NULL when no cron or disabled
- `last_run_at` timestamptz
- `created_by` text NOT NULL (WorkOS `user_…`), `created_by_email` text
- `created_at` / `updated_at` timestamptz NOT NULL default now()
- Indexes: `(project_id)`, `(organization_id)`, partial `idx_workflows_due` on `(next_run_at)` WHERE `schedule_cron IS NOT NULL AND enabled`

`workflow_runs` (append-only)
- `id` uuid PK default random
- `workflow_id` uuid NOT NULL → `workflows.id` ON DELETE CASCADE
- `project_id` uuid NOT NULL, `organization_id` text NOT NULL (denormalized)
- `job_id` text — backend async-job id; NULL when `skipped`/`error`
- `trigger` text NOT NULL: `'manual' | 'schedule'`
- `status` text NOT NULL: `'submitted' | 'skipped' | 'error'` — submission outcome only; live job progress/results stay in the backend job store, joined by `job_id`
- `detail` text — skip reason (e.g. org job cap) or submission error
- `prompt_snapshot` text NOT NULL
- `triggered_by` text — user id for manual runs, `'scheduler'` for cron
- `created_at` timestamptz NOT NULL default now()
- Indexes: `(workflow_id, created_at desc)`, `(project_id)`, `(organization_id)`

## Definition JSONB (version 1) and the compiler

```jsonc
{
  "version": 1,
  "blocks": {
    "objective": "string, required, non-empty",
    "context": "string, optional",
    "questions": ["string", "…"],        // optional list
    "outputFormat": "string, optional"    // e.g. "executive summary + table of sources"
  }
}
```

`compileWorkflowPrompt(definition)` (in `src/lib/workflows/compiler.ts`) is a
pure, deterministic function producing a structured research brief (Markdown
sections: Objective / Background & Context / Research questions / Output
requirements — omitting empty sections). It runs at save time (stored in
`compiled_prompt`), and the editor's preview pane renders the identical output:
the preview IS what the agent receives. Compiled length is validated ≤ 32000.

## BFF API (all under the feature gate + `requireProjectAccess`)

Read = `project:view`; mutate & run = the standard project edit permission
(same slug used by existing project-content mutation routes).

- `GET  /api/projects/[id]/workflows` — list (id, name, description, enabled, schedule, next/last run, updatedAt)
- `POST /api/projects/[id]/workflows` — create `{name, description?, definition, dataSources?, enabled?, scheduleCron?, scheduleTimezone?}`; server compiles the prompt, validates cron + min interval, computes `next_run_at`
- `GET/PATCH/DELETE /api/projects/[id]/workflows/[workflowId]` — PATCH recompiles/revalidates and recomputes `next_run_at`; every query double-filters by `organization_id`
- `POST /api/projects/[id]/workflows/[workflowId]/run` — manual fire via `fireWorkflow(workflow, 'manual', session.user.id)`; 409 when disabled; surfaces backend 429 (caps) as a friendly skipped result
- `GET  /api/projects/[id]/workflows/[workflowId]/runs?limit&offset` — run history (newest first)
- `POST /api/internal/workflows/fire` — `internalApiRoute` (shared-token, like `/api/internal/memory`), body `{workflowId}`; used by the scheduler. Delegates to `fireScheduledWorkflow`, which re-checks `enabled` AND the org's `workflows` gate (per-org WorkOS flag via `isOrgFeatureEnabled` under enforcement — fail-closed, so flag revocation/outage pauses schedules with visible `skipped` runs; the `GRID_WORKFLOWS_ENABLED` env gate otherwise) before `fireWorkflow(workflow, 'schedule', 'scheduler')`.

`fireWorkflow()` (service) is the single submission path:
1. Build identity (org, project, workflow creator as owner) + the same
   budget/model-override context the interactive async-submit path attaches.
2. POST backend `POST /v1/internal/workflows/submit` (below).
3. Record a `workflow_runs` row: `submitted` (+ job_id) / `skipped` (429 with
   Retry-After → detail) / `error` (other failures). Update `last_run_at`.
   Never throws for skip; an occurrence is not retried before its next slot.

## Backend internal route (Python, aiq_api)

`POST /v1/internal/workflows/submit` — guarded by `GRID_INTERNAL_API_TOKEN`
(`X-Internal-Token`, constant-time compare, dev-default-token refusal outside
dev — exactly the `maintenance.py` pattern; NOT added to the external-path
allowlist, so it is unreachable from outside the compose network).

Request:
```jsonc
{
  "agent_type": "deep_researcher",       // must exist in AGENT_REGISTRY
  "input": "…compiled prompt…",           // 1..32000
  "job_id": "optional idempotency id",    // ^[a-zA-Z0-9_-]+$, ≤64
  "data_sources": ["web_search"] | null,
  "collection_scope": ["proj_<uuid>"] | null,
  "project_context": "…" | null,
  "organization_id": "org_…",             // required
  "user_id": "user_…" | null,             // workflow creator
  "project_id": "<uuid>" | null,
  "owner_email": "…" | null,
  "budget_header": "…" | null,            // pass-through, same header value the BFF builds for interactive submits
  "model_overrides": {"group": "model"} | null
}
```
Behavior: validates agent/data sources like the public submit route, builds
`usage_context = {"identity": {organization_id, user_id, project_id,
conversation_id: null}, "budget_header": …}`, constructs a Principal for the
workflow creator, and calls `submit_agent_job(...)`. Error mapping identical
to the public route: 429 + Retry-After on `JobAdmissionError`, 409 duplicate,
503 scheduler-not-configured, 403 bad/missing token. Response: `{"job_id": …}`.
Admission caps (`GRID_MAX_ACTIVE_JOBS[_PER_ORG]`) therefore apply to
scheduled runs automatically.

## Scheduler worker (`frontends/ui/scheduler/`)

Plain-Node worker (purger idiom: CommonJS, `postgres` client, `.spec.mjs`
tests), compose service `workflow-scheduler` running `node scheduler/index.js`
off the frontend image. Refuses to start (clean log + exit 0) unless the
deployment gate is on (`GRID_WORKFLOWS_ENABLED=true` or
`GRID_ENFORCE_FEATURE_FLAGS=true`).

Tick (default 30 s), all inside one transaction:
1. `SELECT id, schedule_cron, schedule_timezone, next_run_at FROM workflows
   WHERE enabled AND schedule_cron IS NOT NULL AND next_run_at <= now()
   ORDER BY next_run_at LIMIT $batch FOR UPDATE SKIP LOCKED`
2. For each row compute the next occurrence **strictly in the future**
   (`cron-parser`, per-row timezone; misfires coalesce — no backfill) and
   `UPDATE workflows SET next_run_at = $next WHERE id = $id`.
3. Commit. THEN fire each claimed workflow:
   `POST {FRONTEND_INTERNAL_URL}/api/internal/workflows/fire` with the shared
   internal token. Fire failures are logged loudly (the BFF records run rows;
   if the BFF itself was unreachable the occurrence is missed-once and the
   next occurrence heals — see ADR-0023 risks).
4. Retention: `DELETE FROM workflow_runs WHERE created_at < now() - interval
   '$GRID_WORKFLOW_RUNS_RETENTION_DAYS days'` (batched).

A row with an unparseable cron (should be impossible — validated at write
time) is disabled with a loud log instead of wedging the due-scan.

## Cron semantics

- 5-field cron, validated at save time in the BFF with `cron-parser`.
- Per-workflow IANA timezone (DST handled by the library).
- Minimum interval between occurrences: `GRID_WORKFLOW_MIN_INTERVAL_MINUTES`
  (default 15) — enforced at save time by sampling successive occurrences.
- At-most-once per occurrence across replicas and crashes (claim advances the
  schedule before firing).

## Environment variables

| Variable | Service | Default | Purpose |
|---|---|---|---|
| `GRID_WORKFLOWS_ENABLED` | frontend, workflow-scheduler | `false` | Dark-launch fallback gate while flags are unenforced; also the scheduler's start gate |
| `GRID_WORKFLOW_SCHEDULER_POLL_MS` | workflow-scheduler | `30000` | Tick interval |
| `GRID_WORKFLOW_SCHEDULER_BATCH` | workflow-scheduler | `20` | Max claims per tick |
| `GRID_WORKFLOW_MIN_INTERVAL_MINUTES` | frontend | `15` | Minimum cron cadence accepted at save time |
| `GRID_WORKFLOW_RUNS_RETENTION_DAYS` | workflow-scheduler | `90` | Run-history retention |

(Existing: `GRID_APP_DATABASE_URL`, `FRONTEND_INTERNAL_URL`,
`GRID_INTERNAL_API_TOKEN`, `BACKEND_URL` are reused, not new.)

## UI

Sidebar gains a `workflows` nav item (flag-gated like `knowledge`), page at
`app/projects/[id]/workflows` (server shell: session → flag `notFound()` →
`requireProjectAccess` → client panel). Feature dir
`src/features/workflows/`: list of workflows with enable/disable + next-run,
create/edit builder (blocks form left, live compiled-prompt preview right,
schedule editor with common presets + custom cron + timezone picker, data
source checkboxes from the existing sources endpoint), per-workflow run
history with links into the existing research-run/report surfaces. i18n:
`en`/`de` dictionaries (nav + workflows namespace).

## Testing

- BFF: vitest — compiler determinism/limits, cron validation incl. min
  interval + timezone, service authz/tenant filters, route tests under
  `tests/app/api/projects/[id]/workflows/…` (session/db mocks), feature-flag
  spec additions.
- Scheduler: `.spec.mjs` unit tests for next-occurrence computation, misfire
  coalescing, claim/advance SQL (mocked sql), start-gate.
- Backend: pytest — token guard (403/503 dev-default), payload validation,
  admission-error mapping, `submit_agent_job` call shape (mocked), external
  allowlist non-exposure.

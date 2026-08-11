# Agent Skills (ADR-0046)

Skills are reusable, versioned instruction packages (the agentskills.io
format) that extend what the model can be told how to do on:
- **Interactive chat turns** (`shallow_researcher`), and
- **Async deep-research jobs** (`deep_researcher`), including the
  skill-scheduler's scheduled runs.

This doc is the whole subsystem: the backend half (where skills come from, how
they are selected per run, how the model is told about them) and the BFF half
(the org toolbox, project schedules, the fire path, the scheduler worker and
the UI). It replaces `docs/architecture/workflows.md` — the Workflows feature
(ADR-0023) was removed, and Agent Skills is its successor: the skill-scheduler
is the workflow scheduler, and a skill schedule is what a saved research brief
used to be. API surfaces are tabulated in `docs/api/python-endpoints.md` and
`docs/api/bff-routes.md`.

Feature gate: `FEATURE_FLAGS.skills` (`skills` in WorkOS) with the dark-launch
env fallback `GRID_SKILLS_ENABLED` (default off) while
`GRID_ENFORCE_FEATURE_FLAGS` is off — `isSkillsEnabled` /
`requireSkillsEnabled` in `frontends/ui/src/lib/authz/feature-flags.ts`.

## Skill model

A skill is a `SKILL.md` with YAML frontmatter (agentskills.io contract),
validated strictly by `src/aiq_agent/skills/models.py`:

| Field | Rule |
|-------|------|
| `name` | 1–64 chars, lowercase `a-z0-9` + hyphens; for filesystem skills it must equal the parent dir name |
| `description` | 1–1024 chars, non-empty; the one-line L1 summary the model sees |
| `body` | The full markdown instructions (L2), loaded only via the `use_skill` tool |
| `metadata` | String-map; reserved GRID keys (`grid-execution` ∈ `chat`\|`deep-research`, `grid-schedulable`, `grid-agents`) are validated |
| `license` / `compatibility` / `allowed_tools` | Optional free-form strings |

Unlike deepagents' warn-and-continue scan, GRID's substrate validates
**strictly**: an invalid builtin SKILL.md is a deployment error
(`builtin.py` raises), an invalid org row is dropped individually with a
warning (`resolver._build_org_skills`), never silently half-loaded.

### Origins

- **Builtin** (`origin="platform"`): SKILL.md files shipped under
  `src/aiq_agent/skills/builtin/<collection>/<name>/SKILL.md`, discovered
  deterministically by `discover_builtin_skills()`. The BFF sees the same
  files through the generated `@/lib/skills/platform-skills` module
  (`frontends/ui/scripts/sync-platform-skills.mjs`), so both tiers read one
  source of truth.
- **Org** (`origin="org"` / `"platform-clone"`): rows in the `skills` table,
  authored in the organization or cloned from a builtin. The backend reads
  them through the BFF internal endpoint
  `GET /api/internal/skills/resolve`. An org row whose name matches a builtin
  **shadows** it — the tenant's version wins, mirroring BYOK's "explicit org
  value beats deployment default" ordering (ADR-0022).

## Resolution

`SkillResolver(agent)` in `src/aiq_agent/skills/resolver.py` produces the
effective skill set for one run:

1. Builtin set is discovered once per resolver instance (never per turn).
2. Org rows are fetched per organization from the BFF fail-open:
   - Cached in the shared Dragonfly/Redis cache
     (`aiq_agent.common.cache`, ADR-0020) keyed
     `skills:{organization_id}:{agent}` for
     `GRID_SKILLS_CACHE_TTL_SECONDS` (default 60s).
   - Any failure (no `GRID_INTERNAL_API_TOKEN`, timeout, non-2xx, malformed
     payload) degrades to the builtin set — skills are an additive
     capability and must never take chat down.
3. Per-agent filtering (below).
4. The NAT config's `skills_enabled` / `skill_allowlist` (see Config).

### Agent targeting

ONE gate, read from reserved frontmatter metadata and applied identically by
the Python resolver (`_skill_applies_to_agent`) and by the BFF
(`skillTargetsAgent` in `frontends/ui/src/lib/skills/service.ts`) — they are a
contract pair, and both test suites pin them against the same cases:

- `grid-agents` — comma-separated allowlist of agent identifiers; absent means
  every agent. A name that matches no known agent is **ignored** rather than
  obeyed, so one typo cannot silently delete a skill from every agent at once.

`grid-execution` is **not** a gate, though it used to be. It says what a
*scheduled* run of the skill produces — a chat turn you can open, or a
deep-research report (`routes/skills.py::_EXECUTION_AGENT_TYPES`) — and reading
it as an availability rule meant declaring an output format silently decided
where the skill existed. A skill whose scheduled runs write a report is still
an ordinary skill to invoke with `/name` in chat. A skill that genuinely cannot
run somewhere says so with `grid-agents`.

The agent vocabulary is the `AGENT_REGISTRY` identifiers
(`frontends/aiq_api/src/aiq_api/registry.py`): **`shallow_researcher`** and
**`deep_researcher`**. There is one spelling; the older `deep_research_agent`
name is gone from the skills path entirely, because two vocabularies for one
agent meant a `grid-agents` value that was correct in one file and inert in
the other.

All five builtin skills declare `grid-execution: deep-research`,
`grid-agents: deep_researcher` and `grid-schedulable: "false"` in their own
frontmatter. They are DeepAgents subagent skills: their instructions call
`execute`, read and write `/shared/` and return `ResearchNotes`, none of which
exists in a chat turn. `grid-agents: deep_researcher` is what keeps the shallow
chat researcher from being offered a procedure it cannot carry out — shallow
chat resolves none of them, deep research resolves all five. Since the
`grid-execution` gate was removed, that key is the ONLY thing doing so, which
is why `platform-skills.spec.ts` asserts every builtin still declares it. The BFF forwards
platform metadata **verbatim** on the resolve endpoint (an empty `metadata: {}`
would merge over the backend's own filesystem copy and erase this targeting),
and the agent filter applies to platform rows as well as org rows.

## Selection & progressive disclosure

Skill selection is **user-request-driven, never model-chosen**:

- Chat turns: `_extract_query_and_sources` / `_extract_query_from_text` in
  `src/aiq_agent/agents/chat_researcher/utils.py` parse `data_sources` and
  `skills` out of the turn input. The JSON envelope mirrors the
  `data_sources` mechanism, so a message like
  `{"query": "...", "data_sources": ["web_search"], "skills": ["forecast-analysis"]}`
  forces those skills for the turn — the backend lifts the array onto the
  agent state as `force_skills`. Unknown names are dropped by the
  enforcement machinery (they simply don't match a resolved skill). The `/name`
  composer invocation below is what sets that field in the product.
- Remote submissions: `/v1/internal/skills/submit` carries `force_skills` so
  scheduled/manual skill runs force-activate their declared skill names;
  agent selection follows the skill's `grid-execution` metadata. Deep-research
  runs get their skills the deepagents-native way (see Config).

Progressive disclosure has exactly two levels:

- **L1 — the catalog.** One line per skill (`name: description`) in the
  system prompt's `## Verfügbare Skills` section, plus a `## Aktive Skills
  (vom Nutzer erzwungen)` block listing skills forced for this turn. Both
  blocks are pre-collated by the register layer (`ShallowAgentFlat` /
  `DeepAgentFlat`) and render via the runtime's `prompt_block()` /
  `forced_block()`; `None` renders no section.
- **L2 — the body.** The model must call the `use_skill` tool to load a
  body before following it. A failed lookup returns an error listing the
  available names, so a hallucinated skill name is self-correcting rather
  than a fatal turn.

`SkillRuntime` (`src/aiq_agent/skills/runtime.py`) is **per run**
(ADR-0018 — never cached on a shared agent instance): it owns the forced/
activated name lists, so `skills_activated` on the terminal frame records
exactly which skills were forced vs. invoked this run.

## Invoking a skill in chat (`/name`)

Typing `/` as the first non-whitespace character of a composer message opens a
picker of the skills this member may invoke; picking one inserts `/name ` and
sending carries `skills: ['name']` on the chat message envelope, which the
backend lifts onto `force_skills`.

- **Endpoint:** `GET /api/skills/invocable` → `listInvocableSkills`, filtered
  to enabled skills a chat turn can actually run (`shallow_researcher`), so
  the menu can never offer a deep-research skill the turn cannot execute. Any
  org member may list: invoking a skill is *using* the product, not
  administering it (authoring stays `org:skills:manage`).
- **Level 1 only.** The picker shows name and description and nothing else,
  because that is exactly the metadata the agent is given at the start of a
  turn. The menu a person reads and the catalogue the model reads are the same
  text, so a description that fails to say when a skill applies is visibly
  unhelpful to both — which is the feedback a skill author needs. Bodies are
  never fetched to draw it; they enter the conversation only when the agent
  calls `use_skill`.
- **Why only at the start of a message.** The trigger is deliberately narrower
  than `@`: slashes are ordinary punctuation in this domain (`12/05`,
  `OIB-RL 2/3`, `und/oder`, `m/s`, `/etc/hosts`), and a menu firing on those
  would interrupt someone writing a normal sentence about a Richtlinie. An
  invocation applies to the whole turn, so the front of the message costs
  nothing and removes the entire class of false positives.
- **No invocation state.** The invoked skill is derived from the composer text
  on every render, so deleting the token removes the invocation with no
  bookkeeping and nothing can drift from what the user sees. Mentions cannot
  do this (two people may share a display name); a skill name is unique and
  exact, so the text is a complete record, and what goes on the wire is
  resolved from the text *being sent*. A leading slash that names no real
  skill is ordinary text, not an invocation.
- **Degradation.** With the feature off, or if the request fails, `/` is an
  ordinary character again. A successful empty answer still opens the panel —
  that panel is where the product explains what a skill is.

Files: `frontends/ui/src/features/skills/lib/slash-command.ts` (pure text
logic), `hooks/use-slash-command.ts` (composer behaviour),
`components/SlashCommandPicker.tsx` (the menu, deliberately the same keyboard
contract and panel as `MentionPicker`) and `components/InvokedSkillChip.tsx`
(the composer chip naming the attached skill and its description).

## Activation transparency (`skills_activated`)

The runtime records which skills were actually **loaded** — forced first, then
invoked via `use_skill`, deduped — and the agent lifts that list onto the
terminal `system_response_message` as `skills_activated`; the reconnect path
persists it into assistant-message metadata
(`docs/api/websocket-protocol.md`).

The UI renders it as a quiet disclosure under the answer
(`features/skills/components/SkillsUsedDisclosure.tsx`): nothing at all when
no skill was activated, one muted line when some were, opening to name them
and state the mechanism — every skill contributes its name and description to
the catalogue on every turn, and only the activated ones had their full
instructions loaded. That is the progressive-disclosure model shown at the
moment it becomes concrete, rather than explained in documentation nobody
reads. It is also the distinction worth surfacing: "this skill was available"
is not news, "this skill's instructions shaped this answer" is.

Descriptions are fetched only when the panel is opened. Paying for an
org-scoped read on every rendered answer to fill a panel almost nobody opens
would be precisely the eager loading the skills model exists to avoid. A row
whose skill has since been deleted keeps its name rather than vanishing — the
name is still a true record of what ran.

## Config

`configs/config_oib_openrouter.yml`, `shallow_research_agent` (the NAT
workflow YAML — NAT's own vocabulary for an agent config):

```yaml
skills_enabled: true        # default true; false disables the use_skill tool + catalog
skill_allowlist: []         # empty = every resolved skill is offered
```

Both are fields on `ShallowResearchAgentConfig`; they only affect **research
turns** (`requires_sources=True`) — meta/conversational turns never load
skills, mirroring the interaction-only tool partition. Forced names and the
allowlist filter to the actual resolved set; unknown names are simply ignored
(fail-open on both sides: a typo in `skills:` never errors a turn).

Forced skills do **not** depend on the intent classifier. `force_skills` is
only ever set by an explicit `/name` invocation or a skill run, and gating the
`use_skill` tool on `requires_sources` alone made that a no-op on exactly the
short, imperative messages people type after a slash command. A plain greeting
still loads nothing.

The deep-research side is different by construction: it does NOT use the
`use_skill` tool or these config keys. Its skills are deepagents-native
(`deep_research_skills`, a `DeepResearchSkillsConfig` function-ref in the
config): per-agent skill *sources* wired through `SkillsMiddleware` with a
`FilesystemBackend` over `src/aiq_agent/skills/builtin/` and read-only
filesystem permission rules (`factory.runtime_skill_filesystem_permissions`).
`force_skills` is never passed to deep research — the chat orchestrator drops
it (`chat_researcher/agent.py`).

## Data model (grid_app, Drizzle)

Three tables, migration `frontends/ui/drizzle/0041_agent_skills.sql`, schema
`frontends/ui/src/lib/db/schema/skills.ts`. Each joins the tenant boundary
with a `grid_secure_table()` line in the same migration (ADR-0041).

`skills` — the org toolbox
- `id` uuid PK, `organization_id` text NOT NULL (denormalized WorkOS org id,
  never a FK — ADR-0007)
- `name` / `description` / `body` — the SKILL.md contract, validated at the
  routes by the same rules the backend applies
- `metadata` jsonb NOT NULL default `{}` — reserved keys read at fire time
- `origin` text NOT NULL default `'org'` (`org` | `platform-clone`),
  `cloned_from` text (the platform name a clone came from)
- `enabled` boolean NOT NULL default true, author columns, timestamps
- Indexes: unique `idx_skills_org_name` on `(organization_id, name)` — one
  skill per name per org, and the point query the fire/resolve paths make —
  plus `(organization_id)`
- Platform-authored skills are **not** rows here; they are files (see Origins).

`skill_schedules` — project-scoped, fires one named skill
- `project_id` uuid NOT NULL → `projects.id` ON DELETE CASCADE,
  `organization_id` text NOT NULL (denormalized)
- `name` text, `skill_name` text
- `skill_snapshot` jsonb NOT NULL — `{name, description, body, metadata,
  origin}` copied at save time, so a run is a deterministic WYSIWYG copy that
  cannot drift when the skill is later edited. This is the workflows
  "compiled prompt" contract, mirrored as JSONB
- `execution` text NOT NULL — denormalized at save time from
  `skill_snapshot.metadata['grid-execution']`; it decides the agent
- `data_sources` jsonb — `string[] | null`. User-selected entries are
  **additional** sources; `knowledge_layer` (project documents + OIB base
  corpus) is always included and prepended on save (`withAlwaysOnKnowledge`),
  and enforced again at fire time so legacy rows are covered. `null` still =
  all sources available to the agent. Those documents plus the base corpus are
  the product's factual/normative basis — a run without them is never intended
- `enabled` boolean NOT NULL default true, `schedule_cron` (5-field, NULL =
  manual-only), `schedule_timezone` (IANA, default UTC), `next_run_at`
  (computed at save time; NULL when no cron or disabled), `last_run_at`,
  author columns, timestamps
- Indexes: `(project_id)`, `(organization_id)`, and the partial
  `idx_skill_schedules_due` on `(next_run_at)` WHERE
  `schedule_cron IS NOT NULL AND enabled` — only rows that can ever fire are
  indexed, so the per-tick due probe stays a tiny scan. Partial indexes are
  not expressible in the Drizzle builder, so it lives in the SQL migration

`skill_runs` (append-only) — submission history
- `schedule_id` uuid NOT NULL → `skill_schedules.id` ON DELETE CASCADE,
  denormalized `project_id` / `organization_id`
- `job_id` text — backend async-job id; NULL when `skipped`/`error`
- `trigger`: `'manual' | 'schedule'`; `status`: `'submitted' | 'skipped' |
  'error'` — submission outcome only. Live job progress/results stay in the
  backend job store, joined by `job_id`
- `detail` text — skip reason (job cap, feature gate) or submission error
- `skill_snapshot` jsonb NOT NULL — the schedule's snapshot at fire time, so
  run history stays self-describing after the schedule is edited or purged
- `triggered_by` — user id for manual runs, `'scheduler'` for cron
- Indexes: `(schedule_id, created_at DESC)` for the newest-first history,
  `(project_id)`, `(organization_id)`, and a standalone `(created_at)` the
  retention prune needs (the composite cannot serve it without a
  `schedule_id` predicate)

## BFF API

All routes are feature-gated (`requireSkillsEnabled`). Authorization is
enforced in the service, not the route (ADR-0017); the routes are thin
adapters. Every query is additionally org-filtered.

Org toolbox (`frontends/ui/src/app/api/skills/…`):

- `GET  /api/skills` — the merged toolbox: every platform builtin plus every
  org row, org rows shadowing platform entries of the same name. Any member
  may read.
- `POST /api/skills` — author a skill (`org:skills:manage`). Validates the
  name/description rules and the reserved `grid-execution` value; a
  `clonedFrom` hint records a platform clone.
- `PATCH`/`DELETE /api/skills/{skillId}` — `org:skills:manage`.
- `GET  /api/skills/invocable` — the `/name` picker's list (name +
  description only, chat-executable, enabled). Any org member.

Project schedules (`…/api/projects/[id]/skill-schedules/…`, read =
`project:view`, mutate/run = `project:skills:manage` via
`requireProjectAccess`):

- `GET`/`POST /api/projects/{id}/skill-schedules` — list / create. Create
  resolves the skill (org row first, builtin fallback; unknown name → 404),
  snapshots it, denormalizes `execution`, validates the cron (5-field, IANA
  timezone, minimum interval) and computes `next_run_at`. A cron on a skill
  marked `grid-schedulable: "false"` is refused.
- `GET`/`PATCH`/`DELETE /api/projects/{id}/skill-schedules/{scheduleId}` —
  PATCH re-resolves the snapshot and recomputes `next_run_at`.
- `POST …/{scheduleId}/run` — manual "Run now" through the shared fire path;
  409 when the schedule is disabled; a backend 429 (job caps) comes back as a
  `skipped` run rather than an error.
- `GET  …/{scheduleId}/runs` — run history, newest first.

Internal (shared-token, `internalApiRoute`, unreachable from outside the
compose network):

- `POST /api/internal/skills/fire` — body `{scheduleId}`; the scheduler's
  entry point. Loads the schedule with no session (platform access, narrowly
  scoped to that lookup — everything the run then does is one organization's
  work and runs as that organization), re-checks `enabled` and the org's
  `skills` gate under flag enforcement (fail-closed, so a revoked flag pauses
  schedules with visible `skipped` runs), then fires.
- `GET /api/internal/skills/resolve?organization_id=…&agent=…` — the backend
  resolver's source for org skills. Note the **snake_case** query contract and
  that `agent` is optional but must be non-empty when present.

### The fire path

`fireSkillSchedule(schedule, trigger, actor)` is the single submission path
for both manual and scheduled runs:

1. Build the run context in parallel — budget snapshot, effective model
   overrides (ADR-0014), the project's ordered collection scope, project
   context and Bundesland — exactly what the interactive path attaches. The
   signed `X-Grid-Request-Context` envelope is built from those same values
   through the shared builder, so the skill path's wire format cannot drift
   from the interactive one.
2. POST the backend `POST /v1/internal/skills/submit` with
   `input` = `buildFirePrompt(snapshot)` (the deterministic prompt embedding
   the snapshot's name, description and full body), `skills` = the snapshot's
   name, and `execution` — which selects the agent.
3. Record a `skill_runs` row: `submitted` (+ `job_id`), `skipped` (a 429 with
   `Retry-After` → detail) or `error`, and touch `last_run_at`. Context
   building sits inside the try, so a transient DB/WorkOS failure surfaces as
   an `error` run row rather than an unrecorded throw. A skip never throws: an
   occurrence is not retried before its next slot.

Admission caps (`GRID_MAX_ACTIVE_JOBS[_PER_ORG]`) therefore apply to scheduled
runs automatically, and every run — however triggered — is visible in history.

## Backend internal route (Python, aiq_api)

`POST /v1/internal/skills/submit` (`aiq_api.routes.skills`) — guarded by
`GRID_INTERNAL_API_TOKEN` (`X-Internal-Token`, constant-time compare,
dev-default-token refusal outside dev — the `maintenance.py` pattern; NOT on
the external-path allowlist). It wraps `submit_agent_job`, so admission
control, cost tracking and `job_access` ownership apply exactly like the
public submit route; the agent is deterministic from `execution` (`chat` →
`shallow_researcher`, `deep-research` → `deep_researcher`) unless `agent_type`
overrides it, and the job carries `force_skills` so the worker force-activates
the named skills. Error mapping matches the public route: 429 + `Retry-After`,
409 duplicate, 503 scheduler-not-configured, 403 bad/missing token. Full
payload and response in `docs/api/python-endpoints.md`.

## Scheduler worker (`frontends/ui/scheduler/`)

Plain-Node worker (purger idiom: CommonJS, `postgres` client, `.spec.mjs`
tests), compose service `skill-scheduler` (container `grid-skill-scheduler`)
running `node scheduler/index.js` off the frontend image. It refuses to start
— clean log, exit 0 — unless the deployment gate is on
(`GRID_SKILLS_ENABLED=true` or `GRID_ENFORCE_FEATURE_FLAGS=true`), read
case-insensitively exactly as the BFF reads it, so `TRUE` cannot enable the UI
while silently no-op'ing this container.

Tick (default 30 s), with a reentrancy guard so a slow tick never overlaps the
next interval:

1. Claim, in one transaction:
   `SELECT id, schedule_cron, schedule_timezone, next_run_at FROM
   skill_schedules WHERE enabled AND schedule_cron IS NOT NULL AND
   next_run_at <= now() ORDER BY next_run_at LIMIT $batch FOR UPDATE SKIP
   LOCKED`, compute each row's next occurrence **strictly in the future**
   (`cron-parser`, per-row timezone; misfires coalesce — no backfill) and
   `UPDATE … SET next_run_at = $next`. Commit.
2. THEN fire each claimed row: `POST
   {FRONTEND_INTERNAL_URL}/api/internal/skills/fire` with the shared internal
   token, concurrently (schedules cluster on popular slots like daily-at-9, and
   sequential 30 s-timeout fires would let one slow BFF hop stall the tick).
   A 200 is not always a fire — the BFF answers `{fired:false, reason}` for
   disabled or gated rows, and those are logged as skips so operators see them.
   Fire failures are logged loudly and swallowed; the BFF records run rows, and
   if the BFF itself was unreachable the occurrence is missed once and the next
   occurrence heals it (ADR-0023 risks).
3. Retention: `DELETE FROM skill_runs WHERE created_at < now() - interval
   '$GRID_SKILL_RUNS_RETENTION_DAYS days'` (batched).

Claiming advances the schedule **before** firing, which is what makes a run
at-most-once per occurrence across replicas and crashes.

## Cron semantics

- 5-field cron, validated at save time in the BFF with `cron-parser`.
- Per-schedule IANA timezone (DST handled by the library).
- Minimum interval between occurrences: `GRID_SKILL_MIN_INTERVAL_MINUTES`
  (default 15) — enforced at save time by sampling successive occurrences.
- A skill declaring `grid-schedulable: "false"` cannot be given a cron at all.

## Environment variables

| Variable | Service | Default | Purpose |
|---|---|---|---|
| `GRID_SKILLS_ENABLED` | frontend, skill-scheduler | `false` | Dark-launch fallback gate while flags are unenforced; also the scheduler's start gate |
| `GRID_SKILL_SCHEDULER_POLL_MS` | skill-scheduler | `30000` | Tick interval |
| `GRID_SKILL_SCHEDULER_BATCH` | skill-scheduler | `20` | Max claims per tick |
| `GRID_SKILL_MIN_INTERVAL_MINUTES` | frontend | `15` | Minimum cron cadence accepted at save time |
| `GRID_SKILL_RUNS_RETENTION_DAYS` | skill-scheduler | `90` | Run-history retention |
| `GRID_SKILLS_CACHE_TTL_SECONDS` | aiq-agent | `60` | Backend org-skill resolution cache TTL (ADR-0020) |

(Existing: `GRID_APP_DATABASE_URL`, `FRONTEND_INTERNAL_URL`,
`GRID_INTERNAL_API_TOKEN`, `BACKEND_URL` are reused, not new.)

The workflow-era names (`GRID_WORKFLOWS_ENABLED`,
`GRID_WORKFLOW_SCHEDULER_POLL_MS`, `GRID_WORKFLOW_SCHEDULER_BATCH`,
`GRID_WORKFLOW_RUNS_RETENTION_DAYS`, `GRID_WORKFLOW_MIN_INTERVAL_MINUTES`) are
**not** read as fallbacks: they gated a feature that never shipped enabled, so
there is no deployment to ease off them.

## UI

Project sidebar gains a flag-gated `skills` section (`G` then `W`), page at
`app/projects/[id]/skills`: server shell (session → flag `notFound()` →
`requireProjectAccess` → project lookup → capabilities) around
`features/skills/components/skills-panel.tsx`. List mode shows the org skill
toolbox plus the project's schedules; the builder replaces both while
creating or editing a schedule. Org skill authoring (`org:skills:manage`) and
schedule management (`project:skills:manage`) are independent permissions, so
each capability is computed by the page and passed down.

Run history rows carry the **live** job status, not just the submission badge:
`RunHistory` joins its rows against
`GET /v1/jobs/async/jobs?project_collection=<proj_…>` — the same list the
History page uses — and shows `Queued / Running / Completed / Failed /
Cancelled`, repeating every 10 s while a run is still active. Best-effort:
without the join (backend unreachable, run outside the lookup window) the row
falls back to its submission badge. The row's action follows that status
(running → `?job=<id>&tab=tasks`, completed → `?job=<id>`, failed/cancelled →
`?job=<id>&tab=thinking`), and "Run now" opens the history and offers a *View
progress* action into the live job. A skill run has no owning conversation, so
the research panel attaches to the job without writing banners or error cards
into whatever chat thread happens to be open; TasksTab's outcome notice reports
how the run ended instead.

## Tests

- `tests/aiq_agent/skills/` — model validation, builtin discovery, resolver
  caching/shadowing/fail-open (including the resolve query contract: URL,
  token header, both param cases), runtime prompt/tool wiring.
- `tests/aiq_agent/agents/chat_researcher/` — the envelope parsing
  (`test_utils.py`, `test_register_helpers.py`) and per-turn skill forcing.
- BFF vitest: `lib/skills/service.spec.ts` (authz, tenant filters, snapshot
  and targeting semantics — pinned against the Python cases),
  `schedule.spec.ts` (cron + min interval + timezone), `platform-skills.spec.ts`,
  the feature-gate spec (`isSkillsEnabled` / `requireSkillsEnabled`, including
  the dark-launch property), `features/skills/lib/slash-command.spec.ts` and
  `components/skills-transparency.spec.tsx`.
- Scheduler: `.spec.mjs` unit tests for next-occurrence computation, misfire
  coalescing, claim/advance SQL (mocked sql), and the start gate.
- Backend pytest: token guard (403/503 dev-default), payload validation,
  admission-error mapping, `submit_agent_job` call shape, external allowlist
  non-exposure.

# GRID Backend Deep Dive — Chat, Cards, Project Knowledge, Files & Research

> Authoritative end-to-end map of how GRID's core flows work, why several were
> broken, and how they were fixed. Written 2026-07-04 from a full source trace
> (7 parallel explorations + NAT-internals verification). File references are
> `path:line` at time of writing.

## 1. System topology

Docker Compose (`deploy/compose/docker-compose.yaml`):

- **postgres** — 3 logical DBs: `aiq_jobs`, `aiq_checkpoints`, `grid_app`.
- **minio** — object storage, bucket `grid-documents`. Published to the host at
  `localhost:9000`; internal DNS name `minio:9000`.
- **aiq-agent** — FastAPI + NeMo Agent Toolkit (NAT) + embedded Dask
  scheduler/worker + in-process ChromaDB. Runs the LangGraph workflow and the
  async deep-research jobs.
- **frontend** — Next.js 16 BFF + a Node WebSocket proxy (`frontends/ui/server.js`).

The **real** backend front-end plugin is `frontends/aiq_api` (`_type: aiq_api`).
(The old `src/aiq_agent/fastapi_extensions/` duplicate was deleted 2026-07-03,
commit `2570b1b`; its one live route, `/v1/ingest`, was ported into `aiq_api`.)

The working config is `configs/config_oib_openrouter.yml` (OpenRouter DeepSeek +
OpenRouter embeddings). `config_grid_oib.yml` (Kimi) is not currently working.

## 2. Chat request lifecycle (WebSocket-only)

Chat is **WebSocket only**. The old SSE `/api/generate` chat path is dead; SSE
now serves **only** the deep-research job stream (§7).

```
Browser WebSocket
  → frontends/ui/server.js  (WS upgrade proxy)
      • calls internal /api/websocket-scope?projectId=…  to fetch:
          - projectContext  → sets header  x-grid-project-context
          - collection scope → sets header  x-grid-collection-scope
      • proxies the upgrade to the aiq-agent backend
  → NAT workflow  chat_deepresearcher_agent
      LangGraph:  intent_classifier
                    ├─ meta      → END
                    ├─ shallow   → shallow_research ─(escalate?)→ clarifier
                    └─ deep      → clarifier → deep_research
  → response streamed back through the MONKEYPATCHED WS handler
      frontends/aiq_api/src/aiq_api/websocket_reconnect.py
  → frontends/ui/src/adapters/api/websocket-client.ts  (parse system_response)
  → frontends/ui/src/features/chat/hooks/use-websocket-chat.ts  (onResponse)
  → frontends/ui/src/features/layout/components/ChatArea.tsx → AgentResponse.tsx
```

Key files:
- Graph build: `src/aiq_agent/agents/chat_researcher/agent.py` (`_build_graph`, nodes).
- Workflow registration + response creation: `src/aiq_agent/agents/chat_researcher/register.py`.
- WS wire types (NAT, vendored): `.venv/Lib/site-packages/nat/data_models/api_server.py`
  — `ChatResponse` and the WS message models are `extra="allow"`, so extra
  fields (cards, deep_research_job_id) survive serialization.

### The monkeypatch (critical seam)

`websocket_reconnect.py:create_websocket_message` takes the workflow's
`ChatResponse` (`data_model`) and builds the top-level `system_response` WS
message. It **lifts extra fields off the response onto the top-level message**
so the frontend can read them at `message.<field>` (not nested under
`message.content`):

- `cards`  → `message.cards`  (rendered as Grid cards)
- `deep_research_job_id` → `message.deep_research_job_id` (opens the research panel)

If you add another structured signal to the chat response, this is where it must
be lifted, and the frontend Zod schema (`schemas.ts`) must declare it.

## 3. The card pipeline

**Cards are the rich-UI presentation layer**, not a citations feature. The agent
answers in plain markdown by default and emits a typed *card* whenever a
structured/rich format serves the user better. `LegalBasisCard` is one instance;
the set is meant to grow (summaries, profile patches, and later e.g. requirement
checklists, comparison tables, action prompts, standard-applicability panels).
Because cards are model-*chosen* rich UI, generation is inherently LLM-driven —
the design goal is to make card emission a **first-class, robust output channel**
(visible failures, one shared typed schema front+back, and a frontend renderer
registry so a new card type = define model + add renderer, no pipeline surgery),
NOT to bolt on a silently-failing second LLM call.

Cards (`SummaryCard`, `LegalBasisCard`, `ProjectProfilePatchCard`) are defined in
`src/aiq_agent/cards/models.py` (discriminated union, `validate_cards`); the
frontend renders them in `frontends/ui/src/features/grid-cards/`.

### How generation works (post-fix)

Card generation is a **second LLM call** (`ChatResearcherAgent._generate_cards`,
`agent.py`) run in `run()` after the graph produces an answer, using the
`card_generator_llm` (config: `deepseek_super_llm`). Post-fix behaviour:

- Cards are generated whenever a turn produced a real answer (`query` + `context`).
  The old code hard-gated on `intent == "research"` and was inconsistent between
  its two return-shape branches; this was unified.
- Generation is **skipped when the turn only dispatched an async deep-research
  job** (the "answer" is just the job-submitted stub — nothing to card).
- The result rides `ChatResponse.cards` → monkeypatch → `message.cards` → the
  frontend `validateGridCards` → `GridCards.tsx`.

### The deep-research card gap (still open — see §7)

With `use_async_deep_research: true` (the working config), any query routed to
deep research returns the stub `"Deep research job submitted. Job ID: …"`. The
**real** answer is produced later by `frontends/aiq_api/src/aiq_api/jobs/runner.py`
(`run_deep_research`), which currently has **no card-generation code**. So
deep-research answers cannot carry cards yet. Closing this requires generating
cards from the final report in `jobs/runner.py` and delivering them through the
job SSE stream (the report artifact) — a change that must be verified against a
running stack.

### Removed dead mechanism

`deep_researcher/prompts/writer.j2` previously instructed the writer to emit a
`<grid_cards>…</grid_cards>` block, but the same prompt tells it to write the
report to `/shared/output.md` and return only a marker — and nothing ever parsed
the block. It could only leak raw JSON into reports. **Removed.**

## 4. Project knowledge — the intake-wizard context

> "Project knowledge" here = the intake-wizard profile injected as agent context.
> This is distinct from RAG/file scoping (§6), which works independently.

Pipeline (all correctly wired):

```
Intake wizard answers
  → PUT /api/projects/{id}/profile
      buildProfileUpdate → buildProjectPromptView(profile)
      → stored in projects.profile_prompt_view  (a compact "PROJECT_CONTEXT v1" block)
  → /api/websocket-scope reads profile_prompt_view → returns projectContext
  → server.js sets header  x-grid-project-context  on the WS upgrade
  → src/aiq_agent/project_context.py reads the header (truncated to 4000 chars)
  → chat_researcher/register.py sets state.project_context
  → injected into every prompt: all *.j2 have {% if project_context %}{{ project_context }}
```

### The bug that was fixed (WebSocket projectId race)

The header only carries when the WS handshake includes the correct `projectId`
query param. The client used to **snapshot `projectId` once** via
`useChatStore.getState().projectId` at socket-creation time, with the connect
effect **not keyed on `projectId`** and **no way to update it**. Because React
fires child effects before parent effects, on first navigation into a project
(the wizard's landing) the socket connected with `projectId: undefined` → the
header was never sent → the agent had no project knowledge for that session.

**Fix** (`use-websocket-chat.ts`, `websocket-client.ts`):
- Subscribe to `projectId` reactively and add it to the connect-effect deps, so
  the socket is (re)established once the project store resolves.
- Added `NATWebSocketClient.updateProjectId()` which rotates the socket (same
  atomic swap used for auth rotation) only when the value actually changes, so
  the handshake re-sends the project scope.

Note: the profile is intentionally **not** embedded into the `proj_*` RAG
collection — project knowledge reaches the agent only via header text-injection:
this profile header plus the project-memory digest header (`x-grid-project-memory`,
see §8).

## 5. Project summary / fact-sheet

The Project Overview "Project Brief" panel (`project-overview.tsx`) renders three
parts from `projects.profile_display`:
- `summary` — an AI-generated prose description.
- `keyFacts` — a deterministic `<dl>` derived from `profile.facts`.
- `missingInfo` — the profile's unknowns.

Summary generation: the intake wizard fires
`POST /api/projects/{id}/generate-summary` → backend `/v1/generate-summary`
(`frontends/aiq_api/.../routes/generate_summary.py`, registered in `plugin.py`)
→ result stored into `profile_display.summary`.

### The bug that was fixed (summary wiped on every save)

`buildProjectProfileDisplay` used to hardcode `summary: ''`, so every profile
save/patch blanked the AI summary; only the intake wizard regenerated it, so any
chat-driven profile edit permanently lost the prose. **Fix**: the function now
takes a `previousSummary` and both callers (`profile/route.ts`,
`profile/patches/route.ts`) pass the current `profile_display.summary` through,
preserving it across rebuilds.

Operational note: `/v1/generate-summary` fails silently (swallowed try/catch on
both ends) if the `aiq_api` process has no LLM key. Ensure `OPENROUTER_API_KEY`
(or `SUMMARY_LLM_API_KEY`) is set, else the summary stays empty even though the
fact-sheet renders.

## 6. Files, documents & RAG

- **Upload**: `POST /api/documents/upload` streams the file to MinIO **server-side**
  via `s3Client` (internal endpoint), records a `documents` row, then presigns a
  GET URL and hands it to backend `/v1/ingest` as `file_ref`. Because the backend
  consumes that URL from **inside** the Docker network, it correctly uses the
  **internal** endpoint.
- **Preview / download**: `/api/documents/{id}/preview` and `/download` presign a
  GET URL for the **browser** to fetch.

### The bug that was fixed (PDF preview/download broken)

Preview/download presigned with the internal `MINIO_ENDPOINT=http://minio:9000`,
which the browser cannot resolve — so both silently failed. **Fix**:
`src/lib/s3.ts` now exposes a second `signingS3Client` bound to
`MINIO_PUBLIC_ENDPOINT` (browser-reachable; defaults to `http://localhost:9000`
in dev), and the preview/download routes sign with it. The upload route keeps the
internal client (its URL is backend-consumed). Compose sets `MINIO_PUBLIC_ENDPOINT`.

### Folders

Nested folders are fully supported (self-referential `project_folders.parent_id`,
`folder-service.ts` builds the nested path, the API accepts `parentId`, and the
tree renders recursively). The prior "can't nest" symptom was **UX only** — there
was no per-folder affordance. **Fix**: `folder-tree-pane.tsx` now shows an "add
subfolder" `+` on each folder row and makes root creation explicit.

### Collection scoping (multitenancy)

Every backend call carries a base64url `X-Grid-Collection-Scope` header =
`[oib_knowledge, proj_<id>, s_<conversation>]`, built in
`src/lib/collection-scope-request.ts` and validated backend-side. This is the core
RAG multi-tenant boundary. Note `resolveProjectCollectionName` short-circuits to
no project scope when `session.organizationId` is falsy (anonymous /
`REQUIRE_AUTH=false`).

## 7. Deep research (async jobs)

- The `deep_research` graph node submits a Dask job and returns the stub message
  **plus** a structured `deep_research_job_id` (added in this pass), threaded
  through `ChatResearcherState` → `ChatResponse.deep_research_job_id` → monkeypatch
  → `message.deep_research_job_id`.
- The frontend (`use-websocket-chat.ts`) opens the research panel from the
  **structured field** (`deepResearchJobId`), falling back to the old prose regex
  only for older backends. This fixes the fragile-regex failure where any wording
  drift silently hid the entire research panel.
- Job data (progress, thinking, citations, report) streams via SSE from backend
  `/v1/jobs/async/*` through the BFF proxy `/api/jobs/async/[...path]` into the
  `ResearchPanel` (Tasks / Thinking / Report tabs).

**Open item**: deep-research answers do not yet carry Grid cards (§3). And the
research tab can 403 — see §9.

## 8. Backend agent architecture & DRY debt

Registered agents (via NAT `@register_function` + `FunctionBaseConfig`):
`intent_classifier`, `chat_deepresearcher_agent` (entrypoint), `clarifier_agent`,
`shallow_research_agent`, `deep_research_agent` (+ eval/placeholder wrappers).

No shared base-agent class exists; four agent classes each repeat: tool
resolution/exclusion, `LLMProvider` construction, verbose/trace callback setup,
per-request data-source-filtered rebuild, tool-availability validation, and
prompt-loading fallbacks. Good shared primitives already live in
`src/aiq_agent/common/` (`llm_provider`, `data_source_registry`, `tool_validation`,
`prompt_utils`, `citation_verification`).

**Recommended (not yet implemented):** a `src/aiq_agent/common/agent_base.py`
providing `resolve_tools()`, `build_llm_provider()`, `with_tool_guard()`, a
prompt-loading mixin, and an eval-wrapper factory — collapsing the duplication
without touching the genuinely agent-specific LangGraph node logic. This is a
refactor that should be verified against a running stack before merge.

### Project memory (implemented)

The agent can now persist curated findings across turns. Full design:
`docs/architecture/project-memory-design.md`. Key facts:

- **Single-writer**: the `grid_app` DB has exactly one writer, the Next.js BFF.
  The backend `remember` tool never touches the DB — it POSTs to the internal
  BFF endpoint `POST /api/internal/memory`
  (`frontends/ui/src/app/api/internal/memory/route.ts`), authenticated by the
  shared service token `GRID_INTERNAL_API_TOKEN` (`x-grid-internal-token`
  header; the route fails closed with 503 when the token is unconfigured).
  Backend client: `src/aiq_agent/knowledge/project_memory.py` (base URL from
  `FRONTEND_INTERNAL_URL`, default `http://frontend:3000`).
- **Two scopes**: the `project_memory` table has a `scope` column —
  `project` (requires `projectId`) or `organization` (org-wide, requires
  `organizationId`, `projectId` null).
- **Read path**: `buildProjectMemoryDigest()`
  (`frontends/ui/src/lib/projects/memory-service.ts`) merges org-wide +
  project items (active only; pinned first, then most recently updated,
  bounded), tags each line with scope/kind/confidence/verification, and the
  digest rides the WS upgrade as the `x-grid-project-memory` header
  (`server.js` → `src/aiq_agent/project_context.py`), injected into prompts
  alongside `x-grid-project-context`.

## 8b. Runtime model overrides & usage metering (2026-07-07)

Two org-level runtime systems sit on top of the static workflow config —
full specs in `org-model-configuration.md` (ADR-0014) and
`usage-budgets.md` (ADR-0015); summary of the backend seams:

- **Model overrides**: `x-grid-model-overrides` (base64url JSON
  `{agentGroup: openrouterModelId}`) is parsed by
  `src/aiq_agent/common/model_overrides.py` and applied request-scoped:
  `LLMProvider.with_model_overrides()` (group-tagged roles; identity when
  nothing applies) in the shallow/deep/clarifier `_run` closures, plus
  `apply_model_override()` at the intent-classifier invocation, the
  clarifier planner, and the reflection scheduling site. Async jobs carry
  the map through `submit_agent_job` → `jobs/runner.py` (provider + header
  re-injection). Only the model id changes; params/keys stay from YAML.
- **Cost capture (DRY)**: `src/aiq_agent/common/cost_tracking.py` installs
  `GridCostTracker` through LangChain's `register_configure_hook` ContextVar
  seam — every callback manager configured inside the request picks it up,
  so agents contain no metering code. Activated in exactly three places:
  the chat workflow `_run`, the Dask job runner, and the reflection task.
  Events (model, tokens, OpenRouter `usage.cost`, generation id) POST to
  the token-guarded `POST /api/internal/usage` (single-writer rule).
- **Budgets**: `x-grid-budget` carries remaining USD per scope
  (org/member/project); the tracker raises `BudgetExceededError` before the
  next LLM call once exhausted (sync path returns a friendly chat response);
  the BFF refuses the WS upgrade outright when already over.

## 9. Known issues / open items

- **Research tab 403** — origin is `requireAuthorizedSession()` throwing
  `Unauthorized` in the BFF proxy (`/api/jobs/async/[...path]`), mapped to 403 by
  `backend-proxy.ts` when there is no WorkOS session at request time (auth
  required + missing/expired cookie). A secondary candidate is the backend
  `require_verified_principal()` under `REQUIRE_AUTH=true`. Distinguish by the
  error code: `FORBIDDEN` (frontend) vs `BACKEND_ERROR` (backend). Note
  `requireAuthorizedSession()` also `redirect()`s no-org users, which is invalid
  inside an API route — a latent bug for users without an organization. **Needs
  runtime evidence to fix safely; do not guess-patch auth.**
- **Deep-research cards** — not delivered on the async path (§3/§7).
- **Silent LLM failures** — card generation and summary generation both swallow
  exceptions; consider surfacing a degraded signal to the UI.
- Infra: live secrets in `deploy/.env`; backend DBs have no migration mechanism
  (init only); config drift between the two config files.

## 10. Verification workflow

The host's `npm install` hangs, so verify in containers:

- **Frontend typecheck (fast, no NGC auth):**
  ```
  cd frontends/ui
  docker build -q -f Dockerfile.typecheck -t grid-tsc .   # deps layer caches
  docker run --rm grid-tsc                                 # runs tsc --noEmit
  ```
  Note: tsconfig includes test files, so spec type errors block the production
  `next build`.
- **Backend:** `.venv/Scripts/python.exe -m py_compile <files>` and
  `.venv/Scripts/ruff.exe check <files>` (uv hangs on cross-filesystem sync here).
- **Full stack / runtime:** the `.devcontainer` (VS Code, `deploy/Dockerfile`
  target `dev-builder`, NGC auth required) or `docker compose … up -d --build`.
  Runtime-behavioural changes (deep-research cards, agent refactor, research 403)
  must be verified here before merge.

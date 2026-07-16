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
- **dragonfly** — Redis-protocol shared cache (ADR-0020): read-through caches
  (membership, flags, prompt view, model overrides, budget limits, model
  catalog), the gateway's WS-upgrade rate limiter, and per-conversation
  citation-registry snapshots. Cache-only semantics; both tiers fail open to
  in-process fallbacks when it is down or `REDIS_URL` is unset.

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

### Deep-research cards (async path: closed; sync inline path: open)

With `use_async_deep_research: true` (the working config), any query routed to
deep research returns the stub `"Deep research job submitted. Job ID: …"`. The
**real** answer is produced later by `frontends/aiq_api/src/aiq_api/jobs/runner.py`
(`run_agent_job`), which now generates cards post-hoc from the final report
(`_generate_grid_cards` → `aiq_agent.cards.generate_cards`), re-emits the
report artifact with cards attached over the job SSE stream, and stores
`{"report", "cards"}` as the job output. Deep research cannot use the
`emit_card` tool directly: the conversation-scoped `CardRegistry` is bound
only in the chat request path, not inside a Dask worker. The remaining gap is
the **synchronous inline** deep-research path (no Dask scheduler configured):
those answers carry no cards, since the deep agent has no `emit_card` tool
and no post-hoc generation runs in `deep_research_node`.

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

The Project Overview "Project Brief" panel (`project-brief.tsx`, mounted by
`project-overview.tsx`) renders the AI `summary` from `projects.profile_display`
plus a fact sheet derived **at render time from the raw `projects.profile`** via
`buildProjectBriefView` (`lib/project-profile/brief-view.ts`): facts grouped in
intake-stage order with question/option labels ("Main use: Residential", not
"hauptnutzung: wohnen"), goal focus areas, unanswered questions as links back
into the wizard, a completeness count, and agent-suggested `assumptions` with
confirm/dismiss actions (confirm graduates the value into a `user_confirmed`
fact through the same patches endpoint the agent's `project_profile_patch`
cards use). `buildProjectProfileDisplay` (the stored `profile_display`
projection) uses the same labels.

### Agent-driven brief updates (project_profile_patch)

The agent keeps the brief current by emitting a `project_profile_patch` card
(via `emit_card`) whenever the conversation establishes a durable hard fact —
the shallow-researcher prompt has an explicit "Keeping the Project Brief
current" policy, and the card model carries the canonical fact-key vocabulary
(`PROFILE_FACT_VOCABULARY` in `cards/models.py`, mirroring the intake
definition). The card only proposes: the user's Accept posts the JSON-Patch to
`POST /api/projects/{id}/profile/patches`, which normalizes bare values into
full fact objects (`source: 'user_confirmed'` — accepting IS the confirmation),
applies them through the shared patch engine, and prunes unknowns the patch
just answered. `GridCards` receives the chat store's `projectId` in both the
chat bubble (`AgentResponse.tsx`) and the research report (`ReportTab.tsx`), so
Accept is live wherever the card renders.

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

### Document summaries & `available_documents` (SQL side-table, distinct from the vector index)

Two separate stores back "documents" and **can diverge**: the **ChromaDB
vector index** that `knowledge_search`/`knowledge_retrieval` queries (what's
actually retrievable), and a **SQL `summaries` side-table** (`SummaryStore`,
`src/aiq_agent/knowledge/summary_store.py` + `factory.py
get_available_documents_async`) that is the **sole source** of the
`available_documents` list (file name + summary, optionally tags) rendered
into agent prompts and shown in the Data Sources panel. A document can be
fully ingested and retrievable via `knowledge_search` yet be **absent** from
`available_documents` — see the known limitation below.

`available_documents` is fetched **once per turn**, in
`chat_researcher/register.py` (~lines 530–581), aggregated across the
collections in the request's header-based scope (or the base + session
collection fallback when no scope header is present) and deduplicated by file
name. The same list is then shared by the shallow, clarifier, and deep-research
paths for that turn — it is not re-fetched per node.

**Prompt gating asymmetry (known limitation, fix pending)**: the shallow
researcher's prompt (`agents/shallow_researcher/prompts/researcher.j2:31`)
carries an *unconditional* "use `knowledge_search` first for user documents"
instruction — the shallow path always tries the tool regardless of
`available_documents`. The deep-research prompts instead gate document
awareness purely on `available_documents` being non-empty:
`agents/deep_researcher/prompts/planner.j2`,
`agents/deep_researcher/prompts/orchestrator.j2`,
`agents/deep_researcher/prompts/researcher.j2`, and
`agents/deep_researcher/prompts/source_router.j2` all wrap their document
listing in `{% if available_documents %}` (or the length-checked variant).
When the summaries table has no row for a collection's documents (see below),
the deep path never surfaces project content in its prompts at all, even
though `knowledge_search` could still retrieve it.

**Silent summary-row loss on double LLM failure (known limitation, fix
pending)**: ingestion (`sources/knowledge_layer/src/llamaindex/adapter.py`,
~lines 1795–1965) runs summary generation and tag classification as two
concurrent calls to the same `summary_llm`; both independently swallow
exceptions/timeouts and return `None` on failure. The deterministic,
text-derived fallback summary only kicks in when `not summary and tags and
text_documents` — i.e. only when tag classification succeeded but
summarization did not — and `register_summary()` (the only call that writes a
`summaries` row) only runs `if summary:`. So when **both** calls fail, no row
is ever written, even though the file's chunks were embedded successfully and
the file was already marked `FileStatus.SUCCESS`. The document stays fully
searchable via `knowledge_search` but is permanently invisible in
`available_documents` (Data Sources panel summary list, deep-research
prompts above) until the document is re-ingested or backfilled.

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

**Open items**: synchronous inline deep-research answers (no Dask) do not
carry Grid cards (§3; the async job path generates them post-hoc in the
runner). And the research tab can 403 — see §9.

**Collection-scope re-injection gap (known limitation, fix pending)**: the
`X-Grid-Collection-Scope` header is captured once at submit time
(`chat_researcher/register.py`) and threaded into the async job payload as
`collection_scope`. The Dask worker only re-injects it into its own request
context conditionally —
`frontends/aiq_api/src/aiq_api/jobs/runner.py:591` does `if collection_scope
is not None:` before base64url-encoding it back onto the header. When the
scope is absent, `knowledge_retrieval` inside the worker falls back to legacy
config-based resolution (base collection + session collection only — see
`docs/technical-reference/collection-scoping.md`). Because
`project_collections` is `[]` in the shipped configs, project collections are
**never** searched in that fallback path for the affected job, and no warning
is logged — the degradation is silent.

**Workflows (ADR-0023, 2026-07-16)**: saved per-project research briefs can
fire this same async pipeline on a cron schedule — a dedicated
`workflow-scheduler` container claims due rows in `grid_app`
(`FOR UPDATE SKIP LOCKED`) and fires through the BFF's internal endpoint into
`POST /v1/internal/workflows/submit` (internal-token-guarded wrapper around
`submit_agent_job`, so admission control and cost tracking apply unchanged).
See `docs/architecture/workflows.md`.

**Deep-research agent graph internals**: the orchestrator/planner/researcher/
writer middleware stack, structured-output contracts, and graph invariants
(concurrency, recursion limit, skill filesystem permissions) live in
`src/aiq_agent/agents/deep_researcher/README.md`. Its "Known limitations"
section documents three known-but-unfixed defects found by a source audit
against the installed `deepagents`/`langchain`/`langgraph` versions —
summarized in §9 below.

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
  exceptions; consider surfacing a degraded signal to the UI. This also covers
  document-ingestion summary/tag generation specifically — see the
  "Silent summary-row loss on double LLM failure" note in §6.
- **`available_documents` vs. ChromaDB divergence** — the SQL summaries
  side-table that feeds `available_documents` can miss documents that are
  fully indexed and retrievable in ChromaDB (§6). Deep-research prompts gate
  document awareness entirely on this list being non-empty, unlike the
  shallow path (§6).
- **Async job collection-scope fallback** — `collection_scope` is only
  re-injected into the Dask worker context when present; absent scope
  silently drops project-collection search for that job (§7).
- **Deep-research tool-result pruning defeats prompt-prefix caching** —
  `ToolResultPruningMiddleware` recomputes a positional sliding window on
  every model call, so message bytes shift turn over turn on the ~80k-token
  contexts a deep run accumulates, invalidating OpenRouter/DeepSeek
  prompt-prefix caching; it also runs uncoordinated with deepagents' own
  (stable-cutoff) summarization middleware and counts no-op `think` results
  toward its window. See `src/aiq_agent/agents/deep_researcher/README.md`
  "Known limitations" for details.
- **Deep-research strict structured-output schema bounds** —
  `EvidenceJudgment.relevance_score`'s `ge=0`/`le=100` bounds compile to
  JSON-Schema `minimum`/`maximum`, unsupported in strict `json_schema` mode
  on some providers; `tools/research.py`'s fenced-JSON fallback parser papers
  over the resulting researcher-worker failures without fixing the root
  cause. See the same README section.
- **Deep-research planner ceremony overhead** — deepagents' `StateBackend`
  is write-once (a second `write_file` to an existing path errors; recovery
  is via `edit_file`); the planner prompt additionally mandates a todo-list
  ceremony and a `think` call after every search, adding several
  pure-ceremony LLM turns per planning run. Prompt tuning to reduce this is
  pending.
- **NAT step-tree/span corruption after a retried call (known limitation,
  local wrapper fix pending)** — the recurring log warnings `Step id ... not
  the last step in the stack` / `span ID stack is not equal` come from NAT's
  `LangchainProfilerHandler`
  (`nat/plugins/langchain/callback_handler.py`, `nvidia-nat==1.7.0`), which
  implements `on_llm_start`/`on_chat_model_start`/`on_llm_new_token`/
  `on_llm_end`/`on_tool_start`/`on_tool_end` but no `on_llm_error` or
  `on_tool_error`. An errored (then retried) model or tool attempt therefore
  never closes its intermediate-step span; the orphaned span makes the next
  legitimate `END` pop more than one frame off the stack, producing the
  warnings. Consequence: the NAT step tree / OTel span tree is malformed for
  any run that retried anything — which, given the retry stacking below, is
  most deep-research runs that hit any transient error — but `run_id`-keyed
  token/cost accounting (§8b) is **not** corrupted by this. Root cause is
  upstream NAT, amplified by our own broad retry policy; no NAT-side fix is
  available today, so any correction has to be a local wrapper around the
  handler.
- **Shared trace-callback state across concurrent researcher workers (known
  limitation, fix pending)** — `VerboseTraceCallback` mutates per-run state
  (`current_input`, `active_chains`, `depth` — `common/callbacks.py`) and
  exists specifically to avoid leaking that state *across* runs: `for_new_run()`
  hands each deep-research run a fresh instance
  (`DeepResearcherAgent._prepare_run()`, ADR-0018). That fix operates at
  run granularity, not worker granularity — the one fresh instance a run
  gets is then passed as a shared `callbacks` entry into the graph and used
  by every concurrent researcher worker inside that run (up to
  `max_research_concurrency`, default 6, workers via
  `run_research_batch`'s `asyncio.Semaphore`/`asyncio.gather`). Concurrent
  workers mutating the same `depth`/`current_input`/`active_chains` can
  misattribute verbose trace log lines (indentation, "current input") across
  workers. The same pattern recurs in the async job runner: `runner.py`
  builds one `VerboseTraceCallback()` and one `LangchainProfilerHandler()`
  per job (not per worker) and both are shared across that job's concurrent
  researcher workers.
- **Async deep-research jobs are not restart-safe (known limitation)** — the
  deepagents graph is built with `store=InMemoryStore()`
  (`agents/deep_researcher/factory.py`), and `checkpoint_db`/
  `get_checkpointer()` (`common/__init__.py`) is wired only into the
  synchronous chat graph (`chat_researcher/register.py`); nothing persists
  deep-research graph/agent state. If the process running a deep-research
  job dies mid-run (worker crash, restart), only the SQL job-store status
  row survives — the run itself is gone, not paused. The ghost-job reaper
  (ADR-0021, `scaling-review-2026-07.md` §2.4) flips the orphaned row to
  `FAILURE` after its timeout; there is no queueing or resume, and a future
  DB-claimed-worker migration (ADR-0021) fixes replica pinning/cross-node
  cancel but does not by itself add resume — that also needs the
  deepagents graph state to move off `InMemoryStore` onto a persisted
  store.
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

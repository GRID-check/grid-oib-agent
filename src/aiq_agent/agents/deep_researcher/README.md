# Deep Researcher Agent Architecture

This document describes the deep agents implementation using the [LangChain DeepAgents](https://docs.langchain.com/oss/python/deepagents/overview) library for multi-phase research workflows.

## Overview

The deep agents architecture provides a publication-ready research report generation system through an iterative multi-agent workflow. It uses specialized subagents coordinated by an orchestrator to produce comprehensive, cited research reports.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                  DeepResearcherAgent                             │
│                 (DeepAgents orchestrator)                        │
│                    ORCHESTRATOR LLM                              │
│                                                                  │
│  Tools: think, get_verified_sources, run_research_batch          │
│  Delegates to subagents via task(); files live under /shared/    │
└──────────────────────────────────────────────────────────────────┘
        │                │                    │                │
        ▼                ▼                    ▼                ▼
┌───────────────┐ ┌───────────────┐ ┌──────────────────┐ ┌────────────────┐
│ source-router │ │ planner-agent │ │ run_research_    │ │  writer-agent  │
│    -agent     │ │  PLANNER LLM  │ │ batch tool       │ │REPORT_WRITER   │
│  ROUTER LLM   │ │               │ │ (researcher      │ │      LLM       │
│               │ │ Plans queries │ │ workers,         │ │                │
│ Advisory      │ │ via discovery │ │ RESEARCHER LLM,  │ │ Reads /shared/ │
│ domain/source │ │ searches →    │ │ concurrent,      │ │ plan + notes → │
│ route →       │ │ ResearchPlan +│ │ structured       │ │ cited Markdown │
│ /shared/      │ │ /shared/      │ │ ResearchNotes →  │ │ → /shared/     │
│ source_       │ │ plan.json     │ │ /shared/         │ │ output.md      │
│ routing.json  │ │               │ │ research_note_*  │ │                │
└───────────────┘ └───────────────┘ └──────────────────┘ └────────────────┘
```

Research source tools (web search, knowledge search, paper search, custom
tools) are used by the planner (discovery) and researcher workers. Source
tools with a single string input are upgraded to same-name batch-capable
wrappers with a shared concurrency limiter
(`tools/source_tool_batching.py`).

## Run lifecycle (ADR-0018)

The agent instance holds only immutable configuration (LLM provider, tool
list, prompts, concurrency knobs). Everything a run mutates — the
`SourceRegistryMiddleware`, the batch/throttle tool wrappers with their
concurrency limiter, the middleware stacks, and the graph — is built fresh
per run by `DeepResearcherAgent._prepare_run()` into a
`DeepResearchRunArtifacts` bundle. No run can observe another run's
captured sources, compact citation keys, or throttle state; cross-turn
source continuity in conversation mode lives in the session-scoped
registry bound by the chat entrypoint. Anything new that a run can mutate
belongs in `DeepResearchRunArtifacts`, never on the agent instance. See
[ADR-0018](../../../../docs/adr/0018-per-run-state-for-deep-research.md).

## Middleware Stack

Built per run in `factory.py` (`build_common_middleware`), shared by the
orchestrator and all subagents:

| Middleware | Purpose |
|------------|---------|
| `EmptyContentFixMiddleware` | Replaces empty ToolMessage content (some APIs reject it) |
| `ToolNameSanitizationMiddleware` | Repairs corrupted/hallucinated tool names |
| `ToolRetryMiddleware` (langchain) | Retries failed tool calls with backoff |
| `SourceRegistryMiddleware` | Captures source URLs/citation keys from tool results; feeds `get_verified_sources` and citation verification |
| `ToolResultPruningMiddleware` | Truncates older tool results to protect the context window. Keeps the last `keep_last_n` **oversized** `ToolMessage`s intact (default 10, all agents but the writer, which scales with `max_research_concurrency` to cover every research-note read) and truncates earlier ones to `max_chars` (default 2000; writer gets 20,000). Truncation is monotonic (recorded per message id, frozen once applied) rather than recomputed per call — see [Known limitations](#known-limitations) for the residual prompt-caching gap |
| `ModelRetryMiddleware` (langchain) | Retries model calls with backoff |

The orchestrator additionally gets DeepAgents runtime middleware
(TodoList, Filesystem, SubAgents) from `create_deep_agent`. Researcher
workers are separate `create_agent` runnables with `FilesystemMiddleware`,
summarization middleware, `PatchToolCallsMiddleware`, and structured
`ResearchNotes` output — no TodoList. When no sandbox is configured, a
`ToolVisibilityMiddleware` hides the `execute` tool.

## Workflow Phases

### Phase 1 (optional): Source Routing

The **source-router-agent** (enabled by `enable_source_router`, default
true) reads the configured source/domain catalog via
`lookup_source_catalog` and writes an advisory route to
`/shared/source_routing.json`. The planner treats it as guidance, not a
constraint.

### Phase 2: Research Planning

The **planner-agent** runs discovery searches (internal-vs-external
triage first), then returns a structured `ResearchPlan` — task analysis,
answer strategy with required components, constraints, and self-contained
`ResearchQuery` objects — and writes it to `/shared/plan.json`.

### Phase 3: Batched Research

The orchestrator submits planned queries to the **`run_research_batch`**
tool (at most `max_research_concurrency` per call). Each query runs a
researcher worker concurrently — bounded by an `asyncio.Semaphore` and
gathered via `asyncio.gather(..., return_exceptions=True)`, so one worker's
failure doesn't cancel the others. Workers return structured `ResearchNotes`
(findings, sources, gaps, evidence judgment) which the tool persists under
`/shared/` and registers with the source registry. Failed workers surface
as tool errors listing only the queries to resubmit — `run_research_batch`
is registered `no_retry` (`factory.py`'s `_NO_RETRY_TOOL_NAMES`) precisely
so the *orchestrator* reacts to a partial failure (resubmitting only the
failed queries), instead of the tool-retry middleware blindly re-running the
whole batch and repeating every already-successful multi-LLM-call worker.

### Phase 4: Final Synthesis

The **writer-agent** reads the plan, all research notes, and the verified
source list (`get_verified_sources`), then writes the final cited Markdown
to `/shared/output.md` and returns a short completion marker.

### Phase 5: Deterministic Post-Processing

`DeepResearcherAgent.run()` extracts `/shared/output.md`, verifies every
citation against the captured source registry (`verify_citations`,
controlled by `enable_citation_verification`), sanitizes URLs
(`sanitize_report`), re-emits the final report through callbacks, and
replaces the final message content. A run that captured no sources raises
`EmptySourceRegistryError`.

## Components

### Function: `deep_research_agent`

The core deep research agent using the DeepAgents library.

**Location**: `src/aiq_agent/agents/deep_researcher/`

Optional DeepAgents sandbox behavior is configured via the
`deep_research_sandbox` config (see `deepagents_runtime.py` and
`configs/config_domain_routing_and_skills.yml` for a working example).

**Configuration:**

```yaml
functions:
  deep_research_agent:
    _type: deep_research_agent
    orchestrator_llm: nemotron_nano_llm   # LLM for orchestrator; replace with nemotron_super_llm if available
    source_router_llm: nemotron_nano_llm  # optional source-router model
    researcher_llm: nemotron_nano_llm    # optional; replace with nemotron_super_llm if available
    planner_llm: nemotron_nano_llm        # optional; replace with nemotron_super_llm if available
    writer_llm: nemotron_nano_llm         # optional final writer model
    enable_source_router: true            # set false to skip advisory source routing
    verbose: true                    # Enable detailed logging
    tools:
      - web_search_tool              # Search tools (e.g. tavily_web_search, ris_search)
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `orchestrator_llm` | LLMRef | required | LLM for orchestrator and report generation |
| `source_router_llm` | LLMRef | optional | LLM for source-router subagent; falls back to default if unset |
| `researcher_llm` | LLMRef | optional | LLM for researcher subagent; falls back to default if unset |
| `planner_llm` | LLMRef | optional | LLM for planner subagent; falls back to default if unset |
| `writer_llm` | LLMRef | optional | LLM for final writer subagent; falls back to default if unset |
| `enable_source_router` | bool | `true` | Enable advisory source routing before planning |
| `enable_citation_verification` | bool | `true` | Verify final citations against the captured source registry; a run with zero captured sources fails with `EmptySourceRegistryError` |
| `tools` | list | `[]` | Research tools. Empty = inherit all tools from the data source registry. Keep this list evidence-only: interaction tools such as `emit_card`/`remember` belong to the shallow agent, not here — every loaded tool is treated as a citable source |
| `exclude_tools` | list | `[]` | Tool names to exclude when inheriting from the registry |
| `skills` | config/ref | unset | Optional `deep_research_skills` assignment of built-in skill collections to `researcher-agent`/`writer-agent` |
| `sandbox` | config/ref | unset | Optional `deep_research_sandbox` (Modal) backend enabling the `execute` tool |
| `domain_catalog_path` | str | unset | YAML/JSON domain catalog for the source router |
| `max_research_concurrency` | int | `6` | Max ResearchQuery items per `run_research_batch` call |
| `max_concurrent_source_tool_calls` | int | `5` | Shared source-tool concurrency across researcher workers |
| `max_source_tool_batch_size` | int | `4` | Max inputs per batch-capable source tool call |
| `verbose` | bool | `true` | Enable detailed logging |

### Workflow: `deep_research_workflow`

A wrapper workflow that accepts string queries for evaluation and CLI use.

**Configuration:**

```yaml
workflow:
  _type: deep_research_workflow
```

This wrapper:
- Accepts a string query as input
- Converts it to the message format expected by `deep_research_agent`
- Returns the final report as a string

## LLM Roles

The agent uses role-based LLM access via `LLMProvider`:

| Role | Usage | Configured By |
|------|-------|---------------|
| `ORCHESTRATOR` | Orchestrator | `orchestrator_llm` config |
| `ROUTER` | source-router-agent subagent | `source_router_llm` config (optional; falls back to default) |
| `PLANNER` | planner-agent subagent | `planner_llm` config (optional; falls back to default) |
| `RESEARCHER` | researcher workers | `researcher_llm` config (optional; falls back to default) |
| `REPORT_WRITER` | writer-agent subagent | `writer_llm` config (optional; falls back to default) |

Per-org runtime model overrides (`X-Grid-Model-Overrides`) are applied per
agent group via `LLMProvider.with_model_overrides` in `register.py`.

## Configuration Example

```yaml
general:
  telemetry:
    logging:
      console:
        _type: console
        level: INFO
  use_uvloop: true

llms:
  nemotron_nano_llm:
    _type: nim
    model_name: nvidia/nemotron-3-nano-30b-a3b
    base_url: "https://integrate.api.nvidia.com/v1"
    temperature: 1.0
    top_p: 1.0
    max_tokens: 128000
    num_retries: 5
    chat_template_kwargs:
      enable_thinking: true

  # Nemotron Super is compatible and tested with AIQ but has limited availability
  # on the Build API due to high demand.
  # Uncomment nemotron_super_llm below if the endpoint is accessible.
  # nemotron_super_llm:
  #   _type: nim
  #   model_name: nvidia/nemotron-3-super-120b-a12b
  #   base_url: "https://integrate.api.nvidia.com/v1"
  #   temperature: 1.0
  #   top_p: 1.0
  #   max_tokens: 128000
  #   num_retries: 5
  #   chat_template_kwargs:
  #     enable_thinking: true

functions:
  web_search_tool:
    _type: tavily_web_search
    max_results: 10

  deep_research_agent:
    _type: deep_research_agent
    orchestrator_llm: nemotron_nano_llm  # replace with nemotron_super_llm if available
    tools:
      - web_search_tool

workflow:
  _type: deep_research_workflow
```


## Prompts

The agent loads prompts from `src/aiq_agent/agents/deep_researcher/prompts/`:

| Prompt | Purpose |
|--------|---------|
| `orchestrator.j2` | Main orchestrator instructions (workflow steps, delegation templates, clarifier_result, available_documents) |
| `source_router.j2` | Advisory source routing instructions |
| `planner.j2` | Instructions for the planning subagent |
| `researcher.j2` | Instructions for researcher workers |
| `writer.j2` | Final synthesis and citation contract for the writer subagent |
| `source_registry.j2` | Template for the verified source list shown to the writer |

All prompts identify as Grid OIB (Austrian building regulations) and carry
domain conventions for regulation-anchored citations, while remaining
usable for general research requests.

## State and context

`DeepResearchAgentState` includes optional context passed from the chat researcher workflow:

- **`clarifier_result`**: When the user goes through the clarifier (plan approval) before deep research, the approved plan or clarification log is passed here and injected into the orchestrator prompt.
- **`available_documents`**: User-uploaded documents with summaries; injected into subagent prompts for context.
- **`user_info`**: Authenticated user identity (name/email) rendered into all subagent prompts.
- **`project_context`**: The project brief (facts/assumptions/unknowns) rendered into all subagent prompts.
- **`data_sources`**: User-selected data sources; filters the runtime tool set per request.

## Execution paths

- **Synchronous (in-process)**: the chat researcher's `deep_research_node`
  builds `DeepResearchAgentState` directly and awaits the agent.
- **Asynchronous (submitted job)**: with `use_async_deep_research: true` and
  *either* backend configured — `NAT_DASK_SCHEDULER_ADDRESS` for a Dask
  cluster, or `GRID_JOB_EXECUTION=db` for DB-claimed workers (ADR-0021), which
  need no address at all — the chat workflow submits the job via
  `aiq_api.jobs.submit.submit_agent_job` and immediately returns the job
  id. That is the same condition `submit_agent_job` itself enforces; the chat
  gate imports the same predicate (`aiq_api.jobs.submit.async_job_dispatch`)
  rather than mirroring it, so a deployment whose submit path would
  accept the job never silently researches inline instead. With neither
  configured the synchronous path above runs. The worker
  (`aiq_api.jobs.runner`, replayed identically by the Dask worker and by
  `aiq_api.jobs.worker`) rebuilds the agent from the NAT config and forwards
  `user_info`, `clarifier_result`, `project_context`, `available_documents`,
  and `data_sources` onto the state so both paths render identical prompts.
  Grid response cards are generated post-hoc from the final report in the job
  runner (the `emit_card` tool used by the shallow agent requires the chat
  request's conversation-scoped card registry, which does not exist inside a
  worker).


## Known limitations

Verified against the installed `deepagents==0.6.8`, `langchain==1.3.4`, and
`langgraph==1.2.4` source. These are documented as current behavior, not
aspirational fixes. Several items below were fixed 2026-07-16; each is
marked with the commit that fixed it.

### Tool-result pruning defeats provider prompt-prefix caching — fixed (`0b5d29d`)

`ToolResultPruningMiddleware` (`custom_middleware.py`) previously recomputed
its keep/truncate split from scratch on **every** model call: it indexed all
`ToolMessage`s in the running transcript, kept the last `keep_last_n` intact,
and truncated everything older to `max_chars`. Because the window was
positional-from-the-end rather than pinned to a stable cutoff, the message
bytes at any given offset shifted on nearly every turn as new tool results
arrived and old ones rolled out of the window — invalidating provider-side
prompt-prefix caching (OpenRouter/DeepSeek) turn over turn on the ~80k-token
contexts a deep run accumulates. Truncation is now **monotonic**: a decision
is recorded per message id and, once a message is truncated, it is sent in
exactly that truncated form on every later call — message bytes at a given
offset no longer shift. Two related changes:

- The window now only counts **oversized** `ToolMessage`s (content longer
  than `max_chars`); no-op `think` results (`factory.py`'s `think` tool
  always returns `"Thought recorded."`) and other trivial results no longer
  consume window slots for zero context savings.
- `ModelRetryMiddleware` now retries only rate limits, timeouts, transport
  errors, and 5xx (`_is_transient_model_error`, `factory.py`) instead of
  every exception, so a permanent failure (schema rejection, auth error,
  context overflow) reaches the caller immediately instead of burning
  retries it can never win.

This middleware still runs independently of, and uncoordinated with,
deepagents' own summarization middleware (`create_summarization_middleware`),
which is auto-installed on every subagent (planner, researcher workers,
writer) and uses its own stable, persisted cutoff — the two mechanisms are
still not aware of each other, they just no longer fight the cache on their
own axis. No call site sets provider-side prompt-caching hints yet, so
enabling that remains a separate, larger cost lever — see
`docs/architecture/scaling-review-2026-07.md` §6.1 and
`docs/architecture/llm-providers.md`.

### Strict structured-output schemas can violate provider constraints — fixed (`2db0f7d`)

> Note: since the T2-8 fix (next section), the strict schema is applied via
> `DeferredStructuredOutputMiddleware` on the agent's exit turn rather than via
> `create_agent(response_format=...)` on every call. The schema-sanitization
> constraints described here still apply to that deferred call.

Researcher workers request provider-native `response_format: json_schema,
strict` output instead of `create_agent`'s `AutoStrategy`, which falls back to
a synthetic tool call for models absent from its hardcoded allowlist
(OpenRouter/DeepSeek slugs have no entry). LangChain's `ProviderStrategy` ships
the Pydantic schema verbatim with no sanitization, so a declarative bound like
`EvidenceJudgment.relevance_score`'s `ge=0, le=100` used to compile to
JSON-Schema `minimum`/`maximum` — unsupported in strict `json_schema` mode on
some providers, producing a 400 or inconsistent handling.
`relevance_score` and `ResearchQuery.preferred_tools` (previously `min_length`)
are now `field_validator(mode="after")` checks instead of declarative bounds:
`relevance_score` **clamps** out-of-range values (a worker returning 105
degrades to 100 rather than failing the whole structured response), while
`preferred_tools` still raises on empty (there is no tool name to invent, so
failing is correct there). `ResearchNotes`/`ResearchPlan.model_json_schema()`
no longer emit `minimum`/`maximum`/`minLength`/`maxLength`/`pattern` anywhere
in the nested tree (verified by a schema-walk test).
`tools/research.py:_structured_research_notes`'s fenced-JSON fallback parser
(`tools/research.py:73-90`) remains as a second line of defense for
non-conformant completions in general, but the schema-constraint root cause is
closed.

### Strict response_format on every tool-loop turn suppressed research entirely — fixed (T2-8)

`create_agent(response_format=ProviderStrategy(schema, strict=True))` binds
`response_format: json_schema strict` on EVERY model call of the agent loop
(langchain `agents/factory.py` `_get_bound_model`). OpenRouter/DeepSeek-class
endpoints do not reliably combine tools with a strict schema: the constrained
decoder satisfies the schema on turn 1 — emitting a schema-valid but empty (or
fabricated-from-memory) ResearchNotes with no tool calls — and the loop exits
before any research happens. Reproduced live against
`deepseek/deepseek-v4-flash`: zero tool calls, notes invented by the model.
This was the root cause of the production "researcher workers returned empty
ResearchNotes" failures (backlog T2-8).

Fix: `DeferredStructuredOutputMiddleware(schema)` (`custom_middleware.py`)
decouples researching from formatting. The tool loop runs with no
`response_format` at all; when the model stops calling tools, the middleware
re-issues the call once — draft message appended, strict schema applied — so
the model formats the answer it already researched. The parsed object lands in
`structured_response` exactly as with `create_agent(response_format=...)`. If
the formatting call itself fails (provider schema rejection), the draft passes
through and the fenced-JSON fallback in `_structured_research_notes` still
applies. Researcher workers (`ResearchNotes`) and the planner (`ResearchPlan`)
both use it; `llm_factory.strict_response_format` remains for non-tool call
sites (e.g. the intent classifier's `.bind()` path).

Related (T2-9): the orchestrator prompt's "Available Tools" section is now
rendered from the same list that is bound to `create_deep_agent(tools=...)`
(`factory.py` `build_deep_research_graph`), while configured source tools are
listed separately as researcher-only (to be referenced via
`ResearchQuery.preferred_tools`). The prompt previously advertised source
tools the orchestrator cannot call, and the model tried to call them directly
("not a valid tool" errors). Prompt prose likewise no longer hardcodes
config-level tool names (`ris_search`, `ris_fetch_document`,
`ris_catalog_lookup`): it refers to the RIS search/fetch/catalog-lookup tools
generically, since bound names are a config concern.

### StateBackend write-once plus per-search planner ceremony — reduced (`77a4d7a`)

deepagents' `StateBackend.write()` is write-once: a second `write_file` to
an existing path returns an error (`"already exists"`); recovery is via
`edit_file`. `planner.j2` accounts for this (`write_file` to create
`/shared/plan.json`, `edit_file` to revise it). It previously also mandated a
todo-list ceremony (`write_todos` before decomposing) and a `think` call
after every search ("What did I learn? Internal or external? ... What
constraints should I add?"), adding several pure-ceremony LLM turns per
planning run beyond the discovery searches themselves. As of the 2026-07-16
prompt pass: `write_todos` task decomposition is optional instead of
mandatory, the planner's after-every-search `think` is consolidated into a
single pre-finalize `think`, and orchestrator `write_todos` updates are
phase-level instead of per-step. This reduces, but does not eliminate,
ceremony overhead — there is no hard bound on remaining ceremony turns, so
further tuning is still possible if production logs show it's warranted.

### Verified-correct, not bugs

Worth stating explicitly since they look similar to the issues above at a
glance:

- `run_research_batch` researcher workers genuinely run concurrently
  (`asyncio.Semaphore` + `asyncio.gather(..., return_exceptions=True)`, see
  Phase 3 above), with partial-failure separation and `no_retry` on the
  batch tool so the *orchestrator* reacts to a failed subset rather than the
  tool-retry middleware blindly re-executing the whole batch.
- `recursion_limit: 2000` (`factory.py:515`) is a deliberate reduction from
  deepagents' `9999` default, not an oversight.
- Skill filesystem permission rules
  (`factory.py:skill_filesystem_permissions`) are evaluated first-match-wins
  (deepagents' `_check_fs_permission` walks the rule list in order and
  returns on the first path match) and are ordered correctly for that
  semantics: deny-write-builtin, then allow-read-builtin (only if skill
  sources are assigned), then allow-read-per-source, then a catch-all
  deny-read-builtin.
- The manually-built researcher runnable (`factory.py:build_researcher_runnable`)
  places `SkillsMiddleware` *before* `FilesystemMiddleware`/summarization/
  `PatchToolCallsMiddleware`, whereas deepagents' auto-assembled subagent
  stack (`deepagents/graph.py`) places `SkillsMiddleware` *after* those
  three (plus an `AnthropicPromptCachingMiddleware` that no-ops for
  non-Anthropic models). The ordering differs cosmetically between the two
  paths but is stable per agent — not a runtime bug.

## Evaluation

### Deep Research Bench (DRB)

The benchmark evaluates research reports using RACE and FACT metrics.

See [frontends/benchmarks/deepresearch_bench/README.md](../../../../frontends/benchmarks/deepresearch_bench/README.md) for full documentation (path from this file to repo root).

**Quick start:**

```bash
# Install the evaluator (from repo root)
uv pip install -e ./frontends/benchmarks/deepresearch_bench

# Run evaluation (use one of the provided configs)
dotenv -f deploy/.env run nat eval --config_file frontends/benchmarks/deepresearch_bench/configs/config_nemotron_only.yml
```

### OIB Compliance golden eval suite (backlog T4-5, 2026-07-16)

A separate, smaller golden eval suite exercises the real
`chat_deepresearcher_agent` workflow against 4 hand-authored OIB-compliance
cases, bounding wall-clock/LLM-calls/completion-tokens and grading
answer-correctness via a checklist (no LLM judge). It exists specifically to
make regressions in the 2026-07-16 perf fixes above (latency/cost) and in
answer correctness measurable instead of vibes — see also the separate,
deterministic `compliance_checker` package
(`src/aiq_agent/agents/compliance_checker/README.md`) for the structured
alternative to running this same class of check through the open-ended deep
researcher. See
[frontends/benchmarks/oib_compliance/README.md](../../../../frontends/benchmarks/oib_compliance/README.md)
— calibration is still pending a live run (`bounds_calibration_pending: true`
in the fixture).

## References

- [LangChain DeepAgents documentation](https://docs.langchain.com/oss/python/deepagents/overview)
- [NeMo Agent Toolkit documentation](https://docs.nvidia.com/nemo/agent-toolkit/latest/index.html)
- [Deep Research Bench](../../../../frontends/benchmarks/deepresearch_bench/README.md)

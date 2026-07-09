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
| `ToolResultPruningMiddleware` | Truncates older tool results to protect the context window |
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
researcher worker concurrently; workers return structured `ResearchNotes`
(findings, sources, gaps, evidence judgment) which the tool persists under
`/shared/` and registers with the source registry. Failed workers surface
as tool errors listing only the queries to resubmit.

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
      - web_search_tool              # Search tools (e.g. tavily_web_search, paper_search)
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
- **Asynchronous (Dask job)**: with `use_async_deep_research: true` and
  `NAT_DASK_SCHEDULER_ADDRESS` set, the chat workflow submits the job via
  `aiq_api.jobs.submit.submit_agent_job` and immediately returns the job
  id. The worker (`aiq_api.jobs.runner`) rebuilds the agent from the NAT
  config and forwards `user_info`, `clarifier_result`, `project_context`,
  `available_documents`, and `data_sources` onto the state so both paths
  render identical prompts. Grid response cards are generated post-hoc from
  the final report in the job runner (the `emit_card` tool used by the
  shallow agent requires the chat request's conversation-scoped card
  registry, which does not exist inside a Dask worker).


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


## References

- [LangChain DeepAgents documentation](https://docs.langchain.com/oss/python/deepagents/overview)
- [NeMo Agent Toolkit documentation](https://docs.nvidia.com/nemo/agent-toolkit/latest/index.html)
- [Deep Research Bench](../../../../frontends/benchmarks/deepresearch_bench/README.md)

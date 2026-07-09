# ADR-0018: Per-run construction of deep research run state

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Grid engineering
- **Related:** ADR-0003 (stateless Python agent), `src/aiq_agent/agents/deep_researcher/README.md`, `docs/architecture/backend-deep-dive.md`

## Context

`DeepResearcherAgent` is built **once** per NAT registration and reused
across requests (the register function only rebuilds it when data-source
filtering, model overrides, or a sandbox config force a per-request
instance). Until this ADR, its constructor also built everything a run
mutates:

- the `SourceRegistryMiddleware` — the captured-source registry and the
  "compact" ResearchNotes citation-key set that filters the writer-facing
  source list,
- the researcher tool wrappers (batch/throttle adapters with a shared
  `SourceToolConcurrencyLimiter`),
- the middleware stacks referencing that middleware instance.

Only the LangGraph itself was rebuilt per run. That made the agent
instance a **hidden shared-state container**: in standalone/eval mode the
instance registry accumulated sources across runs, and the compact key
set grew forever in every mode, silently filtering one run's source list
against keys from unrelated earlier runs. The 2026-07-09 audit first
patched this with an imperative `begin_run()` reset — which fixed the
observed leak but not the class of bug: every new piece of per-run state
added to the middleware or tool wrappers would need its own reset call,
and a forgotten reset is invisible until a report cites a stale source.
Concurrent runs sharing one prebuilt agent would also race on a single
mutable middleware even with resets.

The agent tier is supposed to be stateless per request (ADR-0003); the
deep researcher was the one component violating that internally.

## Decision

We will construct **all mutable run state per run, not per agent**.

1. `DeepResearcherAgent.__init__` holds only immutable configuration:
   LLM provider, tool list, prompts, concurrency knobs, flags, and the
   `DeepAgentsRuntime` (whose backend is job-scoped by design).
2. A new `DeepResearcherAgent._prepare_run(state)` builds, per run, a
   `DeepResearchRunArtifacts` bundle: a fresh `SourceRegistryMiddleware`,
   a fresh tool set (including batch/throttle wrappers and their
   concurrency limiter), the middleware stacks referencing them, and the
   graph. `run()` uses only this bundle; nothing from it is stored on the
   agent.
3. `SourceRegistryMiddleware.begin_run()` is removed — isolation is now
   structural, not imperative. Cross-turn source continuity in
   conversation mode is unaffected: it lives in the session-scoped
   registry bound by the chat entrypoint, which the per-run middleware
   still prefers via `active_registry()`.

Rule for future work: anything a deep research run can mutate belongs in
`DeepResearchRunArtifacts` (built in `_prepare_run`), never on the agent
instance.

## Consequences

### Positive

- The stale-source / compact-key leak class is eliminated by
  construction; there is no reset call to forget.
- Concurrent runs of one prebuilt agent no longer share a mutable
  middleware, tool wrappers, or throttle semaphores — each run is
  isolated the way ADR-0003 intends.
- Tests assert per-run composition instead of instance identity, which
  also documents the intended middleware stack explicitly.

### Negative

- Per-run construction cost: tool wrapping, middleware assembly, and
  graph build now run on every request. The graph was already rebuilt per
  run; the added work is negligible next to a multi-minute research run.
- The source-tool concurrency limit (`max_concurrent_source_tool_calls`)
  is now scoped **per run** rather than per agent instance. Two runs
  sharing a process may issue up to 2× the limit against upstream APIs.
  In practice deep runs execute as isolated Dask jobs (one agent per
  job), so this changes nothing in the deployed topology; if per-process
  rate limiting is ever needed, it belongs in the source tools
  themselves, not in run-scoped wrappers.
- Introspection attributes on the agent (`writer_tools`,
  `researcher_middleware`, `source_registry_middleware`, …) are gone;
  callers needing run internals must hold a `DeepResearchRunArtifacts`.
  No production code did — only tests, which were updated.

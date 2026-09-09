# The deep researcher: `src/aiq_agent/agents/deep_researcher`

The long-form agent. It runs as an async job on a Dask worker, not on a chat
turn, and it is the one agent here built on **deepagents** rather than a
LangGraph `StateGraph` of ours: an orchestrator LLM delegates to planner,
researcher and writer subagents over a shared filesystem. `README.md` beside
this file has the diagram; `custom_middleware.py` is what that framework costs.

## The seams

**No blocking call may touch the event loop.** A Dask worker heartbeats from
the same loop, and the ghost reaper fails a job with no heartbeat for 300 s —
so a synchronous HTTP call inline (the skill resolver was one) fails healthy
jobs with a timeout that names nothing. `asyncio.to_thread` it. The symptom and
its history: [`gotchas.md`](../../../../docs/contributing/gotchas.md).

**Nothing request-scoped is read from context.** There is no request in a
worker: the organization, the skills and the force list come off the state
(ADR-0018), and per-run state is built per run because the agent instance is
shared across runs and tenants.

**The graph is streamed so a cutoff has something to salvage.**
`cutoff.py` keeps the newest full state seen; `finalize.py` is the pure
pipeline over it. Both a complete run and a salvaged one go through the same
`finalize`, so verification, sanitisation and the confidence label cannot
diverge between them.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add work before the graph runs | Keep it off the loop and inside the heartbeat, or it is invisible dead time | The job fails as "no heartbeat", pointing at nothing |
| Add post-processing of the report | Put it in `finalize.py` as a function of the state | The salvage path skips it, and a cut-off report ships unverified |
| Change `agent_type` or a job's stored identifiers | `deep_researcher` is persisted in `jobs.agent_type`, `grid-agents` metadata and `SKILL_AGENTS`; the package name follows it, not the other way round | Every scoped skill drops off deep research |

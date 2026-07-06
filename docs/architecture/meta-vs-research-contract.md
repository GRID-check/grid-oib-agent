# Meta vs. research turns: response contracts and the case for a dedicated meta agent

## Context

`ChatResearcherAgent` classifies each turn as `meta`, `research`, or `error`
(`chat_researcher/models/intent.py`). Today **both** `meta` and shallow
`research` turns are routed to the **same** `ShallowResearcherAgent`
(`route_after_classification` in `chat_researcher/agent.py`), because that agent
owns the persona and the `remember` tool.

That reuse created a latent bug.

## The bug this note responds to

`ShallowResearchAgent.run()` post-processes every answer with a single rule:

- registry has sources → verify citations, return the report;
- registry is empty → `raise EmptySourceRegistryError`.

That guard is correct **for research** (if a lookup captured nothing, refuse to
present an uncited answer). But a **meta** turn legitimately answers from
persona/project context and calls no research tools, so its registry is
*supposed* to be empty. Routing meta through the source-mandatory path meant a
valid persona answer was generated, then discarded and replaced with
"the search tools did not return any results."

Two smells combined:

1. **Misplaced invariant.** "Answers must be source-grounded" was enforced in a
   component (`run()`) that does not have the intent and therefore cannot tell
   which turns the invariant applies to.
2. **Conflated responsibility.** One node served two contracts with opposite
   rules about sources.

## The shipped fix (tactical, in this PR)

Make the contract explicit and pass it to the altitude that lacks it:

- `ShallowResearchAgentState.requires_sources: bool = True`.
- The orchestrator (`shallow_research_node`) sets `requires_sources=False` when
  `intent == "meta"`.
- `run()` only raises `EmptySourceRegistryError` when `requires_sources` is
  true; conversational turns return the answer as-is.

Default `True` preserves the strict research contract for every existing and
standalone/eval caller. Regression tests cover both cells of the
`{meta, research} × {sources, no-sources}` matrix
(`tests/aiq_agent/agents/shallow_researcher/test_agent.py`).

## The structural direction: a dedicated meta agent

The tactical fix stops the bleeding, but the deeper design should **separate the
two contracts** rather than parameterize one path. Meta and research are
genuinely different jobs:

| | Meta agent | Research agent |
| --- | --- | --- |
| Sources required | never | yes (research turns) |
| Citation verification | none | full |
| Escalation to deep | n/a | yes |
| Tools | `remember`, persona | web / knowledge search |
| Model tier | small / fast is fine | stronger |

### Guiding principle

> Enforce a policy at the altitude where the context to decide it lives.

The research agent should return `{answer, sources}` as **data** and never raise
a research-semantics error — it lacks the intent to judge research semantics.
The orchestrator, which holds the intent, decides what an empty registry means.

### Precondition — extract before you split

Meta was routed through the shallow agent to reuse **persona + `remember`**.
Splitting naively would either duplicate that (drift) or leave the meta agent
coupled to the research agent's internals. So the first move is extraction, not
addition:

1. Extract a shared **`PersonaMemoryCore`** — system persona, `project_context`
   injection, the `remember` tool, history trimming.
2. `MetaAgent` = core + LLM, no research scaffolding, no source registry.
3. `ShallowResearchAgent` = core + research tools + source/citation policy;
   returns `{answer, sources}`, never raises intent-blind errors.
4. Router: `intent → {meta | shallow | deep}`. Meta never enters research, so
   the research agent becomes pure w.r.t. meta *for free* — the
   `requires_sources` flag can then be retired.

### The cost to budget for: the escalation boundary

Intent classification is not always crisp ("what do you know about my project"
= meta; "what does OIB-RL 2 require for *my* GK3 project" = research grounded in
the same project context). A tool-less meta agent **cannot recover** from a
misroute, so it needs an explicit escape hatch: a `needs_research` signal (or a
classifier-confidence gate) that lets the router hand off to shallow. The
current design keeps meta inside shallow partly to preserve that tail-match
escalation — do not lose it silently when splitting.

## When NOT to do the full split

If meta traffic were marginal, the `requires_sources` flag alone would be the
proportionate answer and a whole agent would be over-engineering. Here meta /
persona is a first-class interaction (project Q&A, memory writes, greetings), so
the separation earns its keep. Reach for a generalized `ResponseContract`
strategy only when a third or fourth mode (form-fill, clarifier, tool-only)
actually appears — not before.

## Independent follow-up: streaming commit semantics

`run()` optimistically emits the draft answer during `ainvoke`, then may retract
it in post-processing (the `emit_final_report` overwrite). That is why the good
answer streamed in and was then swapped for an error. Even with routing fixed,
this will resurface on genuine research-with-no-sources turns. Fix separately:
do not stream a draft you might invalidate, or make streamed tokens
provisional-by-contract so a later authoritative emit is not a jarring swap.

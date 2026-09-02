---
status: accepted
date: 2026-09-02
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# One answering agent per turn, no intent router in front of it

## Context and Problem Statement

Every chat turn used to start with an `intent_classifier` node: a serial LLM
call (`intent_llm`, prompt `intent_classification.j2`, result `IntentResult` +
`DepthDecision`) that labelled the message `meta`, `shallow`, `deep` or
`out_of_scope` before any answering agent ran. The label did more than name the
turn. It decided what the answering agent was *allowed* to do: a `meta` turn
entered the shallow researcher with `requires_sources=False`, which switched on
the "meta partition" (`_is_search_tool`, `_RESEARCH_ONLY_BASENAMES`,
`_meta_tool_binding`, a narrowed `ToolNode`) so that only interaction tools were
bound, and the skill runtime was not built at all.

The partition existed for one good reason: a weak model with search tools
dangling in front of it fired a knowledge-base lookup at "wie läufts so". But a
label decided *before* the answer can only ever withhold capabilities the answer
turns out to need, and it cannot know which those are. Two reported symptoms:

- "Zeig mir die Grundrisse" was routed `meta` (a listing question). The turn had
  no `surface_documents` tool, so the assistant told the user the tool "ist in
  dieser Sitzung nicht verfügbar", in a session where it was configured.
- "Was weißt du über das gesamte Projekt" was routed `meta` and answered from
  the profile text alone, without reading a single file it could have read.

Each patch to the router added a carve-out (a bound subject keeps the search
tools; forced skills bypass `requires_sources`; cards may be emitted on meta
turns), and each carve-out was one more place where the router's guess and the
agent's runtime disagreed. `docs/architecture/meta-vs-research-contract.md`
argued the opposite direction, a dedicated tool-less meta agent, and named the
cost honestly: a tool-less agent cannot recover from a misroute and needs an
escape hatch back to research. That escape hatch is the answering agent.

## Decision Drivers

- A user question must reach every tool the configuration gives the assistant;
  the model, not a pre-answer label, decides which to use.
- One output shape per turn (the answer envelope) so the platform reads one
  contract whether the turn was a greeting or a report.
- Latency and cost per turn: the classifier was one serial LLM call (~1 s) on
  every message, including "danke".
- Deep research must stay reachable, and a commissioned report must not spend
  a shallow retrieval before it gets there.

## Considered Options

1. **Keep the classifier, but let `meta` decide only obligations.** The label
   would say whether citations are owed (`requires_sources`) and never touch
   the tool binding or the skill gate; every turn binds everything.
2. **A dedicated tool-less meta agent**, the direction
   `meta-vs-research-contract.md` argued for: extract a persona-and-memory
   core, give meta its own small-model agent, route `intent → {meta | shallow |
   deep}`, add a `needs_research` escape hatch.
3. **Delete the classifier.** One answering agent enters on every turn with its
   full tool set; escalation to deep research is the agent's own decision,
   expressed in the answer envelope.

## Decision Outcome

Chosen option: 3, "delete the classifier", because options 1 and 2 keep a
decision that has no information the answer does not have more of. Option 1
still spends the serial call and still lets a pre-answer label set the grounding
contract, which is exactly what answered "was weißt du über das Projekt" from
the profile. Option 2 makes the misroute unrecoverable by construction and then
has to add a router-to-research hand-off, which is the escalation the answering
agent already owns.

What the graph is now (`chat_deepresearcher_agent`):

```
shallow_research ─(envelope.escalate_to_deep?)─▶ clarifier ─▶ deep_research ─▶ END
       └─────────────────────────────────────────────────────────────────────▶ END
```

- **Entry is the shallow researcher on every turn**, with its full tool set
  bound every time: data-source search, `surface_documents`, `remember`,
  `emit_card`, `use_skill` and the rest of the config's `tools:` list. There is
  no meta partition and no `requires_sources` on `ShallowResearchAgentState`.
- **The answer envelope is the one output shape.** A direct reply (greeting,
  shelf listing, off-topic decline, "what can you do") is an envelope with
  `answer` only and no `confidence`; a researched answer carries `confidence`
  and citations; a hand-off sets `escalate_to_deep` and a new
  `escalation_reason`, the model's own clause, which the reader sees in the
  Herleitung as "Eskaliert zur Tiefenrecherche: {reason}". A commissioned
  report ("erstell mir einen Bericht") escalates immediately, without a
  retrieval first.
- **`routing_decision` stays on the wire, observed after the answer**
  (`chat_researcher.agent.observed_routing`): `meta` when the agent consulted no
  data source and gave no self-assessment, `shallow` otherwise, `deep` set by
  the clarifier hand-off, `error` on a failed turn. `routing_reason`, the live
  status keys `status.routing.*` and `emit_routing` are gone. The post-answer
  stages (`stages/memory_reflection.py`, `stages/follow_ups.py`) gate on
  `routing_decision`; `TurnFacts.intent` is removed.
- The admin agent group `intent` and the LLM roles `intent_llm` /
  `nemotron_llm_intent` are removed from every config.

### Consequences

- Good, because a listing question and a "tell me about the project" question
  now reach `surface_documents` and the search tools; the two reported
  symptoms cannot recur by routing.
- Good, because every turn saves one serial LLM call (~1 s) and the
  classifier's own tokens; the admin UI has one fewer model group to explain.
- Good, because there is one place that decides what a turn is, and it is the
  place that has the answer.
- Bad, because the answering call now always carries the full tool schemas,
  the norm catalog and the skills index, so a greeting costs a few thousand
  more input tokens than it did behind the partition. ADR-0048's deferred
  tool loading is the lever if that grows.
- Bad, because "a greeting does not search" and "a commissioned report
  escalates before retrieving" are now the model's judgment, pinned by the
  prompt and not by code. A weaker model will get one of them wrong sooner
  than the partition would have.
- Bad, because deep research is reachable only through escalation. A config
  with `enable_escalation: false` has no deep research at all; every shipped
  config sets it true.
- Neutral, because the Herleitung loses its "Warum dieser Weg?" line: there is
  no upfront decision to attribute. The escalation line, with the model's own
  reason, replaces it on the turns where a decision was actually made.

### Confirmation

The shape of the graph and the binding are tests, not comments:

- `tests/aiq_agent/agents/chat_researcher/test_agent.py`: the compiled graph
  has no classifier node and its entry point is `shallow_research`.
- `tests/aiq_agent/agents/shallow_researcher/test_agent.py`: the full tool set
  is bound on every turn; there is no narrowed binding to fall into.
- `tests/aiq_agent/common/test_turn_status.py`: the live status vocabulary
  carries no `routing.*` keys.

What is **not** enforced yet: "a greeting does not search" and "a commissioned
report escalates first" are prompt-pinned model behaviour with no automated
eval behind them. Review of the prompt is the only gate today. They belong in
`evals/` next, as two cases the suite fails on: a greeting whose trace shows a
data-source call, and a report request whose trace shows a retrieval before the
escalation.

## Pros and Cons of the Options

### 1. Keep the classifier, label decides obligations only

- Good, because the smallest diff, and the citations-owed contract stays
  deterministic.
- Bad, because the serial call and its latency stay, and a pre-answer label
  still sets what the answer must look like before the model has looked at
  anything.

### 2. A dedicated tool-less meta agent

- Good, because the two contracts (sources never / sources always) are
  separated cleanly and a small model serves meta.
- Bad, because a tool-less agent cannot recover from a misroute, so the design
  needs a `needs_research` hand-off back into research, which is the answering
  agent's escalation by another name, paid for with a second agent, a shared
  persona core and the same router.

### 3. Delete the classifier

- Good, because the model that has the question also has every tool and every
  output shape; nothing upstream can withhold what the answer needs.
- Neutral, because routing becomes an observation, not a decision, and the
  transparency surface has to be honest about that.
- Bad, because the per-turn floor of input tokens rises and two behaviours move
  from code to prompt (see Confirmation).

## More Information

- Revisit if the prompt-pinned behaviours drift: a measured rate of greetings
  that search, or of report requests that retrieve first, that the eval suite
  cannot hold down by prompt alone. The answer then is a cheap deterministic
  pre-check on the *envelope* (a post-answer gate), not a pre-answer router.
- Revisit if the per-turn token floor becomes a cost line: ADR-0048 (deferred
  tool schemas) is the mechanism, applied per tool, not per turn class.
- Supersedes the direction in `docs/architecture/meta-vs-research-contract.md`
  (deleted with this ADR); the bug it recorded, a valid persona answer discarded
  for an empty source registry, is resolved by the envelope carrying no
  `confidence` on a direct reply.
- The graph: `src/aiq_agent/agents/chat_researcher/agent.py` (`_build_graph`,
  `observed_routing`). The envelope: `src/aiq_agent/common/answer_envelope.py`.

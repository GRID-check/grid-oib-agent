# The researcher: `src/aiq_agent/agents/researcher`

The agent that answers every chat turn, and the conversation graph that gives
it a checkpointer and one outgoing edge. Two NAT registrations: `register.py`
for the agent, `conversation_register.py` for the workflow NAT runs per turn.
`clarify.py` is a step of that graph, not an agent.

The persona is a member of the planning office, not a compliance checker.
Questions are about the work. Grounding is the project files, the office
archive, and the regulation corpus — whichever the question needs. A ruling
is one envelope `kind`, not the default. A second retrieval is a checkpoint
on the Herleitung: what it concluded, the tools it called, and the files
that fetch returned — not a mutated search caption.

## The seams

**The agent is built once, at boot.** The prompt is read, the graph compiled
and the boot tools bound in `register.py`; what a turn varies — model override,
narrowed data sources, the org's `use_skill` closure — travels as a
`TurnConfig` into `agent.run`. Anything you add that reads a file, compiles a
graph or builds an index belongs in the boot half.
`tests/aiq_agent/agents/researcher/test_build_once.py` counts it.

**The agent decides its own depth** (ADR-0052). It emits `escalate_to_deep`
with a reason in its own envelope; `conversation.py` only routes on it. A label
decided before the answer can only withhold a capability the answer turned out
to need.

**Confidence has two currencies that do not convert.** A resolved citation can
reach `high`; an IFC measurement (`grounding.py`) never buys more than
`medium`, and an answer touching the law without verified citations is capped
whatever it measured. That ceiling is what keeps a basement measurement from
grounding a legal verdict.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Rename a config key, a graph node, or `PROFILE_AGENT_NAME` | Leave `shallow_research_agent` (NAT function instance), `shallow_research` (graph node and `AgentGroup` id) and `chat_researcher` (profiler span) as they are — each is stored per turn and matched by string in the UI | Nothing local. Stored turns re-render wrong, or a checkpoint stops resuming. A comment at each site names the reader |
| Add a field the reader sees | Put it on the researcher's state and lift it through `conversation.ANSWER_LIFTS` / `turn.response` | Silence. `research_truncated` was set, declared by the frontend, and reached nobody for months |
| Change what the clarify step is given | Edit `ClarifierSettings` on `chat_deepresearcher_agent`, and leave `AgentGroup.CLARIFIER` alone: an org's model choice is stored against it | An org's pinned clarifier model silently stops applying |

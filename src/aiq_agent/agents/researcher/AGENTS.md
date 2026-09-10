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
| Change what a round of tool calls COSTS or RUNS | Derive it once and read it in both nodes. The agent node decides what to charge, the tools node what to execute, and they see the same calls at different `retrieval_round` values (`_announced_round` / `_executing_retrieval_round` — off by one, on purpose). Two derivations eventually charge for a call nothing ran, or run one nothing paid for | Nothing local, and nothing in a unit test of either half. Only a test through the compiled graph that asserts both the spend and the executed calls (`test_round_zero_fanout_cap.py`) |
| Withhold a tool call the model asked for | Leave it on the AIMessage and answer it with a `ToolMessage` saying why. Never delete it from `tool_calls` | A provider rejects a tool result with no matching call, and an un-answered call too. The turn dies on the NEXT request, not on this one |
| Give a TOOL something about this turn through a `ContextVar` | Set it in `_tools_node`, around the `ToolNode` call, never beside the LLM call in the agent node. LangGraph runs each node in a task built with `copy_context()`, so a value set in the agent node is written to a copy that dies at the node boundary — parallel tool calls, being children of the tools node, do inherit it | Silence, and green unit tests. Every Trace-Lanes hit shipped with no round stamp for a release and the Herleitung hung both fetches on the first checkpoint. Only a test that goes through the compiled graph and reads the var inside a tool can fail on it |
| Change what the clarify step is given | Edit `ClarifierSettings` on `chat_deepresearcher_agent`, and leave `AgentGroup.CLARIFIER` alone: an org's model choice is stored against it | An org's pinned clarifier model silently stops applying |

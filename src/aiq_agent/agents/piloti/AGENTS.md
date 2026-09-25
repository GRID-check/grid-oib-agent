# Piloti: `src/aiq_agent/agents/piloti`

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
the org's `use_skill` closure, the data sources this conversation switched off —
travels as a `TurnConfig` into `agent.run`. A switched-off source does NOT
narrow the binding: the tool stays bound and the call is refused at the
`ToolNode` boundary, so the tool payload (and the prompt-cache shard keyed on
it) is the same for every turn of an org — with ONE exception, scope: a turn
without a project is not sent `ifc_query` / `ifc_measure` (`_tools_in_scope`),
which can only say "no project" there and are ~8k tokens of every call. Two
shards per org, never one per toggle combination. Anything you add that reads a file, compiles a
graph or builds an index belongs in the boot half.
`tests/aiq_agent/agents/piloti/test_build_once.py` counts it.

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
| Rename a config key, a graph node, or `PROFILE_AGENT_NAME` | Leave the wire names in the section below as they are | Nothing local. Stored turns re-render wrong, or a checkpoint stops resuming. A comment at each site names the reader |
| Add a field the reader sees | Put it on Piloti's state and lift it through `conversation.ANSWER_LIFTS` / `turn.response` | Silence. `research_truncated` was set, declared by the frontend, and reached nobody for months |
| Change what a round of tool calls COSTS or RUNS | Derive it once and read it in both nodes. The agent node decides what to charge, the tools node what to execute, and they see the same calls at different `retrieval_round` values (`_announced_round` / `_executing_retrieval_round` — off by one, on purpose). The budget is ONE per round, whatever the round asked for, so what the two nodes must agree on is which calls are WITHHELD, not how many there are. THREE guards sit on that seam: the duplicate-fetch guard (a fetch whose signature already ran this turn, answered with that fetch's own earlier result — or, for a same-batch duplicate of a fetch that FAILED, with the notice that says so and invites the retry), the switched-off data source (`disabled_source_notice`, answered with one sentence) and the per-round WIDTH cap (`max_calls_per_round`, default 12: the calls past it are answered with „not run this round, ask again next round"). All three withhold without running and without being announced; the round they empty still costs its one. Each leaves its own technical record — `status:repeat:N`, `status:refused:N`, `status:width:N` — because a withheld call runs nothing and announces nothing, so without one it is invisible. The stamp the tools node sets is derived from the calls that SURVIVED the guards (`_split_round(...).ran`), never from the raw AIMessage: a round whose fetches were all withheld announced nothing, and reading the message would file the surviving `emit_card` under the previous round's search. Two derivations eventually announce a search nothing ran, or run one nothing paid for. The pure half of that derivation — `repeat_fetches`, `signatures_of`, `failed_call_ids`, `ran_signatures`, `assistant_checkpoint` — lives in `common/retrieval_rounds.py`, because deep research runs the same guard; what stays here is what reads a Piloti turn's state and answers a withheld call in Piloti's own words | Nothing local, and nothing in a unit test of either half. Only a test through the compiled graph that asserts both the spend and the executed calls (`test_repeat_fetch_guard.py`, `test_repeat_returns_result.py`, `test_disabled_sources.py`, `test_budget_by_rounds.py`) |
| Read `state.messages` for what THIS turn did (a lookup, a handed marker, a measurement) | Scope the scan with `answer_pipeline.this_turn` — everything after the last `HumanMessage`. The transcript carries the PREVIOUS turn's tool calls and results too (`conversation._answer_update` writes the whole turn back, so a follow-up answers from them without a fetch), pruned to prose one turn later | Nothing local: a scan over the whole list still passes every single-turn test. In production a follow-up answered from the transcript against an empty registry ships the „nothing retrieved" refusal, and a `[[card:1]]` a tool handed out last turn shifts this turn's card numbering |
| Withhold a tool call the model asked for | Leave it on the AIMessage and answer it with a `ToolMessage` saying why. Never delete it from `tool_calls` | A provider rejects a tool result with no matching call, and an un-answered call too. The turn dies on the NEXT request, not on this one |
| Give a TOOL something about this turn through a `ContextVar` | Set it in `_tools_node`, around the `ToolNode` call, never beside the LLM call in the agent node. LangGraph runs each node in a task built with `copy_context()`, so a value set in the agent node is written to a copy that dies at the node boundary — parallel tool calls, being children of the tools node, do inherit it | Silence, and green unit tests. Every Trace-Lanes hit shipped with no round stamp for a release and the Herleitung hung both fetches on the first checkpoint. Only a test that goes through the compiled graph and reads the var inside a tool can fail on it. The prefetch node is the one other place: it calls `_tools_node` itself, so `prefetch_scope` wraps that call. A tool that must tell the decision's prefetch from the model's own first search reads `turn_status.in_prefetch()`, never the round index |
| Call something SYNCHRONOUS from a graph node | Send it through `asyncio.to_thread`, or move it to boot. The nodes are coroutines on the worker's one event loop, so a blocking read there stalls every other turn the worker is serving, not only this one. The system prompt is the worked example: `render_system_prompt` resolves the static half through the Langfuse-backed prompt store, which is a bounded HTTP call on the first render of a TTL window | Nothing local — a test with the store disabled never blocks. `test_prompt_render_off_the_loop.py` asserts the thread the render ran on |
| Change anything that runs after the answer's prose settles | Change nothing but the inside of a quotation (`quote_patch.splice`). A repair never adds, drops or renumbers a `[N]` and never retrieves (ADR-0067) | `test_agent.py::TestPilotiRepairPass` (the text outside the quote is byte-identical, no second call or search) and the answer suite's `settled_replaced` count |
| Edit `piloti_static.md`'s envelope examples or its field-order sentence | Keep `kind` and the masthead fields before `answer`, then `cards` (ADR-0066; `common/answer_prose_stream.py` reads them in that order). Run the answer suite and `test_answer_prose_stream.py`, then `task prompts:push` checks it and `-- --apply` publishes it (a one-way door: ask first) | Nothing: streaming fails open and the masthead just arrives late |
| Edit a table or status rule in `piloti_static.md`'s `<formatting>` | Keep the header names and status words in `frontends/ui/src/shared/components/MarkdownRenderer/table-shape.ts` and `status-marks.ts` in step | Nothing: the table renders plain |
| Change what the clarify step is given | Edit `ClarifierSettings` on `chat_deepresearcher_agent`, and leave `AgentGroup.CLARIFIER` alone: an org's model choice is stored against it | An org's pinned clarifier model silently stops applying |

## The names that stay

The package is `piloti` and the class is `PilotiAgent`; the agent is Piloti, a
member of the planning office. Everything below still says `research` or
`researcher`, and each one is a **wire name** — stored per turn, written into a
deployment, or hand-written by a skill author — so it moves only with a
migration and read-side aliases, never with a rename. A comment sits at each
site naming the reader that would break.

| Name | Where it is read | Site |
|---|---|---|
| `research_agent`, `research_workflow`, `chat_deepresearcher_agent` | NAT `_type` in every `configs/*.yml` and every benchmark config | `register.py`, `conversation_register.py` |
| `shallow_research_agent` | the NAT function *instance* name; the frontend persists it as `functionName` on every stored turn and the live-trace rules match the substring `shallow` | `configs/config_oib_openrouter.yml` |
| `shallow_research` | graph node and `AgentGroup` id, stored in `platform_models.agent_group` for every org that re-pointed this agent's model | `conversation.py`, `common/model_overrides.py` |
| `chat_researcher` | `PROFILE_AGENT_NAME`, the profiler span the reasoning view labels by | `turn/admission.py` |
| `research_llm` | config key. `researcher_llm` is deep research's own role field and cannot be reused | `register.py` |
| `researcher` (skill scope) | `platform_skills.grid_agents` and every skill's frontmatter; both resolvers IGNORE a name they do not know, so a rename without a migration serves chat-scoped skills to deep research in silence | `skills/resolver.py`, `register.py` |
| `researcher` (job agent type) | `AGENT_REGISTRY`, a schedule's stored `agent_type` | `frontends/aiq_api/src/aiq_api/registry.py` |
| `aiq_researcher`, `aiq_researcher_conversation` | `nat.plugins` entry-point names, carried in the installed dist metadata | `pyproject.toml` |
| `LLMRole.RESEARCHER` | a semantic LLM role shared with deep research | `common/llm_provider.py` |

The ADRs and the dated audits under `docs/` still say `researcher`,
`shallow_researcher` and `chat_researcher` in their prose. That is deliberate:
they are records of a decision at a date, not descriptions of the tree, and
rewriting one loses what it was for. Read a path in an ADR as the name of the
thing, not as a location.

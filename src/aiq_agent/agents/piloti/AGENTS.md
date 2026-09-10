# Piloti: `src/aiq_agent/agents/piloti`

The agent that answers every chat turn, and the conversation graph that gives
it a checkpointer and one outgoing edge. Two NAT registrations: `register.py`
for the agent, `conversation_register.py` for the workflow NAT runs per turn.
`clarify.py` is a step of that graph, not an agent.

## The seams

**The agent is built once, at boot.** The prompt is read, the graph compiled
and the boot tools bound in `register.py`; what a turn varies — model override,
narrowed data sources, the org's `use_skill` closure — travels as a
`TurnConfig` into `agent.run`. Anything you add that reads a file, compiles a
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

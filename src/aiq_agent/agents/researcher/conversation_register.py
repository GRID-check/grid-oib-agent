"""NAT registration for the chat workflow: the conversation graph as a turn.

Beside the graph it registers (:mod:`aiq_agent.agents.researcher.conversation`)
and nothing else: the config, the wiring of the sibling NAT functions into that
graph, and a ``_run`` that composes the per-turn harness from
:mod:`aiq_agent.turn`. The answering agent, the escalation edge and the
conversation state are the researcher's, which is why this lives here rather
than in a package of its own.
"""

import asyncio
import logging
from collections.abc import AsyncGenerator
from typing import Annotated
from typing import Any

from langchain_core.messages import HumanMessage
from pydantic import Field

from aiq_agent.agents.researcher.clarify import ClarifierSettings
from aiq_agent.agents.researcher.clarify import build_clarifier
from aiq_agent.agents.researcher.conversation import ConversationGraph
from aiq_agent.agents.researcher.models import ConversationState
from aiq_agent.common import AgentGroup
from aiq_agent.common import filter_tools_by_sources
from aiq_agent.common import format_tool_unavailability_error
from aiq_agent.common import get_all_tool_refs
from aiq_agent.common import get_checkpointer
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import validate_tool_availability
from aiq_agent.common.citation_verification import get_or_create_session_registry
from aiq_agent.common.nat_converters import ensure_registered as ensure_nat_converters_registered
from aiq_agent.common.profiler import flush_after_answer
from aiq_agent.common.profiler import track_agent_profile
from aiq_agent.common.turn_status import emit_documents_loading
from aiq_agent.conversation_context import register_context_appender
from aiq_agent.knowledge.scoping import get_scoped_collections_from_context
from aiq_agent.project_context import GridRequestContext
from aiq_agent.stages import schedule_post_answer_stages
from aiq_agent.turn.admission import PROFILE_AGENT_NAME
from aiq_agent.turn.admission import TurnOutcome
from aiq_agent.turn.admission import answer_turn
from aiq_agent.turn.admission import refusal_response
from aiq_agent.turn.admission import spanned
from aiq_agent.turn.api_seam import skip_clarifier_requested
from aiq_agent.turn.context import TurnContext
from aiq_agent.turn.context import load_turn_context
from aiq_agent.turn.context import thread_id_for_turn
from aiq_agent.turn.context import turn_identity
from aiq_agent.turn.context import user_info_from_principal
from aiq_agent.turn.dispatch import build_deep_research_job_submitter
from aiq_agent.turn.inventory import Inventory
from aiq_agent.turn.inventory import load_inventory
from aiq_agent.turn.inventory import resolve_scope
from aiq_agent.turn.inventory import shelves_in_scope
from aiq_agent.turn.payload import TurnInputs
from aiq_agent.turn.payload import extract_turn_inputs
from aiq_agent.turn.registries import TurnRegistries
from aiq_agent.turn.registries import turn_registries
from aiq_agent.turn.response import build_response
from aiq_agent.turn.response import post_answer_turn_facts
from aiq_agent.turn.streaming import fold_chunks_to_response
from aiq_agent.turn.streaming import response_to_chunks
from nat.builder.builder import Builder
from nat.builder.context import Context
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.api_server import ChatResponseChunk
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig
from nat.data_models.streaming import Streaming

logger = logging.getLogger(__name__)


########################################################
# Chat Deep Researcher Agent
########################################################
class ChatDeepResearcherConfig(FunctionBaseConfig, name="chat_deepresearcher_agent"):
    """Configuration for the chat deep researcher orchestrator agent."""

    max_history_tokens: int = Field(
        default=8000,
        description="Maximum number of tokens of chat history to keep before invoking the agent",
    )
    verbose: bool = Field(default=False, description="Enable verbose logging")
    enable_clarifier: bool = Field(default=False, description="Enable clarification of research queries")
    clarifier: ClarifierSettings | None = Field(
        default=None,
        description=(
            "Models, tools and limits for the clarification step that confirms a research plan "
            "before deep research runs. Required when `enable_clarifier` is true. It is a nested "
            "block rather than its own function because the step has exactly one caller; the "
            "`clarifier` agent group it runs under is unchanged, so per-org model overrides still "
            "address it."
        ),
    )
    use_async_deep_research: bool = Field(
        default=False,
        description="Submit deep research as an async job instead of running inline",
    )
    checkpoint_db: str = Field(
        default="./checkpoints.db",
        description="SQLite database path or Postgres DSN for persistent checkpoints.",
    )
    memory_reflection_llm: LLMRef | None = Field(
        default=None,
        description=(
            "Optional LLM for the async post-answer memory-reflection stage. When set, after each "
            "answer is returned a background task reviews the turn against the project's existing "
            "memory and records any durable finding the in-turn `remember` tool missed. Unset "
            "disables reflection entirely (no extra LLM call)."
        ),
    )
    follow_ups_llm: LLMRef | None = Field(
        default=None,
        description=(
            "Optional LLM for the async post-answer follow-up-questions stage. When set, after a "
            "substantive answer is returned a background task reads the finished answer and names "
            "the two to four questions it made askable. Unset disables the stage entirely (no "
            "extra LLM call) — the capability bit of `flag AND capability`."
        ),
    )


async def _deep_research_tools(builder: Builder) -> list:
    """The deep agent's tool set, resolved once so a turn can check availability
    before it hands over to the clarifier."""
    deep_config = builder.get_function_config("deep_research_agent")
    tool_refs = deep_config.tools or get_all_tool_refs()
    tools = await builder.get_tools(tool_names=tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
    excluded = set(deep_config.exclude_tools or ())
    return [tool for tool in tools if getattr(tool, "name", "") not in excluded]


def _tool_validator(deep_research_tools: list):
    def validate_deep_research_tools(data_sources: list[str] | None) -> tuple[bool, str]:
        """Whether at least one deep research tool is available for ``data_sources``."""
        selected = filter_tools_by_sources(deep_research_tools, data_sources)
        is_valid, _, unavailable = validate_tool_availability(
            selected, research_type="deep research", enable_logging=False
        )
        if not is_valid:
            return False, format_tool_unavailability_error("deep research", unavailable)
        return True, ""

    return validate_deep_research_tools


async def _stage_llm(builder: Builder, ref: LLMRef | None, stage: str):
    """An optional post-answer stage model: None (unset) disables the stage at zero cost."""
    if ref is None:
        return None
    try:
        return await get_langchain_llm(builder, ref)
    except Exception:  # noqa: BLE001 - a stage model is optional; the answer is not
        logger.warning("Could not build %s; that stage is disabled", stage, exc_info=True)
        return None


async def _build_clarifier(config: ChatDeepResearcherConfig, builder: Builder):
    """The clarification step, or None when this deployment runs without one.

    A config that turns the clarifier on without configuring it fails HERE, at
    boot, rather than on the first escalating turn — the same trade the missing
    ``clarifier_agent`` function used to get from ``builder.get_function``.
    """
    if not config.enable_clarifier:
        return None
    if config.clarifier is None:
        raise ValueError("enable_clarifier is true but no `clarifier:` block is configured on the workflow")
    return await build_clarifier(config.clarifier, builder)


async def _build_agent(config: ChatDeepResearcherConfig, builder: Builder) -> ConversationGraph:
    """Resolve the sibling NAT functions into the researcher's conversation graph.

    ``enable_clarifier`` decides HERE whether a clarifier is resolved at all: a
    deployment that runs without one hands the graph ``None`` and the escalation
    goes straight to deep research. The graph itself never reads the flag.

    It is read once more, per turn, folded into ``skip_clarifier`` beside the
    request's own headless marker (the ``_response`` body below). That read is
    redundant — with the flag off there is no ``clarifier_fn`` to run and both
    paths already land on ``_deep_handoff`` — and it is kept because the two
    reads answer different questions: this one is about the deployment, that one
    about the turn, and collapsing them would make a per-request signal depend on
    a build-time one.
    """
    # The NAT function NAME, not its `_type` (which is `research_agent`). The
    # name is what NAT emits as `Function Start: …` and what every stored turn
    # keeps as `functionName`, so it is a persisted identifier and stays put —
    # see the comment on the block in `configs/config_oib_openrouter.yml`.
    research_fn_impl = await builder.get_function("shallow_research_agent")
    deep_fn = await builder.get_function("deep_research_agent")
    return ConversationGraph(
        research_fn=research_fn_impl.ainvoke,
        deep_research_fn=deep_fn.ainvoke,
        clarifier_fn=await _build_clarifier(config, builder),
        max_history_tokens=config.max_history_tokens,
        deep_research_job_submitter=build_deep_research_job_submitter(config),
        checkpointer=await get_checkpointer(config.checkpoint_db),
        validate_deep_research_tools_fn=_tool_validator(await _deep_research_tools(builder)),
    )


def _turn_state(
    inputs: TurnInputs, context: TurnContext, inventory: Inventory, header_scope, *, skip_clarifier: bool
) -> ConversationState:
    return ConversationState(
        messages=[HumanMessage(content=inputs.query_text)],
        user_info=user_info_from_principal(),
        data_sources=inputs.data_sources,
        force_skills=inputs.force_skills,
        available_documents=inventory.available_documents,
        in_flight_documents=inventory.in_flight_documents,
        collection_scope=[entry.collection for entry in header_scope] if header_scope else None,
        focus_file_name=inputs.focus_file_name,
        focus_shelf=inputs.focus_shelf,
        skip_clarifier=skip_clarifier,
        project_context=context.project_context,
        platform_lessons=context.platform_lessons,
    )


def _answer_chunks(
    outcome: TurnOutcome[ConversationState],
    registries: TurnRegistries,
    context: TurnContext,
    inputs: TurnInputs,
    *,
    workflow_id: str,
    stage_llms: dict,
) -> list[ChatResponseChunk]:
    """The chunks a finished turn delivers, with its post-answer stages scheduled.

    ONE call site for every stage, fire-and-forget: which stages exist and
    what gates them is declared in `aiq_agent/stages/`. Every fact a gate may
    read is captured here, while the request context is still live.
    """
    if outcome.refusal is not None:
        return response_to_chunks(refusal_response(outcome.refusal, workflow_id=workflow_id), stream=False)
    assert outcome.state is not None
    cards = registries.cards.snapshot()
    response = build_response(outcome.state, cards=cards, workflow_id=workflow_id)
    facts = post_answer_turn_facts(
        context.stage_facts,
        state=outcome.state,
        response=response,
        query_text=inputs.query_text,
        cards=cards,
        remembered_this_turn=registries.memory_writes,
    )
    schedule_post_answer_stages(facts, llms=stage_llms)
    return response_to_chunks(response, stream=True)


def _turn_runner(agent: ConversationGraph, config: ChatDeepResearcherConfig, stage_llms: dict, workflow_id: str):
    """The per-turn entry point NAT calls, composed from ``aiq_agent.turn``."""
    any_stage_llm = any(llm is not None for llm in stage_llms.values())

    async def _run(
        query: object,
    ) -> Annotated[AsyncGenerator[ChatResponseChunk, None], Streaming(convert=fold_chunks_to_response)]:
        conversation_id = Context.get().conversation_id
        thread_id = thread_id_for_turn(conversation_id)
        # The signed request-context envelope, parsed ONCE per turn (base64 +
        # HMAC-SHA256 + JSON); every consumer below reads this object.
        request = GridRequestContext.from_context()
        # Retrieval reads the turn's focus from the ContextVars this parse sets.
        inputs = extract_turn_inputs(query)
        logger.info("ChatDeepResearcherAgent: %s (data sources: %s)", inputs.query_text, inputs.data_sources)
        header_scope = get_scoped_collections_from_context()
        # Say what is happening in the FIRST hole of the turn — only when one
        # of the reader's OWN shelves is in scope; the base corpus is a constant.
        emit_documents_loading(shelves_in_scope(header_scope or ()))
        turn_metadata: dict[str, Any] = {}
        identity = turn_identity(request, conversation_id)
        # The profiler root opens BEFORE the setup I/O so every setup step has a
        # row; `inline_flush=False` posts its final batch after the answer is out.
        with track_agent_profile(
            agent_name=PROFILE_AGENT_NAME, identity=identity, metadata=turn_metadata, inline_flush=False
        ) as profiler:
            # The independent setup I/O paths, overlapped; each fails open on its own.
            context, inventory, session_registry = await asyncio.gather(
                spanned(
                    "setup.project_context",
                    load_turn_context(
                        request, conversation_id=thread_id, query_text=inputs.query_text, resolve_stages=any_stage_llm
                    ),
                ),
                load_inventory(resolve_scope(header_scope, conversation_id)),
                spanned("setup.session_registry", asyncio.to_thread(get_or_create_session_registry, thread_id)),
            )
            skip_clarifier = not config.enable_clarifier or skip_clarifier_requested()
            state = _turn_state(inputs, context, inventory, header_scope, skip_clarifier=skip_clarifier)
            async with turn_registries(thread_id, session_registry) as registries:
                outcome = await answer_turn(
                    agent,
                    state,
                    thread_id=thread_id,
                    organization_id=request.organization_id,
                    identity=identity,
                    metadata=turn_metadata,
                )
        try:
            for chunk in _answer_chunks(
                outcome, registries, context, inputs, workflow_id=workflow_id, stage_llms=stage_llms
            ):
                yield chunk
        finally:
            # Two BFF round-trips, posted AFTER the reader has the answer; in the
            # `finally` so a consumer that closes the stream early still posts.
            await flush_after_answer(profiler, outcome.cost_tracker)

    return _run


@register_function(config_type=ChatDeepResearcherConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def chat_deepresearcher_agent(config: ChatDeepResearcherConfig, builder: Builder):
    """Chat deep researcher orchestrator agent."""
    # Grid cards ride the response as an extra field; without the direct
    # ChatResponse -> ChatResponseChunk converter NAT's lossy str conversion
    # drops them. Idempotent, registered by the workflow that streams them.
    ensure_nat_converters_registered()
    workflow_id = config.name or config.type
    # The models the post-answer stages run on, keyed by agent group so the
    # runner applies the org's override and BYOK credential per group. A group
    # with no model is the capability bit: its stages are a no-op.
    stage_llms = {
        AgentGroup.MEMORY_REFLECTION: await _stage_llm(builder, config.memory_reflection_llm, "memory_reflection_llm"),
        AgentGroup.FOLLOW_UPS: await _stage_llm(builder, config.follow_ups_llm, "follow_ups_llm"),
    }
    agent = await _build_agent(config, builder)
    # Ingest-only context (ADR-0034 addendum): a `context_only` frame lands in
    # this conversation's checkpoint without a turn. Published rather than
    # imported because the socket is the front end's and the graph is ours.
    register_context_appender(agent.append_context_message)
    run = _turn_runner(agent, config, stage_llms, workflow_id)
    yield FunctionInfo.from_fn(run, description="Chat researcher: one answering agent, escalation to deep research.")

"""NAT registration for the chat workflow: the conversation graph as a turn.

Beside the graph it registers (:mod:`aiq_agent.agents.piloti.conversation`)
and nothing else: the config, the wiring of the sibling NAT functions into that
graph, and a ``_run`` that composes the per-turn harness from
:mod:`aiq_agent.turn`. The answering agent, the escalation edge and the
conversation state are Piloti's, which is why this lives here rather
than in a package of its own.
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncGenerator
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Annotated
from typing import Any

from langchain_core.messages import HumanMessage
from pydantic import Field

from aiq_agent.agents.piloti.clarify import ClarifierSettings
from aiq_agent.agents.piloti.clarify import build_clarifier
from aiq_agent.agents.piloti.conversation import ConversationGraph
from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.common import AgentGroup
from aiq_agent.common import filter_tools_by_sources
from aiq_agent.common import format_tool_unavailability_error
from aiq_agent.common import get_all_tool_refs
from aiq_agent.common import get_checkpointer
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import validate_tool_availability
from aiq_agent.common.agent_tools import load_agent_tools
from aiq_agent.common.profiler import flush_after_answer
from aiq_agent.common.profiler import track_agent_profile
from aiq_agent.common.turn_status import documents_loading_step
from aiq_agent.common.wire_v2 import EventBody
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import StatusStep
from aiq_agent.common.wire_v2 import StepFinishedBody
from aiq_agent.conversation_context import register_context_appender
from aiq_agent.knowledge.inventory import set_inventory_drops
from aiq_agent.knowledge.inventory import set_norm_families
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.scoping import get_scoped_collections_from_context
from aiq_agent.project_context import GridRequestContext
from aiq_agent.stages import schedule_post_answer_stages
from aiq_agent.turn.admission import PROFILE_AGENT_NAME
from aiq_agent.turn.admission import TurnLedgers
from aiq_agent.turn.admission import TurnOutcome
from aiq_agent.turn.admission import answer_turn
from aiq_agent.turn.admission import refused
from aiq_agent.turn.admission import spanned
from aiq_agent.turn.answer_stream import answer_streaming_enabled
from aiq_agent.turn.answer_stream import bound_live_prose
from aiq_agent.turn.api_seam import skip_clarifier_requested
from aiq_agent.turn.context import TurnContext
from aiq_agent.turn.context import load_turn_context
from aiq_agent.turn.context import thread_id_for_turn
from aiq_agent.turn.context import turn_identity
from aiq_agent.turn.context import user_info_from_principal
from aiq_agent.turn.dispatch import build_run_commissioner
from aiq_agent.turn.inventory import Inventory
from aiq_agent.turn.inventory import load_inventory
from aiq_agent.turn.inventory import pending_uploads
from aiq_agent.turn.inventory import resolve_scope
from aiq_agent.turn.inventory import shelves_in_scope
from aiq_agent.turn.inventory import wait_for_uploads
from aiq_agent.turn.payload import TurnInputs
from aiq_agent.turn.payload import extract_turn_inputs
from aiq_agent.turn.registries import TurnRegistries
from aiq_agent.turn.registries import load_session_registry
from aiq_agent.turn.registries import turn_registries
from aiq_agent.turn.response import answer_message_id
from aiq_agent.turn.response import build_result
from aiq_agent.turn.response import finished
from aiq_agent.turn.response import post_answer_turn_facts
from aiq_agent.turn.streaming import TurnTextFold
from aiq_agent.turn.streaming import fold_turn
from aiq_agent.turn.streaming import note_settled_replaced
from aiq_agent.turn.subject_document import load_subject_document
from nat.data_models.streaming import Streaming
from nat.plugin_api import Builder
from nat.plugin_api import Context
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import LLMFrameworkEnum
from nat.plugin_api import LLMRef
from nat.plugin_api import register_function

logger = logging.getLogger(__name__)


########################################################
# Chat Deep Researcher Agent
########################################################
class ChatDeepResearcherConfig(FunctionBaseConfig, name="chat_deepresearcher_agent"):
    """Configuration for the chat deep researcher orchestrator agent."""

    max_history_tokens: int = Field(
        default=40000,
        description=(
            "Tokens of chat history kept before the agent runs (`history.trim_message_history`). "
            "The CONVERSATION is the one thing in the context nobody else can reconstruct: the "
            "system prompt is rendered from the template, the tool schemas come from the binding, "
            "the retrieved passages are in the index (the PREVIOUS turn's ride along in full, so a "
            'follow-up needs no fetch; older turns keep what was said) and the „Bereits gelesen" '
            "digest carries what was READ — but not what was SAID, and not the correction the reader "
            "made two turns ago. The old 8 000 predates the context sizes this surface runs on: one call here "
            "carries 37-84k input tokens with ~14k of static prompt in it, so the window that got "
            "cut was the only irreplaceable one, and `<project_brief>` and PROJECT_MEMORY exist "
            "partly to carry facts across the gap it created. 40 000 is a floor chosen against "
            "those measurements. The RIGHT budget is the residual — model context minus prompt "
            "minus tool schemas minus this turn's observations minus a synthesis reserve — which "
            "is the only one that means anything and is not computed anywhere yet (follow-up)."
        ),
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
    return await load_agent_tools(builder, tool_refs, deep_config.exclude_tools)


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
    """Resolve the sibling NAT functions into Piloti's conversation graph.

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
        commission_run_fn=build_run_commissioner(config),
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
        available_documents=inventory.available_documents,
        in_flight_documents=inventory.in_flight_documents,
        collection_scope=[entry.collection for entry in header_scope] if header_scope else None,
        focus_file_name=inputs.focus_file_name,
        focus_shelf=inputs.focus_shelf,
        skip_clarifier=skip_clarifier,
        project_context=context.project_context,
        platform_lessons=context.platform_lessons,
        org_instructions=context.org_instructions,
        deep_research_allowed=context.deep_research_allowed,
        tasks_allowed=context.tasks_allowed,
    )


def _finished(
    outcome: TurnOutcome[ConversationState],
    registries: TurnRegistries,
    context: TurnContext,
    inputs: TurnInputs,
    *,
    message_id: str,
    stage_llms: dict,
) -> RunFinishedBody:
    """The terminal a finished turn delivers, with its post-answer stages scheduled.

    ONE call site for every stage, fire-and-forget: which stages exist and
    what gates them is declared in `aiq_agent/stages/`. Every fact a gate may
    read is captured here, while the request context is still live.
    """
    if outcome.refusal is not None:
        return refused(outcome.refusal, message_id=message_id)
    assert outcome.state is not None
    cards = registries.cards.snapshot()
    facts = post_answer_turn_facts(
        context.stage_facts,
        state=outcome.state,
        query_text=inputs.query_text,
        cards=cards,
        remembered_this_turn=registries.memory_writes,
    )
    schedule_post_answer_stages(facts, llms=stage_llms)
    return finished(build_result(outcome.state, cards, message_id))


async def _load_setup(
    request: GridRequestContext,
    inputs: TurnInputs,
    scope: list,
    *,
    conversation_id: str | None,
    thread_id: str,
    resolve_stages: bool,
) -> tuple[TurnContext, Inventory, Any, StatusStep | None]:
    """The four independent setup I/O paths, overlapped.

    Each fails open on its own (:mod:`aiq_agent.turn.context`,
    :mod:`aiq_agent.turn.inventory`, :mod:`aiq_agent.turn.registries`,
    :mod:`aiq_agent.turn.subject_document`), so the gather cannot let one dead
    branch lose the others' results — or the turn.

    The subject read is a member and not a step in front of the gather for the
    same reason the others are: it is one HTTP round trip on the
    time-to-first-byte path, it is independent of every other branch, and a
    subject that cannot be fetched costs the model one file. What it returns is
    the step that says whether it did — the file it writes IS the result, and
    the model finds it with `ls` exactly as it finds a draft it wrote itself.
    """
    context, inventory, session_registry, subject_step = await asyncio.gather(
        spanned(
            "setup.project_context",
            load_turn_context(
                request, conversation_id=thread_id, query_text=inputs.query_text, resolve_stages=resolve_stages
            ),
        ),
        load_inventory(scope),
        spanned("setup.session_registry", load_session_registry(thread_id)),
        spanned(
            "setup.subject_document",
            load_subject_document(
                inputs.subject,
                # NAT's conversation id, not the thread id: the working directory
                # is namespaced by the former, and `file_draft` resolves the same
                # one when it goes looking for the file this write leaves behind.
                conversation_id=conversation_id,
                organization_id=request.organization_id,
            ),
        ),
    )
    return context, inventory, session_registry, subject_step


@dataclass(frozen=True)
class _TurnRuntime:
    """The turn's identity and its ledgers, fixed before any setup I/O."""

    thread_id: str
    identity: dict[str, str | None]
    metadata: dict[str, Any]
    ledgers: TurnLedgers
    stage_llms: dict


@dataclass(frozen=True)
class _Turn:
    """What one turn's answering task needs, gathered before it starts."""

    agent: ConversationGraph
    state: ConversationState
    session_registry: Any
    context: TurnContext
    inputs: TurnInputs
    request: GridRequestContext
    runtime: _TurnRuntime


async def _prepare_turn(
    agent: ConversationGraph,
    request: GridRequestContext,
    inputs: TurnInputs,
    header_scope,
    *,
    conversation_id: str | None,
    enable_clarifier: bool,
    resolve_stages: bool,
    runtime: _TurnRuntime,
) -> AsyncIterator[StepFinishedBody | _Turn]:
    """The setup I/O and the steps it reports, then the turn: documents bound, the graph's input state built.

    The setup phase runs before the graph, where no writer exists, so it yields
    its steps itself (chat wire v2 §b). A hold for uploads still being indexed
    is announced before it is waited out.
    """
    scope = resolve_scope(header_scope, conversation_id)
    context, inventory, session_registry, subject_step = await _load_setup(
        request,
        inputs,
        scope,
        conversation_id=conversation_id,
        thread_id=runtime.thread_id,
        resolve_stages=resolve_stages,
    )
    if subject_step is not None:
        yield StepFinishedBody(step=subject_step)
    if (waiting := pending_uploads(inventory)) is not None:
        yield StepFinishedBody(step=waiting)
        inventory = await wait_for_uploads(scope, inventory)
    skip_clarifier = not enable_clarifier or skip_clarifier_requested()
    # The inventory reaches the PROMPT as the rendered block and the TOOLS as
    # rows. The write-side workspace tools resolve a file name against these
    # rows, and there is no argument that could carry them: a LangGraph run and
    # a tool node sit between here and the call. Bound before the graph starts,
    # so the child contexts copy it; called on every turn, including with None,
    # which is what stops one turn resolving against the last one's.
    # The UNCAPPED rows: the prompt cap bounds what the model reads, never
    # what a tool can resolve (`Inventory.all_documents`).
    set_turn_documents(inventory.all_documents or inventory.available_documents)
    set_norm_families(inventory.norm_families)
    set_inventory_drops(inventory.inventory_drops)
    state = _turn_state(inputs, context, inventory, header_scope, skip_clarifier=skip_clarifier)
    yield _Turn(agent, state, session_registry, context, inputs, request, runtime)


async def _answer(turn: _Turn, *, message_id: str, stream: bool) -> AsyncIterator[EventBody]:
    """The answer's bodies as the graph writes them, then its ``RUN_FINISHED``.

    The four registries and, when the platform lets the answer stream
    (ADR-0066), the live prose are bound for the whole run; the terminal is
    built once they are unbound, so ``registries.memory_writes`` is what the
    turn actually wrote.
    """
    runtime = turn.runtime
    outcome: TurnOutcome[ConversationState] | None = None
    async with turn_registries(runtime.thread_id, turn.session_registry) as registries:
        answering = answer_turn(
            turn.agent,
            turn.state,
            thread_id=runtime.thread_id,
            organization_id=turn.request.organization_id,
            # The answer's id rides the cost ledger, so its details can say what it
            # cost. No identity means "read it off the request", which must stay so.
            identity={**runtime.identity, "message_id": message_id} if runtime.identity is not None else None,
            metadata=runtime.metadata,
            ledgers=runtime.ledgers,
        )
        live = bound_live_prose(message_id) if stream else contextlib.nullcontext()
        with live:
            async with contextlib.aclosing(answering) as items:
                async for item in items:
                    if isinstance(item, TurnOutcome):
                        outcome = item
                    else:
                        yield item
    assert outcome is not None
    yield _finished(
        outcome, registries, turn.context, turn.inputs, message_id=message_id, stage_llms=runtime.stage_llms
    )


def _turn_runner(agent: ConversationGraph, config: ChatDeepResearcherConfig, stage_llms: dict):
    """The per-turn entry point NAT calls, composed from ``aiq_agent.turn``."""
    any_stage_llm = any(llm is not None for llm in stage_llms.values())

    async def _run(query: object) -> Annotated[AsyncGenerator[EventBody, None], Streaming(convert=fold_turn)]:
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
        if (loading := documents_loading_step(shelves_in_scope(header_scope or ()))) is not None:
            yield StepFinishedBody(step=loading)
        turn_metadata: dict[str, Any] = {}
        identity = turn_identity(request, conversation_id)
        profiler = None
        # ONE `finally` posts the ledgers for every exit of the turn — happy,
        # refused, raising or cancelled — from OUTSIDE the profiled block, so
        # the root span has closed by the time its batch goes; a flush from
        # inside would post first and strand it. The cost tracker is held here,
        # filled the moment it exists, because a turn that RAISES has no outcome.
        ledgers = TurnLedgers()
        fold = TurnTextFold()
        terminal: RunFinishedBody | None = None
        try:
            # The profiler root opens BEFORE the setup I/O so every setup step has a
            # row; `inline_flush=False` posts its final batch after the answer is out.
            with track_agent_profile(
                agent_name=PROFILE_AGENT_NAME, identity=identity, metadata=turn_metadata, inline_flush=False
            ) as profiler:
                setup = _prepare_turn(
                    agent,
                    request,
                    inputs,
                    header_scope,
                    conversation_id=conversation_id,
                    enable_clarifier=config.enable_clarifier,
                    resolve_stages=any_stage_llm,
                    runtime=_TurnRuntime(thread_id, identity, turn_metadata, ledgers, stage_llms),
                )
                async with contextlib.aclosing(setup) as items:
                    async for item in items:
                        if isinstance(item, _Turn):
                            turn = item
                        else:
                            yield item
                message_id = answer_message_id(conversation_id, turn.context.stage_facts.ws_parent_id)
                stream = await asyncio.to_thread(answer_streaming_enabled)
                # `aclosing` at every level, because `async for` never closes
                # what it iterates: a consumer that walks away would reach the
                # flush below with the graph still suspended mid-run.
                async with contextlib.aclosing(_answer(turn, message_id=message_id, stream=stream)) as bodies:
                    async for body in bodies:
                        if isinstance(body, RunFinishedBody):
                            terminal = body
                            continue
                        fold.add(body)
                        yield body
            # The terminal goes out after the profiled block has closed.
            assert terminal is not None
            note_settled_replaced(fold.settled, terminal.result.text)
            yield terminal
        finally:
            # Two BFF round-trips, posted AFTER the reader has the answer; in the
            # `finally` so a consumer that closes the stream early still posts.
            await flush_after_answer(profiler, ledgers.cost_tracker)

    return _run


@register_function(config_type=ChatDeepResearcherConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def chat_deepresearcher_agent(config: ChatDeepResearcherConfig, builder: Builder):
    """Chat deep researcher orchestrator agent."""
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
    run = _turn_runner(agent, config, stage_llms)
    yield FunctionInfo.from_fn(run, description="Piloti: one answering agent, escalation to deep research.")

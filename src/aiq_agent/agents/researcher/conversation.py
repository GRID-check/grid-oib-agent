"""The conversation graph: one answering agent, escalation as its own edge.

Every turn enters the researcher with its full tool set. That agent decides,
per turn and in the answer envelope, what the turn is: a direct reply (no
source consulted, no self-assessment), a researched answer (sources retrieved,
cited, graded), or a hand-off to deep research (``escalate_to_deep`` with a
reason). There is no classifier in front of it (ADR-0052): a label decided
before the answer could only ever withhold capabilities the answer turned out
to need, and the classes it produced — "meta", "listing", "out of scope" — are
all shapes the answering model can choose itself.

So this module adds exactly two things to :class:`ResearcherAgent`: the
escalation edge (clarifier, then deep research, unless the reader has already
declined a plan), and the conversation-scoped state the checkpointer persists
between turns — the message history and that sticky refusal. Everything else a
turn carries out is a field of the researcher's own finished state, lifted by
:data:`ANSWER_LIFTS` rather than recomputed here.
"""

import logging
from collections.abc import Awaitable
from collections.abc import Callable
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END
from langgraph.graph import StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.common import get_latest_user_query
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.job_admission import JobAdmissionError
from aiq_agent.common.platform_lessons import render_lessons_block
from aiq_agent.common.profiler import profiled_node
from aiq_agent.common.tool_validation import format_user_facing_tool_error
from aiq_agent.common.turn_status import emit_escalation
from aiq_agent.knowledge.inventory import set_listing_shelf
from aiq_agent.knowledge.inventory import shelf_hint_from_query
from aiq_agent.turn.api_seam import AuthError

from .clarify import ClarifyFn
from .history import trim_message_history
from .markers import detect_and_strip_confidence_marker
from .markers import detect_and_strip_escalation_marker
from .models import ClarifyRequest
from .models import ConversationState
from .models import ResearchAgentState

logger = logging.getLogger(__name__)

PLAN_CANCELLED_MESSAGE = (
    "In Ordnung, ich habe die geplante Recherche verworfen. "
    "Wenn Sie doch eine Antwort möchten, stellen Sie Ihre Frage einfach erneut – "
    "ich beantworte sie dann direkt, ohne einen neuen Rechercheplan vorzuschlagen."
)
"""The receipt for an explicit plan cancellation.

German because the product is German-first and this string reaches the user
verbatim (there is no UI envelope to localize it, unlike the plan preview).
It must say two things: that nothing is being researched — the turn really is
over, by the user's own choice, not by a failure — and how to get an answer
after all. The second half is literally true: the cancellation sets
``deep_research_declined`` on the conversation, so re-asking the question
routes straight to the researcher instead of producing plan number two.
"""

GENERIC_ERROR_MESSAGE = "An error occurred while researching your question. Please try again."
NO_SOURCES_MESSAGE = (
    "I searched the available sources but couldn't retrieve anything usable "
    "to ground an answer to this question. This may be a temporary issue — "
    "please try again, or rephrase the question."
)
# Reader-facing text, and therefore left verbatim by the rename: it is what
# `escalation_reason` carries onto the wire when the model asked to escalate
# without saying why, so it is already stored in turns from before this commit.
# Changing the wording is a copy change with a release note, not a rename.
LEGACY_ESCALATION_REASON = "Shallow agent emitted insufficiency marker"

#: State fields that survive the turn boundary. Everything else is reset on
#: every ``run()`` so nothing from a previous turn's checkpoint — a stale job
#: id, a prior self-assessment, last turn's routing — can leak onto this one.
#: ``deep_research_declined`` is STICKY for the conversation on purpose: the
#: user said no to a research plan once and should not have to say it again.
CONVERSATION_SCOPED_FIELDS: frozenset[str] = frozenset({"messages", "deep_research_declined"})
TURN_SCOPED_FIELDS: frozenset[str] = frozenset(ConversationState.model_fields) - CONVERSATION_SCOPED_FIELDS

#: ``(researcher state attribute, conversation state field)``: what a finished
#: answer carries out of the research turn. Every one of these is already
#: decided by the agent that produced the answer — the guarded confidence and
#: the observed routing are derived properties of its state, next to the
#: signals they read — so this node copies rather than re-derives. Both names
#: are checked against both models by a test, so a rename on either side is a
#: failure rather than a field that silently stops being lifted.
ANSWER_LIFTS: tuple[tuple[str, str], ...] = (
    ("observed_routing", "routing_decision"),
    ("answer_confidence", "answer_confidence"),
    ("answer_confidence_marker_reason", "answer_confidence_reason"),
    ("answer_confidence_capped_reason", "answer_confidence_capped_reason"),
    ("verified_sources", "verified_sources"),
    ("citations_removed", "citations_removed"),
    ("skills_activated", "skills_activated"),
    ("skills_hidden", "skills_hidden"),
    ("answer_meta", "answer_meta"),
)


def _error_update(message: str) -> dict[str, Any]:
    """The node update for a failed turn: a retry-able error, never an
    escalation — deep research does not fix a transient or a bug."""
    return {
        "messages": [AIMessage(content=message)],
        "routing_decision": "error",
        "escalate_to_deep": False,
    }


def _no_sources_message(research_type: str, exc: EmptySourceRegistryError) -> str:
    """Only fires when a data-source tool was actually queried and yielded
    nothing citable — it must not blame the search tools for unrelated failures."""
    if exc.unavailable_tools:
        return format_user_facing_tool_error(research_type, exc.unavailable_tools, exc.available_count)
    return NO_SOURCES_MESSAGE


def _escalation_update(message: BaseMessage, result: ResearchAgentState) -> dict[str, Any]:
    """The deep research report supersedes this answer: carry the ASK and no
    fact about the answer it replaces — no self-assessment, no skills-ran
    signal, no truncation note, no anatomy.

    Those fields are absent rather than nulled: ``run`` resets every
    turn-scoped field at turn entry and this node is the only writer before the
    hand-off, so they are still at their defaults when this returns.
    """
    return {
        "messages": [message],
        "escalate_to_deep": True,
        "escalation_ask_reason": result.answer_escalation_reason or LEGACY_ESCALATION_REASON,
        "verified_sources": result.verified_sources,
    }


def _answer_update(message: BaseMessage, result: ResearchAgentState) -> dict[str, Any]:
    """A finished answer with everything the researcher decided about it."""
    update: dict[str, Any] = {field: getattr(result, source) for source, field in ANSWER_LIFTS}
    update["messages"] = [message]
    update["escalate_to_deep"] = False
    # Presence is the fact: True or absent, never False.
    update["research_truncated"] = True if result.research_truncated else None
    return update


def _stripped(content: str) -> str:
    """The answer text with any control marker removed.

    The researcher's own pipeline already strips these; this is the defensive
    second pass, so no marker can reach a reader even if a message other than
    the one that pipeline cleaned ends up being the answer.
    """
    without_escalation, _ = detect_and_strip_escalation_marker(content)
    clean, _, _ = detect_and_strip_confidence_marker(without_escalation)
    return clean


def _finalize_answer(message: BaseMessage, result: ResearchAgentState) -> dict[str, Any]:
    """The node update for a finished research turn, from its answer message and
    the structured signals the researcher extracted in its own ``run()``.

    Those signals are authoritative; non-string content passes through
    untouched with no signal at all.
    """
    content = message.content
    if not isinstance(content, str):
        return {"messages": [message]}
    clean_content = _stripped(content)
    escalating = bool(result.escalation_requested)
    if not clean_content.strip() and not escalating:
        # An empty answer is a generation failure, not an escalation signal.
        logger.error("Research produced an empty answer")
        return _error_update(GENERIC_ERROR_MESSAGE)
    updated = message.model_copy(update={"content": clean_content}) if clean_content != content else message
    if escalating:
        return _escalation_update(updated, result)
    return _answer_update(updated, result)


def _answer_message(new_messages: list[BaseMessage]) -> BaseMessage | None:
    """The answer among the messages the researcher added: the last AIMessage
    that is not a tool call, else whatever came last."""
    final = next((m for m in reversed(new_messages) if isinstance(m, AIMessage) and not m.tool_calls), None)
    if final is not None:
        return final
    return new_messages[-1] if new_messages else None


def _deep_handoff(
    original_query: str | None, escalation_reason: str | None, clarifier_result: str | None = None
) -> Command:
    update: dict[str, Any] = {
        "original_query": original_query,
        "escalation_reason": escalation_reason,
        "routing_decision": "deep",
    }
    if clarifier_result is not None:
        update["clarifier_result"] = clarifier_result
    return Command(goto="deep_research", update=update)


def _plan_cancelled(original_query: str | None) -> Command:
    """An explicit cancellation is the one refusal that may end the turn without
    an answer: the user chose it over the shallow option sitting right next to
    it. It still gets a receipt — a silent end reads as a crash — and declines
    deep for the rest of the conversation, so re-asking yields the answer."""
    logger.info("Conversation: Plan cancelled by user, ending the turn with a receipt")
    return Command(
        goto=END,
        update={
            "messages": [AIMessage(content=PLAN_CANCELLED_MESSAGE)],
            "original_query": original_query,
            "deep_research_declined": True,
            # A receipt, not an answer: neither path was taken.
            "routing_decision": "meta",
            "escalation_reason": None,
            "escalate_to_deep": False,
        },
    )


def _plan_rejected(original_query: str | None) -> Command:
    """A rejected plan is not a cancelled question. The question is right there
    in the messages and the researcher can answer it; ending here told a user
    who had just said "no" twice to retype the question the product was already
    holding. Fall through to the researcher and remember the rejection for the
    rest of the conversation so ``_should_escalate`` never offers plan two."""
    logger.info("Conversation: Plan rejected by user, answering on the shallow path instead")
    return Command(
        goto="shallow_research",
        update={
            "original_query": original_query,
            "deep_research_declined": True,
            "escalation_reason": None,
            "escalate_to_deep": False,
        },
    )


class ConversationGraph:
    """One conversation with the researcher, across turns.

    1. The researcher answers, with every tool it has.
    2. If its envelope asks for deep research, the clarifier confirms a plan
       and deep research runs (as an async job when a submitter is wired).

    The checkpointer holds what a conversation is: the message history and the
    reader's standing refusal of a research plan. Everything else is reset per
    turn (:data:`TURN_SCOPED_FIELDS`).
    """

    def __init__(
        self,
        research_fn: Callable[[ResearchAgentState], Awaitable[ResearchAgentState]],
        deep_research_fn: Callable[[DeepResearchAgentState], Awaitable[DeepResearchAgentState]],
        clarifier_fn: ClarifyFn | None,
        *,
        max_history_tokens: int = 8000,
        deep_research_job_submitter: Callable[[ConversationState], Awaitable[str]] | None = None,
        checkpointer: BaseCheckpointSaver | None = None,
        validate_deep_research_tools_fn: Callable[[list[str] | None], tuple[bool, str]] | None = None,
    ) -> None:
        """Cards are emitted by the answering agent via the ``emit_card`` tool,
        not generated here; the checkpointer defaults to an in-memory saver.

        ``clarifier_fn`` is None when the deployment runs without a clarifier;
        the hand-off then goes straight to deep research, exactly as it does
        for a turn whose caller asked to skip it (``state.skip_clarifier``).
        """
        self.research_fn = research_fn
        self.deep_research_fn = deep_research_fn
        self.clarifier_fn = clarifier_fn
        self.max_history_tokens = max_history_tokens
        self.deep_research_job_submitter = deep_research_job_submitter
        self.checkpointer = checkpointer
        self.validate_deep_research_tools_fn = validate_deep_research_tools_fn
        self._graph = self._build_graph()

    def _trimmed(self, state: ConversationState) -> list[BaseMessage]:
        return trim_message_history(state.messages, self.max_history_tokens)

    async def _clarifier_node(self, state: ConversationState) -> Command:
        original_query = get_latest_user_query(state.messages)
        escalation_reason = state.escalation_ask_reason
        if self.validate_deep_research_tools_fn:
            is_valid, error_msg = self.validate_deep_research_tools_fn(state.data_sources)
            if not is_valid:
                logger.error("Deep research tools validation failed: %s", error_msg)
                return Command(
                    goto=END, update={"messages": [AIMessage(content=error_msg)], "original_query": original_query}
                )
        if state.skip_clarifier or self.clarifier_fn is None:
            return _deep_handoff(original_query, escalation_reason)
        available_docs = [doc.model_dump() for doc in (state.available_documents or [])]
        result = await self.clarifier_fn(
            ClarifyRequest(
                messages=self._trimmed(state),
                data_sources=state.data_sources,
                available_documents=available_docs or None,
                project_context=state.project_context,
            )
        )
        if result.outcome == "cancelled":
            return _plan_cancelled(original_query)
        if result.outcome == "shallow":
            return _plan_rejected(original_query)
        return _deep_handoff(original_query, escalation_reason, result.research_context)

    def _research_input(self, state: ConversationState, trimmed: list[BaseMessage]) -> ResearchAgentState:
        return ResearchAgentState(
            messages=trimmed,
            data_sources=state.data_sources,
            user_info=state.user_info,
            available_documents=state.available_documents,
            in_flight_documents=state.in_flight_documents,
            project_context=state.project_context,
            platform_lessons=state.platform_lessons,
            focus_file_name=state.focus_file_name,
            focus_shelf=state.focus_shelf,
            # The user-requested forced skills, resolved by the researcher's
            # register layer against the run's skill set — never passed to deep
            # research.
            force_skills=state.force_skills,
        )

    async def _run_research(self, research_state: ResearchAgentState) -> ResearchAgentState | dict[str, Any]:
        """The researcher's result, or the error update for a failed call."""
        try:
            return await self.research_fn(research_state)
        except EmptySourceRegistryError as exc:
            logger.warning("Research produced no verifiable sources")
            return _error_update(_no_sources_message("research", exc))
        except AuthError as exc:
            logger.warning("Auth error in research: %s", exc)
            return _error_update(str(exc))
        except Exception as exc:  # noqa: BLE001 - the turn answers with an error rather than dying
            logger.exception("Error in research: %s", exc)
            return _error_update(GENERIC_ERROR_MESSAGE)

    async def _research_node(self, state: ConversationState) -> dict[str, Any]:
        trimmed = self._trimmed(state)
        logger.debug("research_node: available_documents = %s", state.available_documents)
        # A shelf named in the question ("was hast du im Büroarchiv") is the
        # one the inventory prints in full this turn — a ContextVar read by
        # the prompt renderer; the graph runs in this task.
        set_listing_shelf(shelf_hint_from_query(get_latest_user_query(state.messages) or ""))
        result = await self._run_research(self._research_input(state, trimmed))
        if isinstance(result, dict):
            return result
        if not result.messages:
            logger.error("The researcher returned no messages")
            return _error_update(GENERIC_ERROR_MESSAGE)
        message = _answer_message(result.messages[len(trimmed) :])
        if message is None:
            return {"messages": []}
        return _finalize_answer(message, result)

    async def _submit_deep_job(self, state: ConversationState) -> dict[str, Any]:
        assert self.deep_research_job_submitter is not None
        try:
            job_id = await self.deep_research_job_submitter(state)
        except JobAdmissionError as exc:
            # Queue full: answer with the friendly reason, marked as a
            # rejection notice (not a research answer) with the retry hint.
            logger.info("Deep research submission refused by admission control: %s", exc)
            return {
                "messages": [AIMessage(content=str(exc))],
                "job_admission_rejected": True,
                "retry_after_seconds": exc.retry_after_seconds,
            }
        # The job id is a structured channel value so the frontend can open
        # the research panel without regex-parsing this prose.
        return {
            "messages": [AIMessage(content=f"Deep research job submitted. Job ID: {job_id}")],
            "deep_research_job_id": job_id,
        }

    async def _run_deep_inline(self, state: ConversationState) -> dict[str, Any]:
        research_query = state.original_query or get_latest_user_query(state.messages)
        deep_state = DeepResearchAgentState(
            messages=self._trimmed(state) + [HumanMessage(content=research_query)],
            data_sources=state.data_sources,
            clarifier_result=state.clarifier_result,
            available_documents=state.available_documents,
            user_info=state.user_info,
            project_context=state.project_context,
            platform_lessons=render_lessons_block(state.platform_lessons),
        )
        try:
            result = await self.deep_research_fn(deep_state)
        except EmptySourceRegistryError as exc:
            logger.warning("Deep research produced no verifiable sources")
            return {"messages": [AIMessage(content=_no_sources_message("deep research", exc))]}
        except AuthError as exc:
            logger.warning("Auth error in deep research: %s", exc)
            return {"messages": [AIMessage(content=str(exc))]}
        if not result.messages:
            logger.error("An error occurred during deep research.")
            return {"messages": [AIMessage(content="An error occurred during deep research.")]}
        update: dict[str, Any] = {"messages": [result.messages[-1]]}
        if result.citations_removed:
            update["citations_removed"] = result.citations_removed
        return update

    async def _deep_research_node(self, state: ConversationState) -> dict[str, Any]:
        if self.deep_research_job_submitter is not None:
            return await self._submit_deep_job(state)
        return await self._run_deep_inline(state)

    @staticmethod
    def _should_escalate(state: ConversationState) -> str:
        # The user rejected a research plan in this conversation. Escalating
        # would put a THIRD plan in front of them — and on the rejection turn
        # itself it would be a cycle: clarifier -> shallow -> clarifier.
        if state.deep_research_declined:
            logger.info("Escalation suppressed: the user rejected a research plan in this conversation")
            return "END"
        if not state.escalate_to_deep:
            return "END"
        # Deep research is minutes, not seconds, and this is the instant that
        # becomes true. Told now, the reader is waiting; told on the terminal
        # frame, they spent those minutes wondering whether the turn broke.
        emit_escalation(state.escalation_ask_reason)
        return "deep_research"

    def _build_graph(self) -> CompiledStateGraph:
        # The node is still NAMED ``shallow_research`` although the agent behind
        # it is now just the researcher. A LangGraph checkpoint records node
        # names in ``versions_seen``, so renaming one makes every conversation
        # written before the deploy look like it has never run this node; the
        # frontend also labels a step by this string
        # (``intermediate-step-parser.ts::NODE_LABEL_KEYS``). It is a persisted
        # key, and it is deliberately left alone — see the same note on the
        # ``shallow_research_agent`` function block in the config.
        graph = StateGraph(ConversationState)
        graph.add_node("shallow_research", profiled_node("shallow_research", self._research_node))
        graph.add_node("clarifier", profiled_node("clarifier", self._clarifier_node))
        graph.add_node("deep_research", profiled_node("deep_research", self._deep_research_node))
        # Every turn starts with the answering agent. Deep research is reached
        # only through its escalation; the clarifier confirms the plan on the
        # way (or is skipped for headless callers).
        graph.set_entry_point("shallow_research")
        graph.add_conditional_edges(
            "shallow_research", self._should_escalate, {"deep_research": "clarifier", "END": END}
        )
        graph.add_edge("deep_research", END)
        return graph.compile(checkpointer=self.checkpointer)

    async def run(self, state: ConversationState, thread_id: str | None = None) -> ConversationState:
        """Execute one turn on ``thread_id``'s conversation and return the final state.

        The graph input is every turn-scoped field of the fresh ``state`` plus
        its new messages: a field listed is overwritten with this turn's value
        (its default, for the outputs), a field omitted keeps its checkpointed
        value — which is how ``deep_research_declined`` stays sticky.
        """
        graph_config: RunnableConfig = {"configurable": {"thread_id": thread_id}}
        logger.info("Conversation: Starting turn")
        input_state = {name: getattr(state, name) for name in TURN_SCOPED_FIELDS}
        input_state["messages"] = state.messages
        if state.messages:
            logger.info("Query: %s...", str(state.messages[-1].content)[:100])
        result = await self._graph.ainvoke(input_state, config=graph_config)
        logger.info("Conversation: Turn complete")
        return ConversationState.model_validate(result)

    async def append_context_message(self, thread_id: str, text: str) -> None:
        """Append a human turn to *thread_id*'s history WITHOUT running the graph.

        The agent-tier half of ingest-only context (ADR-0034 addendum): a
        colleague's message that the server ruled is NOT addressed to the agent
        still has to be in the agent's memory, or a later "given that, recheck"
        refers to nothing. ``aupdate_state`` writes a checkpoint through the
        ``messages`` reducer and schedules no task, so no node runs and no
        token is spent. Only ``messages`` grows; nothing turn-scoped is touched.
        """
        if not thread_id or not text:
            return
        graph_config: RunnableConfig = {"configurable": {"thread_id": thread_id}}
        await self._graph.aupdate_state(graph_config, {"messages": [HumanMessage(content=text)]})
        logger.info("Conversation: ingested %d chars of context (thread %s)", len(text), thread_id)

    @property
    def graph(self) -> CompiledStateGraph:
        """Get the compiled LangGraph for direct access."""
        return self._graph

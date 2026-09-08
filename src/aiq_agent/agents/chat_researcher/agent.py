"""
Chat Researcher Agent - one answering agent per turn, escalation as its own call.

Every turn enters the shallow research agent with its full tool set. That agent
decides, per turn and in the answer envelope, what the turn is: a direct reply
(no source consulted, no self-assessment), a researched answer (sources
retrieved, cited, graded), or a hand-off to deep research (``escalate_to_deep``
with a reason). There is no classifier in front of it (ADR-0052): a label
decided before the answer could only ever withhold capabilities the answer
turned out to need, and the classes it produced — "meta", "listing", "out of
scope" — are all shapes the answering model can choose itself.

What remains of routing is an OBSERVATION recorded after the fact
(``routing_decision``): which path the turn took, for the transparency
surface and the post-answer stages.
"""

import logging
from collections.abc import Awaitable
from collections.abc import Callable
from typing import Any
from typing import Literal

from langchain_core.messages import AIMessage
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END
from langgraph.graph import StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command
from pydantic import ValidationError

from aiq_agent.agents.clarifier.models import ClarifierAgentState
from aiq_agent.agents.clarifier.models import ClarifierResult
from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.agents.shallow_researcher.markers import ConfidenceLevel
from aiq_agent.agents.shallow_researcher.markers import answer_confidence_capped_reason
from aiq_agent.agents.shallow_researcher.markers import detect_and_strip_confidence_marker
from aiq_agent.agents.shallow_researcher.markers import detect_and_strip_escalation_marker
from aiq_agent.agents.shallow_researcher.markers import surface_answer_confidence
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
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

from .models import ChatResearcherState
from .models import ShallowResult
from .utils import trim_message_history

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
routes straight to the shallow agent instead of producing plan number two.
"""

GENERIC_ERROR_MESSAGE = "An error occurred while researching your question. Please try again."
NO_SOURCES_MESSAGE = (
    "I searched the available sources but couldn't retrieve anything usable "
    "to ground an answer to this question. This may be a temporary issue — "
    "please try again, or rephrase the question."
)
LEGACY_ESCALATION_REASON = "Shallow agent emitted insufficiency marker"

#: State fields that survive the turn boundary. Everything else is reset on
#: every ``run()`` so nothing from a previous turn's checkpoint — a stale job
#: id, a prior self-assessment, last turn's routing — can leak onto this one.
#: ``deep_research_declined`` is STICKY for the conversation on purpose: the
#: user said no to a research plan once and should not have to say it again.
CONVERSATION_SCOPED_FIELDS: frozenset[str] = frozenset({"messages", "deep_research_declined"})
TURN_SCOPED_FIELDS: frozenset[str] = frozenset(ChatResearcherState.model_fields) - CONVERSATION_SCOPED_FIELDS

RoutingDecision = Literal["meta", "shallow", "deep", "error"]


def observed_routing(*, source_lookup_attempted: bool, self_reported: ConfidenceLevel | None) -> RoutingDecision:
    """What kind of turn the answering agent made of it, read off what it did.

    Nothing classifies a turn up front any more; the model has every tool on
    every turn and picks the reply's shape itself. Two facts of the finished
    answer say which shape it picked: whether it consulted a data source, and
    whether it graded itself (a direct reply — a greeting, a shelf listing, an
    off-topic decline, "what can you do" — carries no ``confidence``, because
    there is nothing to grade). Neither → ``meta``, the transparency surface's
    word for a direct reply. Either → ``shallow``: a researched answer, or at
    least one the model presented as one. Deep and error are set by the nodes
    that take those paths, never derived here.
    """
    if not source_lookup_attempted and self_reported is None:
        return "meta"
    return "shallow"


def escalation(state: ChatResearcherState) -> ShallowResult | None:
    """The shallow result that asked for deep research this turn, or ``None``.

    Escalation requires the shallow agent's explicit, prompted signal, carried
    as the structured ``shallow_result``. There is deliberately no keyword or
    prose fallback: German legal hedging in a SUCCESSFUL answer ("lässt sich
    nicht finden", "weitere Recherche erforderlich") false-positived a
    substring match and surprise-escalated good answers. Successful shallow
    paths set ``shallow_result=None``, so this only fires on an explicit ask.
    """
    result = state.shallow_result
    if result is None or not result.escalate_to_deep:
        return None
    return result


def _normalize_citations_removed(value: Any) -> dict[str, Any] | None:
    """Sanitize a research agent's removed-citation summary to the wire shape.

    Returns ``{"count": int, "reasons": [str, ...]}`` (reasons deduplicated, max
    5) only when at least one citation was removed; otherwise ``None`` so the
    field stays absent (never null-spammed).
    """
    if not isinstance(value, dict):
        return None
    try:
        count = int(value.get("count", 0))
    except (TypeError, ValueError):
        return None
    if count < 1:
        return None
    reasons: list[str] = []
    for reason in value.get("reasons") or []:
        text = str(reason)
        if text and text not in reasons:
            reasons.append(text)
        if len(reasons) >= 5:
            break
    return {"count": count, "reasons": reasons}


def _error_update(message: str) -> dict[str, Any]:
    """The node update for a failed shallow turn: a retry-able error, never an
    escalation — deep research does not fix a transient or a bug."""
    return {
        "messages": [AIMessage(content=message)],
        "routing_decision": "error",
        "shallow_result": ShallowResult(answer=message, escalate_to_deep=False),
    }


def _no_sources_message(research_type: str, exc: EmptySourceRegistryError) -> str:
    """Only fires when a data-source tool was actually queried and yielded
    nothing citable — it must not blame the search tools for unrelated failures."""
    if exc.unavailable_tools:
        return format_user_facing_tool_error(research_type, exc.unavailable_tools, exc.available_count)
    return NO_SOURCES_MESSAGE


def _escalation_update(message: BaseMessage, clean_content: str, result: ShallowResearchAgentState) -> dict[str, Any]:
    """The deep research report supersedes this answer: carry the ask and no
    fact about the answer it replaces — no self-assessment, no skills-ran
    signal, no truncation note, no anatomy."""
    return {
        "messages": [message],
        "shallow_result": ShallowResult(
            answer=clean_content,
            escalate_to_deep=True,
            escalation_reason=result.answer_escalation_reason or LEGACY_ESCALATION_REASON,
        ),
        "answer_confidence": None,
        "answer_confidence_reason": None,
        "verified_sources": result.verified_sources,
        "skills_activated": None,
        "skills_hidden": None,
        "research_truncated": None,
        "answer_meta": None,
    }


def _answer_update(message: BaseMessage, result: ShallowResearchAgentState) -> dict[str, Any]:
    """A finished shallow answer with its observed routing and guarded confidence.

    The guard recognises two kinds of grounding. ``answer_citation_grounded``
    is the only route to a surfaced "high". Measurement grounding lifts the
    answer off the "low" floor to at most "medium", and only while
    ``answer_normative_claim_uncited`` is False: a measured answer that also
    asserts something about the Bauordnung without a verified citation stays
    at "low", because the measurement grounds the number and not the law. A
    citation from the single-source fallback is treated like a measurement:
    at most "medium", and stopped by the same normative brake.
    """
    guard = dict(
        measurement_grounded=result.answer_measurement_grounded,
        normative_claim_uncited=result.answer_normative_claim_uncited,
        citation_fallback_used=result.answer_citation_fallback_used,
    )
    level = result.answer_confidence_marker
    return {
        "messages": [message],
        "shallow_result": None,
        "routing_decision": observed_routing(
            source_lookup_attempted=result.source_lookup_attempted, self_reported=level
        ),
        "answer_confidence": surface_answer_confidence(
            level, result.answer_citation_grounded, result.answer_quotes_verified, **guard
        ),
        "answer_confidence_reason": result.answer_confidence_marker_reason,
        "answer_confidence_capped_reason": answer_confidence_capped_reason(
            level, result.answer_citation_grounded, result.answer_quotes_verified, **guard
        ),
        "verified_sources": result.verified_sources,
        "citations_removed": _normalize_citations_removed(result.citations_removed),
        "skills_activated": result.skills_activated,
        "skills_hidden": result.skills_hidden,
        # Presence is the fact: True or absent, never False.
        "research_truncated": True if result.research_truncated else None,
        "answer_meta": result.answer_meta or None,
    }


def _finalize_shallow_answer(message: BaseMessage, result: ShallowResearchAgentState) -> dict[str, Any]:
    """Build the node update for a finished shallow turn from its answer message
    and the structured signals the shallow agent extracted in its own ``run()``.

    Those signals are authoritative for routing; the answer text is still
    stripped defensively so no control marker can leak even if a different
    message than the one ``run()`` cleaned reached this node. Non-string
    content passes through untouched with no signal at all.
    """
    content = message.content
    if not isinstance(content, str):
        return {"messages": [message], "shallow_result": None}
    without_escalation, _ = detect_and_strip_escalation_marker(content)
    clean_content, _, _ = detect_and_strip_confidence_marker(without_escalation)
    escalating = bool(result.escalation_requested)
    if not clean_content.strip() and not escalating:
        # An empty answer is a generation failure, not an escalation signal.
        logger.error("Shallow research produced an empty answer")
        return _error_update(GENERIC_ERROR_MESSAGE)
    updated = message.model_copy(update={"content": clean_content}) if clean_content != content else message
    if escalating:
        return _escalation_update(updated, clean_content, result)
    return _answer_update(updated, result)


def as_shallow_state(result: object) -> ShallowResearchAgentState:
    """The shallow agent's result as the model it is typed to return.

    ``ShallowResearchAgentState`` is the contract and the production caller
    always returns one. A duck-typed stand-in (a test's ``MagicMock``) is
    validated field by field, STRICTLY, so that only the attributes it really
    set survive: an auto-vivified attribute is not a bool or a list (lax mode
    would coerce it through ``__int__``/``__iter__``), fails validation, and
    falls back to the model's default instead of being read as a signal.
    """
    if isinstance(result, ShallowResearchAgentState):
        return result
    raw = {name: getattr(result, name, None) for name in ShallowResearchAgentState.model_fields}
    try:
        return ShallowResearchAgentState.model_validate(raw, strict=True)
    except ValidationError as exc:
        rejected = {str(err["loc"][0]) for err in exc.errors() if err["loc"]}
        return ShallowResearchAgentState.model_validate(
            {k: v for k, v in raw.items() if k not in rejected}, strict=True
        )


def matches_escalation_keywords(content: str) -> bool:
    """Return True if the tail of an answer reads as an insufficiency statement.

    Only the last 800 characters (lowercased) are examined. Used by the memory
    reflection stage (``stages.memory_reflection``) to skip canned
    insufficiency answers — NOT by the escalation decision, which requires the
    shallow agent's explicit signal (a substring match on German legal hedging
    false-positived on successful answers).
    """
    tail = content[-800:].lower() if len(content) > 800 else content.lower()
    escalation_keywords = [
        "i don't have enough information",
        "unable to find",
        "need more research",
        "keine ausreichenden informationen",
        "nicht genügend informationen",
        "konnte keine informationen",
        "keine informationen gefunden",
        "nicht finden",
        "weitere recherche erforderlich",
        "genauere prüfung erforderlich",
    ]
    return any(kw in tail for kw in escalation_keywords)


def _answer_message(new_messages: list[BaseMessage]) -> BaseMessage | None:
    """The answer among the messages the shallow agent added: the last AIMessage
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
    logger.info("ChatResearcher: Plan cancelled by user, ending the turn with a receipt")
    return Command(
        goto=END,
        update={
            "messages": [AIMessage(content=PLAN_CANCELLED_MESSAGE)],
            "original_query": original_query,
            "deep_research_declined": True,
            # A receipt, not an answer: neither path was taken.
            "routing_decision": "meta",
            "escalation_reason": None,
            "shallow_result": None,
        },
    )


def _plan_rejected(original_query: str | None) -> Command:
    """A rejected plan is not a cancelled question. The question is right there
    in the messages and the shallow agent can answer it; ending here told a
    user who had just said "no" twice to retype the question the product was
    already holding. Fall through to shallow and remember the rejection for
    the rest of the conversation so ``should_escalate`` never offers plan two."""
    logger.info("ChatResearcher: Plan rejected by user, answering on the shallow path instead")
    return Command(
        goto="shallow_research",
        update={
            "original_query": original_query,
            "deep_research_declined": True,
            "escalation_reason": None,
            "shallow_result": None,
        },
    )


class ChatResearcherAgent:
    """
    Orchestrates the chat workflow: one answering agent, one escalation path.

    1. The shallow research agent answers, with every tool it has.
    2. If its envelope asks for deep research, the clarifier confirms a plan
       and deep research runs (as an async job when a submitter is wired).
    """

    def __init__(
        self,
        shallow_research_fn: Callable[[ShallowResearchAgentState], Awaitable[ShallowResearchAgentState]],
        deep_research_fn: Callable[[DeepResearchAgentState], Awaitable[DeepResearchAgentState]],
        clarifier_fn: Callable[[ClarifierAgentState], Awaitable[ClarifierResult]] | None,
        *,
        enable_clarifier: bool = True,
        max_history_tokens: int = 8000,
        deep_research_job_submitter: Callable[[ChatResearcherState], Awaitable[str]] | None = None,
        checkpointer: BaseCheckpointSaver | None = None,
        validate_deep_research_tools_fn: Callable[[list[str] | None], tuple[bool, str]] | None = None,
    ) -> None:
        """Cards are emitted by the answering agent via the ``emit_card`` tool,
        not generated here; the checkpointer defaults to an in-memory saver."""
        self.shallow_research_fn = shallow_research_fn
        self.deep_research_fn = deep_research_fn
        self.clarifier_fn = clarifier_fn
        self.enable_clarifier = enable_clarifier
        self.max_history_tokens = max_history_tokens
        self.deep_research_job_submitter = deep_research_job_submitter
        self.checkpointer = checkpointer
        self.validate_deep_research_tools_fn = validate_deep_research_tools_fn
        self._graph = self._build_graph()

    def _trimmed(self, state: ChatResearcherState) -> list[BaseMessage]:
        return trim_message_history(state.messages, self.max_history_tokens)

    async def _clarifier_node(self, state: ChatResearcherState) -> Command:
        original_query = get_latest_user_query(state.messages)
        # Present only on a shallow→deep escalation entry; carried to the
        # terminal state so the frontend can narrate why.
        asked = escalation(state)
        escalation_reason = asked.escalation_reason if asked else None
        if self.validate_deep_research_tools_fn:
            is_valid, error_msg = self.validate_deep_research_tools_fn(state.data_sources)
            if not is_valid:
                logger.error("Deep research tools validation failed: %s", error_msg)
                return Command(
                    goto=END, update={"messages": [AIMessage(content=error_msg)], "original_query": original_query}
                )
        if not self.enable_clarifier or state.skip_clarifier:
            return _deep_handoff(original_query, escalation_reason)
        if self.clarifier_fn is None:
            raise ValueError(
                "enable_clarifier is True but clarifier_agent is not defined in config. "
                "Either add clarifier_agent to functions or set enable_clarifier: false."
            )
        available_docs = [doc.model_dump() for doc in (state.available_documents or [])]
        result = await self.clarifier_fn(
            ClarifierAgentState(
                messages=self._trimmed(state),
                data_sources=state.data_sources,
                available_documents=available_docs or None,
                project_context=state.project_context,
            )
        )
        if result.plan_cancelled:
            return _plan_cancelled(original_query)
        if result.plan_rejected:
            return _plan_rejected(original_query)
        clarifier_result = result.clarifier_log
        approved_plan_context = result.get_approved_plan_context()
        if approved_plan_context:
            clarifier_result = f"{clarifier_result}\n\n{approved_plan_context}"
        return _deep_handoff(original_query, escalation_reason, clarifier_result)

    def _shallow_input(self, state: ChatResearcherState, trimmed: list[BaseMessage]) -> ShallowResearchAgentState:
        return ShallowResearchAgentState(
            messages=trimmed,
            data_sources=state.data_sources,
            user_info=state.user_info,
            available_documents=state.available_documents,
            in_flight_documents=state.in_flight_documents,
            project_context=state.project_context,
            platform_lessons=state.platform_lessons,
            focus_file_name=state.focus_file_name,
            focus_shelf=state.focus_shelf,
            # The user-requested forced skills, resolved by the shallow register
            # layer against the run's skill set — never passed to deep research.
            force_skills=state.force_skills,
        )

    async def _run_shallow(
        self, shallow_state: ShallowResearchAgentState
    ) -> ShallowResearchAgentState | dict[str, Any]:
        """The shallow agent's result, or the error update for a failed call."""
        try:
            return as_shallow_state(await self.shallow_research_fn(shallow_state))
        except EmptySourceRegistryError as exc:
            logger.warning("Shallow research produced no verifiable sources")
            return _error_update(_no_sources_message("shallow research", exc))
        except AuthError as exc:
            logger.warning("Auth error in shallow research: %s", exc)
            return _error_update(str(exc))
        except Exception as exc:  # noqa: BLE001 - the turn answers with an error rather than dying
            logger.exception("Error in shallow research: %s", exc)
            return _error_update(GENERIC_ERROR_MESSAGE)

    async def _shallow_research_node(self, state: ChatResearcherState) -> dict[str, Any]:
        trimmed = self._trimmed(state)
        logger.debug("shallow_research_node: available_documents = %s", state.available_documents)
        # A shelf named in the question ("was hast du im Büroarchiv") is the
        # one the inventory prints in full this turn — a ContextVar read by
        # the prompt renderer; the graph runs in this task.
        set_listing_shelf(shelf_hint_from_query(get_latest_user_query(state.messages) or ""))
        result = await self._run_shallow(self._shallow_input(state, trimmed))
        if isinstance(result, dict):
            return result
        if not result.messages:
            logger.error("Shallow research agent returned no messages")
            return _error_update(GENERIC_ERROR_MESSAGE)
        message = _answer_message(result.messages[len(trimmed) :])
        if message is None:
            return {"messages": [], "shallow_result": None}
        return _finalize_shallow_answer(message, result)

    async def _submit_deep_job(self, state: ChatResearcherState) -> dict[str, Any]:
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

    async def _run_deep_inline(self, state: ChatResearcherState) -> dict[str, Any]:
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
        citations_removed = _normalize_citations_removed(getattr(result, "citations_removed", None))
        if citations_removed is not None:
            update["citations_removed"] = citations_removed
        return update

    async def _deep_research_node(self, state: ChatResearcherState) -> dict[str, Any]:
        if self.deep_research_job_submitter is not None:
            return await self._submit_deep_job(state)
        return await self._run_deep_inline(state)

    @staticmethod
    def _should_escalate(state: ChatResearcherState) -> str:
        # The user rejected a research plan in this conversation. Escalating
        # would put a THIRD plan in front of them — and on the rejection turn
        # itself it would be a cycle: clarifier -> shallow -> clarifier.
        if state.deep_research_declined:
            logger.info("Escalation suppressed: the user rejected a research plan in this conversation")
            return "END"
        asked = escalation(state)
        if asked is None:
            return "END"
        # Deep research is minutes, not seconds, and this is the instant that
        # becomes true. Told now, the reader is waiting; told on the terminal
        # frame, they spent those minutes wondering whether the turn broke.
        emit_escalation(asked.escalation_reason)
        return "deep_research"

    def _build_graph(self) -> CompiledStateGraph:
        graph = StateGraph(ChatResearcherState)
        graph.add_node("shallow_research", profiled_node("shallow_research", self._shallow_research_node))
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

    async def run(self, state: ChatResearcherState, thread_id: str | None = None) -> ChatResearcherState:
        """Execute one turn on ``thread_id``'s conversation and return the final state.

        The graph input is every turn-scoped field of the fresh ``state`` plus
        its new messages: a field listed is overwritten with this turn's value
        (its default, for the outputs), a field omitted keeps its checkpointed
        value — which is how ``deep_research_declined`` stays sticky.
        """
        graph_config: RunnableConfig = {"configurable": {"thread_id": thread_id}}
        logger.info("ChatResearcherAgent: Starting workflow")
        input_state = {name: getattr(state, name) for name in TURN_SCOPED_FIELDS}
        input_state["messages"] = state.messages
        if state.messages:
            logger.info("Query: %s...", str(state.messages[-1].content)[:100])
        result = await self._graph.ainvoke(input_state, config=graph_config)
        logger.info("ChatResearcherAgent: Workflow complete")
        return ChatResearcherState.model_validate(result)

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
        logger.info("ChatResearcherAgent: ingested %d chars of context (thread %s)", len(text), thread_id)

    @property
    def graph(self) -> CompiledStateGraph:
        """Get the compiled LangGraph for direct access."""
        return self._graph

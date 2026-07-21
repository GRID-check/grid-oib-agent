"""
Chat Researcher Agent - Orchestrates intent classification, depth routing, and research.

This is the main orchestrator agent that coordinates the full research workflow:
1. Intent classification (meta vs research)
2. Depth routing (shallow vs deep)
3. Research execution
4. Optional escalation from shallow to deep
"""

import logging
from collections.abc import Awaitable
from collections.abc import Callable
from typing import Any
from typing import Literal

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END
from langgraph.graph import StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from aiq_agent.agents.clarifier.models import ClarifierAgentState
from aiq_agent.agents.clarifier.models import ClarifierResult
from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.agents.shallow_researcher.markers import CONFIDENCE_MARKER_RE  # noqa: F401 (re-exported)
from aiq_agent.agents.shallow_researcher.markers import ESCALATION_MARKER  # noqa: F401 (re-exported)
from aiq_agent.agents.shallow_researcher.markers import ConfidenceLevel
from aiq_agent.agents.shallow_researcher.markers import detect_and_strip_confidence_marker
from aiq_agent.agents.shallow_researcher.markers import detect_and_strip_escalation_marker
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.common import get_latest_user_query
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.job_admission import JobAdmissionError
from aiq_agent.common.profiler import profiled_node

try:
    from aiq_api.auth.errors import AuthError as _AuthError
except ImportError:
    _AuthError = None  # type: ignore[assignment,misc]

from .models import ChatResearcherState
from .models import ShallowResult
from .utils import trim_message_history

logger = logging.getLogger(__name__)


def surface_answer_confidence(
    self_reported: ConfidenceLevel | None,
    citation_grounded: bool,
    quotes_verified: bool = True,
) -> ConfidenceLevel | None:
    """Apply the deterministic overconfidence guard to a self-reported level.

    Returns ``None`` when there is no self-assessment to surface. Otherwise caps
    the surfaced value at "low" whenever the answer is not grounded in a verified
    citation (empty registry or verification removed every citation) OR carries a
    quoted span that could not be verified against a retrieved passage
    (``quotes_verified`` is False — the weak model's "real section, fabricated
    quote" pattern). A self-reported "high"/"medium" in either case is
    untrustworthy and becomes "low"; a fully grounded answer with all quotes
    verified surfaces the model's own level verbatim.
    """
    if self_reported is None:
        return None
    if not citation_grounded or not quotes_verified:
        return "low"
    return self_reported


# Fixed reason for the keyword-fallback escalation path, where no structured
# ``ShallowResult.escalation_reason`` exists (the shallow answer read as
# insufficient by tail-keyword match).
ESCALATION_KEYWORD_REASON = "Die erste Antwort enthielt einen Hinweis auf unzureichende Informationen."


def answer_confidence_capped_reason(
    self_reported: ConfidenceLevel | None,
    citation_grounded: bool,
    quotes_verified: bool = True,
) -> Literal["ungrounded", "quote_unverified"] | None:
    """Why the surfaced confidence was capped, or ``None`` when no cap applied.

    Returns a reason only when a real downgrade happened: a self-reported
    "medium"/"high" that got capped to "low". ``"ungrounded"`` when the answer is
    not grounded in a verified citation (the more fundamental failure, so it wins
    when both apply); ``"quote_unverified"`` when the answer is grounded but
    carries a quoted span not verifiable against a retrieved passage. A missing
    self-report, an already-"low" self-report, or a fully-verified grounded
    answer is not a downgrade and yields ``None``.
    """
    if self_reported is None or self_reported == "low":
        return None
    if not citation_grounded:
        return "ungrounded"
    if not quotes_verified:
        return "quote_unverified"
    return None


def derive_routing_decision(
    user_intent: Any,
    depth_decision: Any,
) -> Literal["meta", "shallow", "deep", "error"] | None:
    """Which path the turn took after intent classification.

    Mirrors ``route_after_orchestration``/``should_escalate`` framing: error and
    meta intents win over depth; a research turn is "deep" only when the depth
    classifier said so, otherwise "shallow". Returns ``None`` when no
    classification ran (nothing to surface).
    """
    intent = getattr(user_intent, "intent", None)
    if intent == "error":
        return "error"
    if intent == "meta":
        return "meta"
    if intent is None:
        return None
    if getattr(depth_decision, "decision", None) == "deep":
        return "deep"
    return "shallow"


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


def _finalize_shallow_answer(
    message: BaseMessage,
    citation_grounded: bool,
    *,
    quotes_verified: bool = True,
    escalation_present: bool | None = None,
    self_reported: ConfidenceLevel | None = None,
    verified_sources: list[dict[str, Any]] | None = None,
    citations_removed: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the node update for a successful/insufficient shallow answer.

    The shallow agent now extracts and strips BOTH control markers inside its
    own ``run()`` and returns the signals as structured state fields. When those
    signals are provided here (``escalation_present`` is not ``None``) they are
    authoritative; the answer text is still stripped defensively in case a
    different message than the one ``run()`` cleaned reached this node. When they
    are absent (``escalation_present is None`` — e.g. a caller that predates the
    structured carrier), we FALL BACK to detecting the markers from the message
    text, preserving the original behavior.

    Routing:

    - Escalation marker present → escalate to deep research (``shallow_result``
      with ``escalate_to_deep=True``) and surface NO confidence chip. The deep
      research report supersedes this shallow answer.
    - Otherwise → a normal success turn (``shallow_result=None``); the parsed
      confidence level is passed through the overconfidence guard and carried on
      ``answer_confidence`` (None when the marker was absent/malformed).

    Non-string content is passed through untouched with no confidence signal.
    """
    content = message.content
    if not isinstance(content, str):
        return {"messages": [message], "shallow_result": None}

    if escalation_present is None:
        # Fallback: no structured signals — detect both markers from the text.
        without_escalation, escalation_present = detect_and_strip_escalation_marker(content)
        clean_content, self_reported = detect_and_strip_confidence_marker(without_escalation)
    else:
        # Structured signals are authoritative for routing; strip defensively so
        # no marker can leak even if this message still carries one.
        without_escalation, _ = detect_and_strip_escalation_marker(content)
        clean_content, _ = detect_and_strip_confidence_marker(without_escalation)

    updated_message = message.model_copy(update={"content": clean_content}) if clean_content != content else message

    if escalation_present:
        return {
            "messages": [updated_message],
            "shallow_result": ShallowResult(
                answer=clean_content,
                confidence="low",
                escalate_to_deep=True,
                escalation_reason="Shallow agent emitted insufficiency marker",
            ),
            # Escalation supersedes the shallow answer → surface no self-assessment.
            "answer_confidence": None,
            "verified_sources": verified_sources,
        }

    return {
        "messages": [updated_message],
        "shallow_result": None,
        "answer_confidence": surface_answer_confidence(self_reported, citation_grounded, quotes_verified),
        "answer_confidence_capped_reason": answer_confidence_capped_reason(
            self_reported, citation_grounded, quotes_verified
        ),
        "verified_sources": verified_sources,
        "citations_removed": citations_removed,
    }


def matches_escalation_keywords(content: str) -> bool:
    """Return True if the tail of an answer signals insufficient information.

    Verbatim lift of the keyword tail-match logic historically embedded in
    ``should_escalate``: only the last 800 characters (lowercased) are examined.
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


class ChatResearcherAgent:
    """
    Orchestrates the full chat research workflow.

    Coordinates intent classification, depth routing, and research agents
    to produce research results based on user queries.

    The workflow:
    1. Classify intent (meta vs research)
    2. If meta → respond with meta chatter
    3. If research → route to shallow or deep based on complexity
    4. Optionally escalate from shallow to deep if results insufficient
    """

    def __init__(
        self,
        intent_classifier_fn: Callable[[str], Awaitable[str]],
        shallow_research_fn: Callable[[str], Awaitable[str]],
        deep_research_fn: Callable[[str], Awaitable[str]],
        clarifier_fn: Callable[
            [ClarifierAgentState | list[BaseMessage]],
            Awaitable[ClarifierResult],
        ]
        | None,
        *,
        enable_clarifier: bool = True,
        enable_escalation: bool = True,
        callbacks: list[BaseCallbackHandler] | None = None,
        max_history: int = 5,
        deep_research_job_submitter: Callable[[Any], Awaitable[str]] | None = None,
        checkpointer: BaseCheckpointSaver | None = None,
        validate_deep_research_tools_fn: Callable[[list[str] | None], tuple[bool, str]] | None = None,
    ) -> None:
        """
        Initialize the chat researcher agent.

        Args:
            intent_classifier_fn: Combined orchestration (intent + meta response + depth in one node)
            shallow_research_fn: Function for shallow research
            deep_research_fn: Function for deep research
            clarifier_fn: Function for clarification
            enable_clarifier: Whether to enable clarification
            enable_escalation: Whether to escalate shallow to deep on low confidence
            callbacks: Optional list of callback handlers
            max_history: Maximum number of messages to keep in history
            deep_research_job_submitter: Optional function to submit deep research as async job
            checkpointer: Optional checkpointer for persistent state (defaults to MemorySaver)

        Cards are emitted by the answering agent via the ``emit_card`` tool, not
        generated here — this class no longer needs a card LLM.
        """
        self.intent_classifier_fn = intent_classifier_fn
        self.shallow_research_fn = shallow_research_fn
        self.deep_research_fn = deep_research_fn
        self.clarifier_fn = clarifier_fn
        self.enable_clarifier = enable_clarifier
        self.enable_escalation = enable_escalation
        self.callbacks = callbacks or []
        self.max_history = max_history
        self.deep_research_job_submitter = deep_research_job_submitter
        self.checkpointer = checkpointer
        self.validate_deep_research_tools_fn = validate_deep_research_tools_fn

        self._graph = self._build_graph()

    def _escalation_reason_for(self, state: ChatResearcherState) -> str | None:
        """Reason a shallow answer escalated to deep research, or ``None``.

        The clarifier node sits on BOTH the direct-deep route and the
        shallow→deep escalation route, so it computes this once. A reason is
        returned only on an escalation entry (a shallow answer preceded this
        node): the structured ``ShallowResult.escalation_reason`` when present,
        otherwise the fixed keyword-fallback notice. A direct-deep entry (no
        shallow answer, escalation disabled, or a meta turn) yields ``None`` so
        the field stays absent. Mirrors ``should_escalate``'s branches.
        """
        if not self.enable_escalation:
            return None
        if state.user_intent and state.user_intent.intent == "meta":
            return None
        if state.shallow_result is not None:
            if state.shallow_result.escalate_to_deep:
                return state.shallow_result.escalation_reason
            return None
        last_ai_content = None
        for m in reversed(state.messages):
            if isinstance(m, AIMessage):
                last_ai_content = m.content if hasattr(m, "content") else str(m)
                break
        if not last_ai_content:
            return None
        last_content = last_ai_content if isinstance(last_ai_content, str) else str(last_ai_content)
        if matches_escalation_keywords(last_content):
            return ESCALATION_KEYWORD_REASON
        return None

    def _build_graph(self) -> CompiledStateGraph:
        """Build the LangGraph workflow."""

        async def intent_classifier_node(state: ChatResearcherState) -> dict[str, Any]:
            return await self.intent_classifier_fn(state)

        async def clarifier_node(state: ChatResearcherState) -> dict[str, Any]:
            original_query = get_latest_user_query(state.messages)
            # Present only on a shallow→deep escalation entry (absent on direct
            # deep). Carried to the terminal state so the frontend can narrate why.
            escalation_reason = self._escalation_reason_for(state)

            # Validate deep research tools before proceeding to clarifier
            if self.validate_deep_research_tools_fn:
                is_valid, error_msg = self.validate_deep_research_tools_fn(state.data_sources)
                if not is_valid:
                    logger.error("Deep research tools validation failed: %s", error_msg)
                    return Command(
                        goto=END,
                        update={
                            "messages": [AIMessage(content=error_msg)],
                            "original_query": original_query,
                        },
                    )

            if self.enable_clarifier and not state.skip_clarifier:
                if self.clarifier_fn is None:
                    raise ValueError(
                        "enable_clarifier is True but clarifier_agent is not defined in config. "
                        "Either add clarifier_agent to functions or set enable_clarifier: false."
                    )
                trimmed_messages: list[BaseMessage] = trim_message_history(state.messages, self.max_history)
                available_docs = [doc.model_dump() for doc in (state.available_documents or [])]
                clarifier_state = ClarifierAgentState(
                    messages=trimmed_messages,
                    data_sources=state.data_sources,
                    available_documents=available_docs if available_docs else None,
                    project_context=state.project_context,
                )
                result = await self.clarifier_fn(clarifier_state)

                # Check if plan was rejected
                if result.plan_rejected:
                    logger.info("ChatResearcher: Plan rejected by user, ending workflow")
                    return Command(
                        goto=END,
                        update={
                            "messages": [
                                AIMessage(
                                    content="Research plan was rejected. Please start a new research query when ready."
                                )
                            ],
                            "original_query": original_query,
                        },
                    )

                # Build clarifier result with optional approved plan context
                clarifier_result = result.clarifier_log
                approved_plan_context = result.get_approved_plan_context()
                if approved_plan_context:
                    clarifier_result = f"{clarifier_result}\n\n{approved_plan_context}"

                return Command(
                    goto="deep_research",
                    update={
                        "clarifier_result": clarifier_result,
                        "original_query": original_query,
                        "escalation_reason": escalation_reason,
                    },
                )
            return Command(
                goto="deep_research",
                update={"original_query": original_query, "escalation_reason": escalation_reason},
            )

        async def shallow_research_node(state: ChatResearcherState) -> dict[str, Any]:
            trimmed_messages: list[BaseMessage] = trim_message_history(state.messages, self.max_history)

            logger.debug(
                "shallow_research_node: ChatResearcherState.available_documents = %s",
                state.available_documents,
            )

            # Meta/conversational turns are routed through the shallow agent for
            # persona + the `remember` tool, but they answer from context without
            # calling research tools — so they capture no sources and must NOT be
            # held to the research-only "sources required" guard. Everything else
            # (research) keeps the strict contract.
            requires_sources = not (state.user_intent is not None and state.user_intent.intent == "meta")

            try:
                shallow_state = ShallowResearchAgentState(
                    messages=trimmed_messages,
                    data_sources=state.data_sources,
                    user_info=state.user_info,
                    available_documents=state.available_documents,
                    project_context=state.project_context,
                    requires_sources=requires_sources,
                )
                result = await self.shallow_research_fn(shallow_state)
            except EmptySourceRegistryError as exc:
                logger.warning("Shallow research produced no verifiable sources")
                if exc.unavailable_tools:
                    from aiq_agent.common.tool_validation import format_user_facing_tool_error

                    err_msg = format_user_facing_tool_error(
                        "shallow research",
                        exc.unavailable_tools,
                        exc.available_count,
                    )
                else:
                    # This error only fires when a data-source tool was actually
                    # queried and yielded nothing citable — the message must not
                    # blame the search tools for unrelated failures (it used to
                    # surface for turns where no tool was ever called).
                    err_msg = (
                        "I searched the available sources but couldn't retrieve anything usable "
                        "to ground an answer to this question. This may be a temporary issue — "
                        "please try again, or rephrase the question."
                    )
                # confidence="high" reflects certainty that an error occurred and that the error
                # message is the correct response — not uncertainty about the answer quality.
                # escalate_to_deep=False because retrying deep research will not resolve a
                # source registry or transient failure; the user should rephrase and retry.
                return {
                    "messages": [AIMessage(content=err_msg)],
                    "shallow_result": ShallowResult(
                        answer=err_msg,
                        confidence="high",
                        escalate_to_deep=False,
                    ),
                }
            except Exception as e:
                if _AuthError and isinstance(e, _AuthError):
                    logger.warning("Auth error in shallow research: %s", e)
                    err_msg = str(e)
                    return {
                        "messages": [AIMessage(content=err_msg)],
                        "shallow_result": ShallowResult(
                            answer=err_msg,
                            confidence="high",
                            escalate_to_deep=False,
                        ),
                    }
                logger.exception("Error in shallow research: %s", e)
                err_msg = "An error occurred while researching your question. Please try again."
                # Same rationale as EmptySourceRegistryError: the system is certain an error
                # occurred; escalating to deep research will not resolve an unexpected exception.
                return {
                    "messages": [AIMessage(content=err_msg)],
                    "shallow_result": ShallowResult(
                        answer=err_msg,
                        confidence="high",
                        escalate_to_deep=False,
                    ),
                }

            if not result.messages:
                logger.error("Shallow research agent returned no messages")
                return {
                    "shallow_result": ShallowResult(
                        answer="An error occurred during shallow research.",
                        confidence="low",
                        escalate_to_deep=True,
                        escalation_reason="Shallow research encountered an error",
                    )
                }
            new_messages = result.messages[len(trimmed_messages) :]
            final_ai_message = next(
                (m for m in reversed(new_messages) if isinstance(m, AIMessage) and not m.tool_calls),
                None,
            )
            # Whether the shallow answer ended up grounded in a verified citation
            # (drives the overconfidence guard below). Absent field → conservative
            # False, so an ungrounded self-report is capped to "low".
            citation_grounded = bool(getattr(result, "answer_citation_grounded", False))
            # Whether every quoted span in the shallow answer was verified against
            # a retrieved passage (drives the same overconfidence guard). Absent
            # field → fail-open True, so an older caller never spuriously caps.
            quotes_verified = bool(getattr(result, "answer_quotes_verified", True))

            # Prefer the structured control-marker signals the shallow agent
            # extracted in its run(); fall back to string-detection inside
            # _finalize_shallow_answer when they are absent (older callers). The
            # shallow agent leaves ``escalation_requested`` None until extraction
            # actually ran on a real answer message — None is the sentinel for
            # "not extracted", so a bool (True/False) means trust these fields.
            raw_escalation = getattr(result, "escalation_requested", None)
            if raw_escalation is not None:
                escalation_present: bool | None = bool(raw_escalation)
                self_reported = getattr(result, "answer_confidence_marker", None)
            else:
                escalation_present = None
                self_reported = None

            verified_sources = getattr(result, "verified_sources", None)
            if not isinstance(verified_sources, list):
                verified_sources = None

            citations_removed = _normalize_citations_removed(getattr(result, "citations_removed", None))

            if final_ai_message:
                return _finalize_shallow_answer(
                    final_ai_message,
                    citation_grounded,
                    quotes_verified=quotes_verified,
                    escalation_present=escalation_present,
                    self_reported=self_reported,
                    verified_sources=verified_sources,
                    citations_removed=citations_removed,
                )
            if new_messages:
                return _finalize_shallow_answer(
                    new_messages[-1],
                    citation_grounded,
                    quotes_verified=quotes_verified,
                    escalation_present=escalation_present,
                    self_reported=self_reported,
                    verified_sources=verified_sources,
                    citations_removed=citations_removed,
                )
            return {"messages": [], "shallow_result": None}

        async def deep_research_node(state: ChatResearcherState) -> dict[str, Any]:
            trimmed_messages: list[BaseMessage] = trim_message_history(state.messages, self.max_history)
            if self.deep_research_job_submitter is not None:
                try:
                    job_id = await self.deep_research_job_submitter(state)
                except JobAdmissionError as exc:
                    # Admission control refused the submission (queue full);
                    # answer with the friendly reason instead of crashing the turn.
                    # Mark it as a queue-rejection notice (not a research answer)
                    # and forward the retry hint so the frontend can back off.
                    logger.info("Deep research submission refused by admission control: %s", exc)
                    return {
                        "messages": [AIMessage(content=str(exc))],
                        "job_admission_rejected": True,
                        "retry_after_seconds": exc.retry_after_seconds,
                    }
                response = f"Deep research job submitted. Job ID: {job_id}"
                # Emit the job id as a structured channel value so the frontend
                # can open the research panel without regex-parsing this prose.
                return {"messages": [AIMessage(content=response)], "deep_research_job_id": job_id}

            research_query = state.original_query or get_latest_user_query(state.messages)
            deep_state = DeepResearchAgentState(
                messages=trimmed_messages + [HumanMessage(content=research_query)],
                data_sources=state.data_sources,
                clarifier_result=state.clarifier_result,
                available_documents=state.available_documents,
                user_info=state.user_info,
                project_context=state.project_context,
            )
            try:
                result = await self.deep_research_fn(deep_state)
            except EmptySourceRegistryError as exc:
                logger.warning("Deep research produced no verifiable sources")
                if exc.unavailable_tools:
                    from aiq_agent.common.tool_validation import format_user_facing_tool_error

                    err_msg = format_user_facing_tool_error(
                        "deep research",
                        exc.unavailable_tools,
                        exc.available_count,
                    )
                else:
                    err_msg = (
                        "I searched the available sources but couldn't retrieve anything usable "
                        "to ground an answer to this question. This may be a temporary issue — "
                        "please try again, or rephrase the question."
                    )
                return {"messages": [AIMessage(content=err_msg)]}
            except Exception as e:
                if _AuthError and isinstance(e, _AuthError):
                    logger.warning("Auth error in deep research: %s", e)
                    return {"messages": [AIMessage(content=str(e))]}
                raise
            if not result.messages:
                error_message = "An error occurred during deep research."
                logger.error(error_message)
                final_message = AIMessage(content=error_message)
                return {"messages": [final_message]}
            else:
                citations_removed = _normalize_citations_removed(getattr(result, "citations_removed", None))
                quotes_unverified = _normalize_citations_removed(getattr(result, "quotes_unverified", None))
                update: dict[str, Any] = {"messages": [result.messages[-1]]}
                if citations_removed is not None:
                    update["citations_removed"] = citations_removed
                if quotes_unverified is not None:
                    update["quotes_unverified"] = quotes_unverified
                return update

        def route_after_orchestration(state: ChatResearcherState) -> str:
            """Route by classification: error -> END (canned message already in
            messages), deep research -> clarifier, everything else (research
            shallow AND meta/conversational turns) -> shallow agent, which owns
            the persona and the `remember` tool."""
            if state.user_intent and state.user_intent.intent == "error":
                return "END"
            # Meta/conversational turns (greetings, capability questions AND
            # memory/`remember` requests) are owned by the shallow agent and must
            # never escalate to deep research — even when the depth classifier
            # says "deep". Checking intent before depth mirrors the meta guard in
            # should_escalate(); without it a "remember X for the whole org"
            # request classified meta+deep is misrouted into a deep-research job
            # that lacks the `remember` tool and hallucinates a filesystem write.
            if state.user_intent and state.user_intent.intent == "meta":
                return "shallow_research"
            if state.depth_decision and state.depth_decision.decision == "deep":
                return "clarifier"
            return "shallow_research"

        def should_escalate(state: ChatResearcherState) -> str:
            if not self.enable_escalation:
                return "END"

            # Conversational (meta) turns are answered by the shallow agent but
            # must never escalate: the keyword tail-match below could otherwise
            # misread chit-chat ("I don't have enough information about you...")
            # as a failed research attempt and launch deep research.
            if state.user_intent and state.user_intent.intent == "meta":
                return "END"

            # Respect explicit escalation decision from shallow research.
            # Successful shallow paths set shallow_result=None so this guard
            # only fires when shallow explicitly set escalate_to_deep.
            if state.shallow_result is not None:
                if state.shallow_result.escalate_to_deep:
                    return "deep_research"
                return "END"

            messages = state.messages
            if not messages:
                return "END"

            last_ai_content = None
            for m in reversed(messages):
                if isinstance(m, AIMessage):
                    last_ai_content = m.content if hasattr(m, "content") else str(m)
                    break
            if not last_ai_content:
                return "END"

            last_content = last_ai_content if isinstance(last_ai_content, str) else str(last_ai_content)
            if not last_content.strip():
                return "deep_research"

            if matches_escalation_keywords(last_content):
                return "deep_research"

            return "END"

        graph = StateGraph(ChatResearcherState)

        graph.add_node("intent_classifier", profiled_node("intent_classifier", intent_classifier_node))
        graph.add_node("shallow_research", profiled_node("shallow_research", shallow_research_node))
        graph.add_node("clarifier", profiled_node("clarifier", clarifier_node))
        graph.add_node("deep_research", profiled_node("deep_research", deep_research_node))

        graph.set_entry_point("intent_classifier")

        graph.add_conditional_edges(
            "intent_classifier",
            route_after_orchestration,
            {
                "END": END,
                "clarifier": "clarifier",
                "shallow_research": "shallow_research",
            },
        )

        graph.add_conditional_edges(
            "shallow_research",
            should_escalate,
            {
                "deep_research": "clarifier",
                "END": END,
            },
        )

        graph.add_edge("deep_research", END)

        return graph.compile(checkpointer=self.checkpointer)

    async def run(
        self, state: ChatResearcherState | dict[str, Any], thread_id: str | None = None
    ) -> ChatResearcherState:
        """
        Execute the chat researcher workflow.

        Args:
            state: ChatResearcherState or dict with new messages to add.
            thread_id: Thread ID for the conversation (used for checkpointing).
        Returns:
            Updated state with response in messages.
        """
        graph_config: RunnableConfig = {"configurable": {"thread_id": thread_id}}
        logger.info("ChatResearcherAgent: Starting workflow")

        if isinstance(state, dict):
            input_state = state
            messages = state.get("messages", [])
        else:
            input_state = {
                "messages": state.messages,
                "user_info": state.user_info,
                "data_sources": state.data_sources,
                "available_documents": state.available_documents,
                "collection_scope": state.collection_scope,
                "shallow_result": None,  # reset at turn boundary to avoid stale checkpoint state
                # Reset like shallow_result: a persisted job id from a previous
                # deep-research turn would otherwise be read as this turn's job.
                "deep_research_job_id": None,
                # Reset likewise: a stale self-assessment from a prior shallow
                # turn must not leak onto this turn's answer.
                "answer_confidence": None,
                # Reset the transparency extras (WP-A) at the turn boundary too,
                # so a prior turn's routing/escalation/citation signals never leak
                # onto this turn via the persisted checkpoint.
                "routing_decision": None,
                "routing_reason": None,
                "escalation_reason": None,
                "answer_confidence_capped_reason": None,
                "citations_removed": None,
                "quotes_unverified": None,
                "job_admission_rejected": None,
                "retry_after_seconds": None,
                # Reset likewise: the clarifier skip path never overwrites this,
                # so turn 1's clarification log would otherwise steer turn 2's
                # deep research toward stale constraints.
                "clarifier_result": None,
                "skip_clarifier": state.skip_clarifier,
                "project_context": state.project_context,
            }
            messages = state.messages

        if messages:
            query = messages[-1].content
            logger.info("Query: %s...", str(query)[:100] if query else "")
        result = await self._graph.ainvoke(input_state, config=graph_config)

        # Cards are emitted by the answering agent through the `emit_card` tool
        # into the conversation-scoped CardRegistry and read by the chat
        # entrypoint after this returns — no post-hoc card-generation call here.
        logger.info("ChatResearcherAgent: Workflow complete")

        return result

    @property
    def graph(self) -> CompiledStateGraph:
        """Get the compiled LangGraph for direct access."""
        return self._graph

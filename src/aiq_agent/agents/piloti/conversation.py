"""The conversation graph: one answering agent, escalation as its own edge.

Every turn enters Piloti with its full tool set. That agent decides,
per turn and in the answer envelope, what the turn is: a direct reply (no
source consulted, no self-assessment), a researched answer (sources retrieved,
cited, graded), or a hand-off to deep research (``escalate_to_deep`` with a
reason). There is no classifier in front of it (ADR-0052): a label decided
before the answer could only ever withhold capabilities the answer turned out
to need, and the classes it produced — "meta", "listing", "out of scope" — are
all shapes the answering model can choose itself.

So this module adds exactly two things to :class:`PilotiAgent`: the
escalation edge (clarifier, then deep research, unless the reader has already
declined a plan), and the conversation-scoped state the checkpointer persists
between turns — the message history and that sticky refusal. Everything else a
turn carries out is a field of Piloti's own finished state, lifted by
:data:`ANSWER_LIFTS` rather than recomputed here.
"""

import logging
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Sequence
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
from aiq_agent.common.canned_replies import GENERIC_ERROR_MESSAGE
from aiq_agent.common.canned_replies import NO_SOURCES_MESSAGE
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.job_admission import JobAdmissionError
from aiq_agent.common.plan_documents import PlanDocuments
from aiq_agent.common.platform_lessons import render_lessons_block
from aiq_agent.common.profiler import profiled_node
from aiq_agent.common.research_plan import PlanStart
from aiq_agent.common.research_plan import ResearchPlanDraft
from aiq_agent.common.research_plan import render_plan_context
from aiq_agent.common.tool_validation import format_user_facing_tool_error
from aiq_agent.common.turn_status import emit_escalation
from aiq_agent.knowledge.inventory import set_listing_shelf
from aiq_agent.knowledge.inventory import shelf_hint_from_query
from aiq_agent.turn.api_seam import AuthError
from aiq_agent.turn.commission import CommissionedRun
from aiq_agent.turn.commission import CommissionRefused

from .clarify import ClarifyFn
from .history import compact_tool_results
from .history import prune_tool_results
from .history import trim_message_history
from .markers import detect_and_strip_confidence_marker
from .markers import detect_and_strip_escalation_marker
from .models import ClarifyRequest
from .models import ConversationState
from .models import ResearchAgentState

logger = logging.getLogger(__name__)

# Reader-facing text, and therefore left verbatim by the rename: it is what
# `escalation_reason` carries onto the wire when the model asked to escalate
# without saying why, so it is already stored in turns from before this commit.
# Changing the wording is a copy change with a release note, not a rename.
LEGACY_ESCALATION_REASON = "Shallow agent emitted insufficiency marker"

DEEP_RESEARCH_UNAVAILABLE_NOTE = (
    "Hinweis: Eine Tiefenrecherche steht in diesem Arbeitsbereich derzeit nicht zur Verfügung. "
    "Ich habe die Frage direkt beantwortet, so weit die vorliegenden Quellen tragen. "
    "Grenzen Sie die Frage gern enger ein, dann komme ich näher heran."
)
"""Appended when Piloti asks to escalate and the tenant has no deep research.

German because the product is German-first and it reaches the reader
verbatim. It exists because the ask and the ANSWER are one message. A
turn that asks to escalate writes either a partial answer (the insufficiency
case) or a single sentence naming what it will research (the commissioned
case), and suppressing the route silently would leave the second one as a
promise nothing keeps. The prompt already tells the model the capability is
absent, so this is the line for the turn where it asked anyway — not the
normal path.
"""

#: State fields that survive the turn boundary. Everything else is reset on
#: every ``run()`` so nothing from a previous turn's checkpoint — a stale job
#: id, a prior self-assessment, last turn's routing — can leak onto this one.
#: ``deep_research_declined`` is STICKY for the conversation on purpose: a
#: conversation whose reader declined a plan (before ADR-0068 made the plan a
#: row the reader stops from the run block) keeps that answer.
CONVERSATION_SCOPED_FIELDS: frozenset[str] = frozenset({"messages", "deep_research_declined", "already_read_digest"})
TURN_SCOPED_FIELDS: frozenset[str] = frozenset(ConversationState.model_fields) - CONVERSATION_SCOPED_FIELDS

#: ``(Piloti state attribute, conversation state field)``: what a finished
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
    ("read_sources", "read_sources"),
    ("already_read_digest", "already_read_digest"),
    ("citations_removed", "citations_removed"),
    ("skills_activated", "skills_activated"),
    ("skills_hidden", "skills_hidden"),
    ("answer_meta", "answer_meta"),
    ("retrieval_ledger", "retrieval_ledger"),
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
        # The turn still read: the deep report replaces the answer, not the
        # digest the next turn re-opens from. Absent (never nulled) when the
        # turn digested nothing, so a mocked result without the field cannot
        # wipe the checkpointed lines either.
        **({"already_read_digest": list(result.already_read_digest)} if result.already_read_digest else {}),
    }


def _answer_update(
    message: BaseMessage, result: ResearchAgentState, turn_messages: Sequence[BaseMessage] = ()
) -> dict[str, Any]:
    """A finished answer with everything Piloti decided about it.

    The WHOLE turn is written back — the tool calls, their results, then the
    answer — not the answer alone: the passages this answer was written from
    are the context the next turn's follow-up needs, and re-fetching what the
    transcript just held was the round every follow-up paid. The results are
    cut to the passages the answer CITED (``history.compact_tool_results``);
    an uncited passage keeps its header so the next turn knows it exists.
    Older turns are pruned to what was said when the next turn's history is
    built (``history.prune_tool_results``), so the budget holds answers, plus
    one turn of cited evidence.
    """
    update: dict[str, Any] = {field: getattr(result, source) for source, field in ANSWER_LIFTS}
    cited = {
        str(source.get("citation_key"))
        for source in (result.verified_sources or [])
        if isinstance(source, dict) and source.get("citation_key")
    }
    kept = compact_tool_results([m for m in turn_messages if m is not message], cited)
    update["messages"] = [*kept, message]
    update["escalate_to_deep"] = False
    # Presence is the fact: True or absent, never False.
    update["research_truncated"] = True if result.research_truncated else None
    return update


def _stripped(content: str) -> str:
    """The answer text with any control marker removed.

    Piloti's own pipeline already strips these; this is the defensive
    second pass, so no marker can reach a reader even if a message other than
    the one that pipeline cleaned ends up being the answer.
    """
    without_escalation, _ = detect_and_strip_escalation_marker(content)
    clean, _, _ = detect_and_strip_confidence_marker(without_escalation)
    return clean


def _finalize_answer(
    message: BaseMessage,
    result: ResearchAgentState,
    *,
    deep_research_allowed: bool = True,
    turn_messages: Sequence[BaseMessage] = (),
) -> dict[str, Any]:
    """The node update for a finished research turn, from its answer message and
    the structured signals Piloti extracted in its own ``run()``.

    Those signals are authoritative; non-string content passes through
    untouched with no signal at all.

    ``deep_research_allowed=False`` turns an ask into a plain answer here, at
    the point where the two updates diverge, rather than at the routing edge.
    The edge is too late: by then ``_escalation_update`` has already dropped
    everything the answer knew about itself and replaced the message with the
    ask, so suppressing the route there ends the turn on a promise instead of
    an answer.
    """
    content = message.content
    if not isinstance(content, str):
        return {"messages": [message]}
    clean_content = _stripped(content)
    escalating = bool(result.escalation_requested)
    if escalating and not deep_research_allowed:
        logger.info("Escalation refused: deep research is not enabled for this tenant")
        escalating = False
        # The ask and the answer are the same message, and the envelope says
        # which of the two shapes this one is. A `handoff` answer is one
        # sentence naming what will be researched — appending the note to it
        # would ship „Dafür starte ich eine Tiefenrecherche" and the
        # contradiction underneath, so it is REPLACED. An insufficiency
        # escalation carries the model's best partial answer, which the reader
        # should keep, so there the note is appended.
        #
        # The envelope's own word, never the prose: the two shapes are not
        # distinguishable by matching on text, and a matcher would decide a
        # reader's answer by regex.
        handoff_only = result.answer_is_handoff or not clean_content.strip()
        clean_content = (
            DEEP_RESEARCH_UNAVAILABLE_NOTE
            if handoff_only
            else f"{clean_content.rstrip()}\n\n{DEEP_RESEARCH_UNAVAILABLE_NOTE}"
        )
    if not clean_content.strip() and not escalating:
        # An empty answer is a generation failure, not an escalation signal.
        logger.error("Research produced an empty answer")
        return _error_update(GENERIC_ERROR_MESSAGE)
    updated = message.model_copy(update={"content": clean_content}) if clean_content != content else message
    if escalating:
        return _escalation_update(updated, result)
    return _answer_update(updated, result, [m for m in turn_messages if m is not message])


def _answer_only(text: str) -> dict[str, Any]:
    """A turn that ends with one sentence and no research behind it.

    ``routing_decision`` is "meta" rather than "error": nothing failed, the
    capability is simply absent, and an error turn would invite the reader to
    retry something that cannot succeed.
    """
    return {
        "messages": [AIMessage(content=text)],
        "routing_decision": "meta",
        "escalate_to_deep": False,
    }


def _answer_message(new_messages: list[BaseMessage]) -> BaseMessage | None:
    """The answer among the messages Piloti added: the last AIMessage
    that is not a tool call, else whatever came last."""
    final = next((m for m in reversed(new_messages) if isinstance(m, AIMessage) and not m.tool_calls), None)
    if final is not None:
        return final
    return new_messages[-1] if new_messages else None


def _deep_handoff(
    original_query: str | None,
    escalation_reason: str | None,
    clarifier_result: str | None = None,
    *,
    plan_documents: PlanDocuments | None = None,
    plan_draft: ResearchPlanDraft | None = None,
    plan_start: PlanStart | None = None,
) -> Command:
    update: dict[str, Any] = {
        "original_query": original_query,
        "escalation_reason": escalation_reason,
        "routing_decision": "deep",
    }
    if clarifier_result is not None:
        update["clarifier_result"] = clarifier_result
    if plan_documents is not None:
        update["plan_documents"] = plan_documents
    # The drafted plan (ADR-0068): the commissioner posts it as the plan the
    # run waits on; the inline path renders it and runs at once.
    if plan_draft is not None:
        update["plan_draft"] = plan_draft
        update["plan_start"] = plan_start
    return Command(goto="deep_research", update=update)


def _inline_plan_context(state: ConversationState) -> str | None:
    """What the deep researcher reads when it runs in process: the Q&A and the plan.

    There is no worker to wait on a plan here, so the drafted plan runs as
    drafted. A deployment without a worker has no run block to edit it on.
    """
    draft = state.plan_draft
    if draft is None:
        return state.clarifier_result
    plan_text = render_plan_context(
        title=draft.title or draft.question,
        genre=draft.genre,
        depth=draft.depth,
        sections=list(draft.sections),
        documents=state.plan_documents,
    )
    return f"{state.clarifier_result}\n\n{plan_text}" if state.clarifier_result else plan_text


class ConversationGraph:
    """One conversation with Piloti, across turns.

    1. Piloti answers, with every tool it has.
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
        max_history_tokens: int = 40000,
        commission_run_fn: Callable[[ConversationState], Awaitable[CommissionedRun]] | None = None,
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
        self.commission_run_fn = commission_run_fn
        self.checkpointer = checkpointer
        self.validate_deep_research_tools_fn = validate_deep_research_tools_fn
        self._graph = self._build_graph()

    def _trimmed(self, state: ConversationState) -> list[BaseMessage]:
        # The previous turn's tool results stay (a follow-up answers from
        # them); older turns keep what was said. Then the token budget.
        return trim_message_history(prune_tool_results(state.messages), self.max_history_tokens)

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
        # No verdict to wait for: the plan, when there is one, is shown on the
        # run block and the run waits on it there (ADR-0068).
        return _deep_handoff(
            original_query,
            escalation_reason,
            result.research_context,
            plan_documents=result.documents,
            plan_draft=result.draft,
            plan_start=result.start,
        )

    def _research_input(self, state: ConversationState, trimmed: list[BaseMessage]) -> ResearchAgentState:
        return ResearchAgentState(
            messages=trimmed,
            data_sources=state.data_sources,
            user_info=state.user_info,
            available_documents=state.available_documents,
            in_flight_documents=state.in_flight_documents,
            already_read_digest=list(state.already_read_digest) if state.already_read_digest else None,
            project_context=state.project_context,
            platform_lessons=state.platform_lessons,
            org_instructions=state.org_instructions,
            focus_file_name=state.focus_file_name,
            focus_shelf=state.focus_shelf,
            # Told to the model so it writes an answer instead of a hand-off
            # sentence. `_finalize_answer` still refuses the escalation if it
            # asks anyway: the prompt is the fix, this is the layer that holds
            # when the model does not read it.
            deep_research_allowed=state.deep_research_allowed,
            tasks_allowed=state.tasks_allowed,
        )

    async def _run_research(self, research_state: ResearchAgentState) -> ResearchAgentState | dict[str, Any]:
        """Piloti's result, or the error update for a failed call."""
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
            logger.error("Piloti returned no messages")
            return _error_update(GENERIC_ERROR_MESSAGE)
        new_messages = result.messages[len(trimmed) :]
        message = _answer_message(new_messages)
        if message is None:
            return {"messages": []}
        update = _finalize_answer(
            message, result, deep_research_allowed=state.deep_research_allowed, turn_messages=new_messages
        )
        if isinstance(result, ResearchAgentState) and not update.get("already_read_digest"):
            # A result that carries no digest (a mocked research_fn, an older
            # caller) must not wipe the checkpointed lines: the digest only
            # ever grows within a conversation, it is never cleared by a turn.
            if state.already_read_digest:
                update["already_read_digest"] = list(state.already_read_digest)
        return update

    async def _commission_run(self, state: ConversationState) -> dict[str, Any]:
        """Hand the question to a run, and answer with nothing but where it is.

        The turn used to answer „Deep research job submitted. Job ID: …", which
        was the whole record of the work: a sentence. The run now has a row and
        a message of its own in this thread (ADR-0062), and THAT message is the
        narration — so this turn's answer is empty on purpose, and carries the
        two ids the reader's client needs to show the block that just appeared.

        A refusal never costs the reader their answer: everything except a full
        queue and a REFUSED CAPABILITY falls back to running the research in
        process, which is the same path a deployment with no worker takes. What
        is lost then is the block, not the work.

        Those two exceptions are not the same kind of thing. A full queue is a
        `retry later`. A ``forbidden`` is the tenant not having deep research at
        all, and the inline fallback would answer it by running deep research
        anyway — in process, with no second check, straight past the gate the
        route just applied. `_finalize_answer` normally stops a turn long before
        it reaches here, so this path is what remains when the capability was
        withdrawn mid-conversation or a flag lookup failed open; either way the
        route's `no` is the authoritative one.
        """
        assert self.commission_run_fn is not None
        try:
            run = await self.commission_run_fn(state)
        except JobAdmissionError as exc:
            # Queue full: answer with the friendly reason, marked as a
            # rejection notice (not a research answer) with the retry hint.
            logger.info("Research run refused by admission control: %s", exc)
            return {
                "messages": [AIMessage(content=str(exc))],
                "job_admission_rejected": True,
                "retry_after_seconds": exc.retry_after_seconds,
            }
        except CommissionRefused as refusal:
            if refusal.reason == "busy":
                logger.info("Research run refused by admission control: %s", refusal)
                return {
                    "messages": [AIMessage(content=str(refusal))],
                    "job_admission_rejected": True,
                    "retry_after_seconds": refusal.retry_after_seconds,
                }
            if refusal.reason == "forbidden":
                # A capability denial, not a transport failure. Falling back
                # would run the very thing the route refused.
                logger.info("Research run refused as a capability the tenant does not have: %s", refusal)
                return _answer_only(DEEP_RESEARCH_UNAVAILABLE_NOTE)
            logger.info("Question could not be commissioned as a run (%s); researching in process", refusal.reason)
            return await self._run_deep_inline(state)
        return {
            "messages": [AIMessage(content="")],
            "run_id": run.run_id,
            "run_message_id": run.run_message_id,
        }

    async def _run_deep_inline(self, state: ConversationState) -> dict[str, Any]:
        research_query = state.original_query or get_latest_user_query(state.messages)
        deep_state = DeepResearchAgentState(
            messages=self._trimmed(state) + [HumanMessage(content=research_query)],
            data_sources=state.data_sources,
            clarifier_result=_inline_plan_context(state),
            plan_documents=state.plan_documents,
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
        if self.commission_run_fn is not None:
            return await self._commission_run(state)
        return await self._run_deep_inline(state)

    @staticmethod
    def _should_escalate(state: ConversationState) -> str:
        # The tenant has no deep research. `_finalize_answer` has already turned
        # this turn's ask into an answer, so nothing should arrive here with the
        # bit set — which is exactly why the check is here as well. This edge is
        # the only way into the clarifier, and the clarifier is what puts a plan
        # in front of a reader whose approval the job queue would then refuse.
        # A second writer of `escalate_to_deep` (a caller seeding state, a path
        # added later) must not be able to reopen that door.
        if not state.deep_research_allowed:
            logger.info("Escalation suppressed: deep research is not enabled for this tenant")
            return "END"
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
        # Transparency must never take a turn down, and the stakes went UP when this
        # moved into a conditional edge: a raise inside a routing function does not
        # degrade the turn, it ends it with no answer at all. Nothing in
        # ``emit_escalation`` can raise today (``push_custom_step`` swallows, and
        # ``clip``/``str.split`` are total on ``str | None``), which is exactly why the
        # guard has to be here rather than trusted to stay true one refactor from now.
        try:
            emit_escalation(state.escalation_ask_reason)
        except Exception:  # noqa: BLE001 - a status line is never worth the answer
            logger.warning("Escalation notice failed to emit; routing to deep research anyway", exc_info=True)
        return "deep_research"

    def _build_graph(self) -> CompiledStateGraph:
        # The node is still NAMED ``shallow_research`` although the agent behind
        # it is now just Piloti. A LangGraph checkpoint records node
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

    async def _merged_digest(self, graph_config: RunnableConfig, state: ConversationState) -> list[str] | None:
        """The digest this turn runs with: checkpoint lines, then the caller's.

        Append-only, exactly as the agent merges a turn's reads at its end: the
        digest never shrinks within a conversation, so a caller that supplies
        lines (a resumed run, a replayed turn) may add but never replace. The
        checkpoint is read here rather than written over, because the field is
        conversation-scoped: a run that supplies nothing must keep what the
        checkpoint holds, and a fresh thread with a caller digest keeps the
        caller's. ``None`` when neither has anything, so an absent digest stays
        absent rather than becoming an empty list the nodes read as a value.
        """
        caller = list(state.already_read_digest or [])
        checkpoint: list[str] = []
        try:
            snapshot = await self._graph.aget_state(graph_config)
            values = getattr(snapshot, "values", None) or {}
            checkpoint = [line for line in (values.get("already_read_digest") or []) if isinstance(line, str)]
        except Exception:  # noqa: BLE001 - no checkpointer (or an empty thread) reads as no lines
            checkpoint = []
        if not checkpoint and not caller:
            return None
        return list(dict.fromkeys([*checkpoint, *caller]))

    async def run(self, state: ConversationState, thread_id: str | None = None) -> ConversationState:
        """Execute one turn on ``thread_id``'s conversation and return the final state.

        The graph input is every turn-scoped field of the fresh ``state`` plus
        its new messages: a field listed is overwritten with this turn's value
        (its default, for the outputs), a field omitted keeps its checkpointed
        value — which is how ``deep_research_declined`` stays sticky. The
        digest is the exception that proves it: conversation-scoped, so the
        caller's lines MERGE with the checkpoint's (append-only) instead of
        overwriting them, and the merged value is what the graph runs with.
        """
        graph_config: RunnableConfig = {"configurable": {"thread_id": thread_id}}
        logger.info("Conversation: Starting turn")
        input_state = {name: getattr(state, name) for name in TURN_SCOPED_FIELDS}
        input_state["messages"] = state.messages
        merged_digest = await self._merged_digest(graph_config, state)
        if merged_digest is not None:
            input_state["already_read_digest"] = merged_digest
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

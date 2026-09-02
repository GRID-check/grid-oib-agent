"""A rejected research plan degrades to an answer, and stays rejected.

The live transcript this file guards: the user asked a plain procedural
question, was shown a six-section research plan instead of an answer, said "no
i dont want a deep research pla", was shown a SECOND seven-section plan, said
"reject" — and the product replied *"Research plan was rejected. Please start a
new research query when ready."* They had to type the question a third time to
get an answer, and the shallow answer they finally got was fine.

Two contracts follow, and both are exercised through the real compiled graph
rather than by calling ``clarifier_node`` directly, because the failure was in
where the graph went next:

1. **A rejection is not a cancellation.** The question is still in
   ``state.messages`` — the rejection reply lives in the clarifier's own state
   and never enters this graph — so the turn continues on the shallow path and
   the user gets the answer they asked for.
2. **A rejection is remembered for the conversation.** Somebody who has said no
   to a plan twice is telling us something durable; the shallow agent's
   ``[ESCALATE_TO_DEEP]`` marker — since ADR-0052 the only way into the
   clarifier — may not put a third plan in front of them in this thread.
"""

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from aiq_agent.agents.chat_researcher.agent import ESCALATION_MARKER
from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.models import ChatResearcherState

PROCEDURAL_QUESTION = "Wie läuft das Baubewilligungsverfahren in Wien ab?"
SHALLOW_ANSWER = "Das Verfahren läuft in fünf Schritten ab [1]."


def _shallow_result(messages, *, escalating: bool = False):
    """A shallow-agent result shaped like the real one.

    Every control-marker field is set EXPLICITLY: a bare ``MagicMock``
    auto-vivifies ``escalation_requested`` into a truthy object, which would
    make every shallow turn here look like an escalation request and hide
    whichever branch is actually under test.
    """
    answer = SHALLOW_ANSWER + (f"\n{ESCALATION_MARKER}" if escalating else "")
    result = MagicMock()
    result.messages = list(messages) + [AIMessage(content=answer)]
    result.escalation_requested = escalating
    result.answer_confidence_marker = None
    result.answer_escalation_reason = None
    result.source_lookup_attempted = True
    result.verified_sources = None
    result.citations_removed = None
    return result


def _is_fresh_question(messages) -> bool:
    """True on the first attempt at a turn — the latest message is the user's."""
    return bool(messages) and isinstance(messages[-1], HumanMessage)


@pytest.fixture
def parts():
    """Call trackers plus the agent functions the graph is built from.

    The shallow agent asks for deep research on every fresh question, so every
    turn reaches the clarifier unless something suppresses the deep route —
    which is the thing under test. Asked again after a rejection (its own
    partial answer is now the latest message) it answers plainly, the way the
    real agent does once the plan is off the table.
    """
    calls = {"shallow": 0, "deep": 0, "clarifier": 0}

    async def shallow(state_input):
        calls["shallow"] += 1
        return _shallow_result(state_input.messages, escalating=_is_fresh_question(state_input.messages))

    async def deep(state):
        calls["deep"] += 1
        result = MagicMock()
        result.messages = list(state.messages) + [AIMessage(content="Comprehensive report.")]
        result.citations_removed = None
        return result

    async def rejecting_clarifier(state_input):
        calls["clarifier"] += 1
        result = MagicMock()
        result.messages = list(state_input.messages)
        result.clarifier_log = "planned"
        result.plan_rejected = True
        # Explicit, like plan_rejected: a bare MagicMock auto-vivifies the
        # attribute truthy, which would take every turn down the cancel branch.
        result.plan_cancelled = False
        result.get_approved_plan_context = MagicMock(return_value=None)
        return result

    return calls, shallow, deep, rejecting_clarifier


def _build(shallow, deep, clarifier, **kwargs):
    """An agent wired the way ``register.py`` wires the real one.

    The checkpointer is NOT optional decoration here. ``_build_graph`` compiles
    with whatever it is handed, so omitting it compiles a graph with
    ``checkpointer=None`` — and then nothing at all survives a ``run()``, which
    would make "the rejection is remembered for the conversation" untestable and
    silently vacuous. Production always passes one
    (``register.py`` -> ``get_checkpointer(config.checkpoint_db)``); a
    ``MemorySaver`` is the in-process equivalent.
    """
    kwargs.setdefault("checkpointer", MemorySaver())
    return ChatResearcherAgent(
        shallow_research_fn=shallow,
        deep_research_fn=deep,
        clarifier_fn=clarifier,
        **kwargs,
    )


class TestRejectionDegradesToAnAnswer:
    @pytest.mark.asyncio
    async def test_rejected_plan_is_answered_on_the_shallow_path(self, parts):
        """The turn the transcript lost: reject -> the question is answered."""
        calls, shallow, deep, clarifier = parts
        agent = _build(shallow, deep, clarifier)

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="reject-1",
        )

        assert calls["clarifier"] == 1
        assert calls["deep"] == 0, "a rejected plan must not run deep research anyway"
        assert calls["shallow"] == 2, "the answer that asked for the plan, then the answer given instead of it"

        answers = [m.content for m in result["messages"] if isinstance(m, AIMessage)]
        assert SHALLOW_ANSWER in answers
        assert not any("start a new research query" in c.lower() for c in answers), (
            "the dead-end notice must be gone: the question was already known and answerable"
        )

    @pytest.mark.asyncio
    async def test_the_shallow_agent_receives_the_original_question(self, parts):
        """Not a paraphrase and not the plan: the words the user actually typed."""
        calls, _shallow, deep, clarifier = parts
        seen: dict[str, object] = {}

        async def capturing_shallow(state_input):
            calls["shallow"] += 1
            seen["messages"] = list(state_input.messages)
            return _shallow_result(state_input.messages, escalating=_is_fresh_question(state_input.messages))

        agent = _build(capturing_shallow, deep, clarifier)
        await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="reject-2",
        )

        # The retry after the rejection sees the question and its own first
        # attempt — and nothing of the plan or the rejection dialog.
        assert [m.content for m in seen["messages"] if isinstance(m, HumanMessage)] == [PROCEDURAL_QUESTION]
        assert all(isinstance(m, (HumanMessage, AIMessage)) for m in seen["messages"])
        assert not any("planned" in str(m.content) for m in seen["messages"])

    @pytest.mark.asyncio
    async def test_the_answer_is_reported_as_shallow_not_deep(self, parts):
        """The transparency panel must name the agent that actually answered.

        The routing is observed after the answer, so a rejected plan cannot
        leave a "deep" label standing on a shallow answer — and the escalation
        that led to the plan is not narrated either.
        """
        calls, shallow, deep, clarifier = parts
        agent = _build(shallow, deep, clarifier)

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="reject-3",
        )

        assert result["routing_decision"] != "deep"
        assert result["routing_decision"] == "shallow"
        assert result.get("escalation_reason") is None, "a decline is not an escalation"


class TestCancellationEndsTheTurnWithAReceipt:
    """An explicit cancellation (the „Abbrechen" button, "cancel"/"abbrechen")
    is the one refusal that may end the turn without an answer — the user chose
    it over the shallow option offered right next to it. It must still say so:
    a silently ended turn reads as a crash, and the old dead-end text told the
    user to retype a question the product was holding.
    """

    @pytest.fixture
    def cancelling_parts(self, parts):
        calls, shallow, deep, _rejecting = parts

        async def cancelling_clarifier(state_input):
            calls["clarifier"] += 1
            result = MagicMock()
            result.messages = list(state_input.messages)
            result.clarifier_log = "planned"
            result.plan_rejected = False
            result.plan_cancelled = True
            result.get_approved_plan_context = MagicMock(return_value=None)
            return result

        return calls, shallow, deep, cancelling_clarifier

    @pytest.mark.asyncio
    async def test_cancel_runs_no_research_and_leaves_a_receipt(self, cancelling_parts):
        calls, shallow, deep, clarifier = cancelling_parts
        agent = _build(shallow, deep, clarifier)

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="cancel-1",
        )

        assert calls["clarifier"] == 1
        assert calls["deep"] == 0, "a cancelled plan must not run deep research"
        assert calls["shallow"] == 1, "a cancellation is not a decline: no second shallow answer was asked for"

        answers = [m.content for m in result["messages"] if isinstance(m, AIMessage)]
        assert any("verworfen" in c for c in answers), "the cancellation needs a visible receipt"
        assert not any("start a new research query" in c.lower() for c in answers)

    @pytest.mark.asyncio
    async def test_cancel_is_reported_as_a_direct_reply_not_deep(self, cancelling_parts):
        """A receipt is neither research nor an escalation: the panel must not
        quote back the deep route the user just refused."""
        calls, shallow, deep, clarifier = cancelling_parts
        agent = _build(shallow, deep, clarifier)

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="cancel-2",
        )

        assert result["routing_decision"] == "meta"
        assert result.get("escalation_reason") is None, "a cancellation is not an escalation"

    @pytest.mark.asyncio
    async def test_cancel_declines_deep_for_the_conversation(self, cancelling_parts):
        """Re-asking after a cancellation yields the answer, not plan number two
        — which is exactly what the receipt promises."""
        calls, shallow, deep, clarifier = cancelling_parts
        agent = _build(shallow, deep, clarifier)

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="cancel-3",
        )
        assert result["deep_research_declined"] is True

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="cancel-3",
        )

        assert calls["clarifier"] == 1, "no second plan after a cancellation"
        assert calls["deep"] == 0
        assert calls["shallow"] == 2, "the re-asked question is answered on the shallow path"
        assert result["messages"][-1].content == SHALLOW_ANSWER


class TestRejectionIsRemembered:
    @pytest.mark.asyncio
    async def test_the_rejection_is_recorded_on_the_conversation(self, parts):
        calls, shallow, deep, clarifier = parts
        agent = _build(shallow, deep, clarifier)

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="sticky-1",
        )

        assert result["deep_research_declined"] is True

    @pytest.mark.asyncio
    async def test_a_later_escalating_turn_in_the_same_thread_stays_shallow(self, parts):
        """Turn 2 of the same conversation: the shallow agent still asks for
        deep research, and the user still does not get a plan."""
        calls, shallow, deep, clarifier = parts
        agent = _build(shallow, deep, clarifier)

        await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="sticky-2",
        )
        assert calls["clarifier"] == 1

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content="Und wie lange dauert die Bauverhandlung?")]),
            thread_id="sticky-2",
        )

        assert calls["clarifier"] == 1, "a second plan must not be offered after a rejection"
        assert calls["deep"] == 0
        assert calls["shallow"] == 3
        assert result["messages"][-1].content == SHALLOW_ANSWER, "the marker is stripped and the answer stands"

    @pytest.mark.asyncio
    async def test_a_new_conversation_can_still_reach_deep_research(self, parts):
        """The flag is per-thread. A fresh chat is the deliberate way back."""
        calls, shallow, deep, clarifier = parts

        async def approving_clarifier(state_input):
            calls["clarifier"] += 1
            result = MagicMock()
            result.messages = list(state_input.messages)
            result.clarifier_log = "planned"
            result.plan_rejected = False
            result.plan_cancelled = False
            result.get_approved_plan_context = MagicMock(return_value=None)
            return result

        agent = _build(shallow, deep, clarifier)
        await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="thread-a",
        )
        assert calls["deep"] == 0

        agent2 = _build(shallow, deep, approving_clarifier)
        await agent2.run(
            ChatResearcherState(messages=[HumanMessage(content="Umfassende Studie zum Holzbau in der DACH-Region")]),
            thread_id="thread-b",
        )

        assert calls["deep"] == 1, "a different conversation must not inherit the rejection"

    @pytest.mark.asyncio
    async def test_escalation_is_suppressed_after_a_rejection(self, parts):
        """The shallow agent's own ``[ESCALATE_TO_DEEP]`` marker cannot re-open
        the clarifier — on the rejection turn that would be a cycle
        (clarifier -> shallow -> clarifier), and on any later turn it would be
        the third plan the user has refused to look at.
        """
        calls, _shallow, deep, clarifier = parts

        async def escalating_shallow(state_input):
            calls["shallow"] += 1
            return _shallow_result(state_input.messages, escalating=True)

        agent = _build(escalating_shallow, deep, clarifier)

        # Turn 1: the plan is rejected; the fallback answer asks to escalate.
        await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="escalate-1",
        )
        # Turn 2: same conversation, the shallow answer asks to escalate again.
        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content="Und die Fristen?")]),
            thread_id="escalate-1",
        )

        assert calls["clarifier"] == 1, "only the rejected plan itself; never a second trip through the clarifier"
        assert calls["deep"] == 0
        assert calls["shallow"] == 3
        assert any(SHALLOW_ANSWER in m.content for m in result["messages"] if isinstance(m, AIMessage))

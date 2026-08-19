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
   to a plan twice is telling us something durable; neither the depth
   classifier nor the shallow agent's ``[ESCALATE_TO_DEEP]`` marker may put a
   third plan in front of them in this thread.
"""

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from aiq_agent.agents.chat_researcher.agent import ESCALATION_MARKER
from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.models import DepthDecision
from aiq_agent.agents.chat_researcher.models import IntentResult

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
    result.verified_sources = None
    result.citations_removed = None
    return result


@pytest.fixture
def parts():
    """Call trackers plus the agent functions the graph is built from.

    The classifier always says deep, so every turn reaches the clarifier unless
    something suppresses the deep route — which is the thing under test.
    """
    calls = {"shallow": 0, "deep": 0, "clarifier": 0}

    async def classifier(state):
        return {
            "user_intent": IntentResult(intent="research", raw=None),
            "depth_decision": DepthDecision(decision="deep", raw_reasoning="Mehrteilige Recherche nötig."),
        }

    async def shallow(state_input):
        calls["shallow"] += 1
        return _shallow_result(state_input.messages)

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
        result.get_approved_plan_context = MagicMock(return_value=None)
        return result

    return calls, classifier, shallow, deep, rejecting_clarifier


def _build(classifier, shallow, deep, clarifier, **kwargs):
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
        intent_classifier_fn=classifier,
        shallow_research_fn=shallow,
        deep_research_fn=deep,
        clarifier_fn=clarifier,
        **kwargs,
    )


class TestRejectionDegradesToAnAnswer:
    @pytest.mark.asyncio
    async def test_rejected_plan_is_answered_on_the_shallow_path(self, parts):
        """The turn the transcript lost: reject -> the question is answered."""
        calls, classifier, shallow, deep, clarifier = parts
        agent = _build(classifier, shallow, deep, clarifier)

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="reject-1",
        )

        assert calls["clarifier"] == 1
        assert calls["deep"] == 0, "a rejected plan must not run deep research anyway"
        assert calls["shallow"] == 1, "a rejected plan must fall through to the shallow answer"

        answers = [m.content for m in result["messages"] if isinstance(m, AIMessage)]
        assert SHALLOW_ANSWER in answers
        assert not any("start a new research query" in c.lower() for c in answers), (
            "the dead-end notice must be gone: the question was already known and answerable"
        )

    @pytest.mark.asyncio
    async def test_the_shallow_agent_receives_the_original_question(self, parts):
        """Not a paraphrase and not the plan: the words the user actually typed."""
        calls, classifier, _shallow, deep, clarifier = parts
        seen: dict[str, object] = {}

        async def capturing_shallow(state_input):
            calls["shallow"] += 1
            seen["messages"] = list(state_input.messages)
            return _shallow_result(state_input.messages)

        agent = _build(classifier, capturing_shallow, deep, clarifier)
        await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="reject-2",
        )

        assert [m.content for m in seen["messages"]] == [PROCEDURAL_QUESTION]

    @pytest.mark.asyncio
    async def test_the_answer_is_reported_as_shallow_not_deep(self, parts):
        """The transparency panel must name the agent that actually answered.

        ``derive_routing_decision`` reads ``depth_decision``; leaving the
        model's rejected "deep" standing would label a shallow answer "Deep
        Research" in the reasoning panel and quote back a reason arguing for a
        route the user just refused.
        """
        from aiq_agent.agents.chat_researcher.agent import derive_routing_decision

        calls, classifier, shallow, deep, clarifier = parts
        agent = _build(classifier, shallow, deep, clarifier)

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="reject-3",
        )

        depth_decision = result["depth_decision"]
        assert depth_decision.decision == "shallow"
        assert depth_decision.raw_reasoning is None, "the model's argument for deep must not be quoted back"
        assert derive_routing_decision(result["user_intent"], depth_decision) == "shallow"
        assert result.get("escalation_reason") is None, "a decline is not an escalation"


class TestRejectionIsRemembered:
    @pytest.mark.asyncio
    async def test_the_rejection_is_recorded_on_the_conversation(self, parts):
        calls, classifier, shallow, deep, clarifier = parts
        agent = _build(classifier, shallow, deep, clarifier)

        result = await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="sticky-1",
        )

        assert result["deep_research_declined"] is True

    @pytest.mark.asyncio
    async def test_a_later_deep_turn_in_the_same_thread_goes_shallow(self, parts):
        """Turn 2 of the same conversation: the classifier still says deep, and
        the user still does not get a plan."""
        calls, classifier, shallow, deep, clarifier = parts
        agent = _build(classifier, shallow, deep, clarifier)

        await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="sticky-2",
        )
        assert calls["clarifier"] == 1

        await agent.run(
            ChatResearcherState(messages=[HumanMessage(content="Und wie lange dauert die Bauverhandlung?")]),
            thread_id="sticky-2",
        )

        assert calls["clarifier"] == 1, "a second plan must not be offered after a rejection"
        assert calls["deep"] == 0
        assert calls["shallow"] == 2

    @pytest.mark.asyncio
    async def test_a_new_conversation_can_still_reach_deep_research(self, parts):
        """The flag is per-thread. A fresh chat is the deliberate way back."""
        calls, classifier, shallow, deep, clarifier = parts

        async def approving_clarifier(state_input):
            calls["clarifier"] += 1
            result = MagicMock()
            result.messages = list(state_input.messages)
            result.clarifier_log = "planned"
            result.plan_rejected = False
            result.get_approved_plan_context = MagicMock(return_value=None)
            return result

        agent = _build(classifier, shallow, deep, clarifier)
        await agent.run(
            ChatResearcherState(messages=[HumanMessage(content=PROCEDURAL_QUESTION)]),
            thread_id="thread-a",
        )
        assert calls["deep"] == 0

        agent2 = _build(classifier, shallow, deep, approving_clarifier)
        await agent2.run(
            ChatResearcherState(messages=[HumanMessage(content="Umfassende Studie zum Holzbau in der DACH-Region")]),
            thread_id="thread-b",
        )

        assert calls["deep"] == 1, "a different conversation must not inherit the rejection"

    @pytest.mark.asyncio
    async def test_escalation_is_suppressed_after_a_rejection(self, parts):
        """The shallow agent's own ``[ESCALATE_TO_DEEP]`` marker cannot re-open
        the clarifier either — on the rejection turn that would be a cycle
        (clarifier -> shallow -> clarifier), and on any later turn it would be
        the third plan the user has refused to look at.
        """
        calls, classifier, _shallow, deep, clarifier = parts

        async def escalating_shallow(state_input):
            calls["shallow"] += 1
            return _shallow_result(state_input.messages, escalating=True)

        agent = _build(classifier, escalating_shallow, deep, clarifier, enable_escalation=True)

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
        assert calls["shallow"] == 2
        assert any(SHALLOW_ANSWER in m.content for m in result["messages"] if isinstance(m, AIMessage))

"""The overconfidence guard with TWO kinds of grounding.

An IFC measurement can never satisfy the citation gate — it has no passage to
quote — so a correctly measured number used to be reported at "low" for lacking
evidence it structurally cannot have. It now grounds the answer, and this file
exists mostly to prove what it does NOT ground.

The four claims under test, and only the first is the feature:

1. a measured, descriptive answer is no longer floored at "low";
2. an ungrounded prose answer is STILL floored — the guard survives intact;
3. a measured answer that ALSO asserts something normative without a citation
   does not launder that claim (``…does_not_launder…`` below — the most
   important test in the change);
4. a fabricated quote still floors the answer, and a measurement in the same
   turn does not rescue it.
"""

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.agent import _finalize_shallow_answer
from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.models import DepthDecision
from aiq_agent.agents.chat_researcher.models import IntentResult
from aiq_agent.agents.shallow_researcher.markers import MEASUREMENT_CONFIDENCE_CEILING
from aiq_agent.agents.shallow_researcher.markers import answer_confidence_capped_reason
from aiq_agent.agents.shallow_researcher.markers import surface_answer_confidence

# The two answers the whole design turns on: the same measured sentence, once
# on its own and once with a legal conclusion bolted onto it.
KELLER_MEASURED = "Der Keller ist 2,70 m hoch (gemessen ±5 mm)."
KELLER_MEASURED_PLUS_VERDICT = "Der Keller ist 2,70 m hoch und erfüllt damit OIB 4 Punkt 2.1."


class TestGuardWithMeasurementGrounding:
    """``surface_answer_confidence`` / ``answer_confidence_capped_reason``."""

    def test_measured_descriptive_answer_is_no_longer_floored_at_low(self):
        """The bug: a right number reported with a hedge nobody could act on."""
        assert (
            surface_answer_confidence("high", citation_grounded=False, measurement_grounded=True)
            == MEASUREMENT_CONFIDENCE_CEILING
        )
        assert surface_answer_confidence("medium", citation_grounded=False, measurement_grounded=True) == "medium"

    def test_measurement_never_reaches_high(self):
        """ "high" keeps meaning exactly one thing: verified against a passage.

        This is the structural half of the anti-laundering design — it holds
        without reference to any text heuristic, so a normative claim the brake
        below fails to spot still cannot come out as a confident legal statement.
        """
        assert MEASUREMENT_CONFIDENCE_CEILING == "medium"
        assert surface_answer_confidence("high", citation_grounded=False, measurement_grounded=True) != "high"

    def test_measurement_only_cap_is_reported_not_silent(self):
        assert (
            answer_confidence_capped_reason("high", citation_grounded=False, measurement_grounded=True)
            == "measurement_only"
        )
        # medium → medium is not a downgrade, so there is nothing to report.
        assert answer_confidence_capped_reason("medium", citation_grounded=False, measurement_grounded=True) is None

    def test_ungrounded_prose_is_still_floored_at_low(self):
        """The guard this change is NOT allowed to weaken.

        A model asserting an OIB requirement with no verified citation and
        nothing measured is the "real section, fabricated quote" failure the gate
        was built for. Nothing here touches it.
        """
        assert surface_answer_confidence("high", citation_grounded=False) == "low"
        assert answer_confidence_capped_reason("high", citation_grounded=False) == "ungrounded"

    def test_measurement_does_not_launder_an_uncited_normative_claim(self):
        """THE test. Measured number + un-cited legal claim stays at "low".

        „Der Keller ist 2,70 m hoch" is reproducible evidence. „…und erfüllt
        damit OIB 4 Punkt 2.1" is not, and it is the sentence an architect signs
        under. If the measurement satisfied the gate for the whole answer, the
        legal claim would ride out at the model's own level on evidence that says
        nothing about it — strictly worse than the over-hedging it replaces.
        """
        assert (
            surface_answer_confidence(
                "high",
                citation_grounded=False,
                measurement_grounded=True,
                normative_claim_uncited=True,
            )
            == "low"
        )
        assert (
            surface_answer_confidence(
                "medium",
                citation_grounded=False,
                measurement_grounded=True,
                normative_claim_uncited=True,
            )
            == "low"
        )

    def test_the_mixed_case_reports_itself_instead_of_resolving_silently(self):
        """The mixed answer is not just capped — it says WHY it was capped.

        Same level as before the change, a different and more honest reason. It
        is also the only way anyone finds out how often the brake fires: the
        reason rides the citation-health ledger.
        """
        assert (
            answer_confidence_capped_reason(
                "high",
                citation_grounded=False,
                measurement_grounded=True,
                normative_claim_uncited=True,
            )
            == "normative_claim_uncited"
        )

    def test_fabricated_quote_still_floors_the_answer(self):
        assert surface_answer_confidence("high", citation_grounded=True, quotes_verified=False) == "low"
        assert (
            answer_confidence_capped_reason("high", citation_grounded=True, quotes_verified=False) == "quote_unverified"
        )

    def test_a_measurement_does_not_rescue_a_fabricated_quote(self):
        """Quote verification is checked BEFORE measurement grounding.

        An answer that measured a wall and also invented a quotation from OIB 2
        is the exact failure the guard exists for; the measurement is beside the
        point, and the reported reason must say so rather than blaming the
        grounding.
        """
        assert (
            surface_answer_confidence(
                "high",
                citation_grounded=False,
                quotes_verified=False,
                measurement_grounded=True,
            )
            == "low"
        )
        assert (
            answer_confidence_capped_reason(
                "high",
                citation_grounded=False,
                quotes_verified=False,
                measurement_grounded=True,
            )
            == "quote_unverified"
        )

    def test_citation_grounding_still_reaches_high_and_is_unaffected(self):
        assert surface_answer_confidence("high", citation_grounded=True) == "high"
        assert (
            surface_answer_confidence(
                "high",
                citation_grounded=True,
                measurement_grounded=True,
                normative_claim_uncited=True,
            )
            == "high"
        )

    def test_the_guard_never_raises_a_self_report(self):
        assert surface_answer_confidence("low", citation_grounded=False, measurement_grounded=True) == "low"
        assert surface_answer_confidence(None, citation_grounded=False, measurement_grounded=True) is None

    def test_defaults_reproduce_the_pre_measurement_behaviour(self):
        """Every caller that does not pass the new signals is untouched."""
        for level in ("low", "medium", "high"):
            for grounded in (True, False):
                for quotes in (True, False):
                    assert surface_answer_confidence(level, grounded, quotes) == (
                        level if (grounded and quotes) else "low"
                    )


class TestFinalizeShallowAnswerCarriesTheSignals:
    """The node-level assembly, where the level and the reason are written."""

    def test_measured_answer_surfaces_medium(self):
        msg = AIMessage(content=f"{KELLER_MEASURED}\n[CONFIDENCE:high]")
        update = _finalize_shallow_answer(msg, citation_grounded=False, measurement_grounded=True)
        assert update["answer_confidence"] == "medium"
        assert update["answer_confidence_capped_reason"] == "measurement_only"
        assert "[CONFIDENCE" not in update["messages"][0].content

    def test_mixed_answer_does_not_launder_through_the_node(self):
        msg = AIMessage(content=f"{KELLER_MEASURED_PLUS_VERDICT}\n[CONFIDENCE:high]")
        update = _finalize_shallow_answer(
            msg,
            citation_grounded=False,
            measurement_grounded=True,
            normative_claim_uncited=True,
        )
        assert update["answer_confidence"] == "low"
        assert update["answer_confidence_capped_reason"] == "normative_claim_uncited"

    def test_node_defaults_leave_an_ungrounded_answer_capped(self):
        msg = AIMessage(content="Der Keller erfüllt OIB 4.\n[CONFIDENCE:high]")
        update = _finalize_shallow_answer(msg, citation_grounded=False)
        assert update["answer_confidence"] == "low"
        assert update["answer_confidence_capped_reason"] == "ungrounded"


class TestMeasurementConfidenceEndToEnd:
    """Propagation from a shallow result through ``ChatResearcherAgent.run()``."""

    @pytest.fixture
    def research_orchestration(self):
        async def classifier(state):
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="shallow", raw_reasoning="simple"),
            }

        return classifier

    @pytest.fixture
    def deep_fn(self):
        async def deep(state):
            result = MagicMock()
            result.messages = list(state.messages) + [AIMessage(content="Deep report.")]
            return result

        return deep

    def _shallow(self, answer: str, *, measured: bool, normative: bool, marker: str = "high"):
        """A shallow result carrying the real state fields (not mock attributes).

        ``MagicMock`` auto-vivifies every attribute as a truthy object, so a mock
        that merely forgot to set the grounding fields would be handed
        measurement grounding for free. The chat node reads these with
        ``is True`` / ``is not False`` precisely so it fails closed on that; here
        the fields are set to real booleans so the test exercises the signal and
        not the fallback.
        """

        async def shallow(state_input):
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            result = MagicMock()
            result.messages = list(messages) + [AIMessage(content=answer)]
            result.answer_citation_grounded = False
            result.answer_quotes_verified = True
            result.answer_measurement_grounded = measured
            result.answer_normative_claim_uncited = normative
            result.escalation_requested = False
            result.answer_confidence_marker = marker
            result.answer_confidence_marker_reason = None
            return result

        return shallow

    def _agent(self, research_orchestration, shallow_fn, deep_fn):
        return ChatResearcherAgent(
            intent_classifier_fn=research_orchestration,
            shallow_research_fn=shallow_fn,
            deep_research_fn=deep_fn,
            clarifier_fn=None,
            enable_clarifier=False,
            enable_escalation=False,
        )

    @pytest.mark.asyncio
    async def test_measured_answer_arrives_at_medium(self, research_orchestration, deep_fn):
        shallow = self._shallow(KELLER_MEASURED, measured=True, normative=False)
        agent = self._agent(research_orchestration, shallow, deep_fn)
        state = ChatResearcherState(messages=[HumanMessage(content="Wie hoch ist der Keller?")])
        result = await agent.run(state, thread_id="m1")
        assert result["answer_confidence"] == "medium"
        assert result["answer_confidence_capped_reason"] == "measurement_only"

    @pytest.mark.asyncio
    async def test_mixed_answer_arrives_at_low_end_to_end(self, research_orchestration, deep_fn):
        """End to end: the legal claim does not reach the user at "medium"."""
        shallow = self._shallow(KELLER_MEASURED_PLUS_VERDICT, measured=True, normative=True)
        agent = self._agent(research_orchestration, shallow, deep_fn)
        state = ChatResearcherState(messages=[HumanMessage(content="Reicht die Kellerhöhe?")])
        result = await agent.run(state, thread_id="m2")
        assert result["answer_confidence"] == "low"
        assert result["answer_confidence_capped_reason"] == "normative_claim_uncited"

    @pytest.mark.asyncio
    async def test_a_result_without_the_fields_falls_back_to_the_old_cap(self, research_orchestration, deep_fn):
        """Fail closed: an unrecognised signal never opens the gate.

        The result here is a bare ``MagicMock`` whose grounding attributes are
        auto-created truthy objects — the shape a partially migrated caller or a
        sloppy test produces. It must be read as "no measurement", not as
        "measured", or every ungrounded answer in the system quietly gains a
        level.
        """

        async def shallow(state_input):
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            result = MagicMock()
            result.messages = list(messages) + [AIMessage(content="Behauptung ohne Beleg.")]
            result.answer_citation_grounded = False
            result.escalation_requested = False
            result.answer_confidence_marker = "high"
            result.answer_confidence_marker_reason = None
            return result

        agent = self._agent(research_orchestration, shallow, deep_fn)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="m3")
        assert result["answer_confidence"] == "low"
        assert result["answer_confidence_capped_reason"] == "ungrounded"

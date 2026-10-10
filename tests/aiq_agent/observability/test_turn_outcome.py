"""A finished turn's outcome on its root span (ADR-0089)."""

import asyncio

from aiq_agent.common.wire_v2 import CitationsRemoved
from aiq_agent.common.wire_v2 import KeyedCard
from aiq_agent.common.wire_v2 import QuoteStamp
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import TurnResult
from aiq_agent.common.wire_v2 import WireSource
from aiq_agent.observability.turn_outcome import OBSERVATION_OUTPUT_ATTRIBUTE
from aiq_agent.observability.turn_outcome import TAGS_ATTRIBUTE
from aiq_agent.observability.turn_outcome import begin_turn_outcome
from aiq_agent.observability.turn_outcome import current_turn_outcome
from aiq_agent.observability.turn_outcome import end_turn_outcome
from aiq_agent.observability.turn_outcome import outcome_attributes
from aiq_agent.observability.turn_outcome import record_turn_finished

META = "langfuse.trace.metadata."


def _result(**overrides) -> TurnResult:
    fields = {
        "message_id": "m1",
        "text": "Die Fluchtweglänge beträgt 40 m [1].",
        "sources": [WireSource(content="OIB-RL 4", number=1)],
        "cards": [KeyedCard(key="k", card={"type": "compliance_check"})],
        "answer_confidence": "medium",
        "answer_confidence_capped_reason": "quote_unverified",
        "routing_decision": "shallow",
        "citations_removed": CitationsRemoved(count=2, reasons=["not_in_registry"]),
        "quote_stamps": [
            QuoteStamp(text="a", status="verbatim", number=1),
            QuoteStamp(text="b", status="not_found"),
        ],
    }
    fields.update(overrides)
    return TurnResult(**fields)


class TestOutcomeAttributes:
    def test_the_dimensions_an_analyst_slices_by(self):
        attributes = outcome_attributes(outcome="answered", result=_result())

        assert attributes[f"{META}turn_outcome"] == "answered"
        assert attributes[f"{META}answer_route"] == "shallow"
        assert attributes[f"{META}answer_confidence"] == "medium"
        assert attributes[f"{META}answer_confidence_capped"] == "quote_unverified"
        assert attributes[f"{META}answer_sources"] == 1
        assert attributes[f"{META}answer_card_types"] == ["compliance_check"]
        assert attributes[f"{META}citations_removed"] == 2
        assert attributes[f"{META}quotes_not_found"] == 1

    def test_the_root_output_is_the_answer_not_the_stream_preview(self):
        attributes = outcome_attributes(outcome="answered", result=_result())

        assert attributes[OBSERVATION_OUTPUT_ATTRIBUTE] == "Die Fluchtweglänge beträgt 40 m [1]."

    def test_tags_are_labels_never_ids_or_prose(self):
        tags = outcome_attributes(outcome="answered", result=_result())[TAGS_ATTRIBUTE]

        assert tags == [
            "outcome:answered",
            "route:shallow",
            "confidence:medium",
            "capped:quote_unverified",
            "citations-removed",
            "quote-not-found",
        ]

    def test_absent_facts_are_omitted_not_zero_filled(self):
        attributes = outcome_attributes(
            outcome="refused",
            result=_result(
                text="",
                answer_confidence=None,
                answer_confidence_capped_reason=None,
                routing_decision=None,
                citations_removed=None,
                quote_stamps=[],
                cards=[],
            ),
        )

        assert f"{META}answer_confidence" not in attributes
        assert f"{META}answer_card_types" not in attributes
        assert OBSERVATION_OUTPUT_ATTRIBUTE not in attributes
        assert attributes[TAGS_ATTRIBUTE] == ["outcome:refused"]

    def test_a_stop_reads_as_a_warning(self):
        assert outcome_attributes(outcome="cancelled", result=_result())["langfuse.observation.level"] == "WARNING"


class TestTheBox:
    def test_nothing_recorded_without_a_bound_turn(self):
        record_turn_finished(RunFinishedBody(outcome="answered", result=_result()))

        assert current_turn_outcome() is None

    def test_a_write_from_a_copied_context_reaches_the_bound_box(self):
        """The workflow runs in copies of the socket's context; the root's export task in another."""
        token = begin_turn_outcome()
        try:

            async def relay():
                record_turn_finished(RunFinishedBody(outcome="answered", result=_result()))

            asyncio.run(relay())
            assert current_turn_outcome()[f"{META}turn_outcome"] == "answered"
        finally:
            end_turn_outcome(token)

        assert current_turn_outcome() is None

    def test_a_broken_body_never_raises_into_the_relay(self):
        token = begin_turn_outcome()
        try:
            record_turn_finished(object())
        finally:
            end_turn_outcome(token)

"""The decision model's observation (ADR-0064, ADR-0089): a generation with its usage, never a state."""

import json

from aiq_agent.observability.decision_trace import decision_observation
from aiq_agent.observability.decision_trace import decision_usage
from aiq_agent.observability.decision_trace import is_decision_span
from aiq_agent.observability.trace_context import observation_type


def test_a_decision_step_is_a_generation_whatever_nat_calls_it():
    assert observation_type(name="decide.turn", kind="FUNCTION") == "generation"
    assert is_decision_span("decide.reference_fit") and not is_decision_span("retrieve.knowledge_search")


def test_the_usage_rides_the_output_and_reads_back_as_tokens_cost_and_model():
    _, body_out = decision_observation(
        questions=["fits"], states=2, model="typesafe/jev-1.13", input_tokens=600, output_tokens=40, cost_usd=0.00003
    )
    attributes = {"nat.output.value": json.dumps(body_out)}

    assert decision_usage(attributes) == {
        "prompt_tokens": 600,
        "completion_tokens": 40,
        "total_tokens": 640,
        "cost_usd": 0.00003,
        "model": "typesafe/jev-1.13",
    }


def test_a_skipped_decision_has_no_usage_to_claim():
    _, body_out = decision_observation(questions=["fits"], states=1, decided=0, skipped="timeout")

    assert body_out == {"decided": 0, "skipped": "timeout"}
    assert decision_usage({"output.value": json.dumps(body_out)}) is None
    assert decision_usage({"output.value": "not json"}) is None

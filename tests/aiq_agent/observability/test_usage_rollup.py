"""Per-turn usage rollup: one record per turn with its dollars.

Pins the sibling contract to the citation-health ledger:

1. **The payload shape** — calls, prompt/completion/total tokens, cost and
   its source. A renamed or silently dropped field makes per-turn waste
   unmeasurable without anything erroring.
2. **No row for a call-free turn** — like the citation ledger's direct
   replies (nothing to cite, no row), a turn that spent nothing records
   nothing rather than a zero row.
3. **Fail-open recording** — stamping the trace must never take a turn down,
   and a tracker that saw no calls is absence, not an error.
"""

import pytest

from aiq_agent.observability.usage_rollup import build_usage_rollup
from aiq_agent.observability.usage_rollup import from_tracker
from aiq_agent.observability.usage_rollup import record_usage_turn


class _Tracker:
    """Duck-typed stand-in for GridCostTracker (prompt/completion/cost totals)."""

    def __init__(self, *, calls=0, prompt=0, completion=0, cost=0.0, job_id=None):
        self.events_recorded = calls
        self.prompt_tokens = prompt
        self.completion_tokens = completion
        self.turn_cost_usd = cost
        self.job_id = job_id
        self.organization_id = "org_1"
        self.conversation_id = "conv_1"


class TestBuildUsageRollup:
    def test_totals_and_dollars_land_on_the_payload(self):
        rollup = build_usage_rollup(llm_calls=3, prompt_tokens=1204, completion_tokens=331, cost_usd=0.00214)

        assert rollup is not None
        assert rollup.to_payload() == {
            "llmCalls": 3,
            "promptTokens": 1204,
            "completionTokens": 331,
            "totalTokens": 1535,
            "costUsd": pytest.approx(0.00214),
            "costSource": "usage_field",
        }

    def test_explicit_total_is_kept(self):
        rollup = build_usage_rollup(
            llm_calls=1, prompt_tokens=100, completion_tokens=20, total_tokens=130, cost_usd=0.0
        )

        assert rollup is not None
        assert rollup.total_tokens == 130
        assert rollup.cost_source == "missing"

    def test_a_call_free_turn_records_nothing(self):
        assert build_usage_rollup(llm_calls=0, prompt_tokens=0, completion_tokens=0) is None


class TestFromTracker:
    def test_reads_the_turn_accumulator(self):
        rollup = from_tracker(_Tracker(calls=2, prompt=500, completion=100, cost=0.001))

        assert rollup is not None
        assert (rollup.llm_calls, rollup.prompt_tokens, rollup.completion_tokens) == (2, 500, 100)
        assert rollup.cost_usd == pytest.approx(0.001)

    def test_empty_tracker_is_absence_not_an_error(self):
        assert from_tracker(_Tracker()) is None
        assert from_tracker(None) is None


class TestRecordUsageTurn:
    @pytest.fixture(autouse=True)
    def _clean(self):
        from aiq_agent.observability.langfuse_trace_attributes import reset_contributions

        reset_contributions()
        yield
        reset_contributions()

    def test_rollup_lands_on_the_trace_and_returns_its_payload(self):
        from aiq_agent.observability.langfuse_trace_attributes import snapshot_contributions

        payload = record_usage_turn(tracker=_Tracker(calls=2, prompt=500, completion=100, cost=0.001))

        assert payload is not None
        assert payload["agent"] == "chat"
        assert payload["rollup"]["costUsd"] == pytest.approx(0.001)
        assert payload["rollup"]["llmCalls"] == 2
        metadata = (snapshot_contributions() or {}).get("metadata", {})
        assert metadata["usage_llm_calls"] == 2
        assert metadata["usage_prompt_tokens"] == 500
        assert metadata["usage_completion_tokens"] == 100
        assert metadata["usage_total_tokens"] == 600
        assert metadata["usage_cost_usd"] == pytest.approx(0.001)

    def test_turn_and_job_travel_with_the_record(self):
        payload = record_usage_turn(
            tracker=_Tracker(calls=1, prompt=10, completion=5, job_id="job_9"), turn_id="turn_7"
        )

        assert payload is not None
        assert payload["turnId"] == "turn_7"
        assert payload["jobId"] == "job_9"

    def test_call_free_turn_records_nothing(self):
        assert record_usage_turn(tracker=_Tracker()) is None

    def test_recording_never_raises_into_the_turn(self):
        assert record_usage_turn(tracker=object()) is None

"""Admission, budget and profiling around the run; a refusal is a value."""

from __future__ import annotations

import pytest

from aiq_agent.common.cost_tracking import BudgetExceededError
from aiq_agent.common.turn_admission import TurnAdmissionError
from aiq_agent.turn import admission as admission_mod
from aiq_agent.turn.admission import TurnRefusal
from aiq_agent.turn.admission import answer_turn
from aiq_agent.turn.admission import refusal_response
from aiq_agent.turn.admission import spanned


class _Agent:
    def __init__(self, outcome):
        self.outcome = outcome
        self.calls: list[tuple[object, str | None]] = []

    async def run(self, state, thread_id=None):
        self.calls.append((state, thread_id))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


@pytest.fixture
def admitted(monkeypatch):
    """Record which organization the slot was taken for; no cache needed."""
    seen: list[str | None] = []

    class _Slot:
        def __init__(self, organization_id):
            seen.append(organization_id)

        async def __aenter__(self):
            return None

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(admission_mod, "admit_turn_async", _Slot)
    return seen


class TestAnswerTurn:
    async def test_runs_the_agent_inside_the_slot_and_returns_its_state(self, admitted):
        agent = _Agent(outcome="STATE")
        outcome = await answer_turn(agent, "IN", thread_id="t1", organization_id="org")
        assert outcome.state == "STATE"
        assert outcome.refusal is None
        assert agent.calls == [("IN", "t1")]
        assert admitted == ["org"]

    async def test_the_identity_reaches_the_cost_ledger_unparsed(self, admitted, monkeypatch):
        """The ledger re-parses the signed envelope when handed nothing; the
        turn already parsed it once and says so."""
        seen: dict = {}

        class _Tracker:
            def __init__(self, **kwargs):
                seen.update(kwargs)

            def __enter__(self):
                return "TRACKER"

            def __exit__(self, *exc):
                return False

        monkeypatch.setattr(admission_mod, "track_llm_costs", _Tracker)
        identity = {"organization_id": "org", "user_id": "u", "project_id": "p", "conversation_id": "c"}
        outcome = await answer_turn(_Agent("STATE"), "IN", thread_id="t", organization_id="org", identity=identity)
        assert seen == {"identity": identity, "inline_flush": False}
        assert outcome.cost_tracker == "TRACKER"

    async def test_a_refused_slot_is_a_refusal_with_its_retry_hint(self, monkeypatch):
        class _Full:
            def __init__(self, _org):
                pass

            async def __aenter__(self):
                raise TurnAdmissionError("Too many turns", retry_after_seconds=15)

            async def __aexit__(self, *exc):
                return False

        monkeypatch.setattr(admission_mod, "admit_turn_async", _Full)
        agent = _Agent(outcome="STATE")
        metadata: dict = {}
        outcome = await answer_turn(agent, "IN", thread_id="t1", organization_id=None, metadata=metadata)
        assert outcome.refusal == TurnRefusal("turn_admission", "Too many turns", 15, outcome="admission_refused")
        assert outcome.state is None
        assert metadata == {"outcome": "admission_refused"}
        assert agent.calls == [], "a refused turn starts nothing"

    async def test_a_blown_budget_is_a_refusal_without_a_retry_hint(self, admitted):
        metadata: dict = {}
        outcome = await answer_turn(
            _Agent(BudgetExceededError("Budget exhausted")),
            "IN",
            thread_id="t",
            organization_id=None,
            metadata=metadata,
        )
        assert outcome.refusal.response_id == "budget_exceeded"
        assert outcome.refusal.outcome == "budget_exceeded"
        assert outcome.refusal.retry_after_seconds is None
        assert "Budget exhausted" in outcome.refusal.message
        assert metadata == {"outcome": "budget_exceeded"}

    async def test_any_other_failure_propagates(self, admitted):
        with pytest.raises(ValueError):
            await answer_turn(_Agent(ValueError("bug")), "IN", thread_id="t", organization_id=None)

    async def test_spanned_returns_the_awaited_value(self):
        async def value():
            return 42

        assert await spanned("setup.anything", value()) == 42


class TestRefusalResponse:
    def test_carries_the_message_and_the_retry_hint(self):
        response = refusal_response(TurnRefusal("turn_admission", "busy", 15), workflow_id="wf")
        assert response.choices[0].message.content == "busy"
        assert response.id == "turn_admission"
        assert response.model == "wf"
        assert response.retry_after_seconds == 15

    def test_no_hint_means_no_field(self):
        response = refusal_response(TurnRefusal("budget_exceeded", "spent"), workflow_id="wf")
        assert getattr(response, "retry_after_seconds", None) is None

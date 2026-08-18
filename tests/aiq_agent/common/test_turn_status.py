"""The turn's own account of itself: what it says, and what it refuses to say.

Exercised against the REAL NAT ``IntermediateStepManager``/``ContextState``
(a process-wide singleton), following ``test_nat_step_repair.py``: half the
contract here is that a status step leaves the span stack exactly as it found
it, and a faked manager would assert nothing about that.
"""

from __future__ import annotations

import json

import pytest

from aiq_agent.common import turn_status
from nat.builder.context import ContextState


@pytest.fixture
def context_state():
    """The singleton ContextState with a clean span stack and a private stream."""
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())
    yield state
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())


@pytest.fixture
def steps(context_state):
    """Every step pushed during the test, as ``(name, parsed payload)`` pairs."""
    seen: list[tuple[str, str, dict]] = []

    def _on_next(step) -> None:
        payload = step.payload
        body = getattr(payload.data, "input", None)
        if isinstance(body, str):
            seen.append((payload.name, str(payload.event_type), json.loads(body)))

    context_state.event_stream.get().subscribe(_on_next)
    return seen


def _live(steps) -> list[dict]:
    return [payload for _name, event_type, payload in steps if event_type.endswith("START")]


class TestSpanHygiene:
    def test_a_step_is_a_balanced_pair(self, steps, context_state) -> None:
        turn_status.emit_citation_check()

        names_and_types = [(name, event_type) for name, event_type, _ in steps]
        assert names_and_types == [
            ("status:citations", "FUNCTION_START"),
            ("status:citations", "FUNCTION_END"),
        ]
        # A leaked START frame corrupts the NEXT legitimate close, which is the
        # fault common.nat_step_repair exists to repair. Never leak one here.
        assert context_state.active_span_id_stack.get() == ["root"]

    def test_emission_never_raises(self, monkeypatch) -> None:
        """Transparency is worth strictly less than the answer it describes."""

        def _boom():
            raise RuntimeError("no context here")

        monkeypatch.setattr("nat.builder.context.Context.get", staticmethod(_boom))
        turn_status.emit_citation_check()
        turn_status.emit_escalation("weil")


class TestDocumentsLoading:
    def test_a_shelf_of_the_readers_own_is_named(self, steps) -> None:
        turn_status.emit_documents_loading(["archiv"])
        assert _live(steps)[0]["text"] == "Unterlagen aus dem Büroarchiv werden gesichtet …"

    def test_several_shelves_collapse_into_one_line(self, steps) -> None:
        turn_status.emit_documents_loading(["archiv", "project"])
        assert _live(steps)[0]["text"] == "Unterlagen aus Ihren Ablagen werden gesichtet …"

    def test_the_base_corpus_alone_says_nothing(self, steps) -> None:
        """It is read on every research turn — announcing it announces a constant."""
        turn_status.emit_documents_loading(["base"])
        turn_status.emit_documents_loading([])
        turn_status.emit_documents_loading(None)
        assert steps == []


class TestRouting:
    def test_the_decision_leads_and_the_reason_follows(self, steps) -> None:
        turn_status.emit_routing(intent="research", depth="deep", reason="Mehrere Teilfragen.")
        payload = _live(steps)[0]
        assert payload["text"] == "Tiefenrecherche wird vorbereitet: Mehrere Teilfragen."
        assert payload["intent"] == "research"
        assert payload["depth"] == "deep"

    def test_a_meta_turn_says_no_research_is_needed(self, steps) -> None:
        turn_status.emit_routing(intent="meta", depth=None, reason=None)
        assert _live(steps)[0]["text"] == "Gespräch — keine Recherche nötig"

    def test_the_line_never_outgrows_its_row(self, steps) -> None:
        turn_status.emit_routing(intent="research", depth="shallow", reason="Grund " * 40)
        payload = _live(steps)[0]
        assert len(payload["text"]) <= turn_status.MAX_STATUS_CHARS
        assert len(payload["reason"]) <= turn_status.MAX_REASON_CHARS


class TestRetrieval:
    def test_it_names_the_corpus_and_quotes_the_question(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "Fluchtweglänge GK4"}}],
            round_index=0,
        )
        payload = _live(steps)[0]
        assert payload["text"] == "Sucht im OIB-Wissen: „Fluchtweglänge GK4“"
        assert payload["query"] == "Fluchtweglänge GK4"

    def test_a_group_qualified_tool_name_still_resolves(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "sources__ris_search_tool", "args": {"query": "OIB 2"}}],
            round_index=0,
        )
        assert _live(steps)[0]["text"] == "Sucht im RIS: „OIB 2“"

    def test_a_parallel_batch_is_ONE_line(self, steps) -> None:
        """Three lines in the same instant is a log stream, not a status."""
        turn_status.emit_retrieval(
            [
                {"name": "knowledge_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
                {"name": "ris_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
                {"name": "web_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
            ],
            round_index=0,
        )
        assert len(_live(steps)) == 1
        assert _live(steps)[0]["text"].startswith("Sucht im OIB-Wissen und im RIS und im Web")

    def test_successive_rounds_do_not_collapse_into_one_step(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "ris_search_tool", "args": {"query": "a"}}], round_index=0)
        turn_status.emit_retrieval([{"name": "ris_search_tool", "args": {"query": "b"}}], round_index=1)
        names = {name for name, event_type, _ in steps if event_type.endswith("START")}
        assert names == {"status:retrieval:0", "status:retrieval:1"}

    def test_loading_a_skill_is_not_a_retrieval(self, steps) -> None:
        """The skills substrate narrates that itself, with the skill's human title."""
        turn_status.emit_retrieval([{"name": "use_skill", "args": {"skill_name": "x"}}], round_index=0)
        turn_status.emit_retrieval([], round_index=1)
        turn_status.emit_retrieval(None, round_index=2)
        assert steps == []

    def test_an_interaction_tool_says_what_it_does(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "remember", "args": {"text": "Dachneigung 30°"}}], round_index=0)
        assert _live(steps)[0]["text"] == "Notiz wird gespeichert …"


class TestEscalation:
    def test_the_line_says_why_in_the_readers_terms(self, steps) -> None:
        turn_status.emit_escalation("Shallow agent emitted insufficiency marker")
        payload = _live(steps)[0]
        assert payload["text"] == "Kurzrecherche reicht nicht — Tiefenrecherche startet"
        # The internal marker string is telemetry, never the sentence.
        assert "Shallow agent" not in payload["text"]
        assert payload["reason"] == "Shallow agent emitted insufficiency marker"


class TestChannels:
    def test_every_status_here_is_addressed_to_the_reader(self, steps) -> None:
        turn_status.emit_documents_loading(["project"])
        turn_status.emit_routing(intent="research", depth="shallow", reason="Eine Fachfrage.")
        turn_status.emit_retrieval([{"name": "knowledge_search_tool", "args": {"query": "q"}}], round_index=0)
        turn_status.emit_citation_check(source_count=3)
        turn_status.emit_escalation(None)

        payloads = _live(steps)
        assert len(payloads) == 5
        for payload in payloads:
            assert payload["kind"] == "status"
            assert payload["channel"] == turn_status.CHANNEL_LIVE
            assert payload["text"]
            assert len(payload["text"]) <= turn_status.MAX_STATUS_CHARS

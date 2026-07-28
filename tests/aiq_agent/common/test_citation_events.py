"""Tests for the citation-health ledger emitter (``common.citation_events``)."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from aiq_agent.common import citation_events
from aiq_agent.common.citation_events import CitationEvent
from aiq_agent.common.citation_events import build_turn_events
from aiq_agent.common.citation_events import extract_citation_target
from aiq_agent.common.citation_events import normalize_removal_reason
from aiq_agent.common.citation_events import record_empty_registry
from aiq_agent.common.citation_events import record_turn
from aiq_agent.common.citation_events import summarize_removal_reasons
from aiq_agent.common.citation_events import summarize_removed_targets


def _kinds(events: list[CitationEvent]) -> list[str]:
    return [event.kind for event in events]


class TestRemovalReasons:
    """Reason keys are bucketed so the dashboard's breakdown stays bounded."""

    def test_known_reasons_pass_through(self) -> None:
        assert normalize_removal_reason("url_not_in_registry") == "url_not_in_registry"
        assert normalize_removal_reason("citation_key_not_in_registry") == "citation_key_not_in_registry"

    def test_duplicate_reasons_collapse_to_one_bucket(self) -> None:
        """Without this, every citation NUMBER would become its own bucket."""
        assert normalize_removal_reason("duplicate_of_citation_3") == "duplicate"
        assert normalize_removal_reason("duplicate_of_citation_17") == "duplicate"

    def test_blank_reason_falls_back(self) -> None:
        assert normalize_removal_reason("") == "unverifiable"
        assert normalize_removal_reason("   ") == "unverifiable"

    def test_summary_counts_occurrences(self) -> None:
        removed = [
            {"number": 1, "reason": "url_not_in_registry"},
            {"number": 2, "reason": "url_not_in_registry"},
            {"number": 3, "reason": "duplicate_of_citation_1"},
            {"number": 4, "reason": "duplicate_of_citation_2"},
            {"number": 5, "reason": "unverifiable"},
        ]
        assert summarize_removal_reasons(removed) == {
            "url_not_in_registry": 2,
            "duplicate": 2,
            "unverifiable": 1,
        }

    def test_summary_tolerates_malformed_entries(self) -> None:
        assert summarize_removal_reasons([{"number": 1}, "junk"]) == {"unverifiable": 2}  # type: ignore[list-item]


class TestCitationTargets:
    """WHICH source failed — the payload that makes the export diagnosable."""

    def test_url_target_is_extracted_and_trimmed(self) -> None:
        assert extract_citation_target("[3] [Web] Some Title: https://example.test/a/b).") == "https://example.test/a/b"

    def test_document_key_is_extracted_with_its_page(self) -> None:
        assert extract_citation_target("[1] [KB] OIB-RL6-2023.pdf, p.12") == "OIB-RL6-2023.pdf, p.12"
        assert extract_citation_target("- [2] Merkblatt.docx") == "Merkblatt.docx"

    def test_a_url_wins_over_a_filename_in_the_same_line(self) -> None:
        target = extract_citation_target("[1] guide.pdf — https://example.test/guide")
        assert target == "https://example.test/guide"

    def test_a_line_with_no_identifiable_target_records_nothing(self) -> None:
        """No target means no record — answer prose must never leak into the ledger."""
        assert extract_citation_target("[1] Bauordnung für Wien, ein Kommentar") is None
        assert extract_citation_target("") is None
        assert extract_citation_target(None) is None  # type: ignore[arg-type]

    def test_targets_are_paired_with_their_normalized_reason(self) -> None:
        targets = summarize_removed_targets(
            [
                {"number": 1, "line": "[1] https://example.test/a", "reason": "url_not_in_registry"},
                {"number": 2, "line": "[2] OIB-RL6.pdf, p.4", "reason": "duplicate_of_citation_1"},
                {"number": 3, "line": "[3] just a title", "reason": "unverifiable"},
            ]
        )
        assert targets == [
            {"target": "https://example.test/a", "reason": "url_not_in_registry"},
            {"target": "OIB-RL6.pdf, p.4", "reason": "duplicate"},
        ]

    def test_targets_are_capped(self) -> None:
        removed = [{"line": f"[{i}] https://example.test/{i}", "reason": "url_not_in_registry"} for i in range(30)]
        assert len(summarize_removed_targets(removed)) == 10

    def test_removed_citations_event_carries_the_targets(self) -> None:
        events = build_turn_events(
            source_count=3,
            cited_count=0,
            removed_citations=[{"line": "[1] OIB-RL6.pdf, p.4", "reason": "citation_key_not_in_registry"}],
            grounded=False,
            retrieved_source_labels=["OIB-RL2.pdf, p.1"],
        )
        by_kind = {event.kind: event for event in events}
        assert by_kind["citations_removed"].detail["targets"] == [
            {"target": "OIB-RL6.pdf, p.4", "reason": "citation_key_not_in_registry"}
        ]
        # The ungrounded row also records what retrieval DID return, so a
        # diagnosis can tell "nothing relevant found" from "model ignored it".
        assert by_kind["answer_ungrounded"].detail["retrieved_sources"] == ["OIB-RL2.pdf, p.1"]

    def test_quote_event_records_cited_documents_but_never_the_quote(self) -> None:
        events = build_turn_events(
            source_count=1,
            cited_count=1,
            unverified_quote_count=2,
            cited_source_labels=["OIB-RL6.pdf, p.4"],
        )
        detail = next(event for event in events if event.kind == "quote_unverified").detail
        assert detail["cited_sources"] == ["OIB-RL6.pdf, p.4"]
        assert "quote" not in detail and "text" not in detail


class TestBuildTurnEvents:
    """The per-turn event set, which is the ledger's entire vocabulary."""

    def test_clean_turn_emits_only_the_baseline_row(self) -> None:
        """The baseline row is the clean-rate DENOMINATOR — it must always exist."""
        events = build_turn_events(source_count=4, cited_count=3)
        assert _kinds(events) == ["turn_verified"]
        assert events[0].detail["source_count"] == 4
        assert events[0].detail["cited_count"] == 3

    def test_removed_citations_add_a_row_with_reason_counts(self) -> None:
        events = build_turn_events(
            source_count=3,
            cited_count=1,
            removed_citations=[
                {"number": 2, "reason": "url_not_in_registry"},
                {"number": 3, "reason": "url_not_in_registry"},
            ],
        )
        assert _kinds(events) == ["turn_verified", "citations_removed"]
        removed = events[1]
        assert removed.count == 2
        assert removed.reasons == {"url_not_in_registry": 2}

    def test_unverified_quotes_add_a_row_carrying_the_count(self) -> None:
        events = build_turn_events(source_count=2, cited_count=2, unverified_quote_count=3)
        assert "quote_unverified" in _kinds(events)
        assert next(e for e in events if e.kind == "quote_unverified").count == 3

    def test_ungrounded_answer_is_recorded_as_an_error(self) -> None:
        events = build_turn_events(source_count=5, cited_count=0, grounded=False)
        ungrounded = next(e for e in events if e.kind == "answer_ungrounded")
        assert ungrounded.to_payload()["severity"] == "error"
        assert ungrounded.detail["source_count"] == 5

    def test_fallback_and_capped_confidence_are_informational(self) -> None:
        events = build_turn_events(
            source_count=1,
            cited_count=1,
            fallback_used=True,
            confidence_capped_reason="quote_unverified",
        )
        by_kind = {event.kind: event for event in events}
        assert by_kind["citation_fallback"].to_payload()["severity"] == "info"
        assert by_kind["confidence_capped"].reasons == {"quote_unverified": 1}

    def test_a_bad_turn_emits_every_applicable_row_once(self) -> None:
        events = build_turn_events(
            source_count=6,
            cited_count=0,
            removed_citations=[{"reason": "unverifiable"}],
            unverified_quote_count=1,
            grounded=False,
            fallback_used=False,
            confidence_capped_reason="ungrounded",
        )
        assert _kinds(events) == [
            "turn_verified",
            "citations_removed",
            "quote_unverified",
            "answer_ungrounded",
            "confidence_capped",
        ]

    def test_source_mix_is_counted_not_listed(self) -> None:
        """Coarse labels only — no user prose, no per-source rows."""
        events = build_turn_events(
            source_count=3,
            cited_count=2,
            source_origins=["kb", "kb", "ris"],
            source_lanes=["oib", None],
            source_tools=["oib_knowledge_search", "ris_search_tool", None],
        )
        detail = events[0].detail
        assert detail["origins"] == {"kb": 2, "ris": 1}
        assert detail["lanes"] == {"oib": 1}
        assert detail["tools"] == {"oib_knowledge_search": 1, "ris_search_tool": 1}


class TestPayload:
    def test_severity_is_derived_from_the_kind_not_the_caller(self) -> None:
        assert CitationEvent(kind="turn_verified").to_payload()["severity"] == "ok"
        assert CitationEvent(kind="citations_removed").to_payload()["severity"] == "warn"
        assert CitationEvent(kind="registry_empty").to_payload()["severity"] == "error"

    def test_empty_reasons_and_detail_serialize_as_null(self) -> None:
        payload = CitationEvent(kind="turn_verified").to_payload()
        assert payload["reasons"] is None
        assert payload["detail"] is None

    def test_count_never_drops_below_one(self) -> None:
        assert CitationEvent(kind="citations_removed", count=0).to_payload()["count"] == 1


class TestEmission:
    """Transport: identity resolution, opt-out, and the never-raise contract."""

    @pytest.fixture(autouse=True)
    def _no_context(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
        monkeypatch.delenv("GRID_CITATION_EVENTS_ENABLED", raising=False)

    def test_record_turn_posts_one_batch_with_every_event(self) -> None:
        # Dispatch goes through the daemon executor so the answer path is never
        # blocked on the ledger; patch `submit` to observe it deterministically.
        with patch.object(citation_events._post_executor, "submit") as submit:
            payload = record_turn(
                agent="shallow",
                source_count=2,
                cited_count=0,
                grounded=False,
                identity={"organization_id": "org_1", "conversation_id": "conv_1"},
            )
        assert payload is not None
        assert payload["organizationId"] == "org_1"
        assert payload["conversationId"] == "conv_1"
        assert payload["agent"] == "shallow"
        assert [event["kind"] for event in payload["events"]] == ["turn_verified", "answer_ungrounded"]
        submit.assert_called_once_with(citation_events._post_batch, payload)

    def test_turn_id_is_borrowed_from_the_active_profiler(self) -> None:
        """A defect must link back to that turn's execution timeline."""

        class _FakeProfiler:
            organization_id = "org_from_profiler"
            conversation_id = "conv_from_profiler"
            turn_id = "turn-abc"
            job_id = "job-xyz"

        with (
            patch.object(citation_events, "_active_profiler", return_value=_FakeProfiler()),
            patch.object(citation_events, "_read_identity", return_value={}),
        ):
            payload = record_turn(agent="deep", source_count=1, cited_count=1)

        assert payload is not None
        assert payload["turnId"] == "turn-abc"
        assert payload["jobId"] == "job-xyz"
        assert payload["organizationId"] == "org_from_profiler"

    def test_explicit_identity_wins_over_the_profiler(self) -> None:
        class _FakeProfiler:
            organization_id = "org_from_profiler"
            conversation_id = None
            turn_id = "turn-abc"
            job_id = None

        with patch.object(citation_events, "_active_profiler", return_value=_FakeProfiler()):
            payload = record_turn(
                agent="deep",
                source_count=1,
                cited_count=1,
                identity={"organization_id": "org_explicit", "conversation_id": None},
            )
        assert payload is not None
        assert payload["organizationId"] == "org_explicit"

    def test_turn_id_falls_back_to_a_uuid_without_a_profiler(self) -> None:
        with patch.object(citation_events, "_active_profiler", return_value=None):
            payload = record_turn(agent="shallow", source_count=1, cited_count=1, identity={})
        assert payload is not None
        assert len(payload["turnId"]) == 36

    def test_disabling_the_flag_emits_nothing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GRID_CITATION_EVENTS_ENABLED", "false")
        assert record_turn(agent="shallow", source_count=1, cited_count=1, identity={}) is None

    def test_record_empty_registry_emits_the_error_row(self) -> None:
        payload = record_empty_registry(
            agent="deep",
            unavailable_tools=["ris_search_tool"],
            available_count=0,
            identity={},
        )
        assert payload is not None
        assert [event["kind"] for event in payload["events"]] == ["registry_empty"]
        event = payload["events"][0]
        assert event["severity"] == "error"
        assert event["detail"] == {"available_tools": 0, "unavailable_tools": ["ris_search_tool"]}

    def test_a_broken_event_build_never_reaches_the_answer_path(self) -> None:
        """Telemetry failure must be invisible to the user."""
        with patch.object(citation_events, "build_turn_events", side_effect=RuntimeError("boom")):
            assert record_turn(agent="shallow", source_count=1, cited_count=1, identity={}) is None

    def test_a_failing_post_never_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        # No token configured: the batch is dropped with a warning, not an error.
        citation_events._post_batch({"events": [{"kind": "turn_verified"}]})

    def test_post_batch_targets_the_internal_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000/")
        captured: dict[str, Any] = {}

        class _Response:
            status = 202

            def __enter__(self) -> _Response:
                return self

            def __exit__(self, *_: object) -> None:
                return None

        def _urlopen(request: Any, timeout: float) -> _Response:  # noqa: ARG001
            captured["url"] = request.full_url
            captured["token"] = request.headers.get("X-grid-internal-token")
            return _Response()

        with patch("urllib.request.urlopen", _urlopen):
            citation_events._post_batch({"events": [], "turnId": "t"})

        assert captured["url"] == "http://frontend:3000/api/internal/citation-events"
        assert captured["token"] == "test-token"

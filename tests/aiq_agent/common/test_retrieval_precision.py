"""Tests for the ``retrieval_precision`` citation-health event.

The retrieval feedback loop: per research turn, how many of the sources
retrieval returned did the answer actually cite, and which were ignored?
"""

from __future__ import annotations

from aiq_agent.common.citation_events import CitationEvent
from aiq_agent.common.citation_events import build_turn_events


def _precision(events: list[CitationEvent]) -> CitationEvent:
    return next(event for event in events if event.kind == "retrieval_precision")


class TestRetrievalPrecisionEvent:
    def test_emitted_when_retrieved_labels_are_present(self) -> None:
        events = build_turn_events(
            source_count=2,
            cited_count=1,
            retrieved_source_labels=["OIB-RL2.pdf, p.1"],
            cited_source_labels=["OIB-RL2.pdf, p.1"],
        )
        assert [event.kind for event in events] == ["turn_verified", "retrieval_precision"]

    def test_not_emitted_without_retrieved_labels(self) -> None:
        assert "retrieval_precision" not in [e.kind for e in build_turn_events(source_count=0, cited_count=0)]
        not_emitted = build_turn_events(source_count=1, cited_count=0, retrieved_source_labels=[])
        assert "retrieval_precision" not in [e.kind for e in not_emitted]

    def test_overlap_math_dedupes_repeated_labels(self) -> None:
        """Counts are over unique labels; a source cited twice is one source."""
        events = build_turn_events(
            source_count=4,
            cited_count=3,
            retrieved_source_labels=["a.pdf", "b.pdf", "c.pdf", "b.pdf"],
            cited_source_labels=["b.pdf", "c.pdf", "b.pdf", "invented.pdf"],
        )
        detail = _precision(events).detail
        assert detail["retrieved_count"] == 3
        assert detail["cited_count"] == 2
        assert detail["uncited_count"] == 1
        assert detail["uncited_sources"] == ["a.pdf"]

    def test_uncited_sources_preserve_retrieved_order(self) -> None:
        events = build_turn_events(
            source_count=3,
            cited_count=0,
            retrieved_source_labels=["z.pdf", "a.pdf", "m.pdf"],
            cited_source_labels=[],
        )
        assert _precision(events).detail["uncited_sources"] == ["z.pdf", "a.pdf", "m.pdf"]

    def test_uncited_sample_is_capped_at_ten(self) -> None:
        labels = [f"doc-{index}.pdf" for index in range(15)]
        events = build_turn_events(
            source_count=15,
            cited_count=0,
            retrieved_source_labels=labels,
            cited_source_labels=[],
        )
        detail = _precision(events).detail
        assert detail["retrieved_count"] == 15
        assert detail["uncited_count"] == 15
        assert len(detail["uncited_sources"]) == 10
        assert detail["uncited_sources"] == labels[:10]

    def test_everything_cited_reports_zero_uncited(self) -> None:
        events = build_turn_events(
            source_count=2,
            cited_count=2,
            retrieved_source_labels=["a.pdf", "b.pdf"],
            cited_source_labels=["a.pdf", "b.pdf"],
        )
        detail = _precision(events).detail
        assert detail["cited_count"] == 2
        assert detail["uncited_count"] == 0
        assert detail["uncited_sources"] == []

    def test_severity_is_info(self) -> None:
        assert (
            _precision(
                build_turn_events(source_count=1, cited_count=0, retrieved_source_labels=["a.pdf"])
            ).to_payload()["severity"]
            == "info"
        )

    def test_payload_round_trips_through_to_payload(self) -> None:
        events = build_turn_events(
            source_count=2,
            cited_count=1,
            retrieved_source_labels=["a.pdf", "b.pdf"],
            cited_source_labels=["a.pdf"],
        )
        payload = _precision(events).to_payload()
        assert payload == {
            "kind": "retrieval_precision",
            "severity": "info",
            "count": 1,
            "reasons": None,
            "detail": {
                "retrieved_count": 2,
                "cited_count": 1,
                "uncited_count": 1,
                "uncited_sources": ["b.pdf"],
            },
        }

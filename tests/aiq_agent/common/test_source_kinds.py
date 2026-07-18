"""Tests for the canonical source-kind taxonomy and its wire projection.

Locks the core invariant of the source-system redesign: every source resolves
to exactly one of the four coarse kinds, and the OIB corpus and RIS share the
same ``baurecht`` kind (they differ only in the fine lane sub-label).
"""

from __future__ import annotations

import pytest

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import source_entry_to_wire
from aiq_agent.common.source_kinds import DEFAULT_SOURCE_KIND
from aiq_agent.common.source_kinds import SOURCE_KINDS
from aiq_agent.common.source_kinds import kind_for_lane
from aiq_agent.common.source_kinds import source_kind


class TestKindForLane:
    """Fine lane stratum-keys collapse to the four coarse kinds."""

    @pytest.mark.parametrize(
        "lane_key,expected",
        [
            ("baurecht_oib", "baurecht"),
            ("baurecht_oib_leitfaden", "baurecht"),
            ("baurecht_ris", "baurecht"),
            ("baurecht_bund", "baurecht"),
            ("baurecht_land", "baurecht"),
            ("baurecht_verordnung", "baurecht"),
            ("behoerde", "baurecht"),
            ("norm_extern", "baurecht"),
            ("buero", "buero"),
            ("projekt", "projekt"),
            ("web", "web"),
        ],
    )
    def test_lane_maps_to_coarse_kind(self, lane_key: str, expected: str):
        assert kind_for_lane(lane_key) == expected

    def test_unknown_lane_fails_open_to_default(self):
        assert kind_for_lane("something_new") == DEFAULT_SOURCE_KIND

    def test_none_and_empty_fail_open(self):
        assert kind_for_lane(None) == DEFAULT_SOURCE_KIND
        assert kind_for_lane("") == DEFAULT_SOURCE_KIND

    def test_case_insensitive(self):
        assert kind_for_lane("BAURECHT_OIB") == "baurecht"


class TestSourceKindLookup:
    def test_known_kind(self):
        assert source_kind("buero").label == "Büroarchiv"

    def test_unknown_kind_fails_open(self):
        assert source_kind("nope").key == DEFAULT_SOURCE_KIND

    def test_every_kind_is_self_consistent(self):
        for key, kind in SOURCE_KINDS.items():
            assert kind.key == key
            assert kind.label and kind.description and kind.css_token


class TestWireKind:
    """``source_entry_to_wire`` stamps the coarse kind (+ fine lane) on the wire."""

    def test_oib_corpus_is_baurecht(self):
        entry = SourceEntry(citation_key="oib-rl_2_ausgabe_mai_2023.pdf, p.12", source_type="knowledge_layer")
        wire = source_entry_to_wire(entry)
        assert wire["kind"] == "baurecht"
        assert wire["lane"] == "baurecht_oib"
        assert wire["lane_label"] == "OIB-Richtlinie"

    def test_corpus_collection_is_baurecht(self):
        entry = SourceEntry(citation_key="anhang.pdf", collection="oib_knowledge", source_type="knowledge_layer")
        assert source_entry_to_wire(entry)["kind"] == "baurecht"

    def test_ris_url_is_baurecht(self):
        entry = SourceEntry(url="https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR99999999", source_type="generic")
        assert source_entry_to_wire(entry)["kind"] == "baurecht"

    def test_org_archiv_is_buero(self):
        entry = SourceEntry(citation_key="detail.pdf", collection="archiv_org123", source_type="knowledge_layer")
        assert source_entry_to_wire(entry)["kind"] == "buero"

    def test_project_collection_is_projekt(self):
        entry = SourceEntry(citation_key="einreichplan.pdf", collection="proj_abc", source_type="knowledge_layer")
        assert source_entry_to_wire(entry)["kind"] == "projekt"

    def test_web_url_is_web(self):
        entry = SourceEntry(url="https://example.com/artikel", source_type="generic")
        assert source_entry_to_wire(entry)["kind"] == "web"

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
from aiq_agent.common.source_kinds import SHELF_QUALIFIERS
from aiq_agent.common.source_kinds import SOURCE_KINDS
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import kind_for_lane
from aiq_agent.common.source_kinds import legacy_shelf_for_collection_name
from aiq_agent.common.source_kinds import parse_shelf
from aiq_agent.common.source_kinds import scope_for_qualifier
from aiq_agent.common.source_kinds import shelf_for_qualifier
from aiq_agent.common.source_kinds import shelf_qualifier
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


class TestBindingNote:
    """RIS sources catalogued in the norm registry carry their bindingness note."""

    def test_ris_source_matching_registry_gets_binding_note(self):
        # wbtv (document_number LWI40016790) is the entry that makes the OIB
        # Richtlinien binding in Wien — the canonical bindingness fact.
        entry = SourceEntry(
            url="https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=LWI40016790",
            source_type="generic",
        )
        wire = source_entry_to_wire(entry)
        assert wire["kind"] == "baurecht"
        assert "verbindlich" in wire["binding_note"].lower()

    def test_non_ris_source_has_no_binding_note(self):
        entry = SourceEntry(citation_key="oib-rl_2.pdf, p.5", source_type="knowledge_layer")
        assert "binding_note" not in source_entry_to_wire(entry)

    def test_ris_without_registry_match_has_no_binding_note(self):
        entry = SourceEntry(url="https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR99999999", source_type="generic")
        assert "binding_note" not in source_entry_to_wire(entry)


class TestShelf:
    """The shelf — the wire vocabulary of ADR-0047, carried as data."""

    def test_the_enum_holds_exactly_the_four_shelves(self):
        # A fifth member is a wire change: the header, chunk metadata, the
        # citation payload and the TS twin all have to learn it together.
        assert {shelf.value for shelf in Shelf} == {"archiv", "project", "session", "base"}

    @pytest.mark.parametrize(
        "value,expected",
        [
            ("archiv", Shelf.ARCHIV),
            ("project", Shelf.PROJECT),
            ("session", Shelf.SESSION),
            ("base", Shelf.BASE),
            ("  SESSION ", Shelf.SESSION),
            (Shelf.BASE, Shelf.BASE),
        ],
    )
    def test_a_stated_shelf_parses(self, value, expected):
        assert parse_shelf(value) is expected

    @pytest.mark.parametrize("value", [None, "", "projekt", "buero", "baurecht", "proj_alpha", 7, {"shelf": "base"}])
    def test_anything_else_is_unknown_never_base(self, value):
        # The pre-ADR defect: an unrecognised value fell open to `baurecht`, so
        # an unknown document claimed to be authoritative building law.
        assert parse_shelf(value) is None

    def test_every_shelf_renders_a_qualifier(self):
        assert {shelf: shelf_qualifier(shelf) for shelf in Shelf} == SHELF_QUALIFIERS

    def test_a_session_file_is_no_longer_projektwissen(self):
        # The headline bug: a file the user attached privately to a chat was
        # cited as "Projektwissen" because `('s_', 'projekt')` was the only guess.
        assert shelf_qualifier(Shelf.SESSION) == "Private Sitzung"
        assert shelf_qualifier(Shelf.SESSION) != shelf_qualifier(Shelf.PROJECT)

    def test_an_unknown_shelf_renders_unattributed(self):
        assert shelf_qualifier(None) is None
        assert shelf_qualifier("projekt") is None
        assert shelf_qualifier("proj_alpha") is None

    def test_the_qualifier_round_trips(self):
        # A citation key carries the qualifier; resolution parses it back. If
        # these two ever disagree, every qualified key stops resolving.
        for shelf in Shelf:
            assert shelf_for_qualifier(shelf_qualifier(shelf)) is shelf

    def test_qualifiers_are_matched_case_insensitively(self):
        # The qualifier survives a round trip through an LLM, which may recase it.
        assert shelf_for_qualifier("projektwissen") is Shelf.PROJECT
        assert shelf_for_qualifier("  BÜROARCHIV  ") is Shelf.ARCHIV
        assert shelf_for_qualifier("private sitzung") is Shelf.SESSION

    def test_an_unqualified_or_unknown_key_names_no_shelf(self):
        assert shelf_for_qualifier(None) is None
        assert shelf_for_qualifier("Internal") is None

    def test_legacy_qualifier_keys_still_parse_to_the_old_vocabulary(self):
        # Those strings are persisted inside citation keys in existing messages;
        # a reader that stops understanding them silently unresolves them.
        assert scope_for_qualifier("Projektwissen") == "projekt"
        assert scope_for_qualifier("Büroarchiv") == "buero"
        assert scope_for_qualifier("Basiswissen") == "baurecht"
        assert scope_for_qualifier("Internal") is None


class TestLegacyShelfFallback:
    """The one surviving name→shelf guess, kept for pre-ADR-0047 producers."""

    @pytest.mark.parametrize(
        "collection,expected",
        [
            ("archiv_org1", Shelf.ARCHIV),
            ("proj_alpha", Shelf.PROJECT),
            # NOT `project`: a session collection is its own shelf now.
            ("s_9f2a4c", Shelf.SESSION),
        ],
    )
    def test_it_reads_the_known_prefixes(self, collection, expected):
        assert legacy_shelf_for_collection_name(collection) is expected

    @pytest.mark.parametrize("collection", ["oib_knowledge", "some_custom_corpus", "", None])
    def test_it_fails_closed_on_anything_else(self, collection):
        # `collection_scope` returned "baurecht" here, which is the fail-open
        # ADR-0047 calls out: an unknown collection claimed base-law authority.
        assert legacy_shelf_for_collection_name(collection) is None

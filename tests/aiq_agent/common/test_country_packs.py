"""CountryPack contract tests: AT pack vocabulary, resolution, doctrine, id validation."""

from __future__ import annotations

from aiq_agent.common.country_packs import COUNTRY_PACKS
from aiq_agent.common.country_packs import DEFAULT_COUNTRY
from aiq_agent.common.country_packs import get_country_pack
from aiq_agent.common.country_packs.at import BUNDESLAENDER
from aiq_agent.common.country_packs.at import BUNDESLAND_TOKENS
from aiq_agent.common.country_packs.at import AustriaPack
from aiq_agent.common.norm_registry import Edition
from aiq_agent.common.norm_registry import EditionSource
from aiq_agent.common.norm_registry import Jurisdiction
from aiq_agent.common.norm_registry import NormEntry


def _entry(entry_id: str, rank: str = "oib_richtlinie", role: str = "normativ") -> NormEntry:
    return NormEntry(
        id=entry_id,
        title=entry_id,
        short=entry_id,
        rank=rank,
        role=role,
        jurisdiction=Jurisdiction(country="at"),
        editions=[Edition(id="e", label="E", source=EditionSource(kind="corpus", file="f.pdf"))],
    )


class TestPackRegistry:
    def test_at_pack_registered_and_default(self):
        assert DEFAULT_COUNTRY == "at"
        assert get_country_pack("at") is COUNTRY_PACKS["at"]
        assert isinstance(get_country_pack("at"), AustriaPack)

    def test_unknown_country_has_no_pack(self):
        assert get_country_pack("de") is None
        assert get_country_pack(None) is None
        assert get_country_pack("") is None


class TestAtPackVocabulary:
    def test_states_cover_all_bundeslaender_plus_outside_sentinel(self):
        pack = get_country_pack("at")
        assert set(pack.state_order) == set(BUNDESLAENDER)
        assert set(pack.states) == set(BUNDESLAND_TOKENS)
        assert pack.states["ausserhalb_oesterreichs"] is None

    def test_token_name_roundtrip(self):
        pack = get_country_pack("at")
        for token, name in BUNDESLAND_TOKENS.items():
            assert pack.state_token_to_name(token) == name
            if name:
                assert pack.state_name_to_token(name) == token

    def test_none_and_unknown_tokens(self):
        pack = get_country_pack("at")
        assert pack.state_token_to_name(None) is None
        assert pack.state_token_to_name("bayern") is None
        assert pack.state_name_to_token(None) is None
        assert pack.state_name_to_token("Bayern") is None


class TestAtPackResolution:
    def test_extract_state_structured_line_wins_over_name_probe(self):
        pack = get_country_pack("at")
        # "Wiener Neustadt" is in Niederösterreich: the structured token must win.
        assert pack.extract_state("- bundesland=niederoesterreich\nProjekt in Wiener Neustadt") == "Niederösterreich"

    def test_extract_state_name_probing_tolerates_umlaut_variants(self):
        pack = get_country_pack("at")
        assert pack.extract_state("Bauvorhaben in Niederoesterreich") == "Niederösterreich"
        assert pack.extract_state("Grundstück in Kärnten") == "Kärnten"

    def test_extract_state_none_without_signal(self):
        pack = get_country_pack("at")
        assert pack.extract_state(None) is None
        assert pack.extract_state("") is None
        assert pack.extract_state("ein Haus") is None

    def test_outside_sentinel_is_final_none(self):
        pack = get_country_pack("at")
        assert pack.extract_state("- bundesland=ausserhalb_oesterreichs") is None


class TestAtPackDoctrine:
    def test_doctrine_lines_match_lane_block_header(self):
        lines = get_country_pack("at").doctrine_lines()
        assert any("norm registry" in line for line in lines)
        assert any("do NOT use RIS search" in line for line in lines)
        assert any("OIB-RL <N>" in line for line in lines)


class TestAtPackIdValidation:
    def test_oib_family_child_without_base_is_a_violation(self):
        pack = get_country_pack("at")
        entries = [_entry("oib-rl-2-leitfaden", rank="oib_leitfaden", role="anwendend")]
        problems = pack.validate_ids(entries)
        assert problems == ["entry 'oib-rl-2-leitfaden' has no base entry 'oib-rl-2'"]

    def test_oib_family_with_base_is_valid(self):
        pack = get_country_pack("at")
        entries = [
            _entry("oib-rl-2"),
            _entry("oib-rl-2-leitfaden", rank="oib_leitfaden", role="anwendend"),
            _entry("oib-rl-2-erlaeuterungen", rank="oib_erklaerung", role="erklaerend"),
        ]
        assert pack.validate_ids(entries) == []

    def test_non_oib_ids_are_not_checked(self):
        pack = get_country_pack("at")
        entries = [_entry("bo-wien", rank="landesgesetz"), _entry("wbtv", rank="verordnung")]
        assert pack.validate_ids(entries) == []

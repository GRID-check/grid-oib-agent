"""Tests for the NormReference trust-chain resolver (norm-registry Phase 5)."""

import pytest

from aiq_agent.common import norm_registry as nr
from aiq_agent.common.norm_resolution import ResolvedNorm
from aiq_agent.common.norm_resolution import resolve_norm_reference


def _edition(edition_id: str, label: str, status: str = "current", role: str | None = None) -> nr.Edition:
    return nr.Edition(
        id=edition_id,
        label=label,
        status=status,
        role=role,
        source=nr.EditionSource(kind="corpus", file=f"{edition_id}.pdf"),
    )


def _rl2() -> nr.NormEntry:
    return nr.NormEntry(
        id="oib-rl-2",
        title="Brandschutz",
        short="OIB-RL 2",
        rank="oib_richtlinie",
        role="normativ",
        jurisdiction=nr.Jurisdiction(country="at", state=None),
        aliases=["OIB-Richtlinie 2", "RL 2", "Brandschutzrichtlinie"],
        editions=[
            _edition("2023-05", "Ausgabe Mai 2023"),
            _edition("2019-04", "Ausgabe April 2019", status="superseded"),
        ],
    )


def _rl2_leitfaden() -> nr.NormEntry:
    return nr.NormEntry(
        id="oib-rl-2-leitfaden",
        title="Brandschutz — Leitfaden",
        short="OIB-RL 2 Leitfaden",
        rank="oib_leitfaden",
        role="anwendend",
        jurisdiction=nr.Jurisdiction(country="at", state=None),
        aliases=["Leitfaden Brandschutz"],
        editions=[_edition("2023-05", "Ausgabe Mai 2023")],
    )


def _wbtv() -> nr.NormEntry:
    return nr.NormEntry(
        id="wbtv",
        title="Wiener Bautechnikverordnung 2023",
        short="WBTV 2023",
        rank="verordnung",
        role="normativ",
        jurisdiction=nr.Jurisdiction(country="at", state="wien"),
        aliases=["WBTV", "Bautechnikverordnung"],
        editions=[
            nr.Edition(
                id="konsolidiert",
                label="Konsolidierte Fassung (laufend)",
                status="current",
                source=nr.EditionSource(kind="ris", application="LrKons", document_number="LWI40016790"),
            )
        ],
        relations=[nr.Relation(type="declares_binding", target="oib-rl-2", edition="2023-05", status="verified")],
    )


@pytest.fixture
def registry() -> nr.NormRegistry:
    return nr.NormRegistry(entries=[_rl2(), _rl2_leitfaden(), _wbtv()])


class TestDocumentMatching:
    def test_alias_match(self, registry):
        resolved = resolve_norm_reference("OIB-Richtlinie 2", None, registry)
        assert resolved is not None
        assert resolved.norm_id == "oib-rl-2"
        assert resolved.rank == "oib_richtlinie"

    def test_short_match(self, registry):
        assert resolve_norm_reference("OIB-RL 2 Leitfaden", None, registry).norm_id == "oib-rl-2-leitfaden"

    def test_umlaut_and_case_normalized(self, registry):
        assert resolve_norm_reference("bautechnikverordnung", None, registry).norm_id == "wbtv"

    def test_unknown_document_returns_none(self, registry):
        assert resolve_norm_reference("ÖNORM B 9999", None, registry) is None

    def test_most_specific_match_wins(self, registry):
        # "OIB-RL 2 Leitfaden" contains "OIB-RL 2" — the leitfaden entry must win.
        resolved = resolve_norm_reference("OIB-RL 2 Leitfaden", "Ausgabe Mai 2023", registry)
        assert resolved.norm_id == "oib-rl-2-leitfaden"
        assert resolved.binding == "anwendend"


class TestEditionAndBinding:
    def test_edition_label_match(self, registry):
        resolved = resolve_norm_reference("OIB-RL 2", "Ausgabe Mai 2023", registry)
        assert resolved.binding == "normativ"

    def test_superseded_edition_still_resolves(self, registry):
        resolved = resolve_norm_reference("OIB-RL 2", "Ausgabe April 2019", registry)
        assert resolved is not None
        assert resolved.norm_id == "oib-rl-2"

    def test_konsolidiert_label(self, registry):
        resolved = resolve_norm_reference("WBTV 2023", "Konsolidierte Fassung", registry)
        assert resolved is not None
        assert resolved.binding == "normativ"

    def test_diff_edition_override_gives_no_binding(self, registry):
        rl2 = _rl2()
        rl2.editions.append(_edition("2023-05-aenderungen", "Änderungen Ausgabe Mai 2023", role="diff"))
        reg = nr.NormRegistry(entries=[rl2])
        resolved = resolve_norm_reference("OIB-RL 2", "Änderungen Ausgabe Mai 2023", reg)
        assert resolved is not None
        assert resolved.binding is None


class TestVia:
    def test_via_from_verified_declares_binding(self, registry):
        resolved = resolve_norm_reference("OIB-RL 2", None, registry, bundesland="wien")
        assert resolved.via == "WBTV 2023"

    def test_via_prefers_bundesland_match(self, registry):
        stmk = nr.NormEntry(
            id="bautechnikgesetz-stmk",
            title="Stmk Bautechnikgesetz",
            short="BauTG Stmk",
            rank="landesgesetz",
            role="normativ",
            jurisdiction=nr.Jurisdiction(country="at", state="steiermark"),
            relations=[nr.Relation(type="declares_binding", target="oib-rl-2", edition="2023-05", status="verified")],
        )
        reg = nr.NormRegistry(entries=[*_rl2_entries(), _wbtv(), stmk])
        assert resolve_norm_reference("OIB-RL 2", None, reg, bundesland="steiermark").via == "BauTG Stmk"
        assert resolve_norm_reference("OIB-RL 2", None, reg, bundesland="wien").via == "WBTV 2023"

    def test_unknown_relation_status_gives_no_via(self, registry):
        wbtv = _wbtv()
        wbtv.relations[0].status = "unknown"
        reg = nr.NormRegistry(entries=[_rl2(), wbtv])
        assert resolve_norm_reference("OIB-RL 2", None, reg, bundesland="wien").via is None


def _rl2_entries():
    return [_rl2(), _rl2_leitfaden()]


def test_resolved_norm_is_frozen():
    resolved = ResolvedNorm(norm_id="oib-rl-2", rank="oib_richtlinie", binding="normativ", via=None)
    with pytest.raises(AttributeError):
        resolved.norm_id = "other"

"""Tests for the norm registry (aiq_agent.common.norm_registry)."""

from pathlib import Path

import pytest
import yaml

from aiq_agent.common import norm_registry as nr
from aiq_agent.common.ris_catalog import catalog_from_registry


def _ris_edition(application: str = "LrKons", document_number: str = "NOR12345678") -> dict:
    return {
        "id": "konsolidiert",
        "label": "Konsolidierte Fassung (laufend)",
        "status": "current",
        "source": {
            "kind": "ris",
            "application": application,
            "document_number": document_number,
            "citation_url": "https://www.ris.bka.gv.at/eli/lgbl/WI/1930/11",
            "full_law_url": "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=1",
        },
    }


def _corpus_editions() -> list[dict]:
    return [
        {
            "id": "2023-05",
            "label": "Ausgabe Mai 2023",
            "status": "current",
            "source": {"kind": "corpus", "file": "oib-rl_2_ausgabe_mai_2023.pdf"},
        },
        {
            "id": "2023-05-aenderungen",
            "label": "Änderungen Ausgabe Mai 2023",
            "status": "current",
            "role": "diff",
            "source": {"kind": "corpus", "file": "aenderungen_oib-rl_2_ausgabe_mai_2023.pdf"},
        },
    ]


def _entry(entry_id: str, **overrides) -> dict:
    base = {
        "id": entry_id,
        "title": f"Title {entry_id}",
        "short": entry_id.upper(),
        "rank": "landesgesetz",
        "role": "normativ",
        "jurisdiction": {"country": "at", "state": "wien"},
        "topics": ["bauordnung"],
        "relevance": "test",
        "editions": [_ris_edition()],
        "verified_at": "2026-07-17",
    }
    base.update(overrides)
    return base


def _write_registry(norms_dir: Path, country: str, entries: list[dict]) -> Path:
    country_dir = norms_dir / country
    country_dir.mkdir(parents=True, exist_ok=True)
    path = country_dir / "registry.yml"
    payload = {"version": 1, "country": country, "entries": entries}
    path.write_text(yaml.safe_dump(payload, allow_unicode=True), encoding="utf-8")
    return path


@pytest.fixture(autouse=True)
def _clean_cache():
    nr.reset_registry_cache()
    yield
    nr.reset_registry_cache()


class _StubPack:
    """Minimal CountryPack for fictional countries in loader tests."""

    def __init__(self, country: str, states: dict[str, str | None] | None = None):
        self.country = country
        self.states = states or {}
        self.state_order = ()

    def state_token_to_name(self, token):
        return self.states.get(token)

    def state_name_to_token(self, name):
        return next((token for token, state in self.states.items() if state == name), None)

    def extract_state(self, text):
        return None

    def resolve_state(self, text):
        return None

    def doctrine_lines(self):
        return []

    def validate_ids(self, entries):
        return []


@pytest.fixture
def _de_pack(monkeypatch):
    """Registers a stub pack for 'de' so multi-country loader tests pass pack validation."""
    from aiq_agent.common.country_packs import COUNTRY_PACKS

    monkeypatch.setitem(COUNTRY_PACKS, "de", _StubPack("de", {"bayern": "Bayern"}))


class TestSchema:
    def test_minimal_entry_validates(self):
        entry = nr.NormEntry.model_validate(_entry("bo-wien"))

        assert entry.rank == "landesgesetz"
        assert entry.role == "normativ"
        assert entry.editions[0].source.kind == "ris"

    def test_invalid_rank_rejected(self):
        with pytest.raises(Exception, match="rank"):
            nr.NormEntry.model_validate(_entry("x", rank="kaiserlicher_erlass"))

    def test_relation_types_restricted(self):
        with pytest.raises(Exception, match="type"):
            nr.NormEntry.model_validate(_entry("x", relations=[{"type": "interpreted_by", "target": "y"}]))

    def test_applicability_rule_requires_both_reasons(self):
        rule = {
            "when": {"all": [{"fact": "hauptnutzung", "op": "eq", "value": "wohnen"}]},
            "verdict": "required",
            "reason_de": "Pflicht",
        }
        with pytest.raises(Exception, match="reason_en"):
            nr.NormEntry.model_validate(_entry("x", applicability=[rule]))

    def test_edition_role_override(self):
        entry = nr.NormEntry.model_validate(_entry("oib-rl-2", rank="oib_richtlinie", editions=_corpus_editions()))

        assert entry.editions[1].role == "diff"


class TestLoader:
    def test_merges_country_dirs(self, tmp_path, _de_pack):
        _write_registry(tmp_path, "at", [_entry("bo-wien")])
        _write_registry(tmp_path, "de", [_entry("mbo", jurisdiction={"country": "de", "state": None})])

        registry = nr.load_registry(str(tmp_path), strict=True)

        assert registry is not None
        assert {e.id for e in registry.entries} == {"bo-wien", "mbo"}

    def test_country_mismatch_entry_dropped(self, tmp_path, caplog):
        _write_registry(tmp_path, "at", [_entry("bo-wien"), _entry("fremd", jurisdiction={"country": "de"})])

        registry = nr.load_registry(str(tmp_path))

        assert registry is not None
        assert [e.id for e in registry.entries] == ["bo-wien"]

    def test_duplicate_id_first_wins(self, tmp_path, caplog, _de_pack):
        _write_registry(tmp_path, "at", [_entry("dup", title="AT title")])
        _write_registry(tmp_path, "de", [_entry("dup", title="DE title", jurisdiction={"country": "de"})])

        registry = nr.load_registry(str(tmp_path))

        assert registry is not None
        assert registry.by_id("dup").title == "AT title"  # sorted glob: at/ before de/, first wins

    def test_missing_dir_fails_open(self, tmp_path):
        assert nr.load_registry(str(tmp_path / "nope")) is None
        with pytest.raises(ValueError, match="no registry files"):
            nr.load_registry(str(tmp_path / "nope"), strict=True)

    def test_invalid_file_skipped(self, tmp_path, _de_pack):
        bad_dir = tmp_path / "at"
        bad_dir.mkdir()
        (bad_dir / "registry.yml").write_text("not: [valid", encoding="utf-8")
        _write_registry(tmp_path, "de", [_entry("mbo", jurisdiction={"country": "de"})])

        registry = nr.load_registry(str(tmp_path))

        assert registry is not None
        assert [e.id for e in registry.entries] == ["mbo"]

    def test_env_var_honored(self, tmp_path, monkeypatch):
        _write_registry(tmp_path, "at", [_entry("bo-wien")])
        monkeypatch.setenv(nr.ENV_NORMS_DIR, str(tmp_path))

        registry = nr.load_registry()

        assert registry is not None
        assert registry.by_id("bo-wien") is not None

    def test_id_convention_strict_raises_non_strict_disables(self, tmp_path):
        _write_registry(tmp_path, "at", [_entry("oib-rl-9-leitfaden", rank="oib_leitfaden", role="anwendend")])

        with pytest.raises(ValueError, match="id-convention"):
            nr.load_registry(str(tmp_path), strict=True)
        assert nr.load_registry(str(tmp_path)) is None

    def test_family_with_base_entry_ok(self, tmp_path):
        _write_registry(
            tmp_path,
            "at",
            [
                _entry("oib-rl-2", rank="oib_richtlinie", editions=_corpus_editions()),
                _entry("oib-rl-2-leitfaden", rank="oib_leitfaden", role="anwendend", editions=_corpus_editions()),
            ],
        )

        registry = nr.load_registry(str(tmp_path), strict=True)

        assert registry is not None
        assert len(registry.entries) == 2

    def test_unknown_country_entry_dropped_runtime_strict_raises(self, tmp_path):
        _write_registry(tmp_path, "de", [_entry("mbo", jurisdiction={"country": "de", "state": None})])

        assert nr.load_registry(str(tmp_path)) is None  # only entry dropped -> empty registry
        with pytest.raises(ValueError, match="country-pack"):
            nr.load_registry(str(tmp_path), strict=True)

    def test_unknown_state_token_dropped_runtime_strict_raises(self, tmp_path):
        _write_registry(
            tmp_path,
            "at",
            [_entry("fremd", jurisdiction={"country": "at", "state": "bayern"}), _entry("bo-wien")],
        )

        registry = nr.load_registry(str(tmp_path))

        assert registry is not None
        assert [e.id for e in registry.entries] == ["bo-wien"]
        with pytest.raises(ValueError, match="country-pack"):
            nr.load_registry(str(tmp_path), strict=True)

    def test_stub_pack_state_vocabulary_enforced(self, tmp_path, _de_pack):
        _write_registry(tmp_path, "de", [_entry("mbo", jurisdiction={"country": "de", "state": "wien"})])

        with pytest.raises(ValueError, match="country-pack"):
            nr.load_registry(str(tmp_path), strict=True)

    def test_resolve_country_defaults_to_at_and_parses_fact(self):
        assert nr.resolve_country(None) == "at"
        assert nr.resolve_country("kein Laenderbezug") == "at"
        assert nr.resolve_country("- country=de") == "de"


class TestMatching:
    def _registry(self) -> nr.NormRegistry:
        return nr.NormRegistry(
            entries=[
                nr.NormEntry.model_validate(
                    _entry("garagengesetz-wien", aliases=["Wiener Garagengesetz"], topics=["garage", "stellplatz"])
                ),
                nr.NormEntry.model_validate(_entry("bo-tirol", jurisdiction={"country": "at", "state": "tirol"})),
                nr.NormEntry.model_validate(
                    _entry("aschg", rank="bundesgesetz", jurisdiction={"country": "at", "state": None})
                ),
            ]
        )

    def test_match_on_alias_and_topic(self):
        registry = self._registry()

        assert [e.id for e in nr.match_entries(registry, "Was sagt das Wiener Garagengesetz?")] == [
            "garagengesetz-wien"
        ]
        assert [e.id for e in nr.match_entries(registry, "Stellplatzpflicht in Wien")] == ["garagengesetz-wien"]

    def test_short_terms_never_match(self):
        registry = self._registry()

        assert nr.match_entries(registry, "bo") == []

    def test_focus_drops_other_states(self):
        registry = self._registry()
        matches = [e for e in registry.entries]

        focused = nr.focus_entries(matches, "Wien")

        assert [e.id for e in focused] == ["garagengesetz-wien", "aschg"]

    def test_focus_noop_without_bundesland(self):
        registry = self._registry()

        assert nr.focus_entries(list(registry.entries), None) == list(registry.entries)

    def test_state_token_name_roundtrip(self):
        assert nr.state_token_to_name("wien") == "Wien"
        assert nr.state_name_to_token("Wien") == "wien"
        assert nr.state_token_to_name("ausserhalb_oesterreichs") is None
        assert nr.state_name_to_token("Atlantis") is None


class TestRenderPromptBlock:
    def _registry(self) -> nr.NormRegistry:
        entries = [
            _entry("aschg", rank="bundesgesetz", jurisdiction={"country": "at", "state": None}),
            _entry("astv", rank="verordnung", jurisdiction={"country": "at", "state": None}),
            _entry("bo-wien", short="BO Wien"),
            _entry("bo-tirol", short="BO Tirol", jurisdiction={"country": "at", "state": "tirol"}),
            _entry(
                "oib-rl-2",
                rank="oib_richtlinie",
                short="OIB-RL 2",
                title="Brandschutz",
                jurisdiction={"country": "at", "state": None},
                editions=_corpus_editions(),
            ),
            _entry(
                "oib-rl-2-leitfaden",
                rank="oib_leitfaden",
                role="anwendend",
                short="Leitfaden RL 2",
                jurisdiction={"country": "at", "state": None},
                editions=_corpus_editions(),
            ),
            _entry(
                "oib-rl-zitierte-normen",
                rank="oib_referenz",
                short="Zitierte Normen",
                jurisdiction={"country": "at", "state": None},
                editions=_corpus_editions(),
            ),
            _entry(
                "oenorm-b-1600",
                rank="norm_extern",
                short="ÖNORM B 1600",
                jurisdiction={"country": "at", "state": None},
                editions=[],
                access={"kind": "unavailable", "note": "Bezugsnorm"},
            ),
        ]
        return nr.NormRegistry(entries=[nr.NormEntry.model_validate(e) for e in entries])

    def test_lane_order_and_state_focus(self):
        block = nr.render_prompt_block(self._registry(), bundesland="Tirol")

        assert block.index("Bundesrecht:") < block.index("Landesrecht — Tirol:")
        assert block.index("Landesrecht — Tirol:") < block.index("Landesrecht — Wien (other state):")
        assert block.index("Landesrecht — Wien (other state):") < block.index("OIB-Richtlinien")
        assert block.index("OIB-Richtlinien") < block.index("OIB-Referenzdokumente:")
        assert block.index("OIB-Referenzdokumente:") < block.index("Externe Normen")

    def test_oib_family_children_and_edition_labels(self):
        block = nr.render_prompt_block(self._registry(), bundesland=None)

        rl_line = block.index("- OIB-RL 2 — Brandschutz [normativ, Ausgabe Mai 2023]")
        child_line = block.index("- Leitfaden RL 2 [anwendend, Ausgabe Mai 2023]")
        assert rl_line < child_line
        assert "Änderungen Ausgabe Mai 2023" not in block  # diff edition never surfaced as citable

    def test_render_block_for_prompt_none_when_missing(self, tmp_path):
        assert nr.render_block_for_prompt(None, norms_dir=str(tmp_path / "nope")) is None


class TestCatalogFlatten:
    def test_only_ris_entries_flatten(self):
        entries = [
            nr.NormEntry.model_validate(_entry("bo-wien")),
            nr.NormEntry.model_validate(
                _entry(
                    "oib-rl-2",
                    rank="oib_richtlinie",
                    jurisdiction={"country": "at", "state": None},
                    editions=_corpus_editions(),
                )
            ),
        ]
        registry = nr.NormRegistry(entries=entries)

        catalog = catalog_from_registry(registry)

        assert [e.id for e in catalog.entries] == ["bo-wien"]
        assert catalog.entries[0].bundesland == "Wien"
        assert catalog.entries[0].document_number == "NOR12345678"


class TestDefaultNormFilters:
    def _rl2(self, editions, relations=None, state=None):
        return nr.NormEntry(
            id="oib-rl-2",
            title="Brandschutz",
            short="OIB-RL 2",
            rank="oib_richtlinie",
            role="normativ",
            jurisdiction=nr.Jurisdiction(country="at", state=state),
            editions=editions,
            relations=relations or [],
        )

    def _corpus(self, edition_id, status):
        return nr.Edition(
            id=edition_id,
            label=f"Ausgabe {edition_id}",
            status=status,
            source=nr.EditionSource(kind="corpus", file=f"oib-rl_2_{edition_id}.pdf"),
        )

    def test_none_registry_returns_none(self):
        assert nr.default_norm_filters(None) is None

    def test_current_only_registry_excludes_diff(self):
        registry = nr.NormRegistry(entries=[self._rl2([self._corpus("2023-05", "current")])])
        assert nr.default_norm_filters(registry) == {"$and": [{"role": {"$nin": ["diff"]}}]}

    def test_superseded_without_verified_binding_is_excluded_flat(self):
        entry = self._rl2([self._corpus("2019-04", "superseded"), self._corpus("2023-05", "current")])
        filters = nr.default_norm_filters(nr.NormRegistry(entries=[entry]))
        assert filters == {"$and": [{"role": {"$nin": ["diff"]}}, {"edition_status": {"$nin": ["superseded"]}}]}

    def test_verified_binding_spares_superseded_edition(self):
        entry = self._rl2([self._corpus("2019-04", "superseded"), self._corpus("2023-05", "current")])
        wbtv = nr.NormEntry(
            id="wbtv",
            title="Wiener Bautechnikverordnung",
            short="WBTV",
            rank="verordnung",
            role="normativ",
            jurisdiction=nr.Jurisdiction(country="at", state="wien"),
            editions=[],
            relations=[nr.Relation(type="declares_binding", target="oib-rl-2", edition="2019-04", status="verified")],
        )
        filters = nr.default_norm_filters(nr.NormRegistry(entries=[entry, wbtv]))
        assert filters == {
            "$and": [
                {"role": {"$nin": ["diff"]}},
                {"$or": [{"edition_status": {"$ne": "superseded"}}, {"doc_id": "oib-rl-2", "edition": "2019-04"}]},
            ]
        }

    def test_unknown_binding_status_is_ignored(self):
        entry = self._rl2([self._corpus("2019-04", "superseded"), self._corpus("2023-05", "current")])
        wbtv = nr.NormEntry(
            id="wbtv",
            title="WBTV",
            short="WBTV",
            rank="verordnung",
            role="normativ",
            jurisdiction=nr.Jurisdiction(country="at", state="wien"),
            editions=[],
            relations=[nr.Relation(type="declares_binding", target="oib-rl-2", edition="2019-04", status="unknown")],
        )
        filters = nr.default_norm_filters(nr.NormRegistry(entries=[entry, wbtv]), bundesland="wien")
        assert filters == {"$and": [{"role": {"$nin": ["diff"]}}, {"edition_status": {"$nin": ["superseded"]}}]}

    def test_jurisdiction_preference_restricts_doc_to_bound_edition(self):
        entry = self._rl2([self._corpus("2019-04", "superseded"), self._corpus("2023-05", "current")])
        wbtv = nr.NormEntry(
            id="wbtv",
            title="WBTV",
            short="WBTV",
            rank="verordnung",
            role="normativ",
            jurisdiction=nr.Jurisdiction(country="at", state="wien"),
            editions=[],
            relations=[nr.Relation(type="declares_binding", target="oib-rl-2", edition="2019-04", status="verified")],
        )
        filters = nr.default_norm_filters(nr.NormRegistry(entries=[entry, wbtv]), bundesland="wien")
        assert {
            "$or": [{"doc_id": {"$ne": "oib-rl-2"}}, {"doc_id": "oib-rl-2", "edition": {"$in": ["2019-04"]}}]
        } in filters["$and"]

    def test_binding_from_other_state_does_not_restrict_jurisdiction(self):
        entry = self._rl2([self._corpus("2019-04", "superseded"), self._corpus("2023-05", "current")])
        stmk_law = nr.NormEntry(
            id="bpg-stmk",
            title="Stmk Baugesetz",
            short="Stmk BauG",
            rank="landesgesetz",
            role="normativ",
            jurisdiction=nr.Jurisdiction(country="at", state="steiermark"),
            editions=[],
            relations=[nr.Relation(type="declares_binding", target="oib-rl-2", edition="2019-04", status="verified")],
        )
        filters = nr.default_norm_filters(nr.NormRegistry(entries=[entry, stmk_law]), bundesland="wien")
        # Other-state binding still spares the edition from exclusion (any-state rule)...
        spare = {"$or": [{"edition_status": {"$ne": "superseded"}}, {"doc_id": "oib-rl-2", "edition": "2019-04"}]}
        assert spare in filters["$and"]
        # ...but no jurisdiction restriction for wien.
        assert not any(
            isinstance(clause, dict) and clause.get("$or") and clause["$or"][0].get("doc_id") == {"$ne": "oib-rl-2"}
            for clause in filters["$and"]
        )

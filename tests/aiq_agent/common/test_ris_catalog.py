"""Tests for the curated RIS catalog (aiq_agent.common.ris_catalog)."""

from pathlib import Path

import pytest
import yaml

from aiq_agent.common.ris_catalog import KNOWN_APPLICATIONS
from aiq_agent.common.ris_catalog import CatalogEntry
from aiq_agent.common.ris_catalog import RisCatalog
from aiq_agent.common.ris_catalog import _normalize
from aiq_agent.common.ris_catalog import extract_bundesland
from aiq_agent.common.ris_catalog import load_catalog
from aiq_agent.common.ris_catalog import match_entries
from aiq_agent.common.ris_catalog import render_block_for_prompt
from aiq_agent.common.ris_catalog import render_prompt_block
from aiq_agent.common.ris_catalog import reset_catalog_cache


def _entry(**overrides) -> dict:
    base = {
        "id": "bo-wien",
        "title": "Bauordnung für Wien",
        "short": "BO Wien",
        "application": "LrKons",
        "document_number": "NOR12345678",
        "citation_url": "https://www.ris.bka.gv.at/eli/lgbl/WI/bo-wien",
        "full_law_url": "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=1",
        "bundesland": "Wien",
        "topics": ["bauordnung", "bauantrag", "baugebühr"],
        "relevance": "State building code for Vienna",
        "verified_at": "2026-07-16",
    }
    base.update(overrides)
    return base


def _write_catalog(tmp_path: Path, entries: list[dict]) -> str:
    path = tmp_path / "ris_catalog.yml"
    path.write_text(
        yaml.safe_dump({"version": 1, "entries": entries}, allow_unicode=True),
        encoding="utf-8",
    )
    return str(path)


@pytest.fixture(autouse=True)
def _clear_cache():
    reset_catalog_cache()
    yield
    reset_catalog_cache()


class TestLoadCatalog:
    def test_loads_valid_catalog(self, tmp_path):
        path = _write_catalog(tmp_path, [_entry()])

        catalog = load_catalog(path)

        assert catalog is not None
        assert catalog.version == 1
        assert len(catalog.entries) == 1
        assert catalog.entries[0].document_number == "NOR12345678"

    def test_missing_file_returns_none(self, tmp_path):
        assert load_catalog(str(tmp_path / "nope.yml")) is None

    def test_invalid_yaml_returns_none(self, tmp_path):
        path = tmp_path / "broken.yml"
        path.write_text("entries: [{{{{", encoding="utf-8")

        assert load_catalog(str(path)) is None

    def test_schema_violation_returns_none(self, tmp_path):
        path = tmp_path / "ris_catalog.yml"
        path.write_text(yaml.safe_dump({"version": 1, "entries": [{}]}), encoding="utf-8")

        assert load_catalog(str(path)) is None

    def test_unknown_application_entries_dropped(self, tmp_path):
        path = _write_catalog(
            tmp_path,
            [_entry(id="ok"), _entry(id="bad", application="FooBar")],
        )

        catalog = load_catalog(path)

        assert catalog is not None
        assert [entry.id for entry in catalog.entries] == ["ok"]

    def test_caches_by_path_and_mtime(self, tmp_path):
        path = _write_catalog(tmp_path, [_entry()])

        first = load_catalog(path)
        second = load_catalog(path)

        assert first is second

        # Regenerating the file (new mtime) picks up the new content.
        _write_catalog(tmp_path, [_entry(), _entry(id="aschg", application="BrKons", bundesland="")])
        third = load_catalog(path)

        assert third is not None
        assert len(third.entries) == 2


class TestNormalize:
    def test_expands_umlauts_and_lowercases(self):
        assert _normalize("  Baugebühr für Kärnten  ") == "baugebuehr fuer kaernten"


class TestMatchEntries:
    def _catalog(self) -> RisCatalog:
        return RisCatalog(entries=[CatalogEntry(**_entry())])

    def test_matches_topic_term(self):
        matches = match_entries(self._catalog(), "Wo reiche ich den Bauantrag in Wien ein?")

        assert [m.id for m in matches] == ["bo-wien"]

    def test_matches_title(self):
        matches = match_entries(self._catalog(), "Was sagt die Bauordnung für Wien zu Fluchtwegen?")

        assert [m.id for m in matches] == ["bo-wien"]

    def test_umlaut_spelling_variant_matches(self):
        matches = match_entries(self._catalog(), "Baugebuehr Wien?")

        assert [m.id for m in matches] == ["bo-wien"]

    def test_no_match_returns_empty(self):
        assert match_entries(self._catalog(), "Wetter in Salzburg") == []

    def test_short_terms_are_ignored(self):
        catalog = RisCatalog(entries=[CatalogEntry(**_entry(topics=["bö"]))])

        assert match_entries(catalog, "das bö hier") == []

    def test_empty_query_returns_empty(self):
        assert match_entries(self._catalog(), "   ") == []


class TestExtractBundesland:
    def test_detects_state_in_project_context(self):
        assert extract_bundesland("Projektstandort: Wien, Österreich\nNutzung: Büro") == "Wien"

    def test_detects_adjective_form(self):
        assert extract_bundesland("Das Tiroler Bauvorhaben ...") == "Tirol"

    def test_none_or_empty_context(self):
        assert extract_bundesland(None) is None
        assert extract_bundesland("") is None

    def test_no_state_present(self):
        assert extract_bundesland("Bürogebäude, 5 Geschoße") is None


class TestRenderPromptBlock:
    def _catalog(self) -> RisCatalog:
        return RisCatalog(
            entries=[
                CatalogEntry(**_entry(id="aschg", title="ArbeitnehmerInnenschutzgesetz", short="ASchG",
                                      application="BrKons", bundesland="")),
                CatalogEntry(**_entry(id="bo-tirol", title="Tiroler Bauordnung", short="BO Tirol",
                                      bundesland="Tirol")),
                CatalogEntry(**_entry(id="bo-wien")),
            ]
        )

    def test_contains_all_entries_and_usage_hint(self):
        block = render_prompt_block(self._catalog())

        assert "Curated RIS index" in block
        assert "ris_catalog_lookup" in block
        assert block.count("[") >= 3
        assert "NOR12345678" in block
        assert "Gesamt: https://www.ris.bka.gv.at/GeltendeFassung.wxe" in block

    def test_federal_first_then_project_state_then_rest(self):
        block = render_prompt_block(self._catalog(), bundesland="Wien")

        assert block.index("ASchG") < block.index("bo-wien") < block.index("bo-tirol")

    def test_without_bundesland_states_sort_alphabetically(self):
        block = render_prompt_block(self._catalog())

        assert block.index("ASchG") < block.index("bo-tirol") < block.index("bo-wien")


class TestRenderBlockForPrompt:
    def test_none_when_catalog_unavailable(self, tmp_path):
        assert render_block_for_prompt("Projekt in Wien", path=str(tmp_path / "missing.yml")) is None

    def test_bundesland_comes_from_project_context(self, tmp_path):
        path = _write_catalog(
            tmp_path,
            [
                _entry(id="bo-tirol", title="Tiroler Bauordnung", short="BO Tirol", bundesland="Tirol"),
                _entry(id="bo-wien"),
            ],
        )

        block = render_block_for_prompt("Standort: Wien", path=path)

        assert block is not None
        assert block.index("bo-wien") < block.index("bo-tirol")


SHIPPED_CATALOG = Path(__file__).resolve().parents[3] / "configs" / "ris_catalog.yml"


class TestShippedCatalog:
    """Schema + coverage guard for the curated catalog (regenerate: scripts/build_ris_catalog.py)."""

    def _catalog(self) -> RisCatalog:
        assert SHIPPED_CATALOG.is_file(), "configs/ris_catalog.yml missing — run scripts/build_ris_catalog.py"
        data = yaml.safe_load(SHIPPED_CATALOG.read_text(encoding="utf-8"))
        return RisCatalog.model_validate(data)

    def test_validates_and_has_coverage(self):
        catalog = self._catalog()

        assert len(catalog.entries) >= 15

    def test_unique_ids(self):
        catalog = self._catalog()
        ids = [entry.id for entry in catalog.entries]

        assert len(ids) == len(set(ids))

    def test_all_entries_fully_specified(self):
        catalog = self._catalog()

        for entry in catalog.entries:
            assert entry.application in KNOWN_APPLICATIONS, entry.id
            assert entry.document_number, entry.id
            assert entry.citation_url.startswith("https://www.ris.bka.gv.at/"), entry.id
            assert "Gesetzesnummer=" in entry.full_law_url, entry.id
            assert entry.topics, entry.id
            assert entry.verified_at, entry.id

    def test_all_nine_bundeslaender_covered(self):
        catalog = self._catalog()
        covered = {entry.bundesland for entry in catalog.entries if entry.application == "LrKons"}

        assert covered == {
            "Wien",
            "Niederösterreich",
            "Oberösterreich",
            "Steiermark",
            "Kärnten",
            "Salzburg",
            "Tirol",
            "Vorarlberg",
            "Burgenland",
        }

    def test_loader_accepts_shipped_file(self):
        catalog = load_catalog(str(SHIPPED_CATALOG))

        assert catalog is not None
        assert catalog.entries

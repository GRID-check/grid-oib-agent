"""Tests for the flat norm registry (aiq_agent.common.norm_registry)."""

import os
from pathlib import Path

import pytest
import yaml

from aiq_agent.common import norm_registry as nr

REPO_ROOT = Path(__file__).resolve().parents[3]


def _entry(entry_id: str, **overrides) -> dict:
    base = {
        "id": entry_id,
        "title": f"Title {entry_id}",
        "short": entry_id.upper(),
        "rank": "landesgesetz",
        "bundesland": "Wien",
        "topics": ["bauordnung"],
        "relevance": "test",
        "application": "LrKons",
        "document_number": "LWI40000225",
        "verified_at": "2026-07-17",
    }
    base.update(overrides)
    return base


def _write_registry(norms_dir: Path, country: str, entries: list[dict]) -> Path:
    country_dir = norms_dir / country
    country_dir.mkdir(parents=True, exist_ok=True)
    path = country_dir / "registry.yml"
    payload = {"version": 1, "entries": entries}
    path.write_text(yaml.safe_dump(payload, allow_unicode=True), encoding="utf-8")
    return path


@pytest.fixture(autouse=True)
def _clean_state():
    nr.reset_registry_cache()
    yield
    nr.set_db_loader(None)  # also clears the cache
    nr.reset_registry_cache()


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


class TestLoader:
    def test_valid_file_loads(self, tmp_path):
        _write_registry(tmp_path, "at", [_entry("bo-wien"), _entry("aschg", rank="bundesgesetz", bundesland="")])

        registry = nr.load_registry(str(tmp_path))

        assert registry is not None
        assert {e.id for e in registry.entries} == {"bo-wien", "aschg"}

    def test_missing_dir_fails_open(self, tmp_path):
        assert nr.load_registry(str(tmp_path / "nope")) is None

    def test_invalid_yaml_fails_open(self, tmp_path):
        bad_dir = tmp_path / "at"
        bad_dir.mkdir()
        (bad_dir / "registry.yml").write_text("not: [valid", encoding="utf-8")

        assert nr.load_registry(str(tmp_path)) is None

    def test_mtime_cache_invalidation(self, tmp_path):
        path = _write_registry(tmp_path, "at", [_entry("bo-wien")])
        first = nr.load_registry(str(tmp_path))
        assert [e.id for e in first.entries] == ["bo-wien"]

        # Rewrite with different content and push the mtime forward so the
        # mtime-keyed cache reloads instead of serving the stale parse.
        _write_registry(tmp_path, "at", [_entry("bo-noe", bundesland="Niederösterreich")])
        st = path.stat()
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))

        second = nr.load_registry(str(tmp_path))
        assert [e.id for e in second.entries] == ["bo-noe"]

    def test_db_loader_precedence(self, tmp_path, monkeypatch):
        monkeypatch.setenv(nr.ENV_NORMS_DIR, str(tmp_path))
        _write_registry(tmp_path, "at", [_entry("yaml-entry")])
        stored = nr.NormsFile(entries=[nr.NormEntry.model_validate(_entry("db-entry"))])
        nr.set_db_loader(lambda: stored)

        registry = nr.load_registry()

        assert [e.id for e in registry.entries] == ["db-entry"]

    def test_db_loader_none_falls_back_to_yaml(self, tmp_path, monkeypatch):
        monkeypatch.setenv(nr.ENV_NORMS_DIR, str(tmp_path))
        _write_registry(tmp_path, "at", [_entry("yaml-entry")])
        nr.set_db_loader(lambda: None)

        registry = nr.load_registry()

        assert [e.id for e in registry.entries] == ["yaml-entry"]

    def test_db_loader_empty_falls_back_to_yaml(self, tmp_path, monkeypatch):
        monkeypatch.setenv(nr.ENV_NORMS_DIR, str(tmp_path))
        _write_registry(tmp_path, "at", [_entry("yaml-entry")])
        nr.set_db_loader(lambda: nr.NormsFile(entries=[]))

        registry = nr.load_registry()

        assert [e.id for e in registry.entries] == ["yaml-entry"]

    def test_db_loader_raises_falls_back_to_yaml(self, tmp_path, monkeypatch):
        monkeypatch.setenv(nr.ENV_NORMS_DIR, str(tmp_path))
        _write_registry(tmp_path, "at", [_entry("yaml-entry")])

        def boom() -> nr.NormsFile:
            raise RuntimeError("store down")

        nr.set_db_loader(boom)

        registry = nr.load_registry()

        assert [e.id for e in registry.entries] == ["yaml-entry"]

    def test_duplicate_id_dropped(self, tmp_path):
        _write_registry(tmp_path, "at", [_entry("dup", title="first"), _entry("dup", title="second")])

        registry = nr.load_registry(str(tmp_path))

        assert registry is not None
        assert len(registry.entries) == 1
        assert registry.by_id("dup").title == "first"  # later copy dropped

    def test_unknown_application_dropped(self, tmp_path):
        _write_registry(tmp_path, "at", [_entry("good"), _entry("bad", application="NOPE")])

        registry = nr.load_registry(str(tmp_path))

        assert [e.id for e in registry.entries] == ["good"]

    def test_unknown_bundesland_dropped(self, tmp_path):
        _write_registry(tmp_path, "at", [_entry("good"), _entry("bad", bundesland="Bayern")])

        registry = nr.load_registry(str(tmp_path))

        assert [e.id for e in registry.entries] == ["good"]

    def test_env_var_honored(self, tmp_path, monkeypatch):
        _write_registry(tmp_path, "at", [_entry("bo-wien")])
        monkeypatch.setenv(nr.ENV_NORMS_DIR, str(tmp_path))

        registry = nr.load_registry()

        assert registry is not None
        assert registry.by_id("bo-wien") is not None


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def _match_registry() -> nr.NormRegistry:
    return nr.NormRegistry(
        entries=[
            nr.NormEntry.model_validate(
                _entry(
                    "garagengesetz-wien",
                    title="Wiener Garagengesetz 2008",
                    short="Garagengesetz Wien",
                    aliases=["Wiener Garagengesetz"],
                    topics=["garage", "stellplatz"],
                )
            ),
            nr.NormEntry.model_validate(_entry("bo-tirol", bundesland="Tirol", topics=["bauordnung"])),
            nr.NormEntry.model_validate(
                _entry(
                    "aschg",
                    rank="bundesgesetz",
                    bundesland="",
                    application="BrKons",
                    document_number="NOR40262244",
                    topics=["arbeitnehmerinnenschutz"],
                )
            ),
        ]
    )


class TestMatching:
    def test_match_on_alias(self):
        matches = nr.match_entries(_match_registry(), "Was sagt das Wiener Garagengesetz?")
        assert [e.id for e in matches] == ["garagengesetz-wien"]

    def test_match_on_topic(self):
        matches = nr.match_entries(_match_registry(), "Stellplatzpflicht in Wien")
        assert [e.id for e in matches] == ["garagengesetz-wien"]

    def test_no_match(self):
        assert nr.match_entries(_match_registry(), "Wetterbericht für morgen") == []
        assert nr.match_entries(_match_registry(), "") == []

    def test_short_terms_never_match(self):
        # "bo" (< _MIN_TOPIC_LENGTH) must not trip any needle.
        assert nr.match_entries(_match_registry(), "bo") == []


# ---------------------------------------------------------------------------
# focus_entries
# ---------------------------------------------------------------------------


class TestFocus:
    def test_drops_other_states_and_puts_own_first(self):
        entries = list(_match_registry().entries)  # garagengesetz-wien (Wien), bo-tirol (Tirol), aschg (federal)

        focused = nr.focus_entries(entries, "Wien")

        assert [e.id for e in focused] == ["garagengesetz-wien", "aschg"]  # Tirol dropped, federal kept

    def test_noop_without_bundesland(self):
        entries = list(_match_registry().entries)
        assert nr.focus_entries(entries, None) == entries


# ---------------------------------------------------------------------------
# extract_bundesland
# ---------------------------------------------------------------------------


class TestExtractBundesland:
    def test_structured_token_beats_name_probing(self):
        # A Lower-Austrian project that also mentions Wien: the structured token wins.
        assert nr.extract_bundesland("bundesland=niederoesterreich; Baustelle nahe Wien") == "Niederösterreich"

    def test_structured_ausserhalb_returns_none(self):
        assert nr.extract_bundesland("bundesland=ausserhalb_oesterreichs; Wien erwähnt") is None

    def test_umlaut_variants_probed(self):
        assert nr.extract_bundesland("Bauvorhaben in Kärnten") == "Kärnten"
        assert nr.extract_bundesland("Bauvorhaben in Kaernten") == "Kärnten"

    def test_no_bundesland(self):
        assert nr.extract_bundesland("kein Landesbezug") is None
        assert nr.extract_bundesland(None) is None


# ---------------------------------------------------------------------------
# render_prompt_block
# ---------------------------------------------------------------------------


def _render_registry() -> nr.NormRegistry:
    entries = [
        _entry(
            "aschg",
            rank="bundesgesetz",
            bundesland="",
            short="ASchG",
            title="ArbeitnehmerInnenschutzgesetz",
            application="BrKons",
            document_number="NOR40262244",
        ),
        _entry(
            "bo-wien",
            short="BO Wien",
            title="Bauordnung für Wien",
            bundesland="Wien",
            binding_note="Macht die OIB-Richtlinien in Wien verbindlich.",
        ),
        _entry(
            "bo-tirol",
            short="Tiroler BO",
            title="Tiroler Bauordnung",
            bundesland="Tirol",
            document_number="LTI40047551",
        ),
    ]
    return nr.NormRegistry(entries=[nr.NormEntry.model_validate(e) for e in entries])


class TestRenderPromptBlock:
    def test_federal_lane_and_all_states_without_bundesland(self):
        block = nr.render_prompt_block(_render_registry(), bundesland=None)

        assert "Bundesrecht:" in block
        assert "ASchG" in block
        assert "Landesrecht — Wien:" in block
        assert "Landesrecht — Tirol:" in block
        assert "OIB-Korpus" in block  # static corpus pointer always present

    def test_focused_state_drops_other_states(self):
        block = nr.render_prompt_block(_render_registry(), bundesland="Wien")

        assert "Bundesrecht:" in block
        assert "Landesrecht — Wien:" in block
        assert "Tirol" not in block  # other state's law entirely absent

    def test_binding_note_rendered(self):
        block = nr.render_prompt_block(_render_registry(), bundesland="Wien")

        assert "Rechtliche Hinweise (kuratiert):" in block
        assert "Macht die OIB-Richtlinien in Wien verbindlich." in block

    def test_render_block_for_prompt_none_when_missing(self, tmp_path):
        assert nr.render_block_for_prompt(None, norms_dir=str(tmp_path / "nope")) is None


# ---------------------------------------------------------------------------
# oib_doc_class (derived from data/oib filename convention)
# ---------------------------------------------------------------------------


class TestOibDocClass:
    @pytest.mark.parametrize(
        "filename,expected",
        [
            ("oib-rl_2_ausgabe_mai_2023.pdf", "richtlinie"),
            ("oib-rl_2_leitfaden_ausgabe_mai_2023.pdf", "leitfaden"),
            ("oib-rl_6-leitfaden_ausgabe_mai_2023.pdf", "leitfaden"),
            ("erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf", "erlaeuterungen"),
            ("oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf", "begriffsbestimmungen"),
            ("oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023.pdf", "zitierte_normen"),
            ("aenderungen_oib-rl_2_ausgabe_mai_2023.pdf", "aenderungen"),
        ],
    )
    def test_real_filenames(self, filename, expected):
        assert nr.oib_doc_class(filename) == expected

    def test_non_oib_returns_none(self):
        assert nr.oib_doc_class("bauordnung_wien.pdf") is None
        assert nr.oib_doc_class("random.txt") is None


# ---------------------------------------------------------------------------
# lane_for_hit (display-strata classification)
# ---------------------------------------------------------------------------


class TestLaneForHit:
    def _registry(self) -> nr.NormRegistry:
        return nr.NormRegistry(
            entries=[
                nr.NormEntry.model_validate(_entry("bo-wien", rank="landesgesetz", document_number="LWI40000225")),
                nr.NormEntry.model_validate(
                    _entry(
                        "aschg",
                        rank="bundesgesetz",
                        bundesland="",
                        application="BrKons",
                        document_number="NOR40262244",
                    )
                ),
                nr.NormEntry.model_validate(
                    _entry(
                        "astv",
                        rank="verordnung",
                        bundesland="",
                        application="BrKons",
                        document_number="NOR40166316",
                    )
                ),
            ]
        )

    def test_oib_file(self):
        assert nr.lane_for_hit(file_name="oib-rl_2_ausgabe_mai_2023.pdf") == ("baurecht_oib", "OIB-Richtlinie")

    def test_oib_leitfaden_file(self):
        assert nr.lane_for_hit(file_name="oib-rl_2_leitfaden_ausgabe_mai_2023.pdf") == (
            "baurecht_oib_leitfaden",
            "OIB-Leitfaden",
        )

    def test_ris_url_maps_to_rank_lane(self):
        reg = self._registry()
        land = "https://www.ris.bka.gv.at/eli/lgbl/WI/1930/11/P0/LWI40000225"
        bund = "https://www.ris.bka.gv.at/eli/bgbl/1994/450/P0/NOR40262244"
        verordnung = "https://www.ris.bka.gv.at/eli/bgbl/ii/1998/368/P0/NOR40166316"

        assert nr.lane_for_hit(source_url=land, registry=reg) == ("baurecht_land", "Landesrecht")
        assert nr.lane_for_hit(source_url=bund, registry=reg) == ("baurecht_bund", "Bundesrecht")
        assert nr.lane_for_hit(source_url=verordnung, registry=reg) == ("baurecht_verordnung", "Verordnung")

    def test_ris_url_without_registry_match(self):
        assert nr.lane_for_hit(source_url="https://www.ris.bka.gv.at/eli/foo/UNKNOWN") == (
            "baurecht_ris",
            "Rechtsquelle (RIS)",
        )

    def test_archiv_collection(self):
        assert nr.lane_for_hit(collection="archiv_buero") == ("buero", "Büroarchiv")

    def test_project_collections(self):
        assert nr.lane_for_hit(collection="proj_123") == ("projekt", "Projektwissen")
        assert nr.lane_for_hit(collection="s_session42") == ("projekt", "Projektwissen")

    def test_unknown_defaults_to_web(self):
        assert nr.lane_for_hit() == ("web", "Web")
        assert nr.lane_for_hit(file_name="notes.txt") == ("web", "Web")

    def test_explicit_doc_class_overrides_filename_guess(self):
        # A file whose name gives no OIB hint, but a human set doc_class:
        # the explicit class wins and lands in the OIB-Richtlinie lane.
        assert nr.lane_for_hit(file_name="randomname.pdf", doc_class="oib_richtlinie") == (
            "baurecht_oib",
            "OIB-Richtlinie",
        )

    def test_explicit_doc_class_overrides_collection(self):
        # Even a project-collection hit is re-homed by an explicit doc_class.
        assert nr.lane_for_hit(collection="proj_123", doc_class="gesetz") == (
            "baurecht_ris",
            "Rechtsquelle (RIS)",
        )

    def test_explicit_doc_class_base_lane(self):
        assert nr.lane_for_hit(doc_class="sonstiges") == ("baurecht_basis", "Basisdokument")

    def test_explicit_doc_class_norm_extern(self):
        assert nr.lane_for_hit(doc_class="norm_extern") == ("norm_extern", "Externe Norm")

    def test_invalid_doc_class_falls_through(self):
        # An unknown doc_class is ignored (fail-open); filename guess applies.
        assert nr.lane_for_hit(doc_class="bogus", file_name="oib-rl_2_ausgabe_mai_2023.pdf") == (
            "baurecht_oib",
            "OIB-Richtlinie",
        )


# ---------------------------------------------------------------------------
# guess_doc_class (filename pre-fill for the explicit doc_class vocabulary)
# ---------------------------------------------------------------------------


class TestGuessDocClass:
    @pytest.mark.parametrize(
        "filename,expected",
        [
            ("oib-rl_2_ausgabe_mai_2023.pdf", "oib_richtlinie"),
            ("oib-rl_2_leitfaden_ausgabe_mai_2023.pdf", "oib_leitfaden"),
            ("erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf", "oib_erlaeuterung"),
            ("oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf", "oib_begriffe"),
            ("oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023.pdf", "oib_referenz"),
            ("aenderungen_oib-rl_2_ausgabe_mai_2023.pdf", "oib_aenderung"),
        ],
    )
    def test_oib_filenames(self, filename, expected):
        assert nr.guess_doc_class(filename) == expected

    def test_unknown_filename_defaults_to_sonstiges(self):
        assert nr.guess_doc_class("bauordnung_wien.pdf") == "sonstiges"
        assert nr.guess_doc_class("random.txt") == "sonstiges"
        assert nr.guess_doc_class("") == "sonstiges"


# ---------------------------------------------------------------------------
# Smoke test against the real repository registry file.
# ---------------------------------------------------------------------------


def test_repo_registry_has_23_entries():
    registry = nr.load_registry(str(REPO_ROOT / "configs" / "norms"))

    assert registry is not None
    assert len(registry.entries) == 23


class TestNonRisEntries:
    """Non-RIS lanes: behoerdliche_info (web source) and norm_extern (no full text)."""

    @staticmethod
    def _write(tmp_path, entries):
        import yaml

        d = tmp_path / "at"
        d.mkdir(parents=True)
        (d / "registry.yml").write_text(
            yaml.safe_dump({"version": 1, "entries": entries}, allow_unicode=True), encoding="utf-8"
        )
        return str(tmp_path)

    def _base(self, **over):
        entry = {
            "id": "ma37",
            "title": "MA 37 Merkblätter",
            "short": "MA 37",
            "rank": "behoerdliche_info",
            "bundesland": "Wien",
            "source_url": "https://www.wien.gv.at/x",
        }
        entry.update(over)
        return entry

    def test_web_source_entry_loads_and_renders_with_quelle(self, tmp_path):
        registry = nr.load_registry(self._write(tmp_path, [self._base()]))
        assert registry is not None and registry.entries[0].id == "ma37"
        block = nr.render_prompt_block(registry, bundesland="Wien")
        assert "Behördliche Informationen" in block
        assert "Quelle: https://www.wien.gv.at/x" in block

    def test_entry_with_both_urls_renders_both(self, tmp_path):
        # Regression: an entry carrying a consolidated-law link AND a curated
        # annex/source link must render BOTH — an `elif` previously dropped
        # ``source_url`` whenever ``full_law_url`` was also set.
        entry = self._base(full_law_url="https://www.ris.bka.gv.at/GeltendeFassung/x")
        registry = nr.load_registry(self._write(tmp_path, [entry]))
        block = nr.render_prompt_block(registry, bundesland="Wien")
        assert "Gesamt: https://www.ris.bka.gv.at/GeltendeFassung/x" in block
        assert "Quelle: https://www.wien.gv.at/x" in block

    def test_norm_extern_stub_renders_kein_volltext(self, tmp_path):
        stub = self._base(id="oenorm", rank="norm_extern", bundesland="", source_url="")
        registry = nr.load_registry(self._write(tmp_path, [stub]))
        block = nr.render_prompt_block(registry)
        assert "Externe Normen" in block
        assert "kein Volltext verfügbar" in block

    def test_law_rank_without_ris_pointer_is_dropped(self, tmp_path):
        bad = self._base(id="bad-law", rank="landesgesetz")
        registry = nr.load_registry(self._write(tmp_path, [bad]))
        assert registry is None

    def test_non_ris_ranks_map_to_lanes(self):
        assert nr._RANK_LANES["behoerdliche_info"] == ("behoerde", "Behördliche Information")
        assert nr._RANK_LANES["norm_extern"] == ("norm_extern", "Externe Norm")

    def test_repo_seed_contains_ma37_entry(self):
        registry = nr.load_registry("configs/norms")
        entry = registry.by_id("ma37-merkblaetter")
        assert entry is not None and entry.rank == "behoerdliche_info" and not entry.is_ris


class TestParcelNote:
    """Parcel documents in the project RAG are surfaced as the governing source."""

    def test_none_without_documents(self):
        assert nr.parcel_note(None) is None
        assert nr.parcel_note([]) is None
        assert nr.parcel_note([{"file_name": "grundriss.pdf", "tags": ["Grundriss"]}]) is None

    def test_tagged_bebauungsplan_is_named_as_governing(self):
        docs = [
            {"file_name": "bplan_7602.pdf", "tags": ["Bebauungsplan"], "summary": "x"},
            {"file_name": "fwp_wien.pdf", "tags": ["Flächenwidmungsplan"]},
            {"file_name": "gutachten.pdf", "tags": ["Gutachten"]},
        ]
        note = nr.parcel_note(docs)
        assert note is not None
        assert "Bebauungsplan: bplan_7602.pdf" in note
        assert "Flächenwidmungsplan: fwp_wien.pdf" in note
        assert "maßgebliche Quelle" in note
        assert "gutachten.pdf" not in note

    def test_corpus_collection_field_defaults_and_loads(self, tmp_path):
        import yaml

        d = tmp_path / "at"
        d.mkdir(parents=True)
        (d / "registry.yml").write_text(yaml.safe_dump({"version": 1, "entries": []}), encoding="utf-8")
        parsed = yaml.safe_load(open("configs/norms/at/registry.yml"))
        assert nr.NormsFile.model_validate(parsed).corpus_collection == "oib_knowledge"
        assert nr.NormsFile(version=1, entries=[]).corpus_collection == "oib_knowledge"

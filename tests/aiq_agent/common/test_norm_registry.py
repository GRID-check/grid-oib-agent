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

    def test_wien_gv_at_is_behoerde_lane(self):
        behoerde = ("behoerde", "Behördliche Information")
        assert nr.lane_for_hit(source_url="https://www.wien.gv.at/wohnen/baupolizei") == behoerde
        assert nr.lane_for_hit(source_url="https://wien.gv.at/x") == behoerde
        assert nr.lane_for_hit(source_url="https://WWW.WIEN.GV.AT/x") == behoerde

    def test_lookalike_hosts_stay_web(self):
        # Host-boundary matching: a lookalike host or a domain mentioned in the
        # path/query must not inherit an authoritative lane.
        assert nr.lane_for_hit(source_url="https://evil.example/wien.gv.at") == ("web", "Web")
        assert nr.lane_for_hit(source_url="https://evil.example/?q=ris.bka.gv.at") == ("web", "Web")
        assert nr.lane_for_hit(source_url="https://wien.gv.at.evil.example/x") == ("web", "Web")
        assert nr.lane_for_hit(source_url="https://ris.bka.gv.at.evil.example/") == ("web", "Web")

    def test_archiv_collection(self):
        assert nr.lane_for_hit(collection="archiv_buero") == ("buero", "Büroarchiv")

    def test_project_collections(self):
        assert nr.lane_for_hit(collection="proj_123") == ("projekt", "Projektwissen")
        # A session attachment shares the project's colour and says whose it is.
        assert nr.lane_for_hit(collection="s_session42") == ("projekt", "Private Sitzung")

    def test_a_shelf_the_caller_knows_beats_the_collection_guess(self):
        assert nr.lane_for_hit(collection="whatever", shelf="archiv") == ("buero", "Büroarchiv")

    def test_the_default_class_never_relabels_a_users_document(self):
        # Ingestion used to stamp "sonstiges" on every upload; on a user's own
        # shelf that guess is not a decision, and the shelf wins.
        assert nr.lane_for_hit(collection="proj_123", doc_class="sonstiges") == ("projekt", "Projektwissen")
        assert nr.lane_for_hit(collection="archiv_org", doc_class="sonstiges") == ("buero", "Büroarchiv")
        assert nr.lane_for_hit(collection="s_chat", doc_class="sonstiges") == ("projekt", "Private Sitzung")
        # A base-corpus file nobody classified is still a base document.
        assert nr.lane_for_hit(collection="oib_knowledge", doc_class="sonstiges") == ("baurecht_basis", "Basisdokument")
        # A human-set class on a project file still wins (see the test above).

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


class TestLaneForAgentAuthoredHit:
    """Stated provenance outranks every other signal in the classifier.

    A published Piloti document is filed on the project or the Büroarchiv shelf
    like any other document, and ingest stamps it with a doc_class like any
    other document. Both of those are how it would silently lose its author:
    the shelf would make it Projektwissen, and the doc_class would file it in
    the norm hierarchy under a label fallback that reads "Baurecht".
    """

    def test_provenance_gives_the_document_its_own_lane(self):
        assert nr.lane_for_hit(authored_by="agent") == ("buero_piloti", "Piloti-Dokument")

    def test_it_beats_the_project_shelf(self):
        """The headline defect: on the project shelf it would wear the
        Projektwissen chip, and nothing would say Piloti wrote it."""
        assert nr.lane_for_hit(shelf="project", collection="proj_abc", authored_by="agent") == (
            "buero_piloti",
            "Piloti-Dokument",
        )
        # Same hit without the provenance — the shelf decides, exactly as before.
        assert nr.lane_for_hit(shelf="project", collection="proj_abc") == ("projekt", "Projektwissen")

    def test_it_beats_an_explicit_doc_class(self):
        """doc_class is the first-priority signal for everything else, and its
        label fallback is "Baurecht" — law blue for a document we wrote."""
        assert nr.lane_for_hit(doc_class="gesetz", shelf="archiv", authored_by="agent") == (
            "buero_piloti",
            "Piloti-Dokument",
        )

    def test_the_lane_is_office_knowledge_not_law(self):
        from aiq_agent.common.source_kinds import kind_for_lane

        lane_key, _label = nr.lane_for_hit(authored_by="agent")
        assert kind_for_lane(lane_key) == "buero"

    def test_the_knowledge_hit_classifier_agrees(self):
        assert nr.lane_for_knowledge_hit(shelf="project", authored_by="agent") == (
            "buero_piloti",
            "Piloti-Dokument",
        )

    def test_an_unmarked_hit_is_untouched(self):
        for authored_by in (None, "", "human", "Marianne"):
            assert nr.lane_for_hit(shelf="archiv", authored_by=authored_by) == ("buero", "Büroarchiv")


class TestLaneForKnowledgeHit:
    """A retrieved document is something we hold — it can never be Web."""

    def test_the_fail_open_lane_becomes_projektwissen(self):
        # No doc_class, no recognizable collection prefix, no OIB filename:
        # lane_for_hit fails open to Web. For a knowledge-layer hit that value
        # means "no signal matched", not "this came off the internet".
        assert nr.lane_for_hit(file_name="Bestandsplan.pdf") == ("web", "Web")
        assert nr.lane_for_knowledge_hit(file_name="Bestandsplan.pdf") == ("projekt", "Projektwissen")

    def test_a_real_classification_is_never_overridden(self):
        assert nr.lane_for_knowledge_hit(file_name="oib-rl_2_ausgabe_mai_2023.pdf") == (
            "baurecht_oib",
            "OIB-Richtlinie",
        )
        assert nr.lane_for_knowledge_hit(collection="archiv_org1") == ("buero", "Büroarchiv")


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


class TestGuessDisplayTitle:
    """The default display-title seed derived from the OIB filename convention."""

    def test_richtlinie(self):
        assert nr.guess_display_title("oib-rl_2_ausgabe_mai_2023.pdf") == "OIB-Richtlinie 2, Ausgabe Mai 2023"

    def test_sub_number(self):
        assert nr.guess_display_title("oib-rl_2.3_ausgabe_mai_2023.pdf") == "OIB-Richtlinie 2.3, Ausgabe Mai 2023"

    def test_leitfaden_underscore_and_hyphen_normalize(self):
        assert nr.guess_display_title("oib-rl_2_leitfaden_ausgabe_mai_2023.pdf") == (
            "OIB-Richtlinie 2 – Leitfaden, Ausgabe Mai 2023"
        )
        # The corpus has a hyphen variant for RL 6; it must normalize identically.
        assert nr.guess_display_title("oib-rl_6-leitfaden_ausgabe_mai_2023.pdf") == (
            "OIB-Richtlinie 6 – Leitfaden, Ausgabe Mai 2023"
        )

    def test_role_prefixes(self):
        assert nr.guess_display_title("erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf") == (
            "Erläuterungen zu OIB-Richtlinie 2, Ausgabe Mai 2023"
        )
        assert nr.guess_display_title("aenderungen_oib-rl_2.1_ausgabe_mai_2023.pdf") == (
            "Änderungen zu OIB-Richtlinie 2.1, Ausgabe Mai 2023"
        )

    def test_named_documents(self):
        assert nr.guess_display_title("oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf") == (
            "OIB-Richtlinie Begriffsbestimmungen, Ausgabe Mai 2023"
        )
        assert (
            nr.guess_display_title(
                "oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023_rev.1.pdf"
            )
            == "OIB-Richtlinie – Zitierte Normen und sonstige technische Regelwerke, Ausgabe Mai 2023, Rev. 1"
        )

    def test_edition_year_is_not_mistaken_for_the_number(self):
        assert nr.guess_display_title("oib-rl_6_ausgabe_mai_2023.pdf") == "OIB-Richtlinie 6, Ausgabe Mai 2023"

    def test_an_edition_other_than_the_shipped_one_is_read_not_assumed(self):
        # The parser used to know exactly one edition, so the next OIB release
        # would have been labelled "Mai 2023" or refused outright.
        assert nr.guess_display_title("oib-rl_2_ausgabe_maerz_2019.pdf") == "OIB-Richtlinie 2, Ausgabe März 2019"
        assert nr.guess_display_title("oib-rl_4_ausgabe_april_2027.pdf") == "OIB-Richtlinie 4, Ausgabe April 2027"
        assert nr.guess_display_title("oib-rl_4_ausgabe_2015.pdf") == "OIB-Richtlinie 4, Ausgabe 2015"
        assert nr.guess_display_title("oib-rl_2_leitfaden_ausgabe_oktober_2027_rev.2.pdf") == (
            "OIB-Richtlinie 2 – Leitfaden, Ausgabe Oktober 2027, Rev. 2"
        )

    def test_non_oib_returns_none(self):
        assert nr.guess_display_title("Brandschutzkonzept_v3.pdf") is None
        assert nr.guess_display_title("") is None

    def test_covers_every_real_corpus_file(self):
        """Every shipped OIB corpus PDF derives a confident (non-None) title."""
        corpus = Path("data/oib")
        # The directory is committed (it carries a README); the PDFs are
        # operator-provided and gitignored. Guarding on the directory would let
        # this pass vacuously in every fresh clone, asserting nothing at all.
        pdfs = sorted(corpus.glob("*.pdf"))
        if not pdfs:
            pytest.skip("no OIB corpus in this checkout — see data/oib/README.md")
        for pdf in pdfs:
            assert nr.guess_display_title(pdf.name), pdf.name


class TestNormsDirResolution:
    """The YAML seed must be found from any working directory of the checkout.

    Every package suite that boots the registry (``frontends/aiq_api`` included)
    used to see an empty registry when run from its own directory: the default
    ``configs/norms`` is cwd-relative, and nothing said so. It failed four route
    tests for weeks and read as a test bug.
    """

    def test_explicit_path_wins(self, tmp_path, monkeypatch):
        monkeypatch.setenv(nr.ENV_NORMS_DIR, str(tmp_path / "env"))
        assert nr._norms_dir(str(tmp_path / "explicit")) == tmp_path / "explicit"

    def test_env_var_beats_the_default(self, tmp_path, monkeypatch):
        monkeypatch.setenv(nr.ENV_NORMS_DIR, str(tmp_path / "env"))
        assert nr._norms_dir(None) == tmp_path / "env"

    def test_default_resolves_against_the_repo_root_from_another_cwd(self, tmp_path, monkeypatch):
        monkeypatch.delenv(nr.ENV_NORMS_DIR, raising=False)
        monkeypatch.chdir(tmp_path)
        resolved = nr._norms_dir(None)
        assert resolved.is_absolute()
        assert (resolved / "at" / "registry.yml").is_file()
        assert nr.registry_yaml_files(), "the seed must load from a foreign working directory"

    def test_default_stays_relative_when_the_cwd_holds_the_seed(self, tmp_path, monkeypatch):
        monkeypatch.delenv(nr.ENV_NORMS_DIR, raising=False)
        (tmp_path / "configs" / "norms").mkdir(parents=True)
        monkeypatch.chdir(tmp_path)
        assert nr._norms_dir(None) == Path(nr.DEFAULT_NORMS_DIR)


class TestOibFamilies:
    """Which Richtlinien belong together, derived from what is INDEXED.

    "OIB-Richtlinien 1–6" names no members, and OIB-RL 2 is four documents.
    Membership is derived from the corpus's own filenames rather than listed
    here, so a deployment without a 2.3 is never told it has one and a corpus
    that grows a 2.4 needs no code change.
    """

    def test_a_richtlinie_with_parts_reports_all_of_them(self):
        from aiq_agent.common.norm_registry import oib_families

        families = oib_families(
            [
                "oib-rl_2_ausgabe_mai_2023.pdf",
                "oib-rl_2.3_ausgabe_mai_2023.pdf",
                "oib-rl_2.1_ausgabe_mai_2023.pdf",
                "oib-rl_2.2_ausgabe_mai_2023.pdf",
            ]
        )

        assert [(f.key, f.members) for f in families] == [("2", ("2", "2.1", "2.2", "2.3"))]
        assert families[0].label == "OIB-Richtlinie 2"

    def test_a_richtlinie_without_parts_is_still_a_family(self):
        """One member is a fact about the corpus. It is a different statement
        from "we do not know what parts it has"."""
        from aiq_agent.common.norm_registry import oib_families

        assert [f.members for f in oib_families(["oib-rl_3_ausgabe_mai_2023.pdf"])] == [("3",)]

    def test_reading_aids_are_not_members(self):
        """A Leitfaden, an Erläuterung and an Änderungsdokument are read WITH a
        Richtlinie. Counting them as parts would let an overview answer look
        complete for having opened an interpretation aid."""
        from aiq_agent.common.norm_registry import oib_families
        from aiq_agent.common.norm_registry import oib_family_member

        assert oib_family_member("oib-rl_2_leitfaden_ausgabe_mai_2023.pdf") is None
        assert oib_family_member("oib-rl_6-leitfaden_ausgabe_mai_2023.pdf") is None
        assert oib_family_member("erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf") is None
        assert oib_family_member("aenderungen_oib-rl_2_ausgabe_mai_2023.pdf") is None
        assert oib_family_member("oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf") is None
        assert oib_families(["oib-rl_2_leitfaden_ausgabe_mai_2023.pdf"]) == []

    def test_a_project_file_is_not_a_member(self):
        from aiq_agent.common.norm_registry import oib_family_member

        assert oib_family_member("Brandschutzkonzept.pdf") is None

    def test_two_editions_of_one_part_are_one_member(self):
        """The family is about which requirements exist, not how many files
        carry them."""
        from aiq_agent.common.norm_registry import oib_families

        families = oib_families(["oib-rl_2_ausgabe_mai_2023.pdf", "oib-rl_2_ausgabe_april_2019.pdf"])
        assert [f.members for f in families] == [("2",)]

    def test_members_sort_numerically_and_families_by_number(self):
        """`2.10` after `2.9`, and family 10 after family 2 — both of which a
        string sort gets backwards."""
        from aiq_agent.common.norm_registry import oib_families

        names = [f"oib-rl_2.{i}_x.pdf" for i in (10, 9, 2)] + ["oib-rl_10_x.pdf", "oib-rl_2_x.pdf"]
        families = oib_families(names)

        assert [f.key for f in families] == ["2", "10"]
        assert families[0].members == ("2", "2.2", "2.9", "2.10")

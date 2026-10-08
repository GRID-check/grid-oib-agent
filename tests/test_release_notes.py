"""Tests for the release-note pipeline (`scripts/release_notes.py`).

The pipeline publishes text straight to a public marketing page, so the parts
worth pinning are the ones whose failure a reviewer cannot see in a diff: the
lint that decides what may be published, the grouping that decides where a note
appears, the translation cache that decides what a German reader gets, and the
drift between reno's section list and the German titles for it.

The git-scanning half (`load_notes_from_reno`) is deliberately not exercised
here: it is reno's, it needs a repository with history, and everything after it
works on the plain structures these tests build directly.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, relative: str):
    """Import a top-level script by path, the way tests/test_backfill_document_tags.py does."""
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


rn = _load("scripts.release_notes", "scripts/release_notes.py")
require_note = _load("ci.require_release_note", "ci/require_release_note.py")

CONFIG_PATH = REPO_ROOT / "releasenotes" / "config.yaml"
SECTIONS = rn.read_config_sections(CONFIG_PATH)
SECTION_KEYS = {key for key, _ in SECTIONS}

GOOD = "Projects can now be re-indexed from the settings page, without contacting support."


def lint_entry(text: str) -> list[str]:
    return rn.lint_note("note.yaml", yaml.safe_dump({"features": [text]}), SECTION_KEYS)


# ── the published-prose rules ───────────────────────────────────────────────


def test_a_plain_sentence_passes():
    assert lint_entry(GOOD) == []


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("The `re-index` button now works as documented for everyone.", "backtick"),
        (".. note:: the re-index button now works as documented for everyone.", "directive"),
        ("Re-indexing works again, see #1423 for the details of the fix.", "issue or PR number"),
        ("Re-indexing works again after the fix in ingest_oib.py landed here.", "file name"),
        ("Re-indexing works again after the change to src/aiq_agent landed here.", "repository path"),
        ("Re-indexing works again as of commit 4f2a91c in the ingest path.", "commit sha"),
        ("Re-indexing is fixed, details at https://github.com/GRID-check/grid-oib-agent.", "link"),
    ],
)
def test_internal_and_markup_references_are_rejected(text, expected):
    problems = lint_entry(text)
    assert problems, f"expected {expected!r} to be rejected"
    assert any(expected in problem for problem in problems)


def test_a_piloti_link_is_allowed():
    assert lint_entry("The full changelog now lives at https://piloti.at/changelog for everyone.") == []


def test_a_stub_is_rejected():
    assert any("too short" in problem for problem in lint_entry("Fixed a bug."))


def test_an_essay_is_rejected():
    assert any("too long" in problem for problem in lint_entry("Word word. " * 60))


def test_a_fragment_is_rejected():
    assert any("full sentence" in problem for problem in lint_entry("Re-indexing from the settings page"))


def test_untouched_template_text_is_rejected():
    problems = lint_entry("Say what is new, from the reader's side, in a sentence.")
    assert any("template" in problem for problem in problems)


def test_the_shipped_template_fails_its_own_lint():
    """`reno new` output is a stub, and a stub must never reach the website."""
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    assert rn.lint_note("new.yaml", config["template"], SECTION_KEYS)


# ── the structural rules ────────────────────────────────────────────────────


def test_an_unknown_section_is_rejected():
    problems = rn.lint_note("note.yaml", yaml.safe_dump({"awesome": [GOOD]}), SECTION_KEYS)
    assert any("unknown section" in problem for problem in problems)


def test_an_empty_section_is_rejected():
    problems = rn.lint_note("note.yaml", yaml.safe_dump({"features": []}), SECTION_KEYS)
    assert any("empty" in problem for problem in problems)


def test_a_section_that_is_not_a_list_is_rejected():
    problems = rn.lint_note("note.yaml", yaml.safe_dump({"features": GOOD}), SECTION_KEYS)
    assert any("must be a list" in problem for problem in problems)


def test_a_prelude_is_allowed_as_prose():
    assert rn.lint_note("note.yaml", yaml.safe_dump({"prelude": GOOD}), SECTION_KEYS) == []


def test_an_empty_file_is_rejected():
    assert rn.lint_note("note.yaml", "", SECTION_KEYS)


def test_german_prose_is_rejected():
    problems = lint_entry("Piloti zeigt jetzt die Fundstelle mit dem Punkt der Richtlinie an.")
    assert any("reads as German" in problem for problem in problems)


def test_english_that_quotes_a_german_label_passes():
    assert lint_entry("The filter „Von Piloti erstellt“ now also finds diagrams in the project.") == []


def test_more_than_two_sentences_are_rejected():
    problems = lint_entry("Folders can be renamed. They can be moved. They can be deleted too.")
    assert any("3 sentences" in problem for problem in problems)


def test_a_reference_with_a_point_number_is_one_sentence():
    assert rn.sentence_count("Citations name the point, as in Pkt. 3.5.2 on S. 7, not only the page.") == 1


@pytest.mark.parametrize(
    "text",
    [
        "Platform operators can now choose the default model for new conversations.",
        "Under Platform → Models the reasoning effort now applies to every agent.",
        "New installations start with an empty knowledge base and load it once.",
    ],
)
def test_operator_notes_are_sent_to_the_operators_section(text):
    assert any("operators" in problem for problem in lint_entry(text))
    note_yaml = yaml.safe_dump({"operators": [text]})
    assert rn.lint_note("note.yaml", note_yaml, SECTION_KEYS) == []


def test_every_lint_message_names_the_fix():
    problems = lint_entry("Fixed #12 in `x.py`")
    assert problems and all("Fix:" in problem for problem in problems)


def test_the_repos_own_summaries_pass():
    path = REPO_ROOT / "releasenotes" / "summaries.yaml"
    assert rn.lint_summaries(path.read_text(encoding="utf-8")) == []


def test_a_summary_key_must_be_a_week_or_a_version():
    assert rn.lint_summaries(yaml.safe_dump({"last week": GOOD}))


def test_the_repos_own_notes_pass():
    """The notes actually committed here are publishable, not just lintable in theory."""
    for path in sorted((REPO_ROOT / "releasenotes" / "notes").glob("*.yaml")):
        assert rn.lint_note(path.name, path.read_text(encoding="utf-8"), SECTION_KEYS) == []


# ── config drift ────────────────────────────────────────────────────────────


def test_every_configured_section_has_a_german_title():
    """A section added to reno's config without a German title would ship an English heading."""
    missing = SECTION_KEYS - set(rn.SECTION_TITLES_DE)
    assert not missing, f"add German titles for: {sorted(missing)}"


def test_no_stale_german_titles():
    stale = set(rn.SECTION_TITLES_DE) - SECTION_KEYS
    assert not stale, f"sections no longer in releasenotes/config.yaml: {sorted(stale)}"


# ── grouping ────────────────────────────────────────────────────────────────


def note(version: str, date: str | None, **sections) -> object:
    return rn.Note(filename=f"{version}-{date}.yaml", version=version, date=date, sections=dict(sections))


def test_untagged_notes_group_by_the_week_they_shipped():
    groups = rn.group_notes(
        [
            note("0.0.0", "2026-08-19", features=["A."]),
            note("0.0.0", "2026-09-21", fixes=["B."]),
            note("0.0.0", "2026-09-26", features=["C."]),
        ],
        [key for key, _ in SECTIONS],
    )
    assert [g["id"] for g in groups] == ["2026-W39", "2026-W34"]
    assert groups[0]["kind"] == "week"
    assert (groups[0]["date"], groups[0]["dateEnd"]) == ("2026-09-21", "2026-09-27")
    # Within a week, the configured section order wins over the note order.
    assert [s["key"] for s in groups[0]["sections"]] == ["features", "fixes"]
    assert groups[0]["sections"][0]["notes"] == ["C."]


def test_a_week_spanning_two_months_is_one_group():
    assert rn.week_of("2026-09-01") == ("2026-W36", "2026-08-31", "2026-09-06")
    assert rn.week_of("2027-01-01") == ("2026-W53", "2026-12-28", "2027-01-03")


def test_operator_notes_never_reach_the_public_changelog():
    public = [key for key, _ in rn.public_sections(SECTIONS)]
    assert "operators" not in public
    groups = rn.group_notes(
        [
            note("0.0.0", "2026-09-26", operators=["Only for the people running the platform."]),
            note("0.0.0", "2026-08-19", operators=["Also internal."], fixes=["Public."]),
        ],
        public,
    )
    assert [g["id"] for g in groups] == ["2026-W34"]
    assert rn.collect_strings(groups) == ["Public."]
    data = rn.build_changelog(groups, rn.public_sections(SECTIONS), {})
    assert "operators" not in data["sectionTitles"]


def test_an_edited_note_keeps_the_day_it_first_shipped():
    """reno dates a note by its latest revision; an edit must not move it to this week."""
    log = "\n".join(
        [
            "@2026-08-19T10:00:00+00:00",
            "A\treleasenotes/notes/old-1234567890abcdef.yaml",
            "@2026-09-01T10:00:00+00:00",
            "R100\treleasenotes/notes/old-1234567890abcdef.yaml\treleasenotes/notes/new-1234567890abcdef.yaml",
            "@2026-09-26T10:00:00+00:00",
            "M\treleasenotes/notes/new-1234567890abcdef.yaml",
            "A\treleasenotes/notes/fresh-fedcba0987654321.yaml",
        ]
    )
    added = rn.parse_added_dates(log)
    assert added["new-1234567890abcdef.yaml"] == "2026-08-19"
    assert added["fresh-fedcba0987654321.yaml"] == "2026-09-26"


def test_a_summary_file_entry_becomes_the_week_summary():
    groups = rn.group_notes([note("0.0.0", "2026-09-26", features=["A."])], ["features"], {"2026-W39": "The week."})
    assert groups[0]["summary"] == "The week."


def test_a_tagged_release_groups_under_its_version():
    groups = rn.group_notes([note("2.1.0", "2026-08-19", features=["A."])], ["features"])
    assert groups[0]["kind"] == "version"
    assert groups[0]["version"] == "2.1.0"


def test_reno_placeholders_are_not_treated_as_releases():
    for placeholder in ("*working-copy*", "0.0.0", "2.1.0-3"):
        assert not rn._is_release_version(placeholder)
    assert rn._is_release_version("2.1.0")


def test_folded_yaml_becomes_one_clean_sentence():
    groups = rn.group_notes([note("0.0.0", "2026-08-19", features=["A\n  sentence\n  over lines.\n"])], ["features"])
    assert groups[0]["sections"][0]["notes"] == ["A sentence over lines."]


def test_a_prelude_becomes_the_release_summary():
    notes = [rn.Note(filename="n.yaml", version="0.0.0", date="2026-08-19", prelude="A summary of it all.")]
    assert rn.group_notes(notes, ["features"])[0]["summary"] == "A summary of it all."


# ── translation ─────────────────────────────────────────────────────────────


def test_a_cached_translation_is_reused_without_calling_the_api(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    monkeypatch.setattr(rn, "translate", lambda *a, **k: pytest.fail("should not call the API"))
    cache = {rn.text_key(GOOD): {"en": GOOD, "de": "Deutsch."}}
    mapping, untranslated = rn.resolve_translations([GOOD], cache, enabled=True, require=True)
    assert mapping[GOOD] == "Deutsch."
    assert untranslated == []


def test_a_new_string_is_translated_once_and_cached(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    calls = []

    def fake_translate(text, api_key, **kwargs):
        calls.append(text)
        return "Deutsch."

    monkeypatch.setattr(rn, "translate", fake_translate)
    cache: dict = {}
    mapping, untranslated = rn.resolve_translations([GOOD, GOOD], cache, enabled=True, require=True)
    assert calls == [GOOD]  # de-duplicated by collect_strings' caller and by the cache
    assert cache[rn.text_key(GOOD)] == {"en": GOOD, "de": "Deutsch."}
    assert mapping[GOOD] == "Deutsch." and untranslated == []


def test_without_a_key_the_english_is_published_and_reported(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    mapping, untranslated = rn.resolve_translations([GOOD], {}, enabled=True, require=False)
    assert mapping[GOOD] == GOOD
    assert untranslated == [GOOD]


def test_require_translations_fails_rather_than_shipping_english(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(SystemExit):
        rn.resolve_translations([GOOD], {}, enabled=True, require=True)


class FakeResponse:
    """Stands in for the object urlopen returns."""

    def __init__(self, content=" Deutscher Satz. "):
        self.content = content

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return json.dumps({"choices": [{"message": {"content": self.content}}]}).encode()


def test_translate_posts_to_openrouter_and_returns_the_sentence(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["auth"] = request.headers["Authorization"]
        captured["body"] = json.loads(request.data.decode())
        return FakeResponse()

    monkeypatch.setattr(rn.urllib.request, "urlopen", fake_urlopen)
    assert rn.translate(GOOD, "sk-test", model="test/model") == "Deutscher Satz."
    assert captured["url"] == rn.OPENROUTER_URL
    assert captured["url"].startswith("https://")
    assert captured["auth"] == "Bearer sk-test"
    assert captured["body"]["model"] == "test/model"
    assert captured["body"]["messages"][-1]["content"] == GOOD


def test_an_empty_translation_is_not_published(monkeypatch):
    monkeypatch.setattr(rn.urllib.request, "urlopen", lambda request, timeout=None: FakeResponse("   "))
    monkeypatch.setattr(rn.time, "sleep", lambda _s: None)
    with pytest.raises(RuntimeError):
        rn.translate(GOOD, "sk-test", attempts=2)


def test_translate_retries_then_gives_up(monkeypatch):
    attempts = []

    def always_fails(request, timeout=None):
        attempts.append(1)
        raise TimeoutError("nope")

    monkeypatch.setattr(rn.urllib.request, "urlopen", always_fails)
    monkeypatch.setattr(rn.time, "sleep", lambda _s: None)
    with pytest.raises(RuntimeError):
        rn.translate(GOOD, "sk-test", attempts=3)
    assert len(attempts) == 3


def test_the_translation_file_round_trips(tmp_path):
    path = tmp_path / "de.json"
    rn.save_translations(path, {rn.text_key(GOOD): {"en": GOOD, "de": "Deutsch."}})
    assert rn.load_translations(path) == {rn.text_key(GOOD): {"en": GOOD, "de": "Deutsch."}}


def test_the_translation_file_stores_no_digests(tmp_path):
    """A 16-hex-character key in a JSON file reads as a credential to every scanner.

    detect-secrets failed CI on exactly that (Hex High Entropy String) when the
    cache keyed its entries by digest, and JSON cannot carry the inline
    `pragma: allowlist secret` that would answer it. The key is derived on load
    instead, so there is nothing to allowlist.
    """
    path = tmp_path / "de.json"
    rn.save_translations(path, {rn.text_key(GOOD): {"en": GOOD, "de": "Deutsch."}})
    assert not re.search(r"\b[0-9a-f]{12,}\b", path.read_text(encoding="utf-8"))
    assert json.loads(path.read_text(encoding="utf-8")) == [{"en": GOOD, "de": "Deutsch."}]


def test_the_committed_translation_file_has_the_same_shape():
    entries = json.loads((REPO_ROOT / "releasenotes" / "translations" / "de.json").read_text("utf-8"))
    assert isinstance(entries, list)
    assert all(set(entry) == {"en", "de"} and entry["en"] and entry["de"] for entry in entries)


def test_pruning_drops_translations_no_note_uses_any_more():
    cache = {rn.text_key(GOOD): {"en": GOOD, "de": "x"}, "deadbeef": {"en": "gone", "de": "weg"}}
    assert rn.prune_translations(cache, [GOOD]) == {rn.text_key(GOOD): {"en": GOOD, "de": "x"}}


# ── the artifact ────────────────────────────────────────────────────────────


def test_the_artifact_carries_both_languages_for_every_string():
    groups = rn.group_notes([note("0.0.0", "2026-08-19", features=[GOOD])], ["features"])
    data = rn.build_changelog(groups, SECTIONS, {GOOD: "Deutsch."})
    entry = data["releases"][0]["sections"][0]["notes"][0]
    assert entry == {"en": GOOD, "de": "Deutsch."}
    assert data["sectionTitles"]["features"]["de"] == rn.SECTION_TITLES_DE["features"]


def test_the_artifact_is_serialised_deterministically():
    groups = rn.group_notes([note("0.0.0", "2026-08-19", features=[GOOD])], ["features"])
    data = rn.build_changelog(groups, SECTIONS, {})
    assert rn.dump_json(data) == rn.dump_json(rn.build_changelog(groups, SECTIONS, {}))
    assert rn.dump_json(data).endswith("\n")


def test_the_committed_artifact_is_well_formed():
    """The file the website imports — every note bilingual, every section known."""
    data = json.loads((REPO_ROOT / "frontends" / "web" / "src" / "data" / "changelog.json").read_text("utf-8"))
    public = {key for key, _ in rn.public_sections(SECTIONS)}
    assert set(data["sectionTitles"]) == public
    for release in data["releases"]:
        assert release["kind"] in ("version", "week")
        for section in release["sections"]:
            assert section["key"] in public
            for entry in section["notes"]:
                assert entry["en"] and entry["de"]
                assert not rn.looks_german(entry["en"]), entry["en"]


# ── the PR gate ─────────────────────────────────────────────────────────────


def test_a_product_change_needs_a_note():
    assert require_note.needs_note(["src/aiq_agent/tools/bim/register.py"])
    assert require_note.needs_note(["frontends/ui/src/app/page.tsx"])


def test_tests_and_docs_do_not_need_a_note():
    assert not require_note.needs_note(
        [
            "tests/test_release_notes.py",
            "src/aiq_agent/tools/bim/tests/test_measure.py",
            "frontends/ui/src/app/page.spec.tsx",
            "docs/architecture/overview.md",
            "deploy/pulumi/src/index.ts",
            "frontends/web/src/pages/changelog.astro",
        ]
    )


def test_a_note_in_the_pr_satisfies_the_gate():
    assert require_note.has_note(["releasenotes/notes/re-index-4f2a91c0deadbeef.yaml"])
    assert not require_note.has_note(["releasenotes/config.yaml"])


def _git(repo: Path, *args: str) -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
        # A developer's signing setup must not reach these throwaway commits.
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "commit.gpgsign",
        "GIT_CONFIG_VALUE_0": "false",
    }
    result = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True, env=env)
    return result.stdout.strip()


@pytest.fixture
def pr_repo(tmp_path, monkeypatch):
    """A repository with one product file and one old note, on its base commit."""
    _git(tmp_path, "init", "-q", "-b", "develop")
    (tmp_path / "src/aiq_agent").mkdir(parents=True)
    (tmp_path / "src/aiq_agent/tool.py").write_text("X = 1\n")
    (tmp_path / "releasenotes/notes").mkdir(parents=True)
    (tmp_path / "releasenotes/notes/old-0000.yaml").write_text("features:\n  - Old.\n")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "base")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _pr(repo: Path, files: dict[str, str]) -> int:
    base = _git(repo, "rev-parse", "HEAD")
    for path, text in files.items():
        (repo / path).write_text(text)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "change")
    return require_note.main(["require_release_note.py", base, _git(repo, "rev-parse", "HEAD")])


def test_a_comment_only_edit_to_a_product_file_still_needs_a_note(pr_repo):
    # The check goes by file; a change nobody can notice takes the label instead.
    assert _pr(pr_repo, {"src/aiq_agent/tool.py": "# why X is one\nX = 1\n"}) == 1


def test_a_note_the_pr_adds_satisfies_the_gate(pr_repo):
    files = {"src/aiq_agent/tool.py": "X = 2\n", "releasenotes/notes/new-1111.yaml": "fixes:\n  - New.\n"}

    assert _pr(pr_repo, files) == 0


def test_editing_an_old_note_does_not_satisfy_the_gate(pr_repo):
    files = {"src/aiq_agent/tool.py": "X = 2\n", "releasenotes/notes/old-0000.yaml": "features:\n  - Edited.\n"}

    assert _pr(pr_repo, files) == 1


def test_a_pr_without_product_files_needs_no_note(pr_repo):
    (pr_repo / "docs").mkdir()

    assert _pr(pr_repo, {"docs/readme.md": "Hello\n"}) == 0

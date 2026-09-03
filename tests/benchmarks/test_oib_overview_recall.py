"""Golden file-level recall for broad OIB queries (backlog item 12).

The ratchet items 13/14 are measured against: ~30 German golden questions in
three cohorts (overview / exact-id / paraphrase), scored as recall@16
(k = production top_k) + MRR against a deterministic in-memory fixture corpus.
Offline, no network, no Chroma, no embedder, no PDF, no key — seconds in CI.

BASELINE (recorded 2026-09-03; overview re-recorded after item 13, see ``BASELINE`` below):

| cohort     | recall@16 | mrr   | empty |
|------------|-----------|-------|-------|
| overview   | 0.583     | 0.389 | 0.10  |
| exact-id   | 0.700     | 0.367 | 0.20  |
| paraphrase | 1.000     | 0.553 | 0.00  |

"empty" = share of queries with no firing deterministic channel. The overview
cohort was the known-bad one (item 11): 8 of its 10 queries ranked nothing
until item 13 (casefold identifier) let the "oib N" shape fire the exact
channel — 9 of 10 now rank something. Only ov-cross-rl (bare
"oib-richtlinien", no number, no other signal) still ranks nothing; the two
content-noun queries ("Wohngebäude", "Begriffsbestimmung") scored via sparse
before and still do. Item 14 must LIFT the overview numbers further; when it
does, the floor asserts below go red on purpose — raise them and re-record
the table.

Import fallback as in the sibling benchmark tests: the suite is importable via
``pip install -e frontends/benchmarks/oib_retrieval``, otherwise the src tree
is prepended here so a fresh checkout runs without the editable install.
``aiq_agent`` resolves via ``PYTHONPATH=src`` (set by ``Taskfile.yml`` — never
invoke pytest here without it, or the assertions below validate whatever the
venv installed instead of this worktree).
"""

import json
import sys
import time
from pathlib import Path

import pytest

try:
    from oib_retrieval_eval import overview
except ImportError:
    _SRC = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "src"
    sys.path.insert(0, str(_SRC))
    from oib_retrieval_eval import overview

FIXTURES = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "fixtures"
GOLDEN_PATH = FIXTURES / "oib_golden_overview.json"
PUNKT_INDEX_PATH = FIXTURES / "punkt_index.json"

#: The HEAD baseline the thresholds below are derived from. Re-record (code +
#: table + module docstring) whenever a retrieval change moves the harness.
BASELINE = {
    "overview": {"recall": 0.583, "mrr": 0.389, "empty": 0.10},
    "exact-id": {"recall": 0.700, "mrr": 0.367, "empty": 0.20},
    "paraphrase": {"recall": 1.000, "mrr": 0.553, "empty": 0.00},
}


@pytest.fixture(scope="module")
def entries() -> list[overview.GoldenEntry]:
    return overview.load_golden(GOLDEN_PATH, known_files=frozenset(overview.FIXTURE_TEXTS))


@pytest.fixture(scope="module")
def docs() -> list[overview.FixtureDoc]:
    return overview.fixture_docs()


@pytest.fixture(scope="module")
def index(docs):
    return overview.build_index(docs)


@pytest.fixture(scope="module")
def report(entries) -> overview.Report:
    started = time.perf_counter()
    result = overview.run(entries)
    result_elapsed = time.perf_counter() - started
    # Printed so the CI log (and any failure below) carries the numbers, not
    # just the verdict. pytest shows captured stdout for failed tests.
    print("\n" + overview.format_report(result))
    print(f"\n(harness ran {len(result.results)} queries in {result_elapsed:.1f}s)")
    assert result_elapsed < 60, f"harness budget is 60s, took {result_elapsed:.1f}s"
    return result


def _cohort(report: overview.Report, label: str) -> overview.CohortScores:
    return next(scores for scores in report.cohorts if scores.label == label)


def _diff(report: overview.Report) -> str:
    """The readable per-query diff every threshold failure reports."""
    return "\n" + overview.format_report(report)


# ---------------------------------------------------------------------------
# The golden set's own invariants
# ---------------------------------------------------------------------------


def test_the_golden_set_has_thirty_entries_ten_per_cohort(entries):
    by_cohort: dict[str, int] = {}
    for entry in entries:
        by_cohort[entry.cohort] = by_cohort.get(entry.cohort, 0) + 1
    assert len(entries) == 30
    # Exact counts, not ranges: adding a query is a deliberate instrument change
    # (re-derive the baseline, update BASELINE above). A silent +/-1 that still
    # passes ">= 8" would move every cohort mean without anyone noticing.
    assert by_cohort == {"overview": 10, "exact-id": 10, "paraphrase": 10}


def test_every_expected_file_is_a_real_oib_corpus_name(entries):
    from aiq_agent.common.norm_registry import oib_doc_class

    fixture_files = set(overview.FIXTURE_TEXTS)
    assert len(fixture_files) == 39, "fixture must cover all 39 data/oib files"
    for entry in entries:
        for name in entry.expected:
            assert name in fixture_files, entry.id
            # Production's own filename classifier: a mistyped or invented name
            # classifies as None (unknown), a genuine OIB-corpus name does not.
            assert oib_doc_class(name) is not None, f"{entry.id}: {name!r} is not an OIB-corpus name"


def test_the_normative_expected_files_resolve_against_the_punkt_index(entries):
    """The 12 normative PDFs are the committed Punkt index's file set."""
    payload = json.loads(PUNKT_INDEX_PATH.read_text(encoding="utf-8"))
    indexed_files = {
        punkt["file_name"] for rl, punkte in payload.items() if rl != "_unresolved" for punkt in punkte.values()
    }
    assert len(indexed_files) == 12
    normative = {
        name
        for entry in entries
        for name in entry.expected
        if name.startswith("oib-rl_") and "begriff" not in name and "zitierte" not in name
    }
    assert normative, "the golden set must exercise the normative Richtlinien"
    assert normative <= indexed_files, normative - indexed_files


def test_no_expected_file_is_production_excluded(entries):
    excluded = overview.production_excluded()
    assert len(excluded) == 16, "production exclusion list changed shape — re-derive the baseline"
    for entry in entries:
        assert not (set(entry.expected) & excluded), entry.id


def test_the_loader_rejects_a_duplicate_id(tmp_path):
    payload = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    payload["entries"].append(dict(payload["entries"][0]))
    path = tmp_path / "dupe.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate"):
        overview.load_golden(path)


def test_the_loader_rejects_an_unknown_cohort_and_an_unknown_file(tmp_path):
    payload = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    payload["entries"][0]["cohort"] = "vibes"
    path = tmp_path / "cohort.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="cohort"):
        overview.load_golden(path)

    payload["entries"][0]["cohort"] = "overview"
    payload["entries"][0]["expected_files"] = ["oib-rl_99_ausgabe_mai_2023.pdf"]
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="not in the fixture corpus"):
        overview.load_golden(path, known_files=frozenset(overview.FIXTURE_TEXTS))


def test_the_loader_rejects_an_expected_file_production_filters_out(tmp_path):
    payload = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    payload["entries"][0]["expected_files"] = ["aenderungen_oib-rl_2_ausgabe_mai_2023.pdf"]
    path = tmp_path / "excluded.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="exclude_file_names"):
        overview.load_golden(
            path, known_files=frozenset(overview.FIXTURE_TEXTS) | {"aenderungen_oib-rl_2_ausgabe_mai_2023.pdf"}
        )


# ---------------------------------------------------------------------------
# The item-11 mechanism, pinned at HEAD behaviour
# ---------------------------------------------------------------------------


def test_the_broad_overview_query_sparse_channel_stays_silent(index):
    """The item-11 cause, half-lifted by item 13: lowercase "oib 2" now yields
    the exact term "OIB" (casefold identifier — the deleted ``== []`` assert
    went red on purpose when item 13 landed, per its flip instruction; the
    "oib 2" -> "OIB" pin now lives in
    ``tests/aiq_agent/common/test_legal_terms.py::TestCaseInsensitiveIdentifiers``),
    while the sparse survivors still die at the DF ceiling / digit-only rule.

    The sparse assert is independent of item 13 and must keep holding until a
    sparse-side change moves it.
    """
    assert overview.sparse_terms_for(index, "was weißt du über die oib 2") == []


def test_the_precise_rewrite_of_the_same_intent_fires(index):
    """The asymmetry item 11 describes: the retry wins because uppercase and
    full-spelling terms exist — the broad turn has neither."""
    assert overview.exact_terms_for("OIB-Richtlinie 2") == ["OIB-Richtlinie 2"]
    assert overview.exact_terms_for("OIB-RL 2") == ["OIB-RL"]
    assert overview.sparse_terms_for(index, "Brandschutz im Wohnhaus") != []


# ---------------------------------------------------------------------------
# The baseline gate: cohort floors/ceilings items 13/14 must beat
# ---------------------------------------------------------------------------


def test_the_cutoff_is_production_top_k(report):
    assert report.k == 16, (
        f"cutoff is {report.k}, not 16: production retuned top_k, so every threshold below "
        "was derived at the wrong depth — re-derive BASELINE" + _diff(report)
    )


def test_overview_cohort_recall_has_a_floor(report):
    """Post-item-13 floor (item 11's ceilings, flipped per their instruction):
    the casefold identifier lets the "oib N" shape fire the exact channel
    (overview recall 0.150 -> 0.583, empty 0.80 -> 0.10). Item 14 must lift
    these numbers further — when it does this test goes red, raise the floors
    and re-record BASELINE."""
    scores = _cohort(report, "overview")
    assert scores.recall >= 0.50, _diff(report)
    assert scores.mrr >= 0.30, _diff(report)
    assert scores.empty_share <= 0.20, _diff(report)


def test_the_exemplar_overview_query_now_retrieves(report):
    """Post-item-13: the item-11 exemplar ("was weißt du über die oib 2")
    fires the exact channel ("OIB") and retrieves all 6 expected RL-2 files
    (recall was 0.0 at the item-12 baseline). Re-record on the next move."""
    by_id = {result.entry.id: result for result in report.results}
    assert by_id["ov-rl2"].recall == 1.0, _diff(report)
    assert by_id["ov-rl2"].ranked != ()


def test_exact_id_cohort_recall_has_a_floor(report):
    """Uppercase designations and §-refs with content nouns retrieve; literal
    filenames (no deterministic channel serves them) and the bare short-form
    §-ref honestly score 0 — the 0.70 mean encodes both."""
    scores = _cohort(report, "exact-id")
    assert scores.recall >= 0.60, _diff(report)
    assert scores.mrr >= 0.30, _diff(report)
    by_id = {result.entry.id: result for result in report.results}
    assert by_id["ex-filename-rl2"].recall == 0.0, _diff(report)
    assert by_id["ex-rl2"].recall == 1.0, _diff(report)


def test_paraphrase_cohort_recall_has_a_floor(report):
    """Everyday wordings carry content nouns, so the sparse channel serves all
    ten — this floor guards the tuning work against regressions that trade
    paraphrase recall for overview recall."""
    scores = _cohort(report, "paraphrase")
    assert scores.recall >= 0.90, _diff(report)
    assert scores.mrr >= 0.45, _diff(report)


def test_overview_is_the_weakest_cohort(report):
    """Ordering, not absolute values: whichever retrieval change lands next,
    the broad cohort must not silently overtake the precise ones (that would
    mean the labels stopped discriminating, not that retrieval got better)."""
    recalls = {scores.label: scores.recall for scores in report.cohorts if scores.label != "all"}
    assert recalls["overview"] < recalls["exact-id"], _diff(report)
    assert recalls["overview"] < recalls["paraphrase"], _diff(report)


def test_rankings_are_deterministic(entries):
    first = [result.ranked for result in overview.run(entries).results]
    second = [result.ranked for result in overview.run(entries).results]
    assert first == second

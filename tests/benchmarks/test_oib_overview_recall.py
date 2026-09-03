"""Golden file-level recall for broad OIB queries (backlog item 12).

The ratchet items 13/14 are measured against: ~30 German golden questions in
three cohorts (overview / exact-id / paraphrase), scored as recall@16
(k = production top_k) + MRR against a deterministic in-memory fixture corpus.
Offline, no network, no Chroma, no embedder, no PDF, no key — seconds in CI.

BASELINE (recorded 2026-09-03; overview re-recorded after the item-13 correction):

| cohort     | recall@16 | mrr   | empty |
|------------|-----------|-------|-------|
| overview   | 0.150     | 0.200 | 0.80  |
| exact-id   | 0.700     | 0.367 | 0.20  |
| paraphrase | 1.000     | 0.553 | 0.00  |

"empty" = share of queries with no firing deterministic channel. The overview
cohort is the known-bad one (item 11): 8 of its 10 queries rank nothing, and
only the two content-noun queries ("Wohngebäude", "Begriffsbestimmung") score,
via sparse. That is the honest state and no shipped change has moved it.

Item 13 briefly appeared to move it to 0.583. It did not. Casefolding let
"oib N" emit the bare term ``OIB``, which is on 34 of these 39 fixture files
and 92.3% of real corpus pages — in production a ``$contains`` filter that
removes almost nothing, and offline an unranked dump of the corpus in filename
order. All six "oib N" questions got ONE identical ranking; the 0.583 was
where their labels happened to sit in it, and it moved to 0.750 under nothing
but a reordering of the fixture. The retriever now prices exact terms against
the live collection with the DF ceiling the sparse channel has always had
(``knowledge_layer.llamaindex.hybrid.selective_terms``), this harness mirrors
that rule, and the number went back to the 0.150 it never really left.

A real lift here has to come from a channel that can tell "oib 2" from
"oib 6" — item 14, or the filename/designation-aware lookup the harness
module docstring names. When one lands this test goes red on purpose: raise
the floors and re-record the table.

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
    "overview": {"recall": 0.150, "mrr": 0.200, "empty": 0.80},
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


def test_the_broad_overview_query_reaches_neither_deterministic_channel(index):
    """The item-11 cause, still uncured: no deterministic channel serves
    "was weißt du über die oib 2".

    Both halves die for the SAME reason at two different layers — the token
    that carries the intent is corpus-identity vocabulary. The sparse
    survivors die at ``german_text``'s DF ceiling; the exact term ``OIB`` that
    casefolding extracts (pinned in
    ``tests/aiq_agent/common/test_legal_terms.py::TestCaseInsensitiveIdentifiers``)
    dies at the same ceiling in ``hybrid.selective_terms``, because on this
    corpus it filters nothing.

    This is the query class a real fix has to serve. Until one lands, both
    asserts hold, and a change that flips either without also lifting
    ``ov-rl2`` above has moved a number rather than the retrieval.
    """
    assert overview.sparse_terms_for(index, "was weißt du über die oib 2") == []
    assert (
        overview.exact_files_for(overview.exact_terms_for("was weißt du über die oib 2"), overview.fixture_docs()) == []
    )


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


def test_overview_cohort_is_still_the_unsolved_cohort(report):
    """The overview cohort is a CEILING, not a floor, and that is the point.

    It is the open problem (item 11): 8 of 10 queries reach no deterministic
    channel. A change that lifts these numbers has done something real and
    this test goes red on purpose — raise it to a floor and re-record
    BASELINE. A change that lifts them by widening a channel until it matches
    most of the corpus has done nothing, and the ceiling is what catches that:
    the near-no-op scores here precisely because recall alone cannot tell the
    two apart, so the assert direction has to."""
    scores = _cohort(report, "overview")
    assert scores.recall <= 0.20, _diff(report)
    assert scores.empty_share >= 0.70, _diff(report)


def test_the_exemplar_overview_query_still_does_not_retrieve(report):
    """The item-11 exemplar ("was weißt du über die oib 2") ranks nothing.

    It scored 1.00 for one release on the strength of a term that matched 34
    of 39 files: the six "oib N" questions shared one identical ranking, so
    the exemplar's six RL-2 labels sat inside a list that RL-6's labels sat
    outside of, and nothing about the retrieval distinguished them. Lift this
    with a channel that separates "oib 2" from "oib 6" and the assert flips
    for a reason worth recording."""
    by_id = {result.entry.id: result for result in report.results}
    assert by_id["ov-rl2"].recall == 0.0, _diff(report)
    assert by_id["ov-rl2"].ranked == ()


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

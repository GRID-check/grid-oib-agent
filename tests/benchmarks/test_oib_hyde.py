"""HyDE-as-channel experiment (backlog item 14): on-vs-off measurement.

The instrument is the item-12 golden harness (``oib_retrieval_eval.overview``):
recall@16 per cohort, HyDE on vs off. The on-mode fuses a drafter callback's
passage as one extra RRF channel beside the original query (see
``overview.rank_files_with_hyde``); the draft's dense half has no offline
mirror and is not claimed here.

SHIP CONDITION (backlog item 14): overview lift with NO exact-id/paraphrase
regression. This file pins the regression half (on-without-drafts is
byte-identical to off) and the gating half (the draft callback fires exactly
for the identifier-free queries, never for identifier-shaped ones). A lift
needs RECORDED drafts from the real draft model — see the module docstring of
``oib_retrieval_eval.overview`` for why hand-written drafts would be label
leakage. Until such drafts exist and move the overview number, the channel
stays default-off: a measured negative is a complete result.

Import fallback as in the sibling benchmark tests.
"""

import sys
from pathlib import Path

try:
    from oib_retrieval_eval import overview
except ImportError:
    _SRC = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "src"
    sys.path.insert(0, str(_SRC))
    from oib_retrieval_eval import overview

import pytest

FIXTURES = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "fixtures"
GOLDEN_PATH = FIXTURES / "oib_golden_overview.json"

#: Queries with no exact identifier shape — the only ones the HyDE gate lets
#: through. Derived from the gate (digits/§/quotes/filenames/exact terms),
#: pinned literally so a gate change goes red here on purpose.
HYDE_FIRE_SET = frozenset(
    {
        "ov-cross-rl",
        "ov-which-wohngebaeude",
        "ov-begriffe",
        "ex-begriffe-gebaeudeklasse",
        "pa-brandschutz-wohnhaus",
        "pa-fluchtweg-laenge",
        "pa-fluchtweg-breite",
        "pa-zweiter-fluchtweg",
        "pa-tragwerk",
        "pa-trinkwasser",
        "pa-barrierefrei-tuer",
        "pa-schallschutz",
        "pa-u-wert",
    }
)


@pytest.fixture(scope="module")
def entries() -> list[overview.GoldenEntry]:
    return overview.load_golden(GOLDEN_PATH, known_files=frozenset(overview.FIXTURE_TEXTS))


def _cohort(report: overview.Report, label: str) -> overview.CohortScores:
    return next(scores for scores in report.cohorts if scores.label == label)


def _cohort_table(report: overview.Report) -> dict[str, tuple[float, float, float]]:
    return {scores.label: (scores.recall, scores.mrr, scores.empty_share) for scores in report.cohorts}


def _ranked_table(report: overview.Report) -> dict[str, tuple[str, ...]]:
    return {result.entry.id: result.ranked for result in report.results}


def test_hyde_gate_fires_only_for_identifier_free_queries(entries) -> None:
    """The conditionality pin: the draft callback is reached exactly for the
    fire set — identifier-shaped queries (every §-ref, RL-number, filename,
    and since item 13 every "oib N") never cost a draft call."""
    called: list[str] = []

    def recording_drafter(entry: overview.GoldenEntry) -> str | None:
        called.append(entry.id)
        return None

    overview.run(entries, hyde_drafter=recording_drafter)
    assert set(called) == HYDE_FIRE_SET
    assert len(called) == len(HYDE_FIRE_SET)  # once each, no repeats


def test_hyde_gate_keeps_identifier_shaped_overview_queries_out(entries) -> None:
    """Item-13 consequence: the broad "oib N" overview queries now carry the
    casefold identifier, so the HyDE channel must NOT fire for them — the
    exact channel already serves that shape."""
    assert overview.hyde_fires("was weißt du über die oib 2") is False
    assert overview.hyde_fires("fasse die oib 4 kurz zusammen") is False
    assert overview.hyde_fires("was weißt du über die oib-richtlinien") is True


def test_hyde_on_without_drafts_is_the_baseline(entries) -> None:
    """Fail-open identity: with no draft available the on-mode ranking is
    byte-identical to off — per query and per cohort. This is the
    no-regression half of the ship condition, measured."""
    off = overview.run(entries)
    on = overview.run(entries, hyde_drafter=lambda entry: None)
    assert _ranked_table(on) == _ranked_table(off)
    assert _cohort_table(on) == _cohort_table(off)
    assert all(not result.hyde_fired for result in on.results)


def test_hyde_drafter_errors_degrade_to_the_baseline(entries) -> None:
    """A failing drafter reads as no draft: same numbers as off, no exception."""

    def failing_drafter(entry: overview.GoldenEntry) -> str | None:
        raise RuntimeError("draft model down")

    off = overview.run(entries)
    on = overview.run(entries, hyde_drafter=failing_drafter)
    assert _ranked_table(on) == _ranked_table(off)
    assert _cohort_table(on) == _cohort_table(off)


def test_hyde_on_without_drafts_matches_the_pinned_baseline(entries) -> None:
    """The measured on-vs-off numbers (fail-open): identical to the golden
    floors' baseline — no lift measurable without recorded drafts, no
    regression anywhere."""
    report = overview.run(entries, hyde_drafter=lambda entry: None)
    # Read from the golden test's BASELINE rather than restated: these numbers
    # were duplicated here once, and a retrieval correction moved one copy and
    # not the other. One place to re-record.
    from tests.benchmarks.test_oib_overview_recall import BASELINE

    # Table precision (3dp): the exact identity with off-mode is pinned by
    # test_hyde_on_without_drafts_is_the_baseline above.
    for cohort, expected in BASELINE.items():
        assert _cohort(report, cohort).recall == pytest.approx(expected["recall"], abs=5e-4), cohort


def test_fusion_keeps_the_original_channel_first() -> None:
    """RRF tie-break seat: a file both formulations agree on rises, a file
    only the draft found enters, and at equal score the original channel's
    rank wins (production ``fuse_with_ranks`` contract)."""
    assert overview.fuse_file_channels([["a", "b"], ["b", "c"]]) == ["b", "a", "c"]
    assert overview.fuse_file_channels([["x"], ["x"]]) == ["x"]
    assert overview.fuse_file_channels([[], []]) == []
    assert overview.fuse_file_channels([]) == []


def test_fused_empty_query_stays_empty(entries) -> None:
    """ov-cross-rl ranks nothing at baseline; fusing its own question as the
    draft must still rank nothing — the fused path runs (fired) without
    inventing signal."""
    report = overview.run(entries, hyde_drafter=lambda entry: entry.question)
    by_id = {result.entry.id: result for result in report.results}
    assert by_id["ov-cross-rl"].ranked == ()
    assert by_id["ov-cross-rl"].recall == 0.0
    assert by_id["ov-cross-rl"].hyde_fired is True


def test_draft_text_never_leaks_into_the_report(entries) -> None:
    """The draft is a retrieval probe: ranked files and the printed report
    must never echo it (non-leak at the harness level; in production the
    draft likewise never reaches the formatter — only chunks do)."""
    canary = "HYDE-CANARY-9137-nichtexistierend"

    def canary_drafter(entry: overview.GoldenEntry) -> str | None:
        return f"{entry.question} {canary}"

    report = overview.run(entries, hyde_drafter=canary_drafter)
    assert canary not in overview.format_report(report)
    for result in report.results:
        assert all(name.endswith(".pdf") for name in result.ranked)

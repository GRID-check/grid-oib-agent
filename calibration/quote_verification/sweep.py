"""Grid sweep over the three TUNABLE quote-verification constants.

The sweep calls the REAL ``verify_quoted_spans`` — never a reimplementation.

It exploits the shape of that function to stay cheap: ``threshold`` and
``min_quote_len`` are applied AFTER coverage is computed
(``skip if len(norm_quote) < min_quote_len`` / ``flag if coverage < threshold``),
while ``_QUOTE_MAX_ELIDED_GAP`` is baked into the coverage number itself. So for
each candidate gap value we run the real function once per case with
``threshold=1.01`` and ``min_quote_len=0`` — which makes it return EVERY
extracted span together with its ``best_coverage`` — and then replay the two
post-hoc predicates arithmetically. :func:`verify_replay_matches_real` asserts
that the replay reproduces the real function exactly at any given point of the
grid, so the shortcut is checked rather than assumed.
"""

from __future__ import annotations

import random
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from dataclasses import field

from aiq_agent.common import citation_verification as cv
from calibration.quote_verification.cases import Case
from calibration.quote_verification.cases import build_cases
from calibration.quote_verification.cases import build_registries
from calibration.quote_verification.corpus import Corpus

CURRENT_THRESHOLD = cv.QUOTE_MATCH_THRESHOLD
CURRENT_MIN_LEN = cv.MIN_QUOTE_LEN
CURRENT_GAP = cv._QUOTE_MAX_ELIDED_GAP

# Sentinel threshold above 1.0: every span's coverage is below it, so the real
# function returns all of them and we can read off their coverage.
_RETURN_EVERYTHING = 1.01


@dataclass(frozen=True)
class Span:
    """One extracted quoted span with the coverage the real matcher gave it."""

    norm_len: int
    coverage: float
    text: str


@dataclass
class Observation:
    """All spans the real extractor found in one case's answer, at one gap value."""

    case: Case
    spans: list[Span] = field(default_factory=list)

    def flagged(self, threshold: float, min_len: int) -> bool:
        """Would the user see the unverified marker on this answer?"""
        return any(span.coverage < threshold for span in self.spans if span.norm_len >= min_len)

    def scanned(self, min_len: int) -> bool:
        return any(span.norm_len >= min_len for span in self.spans)


def _observe_serial(cases: list[Case], registries: dict[str, cv.SourceRegistry], gap: int) -> list[list[Span]]:
    """Spans + coverage for each case, with ``_QUOTE_MAX_ELIDED_GAP = gap``."""
    original = cv._QUOTE_MAX_ELIDED_GAP
    cv._QUOTE_MAX_ELIDED_GAP = gap
    try:
        out: list[list[Span]] = []
        for case in cases:
            unverified = cv.verify_quoted_spans(
                case.answer,
                registries[case.registry],
                threshold=_RETURN_EVERYTHING,
                min_quote_len=0,
            )
            out.append(
                [
                    Span(
                        norm_len=len(cv._normalize_for_quote_match(item.quote)),
                        coverage=item.best_coverage,
                        text=item.quote,
                    )
                    for item in unverified
                ]
            )
        return out
    finally:
        cv._QUOTE_MAX_ELIDED_GAP = original


def _observe_worker(payload: tuple[list[Case], dict[str, cv.SourceRegistry], int]) -> list[list[Span]]:
    """Process-pool entry point. Module level so it pickles."""
    return _observe_serial(*payload)


def observe(
    cases: list[Case], registries: dict[str, cv.SourceRegistry], gap: int, *, jobs: int = 1
) -> list[Observation]:
    """Run the real verifier over every case with ``_QUOTE_MAX_ELIDED_GAP = gap``.

    ``difflib`` alignment dominates the runtime and the cases are independent, so
    the work is split across processes when ``jobs > 1``. The result is identical
    either way — each worker patches the constant in its own interpreter.
    """
    if jobs <= 1 or len(cases) < jobs * 4:
        spans_per_case = _observe_serial(cases, registries, gap)
    else:
        stride = (len(cases) + jobs - 1) // jobs
        slices = [cases[start : start + stride] for start in range(0, len(cases), stride)]
        with ProcessPoolExecutor(max_workers=jobs) as pool:
            spans_per_case = [
                spans
                for part in pool.map(_observe_worker, [(slice_, registries, gap) for slice_ in slices])
                for spans in part
            ]
    return [Observation(case=case, spans=spans) for case, spans in zip(cases, spans_per_case, strict=True)]


def _real_decisions(
    payload: tuple[list[Case], dict[str, cv.SourceRegistry], float, int, int],
) -> list[bool]:
    """Whether the REAL function flags each case at a concrete grid point."""
    cases, registries, threshold, min_len, gap = payload
    original = cv._QUOTE_MAX_ELIDED_GAP
    cv._QUOTE_MAX_ELIDED_GAP = gap
    try:
        return [
            bool(
                cv.verify_quoted_spans(
                    case.answer, registries[case.registry], threshold=threshold, min_quote_len=min_len
                )
            )
            for case in cases
        ]
    finally:
        cv._QUOTE_MAX_ELIDED_GAP = original


def verify_replay_matches_real(
    cases: list[Case],
    registries: dict[str, cv.SourceRegistry],
    observations: list[Observation],
    *,
    threshold: float,
    min_len: int,
    gap: int,
    jobs: int = 1,
) -> tuple[int, list[str]]:
    """Cross-check the arithmetic replay against a real run at one grid point.

    Returns (cases_checked, disagreeing_case_ids). A non-empty second element
    means the replay shortcut is invalid and the run must be treated as void.
    """
    if jobs <= 1 or len(cases) < jobs * 4:
        decisions = _real_decisions((cases, registries, threshold, min_len, gap))
    else:
        stride = (len(cases) + jobs - 1) // jobs
        slices = [cases[start : start + stride] for start in range(0, len(cases), stride)]
        with ProcessPoolExecutor(max_workers=jobs) as pool:
            decisions = [
                decision
                for part in pool.map(
                    _real_decisions, [(slice_, registries, threshold, min_len, gap) for slice_ in slices]
                )
                for decision in part
            ]
    disagreements = [
        observation.case.case_id
        for observation, real in zip(observations, decisions, strict=True)
        if real != observation.flagged(threshold, min_len)
    ]
    return len(cases), disagreements


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Score:
    """Outcome of the whole corpus at one (threshold, min_len, gap) point."""

    threshold: float
    min_len: int
    gap: int
    verify_total: int
    false_positives: int
    flag_total: int
    false_negatives: int
    attribution_total: int
    attribution_missed: int
    grey_total: int
    grey_flagged: int

    @property
    def fp_rate(self) -> float:
        return self.false_positives / self.verify_total if self.verify_total else 0.0

    @property
    def fn_rate(self) -> float:
        return self.false_negatives / self.flag_total if self.flag_total else 0.0


def score(observations: list[Observation], *, threshold: float, min_len: int, gap: int) -> Score:
    counters: dict[str, int] = defaultdict(int)
    for observation in observations:
        label = observation.case.label
        flagged = observation.flagged(threshold, min_len)
        counters[f"{label}_total"] += 1
        if label == "verify" and flagged:
            counters["false_positives"] += 1
        elif label == "flag" and not flagged:
            counters["false_negatives"] += 1
        elif label == "attribution" and not flagged:
            counters["attribution_missed"] += 1
        elif label == "grey" and flagged:
            counters["grey_flagged"] += 1
    return Score(
        threshold=threshold,
        min_len=min_len,
        gap=gap,
        verify_total=counters["verify_total"],
        false_positives=counters["false_positives"],
        flag_total=counters["flag_total"],
        false_negatives=counters["false_negatives"],
        attribution_total=counters["attribution_total"],
        attribution_missed=counters["attribution_missed"],
        grey_total=counters["grey_total"],
        grey_flagged=counters["grey_flagged"],
    )


def per_family(observations: list[Observation], *, threshold: float, min_len: int) -> dict[str, tuple[int, int]]:
    """{family: (cases, wrong_outcomes)} at one grid point."""
    out: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for observation in observations:
        case = observation.case
        flagged = observation.flagged(threshold, min_len)
        expected_flag = case.label in {"flag", "attribution"}
        out[case.family][0] += 1
        if flagged != expected_flag:
            out[case.family][1] += 1
    return {family: (total, wrong) for family, (total, wrong) in sorted(out.items())}


def worst_verify_cases(
    observations: list[Observation], *, threshold: float, min_len: int, limit: int = 15
) -> list[tuple[str, str, int, float]]:
    """The genuine quotes closest to (or past) the flagging cliff."""
    rows: list[tuple[str, str, int, float]] = []
    for observation in observations:
        if observation.case.label != "verify":
            continue
        scanned = [span for span in observation.spans if span.norm_len >= min_len]
        if not scanned:
            continue
        worst = min(scanned, key=lambda span: span.coverage)
        rows.append((observation.case.case_id, observation.case.noise_class, worst.norm_len, worst.coverage))
    rows.sort(key=lambda row: row[3])
    return rows[:limit]


def build_everything(
    corpus: Corpus, *, max_sentences: int | None = None
) -> tuple[list[Case], dict[str, cv.SourceRegistry]]:
    rng = random.Random(20260728)
    registries = build_registries(corpus, rng)
    return build_cases(corpus, max_sentences=max_sentences), registries

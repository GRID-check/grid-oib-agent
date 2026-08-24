"""Deterministic, LLM-free scoring for the OIB compliance golden eval suite.

Two independent axes are graded per case:

1. **Correctness** — a checklist of expected key facts, each satisfied by a
   substring/keyword (optionally regex) match against the agent's answer.
   This is intentionally *not* an LLM-judge: it is meant to be fast, free,
   deterministic, and fully unit-testable offline (see
   ``tests/benchmarks/test_oib_compliance_checklist.py``), so it can run in
   CI without live model access and still catch gross regressions (an answer
   that stops citing OIB-RL 2, stops naming the missing Nachweise, or starts
   hallucinating a nonexistent document).
2. **Performance bounds** — wall-clock seconds, LLM call count, and
   completion tokens for the run, checked against generous initial
   calibration-pending bounds (see ``DEFAULT_BOUNDS``) so latency/cost
   regressions show up in eval output without failing the whole case.

Nothing in this module imports NAT or an LLM client. ``evaluator.py`` is the
thin NAT-facing wrapper that feeds it real ``EvalInputItem`` data.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict
from dataclasses import dataclass
from dataclasses import field
from typing import Any

# Generous, intentionally loose starting bounds (backlog T4-5): today's audit
# fixed the 20+ minute runaway-run bugs, so these exist to catch a *return*
# of that class of regression, not to enforce a tight SLA yet. Tighten once a
# handful of live runs establish a real baseline (see README "Calibration").
DEFAULT_BOUNDS: dict[str, float] = {
    "max_wall_clock_s": 600,
    "max_llm_calls": 150,
    "max_completion_tokens": 60_000,
}

DEFAULT_PASS_THRESHOLD = 0.75


def normalize_text(text: str | None) -> str:
    """Casefold + NFKC-normalize text for robust German-language substring matching."""
    if not text:
        return ""
    return unicodedata.normalize("NFKC", text).casefold()


def _contains_phrase(haystack_norm: str, phrase: str) -> bool:
    return normalize_text(phrase) in haystack_norm


@dataclass
class ChecklistItemResult:
    """Outcome of grading a single checklist item against a response."""

    id: str
    description: str
    passed: bool
    weight: float
    matched_any: list[str] = field(default_factory=list)
    matched_regex: list[str] = field(default_factory=list)
    missing_all: list[str] = field(default_factory=list)
    present_forbidden: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ChecklistItem:
    """A single expected-fact checklist entry.

    An item passes when ALL specified conditions hold:
      - ``any_of``: at least one phrase is present (OR) — omit for "no requirement".
      - ``any_regex``: at least one regex matches (OR) — for facts that vary
        (e.g. "cites a specific 4-digit OIB edition year") where hardcoding a
        literal substring would be brittle or (worse) assert a fact we can't
        independently verify offline.
      - ``all_of``: every phrase is present (AND).
      - ``none_of``: no phrase is present — hallucination/fabrication guard.
    """

    id: str
    description: str = ""
    any_of: list[str] = field(default_factory=list)
    any_regex: list[str] = field(default_factory=list)
    all_of: list[str] = field(default_factory=list)
    none_of: list[str] = field(default_factory=list)
    weight: float = 1.0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ChecklistItem:
        item_id = str(data.get("id") or data.get("description") or "").strip()
        if not item_id:
            raise ValueError(f"Checklist item is missing an 'id' (and 'description' fallback): {data!r}")
        return cls(
            id=item_id,
            description=str(data.get("description", "")),
            any_of=list(data.get("any_of", [])),
            any_regex=list(data.get("any_regex", [])),
            all_of=list(data.get("all_of", [])),
            none_of=list(data.get("none_of", [])),
            weight=float(data.get("weight", 1.0)),
        )

    def evaluate(self, response_norm: str) -> ChecklistItemResult:
        matched_any = [p for p in self.any_of if _contains_phrase(response_norm, p)]
        matched_regex = [p for p in self.any_regex if re.search(p, response_norm, flags=re.IGNORECASE)]
        missing_all = [p for p in self.all_of if not _contains_phrase(response_norm, p)]
        present_forbidden = [p for p in self.none_of if _contains_phrase(response_norm, p)]

        any_ok = (not self.any_of and not self.any_regex) or bool(matched_any or matched_regex)
        all_ok = not missing_all
        none_ok = not present_forbidden

        return ChecklistItemResult(
            id=self.id,
            description=self.description,
            passed=any_ok and all_ok and none_ok,
            weight=self.weight,
            matched_any=matched_any,
            matched_regex=matched_regex,
            missing_all=missing_all,
            present_forbidden=present_forbidden,
        )


@dataclass
class ChecklistScore:
    """Aggregate result of grading a response against a full checklist."""

    items: list[ChecklistItemResult]
    score: float
    threshold: float
    passed_threshold: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "threshold": self.threshold,
            "passed_threshold": self.passed_threshold,
            "items": [item.to_dict() for item in self.items],
        }


def score_checklist(
    response: str | None,
    checklist: list[dict[str, Any]],
    *,
    threshold: float = DEFAULT_PASS_THRESHOLD,
) -> ChecklistScore:
    """Grade ``response`` against a list of checklist-item dicts (see ``ChecklistItem``).

    An empty checklist scores 0.0 (never "passes") rather than dividing by
    zero — a case with no checklist is a fixture bug, not a free pass.
    """
    response_norm = normalize_text(response)
    items = [ChecklistItem.from_dict(entry).evaluate(response_norm) for entry in checklist]

    if not items:
        return ChecklistScore(items=[], score=0.0, threshold=threshold, passed_threshold=False)

    total_weight = sum(item.weight for item in items)
    achieved_weight = sum(item.weight for item in items if item.passed)
    score = round(achieved_weight / total_weight, 4) if total_weight else 0.0

    return ChecklistScore(items=items, score=score, threshold=threshold, passed_threshold=score >= threshold)


@dataclass
class RunMetrics:
    """Per-case performance metrics, derived from a NAT ``EvalInputItem.trajectory``."""

    wall_clock_seconds: float = 0.0
    llm_calls: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class BoundsResult:
    """Outcome of checking ``RunMetrics`` against performance bounds."""

    bounds: dict[str, float]
    metrics: dict[str, float]
    within_bounds: bool
    violations: list[str]
    calibration_pending: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def check_bounds(
    metrics: RunMetrics,
    bounds: dict[str, float] | None = None,
    *,
    calibration_pending: bool = True,
) -> BoundsResult:
    """Check ``metrics`` against ``bounds`` (merged over ``DEFAULT_BOUNDS``)."""
    effective_bounds = {**DEFAULT_BOUNDS, **(bounds or {})}
    violations: list[str] = []

    if metrics.wall_clock_seconds > effective_bounds["max_wall_clock_s"]:
        violations.append(
            f"wall_clock_seconds={metrics.wall_clock_seconds:.1f}s exceeds "
            f"max_wall_clock_s={effective_bounds['max_wall_clock_s']}s"
        )
    if metrics.llm_calls > effective_bounds["max_llm_calls"]:
        violations.append(f"llm_calls={metrics.llm_calls} exceeds max_llm_calls={effective_bounds['max_llm_calls']}")
    if metrics.completion_tokens > effective_bounds["max_completion_tokens"]:
        violations.append(
            f"completion_tokens={metrics.completion_tokens} exceeds "
            f"max_completion_tokens={effective_bounds['max_completion_tokens']}"
        )

    return BoundsResult(
        bounds=effective_bounds,
        metrics=metrics.to_dict(),
        within_bounds=not violations,
        violations=violations,
        calibration_pending=calibration_pending,
    )


def grade_case(
    response: str | None,
    expected: dict[str, Any],
    metrics: RunMetrics | None = None,
    *,
    default_threshold: float = DEFAULT_PASS_THRESHOLD,
) -> dict[str, Any]:
    """Grade one golden case: checklist correctness + performance bounds.

    ``expected`` is the case's ``expected_output`` dict (checklist, optional
    pass_threshold/bounds/bounds_calibration_pending overrides). Returns a
    plain dict (not dataclasses) so it drops straight into a NAT
    ``EvalOutputItem.reasoning`` field.
    """
    checklist = expected.get("checklist", [])
    threshold = float(expected.get("pass_threshold", default_threshold))
    checklist_score = score_checklist(response, checklist, threshold=threshold)

    bounds_cfg = expected.get("bounds")
    calibration_pending = bool(expected.get("bounds_calibration_pending", True))
    bounds_result = check_bounds(metrics or RunMetrics(), bounds_cfg, calibration_pending=calibration_pending)

    return {
        "checklist": checklist_score.to_dict(),
        "bounds": bounds_result.to_dict(),
        "score": checklist_score.score,
        "is_correct": checklist_score.passed_threshold,
    }

"""Why a reader rated an answer unhelpful, as a label (ADR-0064, use 9).

A down-vote carries one of four coarse chips (inaccurate, too slow, wrong
source, other) and sometimes a comment, and the comment is where the cause is:
„In GK 4 ist es R 60, nicht R 90" and „Das ist die Wiener Regelung, wir sind in
Tirol" are both `inaccurate` to the chip and two different defects to whoever
has to fix them. Filing a comment under one of ten causes is a choice over a
state, so the decision model labels each down-vote the feedback digest samples,
and the digest reads — and the Quality page shows — the counts.

A label annotates an operator's view. Nothing a reader sees depends on it, and
a vote the decider could not label is counted as unlabelled, not guessed.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from typing import Any

#: The causes, in the decider's language. Keys are stable: the page translates them.
CAUSES: dict[str, str] = {
    "wrong_value": "The answer states a wrong number, class or requirement, or misread a table or the project's facts.",
    "wrong_rule": (
        "The answer used the wrong regulation: another Land's law, an outdated edition, an OIB-Richtlinie where "
        "a Bauordnung applies, or the wrong Punkt or §."
    ),
    "incomplete": (
        "The answer is right as far as it goes but leaves out a case, a threshold, an exception or a requirement "
        "that matters."
    ),
    "misunderstood": (
        "The answer addresses a different question than the one asked (another building type, use, element or "
        "situation)."
    ),
    "no_source": "The answer gives no source, or a source the reader cannot check.",
    "not_found": (
        "The assistant did not find or could not open a document the reader has (a project file, a Bescheid, a plan)."
    ),
    "form": (
        "The content may be right but the form is the problem: too long, unclear, badly structured, a table that "
        "does not help."
    ),
    "slow": "The answer took too long — also when the reader only picked the reason 'too_slow' and wrote nothing.",
    "broken": "The answer is cut off, empty, garbled or shows an error.",
    "other": "None of the above, or no way to tell from what was written.",
}

#: A label counts at this probability; below it the vote is unlabelled. Measured
#: 2026-09-26 on sixteen down-votes (``tests/fixtures/decisions/feedback_causes.yaml``):
#: 16/16 right, the lowest 0.89 once `slow` covers a bare 'too_slow' chip
#: with no comment (0.75-0.79 before). Held-out (24 down-votes written blind):
#: 20 right, 1 wrong, 3 left unlabelled, with or without that change.
CAUSE_THRESHOLD = 0.8
SLOT = "feedback_causes"
CAUSE_QUESTION = (
    "Why did the reader rate this answer as unhelpful? Read the comment first, then the reason they "
    "picked and the question."
)
_MAX_TEXT = 300


def _state(sample: Any) -> dict[str, str]:
    state = {"question": str(getattr(sample, "question", "") or "")[:_MAX_TEXT]}
    if getattr(sample, "reason", None):
        state["reason"] = str(sample.reason)
    if getattr(sample, "comment", None):
        state["comment"] = str(sample.comment)[:_MAX_TEXT]
    return state


async def label_causes(samples: Sequence[Any], *, organization_id: str | None = None) -> list[str | None]:
    """One cause per down-vote sample, ``None`` where none was decided."""
    if not samples:
        return []
    from aiq_agent.common.decisions import choice
    from aiq_agent.common.decisions import decide_many

    decided = await decide_many(
        [_state(sample) for sample in samples],
        {"cause": choice(CAUSE_QUESTION, CAUSES)},
        slot=SLOT,
        organization_id=organization_id,
    )
    labels: list[str | None] = []
    for decision in decided:
        cause, distribution = decision.choice("cause") if decision is not None else (None, {})
        labels.append(cause if cause in CAUSES and distribution.get(cause, 0.0) >= CAUSE_THRESHOLD else None)
    return labels


def count_causes(labels: Sequence[str | None]) -> dict[str, int]:
    """Labelled causes, most frequent first; unlabelled votes are not counted."""
    return dict(Counter(label for label in labels if label).most_common())

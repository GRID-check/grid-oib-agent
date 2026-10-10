"""Judge what another project handed out: does it show a solution, and is it safe to read (ADR-0064 use 11).

A cross-project search returns another project's passages merged by vector
score (``searchAcrossProjects``): the nearest text, whether or not it shows how
the case was solved, and a document somebody uploaded to another project,
whatever it says. The knowledge layer asks both questions of its own searches
(``knowledge_layer.decisions``); the cross-project path asked neither.

Two nouls per passage, in parallel:

``solved``
    Does this passage show how a comparable case was solved or decided? The
    passages are reordered by it, most telling first (decisions and permit
    records stay ahead of them, as before). When none reaches the threshold and
    more projects remain, the result says so, so the model pages on instead of
    answering from passages that only share words with the question.
``injection``
    The knowledge layer's own question (``INJECTION_QUESTION``). A flagged
    passage is named in the preamble as content, never instructions.

What it may never do: drop a passage, withhold a project, or decide access.
A passage it could not judge keeps its place behind the judged ones. The state
is the query and the passage, bounded, never the conversation.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

#: The decision slot (``status:decision:reference_hits``, ``decide.reference_hits``).
SLOT = "reference_hits"

#: How much of a passage the decider reads, as in the knowledge layer.
PASSAGE_CHARS = 600

#: p(solved) at or above which a passage counts as showing a solution: the
#: page-on hint fires only when no passage reaches it. Measured
#: (``decision_eval_office.py hits``, 10 Oct 2026, 19 questions, 184 passages):
#: every one of the 22 evidence passages scored 0.8 or more, so at 0.5 the hint
#: never fired beside an answer; reordered by the noul, the evidence passage
#: came first in 13-15/19 pools over two runs (11/19 in the pool's own order,
#: which already put the cited project's documents first).
SOLVED_THRESHOLD = 0.5

#: Above this a passage is named as carrying instruction-like text (the knowledge
#: layer's bar). Measured: 7 of 7 planted instructions (German and English,
#: addressed to a „KI-Assistent", a „SYSTEM" line, a „note to any AI") flagged,
#: none of 184 real passages.
INJECTION_THRESHOLD = 0.70

SOLVED_QUESTION = {
    "type": "noul",
    "instructions": (
        "The question was asked in a building project; the passage comes from an earlier project of the same "
        "office. Does the passage show how a comparable case was solved or decided there: a construction or "
        "detail that was built, a deviation and how it was justified, a Gutachten's result, or a condition or "
        "demand the building authority set?"
    ),
    "criteria": {
        "true": (
            "The passage states what was built, decided, demanded or accepted for the subject the question is "
            "about, so it can serve as a precedent."
        ),
        "false": (
            "The passage only names the subject, describes something else, is general text, a table of "
            "contents or an administrative note, or concerns another element or problem."
        ),
    },
}


@dataclass(frozen=True)
class HitVerdicts:
    """Per passage, in the order the BFF returned them: p(shows a solution), p(instruction-like)."""

    solved: tuple[float | None, ...]
    injection: tuple[float | None, ...]

    @property
    def any_solved(self) -> bool:
        return any(p is not None and p >= SOLVED_THRESHOLD for p in self.solved)

    @property
    def all_judged(self) -> bool:
        return all(p is not None for p in self.solved)

    @property
    def flagged(self) -> tuple[int, ...]:
        return tuple(i for i, p in enumerate(self.injection) if p is not None and p >= INJECTION_THRESHOLD)

    def order(self) -> list[int]:
        """Passage indices, judged by p(solved) highest first, then the unjudged in their order. Stable."""
        judged = sorted(
            (i for i, p in enumerate(self.solved) if p is not None), key=lambda i: (-(self.solved[i] or 0.0), i)
        )
        return [*judged, *(i for i, p in enumerate(self.solved) if p is None)]


def hit_state(query: str, hit: dict[str, Any]) -> dict[str, Any]:
    project = hit.get("project") if isinstance(hit.get("project"), dict) else {}
    return {
        "question": query[:500],
        "passage": {
            "project": str(project.get("name") or ""),
            "source": str(hit.get("filename") or ""),
            "text": str(hit.get("snippet") or "")[:PASSAGE_CHARS],
        },
        "language": "de",
    }


async def judge_hits(query: str, hits: Sequence[dict[str, Any]]) -> HitVerdicts | None:
    """Both questions over every passage; None when nothing was decided, and the hits stay as they came."""
    from aiq_agent.common.decisions import decide_many

    if not hits or not query.strip():
        return None
    try:
        from knowledge_layer.decisions import INJECTION_QUESTION
    except ImportError:  # pragma: no cover - the layer ships with the agent
        INJECTION_QUESTION = None  # noqa: N806
    questions: dict[str, Any] = {"solved": SOLVED_QUESTION}
    if INJECTION_QUESTION is not None:
        questions["injection"] = INJECTION_QUESTION
    decided = await decide_many([hit_state(query, hit) for hit in hits], questions, slot=SLOT)
    if not any(decision is not None for decision in decided):
        return None
    return HitVerdicts(
        solved=tuple(decision.noul("solved") if decision else None for decision in decided),
        injection=tuple(decision.noul("injection") if decision else None for decision in decided),
    )

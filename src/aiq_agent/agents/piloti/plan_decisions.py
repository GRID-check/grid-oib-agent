"""The decision model's pre-selection for a research plan: genre and depth.

A commissioned Prüfung and a commissioned Gutachten are different documents
with different lengths, and the planner used to guess the shape from prose
alone. The decision model (ADR-0064) reads the request and the project facts
once and proposes a genre and a depth; the planner is told, and may still
follow the request where it disagrees. Additive, like every decision: it
suggests, it never withholds.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from aiq_agent.common.decisions import choice
from aiq_agent.common.decisions import decide

SLOT = "plan"
THRESHOLD = 0.5

GENRES: dict[str, str] = {
    "pruefbericht": (
        "A Prüfbericht: requirements read against this project, one finding per requirement with status and Fundstelle"
    ),
    "aktenvermerk": "An Aktenvermerk: a short decision memo recording a question, the rule and the decision taken",
    "vergleich": "A Vergleich: two or more variants, jurisdictions or options compared on the same criteria",
    "checkliste": "A Checkliste: the documents, proofs or steps a submission or procedure needs, as a list",
    "bericht": "A Bericht: an explanatory long-form report on a subject with sections and depth",
}

DEPTHS: dict[str, str] = {
    "kurzpruefung": (
        "A Kurzprüfung: the smallest complete answer, the governing rule and the finding per point, no narrative"
    ),
    "gutachten": "A Gutachten: full depth, the derivation and the caveats written out per point",
}

QUESTIONS: dict[str, dict[str, Any]] = {
    "genre": choice("Which document genre does the request commission?", GENRES),
    "depth": choice("How deep should the report go?", DEPTHS),
}


@dataclass(frozen=True)
class PlanShape:
    """What the decision proposed; ``None`` where it was not confident."""

    genre: str | None = None
    depth: str | None = None

    @property
    def decided(self) -> bool:
        return self.genre is not None or self.depth is not None


async def decide_plan_shape(
    question: str, project_facts: str | None, *, organization_id: str | None = None, transport: Any = None
) -> PlanShape:
    """One decision call before the planner runs; never raises, never blocks the plan."""
    state = {"request": question[:1500], "project": (project_facts or "")[:1500]}
    decision = await decide(state, QUESTIONS, slot=SLOT, organization_id=organization_id, transport=transport)
    if decision is None:
        return PlanShape()
    genre, genre_p = decision.choice("genre")
    depth, depth_p = decision.choice("depth")
    return PlanShape(
        genre=genre if genre in GENRES and _confident(genre_p, genre) else None,
        depth=depth if depth in DEPTHS and _confident(depth_p, depth) else None,
    )


def _confident(distribution: Any, option: str | None) -> bool:
    if option is None:
        return False
    if isinstance(distribution, dict):
        return float(distribution.get(option, 0.0)) >= THRESHOLD
    return True

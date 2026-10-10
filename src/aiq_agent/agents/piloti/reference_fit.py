"""Rank, then verify: which of the office's reference projects fit THIS question (ADR-0064 use 10).

The catalog (``<referenzprojekte>``, ADR-0094) is ranked by fingerprint in the
BFF (``similarity.ts``): Bundesland, Gebäudeklasse, Bauweise, uses, kind of
work. That ranking is blind to the question. A timber house asking about a
Sicherheitstreppenhaus is best served by the office building in Wien 22 that
had one, which shares nothing of the fingerprint and sits last.

This is TypeSafe's skill-suggestion cookbook applied to projects: the
fingerprint ranks, then one ``fits`` noul per catalog line verifies against the
message, in parallel and beside the turn decision. What it may do:

* move the lines that fit ahead of those that do not, each group in the
  BFF's likeness order (a partition, not a sort: measured, sorting by the
  raw score reshuffled four Holzbau projects scoring 0.77-0.78 and pushed the
  one with the Traufe detail from first to fifth; the partition keeps it
  first and still lifts the Wien 22 office building with the
  Sicherheitstreppenhaus from seventh to first);
* hand the same order to every ``similar`` or ``closed`` search of the turn
  (``CrossProjectTurn.reference_order``), the round-0 prefetch included, so a
  search of eight projects searches the eight that fit, not the eight most
  alike.

What it may never do (ADR-0064's rule): drop a project, narrow a scope, or
decide access. A line it could not score keeps its place among the unscored,
and a fit that did not run leaves the catalog as the BFF wrote it.

The state is one catalog line (its name, years, facts, what it shares and its
summary, never its id or anything from its documents) and the message: small
and structured, as the vendor asks.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: The decision slot (``status:decision:reference_fit``, ``decide.reference_fit``).
SLOT = "reference_fit"

#: Fewer catalog lines than this are not worth a reorder.
MIN_LINES = 2

#: p(fits) at or above which a line counts as fitting and moves ahead.
#: Nothing is dropped below it. Measured (``scripts/decision_eval_office.py
#: fit``, 10 Oct 2026, 19 questions whose answer must cite a closed project):
#: the cited project ranked first in 10/19 by fingerprint alone; partitioned
#: at 0.5 in 14/19, at 0.6 in 16/19 (MRR 0.695 → 0.893), and no question got
#: worse at either; at 0.7 and 0.8 two did, the fit splitting projects that
#: are all alike enough.
FIT_THRESHOLD = 0.6

#: How long a catalog line may be in the state.
LINE_CHARS = 400

#: A line of the catalog: ``- <name> (id <uuid>)<rest>``.
_LINE = re.compile(r"^- (?P<name>.+?) \(id (?P<id>[0-9a-fA-F-]{36})\)(?P<rest>.*)$")

FITS_QUESTION = {
    "type": "noul",
    "instructions": (
        "The message was asked in a building project. The state names one earlier project of the same office. "
        "Could that earlier project hold a useful answer: did it likely face the same decision, building "
        "element, construction, deviation, Gutachten or authority demand the message is about?"
    ),
    "criteria": {
        "true": (
            "The earlier project's facts or summary concern what the message asks about (the same element, "
            "construction, use, authority or kind of decision), so its documents may show how it was solved."
        ),
        "false": (
            "The earlier project concerns other things than the message: another element, use or problem; "
            "sharing only the Land or the building class is not enough."
        ),
    },
}


@dataclass(frozen=True)
class CatalogLine:
    project_id: str
    text: str


@dataclass(frozen=True)
class ReferenceFit:
    """The fit of each catalog project, and the catalog reordered by it."""

    #: ``(project_id, p)`` in the new order; ``p`` None where the line was not scored.
    ranked: tuple[tuple[str, float | None], ...]
    catalog: str

    @property
    def order(self) -> list[str]:
        return [project_id for project_id, _ in self.ranked]


def parse_catalog(catalog: str | None) -> tuple[list[CatalogLine], list[str]]:
    """The project lines and every other line (the „… und N weitere" tail), in order."""
    lines: list[CatalogLine] = []
    rest: list[str] = []
    for line in (catalog or "").splitlines():
        match = _LINE.match(line)
        if match:
            lines.append(CatalogLine(project_id=match["id"].lower(), text=line))
        elif line.strip():
            rest.append(line)
    return lines, rest


def line_state(question: str, line: CatalogLine) -> dict[str, Any]:
    """What the decider reads for one line: the message and the line without its id."""
    match = _LINE.match(line.text)
    project = f"{match['name']}{match['rest']}" if match else line.text
    return {"message": question[:600], "earlier_project": project[:LINE_CHARS], "language": "de"}


def reorder(
    lines: list[CatalogLine], scores: list[float | None], threshold: float = FIT_THRESHOLD
) -> list[tuple[CatalogLine, float | None]]:
    """The fitting lines first, then the rest, each in the BFF's order. An unscored line counts as not fitting."""
    pairs = list(zip(lines, scores, strict=True))
    fitting = [(line, p) for line, p in pairs if p is not None and p >= threshold]
    return [*fitting, *((line, p) for line, p in pairs if p is None or p < threshold)]


async def fit_references(
    question: str, catalog: str | None, *, organization_id: str | None = None
) -> ReferenceFit | None:
    """The catalog verified against the question, or None when nothing was decided."""
    from aiq_agent.common.decisions import decide_many

    lines, rest = parse_catalog(catalog)
    if len(lines) < MIN_LINES or not question.strip():
        return None
    decided = await decide_many(
        [line_state(question, line) for line in lines],
        {"fits": FITS_QUESTION},
        slot=SLOT,
        organization_id=organization_id,
    )
    scores = [decision.noul("fits") if decision is not None else None for decision in decided]
    if all(score is None for score in scores):
        return None
    ordered = reorder(lines, scores)
    logger.info(
        "Reference fit: %s",
        ", ".join(f"{line.project_id[:8]}={'-' if p is None else f'{p:.2f}'}" for line, p in ordered[:6]),
    )
    return ReferenceFit(
        ranked=tuple((line.project_id, p) for line, p in ordered),
        catalog="\n".join([*(line.text for line, _ in ordered), *rest]),
    )

"""Project likeness as an input to the one cross-project ranking (design §7, item 3).

The BFF used to decide which projects got searched at all from the hand-set
fingerprint similarity (``frontends/ui/src/lib/cross-project/similarity.ts``).
With every reachable project in one query, the similarity becomes a ranking
input instead: a wrong weight nudges an order rather than hiding a project.

## Shape: each channel rescored before the fusion, not the fusion rescored

The obvious shape is ``$score + w * (fact matches)`` as a formula over a
prefetch that does the RRF. Qdrant computes a fusion that sits inside a
prefetch on each shard, over that shard's points only ("a fusion merges results
across all shards only when it is the main query"), and a main query cannot be
both a fusion and a formula. The office collection is meant to run on six
shards (design §9). Measured on 1.19.2, nesting moved the order even with
``$score`` alone as the formula: the grouped top 10 overlapped the top-level
fusion's by 0.84 on one shard and 0.39 on six. That breaks the one comparable
ranking cross-project search exists for (``test_qdrant_boost.py`` pins both
facts).

Separate likeness channels fused beside dense and BM25 do not work either.
Qdrant's weighted RRF scales a channel's RANK, not its vote: a channel of
weight ``w`` adds ``1 / (k - 1 + rank / w)``. A small weight therefore does not
give a small bonus. It gives the channel's first passage nearly a full vote,
and almost nothing to the passages below it.

So the fusion stays the main query, and each of its channels is rescored first:

    $score * (1 + LIKENESS * sum(weight_i * condition_i) / most)

``condition_i`` asks one term of ``similarity()`` of the passage's project (the
Land, the same Gebäudeklasse, a neighbouring one, the Bauweise, one shared use,
a second shared use, the kind of work), weighted as the BFF weighs it, and
``most`` is the likeness of a project that shares every fact. A passage whose
project shares everything gains ``LIKENESS`` of its own score in each channel.
A formula over a plain vector score is pointwise, so it gives the same answer on
any number of shards. Multiplying rather than adding keeps one constant for
both channels, whose score scales differ (a cosine, a BM25 sum); a channel's
retrieved candidates score above zero (BM25 always does, and so does a
production embedder's cosine for a passage worth ranking).

Likeness only re-ranks a channel's own candidates and never pulls a passage
in on its project's facts alone. The weights arrive in the request, from the
BFF's ``SIMILARITY_WEIGHTS``, so they are set in one place. Only this module
turns them into Qdrant terms.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from dataclasses import fields
from itertools import combinations
from typing import Any

from qdrant_client import models

from .payload import project_payload
from .schema import PROJECT_FACTS_FIELD
from .schema import fact_field

#: The share of its own score a passage gains in each channel when its project
#: shares every fact with the current one. 0.05 lifts a 0.50 cosine to 0.525:
#: enough to put a similar project's passage ahead of near-equal ones from
#: projects that share nothing, not enough to beat a clearly better passage.
#: Hand-set like the weights. The answer suite (gate G1) is where it is tuned.
LIKENESS = 0.05

#: Uses compared for "at least n shared". The combinations grow as n choose
#: k, and the intake records a handful of uses per project.
MAX_NUTZUNGEN = 6


@dataclass(frozen=True)
class FactWeights:
    """The BFF's ``SIMILARITY_WEIGHTS``, in snake case: what each shared fact is worth."""

    bundesland: float = 0.0
    gebaeudeklasse: float = 0.0
    gebaeudeklasse_adjacent: float = 0.0
    bauweise: float = 0.0
    nutzung: float = 0.0
    nutzung_max: float = 0.0
    vorhabensart: float = 0.0

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> FactWeights:
        values: dict[str, float] = {}
        for field in fields(cls):
            value = float(raw.get(field.name) or 0.0)
            if value < 0:
                raise ValueError(f"boost weight {field.name} must not be negative, got {value}")
            values[field.name] = value
        return cls(**values)

    @property
    def most(self) -> float:
        """The highest likeness two projects can reach: ``similarity()`` when every fact is shared."""
        return (
            self.bundesland
            + max(self.gebaeudeklasse, self.gebaeudeklasse_adjacent)
            + self.bauweise
            + self.nutzung_max
            + self.vorhabensart
        )


@dataclass(frozen=True)
class Boost:
    """The current project's facts, and the weights that turn shared facts into likeness."""

    facts: Mapping[str, Any]
    weights: FactWeights


def parse_boost(raw: Mapping[str, Any] | None) -> Boost | None:
    """A request's ``boost`` (``{"facts": {...}, "weights": {...}}``) as a :class:`Boost`; None when absent."""
    if not raw:
        return None
    facts = project_payload(raw.get("facts"), "active")[PROJECT_FACTS_FIELD]
    return Boost(facts=facts, weights=FactWeights.from_mapping(raw.get("weights") or {}))


def _any(key: str, values: list[Any]) -> models.FieldCondition:
    return models.FieldCondition(key=fact_field(key), match=models.MatchAny(any=values))


def _class_terms(classes: list[int], weights: FactWeights) -> list[tuple[float, Any]]:
    """The same class as any building scores the full weight; only a neighbouring one, the adjacent weight."""
    if not classes:
        return []
    exact = _any("gebaeudeklasse", classes)
    terms: list[tuple[float, Any]] = [(weights.gebaeudeklasse, exact)]
    neighbours = sorted({gk + step for gk in classes for step in (-1, 1)} - set(classes))
    if neighbours:
        adjacent = models.Filter(must=[_any("gebaeudeklasse", neighbours)], must_not=[exact])
        terms.append((weights.gebaeudeklasse_adjacent, adjacent))
    return terms


def _use_terms(uses: list[str], weights: FactWeights) -> list[tuple[float, Any]]:
    """``min(shared * nutzung, nutzung_max)`` as steps: "at least n uses shared" for n = 1, 2, ..."""
    if weights.nutzung <= 0 or not uses:
        return []
    uses = uses[:MAX_NUTZUNGEN]
    terms: list[tuple[float, Any]] = []
    for shared in range(1, len(uses) + 1):
        step = min(weights.nutzung, weights.nutzung_max - (shared - 1) * weights.nutzung)
        if step <= 0:
            break
        if shared == 1:
            terms.append((step, _any("nutzungen", uses)))
            continue
        groups = [
            models.Filter(must=[_any("nutzungen", [use]) for use in group]) for group in combinations(uses, shared)
        ]
        terms.append((step, models.Filter(should=groups)))
    return terms


def boost_terms(boost: Boost) -> list[tuple[float, Any]]:
    """``(weight, condition)`` for every term of ``similarity()`` the current project can score.

    Mirrors ``similarity()`` in ``similarity.ts`` term by term. Empty when the
    current project has no facts, or every weight is zero.
    """
    facts, weights = boost.facts, boost.weights
    terms: list[tuple[float, Any]] = []
    if facts.get("bundesland"):
        land = models.FieldCondition(key=fact_field("bundesland"), match=models.MatchValue(value=facts["bundesland"]))
        terms.append((weights.bundesland, land))
    terms.extend(_class_terms(list(facts.get("gebaeudeklasse") or []), weights))
    if facts.get("bauweise"):
        terms.append((weights.bauweise, _any("bauweise", list(facts["bauweise"]))))
    terms.extend(_use_terms(list(facts.get("nutzungen") or []), weights))
    if facts.get("vorhabensart"):
        terms.append((weights.vorhabensart, _any("vorhabensart", list(facts["vorhabensart"]))))
    return [(weight, condition) for weight, condition in terms if weight > 0]


def likeness_formula(boost: Boost | None) -> models.FormulaQuery | None:
    """``$score * (1 + LIKENESS * likeness / most)``, or None when the current project can share nothing."""
    terms = boost_terms(boost) if boost else []
    if not terms or not boost:
        return None
    scale = LIKENESS / boost.weights.most
    factor = models.SumExpression(
        sum=[1.0] + [models.MultExpression(mult=[scale * weight, condition]) for weight, condition in terms]
    )
    return models.FormulaQuery(formula=models.MultExpression(mult=["$score", factor]))


def boosted(channel: models.Prefetch, formula: models.FormulaQuery | None) -> models.Prefetch:
    """``channel`` rescored by ``formula`` over its own candidates; the channel itself when there is none."""
    if formula is None:
        return channel
    return models.Prefetch(prefetch=[channel], query=formula, limit=channel.limit)

"""Ranked reads: one Query API call per search, fused on the server.

A search runs these channels as prefetches over the same scope filter and
fuses them by reciprocal rank (k=60, the paper's constant; Qdrant's own
default is 2, so it is always set):

* the dense vector, the production embedder's;
* BM25 over the chunk text, analysed in German by Qdrant itself, with
  document frequencies counted over the searched scopes only, so one office's
  vocabulary never decides another's rarity;
* per exact term (``§ 3``, ``OIB-RL 2``), the dense ranking restricted to
  chunks containing that phrase.

This replaces three things the Chroma path did by hand: the ``$contains``
passes, the Postgres German mirror with its fetch-back by id, and the RRF in
Python. Fusion stays rank-only, so the two score scales never need to agree.
Every knob of that call is one value, :data:`RANKING`, measured by the parity
sweep; passages the fusion ties are ordered by cosine here, since Qdrant
returns ties in no fixed order.

A fused score is a rank statistic, not a relevance. Every hit therefore also
carries its true cosine to the query, which every consumer of ``Chunk.score``
expects (the grounding block prints it, thresholds compare against it); it
comes from one exact dense query over the fused hits' ids, no vectors shipped.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from typing import Literal

from qdrant_client import models

from .boost import Boost
from .boost import boosted
from .boost import likeness_formula
from .payload import paragraph_key
from .schema import DENSE
from .schema import LEXICAL
from .schema import PARAGRAPH_FIELD
from .schema import TEXT_FIELD
from .schema import physical_for_scope
from .scope import scope_condition
from .scope import scope_filter
from .store import QdrantStore
from .store import bm25

#: Reciprocal rank fusion constant (Cormack, Clarke & Buettcher, SIGIR 2009),
#: the value the Python fusion in ``llamaindex/hybrid.py`` has always used.
RRF_K = 60


@dataclass(frozen=True)
class Ranking:
    """How a search reads the dense index and fuses its channels: the knobs the parity sweep measures.

    One frozen value, :data:`RANKING`, is what production runs; the sweep
    (``oib_retrieval_eval.qdrant_parity.variants``) swaps it to measure the
    alternatives through the same code. Every default is the setting the
    measurement supports (``qdrant-gates-2026-10.md``, "Ranking sweep").
    """

    #: ``rrf`` (rank only) or ``dbsf`` (scores normalised per channel by mean and spread, then summed).
    fusion: Literal["rrf", "dbsf"] = "rrf"
    rrf_k: int = RRF_K
    #: Weight of the unrestricted dense channel in RRF. Qdrant scales the RANK
    #: by it (``1 / (k - 1 + rank / w)``), not the vote; 1.0 sends no weights.
    dense_weight: float = 1.0
    #: Re-score the quantized dense candidates against the original vectors.
    rescore: bool = False
    #: How many more quantized candidates than ``limit`` to fetch before rescoring (None: Qdrant's default).
    oversampling: float | None = None
    #: Maximal marginal relevance on the unrestricted dense channel: 0 is pure
    #: relevance, 1 pure diversity; None runs a plain nearest query.
    mmr_diversity: float | None = None
    #: Candidates MMR chooses from (None: the channel's own limit).
    mmr_candidates: int | None = None
    #: Order passages whose fused scores tie by their cosine to the query.
    #: Equal-weight RRF ties exactly whenever two passages hold the same ranks
    #: in different channels, and Qdrant returns ties in no fixed order: 86 of
    #: 105 parity queries came back in another top-60 order on four identical
    #: calls, 0 with this on. The one setting the sweep adopted
    #: (``qdrant-gates-2026-10.md``, "Ranking sweep").
    cosine_tie_break: bool = True

    def label(self) -> str:
        """A short stable name for the settings, as trace metadata carries it."""
        parts = [f"rrf{self.rrf_k}" if self.fusion == "rrf" else self.fusion]
        if self.dense_weight != 1.0:
            parts.append(f"dense_w{self.dense_weight:g}")
        if self.rescore:
            parts.append("rescore" + ("" if self.oversampling is None else f"_os{self.oversampling:g}"))
        elif self.oversampling is not None:
            parts.append(f"os{self.oversampling:g}")
        if self.mmr_diversity is not None:
            parts.append(f"mmr{self.mmr_diversity:g}" + (f"_c{self.mmr_candidates}" if self.mmr_candidates else ""))
        if self.cosine_tie_break:
            parts.append("cosine_ties")
        return "+".join(parts)


#: The ranking every search runs.
RANKING = Ranking()


@dataclass
class Hit:
    """One ranked chunk."""

    chunk_id: str
    text: str
    payload: dict[str, Any]
    #: The fused rank score: comparable within one result list only.
    fused: float
    #: Cosine similarity between the query and the chunk's dense vector.
    cosine: float


def phrase(term: str) -> models.FieldCondition:
    """Chunks whose text contains ``term`` as a phrase (tokenized, lowercased, umlauts folded)."""
    return models.FieldCondition(key=TEXT_FIELD, match=models.MatchPhrase(phrase=term))


#: An exact term that is one ``§`` reference and nothing else, as
#: ``legal_terms.extract_exact_terms`` emits it (``§ 3``, ``§ 12.1``, ``§ 3a``).
_PARAGRAPH_TERM = re.compile(r"^§\s*(\S+)$")


def exact_term(term: str) -> models.FieldCondition:
    """Chunks containing the exact term ``term``: what the Chroma path's ``$contains`` pass selected.

    A ``§`` reference matches the chunk's own list of the references it cites
    (``payload.paragraph_refs``): no tokenizer keeps the ``§``, so as a phrase
    "§ 3" is the bare token ``3`` and would match every "Abs. 3". Every other
    term ("OIB-Richtlinie 2", "5.1.1", "§ 3 Abs. 2") is a phrase over the
    word-tokenized text, digits included.
    """
    paragraph = _PARAGRAPH_TERM.match(term.strip())
    if paragraph:
        return models.FieldCondition(key=PARAGRAPH_FIELD, match=models.MatchValue(value=paragraph_key(paragraph[1])))
    return phrase(term)


def _alias(store: QdrantStore, scopes: Sequence[str]) -> str:
    physicals = {physical_for_scope(scope) for scope in scopes}
    if len(physicals) != 1:
        raise ValueError(f"One search reads one physical collection; scopes {list(scopes)!r} span {physicals}")
    return store.alias(scopes[0])


def _dense_params(ranking: Ranking) -> models.SearchParams | None:
    """The dense channels' search parameters: how the quantized index is read."""
    if not ranking.rescore and ranking.oversampling is None:
        return None
    return models.SearchParams(
        quantization=models.QuantizationSearchParams(rescore=ranking.rescore, oversampling=ranking.oversampling)
    )


def _dense_query(vector: Sequence[float], ranking: Ranking) -> Any:
    if ranking.mmr_diversity is None:
        return list(vector)
    mmr = models.Mmr(diversity=ranking.mmr_diversity, candidates_limit=ranking.mmr_candidates)
    return models.NearestQuery(nearest=list(vector), mmr=mmr)


def _prefetches(
    scopes: Sequence[str],
    query_filter: models.Filter,
    vector: Sequence[float],
    lexical_text: str,
    exact_terms: Sequence[str],
    candidates: int,
    ranking: Ranking,
) -> list[models.Prefetch]:
    """The channels, the unrestricted dense one first (:func:`_fusion` weighs it by position)."""
    idf = models.SearchParams(idf=models.IdfCorpusParams(corpus=models.Filter(must=[scope_condition(scopes)])))
    dense = _dense_params(ranking)
    prefetch = [
        models.Prefetch(
            query=_dense_query(vector, ranking), using=DENSE, limit=candidates, filter=query_filter, params=dense
        )
    ]
    if lexical_text.strip():
        prefetch.append(
            models.Prefetch(query=bm25(lexical_text), using=LEXICAL, limit=candidates, filter=query_filter, params=idf)
        )
    for term in exact_terms:
        restricted = models.Filter(must=[query_filter, exact_term(term)])
        prefetch.append(
            models.Prefetch(query=list(vector), using=DENSE, limit=candidates, filter=restricted, params=dense)
        )
    return prefetch


def _fusion(ranking: Ranking, channels: int) -> models.RrfQuery | models.FusionQuery:
    """The main query fusing ``channels`` prefetches, the first of them the unrestricted dense one."""
    if ranking.fusion == "dbsf":
        return models.FusionQuery(fusion=models.Fusion.DBSF)
    weights = None
    if ranking.dense_weight != 1.0 and channels > 1:
        weights = [ranking.dense_weight] + [1.0] * (channels - 1)
    return models.RrfQuery(rrf=models.Rrf(k=ranking.rrf_k, weights=weights))


def _cosines(
    store: QdrantStore, alias: str, scopes: Sequence[str], vector: Sequence[float], ids: Sequence[Any]
) -> dict[str, float]:
    """True cosine of each point to the query, by point id; exact, over these points only."""
    if not ids:
        return {}
    result = store.client.query_points(
        alias,
        query=list(vector),
        using=DENSE,
        query_filter=scope_filter(scopes, None, models.HasIdCondition(has_id=list(ids))),
        search_params=models.SearchParams(exact=True),
        limit=len(ids),
        with_payload=False,
    )
    return {str(point.id): float(point.score) for point in result.points}


def _hit(point: Any, cosines: dict[str, float]) -> Hit:
    payload = dict(point.payload or {})
    return Hit(
        chunk_id=str(payload.get("chunk_id") or point.id),
        text=str(payload.get(TEXT_FIELD) or ""),
        payload=payload,
        fused=float(point.score),
        cosine=cosines.get(str(point.id), 0.0),
    )


def hybrid_search(
    store: QdrantStore,
    scopes: Sequence[str],
    *,
    vector: Sequence[float],
    lexical_text: str,
    limit: int,
    filters: dict[str, Any] | None = None,
    exact_terms: Sequence[str] = (),
    candidates: int | None = None,
) -> list[Hit]:
    """The fused ranking over ``scopes``, best first."""
    if limit <= 0 or not scopes or not store.exists(scopes[0]):
        return []
    alias = _alias(store, scopes)
    query_filter = scope_filter(scopes, filters)
    prefetch = _prefetches(scopes, query_filter, vector, lexical_text, exact_terms, candidates or limit, RANKING)
    result = store.client.query_points(
        alias,
        prefetch=prefetch,
        query=_fusion(RANKING, len(prefetch)),
        limit=limit + _tie_slack(limit) if RANKING.cosine_tie_break else limit,
        with_payload=True,
    )
    cosines = _cosines(store, alias, scopes, vector, [point.id for point in result.points])
    hits = [_hit(point, cosines) for point in result.points]
    return _cosine_ordered_ties(hits)[:limit] if RANKING.cosine_tie_break else hits


def _tie_slack(limit: int) -> int:
    """Passages fetched past ``limit`` so that a tie straddling the cut is ordered whole before it is cut."""
    return max(4, limit // 4)


def _tie_order(hit: Hit) -> tuple[float, float, str]:
    """Fused score first, ties (to float noise) by cosine, then by chunk id."""
    return (-round(hit.fused, 9), -hit.cosine, hit.chunk_id)


def _cosine_ordered_ties(hits: list[Hit]) -> list[Hit]:
    """``hits`` in fused order, ties ordered by cosine, then by chunk id."""
    return sorted(hits, key=_tie_order)


def grouped_search(
    store: QdrantStore,
    scopes: Sequence[str],
    *,
    vector: Sequence[float],
    lexical_text: str,
    group_by: str,
    groups: int,
    group_size: int,
    filters: dict[str, Any] | None = None,
    boost: Boost | None = None,
    exact_terms: Sequence[str] = (),
    candidates: int = 200,
) -> list[tuple[str, list[Hit]]]:
    """The fused ranking over ``scopes``, grouped by a payload field, best group first.

    Cross-project search groups by ``scope``: one call ranks every reachable
    project's documents together, instead of one search per project merged
    on scores that are not comparable across indexes.

    ``filters`` narrow every channel inside the scope (tags, project facts):
    a pre-filter, so nothing is fetched to be dropped afterwards. ``boost``
    rescores each channel by the passage's project's likeness to the current
    one before the fusion (``boost.py``); the fusion stays the main query, so
    the ranking stays global on a sharded collection. ``exact_terms`` are the
    single-collection search's exact-term channels („§ 8“, „REI 90“).
    """
    if groups <= 0 or not scopes or not store.exists(scopes[0]):
        return []
    alias = _alias(store, scopes)
    query_filter = scope_filter(scopes, filters)
    likeness = likeness_formula(boost)
    prefetch = [
        boosted(channel, likeness)
        for channel in _prefetches(scopes, query_filter, vector, lexical_text, exact_terms, candidates, RANKING)
    ]
    # One flat fused ranking, grouped here in its order. Qdrant's group query
    # is no substitute: with a fusion as its query it fuses again for every
    # round of groups it collects, so each round's best passage scores rank 0
    # and the groups interleave by round instead of by relevance (measured on
    # 1.19.2; ``test_qdrant_boost.py`` pins it).
    result = store.client.query_points(
        alias,
        prefetch=prefetch,
        query=_fusion(RANKING, len(prefetch)),
        limit=max(candidates, groups * group_size),
        with_payload=True,
    )
    points = list(result.points)
    cosines: dict[str, float] | None = None
    if RANKING.cosine_tie_break:
        # Ties are ordered before grouping: which project's passage comes first decides the group order.
        cosines = _cosines(store, alias, scopes, vector, [point.id for point in points])
        points.sort(key=lambda point: _tie_order(_hit(point, cosines)))
    collected = _group_in_order(points, group_by, groups, group_size)
    if cosines is None:
        cosines = _cosines(store, alias, scopes, vector, [point.id for group in collected.values() for point in group])
    return [(key, [_hit(point, cosines) for point in group]) for key, group in collected.items()]


def _group_in_order(points: Sequence[Any], group_by: str, groups: int, group_size: int) -> dict[str, list[Any]]:
    """The first ``groups`` values of ``group_by`` in ranking order, each with its best ``group_size`` points."""
    collected: dict[str, list[Any]] = {}
    for point in points:
        key = (point.payload or {}).get(group_by)
        if key is None:
            continue
        key = str(key)
        if key not in collected:
            if len(collected) >= groups:
                continue
            collected[key] = []
        if len(collected[key]) < group_size:
            collected[key].append(point)
    return collected

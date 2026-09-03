"""Hybrid lexical+vector fusion helpers for the LlamaIndex retriever.

The semantic (vector) channel alone misses queries whose signal is a short exact string
(``§ 3``, ``OIB-Richtlinie 2``, an ALLCAPS code). The retriever therefore runs one extra
Chroma ``where_document {"$contains": term}`` pass per exact term extracted from the query
and fuses the channels with reciprocal rank fusion (Cormack, Clarke & Buettcher, SIGIR 2009).

RRF is rank-only: each channel contributes ``1 / (k + rank)`` per result, so score scales
between channels never need to be comparable — exactly what a hybrid of cosine similarity
and keyword containment needs.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

#: RRF constant k from the paper. 60 is the canonical value.
RRF_K = 60

try:
    from aiq_agent.common.legal_terms import extract_exact_terms  # type: ignore
except ImportError:  # knowledge_layer usable without the aiq_agent package
    extract_exact_terms = None  # type: ignore


def fuse_with_ranks(
    channels: list[list[Any]],
    *,
    k: int = RRF_K,
    top_n: int | None = None,
) -> list[tuple[Any, int, float]]:
    """Fuse ranked chunk lists by chunk identity, returning each survivor's fused rank and score.

    The fused *order* alone is a fragile carrier: a list is only ordered until the next
    stage sorts it. That is exactly how the cross-collection merge used to discard this
    fusion -- it re-sorted the fused list by ``chunk.score``, and since a lexical-only hit
    is by construction outside the vector top-k, its cosine is at most every vector hit's,
    so a score sort could only ever undo the boost. Handing the rank back lets a caller
    keep the fusion in a field instead of in a list order.

    Ties resolve in this order: higher fused score, then the better (lower) *minimum* rank
    across channels, then channel identity -- the earliest channel that contributed the
    chunk wins, because ``sorted`` is stable over insertion order. Channel identity
    therefore only ever decides when score AND minimum rank are equal.

    Args:
        channels: Ranked lists of chunks, best first. Entries without a ``chunk_id``
            (including ``None``) are skipped, so a caller may pad a channel with ``None``
            to express a rank gap.
        k: RRF constant (default 60).
        top_n: Maximum number of fused results to return (default: all).

    Returns:
        ``(chunk, fused_rank, fused_score)`` triples, best first. ``fused_rank`` is
        0-based over the returned (already trimmed) list.
    """
    scores: dict[str, float] = {}
    best: dict[str, Any] = {}
    # Minimum rank the chunk reached in ANY channel -- it is updated on every channel,
    # so it is not the rank of the first channel that saw the chunk.
    best_rank: dict[str, int] = {}

    for channel in channels:
        for rank, chunk in enumerate(channel):
            chunk_id = getattr(chunk, "chunk_id", None)
            if not chunk_id:
                continue
            if chunk_id not in best:
                best[chunk_id] = chunk
                best_rank[chunk_id] = rank
            elif rank < best_rank[chunk_id]:
                best_rank[chunk_id] = rank
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (k + rank + 1)

    # ``reverse=True`` over ``(score, -best_rank)`` resolves an equal-score tie toward the
    # SMALLER best_rank, i.e. the better rank. The negation is load-bearing, not a typo.
    ordered = sorted(scores, key=lambda cid: (scores[cid], -best_rank[cid]), reverse=True)
    if top_n is not None:
        ordered = ordered[:top_n]
    return [(best[cid], fused_rank, scores[cid]) for fused_rank, cid in enumerate(ordered)]


def reciprocal_rank_fusion(
    channels: list[list[Any]],
    *,
    k: int = RRF_K,
    top_n: int | None = None,
) -> list[Any]:
    """Fuse ranked chunk lists by chunk identity using reciprocal rank fusion.

    Thin wrapper over :func:`fuse_with_ranks` for callers that consume the fused order
    directly (the intra-collection lexical boost, which hands its list straight back to
    the retriever). ``channels[0]``'s ``Chunk`` objects are the ones kept whenever the
    same chunk appears in more than one channel, but ``channels[0]`` does NOT simply win
    ties: see :func:`fuse_with_ranks` for the real tie-break order.

    Args:
        channels: Ranked lists of chunks, best first.
        k: RRF constant (default 60).
        top_n: Maximum number of fused results to return (default: all).

    Returns:
        Chunks sorted by fused score, descending, trimmed to ``top_n``.
    """
    return [chunk for chunk, _fused_rank, _fused_score in fuse_with_ranks(channels, k=k, top_n=top_n)]


try:
    from aiq_agent.common.german_text import DEFAULT_DF_CEILING_MIN_TOTAL  # type: ignore
    from aiq_agent.common.german_text import DEFAULT_DF_CEILING_RATIO  # type: ignore
except ImportError:  # knowledge_layer usable without the aiq_agent package
    #: Mirrors ``aiq_agent.common.german_text`` for the standalone-package case only.
    #: Change the numbers THERE; these exist so the import failure degrades to the same
    #: behaviour rather than to no ceiling at all.
    DEFAULT_DF_CEILING_RATIO = 0.25  # type: ignore[assignment]
    DEFAULT_DF_CEILING_MIN_TOTAL = 25  # type: ignore[assignment]


def selective_terms(
    frequencies: dict[str, int],
    total: int,
    *,
    df_ceiling_ratio: float = DEFAULT_DF_CEILING_RATIO,
    min_total: int = DEFAULT_DF_CEILING_MIN_TOTAL,
) -> list[str]:
    """Drop the exact terms whose document frequency is too high to filter anything.

    The ``$contains`` channel FILTERS the dense ranking, so selectivity is the whole
    of its worth. A term present in nearly every chunk filters nothing and hands the
    vector channel straight back, and RRF then counts that one dense ranking twice.
    Every chunk the dense channel already found scores ``2/(k+rank+1)``; a chunk only
    the German sparse channel found still scores ``1/(k+rank+1)``. The lexical evidence
    loses to an ECHO of its rival, and it loses however strong it is, because rank is
    all RRF sees.

    A bare ``OIB`` is that echo. It is on 92.3% of pages of this corpus and in 39 of
    its 39 documents (``german_text``'s module docstring records the same finding at
    chunk level, 467 of 490).

    The German sparse channel has priced that since it was built and this channel never
    did. So this is ``german_text.select_terms`` rule 2, same constants and same reason,
    applied to literal substrings instead of lexemes. A term matching nothing costs a
    round trip and goes. A term above ``df_ceiling_ratio`` costs a round trip AND skews
    the fusion, so it goes too. Returning nothing is a correct and expected outcome; the
    caller then runs on the other channels.

    The ceiling is only applied once the collection is big enough for a ratio to mean
    anything (``min_total``), because in a six-chunk project collection every real term
    looks ubiquitous.

    Args:
        frequencies: ``term -> number of chunks in the collection containing it``.
        total: Chunks in the collection.
        df_ceiling_ratio: Share of the collection above which a term is noise.
        min_total: Below this many chunks the ratio is noise; only ``df == 0`` drops.

    Returns:
        The terms worth a ``$contains`` pass, in ``frequencies`` insertion order.
    """
    if not frequencies or total <= 0:
        return []
    apply_ceiling = total >= min_total
    ceiling = total * df_ceiling_ratio
    kept: list[str] = []
    for term, frequency in frequencies.items():
        if frequency <= 0:
            continue
        if apply_ceiling and frequency > ceiling:
            logger.info(
                "Exact term %r dropped: on %d of %d chunks (%.1f%%), above the %.0f%% ceiling",
                term,
                frequency,
                total,
                100.0 * frequency / total,
                100.0 * df_ceiling_ratio,
            )
            continue
        kept.append(term)
    return kept

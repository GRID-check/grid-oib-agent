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


def reciprocal_rank_fusion(
    channels: list[list[Any]],
    *,
    k: int = RRF_K,
    top_n: int | None = None,
) -> list[Any]:
    """Fuse ranked chunk lists by chunk identity using reciprocal rank fusion.

    ``channels[0]`` is the primary (vector) channel: it wins ties and its ``Chunk`` objects
    are kept whenever the same chunk appears in more than one channel.

    Args:
        channels: Ranked lists of chunks, best first.
        k: RRF constant (default 60).
        top_n: Maximum number of fused results to return (default: all).

    Returns:
        Chunks sorted by fused score, descending, trimmed to ``top_n``.
    """
    scores: dict[str, float] = {}
    best: dict[str, Any] = {}
    first_rank: dict[str, int] = {}

    for channel in channels:
        for rank, chunk in enumerate(channel):
            chunk_id = getattr(chunk, "chunk_id", None)
            if not chunk_id:
                continue
            if chunk_id not in best:
                best[chunk_id] = chunk
                first_rank[chunk_id] = rank
            elif rank < first_rank[chunk_id]:
                first_rank[chunk_id] = rank
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (k + rank + 1)

    ordered = sorted(scores, key=lambda cid: (scores[cid], -first_rank[cid]), reverse=True)
    if top_n is not None:
        ordered = ordered[:top_n]
    return [best[cid] for cid in ordered]

"""Tests for the hybrid lexical+vector retrieval fusion (RRF).

The vector channel alone misses short exact-string queries (``§ 3``, quoted
phrases, ALLCAPS abbreviations). ``knowledge_layer.llamaindex.hybrid`` fuses
one vector channel with one lexical channel per exact term using reciprocal
rank fusion (Cormack et al., SIGIR 2009) and must fail open.
"""

from __future__ import annotations

from types import SimpleNamespace

from sources.knowledge_layer.src.llamaindex.hybrid import RRF_K
from sources.knowledge_layer.src.llamaindex.hybrid import reciprocal_rank_fusion


def _chunk(chunk_id: str) -> SimpleNamespace:
    return SimpleNamespace(chunk_id=chunk_id)


def test_rrf_single_channel_preserves_order() -> None:
    channels = [[_chunk("a"), _chunk("b"), _chunk("c")]]
    fused = reciprocal_rank_fusion(channels)
    assert [c.chunk_id for c in fused] == ["a", "b", "c"]


def test_rrf_lexical_channel_boosts_exact_match() -> None:
    # Vector ranks "b" first; the lexical channel ranks "b" first too, so "b"
    # must win despite its worse vector rank.
    vector = [_chunk("b"), _chunk("a")]
    lexical = [_chunk("b")]
    fused = reciprocal_rank_fusion([vector, lexical])
    assert fused[0].chunk_id == "b"
    assert fused[1].chunk_id == "a"


def test_rrf_tie_prefers_vector_channel() -> None:
    # A hit present in both channels scores 1/(k+1) + 1/(k+1) regardless of
    # which list is first; the ordering among equal scores must prefer the
    # vector channel (channels[0]).
    vector = [_chunk("x"), _chunk("y")]
    lexical = [_chunk("y"), _chunk("x")]
    fused = reciprocal_rank_fusion([vector, lexical])
    assert fused[0].chunk_id == "x"


def test_rrf_top_n_trims() -> None:
    channels = [[_chunk("a"), _chunk("b"), _chunk("c")]]
    fused = reciprocal_rank_fusion(channels, top_n=2)
    assert [c.chunk_id for c in fused] == ["a", "b"]


def test_rrf_dedupes_by_chunk_id() -> None:
    # Same chunk in multiple channels must appear exactly once; the shared
    # chunk ranks above the vector-only one because it collects both ranks.
    vector = [_chunk("a"), _chunk("b")]
    lexical = [_chunk("b")]
    fused = reciprocal_rank_fusion([vector, lexical])
    ids = [c.chunk_id for c in fused]
    assert ids == ["b", "a"]


def test_rrf_empty_channels_returns_empty() -> None:
    assert reciprocal_rank_fusion([[], []]) == []


def test_rrf_k_default_is_60() -> None:
    assert RRF_K == 60


def test_rrf_chunk_without_id_is_skipped() -> None:
    plain = object()
    vector = [plain]
    fused = reciprocal_rank_fusion([vector])
    assert fused == []

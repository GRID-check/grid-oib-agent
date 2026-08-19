"""Tests for the hybrid lexical+vector retrieval fusion (RRF).

The vector channel alone misses short exact-string queries (``§ 3``, quoted
phrases, ALLCAPS abbreviations). ``knowledge_layer.llamaindex.hybrid`` fuses
one vector channel with one lexical channel per exact term using reciprocal
rank fusion (Cormack et al., SIGIR 2009) and must fail open.
"""

from __future__ import annotations

from types import SimpleNamespace

from sources.knowledge_layer.src.llamaindex.hybrid import RRF_K
from sources.knowledge_layer.src.llamaindex.hybrid import fuse_with_ranks
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


def test_rrf_equal_score_tie_is_broken_toward_the_better_rank_not_the_first_channel() -> None:
    # The previous version of this test used a mirrored pair (x,y)/(y,x): both chunks
    # ended up with the SAME score and the SAME best rank, so it passed on `sorted`
    # being stable and asserted nothing about the tie-break itself.
    #
    # k=0 makes the arithmetic exact and readable: a hit at rank r contributes 1/(r+1).
    # "deep-twice" is found by both channels at rank 3 (1/4 + 1/4) and "shallow-once" by
    # the second channel alone at rank 1 (1/2) — exactly equal fused scores, unequal best
    # ranks. The better (lower) rank must win, even though "deep-twice" also sits in
    # channels[0], which the docstring used to claim decides ties.
    first = [_chunk("f0"), _chunk("f1"), _chunk("f2"), _chunk("deep-twice")]
    second = [_chunk("s0"), _chunk("shallow-once"), _chunk("s2"), _chunk("deep-twice")]
    fused = fuse_with_ranks([first, second], k=0)
    scored = {chunk.chunk_id: score for chunk, _rank, score in fused}
    assert scored["deep-twice"] == scored["shallow-once"], "the tie this test rests on must be exact"

    ids = [chunk.chunk_id for chunk, _rank, _score in fused]
    assert ids.index("shallow-once") < ids.index("deep-twice")


def test_rrf_channel_identity_decides_only_when_score_and_best_rank_are_equal() -> None:
    # The one case where being in channels[0] (the vector channel) does decide: the
    # mirrored pair, equal on both keys the sort actually compares.
    vector = [_chunk("x"), _chunk("y")]
    lexical = [_chunk("y"), _chunk("x")]
    fused = reciprocal_rank_fusion([vector, lexical])
    assert fused[0].chunk_id == "x"


def test_fuse_with_ranks_reports_dense_zero_based_ranks_and_descending_scores() -> None:
    # The rank is the whole point of the function: a caller that only receives an order
    # loses the fusion as soon as anything downstream re-sorts the list.
    vector = [_chunk("a"), _chunk("b"), _chunk("c")]
    lexical = [_chunk("c")]
    fused = fuse_with_ranks([vector, lexical])
    assert [(chunk.chunk_id, rank) for chunk, rank, _score in fused] == [("c", 0), ("a", 1), ("b", 2)]
    scores = [score for _chunk_obj, _rank, score in fused]
    assert scores == sorted(scores, reverse=True)


def test_fuse_with_ranks_renumbers_ranks_after_top_n_trim() -> None:
    fused = fuse_with_ranks([[_chunk("a"), _chunk("b"), _chunk("c")]], top_n=2)
    assert [(chunk.chunk_id, rank) for chunk, rank, _score in fused] == [("a", 0), ("b", 1)]


def test_fuse_with_ranks_treats_a_padded_slot_as_a_rank_gap() -> None:
    # Callers express "this collection's rank 1 was dropped upstream" by padding with
    # None, so the surviving rank-2 hit is fused as rank 2 rather than sliding up to 1.
    with_gap = fuse_with_ranks([[_chunk("a"), None, _chunk("c")]])
    without_gap = fuse_with_ranks([[_chunk("a"), _chunk("c")]])
    gap_score = {chunk.chunk_id: score for chunk, _rank, score in with_gap}["c"]
    dense_score = {chunk.chunk_id: score for chunk, _rank, score in without_gap}["c"]
    assert gap_score < dense_score


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

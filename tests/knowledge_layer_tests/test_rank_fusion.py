"""Tests for rank fusion actually reaching the answer.

Reciprocal rank fusion used to be computed and then thrown away: the retriever
returned a fused ORDER while every chunk kept its raw similarity, and the
cross-collection merge re-sorted by that similarity. The fusion could therefore
only ever lose — a lexical-only hit is by construction outside the vector top-k,
so its cosine is at most every vector hit's, and a score sort demotes it right
back out of the slate it had just earned.

The same theorem sinks layered retrieval: session and project collections sit in
a systematically worse distance band than the professionally chunked base corpus,
so a user's own uploaded PDF can never win on raw score. Rank is scale-free,
which is exactly why fusing on rank fixes both.

All tests are offline: no ChromaDB, no embeddings, no network.
"""

from types import SimpleNamespace

import pytest
from knowledge_layer.register import _apply_diversity_cap
from knowledge_layer.register import _merge_results

from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult
from sources.knowledge_layer.src.llamaindex.hybrid import fuse_with_ranks


def _chunk(chunk_id: str, score: float, rank: int, file_name: str = "doc.pdf", collection: str | None = None) -> Chunk:
    """One retrieved hit: ``rank`` is its 0-based rank inside its own collection."""
    return Chunk(
        chunk_id=chunk_id,
        content=f"content {chunk_id}",
        score=score,
        file_name=file_name,
        display_citation=file_name,
        content_type=ContentType.TEXT,
        retrieval_rank=rank,
        metadata={"collection": collection} if collection else {},
    )


def _result(chunks, backend: str = "llamaindex") -> RetrievalResult:
    return RetrievalResult(chunks=chunks, query="q", backend=backend, success=True)


def _ids(merged) -> list[str]:
    return [chunk.chunk_id for chunk in merged.chunks]


# =============================================================================
# The fusion itself
# =============================================================================


def test_a_chunk_found_by_both_channels_outranks_a_single_channel_one() -> None:
    # The defining property of RRF: agreement between channels beats depth in one.
    vector = [SimpleNamespace(chunk_id="vector-only"), SimpleNamespace(chunk_id="both")]
    lexical = [SimpleNamespace(chunk_id="both")]
    fused = fuse_with_ranks([vector, lexical])
    assert [(chunk.chunk_id, rank) for chunk, rank, _score in fused] == [("both", 0), ("vector-only", 1)]


# =============================================================================
# What the merge must no longer undo
# =============================================================================


def test_a_lexical_only_hit_with_a_poor_cosine_survives_the_merge_into_the_top_k() -> None:
    # This is the measured regression, verbatim: the retriever's fused order was
    # [lex-hit 0.21, vec-1 0.62, vec-2 0.58] and the merge returned it re-sorted as
    # [vec-1, vec-2, lex-hit]. A lexical-only hit is never in the vector top-k, so its
    # cosine is at most every vector hit's — under a score sort the boost is unreachable
    # by construction, not by accident.
    collection = _result(
        [
            _chunk("lex-hit", 0.21, rank=0),
            _chunk("vec-1", 0.62, rank=1),
            _chunk("vec-2", 0.58, rank=2),
        ]
    )
    merged = _merge_results([collection], query="q", top_k=2, backend_name="llamaindex", max_per_document=0)
    assert _ids(merged) == ["lex-hit", "vec-1"]


def test_a_session_hit_at_rank_zero_beats_a_corpus_hit_at_rank_five() -> None:
    # Layered retrieval's whole point. Every session chunk here scores worse than every
    # corpus chunk — that is the distance band, not a relevance judgement — so under a
    # score sort the user's own upload could never enter a slate the corpus can fill.
    corpus = _result([_chunk(f"corpus-{rank}", 0.70 - rank * 0.01, rank, "oib-rl2.pdf") for rank in range(6)])
    session = _result([_chunk("session-0", 0.45, rank=0, file_name="mein_projekt.pdf", collection="s_abc")])
    merged = _merge_results([corpus, session], query="q", top_k=3, backend_name="llamaindex", max_per_document=0)
    assert _ids(merged) == ["corpus-0", "session-0", "corpus-1"]
    assert merged.chunks[1].score < merged.chunks[2].score, "it wins on rank while holding the worse similarity"


def test_the_base_corpus_wins_an_exact_tie_because_it_is_the_first_channel() -> None:
    # Same rank, same fused score: collection order (target_collections) decides, so a
    # session upload never silently displaces the corpus on an exact tie.
    corpus = _result([_chunk("corpus-0", 0.70, rank=0, collection="oib_knowledge")])
    session = _result([_chunk("session-0", 0.45, rank=0, file_name="mine.pdf", collection="s_abc")])
    merged = _merge_results([corpus, session], query="q", top_k=2, backend_name="llamaindex", max_per_document=0)
    assert _ids(merged) == ["corpus-0", "session-0"]


def test_a_rank_gap_left_by_a_dropped_hit_does_not_promote_the_survivors() -> None:
    # Ranks are stamped per collection, so a hit filtered out downstream leaves a hole.
    # Reading the rank (not the list position) keeps rank 5 competing as rank 5.
    corpus = _result([_chunk("corpus-0", 0.70, rank=0), _chunk("corpus-5", 0.60, rank=5)])
    session = _result([_chunk("session-1", 0.40, rank=1, file_name="mine.pdf", collection="s_abc")])
    merged = _merge_results([corpus, session], query="q", top_k=3, backend_name="llamaindex", max_per_document=0)
    assert _ids(merged) == ["corpus-0", "session-1", "corpus-5"]


def test_the_merge_never_raises_on_the_results_gather_hands_it() -> None:
    # Called on asyncio.gather(..., return_exceptions=True) output: exceptions, layers
    # whose collection does not exist yet, and objects with no `.success` at all.
    ok = _result([_chunk("corpus-0", 0.70, rank=0)])
    failed = RetrievalResult(chunks=[], query="q", backend="llamaindex", success=False, error_message="not found")
    merged = _merge_results(
        [ok, failed, RuntimeError("boom"), object()],
        query="q",
        top_k=5,
        backend_name="llamaindex",
    )
    assert merged.success is True
    assert _ids(merged) == ["corpus-0"]


# =============================================================================
# Diversity cap
# =============================================================================


def test_the_diversity_cap_fill_pass_is_reachable() -> None:
    # The old cap scanned the whole merged list before truncating, so `selected` alone
    # already exceeded top_k and `(selected + leftovers)[:top_k]` never reached the
    # leftovers: the promised soft quota was a hard one. Two documents, cap 2, five
    # slots — the cap can fill only 4, so the fill pass must supply the fifth.
    ordered = [
        _chunk("a-0", 0.90, 0, "a.pdf"),
        _chunk("a-1", 0.88, 1, "a.pdf"),
        _chunk("a-2", 0.86, 2, "a.pdf"),
        _chunk("b-0", 0.50, 3, "b.pdf"),
        _chunk("b-1", 0.48, 4, "b.pdf"),
        _chunk("b-2", 0.46, 5, "b.pdf"),
    ]
    capped = _apply_diversity_cap(ordered, top_k=5, max_per_document=2)
    assert len(capped) == 5, "the cap must be exceeded rather than return fewer than top_k"
    assert [chunk.chunk_id for chunk in capped] == ["a-0", "a-1", "a-2", "b-0", "b-1"]


def test_the_diversity_cap_output_is_monotone_in_the_rank_it_selected_by() -> None:
    # The old version returned the cap survivors first and the deferred chunks after
    # them, so the output was not ordered by its own ranking key — and a downstream
    # `[:top_k]` trim then saw a slate whose head had been rebuilt out of deep hits.
    ordered = [_chunk(f"a-{rank}", 0.90 - rank / 100, rank, "a.pdf") for rank in range(4)]
    ordered += [_chunk(f"b-{rank}", 0.40 - rank / 100, 4 + rank, "b.pdf") for rank in range(4)]
    capped = _apply_diversity_cap(ordered, top_k=6, max_per_document=2)
    positions = [ordered.index(chunk) for chunk in capped]
    assert positions == sorted(positions), "the returned slate must be a subsequence of the fused order"


def test_the_diversity_cap_never_returns_a_worse_slate_than_plain_top_k_when_documents_are_scarce() -> None:
    # The measured loss: on a single-topic query the cap swapped on-topic hits for
    # off-topic ones and then, because the deferred hits were appended at the very end,
    # the downstream trim could not get them back. With the fill pass reachable and the
    # output in rank order, the on-topic hits keep the head of the list.
    on_topic = [_chunk(f"a-{rank}", 0.82, rank, "a.pdf") for rank in range(8)]
    off_topic = [
        _chunk(f"{name}-{i}", 0.39, 8 + offset, f"{name}.pdf")
        for offset, (name, i) in enumerate([("b", 0), ("b", 1), ("c", 0), ("c", 1)])
    ]
    capped = _apply_diversity_cap(on_topic + off_topic, top_k=12, max_per_document=2)
    # What a later `[:8]` trim sees must still be the on-topic document.
    assert [chunk.chunk_id for chunk in capped[:8]] == [chunk.chunk_id for chunk in on_topic]


def test_a_single_collection_with_the_cap_disabled_is_plain_top_k() -> None:
    chunks = [_chunk(f"a-{rank}", 0.90 - rank / 100, rank, "a.pdf") for rank in range(5)]
    merged = _merge_results([_result(chunks)], query="q", top_k=3, backend_name="llamaindex", max_per_document=0)
    assert _ids(merged) == ["a-0", "a-1", "a-2"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))

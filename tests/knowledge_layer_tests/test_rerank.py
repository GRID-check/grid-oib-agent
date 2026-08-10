"""Tests for the LLM-judge reranker (``knowledge_layer.rerank``).

The reranker scores retrieved chunks in one batched LLM call and must fail
open: any parse error, timeout, or transport failure leaves the input order
unchanged.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from sources.knowledge_layer.src.rerank import rerank_chunks


def _chunk(chunk_id: str, content: str = "text") -> SimpleNamespace:
    return SimpleNamespace(chunk_id=chunk_id, content=content, page_number=1, file_name="doc.pdf")


class _FakeLLM:
    def __init__(self, response: str) -> None:
        self._response = response
        self.calls: list[list] = []

    async def ainvoke(self, messages: list) -> SimpleNamespace:
        self.calls.append(messages)
        return SimpleNamespace(content=self._response)


@pytest.mark.asyncio
async def test_rerank_reorders_by_scores() -> None:
    llm = _FakeLLM(json.dumps({"scores": [{"i": 1, "score": 3}, {"i": 2, "score": 9}]}))
    chunks = [_chunk("a"), _chunk("b")]
    reranked = await rerank_chunks(llm, "query", chunks)
    assert [c.chunk_id for c in reranked] == ["b", "a"]


@pytest.mark.asyncio
async def test_rerank_missing_indices_trail_in_relative_order() -> None:
    llm = _FakeLLM(json.dumps({"scores": [{"i": 2, "score": 8}]}))
    chunks = [_chunk("a"), _chunk("b"), _chunk("c")]
    reranked = await rerank_chunks(llm, "query", chunks)
    assert [c.chunk_id for c in reranked] == ["b", "a", "c"]


@pytest.mark.asyncio
async def test_rerank_malformed_json_returns_original() -> None:
    llm = _FakeLLM("not json at all")
    chunks = [_chunk("a"), _chunk("b")]
    reranked = await rerank_chunks(llm, "query", chunks)
    assert [c.chunk_id for c in reranked] == ["a", "b"]


@pytest.mark.asyncio
async def test_rerank_fenced_json_parses() -> None:
    payload = "```json\n" + json.dumps({"scores": [{"i": 1, "score": 1}, {"i": 2, "score": 10}]}) + "\n```"
    llm = _FakeLLM(payload)
    chunks = [_chunk("a"), _chunk("b")]
    reranked = await rerank_chunks(llm, "query", chunks)
    assert [c.chunk_id for c in reranked] == ["b", "a"]


@pytest.mark.asyncio
async def test_rerank_timeout_returns_original() -> None:
    class _SlowLLM:
        async def ainvoke(self, messages: list) -> SimpleNamespace:
            await asyncio.sleep(5)
            return SimpleNamespace(content=json.dumps({"scores": []}))

    chunks = [_chunk("a"), _chunk("b")]
    reranked = await rerank_chunks(_SlowLLM(), "query", chunks, timeout_seconds=0.05)
    assert [c.chunk_id for c in reranked] == ["a", "b"]


@pytest.mark.asyncio
async def test_rerank_raising_llm_returns_original() -> None:
    class _RaisingLLM:
        async def ainvoke(self, messages: list) -> SimpleNamespace:
            raise RuntimeError("boom")

    chunks = [_chunk("a"), _chunk("b")]
    reranked = await rerank_chunks(_RaisingLLM(), "query", chunks)
    assert [c.chunk_id for c in reranked] == ["a", "b"]


@pytest.mark.asyncio
async def test_rerank_empty_reply_returns_original() -> None:
    llm = _FakeLLM("")
    chunks = [_chunk("a")]
    reranked = await rerank_chunks(llm, "query", chunks)
    assert [c.chunk_id for c in reranked] == ["a"]


@pytest.mark.asyncio
async def test_rerank_empty_inputs_unchanged() -> None:
    llm = _FakeLLM("{}")
    assert await rerank_chunks(llm, "query", []) == []
    chunks = [_chunk("a")]
    assert await rerank_chunks(llm, "", chunks) == chunks
    assert llm.calls == []


@pytest.mark.asyncio
async def test_rerank_top_n_trims() -> None:
    llm = _FakeLLM(json.dumps({"scores": [{"i": 1, "score": 1}, {"i": 2, "score": 2}]}))
    chunks = [_chunk("a"), _chunk("b")]
    reranked = await rerank_chunks(llm, "query", chunks, top_n=1)
    assert [c.chunk_id for c in reranked] == ["b"]


@pytest.mark.asyncio
async def test_rerank_uses_single_batched_call() -> None:
    llm = _FakeLLM(json.dumps({"scores": [{"i": 1, "score": 5}]}))
    await rerank_chunks(llm, "query", [_chunk("a"), _chunk("b")])
    assert len(llm.calls) == 1
    assert len(llm.calls[0]) == 2  # system + user message


# ===========================================================================
# Judge-reply hardening.
#
# The suite above proves the reranker never crashes. These prove it never
# silently produces a WRONG order -- the more dangerous failure, because a
# renumbered or partial reply used to be absorbed as a successful rerank with
# nothing in the logs to distinguish it from a good one.
# ===========================================================================


@pytest.mark.asyncio
async def test_zero_based_reply_is_rejected_rather_than_shifting_every_chunk() -> None:
    """A judge answering 0-based must not silently shift the whole ranking.

    Read 1-based, ``{"i": 0}`` is out of range and ``{"i": 1}``/``{"i": 2}`` name
    the wrong chunks: the model's best candidate lands second and its worst lands
    first. Every index being out of range is the signature of a renumbered reply,
    so the ranking is discarded instead.
    """
    llm = _FakeLLM(json.dumps({"scores": [{"i": 0, "score": 10}, {"i": -1, "score": 0}]}))
    chunks = [_chunk("a"), _chunk("b"), _chunk("c")]
    reranked = await rerank_chunks(llm, "query", chunks)
    assert [c.chunk_id for c in reranked] == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_indices_past_the_candidate_count_are_dropped() -> None:
    llm = _FakeLLM(json.dumps({"scores": [{"i": 2, "score": 9}, {"i": 99, "score": 10}]}))
    chunks = [_chunk("a"), _chunk("b"), _chunk("c")]
    reranked = await rerank_chunks(llm, "query", chunks)
    # 99 names no candidate and is discarded; 2 is honoured.
    assert reranked[0].chunk_id == "b"


@pytest.mark.asyncio
async def test_a_repeated_index_keeps_the_first_score_and_never_demotes() -> None:
    """``dict()`` collapse used to be last-wins, so a repeat silently demoted a chunk."""
    llm = _FakeLLM(json.dumps({"scores": [{"i": 1, "score": 9}, {"i": 1, "score": 0}, {"i": 2, "score": 5}]}))
    chunks = [_chunk("a"), _chunk("b")]
    reranked = await rerank_chunks(llm, "query", chunks)
    assert [c.chunk_id for c in reranked] == ["a", "b"]


@pytest.mark.asyncio
async def test_unscored_chunks_outrank_an_explicitly_rejected_one() -> None:
    """A partial reply must not bury unjudged candidates under a rejected one.

    Models routinely score only a prefix of a long list. Treating the omissions as
    a low score sent every unjudged chunk below one the judge scored 0.
    """
    llm = _FakeLLM(json.dumps({"scores": [{"i": 1, "score": 10}, {"i": 2, "score": 0}]}))
    chunks = [_chunk("scored_best"), _chunk("scored_worst"), _chunk("unscored_x"), _chunk("unscored_y")]
    reranked = await rerank_chunks(llm, "query", chunks)
    order = [c.chunk_id for c in reranked]
    assert order[0] == "scored_best"
    assert order[-1] == "scored_worst"
    assert order[1:3] == ["unscored_x", "unscored_y"]  # untouched relative order


@pytest.mark.asyncio
async def test_non_positive_top_n_does_not_empty_the_result() -> None:
    """``rerank_candidates: 0`` is config-reachable (``ge=0``) and used to return nothing.

    ``chunks[:0]`` emptied the knowledge base on both the success and the
    fail-open path, so retrieval failed open to zero chunks.
    """
    llm = _FakeLLM(json.dumps({"scores": [{"i": 1, "score": 5}, {"i": 2, "score": 9}]}))
    chunks = [_chunk("a"), _chunk("b")]
    assert len(await rerank_chunks(llm, "query", chunks, top_n=0)) == 2
    assert len(await rerank_chunks(_FakeLLM("garbage"), "query", chunks, top_n=0)) == 2


@pytest.mark.asyncio
async def test_non_finite_and_boolean_scores_are_rejected() -> None:
    """``json.loads`` accepts NaN, and a single NaN makes the sort order undefined.

    ``bool`` is an ``int`` subclass, so ``{"i": true}`` would otherwise score
    candidate 1 and ``{"score": true}`` would read as 1.0.
    """
    chunks = [_chunk("a"), _chunk("b"), _chunk("c")]
    assert [c.chunk_id for c in await rerank_chunks(_FakeLLM('{"scores":[{"i":3,"score":NaN}]}'), "q", chunks)] == [
        "a",
        "b",
        "c",
    ]
    assert [c.chunk_id for c in await rerank_chunks(_FakeLLM('{"scores":[{"i":true,"score":9}]}'), "q", chunks)] == [
        "a",
        "b",
        "c",
    ]


def test_a_chunk_without_a_page_does_not_render_p_none() -> None:
    """``page_number`` is ``int | None``, so a getattr default never fires for a null page."""
    from sources.knowledge_layer.src.rerank import _build_user_prompt

    prompt = _build_user_prompt("q", [SimpleNamespace(content="text", page_number=None, file_name="doc.pdf")])
    assert "p.None" not in prompt
    assert "doc.pdf:" in prompt


def test_excerpt_budget_shrinks_so_a_large_pool_still_fits_the_prompt() -> None:
    """Per-chunk budget yields to a whole-prompt bound rather than multiplying by it."""
    from sources.knowledge_layer.src.rerank import _MIN_EXCERPT_CHARS
    from sources.knowledge_layer.src.rerank import _TOTAL_EXCERPT_BUDGET_CHARS
    from sources.knowledge_layer.src.rerank import _excerpt_budget

    assert _excerpt_budget(20, 1200) == 1200  # small pool keeps the full budget
    assert _excerpt_budget(200, 1200) < 1200  # large pool is throttled
    assert _excerpt_budget(100_000, 1200) == _MIN_EXCERPT_CHARS  # never below the floor
    assert _excerpt_budget(200, 1200) * 200 <= _TOTAL_EXCERPT_BUDGET_CHARS


@pytest.mark.asyncio
async def test_cross_encoder_wins_when_it_answers_and_the_judge_is_not_called() -> None:
    class _Encoder:
        async def rerank(self, query: str, chunks: list, *, top_n: int | None = None) -> list:
            return list(reversed(chunks))

    llm = _FakeLLM(json.dumps({"scores": [{"i": 1, "score": 9}]}))
    chunks = [_chunk("a"), _chunk("b"), _chunk("c")]
    reranked = await rerank_chunks(llm, "query", chunks, cross_encoder=_Encoder())
    assert [c.chunk_id for c in reranked] == ["c", "b", "a"]
    assert llm.calls == []


@pytest.mark.asyncio
async def test_cross_encoder_failure_falls_back_to_the_judge() -> None:
    class _BrokenEncoder:
        async def rerank(self, query: str, chunks: list, *, top_n: int | None = None) -> list:
            raise RuntimeError("provider down")

    llm = _FakeLLM(json.dumps({"scores": [{"i": 1, "score": 1}, {"i": 2, "score": 9}]}))
    chunks = [_chunk("a"), _chunk("b")]
    reranked = await rerank_chunks(llm, "query", chunks, cross_encoder=_BrokenEncoder())
    assert [c.chunk_id for c in reranked] == ["b", "a"]
    assert len(llm.calls) == 1

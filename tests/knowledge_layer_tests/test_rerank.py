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

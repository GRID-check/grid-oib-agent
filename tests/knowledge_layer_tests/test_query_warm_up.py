"""The turn-start warm-up: the question is embedded once, beside the decision, and the search reuses it."""

from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace

from aiq_agent.knowledge import factory
from sources.knowledge_layer.src.llamaindex.adapter import LlamaIndexRetriever


class _SlowEmbedder:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def get_query_embedding(self, query: str) -> list[float]:
        self.calls.append(query)
        time.sleep(0.05)
        return [float(len(query))]


def _retriever() -> tuple[LlamaIndexRetriever, _SlowEmbedder]:
    retriever = LlamaIndexRetriever(config={"persist_dir": "/tmp/unused"})
    embedder = _SlowEmbedder()
    retriever._embed_model = embedder
    retriever._initialized = True
    return retriever, embedder


def test_a_search_that_starts_while_the_warm_up_is_in_flight_waits_for_it():
    retriever, embedder = _retriever()
    results: list[list[float]] = []
    threads = [
        threading.Thread(target=lambda: results.append(retriever._embed_query_cached("Treppe Breite")))
        for _ in range(3)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert embedder.calls == ["Treppe Breite"]
    assert results == [[13.0]] * 3


def test_a_failed_embedding_is_taken_over_by_the_waiter():
    retriever, embedder = _retriever()
    attempts: list[str] = []

    def flaky(query: str) -> list[float]:
        attempts.append(query)
        if len(attempts) == 1:
            time.sleep(0.05)
            raise RuntimeError("embedding API down")
        return [1.0]

    embedder.get_query_embedding = flaky  # type: ignore[method-assign]
    outcome: list[object] = []

    def call() -> None:
        try:
            outcome.append(retriever._embed_query_cached("q"))
        except RuntimeError as exc:
            outcome.append(exc)

    threads = [threading.Thread(target=call) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(attempts) == 2 and [1.0] in outcome


def test_the_warm_up_leaves_the_embedding_where_the_search_reads_it():
    retriever, embedder = _retriever()

    asyncio.run(retriever.warm_query("Geländerhöhe Absturzhöhe"))
    retriever._embed_query_cached("Geländerhöhe Absturzhöhe")

    assert embedder.calls == ["Geländerhöhe Absturzhöhe"]


def test_a_failing_warm_up_never_raises():
    retriever = LlamaIndexRetriever(config={"persist_dir": "/tmp/unused"})
    retriever._initialized = True
    retriever._embed_model = SimpleNamespace(get_query_embedding=lambda q: 1 / 0)

    asyncio.run(retriever.warm_query("irgendwas"))


def test_the_search_retriever_is_warmed_with_the_query_the_tool_will_send(monkeypatch):
    warmed: list[str] = []

    class _Recorder:
        async def warm_query(self, query: str) -> None:
            warmed.append(query)

    monkeypatch.setattr(factory, "_SEARCH_RETRIEVER", _Recorder())
    monkeypatch.setattr("aiq_agent.common.query_expansion.augmented_query", lambda q: f"DE {q}")

    asyncio.run(factory.warm_search_query("stair width"))

    assert warmed == ["DE stair width"]


def test_no_search_retriever_means_no_warm_up(monkeypatch):
    monkeypatch.setattr(factory, "_SEARCH_RETRIEVER", None)

    asyncio.run(factory.warm_search_query("Treppe"))

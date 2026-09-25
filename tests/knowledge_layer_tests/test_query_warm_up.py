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


def _inflight_wait_hook(retriever: LlamaIndexRetriever, waiting: threading.Semaphore):
    """Signal ``waiting`` each time a caller starts waiting on an in-flight embedding; returns the undo."""
    from sources.knowledge_layer.src.llamaindex import adapter

    original = adapter._InflightEmbedding.result

    def result(self):
        waiting.release()
        return original(self)

    adapter._InflightEmbedding.result = result  # type: ignore[method-assign]

    def undo() -> None:
        adapter._InflightEmbedding.result = original  # type: ignore[method-assign]

    return undo


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


def test_a_failed_embedding_fails_every_waiter_at_once():
    """A down embedding API fails every caller after ONE bounded call.

    The old contract handed the key to one waiter at a time, so four callers
    of a failing API paid four timeouts in a row (0.2/0.4/0.6/0.8 s here; about
    10 s each against the real API).
    """
    retriever, embedder = _retriever()
    attempts: list[str] = []
    waiting = threading.Semaphore(0)

    def failing(query: str) -> list[float]:
        attempts.append(query)
        # Fail only once the other three wait on this call, not on a clock.
        for _ in range(3):
            assert waiting.acquire(timeout=5)
        raise RuntimeError("embedding API down")

    embedder.get_query_embedding = failing  # type: ignore[method-assign]
    undo = _inflight_wait_hook(retriever, waiting)
    outcome: list[object] = []

    def call() -> None:
        try:
            outcome.append(retriever._embed_query_cached("q"))
        except RuntimeError as exc:
            outcome.append(exc)

    threads = [threading.Thread(target=call) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
    undo()

    assert attempts == ["q"]  # one failure shared, not four in a row
    assert len(outcome) == 4 and all(isinstance(o, RuntimeError) for o in outcome)
    assert retriever._embed_inflight == {}


def test_after_a_shared_failure_the_next_call_tries_again():
    retriever, embedder = _retriever()
    attempts: list[str] = []

    def flaky(query: str) -> list[float]:
        attempts.append(query)
        if len(attempts) == 1:
            raise RuntimeError("embedding API down")
        return [1.0]

    embedder.get_query_embedding = flaky  # type: ignore[method-assign]
    try:
        retriever._embed_query_cached("q")
    except RuntimeError:
        pass

    assert retriever._embed_query_cached("q") == [1.0]
    assert len(attempts) == 2


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
    monkeypatch.setattr("aiq_agent.common.query_expansion.augmented_query", lambda q, **_: f"DE {q}")

    asyncio.run(factory.warm_search_query("stair width"))

    assert warmed == ["DE stair width"]


def test_the_warm_up_does_not_count_a_glossary_miss_the_search_will_count(monkeypatch, caplog):
    """The miss line is a per-query coverage metric; the warm-up expands the
    same query the search expands, so logging it there counted it twice."""

    class _Recorder:
        async def warm_query(self, query: str) -> None:
            return None

    monkeypatch.setattr(factory, "_SEARCH_RETRIEVER", _Recorder())
    with caplog.at_level("INFO", logger="aiq_agent.common.query_expansion"):
        asyncio.run(factory.warm_search_query("What is the quarterly revenue forecast?"))

    assert not [r for r in caplog.records if "no glossary concept" in r.getMessage()]


def test_no_search_retriever_means_no_warm_up(monkeypatch):
    monkeypatch.setattr(factory, "_SEARCH_RETRIEVER", None)

    asyncio.run(factory.warm_search_query("Treppe"))


def test_without_a_cache_nobody_waits_on_anybody(monkeypatch):
    retriever, embedder = _retriever()
    monkeypatch.setattr(LlamaIndexRetriever, "EMBED_CACHE_MAX", 0)
    # All three must be inside the embedder at once: serialised calls break the barrier.
    together = threading.Barrier(3, timeout=5)
    broken: list[BaseException] = []

    def meet(query: str) -> list[float]:
        embedder.calls.append(query)
        try:
            together.wait()
        except threading.BrokenBarrierError as exc:
            broken.append(exc)
        return [1.0]

    embedder.get_query_embedding = meet  # type: ignore[method-assign]
    threads = [threading.Thread(target=lambda: retriever._embed_query_cached("q")) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(embedder.calls) == 3
    assert broken == []  # three in parallel, not three in a row


def test_the_prefetch_query_carries_no_trailing_blank():
    from aiq_agent.agents.piloti.decisions import prefetch_query

    # A 300-character cut can land on a space; the search strips its query.
    question = "x" * 299 + " und mehr"
    assert prefetch_query(question) == prefetch_query(question).strip()


def test_initialising_the_retriever_leaves_the_global_embed_model_alone(monkeypatch):
    """The retriever's query model (3 s timeout) used to be installed as the
    process-wide ``Settings.embed_model``; every index it builds is handed the
    model explicitly, so the global is not its to set."""
    from llama_index.core import Settings
    from llama_index.embeddings import nvidia

    from sources.knowledge_layer.src.llamaindex import adapter

    monkeypatch.setattr(adapter, "ensure_retrieval_dependencies", lambda: None)
    monkeypatch.setattr(adapter, "_make_chroma_client", lambda persist_dir: object())
    from llama_index.core import MockEmbedding

    monkeypatch.setattr(nvidia, "NVIDIAEmbedding", lambda **kwargs: MockEmbedding(embed_dim=2))
    monkeypatch.setattr(Settings, "_embed_model", None)
    retriever = LlamaIndexRetriever(config={"persist_dir": "/tmp/unused"})

    retriever._initialize_components()

    assert retriever._embed_model is not None
    assert Settings._embed_model is None


def test_the_llamaindex_backend_registers_the_retriever():
    # A class inserted between the decorator and the retriever once took the
    # registration: every llamaindex deployment built the wrong class.
    import sources.knowledge_layer.src.llamaindex.adapter  # noqa: F401  (registers)

    assert factory._RETRIEVER_REGISTRY["llamaindex"].__name__ == "LlamaIndexRetriever"

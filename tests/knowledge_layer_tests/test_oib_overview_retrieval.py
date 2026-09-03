"""Backlog 11 wiring: knowledge_search applies the deterministic OIB normalization.

The unit pin for ``canonicalize_oib_query`` lives in
``tests/aiq_agent/common/test_oib_overview_query.py``. That alone does not hold
while tired: someone can remove the two call sites in
``knowledge_layer.register`` and every unit test still passes while turn-1
overview queries go vector-only again. These tests pin the wiring: the broad
"was weißt du über die oib 2" must reach the retriever (and the requery
fan-out) in its canonical "OIB-Richtlinie 2 Brandschutz" form.

All offline: fake retriever, fake judge, no Chroma, no network.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.retrieval_settings import reset_retrieval_settings_cache


class _FakeResult:
    def __init__(self, chunks=None):
        self.chunks = list(chunks or [])
        self.success = True
        self.backend = "fake"

    def model_copy(self, update=None):
        clone = _FakeResult(list(self.chunks))
        for key, value in (update or {}).items():
            setattr(clone, key, value)
        return clone


class _FakeRetriever:
    backend_name = "fake"

    def __init__(self):
        self.retrieve_calls: list[dict] = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.retrieve_calls.append({"query": query, "collection": collection_name})
        return _FakeResult([])


class _SufficientJudge:
    async def ainvoke(self, messages):
        return SimpleNamespace(content='{"sufficient": true, "queries": []}')


def _install(monkeypatch, retriever, judge):
    monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: retriever)
    monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
    monkeypatch.setattr(
        "knowledge_layer.register._format_results",
        lambda merged, query: f"QUERY={query} RETRIEVED={len(merged.chunks)}",
    )
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    reset_retrieval_settings_cache()

    async def _resolve(_builder, name):
        return judge

    monkeypatch.setattr("aiq_agent.common.get_langchain_llm", _resolve)


def _config(**overrides) -> KnowledgeRetrievalConfig:
    return KnowledgeRetrievalConfig(
        collection_name="oib_knowledge",
        include_base_collection=True,
        include_session_collection=False,
        generate_summary=False,
        top_k=8,
        max_chunks_per_document=0,
        **overrides,
    )


async def _search(config, query, **scope):
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(query=query, **scope))


async def test_broad_oib_overview_query_reaches_retriever_canonicalized(monkeypatch):
    """Turn-1 "oib 2" must arrive as "OIB-Richtlinie 2 Brandschutz"."""
    retriever = _FakeRetriever()
    _install(monkeypatch, retriever, _SufficientJudge())

    await _search(_config(), query="was weißt du über die oib 2")

    assert retriever.retrieve_calls, "the retriever was never called"
    sent = retriever.retrieve_calls[0]["query"]
    assert "OIB-Richtlinie 2" in sent
    assert "Brandschutz" in sent


async def test_precise_and_non_oib_queries_pass_through_unchanged(monkeypatch):
    retriever = _FakeRetriever()
    _install(monkeypatch, retriever, _SufficientJudge())

    await _search(_config(), query="OIB-Richtlinie 2 Brandschutz")
    assert retriever.retrieve_calls[0]["query"] == "OIB-Richtlinie 2 Brandschutz"

    retriever.retrieve_calls.clear()
    await _search(_config(), query="Wie breit muss ein Fluchtweg sein?")
    assert retriever.retrieve_calls[0]["query"] == "Wie breit muss ein Fluchtweg sein?"


async def test_requery_alternative_in_bare_form_is_canonicalized(monkeypatch):
    """The judge's paraphrase gets the same normalization as the first query."""

    class _BareJudge:
        async def ainvoke(self, messages):
            return SimpleNamespace(content='{"sufficient": false, "queries": ["oib 3"]}')

    retriever = _FakeRetriever()
    _install(monkeypatch, retriever, _BareJudge())

    await _search(_config(requery_llm="judge", requery_max_queries=1), query="Fluchtweg GK4")

    sent_queries = [call["query"] for call in retriever.retrieve_calls]
    assert sent_queries[0] == "Fluchtweg GK4"
    assert len(sent_queries) == 2
    assert "OIB-Richtlinie 3" in sent_queries[1]

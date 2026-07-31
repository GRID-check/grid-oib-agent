"""Platform → Retrieval counts (knowledge.top_k / knowledge.max_chunks_per_document)
are consulted per call by the knowledge_search tool and win over the YAML values."""

from unittest.mock import MagicMock

import pytest
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.retrieval_settings import reset_retrieval_settings_cache


class _FakeResult:
    def __init__(self, chunks):
        self.chunks = chunks


class _FakeRetriever:
    backend_name = "fake"

    def __init__(self):
        self.retrieve_calls = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.retrieve_calls.append({"collection": collection_name, "top_k": top_k})
        return _FakeResult([])


@pytest.fixture
def harness(monkeypatch):
    retriever = _FakeRetriever()
    monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: retriever)
    monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
    monkeypatch.setattr("knowledge_layer.register._format_results", lambda merged, query: "no results")
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    # The resolver's TTL cache is process-global; start every case cold so an
    # entry from another module cannot decide this test's counts.
    reset_retrieval_settings_cache()
    return retriever


def _config(**overrides) -> KnowledgeRetrievalConfig:
    return KnowledgeRetrievalConfig(
        collection_name="oib_knowledge",
        include_base_collection=True,
        include_session_collection=False,
        generate_summary=False,
        top_k=8,
        max_chunks_per_document=2,
        **overrides,
    )


class TestKnowledgeSearchPlatformCounts:
    async def test_platform_top_k_reaches_retriever(self, harness, monkeypatch):
        monkeypatch.setattr(
            "aiq_agent.common.retrieval_settings.get_retrieval_setting",
            lambda key, fallback: {"knowledge.top_k": 11, "knowledge.max_chunks_per_document": 4}.get(key, fallback),
        )

        async with knowledge_retrieval(_config(), MagicMock()) as info:
            await info.single_fn(info.input_schema(query="OIB Richtlinie 3 Brandschutz"))

        assert harness.retrieve_calls == [{"collection": "oib_knowledge", "top_k": 11}]

    async def test_defaults_used_without_platform_value(self, harness):
        async with knowledge_retrieval(_config(), MagicMock()) as info:
            await info.single_fn(info.input_schema(query="OIB Richtlinie 3 Brandschutz"))

        assert harness.retrieve_calls == [{"collection": "oib_knowledge", "top_k": 8}]

    async def test_platform_counts_apply_to_every_in_scope_collection(self, harness, monkeypatch):
        monkeypatch.setattr(
            "aiq_agent.common.retrieval_settings.get_retrieval_setting",
            lambda key, fallback: 6 if key == "knowledge.top_k" else fallback,
        )

        async with knowledge_retrieval(_config(project_collections=["proj_abc"]), MagicMock()) as info:
            await info.single_fn(info.input_schema(query="Holzbau Decke"))

        assert harness.retrieve_calls == [
            {"collection": "oib_knowledge", "top_k": 6},
            {"collection": "proj_abc", "top_k": 6},
        ]

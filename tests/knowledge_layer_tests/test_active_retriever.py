"""Tests for the cached active-retriever singleton in the knowledge factory.

``get_active_retriever()`` mirrors the active-ingestor singleton: it lazily
builds ONE retriever from the active ingestor's backend + store/embedding
config, caches it, and reuses it for every subsequent call (no per-request
re-init). This isolates that wiring from the heavy LlamaIndex adapter by
registering a tiny fake retriever backend.
"""

from typing import Any

import pytest

from aiq_agent.knowledge import factory
from aiq_agent.knowledge.base import BaseRetriever
from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import clear_active_retriever
from aiq_agent.knowledge.factory import get_active_retriever
from aiq_agent.knowledge.factory import register_retriever
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_agent.knowledge.factory import set_active_retriever
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import RetrievalResult


@register_retriever("fake_search_backend")
class _FakeRetriever(BaseRetriever):
    backend_name = "fake_search_backend"

    async def retrieve(self, query, collection_name, top_k=10, filters=None) -> RetrievalResult:
        return RetrievalResult(chunks=[], query=query, backend=self.backend_name)

    def normalize(self, raw_result: Any) -> Chunk:  # pragma: no cover - unused
        raise NotImplementedError


class _FakeIngestor:
    """Stand-in exposing only what the factory reads to mirror config."""

    backend_name = "fake_search_backend"
    persist_dir = "/data/fake-chroma"
    embed_base_url = "https://embed.example/v1"
    embed_model_name = "fake-embed-model"


@pytest.fixture(autouse=True)
def _reset_active():
    clear_active_ingestor()
    clear_active_retriever()
    yield
    clear_active_ingestor()
    clear_active_retriever()


def test_builds_from_active_ingestor_config_and_caches():
    set_active_ingestor(_FakeIngestor())

    retriever = get_active_retriever()

    assert retriever.backend_name == "fake_search_backend"
    # Config mirrored from the ingestor so both read the same store + model.
    assert retriever.config["persist_dir"] == "/data/fake-chroma"
    assert retriever.config["embed_base_url"] == "https://embed.example/v1"
    assert retriever.config["embed_model"] == "fake-embed-model"

    # Cached: a second call returns the very same instance (no re-build).
    assert get_active_retriever() is retriever


def test_set_active_retriever_overrides_lazy_build():
    injected = _FakeRetriever(config={"persist_dir": "/injected"})
    set_active_retriever(injected)

    assert get_active_retriever() is injected


def test_falls_back_to_default_backend_without_ingestor(monkeypatch):
    # No active ingestor: build from the factory's default backend instead.
    monkeypatch.setattr(factory, "DEFAULT_RETRIEVER_BACKEND", "fake_search_backend")
    retriever = get_active_retriever()
    assert isinstance(retriever, BaseRetriever)
    assert retriever.backend_name == "fake_search_backend"

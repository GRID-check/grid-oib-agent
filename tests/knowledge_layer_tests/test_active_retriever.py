"""Tests for the cached retriever instances in the knowledge factory.

Two layers, one lifetime question.

``get_active_retriever()`` mirrors the active-ingestor singleton: it lazily
builds ONE retriever from the active ingestor's backend + store/embedding
config, caches it, and reuses it for every subsequent call (no per-request
re-init).

``get_retriever()`` underneath it caches per ``(backend, config)`` identity.
That is the load-bearing part: it is called once per ``WorkflowBuilder`` build,
i.e. once per agent run, and while it constructed a fresh adapter each time,
every cache the adapter owns (index, query embeddings, static results) was born
empty per run and thrown away at the end — the 1-hour result TTL could never be
reached. Caching the adapter is only safe because result entries are keyed on a
cross-replica collection write-version; the identity part of the key is what
stops a second configuration silently reusing the first one's store.

Isolated from the heavy LlamaIndex adapter by registering a tiny fake backend.
"""

from typing import Any

import pytest

from aiq_agent.knowledge import factory
from aiq_agent.knowledge.base import BaseRetriever
from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import clear_active_retriever
from aiq_agent.knowledge.factory import get_active_retriever
from aiq_agent.knowledge.factory import get_retriever
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


def test_the_same_backend_and_config_gets_the_same_instance():
    config = {"persist_dir": "/data/chroma", "embed_model": "nv-embed"}

    first = get_retriever("fake_search_backend", config)
    second = get_retriever("fake_search_backend", dict(config))

    # Each agent run builds its own WorkflowBuilder and lands here. A new adapter
    # per run means empty caches per run, so nothing ever survives long enough to
    # be hit — an equal config must return the identical object, not an equal one.
    assert second is first


def test_a_different_config_gets_a_different_instance():
    first = get_retriever("fake_search_backend", {"persist_dir": "/data/chroma-a"})
    second = get_retriever("fake_search_backend", {"persist_dir": "/data/chroma-b"})

    # Reusing the first instance here would silently query the wrong store: the
    # persist dir and the embedding model are baked into the adapter.
    assert second is not first
    assert second.config["persist_dir"] == "/data/chroma-b"


def test_an_omitted_config_is_its_own_identity():
    default = get_retriever("fake_search_backend")

    assert get_retriever("fake_search_backend", {}) is default
    assert get_retriever("fake_search_backend", {"persist_dir": "/elsewhere"}) is not default


def test_a_config_value_that_is_not_json_serializable_still_resolves():
    class _Opaque:
        pass

    opaque = _Opaque()

    # A factory that raised on an exotic config value would take retrieval down
    # for the sake of a cache key.
    first = get_retriever("fake_search_backend", {"client": opaque})
    assert get_retriever("fake_search_backend", {"client": opaque}) is first


def test_clear_active_retriever_drops_the_cached_instances():
    set_active_ingestor(_FakeIngestor())
    active = get_active_retriever()
    per_identity = get_retriever("fake_search_backend", {"persist_dir": "/data/chroma"})

    clear_active_retriever()

    # A process-lifetime cache with no reset hook makes every test after the
    # first one run against the previous test's warm adapter.
    assert get_active_retriever() is not active
    assert get_retriever("fake_search_backend", {"persist_dir": "/data/chroma"}) is not per_identity


def test_an_unknown_backend_is_still_rejected():
    with pytest.raises(ValueError):
        get_retriever("no_such_backend")

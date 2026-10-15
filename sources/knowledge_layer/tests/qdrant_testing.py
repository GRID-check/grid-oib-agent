"""One real Qdrant for every test that needs a store (ADR-0113).

What a test of the store or the adapter checks is the server's behaviour as
the knowledge layer drives it (filters, strict mode, BM25, deletes by filter),
so these run against the server at ``AIQ_QDRANT_TEST_URL``: the CI backend job
runs a Qdrant 1.19 service container and sets it for every step. Locally,
without the variable, a test that asks for the store skips; on CI it fails
instead, so the suites cannot quietly stop covering it.

:func:`qdrant_store` gives each test its own physical collections (a unique
alias suffix, ``schema.ALIASES`` monkeypatched) and points the process-wide
store at them, so the adapter, the routes and the test all read and write the
same isolated pair. Both are deleted afterwards. Imported by path
(``sources.knowledge_layer.tests.qdrant_testing``), as ``sources/AGENTS.md``
asks, and registered as a fixture by each suite's ``conftest.py``.
"""

from __future__ import annotations

import os
import random
import uuid
from collections.abc import Iterator
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

import pytest
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import store as store_module
from knowledge_layer.qdrant import writes
from knowledge_layer.qdrant.payload import ChunkRecord

#: Dense size of every test vector: small, so a test collection costs nothing.
DIM = 8
#: The embedder identity test collections are created with.
IDENTITY = {"aiq:embed_fingerprint": "test-fp", "aiq:embed_model": "test-model"}


def server_url() -> str:
    """The test server's URL; skips locally without one, fails on CI."""
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if url:
        return url
    if os.environ.get("CI"):
        pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
    pytest.skip("AIQ_QDRANT_TEST_URL not set; start a Qdrant 1.19 server to run these")


def vector(seed: str) -> list[float]:
    """A deterministic test vector for ``seed``: the same text always embeds the same."""
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


class FakeEmbedder:
    """Stands in for the embedding API on the ingest and query paths: :func:`vector` per text."""

    def __init__(self) -> None:
        self.batches: list[list[str]] = []

    def get_text_embedding_batch(self, texts: Sequence[str], **_kwargs: Any) -> list[list[float]]:
        self.batches.append(list(texts))
        return [vector(text) for text in texts]

    def get_query_embedding(self, query: str) -> list[float]:
        return vector(query)


def record(text: str, file_name: str, *, chunk_id: str | None = None, **metadata: Any) -> ChunkRecord:
    """One chunk as ingestion writes it: a fresh node id, the text's vector, ``file_name`` and page 1 unless given."""
    return ChunkRecord(
        chunk_id=chunk_id or str(uuid.uuid4()),
        text=text,
        embedding=vector(text),
        metadata={"file_name": file_name, "page_label": "1", **metadata},
    )


def write(scope: str, records: Sequence[ChunkRecord], config: Mapping[str, Any] | None = None) -> int:
    """Write ``records`` into ``scope`` with the enrichment an ingest job gives them (no metadata-store facts)."""
    return store_module.get_store(IDENTITY).upsert(scope, records, writes.enrichment(scope, config))


def chunk_texts(scope: str, filters: dict[str, Any] | None = None) -> dict[str, str]:
    """``chunk_id -> text`` of every point of ``scope`` (matching ``filters``)."""
    return {
        str((point.payload or {}).get(schema.CHUNK_ID_FIELD)): str((point.payload or {}).get(schema.TEXT_FIELD))
        for point in store_module.get_store().scroll(scope, filters)
    }


@pytest.fixture
def qdrant_store(monkeypatch) -> Iterator[store_module.QdrantStore]:
    """The process-wide store, on this test's own physical collections; both deleted afterwards."""
    url = server_url()
    suffix = uuid.uuid4().hex[:10]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"test_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"test_office_{suffix}")
    monkeypatch.setenv("AIQ_QDRANT_URL", url)
    monkeypatch.delenv("AIQ_QDRANT_API_KEY", raising=False)
    store_module.reset_store()
    store = store_module.get_store(IDENTITY)
    try:
        yield store
    finally:
        client = store_module.make_client()
        for physical in schema.Physical:
            name = schema.ALIASES[physical] + schema.FIRST_VERSION
            if client.collection_exists(name):
                client.delete_collection(name)
        store_module.reset_store()


def capture_indexed_documents(monkeypatch, into: list[list[Any]] | None = None) -> list[list[Any]]:
    """Record the documents each ingest hands to chunking and embedding, one list per file; the write still runs.

    What ``VectorStoreIndex.from_documents``'s call list told a test before
    ingestion embedded and wrote its chunks itself. ``into`` is the list to
    record in (cleared first), for a module-level helper that reads it.
    """
    from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

    calls: list[list[Any]] = into if into is not None else []
    calls.clear()
    real = LlamaIndexIngestor._embedded_records

    def recording(self: Any, documents: list[Any], **kwargs: Any) -> list[ChunkRecord]:
        calls.append(list(documents))
        return real(self, documents, **kwargs)

    monkeypatch.setattr(LlamaIndexIngestor, "_embedded_records", recording)
    return calls

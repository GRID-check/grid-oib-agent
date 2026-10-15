"""The store, filled from one set of vectors, and the retriever that reads it.

Everything here builds the production objects rather than lookalikes:

* **Qdrant**: the production collection shape (``qdrant/schema.py``: dense + server
  BM25 with ``BM25_OPTIONS``, TurboQuant 4-bit, strict mode, payload indexes),
  under uniquely named aliases so a shared server is never touched outside them,
  filled through ingestion's own write (``qdrant/writes.py`` ``write_chunks``,
  one call per file, as ``_ingest_job`` makes it).
* **The retriever**: ``LlamaIndexRetriever`` with its query-embedding cache
  pre-filled, so ``_retrieve_sync`` runs the store path with no embedding call in
  it.

Chroma left the stack in one change (ADR-0113), so there is no second store to
fill: what the Chroma path measured is the fixed reference in ``baseline.py``.
"""

from __future__ import annotations

import contextlib
import logging
import os
import time
import uuid
from collections.abc import Iterator
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

#: The logical collection the parity corpus is indexed under. Not ``oib_knowledge``:
#: that name switches on the static result cache, which would time the cache.
SCOPE = "oib_parity"


@dataclass(frozen=True)
class IndexedChunk:
    """One chunk as the store holds it."""

    chunk_id: str
    text: str
    file_name: str
    page: int
    metadata: dict[str, Any]


def identity(model: str, base_url: str) -> dict[str, str]:
    """The embedder fingerprint the collection records, as production computes it."""
    from knowledge_layer.llamaindex.adapter import embed_fingerprint_metadata

    return embed_fingerprint_metadata(model, base_url)


# ---------------------------------------------------------------- Qdrant


@contextlib.contextmanager
def isolated_qdrant(url: str, api_key: str | None = None) -> Iterator[str]:
    """The knowledge layer's Qdrant store on uniquely named aliases; collections dropped on exit.

    The aliases are the one name the package addresses each physical collection by,
    so renaming them for the run puts every read and write of the production code
    on throwaway collections. Yields the run's suffix.
    """
    from knowledge_layer.qdrant import schema
    from knowledge_layer.qdrant.store import make_client
    from knowledge_layer.qdrant.store import reset_store

    suffix = uuid.uuid4().hex[:8]
    saved = dict(schema.ALIASES)
    saved_env = {key: os.environ.get(key) for key in ("AIQ_QDRANT_URL", "AIQ_QDRANT_API_KEY")}
    os.environ["AIQ_QDRANT_URL"] = url
    if api_key:
        os.environ["AIQ_QDRANT_API_KEY"] = api_key
    for physical in schema.Physical:
        schema.ALIASES[physical] = f"parity_{suffix}_{physical.value}"
    reset_store()
    try:
        yield suffix
    finally:
        client = make_client()
        for physical in schema.Physical:
            with contextlib.suppress(Exception):
                name = schema.ALIASES[physical] + schema.FIRST_VERSION
                if client.collection_exists(name):
                    client.delete_collection(name)
        schema.ALIASES.clear()
        schema.ALIASES.update(saved)
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        reset_store()


def fill_qdrant(chunks: Sequence[IndexedChunk], vectors: np.ndarray, fingerprint: dict[str, str]) -> int:
    """Write the corpus the way ingestion writes a file's chunks; returns the points Qdrant holds.

    One ``write_chunks`` per file, with the chunk ids as the point ids. A
    benchmark corpus has no metadata store behind it, so the lookup of
    person-set facts finds none, which is what it would find. The id sets are
    compared afterwards, not only the counts: equal counts can hide a swap.
    """
    from knowledge_layer.qdrant import writes
    from knowledge_layer.qdrant.payload import ChunkRecord
    from knowledge_layer.qdrant.store import get_store

    by_file: dict[str, list[ChunkRecord]] = {}
    for chunk, vector in zip(chunks, vectors, strict=True):
        record = ChunkRecord(chunk.chunk_id, chunk.text, [float(value) for value in vector], dict(chunk.metadata))
        by_file.setdefault(chunk.file_name, []).append(record)
    original = writes.facts_by_file
    writes.facts_by_file = lambda scope, file_names=None: {}
    try:
        for file_name, records in by_file.items():
            writes.write_chunks(SCOPE, file_name, records, identity=fingerprint)
    finally:
        writes.facts_by_file = original
    stored = set(get_store(fingerprint).chunk_ids(SCOPE))
    expected = {chunk.chunk_id for chunk in chunks}
    if stored != expected:
        raise RuntimeError(
            f"Qdrant holds {len(stored)} points for {len(expected)} chunks: "
            f"{len(expected - stored)} missing, {len(stored - expected)} extra"
        )
    return len(stored)


def wait_until_indexed(timeout_s: float = 600.0) -> dict[str, Any]:
    """Block until the corpus collection's optimizer is idle; its index state for the report.

    Until HNSW and the quantized copy are built a search is a brute-force scan, so a
    latency or recall measured earlier would not be of the configuration under test.
    """
    from knowledge_layer.qdrant import schema
    from knowledge_layer.qdrant.store import get_store

    client = get_store().client
    alias = schema.ALIASES[schema.Physical.CORPUS]
    deadline = time.monotonic() + timeout_s
    info = client.get_collection(alias)
    while time.monotonic() < deadline:
        info = client.get_collection(alias)
        status = str(getattr(info.status, "value", info.status))
        optimizer = str(getattr(info, "optimizer_status", "ok"))
        if status == "green" and "ok" in optimizer.lower():
            break
        time.sleep(1.0)
    return {
        "status": str(getattr(info.status, "value", info.status)),
        "points": int(info.points_count or 0),
        "indexed_vectors": int(info.indexed_vectors_count or 0),
        "segments": int(info.segments_count or 0),
    }


# ---------------------------------------------------------------- the retriever


def retriever(model: str, base_url: str, queries: Sequence[str], query_vectors: np.ndarray) -> Any:
    """``LlamaIndexRetriever`` over the process-wide Qdrant store, its query-embedding cache holding every query.

    ``_retrieve_sync`` then runs exactly as in production, minus the embedding round
    trip: the store calls are what is timed and scored.
    """
    from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
    from llama_index.core.embeddings import MockEmbedding

    instance = LlamaIndexRetriever({"embed_model": model, "embed_base_url": base_url, "hybrid_search": True})
    instance._embed_model = MockEmbedding(embed_dim=int(query_vectors.shape[1]))
    instance._initialized = True
    for query, vector in zip(queries, query_vectors, strict=True):
        key = (model, query)
        instance._embed_cache[key] = [float(value) for value in vector]
        instance._embed_cache_order.append(key)
    return instance

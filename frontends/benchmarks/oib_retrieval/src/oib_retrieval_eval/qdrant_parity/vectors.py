"""The vectors the store is filled with, and the query vectors it is asked with.

ONE SET OF VECTORS
------------------
A comparison across runs that embeds twice compares two embedding runs as much as
two rankings. So every text is embedded once, cached on disk keyed by model and
text, and the same float32 array is written into Qdrant on every run (and the
ranking sweep's variants all read it).

PRODUCTION'S EMBEDDER, THROUGH PRODUCTION'S SEAM
------------------------------------------------
``make_embed_model`` from the knowledge layer is the only embedding client the
process builds, and its HTTP clients pin every OpenRouter request to zero-data-
retention endpoints (``aiq_agent.common.openrouter.PLATFORM_FIXED``). The key comes
from the same chain the retriever resolves (``_resolve_embed_api_key``). Nothing
here opens its own HTTP client to the provider.

The chunk text is embedded as production embeds it: the node's text under
LlamaIndex's ``MetadataMode.EMBED`` header, minus the keys ingestion excludes
(``EMBED_EXCLUDED_METADATA_KEYS`` plus the Punkt chunker's own list). A query is
embedded with ``get_query_embedding``, as ``_embed_query_cached`` does.

``hashed`` is the offline stand-in the tests use: deterministic, no key, no meaning.
A number from it is wiring, never retrieval quality, and the report says which
embedder produced every figure.
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Callable
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

PRODUCTION_MODEL = os.environ.get("AIQ_EMBED_MODEL", "openai/text-embedding-3-large")
PRODUCTION_BASE_URL = os.environ.get("AIQ_EMBED_BASE_URL", "https://openrouter.ai/api/v1")

#: Dimension of the offline stand-in. Small, so a test indexes a corpus in milliseconds.
HASHED_DIMENSION = 64

#: Texts per embedding request; production's ingestion batch size is in the same range.
EMBED_BATCH = 64


def embed_text(text: str, metadata: dict[str, Any]) -> str:
    """The string production embeds for one chunk: the EMBED header, then the body."""
    from knowledge_layer.llamaindex.adapter import EMBED_EXCLUDED_METADATA_KEYS
    from knowledge_layer.llamaindex.punkt_chunking import PUNKT_EMBED_EXCLUDED_METADATA_KEYS
    from llama_index.core.schema import MetadataMode
    from llama_index.core.schema import TextNode

    excluded = list(dict.fromkeys([*EMBED_EXCLUDED_METADATA_KEYS, *PUNKT_EMBED_EXCLUDED_METADATA_KEYS]))
    node = TextNode(
        text=text,
        metadata=dict(metadata),
        excluded_embed_metadata_keys=excluded,
        excluded_llm_metadata_keys=excluded,
    )
    return node.get_content(metadata_mode=MetadataMode.EMBED)


def truncate_renormalise(matrix: np.ndarray, dimension: int) -> np.ndarray:
    """The first ``dimension`` components of each row, L2-normalised again.

    OpenAI documents this as equivalent to asking the v3 API for ``dimensions``, so a
    1024-d vector is derived from the stored 3072-d one with no API call (gate G6).
    """
    if dimension <= 0 or dimension > matrix.shape[1]:
        raise ValueError(f"cannot truncate {matrix.shape[1]}-d vectors to {dimension}")
    cut = np.asarray(matrix[:, :dimension], dtype=np.float32)
    norms = np.linalg.norm(cut, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return cut / norms


def hashed_vector(text: str, dimension: int = HASHED_DIMENSION) -> np.ndarray:
    """A deterministic unit vector from the text's German lexemes. No semantics at all."""
    from aiq_agent.common.german_text import analyze

    vector = np.zeros(dimension, dtype=np.float32)
    for lexeme in analyze(text) or [text]:
        digest = hashlib.sha256(lexeme.encode()).digest()
        index = int.from_bytes(digest[:4], "big") % dimension
        vector[index] += 1.0 if digest[4] % 2 else -1.0
    norm = float(np.linalg.norm(vector))
    if norm == 0.0:
        vector[0] = 1.0
        return vector
    return vector / norm


class VectorCache:
    """Embeddings on disk, keyed by ``(model, kind, text)``; a re-run embeds only what is new.

    ``kind`` separates documents from queries, because a model may encode the two
    differently and the cache must never hand a document vector to a query.
    """

    def __init__(self, directory: Path, model: str):
        self.directory = directory
        self.model = model
        self.directory.mkdir(parents=True, exist_ok=True)
        self.embedded_now = 0

    def _path(self, kind: str, text: str) -> Path:
        digest = hashlib.sha256(f"{self.model}\x00{kind}\x00{text}".encode()).hexdigest()
        return self.directory / digest[:2] / f"{digest}.npy"

    def get_many(
        self, kind: str, texts: Sequence[str], compute: Callable[[list[str]], list[list[float]]]
    ) -> np.ndarray:
        """Vectors for ``texts`` in order, computing (in batches) only the ones not cached."""
        found: dict[int, np.ndarray] = {}
        missing: list[int] = []
        for index, text in enumerate(texts):
            path = self._path(kind, text)
            if path.exists():
                found[index] = np.load(path)
            else:
                missing.append(index)
        for start in range(0, len(missing), EMBED_BATCH):
            batch = missing[start : start + EMBED_BATCH]
            vectors = compute([texts[index] for index in batch])
            if len(vectors) != len(batch):
                raise RuntimeError(f"embedder returned {len(vectors)} vectors for {len(batch)} texts")
            for index, vector in zip(batch, vectors, strict=True):
                array = np.asarray(vector, dtype=np.float32)
                path = self._path(kind, texts[index])
                path.parent.mkdir(parents=True, exist_ok=True)
                np.save(path, array)
                found[index] = array
            self.embedded_now += len(batch)
            logger.info("embedded %d/%d %s texts", min(start + EMBED_BATCH, len(missing)), len(missing), kind)
        if not texts:
            return np.zeros((0, 0), dtype=np.float32)
        return np.stack([found[index] for index in range(len(texts))])


class Embedder:
    """Documents and queries, embedded through one backend and cached."""

    def __init__(self, name: str, cache_dir: Path | None):
        self.name = name
        self.model = PRODUCTION_MODEL if name == "production" else f"hashed-{HASHED_DIMENSION}"
        self.base_url = PRODUCTION_BASE_URL if name == "production" else "offline://hashed"
        self._client: Any = None
        self.cache = VectorCache(cache_dir, self.model) if cache_dir is not None else None

    def _production_client(self) -> Any:
        if self._client is None:
            from knowledge_layer.llamaindex.adapter import _resolve_embed_api_key
            from knowledge_layer.llamaindex.adapter import make_embed_model

            api_key = _resolve_embed_api_key(self.base_url, self.model)
            if not api_key:
                raise SystemExit(
                    "No embeddings key: set OPENROUTER_API_KEY (or AIQ_EMBED_API_KEY), or run with --embedder hashed"
                )
            self._client = make_embed_model(base_url=self.base_url, model=self.model, api_key=api_key)
        return self._client

    def _compute(self, kind: str) -> Callable[[list[str]], list[list[float]]]:
        if self.name != "production":
            return lambda texts: [hashed_vector(text).tolist() for text in texts]
        client = self._production_client()
        if kind == "query":
            return lambda texts: [client.get_query_embedding(text) for text in texts]
        return lambda texts: client.get_text_embedding_batch(texts)

    def embed(self, kind: str, texts: Sequence[str]) -> np.ndarray:
        compute = self._compute(kind)
        if self.cache is None:
            return np.asarray(compute(list(texts)), dtype=np.float32)
        return self.cache.get_many(kind, texts, compute)

    @property
    def embedded_now(self) -> int:
        """Texts sent to the embedding API in this process (0 on a fully cached run)."""
        return self.cache.embedded_now if self.cache is not None else 0

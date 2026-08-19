"""The dense channel: two embedders, one of which is a real model and one of which is not.

NEITHER IS PRODUCTION'S EMBEDDER. Production embeds with ``openai/text-embedding-3-large``
through OpenRouter. No number produced here is a claim about production's absolute recall,
and the report says so next to every dense figure.

``hashed`` — the CI path
------------------------
A deterministic random projection of the German analyzer's lexemes into a fixed-dimension
unit vector. It needs no network, no key and no model download, so ``tests/benchmarks/``
can exercise the whole pipeline — index, search, fuse, score — and prove the metric code
runs end to end. It measures WIRING. It has no semantics whatsoever: it cannot match a
paraphrase, and its English numbers are noise by construction. A number from this embedder
is never a retrieval-quality result, and the runner labels every one of them as plumbing.

``e5`` — the measurement path
-----------------------------
``intfloat/multilingual-e5-small``, 384-dim, run locally. It is a legitimate instrument for
RELATIVE comparisons — page-chunking versus Punkt-chunking, German versus English,
dense-alone versus hybrid — because both sides of each comparison see the same model, and
the difference is then a property of the corpus, the chunking or the query language rather
than of the model. It is not a substitute for measuring production's model, which requires
a key and a populated store.

E5 PREFIXES ARE LOAD-BEARING
-----------------------------
E5 models are trained with ``query: ``/``passage: `` prefixes and asymmetric encoding. Drop
them, or use the same prefix on both sides, and every number silently degrades — the
pipeline still runs, the metrics still print, and the result is wrong in a way nothing
downstream can detect. They are applied here, once, so no caller can forget.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from oib_retrieval_eval.corpus import Chunk

logger = logging.getLogger(__name__)

#: The local model used for the real dense arm. Small on purpose: it downloads once and
#: runs on CPU, so the measurement is reproducible on a laptop and in a container.
E5_MODEL_ID = "intfloat/multilingual-e5-small"

#: Where the model weights are cached. Overridable so a container can point at a warm cache
#: instead of re-downloading.
MODEL_CACHE_ENV = "OIB_RETRIEVAL_MODEL_CACHE"

HASHED_DIMENSION = 512


class Embedder(Protocol):
    """Minimal contract the dense index needs. Queries and passages encode DIFFERENTLY."""

    name: str

    def encode_documents(self, texts: list[str]) -> np.ndarray: ...

    def encode_queries(self, texts: list[str]) -> np.ndarray: ...


def _normalise_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return matrix / norms


class HashedEmbedder:
    """Deterministic hashed bag-of-lexemes. Proves the pipeline; measures no quality.

    Lexemes come from the production German analyzer, so the vector at least reflects the
    same tokenisation the lexical channel uses — which is what makes a hashed-arm run a
    genuine exercise of the whole path rather than of random noise. It is still lexical
    overlap in disguise: it cannot connect "escape route" to "Fluchtweg", and it will never
    tell anyone whether retrieval is good.
    """

    name = "hashed"

    def __init__(self, dimension: int = HASHED_DIMENSION) -> None:
        self.dimension = dimension

    def _encode(self, texts: list[str]) -> np.ndarray:
        from aiq_agent.common.german_text import analyze

        matrix = np.zeros((len(texts), self.dimension), dtype=np.float32)
        for row, text in enumerate(texts):
            for lexeme in analyze(text):
                digest = hashlib.blake2b(lexeme.encode("utf-8"), digest_size=8).digest()
                bucket = int.from_bytes(digest[:4], "big") % self.dimension
                # The sign comes from a different byte of the same digest so two lexemes
                # landing in one bucket cancel as often as they reinforce, which is what
                # keeps a 512-dim projection from saturating on a 40k-lexeme corpus.
                sign = 1.0 if digest[4] % 2 == 0 else -1.0
                matrix[row, bucket] += sign
        return _normalise_rows(matrix)

    def encode_documents(self, texts: list[str]) -> np.ndarray:
        return self._encode(texts)

    def encode_queries(self, texts: list[str]) -> np.ndarray:
        return self._encode(texts)


class E5Embedder:
    """``intfloat/multilingual-e5-small`` with its required asymmetric prefixes.

    Imports ``sentence_transformers`` lazily and only when this arm is explicitly asked
    for, so importing this module (or running the CI tests) never pulls in torch or
    touches the network.
    """

    name = "e5"

    def __init__(self, model_id: str = E5_MODEL_ID, cache_folder: str | None = None, batch_size: int = 64) -> None:
        from sentence_transformers import SentenceTransformer

        self.model_id = model_id
        self.batch_size = batch_size
        self._model = SentenceTransformer(model_id, cache_folder=cache_folder or os.environ.get(MODEL_CACHE_ENV))

    def _encode(self, texts: list[str], prefix: str) -> np.ndarray:
        vectors = self._model.encode(
            [f"{prefix}{text}" for text in texts],
            batch_size=self.batch_size,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return np.asarray(vectors, dtype=np.float32)

    def encode_documents(self, texts: list[str]) -> np.ndarray:
        return self._encode(texts, "passage: ")

    def encode_queries(self, texts: list[str]) -> np.ndarray:
        return self._encode(texts, "query: ")

    def truncation(self, texts: list[str]) -> tuple[int, int]:
        """``(chunks over the model's input limit, that limit)`` — a bias this arm carries.

        E5-small accepts 512 tokens. The page-cut arm's chunks are built for a 1024-token
        budget, so a large share of them are TRUNCATED before they are embedded and their
        tail is invisible to the model. The Punkt-cut arm's chunks are far shorter and
        mostly are not. That is a real disadvantage for the page arm under THIS model which
        production's embedder (8191-token input) would not impose, so the chunking A/B run
        with e5 overstates the Punkt arm's margin by an amount this number bounds.
        """
        limit = int(self._model.max_seq_length)
        tokenizer = self._model.tokenizer
        over = sum(1 for text in texts if len(tokenizer.tokenize(f"passage: {text}")) > limit)
        return over, limit


@dataclass
class DenseIndex:
    """Brute-force cosine search over normalised vectors.

    Exact, not approximate: the corpus is ~1000 chunks, so an ANN index would add a recall
    loss of its own on top of the one being measured. Production's Chroma HNSW may lose a
    little more; that difference is not measured here and is not claimed to be zero.
    """

    chunks: list[Chunk]
    vectors: np.ndarray
    embedder_name: str

    def search(self, embedder: Embedder, question: str, top_k: int) -> list[Chunk]:
        query = embedder.encode_queries([question])[0]
        scores = self.vectors @ query
        if top_k >= len(self.chunks):
            order = np.argsort(-scores, kind="stable")
        else:
            top = np.argpartition(-scores, top_k)[:top_k]
            order = top[np.argsort(-scores[top], kind="stable")]
        return [self.chunks[int(position)] for position in order[:top_k]]


def build_dense_index(embedder: Embedder, chunks: list[Chunk]) -> DenseIndex:
    """Encode every chunk of one arm."""
    texts = [chunk.text for chunk in chunks]
    logger.info("Encoding %d chunks with %s", len(texts), embedder.name)
    return DenseIndex(chunks=list(chunks), vectors=embedder.encode_documents(texts), embedder_name=embedder.name)


def make_embedder(name: str) -> Embedder:
    """``"hashed"`` or ``"e5"``; anything else is a typo, not a fallback."""
    if name == "hashed":
        return HashedEmbedder()
    if name == "e5":
        return E5Embedder()
    raise ValueError(f"unknown embedder {name!r}; expected 'hashed' or 'e5'")

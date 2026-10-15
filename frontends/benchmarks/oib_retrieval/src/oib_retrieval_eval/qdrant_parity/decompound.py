"""Experiment: German compound splitting for the BM25 channel, index and query side.

Neither German analyzer splits closed compounds, so „Verfahren“ never reaches
„Nachweisverfahren“ (the ``compound_only`` hard cases score 0 on every lexical
channel). This measures what splitting would buy, without touching production's
write path: the corpus points are copied into a second scope of the same
collection whose BM25 vector is built from the chunk text PLUS the parts of its
compounds; the dense vector, payload and text index are the original ones. The
query side appends the parts of the question's compounds to the BM25 candidates
(``retrieval.bm25_candidates``), and prices them on the split corpus. Everything
else is production's ``_retrieve_sync`` reading that scope.

The splitter is CharSplit (Tuggener 2016) as packaged on PyPI by ``split-words``
(MIT, pure Python, its n-gram table shipped in the wheel, no runtime download):
``uv pip install split-words==0.1.3``. It is not a dependency of anything: the
variant is skipped when it is absent. CharSplit always proposes a split, so a
proposal is kept only when both parts are words of this corpus (four letters or
more, standing alone in some chunk, a linking „s“ dropped from the first part).
"""

from __future__ import annotations

import contextlib
import re
import uuid
from collections import Counter
from collections.abc import Iterator
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

#: The scope the decompounded copy of the parity corpus is written under.
SPLIT_SCOPE = "oib_parity_split"
#: Shorter words are left whole: a German compound worth splitting is longer.
MIN_WORD = 8
MIN_PART = 4
#: CharSplit proposals tried per word, best first.
PROPOSALS = 3
_WORD = re.compile(r"[^\W\d_]+")
_NAMESPACE = uuid.UUID("5f1d2c9e-7a43-4b0e-9d6a-3c2b1e0f8a77")


@dataclass(frozen=True)
class Variant:
    """A sweep variant reading the decompounded scope under ``ranking``.

    ``query_parts`` False splits the index only: a question keeps its words
    whole, so „Verfahren“ reaches „Nachweisverfahren“ while „Brandabschnittsfläche“
    is not widened to every „Brand“ and „Fläche“.
    """

    ranking: Any
    query_parts: bool = True


def available() -> bool:
    try:
        import split_words  # noqa: F401
    except ImportError:
        return False
    return True


class Decompounder:
    """Splits German compounds into parts that are words of a given vocabulary."""

    def __init__(self, texts: Sequence[str]):
        from split_words import Splitter

        self._splitter = Splitter()
        counts = Counter(word.lower() for text in texts for word in _WORD.findall(text))
        self.vocabulary = {word for word, count in counts.items() if count >= 2 and len(word) >= MIN_PART}
        self._cache: dict[str, tuple[str, ...]] = {}

    def _known(self, part: str) -> str | None:
        part = part.lower()
        if part in self.vocabulary:
            return part
        if part.endswith("s") and part[:-1] in self.vocabulary:
            return part[:-1]
        return None

    def parts(self, word: str) -> tuple[str, ...]:
        """The parts of ``word`` (recursively, first part and head), or nothing when it is no compound here."""
        key = word.lower()
        if key in self._cache:
            return self._cache[key]
        found: tuple[str, ...] = ()
        if len(key) >= MIN_WORD:
            for _score, body, head in self._splitter.split_compound(key)[:PROPOSALS]:
                first, last = self._known(body), self._known(head)
                if first and last and len(first) >= MIN_PART and len(last) >= MIN_PART:
                    found = (*(self.parts(first) or (first,)), *(self.parts(last) or (last,)))
                    break
        self._cache[key] = found
        return found

    def expand(self, text: str) -> list[str]:
        """Every part of every compound in ``text``, in order, deduplicated."""
        seen: dict[str, None] = {}
        for word in _WORD.findall(text):
            for part in self.parts(word):
                seen.setdefault(part, None)
        return list(seen)


def build_split_scope(decompounder: Decompounder, source_scope: str) -> dict[str, int]:
    """Copy ``source_scope``'s points into :data:`SPLIT_SCOPE` with BM25 over text plus compound parts."""
    from knowledge_layer.qdrant.schema import DENSE
    from knowledge_layer.qdrant.schema import LEXICAL
    from knowledge_layer.qdrant.schema import SCOPE_FIELD
    from knowledge_layer.qdrant.scope import scope_filter
    from knowledge_layer.qdrant.store import bm25
    from knowledge_layer.qdrant.store import get_store
    from qdrant_client import models

    store = get_store()
    alias = store.alias(source_scope)
    offset: Any = None
    copied = expanded = 0
    while True:
        page, offset = store.client.scroll(
            alias, scroll_filter=scope_filter([source_scope]), limit=256, offset=offset, with_vectors=[DENSE]
        )
        points = []
        for record in page:
            payload = dict(record.payload or {})
            text = str(payload.get("text") or "")
            extra = decompounder.expand(text)
            expanded += bool(extra)
            payload[SCOPE_FIELD] = SPLIT_SCOPE
            vector: dict[str, Any] = {DENSE: record.vector[DENSE]}
            if text.strip():
                vector[LEXICAL] = bm25(" ".join([text, *extra]))
            points.append(
                models.PointStruct(id=str(uuid.uuid5(_NAMESPACE, str(record.id))), vector=vector, payload=payload)
            )
        if points:
            store.client.upsert(alias, points, wait=True)
            copied += len(points)
        if offset is None:
            return {"copied": copied, "with_parts": expanded}


@contextlib.contextmanager
def query_side(decompounder: Decompounder, corpus_texts: Sequence[str], *, query_parts: bool = True) -> Iterator[None]:
    """BM25 candidates gain the parts of the question's compounds, priced on the split corpus.

    Every candidate's document frequency is counted over the decompounded
    chunk texts in Python when it is a part, or (``query_parts`` False) when
    any compound holds it: the text index the pricing reads holds the original words only, so
    it would count „verfahren“ where it stands alone and miss every
    „Nachweisverfahren“ the split BM25 vector now matches.
    """
    from knowledge_layer.qdrant import retrieval

    documents = [set(_WORD.findall(text.lower())) | set(decompounder.expand(text)) for text in corpus_texts]
    original_candidates, original_frequencies = retrieval.bm25_candidates, retrieval.term_frequencies
    parts: set[str] = set()
    split_vocabulary = {part for text in corpus_texts for part in decompounder.expand(text)}

    def candidates(query: str, extra_terms: Sequence[str] = ()) -> list[str]:
        base = original_candidates(query, extra_terms)
        added = [part for part in decompounder.expand(query) if part not in base] if query_parts else []
        parts.update(added)
        return [*base, *added]

    def frequencies(scopes: Any, terms: Sequence[str], cache: Any = None) -> tuple[int, dict[str, int]]:
        counted = parts if query_parts else split_vocabulary
        total, counts = original_frequencies(scopes, [t for t in terms if t not in counted], cache)
        for term in terms:
            if term in counted:
                counts[term] = sum(1 for words in documents if term in words)
        return total, counts

    retrieval.bm25_candidates, retrieval.term_frequencies = candidates, frequencies
    try:
        yield
    finally:
        retrieval.bm25_candidates, retrieval.term_frequencies = original_candidates, original_frequencies

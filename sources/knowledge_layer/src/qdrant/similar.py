"""Similar passages: the office's nearest passages to one it is looking at ("Ähnliche Stellen").

A person reading a passage (a cited Fundstelle, or a sentence they selected)
asks where the office has written something like it before. The answer is a
nearest-neighbour query over the office's collection, restricted to the
scopes the BFF authorized, with the passage's own document left out, grouped
by document in ranking order.

The query vector is the one the store already holds whenever the passage is a
stored chunk, so most asks cost no model call:

* a chunk id names the point directly;
* a cited passage carries its text, its file and its page, and the chunk that
  holds that text is found by a scroll over the file (page first);
* only a free selection, or a citation whose chunk is not found, is embedded,
  through the retriever's cached query embedding (the caller's ``embed``).

The point is queried by id (Qdrant's ``nearest`` with a point id). A source in
the legal corpus is looked up there (``lookup_from``) while the search runs
over the office collection: what the office wrote next to an OIB passage is a
question this answers too.

Dense only. A BM25 channel over a whole passage as its query has no measured
benefit yet, and a long passage as a lexical query mostly matches its stop
words; it waits for an evaluation set rather than riding along.

Nothing returned carries a ``qdrant_client`` type.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from qdrant_client import models

from aiq_agent.knowledge.base import reading_order

from .schema import CHUNK_ID_FIELD
from .schema import DENSE
from .schema import READING_ORDER_FIELD
from .schema import SCOPE_FIELD
from .schema import TEXT_FIELD
from .schema import Physical
from .schema import physical_for_scope
from .scope import scope_condition
from .scope import scope_filter
from .store import QdrantStore

#: Points ranked before grouping: enough for ``documents`` groups of
#: ``per_document`` passages when a few documents hold many near passages.
MAX_CANDIDATES = 200
#: Chunks of one file read to find the one holding a cited passage. A guard:
#: a document's chunks stay far below it.
LOCATE_SCAN_CAP = 4096
#: How much of a cited passage has to be found inside a chunk. A citation's
#: snippet can be cut short, so its head is what is matched.
LOCATE_PROBE_CHARS = 240
#: Below this many characters a passage is too short to say which chunk holds it.
LOCATE_MIN_CHARS = 24

#: How the query vector was obtained.
ORIGIN_POINT = "point"
ORIGIN_EMBEDDED = "embedded"

_SPACE = re.compile(r"\s+")
_TRAILING_ELLIPSIS = re.compile(r"(?:…|\.\.\.)\s*$")


@dataclass(frozen=True)
class PassageSource:
    """The passage a person asked about, as the route received it (already authorized)."""

    scope: str
    file_name: str
    text: str = ""
    page: int | None = None
    chunk_id: str | None = None
    #: The passage is retrieved text (a citation) and may stand for a stored chunk.
    #: A selection is never matched to a chunk: the chunk says more than the selection.
    cited: bool = False
    #: The BFF's document id, when it knows it: excluded by id as well as by file.
    document_id: str | None = None


@dataclass
class SimilarPassage:
    """One passage of a similar document."""

    chunk_id: str
    text: str
    page: int | None
    score: float


@dataclass
class SimilarDocument:
    """A document holding passages similar to the source, its best passage first."""

    scope: str
    file_name: str
    passages: list[SimilarPassage] = field(default_factory=list)


@dataclass
class SimilarResult:
    """The documents in ranking order, and how the query vector was obtained."""

    documents: list[SimilarDocument]
    origin: str
    #: Points ranked before grouping, for the trace.
    candidates: int = 0


def normalized(text: str) -> str:
    """Text for containment checks: one space between words, case folded, a trailing ellipsis dropped."""
    return _SPACE.sub(" ", _TRAILING_ELLIPSIS.sub("", text or "")).strip().casefold()


def _file_condition(source: PassageSource) -> models.Filter:
    return models.Filter(
        must=[
            scope_condition([source.scope]),
            models.FieldCondition(key="file_name", match=models.MatchValue(value=source.file_name)),
        ]
    )


def _record_by_chunk_id(store: QdrantStore, source: PassageSource) -> Any | None:
    """The source scope's point for ``source.chunk_id``, or None."""
    if not source.chunk_id:
        return None
    condition = models.FieldCondition(key=CHUNK_ID_FIELD, match=models.MatchValue(value=str(source.chunk_id)))
    return next(iter(store.scroll(source.scope, None, condition, limit=1)), None)


def _containing(records: Sequence[Any], probe: str) -> Any | None:
    """The first record whose text holds ``probe`` (or is held by it, for a passage longer than one chunk)."""
    for record in records:
        text = normalized(str((record.payload or {}).get(TEXT_FIELD) or ""))
        if text and (probe in text or (len(text) >= LOCATE_MIN_CHARS and text in probe)):
            return record
    return None


def _record_by_text(store: QdrantStore, source: PassageSource) -> Any | None:
    """The chunk of the source file holding the cited text: its page first, then the whole file."""
    probe = normalized(source.text)[:LOCATE_PROBE_CHARS]
    if len(probe) < LOCATE_MIN_CHARS:
        return None
    file_filter = _file_condition(source)
    if source.page:
        on_page = models.FieldCondition(key=READING_ORDER_FIELD, match=models.MatchValue(value=int(source.page)))
        found = _containing(list(store.scroll(source.scope, None, file_filter, on_page, limit=LOCATE_SCAN_CAP)), probe)
        if found is not None:
            return found
    return _containing(list(store.scroll(source.scope, None, file_filter, limit=LOCATE_SCAN_CAP)), probe)


def locate_source(store: QdrantStore, source: PassageSource) -> Any | None:
    """The stored point the passage is, when it is one: by chunk id, else (a citation) by its text."""
    record = _record_by_chunk_id(store, source)
    if record is None and source.cited:
        record = _record_by_text(store, source)
    return record


def _excluded(source: PassageSource) -> models.Filter:
    """Everything of the source document: its file in its scope, and every point carrying its BFF id."""
    exclusions: list[Any] = [_file_condition(source)]
    if source.document_id:
        exclusions.append(
            models.FieldCondition(key="grid_document_id", match=models.MatchValue(value=source.document_id))
        )
    return models.Filter(must_not=exclusions)


#: The superseded Fassung of a document drops out, as from every answer (ADR-0099).
#: ``$ne`` keeps a point that carries no ``superseded`` at all.
CURRENT_FASSUNGEN: dict[str, Any] = {"superseded": {"$ne": True}}


def group_by_document(points: Sequence[Any], documents: int, per_document: int) -> list[SimilarDocument]:
    """The first ``documents`` documents in ranking order, each with its best ``per_document`` passages.

    A document is its scope and file name: a file name is unique within one
    scope only, and a project's restricted folder is a scope of its own.
    """
    grouped: dict[tuple[str, str], SimilarDocument] = {}
    for point in points:
        payload = point.payload or {}
        scope, file_name = payload.get(SCOPE_FIELD), payload.get("file_name")
        if not scope or not file_name:
            continue
        key = (str(scope), str(file_name))
        if key not in grouped:
            if len(grouped) >= documents:
                continue
            grouped[key] = SimilarDocument(scope=key[0], file_name=key[1])
        document = grouped[key]
        if len(document.passages) < per_document:
            page = reading_order(payload.get("page_label"))
            document.passages.append(
                SimilarPassage(
                    chunk_id=str(payload.get(CHUNK_ID_FIELD) or point.id),
                    text=str(payload.get(TEXT_FIELD) or ""),
                    page=page or None,
                    score=float(point.score),
                )
            )
    return list(grouped.values())


def find_similar(
    store: QdrantStore,
    scopes: Sequence[str],
    *,
    source: PassageSource,
    embed: Callable[[str], Sequence[float]],
    documents: int,
    per_document: int,
) -> SimilarResult:
    """The documents of ``scopes`` nearest to ``source``, best first; the source document never among them.

    ``scopes`` are the office's collections the caller may read (one physical
    collection); the source's own scope need not be one of them. ``embed`` is
    asked only when the passage is no stored point.
    """
    if documents <= 0 or per_document <= 0 or not scopes:
        return SimilarResult([], ORIGIN_POINT)
    physicals = {physical_for_scope(scope) for scope in scopes}
    if physicals != {Physical.OFFICE}:
        raise ValueError(f"Similar passages are searched in the office's collections, not {sorted(physicals)}")
    if not store.exists(scopes[0]):
        return SimilarResult([], ORIGIN_POINT)
    store.check_identity(scopes[0])
    store.check_identity(source.scope)
    record = locate_source(store, source)
    query: Any
    lookup: models.LookupLocation | None = None
    if record is not None:
        query, origin = record.id, ORIGIN_POINT
        if physical_for_scope(source.scope) is not Physical.OFFICE:
            lookup = models.LookupLocation(collection=store.alias(source.scope), vector=DENSE)
    elif source.text.strip():
        query, origin = list(embed(source.text)), ORIGIN_EMBEDDED
    else:
        raise LookupError("the passage is no stored chunk and carries no text to embed")
    candidates = min(MAX_CANDIDATES, max(documents * per_document * 4, documents))
    result = store.client.query_points(
        store.alias(scopes[0]),
        query=query,
        using=DENSE,
        lookup_from=lookup,
        query_filter=scope_filter(scopes, CURRENT_FASSUNGEN, _excluded(source)),
        # The scores are shown as a match percentage: rescored from the original
        # vectors rather than read off the 4-bit quantized copy.
        search_params=models.SearchParams(quantization=models.QuantizationSearchParams(rescore=True)),
        limit=candidates,
        with_payload=True,
    )
    return SimilarResult(group_by_document(result.points, documents, per_document), origin, len(result.points))

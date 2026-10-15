"""A document's indexed text, page by page, read back from its collection's chunks.

The permit backfill and the project-experience route both read a document that was
ingested long ago without re-parsing it: the chunks in Qdrant carry the text and
the page label. One reader, so the two cannot drift in how they order pages.
"""

from __future__ import annotations

from typing import Any

#: The most chunks one document's read takes. A guard, not a budget: the
#: structural fetch's own cap (``knowledge_layer.qdrant.reads.WHOLE_SET_CAP``).
MAX_CHUNKS = 4096


def read_pages(collection: str, file_name: str) -> list[tuple[Any, str]] | None:
    """``(page_label, chunk text)`` of one file in reading order, or None when the collection or file has none.

    Raises when the store cannot be read: an outage is not evidence that a
    file has no chunks, so it never reads as None (``read_passage`` does the same).

    A structural fetch (``knowledge_layer.qdrant.reads.fetch``): a filter on the
    file, no query vector, no ranking. Reading order is page, then the section
    structure ``read_passage`` sorts by, then the chunk's place in the file
    (``reads.in_document_order``); point ids, which a scroll returns them by,
    are random.
    """
    hits = _document_hits(collection, file_name)
    return [(hit.payload.get("page_label"), hit.text) for hit in hits if hit.text] or None


def read_chunks(collection: str, file_name: str) -> list[tuple[str, dict[str, Any]]] | None:
    """``(chunk text, metadata)`` of one file in reading order; None when the collection or file has none.

    The compare of two Fassungen (``fassung_diff``) needs what ``read_pages``
    drops: the ``content_type`` that tells printed text from a drawing reading,
    and the ``drawing_data`` that holds the reading's structure. The same
    structural fetch and order, with the chunk's own metadata
    (``chunk_metadata``: the payload without the fields only the store adds).
    Raises when the store cannot be read, as ``read_pages`` does.
    """
    from knowledge_layer.qdrant.payload import chunk_metadata

    hits = _document_hits(collection, file_name)
    return [(hit.text, chunk_metadata(hit.payload)) for hit in hits if hit.text] or None


def _document_hits(collection: str, file_name: str) -> list[Any]:
    """Every chunk of one file, in reading order (``reads.in_document_order``)."""
    from knowledge_layer.qdrant import reads

    return reads.in_document_order(reads.fetch(collection, {"file_name": file_name}, MAX_CHUNKS))

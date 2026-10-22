"""One chunk's Qdrant point: id, vectors and a flat, typed payload.

The payload carries the chunk's own metadata as LlamaIndex wrote it (minus
LlamaIndex's bookkeeping), the chunk text as a top-level field, the logical
``scope`` it belongs to, and what the collection name used to only imply:
the office, project and BFF document it came from, and the facts a person
set on the document (tags, Dokumentart, Fassung status, folder).

A point id is the chunk id (the chunker's node id), so a citation, an
``already_read`` digest or a Langfuse score that names a chunk names the
point, and chunks copied from the old store keep the ids they were cited
by. A chunk id that is not a UUID gets a stable UUIDv5 point id; the payload
keeps the original.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from dataclasses import field
from datetime import UTC
from datetime import date
from datetime import datetime
from typing import Any

from aiq_agent.knowledge.base import reading_order
from aiq_agent.knowledge.document_classification import canonical_doc_class
from aiq_agent.knowledge.document_classification import qdrant_doc_class

from .prefilter import FOLDER_FIELD
from .prefilter import folder_ancestors
from .schema import ADDED_AT_FIELD
from .schema import BOOL_FIELDS
from .schema import CHUNK_ID_FIELD
from .schema import CHUNK_ORDINAL_FIELD
from .schema import DATETIME_FIELDS
from .schema import DOCUMENT_DATE_FIELD
from .schema import FACT_KEYS
from .schema import INDEXED_AT_FIELD
from .schema import INTEGER_FIELDS
from .schema import KEYWORD_FIELDS
from .schema import LEGACY_CHUNKING
from .schema import LEGACY_FIELDS
from .schema import PARAGRAPH_FIELD
from .schema import PROJECT_FACTS_FIELD
from .schema import PROJECT_STATUS_FIELD
from .schema import READING_ORDER_FIELD
from .schema import SCOPE_FIELD
from .schema import TEXT_FIELD
from .schema import TEXT_STEM_FIELD

#: LlamaIndex's own keys on a stored node. ``_node_content`` is a second, JSON
#: copy of the whole node including its text; ``doc_id``/``ref_doc_id``/
#: ``document_id`` name LlamaIndex's source Document, not the BFF document
#: (that one is ``grid_document_id``).
LLAMA_INTERNAL_KEYS = frozenset({"_node_content", "_node_type", "doc_id", "ref_doc_id", "document_id"})

#: Fields multi-valued by nature: a scalar is wrapped, so a filter can match any.
LIST_FIELDS = frozenset({"tags", "topics", FOLDER_FIELD, PARAGRAPH_FIELD})

#: Payload field keeping the Dokumentart the chunk was ingested with (its own
#: ``doc_class`` metadata, "" for none), so clearing a person's class can put
#: back what ``register._hit_doc_class`` falls back to (``writes.refresh_facts``).
#: Stored, not indexed: nothing filters on it.
CHUNK_DOC_CLASS_FIELD = "chunk_doc_class"

#: A ``§`` reference in chunk text: the number the way ``legal_terms`` reads a
#: query's (``3``, ``3a``, ``12.1``). The letter counts only when no further
#: letter follows, so "§ 3Abs" is ``§ 3``; "§§ 3" is ``§ 3``.
_PARAGRAPH_REF = re.compile(r"§+\s*(\d+(?:\.\d+)?(?:[a-z](?![a-z]))?)", re.IGNORECASE)

_TRUE_STRINGS = frozenset({"true", "1", "yes", "ja"})
_FALSE_STRINGS = frozenset({"false", "0", "no", "nein", ""})

_POINT_NAMESPACE = uuid.UUID("5b0c7f8e-6b8a-4f0e-9a51-2c1d8f3e7a10")


@dataclass
class ChunkRecord:
    """One embedded chunk: its id, text, dense vector and metadata, as ingestion (or a migration) writes it."""

    chunk_id: str
    text: str
    embedding: list[float]
    metadata: dict[str, Any] = field(default_factory=dict)
    #: The chunk's place in its file (``schema.CHUNK_ORDINAL_FIELD``); None when the writer does not know it.
    ordinal: int | None = None


def point_id(chunk_id: str) -> str:
    """The Qdrant point id for a chunk: the chunk id itself when it is a UUID."""
    try:
        return str(uuid.UUID(chunk_id))
    except (ValueError, AttributeError, TypeError):
        return str(uuid.uuid5(_POINT_NAMESPACE, str(chunk_id)))


def paragraph_key(number: str) -> str:
    """One ``§`` reference as :data:`PARAGRAPH_FIELD` holds it: ``§ 3a``, case folded."""
    return f"§ {number.strip().rstrip('.')}".casefold()


def paragraph_refs(text: str) -> list[str]:
    """Every ``§`` reference ``text`` cites, once each, in order of first appearance."""
    return list(dict.fromkeys(paragraph_key(match) for match in _PARAGRAPH_REF.findall(text or "")))


def _as_bool(value: Any) -> bool | None:
    """``value`` as a boolean; a string is read for what it says ("false" is False), anything unreadable is None."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        folded = value.strip().casefold()
        if folded in _TRUE_STRINGS:
            return True
        if folded in _FALSE_STRINGS:
            return False
        return None
    if isinstance(value, (int, float)):
        return bool(value)
    return None


def _as_int(value: Any) -> int | None:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def as_rfc3339(value: Any) -> str | None:
    """``value`` as an RFC 3339 UTC timestamp; None when it is not a date.

    Reads a ``date``/``datetime``, an ISO 8601 string (``2026-01-31``, ``2026-01-31T10:00:00+02:00``,
    a trailing ``Z``) and an EXIF-style ``2026:01:31 10:00:00``. A naive time is taken as UTC. A bool
    or a number is not a date.
    """
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, date):
        moment = datetime(value.year, value.month, value.day)
    elif isinstance(value, str) and value.strip():
        text = value.strip()
        if re.fullmatch(r"\d{4}:\d{2}:\d{2}.*", text):
            text = text[:10].replace(":", "-") + text[10:]
        try:
            moment = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def coerce_field(key: str, value: Any) -> Any:
    """A value in the type its index expects; None when it cannot be one.

    Used for writes AND for filter values, so the two always agree: the same
    coercion that stores ``page_label`` 3 as "3" turns a filter's 3 into "3".
    """
    if value is None:
        return None
    if key in INTEGER_FIELDS:
        return _as_int(value)
    if key in BOOL_FIELDS:
        return _as_bool(value)
    if key in DATETIME_FIELDS:
        return as_rfc3339(value)
    if key in LIST_FIELDS:
        items = value if isinstance(value, (list, tuple, set)) else [value]
        return [str(item) for item in items if item is not None and str(item)]
    if key in KEYWORD_FIELDS:
        return str(value)
    return value


def document_facts(document: Any | None) -> dict[str, Any]:
    """The person-set facts of one document, as payload fields.

    ``document`` is an ``AvailableDocument`` row from the metadata store, the
    authority for every one of these: Postgres decides, the payload mirrors.
    """
    if document is None:
        return {}
    facts: dict[str, Any] = {
        "tags": list(getattr(document, "tags", None) or []),
        "topics": list(getattr(document, "topics", None) or []),
        "superseded": bool(getattr(document, "superseded_by", None)),
    }
    if doc_class := getattr(document, "doc_class", None):
        facts["doc_class"] = qdrant_doc_class(doc_class)
    # The folder is stated even at the root (None, []), so a file moved to the
    # root stops matching the folder it left. ``doc_class`` is not: without a
    # stored class the chunk's own one stands, as it does for the post-filter.
    folder_path = getattr(document, "folder_path", None) or None
    facts["folder_path"] = folder_path
    facts[FOLDER_FIELD] = folder_ancestors(folder_path)
    # Stated even when unknown (None), so a date a person or a re-read removed stops matching a range.
    facts[DOCUMENT_DATE_FIELD] = _document_date(document)
    facts[ADDED_AT_FIELD] = as_rfc3339(getattr(document, "added_at", None))
    return facts


def _document_date(document: Any) -> str | None:
    """The document's own date: the title block's ``revision_date``, else the photo's ``captured_at``,
    else, for a filed E-Mail-Verlauf, its newest message's send time (``mail_thread.latest_sent_at``).

    A file that came WITH a mail keeps its own date: a Stellplatznachweis dated in March and sent in
    May is a March document, so ``mail_origin`` is not read here.
    """
    revision = getattr(document, "revision_facts", None)
    capture = getattr(document, "capture", None)
    thread = getattr(document, "mail_thread", None)
    for source, key in ((revision, "revision_date"), (capture, "captured_at"), (thread, "latest_sent_at")):
        if isinstance(source, Mapping) and (stamp := as_rfc3339(source.get(key))):
            return stamp
    return None


#: The lifecycle states a project can be in (ADR-0098), as the BFF writes them.
PROJECT_STATUSES = ("active", "paused", "closed")


def _fact_values(key: str, value: Any) -> list[Any]:
    items = value if isinstance(value, (list, tuple, set)) else [value]
    if key == "building_class":
        return sorted({number for number in (_as_int(item) for item in items) if number is not None})
    return list(dict.fromkeys(str(item) for item in items if item is not None and str(item).strip()))


def project_payload(facts: Mapping[str, Any] | None, status: str) -> dict[str, Any]:
    """The project's facts and status as the payload every one of its points carries.

    ``facts`` is the BFF's similarity reading of ``projects.profile`` (the
    authority): ``federal_state`` one token or absent, every other key a list.
    The whole ``project_facts`` object is written at once, so a fact a person
    removed disappears from the points instead of lingering. Unknown keys are
    dropped; an unknown status raises, since it would filter as nothing.
    """
    if status not in PROJECT_STATUSES:
        raise ValueError(f"project status {status!r} is not one of {', '.join(PROJECT_STATUSES)}")
    shaped: dict[str, Any] = {}
    for key in FACT_KEYS:
        values = _fact_values(key, (facts or {}).get(key))
        if key == "federal_state":
            if values:
                shaped[key] = values[0]
        else:
            shaped[key] = values
    return {PROJECT_FACTS_FIELD: shaped, PROJECT_STATUS_FIELD: status}


def build_payload(scope: str, record: ChunkRecord, enrichment: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The payload for one chunk; ``scope``, ``text``, ``chunk_id``, ``reading_order`` and the ordinal always win.

    ``reading_order`` is derived from the STORED ``page_label`` (a string by
    then), the value a reader's ``Chunk.page_number`` is parsed from, so the
    order a fetch sorts by and the order its reader re-sorts by agree.
    """
    payload: dict[str, Any] = {
        key: value for key, value in (record.metadata or {}).items() if key not in LLAMA_INTERNAL_KEYS
    }
    payload.update({key: value for key, value in (enrichment or {}).items() if value is not None})
    typed: dict[str, Any] = {}
    for key, value in payload.items():
        coerced = coerce_field(key, value)
        if coerced is not None:
            typed[key] = coerced
    # The vector store holds the German spelling of a Dokumentart until its rebuild (qdrant_doc_class).
    if isinstance(typed.get("doc_class"), str):
        typed["doc_class"] = qdrant_doc_class(typed["doc_class"])
    # Derived from whichever folder won, never taken from a writer.
    typed[FOLDER_FIELD] = folder_ancestors(typed.get("folder_path"))
    typed[SCOPE_FIELD] = scope
    typed[TEXT_FIELD] = record.text or ""
    typed[TEXT_STEM_FIELD] = typed[TEXT_FIELD]
    typed[CHUNK_ID_FIELD] = str(record.chunk_id)
    typed[READING_ORDER_FIELD] = reading_order(typed.get("page_label"))
    if record.ordinal is not None:
        typed[CHUNK_ORDINAL_FIELD] = int(record.ordinal)
    typed[PARAGRAPH_FIELD] = paragraph_refs(typed[TEXT_FIELD])
    typed[CHUNK_DOC_CLASS_FIELD] = qdrant_doc_class(str((record.metadata or {}).get("doc_class") or ""))
    return typed


#: Fields an ingest job or the metadata store decides, never the chunk itself.
#: :func:`chunk_own_payload` leaves them out, so a backfill that refreshes a
#: point's own fields cannot strip what ingestion or a person put there.
ENRICHED_FIELDS = frozenset(
    {"office_id", "project_id", "grid_document_id", "folder_path", FOLDER_FIELD, "tags", "topics", "superseded"}
    | {"doc_class", INDEXED_AT_FIELD, *DATETIME_FIELDS}
)


def chunk_own_payload(scope: str, record: ChunkRecord) -> dict[str, Any]:
    """The payload fields derived from the chunk alone: its metadata, text and every field computed from them.

    Merged onto a point that already exists (``set_payload``), it brings a
    field added to :func:`build_payload` after the point was written, and
    leaves the job's ids and a person's facts as they are.
    """
    return {key: value for key, value in build_payload(scope, record).items() if key not in ENRICHED_FIELDS}


#: Fields the store adds for filtering. A hit's metadata leaves them out, so a
#: chunk read back carries exactly the metadata the chunker gave it; the facts
#: themselves are read from the metadata store, their authority.
STORE_ONLY_FIELDS = frozenset(
    {TEXT_FIELD, TEXT_STEM_FIELD, SCOPE_FIELD, CHUNK_ID_FIELD, READING_ORDER_FIELD}
    | {"office_id", "project_id", "grid_document_id"}
    | {
        CHUNK_ORDINAL_FIELD,
        "folder_path",
        FOLDER_FIELD,
        "tags",
        "topics",
        "superseded",
        PROJECT_FACTS_FIELD,
        PROJECT_STATUS_FIELD,
        PARAGRAPH_FIELD,
        CHUNK_DOC_CLASS_FIELD,
        INDEXED_AT_FIELD,
        *DATETIME_FIELDS,
    }
)


def chunk_metadata(payload: Mapping[str, Any]) -> dict[str, Any]:
    """The chunk metadata a caller sees on a hit: the payload minus what only the store adds.

    ``doc_class`` is the chunk's own, as the chunker stamped it, not the
    person's class a pre-filter matches: the reader resolves the stored class itself
    and falls back to this one (``register._hit_doc_class``). A point written
    before :data:`CHUNK_DOC_CLASS_FIELD` existed keeps the payload's.
    """
    metadata = {key: value for key, value in payload.items() if key not in STORE_ONLY_FIELDS}
    if CHUNK_DOC_CLASS_FIELD in payload:
        metadata.pop("doc_class", None)
        if payload[CHUNK_DOC_CLASS_FIELD]:
            metadata["doc_class"] = payload[CHUNK_DOC_CLASS_FIELD]
    # A point holds the German spelling until the vector store is rebuilt; a hit speaks the current one.
    if isinstance(metadata.get("doc_class"), str):
        metadata["doc_class"] = canonical_doc_class(metadata["doc_class"]) or metadata["doc_class"]
    return _english_clause_keys(metadata)


def _english_clause_keys(metadata: dict[str, Any]) -> dict[str, Any]:
    """``metadata`` with the clause keys a point written before the rename holds read under their English names.

    ``punkt_id`` is read as ``clause_id`` and ``chunking: "punkt"`` as ``"clause"``; the English
    key wins when both are present. Remove with ``schema.LEGACY_FIELDS``.
    """
    for new, old in LEGACY_FIELDS.items():
        if old in metadata and not old.startswith(PROJECT_FACTS_FIELD):
            legacy = metadata.pop(old)
            metadata.setdefault(new, legacy)
    chunking = metadata.get("chunking")
    if isinstance(chunking, str):
        metadata["chunking"] = {old: new for new, old in LEGACY_CHUNKING.items()}.get(chunking, chunking)
    return metadata

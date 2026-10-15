"""The Qdrant client and every write the knowledge layer makes.

This package is the only code that imports ``qdrant_client`` (an
import-linter contract fails the build otherwise), so the scope filter, the
BM25 options and the payload shape cannot drift between callers.

Writes address points by scope and chunk id or by scope and file name, never
by a bare id list from elsewhere: a delete names what it deletes.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable
from collections.abc import Iterable
from collections.abc import Iterator
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any
from typing import TypeVar

import httpx
from qdrant_client import QdrantClient
from qdrant_client import models
from qdrant_client.http.exceptions import ResponseHandlingException
from qdrant_client.http.exceptions import UnexpectedResponse

from .config import REQUEST_TIMEOUT_SECONDS
from .config import qdrant_api_key
from .config import qdrant_url
from .payload import CHUNK_DOC_CLASS_FIELD
from .payload import ChunkRecord
from .payload import build_payload
from .payload import chunk_own_payload
from .payload import point_id
from .schema import ALIASES
from .schema import BM25_MODEL
from .schema import BM25_OPTIONS
from .schema import CHUNK_ID_FIELD
from .schema import DENSE
from .schema import LEXICAL
from .schema import SCOPE_FIELD
from .schema import TEXT_FIELD
from .schema import Physical
from .schema import ensure_collection
from .schema import ensure_payload_indexes
from .schema import identity_mismatch
from .schema import physical_for_scope
from .schema import text_index_drift
from .scope import scope_condition
from .scope import scope_filter

logger = logging.getLogger(__name__)

#: Points per upsert request. A 3072-d vector is about 30 KB of JSON, so this
#: keeps one request near 2 MB.
UPSERT_BATCH = 64
#: Points per scroll page.
SCROLL_PAGE = 256
#: Payload updates per ``batch_update_points`` request.
PAYLOAD_BATCH = 128
#: Distinct values one facet request may return: every file of a scope, every
#: scope of a collection. Above it the caller reads a truncated list, and says so.
FACET_LIMIT = 100_000
#: Chunk ids per delete request: a re-upload retires every chunk of the version
#: it replaces, and a large drawing set has thousands.
DELETE_BATCH = 1024

#: The pause before each retry of a write that failed transiently. A peer
#: that is restarting (a rollout, a drain) answers again within seconds; a
#: refusal (4xx) is final and is never retried.
RETRY_BACKOFF_SECONDS = (0.2, 0.8, 2.0)

T = TypeVar("T")


def _transient(error: BaseException) -> bool:
    """True for a failure a retry can cure: no connection, a timeout, a 5xx. Never a 4xx."""
    if isinstance(error, UnexpectedResponse):
        return error.status_code is not None and error.status_code >= 500
    if isinstance(error, ResponseHandlingException):
        return isinstance(error.source, (httpx.TransportError, ConnectionError, TimeoutError))
    return isinstance(error, (httpx.TransportError, ConnectionError, TimeoutError))


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def with_retry(label: str, work: Callable[[], T]) -> T:
    """Run one write, or a read whose answer decides one, retrying a transient failure after each pause.

    Every write this store makes is idempotent (an upsert or set by point id
    or filter, a delete by filter), so a retry after a timeout whose request
    did land changes nothing; a read changes nothing at all. ``work`` must
    return the whole answer (a list, not a lazy scroll), so a retry starts
    over. The pauses are :data:`RETRY_BACKOFF_SECONDS`.
    """
    for pause in RETRY_BACKOFF_SECONDS:
        try:
            return work()
        except Exception as error:
            if not _transient(error):
                raise
            logger.warning("Qdrant %s failed transiently (%s); retrying in %.1f s", label, error, pause)
            _sleep(pause)
    return work()


def bm25(text: str) -> models.Document:
    """The text as Qdrant's server-side BM25 input, with the one set of German options."""
    return models.Document(text=text, model=BM25_MODEL, options=dict(BM25_OPTIONS))


class QdrantStore:
    """Writes and plain reads against the two physical collections."""

    def __init__(self, client: QdrantClient, identity: Mapping[str, str] | None = None):
        self.client = client
        self.identity = dict(identity or {})
        self._ensured: set[Physical] = set()
        self._present: set[Physical] = set()
        self._verified: set[Physical] = set()
        self._indexed: set[tuple[Physical, str]] = set()
        self._sound_text: set[Physical] = set()
        self._ensure_lock = threading.Lock()

    @staticmethod
    def alias(scope: str) -> str:
        """The alias of the physical collection holding ``scope``."""
        return ALIASES[physical_for_scope(scope)]

    def ensure(self, scope: str, dense_size: int) -> str:
        """Make sure ``scope``'s physical collection exists; returns its alias."""
        physical = physical_for_scope(scope)
        if physical not in self._ensured:
            with self._ensure_lock:
                if physical not in self._ensured:
                    ensure_collection(self.client, physical, dense_size, self.identity)
                    self._ensured.add(physical)
        return ALIASES[physical]

    def exists(self, scope: str) -> bool:
        """True when ``scope``'s physical collection exists (no point need exist in it).

        A positive answer is remembered: a collection is never dropped under a
        running process (a rebuild switches the alias to a new one), so only
        "not yet" needs asking again.
        """
        physical = physical_for_scope(scope)
        if physical in self._ensured or physical in self._present:
            return True
        alias = ALIASES[physical]
        if any(entry.alias_name == alias for entry in self.client.get_aliases().aliases):
            self._ensure_indexes(alias)
            self._present.add(physical)
            return True
        return False

    def _ensure_indexes(self, alias: str) -> None:
        """Add the payload indexes a collection made by older code lacks, before this process reads it.

        A process that only reads never calls :meth:`ensure`, and without the
        index strict mode refuses the filter. A key that may not create
        indexes is logged here and the read goes on: a query that needs the
        missing index then fails at the server, naming the field.
        """
        try:
            ensure_payload_indexes(self.client, alias)
        except Exception:  # noqa: BLE001 - see the docstring; the refusal surfaces on the query
            logger.error("Qdrant %s: could not create missing payload indexes", alias, exc_info=True)

    def check_identity(self, scope: str) -> None:
        """Raise when ``scope``'s collection holds vectors from another embedder than this process's.

        Checked once per physical collection per process. Without a known
        identity (a process that never embeds) there is nothing to compare.
        """
        physical = physical_for_scope(scope)
        if not self.identity or physical in self._verified or not self.exists(scope):
            return
        mismatch = identity_mismatch(self.client.get_collection(ALIASES[physical]).config.metadata, self.identity)
        if mismatch:
            raise RuntimeError(f"{ALIASES[physical]}: {mismatch}")
        self._verified.add(physical)

    # ------------------------------------------------------------------ writes

    def upsert(
        self,
        scope: str,
        records: Sequence[ChunkRecord],
        enrichment: Mapping[str, Any] | None = None,
        *,
        insert_only: bool = False,
    ) -> int:
        """Write ``records`` into ``scope``; returns how many points were sent.

        The dense vector is the one the caller computed (ingestion's embedder,
        or a migration's copy: no embedding call here); the lexical vector is
        computed by Qdrant from the text. A point with the same id is replaced
        whole, which is what a retried write needs.

        ``insert_only`` leaves a point that already exists exactly as it is
        (Qdrant's ``update_mode: insert_only``) and merges only the fields the
        chunk alone decides onto it (:func:`payload.chunk_own_payload`). It is
        the backfill's mode: a chunk id names immutable content, and the
        point ingestion wrote carries ids (office, project, BFF document) the
        backfill cannot know and must not strip.
        """
        usable = [record for record in records if record.embedding is not None and len(record.embedding)]
        if not usable:
            return 0
        alias = self.ensure(scope, len(usable[0].embedding))
        mode = models.UpdateMode.INSERT_ONLY if insert_only else None
        for start in range(0, len(usable), UPSERT_BATCH):
            batch = usable[start : start + UPSERT_BATCH]
            points = [self._point(scope, record, enrichment) for record in batch]
            with_retry(f"upsert into {scope}", lambda: self.client.upsert(alias, points, wait=True, update_mode=mode))
            if insert_only:
                self._merge_own_payloads(alias, scope, batch)
        return len(usable)

    def _merge_own_payloads(self, alias: str, scope: str, records: Sequence[ChunkRecord]) -> None:
        operations = [
            models.SetPayloadOperation(
                set_payload=models.SetPayload(
                    payload=chunk_own_payload(scope, record), points=[point_id(record.chunk_id)]
                )
            )
            for record in records
        ]
        self._batch(alias, f"merge payloads in {scope}", operations)

    def _batch(self, alias: str, label: str, operations: Sequence[Any]) -> None:
        for start in range(0, len(operations), PAYLOAD_BATCH):
            chunk = list(operations[start : start + PAYLOAD_BATCH])
            with_retry(label, lambda: self.client.batch_update_points(alias, chunk, wait=True))

    @staticmethod
    def _point(scope: str, record: ChunkRecord, enrichment: Mapping[str, Any] | None) -> models.PointStruct:
        vector: dict[str, Any] = {DENSE: [float(value) for value in record.embedding]}
        if (record.text or "").strip():
            vector[LEXICAL] = bm25(record.text)
        return models.PointStruct(
            id=point_id(record.chunk_id), vector=vector, payload=build_payload(scope, record, enrichment)
        )

    def _delete(self, scope: str, *conditions: models.Condition) -> None:
        if not self.exists(scope):
            return
        selector = models.FilterSelector(filter=models.Filter(must=[scope_condition([scope]), *conditions]))
        with_retry(
            f"delete in {scope}", lambda: self.client.delete(self.alias(scope), points_selector=selector, wait=True)
        )

    def delete_chunks(self, scope: str, chunk_ids: Sequence[str]) -> None:
        """Delete these chunks of ``scope``, in bounded requests. Ids with no point are no error."""
        ids = list(dict.fromkeys(str(chunk_id) for chunk_id in chunk_ids if chunk_id))
        for start in range(0, len(ids), DELETE_BATCH):
            batch = ids[start : start + DELETE_BATCH]
            self._delete(scope, models.FieldCondition(key=CHUNK_ID_FIELD, match=models.MatchAny(any=batch)))

    def delete_file(self, scope: str, file_name: str, matches: Callable[[str], bool] | None = None) -> None:
        """Delete every chunk of one file in ``scope``.

        ``matches`` widens "this file" to every stored spelling it accepts
        (the adapter's rule: a ``tmp…_`` upload prefix, percent-encoding), read
        from the scope's own ``file_name`` values.
        """
        names = {file_name}
        if matches is not None:
            names.update(name for name in self.file_names(scope) if matches(name))
        self._delete(scope, models.FieldCondition(key="file_name", match=models.MatchAny(any=sorted(names))))

    def delete_scope(self, scope: str) -> None:
        """Delete every chunk of ``scope``: a collection deleted, a conversation's uploads reaped."""
        self._delete(scope)

    @staticmethod
    def _file_filter(scope: str, file_name: str) -> models.Filter:
        return models.Filter(
            must=[
                scope_condition([scope]),
                models.FieldCondition(key="file_name", match=models.MatchValue(value=file_name)),
            ]
        )

    def set_file_payloads(self, scope: str, payloads: Mapping[str, Mapping[str, Any]]) -> None:
        """Overwrite these payload fields on every chunk of each file (a person changed a fact); others are kept.

        A bounded batch per request, never one request per file.
        """
        payloads = {name: dict(values) for name, values in payloads.items() if values}
        if not payloads or not self.exists(scope):
            return
        operations = [
            models.SetPayloadOperation(
                set_payload=models.SetPayload(payload=values, filter=self._file_filter(scope, name))
            )
            for name, values in payloads.items()
        ]
        self._batch(self.alias(scope), f"set payloads in {scope}", operations)

    def restore_chunk_doc_classes(self, scope: str, file_names: Iterable[str]) -> None:
        """Put each file's own Dokumentart back on its points after a person cleared theirs.

        The stored class beats the chunk's, so the copy wrote it over the
        chunk's; with the stored class gone, the chunk's is what a reader falls
        back to (``register._hit_doc_class``) and what a ``doc_class``
        pre-filter must match. It is per file (ingestion stamps it per file),
        so one point of each file says it: one small read per file, then every
        change in bounded batches. A point written before
        :data:`payload.CHUNK_DOC_CLASS_FIELD` existed cannot say it, and is left.
        """
        names = sorted(set(file_names))
        if not names or not self.exists(scope):
            return
        alias = self.alias(scope)
        operations: list[Any] = []
        for file_name in names:
            page, _next = self.client.scroll(
                alias,
                scroll_filter=self._file_filter(scope, file_name),
                limit=1,
                with_payload=[CHUNK_DOC_CLASS_FIELD, "doc_class"],
                with_vectors=False,
            )
            payload = dict(page[0].payload or {}) if page else {}
            if CHUNK_DOC_CLASS_FIELD not in payload:
                continue
            own = payload[CHUNK_DOC_CLASS_FIELD] or None
            if own == payload.get("doc_class"):
                continue
            selector = self._file_filter(scope, file_name)
            if own:
                operations.append(
                    models.SetPayloadOperation(
                        set_payload=models.SetPayload(payload={"doc_class": own}, filter=selector)
                    )
                )
            else:
                operations.append(
                    models.DeletePayloadOperation(
                        delete_payload=models.DeletePayload(keys=["doc_class"], filter=selector)
                    )
                )
        self._batch(alias, f"restore doc_class in {scope}", operations)

    # ------------------------------------------------------------------ inventory

    def _facet_counts(self, alias: str, key: str, facet_filter: models.Filter | None) -> dict[str, int]:
        response = self.client.facet(alias, key=key, facet_filter=facet_filter, limit=FACET_LIMIT, exact=True)
        if len(response.hits) >= FACET_LIMIT:
            logger.warning("Qdrant %s: more than %d values of %s; the list is truncated", alias, FACET_LIMIT, key)
        return {str(hit.value): int(hit.count) for hit in response.hits}

    def _facet(self, alias: str, key: str, facet_filter: models.Filter | None) -> list[str]:
        return list(self._facet_counts(alias, key, facet_filter))

    def file_names(self, scope: str) -> list[str]:
        """Every ``file_name`` value the points of ``scope`` carry."""
        if not self.exists(scope):
            return []
        return self._facet(self.alias(scope), "file_name", models.Filter(must=[scope_condition([scope])]))

    def file_counts(self, scope: str) -> dict[str, int]:
        """``file_name -> chunks`` for every file with a point in ``scope``, one exact facet."""
        if not self.exists(scope):
            return {}
        return self._facet_counts(self.alias(scope), "file_name", models.Filter(must=[scope_condition([scope])]))

    def scopes(self, physical: Physical) -> list[str]:
        """Every logical scope with at least one point in ``physical``'s collection."""
        return list(self.scope_counts(physical))

    def scope_counts(self, physical: Physical) -> dict[str, int]:
        """``scope -> chunks`` for every logical scope with at least one point in ``physical``'s collection."""
        alias = ALIASES[physical]
        if not any(entry.alias_name == alias for entry in self.client.get_aliases().aliases):
            return {}
        return self._facet_counts(alias, SCOPE_FIELD, None)

    def chunk_ids(self, scope: str) -> Iterable[str]:
        """The chunk id of every point of ``scope``, read by scroll with nothing else in the payload."""
        if not self.exists(scope):
            return
        query_filter = models.Filter(must=[scope_condition([scope])])
        offset: Any = None
        while True:
            page, offset = self.client.scroll(
                self.alias(scope),
                scroll_filter=query_filter,
                limit=SCROLL_PAGE * 8,
                offset=offset,
                with_payload=[CHUNK_ID_FIELD],
                with_vectors=False,
            )
            for record in page:
                yield str((record.payload or {}).get(CHUNK_ID_FIELD) or record.id)
            if offset is None:
                return

    def missing_chunk_ids(self, scope: str, chunk_ids: Sequence[str]) -> list[str]:
        """Those of ``chunk_ids`` with no point in ``scope``."""
        if not chunk_ids:
            return []
        if not self.exists(scope):
            return list(chunk_ids)
        by_point = {point_id(chunk_id): chunk_id for chunk_id in chunk_ids}
        points = list(by_point)
        present: set[str] = set()
        for start in range(0, len(points), SCROLL_PAGE * 4):
            found = self.client.retrieve(
                self.alias(scope),
                points[start : start + SCROLL_PAGE * 4],
                with_payload=[SCOPE_FIELD],
                with_vectors=False,
            )
            present.update(str(record.id) for record in found if (record.payload or {}).get(SCOPE_FIELD) == scope)
        return [chunk_id for point, chunk_id in by_point.items() if point not in present]

    def sample_chunk_ids(self, scope: str, size: int) -> list[str]:
        """About ``size`` chunk ids of ``scope``, read from a random place in point-id order (wrapping round)."""
        if not self.exists(scope) or size <= 0:
            return []
        query_filter = models.Filter(must=[scope_condition([scope])])
        ids: dict[str, None] = {}
        for offset in (str(uuid.uuid4()), None):
            page, _next = self.client.scroll(
                self.alias(scope),
                scroll_filter=query_filter,
                limit=size - len(ids),
                offset=offset,
                with_payload=[CHUNK_ID_FIELD],
                with_vectors=False,
            )
            ids.update(dict.fromkeys(str((record.payload or {}).get(CHUNK_ID_FIELD) or record.id) for record in page))
            if len(ids) >= size:
                break
        return list(ids)

    def set_scope_payload(self, scope: str, payload: Mapping[str, Any]) -> bool:
        """Overwrite these payload fields on every point of ``scope``; False when it has no point yet.

        The project facts mirror (``PUT /v1/collections/{c}/project-facts``):
        one call per scope, whatever its size, since the filter names the
        scope rather than a list of ids. A top-level key replaces the stored
        value whole, so a nested object loses the keys it no longer has.
        """
        # ``exists`` has given an older collection the project facts indexes.
        if not payload or not self.exists(scope):
            return False
        if self.count(scope) == 0:
            return False
        selector = models.Filter(must=[scope_condition([scope])])
        with_retry(
            f"set payload on {scope}",
            lambda: self.client.set_payload(self.alias(scope), payload=dict(payload), points=selector, wait=True),
        )
        return True

    # ------------------------------------------------------------------ plain reads

    def count(self, scope: str, filters: dict[str, Any] | None = None, *extra: models.Condition) -> int:
        """Chunks of ``scope`` matching ``filters`` (exact)."""
        if not self.exists(scope):
            return 0
        result = self.client.count(self.alias(scope), count_filter=scope_filter([scope], filters, *extra), exact=True)
        return result.count

    def scroll(
        self,
        scope: str,
        filters: dict[str, Any] | None = None,
        *extra: models.Condition | models.Filter,
        limit: int | None = None,
        fields: Sequence[str] | None = None,
        page_size: int = SCROLL_PAGE,
    ) -> Iterator[models.Record]:
        """Every chunk of ``scope`` matching ``filters`` and ``extra``, in point-id order, payload only.

        ``fields`` limits the payload to those keys: a listing that needs a
        file's name and page reads no chunk text.
        """
        if not self.exists(scope):
            return
        query_filter = scope_filter([scope], filters, *extra)
        offset: Any = None
        seen = 0
        while True:
            page, offset = self.client.scroll(
                self.alias(scope),
                scroll_filter=query_filter,
                limit=page_size,
                offset=offset,
                with_payload=list(fields) if fields is not None else True,
                with_vectors=False,
            )
            for record in page:
                yield record
                seen += 1
                if limit is not None and seen >= limit:
                    return
            if offset is None:
                return

    def scroll_ordered(
        self,
        scope: str,
        filters: dict[str, Any] | None,
        order_by: str,
        limit: int,
        *,
        descending: bool = False,
        fields: Sequence[str] | None = None,
    ) -> list[models.Record]:
        """The first ``limit`` chunks of ``scope`` matching ``filters``, ordered by the integer field ``order_by``.

        Ascending unless ``descending``. Qdrant skips a point that lacks the
        field, so a caller asks this only of a set it knows carries it
        (``reads.fetch``), or one where a missing value means "unknown"
        (:meth:`newest`).
        """
        if not self.exists(scope):
            return []
        direction = models.Direction.DESC if descending else models.Direction.ASC
        page, _next = self.client.scroll(
            self.alias(scope),
            scroll_filter=scope_filter([scope], filters),
            limit=limit,
            order_by=models.OrderBy(key=order_by, direction=direction),
            with_payload=list(fields) if fields is not None else True,
            with_vectors=False,
        )
        return list(page)

    def newest(self, scope: str, field: str, *, oldest: bool = False) -> int | None:
        """The largest (``oldest``: smallest) value of the integer ``field`` in ``scope``; None if none has one."""
        page = self.scroll_ordered(scope, None, field, 1, descending=not oldest, fields=[field])
        value = (page[0].payload or {}).get(field) if page else None
        return int(value) if value is not None else None

    def has_index(self, scope: str, field: str) -> bool:
        """Whether ``scope``'s collection indexes ``field``. Only "yes" is remembered: a writer may add one later."""
        physical = physical_for_scope(scope)
        if (physical, field) in self._indexed:
            return True
        present = self.client.get_collection(ALIASES[physical]).payload_schema or {}
        self._indexed.update((physical, name) for name in present)
        return field in present

    def text_index_sound(self, scope: str) -> bool:
        """Whether ``scope``'s full-text index tokenizes as :data:`schema.TEXT_INDEX` does. Only "yes" is remembered.

        A collection built with another tokenizer is reported by
        ``ensure_payload_indexes``; a reader that narrows by tokens asks this
        first, because under ``multilingual`` a number is no token at all.
        """
        physical = physical_for_scope(scope)
        if physical in self._sound_text:
            return True
        text = (self.client.get_collection(ALIASES[physical]).payload_schema or {}).get(TEXT_FIELD)
        if text is None or text_index_drift(text.params):
            return False
        self._sound_text.add(physical)
        return True

    def health(self) -> bool:
        """True when the cluster answers."""
        try:
            self.client.get_aliases()
            return True
        except Exception:  # noqa: BLE001 - a health probe reports, it does not raise
            return False


_store: QdrantStore | None = None
_store_lock = threading.Lock()


def make_client() -> QdrantClient:
    """A client for the configured cluster. ``cloud_inference`` sends ``Document``
    inputs to the server, whose own BM25 analyses them, rather than to a local
    FastEmbed model this image does not ship."""
    return QdrantClient(
        url=qdrant_url(),
        api_key=qdrant_api_key(),
        timeout=REQUEST_TIMEOUT_SECONDS,
        cloud_inference=True,
        check_compatibility=False,
    )


def get_store(identity: Mapping[str, str] | None = None) -> QdrantStore:
    """The process-wide store. ``identity`` (the embedder's fingerprint) is
    taken from the first caller that passes one; every later caller shares it."""
    global _store
    with _store_lock:
        if _store is None:
            _store = QdrantStore(make_client(), identity)
        elif identity and not _store.identity:
            _store.identity = dict(identity)
        return _store


def reset_store() -> None:
    """Drop the process-wide store (tests, and a process that changed its config)."""
    global _store
    with _store_lock:
        _store = None


__all__ = ["QdrantStore", "bm25", "get_store", "make_client", "reset_store", "TEXT_FIELD"]

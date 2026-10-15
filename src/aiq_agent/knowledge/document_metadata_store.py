"""Per-document metadata store (SQLAlchemy).

One row per ``(collection, filename)`` holding everything the system knows about
an ingested document beyond its chunks: the one-sentence ``summary``, the
controlled ``tags``, the explicit ``doc_class`` ("Dokumentart"), the
user-facing ``display_title``, the ``folder_path`` the document is filed
under (ADR-0049), and the ``provenance`` of a document Piloti wrote and a
person released (ADR-0054). The table is named ``document_metadata`` because
it is exactly that — the summary is only one of several columns.

Historically this was the ``summaries`` table (class ``SummaryStore``). A
startup migration renames that table in place the first time the store opens
against an older database, so existing rows are preserved untouched — see
:meth:`DocumentMetadataStore._ensure_schema`.

Configurable SQLite/PostgreSQL storage, following the same pattern as EventStore
in the jobs system.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC
from datetime import date
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING
from typing import Any
from zoneinfo import ZoneInfo

from aiq_agent.common.db_utils import ensure_schema
from aiq_agent.common.db_utils import lock_schema
from aiq_agent.common.db_utils import normalize_db_url as _normalize_db_url
from aiq_agent.common.db_utils import present_columns
from aiq_agent.common.db_utils import present_indexes
from aiq_agent.common.db_utils import redact_db_url
from aiq_agent.knowledge.document_classification import MAX_TOPIC_VOCABULARY
from aiq_agent.knowledge.title_block import normalise_revision_facts

if TYPE_CHECKING:
    from .schema import AvailableDocument

logger = logging.getLogger(__name__)

#: The clock an upload date is read on. The product serves Austrian offices;
#: a second country reads it from its profile when one arrives.
_OFFICE_TIMEZONE = ZoneInfo("Europe/Vienna")

ENGINE_CACHE_TTL_SECONDS = 3600
ENGINE_CACHE_MAX_SIZE = 10

#: Current table name. The store renames the legacy ``summaries`` table to this
#: on first open (see :meth:`DocumentMetadataStore._ensure_schema`).
TABLE_NAME = "document_metadata"
#: The pre-rename table name, migrated in place when found.
LEGACY_TABLE_NAME = "summaries"
_INDEX_NAME = "idx_document_metadata_collection"
_LEGACY_INDEX_NAME = "idx_summaries_collection"

#: Optional (nullable) columns added after the original schema shipped. Kept as a
#: single list so both the fresh-create path and the in-place backfill add the
#: exact same set — a new column is introduced by appending one entry here.
_OPTIONAL_COLUMNS: tuple[str, ...] = (
    "tags",
    "doc_class",
    "display_title",
    "folder_path",
    "provenance",
    "doc_class_suggestion",
    "tags_set_by",
    "topics",
    "capture",
    "superseded_by",
    "revision_suggestion",
    "change_summary",
    "change_basis",
    "revision_facts",
)

#: ``tags_set_by`` value for tags a PERSON chose. Machine writes (ingest, the
#: backfill script) never overwrite them — see :meth:`DocumentMetadataStore.register`.
#: Topics ride on the same marker: a person's curation covers both columns.
TAGS_SET_BY_PERSON = "person"

#: What a ``revision_suggestion`` may say its confidence rests on: the title block
#: (the same ``document_number`` on two documents), the file names (the series grammar
#: of ``revision_series.py``) or the model's reading of the content. Anything else is not stored.
SUGGESTION_BASES = ("title_block", "name", "content")

#: The columns :meth:`DocumentMetadataStore.get_all` reads, in the order
#: :meth:`DocumentMetadataStore._row_to_document` expects them.
_DOCUMENT_COLUMNS = (
    "filename, summary, tags, doc_class, display_title, folder_path, created_at, "
    "topics, capture, superseded_by, revision_suggestion, change_summary, change_basis, revision_facts"
)

#: Where the Fassung facts a person made outlive a purge that can be undone (an archive, the folder
#: bin, a publish that re-reads a document). One row per ``(collection, filename)`` whose metadata row
#: went; the next :meth:`DocumentMetadataStore.register` of that name takes them back and deletes it.
RETAINED_TABLE_NAME = "document_fassung_retained"

#: What :data:`RETAINED_TABLE_NAME` keeps: the link a person confirmed, the suggestions a person
#: refused, and the change line told against a linked Fassung (its basis is another file).
_RETAINED_COLUMNS = ("superseded_by", "revision_suggestion", "change_summary", "change_basis")

#: The reason a refusal is stored with when nothing else was suggested: the record keeps its shape.
REFUSAL_REASON = "Von einer Person abgelehnt."


class LinkOutcome(StrEnum):
    """What :meth:`DocumentMetadataStore.link_fassung` did."""

    LINKED = "linked"
    #: ``newer`` already leads to ``older`` through replacements; nothing was written.
    LOOP = "loop"
    #: ``older`` has no metadata row in the collection; nothing was written.
    MISSING = "missing"


def dismissed_fassungen(suggestion: Any) -> list[str]:
    """The file names a person refused as the older Fassung of a document, oldest refusal first.

    Reads the stored record in both shapes: the current one carries ``dismissed_of``; a record
    written before that carries one ``of`` with ``dismissed: true``. Anything else refuses nothing.
    """
    if not isinstance(suggestion, dict):
        return []
    names = [name for name in suggestion.get("dismissed_of") or () if isinstance(name, str) and name.strip()]
    older = suggestion.get("of")
    if suggestion.get("dismissed") is True and isinstance(older, str) and older.strip() and older not in names:
        names.append(older)
    return list(dict.fromkeys(names))


def _link_lock_key(collection: str) -> int:
    """The signed 64-bit advisory-lock key that serialises link writes within one collection (Postgres)."""
    digest = hashlib.sha256(f"grid-fassung-link:{collection}".encode()).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


@dataclass(frozen=True, slots=True)
class _LinkRow:
    """What :meth:`DocumentMetadataStore.link_fassung` reads of each row of the collection."""

    superseded_by: str | None
    change_basis: str | None
    revision_suggestion: str | None


def _set_columns(conn, collection: str, filename: str, **values: Any) -> None:
    """UPDATE the named Fassung columns of one row on the caller's connection."""
    from sqlalchemy import text

    unknown = set(values) - set(_RETAINED_COLUMNS)
    if unknown:
        raise ValueError(f"not a Fassung column: {sorted(unknown)}")
    assignments = ", ".join(f"{column} = :{column}" for column in values)
    conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(f"UPDATE {TABLE_NAME} SET {assignments} WHERE collection = :collection AND filename = :filename"),
        {**values, "collection": collection, "filename": filename},
    )


def _refusal_record(refused: list[str]) -> dict[str, Any] | None:
    """The stored record when a person refused files and nothing is suggested: the latest refusal as its ``of``."""
    if not refused:
        return None
    return {
        "of": refused[-1],
        "confidence": 0.0,
        "reason": REFUSAL_REASON,
        "basis": "name",
        "dismissed": True,
        "dismissed_of": refused,
    }


def _merged_suggestion(stored: dict[str, Any] | None, new: dict[str, Any] | None) -> dict[str, Any] | None:
    """``new`` as it is stored over ``stored``: the refusals of both kept, and dismissed when it names one of them.

    ``new`` of ``None`` clears the open suggestion; what is left is the refusals, or nothing.
    """
    refused = list(dict.fromkeys(dismissed_fassungen(stored) + dismissed_fassungen(new)))
    if new is None:
        return _refusal_record(refused)
    return {**new, "dismissed": new["of"] in refused, "dismissed_of": refused}


def _with_refusal(stored: dict[str, Any] | None, older: str) -> dict[str, Any]:
    """``stored`` with ``older`` refused: the open suggestion dismissed when it names ``older``, else kept open."""
    refused = [name for name in dismissed_fassungen(stored) if name != older] + [older]
    if stored is None or stored["of"] == older or stored["dismissed"]:
        return {**(stored or {}), **_refusal_record(refused), **_kept_reason(stored, older)}
    return {**stored, "dismissed_of": refused}


def _person_made_facts(
    filename: str,
    superseded_by: str | None,
    revision_suggestion: str | None,
    change_summary: str | None,
    change_basis: str | None,
) -> dict[str, str | None] | None:
    """What a reversible purge keeps of a row: the confirmed link, the refusals, a change line against a link.

    An open suggestion is Piloti's advice and is read again; a change line told against the
    document's own earlier upload (``change_basis`` is its own name) describes bytes the re-read
    replaces. ``None`` when nothing a person made is on the row.
    """
    refusals = _merged_suggestion(DocumentMetadataStore._decode_suggestion(revision_suggestion), None)
    linked_change = bool(change_summary) and bool(change_basis) and change_basis != filename
    kept = {
        "superseded_by": superseded_by or None,
        "revision_suggestion": json.dumps(refusals) if refusals else None,
        "change_summary": change_summary if linked_change else None,
        "change_basis": change_basis if linked_change else None,
    }
    return kept if any(kept.values()) else None


def _kept_reason(stored: dict[str, Any] | None, older: str) -> dict[str, Any]:
    """The suggestion's own reason, confidence and basis when the refusal is of the file it named."""
    if stored is None or stored["of"] != older:
        return {}
    return {key: stored[key] for key in ("confidence", "reason", "basis")}


# Every raw-SQL statement in this module interpolates ONLY trusted, code-defined
# SQL identifiers: the table/index name constants above, and column names drawn
# from a fixed allowlist (``_OPTIONAL_COLUMNS`` plus the literal
# ``"tags"``/``"doc_class"``/``"display_title"``/``"folder_path"``/``"provenance"``/
# ``"doc_class_suggestion"``/``"topics"``/``"capture"``/``"superseded_by"``/
# ``"revision_suggestion"``/``"revision_facts"`` passed by the typed accessors).
# SQL identifiers cannot be bound parameters, so they must live in the statement
# text. Every caller-supplied *value* (collection, filename, summary, tags,
# display_title, …) is always passed as a bound ``:param`` and never interpolated.
# The interpolation is therefore not attacker-reachable, which is why each
# ``sqlalchemy.text()`` call below carries a ``# nosemgrep: …avoid-sqlalchemy-text``
# marker for the taint-based SAST rule.


def _escape_like(value: str) -> str:
    """Escape SQL ``LIKE`` metacharacters so a path matches only itself.

    The TS twin is ``escapeLikePattern`` in ``folder-service.ts``; both exist so
    a folder called ``100 % Plans`` cannot prefix-match half the project.
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class DocumentMetadataStore:
    """SQLAlchemy-based store for per-document metadata.

    Features:
    - Automatic SQLite/PostgreSQL support based on db_url
    - Connection pooling with TTL-based cache management
    - Both sync and async operations supported
    - In-place migration of the legacy ``summaries`` table + added columns
    """

    _async_engine_cache: dict[str, tuple[Any, float]] = {}
    _sync_engine_cache: dict[str, tuple[Any, float]] = {}
    _cache_lock = threading.Lock()
    _tables_initialized: set[str] = set()
    #: Serialises :meth:`link_fassung` on SQLite, which has no advisory lock (dev and tests run one process).
    _link_lock = threading.Lock()

    def __init__(self, db_url: str):
        self.db_url = db_url
        self._sync_engine = self._get_or_create_sync_engine(db_url)
        self._ensure_table_sync()
        logger.info("DocumentMetadataStore initialized: %s", redact_db_url(db_url))

    @classmethod
    def _get_or_create_sync_engine(cls, db_url: str):
        """Get or create a sync SQLAlchemy engine with TTL-based caching."""
        with cls._cache_lock:
            cls._cleanup_stale_engines(cls._sync_engine_cache)

            if db_url in cls._sync_engine_cache:
                engine, _ = cls._sync_engine_cache[db_url]
                cls._sync_engine_cache[db_url] = (engine, time.monotonic())
                return engine

            from sqlalchemy import create_engine

            normalized_url = _normalize_db_url(db_url, async_mode=False)
            is_sqlite = normalized_url.startswith("sqlite")
            connect_args = {"check_same_thread": False, "timeout": 30} if is_sqlite else {}

            engine = create_engine(
                normalized_url,
                pool_pre_ping=True,
                pool_size=1 if is_sqlite else 5,
                max_overflow=0 if is_sqlite else 10,
                connect_args=connect_args,
            )
            cls._sync_engine_cache[db_url] = (engine, time.monotonic())
            logger.debug("Created sync engine for %s", redact_db_url(db_url))
            return engine

    @classmethod
    def _get_or_create_async_engine(cls, db_url: str):
        """Get or create an async SQLAlchemy engine with TTL-based caching."""
        with cls._cache_lock:
            cls._cleanup_stale_engines(cls._async_engine_cache)

            if db_url in cls._async_engine_cache:
                engine, _ = cls._async_engine_cache[db_url]
                cls._async_engine_cache[db_url] = (engine, time.monotonic())
                return engine

            from sqlalchemy.ext.asyncio import create_async_engine

            normalized_url = _normalize_db_url(db_url, async_mode=True)
            is_sqlite = normalized_url.startswith("sqlite")

            engine = create_async_engine(
                normalized_url,
                pool_pre_ping=True,
                pool_size=1 if is_sqlite else 5,
                max_overflow=0 if is_sqlite else 10,
            )
            cls._async_engine_cache[db_url] = (engine, time.monotonic())
            logger.debug("Created async engine for %s", redact_db_url(db_url))
            return engine

    @classmethod
    def _cleanup_stale_engines(cls, cache: dict[str, tuple[Any, float]]):
        """Remove engines that haven't been used recently."""
        now = time.monotonic()
        stale_keys = [key for key, (_, last_used) in cache.items() if now - last_used > ENGINE_CACHE_TTL_SECONDS]
        for key in stale_keys:
            engine, _ = cache.pop(key, (None, 0))
            if engine:
                try:
                    engine.dispose()
                    logger.debug("Disposed stale engine for %s", redact_db_url(key))
                except Exception as e:
                    logger.warning("Failed to dispose engine: %s", e)

        if len(cache) > ENGINE_CACHE_MAX_SIZE:
            sorted_entries = sorted(cache.items(), key=lambda x: x[1][1])
            for key, (engine, _) in sorted_entries[: len(sorted_entries) - ENGINE_CACHE_MAX_SIZE]:
                cache.pop(key, None)
                if engine:
                    try:
                        engine.dispose()
                    except (RuntimeError, OSError):
                        pass

    # ------------------------------------------------------------------
    # Schema management (create fresh · rename legacy · backfill columns)
    # ------------------------------------------------------------------

    def _is_postgres(self) -> bool:
        return self.db_url.startswith("postgres")

    def _ensure_table_sync(self):
        """Create/migrate the ``document_metadata`` table if needed (sync)."""
        with DocumentMetadataStore._cache_lock:
            if self.db_url in DocumentMetadataStore._tables_initialized:
                return

            # Only mark the store initialized when the schema is actually ready.
            # A failed migration must NOT be cached as initialized, so the next
            # call retries it instead of writing against a missing column.
            try:
                ensure_schema(self._sync_engine, TABLE_NAME, self._run_schema)
            except Exception as e:
                logger.warning("Failed to ensure document_metadata schema (sync): %s", e)
                return
            DocumentMetadataStore._tables_initialized.add(self.db_url)

    @classmethod
    async def _ensure_table_async(cls, db_url: str):
        """Ensure the ``document_metadata`` table exists/migrated (async)."""
        if db_url in cls._tables_initialized:
            return

        engine = cls._get_or_create_async_engine(db_url)
        # A detached instance carries db_url so the shared schema helpers can read
        # `_is_postgres()`; they never touch the (async) engine.
        store = cls.__new__(cls)
        store.db_url = db_url

        try:
            async with engine.begin() as conn:
                await conn.run_sync(lock_schema, TABLE_NAME)
                await conn.run_sync(store._run_schema)
        except Exception as e:
            logger.warning("Failed to ensure document_metadata schema (async): %s", e)
            return
        cls._tables_initialized.add(db_url)
        logger.info("Created/migrated document_metadata table (async) in %s", redact_db_url(db_url))

    def _run_schema(self, conn) -> None:
        """Create fresh, rename the legacy table, then backfill missing columns.

        Runs over a live sync connection (the caller owns the transaction/commit,
        and has taken the schema lock: the processes of a boot all reach this at once).
        """
        from sqlalchemy import inspect
        from sqlalchemy import text

        inspector = inspect(conn)
        has_current = inspector.has_table(TABLE_NAME)
        has_legacy = inspector.has_table(LEGACY_TABLE_NAME)

        if not has_current and has_legacy:
            # Preserve every existing row: rename the table in place rather
            # than recreating it. Postgres and SQLite both support this.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            conn.execute(text(f"ALTER TABLE {LEGACY_TABLE_NAME} RENAME TO {TABLE_NAME}"))
            logger.info("Migrated legacy '%s' table to '%s' (rows preserved)", LEGACY_TABLE_NAME, TABLE_NAME)
        elif not has_current:
            self._create_table(conn)

        # Backfill any optional column that predates the current schema
        # (covers a just-renamed legacy table and older document_metadata ones).
        # Only the MISSING ones: ``ADD COLUMN IF NOT EXISTS`` locks the table
        # exclusively before it checks, so running it for every column on every
        # start blocked all readers, and behind one stuck reader it hung the API's
        # start (see ``present_columns``). On a current table this issues no DDL.
        present = present_columns(conn, TABLE_NAME)
        for column in _OPTIONAL_COLUMNS:
            if column not in present:
                self._add_column_if_missing(conn, column)

        self._ensure_index(conn)
        self._create_retained_table(conn)

    def _create_retained_table(self, conn) -> None:
        """Create :data:`RETAINED_TABLE_NAME` if it is missing: the Fassung facts a reversible purge keeps."""
        from sqlalchemy import text

        conn.execute(
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"CREATE TABLE IF NOT EXISTS {RETAINED_TABLE_NAME} ("
                "collection VARCHAR(256) NOT NULL, "
                "filename VARCHAR(512) NOT NULL, "
                "superseded_by TEXT, "
                "revision_suggestion TEXT, "
                "change_summary TEXT, "
                "change_basis TEXT, "
                "PRIMARY KEY (collection, filename))"
            )
        )

    def _create_table(self, conn) -> None:
        from sqlalchemy import text

        conn.execute(
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"CREATE TABLE {TABLE_NAME} ("
                "collection VARCHAR(256) NOT NULL, "
                "filename VARCHAR(512) NOT NULL, "
                "summary TEXT NOT NULL, "
                "tags TEXT, "
                "doc_class TEXT, "
                "display_title TEXT, "
                "folder_path TEXT, "
                "provenance TEXT, "
                "created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, "
                "PRIMARY KEY (collection, filename))"
            )
        )
        logger.info("Created document_metadata table in %s", redact_db_url(self.db_url))

    def _add_column_if_missing(self, conn, column: str, ddl_type: str = "TEXT") -> None:
        """Add a nullable column to ``document_metadata`` if it is not present.

        Postgres supports ``ADD COLUMN IF NOT EXISTS``; SQLite does not, so the
        column is added only after a ``PRAGMA table_info`` existence check.
        """
        from sqlalchemy import text

        if self._is_postgres():
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            conn.execute(text(f"ALTER TABLE {TABLE_NAME} ADD COLUMN IF NOT EXISTS {column} {ddl_type}"))
            return
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({TABLE_NAME})")).fetchall()}
        if column not in existing:
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            conn.execute(text(f"ALTER TABLE {TABLE_NAME} ADD COLUMN {column} {ddl_type}"))

    def _ensure_index(self, conn) -> None:
        """Create the collection index under the new name; drop the legacy one."""
        from sqlalchemy import text

        # Checked first: ``CREATE INDEX IF NOT EXISTS`` takes the table's SHARE lock
        # before it looks at the name (see ``present_indexes``).
        if _INDEX_NAME not in present_indexes(conn, TABLE_NAME):
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            conn.execute(text(f"CREATE INDEX IF NOT EXISTS {_INDEX_NAME} ON {TABLE_NAME} (collection)"))
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        conn.execute(text(f"DROP INDEX IF EXISTS {_LEGACY_INDEX_NAME}"))

    def register(
        self,
        collection: str,
        filename: str,
        summary: str,
        tags: list[str] | None = None,
        topics: list[str] | None = None,
    ) -> None:
        """Store a document summary, its controlled tags and its open topics (sync).

        Owns the ``summary`` and ``tags`` columns and NOTHING ELSE. The other
        columns on the row — ``doc_class``, ``display_title``, ``folder_path`` —
        are set by people (a reclassification, a rename, a folder move) or by the
        BFF, and re-summarising a document must not undo any of them.

        That is why both engines run the same ``ON CONFLICT … DO UPDATE`` and the
        SQLite branch no longer uses ``INSERT OR REPLACE``: replace is a DELETE
        plus an INSERT, so every column absent from the statement came back NULL.
        A re-ingest silently un-renamed and un-filed the document, and the only
        symptom was the agent describing a folder structure the user no longer
        had. ``excluded`` is spelled the same in SQLite and Postgres.

        Tags a PERSON set (``tags_set_by = 'person'``) are kept as they are: the
        classifier's fresh output replaces only its own earlier guess. Without
        this, „Erneut lesen" silently threw away every correction anybody had
        made, because the re-read re-classifies and this upsert wrote the result
        over whatever was there.

        Topics follow the same rule, on the same marker: a person's curation
        covers ``tags`` AND ``topics``. So a person who edited only the topics
        also freezes the tags (and the reverse), because the row carries one
        ``tags_set_by`` flag. That is deliberate: one "a person touched this
        row" answer, not two that a re-read could disagree with.
        """
        import json

        from sqlalchemy import text

        tags_json = json.dumps(tags) if tags else None
        topics_json = json.dumps(topics) if topics else None

        try:
            with self._sync_engine.connect() as conn:
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"INSERT INTO {TABLE_NAME} (collection, filename, summary, tags, topics) "
                        "VALUES (:collection, :filename, :summary, :tags, :topics) "
                        "ON CONFLICT (collection, filename) DO UPDATE SET "
                        "summary = excluded.summary, "
                        f"tags = CASE WHEN {TABLE_NAME}.tags_set_by = :person "
                        f"THEN {TABLE_NAME}.tags ELSE excluded.tags END, "
                        f"topics = CASE WHEN {TABLE_NAME}.tags_set_by = :person "
                        f"THEN {TABLE_NAME}.topics ELSE excluded.topics END"
                    ),
                    {
                        "collection": collection,
                        "filename": filename,
                        "summary": summary,
                        "tags": tags_json,
                        "topics": topics_json,
                        "person": TAGS_SET_BY_PERSON,
                    },
                )
                self._take_back_retained(conn, collection, filename)
                conn.commit()
                logger.debug("Registered metadata for %s in %s", filename, collection)
        except Exception as e:
            logger.warning("Failed to register metadata for %s: %s", filename, e)

    def _take_back_retained(self, conn, collection: str, filename: str) -> None:
        """Put the Fassung facts a reversible purge kept back onto the row, in the caller's transaction.

        A column the row already fills wins: a fact written since is newer than the one kept. The kept
        entry goes either way, so it is taken back exactly once.
        """
        from sqlalchemy import text

        params = {"collection": collection, "filename": filename}
        kept = conn.execute(
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"SELECT {', '.join(_RETAINED_COLUMNS)} FROM {RETAINED_TABLE_NAME} "
                "WHERE collection = :collection AND filename = :filename"
            ),
            params,
        ).first()
        if kept is None:
            return
        kept = dict(zip(_RETAINED_COLUMNS, kept, strict=True))
        if kept["superseded_by"] and self._closes_a_loop(conn, collection, filename, kept["superseded_by"]):
            # Linked meanwhile the other way round (X over this file while it was gone): that link stands.
            kept["superseded_by"] = None
        conn.execute(
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"UPDATE {TABLE_NAME} SET "
                "superseded_by = COALESCE(superseded_by, :superseded_by), "
                "revision_suggestion = COALESCE(revision_suggestion, :revision_suggestion), "
                "change_basis = CASE WHEN change_summary IS NULL THEN :change_basis ELSE change_basis END, "
                "change_summary = COALESCE(change_summary, :change_summary) "
                "WHERE collection = :collection AND filename = :filename"
            ),
            {**params, **kept},
        )
        self._forget_retained(conn, collection, filename)
        logger.info("Took back the Fassung facts kept for %s in %s", filename, collection)

    @staticmethod
    def _closes_a_loop(conn, collection: str, older: str, newer: str) -> bool:
        """Whether ``older -> newer`` would close a loop over the links the collection's rows hold now."""
        from sqlalchemy import text

        from .document_revisions import would_loop

        rows = {
            row[0]: _LinkRow(row[1], None, None)
            for row in conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT filename, superseded_by FROM {TABLE_NAME} WHERE collection = :collection"),
                {"collection": collection},
            )
        }
        return would_loop(rows, newer=newer, older=older)

    @staticmethod
    def _forget_retained(conn, collection: str, filename: str) -> None:
        from sqlalchemy import text

        conn.execute(
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(f"DELETE FROM {RETAINED_TABLE_NAME} WHERE collection = :collection AND filename = :filename"),
            {"collection": collection, "filename": filename},
        )

    def update_tags(self, collection: str, filename: str, tags: list[str] | None) -> bool:
        """Replace the machine's ``tags`` on an existing metadata row (sync).

        The one-sentence ``summary`` is NEVER touched — this is the backfill
        seam, distinct from :meth:`register` (which owns the summary). An empty
        or ``None`` ``tags`` clears the column (stored as SQL NULL, which decodes
        back to ``None``).

        A row whose tags a person chose is left alone, like :meth:`register`
        leaves it: a machine write never overrules a person's. A person's own
        edit goes through :meth:`set_tags_by_person`.

        Returns ``True`` when a row was updated, ``False`` when no metadata row
        exists for ``(collection, filename)`` or its tags are a person's.
        """
        import json

        from sqlalchemy import text

        tags_json = json.dumps(tags) if tags else None
        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"UPDATE {TABLE_NAME} SET tags = :tags "
                        "WHERE collection = :collection AND filename = :filename "
                        "AND (tags_set_by IS NULL OR tags_set_by <> :person)"
                    ),
                    {"tags": tags_json, "collection": collection, "filename": filename, "person": TAGS_SET_BY_PERSON},
                )
                conn.commit()
                return (result.rowcount or 0) > 0
        except Exception as e:
            logger.warning("Failed to update tags for %s: %s", filename, e)
            return False

    def set_tags_by_person(self, collection: str, filename: str, tags: list[str] | None) -> bool:
        """Store the tags a PERSON chose, and mark them as theirs (sync).

        From then on neither a re-ingest (:meth:`register`) nor the backfill
        (:meth:`update_tags`) replaces them. An empty list is a choice too — "no
        tags" — and is kept the same way. ``False`` when no row exists.
        """
        return self._set_person_list(collection, filename, "tags", tags)

    def set_topics_by_person(self, collection: str, filename: str, topics: list[str] | None) -> bool:
        """Store the topics a PERSON chose, and mark the row as theirs (sync).

        The topic twin of :meth:`set_tags_by_person`, on the same marker, so a
        re-ingest keeps them (see :meth:`register`). ``False`` when no row exists.
        """
        return self._set_person_list(collection, filename, "topics", topics)

    def get_person_tags_batch(self, collection: str, filenames: list[str]) -> dict[str, list[str]]:
        """The tags a PERSON chose, for the rows among ``filenames`` that have them.

        A row whose person cleared every tag answers ``[]`` — still a choice, and
        distinct from a row that is absent (the machine's tags, or no row).
        Fail-open to ``{}``.
        """
        return self._person_list_batch(collection, filenames, "tags")

    def get_person_topics_batch(self, collection: str, filenames: list[str]) -> dict[str, list[str]]:
        """The topics a PERSON chose, with the same answer shape as :meth:`get_person_tags_batch`."""
        return self._person_list_batch(collection, filenames, "topics")

    def get_topic_vocabulary(self, collection: str, limit: int = MAX_TOPIC_VOCABULARY) -> list[str]:
        """The topics this collection already uses, most frequent first (sync).

        What ingestion offers the model to reuse, so one office's "Attika" stays
        "Attika". A topic counts once per document, whatever its case; the
        spelling kept is the most frequent one, and ties sort alphabetically.
        Fail-open to ``[]``.
        """
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                rows = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"SELECT topics FROM {TABLE_NAME} WHERE collection = :collection AND topics IS NOT NULL"),
                    {"collection": collection},
                )
                documents = [self._decode_tags(row[0]) or [] for row in rows]
        except Exception as e:
            logger.warning("Failed to read topic vocabulary for %s: %s", collection, e)
            return []

        from collections import Counter
        from collections import defaultdict

        documents_per_topic: Counter[str] = Counter()
        spellings: defaultdict[str, Counter[str]] = defaultdict(Counter)
        for topics in documents:
            first_spelling: dict[str, str] = {}
            for topic in topics:
                first_spelling.setdefault(topic.casefold(), topic)
            for key, spelling in first_spelling.items():
                documents_per_topic[key] += 1
                spellings[key][spelling] += 1

        ranked = sorted(documents_per_topic, key=lambda key: (-documents_per_topic[key], key))
        return [spellings[key].most_common(1)[0][0] for key in ranked[:limit]]

    def _set_person_list(self, collection: str, filename: str, column: str, values: list[str] | None) -> bool:
        """Store a JSON list a PERSON chose in ``column`` and mark the row ``tags_set_by = 'person'``."""
        import json

        from sqlalchemy import text

        value_json = json.dumps(values) if values else None
        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"UPDATE {TABLE_NAME} SET {column} = :value, tags_set_by = :person "
                        "WHERE collection = :collection AND filename = :filename"
                    ),
                    {
                        "value": value_json,
                        "collection": collection,
                        "filename": filename,
                        "person": TAGS_SET_BY_PERSON,
                    },
                )
                conn.commit()
                return (result.rowcount or 0) > 0
        except Exception as e:
            logger.warning("Failed to set %s for %s: %s", column, filename, e)
            return False

    def _person_list_batch(self, collection: str, filenames: list[str], column: str) -> dict[str, list[str]]:
        """The JSON list in ``column`` for the rows among ``filenames`` a PERSON set. Fail-open to ``{}``."""
        if not filenames:
            return {}
        from sqlalchemy import bindparam
        from sqlalchemy import text

        result: dict[str, list[str]] = {}
        try:
            with self._sync_engine.connect() as conn:
                rows = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT filename, {column} FROM {TABLE_NAME} "
                        "WHERE collection = :collection AND filename IN :filenames AND tags_set_by = :person"
                    ).bindparams(bindparam("filenames", expanding=True)),
                    {"collection": collection, "filenames": list(filenames), "person": TAGS_SET_BY_PERSON},
                )
                for row in rows:
                    result[row[0]] = self._decode_tags(row[1]) or []
        except Exception as e:
            logger.warning("Failed to batch-get person %s for %s: %s", column, collection, e)
            return {}
        return result

    def set_doc_class(self, collection: str, filename: str, doc_class: str | None) -> bool:
        """Replace only the ``doc_class`` of an existing metadata row (sync).

        The explicit "Dokumentart" seam, distinct from :meth:`register` (which
        owns the summary) and :meth:`update_tags` (which owns the tags). Follows
        the same UPDATE-only contract as :meth:`update_tags`: returns ``True``
        when a row existed and was updated, ``False`` when no metadata row exists
        for ``(collection, filename)`` — so ingestion/edit callers never create a
        summary-less, NOT NULL-violating row. A ``None`` value clears the column.
        """
        return self._update_column(collection, filename, "doc_class", doc_class)

    def get_doc_class(self, collection: str, filename: str) -> str | None:
        """Return the stored explicit ``doc_class`` for a document, or ``None`` (sync).

        ``None`` covers both "no metadata row" and "row present but doc_class not
        set" — callers treat both as "no explicit class yet" and fall back to the
        filename guess.
        """
        return self._get_column(collection, filename, "doc_class")

    def get_doc_classes_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        """Return stored explicit ``doc_class`` values for many documents in one query."""
        return self._get_column_batch(collection, filenames, "doc_class")

    def set_doc_class_suggestion(self, collection: str, filename: str, doc_class: str | None) -> bool:
        """Store (or clear, with ``None``) the decided Dokumentart a human has not confirmed.

        A suggestion, never the class: nothing reads it but the base-knowledge
        page, which offers it to the platform owner. Same UPDATE-only contract
        as :meth:`set_doc_class`.
        """
        return self._update_column(collection, filename, "doc_class_suggestion", doc_class)

    def get_doc_class_suggestions_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        """Stored Dokumentart suggestions for many documents in one query."""
        return self._get_column_batch(collection, filenames, "doc_class_suggestion")

    def set_display_title(self, collection: str, filename: str, display_title: str | None) -> bool:
        """Replace only the ``display_title`` of an existing metadata row (sync).

        The user-facing document name shown on citation chips and in the base
        corpus admin UI. Same UPDATE-only contract as :meth:`set_doc_class`:
        returns ``False`` when no metadata row exists (callers 404). A ``None``
        value clears the override so the derived default applies again.
        """
        return self._update_column(collection, filename, "display_title", display_title)

    def get_display_title(self, collection: str, filename: str) -> str | None:
        """Return the stored ``display_title`` for a document, or ``None`` (sync).

        ``None`` covers both "no metadata row" and "row present but no title set";
        callers fall back to the derived default (``guess_display_title``).
        """
        return self._get_column(collection, filename, "display_title")

    def get_display_titles_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        """Return stored ``display_title`` values for many documents in one query."""
        return self._get_column_batch(collection, filenames, "display_title")

    def set_folder_path(self, collection: str, filename: str, folder_path: str | None) -> bool:
        """Replace only the ``folder_path`` of an existing metadata row (sync).

        The materialised folder path the document is filed under
        (``Brandschutz/Fluchtwege``), denormalised from the BFF's
        ``project_folders.path`` — ADR-0049. Same UPDATE-only contract as
        :meth:`set_display_title`: returns ``False`` when no metadata row exists
        (callers 404 / skip). ``None`` clears it, which is what "filed at the
        project root" means.
        """
        return self._update_column(collection, filename, "folder_path", folder_path)

    def get_folder_path(self, collection: str, filename: str) -> str | None:
        """Return the stored ``folder_path`` for a document, or ``None`` (sync).

        ``None`` covers both "no metadata row" and "row present but filed at the
        project root" — callers treat both as "no folder".
        """
        return self._get_column(collection, filename, "folder_path")

    def get_folder_paths_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        """Return stored ``folder_path`` values for many documents in one query."""
        return self._get_column_batch(collection, filenames, "folder_path")

    def set_provenance(self, collection: str, filename: str, provenance: dict[str, str] | None) -> bool:
        """Replace only the ``provenance`` of an existing metadata row (sync).

        Who wrote the document and who released it (ADR-0054), stored as the
        same JSON object the chunks carry as four separate keys — one nullable
        column rather than four because nothing queries the parts, every reader
        wants the whole record, and a column per key would make the fifth key
        this record ever grows a migration instead of an edit to
        ``aiq_agent.common.provenance``.

        Same UPDATE-only contract as :meth:`set_folder_path`: returns ``False``
        when no metadata row exists, so an ingest that produced no summary never
        creates a summary-less, NOT NULL-violating row. ``None`` or an empty
        mapping clears the column, which is what "a human wrote this" means.
        """
        import json

        return self._update_column(collection, filename, "provenance", json.dumps(provenance) if provenance else None)

    def get_provenance(self, collection: str, filename: str) -> dict[str, str] | None:
        """Return the stored provenance for a document, or ``None`` (sync).

        ``None`` covers "no metadata row", "row present but unmarked" and
        "stored value is not a JSON object" — every one of which means the same
        thing to a caller, and none of which is worth raising over: a document
        whose provenance cannot be read is a document with no provenance, which
        is what an unmarked human document already is.
        """
        import json

        raw = self._get_column(collection, filename, "provenance")
        if not raw:
            return None
        try:
            decoded = json.loads(raw)
        except (TypeError, ValueError):
            logger.warning("Ignoring unreadable provenance for %s in %s", filename, collection)
            return None
        return decoded if isinstance(decoded, dict) else None

    def set_capture(self, collection: str, filename: str, capture: dict[str, Any] | None) -> bool:
        """Replace only the ``capture`` facts of an existing metadata row (sync).

        What the camera wrote into a photo (:class:`PhotoFacts`, as its
        ``as_metadata()``): ``captured_at``, ``latitude``, ``longitude``,
        ``camera``. The coordinates are stored and read back for the BFF; they
        are never rendered into anything a model reads, which is the readers'
        rule, not this store's. Same UPDATE-only contract as
        :meth:`set_provenance`. ``None`` or an empty mapping clears the column.
        """
        import json

        return self._update_column(collection, filename, "capture", json.dumps(capture) if capture else None)

    def set_revision_facts(self, collection: str, filename: str, facts: dict[str, Any] | None) -> bool:
        """Replace only the ``revision_facts`` of an existing metadata row (sync): the title block that was read.

        ``document_number``, ``revision`` (the Index as printed), ``revision_date``
        (ISO), ``scale``, ``title`` and the ``page`` they were read on, present
        keys only (:func:`~aiq_agent.knowledge.title_block.normalise_revision_facts`).
        A mapping with nothing printed in it clears the column, which is what a
        re-upload without a title block means: the old sheet's number must not
        outlive the sheet. Same UPDATE-only contract as :meth:`set_capture`.
        """
        import json

        normalised = normalise_revision_facts(facts)
        return self._update_column(
            collection, filename, "revision_facts", json.dumps(normalised, ensure_ascii=False) if normalised else None
        )

    def set_superseded_by(self, collection: str, older: str, newer: str | None) -> bool:
        """Record that a PERSON confirmed ``newer`` replaces ``older`` (sync), or lift it with ``None``.

        The link lives on the OLDER document's row, as the file name of the newer
        one in the same collection. Only a person's confirmation writes it;
        ingestion and models suggest through :meth:`set_revision_suggestion` and
        never here. A re-ingest of either file keeps it: :meth:`register` writes
        only the summary, tags and topics. Same UPDATE-only contract as
        :meth:`set_doc_class`.

        Without a loop check, so it is for lifting a link (``None``) and for
        carrying one that already exists onto another spelling. A NEW link goes
        through :meth:`link_fassung`, which refuses a loop in the same transaction.
        """
        return self._update_column(collection, older, "superseded_by", newer or None)

    def set_revision_suggestion(self, collection: str, filename: str, suggestion: dict[str, Any] | None) -> bool:
        """Store (or clear, with ``None``) Piloti's suggestion that ``filename`` is a newer Fassung of another.

        A suggestion, never a link: nothing hides or re-ranks a document because
        of it. A dict that is not a valid suggestion (:meth:`_normalise_suggestion`)
        is refused with ``False`` rather than stored. UPDATE-only, like the rest.

        The refusals a person made (``dismissed_of``) outlive every write here: a new
        suggestion keeps them, and one naming a refused file is stored dismissed, so
        it is not offered again. ``None`` clears the open suggestion and keeps them.
        """
        normalised = None
        if suggestion is not None:
            normalised = self._normalise_suggestion(suggestion)
            if normalised is None:
                logger.warning("Refused an invalid revision suggestion for %s", filename)
                return False
        return self._rewrite_suggestion(collection, filename, lambda stored: _merged_suggestion(stored, normalised))

    def dismiss_revision_suggestion(self, collection: str, filename: str, older: str) -> bool:
        """Record that a person refused ``older`` as the Fassung ``filename`` replaces (sync).

        Added to the refusals the row already holds, so „Nein" to one file never
        undoes „Nein" to another. An open suggestion about ``older`` is marked
        dismissed; one about another file stays open. ``False`` when no row exists.
        """
        if not older.strip():
            return False
        return self._rewrite_suggestion(collection, filename, lambda stored: _with_refusal(stored, older))

    def _rewrite_suggestion(
        self, collection: str, filename: str, rewrite: Callable[[dict[str, Any] | None], dict[str, Any] | None]
    ) -> bool:
        """Read the stored suggestion, ``rewrite`` it, and write the result back in one transaction."""
        from sqlalchemy import text

        params = {"collection": collection, "filename": filename}
        try:
            with self._sync_engine.begin() as conn:
                row = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT revision_suggestion FROM {TABLE_NAME} "
                        "WHERE collection = :collection AND filename = :filename"
                    ),
                    params,
                ).first()
                if row is None:
                    return False
                written = rewrite(self._decode_suggestion(row[0]))
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"UPDATE {TABLE_NAME} SET revision_suggestion = :value "
                        "WHERE collection = :collection AND filename = :filename"
                    ),
                    {**params, "value": json.dumps(written) if written else None},
                )
                return True
        except Exception as e:
            logger.warning("Failed to write the revision suggestion for %s: %s", filename, e)
            return False

    def link_fassung(self, collection: str, older: str, newer: str) -> LinkOutcome:
        """Record that a PERSON confirmed ``newer`` replaces ``older``, refusing a loop, in one locked transaction.

        The loop check and the write are one step: two people confirming A over B
        and B over A at the same moment each read a collection with no link, and
        writing after a separate check stored both. Here the second waits for the
        first (an advisory lock per collection on Postgres, a process lock on
        SQLite) and then sees its link.

        In the same transaction: a suggestion on ``newer`` that named ``older`` is
        cleared (its refusals stay), and when ``older`` was replaced by another file
        X until now, X's change line told against ``older`` goes, because X no longer
        replaces it. ``newer`` need not have a row yet: an upload whose summary is
        still missing has the link waiting for it (:meth:`_attach_supersedes`).
        """
        if self._is_postgres():
            return self._link_fassung_locked(collection, older, newer)
        with DocumentMetadataStore._link_lock:
            return self._link_fassung_locked(collection, older, newer)

    def _link_fassung_locked(self, collection: str, older: str, newer: str) -> LinkOutcome:
        from sqlalchemy import text

        from .document_revisions import would_loop

        with self._sync_engine.begin() as conn:
            if conn.dialect.name == "postgresql":
                conn.execute(
                    text("SELECT pg_advisory_xact_lock(CAST(:key AS bigint))"), {"key": _link_lock_key(collection)}
                )
            rows = {
                row[0]: _LinkRow(row[1], row[2], row[3])
                for row in conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT filename, superseded_by, change_basis, revision_suggestion FROM {TABLE_NAME} "
                        "WHERE collection = :collection"
                    ),
                    {"collection": collection},
                )
            }
            if older not in rows:
                return LinkOutcome.MISSING
            if would_loop(rows, newer=newer, older=older):
                return LinkOutcome.LOOP
            self._write_link(conn, collection, older, newer, rows)
        return LinkOutcome.LINKED

    def _write_link(self, conn, collection: str, older: str, newer: str, rows: dict[str, _LinkRow]) -> None:
        """The three writes of a confirmed link, on the caller's locked transaction."""
        _set_columns(conn, collection, older, superseded_by=newer)
        previous = rows[older].superseded_by
        if previous and previous != newer and previous in rows and rows[previous].change_basis == older:
            _set_columns(conn, collection, previous, change_summary=None, change_basis=None)
        own = rows.get(newer)
        stored = self._decode_suggestion(own.revision_suggestion) if own is not None else None
        if stored is not None and stored["of"] == older and not stored["dismissed"]:
            kept = _merged_suggestion(stored, None)
            _set_columns(conn, collection, newer, revision_suggestion=json.dumps(kept) if kept else None)

    def set_change_summary(self, collection: str, filename: str, summary: str | None, basis: str | None) -> bool:
        """Store what changed in ``filename`` against the Fassung named ``basis`` (sync); ``None`` clears both.

        ``basis`` is the file name compared against: the document's own name for
        its previous upload, another name for a Fassung a person confirmed. One
        UPDATE writes both columns, so a summary is never left with another
        file's basis.
        """
        from sqlalchemy import text

        text_value = (summary or "").strip() or None
        basis_value = (basis or "").strip() or None if text_value else None
        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"UPDATE {TABLE_NAME} SET change_summary = :summary, change_basis = :basis "
                        "WHERE collection = :collection AND filename = :filename"
                    ),
                    {"summary": text_value, "basis": basis_value, "collection": collection, "filename": filename},
                )
                conn.commit()
                return (result.rowcount or 0) > 0
        except Exception as e:
            logger.warning("Failed to set the change summary for %s: %s", filename, e)
            return False

    def get_superseded_by_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        """The confirmed ``superseded_by`` of the rows among ``filenames`` that have one."""
        return self._get_column_batch(collection, filenames, "superseded_by")

    def files_linked_to(self, collection: str, newer: str) -> list[str]:
        """The rows whose stored ``superseded_by`` names ``newer``, whether or not ``newer`` has a row (sync).

        What a register or an unregister of ``newer`` changes the meaning of: the
        link counts only while ``newer`` has its row (:meth:`get_superseded_files`),
        so each of these rows reads as replaced or as current again. Fail-open to
        ``[]``.
        """
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                rows = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT filename FROM {TABLE_NAME} WHERE collection = :collection AND superseded_by = :newer"
                    ),
                    {"collection": collection, "newer": newer},
                )
                return sorted(row[0] for row in rows)
        except Exception as e:
            logger.warning("Failed to read the files linked to %s in %s: %s", newer, collection, e)
            return []

    def get_superseded_files(self, collection: str) -> dict[str, str]:
        """Every file of ``collection`` a person replaced, with the file that replaced it (sync).

        Read at search time, so the answer is the store's and a delete or an
        unlink applies to the next search. A link counts only while the newer
        document still has its row, which the same query checks. Fail-open to
        ``{}``: a search that cannot read it hides nothing.
        """
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                rows = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT older.filename, older.superseded_by FROM {TABLE_NAME} older "
                        "WHERE older.collection = :collection AND older.superseded_by IS NOT NULL "
                        f"AND EXISTS (SELECT 1 FROM {TABLE_NAME} newer "
                        "WHERE newer.collection = older.collection AND newer.filename = older.superseded_by)"
                    ),
                    {"collection": collection},
                )
                return {row[0]: row[1] for row in rows}
        except Exception as e:
            logger.warning("Failed to read the replaced files of %s: %s", collection, e)
            return {}

    def get_revision_suggestions_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        """The stored ``revision_suggestion`` JSON of the rows among ``filenames`` that have one (raw text)."""
        return self._get_column_batch(collection, filenames, "revision_suggestion")

    def rewrite_folder_paths(self, collection: str, from_path: str, to_path: str | None) -> int:
        """Re-file a whole subtree after a folder was renamed, moved or deleted.

        The BFF's ``project_folders.path`` is materialised, so one rename rewrites
        every descendant row there (``rewriteDescendantPaths``). This is the
        mirror of that single operation: every document whose ``folder_path`` is
        ``from_path`` OR sits under ``from_path/`` gets that prefix replaced by
        ``to_path``. ``to_path`` of ``None``/``""`` re-files the subtree at the
        project root (what a delete does to the folder's direct children).

        TWO statements, in one transaction, mirroring ``rewriteDescendantPaths``
        on the BFF side: the folder itself is an equality UPDATE, and its
        descendants are a single prefix-replace over the rows that share
        ``from_path/``. A row-by-row loop would be the same result with N
        statements and a half-moved subtree if it failed part-way; nothing is
        committed here until both have run.

        The second statement is deliberately NOT a bare ``LIKE 'from_path%'``: a
        folder called ``Plan`` must not carry ``Plangrundlagen`` with it, which
        is exactly the boundary the ``/`` enforces. LIKE metacharacters in the
        caller's path are escaped for the same reason the BFF escapes them — a
        folder named ``100 % Plans`` cannot be allowed to match half the project.

        Returns the number of rows re-filed (0 when nothing was under it).
        """
        return self.rewrite_folder_paths_moved(collection, from_path, to_path)[0]

    def rewrite_folder_paths_moved(self, collection: str, from_path: str, to_path: str | None) -> tuple[int, list[str]]:
        """:meth:`rewrite_folder_paths`, returning the files it re-filed beside the count.

        The names are read in the same transaction as the two updates, before
        them, so they are the rows those updates move; the count is still the
        updates' own.
        """
        from sqlalchemy import text

        prefix = (from_path or "").strip().strip("/")
        if not prefix:
            return 0, []
        target = (to_path or "").strip().strip("/")

        updated = 0
        try:
            with self._sync_engine.connect() as conn:
                moved = [
                    row[0]
                    for row in conn.execute(
                        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                        text(
                            f"SELECT filename FROM {TABLE_NAME} WHERE collection = :collection "
                            "AND (folder_path = :prefix OR folder_path LIKE :pattern ESCAPE '\\')"
                        ),
                        {"collection": collection, "prefix": prefix, "pattern": f"{_escape_like(prefix)}/%"},
                    )
                ]
                exact = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"UPDATE {TABLE_NAME} SET folder_path = :target "
                        "WHERE collection = :collection AND folder_path = :prefix"
                    ),
                    {"target": target or None, "collection": collection, "prefix": prefix},
                )
                updated += exact.rowcount or 0

                # Descendants: swap the leading ``prefix/`` for ``target/`` (or
                # strip it when the subtree lands at the root). ``substr`` is
                # 1-indexed in both SQLite and Postgres, so the cut starts one
                # past the separator; ``||`` concatenates in both.
                descendants = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"UPDATE {TABLE_NAME} SET folder_path = :new_prefix || substr(folder_path, :cut) "
                        "WHERE collection = :collection AND folder_path LIKE :pattern ESCAPE '\\'"
                    ),
                    {
                        "new_prefix": f"{target}/" if target else "",
                        "cut": len(prefix) + 2,
                        "collection": collection,
                        "pattern": f"{_escape_like(prefix)}/%",
                    },
                )
                updated += descendants.rowcount or 0
                conn.commit()
        except Exception as e:
            logger.warning("Failed to rewrite folder paths under %r in %s: %s", from_path, collection, e)
            return 0, []
        logger.info("Re-filed %d document(s) from %r to %r in %s", updated, prefix, target, collection)
        return updated, moved

    # ------------------------------------------------------------------
    # Column-level helpers (shared by tags/doc_class/display_title accessors)
    # ------------------------------------------------------------------

    def _update_column(self, collection: str, filename: str, column: str, value: Any) -> bool:
        """UPDATE a single column of an existing row; ``False`` if the row is absent."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"UPDATE {TABLE_NAME} SET {column} = :value "
                        "WHERE collection = :collection AND filename = :filename"
                    ),
                    {"value": value, "collection": collection, "filename": filename},
                )
                conn.commit()
                updated = (result.rowcount or 0) > 0
                if updated:
                    logger.debug("Updated %s for %s in %s", column, filename, collection)
                else:
                    logger.debug("No metadata row to update %s for %s in %s", column, filename, collection)
                return updated
        except Exception as e:
            logger.warning("Failed to update %s for %s: %s", column, filename, e)
            return False

    def _get_column(self, collection: str, filename: str, column: str) -> str | None:
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"SELECT {column} FROM {TABLE_NAME} WHERE collection = :collection AND filename = :filename"),
                    {"collection": collection, "filename": filename},
                )
                row = result.first()
                return row[0] if row and row[0] else None
        except Exception as e:
            logger.warning("Failed to get %s for %s: %s", column, filename, e)
            return None

    def _get_column_batch(self, collection: str, filenames: list[str], column: str) -> dict[str, str]:
        if not filenames:
            return {}
        from sqlalchemy import bindparam
        from sqlalchemy import text

        result: dict[str, str] = {}
        try:
            with self._sync_engine.connect() as conn:
                rows = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT filename, {column} FROM {TABLE_NAME} "
                        "WHERE collection = :collection AND filename IN :filenames"
                    ).bindparams(bindparam("filenames", expanding=True)),
                    {"collection": collection, "filenames": list(filenames)},
                )
                for row in rows:
                    if row[1]:
                        result[row[0]] = row[1]
        except Exception as e:
            logger.warning("Failed to batch-get %s for %s: %s", column, collection, e)
            return {}
        return result

    def find_tmp_upload_names(self, collection: str, filenames: list[str]) -> list[str]:
        """The stored names that are one of ``filenames`` behind a ``tmp[8]_`` upload prefix.

        The vector store cannot filter by pattern, and the prefix is random, so
        this row table is where a re-upload learns those spellings without
        reading every chunk of the collection. One indexed query per call. Empty
        on any failure: the caller then misses a legacy spelling, never fails.
        """
        names = [name for name in dict.fromkeys(filenames) if name]
        if not names:
            return []
        from sqlalchemy import text

        # tmp + exactly eight characters + a literal underscore + the name.
        patterns = {f"p{index}": f"tmp{'_' * 8}\\_{_escape_like(name)}" for index, name in enumerate(names)}
        where = " OR ".join(f"filename LIKE :{key} ESCAPE '\\'" for key in patterns)
        try:
            with self._sync_engine.connect() as conn:
                rows = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"SELECT filename FROM {TABLE_NAME} WHERE collection = :collection AND ({where})"),
                    {"collection": collection, **patterns},
                )
                return [row[0] for row in rows]
        except Exception as e:
            logger.warning("Failed to look up tmp-prefixed names in %s: %s", collection, e)
            return []

    def list_collections(self) -> list[str]:
        """Return every distinct collection present in the metadata table (sync).

        The store is the only place that knows which collections have persisted
        metadata; the backfill script iterates these when no ``--collection`` is
        given. Ordered for stable, log-friendly output.
        """
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                result = conn.execute(text(f"SELECT DISTINCT collection FROM {TABLE_NAME} ORDER BY collection"))
                return [row[0] for row in result]
        except Exception as e:
            logger.warning("Failed to list metadata collections: %s", e)
            return []

    @staticmethod
    def _decode_tags(raw: Any) -> list[str] | None:
        """Decode the JSON-encoded tags column back into a list (fail-open)."""
        if not raw:
            return None
        import json

        try:
            decoded = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if isinstance(decoded, list):
            tags = [t for t in decoded if isinstance(t, str)]
            return tags or None
        return None

    #: The keys a ``capture`` object may carry, and the type each must have.
    _CAPTURE_TYPES: dict[str, type | tuple[type, ...]] = {
        "captured_at": str,
        "latitude": (int, float),
        "longitude": (int, float),
        "camera": str,
    }

    @classmethod
    def _decode_object(cls, raw: Any) -> dict[str, Any] | None:
        """Decode the JSON ``capture`` column: only the known keys, each of its type (fail-open).

        A key outside :attr:`_CAPTURE_TYPES`, or one of the wrong type, is dropped
        rather than failing the row: the column is a record of what a camera
        wrote, and a malformed key is a fact we cannot use, not a reason to lose
        the document. ``bool`` is excluded from the numeric keys (it is an ``int``
        in Python, and a flag is not a coordinate).
        """
        if not raw:
            return None
        import json

        try:
            decoded = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if not isinstance(decoded, dict):
            return None
        kept: dict[str, Any] = {}
        for key, expected in cls._CAPTURE_TYPES.items():
            value = decoded.get(key)
            if value is None or isinstance(value, bool) or not isinstance(value, expected):
                continue
            if key == "captured_at" and not value.strip():
                continue
            kept[key] = value
        return kept or None

    @staticmethod
    def _decode_revision_facts(raw: Any) -> dict[str, Any] | None:
        """Decode the JSON ``revision_facts`` column through the one normaliser (fail-open to ``None``)."""
        if not raw:
            return None
        import json

        try:
            return normalise_revision_facts(json.loads(raw))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _normalise_suggestion(value: Any) -> dict[str, Any] | None:
        """A revision suggestion as it is stored and read: exactly its six keys, each valid, or ``None``.

        ``of`` is the older file name, ``confidence`` a number in 0..1 (a flag is
        not one, and NaN is not one), ``reason`` a non-empty text, ``basis`` one
        of :data:`SUGGESTION_BASES`. ``dismissed_of`` lists every file a person
        refused as the older Fassung (:func:`dismissed_fassungen`, which also reads
        the older record with one dismissed ``of``), and ``dismissed`` says whether
        ``of`` is among them. A suggestion missing any of the first four is no suggestion.
        """
        if not isinstance(value, dict):
            return None
        older, confidence = value.get("of"), value.get("confidence")
        reason, basis = value.get("reason"), value.get("basis")
        if not isinstance(older, str) or not older.strip():
            return None
        if isinstance(confidence, bool) or not isinstance(confidence, int | float) or not 0.0 <= confidence <= 1.0:
            return None
        if not isinstance(reason, str) or not reason.strip() or basis not in SUGGESTION_BASES:
            return None
        refused = dismissed_fassungen(value)
        return {
            "of": older,
            "confidence": float(confidence),
            "reason": reason.strip(),
            "basis": basis,
            "dismissed": older in refused,
            "dismissed_of": refused,
        }

    @classmethod
    def _decode_suggestion(cls, raw: Any) -> dict[str, Any] | None:
        """Decode the JSON ``revision_suggestion`` column (fail-open to ``None``)."""
        if not raw:
            return None
        import json

        try:
            return cls._normalise_suggestion(json.loads(raw))
        except (TypeError, ValueError):
            return None

    def _row_to_document(self, row: Any, collection: str | None = None) -> AvailableDocument:
        from .schema import AvailableDocument

        return AvailableDocument(
            file_name=row[0],
            summary=row[1],
            tags=self._decode_tags(row[2]),
            doc_class=row[3] or None,
            display_title=row[4] or None,
            folder_path=row[5] or None,
            added_at=self._iso_date(row[6]) if len(row) > 6 else None,
            topics=self._decode_tags(row[7]) if len(row) > 7 else None,
            capture=self._decode_object(row[8]) if len(row) > 8 else None,
            superseded_by=(row[9] or None) if len(row) > 9 else None,
            revision_suggestion=self._decode_suggestion(row[10]) if len(row) > 10 else None,
            change_summary=(row[11] or None) if len(row) > 11 else None,
            change_basis=(row[12] or None) if len(row) > 12 else None,
            revision_facts=self._decode_revision_facts(row[13]) if len(row) > 13 else None,
            collection=collection,
        )

    @staticmethod
    def _attach_supersedes(documents: list[AvailableDocument]) -> list[AvailableDocument]:
        """Fill ``supersedes``, the reverse of ``superseded_by``, over one collection's rows.

        Derived on every read and never stored, so there is one fact to keep true.
        A link counts only while the newer document still has its row: a purge that
        can be undone leaves the links that point at it (:meth:`unregister`), and this
        guard is what reads them as nothing until the row is back. An older document
        whose newer one is gone is current again, not hidden.
        """
        present = {doc.file_name for doc in documents}
        replaced: dict[str, list[str]] = {}
        for doc in documents:
            if doc.superseded_by and doc.superseded_by in present:
                replaced.setdefault(doc.superseded_by, []).append(doc.file_name)
        for doc in documents:
            if doc.superseded_by and doc.superseded_by not in present:
                doc.superseded_by = None
            doc.supersedes = sorted(replaced[doc.file_name]) if doc.file_name in replaced else None
        return documents

    @staticmethod
    def _iso_date(raw: Any) -> str | None:
        """``created_at`` as the ``YYYY-MM-DD`` the office saw on its clock (Europe/Vienna).

        A datetime on Postgres, a ``YYYY-MM-DD HH:MM:SS`` string on SQLite; both
        are written by ``CURRENT_TIMESTAMP`` and so are UTC when naive. The
        column is ``TIMESTAMP WITH TIME ZONE`` (here and in
        ``deploy/compose/init-db.sql``), so Postgres returns an aware value; a
        naive one only comes from SQLite, whose ``CURRENT_TIMESTAMP`` is UTC, or
        from a table created before that, on a server whose ``TimeZone`` is UTC
        (the Postgres image default). Taking
        the UTC date filed an upload made at 00:30 in Vienna under the day
        before, and „was ist seit heute neu“ missed it.
        """
        if raw is None:
            return None
        if isinstance(raw, datetime):
            moment = raw
        elif isinstance(raw, date):
            return raw.isoformat()
        else:
            text_value = str(raw).strip()
            try:
                moment = datetime.fromisoformat(text_value)
            except ValueError:
                return text_value[:10] or None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=UTC)
        return moment.astimezone(_OFFICE_TIMEZONE).date().isoformat()

    def get_all(self, collection: str) -> list[AvailableDocument]:
        """Get all documents with metadata for a collection (sync)."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"SELECT {_DOCUMENT_COLUMNS} FROM {TABLE_NAME} WHERE collection = :collection"),
                    {"collection": collection},
                )
                return self._attach_supersedes([self._row_to_document(row, collection) for row in result])
        except Exception as e:
            logger.warning("Failed to get metadata for %s: %s", collection, e)
            return []

    def get_many(self, collection: str, filenames: list[str]) -> list[AvailableDocument]:
        """The rows of ``filenames`` only (sync): what a change to one file needs, not the whole collection.

        ``superseded_by`` reads as in :meth:`get_all`: a link counts only while
        the newer document still has its row. ``supersedes`` is left unset,
        because deriving it takes every row of the collection.
        """
        if not filenames:
            return []
        from sqlalchemy import bindparam
        from sqlalchemy import text

        select = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            f"SELECT {_DOCUMENT_COLUMNS} FROM {TABLE_NAME} WHERE collection = :collection AND filename IN :filenames"
        ).bindparams(bindparam("filenames", expanding=True))
        present = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            f"SELECT filename FROM {TABLE_NAME} WHERE collection = :collection AND filename IN :filenames"
        ).bindparams(bindparam("filenames", expanding=True))
        try:
            with self._sync_engine.connect() as conn:
                documents = [
                    self._row_to_document(row, collection)
                    for row in conn.execute(select, {"collection": collection, "filenames": list(filenames)})
                ]
                newer = sorted({doc.superseded_by for doc in documents if doc.superseded_by})
                kept = (
                    {row[0] for row in conn.execute(present, {"collection": collection, "filenames": newer})}
                    if newer
                    else set()
                )
        except Exception as e:
            logger.warning("Failed to get metadata of %d file(s) in %s: %s", len(filenames), collection, e)
            return []
        for doc in documents:
            if doc.superseded_by and doc.superseded_by not in kept:
                doc.superseded_by = None
        return documents

    async def get_all_async(self, collection: str) -> list[AvailableDocument]:
        """Get all documents with metadata for a collection (async)."""
        from sqlalchemy import text

        try:
            await self._ensure_table_async(self.db_url)
            engine = self._get_or_create_async_engine(self.db_url)
            async with engine.connect() as conn:
                result = await conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"SELECT {_DOCUMENT_COLUMNS} FROM {TABLE_NAME} WHERE collection = :collection"),
                    {"collection": collection},
                )
                return self._attach_supersedes([self._row_to_document(row, collection) for row in result])
        except Exception as e:
            logger.warning("Failed to get metadata async for %s: %s", collection, e)
            # Fallback to sync
            return self.get_all(collection)

    def unregister(self, collection: str, filename: str, *, permanent: bool = False) -> None:
        """Remove a document's metadata row (sync), keeping the Fassung facts a person made unless ``permanent``.

        Most purges can be undone: an archive, the folder bin and a publish take the
        chunks and the row out and read the document again later. A link only a
        person makes must survive that, so by default the row's own link, its
        refusals and a change line told against a linked Fassung are kept under
        ``(collection, filename)`` (:data:`RETAINED_TABLE_NAME`) for the next
        :meth:`register` of the name, and the links OTHER rows hold to it stay as
        they are. While the row is gone they read as nothing: :meth:`_attach_supersedes`
        and :meth:`get_superseded_files` count a link only while both rows exist.

        ``permanent`` is a delete nobody undoes (the document is erased, or leaves the
        collection): what was kept for the name goes, and the rows it replaced are
        current again for good.
        """
        from sqlalchemy import text

        params = {"collection": collection, "filename": filename}
        try:
            with self._sync_engine.begin() as conn:
                if permanent:
                    self._forget_links_to(conn, collection, filename)
                else:
                    self._retain(conn, collection, filename)
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"DELETE FROM {TABLE_NAME} WHERE collection = :collection AND filename = :filename"),
                    params,
                )
            logger.debug("Unregistered metadata for %s in %s (permanent=%s)", filename, collection, permanent)
        except Exception as e:
            logger.warning("Failed to unregister metadata for %s: %s", filename, e)

    def _retain(self, conn, collection: str, filename: str) -> None:
        """Keep the Fassung facts a person made on the row about to go, in the caller's transaction."""
        from sqlalchemy import text

        params = {"collection": collection, "filename": filename}
        row = conn.execute(
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"SELECT {', '.join(_RETAINED_COLUMNS)} FROM {TABLE_NAME} "
                "WHERE collection = :collection AND filename = :filename"
            ),
            params,
        ).first()
        kept = _person_made_facts(filename, *row) if row is not None else None
        self._forget_retained(conn, collection, filename)
        if kept is None:
            return
        conn.execute(
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"INSERT INTO {RETAINED_TABLE_NAME} (collection, filename, {', '.join(_RETAINED_COLUMNS)}) "
                "VALUES (:collection, :filename, :superseded_by, :revision_suggestion, :change_summary, :change_basis)"
            ),
            {**params, **kept},
        )

    def _forget_links_to(self, conn, collection: str, filename: str) -> None:
        """A permanent delete: nothing kept for ``filename``, and no row, kept or live, replaced by it any longer."""
        from sqlalchemy import text

        self._forget_retained(conn, collection, filename)
        for table in (TABLE_NAME, RETAINED_TABLE_NAME):
            conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE {table} SET superseded_by = NULL "
                    "WHERE collection = :collection AND superseded_by = :filename"
                ),
                {"collection": collection, "filename": filename},
            )

    def clear_collection(self, collection: str) -> None:
        """Remove all metadata for a collection (sync)."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"DELETE FROM {TABLE_NAME} WHERE collection = :collection"),
                    {"collection": collection},
                )
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"DELETE FROM {RETAINED_TABLE_NAME} WHERE collection = :collection"),
                    {"collection": collection},
                )
                conn.commit()
                logger.debug("Cleared metadata for collection %s", collection)
        except Exception as e:
            logger.warning("Failed to clear metadata for %s: %s", collection, e)

    def clear_all(self) -> None:
        """Remove all metadata rows (sync)."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                conn.execute(text(f"DELETE FROM {TABLE_NAME}"))
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                conn.execute(text(f"DELETE FROM {RETAINED_TABLE_NAME}"))
                conn.commit()
                logger.debug("Cleared all document metadata")
        except Exception as e:
            logger.warning("Failed to clear all document metadata: %s", e)

    @classmethod
    async def dispose_engine_async(cls, db_url: str):
        """Awaitable variant of :meth:`dispose_engine` for callers inside a
        running event loop.

        The synchronous variant can only *schedule* the close of an async
        engine (``loop.create_task``); when the caller's loop is about to shut
        down — e.g. an async test's teardown — that task never runs, the
        aiosqlite connection stays open and a Windows SQLite temp file remains
        locked. Awaiting the dispose directly closes it before the caller
        proceeds.
        """
        with cls._cache_lock:
            engine = cls._sync_engine_cache.pop(db_url, (None,))[0]
            if engine:
                try:
                    engine.dispose()
                except (RuntimeError, OSError):
                    pass

            engine = cls._async_engine_cache.pop(db_url, (None,))[0]
            if engine:
                try:
                    await engine.dispose()
                except (RuntimeError, OSError):
                    pass

    @classmethod
    def dispose_engine(cls, db_url: str):
        """Dispose the cached engines for one db_url (e.g. temp-file teardown).

        Unlike ``dispose_all_engines`` this leaves every other cached store
        intact — engine caches are shared process-globally, so tests that point
        the store at a fresh temp SQLite file must release exactly that file's
        handle before removing the directory (Windows: unlink of an open SQLite
        file fails with PermissionError).
        """
        import asyncio

        with cls._cache_lock:
            engine = cls._sync_engine_cache.pop(db_url, (None,))[0]
            if engine:
                try:
                    engine.dispose()
                except (RuntimeError, OSError):
                    pass

            engine = cls._async_engine_cache.pop(db_url, (None,))[0]
            if engine:
                try:
                    coro = engine.dispose()
                    try:
                        loop = asyncio.get_running_loop()
                        loop.create_task(coro)
                    except RuntimeError:
                        asyncio.run(coro)
                except (RuntimeError, OSError):
                    pass

    @classmethod
    def dispose_all_engines(cls):
        """Dispose all cached engines (for shutdown)."""
        import asyncio

        with cls._cache_lock:
            for key, (engine, _) in list(cls._sync_engine_cache.items()):
                try:
                    engine.dispose()
                except (RuntimeError, OSError):
                    pass
            cls._sync_engine_cache.clear()

            for key, (engine, _) in list(cls._async_engine_cache.items()):
                try:
                    coro = engine.dispose()
                    try:
                        loop = asyncio.get_running_loop()
                        loop.create_task(coro)
                    except RuntimeError:
                        asyncio.run(coro)
                except (RuntimeError, OSError):
                    pass
            cls._async_engine_cache.clear()

            cls._tables_initialized.clear()

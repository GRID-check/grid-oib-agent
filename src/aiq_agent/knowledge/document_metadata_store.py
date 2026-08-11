"""Per-document metadata store (SQLAlchemy).

One row per ``(collection, filename)`` holding everything the system knows about
an ingested document beyond its chunks: the one-sentence ``summary``, the
controlled ``tags``, the explicit ``doc_class`` ("Dokumentart"), and the
user-facing ``display_title``. The table is named ``document_metadata`` because
it is exactly that — the summary is only one of several columns.

Historically this was the ``summaries`` table (class ``SummaryStore``). A
startup migration renames that table in place the first time the store opens
against an older database, so existing rows are preserved untouched — see
:meth:`DocumentMetadataStore._ensure_schema`.

Configurable SQLite/PostgreSQL storage, following the same pattern as EventStore
in the jobs system.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.db_utils import normalize_db_url as _normalize_db_url
from aiq_agent.common.db_utils import redact_db_url

if TYPE_CHECKING:
    from .schema import AvailableDocument

logger = logging.getLogger(__name__)

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
_OPTIONAL_COLUMNS: tuple[str, ...] = ("tags", "doc_class", "display_title")

# Every raw-SQL statement in this module interpolates ONLY trusted, code-defined
# SQL identifiers: the table/index name constants above, and column names drawn
# from a fixed allowlist (``_OPTIONAL_COLUMNS`` plus the literal
# ``"tags"``/``"doc_class"``/``"display_title"`` passed by the typed accessors).
# SQL identifiers cannot be bound parameters, so they must live in the statement
# text. Every caller-supplied *value* (collection, filename, summary, tags,
# display_title, …) is always passed as a bound ``:param`` and never interpolated.
# The interpolation is therefore not attacker-reachable, which is why each
# ``sqlalchemy.text()`` call below carries a ``# nosemgrep: …avoid-sqlalchemy-text``
# marker for the taint-based SAST rule.


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

            migrated = False
            try:
                with self._sync_engine.connect() as conn:
                    migrated = self._run_schema(conn)
                    conn.commit()
            except Exception as e:
                logger.warning("Failed to ensure document_metadata schema (sync): %s", e)

            # Only mark the store initialized when the schema is actually ready.
            # A failed migration must NOT be cached as initialized, so the next
            # call retries it instead of writing against a missing column.
            if migrated:
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

        migrated = False
        try:
            async with engine.begin() as conn:
                migrated = await conn.run_sync(store._run_schema)
        except Exception as e:
            logger.warning("Failed to ensure document_metadata schema (async): %s", e)

        if migrated:
            cls._tables_initialized.add(db_url)
            logger.info("Created/migrated document_metadata table (async) in %s", redact_db_url(db_url))

    def _run_schema(self, conn) -> bool:
        """Create fresh, rename the legacy table, then backfill missing columns.

        Runs over a live sync connection (the caller owns the transaction/commit).
        Returns ``True`` when the schema is ready.
        """
        from sqlalchemy import inspect
        from sqlalchemy import text

        inspector = inspect(conn)
        has_current = inspector.has_table(TABLE_NAME)
        has_legacy = inspector.has_table(LEGACY_TABLE_NAME)

        try:
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
            for column in _OPTIONAL_COLUMNS:
                self._add_column_if_missing(conn, column)

            self._ensure_index(conn)
            return True
        except Exception as e:
            logger.warning("Failed to migrate document_metadata schema: %s", e)
            return False

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
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "
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

        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        conn.execute(text(f"CREATE INDEX IF NOT EXISTS {_INDEX_NAME} ON {TABLE_NAME} (collection)"))
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        conn.execute(text(f"DROP INDEX IF EXISTS {_LEGACY_INDEX_NAME}"))

    def register(self, collection: str, filename: str, summary: str, tags: list[str] | None = None) -> None:
        """Store a document summary and optional controlled tags (sync)."""
        import json

        from sqlalchemy import text

        # Use upsert pattern that works for both SQLite and PostgreSQL
        is_postgres = self._is_postgres()
        tags_json = json.dumps(tags) if tags else None

        try:
            with self._sync_engine.connect() as conn:
                if is_postgres:
                    conn.execute(
                        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                        text(
                            f"INSERT INTO {TABLE_NAME} (collection, filename, summary, tags) "
                            "VALUES (:collection, :filename, :summary, :tags) "
                            "ON CONFLICT (collection, filename) DO UPDATE SET "
                            "summary = EXCLUDED.summary, tags = EXCLUDED.tags"
                        ),
                        {"collection": collection, "filename": filename, "summary": summary, "tags": tags_json},
                    )
                else:
                    # SQLite uses INSERT OR REPLACE
                    conn.execute(
                        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                        text(
                            f"INSERT OR REPLACE INTO {TABLE_NAME} (collection, filename, summary, tags) "
                            "VALUES (:collection, :filename, :summary, :tags)"
                        ),
                        {"collection": collection, "filename": filename, "summary": summary, "tags": tags_json},
                    )
                conn.commit()
                logger.debug("Registered metadata for %s in %s", filename, collection)
        except Exception as e:
            logger.warning("Failed to register metadata for %s: %s", filename, e)

    def update_tags(self, collection: str, filename: str, tags: list[str] | None) -> bool:
        """Replace only the ``tags`` of an existing metadata row (sync).

        The one-sentence ``summary`` is NEVER touched — this is the tag-edit /
        backfill seam, distinct from :meth:`register` (which owns the summary).
        An empty or ``None`` ``tags`` clears the column (stored as SQL NULL,
        which decodes back to ``None``).

        Returns ``True`` when a row existed and was updated, ``False`` when no
        metadata row exists for ``(collection, filename)`` — so callers (the edit
        endpoint) can surface a 404 rather than silently creating a summary-less,
        NOT NULL-violating row.
        """
        import json

        tags_json = json.dumps(tags) if tags else None
        return self._update_column(collection, filename, "tags", tags_json)

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

    def _row_to_document(self, row: Any) -> AvailableDocument:
        from .schema import AvailableDocument

        return AvailableDocument(
            file_name=row[0],
            summary=row[1],
            tags=self._decode_tags(row[2]),
            doc_class=row[3] or None,
            display_title=row[4] or None,
        )

    def get_all(self, collection: str) -> list[AvailableDocument]:
        """Get all documents with metadata for a collection (sync)."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT filename, summary, tags, doc_class, display_title FROM {TABLE_NAME} "
                        "WHERE collection = :collection"
                    ),
                    {"collection": collection},
                )
                return [self._row_to_document(row) for row in result]
        except Exception as e:
            logger.warning("Failed to get metadata for %s: %s", collection, e)
            return []

    async def get_all_async(self, collection: str) -> list[AvailableDocument]:
        """Get all documents with metadata for a collection (async)."""
        from sqlalchemy import text

        try:
            await self._ensure_table_async(self.db_url)
            engine = self._get_or_create_async_engine(self.db_url)
            async with engine.connect() as conn:
                result = await conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT filename, summary, tags, doc_class, display_title FROM {TABLE_NAME} "
                        "WHERE collection = :collection"
                    ),
                    {"collection": collection},
                )
                return [self._row_to_document(row) for row in result]
        except Exception as e:
            logger.warning("Failed to get metadata async for %s: %s", collection, e)
            # Fallback to sync
            return self.get_all(collection)

    def unregister(self, collection: str, filename: str) -> None:
        """Remove a document's metadata row (sync)."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"DELETE FROM {TABLE_NAME} WHERE collection = :collection AND filename = :filename"),
                    {"collection": collection, "filename": filename},
                )
                conn.commit()
                logger.debug("Unregistered metadata for %s in %s", filename, collection)
        except Exception as e:
            logger.warning("Failed to unregister metadata for %s: %s", filename, e)

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

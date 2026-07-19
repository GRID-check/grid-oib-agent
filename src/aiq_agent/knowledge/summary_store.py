"""Summary store for document summaries using SQLAlchemy.

Provides configurable SQLite/PostgreSQL storage for document summaries,
following the same pattern as EventStore in the jobs system.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.db_utils import redact_db_url

if TYPE_CHECKING:
    from .schema import AvailableDocument

logger = logging.getLogger(__name__)

ENGINE_CACHE_TTL_SECONDS = 3600
ENGINE_CACHE_MAX_SIZE = 10


def _normalize_db_url(db_url: str, async_mode: bool = True) -> str:
    """Normalize database URL to use consistent drivers."""
    if db_url.startswith("postgresql") or db_url.startswith("postgres"):
        base_url = db_url.replace("+asyncpg", "").replace("+psycopg2", "").replace("+psycopg", "")
        if not base_url.startswith("postgresql://"):
            base_url = base_url.replace("postgres://", "postgresql://")
        return (
            f"{base_url.replace('postgresql://', 'postgresql+psycopg://')}"
            if async_mode
            else base_url.replace("postgresql://", "postgresql+psycopg://")
        )
    elif db_url.startswith("sqlite"):
        base_url = db_url.replace("+aiosqlite", "")
        return base_url.replace("sqlite:///", "sqlite+aiosqlite:///") if async_mode else base_url
    return db_url


class SummaryStore:
    """SQLAlchemy-based store for document summaries.

    Features:
    - Automatic SQLite/PostgreSQL support based on db_url
    - Connection pooling with TTL-based cache management
    - Both sync and async operations supported
    """

    _async_engine_cache: dict[str, tuple[Any, float]] = {}
    _sync_engine_cache: dict[str, tuple[Any, float]] = {}
    _cache_lock = threading.Lock()
    _tables_initialized: set[str] = set()

    def __init__(self, db_url: str):
        self.db_url = db_url
        self._sync_engine = self._get_or_create_sync_engine(db_url)
        self._ensure_table_sync()
        logger.info("SummaryStore initialized: %s", redact_db_url(db_url))

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

    def _ensure_table_sync(self):
        """Create summaries table if it doesn't exist (sync)."""
        with SummaryStore._cache_lock:
            if self.db_url in SummaryStore._tables_initialized:
                return

            from sqlalchemy import Column
            from sqlalchemy import DateTime
            from sqlalchemy import Index
            from sqlalchemy import MetaData
            from sqlalchemy import PrimaryKeyConstraint
            from sqlalchemy import String
            from sqlalchemy import Table
            from sqlalchemy import Text
            from sqlalchemy import inspect
            from sqlalchemy.sql import func

            inspector = inspect(self._sync_engine)
            if not inspector.has_table("summaries"):
                metadata = MetaData()
                Table(
                    "summaries",
                    metadata,
                    Column("collection", String(256), nullable=False),
                    Column("filename", String(512), nullable=False),
                    Column("summary", Text, nullable=False),
                    Column("tags", Text, nullable=True),
                    Column("doc_class", Text, nullable=True),
                    Column("created_at", DateTime, server_default=func.now()),
                    PrimaryKeyConstraint("collection", "filename"),
                    Index("idx_summaries_collection", "collection"),
                )
                metadata.create_all(self._sync_engine)
                logger.info("Created summaries table in %s", redact_db_url(self.db_url))
                migrated = True
            else:
                # Pre-existing table (created before the tags/doc_class columns
                # existed): add the columns explicitly. CREATE TABLE only adds
                # them on fresh tables, and this store has no migration framework.
                migrated = self._migrate_add_tags_column_sync() and self._migrate_add_doc_class_column_sync()

            # Only mark the store initialized when the schema is actually ready.
            # A failed migration must NOT be cached as initialized, so the next
            # call retries it instead of writing against a missing tags column.
            if migrated:
                SummaryStore._tables_initialized.add(self.db_url)

    def _migrate_add_tags_column_sync(self) -> bool:
        """Backfill the ``tags`` column onto a pre-existing summaries table.

        Postgres supports ``ADD COLUMN IF NOT EXISTS``; SQLite does not, so the
        column is added only after a ``PRAGMA table_info`` existence check.
        Mirrors the job_access migration pattern in
        ``frontends/aiq_api/src/aiq_api/jobs/access.py``.

        Returns ``True`` when the column is present after the call, ``False`` if
        the migration failed (so the caller can retry on the next access instead
        of caching a half-initialized store).
        """
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                if self.db_url.startswith("postgres"):
                    conn.execute(text("ALTER TABLE summaries ADD COLUMN IF NOT EXISTS tags TEXT"))
                else:
                    existing = {row[1] for row in conn.execute(text("PRAGMA table_info(summaries)")).fetchall()}
                    if "tags" not in existing:
                        conn.execute(text("ALTER TABLE summaries ADD COLUMN tags TEXT"))
                conn.commit()
            return True
        except Exception as e:
            logger.warning("Failed to migrate summaries.tags column: %s", e)
            return False

    def _migrate_add_doc_class_column_sync(self) -> bool:
        """Backfill the ``doc_class`` column onto a pre-existing summaries table.

        Mirrors :meth:`_migrate_add_tags_column_sync` exactly (Postgres
        ``ADD COLUMN IF NOT EXISTS``; SQLite guarded by ``PRAGMA table_info``).
        Returns ``True`` when the column is present afterwards, ``False`` on
        failure so the caller retries instead of caching a half-initialized store.
        """
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                if self.db_url.startswith("postgres"):
                    conn.execute(text("ALTER TABLE summaries ADD COLUMN IF NOT EXISTS doc_class TEXT"))
                else:
                    existing = {row[1] for row in conn.execute(text("PRAGMA table_info(summaries)")).fetchall()}
                    if "doc_class" not in existing:
                        conn.execute(text("ALTER TABLE summaries ADD COLUMN doc_class TEXT"))
                conn.commit()
            return True
        except Exception as e:
            logger.warning("Failed to migrate summaries.doc_class column: %s", e)
            return False

    @classmethod
    async def _ensure_table_async(cls, db_url: str):
        """Ensure summaries table exists (async)."""
        if db_url in cls._tables_initialized:
            return

        from sqlalchemy import Column
        from sqlalchemy import DateTime
        from sqlalchemy import Index
        from sqlalchemy import MetaData
        from sqlalchemy import PrimaryKeyConstraint
        from sqlalchemy import String
        from sqlalchemy import Table
        from sqlalchemy import Text
        from sqlalchemy.sql import func

        engine = cls._get_or_create_async_engine(db_url)
        metadata = MetaData()

        Table(
            "summaries",
            metadata,
            Column("collection", String(256), nullable=False),
            Column("filename", String(512), nullable=False),
            Column("summary", Text, nullable=False),
            Column("tags", Text, nullable=True),
            Column("doc_class", Text, nullable=True),
            Column("created_at", DateTime, server_default=func.now()),
            PrimaryKeyConstraint("collection", "filename"),
            Index("idx_summaries_collection", "collection"),
        )

        async with engine.begin() as conn:
            await conn.run_sync(lambda sync_conn: metadata.create_all(sync_conn))
            # create_all() never alters an existing table, so backfill the tags
            # and doc_class columns onto pre-existing tables (see the sync helpers).
            migrated = await conn.run_sync(cls._migrate_add_tags_column_conn, db_url)
            migrated = await conn.run_sync(cls._migrate_add_doc_class_column_conn, db_url) and migrated

        # Only cache the store as initialized when the migration actually
        # succeeded; a failed migration must be retried on the next access.
        if migrated:
            cls._tables_initialized.add(db_url)
            logger.info("Created summaries table (async) in %s", redact_db_url(db_url))

    @staticmethod
    def _migrate_add_tags_column_conn(sync_conn, db_url: str) -> bool:
        """Add the ``tags`` column onto a pre-existing table, over a sync connection.

        Returns ``True`` when the column is present afterwards, ``False`` if the
        migration failed (so ``_ensure_table_async`` does not cache a
        half-initialized store).
        """
        from sqlalchemy import text

        try:
            if db_url.startswith("postgres"):
                sync_conn.execute(text("ALTER TABLE summaries ADD COLUMN IF NOT EXISTS tags TEXT"))
            else:
                existing = {row[1] for row in sync_conn.execute(text("PRAGMA table_info(summaries)")).fetchall()}
                if "tags" not in existing:
                    sync_conn.execute(text("ALTER TABLE summaries ADD COLUMN tags TEXT"))
            return True
        except Exception as e:
            logger.warning("Failed to migrate summaries.tags column (async): %s", e)
            return False

    @staticmethod
    def _migrate_add_doc_class_column_conn(sync_conn, db_url: str) -> bool:
        """Add the ``doc_class`` column onto a pre-existing table, over a sync connection.

        Async twin of :meth:`_migrate_add_doc_class_column_sync`. Returns ``True``
        when the column is present afterwards, ``False`` on failure.
        """
        from sqlalchemy import text

        try:
            if db_url.startswith("postgres"):
                sync_conn.execute(text("ALTER TABLE summaries ADD COLUMN IF NOT EXISTS doc_class TEXT"))
            else:
                existing = {row[1] for row in sync_conn.execute(text("PRAGMA table_info(summaries)")).fetchall()}
                if "doc_class" not in existing:
                    sync_conn.execute(text("ALTER TABLE summaries ADD COLUMN doc_class TEXT"))
            return True
        except Exception as e:
            logger.warning("Failed to migrate summaries.doc_class column (async): %s", e)
            return False

    def register(self, collection: str, filename: str, summary: str, tags: list[str] | None = None) -> None:
        """Store a document summary and optional controlled tags (sync)."""
        import json

        from sqlalchemy import text

        # Use upsert pattern that works for both SQLite and PostgreSQL
        is_postgres = self.db_url.startswith("postgres")
        tags_json = json.dumps(tags) if tags else None

        try:
            with self._sync_engine.connect() as conn:
                if is_postgres:
                    conn.execute(
                        text(
                            "INSERT INTO summaries (collection, filename, summary, tags) "
                            "VALUES (:collection, :filename, :summary, :tags) "
                            "ON CONFLICT (collection, filename) DO UPDATE SET "
                            "summary = EXCLUDED.summary, tags = EXCLUDED.tags"
                        ),
                        {"collection": collection, "filename": filename, "summary": summary, "tags": tags_json},
                    )
                else:
                    # SQLite uses INSERT OR REPLACE
                    conn.execute(
                        text(
                            "INSERT OR REPLACE INTO summaries (collection, filename, summary, tags) "
                            "VALUES (:collection, :filename, :summary, :tags)"
                        ),
                        {"collection": collection, "filename": filename, "summary": summary, "tags": tags_json},
                    )
                conn.commit()
                logger.debug("Registered summary for %s in %s", filename, collection)
        except Exception as e:
            logger.warning("Failed to register summary for %s: %s", filename, e)

    def update_tags(self, collection: str, filename: str, tags: list[str] | None) -> bool:
        """Replace only the ``tags`` of an existing summary row (sync).

        The one-sentence ``summary`` is NEVER touched — this is the tag-edit /
        backfill seam, distinct from :meth:`register` (which owns the summary).
        An empty or ``None`` ``tags`` clears the column (stored as SQL NULL,
        which decodes back to ``None``).

        Returns ``True`` when a row existed and was updated, ``False`` when no
        summary row exists for ``(collection, filename)`` — so callers (the edit
        endpoint) can surface a 404 rather than silently creating a summary-less,
        NOT NULL-violating row.
        """
        import json

        from sqlalchemy import text

        tags_json = json.dumps(tags) if tags else None

        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    text("UPDATE summaries SET tags = :tags WHERE collection = :collection AND filename = :filename"),
                    {"tags": tags_json, "collection": collection, "filename": filename},
                )
                conn.commit()
                updated = (result.rowcount or 0) > 0
                if updated:
                    logger.debug("Updated tags for %s in %s", filename, collection)
                else:
                    logger.debug("No summary row to update tags for %s in %s", filename, collection)
                return updated
        except Exception as e:
            logger.warning("Failed to update tags for %s: %s", filename, e)
            return False

    def set_doc_class(self, collection: str, filename: str, doc_class: str | None) -> bool:
        """Replace only the ``doc_class`` of an existing summary row (sync).

        The explicit "Dokumentart" seam, distinct from :meth:`register` (which
        owns the summary) and :meth:`update_tags` (which owns the tags). Follows
        the same UPDATE-only contract as :meth:`update_tags`: returns ``True``
        when a row existed and was updated, ``False`` when no summary row exists
        for ``(collection, filename)`` — so ingestion/edit callers never create a
        summary-less, NOT NULL-violating row. A ``None`` value clears the column.
        """
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    text(
                        "UPDATE summaries SET doc_class = :doc_class "
                        "WHERE collection = :collection AND filename = :filename"
                    ),
                    {"doc_class": doc_class, "collection": collection, "filename": filename},
                )
                conn.commit()
                updated = (result.rowcount or 0) > 0
                if updated:
                    logger.debug("Updated doc_class for %s in %s", filename, collection)
                else:
                    logger.debug("No summary row to update doc_class for %s in %s", filename, collection)
                return updated
        except Exception as e:
            logger.warning("Failed to update doc_class for %s: %s", filename, e)
            return False

    def get_doc_class(self, collection: str, filename: str) -> str | None:
        """Return the stored explicit ``doc_class`` for a document, or ``None`` (sync).

        ``None`` covers both "no summary row" and "row present but doc_class not
        set" — callers treat both as "no explicit class yet" and fall back to the
        filename guess.
        """
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    text("SELECT doc_class FROM summaries WHERE collection = :collection AND filename = :filename"),
                    {"collection": collection, "filename": filename},
                )
                row = result.first()
                return row[0] if row and row[0] else None
        except Exception as e:
            logger.warning("Failed to get doc_class for %s: %s", filename, e)
            return None

    def get_doc_classes_batch(self, collection: str, filenames: list[str]) -> dict[str, str]:
        """Return stored explicit ``doc_class`` values for many documents in one query.

        Batched equivalent of :meth:`get_doc_class`: one ``... WHERE collection =
        :collection AND filename IN (...)`` instead of one round-trip per file.
        Only documents with a truthy stored ``doc_class`` appear in the result —
        identical coercion to :meth:`get_doc_class` (a missing row or an
        unset/empty ``doc_class`` is simply absent), so callers see the same
        "no explicit class yet" signal. Fail-open: any error yields an empty map.
        """
        if not filenames:
            return {}
        from sqlalchemy import bindparam
        from sqlalchemy import text

        result: dict[str, str] = {}
        try:
            with self._sync_engine.connect() as conn:
                rows = conn.execute(
                    text(
                        "SELECT filename, doc_class FROM summaries "
                        "WHERE collection = :collection AND filename IN :filenames"
                    ).bindparams(bindparam("filenames", expanding=True)),
                    {"collection": collection, "filenames": list(filenames)},
                )
                for row in rows:
                    if row[1]:
                        result[row[0]] = row[1]
        except Exception as e:
            logger.warning("Failed to batch-get doc_class for %s: %s", collection, e)
            return {}
        return result

    def list_collections(self) -> list[str]:
        """Return every distinct collection present in the summaries table (sync).

        The store is the only place that knows which collections have persisted
        summaries; the backfill script iterates these when no ``--collection`` is
        given. Ordered for stable, log-friendly output.
        """
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(text("SELECT DISTINCT collection FROM summaries ORDER BY collection"))
                return [row[0] for row in result]
        except Exception as e:
            logger.warning("Failed to list summary collections: %s", e)
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

    def get_all(self, collection: str) -> list[AvailableDocument]:
        """Get all documents with summaries for a collection (sync)."""
        from sqlalchemy import text

        from .schema import AvailableDocument

        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    text("SELECT filename, summary, tags, doc_class FROM summaries WHERE collection = :collection"),
                    {"collection": collection},
                )
                return [
                    AvailableDocument(
                        file_name=row[0], summary=row[1], tags=self._decode_tags(row[2]), doc_class=row[3] or None
                    )
                    for row in result
                ]
        except Exception as e:
            logger.warning("Failed to get summaries for %s: %s", collection, e)
            return []

    async def get_all_async(self, collection: str) -> list[AvailableDocument]:
        """Get all documents with summaries for a collection (async)."""
        from sqlalchemy import text

        from .schema import AvailableDocument

        try:
            await self._ensure_table_async(self.db_url)
            engine = self._get_or_create_async_engine(self.db_url)
            async with engine.connect() as conn:
                result = await conn.execute(
                    text("SELECT filename, summary, tags, doc_class FROM summaries WHERE collection = :collection"),
                    {"collection": collection},
                )
                return [
                    AvailableDocument(
                        file_name=row[0], summary=row[1], tags=self._decode_tags(row[2]), doc_class=row[3] or None
                    )
                    for row in result
                ]
        except Exception as e:
            logger.warning("Failed to get summaries async for %s: %s", collection, e)
            # Fallback to sync
            return self.get_all(collection)

    def unregister(self, collection: str, filename: str) -> None:
        """Remove a document's summary (sync)."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                conn.execute(
                    text("DELETE FROM summaries WHERE collection = :collection AND filename = :filename"),
                    {"collection": collection, "filename": filename},
                )
                conn.commit()
                logger.debug("Unregistered summary for %s in %s", filename, collection)
        except Exception as e:
            logger.warning("Failed to unregister summary for %s: %s", filename, e)

    def clear_collection(self, collection: str) -> None:
        """Remove all summaries for a collection (sync)."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                conn.execute(
                    text("DELETE FROM summaries WHERE collection = :collection"),
                    {"collection": collection},
                )
                conn.commit()
                logger.debug("Cleared summaries for collection %s", collection)
        except Exception as e:
            logger.warning("Failed to clear summaries for %s: %s", collection, e)

    def clear_all(self) -> None:
        """Remove all summaries (sync)."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                conn.execute(text("DELETE FROM summaries"))
                conn.commit()
                logger.debug("Cleared all summaries")
        except Exception as e:
            logger.warning("Failed to clear all summaries: %s", e)

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

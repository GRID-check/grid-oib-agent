"""Admin-managed store for the curated norm registry (SQLAlchemy-backed).

Persists the ``NormsFile`` payload (see ``aiq_agent.common.norm_registry``) so
the platform admin UI can edit the catalog at runtime while the YAML seed at
``configs/norms/<country>/registry.yml`` remains the build-time seed / fallback.
The store registers itself as ``norm_registry``'s runtime source via
``set_db_loader``; the registry stays fail-open (a broken store falls back to
the YAML seed, never breaks the prompt-building hot path).

Modeled on :mod:`aiq_agent.knowledge.document_metadata_store` (URL normalization, engine
cache with TTL, lazy ``_ensure_table`` via ``inspect().has_table``, fail-open
try/except → ``logger.warning``).

DB URL decision: this store reuses the SAME database URL as the summary store
(``config.summary_db`` / ``configure_summary_db``). There is intentionally NO
new environment variable — the norm registry is a tiny single-row-per-country
table and belongs in the same knowledge database the summaries already live in,
so deployments configure one URL, not two. The wiring lives next to
``configure_summary_db`` in ``sources/knowledge_layer/src/register.py``.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import UTC
from datetime import datetime
from typing import Any

from aiq_agent.common import norm_registry
from aiq_agent.common.db_utils import normalize_db_url as _normalize_db_url
from aiq_agent.common.db_utils import redact_db_url
from aiq_agent.common.norm_registry import NormsFile

logger = logging.getLogger(__name__)

ENGINE_CACHE_TTL_SECONDS = 3600
ENGINE_CACHE_MAX_SIZE = 10

DEFAULT_COUNTRY = "at"

# The norm catalog is admin-edited, effectively static data that the shallow
# research answer path reads many times per turn (prompt render ×iterations,
# knowledge/RIS tools, and RIS wire serialization). Memoize the parsed
# ``(NormsFile, version)`` in-process for this many seconds so those repeated
# reads don't each pay a blocking DB SELECT + full JSON re-parse on the event
# loop. Same-process admin writes invalidate immediately (see ``put``); a
# cross-replica edit becomes visible within the TTL — indistinguishable from
# today's DB-propagation delay (there is no push invalidation across replicas).
NORM_STORE_CACHE_TTL_SECONDS = 30


class NormRegistryStore:
    """SQLAlchemy-based store for the admin-managed norm registry.

    One row per country (``country`` primary key) holding the ``NormsFile`` JSON
    plus an integer ``version`` used for optimistic concurrency. SQLite/Postgres
    are both supported based on ``db_url``.
    """

    _sync_engine_cache: dict[str, tuple[Any, float]] = {}
    _cache_lock = threading.Lock()
    _tables_initialized: set[str] = set()

    def __init__(self, db_url: str):
        self.db_url = db_url
        self._sync_engine = self._get_or_create_sync_engine(db_url)
        self._ensure_table_sync()
        # Short-TTL memo of parsed ``(NormsFile, version)`` per country. Instance
        # scoped (the store is a process singleton via ``_norm_store``). Guarded
        # by its own lock so the loader — called from the event loop and worker
        # threads — never races the invalidation in ``put``.
        self._get_cache: dict[str, tuple[tuple[NormsFile | None, int], float]] = {}
        self._get_cache_lock = threading.Lock()
        logger.info("NormRegistryStore initialized: %s", redact_db_url(db_url))

    # -- engine cache --------------------------------------------------------

    @classmethod
    def _get_or_create_sync_engine(cls, db_url: str):
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
    def _cleanup_stale_engines(cls, cache: dict[str, tuple[Any, float]]):
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

    # -- schema --------------------------------------------------------------

    def _ensure_table_sync(self):
        """Create the ``norm_registry`` table if it doesn't exist (sync)."""
        with NormRegistryStore._cache_lock:
            if self.db_url in NormRegistryStore._tables_initialized:
                return

            from sqlalchemy import Column
            from sqlalchemy import DateTime
            from sqlalchemy import Integer
            from sqlalchemy import MetaData
            from sqlalchemy import String
            from sqlalchemy import Table
            from sqlalchemy import Text
            from sqlalchemy import inspect

            inspector = inspect(self._sync_engine)
            if not inspector.has_table("norm_registry"):
                metadata = MetaData()
                Table(
                    "norm_registry",
                    metadata,
                    Column("country", String(8), primary_key=True),
                    Column("data", Text, nullable=False),
                    Column("version", Integer, nullable=False),
                    Column("updated_at", DateTime),
                )
                metadata.create_all(self._sync_engine)
                logger.info("Created norm_registry table in %s", redact_db_url(self.db_url))

            NormRegistryStore._tables_initialized.add(self.db_url)

    # -- read ----------------------------------------------------------------

    def get(self, country: str = DEFAULT_COUNTRY) -> tuple[NormsFile | None, int]:
        """Return the stored ``(NormsFile, version)``; ``(None, 0)`` when absent or unparseable."""
        from sqlalchemy import text

        try:
            with self._sync_engine.connect() as conn:
                row = conn.execute(
                    text("SELECT data, version FROM norm_registry WHERE country = :country"),
                    {"country": country},
                ).fetchone()
        except Exception as e:
            logger.warning("Failed to read norm_registry for %s: %s", country, e)
            return (None, 0)

        if row is None:
            return (None, 0)

        data, version = row[0], row[1]
        try:
            norms_file = NormsFile.model_validate_json(data)
        except Exception as e:
            logger.warning("Corrupted norm_registry row for %s (%s) — treating as empty", country, e)
            return (None, 0)
        return (norms_file, int(version))

    def get_cached(self, country: str = DEFAULT_COUNTRY) -> tuple[NormsFile | None, int]:
        """Return :meth:`get` memoized with a short TTL (see ``NORM_STORE_CACHE_TTL_SECONDS``).

        Behavior-equivalent to ``get`` for callers that tolerate the same
        cross-replica propagation delay the YAML seed's mtime cache already
        imposes. Same-process writes via :meth:`put` refresh this cache
        immediately, so an admin edit is visible to this process on the very
        next read.
        """
        now = time.monotonic()
        with self._get_cache_lock:
            cached = self._get_cache.get(country)
            if cached is not None and now - cached[1] < NORM_STORE_CACHE_TTL_SECONDS:
                return cached[0]
        result = self.get(country)
        with self._get_cache_lock:
            self._get_cache[country] = (result, time.monotonic())
        return result

    # -- write ---------------------------------------------------------------

    def put(
        self,
        norms_file: NormsFile,
        country: str = DEFAULT_COUNTRY,
        expected_version: int | None = None,
    ) -> int | None:
        """Write the registry with optimistic concurrency.

        When ``expected_version`` is not None and differs from the stored version,
        the write is refused and ``None`` is returned (caller maps to HTTP 409).
        Otherwise the row is written at ``stored_version + 1`` (or 1 for a new
        row) and the new version is returned. The read-check-write runs in one
        transaction.
        """
        from sqlalchemy import text

        payload = norms_file.model_dump_json()
        now = datetime.now(UTC)
        is_postgres = self.db_url.startswith("postgres")

        try:
            with self._sync_engine.begin() as conn:
                row = conn.execute(
                    text("SELECT version FROM norm_registry WHERE country = :country"),
                    {"country": country},
                ).fetchone()
                current = int(row[0]) if row is not None else 0

                if expected_version is not None and expected_version != current:
                    return None

                new_version = current + 1
                params = {
                    "country": country,
                    "data": payload,
                    "version": new_version,
                    "updated_at": now,
                }
                if row is not None:
                    conn.execute(
                        text(
                            "UPDATE norm_registry SET data = :data, version = :version, "
                            "updated_at = :updated_at WHERE country = :country"
                        ),
                        params,
                    )
                elif is_postgres:
                    conn.execute(
                        text(
                            "INSERT INTO norm_registry (country, data, version, updated_at) "
                            "VALUES (:country, :data, :version, :updated_at) "
                            "ON CONFLICT (country) DO UPDATE SET "
                            "data = EXCLUDED.data, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at"
                        ),
                        params,
                    )
                else:
                    conn.execute(
                        text(
                            "INSERT INTO norm_registry (country, data, version, updated_at) "
                            "VALUES (:country, :data, :version, :updated_at)"
                        ),
                        params,
                    )
            # Refresh the read memo in-process so this write is visible to the
            # next ``get_cached`` immediately (no TTL wait for same-process edits).
            with self._get_cache_lock:
                self._get_cache[country] = ((norms_file, new_version), time.monotonic())
            return new_version
        except Exception as e:
            logger.warning("Failed to write norm_registry for %s: %s", country, e)
            return None

    # -- seeding -------------------------------------------------------------

    def seed_from_yaml_if_empty(self, country: str = DEFAULT_COUNTRY) -> bool:
        """Seed the store from the YAML seed when no row exists yet (idempotent).

        Reads the YAML seed directly (``registry_yaml_files`` + yaml parse), NOT
        ``load_registry`` — the latter would consult this very store's db loader.
        Returns ``True`` when a seed was written, ``False`` when a row already
        existed or no seed is available.
        """
        existing, _ = self.get(country)
        if existing is not None:
            return False

        import yaml

        seed_file = next(
            (path for path in norm_registry.registry_yaml_files() if path.parent.name == country),
            None,
        )
        if seed_file is None:
            logger.warning("No YAML seed for country '%s' — norm store left empty", country)
            return False

        try:
            data = yaml.safe_load(seed_file.read_text(encoding="utf-8"))
            norms_file = NormsFile.model_validate(data)
        except Exception as e:
            logger.warning("Failed to parse norm seed %s (%s) — norm store left empty", seed_file, e)
            return False

        new_version = self.put(norms_file, country=country, expected_version=None)
        if new_version is None:
            return False
        logger.info("Seeded norm_registry for '%s' from %s (version %d)", country, seed_file, new_version)
        return True

    def clear_cache(self) -> None:
        """Drop the short-TTL read memo (invoked via ``reset_registry_cache`` on admin edits)."""
        with self._get_cache_lock:
            self._get_cache.clear()

    @classmethod
    def dispose_all_engines(cls):
        """Dispose all cached engines (for shutdown / test cleanup)."""
        with cls._cache_lock:
            for _key, (engine, _) in list(cls._sync_engine_cache.items()):
                try:
                    engine.dispose()
                except (RuntimeError, OSError):
                    pass
            cls._sync_engine_cache.clear()
            cls._tables_initialized.clear()


# ---------------------------------------------------------------------------
# Module-level singleton + configuration seam (mirrors factory.configure_summary_db).
# ---------------------------------------------------------------------------

_norm_store: NormRegistryStore | None = None


def get_norm_store() -> NormRegistryStore | None:
    """The configured store, or None when ``configure_norm_store`` was never called."""
    return _norm_store


def configure_norm_store(db_url: str) -> NormRegistryStore | None:
    """Build the store, seed it from YAML if empty, and register it with norm_registry.

    Registers ``norm_registry.set_db_loader(lambda: store.get()[0])`` wrapped
    fail-open so the registry hot path never breaks on a store error. Reuses the
    summary store's DB URL (see module docstring). Returns the store, or None if
    construction failed (fail-open — the YAML seed keeps working).
    """
    global _norm_store

    try:
        store = NormRegistryStore(db_url)
        store.seed_from_yaml_if_empty()
    except Exception as e:
        logger.warning("Failed to configure norm store (%s) — falling back to YAML seed", e)
        return None

    def _loader() -> NormsFile | None:
        try:
            return store.get_cached()[0]
        except Exception:  # noqa: BLE001 — the registry loader must never raise
            logger.warning("norm store loader failed — falling back to YAML seed", exc_info=True)
            return None

    norm_registry.set_db_loader(_loader, cache_reset=store.clear_cache)
    _norm_store = store
    logger.info("Norm store configured: %s", redact_db_url(db_url))
    return store

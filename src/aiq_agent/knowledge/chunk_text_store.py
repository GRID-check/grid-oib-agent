"""Chunk-text mirror backing the German sparse (lexical) retrieval channel.

One row per indexed chunk — ``(collection, chunk_id)`` — holding the chunk's raw
``body`` plus the lexical index over it. It is a MIRROR, never a source of truth:
``chunk_id`` is the llama-index node id Chroma already stores in its ``ids``, and
``body`` is what Chroma stores in ``documents``, so the mirror joins back to the
vector store exactly and can be bootstrapped from it with no re-ingest and no
re-embed (``scripts/backfill_chunk_text.py``).

WHY A SECOND STORE AT ALL
-------------------------
The lexical channel used to run Chroma ``where_document {"$contains": term}``.
That is a raw, case-sensitive, byte-level substring test: measured over 53 real
German questions from this repo it produced a term for 28.3% and a USEFUL term
for 9.4%, while a bare ``OIB`` term matched 467 of 490 chunks (95.3%) — a
near-no-op that RRF then fused into the results. Chroma has no lexical index and
cannot get one; Postgres already ships the ``german`` FTS config that solves
inflection, ß→ss, umlaut folding and hyphenated-token splitting, with no
extension (``postgres:16-alpine`` includes it). So the text is mirrored into the
knowledge database and searched there. Query construction — the DF ceiling that
makes an OR-of-lexemes selective, and the English-query behaviour — lives in
:mod:`aiq_agent.common.german_text`; this module only runs SQL.

DATABASE URL: NO NEW ENV VAR
----------------------------
Reuses the SAME database URL as the document metadata store (``AIQ_SUMMARY_DB``,
then ``NAT_JOB_STORE_DB_URL``, then the local SQLite default), for the reason
:mod:`aiq_agent.knowledge.norm_store` states: one knowledge database, no extra
env var, deployments configure one URL. The resolution order here is copied from
``knowledge.factory._get_document_metadata_store`` so an ingestion worker thread
that never ran the NAT registration lands in the SAME database as everything
else instead of a stray local SQLite file.

THE PORTABILITY SPLIT (Postgres real, SQLite degraded — both supported)
-----------------------------------------------------------------------
The repo default is SQLite (``sqlite+aiosqlite:///./summaries.db``); production
is Postgres. ``to_tsvector``/GIN/``ts_rank_cd`` do not exist in SQLite, so the
``tsv`` column means two different things and the dialect is chosen once, at
schema creation:

* **Postgres** — ``tsv tsvector GENERATED ALWAYS AS (to_tsvector('german', body))
  STORED`` with a GIN index. Real Snowball German stemming, real stopwords, real
  ``ts_rank_cd`` ranking, index-backed. Writers never touch ``tsv``: the column
  is derived, so a mirror row can never disagree with its own body.
* **SQLite** — ``tsv TEXT``, written by :meth:`upsert_many` as
  ``german_text.index_blob(body)``: the space-padded, folded, stemmed lexemes.
  Search is an OR of ``LIKE '% lexeme %'`` whole-lexeme tests, ranked by the
  summed inverse document frequency of the lexemes a row matches (the frequencies
  the DF ceiling already measured, so ranking costs no extra query).

  THE COST, stated plainly: (1) no index — it is a full scan of the collection,
  fine for a dev box or a small project collection, not for the 490-chunk-plus
  base corpus under load; (2) the stemmer is the small approximation in
  ``german_text.stem``, not Snowball, so ranking and a few edge inflections
  differ from production; (3) no phrase/proximity component and no document-length
  normalisation in the score, both of which ``ts_rank_cd`` has.
  FTS5 was NOT used: it would need a second, separately-maintained virtual table
  whose tokenizer still does not stem German, buying complexity without buying
  the thing that matters. The SQLite path exists so a SQLite deployment keeps
  working and so the tests can be real, offline and fast — not to be equal.

Nothing about either path is required for the system to work. EVERY method fails
open: a store outage, a missing table, a broken query, a schema that could not be
created — all degrade retrieval to vector-only and are logged, never raised.

Modeled on :mod:`aiq_agent.knowledge.document_metadata_store` (URL normalization,
TTL engine cache, lazy ``_ensure_schema`` guarded by ``_tables_initialized``,
fail-open ``try/except`` -> ``logger.warning``). Sync only, on purpose: both call
sites are synchronous — the ingestion worker thread that mirrors freshly indexed
chunks, and the retriever's lexical pass, which runs inside a sync method.
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
from collections.abc import Iterable
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from aiq_agent.common import german_text
from aiq_agent.common.db_utils import normalize_db_url as _normalize_db_url
from aiq_agent.common.db_utils import redact_db_url

logger = logging.getLogger(__name__)

ENGINE_CACHE_TTL_SECONDS = 3600
ENGINE_CACHE_MAX_SIZE = 10

TABLE_NAME = "chunk_text"
_TSV_INDEX_NAME = "idx_chunk_text_tsv"
_FILE_INDEX_NAME = "idx_chunk_text_collection_file"

#: The Postgres text-search configuration. German, and only German — see the
#: "ENGLISH QUERIES" section of ``german_text``: a second ``english`` column is
#: explicitly rejected, not merely absent.
FTS_CONFIG = "german"

#: Rows per INSERT batch. Matches the backfill's page size so a page maps to one
#: statement, and keeps the bound-parameter count well inside every driver limit.
UPSERT_BATCH_SIZE = 500

DEFAULT_SEARCH_LIMIT = 20

#: Default DB URL, identical to ``knowledge.factory._DEFAULT_METADATA_DB``.
_DEFAULT_DB_URL = "sqlite+aiosqlite:///./summaries.db"

# Every raw-SQL statement in this module interpolates ONLY trusted, code-defined
# SQL identifiers: the table/index name constants above, the ``FTS_CONFIG``
# literal, and generated bind-parameter NAMES (``:t0``, ``:t1``, …) whose count
# comes from the number of query lexemes. Every caller-supplied value —
# collection, chunk_id, body, file_name, the tsquery string, LIKE patterns — is
# always passed as a bound parameter and never interpolated. The interpolation is
# therefore not attacker-reachable, which is why each ``sqlalchemy.text()`` call
# carries a ``# nosemgrep: …avoid-sqlalchemy-text`` marker for the taint-based
# SAST rule.


@dataclass(frozen=True)
class ChunkTextRow:
    """One mirrored chunk. ``chunk_id`` is the llama-index node id Chroma uses."""

    chunk_id: str
    body: str
    file_name: str = ""
    page_label: str = ""


@dataclass(frozen=True)
class TermFrequencies:
    """Document frequencies of some lexemes within one collection.

    ``total`` is the collection's row count — the denominator the DF ceiling in
    ``german_text.select_terms`` divides by. Both are ZERO when the store is
    unavailable, which makes the ceiling a no-op and the search return nothing:
    the fail-open direction.
    """

    total: int = 0
    counts: dict[str, int] = field(default_factory=dict)


class ChunkTextStore:
    """SQLAlchemy-backed mirror of chunk text with a German lexical index.

    Features:
    - Automatic SQLite/PostgreSQL support based on ``db_url`` (see module docstring)
    - Sync engine with the same TTL-based cache as the document metadata store
    - Lazy schema creation, retried until it succeeds
    - Fail-open on every path: retrieval degrades to vector-only, never breaks
    """

    _sync_engine_cache: dict[str, tuple[Any, float]] = {}
    _cache_lock = threading.Lock()
    _tables_initialized: set[str] = set()

    def __init__(self, db_url: str):
        self.db_url = db_url
        self._sync_engine = self._get_or_create_sync_engine(db_url)
        self._ensure_schema()
        logger.info("ChunkTextStore initialized: %s", redact_db_url(db_url))

    # ------------------------------------------------------------------
    # Engine cache (same shape as DocumentMetadataStore)
    # ------------------------------------------------------------------

    @classmethod
    def _get_or_create_sync_engine(cls, db_url: str):
        """Get or create a sync SQLAlchemy engine, or ``None`` when the URL is unusable.

        Returns ``None`` rather than raising, because CONSTRUCTION is on the same
        fail-open contract as every query: a deployment that mis-spells the
        knowledge-database URL, or whose driver package is missing, must lose the
        lexical channel and keep retrieval — not crash the ingestion worker at
        import time. Only a genuinely unusable URL lands here (an unparsable DSN,
        an unknown dialect); a reachable-but-down database still yields an engine,
        because SQLAlchemy connects lazily, and fails open later at ``connect()``.
        A failure is deliberately NOT cached, so a transient import error is
        retried by the next caller instead of poisoning the process.
        """
        with cls._cache_lock:
            cls._cleanup_stale_engines(cls._sync_engine_cache)

            if db_url in cls._sync_engine_cache:
                engine, _ = cls._sync_engine_cache[db_url]
                cls._sync_engine_cache[db_url] = (engine, time.monotonic())
                return engine

            from sqlalchemy import create_engine

            try:
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
            except Exception as e:  # noqa: BLE001 — a bad URL must not break the caller
                logger.warning("Could not create chunk text engine for %s: %s", redact_db_url(db_url), e)
                return None
            cls._sync_engine_cache[db_url] = (engine, time.monotonic())
            logger.debug("Created sync engine for %s", redact_db_url(db_url))
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
                except Exception as e:  # noqa: BLE001 — disposal must never break a caller
                    logger.warning("Failed to dispose engine: %s", e)

        if len(cache) > ENGINE_CACHE_MAX_SIZE:
            sorted_entries = sorted(cache.items(), key=lambda item: item[1][1])
            for key, (engine, _) in sorted_entries[: len(sorted_entries) - ENGINE_CACHE_MAX_SIZE]:
                cache.pop(key, None)
                if engine:
                    try:
                        engine.dispose()
                    except (RuntimeError, OSError):
                        pass

    @classmethod
    def dispose_all_engines(cls):
        """Dispose all cached engines (for shutdown and tests)."""
        with cls._cache_lock:
            for engine, _ in list(cls._sync_engine_cache.values()):
                try:
                    engine.dispose()
                except (RuntimeError, OSError):
                    pass
            cls._sync_engine_cache.clear()
            cls._tables_initialized.clear()

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    def _is_postgres(self) -> bool:
        return self.db_url.startswith("postgres")

    def _ensure_schema(self) -> None:
        """Create the table and indexes if needed (sync, fail-open).

        A FAILED creation is deliberately not cached as initialized, so the next
        call retries instead of running every query against a missing table.
        """
        if self._sync_engine is None:
            return
        with ChunkTextStore._cache_lock:
            if self.db_url in ChunkTextStore._tables_initialized:
                return

            created = False
            try:
                with self._sync_engine.connect() as conn:
                    created = self._run_schema(conn)
                    conn.commit()
            except Exception as e:  # noqa: BLE001 — a store outage must not break ingestion
                logger.warning("Failed to ensure chunk_text schema: %s", e)

            if created:
                ChunkTextStore._tables_initialized.add(self.db_url)

    def _run_schema(self, conn) -> bool:
        """Create table + indexes over a live connection (caller commits)."""
        from sqlalchemy import text

        try:
            if self._is_postgres():
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"CREATE TABLE IF NOT EXISTS {TABLE_NAME} ("
                        "collection VARCHAR(256) NOT NULL, "
                        "chunk_id VARCHAR(256) NOT NULL, "
                        "file_name VARCHAR(512), "
                        "page_label VARCHAR(64), "
                        "body TEXT NOT NULL, "
                        # Generated, so a row's index can never disagree with its
                        # own body. The two-argument to_tsvector with a constant
                        # config is IMMUTABLE, which a generated column requires.
                        f"tsv tsvector GENERATED ALWAYS AS (to_tsvector('{FTS_CONFIG}', body)) STORED, "
                        "PRIMARY KEY (collection, chunk_id))"
                    )
                )
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"CREATE INDEX IF NOT EXISTS {_TSV_INDEX_NAME} ON {TABLE_NAME} USING GIN (tsv)")
                )
            else:
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"CREATE TABLE IF NOT EXISTS {TABLE_NAME} ("
                        "collection VARCHAR(256) NOT NULL, "
                        "chunk_id VARCHAR(256) NOT NULL, "
                        "file_name VARCHAR(512), "
                        "page_label VARCHAR(64), "
                        "body TEXT NOT NULL, "
                        # Python-analyzed lexemes; written by upsert_many because
                        # SQLite has no to_tsvector to generate them from.
                        "tsv TEXT NOT NULL DEFAULT '', "
                        "PRIMARY KEY (collection, chunk_id))"
                    )
                )
            conn.execute(
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"CREATE INDEX IF NOT EXISTS {_FILE_INDEX_NAME} ON {TABLE_NAME} (collection, file_name)")
            )
            return True
        except Exception as e:  # noqa: BLE001 — see _ensure_schema
            logger.warning("Failed to create chunk_text schema: %s", e)
            return False

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    @staticmethod
    def _coerce_row(row: ChunkTextRow | Mapping[str, Any]) -> ChunkTextRow | None:
        """Accept a row object or a plain mapping; ``None`` when unusable.

        Fail-soft per row on purpose: the ingestion mirror and the backfill both
        feed this from foreign data (Chroma metadatas), where one malformed entry
        must not cost the whole batch.
        """
        if isinstance(row, ChunkTextRow):
            source: Mapping[str, Any] = {
                "chunk_id": row.chunk_id,
                "body": row.body,
                "file_name": row.file_name,
                "page_label": row.page_label,
            }
        elif isinstance(row, Mapping):
            source = row
        else:
            return None
        # Coerced through ``str`` even for a ChunkTextRow: the dataclass annotates
        # ``str`` but cannot enforce it, and both feeds are foreign data (Chroma
        # metadatas), where a ``None`` page_label or an int chunk id is routine.
        candidate = ChunkTextRow(
            chunk_id=str(source.get("chunk_id") or ""),
            body=str(source.get("body") or ""),
            file_name=str(source.get("file_name") or ""),
            page_label=str(source.get("page_label") or ""),
        )
        if not candidate.chunk_id or not candidate.body.strip():
            return None
        return candidate

    def upsert_many(self, collection: str, rows: Iterable[ChunkTextRow | Mapping[str, Any]]) -> int:
        """Insert-or-replace mirror rows; returns how many were written.

        Idempotent by primary key ``(collection, chunk_id)`` — re-mirroring the
        same chunks overwrites them in place, which is what makes both a
        re-ingest and a repeated backfill safe. Rows with no id or no body are
        skipped (a chunk with no text has nothing to index).
        """
        if not collection or not rows or self._sync_engine is None:
            return 0
        try:
            prepared = [row for row in (self._coerce_row(raw) for raw in rows) if row is not None]
        except TypeError as e:
            # ``rows`` was not iterable at all. Same fail-open contract as a store
            # outage: a malformed caller loses the mirror, not the ingestion run.
            logger.warning("Chunk text rows for %s were not iterable: %s", collection, e)
            return 0
        if not prepared:
            return 0

        from sqlalchemy import text

        self._ensure_schema()
        is_postgres = self._is_postgres()
        if is_postgres:
            # Interpolates only TABLE_NAME, a module constant — never caller input. Every
            # value is a bound parameter. The suppression sits on the `text(` line because
            # that is the line semgrep reports; inside the call it is not seen.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            statement = text(
                f"INSERT INTO {TABLE_NAME} (collection, chunk_id, file_name, page_label, body) "
                "VALUES (:collection, :chunk_id, :file_name, :page_label, :body) "
                "ON CONFLICT (collection, chunk_id) DO UPDATE SET "
                "file_name = EXCLUDED.file_name, page_label = EXCLUDED.page_label, body = EXCLUDED.body"
            )
        else:
            # Interpolates only TABLE_NAME, a module constant — never caller input. Every
            # value is a bound parameter. The suppression sits on the `text(` line because
            # that is the line semgrep reports; inside the call it is not seen.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            statement = text(
                f"INSERT OR REPLACE INTO {TABLE_NAME} (collection, chunk_id, file_name, page_label, body, tsv) "
                "VALUES (:collection, :chunk_id, :file_name, :page_label, :body, :tsv)"
            )

        written = 0
        try:
            with self._sync_engine.connect() as conn:
                for start in range(0, len(prepared), UPSERT_BATCH_SIZE):
                    batch = prepared[start : start + UPSERT_BATCH_SIZE]
                    payload = []
                    for row in batch:
                        values: dict[str, Any] = {
                            "collection": collection,
                            "chunk_id": row.chunk_id,
                            "file_name": row.file_name,
                            "page_label": row.page_label,
                            "body": row.body,
                        }
                        if not is_postgres:
                            values["tsv"] = german_text.index_blob(row.body)
                        payload.append(values)
                    result = conn.execute(statement, payload)
                    rowcount = result.rowcount or 0
                    # executemany rowcount is driver-dependent (-1 on some); the
                    # batch length is the truthful count when it is unavailable.
                    written += rowcount if rowcount > 0 else len(batch)
                conn.commit()
        except Exception as e:  # noqa: BLE001 — the mirror is an enhancement, never a gate
            logger.warning("Failed to upsert chunk text for %s: %s", collection, e)
            return 0
        logger.debug("Mirrored %d chunk(s) into %s for %s", written, TABLE_NAME, collection)
        return written

    def delete_by_file(self, collection: str, file_name: str) -> int:
        """Remove every mirrored chunk of one file IN ONE collection.

        Scoped by collection on purpose: the same ``file_name`` legitimately
        exists in several collections (the base corpus and a project upload), and
        deleting a project's copy must not blind the base corpus.
        """
        if not collection or not file_name:
            return 0
        return self._delete(
            f"DELETE FROM {TABLE_NAME} WHERE collection = :collection AND file_name = :file_name",
            {"collection": collection, "file_name": file_name},
            f"chunk text for {file_name} in {collection}",
        )

    def delete_collection(self, collection: str) -> int:
        """Remove every mirrored chunk of a collection (collection deleted)."""
        if not collection:
            return 0
        return self._delete(
            f"DELETE FROM {TABLE_NAME} WHERE collection = :collection",
            {"collection": collection},
            f"chunk text for collection {collection}",
        )

    def _delete(self, statement: str, params: dict[str, Any], description: str) -> int:
        from sqlalchemy import text

        if self._sync_engine is None:
            return 0
        self._ensure_schema()
        try:
            with self._sync_engine.connect() as conn:
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                result = conn.execute(text(statement), params)
                conn.commit()
                deleted = result.rowcount or 0
                logger.debug("Deleted %d row(s): %s", deleted, description)
                return deleted
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to delete %s: %s", description, e)
            return 0

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def count(self, collection: str) -> int:
        """Number of mirrored chunks in a collection (0 when unavailable).

        The backfill uses this both for idempotence ("already mirrored, skip")
        and to verify its writes landed.
        """
        if not collection or self._sync_engine is None:
            return 0
        from sqlalchemy import text

        self._ensure_schema()
        try:
            with self._sync_engine.connect() as conn:
                result = conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"SELECT count(*) FROM {TABLE_NAME} WHERE collection = :collection"),
                    {"collection": collection},
                )
                row = result.first()
                return int(row[0]) if row else 0
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to count chunk text for %s: %s", collection, e)
            return 0

    def document_frequencies(self, collection: str, terms: Sequence[str]) -> TermFrequencies:
        """How many chunks of ``collection`` each term occurs in, plus the total.

        This is the measurement the DF ceiling needs (see
        ``german_text.select_terms``): the ceiling is a property of THIS corpus,
        so it is measured against it rather than approximated by a stopword list.

        One statement, one pass: a ``SUM(CASE WHEN … )`` per term alongside the
        ``count(*)``, so a query's worth of lexemes costs one round trip rather
        than one per lexeme on the retrieval hot path. Returns an empty result
        (``total=0``) on any failure, which silences the channel.
        """
        empty = TermFrequencies()
        if not collection or not terms or self._sync_engine is None:
            return empty

        from sqlalchemy import text

        self._ensure_schema()
        unique = list(dict.fromkeys(term for term in terms if term))
        if not unique:
            return empty

        params: dict[str, Any] = {"collection": collection}
        projections: list[str] = []
        for index, term in enumerate(unique):
            name = f"t{index}"
            if self._is_postgres():
                params[name] = term
                condition = f"tsv @@ to_tsquery('{FTS_CONFIG}', :{name})"
            else:
                params[name] = german_text.like_pattern(term)
                condition = f"tsv LIKE :{name}"
            projections.append(f"SUM(CASE WHEN {condition} THEN 1 ELSE 0 END)")

        statement = f"SELECT count(*), {', '.join(projections)} FROM {TABLE_NAME} WHERE collection = :collection"
        try:
            with self._sync_engine.connect() as conn:
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                row = conn.execute(text(statement), params).first()
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to measure document frequencies for %s: %s", collection, e)
            return empty
        if not row:
            return empty
        counts = {term: int(row[index + 1] or 0) for index, term in enumerate(unique)}
        return TermFrequencies(total=int(row[0] or 0), counts=counts)

    def search(
        self,
        collection: str,
        query: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        *,
        extra_terms: Sequence[str] = (),
        df_ceiling_ratio: float = german_text.DEFAULT_DF_CEILING_RATIO,
        df_ceiling_min_total: int = german_text.DEFAULT_DF_CEILING_MIN_TOTAL,
    ) -> list[str]:
        """Chunk ids matching ``query`` lexically, best first (never raises).

        Pipeline: candidate lexemes -> measured document frequencies -> DF
        ceiling -> ranked SQL. An EMPTY list is a normal outcome and means "no
        usable lexical signal": a question whose only shared vocabulary is the
        95%-frequent ``OIB``, or (by construction) an English question against
        this German index. The caller must treat it as "vector-only", never as an
        error — this channel is an enhancement, never a gate.

        ``extra_terms`` is the cross-lingual seam: German terms produced by a
        caller-side glossary for a non-German query, merged ahead of the query's
        own tokens (see ``german_text``). This module does not translate.
        """
        if not collection or not query or limit <= 0:
            return []
        try:
            if self._is_postgres():
                candidates = german_text.query_terms(query, extra_terms=extra_terms)
            else:
                candidates = german_text.analyze_query(query, extra_terms=extra_terms)
            if not candidates:
                return []

            frequencies = self.document_frequencies(collection, candidates)
            kept = german_text.select_terms(
                candidates,
                frequencies.counts,
                frequencies.total,
                df_ceiling_ratio=df_ceiling_ratio,
                min_total=df_ceiling_min_total,
            )
            if not kept:
                logger.debug(
                    "Lexical channel silent for %s: no lexeme of %s survived the DF ceiling "
                    "(total=%d) — degrading to vector-only",
                    collection,
                    candidates,
                    frequencies.total,
                )
                return []
            if self._sync_engine is None:
                # The same guard every other public method carries. Without it the
                # AttributeError below is caught and logged as "Lexical chunk-text search
                # failed" on every single query, which reads as a fault rather than as an
                # unconfigured optional channel.
                return []
            return self._search_terms(collection, kept, limit, frequencies)
        except Exception as e:  # noqa: BLE001 — retrieval must never break on the lexical channel
            logger.warning("Lexical chunk-text search failed for %s: %s", collection, e)
            return []

    def _search_terms(
        self,
        collection: str,
        terms: list[str],
        limit: int,
        frequencies: TermFrequencies,
    ) -> list[str]:
        """Run the ranked lexical query for already-filtered lexemes."""
        from sqlalchemy import text

        params: dict[str, Any] = {"collection": collection, "limit": limit}
        if self._is_postgres():
            params["tsquery"] = german_text.build_tsquery(terms)
            statement = (
                f"SELECT chunk_id FROM {TABLE_NAME} "
                "WHERE collection = :collection "
                f"AND tsv @@ to_tsquery('{FTS_CONFIG}', :tsquery) "
                f"ORDER BY ts_rank_cd(tsv, to_tsquery('{FTS_CONFIG}', :tsquery)) DESC, chunk_id "
                "LIMIT :limit"
            )
        else:
            # Rank by the summed INVERSE DOCUMENT FREQUENCY of the query lexemes a
            # row matches, not by how many it matches. The frequencies are already
            # in hand — ``search`` measured them for the DF ceiling — so this costs
            # no extra round trip, and it is the one part of ``ts_rank_cd`` worth
            # imitating: a row carrying the rare ``treppenlaufbreit`` must outrank
            # one carrying two common lexemes. Measured over the 776-page corpus
            # with 25 real German questions, this moved top-1 from 11/25 to 16/25
            # and top-3 from 15/25 to 19/25 against the plain hit count.
            #
            # Weights are BOUND parameters, never interpolated, so the statement
            # text stays free of computed values. Ties break on ``chunk_id`` so the
            # order is deterministic across runs.
            conditions: list[str] = []
            weighted: list[str] = []
            for index, term in enumerate(terms):
                params[f"t{index}"] = german_text.like_pattern(term)
                params[f"w{index}"] = self._idf(frequencies, term)
                condition = f"tsv LIKE :t{index}"
                conditions.append(condition)
                weighted.append(f"CASE WHEN {condition} THEN :w{index} ELSE 0 END")
            statement = (
                f"SELECT chunk_id, ({' + '.join(weighted)}) AS score FROM {TABLE_NAME} "
                "WHERE collection = :collection "
                f"AND ({' OR '.join(conditions)}) "
                "ORDER BY score DESC, chunk_id LIMIT :limit"
            )

        with self._sync_engine.connect() as conn:
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            rows = conn.execute(text(statement), params).fetchall()
        return [row[0] for row in rows]

    @staticmethod
    def _idf(frequencies: TermFrequencies, term: str) -> float:
        """Inverse document frequency of one lexeme, for the SQLite ranking.

        ``log(1 + total/df)``: strictly positive (so a matched lexeme can never
        subtract), and monotonically decreasing in ``df``. A term the caller never
        measured, or one measured at zero, is treated as maximally rare — the DF
        ceiling has already removed every ``df == 0`` term before this is reached,
        so the clamp only guards against a caller passing terms it did not measure.
        """
        total = max(frequencies.total, 1)
        frequency = max(frequencies.counts.get(term, 0), 1)
        return math.log(1.0 + total / frequency)


# ---------------------------------------------------------------------------
# Process-wide accessor. Mirrors knowledge.factory's lazy store init (double
# checked under a lock, same env precedence) so the ingestion worker thread and
# the retriever share one engine cache and one database.
# ---------------------------------------------------------------------------

_chunk_text_store: ChunkTextStore | None = None
_chunk_text_store_lock = threading.Lock()


def configure_chunk_text_store(db_url: str) -> ChunkTextStore:
    """Point the process-wide store at ``db_url`` (the NAT registration seam)."""
    global _chunk_text_store
    with _chunk_text_store_lock:
        _chunk_text_store = ChunkTextStore(db_url)
    logger.info("Chunk text store configured: %s", redact_db_url(db_url))
    return _chunk_text_store


def get_chunk_text_store() -> ChunkTextStore:
    """The process-wide store, lazily built from the environment.

    Same URL resolution as ``knowledge.factory._get_document_metadata_store``:
    ``AIQ_SUMMARY_DB`` -> ``NAT_JOB_STORE_DB_URL`` -> local SQLite. NO new env
    var (see the module docstring), so a container that only sets the one
    knowledge-database URL gets the mirror in the same place as the summaries.
    """
    global _chunk_text_store
    if _chunk_text_store is None:
        with _chunk_text_store_lock:
            if _chunk_text_store is None:
                db_url = os.environ.get("AIQ_SUMMARY_DB") or os.environ.get("NAT_JOB_STORE_DB_URL") or _DEFAULT_DB_URL
                _chunk_text_store = ChunkTextStore(db_url)
                logger.info("Chunk text store initialized (lazy env fallback): %s", redact_db_url(db_url))
    return _chunk_text_store


def reset_chunk_text_store() -> None:
    """Drop the process-wide store (tests, and after a URL change)."""
    global _chunk_text_store
    with _chunk_text_store_lock:
        _chunk_text_store = None

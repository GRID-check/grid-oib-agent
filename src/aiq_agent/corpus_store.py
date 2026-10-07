"""The base corpus in the object store, with the upload directory as a local cache (ADR-0082, step A2).

Admin-uploaded base-corpus PDFs used to live on one replica's disk, together with
the sync registry and the exclusion list, so an upload reached the replica that
accepted it and nobody else. ``GRID_BASE_CORPUS_STORE=object`` moves the source
of record off the replica:

* the PDFs are objects in SeaweedFS (``base-corpus/<file name>`` in
  ``SEAWEED_BUCKET``), listed by the ``oib_corpus_files`` table;
* the registry and the exclusion list are the ``oib_corpus_registry`` and
  ``oib_corpus_excluded`` tables, in the knowledge database (``AIQ_SUMMARY_DB``);
* ``OIB_UPLOADS_DIR`` stays, as a CACHE of the table. Everything that wants a
  path (hashing, ``ingestor.upload_file(path)``, ``FileResponse``, ``rglob``)
  keeps getting one, and the registry keys, which are absolute paths under that
  directory, stay what they were, so nothing re-ingests because of the move.

``disk`` (the default) leaves all of this unused: ``object_mode()`` is the one
switch, and ``oib_sync`` branches on it once, at the seam.

WHO WRITES WHAT. The backend holds a read-only object credential
(``aiq_agent.common.seaweed_s3``), so it reads objects itself and asks the BFF to
write them: ``POST /api/internal/base-corpus/upload-url`` returns a presigned PUT,
``DELETE /api/internal/base-corpus/<name>`` removes the object. Same internal
channel and token header as ``knowledge_layer.llamaindex.image_store``. A
presigned URL is a live bearer credential and is never logged, nor is any
exception text that could carry it.

THE CACHE IS CHECKED, NOT TRUSTED. A file counts as present when its sha256
matches the table row (hashes are memoised by size and mtime, so a check is a
``stat``). A download goes to a temp file beside its target, is verified against
the row, and only then renamed into place, so a reader never sees a partial or
mismatched PDF.

NEVER DELETE ON A GUESS. :func:`pull` reads the table before it touches the
disk, and only removes a local PDF the table does not list; a table that cannot
be read raises and removes nothing. :func:`migrate_once` runs first on every
replica so the PDFs already on a per-replica volume are in the table before the
cache is made to match it.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import os
import tempfile
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from typing import BinaryIO
from urllib.parse import quote

import httpx
from sqlalchemy import BigInteger
from sqlalchemy import Column
from sqlalchemy import DateTime
from sqlalchemy import MetaData
from sqlalchemy import Table
from sqlalchemy import Text
from sqlalchemy import bindparam
from sqlalchemy import delete
from sqlalchemy import func
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects import sqlite
from sqlalchemy.schema import CreateTable

from aiq_agent.common import seaweed_s3
from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.leader_lock import keyed_lock

logger = logging.getLogger(__name__)

STORE_ENV = "GRID_BASE_CORPUS_STORE"
MODE_OBJECT = "object"
MODE_DISK = "disk"

#: Reserved registry key: the chunk-format stamp ``oib_sync`` keeps beside the hashes.
FORMAT_KEY = "__chunk_format_version__"

#: Written into the cache directory once a replica's local files are in the store.
MIGRATION_MARKER = ".object-store-migrated"

_KEY_PREFIX = "base-corpus/"
_UPLOAD_URL_PATH = "/api/internal/base-corpus/upload-url"
_DELETE_PATH = "/api/internal/base-corpus/"
_FRONTEND_INTERNAL_URL_ENV = "FRONTEND_INTERNAL_URL"
_INTERNAL_TOKEN_ENV = "GRID_INTERNAL_API_TOKEN"
_BFF_TIMEOUT_SECONDS = 15.0
_PUT_TIMEOUT_SECONDS = 300.0
_CHUNK_BYTES = 1024 * 1024

_metadata = MetaData()
_files = Table(
    "oib_corpus_files",
    _metadata,
    Column("file_name", Text, primary_key=True),
    Column("storage_key", Text, nullable=False),
    Column("sha256", Text, nullable=False),
    Column("size_bytes", BigInteger, nullable=False),
    Column("uploaded_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
)
_registry = Table(
    "oib_corpus_registry",
    _metadata,
    Column("doc_key", Text, primary_key=True),
    Column("value", Text, nullable=False),
)
_excluded = Table("oib_corpus_excluded", _metadata, Column("file_name", Text, primary_key=True))

_initialized: set[str] = set()
_INIT_LOCK = threading.Lock()

#: Serialises "a row appears or goes + the cache file follows" against the drop
#: of unlisted cache files, so a pull that read the table before an upload
#: cannot delete the file the upload has just written.
_CACHE_LOCK = threading.Lock()
_MIGRATION_LOCK = threading.Lock()

# sha256 of a cache file keyed by path, valid while (size, mtime_ns) hold.
_SHA_CACHE: dict[str, tuple[int, int, str]] = {}
_SHA_LOCK = threading.Lock()


class CorpusStoreError(RuntimeError):
    """The object store, the BFF or the corpus tables could not do what was asked.

    The message is safe to show an admin: it never carries a URL or credential.
    """


@dataclass(frozen=True)
class FileRow:
    """One corpus PDF as the table records it."""

    file_name: str
    storage_key: str
    sha256: str
    size_bytes: int


# ----------------------------------------------------------------------------
# Mode and small helpers
# ----------------------------------------------------------------------------


def object_mode() -> bool:
    """True when the object store is the source of record for the base corpus."""
    return os.environ.get(STORE_ENV, MODE_DISK).strip().lower() == MODE_OBJECT


def default_cache_dir() -> Path:
    """``OIB_UPLOADS_DIR``, for callers that do not hold ``oib_sync``'s own constant."""
    return Path(os.environ.get("OIB_UPLOADS_DIR", "data/oib_uploads"))


def shared_lock(key: str):
    """A lock on ``key`` across every replica in object mode; a no-op context in disk mode."""
    return keyed_lock(key) if object_mode() else contextlib.nullcontext()


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8192), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _local_sha(path: Path) -> str | None:
    """sha256 of ``path``, or ``None`` when it is not a file. Memoised by size and mtime."""
    try:
        stat = path.stat()
    except OSError:
        return None
    key = str(path)
    with _SHA_LOCK:
        cached = _SHA_CACHE.get(key)
    if cached is not None and cached[0] == stat.st_size and cached[1] == stat.st_mtime_ns:
        return cached[2]
    digest = sha256_file(path)
    with _SHA_LOCK:
        _SHA_CACHE[key] = (stat.st_size, stat.st_mtime_ns, digest)
    return digest


def _valid_name(name: str) -> bool:
    return bool(name) and Path(name).name == name and name.lower().endswith(".pdf")


def _require_name(name: str) -> None:
    if not _valid_name(name):
        raise CorpusStoreError(f"not a corpus file name: {name!r}")


# ----------------------------------------------------------------------------
# Tables
# ----------------------------------------------------------------------------


def _db_url() -> str:
    url = os.environ.get("AIQ_SUMMARY_DB") or os.environ.get("NAT_JOB_STORE_DB_URL")
    if not url:
        # A silent fall back to a local SQLite file would bring back exactly the
        # per-replica state this mode exists to remove.
        raise CorpusStoreError(f"{STORE_ENV}=object needs AIQ_SUMMARY_DB (the shared knowledge database)")
    return url


def _create_tables(url: str) -> None:
    with DocumentMetadataStore._get_or_create_sync_engine(url).begin() as conn:
        for table in (_files, _registry, _excluded):
            conn.execute(CreateTable(table, if_not_exists=True))


def _ensure_tables(url: str) -> None:
    with _INIT_LOCK:
        if url in _initialized:
            return
        _create_tables(url)
        _initialized.add(url)


@contextlib.contextmanager
def _transaction():
    """A connection on the corpus tables, committed when the block ends."""
    url = _db_url()
    _ensure_tables(url)
    with DocumentMetadataStore._get_or_create_sync_engine(url).begin() as conn:
        yield conn


def _insert(conn, table):
    """The dialect's INSERT, the only construct that has ``ON CONFLICT``."""
    return (postgresql.insert if conn.dialect.name == "postgresql" else sqlite.insert)(table)


def _row_from(record) -> FileRow:
    return FileRow(record.file_name, record.storage_key, record.sha256, int(record.size_bytes))


def list_files() -> dict[str, FileRow]:
    """Every corpus PDF the table lists, by file name."""
    with _transaction() as conn:
        return {record.file_name: _row_from(record) for record in conn.execute(select(_files))}


def get_file(name: str) -> FileRow | None:
    with _transaction() as conn:
        record = conn.execute(select(_files).where(_files.c.file_name == name)).first()
    return _row_from(record) if record is not None else None


def _upsert_file(row: FileRow) -> None:
    values = {
        "file_name": row.file_name,
        "storage_key": row.storage_key,
        "sha256": row.sha256,
        "size_bytes": row.size_bytes,
    }
    with _transaction() as conn:
        statement = _insert(conn, _files).values(**values)
        conn.execute(
            statement.on_conflict_do_update(
                index_elements=[_files.c.file_name],
                set_={**{k: v for k, v in values.items() if k != "file_name"}, "uploaded_at": func.now()},
            )
        )


def _delete_file_row(name: str) -> None:
    with _transaction() as conn:
        conn.execute(delete(_files).where(_files.c.file_name == name))


# -- registry and exclusions: the JSON files' twins ---------------------------


def load_registry() -> dict[str, Any]:
    """The sync registry, as ``oib_sync`` keeps it: ``{path: sha256}`` plus the format stamp (an int)."""
    with _transaction() as conn:
        rows = {record.doc_key: record.value for record in conn.execute(select(_registry))}
    stamp = rows.get(FORMAT_KEY)
    if stamp is not None:
        rows[FORMAT_KEY] = int(stamp) if stamp.lstrip("-").isdigit() else stamp
    return rows


def _replace_keys(conn, table, column, wanted: dict[str, dict[str, Any]], current: set[str]) -> None:
    """Delete the rows ``wanted`` no longer names and upsert the ones it does."""
    stale = [{"k": key} for key in current - wanted.keys()]
    if stale:
        conn.execute(delete(table).where(column == bindparam("k")), stale)
    for key, values in wanted.items():
        statement = _insert(conn, table).values(**{column.key: key}, **values)
        if values:
            statement = statement.on_conflict_do_update(index_elements=[column], set_=values)
        else:
            statement = statement.on_conflict_do_nothing(index_elements=[column])
        conn.execute(statement)


def save_registry(registry: dict[str, Any]) -> None:
    """Make the table equal ``registry``. Callers hold the registry lock and reload inside it."""
    wanted = {key: {"value": str(value)} for key, value in registry.items()}
    with _transaction() as conn:
        current = {record.doc_key for record in conn.execute(select(_registry.c.doc_key))}
        _replace_keys(conn, _registry, _registry.c.doc_key, wanted, current)


def load_excluded() -> set[str]:
    with _transaction() as conn:
        return {record.file_name for record in conn.execute(select(_excluded))}


def save_excluded(names: set[str]) -> None:
    """Make the table equal ``names``. Callers hold the exclusion lock and reload inside it."""
    with _transaction() as conn:
        current = {record.file_name for record in conn.execute(select(_excluded.c.file_name))}
        _replace_keys(conn, _excluded, _excluded.c.file_name, {name: {} for name in names}, current)


# ----------------------------------------------------------------------------
# BFF writes and object-store reads. Module-level so a test can replace each.
# ----------------------------------------------------------------------------


def _bff() -> tuple[str, dict[str, str]]:
    base_url = os.environ.get(_FRONTEND_INTERNAL_URL_ENV, "").strip()
    token = os.environ.get(_INTERNAL_TOKEN_ENV, "").strip()
    if not base_url or not token:
        raise CorpusStoreError(f"{_FRONTEND_INTERNAL_URL_ENV} and {_INTERNAL_TOKEN_ENV} are needed to write the corpus")
    return base_url.rstrip("/"), {"x-grid-internal-token": token}


def _request_upload_url(name: str) -> tuple[str, str]:
    """``(presigned PUT url, storage key)`` for ``name``, from the BFF."""
    base_url, headers = _bff()
    try:
        response = httpx.post(
            f"{base_url}{_UPLOAD_URL_PATH}", json={"fileName": name}, headers=headers, timeout=_BFF_TIMEOUT_SECONDS
        )
        data = response.json() if response.status_code == 200 else {}
    except (httpx.HTTPError, ValueError) as e:
        # Class name only: an httpx error's text embeds the request URL.
        raise CorpusStoreError(f"upload-url request for {name} failed: {type(e).__name__}") from e
    if response.status_code != 200:
        raise CorpusStoreError(f"upload-url request for {name} was refused (HTTP {response.status_code})")
    upload_url, storage_key = data.get("uploadUrl"), data.get("storageKey")
    if not isinstance(upload_url, str) or not upload_url or not isinstance(storage_key, str) or not storage_key:
        raise CorpusStoreError(f"upload-url answer for {name} was malformed")
    return upload_url, storage_key


def _put_object(upload_url: str, data: bytes) -> None:
    try:
        response = httpx.put(
            upload_url, content=data, headers={"Content-Type": "application/pdf"}, timeout=_PUT_TIMEOUT_SECONDS
        )
    except httpx.HTTPError as e:
        raise CorpusStoreError(f"upload to the object store failed: {type(e).__name__}") from e
    if response.status_code >= 300:
        raise CorpusStoreError(f"upload to the object store was refused (HTTP {response.status_code})")


def _delete_object(name: str) -> None:
    base_url, headers = _bff()
    try:
        # Encoded exactly once: the BFF's router decodes the path parameter once.
        response = httpx.delete(
            f"{base_url}{_DELETE_PATH}{quote(name, safe='')}", headers=headers, timeout=_BFF_TIMEOUT_SECONDS
        )
    except httpx.HTTPError as e:
        raise CorpusStoreError(f"delete of {name} from the object store failed: {type(e).__name__}") from e
    if response.status_code != 200:
        raise CorpusStoreError(f"delete of {name} from the object store was refused (HTTP {response.status_code})")


def _copy_body(body, out: BinaryIO) -> None:
    with contextlib.closing(body):
        for chunk in iter(lambda: body.read(_CHUNK_BYTES), b""):
            out.write(chunk)


def _download_object(storage_key: str, out: BinaryIO) -> None:
    """Stream ``storage_key`` from the shared bucket into ``out`` on the backend's read credential."""
    try:
        client = seaweed_s3.s3_client()
        if client is None:
            raise CorpusStoreError("SeaweedFS read credentials (SEAWEED_*) are not configured")
        _copy_body(client.get_object(Bucket=seaweed_s3.default_bucket(), Key=storage_key)["Body"], out)
    except CorpusStoreError:
        raise
    except Exception as e:  # noqa: BLE001 - botocore raises many types; the caller needs one
        raise CorpusStoreError(f"download of {storage_key} failed: {type(e).__name__}") from e


# ----------------------------------------------------------------------------
# The cache
# ----------------------------------------------------------------------------


def _write_cache(path: Path, data: bytes) -> Path:
    """Write ``data`` to ``path`` through a temp file, so a reader never sees half of it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".", suffix=".part")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return path


def _matches(path: Path, row: FileRow) -> bool:
    return _local_sha(path) == row.sha256


def _download_verified(row: FileRow, dest: Path) -> None:
    with dest.open("wb") as out:
        _download_object(row.storage_key, out)
    digest = sha256_file(dest)
    if digest != row.sha256:
        raise CorpusStoreError(f"{row.file_name} in the object store does not match its recorded hash")


def _fetch(row: FileRow, target: Path) -> bool:
    """Download ``row`` into ``target``, verified, then renamed into place. False on failure."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".", suffix=".part")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        _download_verified(row, tmp)
        os.replace(tmp, target)
    except (CorpusStoreError, OSError):
        logger.warning("Could not fetch base-corpus file %s into the cache", row.file_name, exc_info=True)
        return False
    finally:
        tmp.unlink(missing_ok=True)
    logger.info("Fetched base-corpus file %s into the cache (%d bytes)", row.file_name, row.size_bytes)
    return True


def _drop_if_unlisted(path: Path) -> None:
    # Re-asked of the table under the cache lock, not taken from the snapshot a
    # pull started with: an upload that landed since is listed now.
    with _CACHE_LOCK:
        if get_file(path.name) is not None:
            return
        path.unlink(missing_ok=True)
    logger.info("Dropped %s from the cache: no longer in the corpus", path.name)


def pull(cache_dir: Path) -> None:
    """Make the cache match the table: fetch what is missing or different, drop what is unlisted.

    The table is read first, so a failure there raises before any file is touched.
    A single file that cannot be fetched is logged and skipped, not fatal. Only
    top-level ``*.pdf`` files are the cache's; anything nested is left alone.
    """
    rows = list_files()
    cache_dir.mkdir(parents=True, exist_ok=True)
    for row in rows.values():
        target = cache_dir / row.file_name
        if not _matches(target, row):
            _fetch(row, target)
    for path in sorted(cache_dir.glob("*.pdf")):
        if path.name not in rows:
            _drop_if_unlisted(path)


def ensure_local(name: str, cache_dir: Path | None = None) -> Path | None:
    """The cached path of corpus file ``name``, fetching it when this replica lacks it.

    ``None`` when the table does not list it (or ``name`` is not a plain PDF
    name) or the fetch failed. A table that cannot be read raises.
    """
    if not _valid_name(name):
        return None
    row = get_file(name)
    if row is None:
        return None
    target = (cache_dir or default_cache_dir()) / name
    if _matches(target, row) or _fetch(row, target):
        return target
    return None


# ----------------------------------------------------------------------------
# Writes
# ----------------------------------------------------------------------------


def _upload(name: str, data: bytes) -> FileRow:
    """Put ``data`` in the object store through the BFF; the row to record for it."""
    _require_name(name)
    upload_url, storage_key = _request_upload_url(name)
    _put_object(upload_url, data)
    return FileRow(name, storage_key, hashlib.sha256(data).hexdigest(), len(data))


def put(name: str, data: bytes, cache_dir: Path) -> Path:
    """Store a PDF in the corpus and in this replica's cache; the cache path.

    Raises :class:`CorpusStoreError` when the object cannot be stored, so the
    upload route answers with an error instead of a pending job that would never
    find its file. The row is written after the object, and the cache file with
    it under the cache lock, so a concurrent pull sees both or neither.
    """
    row = _upload(name, data)
    with _CACHE_LOCK:
        _upsert_file(row)
        return _write_cache(cache_dir / name, data)


def remove(name: str) -> None:
    """Take ``name`` out of the corpus: its row first, then its object. Idempotent.

    The row is what makes the file part of the corpus, so it goes first; a
    failure to delete the object afterwards raises, and leaves an unreachable
    object that a later upload of the same name overwrites.
    """
    _require_name(name)
    _delete_file_row(name)
    _delete_object(name)


# ----------------------------------------------------------------------------
# One-time move of a replica's local state into the store
# ----------------------------------------------------------------------------


def _import_registry(local_registry: Callable[[], dict[str, Any]]) -> None:
    if load_registry():
        return
    local = local_registry()
    if local:
        save_registry(local)
        logger.info("Imported %d sync registry entries into the shared registry", len(local))


def _import_excluded(local_excluded: Callable[[], set[str]]) -> None:
    local = local_excluded()
    if local:
        save_excluded(load_excluded() | local)


def _upload_local_pdfs(cache_dir: Path) -> None:
    listed = list_files().keys()
    for path in sorted(cache_dir.glob("*.pdf")):
        if path.name in listed or not path.is_file():
            continue
        _upsert_file(_upload(path.name, path.read_bytes()))
        logger.info("Moved %s from the local volume into the object store", path.name)


def migrate_once(
    cache_dir: Path,
    local_registry: Callable[[], dict[str, Any]],
    local_excluded: Callable[[], set[str]],
) -> None:
    """Move what this replica has on its own disk into the shared store, once.

    Until ``cache_dir/.object-store-migrated`` exists: import the local registry
    when the shared one is empty, add the local exclusions to the shared set, and
    upload every local PDF the table does not list. Then write the marker.
    Idempotent, and each replica contributes the files only it holds, which also
    heals a corpus that an upload had left on one replica of several.

    The edge this leaves open: a document an admin deletes after the first
    replica migrated, but before a second replica that still holds its file on a
    per-replica volume has booted, is uploaded again by that second replica on
    its first boot (it finds a file the table does not list). The delete went
    through the shared store and cannot reach a disk nobody has read yet. The
    window closes when the last replica has migrated, and an admin can delete
    the document again.
    """
    marker = cache_dir / MIGRATION_MARKER
    if marker.exists():
        return
    with _MIGRATION_LOCK, keyed_lock("oib-corpus-migration"):
        if marker.exists():
            return
        _import_registry(local_registry)
        _import_excluded(local_excluded)
        _upload_local_pdfs(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        marker.write_text("moved to the object store\n", encoding="utf-8")


def refresh_cache(
    cache_dir: Path,
    local_registry: Callable[[], dict[str, Any]],
    local_excluded: Callable[[], set[str]],
) -> None:
    """Migrate this replica's local state if it has not been, then make the cache match the corpus."""
    migrate_once(cache_dir, local_registry, local_excluded)
    pull(cache_dir)

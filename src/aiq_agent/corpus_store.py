"""The base corpus: objects in SeaweedFS, one table in the knowledge database, a cache on disk (ADR-0082, step A2).

A base-corpus PDF has exactly one source of record, the object
``base-corpus/<file name>`` in ``SEAWEED_BUCKET``. One table in the knowledge
database (``AIQ_SUMMARY_DB``), ``oib_corpus_files``, lists what is in the corpus
and keeps what ingestion needs to know about each file:

====================== ======================================================
``file_name``          primary key, the PDF's name (the index keys chunks on it)
``storage_key``        the object's key in the bucket
``sha256`` / ``size``  of the stored bytes; a download is verified against them
``ingested_sha256``    the hash the index was last built from, ``NULL`` before
``chunk_format_version`` the chunking pipeline's version at that ingestion
``failed_job_id``      the ingest job that gave up on the current bytes, ``NULL`` if none
====================== ======================================================

A file needs ingestion when its ``ingested_sha256`` differs from its
``sha256`` or its ``chunk_format_version`` differs from the pipeline's current
one (:meth:`FileRow.needs_ingestion`). That one rule is the whole change
detector: a changed PDF, a new PDF, a chunking change and a wiped vector store
all reach ingestion through it, and nothing else keeps a registry. The ingestion
itself is a job on the ingest queue (``aiq_agent.oib_sync``); ``failed_job_id``
is the one thing remembered about a job that ran and failed, so the file is not
tried again until its bytes change or an admin asks.

Local files are a CACHE and nothing more. They live in
``GRID_BASE_CORPUS_CACHE_DIR`` (default ``/tmp/base-corpus``), are filled one
file at a time by :func:`ensure_local` for whoever needs a path (ingestion, the
PDF route, the export, the page renderer), and may disappear at any restart.
Nothing pulls the corpus speculatively.

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
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote

import httpx
from sqlalchemy import BigInteger
from sqlalchemy import Column
from sqlalchemy import DateTime
from sqlalchemy import Integer
from sqlalchemy import MetaData
from sqlalchemy import Table
from sqlalchemy import Text
from sqlalchemy import delete
from sqlalchemy import func
from sqlalchemy import select
from sqlalchemy import update
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects import sqlite
from sqlalchemy.schema import CreateTable

from aiq_agent.common import seaweed_s3
from aiq_agent.common.db_utils import ensure_schema
from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

logger = logging.getLogger(__name__)

CACHE_DIR_ENV = "GRID_BASE_CORPUS_CACHE_DIR"
# A cache that may vanish at any restart, by design: the table and the bucket are the record.
DEFAULT_CACHE_DIR = "/tmp/base-corpus"

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
    Column("ingested_sha256", Text, nullable=True),
    Column("chunk_format_version", Integer, nullable=True),
    Column("failed_job_id", Text, nullable=True),
)

_initialized: set[str] = set()
_INIT_LOCK = threading.Lock()

# sha256 of a cache file keyed by path, valid while (size, mtime_ns) hold.
_SHA_CACHE: dict[str, tuple[int, int, str]] = {}
_SHA_LOCK = threading.Lock()


class CorpusStoreError(RuntimeError):
    """The object store, the BFF or the corpus table could not do what was asked.

    The message is safe to show an admin: it never carries a URL or credential.
    """


@dataclass(frozen=True)
class FileRow:
    """One corpus PDF as the table records it."""

    file_name: str
    storage_key: str
    sha256: str
    size_bytes: int
    ingested_sha256: str | None = None
    chunk_format_version: int | None = None
    failed_job_id: str | None = None

    def needs_ingestion(self, chunk_format_version: int) -> bool:
        """True when the index was not built from these bytes with this pipeline version."""
        return self.ingested_sha256 != self.sha256 or self.chunk_format_version != chunk_format_version


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------


def cache_dir() -> Path:
    """This process's cache of corpus files (``GRID_BASE_CORPUS_CACHE_DIR``), read at call time."""
    return Path(os.environ.get(CACHE_DIR_ENV, "").strip() or DEFAULT_CACHE_DIR)


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


def is_valid_name(name: str) -> bool:
    """A plain ``*.pdf`` file name: no directory part, so it cannot leave the cache or the key prefix."""
    return bool(name) and Path(name).name == name and name.lower().endswith(".pdf")


def _require_name(name: str) -> None:
    if not is_valid_name(name):
        raise CorpusStoreError(f"not a corpus file name: {name!r}")


# ----------------------------------------------------------------------------
# The table
# ----------------------------------------------------------------------------


def _db_url() -> str:
    url = os.environ.get("AIQ_SUMMARY_DB") or os.environ.get("NAT_JOB_STORE_DB_URL")
    if not url:
        # A silent fall back to a local SQLite file would bring back exactly the
        # per-replica state the corpus store exists to remove.
        raise CorpusStoreError("the base corpus needs AIQ_SUMMARY_DB (the shared knowledge database)")
    return url


def _ensure_table(url: str) -> None:
    with _INIT_LOCK:
        if url in _initialized:
            return
        # Replicas that first touch the table together would race the CREATE.
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        ensure_schema(engine, _files.name, lambda conn: conn.execute(CreateTable(_files, if_not_exists=True)))
        _initialized.add(url)


@contextlib.contextmanager
def _transaction():
    """A connection on the corpus table, committed when the block ends."""
    url = _db_url()
    _ensure_table(url)
    with DocumentMetadataStore._get_or_create_sync_engine(url).begin() as conn:
        yield conn


def _row_from(record) -> FileRow:
    return FileRow(
        file_name=record.file_name,
        storage_key=record.storage_key,
        sha256=record.sha256,
        size_bytes=int(record.size_bytes),
        ingested_sha256=record.ingested_sha256,
        chunk_format_version=None if record.chunk_format_version is None else int(record.chunk_format_version),
        failed_job_id=record.failed_job_id,
    )


def list_files() -> dict[str, FileRow]:
    """Every corpus PDF the table lists, by file name."""
    with _transaction() as conn:
        return {record.file_name: _row_from(record) for record in conn.execute(select(_files))}


def get_file(name: str) -> FileRow | None:
    with _transaction() as conn:
        record = conn.execute(select(_files).where(_files.c.file_name == name)).first()
    return _row_from(record) if record is not None else None


def _upsert_file(row: FileRow) -> None:
    """Record ``row``'s bytes. A replaced file keeps its ingested hash, so it reads as stale until re-ingested."""
    values = {"storage_key": row.storage_key, "sha256": row.sha256, "size_bytes": row.size_bytes}
    with _transaction() as conn:
        # `ON CONFLICT` is in the dialect's own INSERT, not the generic one.
        insert = postgresql.insert if conn.dialect.name == "postgresql" else sqlite.insert
        conn.execute(
            insert(_files)
            .values(file_name=row.file_name, **values)
            .on_conflict_do_update(index_elements=[_files.c.file_name], set_={**values, "uploaded_at": func.now()})
        )


def _delete_file_row(name: str) -> None:
    with _transaction() as conn:
        conn.execute(delete(_files).where(_files.c.file_name == name))


def mark_ingested(name: str, sha256: str, chunk_format_version: int) -> bool:
    """Record that the index was built from ``sha256`` by pipeline ``chunk_format_version``.

    Only if the row still holds those bytes: a file replaced while it was being
    ingested keeps its old ingested hash and so still needs ingestion. False
    when the row is gone or changed. A recorded success clears a recorded failure.
    """
    with _transaction() as conn:
        result = conn.execute(
            update(_files)
            .where(_files.c.file_name == name, _files.c.sha256 == sha256)
            .values(ingested_sha256=sha256, chunk_format_version=chunk_format_version, failed_job_id=None)
        )
    return result.rowcount == 1


def mark_failed(name: str, sha256: str, job_id: str) -> bool:
    """Record that ingest job ``job_id`` gave up on ``sha256``; False when the row is gone or has other bytes."""
    with _transaction() as conn:
        result = conn.execute(
            update(_files).where(_files.c.file_name == name, _files.c.sha256 == sha256).values(failed_job_id=job_id)
        )
    return result.rowcount == 1


def forget_ingested(name: str | None = None) -> None:
    """Mark ``name`` (or every file) as neither ingested nor failed, so a sync cycle ingests it again."""
    statement = update(_files).values(ingested_sha256=None, chunk_format_version=None, failed_job_id=None)
    if name is not None:
        statement = statement.where(_files.c.file_name == name)
    with _transaction() as conn:
        conn.execute(statement)


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


@contextlib.contextmanager
def _temp_beside(target: Path):
    """A temp file in ``target``'s directory, removed on the way out, so a rename into place is atomic."""
    tmp: Path | None = None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".", suffix=".part")
        os.close(fd)
        tmp = Path(tmp_name)
        yield tmp
    except OSError as e:
        raise CorpusStoreError(f"could not write {target.name} into the cache: {type(e).__name__}") from e
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def _write_cache(target: Path, data: bytes) -> None:
    with _temp_beside(target) as tmp:
        tmp.write_bytes(data)
        os.replace(tmp, target)


def _fetch(row: FileRow, target: Path) -> None:
    """Download ``row`` into ``target``: verified against the row, then renamed into place."""
    with _temp_beside(target) as tmp:
        with tmp.open("wb") as out:
            _download_object(row.storage_key, out)
        if sha256_file(tmp) != row.sha256:
            raise CorpusStoreError(f"{row.file_name} in the object store does not match its recorded hash")
        os.replace(tmp, target)
    logger.info("Fetched base-corpus file %s into the cache (%d bytes)", row.file_name, row.size_bytes)


def ensure_local(name: str) -> Path | None:
    """The cached path of corpus file ``name``, downloaded first when this process lacks the current bytes.

    ``None`` when the table does not list ``name`` (or it is not a plain PDF
    name); any copy this process still holds is deleted then, since the table is
    what says the file exists. Raises :class:`CorpusStoreError` when the file is
    listed but cannot be fetched, and whatever the database raises when the
    table cannot be read: neither is "not in the corpus".
    """
    if not is_valid_name(name):
        return None
    target = cache_dir() / name
    row = get_file(name)
    if row is None:
        target.unlink(missing_ok=True)
        return None
    if _local_sha(target) != row.sha256:
        _fetch(row, target)
    return target


# ----------------------------------------------------------------------------
# Writes
# ----------------------------------------------------------------------------


def put(name: str, data: bytes) -> FileRow:
    """Store a PDF in the corpus, and keep this process's copy in the cache.

    The object first, then the row: the row is what makes the file part of the
    corpus, so a failed upload raises :class:`CorpusStoreError` and leaves
    nothing listed. Storing a name again replaces its bytes and leaves it
    needing ingestion.
    """
    _require_name(name)
    upload_url, storage_key = _request_upload_url(name)
    _put_object(upload_url, data)
    row = FileRow(name, storage_key, hashlib.sha256(data).hexdigest(), len(data))
    _upsert_file(row)
    _write_cache(cache_dir() / name, data)
    return row


def remove(name: str) -> None:
    """Take ``name`` out of the corpus: its row, then its object, then this process's cached copy. Idempotent.

    The row is what makes the file part of the corpus, so it goes first; a
    failure to delete the object afterwards raises and leaves an unreachable
    object that a later upload of the same name overwrites.
    """
    _require_name(name)
    _delete_file_row(name)
    _delete_object(name)
    (cache_dir() / name).unlink(missing_ok=True)


# ----------------------------------------------------------------------------
# The download an ingest job runs
# ----------------------------------------------------------------------------

#: Every corpus object's key starts here (the BFF's ``buildBaseCorpusStorageKey``).
_KEY_PREFIX = "base-corpus/"


class CorpusObjectDownload:
    """The original of a queued ingest job: a corpus object the worker reads itself.

    The ingest queue carries a job as data, and a job that waits for a worker for
    a long time cannot carry a presigned URL that expires in an hour. This
    carries the object's key and hash instead, and the worker, which holds the same
    read credential as every backend process (``aiq_agent.common.seaweed_s3``),
    downloads it when it reaches the file, to a temp file the job then owns and
    deletes (``knowledge_layer.deferred_files``: any zero-argument callable that
    returns a path). The bytes are checked against the hash the job was made for, so a
    file replaced while the job waited fails here, as a failed download, instead of
    being indexed under the wrong hash.
    """

    __slots__ = ("sha256", "storage_key")

    def __init__(self, storage_key: str, sha256: str) -> None:
        if not storage_key.startswith(_KEY_PREFIX) or ".." in storage_key:
            raise CorpusStoreError("not a corpus object key")
        self.storage_key = storage_key
        self.sha256 = sha256

    def __repr__(self) -> str:
        return f"<corpus object download {self.storage_key}>"

    def to_payload(self) -> dict[str, str]:
        return {"storage_key": self.storage_key, "sha256": self.sha256}

    @classmethod
    def from_payload(cls, data: dict) -> CorpusObjectDownload:
        """Rebuild one from a queue payload; the key is checked again, a row is not a request that was."""
        return cls(str(data["storage_key"]), str(data["sha256"]))

    def __call__(self) -> str:
        fd, name = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        path = Path(name)
        try:
            with path.open("wb") as out:
                _download_object(self.storage_key, out)
            if sha256_file(path) != self.sha256:
                raise CorpusStoreError(f"{self.storage_key} does not match the hash the job was made for")
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return name

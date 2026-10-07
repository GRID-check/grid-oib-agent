"""An in-memory stand-in for the BFF and SeaweedFS, for base-corpus tests.

``corpus_store`` reaches the outside world through four module-level functions
(``_request_upload_url``, ``_put_object``, ``_delete_object``,
``_download_object``). :func:`install` replaces them with a dict-backed bucket,
gives the cache a fresh directory and points the corpus table at a throwaway
SQLite file, so the store's own logic (table, cache, hash checks) runs for real.

Set ``GRID_TEST_CORPUS_DB`` to a Postgres URL to run the same tests against a
real server: the Postgres upsert, the conditional update and the advisory
locks of ``keyed_lock`` (SQLite has none) are then exercised too. The table is
emptied before each test.
"""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import delete

from aiq_agent import corpus_store


class FakeBucket:
    """Objects by storage key, plus a record of every call the store made."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.uploads: list[str] = []
        self.deletes: list[str] = []
        self.downloads: list[str] = []
        self.refuse_uploads = False

    def request_upload_url(self, name: str) -> tuple[str, str]:
        if self.refuse_uploads:
            raise corpus_store.CorpusStoreError(f"upload-url request for {name} was refused (HTTP 503)")
        self.uploads.append(name)
        return f"https://upload.invalid/{name}", f"base-corpus/{name}"

    def put_object(self, upload_url: str, data: bytes) -> None:
        self.objects[f"base-corpus/{upload_url.rsplit('/', 1)[1]}"] = data

    def delete_object(self, name: str) -> None:
        self.deletes.append(name)
        self.objects.pop(f"base-corpus/{name}", None)

    def download_object(self, storage_key: str, out) -> None:
        self.downloads.append(storage_key)
        if storage_key not in self.objects:
            raise corpus_store.CorpusStoreError(f"download of {storage_key} failed: NoSuchKey")
        out.write(self.objects[storage_key])


def install(monkeypatch, tmp_path: Path) -> FakeBucket:
    """A fresh database, an empty cache directory and a fake bucket."""
    bucket = FakeBucket()
    monkeypatch.setenv("AIQ_SUMMARY_DB", os.environ.get("GRID_TEST_CORPUS_DB") or f"sqlite:///{tmp_path / 'corpus.db'}")
    monkeypatch.setenv(corpus_store.CACHE_DIR_ENV, str(tmp_path / "cache"))
    monkeypatch.setattr(corpus_store, "_request_upload_url", bucket.request_upload_url)
    monkeypatch.setattr(corpus_store, "_put_object", bucket.put_object)
    monkeypatch.setattr(corpus_store, "_delete_object", bucket.delete_object)
    monkeypatch.setattr(corpus_store, "_download_object", bucket.download_object)
    with corpus_store._transaction() as conn:
        conn.execute(delete(corpus_store._files))
    return bucket

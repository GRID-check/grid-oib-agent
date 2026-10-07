"""The base corpus: table, cache, hash checks and the ingestion state (ADR-0082, step A2).

The BFF and SeaweedFS are replaced by an in-memory bucket (``tests/object_corpus_fakes``);
the corpus table is a real SQLite file (a real Postgres when ``GRID_TEST_CORPUS_DB`` is set),
so the store's own logic runs for real.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

import httpx
import pytest

from aiq_agent import corpus_store
from aiq_agent.common import seaweed_s3
from tests.object_corpus_fakes import FakeBucket
from tests.object_corpus_fakes import install

FORMAT = 7


@pytest.fixture
def bucket(monkeypatch, tmp_path) -> FakeBucket:
    return install(monkeypatch, tmp_path)


@pytest.fixture
def cache(tmp_path) -> Path:
    return tmp_path / "cache"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _stored_elsewhere(name: str, data: bytes, cache: Path) -> None:
    """A file another replica uploaded: object and row exist, this process's cache does not hold it."""
    corpus_store.put(name, data)
    (cache / name).unlink()


class TestCacheDir:
    def test_defaults_to_a_tmp_directory(self, monkeypatch):
        monkeypatch.delenv(corpus_store.CACHE_DIR_ENV, raising=False)
        assert corpus_store.cache_dir() == Path("/tmp/base-corpus")

    def test_is_read_when_asked_not_at_import(self, monkeypatch, tmp_path):
        monkeypatch.setenv(corpus_store.CACHE_DIR_ENV, str(tmp_path / "elsewhere"))
        assert corpus_store.cache_dir() == tmp_path / "elsewhere"

    def test_a_blank_setting_is_the_default(self, monkeypatch):
        monkeypatch.setenv(corpus_store.CACHE_DIR_ENV, "  ")
        assert corpus_store.cache_dir() == Path(corpus_store.DEFAULT_CACHE_DIR)


class TestTable:
    def test_without_a_database_it_fails_loudly(self, monkeypatch):
        monkeypatch.delenv("AIQ_SUMMARY_DB", raising=False)
        monkeypatch.delenv("NAT_JOB_STORE_DB_URL", raising=False)
        with pytest.raises(corpus_store.CorpusStoreError, match="AIQ_SUMMARY_DB"):
            corpus_store.list_files()

    def test_the_table_is_created_on_first_use(self, bucket):
        assert corpus_store.list_files() == {}
        assert corpus_store.get_file("a.pdf") is None


class TestPutAndRemove:
    def test_put_stores_the_object_the_row_and_the_cache_file(self, bucket, cache):
        row = corpus_store.put("a.pdf", b"alpha")

        assert (cache / "a.pdf").read_bytes() == b"alpha"
        assert bucket.objects == {"base-corpus/a.pdf": b"alpha"}
        assert row == corpus_store.FileRow("a.pdf", "base-corpus/a.pdf", _sha(b"alpha"), 5)
        assert corpus_store.get_file("a.pdf") == row
        assert list(corpus_store.list_files()) == ["a.pdf"]

    def test_put_again_replaces_the_bytes_and_keeps_what_the_index_was_built_from(self, bucket, cache):
        corpus_store.put("a.pdf", b"v1")
        assert corpus_store.mark_ingested("a.pdf", _sha(b"v1"), FORMAT)

        corpus_store.put("a.pdf", b"version two")

        row = corpus_store.get_file("a.pdf")
        assert row is not None and row.sha256 == _sha(b"version two") and row.size_bytes == 11
        assert row.ingested_sha256 == _sha(b"v1")  # the index still holds version one
        assert row.needs_ingestion(FORMAT)
        assert (cache / "a.pdf").read_bytes() == b"version two"

    def test_putting_the_same_bytes_again_does_not_ask_for_a_new_ingestion(self, bucket):
        corpus_store.put("a.pdf", b"v1")
        corpus_store.mark_ingested("a.pdf", _sha(b"v1"), FORMAT)

        corpus_store.put("a.pdf", b"v1")

        row = corpus_store.get_file("a.pdf")
        assert row is not None and not row.needs_ingestion(FORMAT)

    def test_a_refused_upload_raises_and_leaves_nothing_behind(self, bucket, cache):
        bucket.refuse_uploads = True

        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.put("a.pdf", b"alpha")

        assert corpus_store.get_file("a.pdf") is None
        assert not (cache / "a.pdf").exists()

    @pytest.mark.parametrize("name", ["../a.pdf", "dir/a.pdf", "notes.txt", ""])
    def test_a_name_that_is_not_a_plain_pdf_is_refused_before_any_call(self, bucket, name):
        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.put(name, b"x")
        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.remove(name)
        assert bucket.uploads == [] and bucket.deletes == []

    def test_remove_drops_the_row_the_object_and_the_cached_copy_and_is_idempotent(self, bucket, cache):
        corpus_store.put("a.pdf", b"alpha")

        corpus_store.remove("a.pdf")
        corpus_store.remove("a.pdf")

        assert corpus_store.get_file("a.pdf") is None
        assert bucket.objects == {}
        assert not (cache / "a.pdf").exists()
        assert bucket.deletes == ["a.pdf", "a.pdf"]

    def test_a_failed_object_delete_still_leaves_the_file_out_of_the_corpus(self, bucket, monkeypatch):
        corpus_store.put("a.pdf", b"alpha")

        def refuse(_name):
            raise corpus_store.CorpusStoreError("delete of a.pdf from the object store was refused (HTTP 500)")

        monkeypatch.setattr(corpus_store, "_delete_object", refuse)

        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.remove("a.pdf")

        assert corpus_store.get_file("a.pdf") is None


class TestEnsureLocal:
    def test_fetches_a_file_this_process_lacks(self, bucket, cache):
        corpus_store.put("a.pdf", b"alpha")
        (cache / "a.pdf").unlink()

        path = corpus_store.ensure_local("a.pdf")

        assert path == cache / "a.pdf"
        assert path.read_bytes() == b"alpha"
        assert bucket.downloads == ["base-corpus/a.pdf"]

    def test_does_not_download_a_file_it_already_has(self, bucket, cache):
        corpus_store.put("a.pdf", b"alpha")

        assert corpus_store.ensure_local("a.pdf") == cache / "a.pdf"
        assert bucket.downloads == []

    def test_replaces_a_cached_copy_whose_bytes_are_not_the_recorded_ones(self, bucket, cache):
        corpus_store.put("a.pdf", b"new bytes")
        (cache / "a.pdf").write_bytes(b"old bytes")

        assert corpus_store.ensure_local("a.pdf") == cache / "a.pdf"

        assert (cache / "a.pdf").read_bytes() == b"new bytes"

    def test_a_file_the_table_does_not_list_is_none_and_its_stale_copy_is_deleted(self, bucket, cache):
        cache.mkdir()
        (cache / "gone.pdf").write_bytes(b"left behind by a delete on another replica")

        assert corpus_store.ensure_local("gone.pdf") is None

        assert not (cache / "gone.pdf").exists()

    @pytest.mark.parametrize("name", ["../etc/passwd.pdf", "a.txt", "sub/a.pdf", ""])
    def test_unsafe_names_are_none_and_touch_nothing(self, bucket, name):
        assert corpus_store.ensure_local(name) is None

    def test_a_download_that_fails_the_hash_check_never_reaches_the_cache(self, bucket, cache):
        corpus_store.put("a.pdf", b"alpha")
        (cache / "a.pdf").unlink()
        bucket.objects["base-corpus/a.pdf"] = b"tampered"

        with pytest.raises(corpus_store.CorpusStoreError, match="does not match"):
            corpus_store.ensure_local("a.pdf")

        assert not (cache / "a.pdf").exists()
        assert list(cache.glob(".*.part")) == []

    def test_a_mismatch_does_not_replace_a_cached_copy(self, bucket, cache):
        corpus_store.put("a.pdf", b"alpha")
        bucket.objects["base-corpus/a.pdf"] = b"tampered"
        (cache / "a.pdf").write_bytes(b"stale local")

        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.ensure_local("a.pdf")

        assert (cache / "a.pdf").read_bytes() == b"stale local"

    def test_a_listed_file_that_cannot_be_fetched_is_an_error_not_a_missing_file(self, bucket, cache):
        corpus_store.put("a.pdf", b"alpha")
        (cache / "a.pdf").unlink()
        bucket.objects.clear()

        with pytest.raises(corpus_store.CorpusStoreError, match="NoSuchKey"):
            corpus_store.ensure_local("a.pdf")

        assert list(cache.glob(".*.part")) == []

    def test_a_reader_never_sees_a_partial_file(self, bucket, cache, monkeypatch):
        corpus_store.put("a.pdf", b"alpha")
        (cache / "a.pdf").unlink()
        seen_during_download: list[bool] = []

        def half_then_fail(_key, out):
            out.write(b"al")
            seen_during_download.append((cache / "a.pdf").exists())
            raise corpus_store.CorpusStoreError("connection reset")

        monkeypatch.setattr(corpus_store, "_download_object", half_then_fail)

        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.ensure_local("a.pdf")

        assert seen_during_download == [False]
        assert not (cache / "a.pdf").exists()

    def test_an_unreadable_table_is_an_error_not_a_missing_file(self, bucket, cache, monkeypatch):
        corpus_store.put("a.pdf", b"alpha")

        def broken(_name):
            raise corpus_store.CorpusStoreError("database down")

        monkeypatch.setattr(corpus_store, "get_file", broken)

        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.ensure_local("a.pdf")

        assert (cache / "a.pdf").exists()  # nothing was deleted on a guess


class TestIngestionState:
    def test_a_new_file_needs_ingestion(self, bucket):
        row = corpus_store.put("a.pdf", b"alpha")

        assert row.ingested_sha256 is None and row.chunk_format_version is None
        assert row.needs_ingestion(FORMAT)

    def test_a_file_the_index_was_built_from_does_not(self, bucket):
        corpus_store.put("a.pdf", b"alpha")

        assert corpus_store.mark_ingested("a.pdf", _sha(b"alpha"), FORMAT) is True

        row = corpus_store.get_file("a.pdf")
        assert row == corpus_store.FileRow(
            "a.pdf", "base-corpus/a.pdf", _sha(b"alpha"), 5, ingested_sha256=_sha(b"alpha"), chunk_format_version=FORMAT
        )
        assert not row.needs_ingestion(FORMAT)

    def test_a_new_chunk_format_makes_every_file_need_ingestion_again(self, bucket):
        corpus_store.put("a.pdf", b"alpha")
        corpus_store.mark_ingested("a.pdf", _sha(b"alpha"), FORMAT)

        row = corpus_store.get_file("a.pdf")

        assert row is not None and not row.needs_ingestion(FORMAT) and row.needs_ingestion(FORMAT + 1)

    def test_a_hash_is_not_recorded_for_bytes_the_row_no_longer_holds(self, bucket):
        corpus_store.put("a.pdf", b"v1")
        corpus_store.put("a.pdf", b"v2")  # replaced while v1 was being ingested

        assert corpus_store.mark_ingested("a.pdf", _sha(b"v1"), FORMAT) is False

        row = corpus_store.get_file("a.pdf")
        assert row is not None and row.ingested_sha256 is None and row.needs_ingestion(FORMAT)

    def test_nothing_is_recorded_for_a_file_that_is_gone(self, bucket):
        assert corpus_store.mark_ingested("ghost.pdf", _sha(b"x"), FORMAT) is False

    def test_forget_ingested_for_one_file_leaves_the_others(self, bucket):
        for name, data in (("a.pdf", b"a"), ("b.pdf", b"b")):
            corpus_store.put(name, data)
            corpus_store.mark_ingested(name, _sha(data), FORMAT)

        corpus_store.forget_ingested("a.pdf")

        files = corpus_store.list_files()
        assert files["a.pdf"].needs_ingestion(FORMAT) and files["a.pdf"].ingested_sha256 is None
        assert not files["b.pdf"].needs_ingestion(FORMAT)

    def test_forget_ingested_without_a_name_forgets_every_file(self, bucket):
        for name, data in (("a.pdf", b"a"), ("b.pdf", b"b")):
            corpus_store.put(name, data)
            corpus_store.mark_ingested(name, _sha(data), FORMAT)

        corpus_store.forget_ingested()

        assert all(row.needs_ingestion(FORMAT) for row in corpus_store.list_files().values())


class TestWireDetails:
    def test_the_delete_url_encodes_the_name_exactly_once(self, monkeypatch):
        seen: dict = {}
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000/")
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")

        def fake_delete(url, headers, timeout):
            seen.update(url=url, headers=headers)
            return httpx.Response(200, json={"deleted": True})

        monkeypatch.setattr(httpx, "delete", fake_delete)

        corpus_store._delete_object("Brand schutz #1 äö.pdf")

        assert seen["url"] == "http://frontend:3000/api/internal/base-corpus/Brand%20schutz%20%231%20%C3%A4%C3%B6.pdf"
        assert seen["headers"] == {"x-grid-internal-token": "tok"}

    def test_the_upload_url_request_carries_the_name_and_the_token(self, monkeypatch):
        seen: dict = {}
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")

        def fake_post(url, json, headers, timeout):
            seen.update(url=url, json=json, headers=headers)
            return httpx.Response(
                200, json={"uploadUrl": "https://s3.invalid/put?x=1", "storageKey": "base-corpus/a.pdf"}
            )

        monkeypatch.setattr(httpx, "post", fake_post)

        assert corpus_store._request_upload_url("a.pdf") == ("https://s3.invalid/put?x=1", "base-corpus/a.pdf")
        assert seen["url"] == "http://frontend:3000/api/internal/base-corpus/upload-url"
        assert seen["json"] == {"fileName": "a.pdf"}
        assert seen["headers"] == {"x-grid-internal-token": "tok"}

    def test_a_refused_upload_url_request_is_an_error(self, monkeypatch):
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        monkeypatch.setattr(httpx, "post", lambda *_a, **_k: httpx.Response(400, json={"error": "bad name"}))

        with pytest.raises(corpus_store.CorpusStoreError, match="HTTP 400"):
            corpus_store._request_upload_url("a.pdf")

    def test_the_presigned_put_is_a_pdf(self, monkeypatch):
        seen: dict = {}

        def fake_put(url, content, headers, timeout):
            seen.update(url=url, content=content, headers=headers)
            return httpx.Response(200)

        monkeypatch.setattr(httpx, "put", fake_put)

        corpus_store._put_object("https://s3.invalid/put?x=1", b"pdf")

        assert seen["headers"] == {"Content-Type": "application/pdf"}
        assert seen["content"] == b"pdf"

    def test_a_failed_put_is_an_error_that_does_not_carry_the_url(self, monkeypatch):
        def refuse(*_args, **_kwargs):
            raise httpx.ConnectError("cannot reach https://s3.invalid/put?X-Amz-Signature=secret")

        monkeypatch.setattr(httpx, "put", refuse)

        with pytest.raises(corpus_store.CorpusStoreError) as raised:
            corpus_store._put_object("https://s3.invalid/put?X-Amz-Signature=secret", b"pdf")

        assert "secret" not in str(raised.value)

    def test_writes_need_the_bff_settings(self, monkeypatch):
        monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)

        with pytest.raises(corpus_store.CorpusStoreError, match="FRONTEND_INTERNAL_URL"):
            corpus_store._request_upload_url("a.pdf")

    def test_a_download_goes_through_the_shared_read_client(self, monkeypatch):
        calls: list[tuple[str, str]] = []

        class _S3:
            def get_object(self, *, Bucket, Key):
                calls.append((Bucket, Key))
                return {"Body": io.BytesIO(b"pdf-bytes")}

        monkeypatch.setattr(seaweed_s3, "s3_client", lambda: _S3())
        monkeypatch.setenv("SEAWEED_BUCKET", "grid-documents")
        out = io.BytesIO()

        corpus_store._download_object("base-corpus/a.pdf", out)

        assert out.getvalue() == b"pdf-bytes"
        assert calls == [("grid-documents", "base-corpus/a.pdf")]

    def test_a_download_without_credentials_is_a_store_error(self, monkeypatch):
        for env in ("SEAWEED_ENDPOINT", "SEAWEED_ACCESS_KEY", "SEAWEED_SECRET_KEY"):
            monkeypatch.delenv(env, raising=False)

        with pytest.raises(corpus_store.CorpusStoreError, match="SEAWEED"):
            corpus_store._download_object("base-corpus/a.pdf", io.BytesIO())

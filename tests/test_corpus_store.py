"""The object-mode base corpus: tables, cache, hash checks and the one-time move (ADR-0082, step A2).

The BFF and SeaweedFS are replaced by an in-memory bucket (``tests/object_corpus_fakes``);
the corpus tables are a real SQLite file, so the store's own logic runs for real.
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


@pytest.fixture
def bucket(monkeypatch, tmp_path) -> FakeBucket:
    return install(monkeypatch, tmp_path)


@pytest.fixture
def cache(tmp_path) -> Path:
    return tmp_path / "cache"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _from_another_replica(tmp_path: Path, name: str, data: bytes) -> None:
    corpus_store.put(name, data, tmp_path / "other-replica")


class TestMode:
    def test_disk_is_the_default(self, monkeypatch):
        monkeypatch.delenv(corpus_store.STORE_ENV, raising=False)
        assert corpus_store.object_mode() is False

    def test_only_the_word_object_switches_it_on(self, monkeypatch):
        monkeypatch.setenv(corpus_store.STORE_ENV, " Object ")
        assert corpus_store.object_mode() is True
        monkeypatch.setenv(corpus_store.STORE_ENV, "s3")
        assert corpus_store.object_mode() is False

    def test_disk_mode_takes_no_cross_replica_lock(self, monkeypatch):
        monkeypatch.delenv(corpus_store.STORE_ENV, raising=False)
        monkeypatch.setattr(corpus_store, "keyed_lock", lambda _key: pytest.fail("keyed_lock must not be used"))
        with corpus_store.shared_lock("oib-sync"):
            pass

    def test_object_mode_without_a_database_fails_loudly(self, monkeypatch):
        monkeypatch.setenv(corpus_store.STORE_ENV, "object")
        monkeypatch.delenv("AIQ_SUMMARY_DB", raising=False)
        monkeypatch.delenv("NAT_JOB_STORE_DB_URL", raising=False)
        with pytest.raises(corpus_store.CorpusStoreError, match="AIQ_SUMMARY_DB"):
            corpus_store.list_files()


class TestPutAndRemove:
    def test_put_stores_the_object_the_row_and_the_cache_file(self, bucket, cache):
        path = corpus_store.put("a.pdf", b"alpha", cache)

        assert path == cache / "a.pdf"
        assert path.read_bytes() == b"alpha"
        assert bucket.objects == {"base-corpus/a.pdf": b"alpha"}
        row = corpus_store.get_file("a.pdf")
        assert row == corpus_store.FileRow("a.pdf", "base-corpus/a.pdf", _sha(b"alpha"), 5)

    def test_put_again_replaces_the_row(self, bucket, cache):
        corpus_store.put("a.pdf", b"v1", cache)
        corpus_store.put("a.pdf", b"version two", cache)

        row = corpus_store.get_file("a.pdf")
        assert row is not None and row.sha256 == _sha(b"version two") and row.size_bytes == 11
        assert (cache / "a.pdf").read_bytes() == b"version two"

    def test_a_refused_upload_raises_and_leaves_nothing_behind(self, bucket, cache):
        bucket.refuse_uploads = True

        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.put("a.pdf", b"alpha", cache)

        assert corpus_store.get_file("a.pdf") is None
        assert not (cache / "a.pdf").exists()

    def test_a_name_with_a_path_is_refused_before_any_call(self, bucket, cache):
        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.put("../a.pdf", b"x", cache)
        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.put("notes.txt", b"x", cache)
        assert bucket.uploads == []

    def test_remove_drops_the_row_and_the_object_and_is_idempotent(self, bucket, cache):
        corpus_store.put("a.pdf", b"alpha", cache)

        corpus_store.remove("a.pdf")
        corpus_store.remove("a.pdf")

        assert corpus_store.get_file("a.pdf") is None
        assert bucket.objects == {}
        assert bucket.deletes == ["a.pdf", "a.pdf"]


class TestPull:
    def test_fetches_what_is_missing_and_keeps_what_matches(self, bucket, cache, tmp_path):
        _from_another_replica(tmp_path, "a.pdf", b"alpha")
        _from_another_replica(tmp_path, "b.pdf", b"beta")
        cache.mkdir()
        (cache / "a.pdf").write_bytes(b"alpha")  # already here, same bytes

        corpus_store.pull(cache)

        assert (cache / "a.pdf").read_bytes() == b"alpha"
        assert (cache / "b.pdf").read_bytes() == b"beta"
        assert bucket.downloads == ["base-corpus/b.pdf"]

    def test_refetches_a_file_whose_content_differs(self, bucket, cache, tmp_path):
        _from_another_replica(tmp_path, "a.pdf", b"new bytes")
        cache.mkdir()
        (cache / "a.pdf").write_bytes(b"old bytes")

        corpus_store.pull(cache)

        assert (cache / "a.pdf").read_bytes() == b"new bytes"

    def test_drops_local_pdfs_the_table_does_not_list(self, bucket, cache):
        cache.mkdir()
        (cache / "gone.pdf").write_bytes(b"x")
        (cache / "notes.txt").write_bytes(b"not a pdf")

        corpus_store.pull(cache)

        assert not (cache / "gone.pdf").exists()
        assert (cache / "notes.txt").exists()

    def test_a_download_that_fails_the_hash_check_never_reaches_the_cache(self, bucket, cache, tmp_path):
        _from_another_replica(tmp_path, "a.pdf", b"alpha")
        bucket.objects["base-corpus/a.pdf"] = b"tampered"

        corpus_store.pull(cache)

        assert not (cache / "a.pdf").exists()
        assert list(cache.glob(".*.part")) == []

    def test_a_mismatch_does_not_replace_a_cached_copy(self, bucket, cache, tmp_path):
        _from_another_replica(tmp_path, "a.pdf", b"alpha")
        bucket.objects["base-corpus/a.pdf"] = b"tampered"
        cache.mkdir()
        (cache / "a.pdf").write_bytes(b"stale local")

        corpus_store.pull(cache)

        assert (cache / "a.pdf").read_bytes() == b"stale local"

    def test_one_failed_file_does_not_stop_the_others(self, bucket, cache, tmp_path):
        _from_another_replica(tmp_path, "a.pdf", b"alpha")
        _from_another_replica(tmp_path, "b.pdf", b"beta")
        del bucket.objects["base-corpus/a.pdf"]

        corpus_store.pull(cache)

        assert not (cache / "a.pdf").exists()
        assert (cache / "b.pdf").read_bytes() == b"beta"

    def test_an_unreadable_table_removes_nothing(self, bucket, cache, monkeypatch):
        cache.mkdir()
        (cache / "mine.pdf").write_bytes(b"x")

        def broken():
            raise corpus_store.CorpusStoreError("database down")

        monkeypatch.setattr(corpus_store, "list_files", broken)

        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.pull(cache)

        assert (cache / "mine.pdf").exists()

    def test_a_file_listed_since_the_pull_began_is_not_dropped(self, bucket, cache, monkeypatch):
        # The pull read the table before an upload landed; the upload's file is on disk.
        corpus_store.put("late.pdf", b"late", cache)
        monkeypatch.setattr(corpus_store, "list_files", lambda: {})

        corpus_store.pull(cache)

        assert (cache / "late.pdf").read_bytes() == b"late"


class TestEnsureLocal:
    def test_fetches_a_file_this_replica_lacks(self, bucket, cache, tmp_path):
        _from_another_replica(tmp_path, "a.pdf", b"alpha")

        path = corpus_store.ensure_local("a.pdf", cache)

        assert path == cache / "a.pdf"
        assert path.read_bytes() == b"alpha"

    def test_does_not_download_a_file_it_already_has(self, bucket, cache):
        corpus_store.put("a.pdf", b"alpha", cache)

        assert corpus_store.ensure_local("a.pdf", cache) == cache / "a.pdf"
        assert bucket.downloads == []

    def test_unknown_files_and_unsafe_names_are_none(self, bucket, cache):
        assert corpus_store.ensure_local("ghost.pdf", cache) is None
        assert corpus_store.ensure_local("../etc/passwd.pdf", cache) is None
        assert corpus_store.ensure_local("a.txt", cache) is None

    def test_a_failed_fetch_is_none(self, bucket, cache, tmp_path):
        _from_another_replica(tmp_path, "a.pdf", b"alpha")
        bucket.objects.clear()

        assert corpus_store.ensure_local("a.pdf", cache) is None

    def test_the_default_cache_is_the_uploads_dir(self, bucket, tmp_path, monkeypatch):
        _from_another_replica(tmp_path, "a.pdf", b"alpha")
        monkeypatch.setenv("OIB_UPLOADS_DIR", str(tmp_path / "uploads"))

        assert corpus_store.ensure_local("a.pdf") == tmp_path / "uploads" / "a.pdf"


class TestRegistryAndExclusions:
    def test_the_registry_round_trips_with_the_format_stamp_as_an_int(self, bucket):
        registry = {corpus_store.FORMAT_KEY: 4, "/data/a.pdf": "abc"}

        corpus_store.save_registry(registry)

        assert corpus_store.load_registry() == registry

    def test_saving_the_registry_replaces_it(self, bucket):
        corpus_store.save_registry({"/data/a.pdf": "1", "/data/b.pdf": "2"})
        corpus_store.save_registry({"/data/b.pdf": "3", "/data/c.pdf": "4"})

        assert corpus_store.load_registry() == {"/data/b.pdf": "3", "/data/c.pdf": "4"}

    def test_saving_an_empty_registry_clears_it(self, bucket):
        corpus_store.save_registry({"/data/a.pdf": "1"})
        corpus_store.save_registry({})

        assert corpus_store.load_registry() == {}

    def test_exclusions_round_trip_and_replace(self, bucket):
        corpus_store.save_excluded({"a.pdf", "b.pdf"})
        assert corpus_store.load_excluded() == {"a.pdf", "b.pdf"}

        corpus_store.save_excluded({"b.pdf", "c.pdf"})
        assert corpus_store.load_excluded() == {"b.pdf", "c.pdf"}

        corpus_store.save_excluded(set())
        assert corpus_store.load_excluded() == set()


def _local(cache: Path, **files: bytes) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (cache / f"{name}.pdf").write_bytes(data)


class TestMigration:
    def test_moves_local_files_registry_and_exclusions_up_once(self, bucket, cache):
        _local(cache, a=b"alpha", b=b"beta")
        registry = {corpus_store.FORMAT_KEY: 4, str(cache / "a.pdf"): _sha(b"alpha")}

        corpus_store.migrate_once(cache, lambda: registry, lambda: {"shipped.pdf"})

        assert set(corpus_store.list_files()) == {"a.pdf", "b.pdf"}
        assert bucket.objects["base-corpus/b.pdf"] == b"beta"
        assert corpus_store.load_registry() == registry
        assert corpus_store.load_excluded() == {"shipped.pdf"}
        assert (cache / corpus_store.MIGRATION_MARKER).exists()

        # A second run reads nothing local and uploads nothing.
        uploads = list(bucket.uploads)
        corpus_store.migrate_once(
            cache, lambda: pytest.fail("registry re-read"), lambda: pytest.fail("exclusions re-read")
        )
        assert bucket.uploads == uploads

    def test_a_file_the_table_already_lists_is_not_uploaded_again(self, bucket, cache, tmp_path):
        _from_another_replica(tmp_path, "a.pdf", b"alpha")
        _local(cache, a=b"alpha", b=b"beta")

        corpus_store.migrate_once(cache, dict, set)

        assert bucket.uploads == ["a.pdf", "b.pdf"]  # a.pdf once, by the other replica

    def test_a_registry_already_in_the_table_is_not_overwritten(self, bucket, cache):
        corpus_store.save_registry({"/data/x.pdf": "shared"})
        _local(cache)

        corpus_store.migrate_once(cache, lambda: {"/data/y.pdf": "stale local"}, set)

        assert corpus_store.load_registry() == {"/data/x.pdf": "shared"}

    def test_local_exclusions_are_added_to_the_shared_set(self, bucket, cache):
        corpus_store.save_excluded({"shared.pdf"})
        _local(cache)

        corpus_store.migrate_once(cache, dict, lambda: {"local.pdf"})

        assert corpus_store.load_excluded() == {"shared.pdf", "local.pdf"}

    def test_a_failed_upload_leaves_no_marker_and_the_file_in_place(self, bucket, cache):
        _local(cache, a=b"alpha")
        bucket.refuse_uploads = True

        with pytest.raises(corpus_store.CorpusStoreError):
            corpus_store.refresh_cache(cache, dict, set)

        assert not (cache / corpus_store.MIGRATION_MARKER).exists()
        assert (cache / "a.pdf").read_bytes() == b"alpha"  # never dropped by a pull

    def test_the_cache_keeps_the_files_it_just_moved(self, bucket, cache):
        _local(cache, a=b"alpha")

        corpus_store.refresh_cache(cache, dict, set)

        assert (cache / "a.pdf").read_bytes() == b"alpha"
        assert bucket.downloads == []

    def test_a_second_replica_contributes_only_its_own_files(self, bucket, tmp_path):
        first, second = tmp_path / "pvc-0", tmp_path / "pvc-1"
        _local(first, a=b"alpha")
        _local(second, a=b"alpha", b=b"beta")

        corpus_store.refresh_cache(first, dict, set)
        corpus_store.refresh_cache(second, dict, set)
        corpus_store.refresh_cache(first, dict, set)  # its next refresh

        assert set(corpus_store.list_files()) == {"a.pdf", "b.pdf"}
        assert bucket.uploads == ["a.pdf", "b.pdf"]
        assert (first / "b.pdf").read_bytes() == b"beta"  # the first replica serves it too now


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

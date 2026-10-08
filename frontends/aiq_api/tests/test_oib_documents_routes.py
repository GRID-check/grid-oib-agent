"""Tests for the OIB base-corpus admin routes.

Covers the non-blocking upload (explicit + guessed doc_class, invalid → 400),
safe ZIP extraction (happy path + zip-slip + non-pdf skip), the reclassify
PATCH endpoint (updates / validates / 404), delete, re-ingest, the PDF route and
the corpus export. Uses a tmp-sqlite summary store, an in-memory stand-in for the
BFF and SeaweedFS with a real corpus table, ingest queue and status store (a real
Postgres when ``GRID_TEST_CORPUS_DB`` is set), and a fake ingestor that can only
PREPARE a job: an upload or a re-ingest must leave a job in the queue and ingest
nothing in the route's own process.
"""

import io
import os
import tarfile
import tempfile
import zipfile
from datetime import UTC
from datetime import datetime
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy import text

from aiq_agent import corpus_store
from aiq_agent import oib_sync
from aiq_agent.knowledge import ingest_queue
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.base import PreparedIngestJob
from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.factory import configure_summary_db
from aiq_agent.knowledge.factory import register_summary
from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState
from aiq_api.jobs import ingest_dispatch
from aiq_api.routes.oib import add_oib_routes

_COLLECTION = "oib_knowledge"


@pytest.fixture
def summary_db():
    # ignore_cleanup_errors: the SQLite engine's connection (and its -wal/-shm
    # sidecar files) may not be released the instant the fixture tears down, so
    # rmtree can hit a transient "Directory not empty". Tolerate it rather than
    # let a teardown race fail an otherwise-passing test (seen flaky on py3.13).
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'oib.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)
        yield db_url


@pytest.fixture
def store(summary_db):
    return DocumentMetadataStore(summary_db)


class _FakeBucket:
    """The BFF's presigned upload and delete, and SeaweedFS, as a dict."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.deletes: list[str] = []
        self.refuse_uploads = False
        self.refuse_names: set[str] = set()

    def request_upload_url(self, name):
        if self.refuse_uploads or name in self.refuse_names:
            raise corpus_store.CorpusStoreError(f"upload-url request for {name} was refused (HTTP 503)")
        return f"https://upload.invalid/{name}", f"base-corpus/{name}"

    def put_object(self, upload_url, data):
        self.objects[f"base-corpus/{upload_url.rsplit('/', 1)[1]}"] = data

    def delete_object(self, name):
        self.deletes.append(name)
        self.objects.pop(f"base-corpus/{name}", None)

    def download_object(self, storage_key, out):
        if storage_key not in self.objects:
            raise corpus_store.CorpusStoreError(f"download of {storage_key} failed: NoSuchKey")
        out.write(self.objects[storage_key])


@pytest.fixture
def bucket(monkeypatch, tmp_path):
    """The corpus: a fake bucket, a fresh table and an empty cache directory."""
    fake = _FakeBucket()
    monkeypatch.setenv("AIQ_SUMMARY_DB", os.environ.get("GRID_TEST_CORPUS_DB") or f"sqlite:///{tmp_path / 'corpus.db'}")
    monkeypatch.setenv(corpus_store.CACHE_DIR_ENV, str(tmp_path / "cache"))
    monkeypatch.setattr(corpus_store, "_request_upload_url", fake.request_upload_url)
    monkeypatch.setattr(corpus_store, "_put_object", fake.put_object)
    monkeypatch.setattr(corpus_store, "_delete_object", fake.delete_object)
    monkeypatch.setattr(corpus_store, "_download_object", fake.download_object)
    monkeypatch.delenv("GRID_INGEST_QUEUE", raising=False)
    monkeypatch.delenv("GRID_JOB_PAYLOAD_KEK", raising=False)
    with corpus_store._transaction() as conn:
        conn.execute(delete(corpus_store._files))
    ingest_status_store.get("never-existed")  # creates the status and queue tables
    with DocumentMetadataStore._get_or_create_sync_engine(ingest_queue.db_url()).begin() as conn:
        for table in ("ingest_jobs", ingest_queue.TABLE):
            conn.execute(text(f"DELETE FROM {table}"))
    return fake


@pytest.fixture
def cache_dir(tmp_path):
    return tmp_path / "cache"


class _FakeIngestor:
    """Can prepare a job (a PENDING status, as the real ingestor does) and delete chunks; it never ingests."""

    supports_durable_jobs = True
    backend_name = "fake"

    def __init__(self):
        self.prepared: list[PreparedIngestJob] = []
        self.deleted: list[str] = []
        self.indexed: set[str] = set()

    @property
    def names(self) -> list[str]:
        return [job.config["original_filenames"][0] for job in self.prepared]

    def get_collection(self, _collection):
        return object()

    def prepare_job(self, file_paths, collection_name, config=None, job_id=None):
        config = dict(config or {})
        status = IngestionJobStatus(
            job_id=job_id,
            status=JobState.PENDING,
            submitted_at=datetime.now(UTC).replace(tzinfo=None),
            total_files=len(file_paths),
            collection_name=collection_name,
            backend=self.backend_name,
            file_details=[
                FileProgress(file_id=f"{job_id}-{i}", file_name=name, status=FileStatus.UPLOADING)
                for i, name in enumerate(config["original_filenames"])
            ],
        )
        ingest_status_store.put(status)
        prepared = PreparedIngestJob(job_id, status, list(file_paths), collection_name, config)
        self.prepared.append(prepared)
        return prepared

    def upload_file(self, *_args, **_kwargs):
        raise AssertionError("a route must queue an ingestion, never run one")

    submit_job = submit_prepared = run_prepared = upload_file

    def delete_file(self, name, _collection):
        self.deleted.append(name)
        self.indexed.discard(name)
        return True

    def list_files(self, _collection):
        return [type("Info", (), {"file_name": name})() for name in sorted(self.indexed)]


@pytest.fixture
def ingestor(monkeypatch, bucket):
    monkeypatch.setattr(oib_sync, "COLLECTION_NAME", _COLLECTION)
    fake = _FakeIngestor()
    monkeypatch.setattr(oib_sync, "_get_oib_ingestor", lambda: fake)
    return fake


@pytest.fixture
def app(summary_db, bucket, ingestor):
    app = FastAPI()
    router = APIRouter()
    add_oib_routes(router)
    app.include_router(router)
    return app


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _pdf_bytes(marker: bytes = b"%PDF-1.4 fake") -> bytes:
    return marker


@pytest.mark.asyncio
async def test_upload_explicit_doc_class_persists(app, ingestor, bucket, cache_dir):
    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": ("plan.pdf", _pdf_bytes(), "application/pdf")},
            data={"doc_class": "oib_leitfaden"},
        )

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "pending"
    assert body["kind"] == "file"
    assert body["file_name"] == "plan.pdf"
    assert body["doc_class"] == "oib_leitfaden"
    # Stored in the shared corpus before the response: the object, the row, this replica's cache.
    assert bucket.objects == {"base-corpus/plan.pdf": _pdf_bytes()}
    assert corpus_store.get_file("plan.pdf") is not None
    assert (cache_dir / "plan.pdf").is_file()
    # One job on the ingest queue, carrying the admin's Dokumentart; nothing ingested here.
    assert ingestor.names == ["plan.pdf"]
    assert ingestor.prepared[0].config["doc_class"] == "oib_leitfaden"
    assert ingest_queue.counts()["queued"] == 1


@pytest.mark.asyncio
async def test_upload_without_doc_class_uses_guess(app, ingestor):
    from aiq_agent.common.norm_registry import guess_doc_class

    name = "oib-rl_2_brandschutz.pdf"
    expected = guess_doc_class(name)

    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": (name, _pdf_bytes(), "application/pdf")},
        )

    assert res.status_code == 200
    assert res.json()["doc_class"] == expected
    assert ingestor.prepared[0].config["doc_class"] == expected


@pytest.mark.asyncio
async def test_upload_invalid_doc_class_400(app, bucket, ingestor):
    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": ("plan.pdf", _pdf_bytes(), "application/pdf")},
            data={"doc_class": "not_a_real_class"},
        )

    assert res.status_code == 400
    # Nothing was stored for the rejected upload.
    assert bucket.objects == {}
    assert corpus_store.get_file("plan.pdf") is None
    assert ingestor.prepared == []


def _build_zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


@pytest.mark.asyncio
async def test_zip_happy_path_and_skips(app, ingestor, bucket):
    content = _build_zip(
        {
            "a.pdf": _pdf_bytes(),
            "sub/b.pdf": _pdf_bytes(),  # nested but safe
            "notes.txt": b"ignore me",  # non-pdf skipped
        }
    )

    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": ("bulk.zip", content, "application/zip")},
        )

    assert res.status_code == 200
    body = res.json()
    assert body["kind"] == "zip"
    assert body["status"] == "pending"
    assert body["accepted"] == 2
    assert body["rejected"] == 1
    accepted_names = {m["file_name"] for m in body["members"] if m["status"] == "pending"}
    assert accepted_names == {"a.pdf", "b.pdf"}
    rejected = [m for m in body["members"] if m["status"] == "rejected"]
    assert rejected[0]["file_name"] == "notes.txt"
    # Both PDFs are stored by basename.
    assert set(bucket.objects) == {"base-corpus/a.pdf", "base-corpus/b.pdf"}
    assert set(corpus_store.list_files()) == {"a.pdf", "b.pdf"}
    assert sorted(ingestor.names) == ["a.pdf", "b.pdf"]
    assert ingest_queue.counts()["queued"] == 2


@pytest.mark.asyncio
async def test_zip_slip_member_rejected(app, bucket):
    # zipfile.writestr won't normalize a traversal path, so it lands verbatim.
    content = _build_zip({"../escape.pdf": _pdf_bytes(), "ok.pdf": _pdf_bytes()})

    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": ("bulk.zip", content, "application/zip")},
        )

    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] == 1
    assert body["rejected"] == 1
    rejected = [m for m in body["members"] if m["status"] == "rejected"][0]
    assert "unsafe" in rejected["reason"].lower()
    # The traversal target was never stored.
    assert set(bucket.objects) == {"base-corpus/ok.pdf"}


@pytest.mark.asyncio
async def test_upload_the_store_refuses_is_an_error_and_queues_no_ingestion(app, bucket, ingestor, cache_dir):
    bucket.refuse_uploads = True

    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents", files={"file": ("plan.pdf", _pdf_bytes(), "application/pdf")}
        )

    assert res.status_code == 500
    assert "refused" in res.json()["detail"]
    assert ingestor.prepared == []
    assert ingest_queue.counts()["queued"] == 0
    assert corpus_store.get_file("plan.pdf") is None
    assert not (cache_dir / "plan.pdf").exists()


@pytest.mark.asyncio
async def test_a_zip_member_the_store_refuses_is_rejected_and_the_others_go_on(app, bucket, ingestor):
    bucket.refuse_names = {"bad.pdf"}
    content = _build_zip({"good.pdf": _pdf_bytes(), "bad.pdf": _pdf_bytes()})

    async with _client(app) as client:
        res = await client.post("/v1/admin/oib/documents", files={"file": ("bulk.zip", content, "application/zip")})

    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] == 1 and body["rejected"] == 1
    assert {m["file_name"]: m["status"] for m in body["members"]} == {"good.pdf": "pending", "bad.pdf": "rejected"}
    assert ingestor.names == ["good.pdf"]


@pytest.mark.asyncio
async def test_a_zip_member_the_queue_refuses_is_rejected_and_the_others_go_on(app, bucket, ingestor, monkeypatch):
    real = ingest_dispatch.enqueue_only

    def enqueue(prepared):
        if prepared.config["original_filenames"] == ["bad.pdf"]:
            raise ingest_dispatch.QueueUnavailable("could not queue it")
        return real(prepared)

    monkeypatch.setattr(ingest_dispatch, "enqueue_only", enqueue)
    content = _build_zip({"good.pdf": _pdf_bytes(), "bad.pdf": _pdf_bytes()})

    async with _client(app) as client:
        res = await client.post("/v1/admin/oib/documents", files={"file": ("bulk.zip", content, "application/zip")})

    assert res.status_code == 200
    body = res.json()
    assert {m["file_name"]: m["status"] for m in body["members"]} == {"good.pdf": "pending", "bad.pdf": "rejected"}
    assert ingest_queue.counts()["queued"] == 1


@pytest.mark.asyncio
async def test_an_upload_queues_the_ingestion_of_the_file_it_stored(app, ingestor):
    async with _client(app) as client:
        await client.post("/v1/admin/oib/documents", files={"file": ("plan.pdf", _pdf_bytes(), "application/pdf")})

    assert ingestor.names == ["plan.pdf"]
    claim = ingest_queue.claim_next("w1", stale_seconds=180, max_attempts=3)
    assert claim is not None and claim.job_id == ingestor.prepared[0].job_id


@pytest.mark.asyncio
async def test_an_upload_when_the_queue_is_off_is_an_error_not_an_in_process_ingestion(
    app, bucket, ingestor, monkeypatch
):
    monkeypatch.setenv("GRID_INGEST_QUEUE", "off")

    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents", files={"file": ("plan.pdf", _pdf_bytes(), "application/pdf")}
        )

    assert res.status_code == 500
    assert "ingest queue is off" in res.json()["detail"]
    # The file is kept: the next sync cycle queues it as soon as the queue is back.
    assert corpus_store.get_file("plan.pdf") is not None
    assert bucket.objects == {"base-corpus/plan.pdf": _pdf_bytes()}
    assert ingest_queue.counts()["queued"] == 0


@pytest.mark.asyncio
async def test_the_same_bytes_uploaded_twice_are_one_job(app, ingestor):
    async with _client(app) as client:
        for _ in range(2):
            res = await client.post(
                "/v1/admin/oib/documents", files={"file": ("plan.pdf", _pdf_bytes(), "application/pdf")}
            )
            assert res.status_code == 200

    assert ingest_queue.counts()["queued"] == 1
    assert len(ingestor.prepared) == 1


@pytest.mark.asyncio
async def test_patch_doc_class_updates(app, store):
    register_summary(_COLLECTION, "plan.pdf", "A plan.")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/admin/oib/documents/plan.pdf/doc-class",
            json={"doc_class": "gesetz"},
        )

    assert res.status_code == 200
    assert res.json() == {"file_name": "plan.pdf", "doc_class": "gesetz"}
    assert store.get_doc_class(_COLLECTION, "plan.pdf") == "gesetz"


@pytest.mark.asyncio
async def test_a_person_setting_the_doc_class_clears_the_suggestion(app, store):
    """ADR-0064 use 8: once someone has decided, the page has nothing left to offer."""
    register_summary(_COLLECTION, "plan.pdf", "A plan.")
    store.set_doc_class_suggestion(_COLLECTION, "plan.pdf", "gesetz")

    async with _client(app) as client:
        res = await client.patch("/v1/admin/oib/documents/plan.pdf/doc-class", json={"doc_class": "sonstiges"})

    assert res.status_code == 200
    assert store.get_doc_class_suggestions_batch(_COLLECTION, ["plan.pdf"]) == {}


@pytest.mark.asyncio
async def test_patch_invalid_doc_class_400(app, store):
    register_summary(_COLLECTION, "plan.pdf", "A plan.")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/admin/oib/documents/plan.pdf/doc-class",
            json={"doc_class": "bogus"},
        )

    assert res.status_code == 400
    assert store.get_doc_class(_COLLECTION, "plan.pdf") is None


@pytest.mark.asyncio
async def test_patch_missing_row_404(app):
    async with _client(app) as client:
        res = await client.patch(
            "/v1/admin/oib/documents/ghost.pdf/doc-class",
            json={"doc_class": "gesetz"},
        )

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_patch_display_title_updates(app, store):
    register_summary(_COLLECTION, "plan.pdf", "A plan.")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/admin/oib/documents/plan.pdf/display-title",
            json={"display_title": "OIB-Richtlinie 2, Ausgabe Mai 2023"},
        )

    assert res.status_code == 200
    assert res.json() == {"file_name": "plan.pdf", "display_title": "OIB-Richtlinie 2, Ausgabe Mai 2023"}
    assert store.get_display_title(_COLLECTION, "plan.pdf") == "OIB-Richtlinie 2, Ausgabe Mai 2023"


@pytest.mark.asyncio
async def test_patch_display_title_blank_clears_override(app, store):
    register_summary(_COLLECTION, "plan.pdf", "A plan.")
    store.set_display_title(_COLLECTION, "plan.pdf", "A custom name")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/admin/oib/documents/plan.pdf/display-title",
            json={"display_title": "   "},
        )

    assert res.status_code == 200
    assert res.json() == {"file_name": "plan.pdf", "display_title": None}
    # Cleared → the derived default applies again on read.
    assert store.get_display_title(_COLLECTION, "plan.pdf") is None


@pytest.mark.asyncio
async def test_patch_display_title_missing_row_404(app):
    async with _client(app) as client:
        res = await client.patch(
            "/v1/admin/oib/documents/ghost.pdf/display-title",
            json={"display_title": "Anything"},
        )

    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Delete: there is one kind, and it deletes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_removes_chunks_row_object_and_cached_copy(app, bucket, ingestor, cache_dir):
    corpus_store.put("custom.pdf", _pdf_bytes())
    register_summary(_COLLECTION, "custom.pdf", "summary")

    async with _client(app) as client:
        res = await client.delete("/v1/admin/oib/documents/custom.pdf")

    assert res.status_code == 200
    assert res.json() == {"success": True, "file_name": "custom.pdf"}
    assert ingestor.deleted == ["custom.pdf"]
    assert bucket.objects == {}
    assert corpus_store.get_file("custom.pdf") is None
    assert not (cache_dir / "custom.pdf").exists()


@pytest.mark.asyncio
async def test_delete_cancels_the_ingestion_that_is_still_queued(app, ingestor):
    async with _client(app) as client:
        await client.post("/v1/admin/oib/documents", files={"file": ("plan.pdf", _pdf_bytes(), "application/pdf")})
        assert ingest_queue.counts()["queued"] == 1

        res = await client.delete("/v1/admin/oib/documents/plan.pdf")

    assert res.status_code == 200
    assert ingest_queue.counts()["queued"] == 0
    assert ingest_status_store.get(ingestor.prepared[0].job_id) is None


@pytest.mark.asyncio
async def test_delete_reaches_a_document_another_replica_uploaded(app, bucket, ingestor, cache_dir):
    corpus_store.put("elsewhere.pdf", _pdf_bytes())
    (cache_dir / "elsewhere.pdf").unlink()  # this replica never held it

    async with _client(app) as client:
        res = await client.delete("/v1/admin/oib/documents/elsewhere.pdf")

    assert res.status_code == 200
    assert bucket.objects == {} and corpus_store.get_file("elsewhere.pdf") is None


@pytest.mark.asyncio
async def test_delete_clears_chunks_the_corpus_no_longer_lists(app, ingestor):
    ingestor.indexed.add("leftover.pdf")

    async with _client(app) as client:
        res = await client.delete("/v1/admin/oib/documents/leftover.pdf")

    assert res.status_code == 200
    assert ingestor.deleted == ["leftover.pdf"]


@pytest.mark.asyncio
async def test_delete_unknown_document_404(app):
    async with _client(app) as client:
        res = await client.delete("/v1/admin/oib/documents/ghost.pdf")

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_a_deleted_document_can_be_uploaded_again(app, bucket):
    async with _client(app) as client:
        await client.post("/v1/admin/oib/documents", files={"file": ("again.pdf", _pdf_bytes(), "application/pdf")})
        await client.delete("/v1/admin/oib/documents/again.pdf")
        res = await client.post(
            "/v1/admin/oib/documents", files={"file": ("again.pdf", _pdf_bytes(b"%PDF v2"), "application/pdf")}
        )

    assert res.status_code == 200
    assert bucket.objects == {"base-corpus/again.pdf": b"%PDF v2"}
    assert list(corpus_store.list_files()) == ["again.pdf"]


@pytest.mark.asyncio
async def test_a_store_that_cannot_delete_the_object_is_a_500_and_the_document_is_out_of_the_corpus(
    app, monkeypatch, ingestor
):
    corpus_store.put("custom.pdf", _pdf_bytes())

    def refuse(_name):
        raise corpus_store.CorpusStoreError("delete of custom.pdf from the object store was refused (HTTP 500)")

    monkeypatch.setattr(corpus_store, "_delete_object", refuse)

    async with _client(app) as client:
        res = await client.delete("/v1/admin/oib/documents/custom.pdf")

    assert res.status_code == 500
    assert corpus_store.get_file("custom.pdf") is None


# ---------------------------------------------------------------------------
# Sync, run by hand
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_manual_sync_runs_one_cycle_and_reports_its_counts(app, monkeypatch):
    monkeypatch.setattr(
        oib_sync, "sync", lambda: oib_sync.SyncResult(enqueued=2, ingested_recorded=3, failed=1, total=5)
    )

    async with _client(app) as client:
        res = await client.post("/v1/admin/oib/sync")

    assert res.status_code == 200
    body = res.json()
    assert body["files_added"] == 2 and body["files_total"] == 5
    assert body["message"] == (
        "OIB sync finished: 2 file(s) queued for ingestion, 3 finished, 1 failed, 5 total tracked"
    )


@pytest.mark.asyncio
async def test_a_manual_sync_that_breaks_is_a_500(app, monkeypatch):
    def broken():
        raise corpus_store.CorpusStoreError("the base corpus needs AIQ_SUMMARY_DB")

    monkeypatch.setattr(oib_sync, "sync", broken)

    async with _client(app) as client:
        res = await client.post("/v1/admin/oib/sync")

    assert res.status_code == 500


# ---------------------------------------------------------------------------
# Subset re-ingest
#
# The change detector gates on the sha256 of the PDF bytes, so it is a no-op for a file
# that has not changed. That is right for "has anything new arrived" and wrong after a
# change to how chunks are BUILT — which is when an admin needs exactly these
# documents rebuilt and nothing else.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reingest_queues_only_the_named_documents(app, ingestor):
    for name in ("a.pdf", "b.pdf", "c.pdf"):
        corpus_store.put(name, _pdf_bytes())
        corpus_store.mark_ingested(name, corpus_store.get_file(name).sha256, oib_sync.CHUNK_FORMAT_VERSION)

    async with _client(app) as client:
        response = await client.post("/v1/admin/oib/reingest", json={"file_names": ["a.pdf", "c.pdf"]})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "pending"
    assert sorted(body["queued"]) == ["a.pdf", "c.pdf"]
    assert body["unknown"] == []
    assert sorted(ingestor.names) == ["a.pdf", "c.pdf"], "b.pdf was not selected and must not be touched"
    assert ingest_queue.counts()["queued"] == 2
    # Queued documents read as not ingested (PENDING in the status panel) until their chunks are rebuilt.
    assert corpus_store.get_file("a.pdf").ingested_sha256 is None
    assert corpus_store.get_file("b.pdf").ingested_sha256 is not None


@pytest.mark.asyncio
async def test_reingesting_twice_while_the_first_job_waits_is_still_one_job(app, ingestor):
    corpus_store.put("a.pdf", _pdf_bytes())
    corpus_store.mark_ingested("a.pdf", corpus_store.get_file("a.pdf").sha256, oib_sync.CHUNK_FORMAT_VERSION)

    async with _client(app) as client:
        for _ in range(2):
            response = await client.post("/v1/admin/oib/reingest", json={"file_names": ["a.pdf"]})
            assert response.status_code == 200

    assert ingest_queue.counts()["queued"] == 1
    assert ingestor.names == ["a.pdf"]


@pytest.mark.asyncio
async def test_reingest_reports_unknown_names_instead_of_failing_the_request(app, ingestor):
    """One stale name must not discard a selection of twenty."""
    corpus_store.put("a.pdf", _pdf_bytes())

    async with _client(app) as client:
        response = await client.post("/v1/admin/oib/reingest", json={"file_names": ["a.pdf", "ghost.pdf"]})

    assert response.status_code == 200
    body = response.json()
    assert body["queued"] == ["a.pdf"]
    assert body["unknown"] == ["ghost.pdf"]


@pytest.mark.asyncio
async def test_reingest_of_nothing_known_is_a_noop_not_a_pending_job(app, ingestor):
    async with _client(app) as client:
        response = await client.post("/v1/admin/oib/reingest", json={"file_names": ["ghost.pdf"]})

    assert response.status_code == 200
    assert response.json()["status"] == "noop"
    assert ingestor.prepared == []


@pytest.mark.asyncio
async def test_reingest_rejects_an_empty_selection(app):
    async with _client(app) as client:
        response = await client.post("/v1/admin/oib/reingest", json={"file_names": []})
    assert response.status_code == 422, "an empty selection is a client bug, not a no-op"


# ---------------------------------------------------------------------------
# The source PDF route
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_document_this_replica_does_not_hold_is_fetched_and_served(app, bucket, cache_dir):
    corpus_store.put("elsewhere.pdf", b"%PDF elsewhere")
    (cache_dir / "elsewhere.pdf").unlink()

    async with _client(app) as client:
        res = await client.get("/v1/oib/documents/elsewhere.pdf")

    assert res.status_code == 200
    assert res.content == b"%PDF elsewhere"
    assert res.headers["content-type"] == "application/pdf"
    assert (cache_dir / "elsewhere.pdf").is_file()


@pytest.mark.asyncio
async def test_a_document_removed_elsewhere_is_not_served_from_a_stale_cache(app, cache_dir):
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "removed.pdf").write_bytes(b"%PDF stale")

    async with _client(app) as client:
        res = await client.get("/v1/oib/documents/removed.pdf")

    assert res.status_code == 404
    assert not (cache_dir / "removed.pdf").exists()


@pytest.mark.asyncio
async def test_a_listed_document_the_object_store_cannot_serve_is_503_not_404(app, bucket, cache_dir):
    corpus_store.put("lost.pdf", b"%PDF lost")
    (cache_dir / "lost.pdf").unlink()
    bucket.objects.clear()

    async with _client(app) as client:
        res = await client.get("/v1/oib/documents/lost.pdf")

    assert res.status_code == 503


@pytest.mark.asyncio
async def test_the_pdf_route_refuses_what_is_not_a_plain_pdf_name(app):
    async with _client(app) as client:
        res = await client.get("/v1/oib/documents/notes.txt")

    assert res.status_code == 404


class TestCorpusExport:
    """The corpus as one .tar.gz for a CI ingest; never served without a configured token."""

    @pytest.fixture
    def corpus(self, monkeypatch, cache_dir, bucket):
        from aiq_api.routes import oib as oib_routes

        corpus_store.put("oib-rl_2_ausgabe_mai_2023.pdf", b"%PDF first")
        corpus_store.put("oib-rl_4_ausgabe_mai_2023.pdf", b"%PDF second")
        (cache_dir / "oib-rl_4_ausgabe_mai_2023.pdf").unlink()  # uploaded through another replica
        monkeypatch.setattr(oib_routes, "_ADMIN_TOKEN", "t0k3n")

    @pytest.mark.asyncio
    async def test_it_holds_every_pdf_of_the_corpus_under_its_basename(self, app, corpus):
        async with _client(app) as client:
            res = await client.get("/v1/admin/oib/corpus.tar.gz", headers={"X-Admin-Token": "t0k3n"})
        assert res.status_code == 200 and res.headers["content-type"] == "application/gzip"
        with tarfile.open(fileobj=io.BytesIO(res.content), mode="r:gz") as archive:
            assert sorted(archive.getnames()) == ["oib-rl_2_ausgabe_mai_2023.pdf", "oib-rl_4_ausgabe_mai_2023.pdf"]
            assert archive.extractfile("oib-rl_4_ausgabe_mai_2023.pdf").read() == b"%PDF second"

    @pytest.mark.asyncio
    async def test_a_refused_range_request_leaves_no_archive(self, app, corpus, tmp_path, monkeypatch):
        scratch = tmp_path / "tmp"
        scratch.mkdir()
        monkeypatch.setattr(tempfile, "tempdir", str(scratch))
        async with _client(app) as client:
            res = await client.get(
                "/v1/admin/oib/corpus.tar.gz", headers={"X-Admin-Token": "t0k3n", "Range": "bytes=999999999-"}
            )
        assert res.status_code == 416
        assert list(scratch.iterdir()) == []

    @pytest.mark.asyncio
    async def test_a_wrong_token_is_refused(self, app, corpus):
        async with _client(app) as client:
            res = await client.get("/v1/admin/oib/corpus.tar.gz", headers={"X-Admin-Token": "nope"})
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_no_configured_token_fails_closed(self, app, corpus, monkeypatch):
        from aiq_api.routes import oib as oib_routes

        monkeypatch.setattr(oib_routes, "_ADMIN_TOKEN", None)
        async with _client(app) as client:
            res = await client.get("/v1/admin/oib/corpus.tar.gz")
        assert res.status_code == 503

    def test_a_failed_build_leaves_no_partial_archive(self, corpus, tmp_path, monkeypatch):
        from aiq_api.routes import oib as oib_routes

        scratch = tmp_path / "tmp"
        scratch.mkdir()
        monkeypatch.setattr(tempfile, "tempdir", str(scratch))

        def broken(self, *args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr("tarfile.TarFile.add", broken)
        with pytest.raises(OSError):
            oib_routes._corpus_tarball()
        assert list(scratch.iterdir()) == []

    def test_a_file_that_cannot_be_fetched_fails_the_export_instead_of_shipping_half_a_corpus(
        self, corpus, bucket, tmp_path, monkeypatch
    ):
        from aiq_api.routes import oib as oib_routes

        scratch = tmp_path / "tmp"
        scratch.mkdir()
        monkeypatch.setattr(tempfile, "tempdir", str(scratch))
        bucket.objects.clear()

        with pytest.raises(corpus_store.CorpusStoreError):
            oib_routes._corpus_tarball()
        assert list(scratch.iterdir()) == []

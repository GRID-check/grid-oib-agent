"""The corpus status: the table merged with what the index holds (ADR-0082, step A2)."""

import hashlib
from datetime import UTC
from datetime import datetime

import pytest

from aiq_agent import corpus_store
from aiq_agent import oib_status
from aiq_agent import oib_sync
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.schema import CollectionInfo
from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.oib_status import OibFileState
from tests.corpus_job_fakes import FakeIngestor as JobIngestor
from tests.corpus_job_fakes import lose_the_workers_for
from tests.corpus_job_fakes import run_worker
from tests.object_corpus_fakes import install


class FakeIngestor:
    def __init__(self, collection: CollectionInfo | None, files: list[FileInfo] | None = None) -> None:
        self.collection = collection
        self.files = files or []

    def get_collection(self, _name: str) -> CollectionInfo | None:
        return self.collection

    def list_files(self, _name: str) -> list[FileInfo]:
        return self.files


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _collection(chunk_count: int = 10) -> CollectionInfo:
    return CollectionInfo(
        name="test_collection",
        chunk_count=chunk_count,
        backend="fake",
        updated_at=datetime(2026, 7, 1, tzinfo=UTC),
    )


def _file_info(name: str, chunk_count: int) -> FileInfo:
    return FileInfo(
        file_id=name,
        file_name=name,
        collection_name="test_collection",
        status=FileStatus.SUCCESS,
        chunk_count=chunk_count,
        ingested_at=datetime(2026, 6, 30, tzinfo=UTC),
    )


@pytest.fixture(autouse=True)
def corpus(monkeypatch, tmp_path):
    monkeypatch.setattr(oib_sync, "COLLECTION_NAME", "test_collection")
    monkeypatch.setattr(oib_status, "_load_summaries", lambda _name: {})
    monkeypatch.setattr(oib_status, "_load_suggestions", lambda _name, _files: {})
    return install(monkeypatch, tmp_path)


def _stored(name: str, content: bytes, *, ingested: bytes | None = None, format_version: int | None = None) -> None:
    """A corpus file, optionally with the bytes the index was last built from."""
    corpus_store.put(name, content)
    if ingested is None:
        return
    # `mark_ingested` only records bytes the row still holds, so replay the history it would have had.
    corpus_store.put(name, ingested)
    corpus_store.mark_ingested(name, _sha256(ingested), format_version or oib_sync.CHUNK_FORMAT_VERSION)
    corpus_store.put(name, content)


def test_status_classifies_ingested_stale_and_pending():
    _stored("ingested.pdf", b"v1", ingested=b"v1")
    _stored("stale.pdf", b"v2-new", ingested=b"v2-old")
    _stored("pending.pdf", b"v3")
    ingestor = FakeIngestor(
        _collection(chunk_count=12),
        files=[_file_info("ingested.pdf", 8), _file_info("stale.pdf", 4)],
    )

    status = oib_status.get_status(ingestor=ingestor)

    by_name = {f.file_name: f for f in status.files}
    assert status.collection_exists is True
    assert status.collection_name == "test_collection"
    assert by_name["ingested.pdf"].state == OibFileState.INGESTED
    assert by_name["ingested.pdf"].chunk_count == 8
    assert by_name["ingested.pdf"].current_sha256 == _sha256(b"v1")
    assert by_name["ingested.pdf"].ingested_sha256 == _sha256(b"v1")
    assert by_name["ingested.pdf"].size_bytes == 2
    assert by_name["stale.pdf"].state == OibFileState.STALE
    assert by_name["stale.pdf"].ingested_sha256 == _sha256(b"v2-old")
    assert by_name["pending.pdf"].state == OibFileState.PENDING
    assert by_name["pending.pdf"].ingested_sha256 is None
    assert status.summary.total_files == 3
    assert status.summary.ingested == 1
    assert status.summary.stale == 1
    assert status.summary.pending == 1
    assert status.summary.total_chunks == 12


def test_a_file_ingested_by_an_older_chunk_format_is_stale():
    _stored("old-format.pdf", b"x", ingested=b"x", format_version=oib_sync.CHUNK_FORMAT_VERSION - 1)
    ingestor = FakeIngestor(_collection(), files=[_file_info("old-format.pdf", 5)])

    status = oib_status.get_status(ingestor=ingestor)

    assert status.files[0].state == OibFileState.STALE


def test_status_flags_removed_and_inconsistent_files():
    _stored("no_chunks.pdf", b"x", ingested=b"x")
    # "orphan.pdf" only exists in the collection: chunks the corpus does not list.
    ingestor = FakeIngestor(_collection(), files=[_file_info("orphan.pdf", 5)])

    status = oib_status.get_status(ingestor=ingestor)

    by_name = {f.file_name: f for f in status.files}
    assert by_name["no_chunks.pdf"].state == OibFileState.INCONSISTENT
    assert by_name["orphan.pdf"].state == OibFileState.REMOVED
    assert by_name["orphan.pdf"].chunk_count == 5
    assert by_name["orphan.pdf"].size_bytes is None
    assert by_name["orphan.pdf"].current_sha256 is None
    assert status.summary.removed == 1
    assert status.summary.inconsistent == 1


def test_status_before_first_sync_reports_everything_pending():
    _stored("a.pdf", b"a")
    _stored("b.pdf", b"b")
    ingestor = FakeIngestor(collection=None)

    status = oib_status.get_status(ingestor=ingestor)

    assert status.collection_exists is False
    assert status.summary.total_files == 2
    assert status.summary.pending == 2
    assert status.summary.total_chunks == 0
    assert all(f.state == OibFileState.PENDING for f in status.files)


def test_status_of_an_empty_corpus_has_no_files():
    status = oib_status.get_status(ingestor=FakeIngestor(_collection(chunk_count=0)))

    assert status.files == []
    assert status.summary.total_files == 0


def test_status_attaches_document_summaries(monkeypatch):
    _stored("a.pdf", b"a", ingested=b"a")
    monkeypatch.setattr(
        oib_status,
        "_load_summaries",
        lambda _name: {"a.pdf": ("Brandschutz basics.", None, "Custom OIB name")},
    )
    ingestor = FakeIngestor(_collection(), files=[_file_info("a.pdf", 3)])

    status = oib_status.get_status(ingestor=ingestor)

    assert status.files[0].summary == "Brandschutz basics."
    # The stored display-title override is surfaced as the effective name.
    assert status.files[0].display_title == "Custom OIB name"


def test_status_display_title_falls_back_to_derived_default():
    """An OIB file with no stored override still gets an effective name."""
    name = "oib-rl_2_ausgabe_mai_2023.pdf"
    _stored(name, b"a", ingested=b"a")
    ingestor = FakeIngestor(_collection(), files=[_file_info(name, 3)])

    status = oib_status.get_status(ingestor=ingestor)

    assert status.files[0].display_title == "OIB-Richtlinie 2, Ausgabe Mai 2023"


def test_status_files_are_sorted_by_name():
    _stored("z.pdf", b"z")
    _stored("a.pdf", b"a")
    ingestor = FakeIngestor(_collection(), files=[_file_info("m.pdf", 1)])

    status = oib_status.get_status(ingestor=ingestor)

    assert [f.file_name for f in status.files] == ["a.pdf", "m.pdf", "z.pdf"]


def test_a_collection_that_cannot_be_listed_still_reports_the_corpus():
    _stored("a.pdf", b"a", ingested=b"a")

    class Unlistable(FakeIngestor):
        def list_files(self, _name):
            raise ConnectionError("chroma is down")

    status = oib_status.get_status(ingestor=Unlistable(_collection()))

    assert [f.file_name for f in status.files] == ["a.pdf"]
    assert status.files[0].state == OibFileState.INCONSISTENT


def test_the_response_carries_no_trace_of_the_removed_concepts():
    _stored("a.pdf", b"a")

    payload = oib_status.get_status(ingestor=FakeIngestor(_collection())).model_dump()

    assert "documents_dir" not in payload
    assert "snapshot" not in payload["summary"]
    assert "origin" not in payload["files"][0]
    assert {state.value for state in OibFileState} == {
        "ingested",
        "stale",
        "pending",
        "failed",
        "removed",
        "inconsistent",
    }


# ---------------------------------------------------------------------------
# What the ingest jobs say
# ---------------------------------------------------------------------------


@pytest.fixture
def jobs(monkeypatch):
    """The corpus's ingest jobs: a fake ingestor that only prepares them, and a worker to finish them."""
    monkeypatch.setattr(oib_sync, "_get_oib_ingestor", lambda: JobIngestor())


def test_a_file_whose_job_waits_is_pending(jobs):
    _stored("a.pdf", b"a")
    oib_sync.sync()

    status = oib_status.get_status(ingestor=FakeIngestor(_collection()))

    assert status.files[0].state == OibFileState.PENDING
    assert status.summary.failed == 0


def test_a_file_whose_job_ran_and_failed_is_failed_and_counted(jobs):
    _stored("a.pdf", b"a")
    _stored("b.pdf", b"b")
    oib_sync.sync()
    run_worker(succeed=False)

    status = oib_status.get_status(ingestor=FakeIngestor(_collection()))

    assert {f.file_name: f.state for f in status.files} == {"a.pdf": OibFileState.FAILED, "b.pdf": OibFileState.FAILED}
    assert status.summary.failed == 2
    assert status.summary.pending == 0


def test_a_file_whose_job_died_with_its_workers_is_failed(jobs):
    row = corpus_store.put("a.pdf", b"a")
    oib_sync.sync()
    lose_the_workers_for(oib_sync.job_id_for(row))

    status = oib_status.get_status(ingestor=FakeIngestor(_collection()))

    assert status.files[0].state == OibFileState.FAILED


def test_a_failure_stays_failed_after_the_job_row_is_gone(jobs):
    row = corpus_store.put("a.pdf", b"a")
    oib_sync.sync()
    run_worker(succeed=False)
    oib_status.get_status(ingestor=FakeIngestor(_collection()))
    ingest_status_store.delete(oib_sync.job_id_for(row))

    status = oib_status.get_status(ingestor=FakeIngestor(_collection()))

    assert status.files[0].state == OibFileState.FAILED


def test_new_bytes_take_a_failed_file_out_of_failed(jobs):
    _stored("a.pdf", b"a")
    oib_sync.sync()
    run_worker(succeed=False)
    oib_status.get_status(ingestor=FakeIngestor(_collection()))

    corpus_store.put("a.pdf", b"a, corrected")
    status = oib_status.get_status(ingestor=FakeIngestor(_collection()))

    assert status.files[0].state == OibFileState.PENDING


def test_a_finished_job_reads_ingested_at_once_without_waiting_for_the_next_cycle(jobs):
    _stored("a.pdf", b"a")
    oib_sync.sync()
    run_worker()

    status = oib_status.get_status(ingestor=FakeIngestor(_collection(), files=[_file_info("a.pdf", 4)]))

    assert status.files[0].state == OibFileState.INGESTED
    assert status.files[0].ingested_sha256 == _sha256(b"a")
    assert corpus_store.get_file("a.pdf").ingested_sha256 == _sha256(b"a")  # and it was recorded

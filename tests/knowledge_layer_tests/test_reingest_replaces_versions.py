"""Re-ingesting a file name REPLACES its earlier chunks, once the new version is in.

Law does not go stale, it gets replaced — the OIB sync enforces that through
its hash registry, but uploaded office/project documents had no replacement
semantics at all: re-uploading ``statik-standard.pdf`` appended a second full
set of chunks next to the first, and both versions then competed in retrieval
on similarity alone.

Replacement is two steps. ``_find_previous_versions`` runs before the job and
only reads: which chunk ids answer to each incoming name, under which stored
spellings, and what a person set on their metadata row.
``_retire_previous_version`` runs per file once that file is in the vector
store. It used to be one step that deleted first, and a re-upload that then
failed (an encrypted PDF, nothing extracted, no VLM key) left the document with
no chunks at all. The end-to-end tests at the bottom pin exactly that.

- exact-name predecessors are found; tmp-prefixed and percent-encoded stored
  names (the two forms ``delete_file`` already normalizes) match their plain
  re-upload; other files are never touched, and nothing is deleted by the find;
- the find reads the files being replaced, by a ``$in`` filter over their
  spellings, never the whole collection (once one full scan per OIB PDF);
- retirement deletes by the COLLECTED ids, in Chroma and in the lexical mirror,
  bumps the collection version, and drops the metadata row only under a stored
  spelling other than the new name (the row under the new name is the new
  version's row, and keeps what people set);
- a failure in either step never fails the ingest;
- a file that fails after some of its chunks went in takes exactly those chunks
  back out, and the previous version stays whole;
- two jobs for one name replace one after the other: the one that finishes last
  is the only version left;
- a document the BFF says was deleted while it indexed leaves none of this
  attempt's chunks and no metadata row, and retires nothing; a BFF that cannot
  answer changes nothing.
"""

import threading
import time
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.llamaindex.adapter import _PreviousVersion


@pytest.fixture()
def ingestor():
    """A bare instance — neither step touches adapter state."""
    return object.__new__(LlamaIndexIngestor)


def _collection(chunks: dict[str, str]) -> MagicMock:
    """A fake Chroma collection: ``chunks`` maps chunk id → stored file_name.

    Honours a ``file_name`` ``$in`` filter the way Chroma does, so a test sees
    what the filtered read can and cannot reach.
    """

    def get(where=None, **_kwargs):
        wanted = (where or {}).get("file_name", {}).get("$in")
        hits = {cid: name for cid, name in chunks.items() if wanted is None or name in wanted}
        return {"ids": list(hits), "metadatas": [{"file_name": name} for name in hits.values()]}

    collection = MagicMock()
    collection.get.side_effect = get
    return collection


@pytest.fixture()
def registries(monkeypatch):
    """Capture the summary/lexical-mirror cleanup and the version bump."""
    unregistered: list[tuple[str, str]] = []
    mirror_deleted: list[tuple[str, list[str]]] = []
    bumped: list[str] = []

    from aiq_agent import knowledge

    monkeypatch.setattr(knowledge, "unregister_summary", lambda coll, name: unregistered.append((coll, name)))
    store = MagicMock()
    store.delete_chunks.side_effect = lambda coll, ids: mirror_deleted.append((coll, sorted(ids)))
    from aiq_agent.knowledge import chunk_text_store

    monkeypatch.setattr(chunk_text_store, "get_chunk_text_store", lambda: store)
    monkeypatch.setattr(adapter_module, "bump_collection_version", lambda name: bumped.append(name))
    # What people set on the previous versions' rows: empty unless a test says.
    human_set: dict[str, dict[str, str]] = {"doc_class": {}, "display_title": {}, "folder_path": {}}

    def reader(field):
        return lambda coll, names: {name: human_set[field][name] for name in names if name in human_set[field]}

    monkeypatch.setattr(knowledge, "get_document_doc_classes", reader("doc_class"))
    monkeypatch.setattr(knowledge, "get_document_display_titles", reader("display_title"))
    monkeypatch.setattr(knowledge, "get_document_folder_paths", reader("folder_path"))
    # Stored names with a metadata row: where the find learns tmp[8]_ spellings.
    rows: list[str] = []
    monkeypatch.setattr(
        knowledge,
        "find_tmp_upload_names",
        lambda coll, names: [row for row in rows if adapter_module._normalized_file_name(row) in names],
    )
    return {
        "unregistered": unregistered,
        "mirror": mirror_deleted,
        "store": store,
        "bumped": bumped,
        "human_set": human_set,
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# Finding: reads only
# ---------------------------------------------------------------------------


def test_same_name_predecessor_is_found_and_nothing_is_deleted_yet(ingestor, registries):
    collection = _collection({"c1": "statik-standard.pdf", "c2": "statik-standard.pdf", "c3": "anderes-dokument.pdf"})

    found = ingestor._find_previous_versions(collection, "proj_1", ["statik-standard.pdf"])

    assert list(found) == ["statik-standard.pdf"]
    assert sorted(found["statik-standard.pdf"].chunk_ids) == ["c1", "c2"]
    assert found["statik-standard.pdf"].stored_names == ["statik-standard.pdf"]
    collection.delete.assert_not_called()
    assert registries["bumped"] == []
    assert registries["unregistered"] == []
    registries["store"].delete_chunks.assert_not_called()
    registries["store"].delete_by_file.assert_not_called()


def test_tmp_prefixed_and_percent_encoded_stored_names_match(ingestor, registries):
    # Stored under the two forms delete_file already normalizes: a backend tmp
    # copy (tmp[8 chars]_) and a presigned-URL-derived percent encoding. The
    # tmp spelling is random, so the find learns it from the metadata rows.
    registries["rows"].append("tmpa1b2c3d4_statik-standard.pdf")
    collection = _collection(
        {"c1": "tmpa1b2c3d4_statik-standard.pdf", "c2": "statik%20standard.pdf", "c3": "bleibt.pdf"}
    )

    found = ingestor._find_previous_versions(collection, "proj_1", ["statik-standard.pdf", "statik standard.pdf"])

    assert found["statik-standard.pdf"].chunk_ids == ["c1"]
    assert found["statik-standard.pdf"].stored_names == ["tmpa1b2c3d4_statik-standard.pdf"]
    assert found["statik standard.pdf"].chunk_ids == ["c2"]
    assert found["statik standard.pdf"].stored_names == ["statik%20standard.pdf"]


def test_the_find_filters_by_name_instead_of_reading_the_collection(ingestor, registries):
    collection = _collection({"c1": "statik standard.pdf", "c2": "anderes.pdf"})

    ingestor._find_previous_versions(collection, "oib_knowledge", ["statik standard.pdf"])

    collection.get.assert_called_once()
    spellings = collection.get.call_args.kwargs["where"]["file_name"]["$in"]
    assert "statik standard.pdf" in spellings
    assert "statik%20standard.pdf" in spellings
    assert "anderes.pdf" not in spellings


def test_a_tmp_prefixed_version_without_a_metadata_row_is_not_found(ingestor, registries):
    """The price of the filtered read: nothing names that spelling, so it stays."""
    collection = _collection({"c1": "tmpa1b2c3d4_statik.pdf"})
    assert ingestor._find_previous_versions(collection, "proj_1", ["statik.pdf"]) == {}


def test_first_upload_finds_nothing(ingestor, registries):
    assert ingestor._find_previous_versions(_collection({"c1": "vorhanden.pdf"}), "proj_1", ["neu.pdf"]) == {}


def test_empty_and_blank_names_are_ignored(ingestor, registries):
    collection = _collection({"c1": "statik-standard.pdf"})
    assert ingestor._find_previous_versions(collection, "proj_1", ["", None]) == {}
    collection.get.assert_not_called()


def test_a_failed_lookup_finds_nothing_and_never_fails_the_ingest(ingestor, registries):
    collection = MagicMock()
    collection.get.side_effect = RuntimeError("chroma down")
    assert ingestor._find_previous_versions(collection, "proj_1", ["statik.pdf"]) == {}


def test_what_people_set_on_the_previous_version_is_carried(ingestor, registries):
    registries["rows"].append("tmpa1b2c3d4_statik.pdf")
    registries["human_set"]["doc_class"]["tmpa1b2c3d4_statik.pdf"] = "tragwerk"
    registries["human_set"]["display_title"]["tmpa1b2c3d4_statik.pdf"] = "Statik Bauteil B"
    registries["human_set"]["folder_path"]["tmpa1b2c3d4_statik.pdf"] = "/Einreichung"
    collection = _collection({"c1": "tmpa1b2c3d4_statik.pdf", "c2": "bleibt.pdf"})

    found = ingestor._find_previous_versions(collection, "proj_1", ["statik.pdf"])

    assert found["statik.pdf"].preserved == {
        "doc_class": "tragwerk",
        "display_title": "Statik Bauteil B",
        "folder_path": "/Einreichung",
    }


def test_a_failed_metadata_read_still_finds_the_chunks(ingestor, registries, monkeypatch):
    from aiq_agent import knowledge

    def broken(coll, names):
        raise RuntimeError("metadata store down")

    monkeypatch.setattr(knowledge, "get_document_doc_classes", broken)

    found = ingestor._find_previous_versions(_collection({"c1": "statik.pdf"}), "proj_1", ["statik.pdf"])

    assert found["statik.pdf"].chunk_ids == ["c1"]
    assert found["statik.pdf"].preserved == {}


# ---------------------------------------------------------------------------
# Retiring: by the collected ids, after the new version is in
# ---------------------------------------------------------------------------


def test_retiring_deletes_the_collected_ids_and_keeps_the_row_under_the_new_name(ingestor, registries):
    collection = MagicMock()
    previous = _PreviousVersion(chunk_ids=["c1", "c2"], stored_names=["statik.pdf"])

    ingestor._retire_previous_version(collection, "proj_1", "statik.pdf", previous)

    collection.delete.assert_called_once_with(ids=["c1", "c2"])
    assert registries["bumped"] == ["proj_1"]
    assert registries["mirror"] == [("proj_1", ["c1", "c2"])]
    # By name, the mirror delete would take the new version's rows too.
    registries["store"].delete_by_file.assert_not_called()
    # The row under the new name IS the new version's row.
    assert registries["unregistered"] == []


def test_retiring_drops_the_row_under_another_spelling(ingestor, registries):
    previous = _PreviousVersion(chunk_ids=["c1"], stored_names=["tmpa1b2c3d4_statik.pdf"])

    ingestor._retire_previous_version(MagicMock(), "proj_1", "statik.pdf", previous)

    assert registries["unregistered"] == [("proj_1", "tmpa1b2c3d4_statik.pdf")]


def test_retiring_nothing_touches_nothing(ingestor, registries):
    collection = MagicMock()
    ingestor._retire_previous_version(collection, "proj_1", "statik.pdf", None)
    ingestor._retire_previous_version(collection, "proj_1", "statik.pdf", _PreviousVersion())
    collection.delete.assert_not_called()
    assert registries["bumped"] == []


def test_a_retirement_failure_never_fails_the_ingest(ingestor, registries):
    collection = MagicMock()
    collection.delete.side_effect = RuntimeError("chroma down")
    # Must swallow: the new version is already in; worst case is a duplicate.
    ingestor._retire_previous_version(collection, "proj_1", "statik.pdf", _PreviousVersion(chunk_ids=["c1"]))


# ---------------------------------------------------------------------------
# End to end through _run_ingestion: a real Chroma collection, no embedding
# ---------------------------------------------------------------------------


class _IndexIntoChroma:
    """Stands in for ``VectorStoreIndex``: writes each document as one chunk, unembedded."""

    @classmethod
    def from_documents(cls, documents, storage_context, **_kwargs):
        index = cls(storage_context.vector_store.client)
        for document in documents:
            index.insert(document)
        return index

    def __init__(self, collection):
        self._collection = collection

    def insert(self, document):
        metadata = {key: value for key, value in document.metadata.items() if value is not None}
        self._collection.add(
            ids=[str(uuid.uuid4())],
            documents=[document.get_content()],
            metadatas=[metadata],
            embeddings=[[0.1, 0.2, 0.3]],
        )


@pytest.fixture()
def stores(tmp_path):
    """A temp SQLite metadata store and lexical mirror for the whole job."""
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory
    from aiq_agent.knowledge.chunk_text_store import configure_chunk_text_store
    from aiq_agent.knowledge.chunk_text_store import reset_chunk_text_store

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    mirror = configure_chunk_text_store(f"sqlite:///{tmp_path / 'mirror.db'}")
    yield mirror
    factory._document_metadata_store = None
    reset_chunk_text_store()


@pytest.fixture()
def live_ingestor(tmp_path, monkeypatch):
    llm = MagicMock()
    llm.invoke.return_value = MagicMock(content="Eine Statik.")
    ing = LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma"), "generate_summary": False, "summary_llm": llm})
    ing._embed_model = MagicMock()
    ing._initialized = True
    monkeypatch.setattr("llama_index.core.VectorStoreIndex", _IndexIntoChroma)
    monkeypatch.setattr("llama_index.core.Settings", MagicMock())
    return ing


def _seed_previous_version(ing, stores, collection_name: str, file_name: str) -> None:
    """The version already live: two chunks, their mirror rows, a row a person edited."""
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import set_document_display_title
    from aiq_agent.knowledge import set_document_doc_class
    from aiq_agent.knowledge import set_document_folder_path

    collection = ing._get_chroma_client().get_or_create_collection(collection_name, metadata={"hnsw:space": "cosine"})
    collection.add(
        ids=["old-1", "old-2"],
        documents=["Alte Fassung Seite eins", "Alte Fassung Seite zwei"],
        metadatas=[{"file_name": file_name, "page_label": "1"}, {"file_name": file_name, "page_label": "2"}],
        embeddings=[[0.1, 0.2, 0.3], [0.3, 0.2, 0.1]],
    )
    stores.upsert_many(
        collection_name,
        [
            {"chunk_id": "old-1", "body": "Alte Fassung Seite eins", "file_name": file_name, "page_label": "1"},
            {"chunk_id": "old-2", "body": "Alte Fassung Seite zwei", "file_name": file_name, "page_label": "2"},
        ],
    )
    register_summary(collection_name, file_name, "Die alte Statik.")
    set_document_doc_class(collection_name, file_name, "tragwerk")
    set_document_display_title(collection_name, file_name, "Statik Bauteil B")
    set_document_folder_path(collection_name, file_name, "/Einreichung")


def _wait_terminal(ing, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def _chunks(ing, collection_name: str) -> dict[str, str]:
    got = ing._get_chroma_client().get_collection(collection_name).get(include=["documents"])
    return dict(zip(got["ids"], got["documents"], strict=True))


def test_a_reupload_that_fails_keeps_the_previous_version(tmp_path, monkeypatch, live_ingestor, stores):
    """An encrypted PDF extracts nothing; the version it was meant to replace stays whole."""
    from aiq_agent.knowledge import get_available_documents
    from aiq_agent.knowledge import get_document_doc_class

    _seed_previous_version(live_ingestor, stores, "proj_fail", "statik.pdf")

    def encrypted(_path):
        raise ValueError("PDF is encrypted")

    monkeypatch.setattr(adapter_module, "_extract_text_from_pdf", encrypted)
    upload = tmp_path / "tmp_upload.pdf"
    upload.write_bytes(b"%PDF-1.7\n%encrypted\n")

    job_id = live_ingestor.submit_job([str(upload)], "proj_fail", config={"original_filenames": ["statik.pdf"]})
    status = _wait_terminal(live_ingestor, job_id)

    assert status.file_details[0].status.value == "failed"
    # The JOB fails too: it is what the BFF reconciles the document's status
    # from, and the collection's file list still reports the name as indexed.
    assert status.status.value == "failed"
    assert sorted(_chunks(live_ingestor, "proj_fail")) == ["old-1", "old-2"]
    assert stores.count("proj_fail") == 2
    assert get_document_doc_class("proj_fail", "statik.pdf") == "tragwerk"
    assert [doc.summary for doc in get_available_documents("proj_fail")] == ["Die alte Statik."]


def test_a_reupload_with_no_vlm_key_keeps_the_previous_image(tmp_path, monkeypatch, live_ingestor, stores):
    """A failure reported by status rather than raised takes the same path."""
    from aiq_agent.common.credential_resolution import ResolvedCredential

    _seed_previous_version(live_ingestor, stores, "proj_img", "grundriss.png")
    no_key = ResolvedCredential(api_key="", base_url="https://vlm.test/v1", model="test-vlm", source="none")
    monkeypatch.setattr(adapter_module, "resolve_vlm_credential", lambda organization_id=None: no_key)
    upload = tmp_path / "tmp_upload.png"
    upload.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)

    job_id = live_ingestor.submit_job([str(upload)], "proj_img", config={"original_filenames": ["grundriss.png"]})
    status = _wait_terminal(live_ingestor, job_id)

    assert status.file_details[0].error_message.startswith("vlm_not_configured")
    assert sorted(_chunks(live_ingestor, "proj_img")) == ["old-1", "old-2"]
    assert stores.count("proj_img") == 2


def test_a_reupload_that_indexes_replaces_the_previous_version(tmp_path, live_ingestor, stores):
    """Old chunks and mirror rows go; the new ones and the row a person edited stay."""
    from aiq_agent.knowledge import get_available_documents
    from aiq_agent.knowledge import get_document_display_title
    from aiq_agent.knowledge import get_document_doc_class
    from aiq_agent.knowledge import get_document_folder_paths

    _seed_previous_version(live_ingestor, stores, "proj_ok", "statik.txt")
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Neue Fassung der Statik mit geänderter Bewehrung.", encoding="utf-8")

    job_id = live_ingestor.submit_job([str(upload)], "proj_ok", config={"original_filenames": ["statik.txt"]})
    status = _wait_terminal(live_ingestor, job_id)

    assert status.file_details[0].status.value == "success"
    chunks = _chunks(live_ingestor, "proj_ok")
    assert "old-1" not in chunks and "old-2" not in chunks
    assert list(chunks.values()) == ["Neue Fassung der Statik mit geänderter Bewehrung."]
    # The new version's mirror row survives the retirement of the old ones.
    assert stores.count("proj_ok") == 1
    assert stores.search("proj_ok", "Bewehrung") == list(chunks)
    assert get_document_doc_class("proj_ok", "statik.txt") == "tragwerk"
    assert get_document_display_title("proj_ok", "statik.txt") == "Statik Bauteil B"
    assert get_document_folder_paths("proj_ok", ["statik.txt"]) == {"statik.txt": "/Einreichung"}
    summaries = [doc.summary for doc in get_available_documents("proj_ok")]
    assert len(summaries) == 1 and summaries[0] != "Die alte Statik."


def test_a_legacy_tmp_prefixed_version_is_replaced_through_its_metadata_row(tmp_path, live_ingestor, stores):
    """The filtered read cannot match a random prefix; the row it left behind names it."""
    from aiq_agent.knowledge import get_document_doc_class

    _seed_previous_version(live_ingestor, stores, "proj_tmp", "tmpa1b2c3d4_statik.txt")
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Neue Fassung der Statik.", encoding="utf-8")

    job_id = live_ingestor.submit_job([str(upload)], "proj_tmp", config={"original_filenames": ["statik.txt"]})
    status = _wait_terminal(live_ingestor, job_id)

    assert status.file_details[0].status.value == "success"
    assert list(_chunks(live_ingestor, "proj_tmp").values()) == ["Neue Fassung der Statik."]
    # The Dokumentart moved from the old spelling's row to the new one.
    assert get_document_doc_class("proj_tmp", "statik.txt") == "tragwerk"
    assert get_document_doc_class("proj_tmp", "tmpa1b2c3d4_statik.txt") is None


# ---------------------------------------------------------------------------
# A failure after some chunks went in, and two jobs for one name
# ---------------------------------------------------------------------------


def _two_page_pdf(monkeypatch, tmp_path):
    """A PDF whose text reader yields two pages: two documents, two inserts."""
    monkeypatch.setattr(
        adapter_module,
        "_extract_text_from_pdf",
        lambda _path: [
            {"page_number": 1, "text": "Neue Fassung Seite eins"},
            {"page_number": 2, "text": "Neue Fassung Seite zwei"},
        ],
    )
    upload = tmp_path / "tmp_upload.pdf"
    upload.write_bytes(b"%PDF-1.7\n")
    return upload


_TEXT_ONLY = {"extract_tables": False, "extract_images": False, "extract_charts": False}


def test_a_reupload_that_fails_halfway_takes_its_own_chunks_back_out(tmp_path, monkeypatch, live_ingestor, stores):
    """Page one is in when page two's embedding fails: page one goes, the old version stays."""
    inserted: list[str] = []

    class _FailsOnSecondInsert(_IndexIntoChroma):
        def insert(self, document):
            if inserted:
                raise RuntimeError("embedding batch timed out")
            super().insert(document)
            new_ids = [cid for cid in self._collection.get()["ids"] if not cid.startswith("old-")]
            inserted.extend(new_ids)
            # A lexical-mirror row for it, as a mirror that ran early would leave.
            stores.upsert_many(
                "proj_half",
                [{"chunk_id": cid, "body": "Neu", "file_name": "statik.pdf", "page_label": "1"} for cid in new_ids],
            )

    monkeypatch.setattr("llama_index.core.VectorStoreIndex", _FailsOnSecondInsert)
    _seed_previous_version(live_ingestor, stores, "proj_half", "statik.pdf")
    upload = _two_page_pdf(monkeypatch, tmp_path)

    job_id = live_ingestor.submit_job(
        [str(upload)], "proj_half", config={"original_filenames": ["statik.pdf"], **_TEXT_ONLY}
    )
    status = _wait_terminal(live_ingestor, job_id)

    assert len(inserted) == 1
    assert status.file_details[0].status.value == "failed"
    assert _chunks(live_ingestor, "proj_half") == {
        "old-1": "Alte Fassung Seite eins",
        "old-2": "Alte Fassung Seite zwei",
    }
    assert stores.count("proj_half") == 2


def test_two_jobs_for_one_name_leave_only_the_later_version(tmp_path, monkeypatch, live_ingestor, stores):
    """Job B waits for job A's replacement, then replaces A's version in turn.

    Without the lock both jobs collect the same old ids, both retire them, and
    both new versions stay: A is held inside its insert while B would run.
    """
    a_inside = threading.Event()
    release_a = threading.Event()

    class _HoldsJobA(_IndexIntoChroma):
        def insert(self, document):
            if "Fassung A" in document.get_content():
                a_inside.set()
                assert release_a.wait(10)
            super().insert(document)

    monkeypatch.setattr("llama_index.core.VectorStoreIndex", _HoldsJobA)
    _seed_previous_version(live_ingestor, stores, "proj_race", "statik.txt")
    upload_a = tmp_path / "a.txt"
    upload_a.write_text("Fassung A", encoding="utf-8")
    upload_b = tmp_path / "b.txt"
    upload_b.write_text("Fassung B", encoding="utf-8")

    job_a = live_ingestor.submit_job([str(upload_a)], "proj_race", config={"original_filenames": ["statik.txt"]})
    assert a_inside.wait(10)
    job_b = live_ingestor.submit_job([str(upload_b)], "proj_race", config={"original_filenames": ["statik.txt"]})
    time.sleep(0.5)  # unguarded, B would index and retire the old version here
    assert not live_ingestor.get_job_status(job_b).is_terminal
    release_a.set()

    assert _wait_terminal(live_ingestor, job_a).file_details[0].status.value == "success"
    assert _wait_terminal(live_ingestor, job_b).file_details[0].status.value == "success"
    assert list(_chunks(live_ingestor, "proj_race").values()) == ["Fassung B"]
    assert stores.count("proj_race") == 1


# ---------------------------------------------------------------------------
# A document deleted while it was being ingested
# ---------------------------------------------------------------------------
#
# Once a file is in, the ingestor asks the BFF whether the document it was
# dispatched for still exists. On a definite "gone" it takes back out exactly
# what this attempt inserted and writes no metadata; on anything else (no
# answer, an unreachable BFF) it carries on as before.


@pytest.fixture()
def presence(monkeypatch):
    """The BFF's answer about the dispatched document, and who asked."""
    from knowledge_layer.llamaindex import document_presence

    # `answers` are given first, one per question; `answer` after that.
    state = SimpleNamespace(answer=True, answers=[], asked=[])

    def still_exists(document_id, collection, organization_id=None):
        state.asked.append((document_id, collection, organization_id))
        return state.answers.pop(0) if state.answers else state.answer

    monkeypatch.setattr(document_presence, "document_still_exists", still_exists)
    return state


def _dispatched(file_name: str, **extra) -> dict:
    """The job config ``/v1/ingest`` builds for a BFF document."""
    return {"original_filenames": [file_name], "document_id": "doc-1", **_TEXT_ONLY, **extra}


def _no_metadata_row(collection_name: str, file_name: str) -> None:
    from aiq_agent.knowledge import get_available_documents
    from aiq_agent.knowledge import get_document_doc_class

    assert get_available_documents(collection_name) == []
    assert get_document_doc_class(collection_name, file_name) is None


def test_a_delete_during_a_reupload_leaves_no_chunks(tmp_path, monkeypatch, live_ingestor, stores, presence):
    """Window (a): the delete runs on another replica between two inserts.

    ``delete_file`` does not wait for the replacement lock, so it removes the
    old version and page one, and page two goes in after it. The check after
    indexing takes page two back out, and no metadata row comes back.
    """
    deleted: list[bool] = []

    class _DeletedBetweenInserts(_IndexIntoChroma):
        def insert(self, document):
            super().insert(document)
            if not deleted:
                deleted.append(live_ingestor.delete_file("statik.pdf", "proj_del"))

    monkeypatch.setattr("llama_index.core.VectorStoreIndex", _DeletedBetweenInserts)
    _seed_previous_version(live_ingestor, stores, "proj_del", "statik.pdf")
    upload = _two_page_pdf(monkeypatch, tmp_path)
    # Present when the job starts reading the file; gone by the time it is in.
    presence.answers = [True]
    presence.answer = False

    job_id = live_ingestor.submit_job([str(upload)], "proj_del", config=_dispatched("statik.pdf"))
    status = _wait_terminal(live_ingestor, job_id)

    assert deleted == [True]
    # The second page really did land after the delete; the check removed it.
    assert _chunks(live_ingestor, "proj_del") == {}
    assert stores.count("proj_del") == 0
    _no_metadata_row("proj_del", "statik.pdf")
    assert status.file_details[0].status.value == "failed"
    assert status.file_details[0].error_message == adapter_module.DOCUMENT_DELETED_DURING_INGEST
    # Asked before reading the file, and again once it was in.
    assert presence.asked == [("doc-1", "proj_del", None)] * 2


def test_a_dispatch_for_a_deleted_document_indexes_nothing(tmp_path, live_ingestor, stores, presence):
    """Window (b): the delete committed after the upload's version, before this dispatch."""
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Ein Dokument, das es nicht mehr gibt.", encoding="utf-8")
    presence.answer = False

    job_id = live_ingestor.submit_job([str(upload)], "proj_gone", config=_dispatched("gone.txt"))
    status = _wait_terminal(live_ingestor, job_id)

    assert _chunks(live_ingestor, "proj_gone") == {}
    assert stores.count("proj_gone") == 0
    # Not even the fallback summary the end-of-job reconciliation writes for
    # a successful file: this one is not successful.
    _no_metadata_row("proj_gone", "gone.txt")
    assert status.status.value == "failed"


def test_a_deleted_document_does_not_retire_what_now_answers_to_its_name(tmp_path, live_ingestor, stores, presence):
    """A delete, then a new upload of the same name that indexed first: that version is live.

    The stale attempt finds it as its predecessor under the lock. Retiring it
    would delete a document somebody just uploaded; only the attempt's own
    chunk goes.
    """
    from aiq_agent.knowledge import get_available_documents
    from aiq_agent.knowledge import get_document_doc_class

    _seed_previous_version(live_ingestor, stores, "proj_new", "statik.txt")
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Die Fassung des gelöschten Dokuments.", encoding="utf-8")
    presence.answer = False

    job_id = live_ingestor.submit_job([str(upload)], "proj_new", config=_dispatched("statik.txt"))
    _wait_terminal(live_ingestor, job_id)

    assert sorted(_chunks(live_ingestor, "proj_new")) == ["old-1", "old-2"]
    assert stores.count("proj_new") == 2
    assert [doc.summary for doc in get_available_documents("proj_new")] == ["Die alte Statik."]
    assert get_document_doc_class("proj_new", "statik.txt") == "tragwerk"


def test_an_unreachable_bff_keeps_the_new_version(tmp_path, monkeypatch, live_ingestor, stores):
    """No answer is not "gone": the re-upload replaces its predecessor as it always did."""
    # Nothing listens on port 9: the real client gets a refused connection.
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret")
    _seed_previous_version(live_ingestor, stores, "proj_down", "statik.txt")
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Neue Fassung der Statik.", encoding="utf-8")

    job_id = live_ingestor.submit_job([str(upload)], "proj_down", config=_dispatched("statik.txt"))
    status = _wait_terminal(live_ingestor, job_id)

    assert status.file_details[0].status.value == "success"
    assert list(_chunks(live_ingestor, "proj_down").values()) == ["Neue Fassung der Statik."]
    assert stores.count("proj_down") == 1


def test_a_document_that_still_exists_is_replaced_as_before(tmp_path, live_ingestor, stores, presence):
    from aiq_agent.knowledge import get_document_doc_class

    _seed_previous_version(live_ingestor, stores, "proj_live", "statik.txt")
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Neue Fassung der Statik.", encoding="utf-8")

    job_id = live_ingestor.submit_job(
        [str(upload)], "proj_live", config=_dispatched("statik.txt", organization_id="org_1")
    )
    status = _wait_terminal(live_ingestor, job_id)

    assert status.file_details[0].status.value == "success"
    assert list(_chunks(live_ingestor, "proj_live").values()) == ["Neue Fassung der Statik."]
    assert get_document_doc_class("proj_live", "statik.txt") == "tragwerk"
    # Before reading the file, and once it was in.
    assert presence.asked == [("doc-1", "proj_live", "org_1")] * 2


def test_a_job_no_bff_document_dispatched_is_never_asked_about(tmp_path, live_ingestor, stores, presence):
    """The OIB sync and ``/v1/documents`` carry no document id: there is nothing to ask."""
    presence.answer = False
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Korpusdokument.", encoding="utf-8")

    job_id = live_ingestor.submit_job([str(upload)], "proj_corpus", config={"original_filenames": ["oib.txt"]})
    status = _wait_terminal(live_ingestor, job_id)

    assert status.file_details[0].status.value == "success"
    assert presence.asked == []


def test_a_document_deleted_while_its_job_waited_is_not_read_at_all(tmp_path, monkeypatch, live_ingestor, presence):
    """The download, OCR and vision calls would all be for chunks that go back out."""
    read = []
    monkeypatch.setattr(
        "knowledge_layer.deferred_files.resolve_original", lambda entry, downloaded: read.append(entry) or entry
    )
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Ein Dokument, das es nicht mehr gibt.", encoding="utf-8")
    presence.answer = False

    job_id = live_ingestor.submit_job([str(upload)], "proj_gone", config=_dispatched("gone.txt"))
    status = _wait_terminal(live_ingestor, job_id)

    assert read == []
    assert presence.asked == [("doc-1", "proj_gone", None)]
    assert status.file_details[0].error_message == adapter_module.DOCUMENT_DELETED_DURING_INGEST


def test_a_run_that_lost_its_claim_stops_before_writing(tmp_path, live_ingestor, stores, presence):
    """Another worker holds the job now: this run writes no chunk and no status."""
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Neue Fassung der Statik.", encoding="utf-8")
    prepared = live_ingestor.prepare_job([str(upload)], "proj_lost", config=_dispatched("statik.txt"))
    answers = iter([True, False])  # held when the file is read, lost before its chunks go in
    written = []
    live_ingestor._persist = written.append

    live_ingestor.run_prepared(prepared, still_owner=lambda: next(answers))

    assert _chunks(live_ingestor, "proj_lost") == {}
    assert stores.count("proj_lost") == 0
    # Only the PROCESSING write from before the claim was lost; nothing after.
    assert [job.status.value for job in written] == ["processing"]
    assert prepared.job_id not in live_ingestor._jobs


# ---------------------------------------------------------------------------
# A base-corpus job, as the queue carries it: what the old in-process path
# stamped after the fact is now the ingestor's own
# ---------------------------------------------------------------------------


def _ingest_base_corpus(ing, tmp_path, file_name: str, config: dict | None = None):
    upload = tmp_path / "tmp_corpus.txt"
    upload.write_text("Mindestens 1,20 m lichte Durchgangsbreite.", encoding="utf-8")
    job_id = ing.submit_job(
        [str(upload)], "oib_knowledge", config={"original_filenames": [file_name], "priority": "bulk", **(config or {})}
    )
    status = _wait_terminal(ing, job_id)
    assert status.file_details[0].status.value == "success"


def test_the_dokumentart_an_admin_chose_at_upload_is_stamped_by_the_job(tmp_path, live_ingestor, stores):
    from aiq_agent.knowledge import get_document_doc_class

    _ingest_base_corpus(live_ingestor, tmp_path, "statik.txt", {"doc_class": "gesetz"})

    assert get_document_doc_class("oib_knowledge", "statik.txt") == "gesetz"


def test_the_admins_choice_beats_the_class_a_replaced_version_carried(tmp_path, live_ingestor, stores):
    from aiq_agent.knowledge import get_document_doc_class

    _seed_previous_version(live_ingestor, stores, "oib_knowledge", "statik.txt")  # a person set "tragwerk"
    _ingest_base_corpus(live_ingestor, tmp_path, "statik.txt", {"doc_class": "gesetz"})

    assert get_document_doc_class("oib_knowledge", "statik.txt") == "gesetz"


def test_a_replacement_with_no_choice_keeps_what_a_person_set(tmp_path, live_ingestor, stores):
    from aiq_agent.knowledge import get_document_doc_class

    _seed_previous_version(live_ingestor, stores, "oib_knowledge", "statik.txt")
    _ingest_base_corpus(live_ingestor, tmp_path, "statik.txt")

    assert get_document_doc_class("oib_knowledge", "statik.txt") == "tragwerk"


def test_without_a_choice_the_class_is_guessed_from_the_file_name(tmp_path, live_ingestor, stores):
    from aiq_agent.knowledge import get_document_doc_class

    _ingest_base_corpus(live_ingestor, tmp_path, "oib-rl_2_ausgabe_mai_2023.txt")

    assert get_document_doc_class("oib_knowledge", "oib-rl_2_ausgabe_mai_2023.txt") == "oib_richtlinie"


def test_a_class_outside_the_vocabulary_is_not_stamped(tmp_path, live_ingestor, stores):
    from aiq_agent.knowledge import get_document_doc_class

    _ingest_base_corpus(live_ingestor, tmp_path, "statik.txt", {"doc_class": "not_a_real_class"})

    assert get_document_doc_class("oib_knowledge", "statik.txt") == "sonstiges"


def test_an_oib_document_gets_its_starting_display_title_from_its_name(tmp_path, live_ingestor, stores):
    from aiq_agent.knowledge import get_document_display_title

    _ingest_base_corpus(live_ingestor, tmp_path, "oib-rl_2_ausgabe_mai_2023.txt")

    assert get_document_display_title("oib_knowledge", "oib-rl_2_ausgabe_mai_2023.txt") == (
        "OIB-Richtlinie 2, Ausgabe Mai 2023"
    )


def test_a_name_that_gives_no_default_title_gets_none(tmp_path, live_ingestor, stores):
    from aiq_agent.knowledge import get_document_display_title

    _ingest_base_corpus(live_ingestor, tmp_path, "statik.txt")

    assert get_document_display_title("oib_knowledge", "statik.txt") is None


def test_a_title_an_admin_set_survives_the_replacement_of_the_document(tmp_path, live_ingestor, stores):
    from aiq_agent.knowledge import get_document_display_title

    _seed_previous_version(live_ingestor, stores, "oib_knowledge", "statik.txt")  # "Statik Bauteil B"
    _ingest_base_corpus(live_ingestor, tmp_path, "statik.txt")

    assert get_document_display_title("oib_knowledge", "statik.txt") == "Statik Bauteil B"


def test_a_project_document_is_not_given_a_base_corpus_title_or_class(tmp_path, live_ingestor, stores):
    from aiq_agent.knowledge import get_document_display_title
    from aiq_agent.knowledge import get_document_doc_class

    upload = tmp_path / "tmp_project.txt"
    upload.write_text("Ein Projektdokument.", encoding="utf-8")
    job_id = live_ingestor.submit_job(
        [str(upload)], "proj_x", config={"original_filenames": ["oib-rl_2_ausgabe_mai_2023.txt"]}
    )
    _wait_terminal(live_ingestor, job_id)

    assert get_document_display_title("proj_x", "oib-rl_2_ausgabe_mai_2023.txt") is None
    assert get_document_doc_class("proj_x", "oib-rl_2_ausgabe_mai_2023.txt") is None

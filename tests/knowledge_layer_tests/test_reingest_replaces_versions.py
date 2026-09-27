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
- retirement deletes by the COLLECTED ids, in Chroma and in the lexical mirror,
  bumps the collection version, and drops the metadata row only under a stored
  spelling other than the new name (the row under the new name is the new
  version's row, and keeps what people set);
- a failure in either step never fails the ingest.
"""

import time
import uuid
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
    """A fake Chroma collection: ``chunks`` maps chunk id → stored file_name."""
    collection = MagicMock()
    collection.get.return_value = {
        "ids": list(chunks.keys()),
        "metadatas": [{"file_name": name} for name in chunks.values()],
    }
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
    return {
        "unregistered": unregistered,
        "mirror": mirror_deleted,
        "store": store,
        "bumped": bumped,
        "human_set": human_set,
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
    # copy (tmp[8 chars]_) and a presigned-URL-derived percent encoding.
    collection = _collection(
        {"c1": "tmpa1b2c3d4_statik-standard.pdf", "c2": "statik%20standard.pdf", "c3": "bleibt.pdf"}
    )

    found = ingestor._find_previous_versions(collection, "proj_1", ["statik-standard.pdf", "statik standard.pdf"])

    assert found["statik-standard.pdf"].chunk_ids == ["c1"]
    assert found["statik-standard.pdf"].stored_names == ["tmpa1b2c3d4_statik-standard.pdf"]
    assert found["statik standard.pdf"].chunk_ids == ["c2"]
    assert found["statik standard.pdf"].stored_names == ["statik%20standard.pdf"]


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

"""Re-ingesting a file name REPLACES its earlier chunks (``_replace_previous_versions``).

Law does not go stale, it gets replaced — the OIB sync enforces that through
its hash registry, but uploaded office/project documents had no replacement
semantics at all: re-uploading ``statik-standard.pdf`` appended a second full
set of chunks next to the first, and both versions then competed in retrieval
on similarity alone. These tests pin the pre-ingest replacement step:

- exact-name predecessors are deleted, the collection version is bumped, and
  the summary registry + lexical mirror are cleaned for the stored name;
- tmp-prefixed and percent-encoded stored names (the two forms ``delete_file``
  already normalizes) match their plain re-upload;
- other files' chunks survive, a first upload deletes nothing, and a failure
  inside replacement never fails the ingest (worst case is the old duplicate
  behavior, logged).
"""

from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor


@pytest.fixture()
def ingestor():
    """A bare instance — ``_replace_previous_versions`` touches no adapter state."""
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
    from knowledge_layer.llamaindex import adapter as adapter_module

    unregistered: list[tuple[str, str]] = []
    mirror_deleted: list[tuple[str, str]] = []
    bumped: list[str] = []

    from aiq_agent import knowledge

    monkeypatch.setattr(knowledge, "unregister_summary", lambda coll, name: unregistered.append((coll, name)))
    store = MagicMock()
    store.delete_by_file.side_effect = lambda coll, name: mirror_deleted.append((coll, name))
    from aiq_agent.knowledge import chunk_text_store

    monkeypatch.setattr(chunk_text_store, "get_chunk_text_store", lambda: store)
    monkeypatch.setattr(adapter_module, "bump_collection_version", lambda name: bumped.append(name))
    # What people set on the rows about to be deleted: empty unless a test says.
    human_set: dict[str, dict[str, str]] = {"doc_class": {}, "display_title": {}, "folder_path": {}}

    def reader(field):
        return lambda coll, names: {name: human_set[field][name] for name in names if name in human_set[field]}

    monkeypatch.setattr(knowledge, "get_document_doc_classes", reader("doc_class"))
    monkeypatch.setattr(knowledge, "get_document_display_titles", reader("display_title"))
    monkeypatch.setattr(knowledge, "get_document_folder_paths", reader("folder_path"))
    return {"unregistered": unregistered, "mirror": mirror_deleted, "bumped": bumped, "human_set": human_set}


def test_same_name_reupload_deletes_predecessor_chunks(ingestor, registries):
    collection = _collection(
        {
            "c1": "statik-standard.pdf",
            "c2": "statik-standard.pdf",
            "c3": "anderes-dokument.pdf",
        }
    )
    ingestor._replace_previous_versions(collection, "proj_1", ["statik-standard.pdf"])

    collection.delete.assert_called_once()
    assert sorted(collection.delete.call_args.kwargs["ids"]) == ["c1", "c2"]
    assert registries["bumped"] == ["proj_1"]
    assert ("proj_1", "statik-standard.pdf") in registries["unregistered"]
    assert ("proj_1", "statik-standard.pdf") in registries["mirror"]


def test_tmp_prefixed_and_percent_encoded_stored_names_match(ingestor, registries):
    # Stored under the two forms delete_file already normalizes: a backend tmp
    # copy (tmp[8 chars]_) and a presigned-URL-derived percent encoding.
    collection = _collection(
        {
            "c1": "tmpa1b2c3d4_statik-standard.pdf",
            "c2": "statik%20standard.pdf",
            "c3": "bleibt.pdf",
        }
    )
    ingestor._replace_previous_versions(collection, "proj_1", ["statik-standard.pdf", "statik standard.pdf"])

    assert sorted(collection.delete.call_args.kwargs["ids"]) == ["c1", "c2"]
    # The lexical mirror is cleaned under the stored name AND its normalized
    # form, because the mirror may hold either depending on the upload path.
    assert ("proj_1", "tmpa1b2c3d4_statik-standard.pdf") in registries["mirror"]
    assert ("proj_1", "statik-standard.pdf") in registries["mirror"]


def test_first_upload_deletes_nothing(ingestor, registries):
    collection = _collection({"c1": "vorhanden.pdf"})
    ingestor._replace_previous_versions(collection, "proj_1", ["neu.pdf"])
    collection.delete.assert_not_called()
    assert registries["bumped"] == []


def test_replacement_failure_never_fails_the_ingest(ingestor, registries):
    collection = _collection({"c1": "statik-standard.pdf"})
    collection.delete.side_effect = RuntimeError("chroma down")
    # Must swallow: worst case is the pre-existing duplicate behavior.
    ingestor._replace_previous_versions(collection, "proj_1", ["statik-standard.pdf"])


def test_empty_and_blank_names_are_ignored(ingestor, registries):
    collection = _collection({"c1": "statik-standard.pdf"})
    ingestor._replace_previous_versions(collection, "proj_1", ["", None])
    collection.get.assert_not_called()
    collection.delete.assert_not_called()


def test_what_people_set_on_the_replaced_version_is_handed_back(ingestor, registries):
    # The row goes with the chunks, so a Dokumentart, a display title and a
    # folder a person set would be lost to the re-upload of the same name.
    registries["human_set"]["doc_class"]["tmpa1b2c3d4_statik.pdf"] = "tragwerk"
    registries["human_set"]["display_title"]["tmpa1b2c3d4_statik.pdf"] = "Statik Bauteil B"
    registries["human_set"]["folder_path"]["tmpa1b2c3d4_statik.pdf"] = "/Einreichung"
    collection = _collection({"c1": "tmpa1b2c3d4_statik.pdf", "c2": "bleibt.pdf"})

    preserved = ingestor._replace_previous_versions(collection, "proj_1", ["statik.pdf"])

    assert preserved == {
        "statik.pdf": {"doc_class": "tragwerk", "display_title": "Statik Bauteil B", "folder_path": "/Einreichung"}
    }
    assert ("proj_1", "tmpa1b2c3d4_statik.pdf") in registries["unregistered"]


def test_a_failed_metadata_read_still_replaces_the_chunks(ingestor, registries, monkeypatch):
    from aiq_agent import knowledge

    def broken(coll, names):
        raise RuntimeError("metadata store down")

    monkeypatch.setattr(knowledge, "get_document_doc_classes", broken)
    collection = _collection({"c1": "statik.pdf"})

    assert ingestor._replace_previous_versions(collection, "proj_1", ["statik.pdf"]) == {}
    assert collection.delete.call_args.kwargs["ids"] == ["c1"]

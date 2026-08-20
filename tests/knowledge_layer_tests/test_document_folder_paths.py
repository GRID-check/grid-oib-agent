"""The folder a document is filed under, on the backend's metadata row (ADR-0049).

The BFF owns `project_folders` and files each document into one. The backend has
no such table, so the folder travels as the MATERIALISED PATH
(``Brandschutz/Fluchtwege``) denormalised onto ``document_metadata.folder_path``.

That choice is only affordable because a path MOVES: a rename or a re-parent
rewrites it, and the whole point of these tests is the rewrite. They pin the two
things a naive ``LIKE 'prefix%'`` gets wrong — a sibling folder whose name merely
STARTS with the renamed one, and a delete that collapses a subtree onto the
project root — plus the read paths that surfacing and retrieval depend on.
"""

import asyncio
import tempfile
from pathlib import Path

import pytest

from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore


@pytest.fixture
def store():
    """A store on a fresh temp SQLite file, disposed before the dir is removed."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'folders.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        instance = DocumentMetadataStore(db_url)
        yield instance
        with DocumentMetadataStore._cache_lock:
            for cache in (
                DocumentMetadataStore._sync_engine_cache,
                DocumentMetadataStore._async_engine_cache,
            ):
                engine = cache.pop(db_url, (None, None))[0]
                if engine is None:
                    continue
                try:
                    disposed = engine.dispose()
                    if asyncio.iscoroutine(disposed):
                        asyncio.run(disposed)
                except (RuntimeError, OSError):
                    pass
        DocumentMetadataStore._tables_initialized.discard(db_url)


def _file(store: DocumentMetadataStore, name: str, folder: str | None) -> None:
    """Register a summarised document and file it under ``folder``."""
    store.register("proj_a", name, f"Summary of {name}")
    if folder is not None:
        assert store.set_folder_path("proj_a", name, folder) is True


class TestFolderPathColumn:
    """Set / read / clear, with the same UPDATE-only contract as display_title."""

    def test_set_then_get_round_trips_the_path(self, store):
        _file(store, "plan.pdf", "Brandschutz/Fluchtwege")
        assert store.get_folder_path("proj_a", "plan.pdf") == "Brandschutz/Fluchtwege"

    def test_a_document_with_no_folder_reads_as_none(self, store):
        _file(store, "plan.pdf", None)
        assert store.get_folder_path("proj_a", "plan.pdf") is None

    def test_setting_a_folder_on_a_missing_row_reports_false(self, store):
        # The summary is the anchor, exactly as it is for tags and display_title:
        # there is nothing to file when the document was never summarised.
        assert store.set_folder_path("proj_a", "never-ingested.pdf", "Brandschutz") is False

    def test_clearing_the_folder_re_files_at_the_root(self, store):
        _file(store, "plan.pdf", "Brandschutz")
        assert store.set_folder_path("proj_a", "plan.pdf", None) is True
        assert store.get_folder_path("proj_a", "plan.pdf") is None

    def test_the_batch_read_returns_only_filed_documents(self, store):
        _file(store, "plan.pdf", "Brandschutz")
        _file(store, "lose.pdf", None)
        paths = store.get_folder_paths_batch("proj_a", ["plan.pdf", "lose.pdf", "absent.pdf"])
        assert paths == {"plan.pdf": "Brandschutz"}

    def test_the_folder_rides_along_on_the_available_documents_read(self, store):
        _file(store, "plan.pdf", "Brandschutz/Fluchtwege")
        docs = {doc.file_name: doc for doc in store.get_all("proj_a")}
        assert docs["plan.pdf"].folder_path == "Brandschutz/Fluchtwege"

    def test_the_async_read_carries_the_folder_too(self, store):
        _file(store, "plan.pdf", "Brandschutz")
        docs = asyncio.run(store.get_all_async("proj_a"))
        assert {doc.file_name: doc.folder_path for doc in docs} == {"plan.pdf": "Brandschutz"}

    def test_the_folder_survives_a_summary_re_register(self, store):
        # Re-ingesting a document rewrites the summary row; the filing is the
        # user's, not the ingester's, and must not be dropped by an upsert.
        _file(store, "plan.pdf", "Brandschutz")
        store.register("proj_a", "plan.pdf", "A newer summary")
        assert store.get_folder_path("proj_a", "plan.pdf") == "Brandschutz"


class TestSubtreeRewrite:
    """A folder rename/move/delete, replayed as one prefix rewrite."""

    def test_renaming_a_folder_moves_it_and_its_whole_subtree(self, store):
        _file(store, "a.pdf", "Brandschutz")
        _file(store, "b.pdf", "Brandschutz/Fluchtwege")
        _file(store, "c.pdf", "Brandschutz/Fluchtwege/EG")

        assert store.rewrite_folder_paths("proj_a", "Brandschutz", "Feuer") == 3

        assert store.get_folder_path("proj_a", "a.pdf") == "Feuer"
        assert store.get_folder_path("proj_a", "b.pdf") == "Feuer/Fluchtwege"
        assert store.get_folder_path("proj_a", "c.pdf") == "Feuer/Fluchtwege/EG"

    def test_a_sibling_that_merely_starts_with_the_name_is_left_alone(self, store):
        # The bug a bare LIKE 'Brandschutz%' would ship: renaming `Brandschutz`
        # would silently drag `Brandschutzkonzepte` — a different folder the user
        # never touched — into the new name.
        _file(store, "inside.pdf", "Brandschutz/Plan")
        _file(store, "sibling.pdf", "Brandschutzkonzepte")

        assert store.rewrite_folder_paths("proj_a", "Brandschutz", "Feuer") == 1

        assert store.get_folder_path("proj_a", "inside.pdf") == "Feuer/Plan"
        assert store.get_folder_path("proj_a", "sibling.pdf") == "Brandschutzkonzepte"

    def test_moving_a_folder_under_another_parent_rewrites_the_prefix(self, store):
        _file(store, "plan.pdf", "Alt/Brandschutz/EG")
        assert store.rewrite_folder_paths("proj_a", "Alt/Brandschutz", "Neu/Brandschutz") == 1
        assert store.get_folder_path("proj_a", "plan.pdf") == "Neu/Brandschutz/EG"

    def test_deleting_a_folder_re_files_its_documents_at_the_parent(self, store):
        # `deleteProjectFolder` moves the documents to the folder's own parent
        # and re-parents the child folders the same way. Both are one rewrite
        # from the folder's path onto the parent's.
        _file(store, "direct.pdf", "Brandschutz/Alt")
        _file(store, "nested.pdf", "Brandschutz/Alt/EG")

        assert store.rewrite_folder_paths("proj_a", "Brandschutz/Alt", "Brandschutz") == 2

        assert store.get_folder_path("proj_a", "direct.pdf") == "Brandschutz"
        assert store.get_folder_path("proj_a", "nested.pdf") == "Brandschutz/EG"

    def test_deleting_a_root_folder_re_files_its_documents_at_the_root(self, store):
        _file(store, "direct.pdf", "Brandschutz")
        _file(store, "nested.pdf", "Brandschutz/EG")

        assert store.rewrite_folder_paths("proj_a", "Brandschutz", None) == 2

        assert store.get_folder_path("proj_a", "direct.pdf") is None
        assert store.get_folder_path("proj_a", "nested.pdf") == "EG"

    def test_a_percent_in_a_folder_name_cannot_match_half_the_project(self, store):
        # The TS twin escapes LIKE metacharacters for this exact reason; without
        # it `100 % Plans` matches `100 anything Plans` and re-files strangers.
        _file(store, "inside.pdf", "100 % Plans/EG")
        _file(store, "stranger.pdf", "100 aber Plans/EG")

        assert store.rewrite_folder_paths("proj_a", "100 % Plans", "Plans") == 1

        assert store.get_folder_path("proj_a", "inside.pdf") == "Plans/EG"
        assert store.get_folder_path("proj_a", "stranger.pdf") == "100 aber Plans/EG"

    def test_rewriting_a_folder_nothing_is_filed_under_is_not_an_error(self, store):
        _file(store, "plan.pdf", "Brandschutz")
        assert store.rewrite_folder_paths("proj_a", "Statik", "Tragwerk") == 0
        assert store.get_folder_path("proj_a", "plan.pdf") == "Brandschutz"

    def test_another_collection_is_never_touched(self, store):
        _file(store, "plan.pdf", "Brandschutz")
        store.register("proj_b", "plan.pdf", "Another project's file")
        store.set_folder_path("proj_b", "plan.pdf", "Brandschutz")

        assert store.rewrite_folder_paths("proj_a", "Brandschutz", "Feuer") == 1

        assert store.get_folder_path("proj_b", "plan.pdf") == "Brandschutz"

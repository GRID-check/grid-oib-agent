"""Provenance survives ingestion — onto every chunk, and onto the metadata row.

The BFF states who wrote a published document and who released it on
``POST /v1/ingest`` (ADR-0054). This is the other end of that wire: what the
ingestor does with the four keys once they are on the job config.

Two destinations, and they answer different questions:

- **the chunk**, because that is what a retrieval hit IS. ``lane_for_hit`` and
  the grounding block both see ``Chunk.metadata`` and never a metadata row, so a
  key that lands only on the row is a key the model never sees;
- **the document metadata row**, for the surfaces that have a filename and no
  chunk — a collection listing, the agent's inventory. That row is deleted with
  the chunks (``unregister_summary``), which is what makes a superseded or
  archived version's provenance go with the passages it described.

The keys are spelled once, in ``aiq_agent.common.provenance``, and both sides
read them from there.
"""

import pytest
from knowledge_layer.llamaindex.adapter import EMBED_EXCLUDED_METADATA_KEYS
from knowledge_layer.llamaindex.adapter import _provenance_from_config

_STAMPED = {
    "authored_by": "agent",
    "approved_by": "Maria Huber",
    "approved_at": "2026-09-01T10:00:00.000Z",
    "producer": "agent_document",
}


class TestProvenanceFromConfig:
    def test_the_four_keys_come_off_the_job_config(self):
        assert _provenance_from_config({"cleanup_files": True, **_STAMPED}) == _STAMPED

    def test_a_human_document_yields_nothing_to_stamp(self):
        # Which is what makes the stamping loop a no-op for every human
        # document: `doc.metadata.update({})` changes nothing.
        assert _provenance_from_config({"cleanup_files": True}) == {}

    def test_a_non_agent_author_yields_nothing_either(self):
        assert _provenance_from_config({"authored_by": "user", "approved_by": "Maria Huber"}) == {}

    def test_a_missing_approver_does_not_lose_the_author(self):
        # The lifecycle CHECK forbids a published version with no approver, and
        # a parser that trusted the producer is a parser that raises in
        # production.
        assert _provenance_from_config({"authored_by": "agent"}) == {"authored_by": "agent"}


class TestEmbedExclusions:
    @pytest.mark.parametrize("key", sorted(_STAMPED))
    def test_provenance_is_excluded_from_the_embedded_text(self, key):
        # Excluded from the rendering, STORED anyway: exclusion governs what the
        # splitter puts into the embedded text and the LLM header, not what the
        # vector store keeps. A release date carries no retrieval signal, and
        # embedding an approver's name would shift every chunk of the document
        # toward whoever signed it.
        assert key in EMBED_EXCLUDED_METADATA_KEYS

    def test_doc_class_is_still_embedded(self):
        # The guard on the other side: `doc_class` is a context header users ask
        # by, and sweeping the provenance keys out must not take it along.
        assert "doc_class" not in EMBED_EXCLUDED_METADATA_KEYS


class TestDocumentMetadataStore:
    """The row-level half, against a real SQLite store."""

    @pytest.fixture()
    def store(self, tmp_path):
        from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

        store = DocumentMetadataStore(f"sqlite:///{tmp_path / 'meta.db'}")
        store.register("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md", "Ein Aktenvermerk.")
        return store

    def test_provenance_round_trips(self, store):
        assert store.set_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md", _STAMPED) is True
        assert store.get_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md") == _STAMPED

    def test_an_unmarked_document_reads_as_none(self, store):
        assert store.get_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md") is None

    def test_clearing_it_is_what_a_human_document_means(self, store):
        store.set_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md", _STAMPED)
        store.set_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md", None)
        assert store.get_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md") is None

    def test_a_document_with_no_row_is_not_invented(self, store):
        # UPDATE-only, like every other typed accessor on this table: an ingest
        # that produced no summary must not create a summary-less row that the
        # NOT NULL constraint would reject.
        assert store.set_provenance("proj_abc", "never-ingested.pdf", _STAMPED) is False

    def test_re_summarising_does_not_undo_the_provenance(self, store):
        # `register` owns the summary and the tags and NOTHING else — the same
        # property `folder_path` and `display_title` rely on, and the reason
        # the SQLite branch stopped using INSERT OR REPLACE.
        store.set_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md", _STAMPED)
        store.register("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md", "Neu zusammengefasst.")
        assert store.get_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md") == _STAMPED

    def test_the_row_goes_when_the_chunks_do(self, store):
        # The purge on supersede and on archive is a chunk delete, and
        # `delete_file` calls `unregister_summary` on every path. That is what
        # keeps a superseded version's provenance from outliving its passages.
        store.set_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md", _STAMPED)
        store.unregister("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md")
        assert store.get_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md") is None

    def test_an_unreadable_stored_value_reads_as_unmarked(self, store):
        # A document whose provenance cannot be decoded is a document with no
        # provenance, which is what an unmarked human document already is —
        # raising here would fail a retrieval over a bookkeeping column.
        store._update_column("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md", "provenance", "not json")
        assert store.get_provenance("proj_abc", "piloti/doc_1/aktenvermerk-2026-09-01.md") is None

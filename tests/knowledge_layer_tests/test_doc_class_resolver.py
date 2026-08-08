"""Retrieval is store-authoritative for doc_class (Phase B).

The summary store's stored ``doc_class`` must win over the value stamped into
chunk metadata at ingestion time; chunk metadata is only a fallback when the
store has no value for the document.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.factory import configure_summary_db
from aiq_agent.knowledge.factory import register_summary
from aiq_agent.knowledge.factory import set_document_doc_class
from sources.knowledge_layer.src.register import _format_results


def _chunk(*, file_name: str, collection: str, doc_class: str | None):
    metadata = {"collection": collection}
    if doc_class is not None:
        metadata["doc_class"] = doc_class
    return SimpleNamespace(
        file_name=file_name,
        page_number=3,
        content="snippet",
        content_type=SimpleNamespace(value="text"),
        score=0.9,
        metadata=metadata,
    )


def test_stored_doc_class_wins_over_chunk_metadata():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'resolver.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)

        register_summary("oib_knowledge", "doc.pdf", "A document.")
        # Store says richtlinie; the chunk metadata still carries the old guess.
        assert set_document_doc_class("oib_knowledge", "doc.pdf", "oib_richtlinie")

        result = SimpleNamespace(
            success=True,
            chunks=[_chunk(file_name="doc.pdf", collection="oib_knowledge", doc_class="oib_leitfaden")],
            error_message=None,
        )
        text = _format_results(result, "q")

        # The STORED class is what the LLM sees, not the chunk-metadata one.
        assert "Dokumentart: oib_richtlinie" in text
        assert "oib_leitfaden" not in text
        # And the Trace-Lanes lane derives from the stored class (richtlinie).
        assert "baurecht_oib" in text


def test_falls_back_to_chunk_metadata_when_store_empty():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'resolver2.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)

        # No summary row / no stored doc_class for this document.
        result = SimpleNamespace(
            success=True,
            chunks=[_chunk(file_name="orphan.pdf", collection="oib_knowledge", doc_class="oib_leitfaden")],
            error_message=None,
        )
        text = _format_results(result, "q")

        assert "Dokumentart: oib_leitfaden" in text


def test_stored_display_title_is_the_source_label():
    """The stored display title (admin override) becomes the citation `Source:`."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'title.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)

        register_summary("oib_knowledge", "oib-rl_2_ausgabe_mai_2023.pdf", "Brandschutz.")
        from aiq_agent.knowledge.factory import set_document_display_title

        assert set_document_display_title("oib_knowledge", "oib-rl_2_ausgabe_mai_2023.pdf", "Custom OIB Name")

        result = SimpleNamespace(
            success=True,
            chunks=[_chunk(file_name="oib-rl_2_ausgabe_mai_2023.pdf", collection="oib_knowledge", doc_class=None)],
            error_message=None,
        )
        text = _format_results(result, "q")

        # The human name is the Source label; the raw filename only appears in the
        # machine Citation (needed for preview/identity), never as the Source.
        assert "Source: Custom OIB Name" in text
        assert "Source: oib-rl_2_ausgabe_mai_2023.pdf" not in text
        assert "Citation: oib-rl_2_ausgabe_mai_2023.pdf, p.3" in text


def test_display_title_falls_back_to_derived_default():
    """With no stored title, the Source label is derived from the OIB filename."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'title2.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)

        result = SimpleNamespace(
            success=True,
            chunks=[_chunk(file_name="oib-rl_2_ausgabe_mai_2023.pdf", collection="oib_knowledge", doc_class=None)],
            error_message=None,
        )
        text = _format_results(result, "q")

        assert "Source: OIB-Richtlinie 2, Ausgabe Mai 2023" in text


def test_non_oib_upload_keeps_its_filename_as_source():
    """A project upload with no derivable OIB name keeps its own filename."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'title3.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)

        result = SimpleNamespace(
            success=True,
            chunks=[_chunk(file_name="Brandschutzkonzept.pdf", collection="s_session", doc_class=None)],
            error_message=None,
        )
        text = _format_results(result, "q")

        assert "Source: Brandschutzkonzept.pdf" in text

"""Retrieval is store-authoritative for doc_class (Phase B).

The summary store's stored ``doc_class`` must win over the value stamped into
chunk metadata at ingestion time; chunk metadata is only a fallback when the
store has no value for the document.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

from aiq_agent.knowledge.factory import configure_summary_db
from aiq_agent.knowledge.factory import register_summary
from aiq_agent.knowledge.factory import set_document_doc_class
from aiq_agent.knowledge.summary_store import SummaryStore
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
        SummaryStore._tables_initialized.discard(db_url)
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
        SummaryStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)

        # No summary row / no stored doc_class for this document.
        result = SimpleNamespace(
            success=True,
            chunks=[_chunk(file_name="orphan.pdf", collection="oib_knowledge", doc_class="oib_leitfaden")],
            error_message=None,
        )
        text = _format_results(result, "q")

        assert "Dokumentart: oib_leitfaden" in text

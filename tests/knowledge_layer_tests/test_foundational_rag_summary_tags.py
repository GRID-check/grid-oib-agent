"""Tests for the Foundational RAG client-side summary + tag persistence paths.

Covers the two ingestion sites (single-file ``upload_file`` and batch
``_upload_files_async``) where a one-sentence summary and controlled tags are
generated client-side and registered in the backend-agnostic summary store:

- Summary and tags are INDEPENDENT: a failed/timed-out summary must not orphan
  the tags future or discard good tags.
- When the summary fails but tags succeed, the row still persists using a
  deterministic, LLM-free fallback summary (the summary column is NOT NULL).
- ``FileInfo.tags`` mirrors what was actually persisted (no store divergence).
- Text is extracted ONCE and shared by both the summary and tag calls.
"""

import time
from unittest.mock import MagicMock

import pytest
from knowledge_layer.foundational_rag import adapter
from knowledge_layer.foundational_rag.adapter import FoundationalRagIngestor


@pytest.fixture
def summary_db(tmp_path):
    """Isolate the summary registry in a temp SQLite DB for each test."""
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._summary_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._summary_store = None


def _summary_fails_tags_ok(prompt):
    """Same LLM for both calls, routed by prompt: summary raises, tags succeed.

    The tag prompt is the only one containing "klassifizierst"; the summary
    prompt is anything else (decoupled from the summary prompt's exact wording).
    """
    if "klassifizierst" not in prompt:
        raise RuntimeError("summary model unavailable")
    return MagicMock(content='["Schnitt", "Brandschutz"]')


def _all_fail(prompt):
    raise RuntimeError("model unavailable")


def _make_ingestor(llm_side_effect):
    llm = MagicMock()
    llm.invoke.side_effect = llm_side_effect
    ing = FoundationalRagIngestor({"generate_summary": True, "summary_llm": llm})
    # Never hit the network: the upload POST is mocked to succeed.
    ing.session = MagicMock()
    ing.session.post.return_value.json.return_value = {"task_id": "t1", "message": "ok"}
    return ing


# =============================================================================
# Single-file path (upload_file)
# =============================================================================


class TestUploadFileTagPersistence:
    def test_summary_fail_tags_ok_persists_fallback_and_syncs_fileinfo(self, tmp_path, summary_db):
        from aiq_agent.knowledge import get_available_documents

        ing = _make_ingestor(_summary_fails_tags_ok)
        doc = tmp_path / "konzept.txt"
        doc.write_text("Dies ist ein Brandschutzkonzept fuer das Gebaeude.", encoding="utf-8")

        file_info = ing.upload_file(str(doc), "coll_single")

        docs = get_available_documents("coll_single")
        assert len(docs) == 1
        assert docs[0].tags == ["Schnitt", "Brandschutz"]
        # Deterministic text fallback, not an LLM sentence.
        assert docs[0].summary is not None
        assert "Brandschutzkonzept" in docs[0].summary
        # FileInfo.tags mirrors what was persisted (no divergence).
        assert file_info.tags == ["Schnitt", "Brandschutz"]

    def test_both_fail_persists_nothing_and_fileinfo_tags_none(self, tmp_path, summary_db):
        from aiq_agent.knowledge import get_available_documents

        ing = _make_ingestor(_all_fail)
        doc = tmp_path / "leer.txt"
        doc.write_text("Ein kurzer Text.", encoding="utf-8")

        file_info = ing.upload_file(str(doc), "coll_none")

        # No summary and no tags -> nothing persisted, FileInfo carries no tags.
        assert get_available_documents("coll_none") == []
        assert file_info.tags is None

    def test_text_extracted_only_once(self, tmp_path, monkeypatch, summary_db):
        calls = {"n": 0}
        real = adapter._extract_text

        def counting(*args, **kwargs):
            calls["n"] += 1
            return real(*args, **kwargs)

        monkeypatch.setattr(adapter, "_extract_text", counting)

        ing = _make_ingestor(_summary_fails_tags_ok)
        doc = tmp_path / "einmal.txt"
        doc.write_text("Text der nur einmal extrahiert werden soll.", encoding="utf-8")

        ing.upload_file(str(doc), "coll_once")

        # Extraction is shared by the summary + tag calls (single extraction).
        assert calls["n"] == 1


# =============================================================================
# Batch path (_upload_files_async via submit_job)
# =============================================================================


def _wait_for_docs(collection, timeout=15):
    from aiq_agent.knowledge import get_available_documents

    deadline = time.time() + timeout
    while time.time() < deadline:
        docs = get_available_documents(collection)
        if docs:
            return docs
        time.sleep(0.05)
    return get_available_documents(collection)


class TestBatchTagPersistence:
    def test_batch_summary_fail_tags_ok_persists_fallback(self, tmp_path, summary_db):
        ing = _make_ingestor(_summary_fails_tags_ok)
        doc = tmp_path / "batch.txt"
        doc.write_text("Ein Schnitt durch das Brandschutzkonzept des Gebaeudes.", encoding="utf-8")

        ing.submit_job([str(doc)], "coll_batch", config={"original_filenames": ["batch.txt"]})

        docs = _wait_for_docs("coll_batch")
        assert len(docs) == 1
        # Tags persisted even though the summary future failed (not orphaned).
        assert docs[0].tags == ["Schnitt", "Brandschutz"]
        assert docs[0].summary is not None
        assert "Brandschutzkonzept" in docs[0].summary

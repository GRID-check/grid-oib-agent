"""Unit tests for standalone PNG/JPG image ingestion (FB-15a).

Covers:
- ``_looks_like_image`` magic-byte detection (PNG / JPEG / false positives).
- ``_build_image_caption_document`` — the caption Document shape (mocked VLM)
  and graceful failure on undecodable bytes.
- The ``_run_ingestion`` image branch end-to-end (heavy LlamaIndex/embedding
  collaborators mocked): happy path registers a summary + tags, an unconfigured
  VLM fails the file with the specific machine-readable reason, and corrupt
  image bytes fail the file without crashing the job.
"""

import io
import time
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.llamaindex.adapter import _build_image_caption_document
from knowledge_layer.llamaindex.adapter import _looks_like_image
from PIL import Image


def _png_bytes(size=(120, 90), color="red") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_bytes(size=(120, 90), color="blue") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


# =============================================================================
# Magic-byte detection
# =============================================================================


class TestLooksLikeImage:
    def test_png_detected(self, tmp_path):
        p = tmp_path / "photo.png"
        p.write_bytes(_png_bytes())
        assert _looks_like_image(str(p)) == "png"

    def test_jpeg_detected(self, tmp_path):
        p = tmp_path / "photo.jpg"
        p.write_bytes(_jpeg_bytes())
        assert _looks_like_image(str(p)) == "jpeg"

    def test_pdf_is_not_an_image(self, tmp_path):
        p = tmp_path / "doc.pdf"
        p.write_bytes(b"%PDF-1.7\n1 0 obj\n")
        assert _looks_like_image(str(p)) is None

    def test_plain_text_is_not_an_image(self, tmp_path):
        p = tmp_path / "notes.txt"
        p.write_bytes(b"Hello world, this is text.")
        assert _looks_like_image(str(p)) is None

    def test_empty_file_is_not_an_image(self, tmp_path):
        p = tmp_path / "empty.bin"
        p.write_bytes(b"")
        assert _looks_like_image(str(p)) is None

    def test_missing_file_returns_none(self, tmp_path):
        assert _looks_like_image(str(tmp_path / "nope.png")) is None


# =============================================================================
# Caption document construction
# =============================================================================


class TestBuildImageCaptionDocument:
    def test_happy_path_metadata_shape(self, tmp_path, monkeypatch):
        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", lambda *a, **k: ("image", "A red rectangle."))
        p = tmp_path / "photo.png"
        p.write_bytes(_png_bytes(size=(120, 90)))

        doc = _build_image_caption_document(str(p), "photo.png", 999, "png")

        assert doc is not None
        assert doc.text == "[IMAGE from page 1]\n\nA red rectangle."
        assert doc.metadata == {
            "file_name": "photo.png",
            "file_size": 999,
            "page_label": "1",
            "content_type": "image",
            "image_index": 0,
            "image_format": "png",
            "image_width": 120,
            "image_height": 90,
        }

    def test_chart_classification_uses_chart_prefix(self, tmp_path, monkeypatch):
        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", lambda *a, **k: ("chart", "A bar chart of sales."))
        p = tmp_path / "chart.jpg"
        p.write_bytes(_jpeg_bytes())

        doc = _build_image_caption_document(str(p), "chart.jpg", 111, "jpeg")

        assert doc.text.startswith("[CHART from page 1]")
        assert doc.metadata["content_type"] == "chart"

    def test_corrupt_bytes_return_none(self, tmp_path, monkeypatch):
        # The VLM must never be reached when the bytes cannot be decoded.
        vlm = MagicMock()
        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", vlm)
        p = tmp_path / "broken.png"
        p.write_bytes(b"this is not a real image")

        assert _build_image_caption_document(str(p), "broken.png", 10, "png") is None
        vlm.assert_not_called()


# =============================================================================
# _run_ingestion image branch (heavy collaborators mocked)
# =============================================================================


@pytest.fixture
def summary_db(tmp_path):
    """Isolate the summary registry in a temp SQLite DB for each test."""
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._summary_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._summary_store = None


@pytest.fixture
def ingestor(tmp_path, monkeypatch):
    """A LlamaIndexIngestor with embeddings + vector index mocked out."""
    # Deterministic summary + tag LLM: routes by prompt prefix.
    def fake_invoke(prompt):
        if prompt.startswith("Summarize"):
            return MagicMock(content="An image of a floor plan.")
        return MagicMock(content='["Foto", "Grundriss"]')

    llm = MagicMock()
    llm.invoke.side_effect = fake_invoke

    ing = LlamaIndexIngestor(
        {
            "persist_dir": str(tmp_path / "chroma"),
            "generate_summary": True,
            "summary_llm": llm,
        }
    )
    # Skip real NVIDIA embedding initialization.
    ing._embed_model = MagicMock()
    ing._initialized = True

    # Never embed: replace the vector index + global Settings with stand-ins
    # (Settings.embed_model otherwise type-validates the assignment).
    monkeypatch.setattr("llama_index.core.VectorStoreIndex", MagicMock())
    monkeypatch.setattr("llama_index.core.Settings", MagicMock())
    return ing


def _wait_terminal(ing, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


class TestRunIngestionImageBranch:
    def test_happy_path_registers_summary_and_tags(self, tmp_path, monkeypatch, ingestor, summary_db):
        from aiq_agent.knowledge import get_available_documents

        monkeypatch.setattr(adapter, "_get_vlm_api_key", lambda: "vlm-key")
        monkeypatch.setattr(
            adapter, "_analyze_image_with_vlm", lambda *a, **k: ("image", "A detailed floor plan drawing.")
        )

        img = tmp_path / "grundriss.png"
        img.write_bytes(_png_bytes())

        job_id = ingestor.submit_job(
            [str(img)], "coll_img", config={"original_filenames": ["grundriss.png"]}
        )
        status = _wait_terminal(ingestor, job_id)

        assert status.is_success
        assert status.file_details[0].status.value == "success"

        docs = get_available_documents("coll_img")
        assert len(docs) == 1
        assert docs[0].file_name == "grundriss.png"
        assert docs[0].summary == "An image of a floor plan."
        assert docs[0].tags == ["Foto", "Grundriss"]

    def test_vlm_unconfigured_fails_with_specific_reason(self, tmp_path, monkeypatch, ingestor, summary_db):
        monkeypatch.setattr(adapter, "_get_vlm_api_key", lambda: "")

        img = tmp_path / "photo.png"
        img.write_bytes(_png_bytes())

        job_id = ingestor.submit_job([str(img)], "coll_novlm", config={"original_filenames": ["photo.png"]})
        status = _wait_terminal(ingestor, job_id)

        assert not status.is_success
        detail = status.file_details[0]
        assert detail.status.value == "failed"
        assert detail.error_message == "vlm_not_configured: image ingestion requires AIQ_VLM_API_KEY"

    def test_corrupt_image_fails_without_crashing(self, tmp_path, monkeypatch, ingestor, summary_db):
        monkeypatch.setattr(adapter, "_get_vlm_api_key", lambda: "vlm-key")
        vlm = MagicMock()
        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", vlm)

        # .png extension routes it to the image branch, but the bytes are junk.
        img = tmp_path / "broken.png"
        img.write_bytes(b"definitely not a PNG payload")

        job_id = ingestor.submit_job([str(img)], "coll_corrupt", config={"original_filenames": ["broken.png"]})
        status = _wait_terminal(ingestor, job_id)

        assert not status.is_success
        detail = status.file_details[0]
        assert detail.status.value == "failed"
        assert "corrupted" in (detail.error_message or "").lower()
        vlm.assert_not_called()

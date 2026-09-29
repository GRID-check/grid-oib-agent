"""A Word or presentation file is indexed from its PDF rendition, only (ADR-0071).

``POST /v1/ingest`` hands the job ``config["extraction_paths"]`` when the BFF
sent ``extraction_ref``: a deferred download (or, from other callers, a local
path) of ``_render.pdf``. The pipeline reads every byte from the rendition
through its PDF path, identity (``file_name``) stays the original's, and a pptx
original adds its speaker notes. Without a rendition such a file fails with
``office_rendition_required``: there is no second way to read it. Layers: the
notes companion; ``knowledge_layer.renditions``; ``_run_ingestion`` end to end
with the heavy collaborators (embedder, vector index, VLM, pdfplumber) mocked.
"""

from __future__ import annotations

import threading
import time
import zipfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import office_extractors
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.renditions import OFFICE_RENDITION_REQUIRED
from knowledge_layer.renditions import align_extraction_paths
from knowledge_layer.renditions import requires_rendition

from aiq_agent.common.credential_resolution import ResolvedCredential

pptx = pytest.importorskip("pptx")


def _deck(path, *, hide_second: bool = False) -> None:
    """Three slides with notes; slide 2 optionally hidden (``show="0"``)."""
    presentation = pptx.Presentation()
    for number, note in enumerate(["Fluchtwege zeigen", "Interne Notiz", "Stiegenhaus 2 betonen"], start=1):
        slide = presentation.slides.add_slide(presentation.slide_layouts[1])
        slide.shapes.title.text = f"Folientitel {number}"
        slide.notes_slide.notes_text_frame.text = note
    if hide_second:
        presentation.slides[1]._element.set("show", "0")
    presentation.save(path)


def _minimal_docx(path) -> None:
    body = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>Originaltext aus dem docx</w:t></w:r></w:p></w:body></w:document>"
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", body)
        archive.writestr(
            "[Content_Types].xml", "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'/>"
        )


# =============================================================================
# The notes companion
# =============================================================================


class TestSpeakerNotesCompanion:
    def test_notes_only_one_unit_per_slide_labelled_by_page(self, tmp_path):
        path = tmp_path / "tmp123.pptx"
        _deck(path)

        docs = office_extractors.extract_rendition_companions(str(path), "Vortrag.pptx", 42)

        assert [d.metadata["page_label"] for d in docs] == ["1", "2", "3"]
        assert "Fluchtwege zeigen" in docs[0].text
        # The rendition already indexed the slide text; the notes unit must not repeat it.
        assert all("Folientitel" not in d.text for d in docs)
        assert {d.metadata["file_name"] for d in docs} == {"Vortrag.pptx"}
        assert {d.metadata["file_size"] for d in docs} == {42}
        assert {d.metadata["content_type"] for d in docs} == {"text"}

    def test_a_hidden_slide_is_skipped_and_does_not_shift_the_pages(self, tmp_path):
        """LibreOffice leaves hidden slides out of the PDF, so the deck's slide 3
        is the rendition's page 2, and that is where a citation must land."""
        path = tmp_path / "deck.pptx"
        _deck(path, hide_second=True)

        docs = office_extractors.extract_rendition_companions(str(path), "deck.pptx", 1)

        assert [(d.metadata["page_label"], "Stiegenhaus" in d.text) for d in docs] == [("1", False), ("2", True)]
        assert all("Interne Notiz" not in d.text for d in docs)

    def test_a_format_without_a_companion_adds_nothing(self, tmp_path):
        path = tmp_path / "bericht.docx"
        _minimal_docx(path)
        assert office_extractors.extract_rendition_companions(str(path), "bericht.docx", 1) == []

    def test_a_deck_without_notes_adds_nothing(self, tmp_path):
        presentation = pptx.Presentation()
        presentation.slides.add_slide(presentation.slide_layouts[1]).shapes.title.text = "Nur Titel"
        path = tmp_path / "deck.pptx"
        presentation.save(path)
        assert office_extractors.extract_rendition_companions(str(path), "deck.pptx", 1) == []


class TestRequiresRendition:
    @pytest.mark.parametrize("name", ["Bericht.docx", "alt.DOC", "brief.odt", "a.rtf", "deck.pptm", "t.ods", "t.xls"])
    def test_word_presentation_and_legacy_sheets(self, name):
        assert requires_rendition(name, "/tmp/tmpabc.bin")

    @pytest.mark.parametrize("name", ["Raumliste.xlsx", "makro.xlsm", "plan.pdf", "notiz.txt", "foto.png"])
    def test_everything_else_keeps_its_reader(self, name):
        assert not requires_rendition(name, "/tmp/tmpabc.bin")

    def test_the_temp_suffix_answers_when_the_name_has_none(self):
        assert requires_rendition("Bericht", "/tmp/tmpabc.docx")


# =============================================================================
# submit_job's lockstep alignment
# =============================================================================


class TestAlignExtractionPaths:
    def test_a_skipped_original_takes_its_rendition_with_it(self, tmp_path):
        orphan = tmp_path / "orphan.pdf"
        orphan.write_bytes(b"%PDF")
        kept = tmp_path / "kept.pdf"
        kept.write_bytes(b"%PDF")
        config = {"cleanup_files": True, "extraction_paths": [str(orphan), str(kept)]}

        align_extraction_paths(config, [1])

        assert config["extraction_paths"] == [str(kept)]
        assert not orphan.exists()
        assert kept.exists()

    def test_without_cleanup_nothing_is_deleted(self, tmp_path):
        orphan = tmp_path / "orphan.pdf"
        orphan.write_bytes(b"%PDF")
        config = {"extraction_paths": [str(orphan)]}

        align_extraction_paths(config, [])

        assert config["extraction_paths"] == []
        assert orphan.exists()

    def test_a_shorter_list_pads_with_none(self):
        config = {"extraction_paths": ["/tmp/a.pdf"]}
        align_extraction_paths(config, [0, 1])
        assert config["extraction_paths"] == ["/tmp/a.pdf", None]


# =============================================================================
# Through _run_ingestion
# =============================================================================


@pytest.fixture
def summary_db(tmp_path):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture
def ingestor(tmp_path, monkeypatch):
    llm = MagicMock()
    llm.invoke.side_effect = lambda prompt: MagicMock(
        content='["Bericht"]' if "klassifizierst" in prompt else "Ein Bericht zur Baubesprechung."
    )
    ing = LlamaIndexIngestor(
        {"persist_dir": str(tmp_path / "chroma"), "generate_summary": True, "summary_llm": llm, "extract_images": True}
    )
    ing._embed_model = MagicMock()
    ing._initialized = True
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


def _gone(path, timeout=5) -> bool:
    """Whether ``path`` is deleted within ``timeout``.

    The job reports its terminal status before its ``finally`` deletes the temp
    files, so an assertion made the instant the status turns terminal races the
    cleanup; it failed intermittently in the full suite and never alone.
    """
    deadline = time.time() + timeout
    while path.exists() and time.time() < deadline:
        time.sleep(0.02)
    return not path.exists()


def _indexed_documents():
    import llama_index.core

    documents = []
    for call in llama_index.core.VectorStoreIndex.from_documents.call_args_list:
        documents.extend(call.args[0])
    return documents


@pytest.fixture
def pdf_pipeline(monkeypatch):
    """Stub the PDF stages, recording which path each one was handed."""
    read: dict[str, list[str]] = {"text": [], "images": [], "pages": []}
    cred = ResolvedCredential(api_key="vlm-key", base_url="https://vlm.test/v1", model="test-vlm", source="env")
    monkeypatch.setattr(adapter, "resolve_vlm_credential", lambda organization_id=None: cred)

    def _text(path):
        read["text"].append(path)
        return [
            {"page_number": 1, "text": "Bericht zur Baubesprechung, Seite eins.", "tables": [], "table_boxes": []},
            {"page_number": 2, "text": "Seite zwei: Fluchtweglänge 40 m.", "tables": [], "table_boxes": []},
        ]

    def _images(path, *args, **kwargs):
        read["images"].append(path)
        return [
            {
                "image_bytes": b"\xff\xd8raster",
                "page_number": 2,
                "image_index": 0,
                "format": "jpeg",
                "width": 800,
                "height": 600,
            }
        ]

    def _pages(path, *args, **kwargs):
        read["pages"].append(path)
        return []

    monkeypatch.setattr(adapter, "_extract_text_from_pdf", _text)
    monkeypatch.setattr(adapter, "_extract_images_from_pdf", _images)
    monkeypatch.setattr(adapter, "analyze_visual", lambda *a, **k: ("image", "Ein Schnitt A-A.", {}))
    import knowledge_layer.llamaindex.processing as processing_module

    monkeypatch.setattr(processing_module, "render_visual_pages_no_vlm", _pages)
    return read


def _rendition(tmp_path):
    path = tmp_path / "tmp_render.pdf"
    path.write_bytes(b"%PDF-1.4\n% rendition\n")
    return path


class TestRunIngestionFromRendition:
    def test_a_word_file_is_read_from_its_rendition(self, tmp_path, monkeypatch, ingestor, summary_db, pdf_pipeline):
        original = tmp_path / "tmp_upload.docx"
        _minimal_docx(original)
        original_size = original.stat().st_size
        rendition = _rendition(tmp_path)
        office = MagicMock(side_effect=AssertionError("the office extractor must not run"))
        monkeypatch.setattr(office_extractors, "extract_office_documents", office)

        job_id = ingestor.submit_job(
            [str(original)],
            "proj_1",
            config={
                "original_filenames": ["Bericht.docx"],
                "extraction_paths": [str(rendition)],
                "cleanup_files": True,
            },
        )
        assert _wait_terminal(ingestor, job_id).is_success

        assert pdf_pipeline["text"] == [str(rendition)]
        assert pdf_pipeline["images"] == [str(rendition)]
        assert pdf_pipeline["pages"] == [str(rendition)]
        documents = _indexed_documents()
        assert {d.metadata["file_name"] for d in documents} == {"Bericht.docx"}
        assert {d.metadata["file_size"] for d in documents} == {original_size}
        text = [d for d in documents if d.metadata["content_type"] == "text"]
        assert [d.metadata["page_label"] for d in text] == ["1", "2"]
        assert "Originaltext" not in " ".join(d.text for d in documents)
        [image] = [d for d in documents if d.metadata["content_type"] == "image"]
        assert image.metadata["page_label"] == "2"
        # The job owns both temp files and deletes both.
        assert _gone(original)
        assert _gone(rendition)

    def test_a_pptx_adds_its_notes_on_the_slide_pages(self, tmp_path, ingestor, summary_db, pdf_pipeline):
        original = tmp_path / "tmp_upload.pptx"
        _deck(original)
        rendition = _rendition(tmp_path)

        job_id = ingestor.submit_job(
            [str(original)],
            "proj_1",
            config={"original_filenames": ["Vortrag.pptx"], "extraction_paths": [str(rendition)]},
        )
        assert _wait_terminal(ingestor, job_id).is_success

        documents = _indexed_documents()
        assert {d.metadata["file_name"] for d in documents} == {"Vortrag.pptx"}
        notes = [d for d in documents if "Notizen des Vortragenden" in d.text]
        assert [d.metadata["page_label"] for d in notes] == ["1", "2", "3"]
        # The slide text came from the rendition (stubbed), never from python-pptx.
        assert all("Folientitel" not in d.text for d in documents)

    def test_without_a_rendition_the_file_fails_with_a_stable_reason(
        self, tmp_path, ingestor, summary_db, pdf_pipeline
    ):
        """No second way to read a Word file: no rendition, no index, and a
        reason the failed-document UX can key on."""
        original = tmp_path / "tmp_upload.docx"
        _minimal_docx(original)

        job_id = ingestor.submit_job([str(original)], "proj_1", config={"original_filenames": ["Bericht.docx"]})
        status = _wait_terminal(ingestor, job_id)

        assert not status.is_success
        assert status.file_details[0].error_message == OFFICE_RENDITION_REQUIRED
        assert status.file_details[0].error_message.startswith("office_rendition_required:")
        assert pdf_pipeline["text"] == []
        assert _indexed_documents() == []

    def test_a_rendition_gone_before_the_worker_fails_the_same_way(self, tmp_path, ingestor, summary_db, pdf_pipeline):
        original = tmp_path / "tmp_upload.pptx"
        _deck(original)

        job_id = ingestor.submit_job(
            [str(original)],
            "proj_1",
            config={"original_filenames": ["Vortrag.pptx"], "extraction_paths": [str(tmp_path / "missing.pdf")]},
        )
        status = _wait_terminal(ingestor, job_id)

        assert status.file_details[0].error_message == OFFICE_RENDITION_REQUIRED
        assert _indexed_documents() == []

    def test_a_spreadsheet_keeps_its_own_reader(self, tmp_path, ingestor, summary_db, pdf_pipeline):
        openpyxl = pytest.importorskip("openpyxl")
        workbook = openpyxl.Workbook()
        workbook.active.append(["Raum", "Fläche"])
        original = tmp_path / "tmp_upload.xlsx"
        workbook.save(original)

        job_id = ingestor.submit_job([str(original)], "proj_1", config={"original_filenames": ["Raumliste.xlsx"]})
        assert _wait_terminal(ingestor, job_id).is_success

        assert pdf_pipeline["text"] == []
        [document] = _indexed_documents()
        assert document.metadata["content_type"] == "table"


# =============================================================================
# Downloads the route deferred to the job
# =============================================================================


def _deferred(path):
    """A stand-in for aiq_api's DeferredObjectDownload: writes a PDF and returns its path."""

    def _download():
        path.write_bytes(b"%PDF-1.4\n% downloaded rendition\n")
        return str(path)

    return _download


class TestDeferredDownloads:
    def test_the_job_downloads_the_rendition_extracts_it_and_deletes_it(
        self, tmp_path, monkeypatch, ingestor, summary_db, pdf_pipeline
    ):
        original = tmp_path / "tmp_upload.docx"
        _minimal_docx(original)
        downloaded = tmp_path / "downloaded.pdf"
        drawn: list[str] = []
        monkeypatch.setattr(
            LlamaIndexIngestor, "_generate_and_upload_thumbnail", staticmethod(lambda path, url: drawn.append(path))
        )

        job_id = ingestor.submit_job(
            [str(original)],
            "proj_1",
            config={
                "original_filenames": ["Bericht.docx"],
                "extraction_paths": [_deferred(downloaded)],
                "thumbnail_upload_url": "http://seaweed/put/thumb",
            },
        )
        assert _wait_terminal(ingestor, job_id).is_success

        assert pdf_pipeline["text"] == [str(downloaded)]
        # One download serves the thumbnail as well.
        assert drawn == [str(downloaded)]
        assert {d.metadata["file_name"] for d in _indexed_documents()} == {"Bericht.docx"}
        # The job made the file, so the job deletes it, cleanup_files or not.
        assert _gone(downloaded)
        assert original.exists()

    def test_a_failed_download_fails_the_file_without_logging_the_url(
        self, tmp_path, ingestor, summary_db, pdf_pipeline, caplog
    ):
        original = tmp_path / "tmp_upload.docx"
        _minimal_docx(original)

        def _fails():
            raise RuntimeError("403 for http://seaweed/_render.pdf?X-Amz-Signature=secret")

        job_id = ingestor.submit_job(
            [str(original)],
            "proj_1",
            config={"original_filenames": ["Bericht.docx"], "extraction_paths": [_fails]},
        )
        status = _wait_terminal(ingestor, job_id)

        assert status.file_details[0].error_message == OFFICE_RENDITION_REQUIRED
        assert all("X-Amz-Signature" not in record.getMessage() for record in caplog.records)


# =============================================================================
# The original, downloaded by the job (knowledge_layer.deferred_files)
# =============================================================================

_SIGNED_ORIGINAL = "http://seaweed/bucket/doc/object?X-Amz-Signature=secret-original"


def _object_store_get(content: bytes, content_type: str, *, gate: threading.Event | None = None):
    """An ``httpx.get`` stand-in for the object store, optionally held until ``gate`` is set."""
    import httpx

    calls: list[str] = []

    def _get(url, **kwargs):
        calls.append(url)
        assert kwargs["follow_redirects"] is False
        if gate is not None:
            gate.wait(timeout=10)
        response = MagicMock(spec=httpx.Response)
        response.content = content
        response.headers = {"content-type": content_type}
        return response

    return _get, calls


class TestDeferredOriginal:
    """What ``POST /v1/ingest`` hands the job: the original as a download, not a path."""

    def test_the_job_downloads_the_original_ingests_it_and_deletes_it(
        self, tmp_path, monkeypatch, ingestor, summary_db, pdf_pipeline, caplog
    ):
        from aiq_api.routes.ingest import DeferredObjectDownload

        get, calls = _object_store_get(b"%PDF-1.4\n% original\n", "application/pdf")
        monkeypatch.setattr("httpx.get", get)
        drawn: list[str] = []
        monkeypatch.setattr(
            LlamaIndexIngestor, "_generate_and_upload_thumbnail", staticmethod(lambda path, url: drawn.append(path))
        )

        job_id = ingestor.submit_job(
            [DeferredObjectDownload(_SIGNED_ORIGINAL)],
            "proj_1",
            config={
                "original_filenames": ["Plan.pdf"],
                "cleanup_files": True,
                "thumbnail_upload_url": "http://seaweed/put/thumb",
            },
        )
        assert _wait_terminal(ingestor, job_id).is_success

        assert calls == [_SIGNED_ORIGINAL]
        # The suffix came from the response's content type: the object path has none.
        [read] = pdf_pipeline["text"]
        assert read.endswith(".pdf")
        # The thumbnail is drawn from the same download, before extraction.
        assert drawn == [read]
        assert {d.metadata["file_name"] for d in _indexed_documents()} == {"Plan.pdf"}
        assert _gone(Path(read))
        assert all("secret-original" not in record.getMessage() for record in caplog.records)

    def test_a_failed_download_fails_the_file_with_a_stable_reason(
        self, tmp_path, ingestor, summary_db, pdf_pipeline, caplog
    ):
        from knowledge_layer.deferred_files import ORIGINAL_DOWNLOAD_FAILED

        rendition_calls: list[str] = []

        def _expired():
            raise RuntimeError("403 for http://seaweed/Plan.pdf?X-Amz-Signature=secret-original")

        job_id = ingestor.submit_job(
            [_expired],
            "proj_1",
            config={
                "original_filenames": ["Bericht.docx"],
                "extraction_paths": [lambda: rendition_calls.append("rendition") or ""],
            },
        )
        status = _wait_terminal(ingestor, job_id)

        assert not status.is_success
        assert status.file_details[0].file_name == "Bericht.docx"
        assert status.file_details[0].error_message == ORIGINAL_DOWNLOAD_FAILED
        assert status.file_details[0].error_message.startswith("original_download_failed:")
        # No original, no use for its rendition: it is never fetched.
        assert rendition_calls == []
        assert pdf_pipeline["text"] == []
        assert all("secret-original" not in record.getMessage() for record in caplog.records)

    def test_the_job_is_live_while_it_downloads(self, tmp_path, monkeypatch, ingestor, summary_db, pdf_pipeline):
        """A retried dispatch that lands while the job is still downloading
        (on this replica or another) finds the job and joins it."""
        from aiq_api.routes.ingest import DeferredObjectDownload

        gate = threading.Event()
        get, calls = _object_store_get(b"%PDF-1.4\n", "application/pdf", gate=gate)
        monkeypatch.setattr("httpx.get", get)

        job_id = ingestor.submit_job(
            [DeferredObjectDownload(_SIGNED_ORIGINAL)],
            "proj_1",
            config={"original_filenames": ["Plan.pdf"], "dispatch_key": "k-plan", "document_id": "doc-1"},
        )
        try:
            deadline = time.time() + 5
            while not calls and time.time() < deadline:
                time.sleep(0.01)
            assert calls, "the job never started its download"
            assert ingestor.find_live_job("k-plan") == job_id
        finally:
            gate.set()
        assert _wait_terminal(ingestor, job_id).is_success
        assert ingestor.find_live_job("k-plan") is None

    def test_local_paths_are_untouched(self, tmp_path, ingestor, summary_db, pdf_pipeline):
        """Every other caller (the multipart upload, the OIB sync) hands paths."""
        original = _rendition(tmp_path)

        job_id = ingestor.submit_job([str(original)], "proj_1", config={"original_filenames": ["Plan.pdf"]})
        assert _wait_terminal(ingestor, job_id).is_success

        assert pdf_pipeline["text"] == [str(original)]
        # Not the job's file without cleanup_files.
        assert original.exists()

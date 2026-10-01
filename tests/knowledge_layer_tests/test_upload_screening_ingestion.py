"""A screened job stops a matching file before any model sees a byte of it.

Through ``_run_ingestion`` with real local extraction (pdfplumber on a hand-built
PDF, the text-format reader on a ``.txt``) and every external call site replaced
by a recorder: page transcription (``route_pdf_pages``), image captioning
(``_build_image_documents``), VLM enrichment (``enrich_vlm_batch``), summary and
tags (the summary LLM), and embeddings (``VectorStoreIndex`` and the embed
model). A quarantined file must FAIL with a ``quarantined:`` reason and leave
every recorder empty; the same file without a screening config must reach them,
which is what proves the gate, not the stubs, kept them empty.
"""

from __future__ import annotations

import json
import time
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import page_triage
from knowledge_layer.llamaindex import transcription
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.llamaindex.screening import QUARANTINED_PREFIX

from aiq_agent.common.credential_resolution import ResolvedCredential
from aiq_agent.knowledge.schema import FileStatus

from .pdf_fixtures import build_pdf

_IBAN = "AT61 1904 3002 3457 3201"
_TERMS = {"content_terms": ["Gehaltsabrechnung"], "detectors": []}
_IBAN_ONLY = {"content_terms": [], "detectors": ["iban"]}


@pytest.fixture
def summary_db(tmp_path):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture
def calls(tmp_path, monkeypatch, summary_db):
    """Every external call site, recording; plus the ingestor that would make them."""
    import llama_index.core
    from knowledge_layer.llamaindex import processing

    record: dict[str, list] = {"ocr": [], "image_caption": [], "vlm": []}
    cred = ResolvedCredential(api_key="vlm-key", base_url="https://vlm.test/v1", model="test-vlm", source="env")
    monkeypatch.setattr(adapter, "resolve_vlm_credential", lambda organization_id=None: cred)

    def _route(path, text_pages, page_texts, **kwargs):
        record["ocr"].append(kwargs.get("triage", "measured-inside"))
        return transcription.PageRoutes()

    def _caption(file_path, file_name, file_size, image_format, **kwargs):
        from llama_index.core import Document

        record["image_caption"].append(file_name)
        return [Document(text="Ein Foto.", metadata={"file_name": file_name, "content_type": "image"})]

    def _enrich(**kwargs):
        record["vlm"].append(kwargs)
        return [], []

    monkeypatch.setattr(transcription, "route_pdf_pages", _route)
    monkeypatch.setattr(adapter, "_build_image_documents", _caption)
    monkeypatch.setattr(processing, "enrich_vlm_batch", _enrich)
    monkeypatch.setattr(processing, "render_visual_pages_no_vlm", lambda *a, **k: [])

    llm = MagicMock()
    llm.invoke.side_effect = lambda prompt: MagicMock(content='["Bericht"]' if "klassifizierst" in prompt else "Ok.")
    ingestor = LlamaIndexIngestor(
        {"persist_dir": str(tmp_path / "chroma"), "generate_summary": True, "summary_llm": llm, "extract_images": True}
    )
    ingestor._embed_model = MagicMock()
    ingestor._initialized = True
    index = MagicMock()
    monkeypatch.setattr(llama_index.core, "VectorStoreIndex", index)
    monkeypatch.setattr(llama_index.core, "Settings", MagicMock())
    record["ingestor"] = ingestor
    record["summary_llm"] = llm
    record["index"] = index
    return record


def _external_calls(calls: dict) -> dict[str, int]:
    return {
        "ocr": len(calls["ocr"]),
        "image_caption": len(calls["image_caption"]),
        "vlm": len(calls["vlm"]),
        "summary_and_tags": calls["summary_llm"].invoke.call_count,
        "embeddings": calls["index"].from_documents.call_count + len(calls["ingestor"]._embed_model.mock_calls),
    }


def _ingest(calls: dict, path, name: str, screening: dict | None, **config):
    ingestor = calls["ingestor"]
    if screening is not None:
        config["screening"] = screening
    job_id = ingestor.submit_job([str(path)], "proj_1", config={"original_filenames": [name], **config})
    deadline = time.time() + 30
    while time.time() < deadline:
        status = ingestor.get_job_status(job_id)
        if status.is_terminal:
            return status.file_details[0]
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def _pdf(tmp_path, *lines: str):
    path = tmp_path / "upload.pdf"
    path.write_bytes(build_pdf([[("R", 11, line) for line in lines]]))
    return path


def _pdf_with_raster(tmp_path, lines: list[str]):
    """One page: ``lines`` of Helvetica text, and a 160x160 grey raster drawn beside them."""
    side = 160
    pixels = bytes((x + y) % 256 for y in range(side) for x in range(side))
    content = b"".join(
        f"BT /F1 10 Tf 50 {780 - 14 * n} Td ({line}) Tj ET\n".encode("latin-1") for n, line in enumerate(lines)
    )
    content += b"q 120 0 0 120 420 80 cm /Im1 Do Q\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 3 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        (
            f"<< /Type /XObject /Subtype /Image /Width {side} /Height {side} /ColorSpace /DeviceGray "
            f"/BitsPerComponent 8 /Length {len(pixels)} >>\nstream\n"
        ).encode()
        + pixels
        + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    path = tmp_path / "mit_bild.pdf"
    path.write_bytes(bytes(out))
    return path


#: Enough text that triage reads the page as text, not as a drawing.
_BODY = [f"Satz {n:02d}: Die Anforderungen an Bauteile sind gemaess Tabelle einzuhalten." for n in range(12)]


def _reasons(error: str) -> dict:
    assert error.startswith(QUARANTINED_PREFIX)
    return json.loads(error[len(QUARANTINED_PREFIX) :])


_PAYSLIP = ("Gehaltsabrechnung Maerz 2026", "Brutto 4.200,00 EUR", "Projekt Musterstrasse 5")


class TestAQuarantinedFileReachesNoModel:
    def test_a_pdf_with_a_configured_term(self, tmp_path, calls):
        detail = _ingest(calls, _pdf(tmp_path, *_PAYSLIP), "Abrechnung.pdf", _TERMS)

        assert detail.status == FileStatus.FAILED
        assert _reasons(detail.error_message) == {
            "reasons": [{"kind": "term", "term": "Gehaltsabrechnung", "count": 1, "pages": [1]}],
            "checked": "full",
        }
        assert detail.screening == "quarantined"
        assert _external_calls(calls) == dict.fromkeys(_external_calls(calls), 0)

    def test_a_pdf_with_a_valid_iban(self, tmp_path, calls):
        detail = _ingest(calls, _pdf(tmp_path, "Bankverbindung", f"IBAN {_IBAN}"), "Vertrag.pdf", _IBAN_ONLY)

        assert detail.status == FileStatus.FAILED
        [reason] = _reasons(detail.error_message)["reasons"]
        assert reason == {"kind": "iban", "count": 1, "pages": [1], "sample": "AT61 •••• •••• •••• 3201"}
        assert _IBAN not in detail.error_message
        assert _external_calls(calls) == dict.fromkeys(_external_calls(calls), 0)

    def test_a_text_file_with_a_valid_iban(self, tmp_path, calls):
        path = tmp_path / "notiz.txt"
        path.write_text(f"Honorarnote\n\nBitte überweisen auf {_IBAN}.\n", encoding="utf-8")

        detail = _ingest(calls, path, "notiz.txt", _IBAN_ONLY)

        assert detail.status == FileStatus.FAILED
        assert _reasons(detail.error_message)["reasons"][0]["kind"] == "iban"
        assert _external_calls(calls) == dict.fromkeys(_external_calls(calls), 0)

    def test_a_term_only_in_the_speaker_notes_of_a_rendered_deck(self, tmp_path, calls):
        pptx = pytest.importorskip("pptx")
        deck = pptx.Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = "Projektstand"
        slide.notes_slide.notes_text_frame.text = "Gehaltsabrechnung nicht zeigen"
        original = tmp_path / "upload.pptx"
        deck.save(original)
        rendition = _pdf(tmp_path, "Projektstand", "Stiegenhaus 2")

        detail = _ingest(calls, original, "Vortrag.pptx", _TERMS, extraction_paths=[str(rendition)], cleanup_files=True)

        assert detail.status == FileStatus.FAILED
        assert _reasons(detail.error_message)["reasons"][0]["term"] == "Gehaltsabrechnung"
        assert _external_calls(calls) == dict.fromkeys(_external_calls(calls), 0)


class TestTheGateIsConditional:
    def test_the_same_pdf_unscreened_reaches_every_model(self, tmp_path, calls):
        detail = _ingest(calls, _pdf(tmp_path, *_PAYSLIP), "Abrechnung.pdf", None)

        assert detail.status == FileStatus.SUCCESS
        assert detail.screening is None
        reached = _external_calls(calls)
        assert reached["ocr"] == 1 and calls["ocr"] == ["measured-inside"]
        assert reached["vlm"] == 1
        assert reached["summary_and_tags"] >= 1
        assert reached["embeddings"] >= 1

    def test_a_clean_pdf_is_screened_then_ingested(self, tmp_path, calls):
        detail = _ingest(calls, _pdf(tmp_path, "Brandschutzkonzept", "Fluchtweglaenge 40 m"), "BSK.pdf", _TERMS)

        assert detail.status == FileStatus.SUCCESS
        assert detail.screening == "clean"
        # The screen measured the PDF; transcription was handed that triage.
        [triage] = calls["ocr"]
        assert isinstance(triage, page_triage.PdfTriage)
        assert _external_calls(calls)["embeddings"] >= 1

    def test_the_same_text_file_unscreened_is_ingested(self, tmp_path, calls):
        path = tmp_path / "notiz.txt"
        path.write_text(f"Bitte überweisen auf {_IBAN}.\n", encoding="utf-8")

        detail = _ingest(calls, path, "notiz.txt", None)

        assert detail.status == FileStatus.SUCCESS
        assert detail.screening is None


class TestOutcomes:
    def test_an_image_is_unchecked_and_still_ingested(self, tmp_path, calls):
        path = tmp_path / "foto.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 64)

        detail = _ingest(calls, path, "foto.png", _TERMS)

        assert detail.screening == "unchecked"
        assert calls["image_caption"] == ["foto.png"]

    def test_pages_sent_to_a_model_unscreened_make_it_partial(self, tmp_path, calls, monkeypatch):
        scan = page_triage.PdfTriage({1: page_triage.PageKind.TEXT, 2: page_triage.PageKind.SCAN})
        monkeypatch.setattr(page_triage, "triage_pdf", lambda *a, **k: scan)

        detail = _ingest(calls, _pdf(tmp_path, "Brandschutzkonzept"), "BSK.pdf", _TERMS)

        assert detail.screening == "partial"
        assert calls["ocr"] == [scan]

    def test_a_match_on_a_partly_screened_pdf_says_so(self, tmp_path, calls, monkeypatch):
        monkeypatch.setattr(page_triage, "triage_pdf", lambda *a, **k: None)

        detail = _ingest(calls, _pdf(tmp_path, *_PAYSLIP), "Abrechnung.pdf", _TERMS)

        assert _reasons(detail.error_message)["checked"] == "partial"
        assert calls["ocr"] == []

    def test_a_text_pdf_whose_embedded_image_goes_to_the_vlm_is_partial(self, tmp_path, calls):
        detail = _ingest(calls, _pdf_with_raster(tmp_path, _BODY), "Bericht.pdf", _TERMS)

        assert detail.status == FileStatus.SUCCESS
        assert detail.screening == "partial"
        # The page itself is text (nothing routed to OCR or drawing analysis):
        # only the raster makes it partial, and the raster did reach the VLM.
        [triage] = calls["ocr"]
        assert not triage.transcribed and not triage.drawings
        [enrichment] = calls["vlm"]
        assert len(enrichment["image_records"]) == 1

    def test_a_match_on_a_pdf_with_an_embedded_image_says_partial(self, tmp_path, calls):
        detail = _ingest(calls, _pdf_with_raster(tmp_path, ["Gehaltsabrechnung Maerz", *_BODY]), "G.pdf", _TERMS)

        assert detail.status == FileStatus.FAILED
        assert _reasons(detail.error_message)["checked"] == "partial"
        assert _external_calls(calls) == dict.fromkeys(_external_calls(calls), 0)

    def test_without_a_vision_key_the_image_goes_nowhere_and_it_stays_clean(self, tmp_path, calls, monkeypatch):
        cred = ResolvedCredential(api_key="", base_url="https://vlm.test/v1", model="test-vlm", source="env")
        monkeypatch.setattr(adapter, "resolve_vlm_credential", lambda organization_id=None: cred)

        detail = _ingest(calls, _pdf_with_raster(tmp_path, _BODY), "Bericht.pdf", _TERMS)

        assert detail.screening == "clean"


def _ruled_table(rows: list[list[str]]) -> bytes:
    """Content-stream ops for a grid of ruled cells with ``rows`` of text, the shape pdfplumber's table finder reads."""
    from .pdf_fixtures import _escape

    ops = bytearray()
    width, height, top = 150, 20, 700
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            x, y = 50 + c * width, top - (r + 1) * height
            ops += f"{x} {y} {width} {height} re S\n".encode()
            ops += f"BT /FR 10 Tf {x + 4} {y + 6} Td (".encode() + _escape(cell) + b") Tj ET\n"
    return bytes(ops)


def _pdf_with_table_page(tmp_path, monkeypatch, rows: list[list[str]]):
    """Five pages: four of body text, and page 2 holding nothing but a ruled table of ``rows``."""
    from . import pdf_fixtures

    plain = pdf_fixtures._content

    def _content(lines):
        return _ruled_table(rows) if lines == ["TABLE"] else plain(lines)

    monkeypatch.setattr(pdf_fixtures, "_content", _content)
    text = [("R", 10, line) for line in _BODY]
    path = tmp_path / "liste.pdf"
    path.write_bytes(pdf_fixtures.build_pdf([text, ["TABLE"], text, text, text]))
    return path


def _text_pass_loses_page(monkeypatch, lost: int) -> None:
    """Page ``lost`` raises in the text pass, as a pdfplumber edge case does; the table pass still reads it."""
    read = adapter._read_pdf_page

    def _read(page, page_num, previous, pdf_path):
        if page_num == lost:
            raise ValueError("unreadable page")
        return read(page, page_num, previous, pdf_path)

    monkeypatch.setattr(adapter, "_read_pdf_page", _read)


class TestTablesAndCapsAreScreened:
    def test_a_term_only_in_a_table_on_a_page_the_text_pass_lost(self, tmp_path, calls, monkeypatch):
        # One page of five is within the failed-page tolerance, so the file
        # stands; the table pass opens the PDF on its own and reads that page.
        path = _pdf_with_table_page(tmp_path, monkeypatch, [["Posten", "Betrag"], ["Gehaltsabrechnung", "4200"]])
        _text_pass_loses_page(monkeypatch, 2)

        detail = _ingest(calls, path, "Liste.pdf", _TERMS, extract_tables=True)

        assert detail.status == FileStatus.FAILED
        assert _reasons(detail.error_message)["reasons"][0] == {
            "kind": "term",
            "term": "Gehaltsabrechnung",
            "count": 1,
            "pages": [2],
        }
        assert _external_calls(calls) == dict.fromkeys(_external_calls(calls), 0)

    def test_a_page_the_text_pass_lost_makes_it_partial(self, tmp_path, calls, monkeypatch):
        path = _pdf_with_table_page(tmp_path, monkeypatch, [["Posten", "Betrag"], ["Estrich", "4200"]])
        _text_pass_loses_page(monkeypatch, 2)

        detail = _ingest(calls, path, "Liste.pdf", _TERMS, extract_tables=False)

        assert detail.status == FileStatus.SUCCESS
        assert detail.screening == "partial"

    def test_a_term_only_in_spreadsheet_rows_past_the_cap_is_partial(self, tmp_path, calls, monkeypatch):
        openpyxl = pytest.importorskip("openpyxl")
        from knowledge_layer.llamaindex import office_extractors

        monkeypatch.setattr(office_extractors, "MAX_TABLE_ROWS", 3)
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        for row in (["Raum", "Flaeche"], ["Buero", "20"], ["Lager", "12"], ["Gehaltsabrechnung", "1"]):
            sheet.append(row)
        path = tmp_path / "raumliste.xlsx"
        workbook.save(path)

        detail = _ingest(calls, path, "Raumliste.xlsx", _TERMS)

        assert detail.status == FileStatus.SUCCESS
        assert detail.metadata["rows_over_cap"] == 1
        assert detail.screening == "partial"
        embedded = [doc.text for call in calls["index"].from_documents.call_args_list for doc in call.args[0]]
        assert embedded and not any("Gehaltsabrechnung" in text for text in embedded)

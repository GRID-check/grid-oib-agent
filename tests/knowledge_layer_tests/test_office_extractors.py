"""Unit tests for the zipped-office-format extractors (docx/xlsx/pptx).

The regression these guard: without ``llama-index-readers-file`` installed,
``SimpleDirectoryReader`` reads an office file's raw zip bytes as text
(``PK\\x03…``), which the binary-content guard then rejects — every Word
upload failed ingestion. Real files are built with the same libraries the
extractors use, so the tests exercise the actual parse.
"""

import zipfile

import pytest
from knowledge_layer.llamaindex import office_extractors
from knowledge_layer.llamaindex.adapter import _looks_like_image
from knowledge_layer.llamaindex.adapter import _looks_like_raw_pdf_or_binary


def _minimal_docx(path):
    document_xml = (
        '<?xml version="1.0"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>Brandschutzkonzept nach OIB-Richtlinie 2</w:t></w:r></w:p></w:body></w:document>"
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", document_xml)
        archive.writestr(
            "[Content_Types].xml",
            "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'/>",
        )


class TestDocx:
    def test_extracts_text_not_zip_bytes(self, tmp_path):
        path = tmp_path / "konzept.docx"
        _minimal_docx(path)
        docs = office_extractors.extract_office_documents(str(path), "konzept.docx", 123)
        assert len(docs) == 1
        assert "Brandschutzkonzept" in docs[0].text
        # The exact failure mode this module exists to prevent.
        assert not _looks_like_raw_pdf_or_binary(docs[0].text)
        assert docs[0].metadata["file_name"] == "konzept.docx"
        assert docs[0].metadata["content_type"] == "text"


class TestXlsx:
    def test_one_document_per_sheet_labelled_by_name(self, tmp_path):
        openpyxl = pytest.importorskip("openpyxl")
        workbook = openpyxl.Workbook()
        first = workbook.active
        first.title = "Raumliste"
        first.append(["Raum", "Fläche"])
        first.append(["Atelier", "24,5 m²"])
        second = workbook.create_sheet("Kosten")
        second.append(["Position", "Betrag"])
        second.append(["Rohbau", "1.200.000"])
        workbook.create_sheet("Leer")  # no content → no document
        path = tmp_path / "raumliste.xlsx"
        workbook.save(path)

        docs = office_extractors.extract_office_documents(str(path), "raumliste.xlsx", 1)

        assert [d.metadata["page_label"] for d in docs] == ["Raumliste", "Kosten"]
        assert "| Atelier | 24,5 m² |" in docs[0].text
        assert docs[0].metadata["content_type"] == "table"

    def test_row_cap_is_stated_not_silent(self, tmp_path):
        openpyxl = pytest.importorskip("openpyxl")
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        for i in range(office_extractors.MAX_TABLE_ROWS + 50):
            sheet.append([f"Zeile {i}", i])
        path = tmp_path / "lang.xlsx"
        workbook.save(path)

        docs = office_extractors.extract_office_documents(str(path), "lang.xlsx", 1)

        assert "Tabelle gekürzt" in docs[0].text
        assert f"Zeile {office_extractors.MAX_TABLE_ROWS - 1}" in docs[0].text
        assert f"Zeile {office_extractors.MAX_TABLE_ROWS}" not in docs[0].text


class TestPptx:
    def test_one_document_per_slide_with_notes(self, tmp_path):
        pptx = pytest.importorskip("pptx")
        presentation = pptx.Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[1])
        slide.shapes.title.text = "Projektvorstellung"
        slide.placeholders[1].text = "Bestand transformieren statt abreißen"
        slide.notes_slide.notes_text_frame.text = "Hinweis auf OIB 2.1"
        path = tmp_path / "vortrag.pptx"
        presentation.save(path)

        docs = office_extractors.extract_office_documents(str(path), "vortrag.pptx", 1)

        assert len(docs) == 1
        assert docs[0].metadata["page_label"] == "1"
        assert "Projektvorstellung" in docs[0].text
        assert "Notizen: Hinweis auf OIB 2.1" in docs[0].text


class TestRouting:
    def test_unhandled_extension_returns_none(self, tmp_path):
        path = tmp_path / "notiz.txt"
        path.write_text("nur text")
        assert office_extractors.extract_office_documents(str(path), "notiz.txt", 1) is None

    def test_extension_of_original_name_wins_over_temp_path(self, tmp_path):
        # Uploads land as temp files; the ORIGINAL filename carries the truth.
        path = tmp_path / "tmpabc123.bin"
        _minimal_docx(path)
        docs = office_extractors.extract_office_documents(str(path), "konzept.docx", 1)
        assert docs and "Brandschutzkonzept" in docs[0].text

    def test_handled_but_empty_returns_empty_list(self, tmp_path):
        openpyxl = pytest.importorskip("openpyxl")
        workbook = openpyxl.Workbook()
        path = tmp_path / "leer.xlsx"
        workbook.save(path)
        assert office_extractors.extract_office_documents(str(path), "leer.xlsx", 1) == []


class TestWebpMagic:
    def test_webp_detected_by_riff_header(self, tmp_path):
        PIL = pytest.importorskip("PIL.Image")
        path = tmp_path / "plan.webp"
        PIL.new("RGB", (200, 150), "white").save(path, "WEBP")
        assert _looks_like_image(str(path)) == "webp"

    def test_riff_without_webp_payload_is_not_an_image(self, tmp_path):
        path = tmp_path / "clip.avi"
        path.write_bytes(b"RIFF\x00\x00\x00\x00AVI LIST")
        assert _looks_like_image(str(path)) is None

"""Unit tests for the spreadsheet extractor (xlsx/xlsm).

The regression these guard: without ``llama-index-readers-file`` installed,
``SimpleDirectoryReader`` reads an office file's raw zip bytes as text
(``PK\\x03…``), which the binary-content guard then rejects. Real files are
built with the same library the extractor uses, so the tests exercise the
actual parse. Word and presentation files are indexed from their PDF rendition
(ADR-0071); the pptx notes companion is tested in ``test_rendition_extraction``.
"""

import pytest
from knowledge_layer.llamaindex import office_extractors
from knowledge_layer.llamaindex.adapter import _looks_like_image


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

    def test_a_long_sheet_is_row_groups_that_each_repeat_the_header(self, tmp_path):
        """The old cap indexed the first 1000 rows as ONE Document, which the splitter cut
        into header-less runs of numbers; every group now names its columns and rows."""
        openpyxl = pytest.importorskip("openpyxl")
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        sheet.title = "Türliste"
        sheet.append(["Tür", "Brandschutzklasse", "Geschoß"])
        for i in range(1500):
            sheet.append([f"T{i:04d}", "EI2 30-C", "EG"])
        path = tmp_path / "tueren.xlsx"
        workbook.save(path)

        docs = office_extractors.extract_office_documents(str(path), "tueren.xlsx", 1)

        assert len(docs) > 1
        assert all("| Tür | Brandschutzklasse | Geschoß |" in doc.text for doc in docs)
        assert all(doc.metadata["page_label"] == "Türliste" for doc in docs)
        assert docs[0].metadata["punkt_id"].startswith("Türliste: Zeilen 2-")
        assert docs[-1].metadata["punkt_id"].endswith("-1501")
        assert docs[0].text.startswith("Tabellenblatt „Türliste“, Zeilen 2-")
        body = "".join(doc.text for doc in docs)
        assert "| T1499 |" in body, "rows past the old 1000-row cap were dropped"
        assert office_extractors.rows_over_cap(docs) == 0
        assert "table_part" in docs[0].excluded_embed_metadata_keys

    def test_the_row_cap_is_stated_and_counted(self, tmp_path, monkeypatch):
        openpyxl = pytest.importorskip("openpyxl")
        monkeypatch.setattr(office_extractors, "MAX_TABLE_ROWS", 20)
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        for i in range(70):
            sheet.append([f"Zeile {i}", i])
        path = tmp_path / "lang.xlsx"
        workbook.save(path)

        docs = office_extractors.extract_office_documents(str(path), "lang.xlsx", 1)

        assert "Tabelle gekürzt: 50 weitere Zeilen" in docs[-1].text
        assert office_extractors.rows_over_cap(docs) == 50
        body = "".join(doc.text for doc in docs)
        assert "| Zeile 19 |" in body and "| Zeile 20 |" not in body


class TestRouting:
    def test_unhandled_extension_returns_none(self, tmp_path):
        path = tmp_path / "notiz.txt"
        path.write_text("nur text")
        assert office_extractors.extract_office_documents(str(path), "notiz.txt", 1) is None

    def test_word_and_presentation_have_no_reader_of_their_own(self, tmp_path):
        """They are indexed from their PDF rendition only (ADR-0071); the
        docx2txt and slide-text readers are gone, not bypassed."""
        path = tmp_path / "konzept.docx"
        path.write_bytes(b"PK")
        assert office_extractors.extract_office_documents(str(path), "konzept.docx", 1) is None
        assert office_extractors.extract_office_documents(str(path), "vortrag.pptx", 1) is None

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

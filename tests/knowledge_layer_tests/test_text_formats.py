"""Markdown, text and CSV files with locators and lossless decoding (``llamaindex/text_formats``).

These went through ``SimpleDirectoryReader``: one Document per file with no locator (the
file was citable only as a whole, and ``read_passage`` could not open any part of it),
read as UTF-8 with ``errors="ignore"`` -- a cp1252 CSV exported from Excel lost every
umlaut and ß without a trace.
"""

from __future__ import annotations

import pytest
from knowledge_layer.llamaindex.text_formats import decode_text
from knowledge_layer.llamaindex.text_formats import extract_text_format_documents

DIGEST = """# BIM-Modell: Wohnanlage Musterstraße

Exportiert aus dem IFC-Modell.

## Modellangaben

- Schema: IFC4
- Geschoße: 4

## Geschoße

### EG

Nettofläche 412 m².

### 1. OG

Nettofläche 398 m².

```
# kein Heading: Code
```

## Materialien

Stahlbeton C25/30.
"""


def _write(tmp_path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


class TestDecoding:
    @pytest.mark.parametrize(
        ("data", "encoding"),
        [
            ("Geschoßfläche".encode("utf-8-sig"), "utf-8-sig"),
            ("Geschoßfläche".encode(), "utf-8"),
            ("Geschoßfläche – „Wand“ €".encode("cp1252"), "cp1252"),
            ("Geschoßfläche".encode("utf-16"), "utf-16"),
        ],
    )
    def test_each_encoding_is_read_whole(self, data, encoding):
        text, used = decode_text(data)
        assert used == encoding
        assert text.lstrip("\ufeff").startswith("Geschoßfläche")

    def test_bytes_no_codepage_defines_fall_back_to_latin1_not_to_nothing(self):
        # 0x81 is undefined in cp1252 and invalid UTF-8.
        text, used = decode_text(b"Wand \x81 Decke")
        assert used == "latin-1"
        assert text == "Wand \x81 Decke"


class TestMarkdown:
    def test_one_section_per_heading_addressed_by_its_path(self, tmp_path):
        docs = extract_text_format_documents(_write(tmp_path, "digest.md", DIGEST.encode()), "digest.md", 1)
        ids = [doc.metadata.get("punkt_id") for doc in docs]
        # The lone "#" heading is the document's title: its own text is addressed by it,
        # and the chapters are addressed below it.
        assert ids == [
            "BIM-Modell: Wohnanlage Musterstraße",
            "Modellangaben",
            "Geschoße",
            "Geschoße › EG",
            "Geschoße › 1. OG",
            "Materialien",
        ]
        assert "punkt_depth" not in docs[0].metadata

    def test_chunks_carry_the_breadcrumb_and_no_page(self, tmp_path):
        docs = extract_text_format_documents(_write(tmp_path, "digest.md", DIGEST.encode()), "digest.md", 1)
        eg = next(doc for doc in docs if doc.metadata.get("punkt_id") == "Geschoße › EG")
        assert eg.text == "BIM-Modell: Wohnanlage Musterstraße › Geschoße › EG\n\nNettofläche 412 m²."
        assert "page_label" not in eg.metadata
        assert eg.metadata["punkt_depth"] == 2
        assert eg.metadata["line_start"] > 1

    def test_a_heading_inside_a_code_fence_is_code(self, tmp_path):
        docs = extract_text_format_documents(_write(tmp_path, "digest.md", DIGEST.encode()), "digest.md", 1)
        assert not any("kein Heading" in (doc.metadata.get("punkt_id") or "") for doc in docs)
        assert any("# kein Heading" in doc.text for doc in docs)

    def test_a_heading_whose_content_is_in_subsections_still_has_its_chunk(self, tmp_path):
        """It is what gives the Gliederung its chapter line."""
        docs = extract_text_format_documents(_write(tmp_path, "digest.md", DIGEST.encode()), "digest.md", 1)
        geschosse = [doc for doc in docs if doc.metadata.get("punkt_id") == "Geschoße"]
        assert [doc.text for doc in geschosse] == ["BIM-Modell: Wohnanlage Musterstraße › Geschoße"]
        assert geschosse[0].metadata["punkt_depth"] == 1

    def test_section_order_is_document_order(self, tmp_path):
        docs = extract_text_format_documents(_write(tmp_path, "digest.md", DIGEST.encode()), "digest.md", 1)
        orders = [doc.metadata["section_order"] for doc in docs]
        assert orders == sorted(orders)


class TestText:
    def test_paragraph_blocks_with_line_ranges(self, tmp_path):
        paragraphs = [f"Absatz {n}: " + "Die Decke ist in REI 90 auszuführen. " * 30 for n in range(1, 7)]
        data = "\n\n".join(paragraphs).encode("cp1252")
        docs = extract_text_format_documents(_write(tmp_path, "notiz.txt", data), "notiz.txt", 1)
        assert len(docs) > 1
        assert docs[0].metadata["punkt_id"].startswith("Zeile")
        assert docs[0].metadata["line_start"] == 1
        assert docs[-1].metadata["line_end"] == 11
        assert all("auszuführen" in doc.text for doc in docs)
        assert docs[0].metadata["source_encoding"] == "cp1252"
        assert "source_encoding" in docs[0].excluded_embed_metadata_keys

    def test_a_chunk_never_starts_mid_paragraph(self, tmp_path):
        paragraphs = [f"Absatz {n}.\n" + "Zeile mit Inhalt über Brandschutz.\n" * 20 for n in range(1, 6)]
        data = "\n".join(paragraphs).encode()
        docs = extract_text_format_documents(_write(tmp_path, "notiz.txt", data), "notiz.txt", 1)
        assert all(doc.text.startswith("Absatz") for doc in docs)


class TestCsv:
    def test_cp1252_semicolon_csv_keeps_umlauts_and_repeats_the_header(self, tmp_path):
        rows = ["Raum;Fläche;Nutzung"] + [f"Büro {n};{n},5 m²;Besprechung für Größere Gruppen" for n in range(200)]
        data = "\r\n".join(rows).encode("cp1252")
        docs = extract_text_format_documents(_write(tmp_path, "räume.csv", data), "räume.csv", 1)
        assert len(docs) > 1
        assert all("| Raum | Fläche | Nutzung |" in doc.text for doc in docs)
        assert "| Büro 0 | 0,5 m² | Besprechung für Größere Gruppen |" in docs[0].text
        assert docs[0].metadata["punkt_id"].startswith("Zeilen 2-")
        assert docs[-1].metadata["punkt_id"].endswith("-201")
        assert docs[0].text.startswith(f"räume.csv, {docs[0].metadata['punkt_id']} (Teil 1 von {len(docs)})")

    def test_row_ranges_tile_the_file(self, tmp_path):
        rows = ["a,b"] + [f"{n},x" for n in range(300)]
        docs = extract_text_format_documents(_write(tmp_path, "t.csv", "\n".join(rows).encode()), "t.csv", 1)
        ranges = [(doc.metadata["line_start"], doc.metadata["line_end"]) for doc in docs]
        assert ranges[0][0] == 2 and ranges[-1][1] == 301
        assert all(later[0] == earlier[1] + 1 for earlier, later in zip(ranges, ranges[1:], strict=False))

    def test_a_quoted_newline_keeps_line_numbers_true(self, tmp_path):
        data = b'Raum,Notiz\nA,"zwei\nZeilen"\nB,eins\n'
        docs = extract_text_format_documents(_write(tmp_path, "t.csv", data), "t.csv", 1)
        assert docs[0].metadata["punkt_id"] == "Zeilen 2-4"


class TestRouting:
    def test_other_extensions_are_not_ours(self, tmp_path):
        assert extract_text_format_documents(_write(tmp_path, "x.json", b"{}"), "x.json", 1) is None

    def test_the_original_name_decides_over_the_temp_path(self, tmp_path):
        path = _write(tmp_path, "tmpabc123", b"# Titel\n\n## Teil\n\nText.")
        docs = extract_text_format_documents(path, "notiz.md", 1)
        assert [doc.metadata.get("punkt_id") for doc in docs] == ["Teil"]


# =============================================================================
# Through the ingest job: the reader the job uses, and what the file result says.
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
    from unittest.mock import MagicMock

    from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

    ing = LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma"), "generate_summary": False})
    ing._embed_model = MagicMock()
    ing._initialized = True
    monkeypatch.setattr("llama_index.core.VectorStoreIndex", MagicMock())
    monkeypatch.setattr("llama_index.core.Settings", MagicMock())
    return ing


def _run(ing, path: str, name: str):
    import time

    job_id = ing.submit_job([path], "proj_1", config={"original_filenames": [name]})
    deadline = time.time() + 30
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def _indexed():
    import llama_index.core

    return [doc for call in llama_index.core.VectorStoreIndex.from_documents.call_args_list for doc in call.args[0]]


class TestThroughTheIngestJob:
    def test_a_cp1252_csv_is_indexed_with_its_umlauts_and_row_locators(self, tmp_path, ingestor, summary_db):
        data = "Raum;Fläche\r\nBüro;24,5 m²\r\nGroßraum;80 m²\r\n".encode("cp1252")
        status = _run(ingestor, _write(tmp_path, "tmp_upload", data), "Räume.csv")

        assert status.file_details[0].status == "success", status.file_details[0].error_message
        docs = _indexed()
        assert [doc.metadata["punkt_id"] for doc in docs] == ["Zeilen 2-3"]
        assert "| Großraum | 80 m² |" in docs[0].text
        assert docs[0].metadata["source_encoding"] == "cp1252"

    def test_rows_the_sheet_cap_left_out_are_counted_on_the_file_result(
        self, tmp_path, ingestor, summary_db, monkeypatch
    ):
        openpyxl = pytest.importorskip("openpyxl")
        from knowledge_layer.llamaindex import office_extractors

        monkeypatch.setattr(office_extractors, "MAX_TABLE_ROWS", 10)
        workbook = openpyxl.Workbook()
        for n in range(25):
            workbook.active.append([f"Pos {n}", n])
        path = tmp_path / "tmp_sheet.xlsx"
        workbook.save(path)

        status = _run(ingestor, str(path), "Kosten.xlsx")

        assert status.file_details[0].status == "success", status.file_details[0].error_message
        assert status.file_details[0].metadata["rows_over_cap"] == 15

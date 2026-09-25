"""Captioned tables are indexed as tables, not as text read across their columns.

OIB-Richtlinie 2's Tabelle 3 reached the agent as „an der obersten an der
obersten an der obersten Stelle …" and cost the September 2026 census three
research rounds. These pin the pure half: fragments joined across pages, the
header repeated in every chunk, a two-row header merged so each column still
names what it holds, and the per-page path keeping a table rather than losing it.
"""

from __future__ import annotations

from types import SimpleNamespace

from knowledge_layer.llamaindex.captioned_tables import PageTable
from knowledge_layer.llamaindex.captioned_tables import join_fragments
from knowledge_layer.llamaindex.captioned_tables import markdown_chunks
from knowledge_layer.llamaindex.captioned_tables import page_text_with_tables
from knowledge_layer.llamaindex.punkt_chunking import punkt_documents

HEADER = ["Gegenstand", "GK 3", "GK 4", "GK 5"]
ROWS = [
    ["1.1 in oberirdischen Geschoßen", "REI 60", "REI 60", "REI 90 und A2"],
    ["2 Decke über dem Treppenhaus", "REI 60", "REI 60", "REI 90 und A2"],
]


def _table(rows=None, **kw) -> PageTable:
    return PageTable("3", "Anforderungen an Treppenhäuser", [HEADER, *(rows or ROWS)], kw.pop("page", 30), **kw)


def test_a_table_reads_as_rows_under_its_columns():
    [chunk] = markdown_chunks(join_fragments([_table()])[0])
    assert chunk.splitlines()[0] == "| Gegenstand | GK 3 | GK 4 | GK 5 |"
    assert "| 1.1 in oberirdischen Geschoßen | REI 60 | REI 60 | REI 90 und A2 |" in chunk


def test_every_chunk_of_a_long_table_carries_the_header():
    rows = [[f"{n} Bauteil mit einer längeren Bezeichnung", "REI 60", "REI 60", "REI 90"] for n in range(60)]
    chunks = markdown_chunks(join_fragments([_table(rows)])[0], max_chars=800)
    assert len(chunks) > 2
    assert all(chunk.startswith("| Gegenstand | GK 3 | GK 4 | GK 5 |") for chunk in chunks)
    assert all(len(chunk) <= 800 for chunk in chunks)


def test_a_continuation_joins_its_table_and_drops_the_repeated_header():
    first = _table()
    second = PageTable("3", first.title, [HEADER, ["4.1 in Treppenhäusern", "R 60", "R 60", "R 90"]], 31, True)
    [table] = join_fragments([first, second])
    assert (table.page_start, table.page_end) == (30, 31)
    assert [row[0] for row in table.rows] == ["Gegenstand", *[row[0] for row in ROWS], "4.1 in Treppenhäusern"]


def test_a_two_row_header_names_every_column():
    rows = [
        ["Gebäudeklassen", "GK 4", "GK 5", ""],
        ["", "", "≤ 6 Geschoße", "> 6 Geschoße"],
        ["1.5 Gebäudetrennfugenmaterial", "A2", "A2", "A2"],
    ]
    table = join_fragments([PageTable("1a", "Brandverhalten", rows, 24)])[0]
    head = markdown_chunks(table)[0].splitlines()[0]
    assert head == "| Gebäudeklassen | GK 4 | GK 5 ≤ 6 Geschoße | GK 5 > 6 Geschoße |"


def test_the_per_page_path_keeps_the_table():
    text = page_text_with_tables("Fließtext der Seite.", [_table()])
    assert text.startswith("Fließtext der Seite.")
    assert "Tabelle 3: Anforderungen an Treppenhäuser" in text
    assert "| 2 Decke über dem Treppenhaus | REI 60 | REI 60 | REI 90 und A2 |" in text


def test_a_richtlinie_indexes_its_table_as_an_addressable_passage():
    body = "\n".join(f"{n} Punkt Nummer {n}\nText zu Punkt {n}, lang genug um zu zählen." for n in range(1, 8))
    pages = [
        {"page_number": 1, "text": "OIB-Richtlinie 9 Ausgabe Mai 2023\n" + body},
        {"page_number": 2, "text": "Tabelle 3: Anforderungen", "tables": [_table(page=2)]},
    ]
    documents = punkt_documents(pages, "oib-rl_9_ausgabe_mai_2023.pdf", 1)
    [table] = [d for d in documents if d.metadata.get("chunking") == "table"]
    assert table.metadata["punkt_id"] == "Tabelle 3"
    assert table.metadata["content_type"] == "table"
    assert "punkt_depth" not in table.metadata
    assert "Tabelle 3: Anforderungen an Treppenhäuser" in table.text


class _FakeTable:
    def __init__(self, rows, top):
        self._rows = rows
        self.bbox = (0, top, 500, top + 100)

    def extract(self):
        return self._rows


class _FakeRegion:
    def __init__(self, text):
        self._text = text

    def extract_text(self):
        return self._text


class _FakePage:
    """A pdfplumber page: its tables, and the caption text standing above them (if any)."""

    width = 600

    def __init__(self, tables=(), caption=""):
        self._tables = list(tables)
        self._caption = caption

    def find_tables(self):
        return self._tables

    def within_bbox(self, bbox):
        return _FakeRegion(self._caption)

    def filter(self, predicate):
        return self

    def extract_text(self):
        return "Fließtext."


def test_a_captionless_box_pages_later_does_not_continue_an_old_table(monkeypatch):
    """Tabelle 3 on p.3, nothing on p.4, a caption-less ruled box at the top of
    p.9: the box used to be appended to Tabelle 3 because the last table was
    remembered across every page after it."""
    import pdfplumber
    from knowledge_layer.llamaindex.adapter import _extract_text_from_pdf

    box = _FakeTable([["Formular", "Feld"], ["Name", "—"]], top=60)
    pages = [
        _FakePage(),
        _FakePage(),
        _FakePage([_FakeTable([HEADER, *ROWS], top=300)], caption="Tabelle 3: Anforderungen an Treppenhäuser"),
        _FakePage(),
        *[_FakePage() for _ in range(4)],
        _FakePage([box]),
    ]
    pdf = SimpleNamespace(pages=pages)

    class _Open:
        def __enter__(self):
            return pdf

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(pdfplumber, "open", lambda path: _Open())

    extracted = _extract_text_from_pdf("x.pdf")

    tables = [(page["page_number"], table.table_id) for page in extracted for table in page["tables"]]
    assert tables == [(3, "3")]


def test_only_the_next_page_can_continue_a_table():
    from knowledge_layer.llamaindex.captioned_tables import extract_page_tables

    previous = _table(page=3)
    page = _FakePage(
        [_FakeTable([["4.1 in Treppenhäusern", "R 60", "R 60", "R 90"], ["4.2", "R 30", "R 30", "R 60"]], 60)]
    )

    assert extract_page_tables(page, 9, previous) == []
    [(fragment, _bbox)] = extract_page_tables(page, 4, previous)
    assert fragment.continuation and fragment.table_id == "3"


def test_a_continuation_on_its_own_page_keeps_its_first_row_as_data():
    """The per-page path renders a continuation without its table; its first
    row is a requirement, not the column labels."""
    first_row = ["4.1 in Treppenhäusern", "R 60", "R 60", "R 90"]
    fragment = PageTable("3", "Anforderungen", [first_row, ["4.2 Wände", "R 30", "R 30", "R 60"]], 31, True)

    text = page_text_with_tables("", [fragment])

    lines = text.splitlines()
    assert lines[0] == "|  |  |  |  |"
    assert "| 4.1 in Treppenhäusern | R 60 | R 60 | R 90 |" in lines[2:]


def test_a_captioned_table_is_cited_by_its_page_not_as_table_1():
    """Every captioned table carried no ``table_index`` and was cited
    „<file>, p.N, Table 1", whichever table it was, under a key no other hit
    on that page renders."""
    from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
    from llama_index.core.schema import NodeWithScore
    from llama_index.core.schema import TextNode

    node = TextNode(
        text="| a | b |",
        metadata={"file_name": "oib-rl_2.pdf", "page_label": "30", "content_type": "table", "punkt_id": "Tabelle 3"},
    )
    retriever = LlamaIndexRetriever(config={"persist_dir": "/tmp/unused"})

    chunk = retriever.normalize(NodeWithScore(node=node, score=0.5))

    assert chunk.display_citation == "oib-rl_2.pdf, p.30"

"""Captioned tables are indexed as tables, not as text read across their columns.

OIB-Richtlinie 2's Tabelle 3 reached the agent as „an der obersten an der
obersten an der obersten Stelle …" and cost the September 2026 census three
research rounds. These pin the pure half: fragments joined across pages, the
header repeated in every chunk, a two-row header merged so each column still
names what it holds, and the per-page path keeping a table rather than losing it.
"""

from __future__ import annotations

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

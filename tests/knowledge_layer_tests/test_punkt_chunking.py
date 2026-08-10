"""Tests for Punkt-aware chunking of the OIB corpus.

The corpus is 1360-odd numbered requirements at a median of 62 tokens, but ingestion
cut it into 1024-token blocks over per-page Documents: 57% of pages began mid-Punkt,
92% of chunks did not start on a numbered line, and overlap never crossed a page
boundary because each page was its own Document. A chunk therefore blended roughly
fifteen unrelated requirements, and no citation could be more precise than a page.

What this file pins is mostly the *guards*, because the failure mode of a
structure-aware chunker is not crashing -- it is confidently mis-cutting. The corpus
lays tables out with a numbered row label in the first column (``1.1 Außenwand…``),
textually indistinguishable from a heading, and wraps requirements onto lines that
begin with a bare measurement (``30 cm und einer Höhe von…``). Either one, accepted,
silently truncates the rest of the document.

All offline: no PDFs, no ChromaDB, no embeddings, no network.
"""

from __future__ import annotations

from knowledge_layer.llamaindex.punkt_chunking import punkt_documents


def _pages(*texts: str) -> list[dict]:
    return [{"page_number": index, "text": text} for index, text in enumerate(texts, start=1)]


COVER = "OIB-Richtlinie 2\nBrandschutz\n"

BODY = (
    "1 Begriffsbestimmungen gelten sinngemaess fuer diese Richtlinie.\n"
    "2 Allgemeine Anforderungen an das Brandverhalten von Bauprodukten.\n"
    "2.1 Bauprodukte muessen den Anforderungen der Tabelle 1a entsprechen.\n"
    "2.2 Die Bauteile muessen den erforderlichen Anforderungen genuegen.\n"
)

MORE = (
    "2.3 Oeffnungen in brandabschnittsbildenden Bauteilen sind zulaessig.\n"
    "3 Flucht- und Rettungswege muessen ins Freie fuehren.\n"
    "3.1 Die nutzbare Breite von Fluchtwegen muss mindestens 1,20 m betragen.\n"
)


def _punkte(docs: list) -> dict[str, object]:
    return {doc.metadata["punkt_id"]: doc for doc in docs if doc.metadata.get("chunking") == "punkt"}


def test_each_numbered_requirement_becomes_its_own_document() -> None:
    docs = punkt_documents(_pages(COVER, BODY, MORE), "oib-rl_2_ausgabe_mai_2023.pdf", 1234)
    assert docs is not None
    assert sorted(_punkte(docs)) == ["1", "2", "2.1", "2.2", "2.3", "3", "3.1"]


def test_a_table_row_label_is_rejected_by_outline_succession() -> None:
    """``1.1 Außenwand…`` inside a table reads exactly like a heading.

    Comparing ids rejects it without any table geometry, because a document's
    numbering only moves forward while a table restarts at 1.
    """
    table = "1.1 Aussenwand-Waermedaemmverbundsysteme E D D C-d1 C-d1\n"
    docs = punkt_documents(_pages(COVER, BODY, table + MORE), "oib-rl_2_ausgabe_mai_2023.pdf", 1234)
    assert docs is not None
    assert "1.1" not in _punkte(docs)


def test_a_wrapped_measurement_line_does_not_park_the_cursor_at_thirty() -> None:
    """``30 cm und einer Hoehe…`` parses as the id (30,), which plain `>` accepts.

    Accepting it strands every later Punkt behind a cursor at 30 -- measured on the
    real file, 37 Punkte survived instead of 227.
    """
    wrapped = "30 cm und einer Hoehe von 20 cm ausgefuehrt werden.\n"
    docs = punkt_documents(_pages(COVER, BODY, wrapped + MORE), "oib-rl_2_ausgabe_mai_2023.pdf", 1234)
    assert docs is not None
    punkte = _punkte(docs)
    assert "30" not in punkte
    assert "3.1" in punkte, "the Punkte after the wrapped line must survive"


def test_a_requirement_split_across_a_page_break_is_joined() -> None:
    """The page stream is joined before it is split; that is the whole point.

    Overlap never crossed a page boundary, so a requirement broken by one was severed
    with no chunk containing it whole.
    """
    head = "2.2 Die Bauteile muessen den erforderlichen\n"
    tail = "Anforderungen der Tabelle 1b genuegen.\n"
    docs = punkt_documents(
        _pages(
            COVER,
            BODY.replace("2.2 Die Bauteile muessen den erforderlichen Anforderungen genuegen.\n", head),
            tail + MORE,
        ),
        "oib-rl_2.pdf",
        1,
    )
    assert docs is not None
    doc = _punkte(docs)["2.2"]
    assert "Tabelle 1b" in doc.get_content()
    assert doc.metadata["page_label"] == "2", "citation anchors on the page the Punkt starts"
    assert doc.metadata["page_end"] == "3"


def test_a_line_break_hyphen_is_healed() -> None:
    """pdfplumber keeps the PDF's line-break hyphens, producing forms no query contains."""
    hyphenated = "2.2 Die Bauteile muessen unterstuet-\nzenden Anforderungen genuegen.\n"
    body = BODY.replace("2.2 Die Bauteile muessen den erforderlichen Anforderungen genuegen.\n", hyphenated)
    docs = punkt_documents(_pages(COVER, body, MORE), "oib-rl_2.pdf", 1)
    assert docs is not None
    assert "unterstuetzenden" in _punkte(docs)["2.2"].get_content()


def test_each_document_carries_its_place_in_the_outline() -> None:
    docs = punkt_documents(_pages(COVER, BODY, MORE), "oib-rl_2_ausgabe_mai_2023.pdf", 1234)
    assert docs is not None
    child = _punkte(docs)["2.1"]
    assert child.metadata["punkt_parent_id"] == "2"
    assert child.metadata["punkt_depth"] == 2
    assert child.metadata["richtlinie"] == "2"
    # The breadcrumb is what gives an isolated requirement its subject back.
    assert "Brandverhalten" in child.get_content()


def test_text_before_the_first_requirement_is_kept_as_a_page_document() -> None:
    """A cover page and the Vorbemerkungen are content, not noise to be dropped."""
    docs = punkt_documents(_pages(COVER, BODY, MORE), "oib-rl_2.pdf", 1)
    assert docs is not None
    assert any(doc.metadata.get("chunking") == "page" for doc in docs)


def test_a_document_without_usable_numbering_falls_back_to_none() -> None:
    """Begriffsbestimmungen and the zitierte-Normen list have no outline.

    Returning None keeps today's per-page behaviour for them and for every non-OIB
    upload, rather than emitting one enormous mis-cut Document.
    """
    prose = "Ein Absatz ohne jede Nummerierung.\nNoch ein Absatz.\n"
    assert punkt_documents(_pages(prose, prose), "glossar.pdf", 1) is None


def test_a_document_whose_numbering_covers_too_little_falls_back() -> None:
    sparse = "1 Eine einzige Ueberschrift.\n" + ("Sehr viel unnummerierter Fliesstext. " * 80) + "\n"
    assert punkt_documents(_pages(sparse), "sparse.pdf", 1) is None


def test_bookkeeping_metadata_is_not_embedded() -> None:
    """`page_end`, `punkt_depth` and `chunking` exist for filtering, not for the vector."""
    docs = punkt_documents(_pages(COVER, BODY, MORE), "oib-rl_2.pdf", 1)
    assert docs is not None
    excluded = set(docs[-1].excluded_embed_metadata_keys or [])
    assert {"page_end", "punkt_depth", "chunking", "file_size"} <= excluded
    assert "punkt_id" not in excluded, "the Punkt number is exactly what a user cites"


def test_an_empty_document_does_not_raise() -> None:
    assert punkt_documents([], "empty.pdf", 0) is None
    assert punkt_documents(_pages("", ""), "empty.pdf", 0) is None


# ===========================================================================
# Choosing between two readings of the same numbering
#
# A table's first column and a document's outline are the same characters, so
# the guards above cannot separate them line by line. What separates them is
# that the outline resumes after the table and the table does not -- which is
# only visible if the whole document is considered at once.
# ===========================================================================

OUTLINE = (
    "0 Vorbemerkungen zu dieser Richtlinie sind zu beachten.\n"
    "1 Allgemeine Bestimmungen gelten fuer alle Gebaeude.\n"
    "2 Begriffsbestimmungen sind der Richtlinie zu entnehmen.\n"
    "3 Gebaeudekategorien werden wie folgt unterschieden.\n"
    "4 Anforderungen an das Gebaeude sind einzuhalten.\n"
    "4.1 Allgemeines zur Nachweisfuehrung des Gebaeudes.\n"
)

#: A U-value table whose row labels continue the outline's own numbering by coincidence.
UWERT_TABLE = (
    "5 WAENDE (Trennwaende) zwischen Wohneinheiten 0,90\n"
    "6 WAENDE gegen andere Bauwerke 0,50\n"
    "7 WAENDE (Zwischenwaende) innerhalb von Einheiten 0,70\n"
)

OUTLINE_TAIL = (
    "4.2 Niedrigstenergiegebaeude sind nachzuweisen.\n"
    "4.3 Anforderungen an Energiekennzahlen bei Neubau.\n"
    "5 Wahl der eingesetzten Energietraeger ist zu begruenden.\n"
    "5.1 Einsatz hocheffizienter alternativer Energiesysteme.\n"
    "6 Ausweis ueber die Gesamtenergieeffizienz ist auszustellen.\n"
)


def test_a_table_whose_rows_continue_the_outline_does_not_swallow_the_rest() -> None:
    """The defect this replaced a greedy scan to fix, in miniature.

    ``5 WAENDE …`` is a legal sibling of Punkt ``4`` and reads as one, so a scan that
    commits to it parks the cursor at 7 and rejects every genuine Punkt that follows.
    On the real OIB-Richtlinie 6 that cost 41 of 64 Punkte and left a Document spanning
    twenty pages. Choosing the chain over the whole document instead costs the table
    nothing to reject, because the outline resumes afterwards and the table does not.
    """
    docs = punkt_documents(_pages(COVER, OUTLINE, UWERT_TABLE + OUTLINE_TAIL), "oib-rl_6.pdf", 1)
    assert docs is not None
    punkte = _punkte(docs)
    assert "7" not in punkte, "a table row is not a Punkt"
    assert sorted(punkte) == ["0", "1", "2", "3", "4", "4.1", "4.2", "4.3", "5", "5.1", "6"]
    assert "Energietraeger" in punkte["5"].get_content(), "Punkt 5 is the outline's, not the table's"


def test_the_contents_page_settles_which_line_is_the_heading_it_names() -> None:
    """Two lines can carry the same number, and only one is the Punkt.

    OIB-Richtlinie 2's annex has a row labelled ``10 Außentreppen`` while its contents
    page promises ``10 Gebäude mit einem Fluchtniveau von mehr als 22 m``. Counting
    headings cannot choose -- both readings are the same length -- so the emitted Punkt
    10 was the table row: a chunk filed under a real citation whose text belongs to
    something else.
    """
    toc = (
        "0 Vorbemerkungen ......... 1\n"
        "1 Allgemeine Bestimmungen ......... 1\n"
        "2 Begriffsbestimmungen ......... 2\n"
        "3 Gebaeudekategorien ......... 2\n"
        "4 Anforderungen an das Gebaeude ......... 3\n"
        "5 Wahl der eingesetzten Energietraeger ......... 4\n"
        "6 Ausweis ueber die Gesamtenergieeffizienz ......... 5\n"
    )
    docs = punkt_documents(_pages(COVER, toc, OUTLINE, UWERT_TABLE + OUTLINE_TAIL), "oib-rl_6.pdf", 1)
    assert docs is not None
    punkte = _punkte(docs)
    assert "Energietraeger" in punkte["5"].get_content()
    assert "WAENDE" not in punkte["5"].get_content()


def test_a_contents_page_that_names_only_the_top_level_still_keeps_the_rest() -> None:
    """Preferring what the contents page lists must never become requiring it.

    OIB-Richtlinie 2's contents page names thirteen Punkte and the document has 214.
    A rule that dropped the other 201 would be far worse than the table rows it removed.
    """
    toc = (
        "0 Vorbemerkungen ......... 1\n"
        "1 Allgemeine Bestimmungen ......... 1\n"
        "2 Begriffsbestimmungen ......... 2\n"
        "3 Gebaeudekategorien ......... 2\n"
        "4 Anforderungen an das Gebaeude ......... 3\n"
    )
    docs = punkt_documents(_pages(COVER, toc, OUTLINE, OUTLINE_TAIL), "oib-rl_6.pdf", 1)
    assert docs is not None
    punkte = _punkte(docs)
    assert "4.1" in punkte and "5.1" in punkte, "unlisted Punkte are kept, not filtered out"


def test_an_abbreviation_legend_is_not_a_contents_page() -> None:
    """Dot leaders also separate a term from its definition, and lead to no page.

    Page 11 of `oib-rl_6-leitfaden` is such a legend. Read as a contents page it was
    dropped from the body entirely, taking Punkte 4.3.1 and 4.3.2 with it.
    """
    legend = (
        "KD ...... Kellerdecke\n"
        "OD ..... Oberste Geschossdecke\n"
        "AW ..... Aussenwand\n"
        "DF ...... Dachflaeche aus Beton\n"
        "4.2 Niedrigstenergiegebaeude sind nachzuweisen.\n"
    )
    docs = punkt_documents(
        _pages(COVER, OUTLINE, legend, OUTLINE_TAIL[len("4.2 Niedrigstenergiegebaeude sind nachzuweisen.\n") :]),
        "oib-rl_6.pdf",
        1,
    )
    assert docs is not None
    assert "4.2" in _punkte(docs), "the legend page is body text and keeps its Punkte"


def test_a_heading_the_corpus_opens_in_lowercase_is_still_a_heading() -> None:
    """OIB-Richtlinie 6 numbers two Punkte "kein ENERGIEAUSWEIS erforderlich …".

    Rejecting a lowercase opening as wrapped prose is a rule the corpus breaks, and
    breaking it merged both requirements into the Punkt above them.
    """
    body = OUTLINE + "4.1.1 kein ENERGIEAUSWEIS erforderlich / keine ANFORDERUNGEN\n"
    docs = punkt_documents(_pages(COVER, body, OUTLINE_TAIL), "oib-rl_6.pdf", 1)
    assert docs is not None
    punkte = _punkte(docs)
    assert "4.1.1" in punkte
    assert "ENERGIEAUSWEIS" in punkte["4.1.1"].get_content()
    assert "ENERGIEAUSWEIS" not in punkte["4.1"].get_content(), "it was merged into the Punkt above"


# ===========================================================================
# The ingestion seam
#
# The chunker is only worth anything if ingestion actually reaches for it, and
# only safe if every document it cannot parse keeps the old behaviour exactly.
# ===========================================================================


def test_ingestion_cuts_a_numbered_document_on_its_outline() -> None:
    from knowledge_layer.llamaindex.adapter import text_documents_for_pages

    docs = text_documents_for_pages(_pages(COVER, BODY, MORE), "oib-rl_2_ausgabe_mai_2023.pdf", 1234)
    assert {doc.metadata.get("chunking") for doc in docs} == {"punkt", "page"}
    assert any(doc.metadata.get("punkt_id") == "2.1" for doc in docs)


def test_ingestion_falls_back_to_one_document_per_page_for_everything_else() -> None:
    """A tenant upload or a glossary must ingest exactly as it did before.

    The fallback is the whole reason the chunker may be enabled by default: it can
    only ever improve a document whose structure it recognises.
    """
    from knowledge_layer.llamaindex.adapter import text_documents_for_pages

    prose = _pages("Ein Angebot ohne Nummerierung.", "Noch eine Seite Fliesstext.")
    docs = text_documents_for_pages(prose, "angebot.pdf", 99)
    assert len(docs) == 2
    assert [doc.metadata["page_label"] for doc in docs] == ["1", "2"]
    assert all(doc.metadata["content_type"] == "text" for doc in docs)
    assert all("punkt_id" not in doc.metadata for doc in docs)


def test_the_chunker_works_under_the_deployed_import_path() -> None:
    """The backend runs with PYTHONPATH=src; pytest also puts the repo root on sys.path.

    That difference hid a ModuleNotFoundError: the chunker reached the adapter by its
    source-tree spelling, which resolves under pytest and not in production, so
    ingestion would have raised on every OIB PDF with the whole suite green. This
    asserts the installed-package path is importable in isolation.
    """
    import subprocess
    import sys

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from knowledge_layer.llamaindex.punkt_chunking import punkt_documents;"
            "from knowledge_layer.llamaindex.adapter import _apply_metadata_exclusions;"
            "print('ok')",
        ],
        capture_output=True,
        check=False,
        text=True,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": "src"},
        cwd=str(__import__("pathlib").Path(__file__).resolve().parents[2]),
    )
    assert result.returncode == 0, result.stderr

"""Outline mode: ``read_passage(document=…)`` with neither Punkt nor page.

An overview question — "Was weißt du über die OIB 2?", "worum geht es im
Brandschutzkonzept?" — names a document and nothing else. There is no Punkt and
no page to pass, so the locator used to refuse and send the model to
``knowledge_search``, which returns cover pages; the model then GUESSED a Punkt
("Anwendungsbereich", which OIB 2 does not have), was refused again, and
searched again.

These tests pin the primitive that answers that question deterministically: one
filtered fetch for the document's top two heading levels, the scope passage
rendered as an ordinary grounding block so a citation resolves to it, and a
``## Gliederung`` index of the Punkte the model may open next — an index, never
evidence.
"""

from __future__ import annotations

import importlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.register import KnowledgeRetrievalConfig

from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.grounding_block import get_grounding_block
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.scoping import ScopedCollection

# NOTE: `knowledge_layer.read_passage` as an ATTRIBUTE is the registered NAT
# function (see `knowledge_layer/__init__.py`); the module holding the helpers
# is reached through the import system instead.
rp = importlib.import_module("knowledge_layer.read_passage")

OIB = "oib-rl_2_ausgabe_mai_2023.pdf"
PLAN = "Brandschutzkonzept.pdf"
SHEET = "Kostenaufstellung.xlsx"


def _document(file_name: str, display_title: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(file_name=file_name, display_title=display_title, summary=None, tags=None)


def _punkt_chunk(
    punkt: str,
    depth: int,
    title: str,
    page: int,
    *,
    content: str = "",
    chunk_id: str = "",
    file_name: str = OIB,
) -> Chunk:
    """A Punkt chunk as ``punkt_documents`` writes it: depth is an int, page a string,
    and the text opens with the Punkt's own heading line, the body after a blank line."""
    return Chunk(
        chunk_id=chunk_id or f"{file_name}:{punkt}",
        content=content or f"{punkt} {title}\n\nText zu {title}.",
        score=0.71,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=ContentType.TEXT,
        metadata={
            "chunking": "punkt",
            "punkt_id": punkt,
            "punkt_depth": depth,
            "punkt_title": title,
            "page_label": str(page),
        },
    )


def _sheet_chunk(sheet: str, content: str, *, file_name: str = SHEET) -> Chunk:
    """A worksheet of an indexed workbook, as ``office_extractors`` writes it.

    ``page_label`` carries the SHEET NAME, not a page number — the whole reason
    the fallback may not narrow on it.
    """
    return Chunk(
        chunk_id=f"{file_name}:{sheet}",
        content=content,
        score=0.71,
        file_name=file_name,
        page_number=None,
        display_citation=f"{file_name}, {sheet}",
        content_type=ContentType.TEXT,
        metadata={"chunking": "page", "page_label": sheet},
    )


def _page_chunk(page: int, content: str, *, file_name: str = PLAN) -> Chunk:
    """A chunk of a document the Punkt chunker rejected: no punkt_* metadata at all."""
    return Chunk(
        chunk_id=f"{file_name}:p{page}",
        content=content,
        score=0.71,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=ContentType.TEXT,
        metadata={"chunking": "page", "page_label": str(page)},
    )


def _is_fallback_fetch(filters: dict) -> bool:
    """The fallback fetch narrows to the file alone; the outline fetch adds the depth group."""
    return "$and" not in filters


class _Store:
    """The retriever and the document metadata store, answering per filter shape."""

    def __init__(self, documents: list[SimpleNamespace]):
        self.documents = documents
        self.calls: list[dict] = []
        self.outline_chunks: list[Chunk] = []
        self.page_chunks: list[Chunk] = []

    async def retrieve(self, query, collection_name, top_k, filters):
        self.calls.append({"query": query, "collection": collection_name, "top_k": top_k, "filters": filters})
        chunks = self.page_chunks if _is_fallback_fetch(filters) else self.outline_chunks
        return SimpleNamespace(chunks=list(chunks), success=True, error_message=None)


@pytest.fixture
def store(monkeypatch):
    handle = _Store([_document(OIB, "OIB-Richtlinie 2, Ausgabe Mai 2023"), _document(PLAN), _document(SHEET)])

    async def _documents(collection: str):
        return list(handle.documents)

    monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: handle)
    monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _documents)
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection("oib_knowledge", Shelf.BASE)],
    )
    # The formatter's three store lookups are not what these tests are about;
    # an empty map is the documented fail-open and keeps the run database-free.
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    return handle


def _builder() -> MagicMock:
    builder = MagicMock()
    builder.get_function_config = MagicMock(
        return_value=KnowledgeRetrievalConfig(collection_name="oib_knowledge", include_base_collection=True)
    )
    return builder


async def _read(**kwargs) -> str:
    async with rp.read_passage(rp.ReadPassageConfig(), _builder()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


def _gliederung(out: str) -> list[str]:
    """The Gliederung block's lines, which is the only place a heading may appear."""
    assert "## Gliederung" in out, out
    return [line for line in out.split("## Gliederung", 1)[1].splitlines() if line.strip()]


#: OIB 2's real top level, plus one split Punkt and one depth-3 child.
def _oib_outline() -> list[Chunk]:
    return [
        _punkt_chunk("0", 1, "Vorbemerkungen", 3, content="Diese Richtlinie gilt für …", chunk_id="v1"),
        _punkt_chunk("0", 1, "Vorbemerkungen", 3, content="… und ist so zu lesen.", chunk_id="v2"),
        _punkt_chunk("1", 1, "Begriffsbestimmungen", 3),
        _punkt_chunk("2", 1, "Allgemeine Anforderungen", 4),
        _punkt_chunk("2.1", 2, "Abstände", 4),
        _punkt_chunk("2.1.1", 3, "Abstand zur Nachbargrenze", 4),
        _punkt_chunk("2.9", 2, "Löschwasser", 5),
        _punkt_chunk("2.10", 2, "Blitzschutz", 5),
    ]


class TestThePunktOutline:
    """A Punkt-structured document answers "what is in it" with its own headings."""

    async def test_it_lists_depth_one_and_two_in_numbering_order(self, store):
        """2.10 after 2.9, which a string sort gets backwards."""
        store.outline_chunks = _oib_outline()

        out = await _read(document=OIB, conclusion="Ich kenne die OIB 2 noch nicht.")

        assert _gliederung(out)[:6] == [
            "- Punkt 0: Vorbemerkungen (S. 3) — Diese Richtlinie gilt für …",
            "- Punkt 1: Begriffsbestimmungen (S. 3) — Text zu Begriffsbestimmungen.",
            "- Punkt 2: Allgemeine Anforderungen (S. 4) — Text zu Allgemeine Anforderungen.",
            "  - Punkt 2.1: Abstände (S. 4)",
            "  - Punkt 2.9: Löschwasser (S. 5)",
            "  - Punkt 2.10: Blitzschutz (S. 5)",
        ]

    async def test_a_chapter_line_carries_its_opening_sentence_and_a_sub_punkt_does_not(self, store):
        """What a chapter is ABOUT beside what it is called. A heading list told
        an overview question nothing it did not know, so the model opened every
        chapter to find out: one round of eight parallel opens per member of a
        family, three once the fan-out crossed the per-round width cap. The
        sentence is bounded, quoted from the body after the heading line, and
        depth 2 stays a bare index — four members at 120 characters per chapter
        is the whole budget."""
        long_body = "Tragende Bauteile müssen " + "sehr " * 40 + "lange halten. Zweiter Satz."
        store.outline_chunks = [
            _punkt_chunk(
                "0",
                1,
                "Vorbemerkungen",
                3,
                content="0 Vorbemerkungen\n\nDiese Richtlinie gilt für Bauwerke. Sie ersetzt nichts.",
            ),
            _punkt_chunk("2", 1, "Anforderungen", 4, content=f"2 Anforderungen\n\n{long_body}"),
            _punkt_chunk("2.1", 2, "Abstände", 4),
        ]

        lines = _gliederung(await _read(document=OIB))

        assert lines[0] == "- Punkt 0: Vorbemerkungen (S. 3) — Diese Richtlinie gilt für Bauwerke."
        assert lines[1].startswith("- Punkt 2: Anforderungen (S. 4) — Tragende Bauteile müssen sehr")
        assert lines[1].endswith("…")
        assert len(lines[1].split(" — ", 1)[1]) <= rp._EXCERPT_CHARS + 1
        assert lines[2] == "  - Punkt 2.1: Abstände (S. 4)"

    async def test_the_numbering_orders_the_index_even_when_a_page_runs_ahead(self, store):
        """An outline is an index of the document's own numbering, not a walk
        through its pages: ordering by page first would print 2.2 after 3, which
        reads as a child of the wrong parent."""
        store.outline_chunks = [
            _punkt_chunk("2", 1, "Allgemeine Anforderungen", 4),
            _punkt_chunk("2.1", 2, "Abstände", 4),
            _punkt_chunk("2.2", 2, "Löschwasser", 6),
            _punkt_chunk("3", 1, "Brandschutz", 5),
        ]

        assert _gliederung(await _read(document=OIB)) == [
            "- Punkt 2: Allgemeine Anforderungen (S. 4) — Text zu Allgemeine Anforderungen.",
            "  - Punkt 2.1: Abstände (S. 4)",
            "  - Punkt 2.2: Löschwasser (S. 6)",
            "- Punkt 3: Brandschutz (S. 5) — Text zu Brandschutz.",
            rp._OUTLINE_INSTRUCTION,
        ]

    async def test_a_split_punkt_is_one_line_not_two(self, store):
        """A Punkt long enough for `SentenceSplitter` to cut arrives as several
        chunks carrying one `punkt_id`; listing it twice would read as two Punkte."""
        store.outline_chunks = _oib_outline()

        lines = _gliederung(await _read(document=OIB))

        assert len([line for line in lines if line.strip().startswith("- Punkt 0:")]) == 1

    async def test_depth_three_is_not_listed(self, store):
        store.outline_chunks = _oib_outline()

        assert "2.1.1" not in "\n".join(_gliederung(await _read(document=OIB)))

    async def test_punkt_zero_is_the_passage_and_carries_a_citation(self, store):
        """The scope passage is a passage: the citation the answer copies resolves
        to it, and the Trace-Lanes fan-out sees it like any searched hit."""
        store.outline_chunks = _oib_outline()

        out = await _read(document=OIB)
        head = out.split("## Gliederung", 1)[0]

        assert "Diese Richtlinie gilt für …" in head
        assert f"Citation: {OIB}, p.3" in head
        assert "Punkt: 0" in head
        assert "## Trace-Lanes" in head

    async def test_the_headings_are_not_rendered_as_passages(self, store):
        """A heading is not evidence. Only the scope passage's chunks are results."""
        store.outline_chunks = _oib_outline()

        out = await _read(document=OIB)

        assert "Found 2 relevant document(s)" in out
        assert "--- Result 3 ---" not in out

    async def test_it_closes_by_saying_the_index_is_not_evidence(self, store):
        store.outline_chunks = _oib_outline()

        out = await _read(document=OIB)

        assert "read_passage(document=…, punkt=…)" in out
        assert "keine Evidenz" in out

    async def test_a_document_without_punkt_zero_opens_its_first_punkt(self, store):
        """Lowest-numbered, not first-returned: 1 before 2 before 10."""
        store.outline_chunks = [
            _punkt_chunk("10", 1, "Schlussbestimmungen", 3, content="Zehntens …"),
            _punkt_chunk("2", 1, "Allgemeine Anforderungen", 3, content="Zweitens …"),
            _punkt_chunk("1", 1, "Begriffsbestimmungen", 3, content="Erstens …"),
            _punkt_chunk("1.1", 2, "Bauwerk", 3, content="Ein Bauwerk ist …"),
        ]

        out = await _read(document=OIB)
        head = out.split("## Gliederung", 1)[0]

        assert "Found 1 relevant document(s)" in head
        assert "Erstens …" in head
        assert "Zweitens …" not in head
        assert _gliederung(out)[0] == "- Punkt 1: Begriffsbestimmungen (S. 3) — Erstens …"


class TestTheRecheckHoldsWhenTheBackendDoesNot:
    """One backend reaches its index through an HTTP service that may honour a
    narrower set of clauses. The re-check is what keeps the outline an outline."""

    async def test_depth_three_chunks_a_backend_smuggled_in_are_dropped(self, store):
        store.outline_chunks = [
            _punkt_chunk("2", 1, "Allgemeine Anforderungen", 4),
            _punkt_chunk("2.1", 2, "Abstände", 4),
            _punkt_chunk("2.1.1", 3, "Abstand zur Nachbargrenze", 4),
            _punkt_chunk("2.1.2", 3, "Abstand zu Verkehrsflächen", 4),
        ]

        lines = _gliederung(await _read(document=OIB))

        assert lines[:2] == [
            "- Punkt 2: Allgemeine Anforderungen (S. 4) — Text zu Allgemeine Anforderungen.",
            "  - Punkt 2.1: Abstände (S. 4)",
        ]
        assert not any("2.1.1" in line or "2.1.2" in line for line in lines)

    async def test_a_depth_stored_as_a_string_still_counts(self, store):
        """A backend that round-trips metadata through JSON may hand `punkt_depth`
        back as "1". Dropping it would empty the outline of a whole corpus."""
        chunk = _punkt_chunk("2", 1, "Allgemeine Anforderungen", 4)
        chunk.metadata["punkt_depth"] = "1"
        store.outline_chunks = [chunk]

        assert (
            _gliederung(await _read(document=OIB))[0]
            == "- Punkt 2: Allgemeine Anforderungen (S. 4) — Text zu Allgemeine Anforderungen."
        )


class TestTheCap:
    async def test_eighty_lines_then_the_count_of_the_rest(self, store):
        store.outline_chunks = [_punkt_chunk(str(number), 1, f"Punkt {number}", 3) for number in range(1, 91)]

        lines = _gliederung(await _read(document=OIB))
        listed = [line for line in lines if line.strip().startswith("- Punkt ")]

        assert len(listed) == rp._MAX_OUTLINE_LINES == 80
        assert "(+10 weitere Punkte nicht gelistet)" in lines

    async def test_an_outline_that_fits_says_nothing_about_a_rest(self, store):
        store.outline_chunks = _oib_outline()

        assert not any("weitere Punkte" in line for line in _gliederung(await _read(document=OIB)))


class TestThePerPageFallback:
    """A document the Punkt chunker rejected (project uploads, Begriffsbestimmungen)
    carries no punkt_* metadata at all — its opening pages are the overview."""

    async def test_the_first_pages_are_the_passages(self, store):
        store.page_chunks = [_page_chunk(page, f"Seite {page} des Konzepts") for page in (1, 2, 3)]

        out = await _read(document=PLAN)

        assert "Found 3 relevant document(s)" in out
        assert f"Citation: {PLAN}, p.1" in out
        assert "Seite 3 des Konzepts" in out

    async def test_there_is_no_gliederung_and_it_says_so(self, store):
        store.page_chunks = [_page_chunk(1, "Seite 1 des Konzepts")]

        out = await _read(document=PLAN)

        assert "## Gliederung" not in out
        assert "nicht nach Punkten gegliedert" in out
        assert "read_passage(document=…, page=…)" in out

    async def test_pages_come_back_in_page_order(self, store):
        store.page_chunks = [_page_chunk(page, f"Seite {page}") for page in (3, 1, 2)]

        out = await _read(document=PLAN)

        assert out.index(f"Citation: {PLAN}, p.1") < out.index(f"Citation: {PLAN}, p.3")

    async def test_only_the_opening_passages_travel(self, store):
        """The fetch is bounded by `_MAX_OUTLINE_CHUNKS`, what is RENDERED by
        `_MAX_PASSAGE_CHUNKS` — a long document opens, it does not arrive."""
        store.page_chunks = [_page_chunk(page, f"Seite {page}") for page in range(1, 41)]

        out = await _read(document=PLAN)

        assert f"Found {rp._MAX_PASSAGE_CHUNKS} relevant document(s)" in out
        assert "Seite 1" in out
        assert "Seite 40" not in out

    async def test_a_document_with_nothing_stored_is_not_an_invented_citation(self, store):
        out = await _read(document=PLAN)

        assert "no passage of it could be read" in out
        assert "knowledge_search" in out
        assert "--- Result 1 ---" not in out


class TestWhatTheStoreIsAsked:
    async def test_the_outline_filter_is_exactly_the_documented_shape(self, store):
        store.outline_chunks = _oib_outline()

        await _read(document="OIB-Richtlinie 2, Ausgabe Mai 2023")

        (call,) = store.calls
        assert call["filters"] == {
            "$and": [
                {"file_name": {"$eq": OIB}},
                {
                    "$or": [
                        {"punkt_id": {"$eq": "0"}},
                        {"punkt_depth": {"$in": [1, 2]}},
                        {"punkt_depth": {"$in": ["1", "2"]}},
                    ]
                },
            ]
        }
        assert call["top_k"] == rp._MAX_OUTLINE_CHUNKS == 160
        assert call["collection"] == "oib_knowledge"

    async def test_the_fetch_names_the_document_alone(self, store):
        """`_locus_label` with no Punkt and no page reads as the document: the
        probe text is never empty, and it never claims a Punkt it did not ask for."""
        store.outline_chunks = _oib_outline()

        await _read(document=OIB)

        assert store.calls[0]["query"] == OIB

    async def test_the_fallback_asks_for_the_document_and_nothing_narrower(self, store):
        """It used to add `page_label $in ("1", "2", "3")`, which no workbook can
        match: `page_label` holds the WORKSHEET NAME for .xlsx/.xlsm. The file
        clause and `_MAX_OUTLINE_CHUNKS` bound the set on their own."""
        store.page_chunks = [_page_chunk(1, "Seite 1")]

        await _read(document=PLAN)

        assert [call["filters"] for call in store.calls][1] == {"file_name": {"$eq": PLAN}}
        assert "page_label" not in str(store.calls[1]["filters"])

    async def test_the_page_fetch_only_happens_when_there_are_no_punkte(self, store):
        store.outline_chunks = _oib_outline()

        await _read(document=OIB)

        assert len(store.calls) == 1

    def test_both_filters_survive_the_real_translator(self):
        """The dialect is the adapter's, not this module's opinion of it: an
        operator it cannot translate raises at the tool boundary rather than
        silently over-retrieving."""
        from knowledge_layer.llamaindex.adapter import _to_metadata_filters

        assert _to_metadata_filters(rp._outline_filters(OIB)) is not None
        assert _to_metadata_filters(rp._whole_document_filters(OIB)) is not None


class TestADocumentWhosePageLabelIsNotAPage:
    """`page_label` is whatever the extractor wrote: the WORKSHEET NAME for
    .xlsx/.xlsm (`llamaindex/office_extractors`). The fallback used to filter
    `page_label $in ("1", "2", "3")`, so an indexed spreadsheet matched nothing
    and the outline told the model the store held no chunk of it."""

    async def test_a_workbook_outlines_with_its_sheets_as_passages(self, store):
        store.page_chunks = [
            _sheet_chunk("Kostenaufstellung", "Position | Betrag …"),
            _sheet_chunk("Annahmen", "Preisbasis 2024 …"),
        ]

        out = await _read(document=SHEET, conclusion="Ich weiß noch nicht, was die Datei enthält.")

        assert "Found 2 relevant document(s)" in out
        assert "Position | Betrag …" in out
        assert "Preisbasis 2024 …" in out
        assert "no passage of it could be read" not in out
        assert "nicht nach Punkten gegliedert" in out

    async def test_the_workbook_passages_carry_a_citation(self, store):
        store.page_chunks = [_sheet_chunk("Kostenaufstellung", "Position | Betrag …")]

        out = await _read(document=SHEET)

        assert f"Citation: {SHEET}" in out
        assert "## Trace-Lanes" in out


class TestTheDepthClauseMatchesTheRecheck:
    """`_punkt_depth` accepts the string a JSON round-trip produces, so the
    clause has to ASK for it: an int-only `$in` can never deliver the chunk the
    re-check was written to keep, and the tolerance is dead code."""

    def test_the_clause_asks_for_both_spellings(self):
        """Two homogeneous `$in` clauses, not one mixed list: `MetadataFilter.value`
        is typed `list[int] | list[str] | …`, so a mixed list fails validation
        before it reaches any store."""
        assert rp._outline_filters(OIB)["$and"][1]["$or"][1:] == [
            {"punkt_depth": {"$in": [1, 2]}},
            {"punkt_depth": {"$in": ["1", "2"]}},
        ]

    def test_every_spelling_it_asks_for_passes_the_recheck(self):
        from types import SimpleNamespace as NS

        asked = [
            depth for clause in rp._outline_filters(OIB)["$and"][1]["$or"][1:] for depth in clause["punkt_depth"]["$in"]
        ]

        assert asked == [1, 2, "1", "2"]
        for depth in asked:
            assert rp._is_outline_chunk(NS(metadata={"punkt_id": "2", "punkt_depth": depth})), depth


class TestResolutionIsUnchanged:
    async def test_an_unknown_document_is_still_refused_with_the_guesses(self, store):
        out = await _read(document="oib-rl_2_ausgabe_mai_20233.pdf")

        assert "No document in scope is named" in out
        assert f"- {OIB}" in out
        assert store.calls == []

    async def test_an_empty_document_still_asks_for_a_name(self, store):
        out = await _read(document="  ")

        assert "Provide `document=`" in out
        assert store.calls == []


class TestTheContract:
    def test_the_first_sentence_covers_both_modes(self):
        first = rp._READ_PASSAGE_DESCRIPTION.split("\n")[0]

        assert "OUTLINE" in first
        assert "`punkt=`" in first and "`page=`" in first

    def test_the_refusal_that_sent_the_model_back_to_a_search_is_gone(self):
        assert "Provide `punkt=`" not in rp._READ_PASSAGE_DESCRIPTION
        assert "Provide `punkt=`" not in (rp.read_passage.__doc__ or "")

    def test_it_still_says_not_to_read_the_same_punkt_twice(self):
        assert "Do not call it twice for the same Punkt" in rp._READ_PASSAGE_DESCRIPTION

    def test_returns_describes_the_gliederung_as_an_index(self):
        returns = rp._READ_PASSAGE_DESCRIPTION.split("RETURNS")[1]

        assert "Gliederung" in returns
        assert "not evidence" in returns


#: The bytes this tool returned before the Gliederung moved inside the block.
#: Captured from the code that appended it, so the move cannot change what the
#: model reads (ADR-0061: the text may not move by a byte).
OUTLINE_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "read_passage_outline.txt"


@pytest.fixture
def capturing():
    """The turn-scoped capture ``PilotiAgent.run`` opens around a live turn."""
    token = begin_grounding_capture()
    yield
    end_grounding_capture(token)


class TestTheOutlineIsReadAsRecords:
    """An outline result must be findable by its own bytes.

    ``read_passage(document=…)`` is the most common call this tool takes, and
    its output used to be concatenated after the renderer had already filed the
    block under the hash of what it returned. Every one of those results missed
    the structured reader and fell to the regex parser, which recovers less than
    the producer stated. The Gliederung travels as the block's trailer now.
    """

    async def test_an_outline_result_is_filed_under_its_own_bytes(self, store, capturing):
        store.outline_chunks = _oib_outline()

        assert get_grounding_block(await _read(document=OIB)) is not None

    async def test_a_document_without_punkte_is_filed_too(self, store, capturing):
        """The no-Punkte line is the same decoration, and was the same miss."""
        store.page_chunks = [_page_chunk(1, "Seite 1 des Konzepts")]

        assert get_grounding_block(await _read(document=PLAN)) is not None

    async def test_the_outline_bytes_did_not_move(self, store):
        """Byte identity against what the concatenating code produced."""
        store.outline_chunks = _oib_outline()

        assert await _read(document=OIB) == OUTLINE_FIXTURE.read_text(encoding="utf-8")

    async def test_the_gliederung_is_still_not_evidence_on_the_text_path(self, store):
        """The reader that parses the text cuts at ``## Trace-Lanes``.

        The trailer sits after the fan-out, so a heading cannot arrive as a
        passage body no matter which of the two readers sees the result.
        """
        store.outline_chunks = _oib_outline()

        entries = extract_sources_from_tool_result("read_passage", await _read(document=OIB))

        assert [entry.chunk_text for entry in entries] == ["Diese Richtlinie gilt für …", "… und ist so zu lesen."]


class TestANumericPunkt:
    """A whole-numbered Punkt arrives as a number, and must open that Punkt.

    Providers answer the schema's type, so `punkt=3` is what a top-level Punkt
    looks like on the wire. Typed `str` only, the call died in argument
    validation before the tool ran, and the model was handed pydantic's own
    message instead of a passage.
    """

    async def test_an_int_punkt_opens_that_punkt(self, store):
        store.outline_chunks = [_punkt_chunk("3", 5, "Brandschutz", 2)]

        out = await _read(document=OIB, punkt=3)

        assert "Brandschutz" in out
        assert {"punkt_id": {"$eq": "3"}} in store.calls[-1]["filters"]["$and"]

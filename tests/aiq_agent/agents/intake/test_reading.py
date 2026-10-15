"""How the Erfassungs-Agent reads: ``read_document`` page by page, and every search hit logged.

The read log holds exactly what the model was shown, so the quote check in
``record_values`` cannot pass on text no tool returned.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from langchain_core.messages import ToolMessage

from aiq_agent.agents.intake import reading
from aiq_agent.agents.intake.reading import IntakeToolMiddleware
from aiq_agent.agents.intake.reading import make_read_document_tool
from aiq_agent.common.grounding_block import GroundingBlock
from aiq_agent.common.grounding_block import GroundingHit
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.grounding_block import render_grounding_block
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.schema import AvailableDocument


async def _read(**arguments) -> str:
    return await make_read_document_tool().ainvoke(arguments)


class TestReadDocument:
    async def test_it_reads_the_pages_under_markers_and_logs_each(self, project, read_log):
        text = await _read(file_name="baubeschreibung.pdf")

        assert "## Baubeschreibung.pdf — 3 Seite(n)" in text
        assert "[Seite 2]" in text and "Holzbauweise" in text
        assert read_log.contains("Baubeschreibung.pdf", "drei oberirdische Geschoße") == 3
        assert read_log.documents_read == ["Baubeschreibung.pdf"]

    async def test_it_reads_only_the_pages_asked_for(self, project, read_log):
        text = await _read(file_name="Baubeschreibung.pdf", pages=[3, 9])

        assert "[Seite 3]" in text and "[Seite 2]" not in text
        assert "No such page(s): 9" in text
        assert read_log.contains("Baubeschreibung.pdf", "Holzbauweise") is False

    async def test_it_is_bounded_and_says_where_to_go_on(self, project, read_log, monkeypatch):
        pages = [(str(n), f"Seite {n}: " + "Text " * 700) for n in range(1, 8)]
        monkeypatch.setattr(reading, "fetch_document_pages", lambda collection, name: pages)

        text = await _read(file_name="Baubeschreibung.pdf")

        assert len(text) < reading.MAX_READ_CHARS + 1500
        assert "Not shown:" in text and "pages=[" in text
        assert read_log.contains("Baubeschreibung.pdf", "Seite 7:") is False, "an unshown page is not logged"

    async def test_an_unknown_name_is_refused_with_the_close_names(self, project, read_log):
        text = await _read(file_name="Baubeschreibng.pdf")
        assert "No document named „Baubeschreibng.pdf“" in text and "„Baubeschreibung.pdf“" in text
        assert read_log.documents_read == []

    async def test_an_older_fassung_names_the_current_one(self, project, read_log, monkeypatch):
        older = reading.ProjectDocument(
            collection="proj_1",
            document=AvailableDocument(
                file_name="Baubeschreibung.pdf", collection="proj_1", superseded_by="Baubeschreibung_v2.pdf"
            ),
        )

        async def documents():
            return [older]

        monkeypatch.setattr(reading, "project_documents", documents)
        text = await _read(file_name="Baubeschreibung.pdf", pages=[1])
        assert "Ältere Fassung" in text and "Baubeschreibung_v2.pdf" in text

    async def test_a_failing_store_is_text_not_an_exception(self, project, read_log, monkeypatch):
        def broken(collection, name):
            raise RuntimeError("vector store down")

        monkeypatch.setattr(reading, "fetch_document_pages", broken)
        text = await _read(file_name="Baubeschreibung.pdf")
        assert "could not read" in text


class TestOnlyTheProjectShelves:
    def test_the_corpus_and_the_archive_are_not_read(self, monkeypatch):
        from aiq_agent.knowledge.scoping import ScopedCollection

        scope = [
            ScopedCollection("oib_knowledge", Shelf.BASE),
            ScopedCollection("proj_1", Shelf.PROJECT),
            ScopedCollection("archiv_1", Shelf.ARCHIV),
            ScopedCollection("legacy", None),
        ]
        monkeypatch.setattr("aiq_agent.knowledge.scoping.get_scoped_collections_from_context", lambda: scope)
        assert reading.project_collections() == ["proj_1", "legacy"]

    def test_a_restricted_folders_collection_is_never_read(self, monkeypatch):
        from aiq_agent.knowledge.scoping import ScopedCollection

        restricted = "proj_1_r0f0e0d0c0b0a"
        scope = [ScopedCollection("proj_1", Shelf.PROJECT), ScopedCollection(restricted, Shelf.PROJECT)]
        monkeypatch.setattr("aiq_agent.knowledge.scoping.get_scoped_collections_from_context", lambda: scope)
        assert reading.project_collections() == ["proj_1"]


def _hit(file_name: str, page: int, body: str, shelf: Shelf | None = Shelf.PROJECT) -> GroundingHit:
    return GroundingHit(
        citation_key=f"{file_name}, p.{page}",
        file_name=file_name,
        page=page,
        shelf=shelf,
        collection="proj_1",
        doc_class=None,
        display_title=file_name,
        folder_path=None,
        punkt=None,
        score=0.7,
        content_type="text",
        provenance=None,
        stored_image_index=None,
        status_note=None,
        body=body,
    )


def _search_result(tool: str, *hits: GroundingHit) -> str:
    block = GroundingBlock(preamble=f"Found {len(hits)} results", degraded_banner="", hits=hits, lanes=(), tool=tool)
    return render_grounding_block(block)


def _request(name: str) -> SimpleNamespace:
    return SimpleNamespace(tool_call={"name": name, "id": f"call-{name}", "args": {}})


class TestTheSharedToolsAreLogged:
    @pytest.mark.parametrize("captured", [True, False], ids=["records", "text-parsed"])
    async def test_a_search_hit_is_logged_but_does_not_count_as_read(self, read_log, captured):
        """From the records the knowledge layer filed (a live run), or from the text when none were."""
        token = begin_grounding_capture() if captured else None
        middleware = IntakeToolMiddleware(max_steps=5, finish_tool="finish_intake")
        content = _search_result("knowledge_search", _hit("Einreichplan.pdf", 1, "Bundesland: Wien"))

        async def handler(request):
            return ToolMessage(content=content, tool_call_id="call-knowledge_search", name="knowledge_search")

        try:
            result = await middleware.awrap_tool_call(_request("knowledge_search"), handler)
        finally:
            if token is not None:
                end_grounding_capture(token)

        assert read_log.contains("Einreichplan.pdf", "bundesland: wien") == 1
        assert read_log.documents_read == []
        assert "## Trace-Lanes" not in result.content, "the fan-out JSON is not the model's to re-read"

    async def test_a_passage_opened_counts_as_read_unless_it_is_the_corpus(self, read_log):
        content = _search_result(
            "read_passage",
            _hit("Einreichplan.pdf", 2, "Fluchtniveau 6,80 m"),
            _hit("OIB-RL 2.pdf", 4, "Gebäudeklasse 3", shelf=Shelf.BASE),
        )
        middleware = IntakeToolMiddleware(max_steps=5, finish_tool="finish_intake")

        async def handler(request):
            return ToolMessage(content=content, tool_call_id="call-read_passage", name="read_passage")

        await middleware.awrap_tool_call(_request("read_passage"), handler)
        assert read_log.documents_read == ["Einreichplan.pdf"]


class TestTheBudget:
    async def test_past_the_budget_only_finish_runs(self, read_log):
        middleware = IntakeToolMiddleware(max_steps=1, finish_tool="finish_intake")
        ran: list[str] = []

        async def handler(request):
            ran.append(request.tool_call["name"])
            return ToolMessage(content="ok", tool_call_id=request.tool_call["id"], name=request.tool_call["name"])

        await middleware.awrap_tool_call(_request("read_document"), handler)
        refused = await middleware.awrap_tool_call(_request("knowledge_search"), handler)
        await middleware.awrap_tool_call(_request("finish_intake"), handler)

        assert ran == ["read_document", "finish_intake"]
        assert "Step budget spent" in refused.content and "finish_intake" in refused.content

    async def test_a_tool_that_raises_is_a_message(self, read_log):
        middleware = IntakeToolMiddleware(max_steps=5, finish_tool="finish_intake")

        async def handler(request):
            raise RuntimeError("boom")

        result = await middleware.awrap_tool_call(_request("list_files"), handler)
        assert result.status == "error" and "list_files failed" in result.content


class TestReadsThePagesFromTheVectorStore:
    """``fetch_document_pages`` against a real Qdrant: the pages in order, an absent file as None."""

    def test_a_document_reads_page_by_page_in_order(self, qdrant_store):  # noqa: ARG002
        from sources.knowledge_layer.tests import qdrant_testing as qt

        qt.write(
            "proj_intake",
            [
                qt.record("Seite zwei: Bauweise geschlossen", "Baubeschreibung.pdf", page_label="2"),
                qt.record("Seite eins: Gebäudeklasse 4", "Baubeschreibung.pdf", page_label="1"),
            ],
        )

        pages = reading.fetch_document_pages("proj_intake", "Baubeschreibung.pdf")

        assert pages == [("1", "Seite eins: Gebäudeklasse 4"), ("2", "Seite zwei: Bauweise geschlossen")]
        assert reading.fetch_document_pages("proj_intake", "Fehlt.pdf") is None

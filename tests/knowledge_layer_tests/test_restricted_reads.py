"""The knowledge layer never hands the model a restricted folder's content unadmitted (ADR-0088).

The product rule: content from a restricted folder reaches the model only in a
turn whose signed scope holds that collection AND after the admission records
it; listing is not use; a person who lost read gets nothing through any tool.

Each tool here is driven the way the Piloti tools node drives it: inside
:func:`report_collections_read`, then through :func:`admit_tool_results`. What
these pin is the tool's half: it refuses what the turn may not read, never
LISTS a restricted file, never confirms one exists, and REPORTS every
collection whose content it returns, so the admission sees it whatever the text
says. The first four tests are the independent verifier's proofs of the bypass,
inverted; each failed against the code before this change.
"""

from __future__ import annotations

import importlib
import io
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import ToolMessage

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge import restricted_use as ru
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.browse import ListFilesConfig
from sources.knowledge_layer.src.browse import list_files
from sources.knowledge_layer.src.read_passage import ReadPassageConfig
from sources.knowledge_layer.src.read_passage import read_passage
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig

PROJ = "proj_11111111-1111-1111-1111-111111111111"
R = PROJ + "_rabcdefabcdef"
SALARIES = "Gehaltsliste_2026.pdf"
SALARY_SUMMARY = "Gehälter: GF 182.000 EUR, Bauleiter 74.000 EUR"


def _builder() -> MagicMock:
    builder = MagicMock()
    builder.get_function_config = MagicMock(
        return_value=KnowledgeRetrievalConfig(collection_name="oib_knowledge", include_base_collection=True)
    )
    return builder


def _chunk(collection: str, *, punkt: str = "1", page: int = 1, content: str = SALARY_SUMMARY) -> Chunk:
    return Chunk(
        chunk_id=f"{collection}-{punkt}",
        content=content,
        score=0.7,
        file_name=SALARIES,
        page_number=page,
        display_citation=f"{SALARIES}, p.{page}",
        content_type=ContentType.TEXT,
        metadata={"punkt_id": punkt, "page_label": str(page), "collection": collection},
    )


class _Store:
    def __init__(self, chunks: list[Chunk]) -> None:
        self.chunks = chunks

    async def retrieve(self, query, collection_name, top_k, filters):
        return SimpleNamespace(
            chunks=[chunk for chunk in self.chunks if chunk.metadata.get("collection") == collection_name],
            success=True,
            error_message=None,
        )


@pytest.fixture
def scope(monkeypatch):
    """A turn whose scope carries the base corpus, the project and one restricted folder."""
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping._parse_scope_payload",
        lambda _s: [
            ScopedCollection("oib_knowledge", Shelf.BASE),
            ScopedCollection(PROJ, Shelf.PROJECT),
            ScopedCollection(R, Shelf.PROJECT),
        ],
    )
    monkeypatch.setattr("aiq_agent.knowledge.ingest_status_store.in_flight_files", lambda collections: {})
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})

    async def _docs(collection):
        if collection == R:
            return [AvailableDocument(file_name=SALARIES, summary=SALARY_SUMMARY)]
        if collection == PROJ:
            return [AvailableDocument(file_name="Grundriss_EG.pdf")]
        return []

    monkeypatch.setattr("aiq_agent.knowledge.get_available_documents_async", _docs)
    monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _docs)
    store = _Store([])
    monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: store)
    set_turn_documents(None)
    yield store
    set_turn_documents(None)


@pytest.fixture
def use(monkeypatch):
    """The turn may draw on the restricted folder; every admission asked is recorded."""
    asked: list[list[str]] = []

    def _admit(bound, collections):
        asked.append(list(collections))
        bound.admitted.update(collections)
        bound.note_recorded()
        return set(collections)

    monkeypatch.setattr(ru, "admit", _admit)
    bound = ru.RestrictedUse(
        organization_id="org", user_id="u", conversation_id="c", project_id="p", drawable={R}, confined=False
    )
    token = ru.bind_restricted_use(bound)
    bound.asked = asked  # type: ignore[attr-defined]
    yield bound
    ru.reset_restricted_use(token)


async def _round(run, name: str) -> tuple[ToolMessage, list[Any]]:
    """One call as the tools node runs it: reported, then admitted."""

    async def execute(_request):
        return ToolMessage(content=await run(), tool_call_id="call-1", name=name)

    message = await ru.report_collections_read(None, execute)
    return message, await ru.admit_tool_results([message])


async def _list_files(**kwargs) -> str:
    async with list_files(ListFilesConfig(), _builder()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


async def _read(**kwargs) -> str:
    async with read_passage(ReadPassageConfig(), _builder()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


# ---------------------------------------------------------------------------
# The verifier's proofs, inverted
# ---------------------------------------------------------------------------


async def test_the_scope_really_carries_the_restricted_folder(scope, use):
    """The precondition every case below stands on: the turn may draw on R."""
    from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

    assert R in [entry.collection for entry in get_scoped_collections_from_context()]


async def test_list_files_never_lists_a_restricted_file_when_the_inventory_failed(scope, use):
    """An inventory that failed to load (``Inventory(None, None)``) falls back to the scope, minus restricted."""
    message, admitted = await _round(_list_files, "list_files")

    assert "Grundriss_EG.pdf" in message.content
    assert SALARIES not in message.content and "182.000" not in message.content
    assert use.asked == [] and use.confined is False
    assert admitted[0] is message


async def test_list_files_never_lists_a_restricted_row_the_turn_bound(scope, use):
    """The filter is on the rows, so a bound row from a restricted folder is dropped as well."""
    set_turn_documents(
        [
            {"file_name": "Grundriss_EG.pdf", "collection": PROJ, "shelf": "project"},
            {"file_name": SALARIES, "summary": SALARY_SUMMARY, "collection": R, "shelf": "project"},
        ]
    )
    text = await _list_files(name_contains="gehalt")

    assert SALARIES not in text and "182.000" not in text


async def test_read_passage_suggests_no_restricted_file_before_it_is_admitted(scope, use):
    message, _ = await _round(lambda: _read(document="Gehaltsliste 2026.pdf", page=1), "read_passage")

    assert "No document in scope is named" in message.content
    assert SALARIES not in message.content and R not in message.content
    # One readable document is counted: the project's plan, not the salaries.
    assert "1 document(s) are readable" in message.content
    assert use.asked == [] and use.confined is False


async def test_read_passage_suggests_a_restricted_file_once_its_folder_was_admitted(scope, use):
    use.admitted.add(R)

    text = await _read(document="Gehaltsliste 2026.pdf", page=1)

    assert SALARIES in text


async def test_view_image_result_of_a_restricted_folder_the_turn_may_not_draw_on_is_withheld():
    bound = ru.RestrictedUse(
        organization_id="org", user_id="u", conversation_id="c", project_id="p", drawable=set(), confined=True
    )
    message = ToolMessage(
        content=[
            {"type": "text", "text": f"Uploaded image 'Gehalt.png' from collection '{R}'"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
        ],
        tool_call_id="call-1",
    )
    token = ru.bind_restricted_use(bound)
    try:
        out = await ru.admit_tool_results([message])
    finally:
        ru.reset_restricted_use(token)
    assert out[0].content == ru.WITHHELD_NOTICE and out[0].tool_call_id == "call-1"
    # And with no restricted use bound at all, nothing can admit it either.
    assert (await ru.admit_tool_results([message]))[0].content == ru.WITHHELD_NOTICE


# ---------------------------------------------------------------------------
# read_passage: existence is not confirmed, content is reported
# ---------------------------------------------------------------------------


async def test_read_passage_does_not_confirm_a_hidden_document_has_no_such_page(scope, use):
    """The salaries resolve, the page is empty: answered as if the file did not exist."""
    text = await _read(document=SALARIES, page=99)

    assert "carries no passage" not in text and "is registered" not in text
    assert "No document in scope is named" in text


async def test_read_passage_says_no_such_page_once_the_folder_was_admitted(scope, use):
    use.admitted.add(R)

    text = await _read(document=SALARIES, page=99)

    assert "carries no passage" in text


async def test_read_passage_reports_a_restricted_passage_and_it_is_admitted(scope, use):
    scope.chunks = [_chunk(R)]

    message, admitted = await _round(lambda: _read(document=SALARIES, page=1), "read_passage")

    assert ru.collections_read(message) == {R}
    assert use.asked == [[R]] and use.confined is True
    assert "182.000" in admitted[0].content


async def test_read_passage_withholds_a_restricted_passage_the_bff_refuses(scope, use, monkeypatch):
    scope.chunks = [_chunk(R)]
    monkeypatch.setattr(ru, "admit", lambda bound, collections: set())

    _message, admitted = await _round(lambda: _read(document=SALARIES, page=1), "read_passage")

    assert admitted[0].content == ru.WITHHELD_NOTICE


# ---------------------------------------------------------------------------
# The exact search: the match table is content of every file it names
# ---------------------------------------------------------------------------


async def test_exact_search_reports_every_collection_its_match_table_names(monkeypatch):
    from sources.knowledge_layer.src import browse

    class _Retriever:
        async def find_text(self, collection, pattern, *, filters, limit):
            return [_chunk(collection, content="Gehalt 182.000 EUR")] if collection == R else []

    # The passages are rendered (and reported) by the grounding block; stubbed
    # here so what is left to report is the match table alone.
    monkeypatch.setattr(importlib.import_module(f"{browse.__package__}.register"), "_format_results", _no_passages)
    monkeypatch.setattr(
        importlib.import_module(f"{browse.__package__}.read_passage"), "_passage_result", lambda chunks, query: None
    )
    entries = [ScopedCollection(PROJ, Shelf.PROJECT), ScopedCollection(R, Shelf.PROJECT)]

    async def run():
        return await browse._search(_Retriever(), entries, ["Gehalt"], browse.phrase_pattern(["Gehalt"]), {})

    message, _ = await _round(run, "knowledge_search")

    assert ru.collections_read(message) == {R}


def _no_passages(*_args, **_kwargs) -> str:
    return "passages"


def test_a_failed_restricted_collection_is_never_named_in_a_message():
    from sources.knowledge_layer.src import browse

    text = browse.search_failed_message(["Gehalt"], [PROJ, R])

    assert R not in text and PROJ in text


# ---------------------------------------------------------------------------
# view_knowledge_image: the model's collection is checked against the turn
# ---------------------------------------------------------------------------


def _png() -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def image_tool(monkeypatch):
    """``view_knowledge_image`` with storage faked: every lookup it makes is recorded."""
    import sources.knowledge_layer.src.view_image as vi

    asked: list[tuple[str, str]] = []

    async def _resolve(collection, file_name, organization_id=None, image_index=None):
        asked.append((collection, file_name))
        return ("org/doc/Gehalt.png", None)

    monkeypatch.setattr(vi, "_resolve_storage_location", _resolve)
    monkeypatch.setattr(vi, "_fetch_seaweed_bytes", lambda key, bucket=None: _png())
    monkeypatch.setattr("knowledge_layer.llamaindex.adapter._get_vlm_api_key", lambda: "k")
    monkeypatch.setattr(vi, "try_consume_image_view", lambda: True)

    async def view(**kwargs):
        async with vi.view_knowledge_image(vi.ViewKnowledgeImageToolConfig(), MagicMock()) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    view.asked = asked  # type: ignore[attr-defined]
    return view


def _scope_of(monkeypatch, *names: str) -> None:
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping._parse_scope_payload",
        lambda _s: [ScopedCollection(name, Shelf.PROJECT) for name in names],
    )


async def test_view_image_refuses_a_restricted_collection_outside_the_turn_before_any_lookup(monkeypatch, image_tool):
    """The asker is cleared for nothing restricted: no use bound, R not in scope."""
    _scope_of(monkeypatch, PROJ)

    message, admitted = await _round(lambda: image_tool(file_name="Gehalt.png", collection=R), "view_knowledge_image")

    assert image_tool.asked == []
    assert isinstance(message.content, str) and "not one this turn may read" in message.content
    assert R not in message.content
    assert admitted[0] is message


async def test_view_image_refuses_a_restricted_collection_in_scope_but_not_drawable(monkeypatch, image_tool):
    """The scope still names R; the turn's use does not let it be drawn on (a share narrowed it, or no envelope)."""
    _scope_of(monkeypatch, PROJ, R)
    bound = ru.RestrictedUse(organization_id="o", user_id="u", conversation_id="c", project_id="p", drawable=set())
    token = ru.bind_restricted_use(bound)
    try:
        result = await image_tool(file_name="Gehalt.png", collection=R)
    finally:
        ru.reset_restricted_use(token)

    assert image_tool.asked == [] and isinstance(result, str)


async def test_view_image_refuses_an_open_collection_outside_the_scope(monkeypatch, image_tool):
    _scope_of(monkeypatch, PROJ)

    result = await image_tool(file_name="plan.png", collection="proj_22222222-2222-2222-2222-222222222222")

    assert image_tool.asked == [] and isinstance(result, str)


async def test_view_image_of_a_drawable_restricted_folder_is_reported_and_admitted(monkeypatch, image_tool, use):
    _scope_of(monkeypatch, PROJ, R)

    message, admitted = await _round(lambda: image_tool(file_name="Gehalt.png", collection=R), "view_knowledge_image")

    assert image_tool.asked == [(R, "Gehalt.png")]
    assert ru.collections_read(message) == {R}
    assert use.asked == [[R]] and use.confined is True
    assert admitted[0].content[1]["type"] == "image_url"


async def test_view_image_reaches_an_open_collection_in_scope_without_admitting_anything(monkeypatch, image_tool, use):
    _scope_of(monkeypatch, PROJ, R)

    message, admitted = await _round(lambda: image_tool(file_name="plan.png", collection=PROJ), "view_knowledge_image")

    assert image_tool.asked == [(PROJ, "plan.png")]
    assert ru.collections_read(message) == {PROJ}
    assert use.asked == [] and admitted[0] is message


async def test_the_lookup_echoes_the_turns_signed_envelope(monkeypatch):
    """The BFF answers only inside the scope the envelope signs; the tool sends it byte-for-byte."""
    import httpx

    from sources.knowledge_layer.src.view_image import _resolve_storage_location

    seen: list[dict[str, str]] = []

    class _Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, url, *, params, headers):
            seen.append(headers)
            return SimpleNamespace(status_code=200, json=lambda: {"storageKey": "k"})

    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    monkeypatch.setattr("aiq_agent.project_context.get_request_envelope_from_context", lambda: ("ZW52ZWxvcGU", "c2ln"))

    assert await _resolve_storage_location(PROJ, "plan.png") == ("k", None)
    assert seen[-1]["x-grid-request-context"] == "ZW52ZWxvcGU"
    assert seen[-1]["x-grid-request-context-sig"] == "c2ln"

    monkeypatch.setattr("aiq_agent.project_context.get_request_envelope_from_context", lambda: (None, None))
    await _resolve_storage_location(PROJ, "plan.png")
    assert "x-grid-request-context" not in seen[-1]

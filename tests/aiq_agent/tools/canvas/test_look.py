"""``look``: the canvas's document, or the box on it, through ``view_knowledge_image``'s own body.

The bytes are a real one-page PDF; only the lookup and the object-store fetch
are faked. What is under test is which file ``look`` picks and that it goes
through the same scope check, image budget and region crop as the tool it shares.
"""

from __future__ import annotations

import io

import knowledge_layer.llamaindex.adapter as llm_adapter
import knowledge_layer.view_image as view
import pypdfium2 as pdfium
import pytest

from aiq_agent.common import image_view_budget
from aiq_agent.common.focus_file import set_turn_intent
from aiq_agent.tools.canvas import look as canvas_look
from aiq_agent.tools.canvas.register import run_look

from .conftest import DOCUMENT
from .conftest import LIST_BODY
from .conftest import answering


def _pdf() -> bytes:
    doc = pdfium.PdfDocument.new()
    doc.new_page(595, 842)
    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


@pytest.fixture
def stored(monkeypatch):
    """A project PDF the lookup finds in ``proj_1`` (or wherever asked) and the store hands back."""
    asked: list[tuple[str, str]] = []

    async def locate(collection, file_name, organization_id=None, image_index=None):
        asked.append((collection, file_name))
        return ("key", None) if collection == "proj_1" else None

    monkeypatch.setenv("AIQ_VIEW_IMAGES_ENABLED", "true")
    monkeypatch.setattr(llm_adapter, "_get_vlm_api_key", lambda: "sk-test")
    monkeypatch.setattr(view, "_find_pdf", lambda _name: None)
    monkeypatch.setattr(view, "_resolve_storage_location", locate)
    monkeypatch.setattr(view, "_fetch_seaweed_bytes", lambda *_: _pdf())
    monkeypatch.setattr(view, "_vision_refusal", _no_refusal)
    return asked


async def _no_refusal(_tool):
    return None


async def test_the_canvas_document_is_looked_at_with_its_inventory_collection(stored) -> None:
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
    token = image_view_budget.begin_image_view_budget()
    try:
        result = await run_look(page=1, region=[0.1, 0.1, 0.3, 0.2])
        budget = image_view_budget.get_image_view_budget()
        assert budget is not None and budget.regions_viewed == 1
    finally:
        image_view_budget.end_image_view_budget(token)

    assert stored == [("proj_1", "Grundriss_EG.pdf")]
    assert isinstance(result, list) and result[0]["text"].startswith("Region [x=0.100")
    assert "from collection 'proj_1'" in result[0]["text"]


async def test_the_subject_is_named_by_the_bff_when_the_turn_does_not_know_its_file(stored, monkeypatch, calls) -> None:
    answering(monkeypatch, calls, LIST_BODY)

    result = await run_look(page=1)

    # The room hears what Piloti reads first; then the subject's name is read for the render.
    # The room hears what Piloti reads while the subject's name is read for the render.
    assert sorted(payload["op"] for payload, _ in calls) == ["list", "look"]
    assert {"op": "look", "page": 1} in [payload for payload, _ in calls]
    assert isinstance(result, list) and "Rendered page 1 of 'Grundriss_EG.pdf'" in result[0]["text"]


async def test_a_file_the_inventory_does_not_list_is_found_in_the_turns_collections(stored, monkeypatch) -> None:
    set_turn_intent(file_name="Brandschutz_Nachweis.pdf", document_id=DOCUMENT)
    monkeypatch.setattr(canvas_look, "probe_collections", lambda: ["proj_9", "proj_1"])

    result = await run_look(page=1)

    assert stored == [
        ("proj_9", "Brandschutz_Nachweis.pdf"),
        ("proj_1", "Brandschutz_Nachweis.pdf"),
        (
            "proj_1",
            "Brandschutz_Nachweis.pdf",
        ),
    ]
    assert isinstance(result, list)


async def test_an_invalid_region_is_refused_in_looks_own_name(stored) -> None:
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

    result = await run_look(page=1, region=[0.9, 0.1, 0.3, 0.2])

    assert isinstance(result, str) and result.startswith("[look] Invalid region")


async def test_a_collection_outside_the_turns_scope_is_never_fetched(stored, monkeypatch) -> None:
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
    monkeypatch.setattr(view, "_may_read", lambda _collection: False)

    result = await run_look(page=1)

    assert stored == [] and isinstance(result, str) and "not one this turn may read" in result


async def test_a_look_reports_the_collection_it_read(stored, monkeypatch) -> None:
    """What ``admit_tool_results`` admits: a restricted folder's page reaches the model only once admitted."""
    reported: list[list[str]] = []
    monkeypatch.setattr(view, "note_collections_read", lambda collections: reported.append(list(collections)))
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

    result = await run_look(page=1, region=[0.0, 0.0, 0.5, 0.5])

    assert isinstance(result, list)
    assert reported == [["proj_1"]]


async def test_the_room_sees_the_box_piloti_reads(stored, monkeypatch, calls) -> None:
    answering(monkeypatch, calls, {"ok": True})
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

    await run_look(page=2, region=[0.1, 0.2, 0.3, 0.25])

    [look] = [payload for payload, _ in calls if payload["op"] == "look"]
    assert (look["page"], look["x"], look["y"], look["w"], look["h"]) == (2, 0.1, 0.2, 0.3, 0.25)


async def test_a_room_that_cannot_be_told_never_stops_the_look(stored, monkeypatch, calls) -> None:
    from aiq_agent.tools.canvas.client import CanvasRequestError

    answering(monkeypatch, calls, CanvasRequestError("down", status=503))
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

    result = await run_look(page=1)

    assert isinstance(result, list)

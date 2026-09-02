"""Unit tests for KB ## Trace-Lanes emit (Herleitung UI)."""

from __future__ import annotations

import json
from types import SimpleNamespace

from sources.knowledge_layer.src.register import _format_results
from sources.knowledge_layer.src.register import _trace_lanes_json


def _chunk(
    *,
    file_name: str,
    page: int | None = None,
    collection: str | None = None,
    shelf: str | None = None,
    doc_class: str | None = None,
):
    metadata: dict[str, str] = {}
    if collection:
        metadata["collection"] = collection
    if shelf:
        metadata["shelf"] = shelf
    if doc_class:
        metadata["doc_class"] = doc_class
    return SimpleNamespace(
        file_name=file_name,
        page_number=page,
        content="snippet",
        content_type=SimpleNamespace(value="text"),
        score=0.9,
        metadata=metadata,
    )


def test_trace_lanes_sources_carry_the_shelf_the_hit_stated():
    """The fan-out is the only channel an uncited document has for its shelf."""
    payload = json.loads(
        _trace_lanes_json([_chunk(file_name="Konzept.pdf", page=1, collection="proj_abc", shelf="project")])
    )
    (lane,) = payload["lanes"]
    assert lane["sources"][0]["shelf"] == "project"


def test_trace_lanes_lane_is_decided_by_the_stated_shelf_not_a_collection_guess():
    """A collection id nobody can read a prefix from, with the default doc class.

    Resolved from the name alone this hit was "Basisdokument" in law blue —
    ``sonstiges`` is a valid class and the collection said nothing. The shelf
    the hit already carries settles it.
    """
    payload = json.loads(
        _trace_lanes_json(
            [_chunk(file_name="Plan.pdf", page=2, collection="c_9f2a", shelf="project", doc_class="sonstiges")]
        )
    )
    (lane,) = payload["lanes"]
    assert lane["key"] == "projekt"


def test_trace_lanes_json_groups_by_lane():
    chunks = [
        _chunk(file_name="OIB-RL_2_Brandschutz.pdf", page=12, collection="oib_knowledge"),
        _chunk(file_name="Konzept.pdf", page=1, collection="proj_abc"),
        _chunk(file_name="Vorlage.pdf", collection="archiv_org1"),
    ]
    payload = json.loads(_trace_lanes_json(chunks))
    keys = [lane["key"] for lane in payload["lanes"]]
    assert keys == ["baurecht_oib", "projekt", "buero"]
    oib = next(lane for lane in payload["lanes"] if lane["key"] == "baurecht_oib")
    assert oib["label"] == "OIB-Richtlinie"
    assert oib["hitCount"] == 1
    # `name` is document identity (dedup / preview resolution); `title` is the
    # user-facing display name the Herleitung fan-out renders.
    assert oib["sources"][0] == {
        "name": "OIB-RL_2_Brandschutz.pdf",
        "title": "OIB-Richtlinie 2",
        "detail": "p.12",
    }


def test_trace_lanes_sources_carry_the_display_title():
    """The fan-out must never make a user read a raw corpus filename."""
    chunks = [_chunk(file_name="oib-rl_2.3_ausgabe_mai_2023.pdf", page=4, collection="oib_knowledge")]
    payload = json.loads(_trace_lanes_json(chunks))
    source = payload["lanes"][0]["sources"][0]
    assert source["name"] == "oib-rl_2.3_ausgabe_mai_2023.pdf"
    assert source["title"] == "OIB-Richtlinie 2.3, Ausgabe Mai 2023"


def test_trace_lanes_omits_title_when_it_would_repeat_the_filename():
    """A project upload's filename IS its user-meaningful name — no redundancy."""
    chunks = [_chunk(file_name="Konzept.pdf", page=1, collection="proj_abc")]
    payload = json.loads(_trace_lanes_json(chunks))
    source = payload["lanes"][0]["sources"][0]
    assert source["name"] == "Konzept.pdf"
    assert "title" not in source


def test_format_results_appends_trace_lanes_block():
    result = SimpleNamespace(
        success=True,
        chunks=[_chunk(file_name="OIB-RL_4.pdf", page=3, collection="oib_knowledge")],
        error_message=None,
    )
    text = _format_results(result, "test query")
    assert "## Trace-Lanes" in text
    assert "baurecht_oib" in text
    assert "OIB-RL_4.pdf" in text


def test_format_results_empty_chunks_skips_trace_block():
    result = SimpleNamespace(success=True, chunks=[], error_message=None)
    text = _format_results(result, "q")
    assert "Trace-Lanes" not in text

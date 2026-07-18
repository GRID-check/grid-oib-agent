"""Unit tests for KB ## Trace-Lanes emit (Herleitung UI)."""

from __future__ import annotations

import json
from types import SimpleNamespace

from sources.knowledge_layer.src.register import _format_results, _trace_lanes_json


def _chunk(*, file_name: str, page: int | None = None, collection: str | None = None):
    return SimpleNamespace(
        file_name=file_name,
        page_number=page,
        content="snippet",
        content_type=SimpleNamespace(value="text"),
        score=0.9,
        metadata={"collection": collection} if collection else {},
    )


def test_trace_lanes_json_groups_by_lane():
    chunks = [
        _chunk(file_name="OIB-RL_2_Brandschutz.pdf", page=12, collection="oib_knowledge"),
        _chunk(file_name="Konzept.pdf", page=1, collection="proj_abc"),
        _chunk(file_name="Vorlage.pdf", collection="archiv_org1"),
    ]
    payload = json.loads(_trace_lanes_json(chunks))
    keys = [lane["key"] for lane in payload["lanes"]]
    assert keys == ["baurecht_oib", "projekt", "buero"]
    oib = next(l for l in payload["lanes"] if l["key"] == "baurecht_oib")
    assert oib["label"] == "OIB-Richtlinie"
    assert oib["hitCount"] == 1
    assert oib["sources"][0] == {"name": "OIB-RL_2_Brandschutz.pdf", "detail": "p.12"}


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

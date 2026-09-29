"""A passage read off a picture of the page carries its box to the viewer (issue #433).

The box travels as a field of the grounding record, never as a line of the text
the model reads: the model gains nothing from coordinates, and a changed block
would be a changed prompt. So these tests hold both halves: the bytes do not
move, and the box still reaches the wire, through dedup and the session cache.
"""

from __future__ import annotations

import dataclasses

import pytest

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import _registry_from_cached_entries
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.citation_verification import read_source_to_wire
from aiq_agent.common.citation_verification import source_entry_to_wire
from aiq_agent.common.grounding_block import GroundingBlock
from aiq_agent.common.grounding_block import GroundingHit
from aiq_agent.common.grounding_block import SourceRegion
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.grounding_block import render_grounding_block

GRUNDRISS = SourceRegion(box=(0.1, 0.2, 0.5, 0.6), label="Grundriss EG")
SCHNITT = SourceRegion(box=(0.55, 0.2, 0.9, 0.6), label=None)


def _hit(**overrides) -> GroundingHit:
    fields = {
        "citation_key": "plan.pdf, p.3",
        "file_name": "plan.pdf",
        "page": 3,
        "shelf": None,
        "collection": "proj_1",
        "doc_class": None,
        "display_title": "plan.pdf",
        "folder_path": None,
        "punkt": None,
        "score": 0.7,
        "content_type": "drawing",
        "provenance": None,
        "stored_image_index": None,
        "status_note": None,
        "body": "[DRAWING from page 3] Grundriss EG mit Sitztreppe zum Innenhof.",
    }
    return GroundingHit(**{**fields, **overrides})


def _block(*hits: GroundingHit) -> GroundingBlock:
    return GroundingBlock(
        preamble=f"Found {len(hits)} relevant document(s):",
        degraded_banner="",
        hits=hits,
        lanes=(),
        tool="knowledge_search",
    )


@pytest.fixture
def capturing():
    token = begin_grounding_capture()
    yield
    end_grounding_capture(token)


def test_the_model_reads_the_same_bytes_with_or_without_a_region():
    assert render_grounding_block(_block(_hit(regions=(GRUNDRISS,)))) == render_grounding_block(_block(_hit()))


def test_the_record_carries_the_region_into_the_registry(capturing):
    rendered = render_grounding_block(_block(_hit(regions=(GRUNDRISS,))))

    [entry] = extract_sources_from_tool_result("knowledge_search", rendered)

    assert entry.regions == [GRUNDRISS]


def test_two_depictions_on_one_page_are_both_marked(capturing):
    """Dedup folds the page's chunks into one source; it must not fold their boxes away."""
    rendered = render_grounding_block(
        _block(_hit(regions=(GRUNDRISS,)), _hit(regions=(SCHNITT,), body="Schnitt A-A durch die Sitztreppe."))
    )
    registry = SourceRegistry()
    for entry in extract_sources_from_tool_result("knowledge_search", rendered):
        registry.add(entry)

    [source] = registry._citation_keys
    assert source.regions == [GRUNDRISS, SCHNITT]


def test_the_wire_carries_the_boxes_and_omits_an_unknown_label():
    entry = SourceEntry(citation_key="plan.pdf, p.3", source_type="knowledge_layer", regions=[GRUNDRISS, SCHNITT])

    assert source_entry_to_wire(entry)["regions"] == [
        {"box": [0.1, 0.2, 0.5, 0.6], "label": "Grundriss EG"},
        {"box": [0.55, 0.2, 0.9, 0.6]},
    ]


def test_running_text_carries_no_regions_key():
    entry = SourceEntry(citation_key="bescheid.pdf, p.2", source_type="knowledge_layer", chunk_text="Spruch.")

    assert "regions" not in source_entry_to_wire(entry)


def test_a_source_that_was_only_read_carries_no_regions():
    """The uncited channel names documents; a box is a claim about where the evidence is."""
    entry = SourceEntry(citation_key="plan.pdf, p.3", source_type="knowledge_layer", regions=[GRUNDRISS])

    assert "regions" not in read_source_to_wire(entry)


def test_a_resumed_conversation_keeps_its_boxes():
    """The session registry is cached as ``asdict``; a replica move must not drop the boxes."""
    entry = SourceEntry(citation_key="plan.pdf, p.3", source_type="knowledge_layer", regions=[GRUNDRISS])

    hydrated = _registry_from_cached_entries([dataclasses.asdict(entry)])

    assert hydrated._all[0].regions == [GRUNDRISS]


def test_a_malformed_cached_box_is_dropped_not_guessed():
    cached = {"citation_key": "plan.pdf, p.3", "regions": [{"box": [0.1, 0.2]}, {"box": [0.1, 0.2, 0.5, 0.6]}]}

    hydrated = _registry_from_cached_entries([cached])

    assert hydrated._all[0].regions == [SourceRegion(box=(0.1, 0.2, 0.5, 0.6))]

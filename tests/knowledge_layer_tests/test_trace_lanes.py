"""The knowledge layer's lane fan-out: typed lanes from the records, and the ``sources`` step."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aiq_agent.common.wire_v2 import TraceLane
from aiq_agent.common.wire_v2 import TraceLaneSource
from sources.knowledge_layer.src.register import _format_results
from sources.knowledge_layer.src.register import _trace_lanes_for_chunks


@pytest.fixture(autouse=True)
def _reset_retrieval_round():
    from aiq_agent.common.turn_status import _retrieval_round

    _retrieval_round.set(None)
    yield
    _retrieval_round.set(None)


def _chunk(
    *,
    file_name: str,
    page: int | None = None,
    collection: str | None = None,
    shelf: str | None = None,
    doc_class: str | None = None,
    provenance: dict[str, str] | None = None,
):
    metadata: dict[str, str] = {}
    if collection:
        metadata["collection"] = collection
    if shelf:
        metadata["shelf"] = shelf
    if doc_class:
        metadata["doc_class"] = doc_class
    if provenance:
        metadata.update(provenance)
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
    (lane,) = _trace_lanes_for_chunks([_chunk(file_name="Konzept.pdf", page=1, collection="proj_abc", shelf="project")])
    assert lane.sources[0].shelf == "project"


def test_trace_lanes_lane_is_decided_by_the_stated_shelf_not_a_collection_guess():
    """A collection id nobody can read a prefix from, with the default doc class.

    Resolved from the name alone this hit was "Basisdokument" in law blue —
    ``sonstiges`` is a valid class and the collection said nothing. The shelf
    the hit already carries settles it.
    """
    (lane,) = _trace_lanes_for_chunks(
        [_chunk(file_name="Plan.pdf", page=2, collection="c_9f2a", shelf="project", doc_class="sonstiges")]
    )
    assert lane.key == "projekt"


def test_trace_lanes_group_by_lane():
    chunks = [
        _chunk(file_name="OIB-RL_2_Brandschutz.pdf", page=12, collection="oib_knowledge"),
        _chunk(file_name="Konzept.pdf", page=1, collection="proj_abc"),
        _chunk(file_name="Vorlage.pdf", collection="archiv_org1"),
    ]
    lanes = _trace_lanes_for_chunks(chunks)
    assert [lane.key for lane in lanes] == ["baurecht_oib", "projekt", "buero"]
    # `name` is document identity (dedup / preview resolution); `title` is the
    # user-facing display name the Herleitung fan-out renders.
    assert lanes[0] == TraceLane(
        key="baurecht_oib",
        label="OIB-Richtlinie",
        kind="baurecht",
        hit_count=1,
        sources=[TraceLaneSource(name="OIB-RL_2_Brandschutz.pdf", title="OIB-Richtlinie 2", detail="p.12")],
    )


def test_trace_lanes_sources_carry_the_display_title():
    """The fan-out must never make a user read a raw corpus filename."""
    (lane,) = _trace_lanes_for_chunks(
        [_chunk(file_name="oib-rl_2.3_ausgabe_mai_2023.pdf", page=4, collection="oib_knowledge")]
    )
    assert (lane.sources[0].name, lane.sources[0].title) == (
        "oib-rl_2.3_ausgabe_mai_2023.pdf",
        "OIB-Richtlinie 2.3, Ausgabe Mai 2023",
    )


def test_trace_lanes_omit_title_when_it_would_repeat_the_filename():
    """A project upload's filename IS its user-meaningful name — no redundancy."""
    (lane,) = _trace_lanes_for_chunks([_chunk(file_name="Konzept.pdf", page=1, collection="proj_abc")])
    assert (lane.sources[0].name, lane.sources[0].title) == ("Konzept.pdf", None)


def test_trace_lanes_sources_carry_the_retrieval_round():
    """The Herleitung assigns files by this stamp."""
    from aiq_agent.common.turn_status import retrieval_round_scope

    with retrieval_round_scope(1):
        (lane,) = _trace_lanes_for_chunks(
            [_chunk(file_name="Konzept.pdf", page=1, collection="proj_abc", shelf="project")]
        )
    assert lane.sources[0].round == 1


def test_emitted_hits_are_captured_for_the_per_round_ledger():
    """The ledger reads the capture, never the prose: same emission, both ships."""
    from aiq_agent.common.turn_status import begin_lane_capture
    from aiq_agent.common.turn_status import end_lane_capture
    from aiq_agent.common.turn_status import get_lane_captures
    from aiq_agent.common.turn_status import retrieval_round_scope

    token = begin_lane_capture()
    try:
        with retrieval_round_scope(0):
            _trace_lanes_for_chunks([_chunk(file_name="OIB-RL_2.pdf", page=12, collection="oib_knowledge")])
        with retrieval_round_scope(1):
            _trace_lanes_for_chunks([_chunk(file_name="OIB-RL_2.pdf", page=31, collection="oib_knowledge")])
        hits = get_lane_captures()
    finally:
        end_lane_capture(token)
    assert [(hit["round"], hit["name"], hit.get("detail")) for hit in hits] == [
        (0, "OIB-RL_2.pdf", "p.12"),
        (1, "OIB-RL_2.pdf", "p.31"),
    ]


def test_a_search_result_is_one_sources_step_built_from_its_records(emitted):
    """Through the real producer: the step carries the lanes the records made, and the tool that ran."""
    from aiq_agent.common.turn_status import READ_PASSAGE_TOOL
    from aiq_agent.common.turn_status import lane_tool_scope
    from aiq_agent.common.turn_status import retrieval_round_scope

    chunks = [_chunk(file_name="OIB-RL_4.pdf", page=3, collection="oib_knowledge")]
    with retrieval_round_scope(2), lane_tool_scope(READ_PASSAGE_TOOL):
        _format_results(SimpleNamespace(success=True, chunks=chunks, error_message=None), "q")
        lanes = list(_trace_lanes_for_chunks(chunks))
    (step,) = emitted.steps
    assert (step.kind, step.round, step.tool, step.lanes) == ("sources", 2, "read_passage", lanes)


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


# ---------------------------------------------------------------------------
# A document PILOTI wrote, that a person released (docs/architecture/
# agent-document-provenance.md)
# ---------------------------------------------------------------------------

_PILOTI = {
    "authored_by": "agent",
    "approved_by": "Maria Huber",
    "approved_at": "2026-09-01",
    "producer": "piloti-chat",
}


def test_a_published_piloti_document_gets_its_own_lane_inside_the_office_kind():
    (lane,) = _trace_lanes_for_chunks(
        [
            _chunk(
                file_name="Brandschutzkonzept Haus B.md",
                page=1,
                collection="proj_abc",
                shelf="project",
                provenance=_PILOTI,
            )
        ]
    )
    # The shelf says project. Without the provenance rule this lane would be
    # "projekt"/"Projektwissen" and nothing would say who wrote the document.
    assert (lane.key, lane.label, lane.kind) == ("buero_piloti", "Piloti-Dokument", "buero")


def test_the_fan_out_carries_the_provenance_as_data_not_as_a_sentence():
    """So a frontend can render the approver in the reader's own locale."""
    (lane,) = _trace_lanes_for_chunks([_chunk(file_name="Konzept.md", page=1, shelf="project", provenance=_PILOTI)])
    assert (lane.sources[0].provenance, lane.sources[0].shelf) == (_PILOTI, "project")


def test_an_unmarked_hit_carries_no_provenance_at_all():
    (lane,) = _trace_lanes_for_chunks([_chunk(file_name="Konzept.pdf", page=1, shelf="project")])
    assert lane.sources[0].provenance is None


def test_the_grounding_block_states_who_released_the_document_in_one_line():
    result = SimpleNamespace(
        success=True,
        chunks=[_chunk(file_name="Brandschutzkonzept.md", page=1, shelf="project", provenance=_PILOTI)],
        error_message=None,
    )
    text = _format_results(result, "brandschutz")
    assert "Herkunft: Piloti-Dokument · freigegeben von Maria Huber am 01.09.2026" in text
    # One line, and no sentence for the model to copy into an answer.
    assert "freigegeben" not in text.replace(
        "Herkunft: Piloti-Dokument · freigegeben von Maria Huber am 01.09.2026", ""
    )


def test_an_unmarked_hit_is_formatted_exactly_as_before():
    """Every human document in the corpus is this case, and it must not move."""
    chunk = _chunk(file_name="Konzept.pdf", page=1, shelf="project")
    text = _format_results(SimpleNamespace(success=True, chunks=[chunk], error_message=None), "q")
    assert "Herkunft" not in text

"""Every producer family, run inside a compiled graph and read off its custom stream.

Chat wire v2 (``docs/design/chat-wire-v2.md`` §b) has no queue of its own: a
producer calls ``turn_status.emit_step`` and LangGraph's writer carries the
body. So what is asserted here is the stream a graph run under
``astream(stream_mode=["custom"])`` really yields, body for body, and that the
setup phase, which runs before any graph, RETURNS its steps rather than
emitting them.
"""

from __future__ import annotations

import asyncio

from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.graph import END
from langgraph.graph import START
from langgraph.graph import MessagesState
from langgraph.graph import StateGraph
from langgraph.prebuilt import ToolNode

from aiq_agent.common import decisions
from aiq_agent.common import turn_status
from aiq_agent.common.grounding_block import GroundingBlock
from aiq_agent.common.grounding_block import GroundingHit
from aiq_agent.common.grounding_block import render_grounding_block
from aiq_agent.common.wire_v2 import RetrievalStep
from aiq_agent.common.wire_v2 import SkillStep
from aiq_agent.common.wire_v2 import SourcesStep
from aiq_agent.common.wire_v2 import StatusStep
from aiq_agent.common.wire_v2 import StepFinishedBody
from aiq_agent.common.wire_v2 import StepStartedBody
from aiq_agent.common.wire_v2 import ToolStep
from aiq_agent.common.wire_v2 import TraceLane
from aiq_agent.common.wire_v2 import TraceLaneSource
from aiq_agent.skills.events import emit_skill_activated
from aiq_agent.skills.models import Skill
from tests.conftest import stream_custom


def _finished(step) -> StepFinishedBody:
    return StepFinishedBody(step=step)


async def test_a_status_line_is_one_finished_step() -> None:
    async def work() -> None:
        turn_status.emit_citation_check(source_count=3)

    assert await stream_custom(work) == [
        _finished(
            StatusStep(id="status:citations", slot="citations", key="status.citations", detail={"source_count": 3})
        )
    ]


async def test_a_retrieval_round_is_its_step_and_its_checkpoint_record() -> None:
    async def work() -> None:
        turn_status.emit_retrieval(
            [{"name": "knowledge_search", "args": {"query": "Fluchtweglänge GK4", "conclusion": "Grundregel fehlt."}}],
            round_index=0,
        )

    assert await stream_custom(work) == [
        _finished(
            RetrievalStep(
                id="status:retrieval:0",
                round=0,
                key="status.retrieval.withQuery",
                values={"corpus": "knowledge", "query": "Fluchtweglänge GK4"},
                tools=["knowledge_search"],
                reason="Grundregel fehlt.",
            )
        ),
        _finished(
            StatusStep(
                id="status:checkpoint:0",
                slot="checkpoint:0",
                channel="technical",
                detail={"round": 0, "hasConclusion": True, "source": "argument"},
            )
        ),
    ]


async def test_a_decision_record_is_a_technical_step() -> None:
    async def work() -> None:
        decisions.record_skipped("turn", "too_short")

    assert await stream_custom(work) == [
        _finished(
            StatusStep(
                id="status:decision:turn", slot="decision:turn", channel="technical", detail={"skipped": "too_short"}
            )
        )
    ]


async def test_a_skill_activation_is_a_skill_step() -> None:
    skill = Skill(name="bsn", description="d", body="b", metadata={"grid-title": "Brandschutznachweis"})

    async def work() -> None:
        emit_skill_activated(skill)

    assert await stream_custom(work) == [
        _finished(SkillStep(id="skill:bsn", phase="activated", skill="bsn", title="Brandschutznachweis"))
    ]


LANES = (
    TraceLane(
        key="projekt",
        label="Projektwissen",
        kind="projekt",
        hit_count=1,
        sources=[TraceLaneSource(name="plan.pdf", detail="p.4", shelf="project", round=1)],
    ),
)

HIT = GroundingHit(
    citation_key="plan.pdf, p.4",
    file_name="plan.pdf",
    page=4,
    shelf=None,
    collection=None,
    doc_class=None,
    display_title="plan.pdf",
    folder_path=None,
    punkt=None,
    score=0.5,
    content_type="text",
    provenance=None,
    stored_image_index=None,
    status_note=None,
    body="Fluchtwege.",
)


async def test_an_evidence_tool_is_one_sources_step_from_its_records_even_off_the_loop() -> None:
    """The knowledge layer renders in ``asyncio.to_thread``; the writer must still reach it."""
    block = GroundingBlock(preamble="Found 1", degraded_banner="", hits=(HIT,), lanes=LANES, tool="knowledge_search")

    async def work() -> None:
        with turn_status.retrieval_round_scope(1):
            await asyncio.to_thread(render_grounding_block, block)

    (body,) = await stream_custom(work)
    assert body == _finished(SourcesStep(id=body.step.id, round=1, tool="knowledge_search", lanes=list(LANES)))


@tool
async def fetch_plan(q: str) -> str:
    """Return a plan."""
    return "the whole passage, which never reaches the wire"


@tool
async def broken_probe(q: str) -> str:
    """Fail."""
    raise ValueError("secret stack detail")


async def test_every_tool_call_is_a_started_and_a_finished_step_with_its_basename_only() -> None:
    """One callback on the run config sees every tool, and says only which one ran and how it ended."""
    builder = StateGraph(MessagesState)
    builder.add_node("tools", ToolNode([fetch_plan, broken_probe], handle_tool_errors=True))
    builder.add_edge(START, "tools")
    builder.add_edge("tools", END)
    calls = [
        {"name": "fetch_plan", "args": {"q": "a"}, "id": "c1"},
        {"name": "broken_probe", "args": {"q": "b"}, "id": "c2"},
    ]

    bodies = [
        chunk
        async for _mode, chunk in builder.compile().astream(
            {"messages": [AIMessage(content="", tool_calls=calls)]},
            config={"callbacks": [turn_status.ToolStepCallback()]},
            stream_mode=["custom"],
        )
    ]

    by_tool = {(type(body).__name__, body.step.tool, body.step.status) for body in bodies}
    assert by_tool == {
        ("StepStartedBody", "fetch_plan", "running"),
        ("StepFinishedBody", "fetch_plan", "ok"),
        ("StepStartedBody", "broken_probe", "running"),
        ("StepFinishedBody", "broken_probe", "error"),
    }
    for started in (body for body in bodies if isinstance(body, StepStartedBody)):
        finished = next(b for b in bodies if isinstance(b, StepFinishedBody) and b.step.id == started.step.id)
        assert isinstance(finished.step, ToolStep)
    assert all("passage" not in body.model_dump_json() and "secret" not in body.model_dump_json() for body in bodies)


async def test_a_step_emitted_inside_deep_research_carries_its_scope() -> None:
    async def work() -> None:
        with turn_status.step_scope("deep"):
            turn_status.emit_synthesis()
        turn_status.emit_citation_check()

    assert [body.step.scope for body in await stream_custom(work)] == ["deep", "chat"]


async def test_the_setup_phase_returns_its_steps_and_emits_nothing() -> None:
    """``_run`` yields these before the graph starts; inside a graph they still only return."""
    returned = []

    async def work() -> None:
        returned.append(turn_status.documents_loading_step(["project"]))
        returned.append(turn_status.documents_waiting_step(file_count=2))
        returned.append(turn_status.subject_document_step(loaded=True, path="/entwuerfe/a.md"))

    assert await stream_custom(work) == []
    assert [step.id for step in returned] == [
        "status:documents",
        "status:documents:waiting",
        "status:documents:subject",
    ]


def test_outside_a_graph_run_emission_is_a_no_op() -> None:
    """Outside any runnable (the setup phase), and inside one that is not a graph (a tool called directly)."""
    turn_status.emit_citation_check()
    assert asyncio.run(fetch_plan.ainvoke({"q": "a"}, config={"callbacks": [turn_status.ToolStepCallback()]}))

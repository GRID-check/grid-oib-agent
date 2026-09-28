"""One whole turn through the real workflow, compared frame for frame with a committed golden (chat wire v2 §g).

The turn is the real ``_run``: the request parse, the setup phase, admission,
the registries, the conversation graph under ``astream``, the result lift. The
answering agent is the one seam: it crosses NAT's function boundary the way
``Function.ainvoke`` does (``Context.push_active_function``) into an inner
LangGraph run with a config of its own, the shape of Piloti's
``agent._graph_config``, and there a fake LLM streams a recorded envelope
through the real token handler. So the bodies asserted here are the ones the
graph's own writer carried out of Piloti's inner graph, which is the reach
``test_stream_writer_reach.py`` stands in for.

The frames are stamped as the socket stamps them (``RUN_STARTED`` first, one
``seq`` each) and compared with ``tests/fixtures/wire_v2/golden_turn.jsonl``,
``ts`` excepted. Regenerate it after a deliberate wire change with
``GRID_REGEN_GOLDEN=1``, and read the diff.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import TypedDict

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.language_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langgraph.graph import END
from langgraph.graph import START
from langgraph.graph import StateGraph

from aiq_agent.agents.piloti import conversation_register as register_mod
from aiq_agent.agents.piloti.answer_pipeline import SettledStream
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import turn_status
from aiq_agent.common.wire_v2 import WIRE_EVENT
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import RunStartedBody
from aiq_agent.common.wire_v2 import StatusStep
from aiq_agent.common.wire_v2 import TextMessageStartBody
from aiq_agent.common.wire_v2 import UserMessage
from aiq_agent.common.wire_v2 import stamp
from aiq_agent.common.wire_v2 import to_frame
from aiq_agent.turn import answer_stream
from aiq_agent.turn.answer_stream import streaming_call
from nat.plugin_api import Context

GOLDEN = Path(__file__).resolve().parents[4] / "fixtures" / "wire_v2" / "golden_turn.jsonl"
CONVERSATION_ID = "5f5b7a5c-1f0e-4a9d-9c3a-2f2f9a1b7c11"
TURN_ID = "msg_1759000000000_3"

PROSE = "Für **Gebäudeklasse 4** darf die Gehweglänge zu einem Treppenhaus höchstens **40 m** betragen [1]."
SETTLED = PROSE
ENVELOPE = (
    "```answer_json\n"
    + json.dumps(
        {
            "kind": "ruling",
            "topic": "Fluchtweglänge",
            "verdict": "40 m",
            "answer": PROSE + "\n\n**Quellen:**\n- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.12",
            "cards": [{"type": "verdict_header", "verdict": "40 m"}, {"type": "broken"}],
        },
        ensure_ascii=False,
    )
    + "\n```"
)
SOURCE = {
    "content": "[OIB] oib-rl_2_ausgabe_mai_2023.pdf#p12",
    "number": 1,
    "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
}


class _Live:
    """What ``LiveAnswer`` shows before the pipeline ran: the masthead, the settled prose, the cards."""

    def masthead(self, fields, prose=""):
        return {"kind": fields["kind"], "topic": fields["topic"], "verdict": fields["verdict"]}

    def settle(self, prose, sources_text, fields):
        return SettledStream(content=SETTLED, sources=[SOURCE], answer_meta=self.masthead(fields))

    def tool_cards(self):
        return []

    def place(self, text):
        return text

    def card(self, payload):
        return None if payload["type"] == "broken" else payload


class _Inner(TypedDict, total=False):
    reply: object


async def _inner_answer(_state):
    turn_status.emit_step(StatusStep(id="status:synthesis", slot="synthesis", key="status.synthesis"))
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)]))
    answering, config = streaming_call(llm, live=_Live())
    return {"reply": await answering.ainvoke([HumanMessage(content="Fluchtweg GK 4?")], config)}


def _inner_graph():
    builder = StateGraph(_Inner)
    builder.add_node("agent", _inner_answer)
    builder.add_edge(START, "agent")
    builder.add_edge("agent", END)
    return builder.compile()


_INNER = _inner_graph()


class _OwnCallbacks(AsyncCallbackHandler):
    """Piloti's inner graph passes callbacks of its own (``agent._graph_config``)."""


async def _piloti_behind_its_nat_function(state):
    """What NAT's ``Function.ainvoke`` does around Piloti: push the function, await it in the same task."""
    with Context.get().push_active_function("shallow_research_agent", input_data=None):
        config = {"recursion_limit": 50, "configurable": {"binding": object()}, "callbacks": [_OwnCallbacks()]}
        await _INNER.ainvoke({}, config=config)
    return ResearchAgentState(
        messages=list(state.messages) + [AIMessage(content=PROSE)],
        escalation_requested=False,
        source_lookup_attempted=True,
        answer_citation_grounded=True,
        answer_confidence_marker="high",
        verified_sources=[SOURCE],
        answer_meta={"kind": "ruling", "topic": "Fluchtweglänge", "verdict": "40 m"},
    )


def _frames(bodies, message_id) -> list[dict]:
    """Stamped as the socket stamps them: RUN_STARTED is seq 1, every body after it the next seq."""
    stamped = [RunStartedBody(message_id=message_id), *bodies]
    return [
        to_frame(stamp(body, conversation_id=CONVERSATION_ID, turn_id=TURN_ID, seq=seq, ts=0))
        for seq, body in enumerate(stamped, start=1)
    ]


async def _golden_turn(workflow_harness, monkeypatch) -> list[dict]:
    monkeypatch.setattr(answer_stream.time, "monotonic", lambda: 0.0)
    monkeypatch.setattr(register_mod, "answer_streaming_enabled", lambda: True)
    loading = StatusStep(id="status:documents", slot="documents", key="status.documents.project")
    monkeypatch.setattr(register_mod, "documents_loading_step", lambda _shelves: loading)
    workflow_harness["shallow"] = _piloti_behind_its_nat_function
    bodies = await workflow_harness["turn"](
        UserMessage(conversation_id="conv-1", message_id="msg-1", text="Wie lang darf der Fluchtweg in GK 4 sein?")
    )
    message_id = next(body.message_id for body in bodies if isinstance(body, TextMessageStartBody))
    return _frames(bodies, message_id)


async def test_the_turn_is_the_golden_frame_for_frame(workflow_harness, monkeypatch):
    frames = await _golden_turn(workflow_harness, monkeypatch)
    lines = [json.dumps({k: v for k, v in frame.items() if k != "ts"}, ensure_ascii=False) for frame in frames]
    if os.environ.get("GRID_REGEN_GOLDEN"):
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert lines == GOLDEN.read_text(encoding="utf-8").splitlines()


async def test_every_frame_is_valid_small_and_the_terminal_is_last(workflow_harness, monkeypatch):
    frames = await _golden_turn(workflow_harness, monkeypatch)
    for frame in frames:
        assert to_frame(WIRE_EVENT.validate_python(frame)) == frame
    assert [frame["seq"] for frame in frames] == list(range(1, len(frames) + 1))
    assert [frame["type"] for frame in frames].count("RUN_FINISHED") == 1 and frames[-1]["type"] == "RUN_FINISHED"
    for frame in frames[:-1]:
        assert len(json.dumps(frame).encode()) < 4096
    assert len(json.dumps(frames[-1]).encode()) < 65536


async def test_the_writer_reaches_the_inner_graph_through_the_nat_boundary(workflow_harness, monkeypatch):
    """The status step and the prose were written inside Piloti's own graph run, and reached `_run`."""
    frames = await _golden_turn(workflow_harness, monkeypatch)
    types = [frame["type"] if frame["type"] != "CUSTOM" else frame["name"] for frame in frames]
    assert "TEXT_MESSAGE_CONTENT" in types and "STATE_SNAPSHOT" in types
    assert {"id": "status:synthesis", "kind": "status", "slot": "synthesis", "key": "status.synthesis"} in [
        frame.get("step") for frame in frames
    ]
    terminal = RunFinishedBody.model_validate(
        {k: v for k, v in frames[-1].items() if k in ("type", "outcome", "result")}
    )
    assert terminal.result.text == PROSE

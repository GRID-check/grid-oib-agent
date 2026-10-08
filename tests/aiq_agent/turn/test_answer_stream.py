"""The answer's prose on the wire while the final call writes it (ADR-0066, chat wire v2 §b).

Every test here runs the answering call inside a real LangGraph node under
``astream(stream_mode="custom")``, so what is asserted is what the graph's own
writer carried: the bodies a turn's socket would send, in order.
"""

from __future__ import annotations

import json
import re
from typing import TypedDict

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.language_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langgraph.graph import END
from langgraph.graph import START
from langgraph.graph import StateGraph

from aiq_agent.agents.piloti.answer_pipeline import SettledStream
from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import CardBody
from aiq_agent.common.wire_v2 import CardRefusedBody
from aiq_agent.common.wire_v2 import MastheadBody
from aiq_agent.common.wire_v2 import StateSnapshotBody
from aiq_agent.common.wire_v2 import TextMessageContentBody
from aiq_agent.common.wire_v2 import TextMessageEndBody
from aiq_agent.common.wire_v2 import TextMessageStartBody
from aiq_agent.turn import answer_stream
from aiq_agent.turn.answer_stream import LiveProse
from aiq_agent.turn.answer_stream import bound_live_prose
from aiq_agent.turn.answer_stream import streaming_call

ENVELOPE = (
    "```answer_json\n"
    + json.dumps(
        {"answer": "In GK 4 gilt ein Fluchtweg von höchstens 40 m [1].\n\n**Quellen:**\n- [1] oib-rl_2.pdf, p.12"}
    )
    + "\n```"
)


class _Counter(AsyncCallbackHandler):
    def __init__(self) -> None:
        self.starts = 0

    async def on_chat_model_start(self, *args, **kwargs) -> None:
        self.starts += 1


def _text(bodies) -> str:
    return "".join(body.delta for body in bodies if isinstance(body, TextMessageContentBody))


def _of(bodies, kind):
    return [body for body in bodies if isinstance(body, kind)]


def _settled(content: str, sources=()) -> SettledStream:
    return SettledStream(content=content, sources=list(sources))


class _Live:
    """A LiveAnswer double: records what it was asked, answers what the test set."""

    def __init__(self, settled=None, masthead=None, card=lambda payload: payload, raises=False, tool_cards=()):
        self.settled, self._masthead, self._card, self.raises = settled, masthead, card, raises
        self._tool_cards = list(tool_cards)
        self.asked: list[tuple] = []

    def tool_cards(self):
        return list(self._tool_cards)

    def place(self, text):
        # The real move (``LiveAnswer.place``): array card N behind the tools' cards.
        offset = len(self._tool_cards)
        return re.sub(r"\[\[card:(\d+)\]\]", lambda m: f"[[card:{int(m.group(1)) + offset}]]", text)

    def masthead(self, fields, prose=""):
        self.asked.append(("masthead", fields))
        return self._masthead

    def settle(self, prose, sources_text, fields):
        self.asked.append(("settle", prose, sources_text, fields))
        if self.raises:
            raise ValueError("registry gone")
        return self.settled

    def card(self, payload):
        return self._card(payload)


class _State(TypedDict, total=False):
    reply: object


async def _answer_in_a_node(llm, parent: _Counter, live=None, prose: LiveProse | None = None):
    """The answering call in a graph node under ``astream``: its reply, the bodies it wrote, the turn's prose."""

    async def node(_state):
        answering, config = streaming_call(llm, live=live)
        return {"reply": await answering.ainvoke([HumanMessage(content="Fluchtweg GK 4?")], config)}

    builder = StateGraph(_State)
    builder.add_node("answer", node)
    builder.add_edge(START, "answer")
    builder.add_edge("answer", END)
    graph = builder.compile()
    bodies, reply = [], None
    with bound_live_prose("m1") as bound:
        if prose is not None:
            bound.streamed = prose.streamed
        async for mode, chunk in graph.astream({}, config={"callbacks": [parent]}, stream_mode=["custom", "values"]):
            if mode == "custom":
                bodies.append(chunk)
            else:
                reply = chunk.get("reply")
    return reply, bodies, bound


async def test_the_answering_call_streams_its_prose_and_the_profiler_still_sees_it():
    parent = _Counter()
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)]))

    message, bodies, prose = await _answer_in_a_node(llm, parent)

    assert message.content == ENVELOPE  # the reply the pipeline reads is unchanged
    assert parent.starts == 1  # the inherited handlers were added to, not replaced
    assert prose.streamed
    # The marker streams as written; the sources section does not.
    assert _text(bodies).rstrip() == "In GK 4 gilt ein Fluchtweg von höchstens 40 m [1]."
    assert bodies[0] == TextMessageStartBody(message_id="m1")
    assert bodies[-1] == TextMessageEndBody(message_id="m1")
    assert {body.message_id for body in bodies} == {"m1"}


async def test_a_round_that_is_not_an_envelope_streams_nothing():
    llm = GenericFakeChatModel(messages=iter([AIMessage(content="Ich suche zuerst in der OIB-RL 2.")]))
    _, bodies, prose = await _answer_in_a_node(llm, _Counter())
    assert not prose.streamed and bodies == []


async def test_once_prose_went_out_no_later_call_streams():
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)]))
    with bound_live_prose("m1") as prose:
        prose.streamed = True
        answering, config = streaming_call(llm)
    assert answering is llm and config is None


def test_the_answer_streams_unless_the_platform_switch_is_off(monkeypatch):
    from aiq_agent.common import retrieval_settings

    settings: dict[str, int] = {}
    monkeypatch.setattr(retrieval_settings, "_resolve", lambda: settings)
    assert answer_stream.answer_streaming_enabled() is True
    settings["chat.answer_streaming"] = 0
    assert answer_stream.answer_streaming_enabled() is False
    settings["chat.answer_streaming"] = 1
    assert answer_stream.answer_streaming_enabled() is True


def test_without_live_prose_bound_the_call_is_the_buffered_one():
    llm = GenericFakeChatModel(messages=iter([]))
    assert streaming_call(llm) == (llm, None)


async def test_the_closed_answer_is_settled_into_one_snapshot():
    """The markers already on screen become the answer's citations before the cards arrive."""
    live = _Live(settled=_settled("In GK 4 gilt … 40 m [1].", [{"content": "[OIB] a.pdf", "number": 1}]))
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)]))
    _, bodies, _ = await _answer_in_a_node(llm, _Counter(), live)

    (snapshot,) = _of(bodies, StateSnapshotBody)
    assert snapshot.snapshot.sources[0].number == 1
    # END, then the snapshot: after every delta it settles.
    assert bodies[-2:] == [TextMessageEndBody(message_id="m1"), snapshot]
    _, prose, sources_text, _fields = live.asked[-1]
    assert prose.rstrip().endswith("40 m [1].") and sources_text.startswith("**Quellen:**")


async def test_a_settle_that_raises_leaves_the_markers_pending():
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)]))
    _, bodies, _ = await _answer_in_a_node(llm, _Counter(), _Live(raises=True))
    assert _of(bodies, StateSnapshotBody) == []
    assert _text(bodies)


async def test_the_masthead_goes_out_before_the_first_word_and_the_cards_after_the_prose():
    reply = (
        "```answer_json\n"
        + json.dumps(
            {
                "kind": "ruling",
                "topic": "Fluchtweg",
                "answer": "In GK 4 gilt ein Fluchtweg von höchstens 40 m [1].\n\n**Quellen:**\n- [1] a.pdf, p.1",
                "cards": [{"type": "table"}, {"type": "broken"}, {"type": "surface"}],
            }
        )
        + "\n```"
    )
    live = _Live(
        settled=_settled("…"),
        masthead={"v": 1, "kind": "ruling", "topic": "Fluchtweg"},
        card=lambda payload: None if payload["type"] == "broken" else payload,
    )
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=reply)]))
    _, bodies, _ = await _answer_in_a_node(llm, _Counter(), live)

    assert isinstance(bodies[0], MastheadBody) and bodies[0].value.answer_meta["topic"] == "Fluchtweg"
    kinds = [type(body) for body in bodies]
    assert kinds.index(StateSnapshotBody) < kinds.index(CardBody)
    # A refused card keeps its place, so [[card:3]] still finds the surface.
    cards = [(b.value.index, b.value.card["type"]) for b in _of(bodies, CardBody)]
    assert cards == [(0, "table"), (2, "surface")]
    assert [b.value.index for b in _of(bodies, CardRefusedBody)] == [1]


def _envelope_with_cards(answer: str, cards: list[dict]) -> str:
    return "```answer_json\n" + json.dumps({"answer": answer, "cards": cards}) + "\n```"


async def test_a_tools_card_heads_the_live_list_and_the_markers_follow_it():
    # The terminal lists the tools' cards first and moves the model's
    # [[card:1]] behind them; the live events must say the same, or the
    # envelope card lands on the tool's place and the draft's key shifts.
    draft = {"type": "document_draft", "path": "a.md"}
    reply = _envelope_with_cards(
        "Der Entwurf liegt vor.\n\n[[card:1]]\n\nSiehe oben [1].\n\n**Quellen:**\n- [1] a.pdf, p.1",
        [{"type": "table"}],
    )
    live = _Live(settled=_settled("Der Entwurf liegt vor.\n\n[[card:1]]\n\nSiehe oben [1]."), tool_cards=[draft])
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=reply)]))
    _, bodies, _ = await _answer_in_a_node(llm, _Counter(), live)

    text = _text(bodies)
    assert "[[card:2]]" in text and "[[card:1]]" not in text
    (snapshot,) = _of(bodies, StateSnapshotBody)
    assert "[[card:2]]" in snapshot.snapshot.text and "[[card:1]]" not in snapshot.snapshot.text
    cards = [(b.value.index, b.value.card) for b in _of(bodies, CardBody)]
    # The tool's card with the settled prose, before the envelope's card closed.
    assert cards == [(0, draft), (1, {"type": "table"})]


async def test_a_tools_card_goes_out_with_the_settled_prose_when_the_envelope_has_none():
    draft = {"type": "document_draft", "path": "a.md"}
    live = _Live(settled=_settled("…"), tool_cards=[draft])
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)]))
    _, bodies, _ = await _answer_in_a_node(llm, _Counter(), live)

    kinds = [type(body) for body in bodies]
    assert kinds.index(StateSnapshotBody) < kinds.index(CardBody)
    assert [b.value.card for b in _of(bodies, CardBody)] == [draft]


async def test_without_a_tools_card_no_card_goes_out_for_an_envelope_without_cards():
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)]))
    _, bodies, _ = await _answer_in_a_node(llm, _Counter(), _Live(settled=_settled("…")))
    assert _of(bodies, CardBody) == [] and _of(bodies, CardRefusedBody) == []


async def test_deltas_are_coalesced_at_the_producer_and_flushed_before_any_other_body(monkeypatch):
    """At most one CONTENT per window; what the window held goes out before END, so order holds.

    The clock stands still: the first delta goes out at once (time to first
    prose), every later one falls inside the same window and waits for END.
    """
    monkeypatch.setattr(answer_stream.time, "monotonic", lambda: 0.0)
    answer = "Ein Satz [1] und noch einer. Und ein zweiter Satz folgt hier."
    reply = "```answer_json\n" + json.dumps({"answer": answer}) + "\n```"
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=reply)]))

    _, bodies, _ = await _answer_in_a_node(llm, _Counter())

    deltas = [body.delta for body in _of(bodies, TextMessageContentBody)]
    assert len(deltas) == 2, "the first delta at once, the rest in one body at END, never one per token"
    assert "".join(deltas) == answer
    assert isinstance(bodies[-2], TextMessageContentBody) and isinstance(bodies[-1], TextMessageEndBody)


def test_a_responses_api_token_is_its_text_blocks_and_never_its_reasoning():
    # Seen live: the Responses API hands on_llm_new_token the chunk's content
    # blocks, and a handler that read only strings streamed nothing.
    from aiq_agent.turn.answer_stream import token_text

    blocks = [{"type": "reasoning", "summary": [{"text": "denke"}]}, {"type": "text", "text": "Hallo", "index": 0}]
    assert token_text(blocks) == "Hallo"
    assert token_text("Welt") == "Welt"
    assert token_text(None) == ""


async def test_a_call_that_also_asks_for_tools_takes_back_what_it_showed():
    """An envelope with a tool call is a round, not the answer: its prose must not stay as the answer."""
    from langchain_core.language_models import BaseChatModel
    from langchain_core.messages import AIMessageChunk
    from langchain_core.outputs import ChatGeneration
    from langchain_core.outputs import ChatGenerationChunk
    from langchain_core.outputs import ChatResult

    class _ToolRound(BaseChatModel):
        """Streams the envelope, then a tool call: what GenericFakeChatModel cannot stream."""

        @property
        def _llm_type(self) -> str:
            return "tool-round"

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content=ENVELOPE))])

        async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
            for start in range(0, len(ENVELOPE), 16):
                chunk = ChatGenerationChunk(message=AIMessageChunk(content=ENVELOPE[start : start + 16]))
                if run_manager:
                    await run_manager.on_llm_new_token(chunk.text, chunk=chunk)
                yield chunk
            call = {"name": "knowledge_search", "args": '{"query": "GK 4"}', "id": "c1", "index": 0}
            yield ChatGenerationChunk(message=AIMessageChunk(content="", tool_call_chunks=[call]))

    _, bodies, prose = await _answer_in_a_node(_ToolRound(), _Counter())

    assert _text(bodies)  # it did stream, before it knew
    assert isinstance(bodies[-1], AnswerRetractedBody)
    assert not prose.streamed  # the real answer, a later call, may stream


async def test_a_tool_round_that_showed_nothing_retracts_nothing(monkeypatch):
    """A masthead read but gated away, and no prose yet: there is nothing on the wire to take back."""
    from langchain_core.messages import AIMessageChunk
    from langchain_core.outputs import ChatGenerationChunk
    from langchain_core.outputs import LLMResult

    from aiq_agent.common import turn_status
    from aiq_agent.turn.answer_stream import _ProseTokenHandler

    written: list = []
    monkeypatch.setattr(turn_status, "emit", written.append)
    handler = _ProseTokenHandler(LiveProse("m1"), _Live(masthead=None))
    await handler.on_chat_model_start({}, [])
    await handler.on_llm_new_token('{"kind": "direct", "answer": "')
    call = {"name": "knowledge_search", "args": "{}", "id": "c1", "index": 0}
    message = AIMessageChunk(content="", tool_call_chunks=[call])
    await handler.on_llm_end(LLMResult(generations=[[ChatGenerationChunk(message=message)]]))

    assert written == []


async def test_the_settle_runs_off_the_event_loop():
    """Verification is fuzzy matching over every chunk; on the loop it stalls every turn the worker serves."""
    import threading

    threads: list[int] = []

    class _Recording(_Live):
        def settle(self, prose, sources_text, fields):
            threads.append(threading.get_ident())
            return super().settle(prose, sources_text, fields)

    live = _Recording(settled=_settled("x"))
    await _answer_in_a_node(GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)])), _Counter(), live)

    assert threads and threads[0] != threading.get_ident()

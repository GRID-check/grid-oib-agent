"""The answer's prose on the wire while the final call writes it (ADR-0066)."""

from __future__ import annotations

import asyncio
import json

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.language_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableLambda

from aiq_agent.turn.answer_stream import AnswerStreamSink
from aiq_agent.turn.answer_stream import bound_answer_stream
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


async def _answer_in_a_node(llm, sink: AnswerStreamSink, parent: _Counter) -> AIMessage:
    async def node(_):
        answering, config = streaming_call(llm)
        return await answering.ainvoke([HumanMessage(content="Fluchtweg GK 4?")], config)

    with bound_answer_stream(sink):
        return await RunnableLambda(node).ainvoke("x", config={"callbacks": [parent]})


async def test_the_answering_call_streams_its_prose_and_the_profiler_still_sees_it():
    sink, parent = AnswerStreamSink(), _Counter()
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)]))

    message = await _answer_in_a_node(llm, sink, parent)

    assert message.content == ENVELOPE  # the reply the pipeline reads is unchanged
    assert parent.starts == 1  # the inherited handlers were added to, not replaced
    assert sink.streamed
    assert sink._drain().rstrip() == "In GK 4 gilt ein Fluchtweg von höchstens 40 m."


async def test_a_round_that_is_not_an_envelope_streams_nothing():
    sink = AnswerStreamSink()
    llm = GenericFakeChatModel(messages=iter([AIMessage(content="Ich suche zuerst in der OIB-RL 2.")]))
    await _answer_in_a_node(llm, sink, _Counter())
    assert not sink.streamed and sink._drain() == ""


async def test_once_prose_went_out_no_later_call_streams():
    sink = AnswerStreamSink()
    sink.push("Schon gezeigt.")
    llm = GenericFakeChatModel(messages=iter([AIMessage(content=ENVELOPE)]))
    with bound_answer_stream(sink):
        answering, config = streaming_call(llm)
    assert answering is llm and config is None


def test_without_a_sink_the_call_is_the_buffered_one():
    llm = GenericFakeChatModel(messages=iter([]))
    assert streaming_call(llm) == (llm, None)


async def test_the_relay_sends_a_window_of_tokens_as_one_frame_and_drains_after():
    sink = AnswerStreamSink()

    async def answer() -> str:
        sink.push("Ein ")
        await asyncio.sleep(0.01)
        sink.push("Satz ")  # inside the window: the same frame
        await asyncio.sleep(0.2)
        sink.push("und noch einer.")  # after it: the next frame
        return "fertig"

    task = asyncio.create_task(answer())
    deltas = [delta async for delta in sink.relay(task)]
    assert deltas == ["Ein Satz ", "und noch einer."]
    assert await task == "fertig"


def test_a_responses_api_token_is_its_text_blocks_and_never_its_reasoning():
    # Seen live: the Responses API hands on_llm_new_token the chunk's content
    # blocks, and a handler that read only strings streamed nothing.
    from aiq_agent.turn.answer_stream import token_text

    blocks = [{"type": "reasoning", "summary": [{"text": "denke"}]}, {"type": "text", "text": "Hallo", "index": 0}]
    assert token_text(blocks) == "Hallo"
    assert token_text("Welt") == "Welt"
    assert token_text(None) == ""

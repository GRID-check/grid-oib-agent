"""Where LangGraph's custom-stream writer reaches: the assumption chat wire v2 is built on.

``docs/design/chat-wire-v2.md`` §b replaces the per-turn ``AnswerStreamSink``
queue with ``get_stream_writer()``: the conversation graph runs under
``astream(stream_mode=["custom", ...], subgraphs=True)`` and every producer
writes a wire body. That holds only if the writer reaches every place a
producer sits: a node of a graph that another node ``ainvoke``s through an
ordinary async function (Piloti's inner graph behind its NAT function), an LLM
token callback, a tool inside ``ToolNode``, a child task, and an
``asyncio.to_thread`` worker (the settle). It must also be a no-op under
``ainvoke`` (a deep-research job worker) and raise outside any graph (the setup
phase, which yields its steps itself).

This pins those facts against the installed LangGraph, so an upgrade that
changes them fails here instead of silently dropping the Herleitung.
"""

from __future__ import annotations

import asyncio
from typing import Any
from typing import TypedDict

import pytest
from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.config import get_stream_writer
from langgraph.graph import END
from langgraph.graph import START
from langgraph.graph import StateGraph
from langgraph.prebuilt import ToolNode

from nat.builder.context import Context


class _State(TypedDict, total=False):
    x: int


class _TokenCallback(AsyncCallbackHandler):
    async def on_llm_new_token(self, token: str, **kwargs: Any) -> None:
        get_stream_writer()({"from": "callback", "token": token})


@tool
async def _probe_tool(q: str) -> str:
    """Write from inside a tool."""
    get_stream_writer()({"from": "tool"})
    return "ok"


async def _inner_node(state: _State) -> _State:
    get_stream_writer()({"from": "inner_node"})
    async for _ in FakeListChatModel(responses=["ab"]).astream("hi", config={"callbacks": [_TokenCallback()]}):
        pass
    call = {"name": "_probe_tool", "args": {"q": "a"}, "id": "c1"}
    await ToolNode([_probe_tool]).ainvoke({"messages": [AIMessage(content="", tool_calls=[call])]})

    async def child() -> None:
        get_stream_writer()({"from": "child_task"})

    await asyncio.create_task(child())
    await asyncio.to_thread(lambda: get_stream_writer()({"from": "to_thread"}))
    return {"x": 1}


def _graph(node: Any) -> Any:
    builder = StateGraph(_State)
    builder.add_node("n", node)
    builder.add_edge(START, "n")
    builder.add_edge("n", END)
    return builder.compile()


_INNER = _graph(_inner_node)


class _OwnCallbacks(AsyncCallbackHandler):
    """Piloti's inner graph passes callbacks of its own (``agent._graph_config``)."""


async def _through_a_function_boundary(state: _State) -> _State:
    """What NAT's ``Function.ainvoke`` does between the conversation graph and Piloti's.

    It pushes the active function on NAT's context and awaits the function in
    the same task (``nat/builder/function.py``), and the inner graph is invoked
    with a config of its own: its own ``configurable`` and ``callbacks``
    (``agent._graph_config``). Neither may cut the custom stream.
    """
    with Context.get().push_active_function("shallow_research_agent", input_data=state):
        config = {"recursion_limit": 50, "configurable": {"binding": object()}, "callbacks": [_OwnCallbacks()]}
        return await _INNER.ainvoke(state, config=config)


async def _outer_node(state: _State) -> _State:
    get_stream_writer()({"from": "outer_node"})
    await _through_a_function_boundary(state)
    return {"x": 2}


_OUTER = _graph(_outer_node)


async def test_the_writer_reaches_every_producer_site_under_astream() -> None:
    written = [
        chunk["from"]
        async for _, mode, chunk in _OUTER.astream({"x": 0}, stream_mode=["custom"], subgraphs=True)
        if mode == "custom"
    ]
    assert written == ["outer_node", "inner_node", "callback", "callback", "tool", "child_task", "to_thread"]


async def test_the_writer_is_a_no_op_under_ainvoke() -> None:
    assert (await _OUTER.ainvoke({"x": 0}))["x"] == 2


def test_the_writer_raises_outside_a_graph() -> None:
    with pytest.raises(RuntimeError):
        get_stream_writer()

"""The write fence: a turn that lost its conversation cannot write the conversation's thread (ADR-0079)."""

from __future__ import annotations

import asyncio
import inspect
from typing import Annotated
from typing import TypedDict

import pytest
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END
from langgraph.graph import START
from langgraph.graph import StateGraph
from langgraph.graph.message import add_messages

from aiq_agent.common.fenced_checkpointer import FencedCheckpointer
from aiq_agent.common.write_fence import TurnFenced
from aiq_agent.common.write_fence import bind_write_fence
from aiq_agent.common.write_fence import guarded_write
from aiq_agent.common.write_fence import unbind_write_fence

THREAD = {"configurable": {"thread_id": "t", "checkpoint_ns": ""}}


class Fence:
    """A fence the test closes by hand."""

    def __init__(self, write_timeout: float = 0.2) -> None:
        self.closed = False
        self.write_timeout = write_timeout

    def fenced(self) -> bool:
        return self.closed


class RecordingSaver(InMemorySaver):
    """An in-memory saver that says how many checkpoints it was asked to commit, and can be slow."""

    def __init__(self, delay: float = 0.0) -> None:
        super().__init__()
        self.commits = 0
        self.delay = delay

    async def aput(self, config, checkpoint, metadata, new_versions):
        await asyncio.sleep(self.delay)
        self.commits += 1
        return await super().aput(config, checkpoint, metadata, new_versions)


def _checkpoint(saver: BaseCheckpointSaver, n: int = 1):
    from langgraph.checkpoint.base import empty_checkpoint

    checkpoint = empty_checkpoint()
    checkpoint["id"] = f"1ef4f797-8335-6428-8001-8a1503f9b8{n:02d}"
    return checkpoint


async def test_a_write_without_a_fence_goes_straight_through():
    saver = RecordingSaver()
    await FencedCheckpointer(saver).aput(THREAD, _checkpoint(saver), {}, {})

    assert saver.commits == 1


async def test_a_write_is_refused_once_the_fence_is_closed_and_a_read_is_not():
    saver = RecordingSaver()
    fenced = FencedCheckpointer(saver)
    fence = Fence()
    token = bind_write_fence(fence)
    try:
        await fenced.aput(THREAD, _checkpoint(saver, 1), {}, {})
        fence.closed = True
        with pytest.raises(TurnFenced):
            await fenced.aput(THREAD, _checkpoint(saver, 2), {}, {})
        with pytest.raises(TurnFenced):
            await fenced.aput_writes(THREAD, [("c", 1)], "task")
        with pytest.raises(TurnFenced):
            await fenced.adelete_thread("t")
        with pytest.raises(TurnFenced):
            fenced.put(THREAD, _checkpoint(saver, 3), {}, {})
        assert await fenced.aget_tuple(THREAD) is not None  # reading what is there stays allowed
    finally:
        unbind_write_fence(token)

    assert saver.commits == 1


async def test_a_write_in_flight_is_bounded_by_the_write_timeout():
    saver = RecordingSaver(delay=5.0)
    token = bind_write_fence(Fence(write_timeout=0.05))
    try:
        started = asyncio.get_running_loop().time()
        with pytest.raises(TimeoutError):
            await FencedCheckpointer(saver).aput(THREAD, _checkpoint(saver), {}, {})
    finally:
        unbind_write_fence(token)

    assert asyncio.get_running_loop().time() - started < 1.0
    assert saver.commits == 0


async def test_the_fence_reaches_the_tasks_a_graph_spawns():
    """LangGraph writes its checkpoints from tasks of its own; they inherit the turn's fence."""

    class State(TypedDict):
        messages: Annotated[list, add_messages]

    fence = Fence()

    def first(state: State) -> dict:
        return {"messages": [("ai", "one")]}

    def second(state: State) -> dict:
        fence.closed = True  # the marker is lost between two steps of the turn
        return {"messages": [("ai", "two")]}

    def third(state: State) -> dict:
        return {"messages": [("ai", "three")]}

    builder = StateGraph(State)
    for name, node in (("first", first), ("second", second), ("third", third)):
        builder.add_node(name, node)
    builder.add_edge(START, "first")
    builder.add_edge("first", "second")
    builder.add_edge("second", "third")
    builder.add_edge("third", END)
    saver = RecordingSaver()
    graph = builder.compile(checkpointer=FencedCheckpointer(saver))

    token = bind_write_fence(fence)
    try:
        with pytest.raises(TurnFenced):
            await graph.ainvoke({"messages": [("human", "q")]}, THREAD)
    finally:
        unbind_write_fence(token)

    committed = [item async for item in saver.alist(THREAD)]
    assert all("three" not in str(item.checkpoint["channel_values"]) for item in committed)


async def test_a_graph_run_without_a_fence_is_unchanged():
    class State(TypedDict):
        messages: Annotated[list, add_messages]

    builder = StateGraph(State)
    builder.add_node("only", lambda state: {"messages": [("ai", "done")]})
    builder.add_edge(START, "only")
    builder.add_edge("only", END)
    graph = builder.compile(checkpointer=FencedCheckpointer(RecordingSaver()))

    result = await graph.ainvoke({"messages": [("human", "q")]}, THREAD)

    assert [m.content for m in result["messages"]] == ["q", "done"]


async def test_guarded_write_refuses_before_it_starts_anything():
    fence = Fence()
    fence.closed = True
    ran = False
    with pytest.raises(TurnFenced):
        async with guarded_write(fence):
            ran = True

    assert not ran


def test_every_public_method_of_the_saver_is_forwarded():
    """A method LangGraph adds to the base class would silently skip the fence if it were not forwarded here."""
    base = {name for name, member in inspect.getmembers(BaseCheckpointSaver, inspect.isfunction) if name != "__init__"}
    own = {name for name, member in vars(FencedCheckpointer).items() if inspect.isfunction(member)}

    assert base - own == set()

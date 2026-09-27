"""The chat workflow driven the way NAT drives it, for the tests that need a whole turn."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from aiq_agent.agents.piloti import conversation_register as register_mod
from aiq_agent.agents.piloti.conversation_register import ChatDeepResearcherConfig
from aiq_agent.agents.piloti.conversation_register import chat_deepresearcher_agent
from aiq_agent.common import profiler as profiler_mod
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.project_context import GridRequestContext
from aiq_agent.turn import context as context_mod
from aiq_agent.turn import inventory as inventory_mod


class _Fn:
    def __init__(self, fn):
        self.ainvoke = fn


class _Builder:
    """Just enough of NAT's Builder for the chat workflow to wire itself."""

    def __init__(self, shallow):
        self._shallow = shallow

    async def get_function(self, name):
        if name == "shallow_research_agent":
            return _Fn(self._shallow)
        if name == "deep_research_agent":
            return _Fn(_never)
        raise AssertionError(name)

    def get_function_config(self, name):
        assert name == "deep_research_agent"
        return SimpleNamespace(tools=["web_search_tool"], exclude_tools=None)

    async def get_tools(self, tool_names, wrapper_type):
        return []


async def _never(_state):  # pragma: no cover - the turn never escalates here
    raise AssertionError("deep research must not run")


@pytest.fixture
def workflow_harness(monkeypatch):
    """The workflow with its database reads and the stage scheduler replaced.

    ``seen["shallow"]`` is the answering function a turn runs unless it is given one.
    """
    seen: dict = {"scheduled": [], "from_context": 0, "spans": []}

    # The turn's profiler batch, captured where it is POSTED. A span reaching
    # here proves the flush ran after the root closed: `track_agent_profile`
    # only adds the root to the batch as it exits.
    monkeypatch.setattr(profiler_mod, "_post_profiler_spans", lambda payload: seen["spans"].extend(payload["spans"]))

    async def no_documents(_collection):
        return []

    async def memory_checkpointer(_db):
        # The sqlite checkpointer keeps a non-daemon aiosqlite thread alive for
        # the process's life; the test process would never exit.
        return InMemorySaver()

    monkeypatch.setattr(register_mod, "get_checkpointer", memory_checkpointer)
    monkeypatch.setattr(inventory_mod, "get_available_documents_async", no_documents)
    monkeypatch.setattr(ingest_status_store, "in_flight_files", lambda _names: {})
    monkeypatch.setattr(context_mod, "get_platform_lessons_digest", lambda _cid: None)
    monkeypatch.setattr(
        register_mod, "schedule_post_answer_stages", lambda facts, llms: seen["scheduled"].append(facts) or []
    )
    # The scoping module parses the envelope on its own account; count only this module's parse.
    monkeypatch.setattr(register_mod, "get_scoped_collections_from_context", lambda: None)
    real_from_context = GridRequestContext.from_context.__func__

    def counting(cls):
        seen["from_context"] += 1
        return real_from_context(cls)

    monkeypatch.setattr(GridRequestContext, "from_context", classmethod(counting))

    async def workflow(shallow):
        config = ChatDeepResearcherConfig()
        gen = chat_deepresearcher_agent.__wrapped__(config, _Builder(shallow))
        return gen, await gen.__anext__()

    async def turn(query, shallow=None):
        gen, info = await workflow(shallow or seen["shallow"])
        try:
            return [body async for body in info.stream_fn(query)]
        finally:
            await gen.aclose()

    async def single(query, shallow=None):
        """What `nat run` and `nat eval` get: NAT's own fold of the stream."""
        gen, info = await workflow(shallow or seen["shallow"])
        try:
            return await info.single_fn(query)
        finally:
            await gen.aclose()

    seen["turn"] = turn
    seen["single"] = single
    return seen

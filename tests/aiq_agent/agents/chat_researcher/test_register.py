"""The workflow entry point: its config, and the per-turn ``_run`` it composes.

``_run`` is driven the way NAT drives it — through the registered builder with
a fake ``Builder`` — with the three database reads and the stage scheduler
replaced. Everything else on the path (the request-context parse, the focus
ContextVars, admission, the registries, the profiler, the response lift, the
streaming) is real.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from aiq_agent.agents.chat_researcher import register as register_mod
from aiq_agent.agents.chat_researcher.register import ChatDeepResearcherConfig
from aiq_agent.agents.chat_researcher.register import chat_deepresearcher_agent
from aiq_agent.agents.researcher.models import ResearchAgentState
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.project_context import GridRequestContext
from aiq_agent.turn import context as context_mod
from aiq_agent.turn import inventory as inventory_mod
from aiq_agent.turn.admission import TurnOutcome
from aiq_agent.turn.admission import TurnRefusal

ANSWER = "Die Brüstung muss mindestens 100 cm hoch sein [1]."


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


async def _shallow(state):
    return ResearchAgentState(
        messages=list(state.messages) + [AIMessage(content=ANSWER)],
        escalation_requested=False,
        source_lookup_attempted=True,
        answer_citation_grounded=True,
        answer_confidence_marker="high",
        skills_activated=["oib-brandschutz"],
    )


class TestStageModelWiring:
    """A stage runs only when a model is configured for its agent group — the
    capability half of `flag AND capability`. Each stage therefore needs its own
    config field, and each must default to None so a deployment that wants
    neither pays for neither."""

    def test_each_post_answer_stage_has_its_own_config_field(self):
        for field in ("memory_reflection_llm", "follow_ups_llm"):
            assert field in ChatDeepResearcherConfig.model_fields
            assert ChatDeepResearcherConfig.model_fields[field].default is None


@pytest.fixture
def harness(monkeypatch):
    """The workflow with its database reads and the stage scheduler replaced."""
    seen: dict = {"scheduled": [], "from_context": 0}

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

    async def turn(query, shallow=_shallow):
        config = ChatDeepResearcherConfig()
        gen = chat_deepresearcher_agent.__wrapped__(config, _Builder(shallow))
        info = await gen.__anext__()
        try:
            return [chunk async for chunk in info.stream_fn(query)]
        finally:
            await gen.aclose()

    seen["turn"] = turn
    return seen


class TestRun:
    async def test_a_turn_streams_the_answer_then_a_terminal_chunk_with_the_extras(self, harness):
        chunks = await harness["turn"]('{"query": "Wie hoch muss die Brüstung sein?"}')

        deltas, terminal = chunks[:-1], chunks[-1]
        assert "".join(c.choices[0].delta.content for c in deltas) == ANSWER
        assert terminal.choices[0].finish_reason == "stop"
        assert terminal.choices[0].delta.content == ANSWER
        assert terminal.routing_decision == "shallow"
        assert terminal.answer_confidence == "high"
        assert terminal.skills_activated == ["oib-brandschutz"]

    async def test_the_post_answer_stages_get_the_turn_facts(self, harness):
        await harness["turn"]('{"query": "Wie hoch muss die Brüstung sein?"}')

        (facts,) = harness["scheduled"]
        assert facts.query == "Wie hoch muss die Brüstung sein?"
        assert facts.answer == ANSWER
        assert facts.routing_decision == "shallow"
        assert facts.answer_confidence == "high"

    async def test_the_request_envelope_is_parsed_once_per_turn(self, harness):
        """The organization for admission used to be re-parsed (base64 + HMAC +
        JSON) after the context load had parsed the same envelope."""
        await harness["turn"]('{"query": "Was gilt?"}')
        assert harness["from_context"] == 1

    async def test_a_refused_turn_delivers_one_terminal_chunk_and_no_stage(self, harness, monkeypatch):
        async def refuse(agent, state, **_kwargs):
            return TurnOutcome(state=None, refusal=TurnRefusal("turn_admission", "Gerade zu viele Anfragen.", 15))

        monkeypatch.setattr(register_mod, "answer_turn", refuse)

        chunks = await harness["turn"]('{"query": "Was gilt?"}')

        (terminal,) = chunks
        assert terminal.choices[0].finish_reason == "stop"
        assert terminal.choices[0].delta.content == "Gerade zu viele Anfragen."
        assert terminal.retry_after_seconds == 15
        assert harness["scheduled"] == []

    async def test_the_focus_of_one_turn_does_not_leak_into_the_next(self, harness):
        seen: list[tuple] = []

        async def shallow(state):
            seen.append((state.focus_file_name, state.focus_shelf))
            return await _shallow(state)

        await harness["turn"](
            '{"query": "fass zusammen", "focus_file_name": "Plan.pdf", "focus_shelf": "session"}', shallow
        )
        await harness["turn"]('{"query": "welche OIB-Richtlinien gelten in Wien?"}', shallow)

        assert seen == [("Plan.pdf", "session"), (None, None)]

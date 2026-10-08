"""The four per-request LLM dials are read in a THREAD, not on the event loop.

``get_model_overrides_from_context``, ``get_reasoning_efforts``,
``get_org_llm_credential_from_context`` and ``get_zdr_only_from_context`` are
header-first, but each falls back to a blocking BFF call under a threading
lock. Called from a coroutine, a cold miss stalls every turn the worker is
serving. What is asserted is WHERE each ran — the shape of
``tests/aiq_agent/agents/piloti/test_prompt_render_off_the_loop.py`` — for the
reader itself and for the two agents that call them: the
clarifier (``Clarifier.__call__`` → ``deps_for``) and deep research
(``run_deep_research``). Chat (``piloti/register._active_provider``) is covered
by ``test_active_provider.py``, which goes through the same reader.
"""

from __future__ import annotations

import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import HumanMessage

from aiq_agent.common import LLMProvider
from aiq_agent.common import request_llm_context
from aiq_agent.common.request_llm_context import RequestLLMContext
from aiq_agent.common.request_llm_context import read_request_llm_context

_READERS = (
    "get_model_overrides_from_context",
    "get_reasoning_efforts",
    "get_org_llm_credential_from_context",
    "get_zdr_only_from_context",
)


@pytest.fixture
def threads(monkeypatch):
    """Each reader answers as an inactive request and records the thread it ran on."""
    seen: dict[str, threading.Thread] = {}
    answers = {
        "get_model_overrides_from_context": {},
        "get_reasoning_efforts": {},
        "get_org_llm_credential_from_context": None,
        "get_zdr_only_from_context": False,
    }

    def recorder(name):
        def read():
            seen[name] = threading.current_thread()
            return answers[name]

        return read

    for name in _READERS:
        monkeypatch.setattr(request_llm_context, name, recorder(name))
    return seen


def _assert_off_the_loop(seen: dict[str, threading.Thread]) -> None:
    assert set(seen) == set(_READERS), "a reader was never called; the fake is not wired in"
    on_the_loop = [name for name, thread in seen.items() if thread is threading.current_thread()]
    assert on_the_loop == [], f"{on_the_loop} ran on the event-loop thread and block every other turn"


def _identity_provider() -> MagicMock:
    """A provider double whose whole override chain answers itself: nothing applies."""
    provider = MagicMock(spec=LLMProvider)
    provider.with_model_overrides.return_value = provider
    provider.with_reasoning_efforts.return_value = provider
    provider.with_credential.return_value = provider
    provider.with_zdr.return_value = provider
    return provider


class TestTheReader:
    async def test_every_dial_is_read_off_the_loop(self, threads):
        context = await read_request_llm_context()

        _assert_off_the_loop(threads)
        assert context == RequestLLMContext()

    async def test_a_broken_zdr_lookup_fails_closed_and_the_others_open(self, monkeypatch):
        def boom():
            raise RuntimeError("bff down")

        for name in _READERS:
            monkeypatch.setattr(request_llm_context, name, boom)

        context = await read_request_llm_context()

        assert context.zdr_only is True, "a privacy control must not switch itself off"
        assert (context.model_overrides, context.reasoning_efforts, context.credential) == ({}, {}, None)

    def test_an_inactive_context_keeps_the_boot_provider(self):
        provider = _identity_provider()
        assert RequestLLMContext().apply(provider) is provider


class TestTheAgentsReadThroughIt:
    async def test_the_clarifier_reads_the_dials_off_the_loop(self, threads):
        from aiq_agent.agents.piloti.clarify import Clarifier
        from aiq_agent.agents.piloti.clarify import ClarifierSettings
        from aiq_agent.agents.piloti.models.clarify import ClarifyRequest

        clarifier = Clarifier.build(_identity_provider(), [], None, ClarifierSettings(llm="l"), AsyncMock())
        request = ClarifyRequest(messages=[HumanMessage(content="q")])

        with patch("aiq_agent.agents.piloti.clarify.clarify", new=AsyncMock(return_value="done")) as run:
            assert await clarifier(request) == "done"

        _assert_off_the_loop(threads)
        assert run.call_args.args[1] is clarifier.boot

    async def test_deep_research_reads_the_dials_off_the_loop(self, threads):
        from aiq_agent.agents.deep_researcher import register as deep_register
        from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState

        prebuilt = MagicMock()
        state = DeepResearchAgentState(messages=[HumanMessage(content="q")])
        prebuilt.run = AsyncMock(return_value=state)
        tools = [SimpleNamespace(name="knowledge_search")]
        lazy = SimpleNamespace(
            get=AsyncMock(return_value=(tools, prebuilt)),
            blueprint=SimpleNamespace(provider=_identity_provider(), sandbox=None),
        )

        with (
            patch.object(deep_register, "filter_tools_by_sources", return_value=tools),
            patch.object(deep_register, "all_mapped_tools_filtered_out", return_value=False),
            patch.object(deep_register, "validate_tool_availability", return_value=(True, [], [])),
        ):
            assert await deep_register.run_deep_research(state, lazy) is state

        _assert_off_the_loop(threads)
        prebuilt.run.assert_awaited_once_with(state)


class TestTurnEffort:
    """The asker's level lands on the chat answer's group only."""

    def test_no_stated_level_leaves_the_platform_efforts(self):
        efforts = {"shallow_research": "medium", "clarifier": "low"}

        assert request_llm_context.with_turn_effort(efforts, None) is efforts

    def test_the_stated_level_wins_for_the_answering_group_only(self):
        efforts = {"shallow_research": "medium", "clarifier": "low"}

        merged = request_llm_context.with_turn_effort(efforts, "high")

        assert merged == {"shallow_research": "high", "clarifier": "low"}
        assert efforts["shallow_research"] == "medium"

    async def test_read_applies_the_turn_level_over_a_failed_lookup(self):
        from aiq_agent.common.reasoning_settings import set_turn_reasoning_effort

        set_turn_reasoning_effort("low")
        try:
            with patch.object(request_llm_context, "get_reasoning_efforts", side_effect=RuntimeError("bff down")):
                efforts = await request_llm_context._read_reasoning_efforts()
        finally:
            set_turn_reasoning_effort(None)

        assert efforts == {"shallow_research": "low"}

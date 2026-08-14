"""Deferred tool loading, as the shallow researcher wires it.

The unit rules live in ``tests/aiq_agent/common/test_deferred_tool_loading.py``.
These tests are about the SEAM: that the agent's research bindings — the
construction-time full one and the narrowed ones tool search builds — both go
through it, that meta turns deliberately do not, and that the whole thing is
byte-identical to the old code path when nobody asked for it.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from langchain_core.tools import tool

from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
from aiq_agent.agents.shallow_researcher.tool_search import ToolSearchSettings
from aiq_agent.common import LLMProvider
from aiq_agent.common.deferred_tool_loading import DeferredToolBinding
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings


@tool
def ifc_measure(operation: str) -> str:
    """Misst Bauteile am IFC-Modell: lichte Raumhöhe, Fläche, Brüstung, Fluchtweg."""
    return "2,42 m"


@tool
def ris_search(query: str) -> str:
    """Sucht österreichische Rechtsnormen im RIS: Bauordnung, OIB-Richtlinien."""
    return "OIB-RL 4"


@tool
def remember(fact: str) -> str:
    """Merkt sich eine dauerhafte Projekterkenntnis."""
    return "ok"


@tool
def emit_card(card: str) -> str:
    """Zeigt dem Nutzer eine strukturierte Karte an."""
    return "ok"


TOOLS = [ifc_measure, ris_search, remember, emit_card]


class FakeOpenRouterLLM:
    """ChatOpenAI stand-in on OpenRouter's Responses API."""

    def __init__(self):
        self.openai_api_base = "https://openrouter.ai/api/v1"
        self.use_responses_api = True
        self.bind_calls: list[dict] = []

    def bind_tools(self, tools, **kwargs):
        return SimpleNamespace(kind="plain_binding", tools=list(tools))

    def bind(self, **kwargs):
        self.bind_calls.append(kwargs)
        return SimpleNamespace(kind="deferred_binding", **kwargs)

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        return {"model": "openai/gpt-5.6-luna", "input": "ping", **kwargs}


@pytest.fixture
def llm():
    return FakeOpenRouterLLM()


@pytest.fixture
def provider(llm):
    p = MagicMock(spec=LLMProvider)
    p.get = MagicMock(return_value=llm)
    return p


def _deferred_names(bind_kwargs: dict) -> list[str]:
    namespace = next(t for t in bind_kwargs["tools"] if t["type"] == "namespace")
    return [f["name"] for f in namespace["tools"]]


def test_off_by_default_the_agent_binds_exactly_as_it_always_has(provider, llm):
    agent = ShallowResearcherAgent(llm_provider=provider, tools=TOOLS)
    assert agent.deferred_tool_loading is None
    assert agent._llm_with_tools.kind == "plain_binding"
    assert llm.bind_calls == []


def test_a_disabled_settings_object_is_the_same_as_none(provider, llm):
    agent = ShallowResearcherAgent(
        llm_provider=provider, tools=TOOLS, deferred_tool_loading=DeferredToolLoadingSettings()
    )
    assert agent.deferred_tool_loading is None
    assert agent._llm_with_tools.kind == "plain_binding"
    assert llm.bind_calls == []


def test_enabled_the_construction_time_binding_defers_every_tool(provider, llm):
    agent = ShallowResearcherAgent(
        llm_provider=provider, tools=TOOLS, deferred_tool_loading=DeferredToolLoadingSettings(enabled=True)
    )
    assert isinstance(agent._llm_with_tools, DeferredToolBinding)
    assert len(llm.bind_calls) == 1
    payload = llm.bind_calls[0]["tools"]
    assert [t["type"] for t in payload] == ["tool_search", "namespace"]
    assert _deferred_names(llm.bind_calls[0]) == [t.name for t in TOOLS]


def test_a_narrowed_binding_is_deferred_too(provider, llm):
    # tool_search decides WHICH tools are bound; deferral decides whether their
    # schemas travel. A narrowed set that quietly stopped deferring would put
    # the schemas back on exactly the requests that select sources.
    agent = ShallowResearcherAgent(
        llm_provider=provider,
        tools=TOOLS,
        tool_search=ToolSearchSettings(enabled=True, top_k=1),
        deferred_tool_loading=DeferredToolLoadingSettings(enabled=True),
    )
    llm.bind_calls.clear()
    from langchain_core.messages import HumanMessage

    messages = [HumanMessage(content="Wie hoch ist die lichte Raumhöhe im Keller? Miss das am Modell.")]
    bound, tools_info = agent._research_tool_binding(messages, agent.tools_info)
    assert isinstance(bound, DeferredToolBinding)
    assert len(llm.bind_calls) == 1
    deferred = _deferred_names(llm.bind_calls[0])
    assert deferred == [ti["name"] for ti in tools_info]
    assert len(deferred) < len(TOOLS)


def test_meta_turns_are_deliberately_not_deferred(provider, llm):
    # Meta turns bind only remember/emit_card. Their schemas are a few hundred
    # characters and the tool-search apparatus costs ~600 input tokens of its
    # own, so deferring there spends more than it withholds.
    agent = ShallowResearcherAgent(
        llm_provider=provider, tools=TOOLS, deferred_tool_loading=DeferredToolLoadingSettings(enabled=True)
    )
    llm.bind_calls.clear()
    bound, tools_info = agent._meta_tool_binding(agent.tools_info)
    assert not isinstance(bound, DeferredToolBinding)
    assert llm.bind_calls == []
    assert {"remember", "emit_card"} <= {ti["name"] for ti in tools_info}


def test_the_namespace_description_is_the_only_tool_text_sent_up_front(provider, llm):
    settings = DeferredToolLoadingSettings(enabled=True, namespace="piloti", namespace_description="Werkzeuge.")
    ShallowResearcherAgent(llm_provider=provider, tools=TOOLS, deferred_tool_loading=settings)
    namespace = next(t for t in llm.bind_calls[0]["tools"] if t["type"] == "namespace")
    assert namespace["name"] == "piloti"
    assert namespace["description"] == "Werkzeuge."


def test_a_chat_completions_deployment_keeps_the_full_binding(provider, llm):
    # config_grid_oib.yml runs Chat Completions against api.kimi.com. Even with
    # the flag set, that deployment must fall back to sending schemas.
    llm.use_responses_api = False
    agent = ShallowResearcherAgent(
        llm_provider=provider, tools=TOOLS, deferred_tool_loading=DeferredToolLoadingSettings(enabled=True)
    )
    assert agent._llm_with_tools.kind == "plain_binding"
    assert llm.bind_calls == []


def test_the_config_defaults_to_off():
    from aiq_agent.agents.shallow_researcher.register import ShallowResearchAgentConfig

    config = ShallowResearchAgentConfig(llm="shallow_llm")
    assert config.deferred_tool_loading.enabled is False

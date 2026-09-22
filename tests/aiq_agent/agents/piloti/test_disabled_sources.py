"""A switched-off data source keeps its tool and refuses the call.

The toggles used to delete tools from the binding, and the prompt then told the
model what it could infer from their absence. Two costs, both real. The
provider's prompt cache is keyed on the tool payload
(``common/prompt_caching.py``), so every toggle combination was its own cache
shard on a workload that is ~99 % input tokens and re-sends its prefix three to
eight times per turn. And an absent tool is a capability the model has to
notice is missing, where a refusal is a fact it can say out loud: „ich konnte
das Web nicht prüfen".

So the tool stays bound and the call is answered with one sentence, at the same
``ToolNode`` boundary the duplicate-fetch guard sits on, uncharged and never
executed. Org-disabled sources (ADR-0022) stay enforced — by the layer that
cannot be talked around, rather than by absence.

Through the COMPILED GRAPH, because the claim is about what RUNS and what the
model reads next: the agent node decides what to charge and the tools node what
to execute, and a unit test of either half passes while the two disagree about
which calls were withheld.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.agent import TurnConfig
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.data_source_registry import populate_from_config
from aiq_agent.common.data_source_registry import reset_registry
from aiq_agent.common.data_sources import disabled_source_notice
from aiq_agent.common.data_sources import unavailable_source_ids
from aiq_agent.common.prompt_caching import prompt_cache_key

_PROMPT = "Du bist Piloti."

RAN: list[str] = []


@tool
def web_search_tool(query: str) -> str:
    """Search the web."""
    RAN.append(f"web_search_tool:{query}")
    return f"Web-Treffer zu: {query}"


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    RAN.append(f"knowledge_search:{query}")
    return f"Treffer zu: {query}"


@tool
def ris_lookup_tool(question: str) -> str:
    """Look up Austrian law in RIS."""
    RAN.append(f"ris_lookup_tool:{question}")
    return f"RIS-Treffer zu: {question}"


@tool
def emit_card(kind: str) -> str:
    """Emit a UI card."""
    RAN.append(f"emit_card:{kind}")
    return "Karte erstellt"


_TOOLS = [web_search_tool, knowledge_search, ris_lookup_tool, emit_card]


@pytest.fixture(autouse=True)
def _registry():
    reset_registry()
    populate_from_config(
        [
            {
                "id": "web_search",
                "name": "Web-Suche",
                "description": "Search the web.",
                "tools": ["web_search_tool"],
            },
            {
                "id": "knowledge_layer",
                "name": "Wissensbasis",
                "description": "Search documents.",
                "tools": ["knowledge_search"],
            },
            {
                "id": "ris",
                "name": "RIS – Österreichisches Recht",
                "description": "Austrian law.",
                "tools": ["ris_lookup_tool"],
            },
        ]
    )
    yield
    reset_registry()


@pytest.fixture(autouse=True)
def _clean_slate():
    RAN.clear()
    turn_status._retrieval_round.set(None)
    yield
    RAN.clear()
    turn_status._retrieval_round.set(None)


@pytest.fixture(autouse=True)
def _bypass_citation_pipeline():
    with (
        patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
        patch("aiq_agent.agents.piloti.answer_pipeline.verify_citations") as verify,
        patch("aiq_agent.agents.piloti.answer_pipeline.sanitize_report") as sanitize,
    ):
        verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
            verified_report=content, removed_citations=[]
        )
        sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
        yield


@pytest.fixture
def steps():
    from nat.builder.context import ContextState
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())
    seen: list[dict] = []

    def _on_next(step) -> None:
        payload = step.payload
        body = getattr(payload.data, "input", None)
        if isinstance(body, str) and str(payload.event_type).endswith("START"):
            seen.append({"step": payload.name, **json.loads(body)})

    state.event_stream.get().subscribe(_on_next)
    yield seen
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())


def _call(name: str, call_id: str, **args) -> dict:
    return {"name": name, "args": args, "id": call_id}


def _batch(*calls: dict) -> AIMessage:
    return AIMessage(content="", tool_calls=list(calls))


def _agent(*rounds: AIMessage) -> tuple[PilotiAgent, MagicMock]:
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(side_effect=list(rounds))
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    agent = PilotiAgent(
        llm_provider=provider,
        tools=_TOOLS,
        system_prompt=_PROMPT,
        max_tool_iterations=7,
    )
    return agent, llm


async def _run(agent: PilotiAgent, disabled: set[str]):
    return await agent.run(
        ResearchAgentState(messages=[HumanMessage(content="Was steht im Web dazu?")]),
        turn=TurnConfig(disabled_sources=frozenset(disabled)),
    )


def _answer_for(result, call_id: str) -> str:
    (message,) = [m for m in result.messages if isinstance(m, ToolMessage) and m.tool_call_id == call_id]
    return str(message.content)


class TestTheCallIsRefusedNotRemoved:
    async def test_the_tool_is_still_bound(self):
        """The whole point: the payload does not change with the toggle."""
        agent, llm = _agent(AIMessage(content="Die Antwort [1]."))

        await _run(agent, {"web_search"})

        (bound,) = [call.args[0] for call in llm.bind_tools.call_args_list]
        assert [t.name for t in bound] == [
            "web_search_tool",
            "knowledge_search",
            "ris_lookup_tool",
            "emit_card",
        ]

    async def test_a_call_to_a_switched_off_source_does_not_run(self):
        agent, _llm = _agent(
            _batch(_call("web_search_tool", "w", query="OIB 2")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent, {"web_search"})

        assert RAN == []
        answer = _answer_for(result, "w")
        assert "Web-Suche" in answer, "the refusal must name the source the reader turned off"
        assert "abgeschaltet" in answer
        # An INSTRUCTION, not an error: what the model should do next is answer
        # from what it holds and SAY the source went unconsulted.
        assert "nicht konsultiert" in answer

    async def test_the_rest_of_the_round_still_runs(self):
        agent, _llm = _agent(
            _batch(
                _call("web_search_tool", "w", query="OIB 2"),
                _call("knowledge_search", "k", query="OIB 2"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent, {"web_search"})

        assert RAN == ["knowledge_search:OIB 2"]
        assert _answer_for(result, "k") == "Treffer zu: OIB 2"
        assert "abgeschaltet" in _answer_for(result, "w")

    async def test_a_tool_belonging_to_no_source_is_never_refused(self):
        """`emit_card` and its kind are not data sources and have no toggle."""
        agent, _llm = _agent(
            _batch(_call("emit_card", "c", kind="verdict_header")),
            AIMessage(content="Die Antwort [1]."),
        )

        await _run(agent, {"web_search", "knowledge_layer", "ris"})

        assert RAN == ["emit_card:verdict_header"]

    async def test_every_call_still_gets_exactly_one_result(self):
        agent, _llm = _agent(
            _batch(
                _call("web_search_tool", "w", query="OIB 2"),
                _call("knowledge_search", "k", query="OIB 2"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent, {"web_search"})

        asked = [call["id"] for m in result.messages if isinstance(m, AIMessage) for call in (m.tool_calls or [])]
        answered = [m.tool_call_id for m in result.messages if isinstance(m, ToolMessage)]
        assert sorted(answered) == sorted(asked)


class TestWhatARefusedRoundCosts:
    async def test_a_refused_round_costs_one_round_and_announces_no_retrieval(self, steps):
        """It cost an LLM call and two graph steps, so it costs a round — and
        nothing was fetched, so there is no layer of the Herleitung to draw."""
        agent, _llm = _agent(
            _batch(_call("web_search_tool", "w", query="OIB 2")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent, {"web_search"})

        assert result.tool_iterations == 1
        assert [step["slot"] for step in steps if str(step["slot"]).startswith("retrieval")] == []

    async def test_the_refusal_is_reported_as_its_own_technical_event(self, steps):
        """A refused call runs nothing and announces nothing, so without this
        record the toggle's effect on a turn is invisible — the repeat guard
        beside it has had `status:repeat:N` all along."""
        agent, _llm = _agent(
            _batch(
                _call("web_search_tool", "w", query="OIB 2"),
                _call("knowledge_search", "k", query="OIB 2"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        await _run(agent, {"web_search"})

        (record,) = [step for step in steps if str(step["slot"]).startswith("refused")]
        assert record["step"] == "status:refused:0"
        assert (record["round"], record["withheld"]) == (0, 1)
        # Technical and key-less, like the repeat record: whether the READER is
        # told is a product decision, and a live key would make it silently.
        assert record["channel"] == turn_status.CHANNEL_TECHNICAL
        assert "key" not in record

    async def test_a_round_with_nothing_refused_leaves_no_record(self, steps):
        """A constant is not an event: the toggle is on for the whole turn, and
        only a call that MET it is worth a record."""
        agent, _llm = _agent(
            _batch(_call("knowledge_search", "k", query="OIB 2")),
            AIMessage(content="Die Antwort [1]."),
        )

        await _run(agent, {"web_search"})

        assert [step for step in steps if str(step["slot"]).startswith("refused")] == []


class TestOneCacheShardPerOrgAndModel:
    """The cost half of row 6, asserted where the key is actually computed."""

    async def test_two_turns_with_different_toggles_share_a_prompt_cache_key(self):
        agent_a, llm_a = _agent(AIMessage(content="Die Antwort [1]."))
        agent_b, llm_b = _agent(AIMessage(content="Die Antwort [1]."))

        await _run(agent_a, {"web_search"})
        await _run(agent_b, {"ris", "knowledge_layer"})

        tools_a = [t.name for t in llm_a.bind_tools.call_args_list[0].args[0]]
        tools_b = [t.name for t in llm_b.bind_tools.call_args_list[0].args[0]]
        key_a = prompt_cache_key(system_prompt=_PROMPT, tools=tools_a, organization_id="org-1", model="m")
        key_b = prompt_cache_key(system_prompt=_PROMPT, tools=tools_b, organization_id="org-1", model="m")
        assert key_a == key_b, "a toggle still splits the cache shard"

    def test_a_different_tool_set_still_splits_it(self):
        """The guarantee is about toggles, not about the key going blunt."""
        base = prompt_cache_key(system_prompt=_PROMPT, tools=["a", "b"], organization_id="org-1", model="m")
        fewer = prompt_cache_key(system_prompt=_PROMPT, tools=["a"], organization_id="org-1", model="m")
        assert base != fewer


class TestTheHelperIsTheOnePlaceThatDecides:
    def test_it_resolves_the_tool_through_the_registry(self):
        assert disabled_source_notice("web_search_tool", {"web_search"}) is not None
        assert disabled_source_notice("knowledge_search", {"web_search"}) is None
        assert disabled_source_notice("emit_card", {"web_search"}) is None

    def test_nothing_disabled_never_refuses(self):
        assert disabled_source_notice("web_search_tool", set()) is None

    def test_the_selection_and_the_org_toggle_are_one_set(self):
        """What the request did not select and what the org switched off are the
        same fact to a tool: this source is not available on this turn."""
        assert unavailable_source_ids(["knowledge_layer"], disabled_sources=set()) == frozenset({"web_search", "ris"})
        assert unavailable_source_ids(None, disabled_sources={"web_search"}) == frozenset({"web_search"})
        assert unavailable_source_ids(["knowledge_layer"], disabled_sources={"knowledge_layer"}) == frozenset(
            {"web_search", "ris", "knowledge_layer"}
        )

    def test_selecting_nothing_switches_every_source_off(self):
        assert unavailable_source_ids([], disabled_sources=set()) == frozenset({"web_search", "knowledge_layer", "ris"})

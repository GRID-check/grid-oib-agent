"""The research budget is spent in ROUNDS, and cost is bounded separately.

A round is one LLM decision that emitted tool calls. It costs one, whatever it
asked for: five parallel ``read_passage`` opens, three ``emit_card`` calls, one
``use_skill``, or a batch the guards withheld in full.

The failure this replaces is measured, not imagined. The budget used to be
charged per emitted CALL, so „was weißt du über die OIB 2" — one
``knowledge_search`` plus the family opened in one parallel batch, which is the
shape the prompt asks for — exhausted a budget of seven on the single most
ordinary question the product answers, and the answer came back written from
whatever had been read by then. Parallel calls inside one round are the model
using its round well; pricing them is what made the prompt and the budget
contradict each other.

What a round ceiling does NOT bound is money, because it stopped being a proxy
for it the moment a round stopped being one call. So there is a second bound —
cumulative INPUT tokens, read off the cost tracker that already meters every
call — and it is checked in the same place and answered the same way.

Through the COMPILED GRAPH: the agent node decides what to charge and the tools
node what to run, and a unit test of either half passes while the two disagree.
The system prompt is a fixed string here, so these tests pin the budget rather
than whatever the template happens to say today.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.piloti.agent import _SYNTHESIS_ANCHOR
from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.agent import _recursion_limit
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.cost_tracking import GridCostTracker
from aiq_agent.common.cost_tracking import UsageEvent
from aiq_agent.common.cost_tracking import grid_cost_tracker_var

#: A prompt the template cannot break. What is under test is the budget.
_PROMPT = "Du bist Piloti."

RAN: list[str] = []


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    RAN.append(f"knowledge_search:{query}")
    return f"Treffer zu: {query}"


@tool
def read_passage(document: str, punkt: str | None = None) -> str:
    """Open a named passage of a known document."""
    RAN.append(f"read_passage:{document}|{punkt or ''}")
    return f"Passage aus {document}"


@tool
def emit_card(kind: str) -> str:
    """Emit a UI card."""
    RAN.append(f"emit_card:{kind}")
    return "Karte erstellt"


@tool
def remember(fact: str) -> str:
    """Remember a durable fact."""
    RAN.append(f"remember:{fact}")
    return "Gemerkt"


_TOOLS = [knowledge_search, read_passage, emit_card, remember]


@pytest.fixture(autouse=True)
def _clean_slate():
    RAN.clear()
    turn_status._retrieval_round.set(None)
    yield
    RAN.clear()
    turn_status._retrieval_round.set(None)


@pytest.fixture(autouse=True)
def _bypass_citation_pipeline():
    """The answer pipeline is not what these tests are about."""
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
    """Every custom step pushed during the test, as parsed payloads."""
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


def _batch(*calls: dict, thought: str = "") -> AIMessage:
    return AIMessage(content=thought, tool_calls=list(calls))


def _agent(*rounds: AIMessage, ceiling: int = 7, max_input_tokens: int = 0) -> PilotiAgent:
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(side_effect=list(rounds))
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return PilotiAgent(
        llm_provider=provider,
        tools=_TOOLS,
        system_prompt=_PROMPT,
        max_tool_iterations=ceiling,
        max_input_tokens_per_turn=max_input_tokens,
    )


async def _run(agent: PilotiAgent, question: str = "Was weißt du über die OIB 2?"):
    return await agent.run(ResearchAgentState(messages=[HumanMessage(content=question)]))


class TestAParallelRoundCostsOne:
    async def test_the_family_overview_costs_two_rounds_not_six(self):
        """The question that used to exhaust a budget of seven.

        One search, then every member of the Richtlinien-Familie opened in ONE
        parallel batch — which is what the research rules ask for. Six calls,
        two decisions, two rounds.
        """
        agent = _agent(
            _batch(_call("knowledge_search", "k", query="OIB 2")),
            _batch(
                *(
                    _call("read_passage", f"p{index}", document=f"OIB-Richtlinie 2 Teil {index}")
                    for index in range(1, 6)
                )
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert len(RAN) == 6, "every member was opened"
        assert result.tool_iterations == 2
        assert result.research_truncated is None

    async def test_a_round_of_cards_costs_the_same_as_a_round_of_searches(self):
        """No second currency: the output channel is priced like the research."""
        agent = _agent(
            _batch(
                _call("emit_card", "c1", kind="verdict_header"),
                _call("emit_card", "c2", kind="typed_table"),
                _call("remember", "m1", fact="Gebäudeklasse 4"),
            ),
            AIMessage(content="Die Antwort [1]."),
            ceiling=2,
        )

        result = await _run(agent)

        assert len(RAN) == 3
        assert result.tool_iterations == 1
        assert result.research_truncated is None


class TestTheCeilingIsRounds:
    async def test_the_loop_stops_after_ceiling_rounds(self, steps):
        """Seven decisions, however many calls each of them asked for."""

        async def _reply(messages, **_kwargs):
            if any(_SYNTHESIS_ANCHOR in str(getattr(message, "content", "")) for message in messages):
                return AIMessage(content="Die Antwort [1].")
            index = len(RAN)
            return _batch(
                _call("knowledge_search", f"a{index}", query=f"Frage {index}"),
                _call("knowledge_search", f"b{index}", query=f"Frage {index} anders"),
            )

        agent = _agent(ceiling=3)
        agent.llm_provider.get().ainvoke = AsyncMock(side_effect=_reply)

        result = await _run(agent)

        assert result.tool_iterations == 3
        assert result.research_truncated is True
        # Three rounds of two calls: the calls are not what ran out.
        assert len(RAN) == 6
        (record,) = [step for step in steps if step.get("slot") == "budget"]
        assert (record["ceiling"], record["spent"], record["rounds"]) == (3, 3, 3)
        assert record["channel"] == turn_status.CHANNEL_TECHNICAL

    def test_the_recursion_guard_derives_from_the_round_ceiling_alone(self):
        """Two graph steps per round, the synthesis, and slack — nothing added."""
        assert _recursion_limit(7) == 24
        assert _recursion_limit(0) == 10


class TestTheInputTokenStop:
    """What bounds the BILL, now that rounds do not."""

    @pytest.fixture
    def spent_tracker(self):
        """A turn that has already metered 1 500 input tokens."""
        tracker = GridCostTracker(organization_id="org-1")
        tracker.record(
            UsageEvent(
                model="m",
                requested_model="m",
                generation_id=None,
                prompt_tokens=1500,
                completion_tokens=10,
                total_tokens=1510,
                cached_tokens=0,
                reasoning_tokens=0,
                cost_usd=0.0,
                cost_source="usage_field",
                is_byok=None,
            )
        )
        token = grid_cost_tracker_var.set(tracker)
        yield tracker
        grid_cost_tracker_var.reset(token)

    async def test_a_turn_over_the_token_ceiling_is_forced_into_synthesis(self, spent_tracker, steps):
        agent = _agent(
            AIMessage(content="Die Antwort aus dem, was da ist [1]."),
            ceiling=7,
            max_input_tokens=1000,
        )

        result = await _run(agent)

        assert RAN == [], "the turn was stopped before it could spend another round"
        assert result.tool_iterations == 0
        assert result.research_truncated is True
        (record,) = [step for step in steps if step.get("slot") == "budget:input"]
        assert (record["limit"], record["spent"], record["rounds"]) == (1000, 1500, 0)
        assert record["truncated"] is True
        # Technical, like the round record: whether the READER is told is a
        # product decision, and a live key would make it silently.
        assert record["channel"] == turn_status.CHANNEL_TECHNICAL
        assert "key" not in record

    async def test_it_is_a_separate_record_from_the_round_ceiling(self, spent_tracker, steps):
        """Two bounds, two slots. One step name for both would collapse under
        the frontend's dedupe and make either question unanswerable."""
        agent = _agent(AIMessage(content="Die Antwort [1]."), ceiling=7, max_input_tokens=1000)

        await _run(agent)

        assert [step["slot"] for step in steps if str(step["slot"]).startswith("budget")] == ["budget:input"]

    async def test_a_turn_under_the_ceiling_researches_normally(self, spent_tracker):
        agent = _agent(
            _batch(_call("knowledge_search", "k", query="OIB 2")),
            AIMessage(content="Die Antwort [1]."),
            ceiling=7,
            max_input_tokens=100_000,
        )

        result = await _run(agent)

        assert RAN == ["knowledge_search:OIB 2"]
        assert result.tool_iterations == 1
        assert result.research_truncated is None

    async def test_zero_disables_the_stop(self, spent_tracker):
        """A deployment that does not want the bound gets the old behaviour,
        not a bound of zero that ends every turn before it starts."""
        agent = _agent(
            _batch(_call("knowledge_search", "k", query="OIB 2")),
            AIMessage(content="Die Antwort [1]."),
            ceiling=7,
            max_input_tokens=0,
        )

        result = await _run(agent)

        assert result.tool_iterations == 1
        assert result.research_truncated is None

    async def test_no_tracker_means_no_budget_has_been_spent(self):
        """A CLI run, an eval, a unit test: nothing is billing anyone, so
        nothing is cut off."""
        agent = _agent(
            _batch(_call("knowledge_search", "k", query="OIB 2")),
            AIMessage(content="Die Antwort [1]."),
            ceiling=7,
            max_input_tokens=1,
        )

        result = await _run(agent)

        assert result.tool_iterations == 1
        assert result.research_truncated is None

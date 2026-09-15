"""What the ledger says a RIS round read — through the compiled graph.

The old RIS search captured twenty lane hits per call: every document the
search listed, including the nineteen it never opened. The Herleitung then drew
twenty documents for a round that produced one passage, which is not a
transparency feature, it is a lie with a UI.

`ris_lookup` captures once per RETURNED passage. Proving that needs the
COMPILED GRAPH and not a unit test of the capture, for the reason
``test_retrieval_rounds_spine`` is written down for: the round stamp is set in
Piloti's tools node and LangGraph builds every node's task with
``copy_context()``, so a capture that reads the stamp in a unit test reads a
value the real tool would never see.

A NEW file rather than a case added to ``test_retrieval_ledger.py``: that
package is being edited concurrently, and this test only needs the public
surface (``PilotiAgent``, ``ResearchAgentState``) plus the real capture the
tool performs.
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
from ris_adapter.lookup.passages import Passage
from ris_adapter.lookup.telemetry import capture_passages

from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

_LAW_URL = "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006"
_GARAGE_URL = "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000098"


def _passage(punkt: str, *, title: str = "Bauordnung für Wien", url: str = _LAW_URL) -> Passage:
    """One returned passage, as ``passages.build_passages`` builds it."""
    return Passage(
        title=title,
        url=url,
        collection="ris/LrKons/Wien",
        punkt_label=punkt,
        citation=f"{title}, {punkt}",
        body="…",
        score=1.0,
    )


#: What each call returned, scripted per test.
RETURNED: list[list[Passage]] = []


@tool
def ris_lookup_tool(question: str, conclusion: str = "") -> str:
    """Answer a question about Austrian law from RIS with citable passages."""
    # The REAL capture the tool performs, on the passages it really returns.
    passages = RETURNED.pop(0) if RETURNED else []
    capture_passages(passages)
    return "\n".join(f"Citation: {passage.citation}" for passage in passages)


@pytest.fixture(autouse=True)
def _clean_slate():
    RETURNED.clear()
    turn_status._retrieval_round.set(None)
    yield
    RETURNED.clear()
    turn_status._retrieval_round.set(None)


@pytest.fixture(autouse=True)
def _bypass_citation_pipeline():
    """The answer pipeline is not what this file is about."""
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
def scripted_agent():
    """A PilotiAgent whose LLM plays a fixed script of tool rounds."""

    def build(*rounds: AIMessage) -> PilotiAgent:
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(side_effect=list(rounds))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        return PilotiAgent(llm_provider=provider, tools=[ris_lookup_tool], max_tool_iterations=6)

    return build


def _lookup(call_id: str, question: str, conclusion: str = "") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": "ris_lookup_tool",
                "args": {"question": question, "conclusion": conclusion},
                "id": call_id,
            }
        ],
    )


async def _run(agent: PilotiAgent) -> ResearchAgentState:
    return await agent.run(ResearchAgentState(messages=[HumanMessage(content="Was verlangt die Baubehörde?")]))


@pytest.mark.asyncio
async def test_the_ledger_records_one_hit_per_returned_passage(scripted_agent):
    """Two passages of one law: two hits a reader can tell apart, one document."""
    RETURNED.append([_passage("§ 63 Abs 1"), _passage("§ 64")])
    agent = scripted_agent(
        _lookup("r1", "Welche Unterlagen verlangt die Baubehörde in Wien?"),
        AIMessage(content="Die Antwort [1]."),
    )

    result = await _run(agent)

    ledger = result.retrieval_ledger
    assert ledger is not None and len(ledger) == 1
    assert ledger[0]["hits"] == 2, "one entry per RETURNED passage, not per document listed"
    assert ledger[0]["documents"] == 1
    assert [doc["detail"] for doc in ledger[0]["docs"]] == ["§ 63 Abs 1", "§ 64"]


@pytest.mark.asyncio
async def test_each_round_owns_the_passages_it_returned(scripted_agent):
    """The stamp has to survive the agent→tools node boundary, or round 1's
    passages are filed under round 0 and the Herleitung draws one layer."""
    RETURNED.append([_passage("§ 63 Abs 1")])
    RETURNED.append([_passage("§ 5", title="Wiener Garagengesetz 2008", url=_GARAGE_URL)])
    agent = scripted_agent(
        _lookup("r1", "Welche Unterlagen verlangt die Baubehörde?"),
        _lookup("r2", "Wie viele Stellplätze?", conclusion="Die Unterlagen stehen; jetzt die Stellplätze."),
        AIMessage(content="Die Antwort [1]."),
    )

    result = await _run(agent)

    ledger = result.retrieval_ledger
    assert [entry["index"] for entry in ledger] == [0, 1]
    assert [entry["hits"] for entry in ledger] == [1, 1]
    assert ledger[0]["docs"][0]["title"] == "Bauordnung für Wien"
    assert ledger[1]["docs"][0]["title"] == "Wiener Garagengesetz 2008"
    assert ledger[1]["new_docs"] == [_GARAGE_URL], "the second law was not read in round 0"


@pytest.mark.asyncio
async def test_a_miss_is_a_round_with_no_documents_not_a_missing_round(scripted_agent):
    """A lookup that found nothing is still something the turn did."""
    RETURNED.append([])
    agent = scripted_agent(
        _lookup("r1", "Wie hoch ist die Grunderwerbsteuer?"),
        AIMessage(content="Dazu finde ich nichts."),
    )

    result = await _run(agent)

    ledger = result.retrieval_ledger
    assert ledger is not None and len(ledger) == 1
    assert ledger[0]["hits"] == 0
    assert ledger[0]["corpora"] == ["ris"], "the `ris_` prefix still places the tool in its corpus"


@pytest.fixture
def status_steps():
    """Every status payload pushed during the test, oldest first."""
    from nat.builder.context import ContextState
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())
    seen: list[dict] = []

    def _on_next(step) -> None:
        body = getattr(step.payload.data, "input", None)
        if isinstance(body, str) and str(step.payload.event_type).endswith("START"):
            seen.append(json.loads(body))

    state.event_stream.get().subscribe(_on_next)
    yield seen
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())


@pytest.mark.asyncio
async def test_the_round_takes_its_checkpoint_from_the_conclusion_argument(scripted_agent, status_steps):
    """`conclusion=` is in the signature, so the checkpoint is a SLOT the model
    fills rather than prose it usually skips — which is the whole reason the
    argument exists on every retrieval tool. A RIS round that could not reach
    the argument channel would fall back to "none" and the Herleitung would
    draw a layer with no body."""
    RETURNED.append([_passage("§ 63 Abs 1")])
    agent = scripted_agent(
        _lookup("r1", "Welche Unterlagen?", conclusion="Ich kenne die Bauordnung noch nicht."),
        AIMessage(content="Die Antwort [1]."),
    )

    await _run(agent)

    checkpoints = [step for step in status_steps if str(step.get("slot", "")).startswith("checkpoint")]
    assert checkpoints, "a retrieval round must announce a checkpoint"
    assert checkpoints[0]["source"] == "argument"

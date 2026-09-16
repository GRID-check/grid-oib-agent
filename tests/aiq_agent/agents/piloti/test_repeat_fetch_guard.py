"""A turn fetches each passage once: the second identical call is not made.

Within one turn the model re-asks for what it already holds — the same
``read_passage(document, punkt)`` a round later, the same ``knowledge_search``
query with the same narrowing. Until now only prompt prose forbade it ("a
second identical search is wasted"), and prose does not hold: the call is
charged when the model emits it and never refunded, so a re-fetch costs the
round that would have found the thing it was still missing.

The guard is built on ONE pure derivation (``agent._repeat_fetches``) read in
BOTH nodes — the agent node decides what to charge, the tools node what to run.
It is the only guard on that seam now that the round-zero fan-out cap is gone.
So these tests go through the COMPILED
GRAPH and assert both halves; a unit test of either one passes while they
disagree, and a disagreement means either a charge for a call nothing executed
or a call nothing paid for.

The transcript invariant is pinned here too. The AIMessage keeps every tool
call it made and each one gets exactly one result — the withheld ones get the
FIRST execution's own result back, behind one line saying it is the earlier one
— because a provider rejects a tool result with no matching call, and rejects
an un-answered call too.

What a withheld repeat is ANSWERED with is the other half of the guard. A tool
delivers an answer; a sentence pointing at the transcript ("das Ergebnis oben
ist die Antwort") asks the model to go and find something, and a model that
cannot find it asks a third time. So the cached result comes back verbatim, and
the retry the notice was trying to talk the model out of has nothing left to
want.
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

from aiq_agent.agents.piloti.agent import _REPEAT_FETCH_MESSAGE
from aiq_agent.agents.piloti.agent import _REPEAT_FETCH_PREFIX
from aiq_agent.agents.piloti.agent import _SYNTHESIS_ANCHOR
from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.turn_status import FETCH_FAILED_MARKER
from aiq_agent.common.turn_status import current_retrieval_round

#: The research budget these tests run on. Small, so a runaway loop hits the
#: ceiling inside the test rather than inside the recursion limit.
_CEILING = 7

#: Which tools actually ran, in execution order. Module level because a
#: LangChain ``@tool`` is a module-level object; cleared per test.
RAN: list[str] = []

#: ``(tool, the round stamp it saw)`` for every tool that RAN. The stamp is
#: what files a result under a layer of the Herleitung, and it is only readable
#: from inside the running tool.
STAMPS: list[tuple[str, int | None]] = []


@tool
def knowledge_search(
    query: str,
    doc_class: str | None = None,
    title_contains: str | None = None,
    file_name: str | None = None,
    folder: str | None = None,
    filters: dict | None = None,
) -> str:
    """Search the OIB knowledge corpus."""
    if query in FAILING_QUERIES:
        FAILING_QUERIES.discard(query)
        RAN.append(f"knowledge_search:{query}|{file_name or ''}:failed")
        return (
            f"{FETCH_FAILED_MARKER} Knowledge search failed for query={query!r}. "
            "Retry once with the same query; if it fails again, say you could not search."
        )
    RAN.append(f"knowledge_search:{query}|{file_name or ''}")
    STAMPS.append(("knowledge_search", current_retrieval_round()))
    return f"Treffer zu: {query}"


@tool
def read_passage(document: str, punkt: str | None = None, page: int | None = None) -> str:
    """Open a named passage of a known document."""
    RAN.append(f"read_passage:{document}|{punkt or ''}|{page or ''}")
    STAMPS.append(("read_passage", current_retrieval_round()))
    return f"Passage aus {document}"


#: Queries the fake store refuses, once each: the first call comes back as the
#: tool's own failure PROSE (marked), the retry succeeds — the exact shape of a
#: store that was briefly unreachable.
FAILING_QUERIES: set[str] = set()


@tool
def ris_search_tool(query: str) -> str:
    """Search Austrian law in RIS."""
    RAN.append(f"ris_search_tool:{query}")
    return f"RIS-Treffer zu: {query}"


@tool
def web_search_tool(query: str) -> str:
    """Search the web."""
    RAN.append(f"web_search_tool:{query}")
    return f"Web-Treffer zu: {query}"


@tool
def emit_card(kind: str) -> str:
    """Emit a UI card."""
    RAN.append(f"emit_card:{kind}")
    STAMPS.append(("emit_card", current_retrieval_round()))
    return "Karte erstellt"


_TOOLS = [knowledge_search, read_passage, ris_search_tool, web_search_tool, emit_card]


@pytest.fixture(autouse=True)
def _clean_slate():
    FAILING_QUERIES.clear()
    RAN.clear()
    STAMPS.clear()
    turn_status._retrieval_round.set(None)
    yield
    RAN.clear()
    STAMPS.clear()
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


def _agent(llm: MagicMock) -> PilotiAgent:
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return PilotiAgent(llm_provider=provider, tools=_TOOLS, max_tool_iterations=_CEILING)


@pytest.fixture
def scripted_agent():
    """A PilotiAgent whose LLM plays a fixed script of tool rounds."""

    def build(*rounds: AIMessage) -> PilotiAgent:
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(side_effect=list(rounds))
        return _agent(llm)

    return build


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


async def _run(agent: PilotiAgent, question: str = "Wie lang darf der Fluchtweg sein?"):
    return await agent.run(ResearchAgentState(messages=[HumanMessage(content=question)]))


def _tool_messages(result) -> list[ToolMessage]:
    return [m for m in result.messages if isinstance(m, ToolMessage)]


def _answer_for(result, call_id: str) -> str:
    (message,) = [m for m in _tool_messages(result) if m.tool_call_id == call_id]
    return str(message.content)


def _is_repeat_notice(text: str) -> bool:
    """Whether a tool result is the guard's answer rather than a fresh fetch."""
    return text.startswith(_REPEAT_FETCH_PREFIX) or text == _REPEAT_FETCH_MESSAGE


def _asked(result) -> list[str]:
    """Every tool-call id the model asked for, in order."""
    return [call["id"] for m in result.messages if isinstance(m, AIMessage) for call in (m.tool_calls or [])]


class TestTheSecondIdenticalFetch:
    async def test_the_same_search_a_round_later_is_answered_not_run(self, scripted_agent, steps):
        agent = scripted_agent(
            _batch(_call("knowledge_search", "a", query="Fluchtweglänge GK4")),
            _batch(_call("knowledge_search", "b", query="Fluchtweglänge GK4")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert RAN == ["knowledge_search:Fluchtweglänge GK4|"]
        # The repeat is answered with what the first call returned, not with a
        # pointer at the transcript.
        assert _answer_for(result, "b") == f"{_REPEAT_FETCH_PREFIX}\n\nTreffer zu: Fluchtweglänge GK4"
        # One round for the search that ran, and one for the round that asked
        # again: the guard saves the FETCH, not the round.
        assert result.tool_iterations == 2
        # The call stays on the AIMessage: the transcript shows what was asked.
        assert _asked(result) == ["a", "b"]
        # And a round that fetched nothing is not a layer of the spine.
        assert [step["slot"] for step in steps if str(step["slot"]).startswith("retrieval")] == ["retrieval:0"]

    async def test_the_withheld_round_is_reported_as_its_own_technical_event(self, scripted_agent, steps):
        agent = scripted_agent(
            _batch(_call("read_passage", "a", document="OIB-Richtlinie 2", punkt="3.5.2")),
            _batch(_call("read_passage", "b", document="OIB-Richtlinie 2", punkt="3.5.2")),
            AIMessage(content="Die Antwort [1]."),
        )

        await _run(agent)

        (record,) = [step for step in steps if str(step["slot"]).startswith("repeat")]
        assert record["step"] == "status:repeat:1"
        assert (record["round"], record["withheld"]) == (1, 1)
        assert record["channel"] == turn_status.CHANNEL_TECHNICAL

    async def test_two_identical_calls_in_ONE_batch_run_once(self, scripted_agent):
        """The first occurrence runs; the rest are the same guess said twice."""
        agent = scripted_agent(
            _batch(
                _call("read_passage", "a", document="OIB-Richtlinie 2", punkt="3.5.2"),
                _call("read_passage", "b", document="OIB-Richtlinie 2", punkt="3.5.2"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert RAN == ["read_passage:OIB-Richtlinie 2|3.5.2|"]
        # Its own batch's result, which the round produced a moment earlier.
        assert _answer_for(result, "b") == f"{_REPEAT_FETCH_PREFIX}\n\nPassage aus OIB-Richtlinie 2"
        assert result.tool_iterations == 1

    async def test_case_whitespace_and_a_trailing_dot_are_the_same_passage(self, scripted_agent):
        """How the model typed the address is not part of the address."""
        agent = scripted_agent(
            _batch(_call("read_passage", "a", document="OIB-Richtlinie 2.pdf", punkt="3.5.2.")),
            _batch(_call("read_passage", "b", document="  oib-richtlinie 2.PDF ", punkt="3.5.2")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert RAN == ["read_passage:OIB-Richtlinie 2.pdf|3.5.2.|"]
        assert _answer_for(result, "b") == f"{_REPEAT_FETCH_PREFIX}\n\nPassage aus OIB-Richtlinie 2.pdf"

    async def test_every_call_still_gets_exactly_one_result(self, scripted_agent):
        """The transcript invariant: a provider rejects an un-answered call and
        rejects a result with no call, so the two sets must be equal."""
        agent = scripted_agent(
            _batch(
                _call("knowledge_search", "a", query="Fluchtweg"),
                _call("knowledge_search", "b", query="fluchtweg"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        answered = [m.tool_call_id for m in _tool_messages(result)]
        assert sorted(answered) == sorted(_asked(result))
        assert len(answered) == len(set(answered)), "a call answered twice is as invalid as one answered never"


class TestWhatIsNotARepeat:
    async def test_the_same_document_at_another_page_is_another_passage(self, scripted_agent):
        agent = scripted_agent(
            _batch(_call("read_passage", "a", document="Brandschutzkonzept.pdf", page=12)),
            _batch(_call("read_passage", "b", document="Brandschutzkonzept.pdf", page=13)),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert RAN == ["read_passage:Brandschutzkonzept.pdf||12", "read_passage:Brandschutzkonzept.pdf||13"]
        assert not any(_is_repeat_notice(str(m.content)) for m in _tool_messages(result))
        assert result.tool_iterations == 2

    async def test_the_same_query_narrowed_to_another_file_is_another_search(self, scripted_agent):
        """A narrowing argument changes which corpus answers, so it is identity."""
        agent = scripted_agent(
            _batch(_call("knowledge_search", "a", query="Fluchtweg")),
            _batch(_call("knowledge_search", "b", query="Fluchtweg", file_name="Brandschutz.pdf")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert RAN == ["knowledge_search:Fluchtweg|", "knowledge_search:Fluchtweg|Brandschutz.pdf"]
        assert not any(_is_repeat_notice(str(m.content)) for m in _tool_messages(result))
        assert result.tool_iterations == 2

    async def test_a_tool_that_is_not_a_fetch_is_never_withheld(self, scripted_agent):
        """Two identical cards are two cards. Only a passage is the same bytes twice."""
        agent = scripted_agent(
            _batch(_call("emit_card", "a", kind="legal_basis")),
            _batch(_call("emit_card", "b", kind="legal_basis")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert RAN == ["emit_card:legal_basis", "emit_card:legal_basis"]
        assert not any(_is_repeat_notice(str(m.content)) for m in _tool_messages(result))


class TestTheGuardIsTheOnlyOneOnTheSeam:
    async def test_a_batch_keeps_everything_but_its_own_duplicate(self, scripted_agent):
        """A first round of three searches runs three searches, minus the repeat.

        Nothing caps a round's fan-out any more: the budget bounds what a turn
        may spend without judging the shape of one round. What is still withheld
        is only the call whose answer the turn already holds — here the second
        „Fluchtweg", identical to the first in the same batch.
        """
        agent = scripted_agent(
            _batch(
                _call("knowledge_search", "a", query="Fluchtweg"),
                _call("knowledge_search", "b", query="Fluchtweg"),
                _call("knowledge_search", "c", query="Treppenraum"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        # A set: one batch's parallel calls run concurrently and their append
        # order is the scheduler's (docs/contributing/gotchas.md).
        assert set(RAN) == {"knowledge_search:Fluchtweg|", "knowledge_search:Treppenraum|"}
        assert len(RAN) == 2
        assert _answer_for(result, "b") == f"{_REPEAT_FETCH_PREFIX}\n\nTreffer zu: Fluchtweg"
        assert not _is_repeat_notice(_answer_for(result, "c"))
        # ONE round: three calls the model decided on in one go, minus the
        # repeat that never ran, is still one decision and costs one.
        assert result.tool_iterations == 1


class TestAFailedFetchIsNotAFetch:
    """The guard withholds a repeat because the answer is already above.

    That is only true when something was fetched. Both retrieval tools answer
    an unreachable store with prose asking the model to RETRY the identical
    call — so a failure that signed itself as executed turned the tool's own
    instruction into a call the guard refused, and the passage was never read
    at all. Nothing in the answer would have said so.
    """

    async def test_the_retry_of_a_failed_search_runs(self, scripted_agent):
        FAILING_QUERIES.add("Fluchtweglänge GK4")
        agent = scripted_agent(
            _batch(_call("knowledge_search", "a", query="Fluchtweglänge GK4")),
            _batch(_call("knowledge_search", "b", query="Fluchtweglänge GK4")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert RAN == [
            "knowledge_search:Fluchtweglänge GK4|:failed",
            "knowledge_search:Fluchtweglänge GK4|",
        ], "the retry the tool asked for was withheld as a repeat"
        assert not _is_repeat_notice(_answer_for(result, "b"))
        assert _answer_for(result, "b") == "Treffer zu: Fluchtweglänge GK4"

    async def test_a_third_call_after_the_retry_succeeded_is_withheld_again(self, scripted_agent):
        """The exemption is the failure, not the query: once it answers, the
        guard is back."""
        FAILING_QUERIES.add("Fluchtweglänge GK4")
        agent = scripted_agent(
            _batch(_call("knowledge_search", "a", query="Fluchtweglänge GK4")),
            _batch(_call("knowledge_search", "b", query="Fluchtweglänge GK4")),
            _batch(_call("knowledge_search", "c", query="Fluchtweglänge GK4")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert len(RAN) == 2
        assert _answer_for(result, "c") == f"{_REPEAT_FETCH_PREFIX}\n\nTreffer zu: Fluchtweglänge GK4"


class TestTheLoopStillTerminates:
    async def test_a_model_that_repeats_forever_reaches_synthesis(self):
        """A withheld fetch is free; the round that asked for it is not.

        The round cost an LLM call and two graph steps and nothing ran to pay
        for them, so it is charged one ROUND — the budget it was trying to
        spend. That is what ends this loop: the model walks into the ceiling in
        at most `ceiling` rounds and is forced into synthesis, instead of
        running until ``GraphRecursionError`` and leaving the reader no answer
        at all.
        """
        rounds = {"n": 0}

        async def _reply(messages, **_kwargs):
            if any(_SYNTHESIS_ANCHOR in str(getattr(message, "content", "")) for message in messages):
                return AIMessage(content="Die Antwort [1].")
            rounds["n"] += 1
            return _batch(_call("knowledge_search", f"r{rounds['n']}", query="Fluchtweglänge GK4"))

        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(side_effect=_reply)

        result = await _run(_agent(llm))

        assert RAN == ["knowledge_search:Fluchtweglänge GK4|"], "the fetch ran once, however often it was asked for"
        assert result.messages[-1].content == "Die Antwort [1]."
        assert result.research_truncated is True
        assert result.tool_iterations >= _CEILING
        # Bounded well inside what ``_recursion_limit`` was sized for.
        assert rounds["n"] <= _CEILING


class TestTheNoticeItself:
    def test_the_prefix_labels_the_result_and_says_what_to_do_next(self):
        """It must read as the EARLIER result, not as a second agreeing one.

        Two answers that look independent are two sources to a model counting
        agreement, which is exactly the false confidence the guard is supposed
        to save the turn from paying for twice.
        """
        assert "bereits" in _REPEAT_FETCH_PREFIX
        assert "nicht erneut" in _REPEAT_FETCH_PREFIX
        assert "andere" in _REPEAT_FETCH_PREFIX

    def test_the_fallback_still_says_the_answer_is_already_there(self):
        """When the turn does not hold the result, an error string would invite
        a retry of the identical call."""
        assert "bereits" in _REPEAT_FETCH_MESSAGE
        assert "Ergebnis oben" in _REPEAT_FETCH_MESSAGE
        assert "andere" in _REPEAT_FETCH_MESSAGE


class TestWhatTheSurvivingCallIsFiledUnder:
    """The round stamp is derived from the calls that RUN, never from the raw message.

    The two nodes agree about which calls are withheld; the stamp has to agree
    too. The agent node decides „is this a retrieval round?" off what SURVIVED
    the guards — a round whose only fetch was withheld announces nothing and
    advances no counter — while the tools node used to ask the same question of
    the AIMessage, which still carries every call the model asked for. A round
    of [duplicate fetch, emit_card] therefore answered „yes" on one side and
    „no" on the other, and the card's result was filed under the PREVIOUS
    round's search: a layer of the Herleitung gaining a fact that belongs to
    nothing it did.
    """

    async def test_a_surviving_action_call_is_not_filed_under_the_last_search(self, scripted_agent):
        agent = scripted_agent(
            _batch(_call("read_passage", "a", document="OIB-Richtlinie 2", punkt="3.5.2")),
            _batch(
                _call("read_passage", "b", document="OIB-Richtlinie 2", punkt="3.5.2"),
                _call("emit_card", "c", kind="legal_basis"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        await _run(agent)

        assert STAMPS == [
            ("read_passage", 0),
            # Round 1 fetched nothing: its only fetch was the repeat. What ran
            # is an action, and an action belongs to no layer of the spine —
            # stamping it 0 would hang the card on the search before it.
            ("emit_card", None),
        ]

    async def test_a_round_that_still_fetches_keeps_its_own_number(self, scripted_agent):
        """The guard took one call; the round is still a fetch round, and the
        search that survived is filed under the round that announced it."""
        agent = scripted_agent(
            _batch(_call("knowledge_search", "a", query="Fluchtweg")),
            _batch(
                _call("knowledge_search", "b", query="Fluchtweg"),
                _call("knowledge_search", "c", query="Treppenraum"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        await _run(agent)

        assert STAMPS == [("knowledge_search", 0), ("knowledge_search", 1)]

"""The held-evidence decision (ADR-0064 use 10): what the transcript holds, asked of the new message.

The decider is stubbed; what is pinned is the seam. The passages are read
back out of the previous turn's tool results with the parser the registry
uses, an uncited passage (compacted to its header) is not held, a confident
yes removes round 0 and puts the block in the prompt, and anything short of
one — a no, no passages, no decision, the config switched off — leaves the
turn as it ran before.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage

import aiq_agent.agents.piloti.register as register_module
from aiq_agent.agents.piloti import held_evidence
from aiq_agent.agents.piloti.decisions import TurnDecisions
from aiq_agent.agents.piloti.held_evidence import HELD_THRESHOLD
from aiq_agent.agents.piloti.held_evidence import MAX_HELD_PASSAGES
from aiq_agent.agents.piloti.held_evidence import HeldCoverage
from aiq_agent.agents.piloti.held_evidence import HeldPassage
from aiq_agent.agents.piloti.held_evidence import decide_held
from aiq_agent.agents.piloti.held_evidence import held_passages
from aiq_agent.agents.piloti.held_evidence import render_held_block
from aiq_agent.agents.piloti.history import UNCITED_PASSAGE_NOTE
from aiq_agent.agents.piloti.history import compact_tool_results
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_system_prompt
from aiq_agent.agents.piloti.prompt import system_prompt_template
from aiq_agent.agents.piloti.register import ResearchAgentConfig
from aiq_agent.common.decisions import Decision
from aiq_agent.common.grounding_block import GroundingBlock
from aiq_agent.common.grounding_block import GroundingHit
from aiq_agent.common.grounding_block import render_grounding_block

from .test_register_decisions import _run_turn

PUNKT_12 = "oib-rl_2_ausgabe_mai_2023.pdf, p.14"
PUNKT_2 = "oib-rl_2_ausgabe_mai_2023.pdf, p.4"


@pytest.fixture(autouse=True)
def _knowledge_search_is_a_data_source(monkeypatch):
    monkeypatch.setattr(
        "aiq_agent.common.data_source_registry._tool_source_map", {"knowledge_search": "knowledge_layer"}
    )


def _hit(key: str, page: int, punkt: str, body: str) -> GroundingHit:
    return GroundingHit(
        citation_key=key,
        file_name="oib-rl_2_ausgabe_mai_2023.pdf",
        page=page,
        shelf=None,
        collection="oib_knowledge",
        doc_class=None,
        display_title="oib-rl_2_ausgabe_mai_2023.pdf",
        folder_path=None,
        punkt=punkt,
        score=0.8,
        content_type="text",
        provenance=None,
        stored_image_index=None,
        status_note=None,
        body=body,
    )


def _search_result() -> str:
    return render_grounding_block(
        GroundingBlock(
            preamble="Found 2 results",
            degraded_banner="",
            hits=(
                _hit(PUNKT_12, 14, "12", "Bei Änderungen an bestehenden Bauwerken sind Abweichungen zulässig."),
                _hit(PUNKT_2, 4, "2", "Zusätzliche Bekleidungen und Beläge nach Tabelle 1a."),
            ),
            lanes=(),
            tool="knowledge_search",
        )
    )


def _researched_turn(question: str, cited: set[str]) -> list:
    """A turn written back the way ``conversation._answer_update`` writes it: results cut to what was cited."""
    call = {"name": "knowledge_search", "args": {"query": question}, "id": "c1"}
    result = ToolMessage(content=_search_result(), tool_call_id="c1", name="knowledge_search")
    return [
        HumanMessage(content=question),
        AIMessage(content="", tool_calls=[call]),
        *compact_tool_results([result], cited),
        AIMessage(content="Die OIB-Richtlinie 2 regelt den Brandschutz."),
    ]


class TestTheHeldPassages:
    def test_only_the_cited_passages_are_held(self):
        messages = [*_researched_turn("was weißt du zur oib 2", {PUNKT_12}), HumanMessage(content="nochmal?")]
        (passage,) = held_passages(messages)
        assert (passage.citation_key, passage.punkt) == (PUNKT_12, "12")
        assert passage.text.startswith("Bei Änderungen") and UNCITED_PASSAGE_NOTE not in passage.text

    def test_the_current_question_holds_nothing_and_a_first_message_nothing_at_all(self):
        assert held_passages([HumanMessage(content="was weißt du zur oib 2")]) == []

    def test_a_tool_that_is_not_a_data_source_holds_nothing(self):
        messages = [
            HumanMessage(content="merk dir das"),
            ToolMessage(content=_search_result(), tool_call_id="c1", name="remember"),
            HumanMessage(content="und?"),
        ]
        assert held_passages(messages) == []

    def test_a_passage_read_twice_is_held_once_at_its_last_position(self):
        turn = _researched_turn("q", {PUNKT_12, PUNKT_2})
        messages = [*turn, *turn[1:], HumanMessage(content="nochmal?")]
        assert [p.citation_key for p in held_passages(messages)] == [PUNKT_12, PUNKT_2]

    def test_two_passages_on_one_page_are_two_passages(self):
        """They share a citation key (file and page); keying on it alone dropped the first."""
        call = {"name": "knowledge_search", "args": {"query": "q"}, "id": "c1"}
        text = render_grounding_block(
            GroundingBlock(
                preamble="Found 2 results",
                degraded_banner="",
                hits=(
                    _hit(PUNKT_12, 14, "11", "Punkt 11 regelt die Nachweise."),
                    _hit(PUNKT_12, 14, "12", "Punkt 12 regelt den Bestand."),
                ),
                lanes=(),
                tool="knowledge_search",
            )
        )
        messages = [
            HumanMessage(content="q"),
            AIMessage(content="", tool_calls=[call]),
            ToolMessage(content=text, tool_call_id="c1", name="knowledge_search"),
            HumanMessage(content="und Punkt 12?"),
        ]
        texts = [p.text for p in held_passages(messages)]
        assert any("Punkt 11" in t for t in texts) and any("Punkt 12" in t for t in texts)

    def test_the_passages_are_bounded_to_the_most_recent(self):
        turn = _researched_turn("q", {PUNKT_12, PUNKT_2})
        assert [p.citation_key for p in held_passages([*turn, HumanMessage(content="?")], limit=1)] == [PUNKT_2]
        assert MAX_HELD_PASSAGES > 0


def _decision(p: float) -> Decision:
    return Decision(answers={"held": {"type": "noul", "noul": p}})


PASSAGES = (HeldPassage(citation_key=PUNKT_12, source="oib-rl_2_ausgabe_mai_2023.pdf", punkt="12", text="x" * 900),)


class TestTheDecision:
    async def test_the_decider_reads_the_message_and_the_bounded_passages(self):
        with patch("aiq_agent.common.decisions.decide", new_callable=AsyncMock, return_value=_decision(0.9)) as decide:
            coverage = await decide_held("Was bedeutet Punkt 12?", PASSAGES, organization_id="org-1")
        assert coverage == HeldCoverage(p=0.9, passages=PASSAGES) and coverage.covered
        state, questions = decide.await_args.args
        assert state["message"] == "Was bedeutet Punkt 12?"
        assert state["passages"] == [
            {"source": "oib-rl_2_ausgabe_mai_2023.pdf", "citation": PUNKT_12, "punkt": "12", "text": "x" * 600}
        ]
        assert list(questions) == ["held"] and questions["held"]["type"] == "noul"
        assert decide.await_args.kwargs == {"slot": "held", "organization_id": "org-1"}
        assert "open_document" not in state

    async def test_the_open_document_is_part_of_the_state(self):
        """„Fass das Dokument zusammen" means the file open NOW, which the old passages may not be from."""
        with patch("aiq_agent.common.decisions.decide", new_callable=AsyncMock, return_value=_decision(0.1)) as decide:
            await decide_held("Fass das Dokument zusammen", PASSAGES, open_document="Bescheid.pdf")
        state, questions = decide.await_args.args
        assert state["open_document"] == "Bescheid.pdf"
        assert "open one" in questions["held"]["criteria"]["false"]

    async def test_below_the_threshold_is_not_covered(self):
        with patch("aiq_agent.common.decisions.decide", new_callable=AsyncMock, return_value=_decision(0.79)):
            coverage = await decide_held("Und in Tirol?", PASSAGES)
        assert coverage is not None and not coverage.covered and HELD_THRESHOLD == 0.8

    async def test_nothing_to_judge_asks_nothing(self):
        with patch("aiq_agent.common.decisions.decide", new_callable=AsyncMock) as decide:
            assert await decide_held("Was bedeutet Punkt 12?", ()) is None
        decide.assert_not_awaited()

    async def test_no_decision_is_no_verdict(self):
        with patch("aiq_agent.common.decisions.decide", new_callable=AsyncMock, return_value=None):
            assert await decide_held("Was bedeutet Punkt 12?", PASSAGES) is None

    async def test_switched_off_globally_is_no_verdict(self, emitted):
        """The conftest turns the endpoint off: the decision records why it did not run."""
        assert await decide_held("Was bedeutet Punkt 12?", PASSAGES) is None
        (record,) = emitted.steps
        assert (record.id, record.detail) == ("status:decision:held", {"skipped": "disabled"})


class TestTheBlock:
    def test_a_confident_yes_names_the_passages_and_leaves_the_tools(self):
        block = render_held_block(HeldCoverage(p=0.91, passages=PASSAGES)) or ""
        assert block.startswith("## Already read in this conversation")
        assert f"- {PUNKT_12} (Punkt 12)" in block and "p = 0.91" in block
        # Bounded, and says so; a pointer, not a rule.
        assert f"at most {MAX_HELD_PASSAGES}" in block and "search as you would" in block

    def test_anything_short_of_a_confident_yes_renders_nothing(self):
        assert render_held_block(None) is None
        assert render_held_block(HeldCoverage(p=0.5, passages=PASSAGES)) is None

    def test_the_block_sits_after_the_already_read_digest(self):
        state = ResearchAgentState(
            messages=[HumanMessage(content="Was bedeutet Punkt 12?")],
            already_read_digest=["oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 14 | Punkte 12 | Turn 1"],
            held_evidence_block=render_held_block(HeldCoverage(p=0.91, passages=PASSAGES)),
        )
        rendered = render_system_prompt(system_prompt_template(), state, [{"name": "knowledge_search"}])
        assert rendered.rindex("## Bereits gelesen") < rendered.index("## Already read in this conversation")


OIB_2 = "was weißt du zur oib 2"
DECIDED = TurnDecisions(decided=True, needs_evidence=0.9, corpus="baurecht", corpus_p=0.9, self_contained=0.95)
CONFIG = ResearchAgentConfig(llm="research_llm", tools=["knowledge_search"], skills_enabled=False)


def _repeat() -> list:
    return [*_researched_turn(OIB_2, {PUNKT_12}), HumanMessage(content=OIB_2)]


class TestTheTurn:
    async def test_a_confident_yes_skips_round_0_and_rides_the_prompt(self):
        with patch.object(register_module, "decide_held", new_callable=AsyncMock) as decide:
            decide.return_value = HeldCoverage(p=0.93, passages=PASSAGES)
            turn, state, _ = await _run_turn(CONFIG, DECIDED, _repeat())
        assert turn.prefetch == ()
        assert state.held_evidence_block and PUNKT_12 in state.held_evidence_block
        # The question and the passages the transcript holds are what was asked.
        message, passages = decide.await_args.args
        assert message == OIB_2 and [p.citation_key for p in passages] == [PUNKT_12]
        assert decide.await_args.kwargs["open_document"] is None

    async def test_the_open_file_reaches_the_decision(self):
        with patch.object(register_module, "decide_held", new_callable=AsyncMock, return_value=None) as decide:
            await _run_turn(CONFIG, DECIDED, _repeat(), focus_file_name="Bescheid.pdf")
        assert decide.await_args.kwargs["open_document"] == "Bescheid.pdf"

    async def test_a_no_leaves_round_0_as_the_turn_decision_named_it(self):
        with patch.object(register_module, "decide_held", new_callable=AsyncMock) as decide:
            decide.return_value = HeldCoverage(p=0.2, passages=PASSAGES)
            turn, state, _ = await _run_turn(CONFIG, DECIDED, _repeat())
        assert turn.prefetch == ({"name": "knowledge_search", "args": {"query": OIB_2}},)
        assert state.held_evidence_block is None

    async def test_a_failing_decider_leaves_the_turn_as_before(self):
        with patch.object(register_module, "decide_held", new_callable=AsyncMock, side_effect=RuntimeError("down")):
            turn, state, _ = await _run_turn(CONFIG, DECIDED, _repeat())
        assert turn.prefetch == ({"name": "knowledge_search", "args": {"query": OIB_2}},)
        assert state.held_evidence_block is None

    async def test_a_first_message_is_never_asked(self):
        with patch.object(register_module, "decide_held", new_callable=AsyncMock) as decide:
            await _run_turn(CONFIG, DECIDED, [HumanMessage(content=OIB_2)])
        decide.assert_not_awaited()

    @pytest.mark.parametrize(
        "config",
        [
            ResearchAgentConfig(
                llm="research_llm", tools=["knowledge_search"], skills_enabled=False, held_evidence=False
            ),
            ResearchAgentConfig(
                llm="research_llm", tools=["knowledge_search"], skills_enabled=False, turn_decisions=False
            ),
        ],
        ids=["held_evidence off", "turn_decisions off"],
    )
    async def test_switched_off_is_never_asked(self, config):
        with patch.object(register_module, "decide_held", new_callable=AsyncMock) as decide:
            _turn, state, _ = await _run_turn(config, DECIDED, _repeat())
        decide.assert_not_awaited()
        assert state.held_evidence_block is None


def test_the_question_is_about_the_evidence_not_the_wording():
    """A rephrasing is a yes; a Land, a class or detail the passages lack is a no."""
    (entry,) = held_evidence.question().values()
    assert "rephrase" in entry["criteria"]["true"]
    assert all(word in entry["criteria"]["false"] for word in ("Land", "building class", "more detail"))

"""The dialect validator and the quote stamps, inside the answer pipeline.

``finalize_answer`` holds the answer to the dialect after the citations are
verified and before hygiene (``common/answer_dialect.py``), and stamps each
quote line on the text the reader gets (``common/quote_stamps.py``). The live
settle holds the dialect the same way, so a block the terminal unwraps is not
drawn first. The stamps then travel: Piloti's state, the conversation state,
``TurnResult.quote_stamps``, and the persisted row.
"""

from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti import answer_pipeline
from aiq_agent.agents.piloti.answer_pipeline import finalize_answer
from aiq_agent.agents.piloti.answer_pipeline import settle_streamed_citations
from aiq_agent.agents.piloti.conversation import ANSWER_LIFTS
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.turn.response import build_result

PASSAGE = "Brandabschnitte dürfen eine Nettogrundfläche von höchstens 1.200 m² aufweisen."
SOURCES = "**Quellen:**\n- [1] rl2.pdf, p.3"
CHECK = (
    ":::check\n| Anforderung | Nachweis | Status | Fundstelle |\n|---|---|---|---|\n"
    "| Brandabschnitt ≤ 1.200 m² | 1.150 m² | erfüllt | [1] |\n:::"
)


@pytest.fixture(autouse=True)
def card_registry():
    registry = CardRegistry()
    token = set_card_registry(registry)
    yield registry
    reset_card_registry(token)


@pytest.fixture
def traced(monkeypatch):
    recorded: list[dict] = []
    monkeypatch.setattr(answer_pipeline, "record_trace_metadata", lambda **pairs: recorded.append(pairs))
    return recorded


def _sources() -> SourceRegistry:
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="rl2.pdf, p.3", title="OIB-RL 2", chunk_text=PASSAGE, punkt="3.1"))
    return registry


async def _finalize(answer: str, kind: str):
    envelope = {"kind": kind, "answer": answer}
    message = AIMessage(content="```answer_json\n" + json.dumps(envelope, ensure_ascii=False) + "\n```")
    return await finalize_answer([HumanMessage(content="?"), message], registry=_sources(), tools=[], repair=None)


@pytest.mark.asyncio
async def test_a_direct_answer_is_unwrapped_keeping_its_rows_and_the_census_is_traced(traced):
    final = await _finalize(f"Der Abschnitt bleibt unter der Grenze [1].\n\n{CHECK}\n\n{SOURCES}", "direct")

    assert ":::check" not in final.content
    assert "| Brandabschnitt ≤ 1.200 m² | 1.150 m² | erfüllt | [1] |" in final.content
    assert final.dialect_repairs == ({"repair": "unwrap_over_budget", "name": "check"},)
    assert traced == [{"answer_dialect": {"blocks": {"check": 1}, "repairs": {"unwrap_over_budget": 1}}}]


@pytest.mark.asyncio
async def test_an_unknown_block_in_a_walkthrough_keeps_its_content(traced):
    answer = f"Vorab [1].\n\n:::hinweis[Achtung]\nDie Frist läuft ab [1].\n:::\n\n{CHECK}\n\n{SOURCES}"
    final = await _finalize(answer, "walkthrough")

    assert ":::hinweis" not in final.content and "**Achtung**" in final.content
    assert "Die Frist läuft ab [1]." in final.content
    assert CHECK in final.content


@pytest.mark.asyncio
async def test_each_quote_line_is_stamped_with_the_passage_that_holds_it(traced):
    invented = "Brandabschnitte dürfen höchstens zwei Geschoße und 2.400 m² umfassen, sagt die Richtlinie."
    answer = f"Die Grenze ist **1.200 m²** [1].\n\n> „{PASSAGE}“ [1]\n\n> „{invented}“ [1]\n\n{SOURCES}"
    final = await _finalize(answer, "ruling")

    verbatim, not_found = final.quote_stamps
    assert verbatim["status"] == "verbatim"
    assert verbatim["text"] == PASSAGE
    assert verbatim["number"] == 1
    assert verbatim["file_name"] == "rl2.pdf" and verbatim["page"] == 3 and verbatim["punkt"] == "3.1"
    assert not_found == {"text": invented, "status": "not_found"}


@pytest.mark.asyncio
async def test_an_answer_without_quote_lines_carries_no_stamps(traced):
    final = await _finalize(f"Die Grenze ist **1.200 m²** [1].\n\n{SOURCES}", "ruling")
    assert final.quote_stamps == ()


def test_the_live_settle_holds_the_dialect_as_the_terminal_does():
    settled = settle_streamed_citations(f"Kurz [1].\n\n{CHECK}", SOURCES, _sources(), kind="direct")
    assert settled is not None
    assert ":::check" not in settled.content
    assert "| Brandabschnitt ≤ 1.200 m² | 1.150 m² | erfüllt | [1] |" in settled.content

    kept = settle_streamed_citations(f"Kurz [1].\n\n{CHECK}", SOURCES, _sources(), kind="walkthrough")
    assert kept is not None and CHECK in kept.content


@pytest.mark.asyncio
async def test_the_stamps_travel_to_the_turn_result(traced):
    final = await _finalize(f"Die Grenze [1].\n\n> „{PASSAGE}“ [1]\n\n{SOURCES}", "ruling")

    state = assemble_result({}, final, turn_sources=[], turn_measurements=[])
    assert state.quote_stamps == list(final.quote_stamps)
    assert ("quote_stamps", "quote_stamps") in ANSWER_LIFTS

    conversation = ConversationState(messages=final.messages, quote_stamps=state.quote_stamps)
    result = build_result(conversation, [], "m1")
    assert [stamp.status for stamp in result.quote_stamps] == ["verbatim"]
    assert result.quote_stamps[0].number == 1
    dumped = result.model_dump(mode="json", exclude_defaults=True)
    assert dumped["quote_stamps"][0] == {
        "text": PASSAGE,
        "status": "verbatim",
        "number": 1,
        "title": "OIB-RL 2",
        "file_name": "rl2.pdf",
        "page": 3,
        "punkt": "3.1",
    }

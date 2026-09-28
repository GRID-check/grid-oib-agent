"""The answer's Markdown directives pass the pipeline as inert text.

The prompt teaches a small directive dialect the renderer draws richly
(``piloti_static.md`` <formatting>, RICH BLOCKS): ``:::pruefung`` around a check
table, ``:::verfahren`` around a Verfahren's list, ``:klasse[B]``, and a cited
quote line ``> „…“ [N]``. None of the post-answer passes knows the dialect, and
none may need to: the fence lines must reach the reader byte-equal, the ``[N]``
inside a block must be verified and renumbered like any other, and a quote
inside one is checked against the source like any quote.
"""

from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage

from aiq_agent.agents.piloti.answer_pipeline import finalize_answer
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import sanitize_report

PASSAGE_A = "Brandabschnitte dürfen eine Nettogrundfläche von höchstens 1.200 m² aufweisen."
PASSAGE_B = "Die Luftschalldämmung zwischen Wohnungen muss mindestens 55 dB betragen."

CHECK = (
    ":::pruefung\n"
    "| Anforderung | Nachweis | Status | Fundstelle |\n"
    "|---|---|---|---|\n"
    "| Luftschalldämmung ≥ 55 dB | 57 dB | erfüllt | [{b}] |\n"
    "| Brandabschnitt ≤ 1.200 m² | 1.150 m² | erfüllt | [{a}] |\n"
    ":::"
)
PROCEDURE = (
    ":::verfahren\n"
    "1. Einreichung beim Magistrat [{a}] :aktuell\n"
    "   :::details[Unterlagen]\n"
    "   - Einreichplan\n"
    "   :::\n"
    "2. Bauverhandlung **binnen sechs Wochen** [{b}]\n"
    ":::"
)
QUOTE = f"> „{PASSAGE_A}“ [{{a}}]"


def _answer(a: str, b: str, *, extra: str = "") -> str:
    blocks = "\n\n".join(block.format(a=a, b=b) for block in (CHECK, PROCEDURE, QUOTE))
    return (
        f"Die Trennwand erfüllt die Anforderung [{b}]; der Abschnitt bleibt unter der Grenze [{a}].{extra}\n\n"
        f"{blocks}\n\nEnergieklasse :klasse[B].\n\n"
        f"**Quellen:**\n- [{a}] rl2.pdf, p.3\n- [{b}] rl5.pdf, p.7"
    )


@pytest.fixture(autouse=True)
def card_registry():
    registry = CardRegistry()
    token = set_card_registry(registry)
    yield registry
    reset_card_registry(token)


def _sources() -> SourceRegistry:
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="rl2.pdf, p.3", chunk_text=PASSAGE_A, source_type="knowledge_layer"))
    registry.add(SourceEntry(citation_key="rl5.pdf, p.7", chunk_text=PASSAGE_B, source_type="knowledge_layer"))
    return registry


async def _finalize(answer: str):
    envelope = {"kind": "walkthrough", "answer": answer}
    message = AIMessage(content="```answer_json\n" + json.dumps(envelope, ensure_ascii=False) + "\n```")
    return await finalize_answer([message], registry=_sources(), tools=[], repair=None)


@pytest.mark.asyncio
async def test_directive_blocks_and_their_citations_reach_the_reader_intact():
    final = await _finalize(_answer("1", "2"))

    for block in (CHECK, PROCEDURE, QUOTE):
        assert block.format(a="1", b="2") in final.content
    assert ":klasse[B]" in final.content
    assert final.quotes_verified is True
    assert final.citation_grounded is True


@pytest.mark.asyncio
async def test_a_dropped_citation_leaves_the_blocks_as_written():
    # [3] resolves to nothing: verification removes it from the prose, and the
    # hygiene pass that closes the gap it leaves must not reach the blocks.
    final = await _finalize(_answer("1", "2").replace("Anforderung [2];", "Anforderung [3];"))

    assert "Anforderung;" in final.content
    for block in (CHECK, PROCEDURE, QUOTE):
        assert block.format(a="1", b="2") in final.content


def test_hygiene_keeps_indentation_and_the_space_before_a_directive():
    # The space collapse once flattened `   :::details` to `:::details`, which
    # closes the outer block early, and the space-before-punctuation rule
    # welded `:klasse[B]` onto the word before it.
    report = "Klasse :klasse[B] und Schritt [1] :aktuell.\n\n1. Schritt\n   :::details[Unterlagen]\n   - Plan\n   :::"

    cleaned = sanitize_report(report).sanitized_report

    assert "Klasse :klasse[B]" in cleaned and "[1] :aktuell." in cleaned
    assert "\n   :::details[Unterlagen]\n   - Plan\n   :::" in cleaned
    assert sanitize_report("Begehung [3] .").sanitized_report.startswith("Begehung [3].")


@pytest.mark.asyncio
async def test_a_quote_inside_a_directive_is_verified_against_the_source():
    invented = "Brandabschnitte dürfen eine Nettogrundfläche von höchstens 2.400 m² und zwei Geschoße umfassen."
    answer = _answer("1", "2").replace(PASSAGE_A, invented)

    final = await _finalize(answer)

    assert final.quotes_verified is False
    assert final.unverified_quote_count == 1
    assert ":::pruefung" in final.content and ":::verfahren" in final.content

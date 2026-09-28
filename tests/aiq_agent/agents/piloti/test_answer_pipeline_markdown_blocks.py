"""A Markdown-first answer comes out of the pipeline as the model wrote it.

The answer carries its structure in Markdown now: a table with a Status column,
a task list, a ```mermaid drawing. Every pass between the model and the reader
(the envelope split, citation verification, quote verification, the reference
brake) reads that Markdown, and each one has, at some point, rewritten or cut
part of it. The envelope once ended at the drawing's opening fence and handed
the reader raw JSON; quote verification once annotated a mermaid label inside
its bracket. This runs the whole finalize path and holds the blocks byte-equal.
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

DRAWING = (
    "```mermaid\n"
    "flowchart TD\n"
    '  E["Einreichung"] --> V{"Vollständig?"}\n'
    '  V -->|nein| N["Verbesserungsauftrag"]\n'
    "  N --> E\n"
    '  V -->|ja| B["Bauverhandlung"]\n'
    "```"
)
TABLE = (
    "| Kriterium | Konzept | Status | Fundstelle |\n"
    "|---|---|---|---|\n"
    "| Stützen oberirdisch | R 90 | erfüllt | [1] |\n"
    "| Trennwände | REI 60 | nicht erfüllt | [1] |"
)
TASKS = "- [x] Einreichplan\n- [ ] Brandschutzkonzept nachreichen"
ANSWER = (
    "Tragende Bauteile brauchen **R 90** [1].\n\n"
    f"### Das Verfahren läuft zurück, wenn etwas fehlt\n\n{DRAWING}\n\n"
    f"### Das Konzept deckt nicht alles\n\n{TABLE}\n\n{TASKS}\n\n"
    "**Quellen:**\n- [1] https://example.com/oib-rl-2"
)


@pytest.fixture(autouse=True)
def card_registry():
    registry = CardRegistry()
    token = set_card_registry(registry)
    yield registry
    reset_card_registry(token)


def _sources() -> SourceRegistry:
    registry = SourceRegistry()
    registry.add(SourceEntry(url="https://example.com/oib-rl-2", tool_name="web"))
    return registry


@pytest.mark.asyncio
async def test_the_drawing_the_table_and_the_task_list_reach_the_reader_intact():
    envelope = {"answer": ANSWER, "kind": "walkthrough", "summary": "R 90, das Konzept verfehlt die Trennwände."}
    message = AIMessage(content="```answer_json\n" + json.dumps(envelope, ensure_ascii=False) + "\n```")

    final = await finalize_answer([message], registry=_sources(), tools=[], repair=None)

    assert "answer_json" not in final.content
    assert DRAWING in final.content
    assert TABLE in final.content
    assert TASKS in final.content

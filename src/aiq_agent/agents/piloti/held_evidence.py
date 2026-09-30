"""Does what this conversation already holds answer the new message? A decision (ADR-0064, use 10).

The turn-start decision asks about the MESSAGE: does it need evidence, can
it be searched on its own. Neither question can see what the conversation
already read, so a message that names its own subject is searched as round 0
whatever the transcript holds. „was weißt du zur oib 2", asked three times,
ran three full researches; „Was bedeutet Punkt 12 für den Umbau?" after an
overview that cited Punkt 12 searched for a passage whose text was still in
front of the model.

The transcript carries the last researching turn's passages
(``conversation._answer_update`` writes a turn back cut to the passages its
answer cited; ``history.prune_tool_results`` keeps them until a later turn
fetches). This module reads those passages back out of the tool results with
the one parser that reads a grounding block (``extract_sources_from_tool_result``),
and asks the decision model one question over them and the new message:
do these passages already hold what it asks? It is a question about the
EVIDENCE, not about the wording of the last exchange, so a repeat, a
rephrasing, and a new question the cited passages happen to settle (a class
the cited table already lists) are the same case.

What a confident yes may do, both of them additions in ADR-0064's sense:
round 0 is not prefetched (a search the model would read past), and the
prompt says which held passages the verdict was about (:func:`render_held_block`).
Every tool stays bound, and the block says the verdict is a pointer, not a
rule: when the passages turn out not to answer, the model searches as it
always could. A false yes costs the model one round of its own; a false no,
or no decision at all, is the turn as it ran before.

The state is the new message and the passages' text as structured fields
(source, Punkt, citation, text) — a passage's text, which ADR-0064 already
allows the decider to read — never the transcript itself.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage

from .history import UNCITED_PASSAGE_NOTE

logger = logging.getLogger(__name__)

#: The slot the technical record is filed under: ``status:decision:held``.
SLOT = "held"

#: At or above this p the held passages are taken to answer the message.
#: A yes removes round 0 and tells the model it holds the answer, so it has
#: to be a confident yes; 0.8 is where every other prefetch-suppressing
#: answer of the turn decision sits. Not yet measured on conversation data:
#: ``task be:eval:decisions:held`` sweeps it over
#: ``tests/fixtures/decisions/held_coverage.yaml`` before it moves.
HELD_THRESHOLD = 0.8

#: How many held passages the decider reads, the most recent ones. The
#: previous turn's cited passages are usually fewer; a turn that cited more
#: is judged on its last twelve, and the block says so.
MAX_HELD_PASSAGES = 12

#: How much of a passage the decider reads: what the knowledge layer's own
#: passage verdict reads (``knowledge_layer/decisions.PASSAGE_CHARS``). The
#: operative sentence of a Punkt is within that.
PASSAGE_CHARS = 600

_QUESTION = (
    "Do the passages already read in this conversation hold what this new message asks for, "
    "so that it can be answered from them without searching again?"
)
_TRUE = (
    "Between them the passages state what the message asks: the rule, value, class, definition, "
    "procedure or fact it wants, or, for a request to explain, summarise, compare or give an overview, "
    "the scope, parts and content that answer it. The message may use other words than the passages, "
    "and it may repeat or rephrase an earlier question."
)
_FALSE = (
    "The message asks for something the passages do not state: another regulation, Land, building "
    "class, use, element, value or document, a Punkt or page they do not contain, or more detail than "
    "they hold. Passages that only name the subject, or list headings without the content asked for, "
    "do not hold the answer. So does a message that needs no reading at all, such as thanks."
)


@dataclass(frozen=True)
class HeldPassage:
    """One passage the transcript still holds, as the decider and the block read it."""

    citation_key: str
    source: str
    punkt: str | None
    text: str

    def state(self) -> dict[str, Any]:
        passage: dict[str, Any] = {"source": self.source, "citation": self.citation_key}
        if self.punkt:
            passage["punkt"] = self.punkt
        passage["text"] = self.text[:PASSAGE_CHARS]
        return passage

    def locator(self) -> str:
        return f"{self.citation_key} (Punkt {self.punkt})" if self.punkt else self.citation_key


@dataclass(frozen=True)
class HeldCoverage:
    """The verdict over the held passages; only built when a decision ran."""

    p: float
    passages: tuple[HeldPassage, ...]

    @property
    def covered(self) -> bool:
        return self.p >= HELD_THRESHOLD


def held_passages(messages: Sequence[Any], *, limit: int = MAX_HELD_PASSAGES) -> list[HeldPassage]:
    """The passages the tool results before the current question still carry, most recent last.

    Read with the parser the citation registry reads with, from data-source
    tools only (an ``emit_card`` confirmation is not evidence). A passage the
    last answer did not cite was compacted to its header
    (``history.compact_tool_results``) and holds no text, so it is not held.
    The same citation key read twice counts once, at its last position.
    """
    from aiq_agent.common.citation_verification import extract_sources_from_tool_result
    from aiq_agent.common.data_source_registry import get_source_id_for_tool

    last_human = max((i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1)
    held: dict[str, HeldPassage] = {}
    for message in messages[: max(last_human, 0)]:
        if not isinstance(message, ToolMessage) or not isinstance(message.content, str):
            continue
        tool_name = str(getattr(message, "name", "") or "")
        source_id = get_source_id_for_tool(tool_name)
        if source_id is None:
            continue
        for entry in extract_sources_from_tool_result(tool_name, message.content, source_id=source_id):
            text = (entry.chunk_text or "").strip()
            if not entry.citation_key or not text or text == UNCITED_PASSAGE_NOTE:
                continue
            held.pop(entry.citation_key, None)
            held[entry.citation_key] = HeldPassage(
                citation_key=entry.citation_key,
                source=entry.title or entry.citation_key,
                punkt=entry.punkt,
                text=text,
            )
    return list(held.values())[-limit:] if limit > 0 else []


def question() -> dict[str, dict[str, Any]]:
    """The one question, keyed the way the answer is read back."""
    from aiq_agent.common.decisions import noul

    return {"held": noul(_QUESTION, true=_TRUE, false=_FALSE)}


def state_for(message: str, passages: Sequence[HeldPassage]) -> dict[str, Any]:
    """What the decider is shown: the message and the held passages, bounded."""
    return {"message": message[:1000], "language": "de", "passages": [p.state() for p in passages]}


async def decide_held(
    message: str, passages: Sequence[HeldPassage], *, organization_id: str | None = None
) -> HeldCoverage | None:
    """The verdict over the held passages; ``None`` when there is nothing to judge or no decision ran."""
    if not message.strip() or not passages:
        return None
    from aiq_agent.common.decisions import decide

    decision = await decide(state_for(message, passages), question(), slot=SLOT, organization_id=organization_id)
    p = decision.noul("held") if decision is not None else None
    if p is None:
        return None
    coverage = HeldCoverage(p=p, passages=tuple(passages))
    logger.info("Held-evidence decision: p=%.2f over %d passage(s), covered=%s", p, len(passages), coverage.covered)
    return coverage


def render_held_block(coverage: HeldCoverage | None) -> str | None:
    """The prompt block for a confident yes; ``None`` renders no section."""
    if coverage is None or not coverage.covered:
        return None
    lines = [
        "## Already read in this conversation",
        (
            "Before this turn, a decision model read this message against the passages still in this "
            f"transcript and judged that they already hold what it asks (p = {coverage.p:.2f}), so nothing "
            f"was searched before you. It read these {len(coverage.passages)}, the most recent the "
            "transcript holds (it reads at most "
            f"{MAX_HELD_PASSAGES}; anything older was not judged):"
        ),
        *(f"- {passage.locator()}" for passage in coverage.passages),
        (
            "Their text is above, in the tool results of an earlier turn, and a passage there is cited as "
            "any passage is. Answer from them, and fetch only what they do not state. The verdict is a "
            "pointer, not a rule: if they do not answer the message after all, search as you would."
        ),
    ]
    return "\n".join(lines)

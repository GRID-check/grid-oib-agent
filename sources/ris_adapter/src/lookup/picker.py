"""The § picker: headings in, ranked § ids out. Never a body.

The one LLM call ``ris_lookup`` makes when nobody named a §, and the reason it
is cheap: its input is the law's table of contents, so it is bounded by how
many paragraphs the law has rather than by how long they are. It returns IDS,
never prose — the passages the answering model reads are cut out of the law by
``grammar``, so no summary of the law can stand in for the law (Cognition:
"actions carry implicit decisions").
"""

from __future__ import annotations

import logging

from langchain_core.exceptions import OutputParserException
from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError
from ris_adapter.register import _apply_org_llm_policy

logger = logging.getLogger(__name__)


class RisPassagePick(BaseModel):
    """One § the picker believes answers the question."""

    section: str = Field(description='The section id exactly as listed, e.g. "§ 63" or "Art 5"')
    reason: str = Field(default="", description="One short sentence: why this §")


class RisPassagePlan(BaseModel):
    """Ranked § ids for one document. Strict structured output, like RisSearchPlan."""

    picks: list[RisPassagePick] = Field(default_factory=list, description="Up to six §§, best first")


_PICKER_SYSTEM_PROMPT = """You pick the paragraphs of an Austrian law that answer a question.

You receive the question and the law's TABLE OF CONTENTS — one line per \
paragraph: its id (§ 63, Art 5) and its heading. You never see the text.

Rules:
- Return at most six section ids, best first, and only ids that appear in the list.
- Copy an id EXACTLY as listed. Do not invent, merge or renumber.
- Prefer the paragraph that states the obligation over the one that defines a term, \
unless the question asks for the definition.
- Return an empty list when no heading plausibly answers the question. An empty list \
is a real answer; a wrong § is not."""


def make_picker(llm):
    """Wrap a chat model into the § picker, with one bounded corrective retry.

    Same shape and same reason as ``register._make_planner``: strict schema
    mode is not honored by every OpenRouter-served model, so a garbled payload
    can still reach the parser.
    """

    async def _pick_sections(question: str, index: str) -> RisPassagePlan:
        structured = _apply_org_llm_policy(llm).with_structured_output(
            RisPassagePlan, method="json_schema", strict=True
        )
        messages = [
            {"role": "system", "content": _PICKER_SYSTEM_PROMPT},
            {"role": "user", "content": f"Question: {question}\n\nParagraphs available:\n{index}"},
        ]
        try:
            return await structured.ainvoke(messages)
        except (ValidationError, OutputParserException):
            logger.warning("ris_lookup picker: invalid structured output, retrying once", exc_info=True)
            corrective = [
                *messages,
                {
                    "role": "user",
                    "content": "Your previous output was invalid JSON. Return ONLY a single valid "
                    "JSON object matching the schema.",
                },
            ]
            return await structured.ainvoke(corrective)

    return _pick_sections

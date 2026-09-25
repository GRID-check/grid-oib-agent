"""One bounded repair of a card the model shaped wrong — on the small model, not a round.

The retry path ``emit_card`` offers hands the failed shape back and lets the
model try again, which is right and costs a full-context call: 40-80k tokens
re-sent so that four fields can be renamed. With cards in the envelope there
is no retry, and a wrong shape would be a dropped card. This is the middle:
the failed object, the validator's clauses and the type's whole shape go to
the card model (``card_llm``, the role that already builds cards post-hoc for
deep research) in a message of a few thousand tokens, and what comes back goes
through the same validator. Bounded once per card, bounded in time, and a
failure keeps the answer exactly as it is — a card is an enhancement of an
answer that already exists.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from aiq_agent.cards.generate import _ainvoke_card_llm
from aiq_agent.cards.generate import _parse_cards_text
from aiq_agent.common.message_utils import response_text

logger = logging.getLogger(__name__)

#: Upper bound on one repair call. The answer is already final when this runs;
#: past this the card is dropped and the answer ships without it.
CARD_REPAIR_TIMEOUT_S = 20.0

_SYSTEM_PROMPT = (
    "You fix ONE rich-UI card object that failed validation. You are given the answer it belongs to, "
    "the card as it was written, why it was refused, and the exact shape the card type needs. "
    "Return the corrected card as ONE JSON object of the same `type`, carrying only the content of "
    "the original — never invent a value, a reference or a number to satisfy a field; leave an "
    "optional field out rather than guess it, and use `needs_input` where the shape offers it. "
    "Return only the JSON object."
)


def _prompt(card: dict[str, Any], refusal: str, answer: str) -> list[Any]:
    import json

    return [
        SystemMessage(content=_SYSTEM_PROMPT),
        HumanMessage(
            content=(
                f"THE ANSWER THE CARD BELONGS TO:\n{answer[:4000]}\n\n"
                f"THE CARD AS WRITTEN:\n{json.dumps(card, ensure_ascii=False)}\n\n"
                f"WHY IT WAS REFUSED, AND THE SHAPE IT NEEDS:\n{refusal}"
            )
        ),
    ]


async def repair_card(llm: Any, card: dict[str, Any], refusal: str, answer: str) -> dict[str, Any] | None:
    """The corrected card object, or ``None`` when the repair did not produce one.

    ``None`` on a timeout, a provider error, unparseable output, or a reply
    that is not one object of the same type — every one of them logged, none
    of them raised: the caller already holds the answer and decides what a
    missing card means (it records it).
    """
    try:
        response = await asyncio.wait_for(_ainvoke_card_llm(llm, _prompt(card, refusal, answer)), CARD_REPAIR_TIMEOUT_S)
    except TimeoutError:
        logger.warning("card repair timed out after %.0fs", CARD_REPAIR_TIMEOUT_S)
        return None
    except Exception as exc:  # noqa: BLE001 — a failed repair keeps the answer
        logger.warning("card repair failed: %s", str(exc).split("\n")[0])
        return None
    parsed = _parse_cards_text(response_text(response))
    if not parsed:
        logger.warning("card repair returned nothing parseable")
        return None
    candidate = parsed[0]
    if not isinstance(candidate, dict) or candidate.get("type") != card.get("type"):
        logger.warning("card repair returned a different shape than asked (%r)", type(candidate).__name__)
        return None
    return candidate

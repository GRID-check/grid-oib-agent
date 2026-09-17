"""The pure derivations a round of retrieval calls needs, shared by both agents.

A round is one decision that emitted tool calls, however many it fanned out
into. Whoever runs one has to answer the same four questions: which of these
calls fetch something the run already holds, which of them really RETURNED
something, which of them merely failed, and what the model said it concluded
before asking. None of those answers depends on which agent asked, so they live
here rather than in either.

What stayed in :mod:`aiq_agent.agents.piloti.agent` is everything that does
depend on Piloti: the width cap and the switched-off-source refusal read a
Piloti turn's state and answer their withheld calls with Piloti's own
sentences, so ``_RoundSplit`` and ``_split_round`` are built there out of these
pieces.
"""

from __future__ import annotations

from collections.abc import Iterable
from collections.abc import Sequence
from typing import Any

from langchain_core.messages import ToolMessage

from aiq_agent.common.message_utils import content_to_text
from aiq_agent.common.turn_status import FETCH_FAILED_MARKER
from aiq_agent.common.turn_status import fetch_signature


def repeat_fetches(calls: Sequence[Any], executed: Sequence[str]) -> list[Any]:
    """The calls of this round that fetch something the run already holds.

    Two kinds, one rule: a call whose signature is in ``executed`` (an earlier
    round of this run ran it) and a call that repeats an earlier call of the
    SAME batch (the first occurrence runs, the rest are the same guess said
    twice). Everything :func:`fetch_signature` declines to sign is absent from
    the result and can never be withheld.

    Pure, and meant to be called with the same calls and the same ``executed``
    everywhere the question is asked: one caller decides what to CHARGE and
    another what to RUN, and two derivations eventually disagree.
    """
    seen = set(executed or ())
    repeats: list[Any] = []
    for call in calls:
        signature = fetch_signature(call)
        if signature is None:
            continue
        if signature in seen:
            repeats.append(call)
            continue
        seen.add(signature)
    return repeats


def signatures_of(calls: Sequence[Any]) -> frozenset[str]:
    """The fetch signatures a batch of calls HANDS to the tools, failures included.

    What tells a same-batch repeat of a failed fetch from one the run simply
    does not hold: the signature was tried here and there is no result, which
    is a failure and not an earlier answer.
    """
    return frozenset(signature for call in calls if (signature := fetch_signature(call)) is not None)


def failed_call_ids(messages: Iterable[Any]) -> set[str]:
    """The ids of the calls whose result is a FAILURE rather than a fetch.

    Two shapes, because the tools answer a dead store two ways. A raised tool
    gets ``status == "error"`` from the ``ToolNode``; a retrieval tool that
    catches its own exception returns PROSE — deliberately, so the turn can say
    it could not search instead of dying — and marks it with
    :data:`FETCH_FAILED_MARKER`.
    """
    failed: set[str] = set()
    for message in messages:
        if not isinstance(message, ToolMessage):
            continue
        content = str(message.content or "")
        if getattr(message, "status", None) == "error" or content.lstrip().startswith(FETCH_FAILED_MARKER):
            failed.add(str(getattr(message, "tool_call_id", "") or ""))
    return failed


def ran_signatures(ran: Sequence[Any], failed_ids: set[str]) -> list[str]:
    """The fetch signatures of the calls that really RETURNED SOMETHING, in call order.

    A call handed to the tools is not the same thing as a fetch that answered.
    Both retrieval tools respond to an unreachable store with a sentence asking
    the model to retry the identical call — and the duplicate guard is built to
    withhold exactly that call with "the result above is the answer", which in
    that case is a lie: nothing was read. So a failure signs nothing, and the
    retry the tool asked for is allowed to run.
    """
    return [
        signature
        for call in ran
        if str(call.get("id") or "") not in failed_ids and (signature := fetch_signature(call)) is not None
    ]


def assistant_checkpoint(response: Any) -> str | None:
    """The one-sentence conclusion the model wrote as PROSE before this round.

    The fallback channel. The prompt asks for the sentence in the retrieval
    tools' ``conclusion`` argument, because a tool-calling model fills a
    declared slot far more reliably than it narrates — but a model that
    narrates anyway must not lose its checkpoint, and neither must a deployment
    pinned to an older prompt. ``turn_status.emit_retrieval`` ranks the two.

    Empty when the model wrote no prose. The Herleitung then keeps the round as
    a layer without a body — it must not invent a conclusion, and it must not
    fall back to the search query (PF-12). A fenced ``answer_json`` is the final
    answer, not a checkpoint.
    """
    text = " ".join(content_to_text(getattr(response, "content", "") or "").split())
    if not text or text.startswith("```"):
        return None
    return text

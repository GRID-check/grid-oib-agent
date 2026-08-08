"""Provider-portable chat-request invariants for every LLM call in the fleet.

Why this module exists
----------------------
The fleet is deliberately LLM-agnostic: any OpenAI-compatible endpoint, and in
production an OpenRouter pool that routes a single request to whichever upstream
provider is healthy at that moment. Those providers do **not** agree on what a
valid request looks like, and the disagreement that reaches users is the
*trailing turn*:

- OpenAI-compatible providers accept a request whose last message is an
  assistant turn, treating it as a prefill to continue from.
- Google (surfacing on OpenRouter as both ``Google`` and ``Google AI Studio``)
  rejects it outright with
  ``400 INVALID_ARGUMENT - Requests ending with a model turn are not supported``.

Because the routed provider varies per request, the *same* conversation can
succeed and then fail minutes later with no code change — which is exactly how
this reached production repeatedly (issues #291-#294, #333, #335, #336, #340).

The design point
----------------
Agents assemble message windows out of **conversation context**: checkpointed
history, a trimmed window, or a shallow answer that just triggered an
escalation. Context legitimately ends on an assistant turn — that assistant
answer is the most useful thing the next agent can read.

Turning context into a **request** is a different concern, and it is the one
that carries a provider contract. Keeping the two apart is what makes this
fixable in one place: agents keep assembling context however they like, and this
module owns the single question "is this a legal request on every provider we
route to?". :mod:`aiq_agent.common.llm_factory` applies it to every chat model
the fleet resolves, so no agent — present or future — can put a
provider-invalid sequence on the wire.

Normalization is context-preserving and idempotent: it never drops a message,
and running it twice is the same as running it once.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage

logger = logging.getLogger(__name__)

#: Appended when a request would otherwise end on an assistant turn. Kept short,
#: neutral and instruction-free beyond "your turn now" so it cannot pull an
#: agent off the task its system prompt already defines — every agent in the
#: fleet shares this one string.
CONTINUATION_TURN = "Continue from the conversation above and respond now, following your instructions exactly."


def _is_assistant_turn(message: BaseMessage) -> bool:
    """True when ``message`` is a model-authored turn.

    Uses LangChain's ``type`` discriminator rather than ``isinstance`` so
    streamed ``AIMessageChunk`` values and any future assistant subclass are
    covered by the same check.
    """
    return getattr(message, "type", None) == "ai"


def _has_pending_tool_calls(message: BaseMessage) -> bool:
    """True when an assistant turn is still awaiting tool results."""
    return bool(getattr(message, "tool_calls", None))


def ends_on_model_turn(messages: Sequence[BaseMessage]) -> bool:
    """True when this sequence would be rejected as ending on a model turn.

    The predicate the contract is built on, exposed so tests and callers can
    assert the invariant directly instead of re-deriving it.
    """
    return bool(messages) and _is_assistant_turn(messages[-1])


def normalize_chat_request(messages: Sequence[BaseMessage]) -> list[BaseMessage]:
    """Return ``messages`` as a request that is legal on every routed provider.

    Appends :data:`CONTINUATION_TURN` when the sequence would otherwise end on
    an assistant turn, preserving that assistant turn as context. No message is
    ever dropped or rewritten, and the function is idempotent — the appended
    turn is a human turn, so a second pass is a no-op.

    One case is deliberately left untouched: a trailing assistant turn that
    still has unanswered ``tool_calls``. That is malformed on *every* provider
    (OpenAI-compatible endpoints require tool results to follow a tool call), so
    it signals a graph that failed to run its tool node rather than a
    portability gap. Papering over it with a human turn would convert a loud,
    locatable bug into a silently degraded answer, so it is logged and passed
    through to fail where it actually broke.
    """
    if not messages:
        return list(messages)

    last = messages[-1]
    if not _is_assistant_turn(last):
        return list(messages)

    if _has_pending_tool_calls(last):
        logger.warning(
            "Chat request ends on an assistant turn with %d unanswered tool call(s); "
            "passing through unchanged — this is a graph bug (a tool node did not run), "
            "not a provider-portability gap.",
            len(getattr(last, "tool_calls", []) or []),
        )
        return list(messages)

    logger.debug("Chat request ended on a model turn; appending a continuation turn for provider portability.")
    return [*messages, HumanMessage(content=CONTINUATION_TURN)]

"""Conversation history, trimmed to a token budget before it reaches a model.

The conversation graph holds the whole thread; every node that hands the
history to an agent hands it through here first, so the window a model sees is
budgeted in TOKENS rather than in messages.
"""

import json
import logging
from collections.abc import Callable
from functools import lru_cache
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.messages import trim_messages

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _get_token_encoder():
    """Cache a tiktoken encoder, or ``None`` when it cannot be had.

    ``get_encoding`` downloads the BPE table on first use, so a missing
    package and a transport failure are both "count by heuristic instead".
    """
    try:
        import tiktoken

        return tiktoken.get_encoding("cl100k_base")
    except (ImportError, OSError) as exc:
        # "tiktoken" and "per-token" are the BPE tokenizer, not a credential;
        # `exc` is an ImportError or an OSError from the BPE-table download.
        # The rule is a keyword match on "token" in a logged string, so it
        # cannot tell the two apart -- suppressed here rather than repo-wide,
        # because it does catch real credential logging elsewhere.
        # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure
        logger.warning("tiktoken unavailable (%s); history is budgeted by the 4-chars-per-token heuristic", exc)
        return None


def _encoded_len(text: str) -> int:
    encoder = _get_token_encoder()
    if encoder is None:
        # Fallback heuristic when tiktoken is unavailable: ~4 chars per token.
        return max(1, len(text) // 4)
    # A user can type "<|endoftext|>"; counting must not refuse it.
    return len(encoder.encode(text, disallowed_special=()))


def _count_message_tokens(messages) -> int:
    """Total approximate tokens across messages, for history-trim budgeting.

    ``trim_messages`` invokes this on the list it holds — BaseMessage objects
    or dict dumps — so content is pulled from either form; non-string content
    is JSON-flattened before counting. Each message adds a small fixed
    overhead for role/format framing.
    """
    return sum(_encoded_len(_message_text(message)) + 4 for message in messages)


def _message_text(message: Any) -> str:
    content = getattr(message, "content", None)
    if content is None and isinstance(message, dict):
        content = message.get("content")
    if content is None:
        return ""
    return content if isinstance(content, str) else json.dumps(content, default=str)


def trim_message_history(
    messages: list[BaseMessage],
    max_tokens: int,
    token_counter: Callable[..., int] | None = None,
) -> list[BaseMessage]:
    """Trim conversation history to a real token budget (not a message count).

    Keeps the most recent turns (``strategy="last"``), always retains system
    messages, and starts the retained window on a human turn.
    """
    return trim_messages(
        messages=[m.model_dump() for m in messages],
        max_tokens=max_tokens,
        strategy="last",
        token_counter=token_counter or _count_message_tokens,
        start_on="human",
        include_system=True,
    )


def prune_tool_results(messages: list[BaseMessage], *, keep_turns: int = 1) -> list[BaseMessage]:
    """The history with tool results kept for the last ``keep_turns`` turns only.

    A turn writes its whole transcript back to the conversation — the tool
    calls, their results, the answer — so the NEXT turn has the passages the
    last answer was written from in front of it and a follow-up („und in
    GK 4?") needs no fetch at all. Older turns keep only what was said: the
    ``ToolMessage``s go, and so does an ``AIMessage`` that was nothing but
    tool calls (a provider rejects a call with no result, so the two leave
    together); an assistant message with prose keeps its prose and drops its
    calls. A turn starts at a ``HumanMessage``; the current question is a
    turn of its own and counts.
    """
    boundaries = [i for i, m in enumerate(messages) if isinstance(m, HumanMessage)]
    if len(boundaries) <= keep_turns + 1:
        return list(messages)
    cutoff = boundaries[-(keep_turns + 1)]
    pruned: list[BaseMessage] = []
    for index, message in enumerate(messages):
        if index >= cutoff or not isinstance(message, (AIMessage, ToolMessage)):
            pruned.append(message)
            continue
        if isinstance(message, ToolMessage):
            continue
        if getattr(message, "tool_calls", None):
            text = _message_text(message).strip()
            if not text:
                continue
            message = message.model_copy(update={"tool_calls": []})
        pruned.append(message)
    return pruned

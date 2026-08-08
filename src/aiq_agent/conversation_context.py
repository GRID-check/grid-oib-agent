"""Ingest-only conversation context: a human turn the agent must SEE, not answer.

Why this exists
---------------
The agent's conversation history IS its LangGraph checkpoint, keyed on
``thread_id == conversation_id``. Only what passes through the agent lands there.
Collaboration (ADR-0034) deliberately suppresses the agent for a message addressed
to a *person* by not invoking it at all — which is right about tokens and was wrong
about memory: Matthias tags Anna, Anna answers, and then ``@Piloti given that,
recheck`` refers to nothing, because neither turn ever reached the checkpoint.

The rule is **"always send, never always judge"**: every human message reaches the
agent tagged with whether it is addressed to it. The server already decides that
deterministically (``prepareMessage`` → ``addressees``), so routing stays binding and
never becomes a model's guess. A message that is *not* addressed to the agent arrives
as **context only**: it is appended to the conversation state and nothing is
generated, streamed, or charged.

This module is the agent-tier half of that: the wire-payload parse, the bounded
attribution formatting, and the indirection the WebSocket front end uses to reach the
compiled chat graph without importing it (``aiq_api`` owns the socket, ``aiq_agent``
owns the graph).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable
from collections.abc import Callable
from dataclasses import dataclass

logger = logging.getLogger(__name__)

#: Char cap on a single ingested message, mirroring ``normalize_project_context``.
#: A pathological paste must not bloat the checkpoint that every later turn reads.
MAX_CONTEXT_MESSAGE_CHARS = 4000

#: Char cap on the author's display name. Attribution, not a payload.
MAX_CONTEXT_AUTHOR_CHARS = 120

#: The wire flag (inside the ``user_message`` JSON text payload) that marks a frame
#: as ingest-only. Narrow and explicit on purpose: its ABSENCE must mean "behave
#: exactly as before this existed".
CONTEXT_ONLY_FIELD = "context_only"

#: Optional display name of the human who wrote it. Advisory only — the backend
#: prefers the authenticated principal's own name when it has one.
AUTHOR_NAME_FIELD = "author_name"

#: ``(thread_id, text) -> None``. Registered by the chat agent at build time.
ContextAppender = Callable[[str, str], Awaitable[None]]

_appender: ContextAppender | None = None


@dataclass(frozen=True)
class ContextOnlyMessage:
    """A human turn to ingest without answering."""

    text: str
    author: str | None = None


def _cap(value: str, max_chars: int) -> str:
    """Strip and cap *value*, preferring a line boundary.

    Same shape as ``project_context.normalize_project_context`` so every piece of
    injected context is bounded the same way.
    """
    value = value.strip()
    if len(value) <= max_chars:
        return value
    trimmed = value[:max_chars]
    head = trimmed.rsplit("\n", 1)[0]
    return head or trimmed


def parse_context_only_payload(raw_text: str | None) -> ContextOnlyMessage | None:
    """Read an ingest-only directive out of a ``user_message`` text payload.

    The payload is the JSON string the client puts in ``content.messages[].content[]
    .text`` — today ``{"query": ..., "data_sources": [...]}``. Returns ``None`` for
    every ordinary message (no flag, not JSON, empty body), so the caller's default
    path is untouched: a NEW backend receiving no field behaves exactly as today.
    """
    if not raw_text:
        return None
    trimmed = raw_text.strip()
    if not (trimmed.startswith("{") and trimmed.endswith("}")):
        return None
    try:
        payload = json.loads(trimmed)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or payload.get(CONTEXT_ONLY_FIELD) is not True:
        return None

    body = payload.get("query") or payload.get("text")
    if not isinstance(body, str) or not body.strip():
        # Flagged but empty: still not something to answer. Swallow it.
        logger.debug("Ignoring context-only message with an empty body")
        return None

    author = payload.get(AUTHOR_NAME_FIELD)
    return ContextOnlyMessage(
        text=body,
        author=author.strip() if isinstance(author, str) and author.strip() else None,
    )


def format_context_turn(message: ContextOnlyMessage, *, author: str | None = None) -> str:
    """Render the ingested turn as bounded, attributed text.

    *author* wins over the client-supplied name — the socket holder IS the writer, so
    the verified principal is the trustworthy source and a client cannot attribute
    text to a colleague in the agent's own history.

    The result is the human's words with a name in front. Nothing product-authored is
    added, so the agent never reads invented narration as if a user had typed it.
    """
    name = _cap(author or message.author or "", MAX_CONTEXT_AUTHOR_CHARS)
    body = _cap(message.text, MAX_CONTEXT_MESSAGE_CHARS)
    return f"{name}: {body}" if name else body


def register_context_appender(appender: ContextAppender | None) -> None:
    """Publish the coroutine that appends a turn to a conversation's checkpoint.

    Called once per chat-agent build. Last registration wins (a process hosts one
    chat workflow); ``None`` clears it, which makes ingestion a logged no-op rather
    than an error — a lost context message degrades the agent's memory and must never
    break the socket.
    """
    global _appender
    _appender = appender


def get_context_appender() -> ContextAppender | None:
    """Return the registered appender, if the chat agent has been built."""
    return _appender


async def append_conversation_context(thread_id: str | None, text: str) -> bool:
    """Append *text* to *thread_id*'s conversation state. Never raises.

    Returns whether it landed. ``False`` means the agent's history is missing this
    turn — worth a log, never worth an error frame: the message itself is already
    persisted in the BFF's ``messages`` table, which is what the humans read.
    """
    if not thread_id or not text:
        return False
    appender = _appender
    if appender is None:
        logger.warning("No conversation-context appender registered; dropping ingest-only message")
        return False
    try:
        await appender(thread_id, text)
    except Exception:
        logger.warning("Failed to append ingest-only context to conversation %s", thread_id, exc_info=True)
        return False
    return True

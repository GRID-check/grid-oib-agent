"""Turn-input parsing and history trimming for the chat workflow."""

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from typing import NamedTuple

from langchain_core.messages import BaseMessage
from langchain_core.messages import trim_messages

from aiq_agent.common import parse_data_sources
from aiq_agent.common.focus_file import get_focused_file_name
from aiq_agent.common.focus_file import get_focused_shelf
from aiq_agent.common.focus_file import set_turn_intent

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


def _normalize_enum_value(value: Any) -> str | None:
    """Extract string value from enum or return as-is if already a string."""
    if value is None:
        return None
    if hasattr(value, "value"):
        return str(value.value)
    return str(value)


def _is_text_type(type_value: Any) -> bool:
    normalized = _normalize_enum_value(type_value)
    return normalized is not None and normalized.lower() == "text"


def _is_user_role(role_value: Any) -> bool:
    normalized = _normalize_enum_value(role_value)
    return normalized is not None and normalized.lower() == "user"


def _field(item: Any, name: str) -> Any:
    """One field of a message or content part, whether it is a dict or an object."""
    return item.get(name) if isinstance(item, dict) else getattr(item, name, None)


def _text_part(item: Any) -> str | None:
    if not _is_text_type(_field(item, "type")):
        return None
    text = _field(item, "text")
    return str(text) if text else None


def _extract_text_from_message(message: Any) -> str | None:
    """The text of one message: a string, a message with string content, or a
    message whose content is a list of parts (only the ``text`` parts count)."""
    if message is None:
        return None
    if isinstance(message, str):
        return message
    content = _field(message, "content")
    if content is None and isinstance(message, dict):
        content = message.get("text")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts = [text for item in content if (text := _text_part(item))]
    return "\n".join(parts).strip() if parts else None


def parse_skills(raw: Any) -> list[str] | None:
    """Parse the forced-skills array from a request payload.

    Mirrors ``parse_data_sources`` semantics: None when not specified
    (nothing forced), [] when explicitly empty, otherwise the sanitized
    name list. Comma-separated strings are accepted as a defensive
    fallback exactly like data sources are.
    """
    if raw is None:
        return None
    if isinstance(raw, list):
        parsed = [str(value).strip() for value in raw]
        return [value for value in parsed if value]
    if isinstance(raw, str):
        parsed = [value.strip() for value in raw.split(",")]
        return [value for value in parsed if value]
    return None


@dataclass(frozen=True)
class TurnIntent:
    """What the composer said the turn is about: the focused file, its shelf,
    and the source preset. ``TurnIntent()`` is "no subject" — and it is set on
    every turn, because the ContextVars outlive one turn and a plain message
    must not inherit the previous subject."""

    file_name: object = None
    shelf: object = None
    source_preset: object = None


class ParsedQuery(NamedTuple):
    query_text: str
    data_sources: list[str] | None
    skills: list[str] | None
    intent: TurnIntent


def _extract_query_from_text(text: str) -> ParsedQuery:
    """Parse one message text, which may be an inline JSON payload carrying the
    query plus data sources, forced skills and the turn intent.

    A JSON blob without a ``query``/``text`` field is the user's message, not
    a payload: its ``data_sources`` would otherwise silently re-aim the turn.
    """
    plain = ParsedQuery(text, None, None, TurnIntent())
    trimmed = text.strip()
    if not (trimmed.startswith("{") and trimmed.endswith("}")):
        return plain
    try:
        payload = json.loads(trimmed)
    except json.JSONDecodeError:
        return plain
    if not isinstance(payload, dict):
        return plain
    query_text = payload.get("query") or payload.get("text")
    if not (isinstance(query_text, str) and query_text.strip()):
        return plain
    return ParsedQuery(
        query_text.strip(),
        parse_data_sources(payload.get("data_sources")),
        parse_skills(payload.get("skills")),
        TurnIntent(payload.get("focus_file_name"), payload.get("focus_shelf"), payload.get("source_preset")),
    )


@dataclass(frozen=True)
class _PayloadShape:
    """A structured request payload, whatever form it arrived in."""

    messages: list
    data_sources: list[str] | None
    skills: list[str] | None
    fallback: Any = None


def _first_present(*values: Any) -> Any:
    """``is None`` chaining, not ``or``: an explicit ``[]`` means "none" and
    must not be overwritten by a fallback (``parse_*`` distinguish None from [])."""
    return next((value for value in values if value is not None), None)


def _normalize_payload(payload: Any) -> _PayloadShape | None:
    """The one shape both the dict and the object form of a payload reduce to,
    or ``None`` when ``payload`` is plain text."""
    if isinstance(payload, dict):
        content = payload.get("content") if isinstance(payload.get("content"), dict) else {}
        messages = content.get("messages", [])
        return _PayloadShape(
            messages=messages if isinstance(messages, list) else [],
            data_sources=_first_present(
                parse_data_sources(payload.get("data_sources")), parse_data_sources(content.get("data_sources"))
            ),
            skills=_first_present(parse_skills(payload.get("skills")), parse_skills(content.get("skills"))),
            fallback=_first_present(payload.get("message"), payload.get("text")),
        )
    messages = getattr(payload, "messages", None)
    if not isinstance(messages, list):
        return None
    return _PayloadShape(
        messages=messages,
        data_sources=parse_data_sources(getattr(payload, "data_sources", None)),
        skills=parse_skills(getattr(payload, "skills", None)),
    )


def _latest_user_text(messages: list) -> str | None:
    """The last user turn's text, else the last message's."""
    for message in reversed(messages):
        if _is_user_role(_field(message, "role")) and (text := _extract_text_from_message(message)):
            return text
    return _extract_text_from_message(messages[-1]) if messages else None


def _extract_query_and_sources(payload: Any) -> ParsedQuery:
    """Extract query text, data sources, forced skills and intent from any payload form.

    ``data_sources`` is None when not specified (use all configured tools) and
    a list when explicitly specified; ``skills`` mirrors that. Values stated on
    the payload beat values stated inline in the message text.
    """
    shape = _normalize_payload(payload)
    if shape is None:
        return _extract_query_from_text(str(payload))
    query_text = _latest_user_text(shape.messages) or _extract_text_from_message(shape.fallback)
    if not query_text:
        return ParsedQuery("", shape.data_sources, shape.skills, TurnIntent())
    inline = _extract_query_from_text(query_text)
    return ParsedQuery(
        inline.query_text,
        _first_present(shape.data_sources, inline.data_sources),
        _first_present(shape.skills, inline.skills),
        inline.intent,
    )


class TurnInputs(NamedTuple):
    """Everything one user message states about how to answer it.

    The focus fields are read back from the turn ContextVars that
    :func:`extract_turn_inputs` sets — retrieval reads the same vars, so the
    state carries exactly the (normalised) subject retrieval sees.
    """

    query_text: str
    data_sources: list[str] | None
    force_skills: list[str] | None
    focus_file_name: str | None
    focus_shelf: str | None


def extract_turn_inputs(payload: Any) -> TurnInputs:
    """Parse one user message into the inputs a turn is built from, and set
    the turn's intent for retrieval. Always sets it: a turn without a subject
    clears the previous turn's."""
    parsed = _extract_query_and_sources(payload)
    intent = parsed.intent
    set_turn_intent(file_name=intent.file_name, shelf=intent.shelf, source_preset=intent.source_preset)
    return TurnInputs(
        parsed.query_text, parsed.data_sources, parsed.skills, get_focused_file_name(), get_focused_shelf()
    )

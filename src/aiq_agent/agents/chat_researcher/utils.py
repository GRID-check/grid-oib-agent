import json
from collections.abc import Callable
from functools import lru_cache
from typing import Any

from langchain_core.messages import BaseMessage
from langchain_core.messages import trim_messages

from aiq_agent.common import parse_data_sources


@lru_cache(maxsize=1)
def _get_token_encoder():
    """Cache a tiktoken encoder, or ``None`` if tiktoken is unavailable."""
    try:
        import tiktoken

        return tiktoken.get_encoding("cl100k_base")
    except Exception:
        return None


def _encoded_len(text: str) -> int:
    encoder = _get_token_encoder()
    if encoder is not None:
        try:
            return len(encoder.encode(text))
        except Exception:
            pass
    # Fallback heuristic when tiktoken is unavailable: ~4 chars per token.
    return max(1, len(text) // 4)


def _count_message_tokens(messages) -> int:
    """Total approximate tokens across messages, for history-trim budgeting.

    Replaces the old ``token_counter=len`` (which counted *messages*, so a few
    large turns blew the real context budget). ``trim_messages`` invokes this on
    the list it holds — BaseMessage objects or dict dumps — so content is pulled
    from either form; non-string content is JSON-flattened before counting. Each
    message adds a small fixed overhead for role/format framing.
    """
    total = 0
    for message in messages:
        content = getattr(message, "content", None)
        if content is None and isinstance(message, dict):
            content = message.get("content")
        if isinstance(content, str):
            text = content
        elif content is None:
            text = ""
        else:
            text = json.dumps(content, default=str)
        total += _encoded_len(text) + 4
    return total


def trim_message_history(
    messages: list[BaseMessage],
    max_tokens: int,
    token_counter: Callable[..., int] | None = None,
) -> list[BaseMessage]:
    """Trim conversation history to a real token budget (not a message count).

    ``max_tokens`` is a token budget; ``token_counter`` defaults to a
    tiktoken-based counter (``_count_message_tokens``) and is injectable for
    tests. Keeps the most recent turns (``strategy="last"``), always retains
    system messages, and starts the retained window on a human turn.
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
    """Check if type value represents 'text', handling both strings and enums."""
    normalized = _normalize_enum_value(type_value)
    return normalized is not None and normalized.lower() == "text"


def _is_user_role(role_value: Any) -> bool:
    """Check if role value represents 'user', handling both strings and enums."""
    normalized = _normalize_enum_value(role_value)
    return normalized is not None and normalized.lower() == "user"


def _extract_text_from_message(message: Any) -> str | None:
    if message is None:
        return None
    if isinstance(message, str):
        return message
    if hasattr(message, "content"):
        content_value = getattr(message, "content")
        if isinstance(content_value, str):
            return content_value
        if isinstance(content_value, list):
            parts = []
            for item in content_value:
                if hasattr(item, "type") and _is_text_type(getattr(item, "type")):
                    text_value = getattr(item, "text", None)
                    if text_value:
                        parts.append(str(text_value))
                elif isinstance(item, dict) and _is_text_type(item.get("type")):
                    text_value = item.get("text")
                    if text_value:
                        parts.append(str(text_value))
            if parts:
                return "\n".join(parts).strip()
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and _is_text_type(item.get("type")):
                    text = item.get("text")
                    if text:
                        parts.append(str(text))
            if parts:
                return "\n".join(parts).strip()
        if isinstance(content, str):
            return content
        text_value = message.get("text")
        if isinstance(text_value, str):
            return text_value
    return None


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
        if len(raw) == 0:
            return []
        parsed = [str(value).strip() for value in raw]
        return [value for value in parsed if value] or []
    if isinstance(raw, str):
        if not raw.strip():
            return []
        parsed = [value.strip() for value in raw.split(",")]
        return [value for value in parsed if value] or []
    return None


def _set_turn_scoped_signals(payload: dict | None) -> None:
    """Apply this turn's document-scoping signals, or clear them.

    Both signals live in ContextVars that outlive a single turn within a
    connection, so EVERY path through ``_extract_query_from_text`` has to state a
    value. A path that simply returns leaves the previous turn's value in place,
    silently re-scoping an attachment-free turn to a document the user has
    stopped talking about — pass ``None`` there rather than falling through.

    Never raises: a scoping signal is an optimisation, and losing one must cost
    the turn its narrowing, not the turn.
    """
    try:
        from aiq_agent.common.focus_file import set_focused_file_name
        from aiq_agent.common.turn_attachments import parse_turn_attachments
        from aiq_agent.common.turn_attachments import set_turn_attachments

        focus = payload.get("focus_file_name") if payload else None
        set_focused_file_name(focus if isinstance(focus, str) else None)
        set_turn_attachments(parse_turn_attachments(payload.get("session_attachments")) if payload else [])
    except Exception:
        pass


def _extract_query_from_text(text: str) -> tuple[str, list[str] | None, list[str] | None]:
    if not text:
        _set_turn_scoped_signals(None)
        return ("", None, None)
    trimmed = text.strip()
    if trimmed.startswith("{") and trimmed.endswith("}"):
        try:
            payload = json.loads(trimmed)
        except json.JSONDecodeError:
            # Looked like a payload but is not one: it carries no signals, so
            # the previous turn's must not survive into this one.
            _set_turn_scoped_signals(None)
            return (text, None, None)
        if isinstance(payload, dict):
            data_sources = parse_data_sources(payload.get("data_sources"))
            skills = parse_skills(payload.get("skills"))
            query_text = payload.get("query") or payload.get("text")
            _set_turn_scoped_signals(payload)
            if isinstance(query_text, str) and query_text.strip():
                return (query_text.strip(), data_sources, skills)
            # No query/text field — treat the whole blob as the user's
            # message, not as a structured payload. data_sources in that
            # JSON would silently re-aim the turn.
            return (text, None, None)
    _set_turn_scoped_signals(None)
    return (text, None, None)


def _extract_query_and_sources(payload: Any) -> tuple[str, list[str] | None, list[str] | None]:
    """Extract query text, data sources and forced skills from various payload formats.

    Returns:
        Tuple of (query_text, data_sources, skills).
        - data_sources is None if not specified, meaning use all configured tools
        - data_sources is a list if explicitly specified (use only those)
        - skills is None/[] if none were forced (semantics mirror data_sources)
    """
    if isinstance(payload, dict):
        content = payload.get("content", {}) if isinstance(payload.get("content"), dict) else {}
        # `is None` chaining, not `or`: an explicit [] means "no data-source
        # tools" and must not be overwritten by a fallback (parse_data_sources
        # distinguishes None from []).
        data_sources = parse_data_sources(payload.get("data_sources"))
        if data_sources is None:
            data_sources = parse_data_sources(content.get("data_sources"))
        # Same None-chaining for the forced-skills array (explicit [] = none).
        skills = parse_skills(payload.get("skills"))
        if skills is None:
            skills = parse_skills(content.get("skills"))
        messages = content.get("messages", [])
        query_text = None
        if isinstance(messages, list) and messages:
            for msg in reversed(messages):
                if isinstance(msg, dict) and _is_user_role(msg.get("role")):
                    query_text = _extract_text_from_message(msg)
                    if query_text:
                        break
            if not query_text:
                query_text = _extract_text_from_message(messages[-1])
        if not query_text:
            query_text = _extract_text_from_message(payload.get("message")) or _extract_text_from_message(
                payload.get("text")
            )
        if query_text:
            inline_query, inline_sources, inline_skills = _extract_query_from_text(query_text)
            query_text = inline_query
            if data_sources is None:
                data_sources = inline_sources
            if skills is None:
                skills = inline_skills
        return (query_text or "", data_sources, skills)

    messages = getattr(payload, "messages", None)
    if isinstance(messages, list):
        data_sources = parse_data_sources(getattr(payload, "data_sources", None))
        skills = parse_skills(getattr(payload, "skills", None))
        query_text = None
        for msg in reversed(messages):
            if _is_user_role(getattr(msg, "role", None)):
                query_text = _extract_text_from_message(msg)
                if query_text:
                    break
        if not query_text and messages:
            query_text = _extract_text_from_message(messages[-1])
        if query_text:
            inline_query, inline_sources, inline_skills = _extract_query_from_text(query_text)
            query_text = inline_query
            if data_sources is None:
                data_sources = inline_sources
            if skills is None:
                skills = inline_skills
        return (query_text or "", data_sources, skills)

    query_text = str(payload)
    inline_query, inline_sources, inline_skills = _extract_query_from_text(query_text)
    return (inline_query, inline_sources, inline_skills)

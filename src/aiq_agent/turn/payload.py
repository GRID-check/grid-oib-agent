"""What one user message states about how to answer it.

The wire hands the workflow either plain text or a structured payload (a dict
or an object, with the query sometimes inline as JSON inside the message text).
Everything is normalised to one shape here, once per turn, and the turn's
intent — the composer's "Asking about <file>" subject — is set from it, because
retrieval reads the same ContextVars.
"""

import json
import logging
from dataclasses import dataclass
from typing import Any
from typing import NamedTuple

from aiq_agent.common import parse_data_sources
from aiq_agent.common.focus_file import get_focused_file_name
from aiq_agent.common.focus_file import get_focused_shelf
from aiq_agent.common.focus_file import set_turn_intent

logger = logging.getLogger(__name__)


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
class SubjectVersion:
    """The document version the composer says this turn is about.

    Additive beside the focused FILE NAME, and a different question from it.
    The name is a retrieval identity — which chunks to prefer — and it is only
    ever as good as the index: a version nobody has published has no chunks at
    all, so the focus filter matches nothing and falls open to the whole corpus
    (``sources/knowledge_layer/src/register.py``). This says WHICH version, by
    id, and what editorial state it is in, so the turn can read the bytes
    instead of hoping the index has them.

    Every field is optional and unvalidated here on purpose: it arrives from a
    client, the BFF re-checks tenancy on the read, and an incomplete triple is
    simply not a subject version.
    """

    document_id: str | None = None
    version_id: str | None = None
    state: str | None = None

    @property
    def is_open(self) -> bool:
        """Whether this names a version retrieval cannot see.

        The open states of the lifecycle (``lifecycle-types.ts``,
        ``OPEN_DOCUMENT_VERSION_STATES``). ``published`` is deliberately NOT a
        membership test that could grow a hole: anything not in this set is
        left to retrieval, which is the behaviour that already works.
        """
        return bool(self.document_id) and bool(self.version_id) and self.state in _OPEN_VERSION_STATES


#: The version states in which a document is still being worked on and therefore
#: has no chunks. Mirrors ``OPEN_DOCUMENT_VERSION_STATES`` in
#: ``frontends/ui/src/lib/documents/lifecycle-types.ts``; there is no shared
#: schema between the two, exactly as for the source kinds.
_OPEN_VERSION_STATES = frozenset({"draft", "in_review", "changes_requested"})


def _subject_version(payload: dict[str, Any]) -> SubjectVersion:
    """The subject triple out of one request payload, strings only."""

    def field(name: str) -> str | None:
        value = payload.get(name)
        return value.strip() or None if isinstance(value, str) else None

    return SubjectVersion(field("focus_document_id"), field("focus_version_id"), field("focus_version_state"))


@dataclass(frozen=True)
class TurnIntent:
    """What the composer said the turn is about: the focused file, its shelf,
    and the source preset. ``TurnIntent()`` is "no subject" — and it is set on
    every turn, because the ContextVars outlive one turn and a plain message
    must not inherit the previous subject."""

    file_name: object = None
    shelf: object = None
    source_preset: object = None
    #: The subject's open version, when the client named one. Carried beside the
    #: intent rather than inside it because it reaches nothing retrieval reads:
    #: it is consumed once, by the turn's subject-document load.
    subject: SubjectVersion = SubjectVersion()


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
        TurnIntent(
            payload.get("focus_file_name"),
            payload.get("focus_shelf"),
            payload.get("source_preset"),
            _subject_version(payload),
        ),
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
    #: The subject's open version, or an empty :class:`SubjectVersion`. NOT read
    #: back from a ContextVar like the two fields above it: nothing in retrieval
    #: consumes it, so it never becomes turn-wide state.
    subject: SubjectVersion = SubjectVersion()


def extract_turn_inputs(payload: Any) -> TurnInputs:
    """Parse one user message into the inputs a turn is built from, and set
    the turn's intent for retrieval. Always sets it: a turn without a subject
    clears the previous turn's."""
    parsed = _extract_query_and_sources(payload)
    intent = parsed.intent
    set_turn_intent(file_name=intent.file_name, shelf=intent.shelf, source_preset=intent.source_preset)
    return TurnInputs(
        parsed.query_text,
        parsed.data_sources,
        parsed.skills,
        get_focused_file_name(),
        get_focused_shelf(),
        intent.subject,
    )

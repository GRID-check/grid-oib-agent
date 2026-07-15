"""Direct NAT type converters that preserve GRID-specific extra fields.

The chat entrypoint attaches Grid ``cards`` (and the structured
``deep_research_job_id``) as *extra* attributes on the ``ChatResponse`` it
returns (``ChatResponse`` is ``extra="allow"``). NAT's FastAPI worker, however,
serves the ``CHAT_STREAM`` schema by converting that ``ChatResponse`` into a
``ChatResponseChunk`` before it ever reaches the WebSocket envelope.

NAT ships no *direct* ``ChatResponse -> ChatResponseChunk`` converter, so the
``GlobalTypeConverter`` falls back to an **indirect path through ``str``**
(``ChatResponse -> str -> ChatResponseChunk``). That path keeps only the answer
text — the ``cards`` / ``deep_research_job_id`` extras are silently dropped, so
the aiq_api WebSocket override (which reads ``data_model.cards``) never sees
them and the frontend renders no cards.

Registering a *direct* converter makes ``GlobalTypeConverter`` prefer it over
the lossy ``str`` hop (direct conversion is attempted before indirect), letting
us copy the extras onto the chunk so they survive to the wire.
"""

from __future__ import annotations

import logging

from nat.data_models.api_server import ChatResponse
from nat.data_models.api_server import ChatResponseChunk
from nat.utils.type_converter import GlobalTypeConverter

logger = logging.getLogger(__name__)

# Extra attributes we want to carry from a ChatResponse onto the derived
# ChatResponseChunk so they survive NAT's CHAT_STREAM serialization.
_PRESERVED_EXTRA_FIELDS = ("cards", "deep_research_job_id", "answer_confidence")

_registered = False


def _extract_content(data: ChatResponse) -> str:
    """Pull the assistant text out of a ChatResponse (mirrors NAT's own logic)."""
    if data.choices and data.choices[0].message:
        return data.choices[0].message.content or ""
    return ""


def _chat_response_to_chunk(data: ChatResponse) -> ChatResponseChunk:
    """Direct ChatResponse -> ChatResponseChunk conversion preserving extras.

    Produces the same text-bearing chunk NAT would, then copies any GRID extra
    fields (``cards``, ``deep_research_job_id``, ``answer_confidence``) across so
    downstream WebSocket serialization can attach them to the response message.
    """
    chunk = ChatResponseChunk.create_streaming_chunk(
        _extract_content(data),
        id_=getattr(data, "id", None),
        created=getattr(data, "created", None),
        model=getattr(data, "model", None),
        usage=getattr(data, "usage", None),
        system_fingerprint=getattr(data, "system_fingerprint", None),
        finish_reason="stop",
    )

    # ChatResponseChunk is extra="allow", so extra attributes land in
    # model_extra and serialize under their own keys via model_dump().
    extra = data.model_extra or {}
    for field in _PRESERVED_EXTRA_FIELDS:
        value = extra.get(field, getattr(data, field, None))
        if value is not None:
            setattr(chunk, field, value)

    return chunk


def ensure_registered() -> None:
    """Idempotently register the direct ChatResponse -> ChatResponseChunk converter."""
    global _registered
    if _registered:
        return
    GlobalTypeConverter.register_converter(_chat_response_to_chunk)
    _registered = True
    logger.debug("Registered direct ChatResponse -> ChatResponseChunk converter (preserves cards)")

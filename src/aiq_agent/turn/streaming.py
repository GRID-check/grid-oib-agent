"""Final-answer streaming: the already-final text as deltas plus one terminal chunk.

The chat turn is generated, citation-verified, and sanitized fully buffered
(verify_citations/sanitize_report need the complete answer, and a shallow
answer can still escalate to deep research — so raw token streaming would
leak unverified citations or superseded text). We therefore stream the
ALREADY-FINAL text as deltas: progressive rendering, not a change to the
answer. See docs/design/streaming-chat-answer.md.
"""

# No `from __future__ import annotations` here: NAT resolves the converter's
# type hints (``fold_chunks_to_response`` -> ChatResponse) against the WORKFLOW
# module's globals, so they must already be objects, not strings.
import re

from aiq_agent.common import _create_chat_response
from nat.data_models.api_server import ChatResponse
from nat.data_models.api_server import ChatResponseChunk

#: The Grid extras a terminal chunk carries beyond the answer text. Each is
#: surfaced only when applicable — the frontend renders on PRESENCE.
STREAM_EXTRA_FIELDS = (
    "cards",
    "deep_research_job_id",
    "answer_confidence",
    "sources",
    # Transparency extras (WP-A).
    "routing_decision",
    "escalation_reason",
    "answer_confidence_capped_reason",
    "answer_confidence_reason",
    "citations_removed",
    # The research turn ran out of budget before it ran out of question.
    "research_truncated",
    "job_admission_rejected",
    "retry_after_seconds",
    # The answer's structured anatomy (verdict / takeaways / callout), gated by
    # the shallow agent — a native answer field, never a card.
    "answer_meta",
    # Agent Skills: which skills ran this turn, in the order their bodies were
    # fetched, and the ``grid-hidden`` subset the disclosure mutes until the
    # reader opens the reasoning view.
    "skills_activated",
    "skills_hidden",
)

# Each piece is a non-space run with its trailing whitespace, or a run of
# whitespace — together they tile the string with no gaps or overlaps.
_DELTA_PIECES = re.compile(r"\S+\s*|\s+")


def iter_answer_deltas(text: str, *, target_size: int = 24) -> list[str]:
    """Split ``text`` into deltas whose concatenation is EXACTLY ``text``.

    Splits on whitespace boundaries so words are not torn mid-token, coalescing
    small tokens up to ``target_size`` chars per delta.
    """
    if not text:
        return []
    deltas: list[str] = []
    buf = ""
    for piece in _DELTA_PIECES.findall(text):
        buf += piece
        if len(buf) >= target_size:
            deltas.append(buf)
            buf = ""
    if buf:
        deltas.append(buf)
    return deltas


def chunk_content(chunk: ChatResponseChunk) -> str | None:
    """The content delta carried by a chunk, or None."""
    try:
        return chunk.choices[0].delta.content
    except (AttributeError, IndexError):
        return None


def chunk_finish_reason(chunk: ChatResponseChunk) -> str | None:
    """The finish_reason carried by a chunk, or None."""
    try:
        return chunk.choices[0].finish_reason
    except (AttributeError, IndexError):
        return None


def response_to_chunks(response: ChatResponse, *, stream: bool) -> list[ChatResponseChunk]:
    """Turn a fully-built ChatResponse into the chunk sequence to yield.

    - ``stream=False``: a single terminal chunk (``finish_reason="stop"``) with
      the full content and the Grid extras.
    - ``stream=True``: delta chunks (``finish_reason=None``, no extras) whose
      contents concatenate to exactly the final text, then one terminal chunk
      carrying the FULL content and the extras. The terminal is authoritative
      for persistence and the single-consumer fold.

    A job-admission rejection ("queue full") is NOT a research answer: the
    frontend surfaces its prose as a warning banner, never an answer bubble, so
    it gets ONLY the terminal chunk and no streaming bubble is ever opened.
    """
    try:
        content = response.choices[0].message.content or ""
    except (AttributeError, IndexError):
        content = ""
    model_name = getattr(response, "model", None)
    response_id = getattr(response, "id", None)
    extras = {field: value for field in STREAM_EXTRA_FIELDS if (value := getattr(response, field, None)) is not None}
    job_admission_rejected = bool(getattr(response, "job_admission_rejected", None))

    chunks: list[ChatResponseChunk] = []
    if stream and content and not job_admission_rejected:
        for delta in iter_answer_deltas(content):
            chunks.append(
                ChatResponseChunk.create_streaming_chunk(delta, id_=response_id, model=model_name, finish_reason=None)
            )
    terminal = ChatResponseChunk.create_streaming_chunk(
        content, id_=response_id, model=model_name, finish_reason="stop"
    )
    for field, value in extras.items():
        setattr(terminal, field, value)
    chunks.append(terminal)
    return chunks


def _chunk_extras(chunk: ChatResponseChunk) -> dict[str, object]:
    model_extra = getattr(chunk, "model_extra", None) or {}
    extras: dict[str, object] = {}
    for field in STREAM_EXTRA_FIELDS:
        value = getattr(chunk, field, None)
        if value is None:
            value = model_extra.get(field)
        if value is not None:
            extras[field] = value
    return extras


def fold_chunks_to_response(chunks: list[ChatResponseChunk]) -> ChatResponse:
    """Collapse a streamed chunk sequence back into one ChatResponse for
    non-streaming consumers (single-shot HTTP, the CLI).

    The terminal chunk's (``finish_reason="stop"``) content is authoritative, so
    deltas are ignored when a terminal is present and the folded content is never
    doubled. Grid extras are copied from whichever chunk carries them.
    """
    delta_parts: list[str] = []
    final_content: str | None = None
    extras: dict[str, object] = {}
    model_name: str | None = None
    response_id: str | None = None
    for chunk in chunks:
        model_name = model_name or getattr(chunk, "model", None)
        response_id = response_id or getattr(chunk, "id", None)
        content = chunk_content(chunk)
        if chunk_finish_reason(chunk) == "stop" and content:
            final_content = content
        elif chunk_finish_reason(chunk) != "stop" and content:
            delta_parts.append(content)
        extras.update(_chunk_extras(chunk))
    content = final_content if final_content is not None else "".join(delta_parts)
    response = _create_chat_response(content, response_id=response_id or "research_response", model=model_name)
    for field, value in extras.items():
        setattr(response, field, value)
    return response

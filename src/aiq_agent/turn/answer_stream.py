"""The answer's prose on the wire while the final call is still writing it.

The answering LLM call streams (``bind(stream=True)``), a callback reads its
tokens through :class:`~aiq_agent.common.answer_prose_stream.AnswerProseStream`,
and what may be shown goes out as wire bodies through the graph's own writer
(``turn_status.emit``, chat wire v2 §b): ``TEXT_MESSAGE_START``, coalesced
``TEXT_MESSAGE_CONTENT``, ``TEXT_MESSAGE_END`` when the ``answer`` string
closes, then ONE ``STATE_SNAPSHOT`` of the settled (verified, renumbered)
prose and its sources, the masthead before the first word, and a ``card`` or
``card_refused`` per card. ``RUN_FINISHED`` then carries the verified answer
and replaces it once more, with the same numbers (ADR-0066,
``docs/design/streaming-chat-answer.md``).

The one piece of per-turn state is :class:`LiveProse`, bound in a ContextVar
before the graph runs, the way ``cards/registry.py`` binds its registry: the
answer's message id, and whether prose already went out this turn.

Fail-open everywhere: nothing bound, an LLM that cannot stream, or a callback
that raises, and the turn is exactly the buffered turn it was.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from typing import Protocol

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.callbacks.manager import AsyncCallbackManager
from langchain_core.runnables.config import ensure_config

from aiq_agent.common import turn_status
from aiq_agent.common.answer_prose_stream import AnswerProseStream
from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import AnswerSnapshot
from aiq_agent.common.wire_v2 import CardBody
from aiq_agent.common.wire_v2 import CardRefusedBody
from aiq_agent.common.wire_v2 import CardRefusedValue
from aiq_agent.common.wire_v2 import CardValue
from aiq_agent.common.wire_v2 import EmptyValue
from aiq_agent.common.wire_v2 import EventBody
from aiq_agent.common.wire_v2 import MastheadBody
from aiq_agent.common.wire_v2 import MastheadValue
from aiq_agent.common.wire_v2 import StateSnapshotBody
from aiq_agent.common.wire_v2 import TextMessageContentBody
from aiq_agent.common.wire_v2 import TextMessageEndBody
from aiq_agent.common.wire_v2 import TextMessageStartBody
from aiq_agent.common.wire_v2 import card_key

logger = logging.getLogger(__name__)


#: At most one ``TEXT_MESSAGE_CONTENT`` per window: a frame per token was 78
#: frames for a four-line answer, and a reader cannot tell 50 ms apart.
RELAY_WINDOW_S = 0.05


class Live(Protocol):
    """What the agent lets the stream show before its pipeline ran (``answer_pipeline.LiveAnswer``).

    The agent supplies it, so the verifier and the gates stay on its side of
    the dependency line. ``settle`` runs in a worker thread with the turn's
    context copied: it may use no loop-bound objects and await nothing.
    """

    def masthead(self, fields: dict[str, Any], prose: str = "") -> dict[str, Any] | None: ...

    def settle(self, prose: str, sources_text: str, fields: dict[str, Any] | None) -> Any: ...

    def tool_cards(self) -> list[dict[str, Any]]: ...

    def place(self, text: str) -> str: ...

    def card(self, payload: Any) -> dict[str, Any] | None: ...

    def restates(self, fence: str, prose: str) -> bool: ...


_FENCE_OPEN = "```mermaid"
_FENCE_CLOSE = "\n```"


class MindmapHold:
    """Holds a ```mermaid mindmap fence back until it closes, so a drawing the settle removes is never shown.

    The settle drops a mindmap that only redraws a table in the answer
    (``agents/piloti/answer_shape.py``). Streamed as written, the reader
    watched it draw and then vanish when the answer settled. Here the fence is
    held from its opening line until it closes and ``drop`` decides against
    the prose already sent: dropped, it never went out; kept, it goes out
    whole. Any other mermaid fence is released as soon as its first line shows
    it is not a mindmap, so its skeleton still draws while it streams. A
    table written after the drawing is the settle's to catch, as before.
    """

    def __init__(self) -> None:
        self._held = ""
        self._holding = False
        self.sent = ""

    def feed(self, text: str, drop: Any) -> str:
        """What of ``held + text`` may go out now; ``drop(fence, sent)`` judges a closed mindmap."""
        buf, out = self._held + text, ""
        self._held = ""
        while buf:
            if self._holding:
                end = buf.find(_FENCE_CLOSE, buf.find("\n") + 1)
                if end < 0:
                    self._held = buf
                    break
                end += len(_FENCE_CLOSE)
                fence, buf = buf[:end], buf[end:]
                self._holding = False
                if not drop(fence, self.sent + out):
                    out += fence
                continue
            start = buf.find(_FENCE_OPEN)
            if start < 0:
                keep = _open_prefix_len(buf)
                out, self._held = out + buf[: len(buf) - keep], buf[len(buf) - keep :]
                break
            out, buf = out + buf[:start], buf[start:]
            first = _first_body_line(buf)
            if first is None:
                self._held = buf
                break
            if first == "mindmap":
                self._holding = True
                continue
            head_end = buf.find("\n") + 1
            out, buf = out + buf[:head_end], buf[head_end:]
        self.sent += out
        return out

    def release(self) -> str:
        """Everything still held, as written: the answer string closed on it."""
        rest, self._held, self._holding = self._held, "", False
        self.sent += rest
        return rest


def _open_prefix_len(text: str) -> int:
    """Length of the longest tail of ``text`` that could still grow into a fence opening."""
    for size in range(min(len(text), len(_FENCE_OPEN) - 1), 0, -1):
        if _FENCE_OPEN.startswith(text[-size:]):
            return size
    return 0


def _first_body_line(fence: str) -> str | None:
    """The fence's first non-blank body line once it is complete; ``None`` while it is still arriving."""
    lines = fence.split("\n")[1:]
    for line in lines[:-1]:
        if line.strip():
            return line.strip()
    return None


@dataclass
class LiveProse:
    """The turn's live answer: the id its bodies carry, and whether any prose went out.

    Once prose has gone out, no later call of the turn streams: a second answer
    appended to the bubble would read as one. A retraction resets it.
    """

    message_id: str
    streamed: bool = False


_PROSE: ContextVar[LiveProse | None] = ContextVar("live_prose", default=None)


def answer_streaming_enabled() -> bool:
    """Whether the platform owner lets the answer stream (Platform → Retrieval, ``chat.answer_streaming``).

    On unless switched off: an unset or unreachable setting streams, the
    default since ADR-0066. Off, nothing is bound, so the answering call is the
    buffered call and the answer arrives whole with ``RUN_FINISHED``; the
    reasoning steps still go out live. Blocking I/O on a cache miss: call it
    through ``asyncio.to_thread``.
    """
    from aiq_agent.common.retrieval_settings import get_retrieval_setting

    return get_retrieval_setting("chat.answer_streaming", 1) == 1


@contextmanager
def bound_live_prose(message_id: str) -> Iterator[LiveProse]:
    """Bind the turn's :class:`LiveProse` for everything started inside, the graph's tasks included."""
    prose = LiveProse(message_id)
    token = _PROSE.set(prose)
    try:
        yield prose
    finally:
        _PROSE.reset(token)


class _ProseTokenHandler(AsyncCallbackHandler):
    """Reads one LLM call's tokens into wire bodies: masthead, prose, settled prose, cards."""

    def __init__(self, prose: LiveProse, live: Live | None) -> None:
        self._prose = prose
        self._live = live
        self._reader: AnswerProseStream | None = None
        self._reset()

    def _reset(self) -> None:
        self._masthead_read = self._settled = self._started = self._ended = False
        #: Whether this call put anything on the wire; only then is there
        #: something to take back.
        self._shown = False
        self._cards = 0
        self._hold = MindmapHold()
        self._pending = ""
        self._flushed_at: float | None = None

    async def on_chat_model_start(self, *args: Any, **kwargs: Any) -> None:
        # A fresh reader per call (the envelope ladder retries on a rejected
        # parameter); none at all once the turn has shown prose.
        self._reader = None if self._prose.streamed else AnswerProseStream()
        self._reset()

    async def on_llm_new_token(self, token: Any, **kwargs: Any) -> None:
        reader = self._reader
        if reader is None:
            return
        delta = reader.feed(token_text(token))
        if not self._masthead_read and reader.masthead is not None:
            self._masthead_read = True
            self._show_masthead(reader.masthead)
        if delta:
            self._append(self._hold.feed(self._placed(delta), self._restates))
        if reader.closed and not self._settled:
            self._settled = True
            self._end()
            await self._settle_prose(reader)
            # The tools' cards head the list, and go out with the settled
            # prose even when the envelope has none of its own: the reader
            # draws an unplaced card once the prose is complete.
            tool_cards = self._guarded("tool cards", lambda live: live.tool_cards()) or []
            for card in tool_cards if reader.emitted else ():
                self._show_card(card)
            self._cards = len(tool_cards)
            self._show_envelope_cards(reader.take_cards())
        elif self._settled:
            self._show_envelope_cards(reader.take_cards())

    async def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        """A call that also asked for tools was a round, not the answer: take back what it showed.

        Only what it showed: a call whose masthead was read but gated away, and
        whose prose never started, put nothing on the wire to retract.
        """
        self._reader = None
        if self._shown and _calls_tools(response):
            logger.info("answer_stream: the streamed call asked for tools; retracting its prose")
            self._write(AnswerRetractedBody(value=EmptyValue()))
            self._prose.streamed = False
            return
        self._end()

    def _append(self, delta: str) -> None:
        """Prose, coalesced: out at once when the window since the last flush has passed."""
        if not delta:
            return
        if not self._started:
            self._started = True
            self._write(TextMessageStartBody(message_id=self._prose.message_id))
        self._pending += delta
        now = time.monotonic()
        if self._flushed_at is None or now - self._flushed_at >= RELAY_WINDOW_S:
            self._flush()

    def _flush(self) -> None:
        if not self._pending:
            return
        body = TextMessageContentBody(message_id=self._prose.message_id, delta=self._pending)
        self._pending = ""
        self._flushed_at = time.monotonic()
        turn_status.emit(body)

    def _end(self) -> None:
        """The ``answer`` string closed (or the call ended): what is held goes out, then END."""
        self._append(self._hold.release())
        if self._started and not self._ended:
            self._ended = True
            self._write(TextMessageEndBody(message_id=self._prose.message_id))

    def _write(self, body: EventBody) -> None:
        """Any body but a delta: the held prose goes out first, so order holds."""
        self._flush()
        self._shown = self._prose.streamed = True
        turn_status.emit(body)

    def _show_masthead(self, fields: dict[str, Any]) -> None:
        """The masthead above the first word, gated as far as it can be without the prose."""
        meta = self._guarded("masthead", lambda live: live.masthead(fields))
        if meta:
            self._write(MastheadBody(value=MastheadValue(answer_meta=meta)))

    async def _settle_prose(self, reader: AnswerProseStream) -> None:
        """Verify what streamed, and send it back settled; fail-open to pending markers.

        In a worker thread: verification is fuzzy matching over every retrieved
        chunk, and on the loop it would stall every other turn the worker
        streams. The model's stream waits for this callback, so order holds.
        """
        if not reader.emitted or self._live is None:
            return
        live = self._live
        try:
            settled = await asyncio.to_thread(live.settle, reader.emitted, reader.sources_text, reader.masthead)
        except Exception:  # noqa: BLE001 - RUN_FINISHED carries it anyway
            logger.warning("answer_stream: the live settle failed", exc_info=True)
            return
        if settled is None:
            return
        snapshot = AnswerSnapshot(
            text=self._placed(settled.content), sources=list(settled.sources), answer_meta=settled.answer_meta
        )
        self._write(StateSnapshotBody(snapshot=snapshot))

    def _restates(self, fence: str, prose: str) -> bool:
        """Whether a closed mindmap is one the settle would remove; shown when nothing can say."""
        return self._guarded("shape", lambda live: live.restates(fence, prose)) is True

    def _placed(self, text: str) -> str:
        """``text`` with its card markers at the positions the live list gives them (``Live.place``)."""
        if "[[card:" not in text:
            return text
        placed = self._guarded("placement", lambda live: live.place(text))
        return placed if isinstance(placed, str) else text

    def _show_envelope_cards(self, payloads: list[dict[str, Any]]) -> None:
        """Each envelope card as it closes, after the tools'; a refused one keeps its index."""
        for payload in payloads:
            card = self._guarded("card", lambda live, payload=payload: live.card(payload))
            if card is None:
                self._write(CardRefusedBody(value=CardRefusedValue(index=self._cards)))
                self._cards += 1
            else:
                self._show_card(card)

    def _show_card(self, card: dict[str, Any]) -> None:
        self._write(CardBody(value=CardValue(index=self._cards, key=card_key(card), card=card)))
        self._cards += 1

    def _guarded(self, what: str, call: Any) -> Any:
        if self._live is None:
            return None
        try:
            return call(self._live)
        except Exception:  # noqa: BLE001 - RUN_FINISHED carries it anyway
            logger.warning("answer_stream: the live %s failed", what, exc_info=True)
            return None


def _calls_tools(response: Any) -> bool:
    """Whether an ``LLMResult`` carries tool calls, in any of the places a provider puts them."""
    generations = getattr(response, "generations", None) or []
    return any(_message_calls_tools(getattr(g, "message", None)) for batch in generations for g in batch)


def _message_calls_tools(message: Any) -> bool:
    if message is None:
        return False
    if getattr(message, "tool_calls", None) or getattr(message, "tool_call_chunks", None):
        return True
    return bool((getattr(message, "additional_kwargs", None) or {}).get("tool_calls"))


def token_text(token: Any) -> str:
    """The visible text of one streamed token.

    Chat Completions hands a string. The Responses API hands the chunk's
    content blocks, where only ``text`` blocks are the reply: a ``reasoning``
    block is the model thinking, and never the reader's.
    """
    if isinstance(token, str):
        return token
    if not isinstance(token, list):
        return ""
    return "".join(
        block.get("text") or ""
        for block in token
        if isinstance(block, dict) and block.get("type") in {"text", "output_text"}
    )


def streaming_call(
    llm: Any, messages_config: dict[str, Any] | None = None, *, live: Live | None = None
) -> tuple[Any, dict[str, Any] | None]:
    """``(llm, config)`` for the answering call: streaming when the turn has live prose bound.

    ``live`` gates what streams ahead of the pipeline (the masthead, the
    settled prose, the cards); without it the prose streams alone, its
    markers pending until ``RUN_FINISHED``.

    The handler is ADDED to the call's inherited callback manager, never
    passed as the call's own callbacks: those replace the inherited ones, and
    NAT's profiler, which bills the call, rides on them.
    """
    prose = _PROSE.get()
    if prose is None or prose.streamed or not hasattr(llm, "bind"):
        return llm, None
    config = ensure_config(messages_config)
    inherited = config.get("callbacks")
    if inherited is None:
        manager = AsyncCallbackManager(handlers=[])
    elif isinstance(inherited, list):
        manager = AsyncCallbackManager(handlers=list(inherited), inheritable_handlers=list(inherited))
    else:
        manager = inherited.copy()
    manager.add_handler(_ProseTokenHandler(prose, live), inherit=True)
    return llm.bind(stream=True), {**config, "callbacks": manager}

"""The answer's prose on the wire while the final call is still writing it.

One sink per turn, bound in a ContextVar before the graph runs. The answering
LLM call streams (``bind(stream=True)``), a callback reads its tokens through
:class:`~aiq_agent.common.answer_prose_stream.AnswerProseStream`, and what may
be shown goes into the sink's queue. The turn generator relays the queue as
delta chunks while the turn runs. The ``[N]`` markers go out as the model
writes them; when the ``answer`` string closes, the prose and its sources
section are settled (verified, renumbered) and go out as ONE snapshot that
replaces the bubble's text and names its sources, before the cards and the
pipeline. The terminal chunk then carries the verified answer and replaces it
once more, with the same numbers (ADR-0066,
``docs/design/streaming-chat-answer.md``).

Fail-open everywhere: no sink, an LLM that cannot stream, or a callback that
raises, and the turn is exactly the buffered turn it was.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from typing import Protocol

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.callbacks.manager import AsyncCallbackManager
from langchain_core.runnables.config import ensure_config

from aiq_agent.common.answer_prose_stream import AnswerProseStream

logger = logging.getLogger(__name__)


#: How long the relay waits after a token for the ones behind it: at most
#: twenty frames a second, well below what a reader sees as stutter.
RELAY_WINDOW_S = 0.05


@dataclass(frozen=True)
class Snapshot:
    """The streamed prose settled: its text so far, replacing, the sources it cites, its masthead."""

    content: str
    sources: list[dict[str, Any]]
    answer_meta: dict[str, Any] | None = None


@dataclass(frozen=True)
class Masthead:
    """The fields that stand above the prose, gated, before its first word."""

    answer_meta: dict[str, Any]


@dataclass(frozen=True)
class Cards:
    """The answer's cards so far, in envelope order; ``None`` holds a refused card's place."""

    cards: list[dict[str, Any] | None]


Item = str | Snapshot | Masthead | Cards


class Live(Protocol):
    """What the agent lets the stream show before its pipeline ran (``answer_pipeline.LiveAnswer``).

    The agent supplies it, so the verifier and the gates stay on its side of
    the dependency line. ``settle`` runs in a worker thread with the turn's
    context copied: it may use no loop-bound objects and await nothing.
    """

    def masthead(self, fields: dict[str, Any], prose: str = "") -> dict[str, Any] | None: ...

    def settle(self, prose: str, sources_text: str, fields: dict[str, Any] | None) -> Any: ...

    def card(self, payload: Any) -> dict[str, Any] | None: ...


class AnswerStreamSink:
    """The turn's live prose: pushed by the callback, relayed by the generator."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[Item] = asyncio.Queue()
        #: Whether any prose went out. Once it has, no later call of the turn
        #: streams: a second answer appended to the bubble would read as one.
        self.streamed = False

    def push(self, delta: str) -> None:
        if delta:
            self.streamed = True
            self._queue.put_nowait(delta)

    def retract(self) -> None:
        """Take back what this call showed: the call turned out to be a tool round, not the answer.

        An empty snapshot clears the bubble's text, citations and masthead, in
        the asker's store and the observer's fold alike, and a later call of
        the turn may stream again. A snapshot carries no cards, so a card
        already drawn stays until the terminal frame; cards come after the
        prose, so that is rare.
        """
        self._queue.put_nowait(Snapshot(content="", sources=[], answer_meta=None))
        self.streamed = False

    def put(self, item: Snapshot | Masthead | Cards) -> None:
        self.streamed = True
        self._queue.put_nowait(item)

    async def relay(self, task: asyncio.Task[Any]) -> AsyncIterator[Item]:
        """Yield queued prose and snapshots, in order, until ``task`` is done.

        What queues up within :data:`RELAY_WINDOW_S` of a token goes out as
        ONE delta: a frame per token was 78 frames for a four-line answer, on
        the socket and on the observer bus alike. A snapshot is never merged:
        it replaces, where a delta appends.
        """
        while not task.done():
            waiter = asyncio.ensure_future(self._queue.get())
            done, _ = await asyncio.wait({waiter, task}, return_when=asyncio.FIRST_COMPLETED)
            if waiter not in done:
                waiter.cancel()
                break
            # Let the next few tokens join this one: a frame per token is a
            # frame per few characters, and the reader cannot tell 50 ms apart.
            await asyncio.sleep(RELAY_WINDOW_S)
            for item in _coalesced([waiter.result(), *self._drain()]):
                yield item
        for item in _coalesced(self._drain()):
            yield item

    def _drain(self) -> list[Item]:
        items: list[Item] = []
        while not self._queue.empty():
            items.append(self._queue.get_nowait())
        return items


def _coalesced(items: list[Item]) -> list[Item]:
    """Adjacent text joined into one delta; every other item kept where it fell."""
    out: list[Item] = []
    for item in items:
        if isinstance(item, str) and out and isinstance(out[-1], str):
            out[-1] += item
        elif item != "":
            out.append(item)
    return out


_SINK: ContextVar[AnswerStreamSink | None] = ContextVar("answer_stream_sink", default=None)


@contextmanager
def bound_answer_stream(sink: AnswerStreamSink) -> Iterator[AnswerStreamSink]:
    """Bind ``sink`` for everything started inside, the graph's tasks included."""
    token = _SINK.set(sink)
    try:
        yield sink
    finally:
        _SINK.reset(token)


class _ProseTokenHandler(AsyncCallbackHandler):
    """Reads one LLM call's tokens into the sink: masthead, prose, settled prose, cards."""

    def __init__(self, sink: AnswerStreamSink, live: Live | None) -> None:
        self._sink = sink
        self._live = live
        self._reader: AnswerProseStream | None = None
        self._masthead_read = False
        self._settled = False
        self._cards: list[dict[str, Any] | None] = []

    async def on_chat_model_start(self, *args: Any, **kwargs: Any) -> None:
        # A fresh reader per call (the envelope ladder retries on a rejected
        # parameter); none at all once the turn has shown prose.
        self._reader = None if self._sink.streamed else AnswerProseStream()
        self._masthead_read = self._settled = False
        self._cards = []

    async def on_llm_new_token(self, token: Any, **kwargs: Any) -> None:
        reader = self._reader
        if reader is None:
            return
        delta = reader.feed(token_text(token))
        if not self._masthead_read and reader.masthead is not None:
            self._masthead_read = True
            self._show_masthead(reader.masthead)
        self._sink.push(delta)
        if reader.closed and not self._settled:
            self._settled = True
            await self._settle_prose(reader)
        if self._settled:
            self._show_cards(reader.take_cards())

    async def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        """A call that also asked for tools was a round, not the answer: take back what it showed."""
        reader, self._reader = self._reader, None
        if reader is not None and (reader.emitted or self._masthead_read) and _calls_tools(response):
            logger.info("answer_stream: the streamed call asked for tools; retracting its prose")
            self._sink.retract()

    def _show_masthead(self, fields: dict[str, Any]) -> None:
        """The masthead above the first word, gated as far as it can be without the prose."""
        meta = self._guarded("masthead", lambda live: live.masthead(fields))
        if meta:
            self._sink.put(Masthead(answer_meta=meta))

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
        except Exception:  # noqa: BLE001 - the terminal frame carries it anyway
            logger.warning("answer_stream: the live settle failed", exc_info=True)
            settled = None
        if settled is not None:
            self._sink.put(
                Snapshot(
                    content=settled.content,
                    sources=list(settled.sources),
                    answer_meta=getattr(settled, "answer_meta", None),
                )
            )

    def _show_cards(self, payloads: list[dict[str, Any]]) -> None:
        """Each card as it closes; its place is kept even when it is refused."""
        if not payloads:
            return
        for payload in payloads:
            self._cards.append(self._guarded("card", lambda live, payload=payload: live.card(payload)))
        if any(card is not None for card in self._cards):
            self._sink.put(Cards(cards=list(self._cards)))

    def _guarded(self, what: str, call: Any) -> Any:
        if self._live is None:
            return None
        try:
            return call(self._live)
        except Exception:  # noqa: BLE001 - the terminal frame carries it anyway
            logger.warning("answer_stream: the live %s failed", what, exc_info=True)
            return None


def _calls_tools(response: Any) -> bool:
    """Whether an ``LLMResult`` carries tool calls, in any of the places a provider puts them."""
    for generations in getattr(response, "generations", None) or []:
        for generation in generations:
            message = getattr(generation, "message", None)
            if message is None:
                continue
            if getattr(message, "tool_calls", None) or getattr(message, "tool_call_chunks", None):
                return True
            if (getattr(message, "additional_kwargs", None) or {}).get("tool_calls"):
                return True
    return False


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
    """``(llm, config)`` for the answering call: streaming when the turn has a sink.

    ``live`` gates what streams ahead of the pipeline (the masthead, the
    settled prose, the cards); without it the prose streams alone, its
    markers pending until the terminal frame.

    The handler is ADDED to the call's inherited callback manager, never
    passed as the call's own callbacks: those replace the inherited ones, and
    NAT's profiler, which bills the call, rides on them.
    """
    sink = _SINK.get()
    if sink is None or sink.streamed or not hasattr(llm, "bind"):
        return llm, None
    config = ensure_config(messages_config)
    inherited = config.get("callbacks")
    if inherited is None:
        manager = AsyncCallbackManager(handlers=[])
    elif isinstance(inherited, list):
        manager = AsyncCallbackManager(handlers=list(inherited), inheritable_handlers=list(inherited))
    else:
        manager = inherited.copy()
    manager.add_handler(_ProseTokenHandler(sink, live), inherit=True)
    return llm.bind(stream=True), {**config, "callbacks": manager}

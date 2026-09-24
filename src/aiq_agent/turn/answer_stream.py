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
from collections.abc import Callable
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

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
    """The streamed prose settled: its text so far, replacing, and the sources it cites."""

    content: str
    sources: list[dict[str, Any]]


#: What settles a closed answer string: ``(prose, sources_text)`` to a
#: :class:`Snapshot`-shaped result, or ``None``. The agent supplies it, so the
#: verifier stays on its side of the dependency line.
Settle = Callable[[str, str], Any]


class AnswerStreamSink:
    """The turn's live prose: pushed by the callback, relayed by the generator."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[str | Snapshot] = asyncio.Queue()
        #: Whether any prose went out. Once it has, no later call of the turn
        #: streams: a second answer appended to the bubble would read as one.
        self.streamed = False

    def push(self, delta: str) -> None:
        if delta:
            self.streamed = True
            self._queue.put_nowait(delta)

    def settle(self, snapshot: Snapshot) -> None:
        self.streamed = True
        self._queue.put_nowait(snapshot)

    async def relay(self, task: asyncio.Task[Any]) -> AsyncIterator[str | Snapshot]:
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

    def _drain(self) -> list[str | Snapshot]:
        items: list[str | Snapshot] = []
        while not self._queue.empty():
            items.append(self._queue.get_nowait())
        return items


def _coalesced(items: list[str | Snapshot]) -> list[str | Snapshot]:
    """Adjacent text joined into one delta; snapshots kept where they fell."""
    out: list[str | Snapshot] = []
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
    """Reads one LLM call's tokens into the sink, and settles them when the string closes."""

    def __init__(self, sink: AnswerStreamSink, settle: Settle | None) -> None:
        self._sink = sink
        self._settle = settle
        self._reader: AnswerProseStream | None = None

    async def on_chat_model_start(self, *args: Any, **kwargs: Any) -> None:
        # A fresh reader per call (the envelope ladder retries on a rejected
        # parameter); none at all once the turn has shown prose.
        self._reader = None if self._sink.streamed else AnswerProseStream()

    async def on_llm_new_token(self, token: Any, **kwargs: Any) -> None:
        reader = self._reader
        if reader is None:
            return
        self._sink.push(reader.feed(token_text(token)))
        if reader.closed:
            self._reader = None
            self._settle_prose(reader)

    def _settle_prose(self, reader: AnswerProseStream) -> None:
        """Verify what streamed, and send it back settled; fail-open to pending markers."""
        if self._settle is None or not reader.emitted:
            return
        try:
            settled = self._settle(reader.emitted, reader.sources_text)
        except Exception:  # noqa: BLE001 - the terminal frame settles them anyway
            logger.warning("answer_stream: settling the streamed citations failed", exc_info=True)
            return
        if settled is not None:
            self._sink.settle(Snapshot(content=settled.content, sources=list(settled.sources)))


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
    llm: Any, messages_config: dict[str, Any] | None = None, *, settle: Settle | None = None
) -> tuple[Any, dict[str, Any] | None]:
    """``(llm, config)`` for the answering call: streaming when the turn has a sink.

    ``settle`` verifies the streamed prose once its ``answer`` string closes;
    without it the markers stay pending until the terminal frame.

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
    manager.add_handler(_ProseTokenHandler(sink, settle), inherit=True)
    return llm.bind(stream=True), {**config, "callbacks": manager}

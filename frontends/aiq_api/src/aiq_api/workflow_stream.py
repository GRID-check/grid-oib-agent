"""A workflow's output stream, torn down in the task that built it.

NAT's ``generate_streaming_response`` runs the workflow in a producer task and
hands items over through a queue. When its consumer stops early (the reader
cancels, a send fails) it closes the queue and returns, without cancelling or
awaiting that task. Two things go wrong from there, and err2issue filed both as
production errors:

- The task's next ``put`` raises ``QueueClosed`` in the middle of
  ``async for chunk in runner.result_stream()``. Nothing retrieves that
  exception, and its traceback holds the frames of the chain it left behind:
  ``result_stream`` -> ``function.astream`` -> the turn's own generator
  (``conversation_register._run``), each of which set ContextVars before its
  ``yield`` and resets them in its ``finally``. The chain is only finalized
  when a later GC pass frees that traceback, outside the task and its Context,
  and every one of those resets raises ``ValueError: <Token ...> was created in
  a different Context`` (#337 ``function_path_stack``, #338 ``workflow_run_id``,
  #759 our profiler and cache counters).
- Its intermediate-step tasks die on the closed queue with a ``QueueClosed``
  nobody retrieves (#334).

Closing NAT's generator with ``aclosing`` does not reach any of this: it ends the consumer side and leaves
the producer task exactly as above.

So here the producer is owned. Stopping early cancels it and waits until it has
finished, so its chain unwinds through every ``finally`` in the task and
Context that entered it, and its outcome is read, so no exception is left to
keep frames alive. That is also how the asker's Stop reaches the graph run: the
chat socket cancels the turn's task, the cancel lands here, and the producer's
cancel unwinds the workflow and every LLM call in it (``chat_socket.run_turn``).
Items are handed over with ``put_nowait`` on a queue that is never closed.

The wait is bounded by ``PRODUCER_TEARDOWN_SECONDS``. A ``finally`` in the
workflow that never returns (a checkpoint flush or an MCP close on a dead
connection) used to hold the Stop forever: the turn's terminal is sent after
this generator returns, so the reader watched "Denkt nach…" with nothing left
running for them. Past the bound the teardown is logged and left to finish in
its own task, where it still unwinds in its own Context and its outcome is
still read; the turn ends without it.

No intermediate step is read here: the chat wire carries what the turn's
``_run`` yields (wire bodies, ADR-0068), and steps go only to the exporters.

It is written here instead of patched into NAT (1.9.0 still does not cancel its
producer, #334/#337/#338/#759): the behaviour to keep is a few lines of NAT's
helper, and the defect is in how that helper owns its task, not in anything we
could configure.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:
    from nat.runtime.session import Session

logger = logging.getLogger(__name__)

#: Put on the hand-over queue when the producer task has finished, however it finished.
_END = object()

#: How long a stopped workflow may take over its teardown before the consumer
#: stops waiting for it. A healthy teardown (ledger posts, a checkpoint write)
#: takes well under a second.
PRODUCER_TEARDOWN_SECONDS = 10.0


async def stream_workflow(payload: Any, *, session: Session) -> AsyncIterator[Any]:
    """Run ``payload`` through ``session`` and yield what the workflow streams, as it streams it.

    A producer's failure is re-raised here once everything it produced has been
    yielded. Leaving early (``aclose()``, an exception or a cancel in the
    consumer) cancels the producer and waits for it, so its teardown has run,
    in its own task, before this generator returns.
    """
    items: asyncio.Queue[Any] = asyncio.Queue()
    producer = asyncio.create_task(_produce(items, payload, session=session))
    producer.add_done_callback(lambda _: items.put_nowait(_END))
    producer.add_done_callback(_read_outcome)
    try:
        while (item := await items.get()) is not _END:
            yield item
        await producer
    finally:
        await _stop(producer)


async def _produce(items: asyncio.Queue[Any], payload: Any, *, session: Session) -> None:
    """Run the workflow in this task, handing each item over without waiting on the consumer."""
    async with session.run(payload) as runner:
        async for item in runner.result_stream():
            items.put_nowait(item)


async def _stop(producer: asyncio.Task[None]) -> None:
    """Cancel ``producer`` if it is still running and wait, up to ``PRODUCER_TEARDOWN_SECONDS``, for its teardown.

    ``asyncio.wait`` never cancels what it waits on, so a cancel aimed at the
    consumer ends this wait (and propagates) while the producer finishes its
    teardown in its own task regardless. So does the bound.
    """
    producer.cancel()
    done, _ = await asyncio.wait({producer}, timeout=PRODUCER_TEARDOWN_SECONDS)
    if not done:
        logger.warning(
            "The workflow's teardown did not finish within %.0fs of the stop; the turn ends without waiting for it",
            PRODUCER_TEARDOWN_SECONDS,
        )


def _read_outcome(producer: asyncio.Task[None]) -> None:
    """Retrieve the producer's exception, so one the consumer never re-raised is not reported as unretrieved."""
    if not producer.cancelled() and producer.exception() is not None:
        logger.debug("Workflow producer ended with %r", producer.exception())

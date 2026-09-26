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
- Its intermediate-step subscription is never removed, and each step it still
  receives is enqueued by a fire-and-forget ``create_task(q.put(...))``. The
  steps written during that teardown land on the closed queue, and each task
  dies with a ``QueueClosed`` nobody retrieves (#334).

Closing NAT's generator (the WebSocket handler has used ``aclosing`` since
2026-09-16) does not reach any of this: it ends the consumer side and leaves
the producer task exactly as above.

So here the producer is owned. Stopping early cancels it and waits until it has
finished, so its chain unwinds through every ``finally`` in the task and
Context that entered it, and its outcome is read, so no exception is left to
keep frames alive. Items are handed over with ``put_nowait`` on a queue that is
never closed, the step subscription is removed before the producer ends, and
steps arrive by ``call_soon_threadsafe`` rather than a task each.

It is written here instead of patched into NAT (1.7.0): the behaviour to keep
is a dozen lines of NAT's helper, and the defect is in how that helper owns its
task, not in anything we could configure.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Any

from nat.builder.context import Context
from nat.data_models.api_server import ResponseIntermediateStep
from nat.data_models.api_server import ResponseObservabilityTrace
from nat.data_models.api_server import ResponsePayloadOutput
from nat.data_models.api_server import ResponseSerializable
from nat.data_models.intermediate_step import IntermediateStep
from nat.runtime.session import Session
from nat.utils.reactive.subscription import Subscription

logger = logging.getLogger(__name__)

#: Put on the hand-over queue when the producer task has finished, however it finished.
_END = object()


async def stream_workflow(
    payload: Any,
    *,
    session: Session,
    streaming: bool,
    step_adaptor: Any = None,
    result_type: type | None = None,
    output_type: type | None = None,
) -> AsyncIterator[Any]:
    """Run ``payload`` through ``session`` and yield what NAT's ``generate_streaming_response`` yields.

    A producer's failure is re-raised here once everything it produced has been
    yielded. Leaving early (``aclose()``, an exception or a cancel in the
    consumer) cancels the producer and waits for it, so its teardown has run,
    in its own task, before this generator returns.
    """
    items: asyncio.Queue[Any] = asyncio.Queue()
    producer = asyncio.create_task(
        _produce(
            items,
            payload,
            session=session,
            streaming=streaming,
            step_adaptor=step_adaptor,
            result_type=result_type,
            output_type=output_type,
        )
    )
    producer.add_done_callback(lambda _: items.put_nowait(_END))
    producer.add_done_callback(_read_outcome)
    try:
        while (item := await items.get()) is not _END:
            yield item if isinstance(item, ResponseSerializable) else ResponsePayloadOutput(payload=item)
        await producer
    finally:
        await _stop(producer)


async def _produce(
    items: asyncio.Queue[Any],
    payload: Any,
    *,
    session: Session,
    streaming: bool,
    step_adaptor: Any,
    result_type: type | None,
    output_type: type | None,
) -> None:
    """Run the workflow in this task, handing each item over without waiting on the consumer."""
    loop = asyncio.get_running_loop()
    async with session.run(payload) as runner:
        steps_done = asyncio.Event()
        subscription = _subscribe_steps(loop, items, step_adaptor, steps_done)
        try:
            if session.workflow.has_streaming_output and streaming:
                async for chunk in runner.result_stream(to_type=output_type):
                    items.put_nowait(chunk)
            else:
                result = await runner.result(to_type=result_type)
                items.put_nowait(runner.convert(result, output_type))
            await steps_done.wait()
        finally:
            subscription.unsubscribe()


def _subscribe_steps(
    loop: asyncio.AbstractEventLoop,
    items: asyncio.Queue[Any],
    step_adaptor: Any,
    steps_done: asyncio.Event,
) -> Subscription:
    """Forward the run's intermediate steps to ``items``, as NAT's ``pull_intermediate`` does, minus its tasks."""
    context = Context.get()
    trace_sent = False

    def on_next(step: IntermediateStep) -> None:
        nonlocal trace_sent
        if not trace_sent and context.observability_trace_id:
            loop.call_soon_threadsafe(
                items.put_nowait, ResponseObservabilityTrace(observability_trace_id=context.observability_trace_id)
            )
            trace_sent = True
        adapted = _adapt(step, step_adaptor)
        if adapted is not None:
            loop.call_soon_threadsafe(items.put_nowait, adapted)

    def on_error(exc: Exception) -> None:
        logger.error("Intermediate step stream failed: %s", exc)
        loop.call_soon_threadsafe(steps_done.set)

    def on_complete() -> None:
        loop.call_soon_threadsafe(steps_done.set)

    return context.intermediate_step_manager.subscribe(on_next=on_next, on_error=on_error, on_complete=on_complete)


def _adapt(step: IntermediateStep, step_adaptor: Any) -> Any:
    if step_adaptor is not None:
        return step_adaptor.process(step)
    return ResponseIntermediateStep(
        id=step.UUID,
        type=step.event_type,
        name=step.name or "",
        parent_id=step.parent_id,
        payload=step.payload.model_dump_json(),
    )


async def _stop(producer: asyncio.Task[None]) -> None:
    """Cancel ``producer`` if it is still running and wait until its teardown is over.

    ``asyncio.wait`` never cancels what it waits on, so a cancel aimed at the
    consumer ends this wait (and propagates) while the producer finishes its
    teardown in its own task regardless.
    """
    producer.cancel()
    await asyncio.wait({producer})


def _read_outcome(producer: asyncio.Task[None]) -> None:
    """Retrieve the producer's exception, so one the consumer never re-raised is not reported as unretrieved."""
    if not producer.cancelled() and producer.exception() is not None:
        logger.debug("Workflow producer ended with %r", producer.exception())

"""A workflow stream that stops early tears down in the task that built it (#334, #337, #338, #759).

The fixture is NAT's shape, not a mock of our own code: a runner whose
``result_stream`` nests generators with plain ``async for``, each setting a
ContextVar before its ``yield`` and resetting it in its ``finally``, and a step
subject that publishes while the run tears down, as NAT's FUNCTION_END and
WORKFLOW_END steps do. NAT's own ``generate_streaming_response`` is run through
the same fixture as the oracle: it has to produce the production errors, or the
fixture proves nothing about the fix.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import gc
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from aiq_api import workflow_stream
from nat.data_models.api_server import ResponseSerializable
from nat.front_ends.fastapi import intermediate_steps_subscriber
from nat.front_ends.fastapi.response_helpers import generate_streaming_response

_LEVEL = contextvars.ContextVar("level", default=None)


class _Chunk(ResponseSerializable):
    """A streamed item as NAT's helper expects one."""

    def __init__(self, n: int) -> None:
        self.n = n

    def get_stream_data(self) -> str:
        return str(self.n)


class _Steps:
    """NAT's step subject, reduced to subscribe / publish / complete."""

    def __init__(self) -> None:
        self.observers: list[SimpleNamespace] = []

    def subscribe(self, on_next, on_error=None, on_complete=None):
        observer = SimpleNamespace(on_next=on_next, on_complete=on_complete)
        self.observers.append(observer)
        return SimpleNamespace(unsubscribe=lambda: self.observers.remove(observer))

    def publish(self, step) -> None:
        for observer in list(self.observers):
            observer.on_next(step)

    def complete(self) -> None:
        for observer in list(self.observers):
            if observer.on_complete:
                observer.on_complete()


class _Workflow:
    """A session whose run nests three generators the way NAT's runner does, and records their teardown."""

    def __init__(self, *, items: int | None = None) -> None:
        self.items = items
        self.steps = _Steps()
        self.torn_down: list[tuple[str, asyncio.Task | None]] = []
        self.workflow = SimpleNamespace(has_streaming_output=True)

    async def _leaf(self):
        token = _LEVEL.set("leaf")
        try:
            n = 0
            while self.items is None or n < self.items:
                await asyncio.sleep(0)  # the innermost await: where a model call would be
                yield _Chunk(n=n)
                n += 1
        finally:
            _LEVEL.reset(token)
            self.torn_down.append(("leaf", asyncio.current_task()))
            self.steps.publish(SimpleNamespace(name="FUNCTION_END"))

    async def _level(self, name, inner):
        token = _LEVEL.set(name)
        try:
            async for item in inner:
                yield item
        finally:
            _LEVEL.reset(token)
            self.torn_down.append((name, asyncio.current_task()))

    async def _result_stream(self):
        # NAT's runner signals the step stream complete where the result
        # stream ends, not where the session does.
        async for item in self._level("result_stream", self._level("astream", self._leaf())):
            yield item
        self.steps.complete()

    @asynccontextmanager
    async def run(self, payload):
        token = _LEVEL.set("session")
        runner = SimpleNamespace(result_stream=lambda to_type=None: self._result_stream())
        try:
            yield runner
        finally:
            _LEVEL.reset(token)


@pytest.fixture
def workflow(monkeypatch):
    wf = _Workflow()
    context = SimpleNamespace(observability_trace_id=None, intermediate_step_manager=wf.steps)
    for module in (workflow_stream, intermediate_steps_subscriber):
        monkeypatch.setattr(module.Context, "get", staticmethod(lambda: context))
    return wf


@contextlib.contextmanager
def _loop_errors():
    """What reaches the running loop's exception handler: the records the collector forwards to err2issue.

    Installed from the test body, not a fixture: pytest-asyncio may run an
    async fixture on another loop than the test's.
    """
    loop = asyncio.get_running_loop()
    seen: list[dict] = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: seen.append(context))
    try:
        yield seen
    finally:
        loop.set_exception_handler(previous)


async def _settle(seconds: float = 0.5, *, until=None) -> None:
    """Give abandoned generators time to be finalized and their tasks collected, which is when asyncio reports them.

    The reports trickle in over a few hundred milliseconds, one abandoned level
    at a time, so this is a time window rather than a number of loop ticks.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    while loop.time() < deadline and not (until and until()):
        gc.collect()
        await asyncio.sleep(0.02)
    gc.collect()


async def _read_then_stop(stream, count: int = 3) -> list:
    """Take ``count`` items and leave, the way a cancelled turn leaves the socket loop."""
    got = []
    async with contextlib.aclosing(stream) as items:
        async for item in items:
            got.append(item)
            if len(got) == count:
                break
    return got


def _stream(open_stream, wf):
    return open_stream({"q": 1}, session=wf, streaming=True, step_adaptor=_Adapter(), output_type=None)


class _Step(ResponseSerializable):
    """An intermediate step as a step adaptor hands it over."""

    def __init__(self, name: str) -> None:
        self.name = name

    def get_stream_data(self) -> str:
        return self.name


class _Adapter:
    def process(self, step):
        return _Step(step.name)


@pytest.mark.asyncio
async def test_nat_s_own_helper_reproduces_the_production_errors(workflow):
    with _loop_errors() as loop_errors:
        # The oracle. If this stops failing the way production did, the fixture
        # no longer models NAT and the test below proves nothing.
        def reported() -> str:
            return " ".join(f"{context.get('message')} {context.get('exception')!r}" for context in loop_errors)

        await _read_then_stop(_stream(generate_streaming_response, workflow))
        await _settle(3, until=lambda: "different Context" in reported() and "QueueClosed" in reported())

        reported = reported()
        assert "was created in a different Context" in reported  # #337, #338, #759
        assert "QueueClosed" in reported  # #334


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [1, 2, 3, 4, 5])
async def test_stopping_early_tears_every_level_down_in_the_producer_task(workflow, count):
    # Each count stops the producer at a different point of its cycle; the
    # scheduler is deterministic, so together they cover every place a
    # cancel can land.
    with _loop_errors() as loop_errors:
        got = await _read_then_stop(_stream(workflow_stream.stream_workflow, workflow), count)
        await _settle()

        assert [chunk.n for chunk in got if isinstance(chunk, _Chunk)] == list(range(count))
        assert loop_errors == []
        names = [name for name, _ in workflow.torn_down]
        assert names == ["leaf", "astream", "result_stream"]
        # One task for the whole chain, and it is the one that entered it.
        assert len({task for _, task in workflow.torn_down}) == 1
        assert workflow.steps.observers == []


@pytest.mark.asyncio
async def test_a_cancelled_consumer_stops_the_run_the_same_way(workflow):
    with _loop_errors() as loop_errors:
        consumed = asyncio.Event()

        async def consume():
            async with contextlib.aclosing(_stream(workflow_stream.stream_workflow, workflow)) as items:
                async for _ in items:
                    consumed.set()

        task = asyncio.create_task(consume())
        await consumed.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await _settle()

        assert loop_errors == []
        assert [name for name, _ in workflow.torn_down] == ["leaf", "astream", "result_stream"]
        assert len({t for _, t in workflow.torn_down}) == 1


@pytest.mark.asyncio
async def test_a_run_that_finishes_yields_everything_and_its_steps(monkeypatch):
    with _loop_errors() as loop_errors:
        wf = _Workflow(items=2)
        context = SimpleNamespace(observability_trace_id=None, intermediate_step_manager=wf.steps)
        monkeypatch.setattr(workflow_stream.Context, "get", staticmethod(lambda: context))

        got = [item async for item in _stream(workflow_stream.stream_workflow, wf)]
        await _settle()

        assert [item.n for item in got if isinstance(item, _Chunk)] == [0, 1]
        assert [item.name for item in got if isinstance(item, _Step)] == ["FUNCTION_END"]
        assert loop_errors == []


@pytest.mark.asyncio
async def test_a_failed_run_is_raised_to_the_consumer(monkeypatch):
    with _loop_errors() as loop_errors:
        wf = _Workflow(items=1)
        context = SimpleNamespace(observability_trace_id=None, intermediate_step_manager=wf.steps)
        monkeypatch.setattr(workflow_stream.Context, "get", staticmethod(lambda: context))

        @asynccontextmanager
        async def failing_run(payload):
            async def boom(to_type=None):
                yield _Chunk(n=0)
                raise RuntimeError("model call failed")

            yield SimpleNamespace(result_stream=boom)

        wf.run = failing_run
        got = []
        with pytest.raises(RuntimeError, match="model call failed"):
            async for item in _stream(workflow_stream.stream_workflow, wf):
                got.append(item)
        await _settle()

        assert [item.n for item in got] == [0]
        assert loop_errors == []

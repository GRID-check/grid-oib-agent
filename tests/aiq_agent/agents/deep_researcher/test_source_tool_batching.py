"""Tests for researcher-facing source tool adapters."""

import asyncio
from contextlib import suppress
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool
from langchain_core.tools import tool
from pydantic import BaseModel

from aiq_agent.agents.deep_researcher.custom_middleware import SourceRegistryMiddleware
from aiq_agent.agents.deep_researcher.tools.source_tool_batching import SourceToolConcurrencyLimiter
from aiq_agent.agents.deep_researcher.tools.source_tool_batching import SourceToolSlotTimeout
from aiq_agent.agents.deep_researcher.tools.source_tool_batching import _make_throttled_source_tool
from aiq_agent.agents.deep_researcher.tools.source_tool_batching import adapt_source_tools_for_research


@pytest.mark.asyncio
async def test_batch_wrapper_single_string_calls_original_once():
    calls: list[str] = []

    @tool
    async def search_tool(query: str) -> str:
        """Search a source."""
        calls.append(query)
        return f"result for {query}"

    result = adapt_source_tools_for_research(
        [search_tool],
        source_tool_names={"search_tool"},
        max_concurrent_source_tool_calls=2,
        max_batch_size=3,
    )

    wrapped = result[0]
    output = await wrapped.ainvoke({"queries": "alpha"})

    assert wrapped.name == "search_tool"
    assert calls == ["alpha"]
    assert "## Query: alpha" in output
    assert "result for alpha" in output


@pytest.mark.asyncio
async def test_batch_wrapper_list_calls_original_once_per_item():
    calls: list[str] = []

    @tool
    async def search_tool(query: str) -> str:
        """Search a source."""
        calls.append(query)
        return f"https://example.test/{query}"

    result = adapt_source_tools_for_research(
        [search_tool],
        source_tool_names={"search_tool"},
        max_concurrent_source_tool_calls=3,
        max_batch_size=3,
    )

    output = await result[0].ainvoke({"queries": ["alpha", "beta", "gamma"]})

    assert sorted(calls) == ["alpha", "beta", "gamma"]
    assert "## Query: alpha" in output
    assert "## Query: beta" in output
    assert "## Query: gamma" in output
    assert "https://example.test/beta" in output


@pytest.mark.asyncio
async def test_batch_wrapper_represents_partial_failures_per_item():
    calls: list[str] = []

    @tool
    async def search_tool(query: str) -> str:
        """Search a source."""
        calls.append(query)
        if query == "bad":
            raise RuntimeError("backend unavailable")
        return f"ok {query}"

    result = adapt_source_tools_for_research(
        [search_tool],
        source_tool_names={"search_tool"},
        max_concurrent_source_tool_calls=2,
        max_batch_size=3,
    )

    output = await result[0].ainvoke({"queries": ["good", "bad"]})

    assert sorted(calls) == ["bad", "good"]
    assert "## Query: good" in output
    assert "ok good" in output
    assert "## Query: bad" in output
    assert "ERROR: backend unavailable" in output


@pytest.mark.asyncio
async def test_batch_wrapper_rejects_oversized_tool_batches_without_calling_original():
    calls: list[str] = []

    @tool
    async def search_tool(query: str) -> str:
        """Search a source."""
        calls.append(query)
        return query

    result = adapt_source_tools_for_research(
        [search_tool],
        source_tool_names={"search_tool"},
        max_concurrent_source_tool_calls=2,
        max_batch_size=1,
    )

    output = await result[0].ainvoke({"queries": ["a", "b"]})

    assert calls == []
    assert "ERROR: search_tool accepts at most 1 queries per batch" in output


@pytest.mark.asyncio
async def test_source_registry_captures_urls_from_wrapped_tool_output():
    @tool
    async def search_tool(query: str) -> str:
        """Search a source."""
        return f"{query}: https://example.test/source"

    result = adapt_source_tools_for_research(
        [search_tool],
        source_tool_names={"search_tool"},
        max_concurrent_source_tool_calls=2,
        max_batch_size=2,
    )
    output = await result[0].ainvoke({"queries": ["alpha"]})

    middleware = SourceRegistryMiddleware(source_tool_names={"search_tool"})
    request = MagicMock()
    request.tool_call = {"name": "search_tool"}
    handler = AsyncMock(return_value=ToolMessage(content=output, tool_call_id="tc1"))

    await middleware.awrap_tool_call(request, handler)

    sources = middleware.registry.all_sources()
    assert len(sources) == 1
    assert sources[0].url == "https://example.test/source"


@pytest.mark.asyncio
async def test_incompatible_multi_arg_source_tool_keeps_schema_and_is_throttled():
    @tool
    async def search_tool(query: str, limit: int) -> str:
        """Search a source."""
        return f"{query}:{limit}"

    result = adapt_source_tools_for_research(
        [search_tool],
        source_tool_names={"search_tool"},
        max_concurrent_source_tool_calls=2,
        max_batch_size=3,
    )
    wrapped = result[0]

    assert wrapped.name == "search_tool"
    assert wrapped.args == search_tool.args
    assert await wrapped.ainvoke({"query": "alpha", "limit": 5}) == "alpha:5"


@pytest.mark.asyncio
async def test_shared_limiter_caps_underlying_calls_across_wrapped_tools():
    active = 0
    max_seen = 0

    async def _recorded_result(query: str) -> str:
        nonlocal active, max_seen
        active += 1
        max_seen = max(max_seen, active)
        await asyncio.sleep(0.01)
        active -= 1
        return query

    @tool
    async def search_a(query: str) -> str:
        """Search source A."""
        return await _recorded_result(query)

    @tool
    async def search_b(query: str) -> str:
        """Search source B."""
        return await _recorded_result(query)

    result = adapt_source_tools_for_research(
        [search_a, search_b],
        source_tool_names={"search_a", "search_b"},
        max_concurrent_source_tool_calls=1,
        max_batch_size=3,
    )
    wrapped_tools = {wrapped.name: wrapped for wrapped in result}

    await asyncio.gather(
        wrapped_tools["search_a"].ainvoke({"queries": ["a1", "a2"]}),
        wrapped_tools["search_b"].ainvoke({"queries": ["b1", "b2"]}),
    )

    assert max_seen == 1


@pytest.mark.asyncio
async def test_shared_limiter_caps_non_batchable_source_tools():
    active = 0
    max_seen = 0

    @tool
    async def search_tool(query: str, limit: int) -> str:
        """Search a source."""
        nonlocal active, max_seen
        active += 1
        max_seen = max(max_seen, active)
        await asyncio.sleep(0.01)
        active -= 1
        return f"{query}:{limit}"

    result = adapt_source_tools_for_research(
        [search_tool],
        source_tool_names={"search_tool"},
        max_concurrent_source_tool_calls=1,
        max_batch_size=3,
    )

    await asyncio.gather(*(result[0].ainvoke({"query": f"q{i}", "limit": i}) for i in range(3)))

    assert max_seen == 1


@pytest.mark.asyncio
async def test_limiter_caps_concurrent_blocks():
    limiter = SourceToolConcurrencyLimiter(1)
    active = 0
    max_seen = 0

    async def hold_slot():
        nonlocal active, max_seen
        async with limiter.limit():
            active += 1
            max_seen = max(max_seen, active)
            await asyncio.sleep(0.01)
            active -= 1

    await asyncio.gather(*(hold_slot() for _ in range(3)))

    assert max_seen == 1


@pytest.mark.asyncio
async def test_limiter_releases_after_exception():
    limiter = SourceToolConcurrencyLimiter(1)

    async def fail_with_slot():
        async with limiter.limit():
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await fail_with_slot()

    async with asyncio.timeout(0.1):
        async with limiter.limit():
            pass


@pytest.mark.asyncio
async def test_limiter_timeout_does_not_release_unacquired_slot():
    limiter = SourceToolConcurrencyLimiter(1, acquire_timeout=0.01)

    async with limiter.limit():
        with pytest.raises(TimeoutError, match="Timed out waiting for a source-tool concurrency slot"):
            async with limiter.limit():
                pass

        with pytest.raises(TimeoutError, match="Timed out waiting for a source-tool concurrency slot"):
            async with limiter.limit():
                pass

    async with asyncio.timeout(0.1):
        async with limiter.limit():
            pass


@pytest.mark.asyncio
async def test_limiter_releases_after_cancellation():
    limiter = SourceToolConcurrencyLimiter(1)

    async def hold_slot():
        async with limiter.limit():
            await asyncio.sleep(1)

    task = asyncio.create_task(hold_slot())
    await asyncio.sleep(0.01)
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task

    async with asyncio.timeout(0.1):
        async with limiter.limit():
            pass


@pytest.mark.asyncio
async def test_slot_timeout_reaches_the_model_as_a_tool_error_not_a_run_failure():
    """A throttled source tool represents a slot timeout the way the batch one does.

    Two wrappers share one limiter. The batch wrapper already turned a slot
    timeout into a per-item ``ERROR:`` line; the throttled wrapper let it escape
    into the graph, where the agent catches ``TimeoutError`` and treats the
    whole deep-research run as cut off by an upstream timeout. Early in a run
    there is nothing above ``MIN_SALVAGE_REPORT_CHARS`` to salvage, so the
    reader got a failed report because OUR OWN semaphore was busy — for a source
    that was never asked anything.
    """

    class _TwoFieldInput(BaseModel):
        query: str
        page: int = 1

    called = False

    async def _never_called(**_kwargs) -> str:
        nonlocal called
        called = True
        return "should not run"

    tool = StructuredTool.from_function(
        coroutine=_never_called,
        name="ris_search_tool",
        description="Two fields, so it takes the throttle-only wrapper.",
        args_schema=_TwoFieldInput,
    )

    limiter = SourceToolConcurrencyLimiter(1, acquire_timeout=0.01)
    throttled = _make_throttled_source_tool(tool, limiter=limiter)

    # Hold the only slot, so the call below cannot acquire one.
    async with limiter.limit():
        result = await throttled.ainvoke({"query": "Fluchtweg", "page": 1})

    assert isinstance(result, str)
    assert result.startswith("ERROR:")
    assert "concurrency slot" in result
    # The model is told a call did NOT happen, which is the fact it needs to
    # decide between retrying this source and reaching for another.
    assert "No call was made" in result
    assert called is False


@pytest.mark.asyncio
async def test_slot_timeout_is_distinguishable_from_an_upstream_timeout():
    """The limiter raises its own type, so a scheduling wait cannot pose as evidence about a source."""
    limiter = SourceToolConcurrencyLimiter(1, acquire_timeout=0.01)

    async with limiter.limit():
        with pytest.raises(SourceToolSlotTimeout):
            async with limiter.limit():
                pass

    # Still a TimeoutError, so every existing handler keeps working.
    assert issubclass(SourceToolSlotTimeout, TimeoutError)


@pytest.mark.asyncio
async def test_an_upstream_timeout_from_the_tool_itself_still_propagates():
    """The run-level cutoff handling for a real upstream timeout is deliberate; do not swallow it."""

    class _TwoFieldInput(BaseModel):
        query: str
        page: int = 1

    async def _times_out(**_kwargs) -> str:
        raise TimeoutError("upstream RIS did not answer")

    tool = StructuredTool.from_function(
        coroutine=_times_out,
        name="ris_search_tool",
        description="Two fields, so it takes the throttle-only wrapper.",
        args_schema=_TwoFieldInput,
    )

    throttled = _make_throttled_source_tool(tool, limiter=SourceToolConcurrencyLimiter(2))

    with pytest.raises(TimeoutError, match="upstream RIS did not answer"):
        await throttled.ainvoke({"query": "Fluchtweg", "page": 1})

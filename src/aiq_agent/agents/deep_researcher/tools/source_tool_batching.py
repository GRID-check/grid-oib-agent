"""Researcher-facing source tool adapters."""

from __future__ import annotations

import asyncio
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langchain_core.tools import BaseTool
from langchain_core.tools import StructuredTool
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field


class SourceToolSlotTimeout(TimeoutError):
    """No concurrency slot came free — the source tool was never called.

    Distinct from the ``TimeoutError`` an upstream source raises, and the
    distinction is the whole point. Both are ``TimeoutError`` to anything that
    does not care (this subclasses it deliberately, so existing handlers keep
    working), but they mean opposite things: an upstream timeout is evidence
    about a source, while this one is evidence about OUR OWN scheduling. Letting
    the second wear the first's name told the deep researcher its sources were
    failing when nothing had been asked of them.
    """


DEFAULT_MAX_CONCURRENT_SOURCE_TOOL_CALLS = 5
DEFAULT_MAX_SOURCE_TOOL_BATCH_SIZE = 4
DEFAULT_SOURCE_TOOL_CONCURRENCY_TIMEOUT = 120.0


class SourceToolConcurrencyLimiter:
    """Shared per-event-loop limiter for source tool calls."""

    def __init__(
        self,
        max_concurrent: int,
        *,
        acquire_timeout: float | None = DEFAULT_SOURCE_TOOL_CONCURRENCY_TIMEOUT,
    ) -> None:
        if max_concurrent < 1:
            raise ValueError("max_concurrent must be >= 1")
        if acquire_timeout is not None and acquire_timeout <= 0:
            raise ValueError("acquire_timeout must be > 0 or None")
        self.max_concurrent = max_concurrent
        self.acquire_timeout = acquire_timeout
        self._semaphores: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
            weakref.WeakKeyDictionary()
        )

    def _get_semaphore(self) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        semaphore = self._semaphores.get(loop)
        if semaphore is None:
            semaphore = asyncio.Semaphore(self.max_concurrent)
            self._semaphores[loop] = semaphore
        return semaphore

    @asynccontextmanager
    async def limit(self) -> AsyncIterator[None]:
        """Acquire one source-tool slot and release it on success, failure, or cancellation."""
        semaphore = self._get_semaphore()
        acquired = False
        try:
            try:
                await asyncio.wait_for(semaphore.acquire(), timeout=self.acquire_timeout)
            except TimeoutError as exc:
                raise SourceToolSlotTimeout(
                    f"Timed out waiting for a source-tool concurrency slot after {self.acquire_timeout} seconds"
                ) from exc
            acquired = True
            yield
        finally:
            if acquired:
                semaphore.release()


class BatchSourceToolInput(BaseModel):
    """Input schema for batch-capable same-name source tool wrappers."""

    model_config = ConfigDict(extra="forbid")

    queries: str | list[str] = Field(description="One query/input string, or a list of query/input strings.")


def _single_string_input_field(tool: BaseTool) -> str | None:
    """Return the sole string input field for a compatible tool, otherwise None."""
    schema = getattr(tool, "args_schema", None)
    fields = getattr(schema, "model_fields", None)
    if not fields or len(fields) != 1:
        return None

    name, field = next(iter(fields.items()))
    if field.annotation is str:
        return name
    return None


def _format_batch_tool_output(results: list[tuple[str, str | None, str | None]]) -> str:
    """Render grouped per-input output without hiding partial failures."""
    parts: list[str] = []
    for query, output, error in results:
        body = f"ERROR: {error}" if error else (output or "")
        parts.append(f"## Query: {query}\n{body}")
    return "\n\n---\n\n".join(parts)


def _make_batch_source_tool(
    original_tool: BaseTool,
    *,
    input_field_name: str,
    limiter: SourceToolConcurrencyLimiter,
    max_batch_size: int,
) -> BaseTool:
    """Create a same-name wrapper that fans out list input to the original tool."""

    async def _run_batch(queries: str | list[str]) -> str:
        query_list = [queries] if isinstance(queries, str) else list(queries)
        if not query_list:
            return "No queries provided."
        if len(query_list) > max_batch_size:
            return (
                f"ERROR: {original_tool.name} accepts at most {max_batch_size} queries per batch. "
                f"Received {len(query_list)}."
            )

        async def _call_one(query: str) -> tuple[str, str | None, str | None]:
            try:
                async with limiter.limit():
                    result = await original_tool.ainvoke({input_field_name: query})
                return query, str(result), None
            except Exception as exc:  # noqa: BLE001 - represented as per-item failure for the LLM
                return query, None, str(exc)

        results = await asyncio.gather(*(_call_one(query) for query in query_list))
        return _format_batch_tool_output(results)

    description = (
        f"{original_tool.description}\n\n"
        "Batch mode: pass `queries` as either a single string or a list of strings. "
        "Each item is run as one underlying source-tool call and returned in grouped sections."
    )
    return StructuredTool.from_function(
        coroutine=_run_batch,
        name=original_tool.name,
        description=description,
        args_schema=BatchSourceToolInput,
    )


def _make_throttled_source_tool(
    original_tool: BaseTool,
    *,
    limiter: SourceToolConcurrencyLimiter,
) -> BaseTool:
    """Create a same-name wrapper that throttles calls to a non-batchable source tool."""

    async def _run_throttled(**kwargs) -> object:
        # A SLOT TIMEOUT IS OURS, NOT THE SOURCE'S, AND IT MUST NOT END THE RUN.
        #
        # The batch wrapper above already represents one to the model, as a
        # per-item `ERROR:` line it can read and route around. This wrapper —
        # the one every non-batchable source tool gets — let it escape into the
        # graph instead, where `DeepResearcherAgent` catches TimeoutError and
        # treats the WHOLE run as cut off by an upstream timeout. Two wrappers
        # around one limiter, disagreeing about whether waiting for our own
        # semaphore is a tool failure or a run failure.
        #
        # Early in a run there is nothing to salvage (the report is under
        # `MIN_SALVAGE_REPORT_CHARS`), so `_finalize_cutoff` re-raises and the
        # reader gets „Bericht konnte nicht abgeschlossen werden" for a source
        # that was never even asked anything.
        #
        # An upstream timeout raised BY the tool is evidence about ONE source,
        # and it stays that: a tool error the model reads and routes around.
        # It used to flow through untouched into the run-level cutoff, on the
        # argument that it was "real evidence" — and so a single slow RIS
        # answer ended a twenty-minute run with nothing salvaged (the report
        # did not exist yet) and a banner blaming a time limit that was never
        # reached. The run-level catch stays for the wall clock; a source that
        # does not answer is the tool's failure to report, not the run's to die of.
        try:
            async with limiter.limit():
                result = await original_tool.ainvoke(kwargs)
        except SourceToolSlotTimeout as exc:
            return f"ERROR: {exc}. No call was made; try this source again or use another."
        except TimeoutError as exc:
            return (
                f"ERROR: {original_tool.name} did not answer in time ({exc or 'timeout'}). "
                "Try this source again with a narrower query, or use another source."
            )
        return result

    args_schema = getattr(original_tool, "args_schema", None)
    if args_schema is None:
        return original_tool

    return StructuredTool.from_function(
        coroutine=_run_throttled,
        name=original_tool.name,
        description=original_tool.description,
        args_schema=args_schema,
        return_direct=original_tool.return_direct,
        response_format=original_tool.response_format,
    )


def adapt_source_tools_for_research(
    tools: list[BaseTool],
    *,
    source_tool_names: set[str],
    max_concurrent_source_tool_calls: int = DEFAULT_MAX_CONCURRENT_SOURCE_TOOL_CALLS,
    max_batch_size: int = DEFAULT_MAX_SOURCE_TOOL_BATCH_SIZE,
) -> list[BaseTool]:
    """Return researcher-facing tools with source calls internally throttled.

    Compatible single-string source tools are upgraded to same-name batch-capable
    tools. Other source tools keep their original schema and receive a
    throttle-only wrapper. Non-source tools are returned unchanged.
    """
    adapted_tools: list[BaseTool] = []
    limiter = SourceToolConcurrencyLimiter(max_concurrent_source_tool_calls)
    for candidate in tools:
        if candidate.name not in source_tool_names:
            adapted_tools.append(candidate)
            continue

        input_field_name = _single_string_input_field(candidate)
        if input_field_name is None:
            adapted_tools.append(_make_throttled_source_tool(candidate, limiter=limiter))
            continue

        adapted_tools.append(
            _make_batch_source_tool(
                candidate,
                input_field_name=input_field_name,
                limiter=limiter,
                max_batch_size=max_batch_size,
            )
        )

    return adapted_tools

"""Researcher runnable and batched research tool construction."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from typing import Any
from typing import cast

from langchain.tools import ToolRuntime
from langchain_core.messages import HumanMessage
from langchain_core.tools import BaseTool
from langchain_core.tools import tool

from aiq_agent.common import extract_json

from ..models import ResearchNotes
from ..models import ResearchQuery

_NO_TOOL_RUNTIME = cast(ToolRuntime, None)
logger = logging.getLogger(__name__)
_NOTE_SLUG_MAX_LENGTH = 64


def format_research_request(query: ResearchQuery) -> str:
    """Create the single-query researcher task text used by the batch tool."""
    query_json = json.dumps(query.model_dump(mode="json"), indent=2, ensure_ascii=False)
    return (
        "Batch research invocation. Execute this ResearchQuery and return a structured ResearchNotes response. "
        "Do not call write_file or edit_file; run_research_batch will persist the returned ResearchNotes under "
        "/shared/ after you return.\n\n"
        "ResearchQuery JSON:\n"
        f"{query_json}"
    )


def researcher_invoke_state(query: ResearchQuery, runtime: ToolRuntime | None) -> dict[str, Any]:
    """Build nested researcher state, carrying parent files for StateBackend-backed skills."""
    invoke_state: dict[str, Any] = {
        "messages": [HumanMessage(content=format_research_request(query))],
    }
    parent_state = getattr(runtime, "state", None) if runtime is not None else None
    if isinstance(parent_state, dict) and "files" in parent_state:
        invoke_state["files"] = parent_state["files"]
    return invoke_state


def _last_message_text(result: Any) -> str | None:
    """Return the final assistant message text from a researcher runnable result."""
    messages = result.get("messages") if isinstance(result, dict) else None
    if not messages:
        return None
    content = getattr(messages[-1], "content", None)
    if isinstance(content, str):
        return content.strip() or None
    if isinstance(content, list):
        # Structured block content: join text blocks rather than repr the list.
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif isinstance(getattr(block, "text", None), str):
                parts.append(block.text)
        return "\n".join(parts).strip() or None
    return None


def _structured_research_notes(result: Any) -> ResearchNotes:
    """Coerce a researcher runnable result into ResearchNotes.

    Prefers the agent's ``structured_response``. Some models (notably
    DeepSeek-class ones) intermittently emit the notes as a ```json-fenced or
    natural-language-prefixed assistant message instead of through the
    structured-output channel, which leaves ``structured_response`` empty. Fall
    back to extracting the JSON from the final message so one non-conformant but
    well-formed completion does not fail the worker and force a full
    orchestrator resubmit cycle.
    """
    structured = result.get("structured_response") if isinstance(result, dict) else None
    if structured is None:
        text = _last_message_text(result)
        structured = extract_json(text) if text else None
    if structured is None:
        raise ValueError("researcher worker did not return structured ResearchNotes")
    return ResearchNotes.model_validate(structured)


async def _run_research_query(
    *,
    query: ResearchQuery,
    researcher_runnable: Any,
    runtime: ToolRuntime | None,
    callbacks: list[Any],
    semaphore: asyncio.Semaphore,
) -> ResearchNotes:
    """Run one researcher worker and return its structured notes."""
    async with semaphore:
        try:
            result = await researcher_runnable.ainvoke(
                researcher_invoke_state(query, runtime),
                config={"callbacks": callbacks} if callbacks else None,
            )
        except Exception as exc:  # noqa: BLE001 - captured as per-item failure
            raise RuntimeError(f"researcher worker failed for query {query.query!r}: {exc}") from exc

        try:
            note = _structured_research_notes(result)
        except Exception as exc:  # noqa: BLE001 - captured as per-item failure
            raise ValueError(
                f"researcher worker returned invalid ResearchNotes for query {query.query!r}: {exc}"
            ) from exc

        # A note with no findings and an empty summary carries no research
        # result — it is schema-valid only because the contract sets no minimum
        # length. Treat it as a failed worker so the orchestrator resubmits the
        # query instead of persisting an empty note that silently drops the work.
        if not note.findings and not note.summary.strip():
            raise ValueError(
                f"researcher worker returned an empty ResearchNotes (no findings and blank summary) "
                f"for query {query.query!r}"
            )

        return note


def _research_note_slug(text: str) -> str:
    """Return a compact filesystem-safe slug for a research note."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", text.lower()).strip("_")
    slug = slug[:_NOTE_SLUG_MAX_LENGTH].strip("_")
    return slug or "research_note"


def _research_note_path(query: ResearchQuery) -> str:
    """Build a deterministic /shared path for a returned research note.

    Derived from the query alone (never from batch position or the returned
    note), so re-running a query after a partial batch failure overwrites the
    previous note file instead of accumulating near-duplicates.
    """
    digest_input = json.dumps(query.model_dump(mode="json"), sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha1(digest_input.encode("utf-8")).hexdigest()[:8]
    slug = _research_note_slug(query.query)
    return f"/shared/research_note_{slug}_{digest}.json"


def _research_note_files(queries: list[ResearchQuery], notes: list[ResearchNotes]) -> list[tuple[str, bytes]]:
    """Serialize returned research notes as shared JSON files.

    Serialized without ``exclude_none`` so the sole nullable field
    (``evidence_judgment``) is written as ``null`` rather than dropped, keeping
    the persisted JSON a round-trip-valid ResearchNotes.
    """
    return [
        (
            _research_note_path(query),
            json.dumps(note.model_dump(mode="json"), indent=2, ensure_ascii=False).encode("utf-8"),
        )
        for query, note in zip(queries, notes, strict=False)
    ]


def _persist_research_notes(
    *,
    backend: Any | None,
    queries: list[ResearchQuery],
    notes: list[ResearchNotes],
) -> None:
    """Persist returned ResearchNotes into parent /shared state."""
    if backend is None or not notes:
        return

    responses = backend.upload_files(_research_note_files(queries, notes))
    errors = [f"{response.path}: {response.error}" for response in responses if getattr(response, "error", None)]
    if errors:
        raise RuntimeError(f"failed to persist research note file(s): {'; '.join(errors)}")


async def _run_research_queries(
    *,
    queries: list[ResearchQuery],
    researcher_runnable: Any,
    runtime: ToolRuntime | None,
    callbacks: list[Any],
    max_concurrency: int,
) -> tuple[list[ResearchQuery], list[ResearchNotes], list[str]]:
    """Run researcher workers concurrently and collect successful query/note pairs plus surfaced errors."""
    semaphore = asyncio.Semaphore(min(max_concurrency, len(queries)))
    raw_results = await asyncio.gather(
        *(
            _run_research_query(
                query=query,
                researcher_runnable=researcher_runnable,
                runtime=runtime,
                callbacks=callbacks,
                semaphore=semaphore,
            )
            for query in queries
        ),
        return_exceptions=True,
    )

    successful_queries: list[ResearchQuery] = []
    notes: list[ResearchNotes] = []
    errors: list[str] = []
    for query, raw_result in zip(queries, raw_results, strict=False):
        if isinstance(raw_result, BaseException):
            error = str(raw_result) or raw_result.__class__.__name__
            errors.append(f"{query.query}: {error}")
        else:
            successful_queries.append(query)
            notes.append(raw_result)
    return successful_queries, notes, errors


def _assert_preferred_tools_available(queries: list[ResearchQuery], researcher_tool_names: set[str]) -> None:
    """Fail the batch before spawning workers if any query prefers an unavailable tool.

    A query whose ``preferred_tools`` are not in the researcher worker's actual
    tool registry can never be executed as planned — the worker would fall back
    to answering from model memory. Surface that as a submission error so the
    orchestrator/planner rewrites the query instead of the worker improvising.
    """
    missing = {
        tool_name
        for query in queries
        for tool_name in query.preferred_tools
        if tool_name not in researcher_tool_names
    }
    if missing:
        available = ", ".join(sorted(researcher_tool_names)) or "(none)"
        raise ValueError(
            f"run_research_batch received queries whose preferred_tools are not available to researcher "
            f"workers: {', '.join(sorted(missing))}. Available researcher tools: {available}. "
            "Re-plan the queries to use only available tools."
        )


def build_research_batch_tool(
    *,
    researcher_runnable: Any,
    callbacks: list[Any],
    max_research_concurrency: int,
    researcher_tool_names: set[str],
    backend: Any | None = None,
    source_registry_middleware: Any | None = None,
) -> BaseTool:
    """Build an orchestrator-only tool that runs researcher tasks concurrently."""

    @tool
    async def run_research_batch(
        queries: list[ResearchQuery],
        runtime: ToolRuntime = _NO_TOOL_RUNTIME,
    ) -> str:
        """Run planned research queries in parallel and return ResearchNotes JSON."""
        if not queries:
            return "[]"

        if len(queries) > max_research_concurrency:
            raise ValueError(
                f"run_research_batch accepts at most {max_research_concurrency} curated queries. "
                f"Received {len(queries)}. Rank, merge, or drop lower-priority queries and call again."
            )

        _assert_preferred_tools_available(queries, researcher_tool_names)
        successful_queries, notes, errors = await _run_research_queries(
            queries=queries,
            researcher_runnable=researcher_runnable,
            runtime=runtime,
            callbacks=callbacks,
            max_concurrency=max_research_concurrency,
        )
        if source_registry_middleware is not None:
            source_registry_middleware.register_research_note_sources(notes)
        _persist_research_notes(backend=backend, queries=successful_queries, notes=notes)

        if errors:
            retained_detail = ""
            if notes:
                retained_actions = []
                if source_registry_middleware is not None:
                    retained_actions.append("registered")
                if backend is not None:
                    retained_actions.append("persisted under /shared/")
                retained_text = " and ".join(retained_actions) if retained_actions else "retained"
                retained_detail = (
                    f" {len(notes)} successful researcher worker(s) were {retained_text}; "
                    "resubmit only the failed queries."
                )
            raise RuntimeError(
                f"run_research_batch failed for {len(errors)} of {len(queries)} researcher worker(s). "
                f"Errors: {'; '.join(errors)}.{retained_detail}"
            )

        return json.dumps(
            [note.model_dump(mode="json", exclude_none=True) for note in notes],
            indent=2,
            ensure_ascii=False,
        )

    return run_research_batch

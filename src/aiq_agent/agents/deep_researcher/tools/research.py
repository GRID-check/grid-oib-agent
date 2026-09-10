"""Researcher runnable and batched research tool construction."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from collections.abc import Iterator
from typing import Any
from typing import cast

from langchain.tools import ToolRuntime
from langchain_core.messages import HumanMessage
from langchain_core.tools import BaseTool
from langchain_core.tools import tool
from langgraph.errors import GraphRecursionError

from aiq_agent.common import RunBudgetExceededError
from aiq_agent.common import extract_json
from aiq_agent.common.cost_tracking import BudgetExceededError

from ..models import ResearchGap
from ..models import ResearchNotes
from ..models import ResearchQuery
from ..models import last_message_text

_NO_TOOL_RUNTIME = cast(ToolRuntime, None)
logger = logging.getLogger(__name__)
_NOTE_SLUG_MAX_LENGTH = 64


def _positive_int_env(name: str, default: int) -> int:
    """Positive-int env override; falls back to ``default`` when unset/invalid/<=0."""
    try:
        value = int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


# Explicit per-worker step cap: without one the LangGraph default
# recursion_limit (25) lets a stuck researcher burn its whole budget before
# failing, and the failure surfaced as a resubmittable error, feeding the
# plan -> batch -> resubmit loop. 100 steps is generous for a single-query
# researcher (each tool round-trip costs 2 steps) while still bounding a
# pathological worker. Overridable via GRID_RESEARCHER_RECURSION_LIMIT.
RESEARCHER_RECURSION_LIMIT = _positive_int_env("GRID_RESEARCHER_RECURSION_LIMIT", 100)

# Code-level bound on orchestrator resubmissions of the same query digest
# (the "retry budget: at most 2" prompt prose is advisory only). After this
# many submissions of one digest the query is returned as a terminal
# unresearchable gap instead of being run again. Overridable via
# GRID_MAX_QUERY_SUBMISSIONS.
MAX_QUERY_SUBMISSIONS = _positive_int_env("GRID_MAX_QUERY_SUBMISSIONS", 3)

# Research notes are read back by the writer at full size (its pruning
# middleware keeps the last N results intact), so a single oversized note can
# blow the writer's context late in the run. Cap the persisted payload; the
# marker tells the writer the note was cut off.
RESEARCH_NOTE_MAX_CHARS = 40_000
_RESEARCH_NOTE_TRUNCATION_SUFFIX = "\n\n[... truncated: research note exceeded the size budget ...]"

# Unresearchable-gap marker language strings reused by the batch-tool terminal
# outcome and by tests.
_UNRESEARCHABLE_SUMMARY = "Dieser Aspekt konnte nach mehrmaligen Versuchen nicht recherchiert werden."
_UNRESEARCHABLE_NARRATIVE = (
    "Der Worker hat wiederholt das Schritt- oder Wiederholungslimit erreicht, ohne verwertbare Ergebnisse zu liefern."
)


class ResearcherExhaustedError(Exception):
    """Terminal per-query worker outcome: the query cannot be researched within its step budget."""


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
        text = last_message_text(result) if isinstance(result, dict) else None
        structured = extract_json(text) if text else None
    if structured is None:
        raise ValueError("researcher worker did not return structured ResearchNotes")
    return ResearchNotes.model_validate(structured)


def _worker_config(callbacks: list[Any]) -> dict[str, Any]:
    """Per-worker invoke config with its own callback instances.

    Stateful handlers (``VerboseTraceCallback``) mutate per-run instance state
    and must not span concurrent runs (ADR-0018); ``for_new_run()`` hands back
    a fresh instance per worker so up to ``max_research_concurrency``
    researchers do not race on one handler's state.
    """
    worker_callbacks = [cb.for_new_run() if hasattr(cb, "for_new_run") else cb for cb in callbacks]
    config: dict[str, Any] = {"recursion_limit": RESEARCHER_RECURSION_LIMIT}
    if worker_callbacks:
        config["callbacks"] = worker_callbacks
    return config


async def _run_research_query(
    *,
    query: ResearchQuery,
    researcher_runnable: Any,
    runtime: ToolRuntime | None,
    callbacks: list[Any],
    semaphore: asyncio.Semaphore,
) -> ResearchNotes:
    """Run one researcher worker and return its structured notes.

    Budget exhaustion is terminal and propagates untouched (never a
    resubmittable RuntimeError); a step-budget overrun becomes
    ``ResearcherExhaustedError``; any other worker failure is captured as a
    per-item failure naming the query. A note with no findings and an empty
    summary is schema-valid only because the contract sets no minimum
    length — it is treated as a failed worker so the orchestrator resubmits
    instead of persisting an empty note that silently drops the work.
    """
    async with semaphore:
        try:
            result = await researcher_runnable.ainvoke(
                researcher_invoke_state(query, runtime), config=_worker_config(callbacks)
            )
        except (RunBudgetExceededError, BudgetExceededError):
            raise
        except GraphRecursionError:
            raise ResearcherExhaustedError(
                f"researcher worker exceeded the step budget ({RESEARCHER_RECURSION_LIMIT} steps) "
                f"for query {query.query!r}"
            ) from None
        except Exception as exc:  # noqa: BLE001 - captured as per-item failure
            raise RuntimeError(f"researcher worker failed for query {query.query!r}: {exc}") from exc

    note = _structured_research_notes(result)
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


def _string_leaves(container: Any, key: Any, value: Any) -> Iterator[tuple[Any, Any, str]]:
    """Every ``(container, key, string)`` leaf of a nested JSON value."""
    if isinstance(value, str):
        yield container, key, value
        return
    children = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else ()
    for child_key, child in children:
        yield from _string_leaves(value, child_key, child)


def _largest_string_leaf(obj: Any) -> tuple[Any, Any] | None:
    """Return ``(container, key)`` of the longest string leaf in a nested JSON value."""
    leaves = list(_string_leaves(None, None, obj))
    if not leaves:
        return None
    container, key, _ = max(leaves, key=lambda leaf: len(leaf[2]))
    return container, key


def _truncate_research_note(note: ResearchNotes) -> ResearchNotes:
    """Shrink an oversized note's largest text fields, keeping it round-trip-valid.

    Slicing the *serialized* JSON string (the previous approach) produced an
    invalid ResearchNotes file; the writer reads every note back, so an
    oversized note must stay a schema-valid ResearchNotes rather than merely
    lose detail. The single largest free-text leaf is truncated (with the
    marker suffix) repeatedly until the serialized payload fits
    ``RESEARCH_NOTE_MAX_CHARS``.
    """
    data = note.model_dump(mode="json")

    def payload_len() -> int:
        return len(json.dumps(data, indent=2, ensure_ascii=False))

    while payload_len() > RESEARCH_NOTE_MAX_CHARS:
        leaf = _largest_string_leaf(data)
        if leaf is None:
            break
        container, key = leaf
        current = container[key]
        overshoot = payload_len() - RESEARCH_NOTE_MAX_CHARS
        keep = max(0, len(current) - overshoot - len(_RESEARCH_NOTE_TRUNCATION_SUFFIX))
        new_value = current[:keep] + _RESEARCH_NOTE_TRUNCATION_SUFFIX
        if len(new_value) >= len(current):
            # Cutting the largest leaf can no longer shrink the payload; stop.
            # The ceiling is a soft one (the writer's total-char budget is the
            # real backstop), so a rare many-tiny-fields note may stay slightly
            # over rather than loop forever.
            break
        container[key] = new_value
    return ResearchNotes.model_validate(data)


def _research_note_files(queries: list[ResearchQuery], notes: list[ResearchNotes]) -> list[tuple[str, bytes]]:
    """Serialize returned research notes as shared JSON files.

    Serialized without ``exclude_none`` so the sole nullable field
    (``evidence_judgment``) is written as ``null`` rather than dropped, keeping
    the persisted JSON a round-trip-valid ResearchNotes.

    Notes whose serialised payload exceeds ``RESEARCH_NOTE_MAX_CHARS`` have
    their largest text fields truncated and are then re-serialized, so the
    persisted file stays schema-valid (the writer reads each note back) while
    a single oversized payload cannot blow the writer's context budget.
    """
    files: list[tuple[str, bytes]] = []
    for query, note in zip(queries, notes, strict=False):
        payload = json.dumps(note.model_dump(mode="json"), indent=2, ensure_ascii=False)
        if len(payload) > RESEARCH_NOTE_MAX_CHARS:
            note = _truncate_research_note(note)
            payload = json.dumps(note.model_dump(mode="json"), indent=2, ensure_ascii=False)
        files.append((_research_note_path(query), payload.encode("utf-8")))
    return files


async def _persist_research_notes(
    *,
    backend: Any | None,
    queries: list[ResearchQuery],
    notes: list[ResearchNotes],
) -> None:
    """Persist returned ResearchNotes into parent /shared state.

    The async upload: trivial for the in-memory ``StateBackend``, but the same
    call goes to a sandbox route if ``/shared/`` is ever re-routed, and a
    synchronous upload there would block the loop.
    """
    if backend is None or not notes:
        return

    responses = await backend.aupload_files(_research_note_files(queries, notes))
    errors = [f"{response.path}: {response.error}" for response in responses if getattr(response, "error", None)]
    if errors:
        raise RuntimeError(f"failed to persist research note file(s): {'; '.join(errors)}")


def _collect_worker_results(
    queries: list[ResearchQuery],
    raw_results: list[Any],
) -> tuple[list[ResearchQuery], list[ResearchNotes], list[str]]:
    """Sort gathered worker outcomes into (query, note) pairs and surfaced errors.

    An exhausted worker already burned its per-worker step budget; resubmitting
    it cannot help, so it becomes a terminal unresearchable note instead of a
    retryable error that would re-feed the plan -> batch -> resubmit loop the
    step cap exists to stop. Budget exhaustion is re-raised: it is terminal for
    the whole run.
    """
    successful_queries: list[ResearchQuery] = []
    notes: list[ResearchNotes] = []
    errors: list[str] = []
    for query, raw_result in zip(queries, raw_results, strict=False):
        if isinstance(raw_result, (RunBudgetExceededError, BudgetExceededError)):
            raise raw_result
        if isinstance(raw_result, ResearcherExhaustedError):
            successful_queries.append(query)
            notes.append(_terminal_unresearchable_note(query))
            continue
        if isinstance(raw_result, BaseException):
            errors.append(f"{query.query}: {str(raw_result) or raw_result.__class__.__name__}")
            continue
        successful_queries.append(query)
        notes.append(raw_result)
    return successful_queries, notes, errors


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
    return _collect_worker_results(queries, list(raw_results))


def _assert_batch_size(queries: list[ResearchQuery], max_research_concurrency: int) -> None:
    if len(queries) <= max_research_concurrency:
        return
    raise ValueError(
        f"run_research_batch accepts at most {max_research_concurrency} curated queries. "
        f"Received {len(queries)}. Rank, merge, or drop lower-priority queries and call again."
    )


def _assert_preferred_tools_available(queries: list[ResearchQuery], researcher_tool_names: set[str]) -> None:
    """Fail the batch before spawning workers if any query prefers an unavailable tool.

    A query whose ``preferred_tools`` are not in the researcher worker's actual
    tool registry can never be executed as planned — the worker would fall back
    to answering from model memory. Surface that as a submission error so the
    orchestrator/planner rewrites the query instead of the worker improvising.
    """
    missing = {
        tool_name for query in queries for tool_name in query.preferred_tools if tool_name not in researcher_tool_names
    }
    if missing:
        available = ", ".join(sorted(researcher_tool_names)) or "(none)"
        raise ValueError(
            f"run_research_batch received queries whose preferred_tools are not available to researcher "
            f"workers: {', '.join(sorted(missing))}. Available researcher tools: {available}. "
            "Re-plan the queries to use only available tools."
        )


def _query_digest(query: ResearchQuery) -> str:
    """Return a stable hex digest for a ResearchQuery, used for submission tracking."""
    return hashlib.sha256(
        json.dumps(query.model_dump(mode="json"), sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def _terminal_unresearchable_note(query: ResearchQuery) -> ResearchNotes:
    """Build a terminal ResearchNotes for a query that exhausted its resubmission budget."""
    return ResearchNotes(
        query_topic=_research_note_slug(query.query),
        target_components=query.target_components,
        summary=_UNRESEARCHABLE_SUMMARY,
        findings=[],
        gaps=[
            ResearchGap(
                description=f"Query: {query.query}",
                impact=_UNRESEARCHABLE_NARRATIVE,
                suggested_follow_up_queries=[],
            )
        ],
        sources=[],
        narrative_notes=_UNRESEARCHABLE_NARRATIVE,
        language="Deutsch",
        evidence_judgment=None,
    )


def _partition_by_submission_budget(
    queries: list[ResearchQuery],
    submission_counts: dict[str, int],
) -> tuple[list[ResearchQuery], list[ResearchQuery]]:
    """Record this submission of each query; split into (runnable, exhausted).

    ``submission_counts`` is the run's ledger of submissions per query digest;
    a query past ``MAX_QUERY_SUBMISSIONS`` is exhausted and gets a terminal
    note instead of another worker.
    """
    runnable: list[ResearchQuery] = []
    exhausted: list[ResearchQuery] = []
    for query in queries:
        digest = _query_digest(query)
        submission_counts[digest] = submission_counts.get(digest, 0) + 1
        (exhausted if submission_counts[digest] > MAX_QUERY_SUBMISSIONS else runnable).append(query)
    return runnable, exhausted


def _batch_failure_message(
    errors: list[str],
    *,
    total_queries: int,
    successful_count: int,
    registered: bool,
    persisted: bool,
) -> str:
    """The partial-failure message the orchestrator resubmits from."""
    message = (
        f"run_research_batch failed for {len(errors)} of {total_queries} researcher worker(s). "
        f"Errors: {'; '.join(errors)}."
    )
    if not successful_count:
        return message
    actions = [name for name, done in (("registered", registered), ("persisted under /shared/", persisted)) if done]
    retained = " and ".join(actions) or "retained"
    return (
        f"{message} {successful_count} successful researcher worker(s) were {retained}; "
        "resubmit only the failed queries."
    )


def build_research_batch_tool(
    *,
    researcher_runnable: Any,
    callbacks: list[Any],
    max_research_concurrency: int,
    researcher_tool_names: set[str],
    backend: Any | None = None,
    source_registry_middleware: Any | None = None,
    submission_counts: dict[str, int] | None = None,
) -> BaseTool:
    """Build an orchestrator-only tool that runs researcher tasks concurrently.

    ``submission_counts`` is the run's ledger of submissions per query digest
    (fresh when omitted; see :func:`_partition_by_submission_budget`). It is
    an argument so the caller that owns the run owns the ledger.
    """
    ledger: dict[str, int] = submission_counts if submission_counts is not None else {}

    @tool
    async def run_research_batch(
        queries: list[ResearchQuery],
        runtime: ToolRuntime = _NO_TOOL_RUNTIME,
    ) -> str:
        """Run planned research queries in parallel and return ResearchNotes JSON."""
        if not queries:
            return "[]"
        _assert_batch_size(queries, max_research_concurrency)
        _assert_preferred_tools_available(queries, researcher_tool_names)
        runnable_queries, exhausted_queries = _partition_by_submission_budget(queries, ledger)
        successful_queries, notes, errors = await _run_research_queries(
            queries=runnable_queries,
            researcher_runnable=researcher_runnable,
            runtime=runtime,
            callbacks=callbacks,
            max_concurrency=min(max_research_concurrency, len(runnable_queries) or 1),
        )
        successful_queries.extend(exhausted_queries)
        notes.extend(_terminal_unresearchable_note(query) for query in exhausted_queries)

        if source_registry_middleware is not None:
            source_registry_middleware.register_research_note_sources(notes)
        await _persist_research_notes(backend=backend, queries=successful_queries, notes=notes)

        if errors:
            raise RuntimeError(
                _batch_failure_message(
                    errors,
                    total_queries=len(queries),
                    successful_count=len(successful_queries) if notes else 0,
                    registered=source_registry_middleware is not None,
                    persisted=backend is not None,
                )
            )
        return json.dumps(
            [note.model_dump(mode="json", exclude_none=True) for note in notes],
            indent=2,
            ensure_ascii=False,
        )

    return run_research_batch

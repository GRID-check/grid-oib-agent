"""Streaming a deep research graph under a budget, and salvaging a cut-off run.

The graph is STREAMED, not awaited as one opaque call, purely so a cutoff has
something to salvage. ``stream_mode="values"`` yields the full graph state
after every step, so the newest one seen is the run's last known state —
including any report the writer already persisted to ``/shared/output.md``.
Awaiting ``ainvoke`` instead meant every cutoff raised out of a call that had
never returned a state, and every research note, captured source and
finished-but-unreturned report died with the exception.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from typing import NoReturn

from langgraph.errors import GraphRecursionError

from aiq_agent.common.budget_guard import RunBudgetExceededError
from aiq_agent.common.cost_tracking import BudgetExceededError
from aiq_agent.common.turn_status import CUTOFF_RUN_BUDGET
from aiq_agent.common.turn_status import CUTOFF_STEP_LIMIT
from aiq_agent.common.turn_status import CUTOFF_UPSTREAM_TIMEOUT
from aiq_agent.common.turn_status import CUTOFF_WALL_CLOCK
from aiq_agent.common.turn_status import emit_deep_research_cutoff

from .finalize import MIN_SALVAGE_REPORT_CHARS
from .finalize import _salvaged_report_length
from .models import DeepResearchAgentState
from .models import last_message_text

logger = logging.getLogger(__name__)

#: The failures a run is SALVAGED from rather than failed by. Anything else
#: propagates untouched.
_CUTOFF_ERRORS: tuple[type[BaseException], ...] = (
    TimeoutError,
    GraphRecursionError,
    RunBudgetExceededError,
    BudgetExceededError,
)


@dataclass(frozen=True)
class StreamOutcome:
    """The last graph state a stream reached, and the cutoff that ended it, if any."""

    last_state: Any
    elapsed_seconds: float
    error: BaseException | None = None


async def stream_with_budget(
    graph: Any,
    state: Any,
    *,
    config: dict[str, Any] | None,
    stream_kwargs: dict[str, Any],
    max_run_seconds: int,
) -> StreamOutcome:
    """Drive the graph to completion or to a cutoff, keeping the newest state.

    Wall-clock budget: per-call ``request_timeout`` bounds one HTTP request and
    ``recursion_limit`` bounds step COUNT — neither bounds total run time, so a
    pathological run could otherwise hold a worker slot forever. ``0`` disables
    the guard.
    """
    last_state: Any = None
    started = time.monotonic()

    async def consume() -> None:
        nonlocal last_state
        async for chunk in graph.astream(state, config=config, stream_mode="values", **stream_kwargs):
            last_state = chunk

    try:
        await asyncio.wait_for(consume(), timeout=max_run_seconds or None)
    except _CUTOFF_ERRORS as exc:
        return StreamOutcome(last_state, time.monotonic() - started, exc)
    return StreamOutcome(last_state, time.monotonic() - started)


def classify_cutoff(
    exc: BaseException,
    *,
    elapsed_seconds: float,
    max_run_seconds: int,
) -> tuple[str, BaseException]:
    """Name the cutoff for the operator channel, and the error to raise for it.

    ``asyncio.wait_for`` raises ``TimeoutError`` — and so does any provider or
    transport call that times out inside the graph, indistinguishably, because
    ``asyncio.TimeoutError`` IS ``TimeoutError``. Blaming the budget for both
    made an operator counting budget overruns count 30-second provider hiccups
    as 2400-second ones, which reads as evidence for raising a budget that was
    never reached. Elapsed time is the honest discriminator; both are salvaged
    identically and only NAMED apart.

    A budget error means the run exhausted its completion-token ceiling or a
    USD budget mid-batch: counted apart so a sizing signal never reads as a
    slow run. A recursion error means the orchestrator ran out of steps.
    """
    if isinstance(exc, (RunBudgetExceededError, BudgetExceededError)):
        return CUTOFF_RUN_BUDGET, exc
    if isinstance(exc, GraphRecursionError):
        return CUTOFF_STEP_LIMIT, exc
    if max_run_seconds > 0 and elapsed_seconds >= max_run_seconds:
        return CUTOFF_WALL_CLOCK, TimeoutError(f"deep research exceeded the {max_run_seconds} s wall-clock budget")
    return CUTOFF_UPSTREAM_TIMEOUT, TimeoutError(
        f"deep research was cut off by an upstream timeout after {elapsed_seconds:.1f} s "
        f"(well inside its {max_run_seconds} s budget)"
    )


def _fail_cutoff(
    detail: str,
    *,
    cutoff_reason: str,
    elapsed_seconds: float,
    source_count: int,
    report_chars: int,
    original: BaseException,
    cause: BaseException,
) -> NoReturn:
    """Report a cutoff with nothing worth shipping, then raise it."""
    emit_deep_research_cutoff(
        reason=cutoff_reason,
        salvaged=False,
        source_count=source_count,
        report_chars=report_chars,
        elapsed_seconds=elapsed_seconds,
    )
    logger.error("Deep research cut off (%s) after %.1fs; %s", cutoff_reason, elapsed_seconds, detail)
    raise original from cause


def _report_salvage(report_chars: int, *, cutoff_reason: str, elapsed_seconds: float, source_count: int) -> None:
    emit_deep_research_cutoff(
        reason=cutoff_reason,
        salvaged=True,
        source_count=source_count,
        report_chars=report_chars,
        elapsed_seconds=elapsed_seconds,
    )
    logger.warning(
        "Deep research cut off (%s) after %.1fs; SALVAGED a %d-char report from "
        "%d captured source(s) instead of failing the run",
        cutoff_reason,
        elapsed_seconds,
        report_chars,
        source_count,
    )


def salvage_cutoff(
    last_state: Any,
    *,
    cutoff_reason: str,
    elapsed_seconds: float,
    source_count: int,
    finalize: Callable[[Any], DeepResearchAgentState],
    original: BaseException,
    cause: BaseException,
) -> DeepResearchAgentState:
    """Salvage a cut-off run, or re-raise loudly when there is nothing to save.

    The salvage bar, deliberately conservative: ``finalize`` has to yield a
    report of at least :data:`MIN_SALVAGE_REPORT_CHARS` characters, and the
    run's normal grounding guard still applies — a run that captured no
    sources still fails with ``EmptySourceRegistryError`` rather than shipping
    an unciteable stub under a "was cut off" banner. Anything that clears the
    bar is returned MARKED, never quietly.
    """
    fail = dict(cutoff_reason=cutoff_reason, elapsed_seconds=elapsed_seconds, source_count=source_count)
    if last_state is None:
        _fail_cutoff(
            f"NO partial state to salvage (captured sources: {source_count})",
            report_chars=0,
            original=original,
            cause=cause,
            **fail,
        )
    try:
        finalized = finalize(last_state)
    except Exception as salvage_error:
        # Salvage failed its own guards (no report, nothing grounded). The
        # cutoff is the real story, so raise THAT — with the salvage failure
        # attached so the log shows why nothing was recoverable.
        _fail_cutoff(
            f"nothing salvageable ({type(salvage_error).__name__}: {salvage_error})",
            report_chars=0,
            original=original,
            cause=salvage_error,
            **fail,
        )
    report_chars = _salvaged_report_length(last_message_text(finalized) or "")
    if report_chars < MIN_SALVAGE_REPORT_CHARS:
        # A stub under a truncation banner still reads as an answer, so it is
        # treated as nothing to salvage and the cutoff is raised loudly.
        _fail_cutoff(
            f"salvaged only {report_chars} char(s), below the {MIN_SALVAGE_REPORT_CHARS}-char bar "
            "— failing the run instead of shipping a stub",
            report_chars=report_chars,
            original=original,
            cause=cause,
            **fail,
        )
    _report_salvage(report_chars, **fail)
    return finalized

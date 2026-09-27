"""A short, bounded retry for the backend's best-effort writes to the BFF.

A finished run tells the BFF how it ended (``jobs/outcome_notify.py``) and fills
its thread message (``jobs/conversation_output.py``) over the internal HTTP API.
Each of those was one POST: a BFF restart or a network blip at that moment lost
the write for good, and a run whose ``task_runs`` row the BFF had not recorded
yet got a 404 and was dropped. This is the first of two answers. It heals the
common case within half a minute; the BFF's run reconciler
(``frontends/ui/src/lib/runs/reconcile.ts``) is the backstop that heals the rest
by asking the job store.

Why a loop and not ``tenacity``: tenacity is in the venv only as somebody
else's dependency, and three attempts with two fixed pauses is the whole
policy. Declaring a library for it would add a contract without removing any
code.

The caller keeps its own ``httpx`` call inside ``send``, so each module still
owns its URL, payload and the meaning of each status code, and a test that
doubles a module's ``httpx.AsyncClient`` still doubles the only client used.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

#: The pauses between attempts: three attempts over about 25 seconds, plus the
#: time each request takes. Long enough to ride out a BFF rollout's restart and
#: the gap between a submit and the row that records it; short enough that a
#: worker is not held on a write the reconciler will make anyway.
RETRY_DELAYS_SECONDS: tuple[float, ...] = (5.0, 20.0)

#: Statuses that say "try again", not "no". 404 is added per call, below.
_RETRYABLE_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


async def _sleep(seconds: float) -> None:
    """The pause between attempts; its own function so a test can skip it."""
    await asyncio.sleep(seconds)


def is_retryable_status(status_code: int, *, retry_not_found: bool) -> bool:
    """Whether an answer is worth asking again.

    ``retry_not_found`` is the caller's knowledge that a row SHOULD exist: a job
    submitted for a ``task_runs`` row can finish before the BFF has recorded the
    row's backend job id, and the first report then meets a 404 that would be a
    200 a few seconds later. Without that knowledge a 404 is an answer (an
    interactive job has no row at all) and asking again only delays the worker.
    """
    if status_code == 404:
        return retry_not_found
    return status_code in _RETRYABLE_STATUSES


async def send_with_retry(
    send: Callable[[], Awaitable[Any]],
    *,
    label: str,
    retry_not_found: bool = False,
    delays: tuple[float, ...] | None = None,
) -> Any | None:
    """Call ``send`` until it gives a final answer or the attempts run out.

    Returns the last response, which may still be a retryable status when every
    attempt got one, so the caller reads it exactly as it read a single response.
    Returns ``None`` when every attempt raised. Never raises itself.
    """
    schedule = RETRY_DELAYS_SECONDS if delays is None else delays
    attempts = len(schedule) + 1
    response: Any | None = None
    for attempt in range(1, attempts + 1):
        if attempt > 1:
            await _sleep(schedule[attempt - 2])
        try:
            response = await send()
        except Exception:  # noqa: BLE001 — a transport failure is what the retry is for
            response = None
            last = attempt == attempts
            logger.log(
                logging.WARNING if last else logging.INFO,
                "%s: attempt %d/%d failed",
                label,
                attempt,
                attempts,
                exc_info=last,
            )
            continue
        if not is_retryable_status(response.status_code, retry_not_found=retry_not_found):
            return response
        logger.info("%s: HTTP %s on attempt %d/%d", label, response.status_code, attempt, attempts)
    return response

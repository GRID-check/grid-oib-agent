"""Tell the BFF how a background run ended.

A job is fired by the BFF and runs here, but the BFF does not learn that it finished
from the job store alone: `job_runs.status` records how the SUBMISSION went, the
browser polls the job store for the run's fate, and the server side observes
nothing. Without a call from here a scheduled run produces a report that expires
with the job store and notifies nobody. This is the call that closes that: the
worker reports the outcome by the backend job id, the only id it holds, and the
BFF turns it into an inbox item for the job's creator.

Best-effort by contract, like ``conversation_output``: the run is already
final in the job store when this is called, and a missed notification must
never unmake a good run. Idempotent on the BFF side (one inbox row per run),
so reporting twice is harmless.

Retried briefly (``internal_retry``): a BFF restart or a blip at the moment a
run ends would leave its ``task_runs`` row ``running`` for good. What the
retry does not heal, the BFF's run reconciler does, from the job store.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from typing import Literal

import httpx

from ..internal_api import internal_base_url
from ..internal_api import internal_headers
from ..internal_retry import send_with_retry

logger = logging.getLogger(__name__)

_NOTIFY_TIMEOUT_SECONDS = 10.0

JobOutcomeStatus = Literal["success", "failure", "interrupted"]


def _organization_id(usage_context: dict | None) -> str | None:
    return ((usage_context or {}).get("identity") or {}).get("organization_id")


async def notify_job_outcome(
    *,
    job_id: str,
    usage_context: dict | None,
    status: JobOutcomeStatus,
    error: str | None = None,
    report: str | None = None,
    cards: list[dict] | None = None,
    expect_run: bool = False,
) -> bool:
    """POST the run's outcome to ``/api/internal/jobs/{job_id}/outcome``.

    Returns ``True`` only when the BFF accepted it. Skips (``False``) rather
    than raising when the internal base URL, the service token, or the tenant
    is unknown — an interactive deep-research job submitted from a chat turn
    has no ``task_runs`` row to report on, and the BFF answers 404 for it,
    which is the ordinary case and logged at debug.

    ``expect_run`` is the caller saying the job WAS submitted for a
    ``task_runs`` row (it holds the run id). Then a 404 means "not recorded
    yet" — the BFF writes the backend job id onto the row after the submit
    returns, and a quick run can finish first — and is retried like a 503.
    """
    base_url = internal_base_url()
    headers = internal_headers()
    organization_id = _organization_id(usage_context)
    if not base_url or headers is None or not organization_id:
        logger.debug("Job %s: outcome not reported (internal BFF route not configured or no tenant)", job_id)
        return False

    payload: dict[str, Any] = {
        "organizationId": organization_id,
        "status": status,
        "error": error,
    }
    # The finished report rides along so the BFF can file it as the requester
    # (the task row's pinned person) instead of leaving it to expire with the
    # job store. The interactive report GET stays the other way to file it;
    # both key on this job id, so they cannot file twice.
    if report:
        payload["report"] = report
        if cards:
            payload["cards"] = cards
    url = f"{base_url.rstrip('/')}/api/internal/jobs/{job_id}/outcome"

    async def _send() -> httpx.Response:
        async with httpx.AsyncClient(timeout=_NOTIFY_TIMEOUT_SECONDS) as client:
            return await client.post(url, json=payload, headers=headers)

    response = await send_with_retry(_send, label=f"Job {job_id}: outcome report", retry_not_found=expect_run)
    if response is None:
        # Every attempt raised; send_with_retry logged the last one in full.
        return False
    if response.status_code == 404:
        # Not a scheduled run: nothing to notify, nobody to tell.
        logger.debug("Job %s: no job run to report an outcome on", job_id)
        return False
    if response.status_code not in (200, 201):
        logger.warning("Job %s: outcome report returned HTTP %s", job_id, response.status_code)
        return False
    return True


async def notify_job_outcome_from_access(
    *,
    job_id: str,
    db_url: str,
    status: JobOutcomeStatus,
    error: str | None = None,
) -> bool:
    """Report an outcome from a terminal writer that never held the run's context.

    The cancel route, the ghost reaper and the queue's retry exhaustion each
    write a terminal status for a run they are not executing, so they have no
    ``usage_context``. The tenant the BFF cross-checks is on the job's
    ``job_access`` row, written at submit. Without this, those three verdicts
    reached nobody and the BFF's ``task_runs`` row stayed ``running`` forever.

    Best-effort like :func:`notify_job_outcome`: never raises.
    """
    from .access import get_job_access

    try:
        access = await asyncio.to_thread(get_job_access, job_id, db_url)
    except Exception:  # noqa: BLE001 — best-effort by contract
        logger.warning("Job %s: could not read job access to report its outcome", job_id, exc_info=True)
        return False
    organization_id = (access or {}).get("organization_id")
    if not organization_id:
        logger.debug("Job %s: no tenant on record; outcome not reported", job_id)
        return False
    return await notify_job_outcome(
        job_id=job_id,
        usage_context={"identity": {"organization_id": organization_id}},
        status=status,
        error=error,
    )

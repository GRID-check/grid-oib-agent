"""Tell the BFF how a background run ended.

A job is fired by the BFF and runs here, and until this module existed the
BFF never learned that it finished: `job_runs.status` records how the
SUBMISSION went, the browser polls the job store for the run's fate, and the
server side observed nothing. So a scheduled run produced a report that
expired with the job store and notified nobody. This is the one call that
closes that: the worker reports the outcome by the backend job id, the only
id it holds, and the BFF turns it into an inbox item for the job's creator.

Best-effort by contract, like ``conversation_output``: the run is already
final in the job store when this is called, and a missed notification must
never unmake a good run. Idempotent on the BFF side (one inbox row per run),
so reporting twice is harmless.
"""

from __future__ import annotations

import logging
from typing import Any
from typing import Literal

import httpx

from ..websocket_reconnect import _internal_base_url
from ..websocket_reconnect import _internal_persist_headers

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
) -> bool:
    """POST the run's outcome to ``/api/internal/jobs/{job_id}/outcome``.

    Returns ``True`` only when the BFF accepted it. Skips (``False``) rather
    than raising when the internal base URL, the service token, or the tenant
    is unknown — an interactive deep-research job submitted from a chat turn
    has no ``job_runs`` row to report on, and the BFF answers 404 for it,
    which is the ordinary case and logged at debug.
    """
    base_url = _internal_base_url()
    headers = _internal_persist_headers()
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
    try:
        async with httpx.AsyncClient(timeout=_NOTIFY_TIMEOUT_SECONDS) as client:
            response = await client.post(url, json=payload, headers=headers)
    except Exception:  # noqa: BLE001 — best-effort by contract
        logger.warning("Job %s: outcome report failed", job_id, exc_info=True)
        return False
    if response.status_code == 404:
        # Not a scheduled run: nothing to notify, nobody to tell.
        logger.debug("Job %s: no job run to report an outcome on", job_id)
        return False
    if response.status_code not in (200, 201):
        logger.warning("Job %s: outcome report returned HTTP %s", job_id, response.status_code)
        return False
    return True

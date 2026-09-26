"""The worker's one question to the plan primitive: may this run start, and with which plan?

A deep research commissioned with a plan waits on it (ADR-0068). The plan is
a row of the BFF — the single writer of the workspace (ADR-0003) — and the
reader edits, holds or starts it on the run block while the worker waits. So
the worker does not read the plan from its job payload: it asks the BFF at
the instant it may start, and runs the plan it is handed then.

Three rules, the same three the ledger client keeps.

**The plan id is the only identity.** It travels in the path; there is no
body. The route reads the tenant off the plan row.

**The answer is parsed by the contract's own model.** ``ResearchPlan`` is
validated against the JSON Schema the BFF exports from its zod, so a plan this
tier cannot read fails here, as a transient error the caller retries, rather
than as a run that starts on half a plan.

**"Not yet" is data.** A waiting run is the normal case, so the route answers
200 with ``started: false`` and a retry hint. The two refusals are different
things: a replaced plan (409) means no run should start on it, and everything
else is transient.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from urllib.parse import quote

import httpx

from aiq_agent.common.research_plan import ResearchPlan

from ..websocket_reconnect import _internal_base_url
from ..websocket_reconnect import _internal_persist_headers

logger = logging.getLogger(__name__)

PLAN_TIMEOUT_SECONDS = 5.0
#: The shortest wait between two claims, whatever the BFF hints.
MIN_RETRY_SECONDS = 1.0


class PlanReplacedError(RuntimeError):
    """The plan was replaced (409): no run should start on it."""


class PlanUnavailableError(RuntimeError):
    """The claim could not be made this time: no BFF, a network error, a 5xx, an unreadable plan."""


@dataclass(frozen=True)
class PlanClaim:
    started: bool
    plan: ResearchPlan
    retry_after_seconds: float = MIN_RETRY_SECONDS


class PlanClient:
    """POST ``/api/internal/plans/{planId}/start``."""

    def __init__(self, timeout: float = PLAN_TIMEOUT_SECONDS) -> None:
        self._timeout = timeout

    async def claim_start(self, plan_id: str) -> PlanClaim:
        url = self._url(plan_id)
        headers = _internal_persist_headers()
        if url is None or headers is None:
            raise PlanUnavailableError("the internal API is not configured")
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(url, headers=headers)
        except Exception as exc:  # noqa: BLE001 — transport: the caller retries
            raise PlanUnavailableError(f"the plan claim could not be sent: {exc}") from exc
        if response.status_code == 409:
            raise PlanReplacedError(f"plan {plan_id} was replaced")
        if response.status_code != 200:
            raise PlanUnavailableError(f"the plan claim returned HTTP {response.status_code}")
        return _claim(response.json())

    @staticmethod
    def _url(plan_id: str) -> str | None:
        base_url = _internal_base_url()
        if not base_url:
            return None
        return f"{base_url.rstrip('/')}/api/internal/plans/{quote(plan_id, safe='')}/start"


def _claim(body: object) -> PlanClaim:
    if not isinstance(body, dict):
        raise PlanUnavailableError("the plan claim answered with something that is not an object")
    try:
        plan = ResearchPlan.model_validate(body.get("plan"))
    except Exception as exc:  # noqa: BLE001 — a plan this tier cannot read is not a plan to run
        raise PlanUnavailableError(f"the plan could not be read: {exc}") from exc
    retry = body.get("retryAfterSeconds")
    retry_after = float(retry) if isinstance(retry, (int, float)) else MIN_RETRY_SECONDS
    return PlanClaim(
        started=body.get("started") is True, plan=plan, retry_after_seconds=max(retry_after, MIN_RETRY_SECONDS)
    )

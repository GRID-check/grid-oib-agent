"""The one door from this tier to a run's ledger: ``append`` and ``finish``.

A run's ledger is FOLDED where the events are produced — here, in the job
runner — and STORED where the reader is, on the run's message in the BFF's
database. This module is the crossing between the two, and it is an HTTP call
with a typed body rather than a database write for the reason every other
backend→BFF write in this tier is one: the BFF is the single writer of
``grid_app`` (ADR-0003), and a workspace primitive is one HTTP API every
consumer is an equal client of (ADR-0055).

Three rules, and they are the same three ``conversation_output`` keeps.

**The run id is the only identity.** It travels in the PATH; the body names no
organization, no project and no person. The route reads all three off the
``task_runs`` row, so a body that could name a tenant would be a body that could
write into another one.

**The payload is built by the contract's own models.** ``RunLedgerAppendRequest``
and ``RunLedgerFinishRequest`` (``aiq_agent.common.run_ledger``) are validated
against the JSON Schema the BFF exports from its zod, so a body that would come
back as a 400 fails here, in this process, where the failure is a log line
instead of a run whose account silently stopped updating.

**Nothing here may fail a run.** Every call is best-effort and returns a bool.
The ledger is bookkeeping ABOUT work that is already done and already stored;
losing a flush costs the reader some of the account, and raising would cost them
the run.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

import httpx

from aiq_agent.common.run_ledger import RunLedgerAppendRequest
from aiq_agent.common.run_ledger import RunLedgerFinishRequest
from aiq_agent.common.run_ledger import to_wire

# The two preconditions of any internal backend→BFF POST: where the BFF is, and
# the service token that authenticates the call. Imported rather than re-derived
# so the base URL and the header spelling cannot drift from the message-write
# path that has been using them since long before this one existed.
from ..websocket_reconnect import _internal_base_url
from ..websocket_reconnect import _internal_persist_headers

logger = logging.getLogger(__name__)

#: Shorter than the message-persist timeout: a ledger flush happens repeatedly
#: during a run and its payload is small, so a BFF that is slow to answer should
#: cost the run a skipped flush rather than seconds of a worker's time.
LEDGER_TIMEOUT_SECONDS = 5.0


class RunLedgerClient:
    """POST the two ops of ``/api/internal/runs/{runId}/ledger``. Never raises."""

    def __init__(self, timeout: float = LEDGER_TIMEOUT_SECONDS) -> None:
        self._timeout = timeout

    async def append(self, run_id: str, body: RunLedgerAppendRequest) -> bool:
        """More of the running account: phases opened or closed, steps, status."""
        return await self._post(run_id, body)

    async def finish(self, run_id: str, body: RunLedgerFinishRequest) -> bool:
        """The terminal fact: what the run produced, or why it stopped."""
        if (body.result is None) == (body.error is None):
            # The route answers 400 to both-or-neither. Refusing it here keeps a
            # doomed POST off the wire and names the defect in this tier's log,
            # where the fold that built the body can be read.
            logger.warning("Run %s: a finish op carries a result or an error, never both", run_id)
            return False
        return await self._post(run_id, body)

    async def _post(self, run_id: str, body: RunLedgerAppendRequest | RunLedgerFinishRequest) -> bool:
        """Send one op. Returns True only when the BFF accepted it."""
        if not run_id:
            return False
        url = self._url(run_id)
        headers = _internal_persist_headers()
        if url is None or headers is None:
            # Not configured is not an error to retry: this deployment has no
            # BFF to write to. Said once per flush at debug, because a run that
            # cannot reach the BFF would otherwise log a warning per second.
            logger.debug("Run %s: internal API not configured; skipping the ledger %s", run_id, body.op)
            return False

        payload: dict[str, Any] = to_wire(body)
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(url, json=payload, headers=headers)
        except Exception:  # noqa: BLE001 — best-effort by contract; see the module docstring
            logger.warning("Run %s: the ledger %s could not be sent", run_id, body.op, exc_info=True)
            return False

        if response.status_code not in (200, 201):
            logger.warning("Run %s: the ledger %s returned HTTP %s", run_id, body.op, response.status_code)
            return False
        return True

    @staticmethod
    def _url(run_id: str) -> str | None:
        base_url = _internal_base_url()
        if not base_url:
            return None
        # Quoted although a run id is a uuid: this value reaches here from a job
        # payload, and a path segment built by concatenation is how a value that
        # is "always a uuid" one day addresses a different route.
        return f"{base_url.rstrip('/')}/api/internal/runs/{quote(run_id, safe='')}/ledger"

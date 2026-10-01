"""The backend's writes into the BFF's internal API: a message row, a run's report.

Python never touches the database (``grid_app`` is single-writer); every write
goes over the internal HTTP API with the shared ``GRID_INTERNAL_API_TOKEN``.
The chat socket persists a finished turn through here (``chat_socket``), and so
do the jobs runner and its notifiers (``jobs/``), so there is one place that
knows how the backend writes a message.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from aiq_api.internal_retry import send_with_retry

logger = logging.getLogger(__name__)

# httpx timeout for the fail-soft server-side persistence POST.
_PERSIST_TIMEOUT_SECONDS = 10.0


def internal_base_url() -> str | None:
    """Resolve the BFF base URL for internal server-to-server calls."""
    return os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL")


INTERNAL_TOKEN_HEADER = "X-Grid-Internal-Token"


def internal_headers() -> dict[str, str] | None:
    """Service-token headers for the internal persist POST, or None if unset.

    Mirrors the ``remember`` tool's internal-endpoint pattern
    (``project_memory.py``): authenticate the backend→BFF call with the shared
    ``GRID_INTERNAL_API_TOKEN`` rather than replaying the browser's handshake
    cookie, which expires on long deep-research turns and would silently 401.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        return None
    return {"Content-Type": "application/json", INTERNAL_TOKEN_HEADER: token}


async def post_internal_conversation_message(
    *,
    conversation_id: str,
    organization_id: str | None,
    message_id: str,
    role: str,
    text: str,
    message_type: str,
    metadata: dict[str, Any] | None = None,
    created_at: str | None = None,
) -> bool:
    """POST ONE message row to the BFF's internal messages route. Fail-soft.

    The single producer for ``POST /api/internal/conversations/{id}/messages``
    from this service: it owns the base-URL/service-token/organization
    preconditions, the wire shape, and the "never raise" contract. Two callers
    sit on top of it — ``persist_assistant_message`` (every finished socket
    turn) and the jobs runner's conversation materialisation
    (``jobs/conversation_output.py``) — so there is exactly one place that
    knows how the backend writes a message, and Python still never touches the
    database.

    ``message_id`` is the caller's business: the route upserts with
    ``onConflictDoNothing`` on ``messages.id``, so a deterministic id makes a
    repeated write a no-op instead of a duplicate. ``created_at`` (ISO-8601)
    is optional and lets a caller that writes SEVERAL rows pin their order —
    the reader sorts by ``createdAt`` (then id), not by insertion order.

    Returns ``True`` only when the BFF accepted the write.
    """
    base_url = internal_base_url()
    if not base_url:
        logger.warning(
            "Cannot persist message for %s: FRONTEND_INTERNAL_URL/FRONTEND_URL not configured",
            conversation_id,
        )
        return False

    headers = internal_headers()
    if headers is None:
        logger.warning(
            "Cannot persist message for %s: GRID_INTERNAL_API_TOKEN not configured",
            conversation_id,
        )
        return False

    if not organization_id:
        # The internal route scopes the conversation lookup by org; without it
        # the write would 404. Skip rather than issue a doomed POST.
        logger.warning(
            "Cannot persist message for %s: organization id unavailable",
            conversation_id,
        )
        return False

    payload: dict[str, Any] = {
        "organizationId": organization_id,
        "id": message_id,
        "role": role,
        "content": text,
        "messageType": message_type,
        "metadata": metadata or {},
    }
    if created_at:
        payload["createdAt"] = created_at
    url = f"{base_url.rstrip('/')}/api/internal/conversations/{conversation_id}/messages"

    async def _send() -> httpx.Response:
        async with httpx.AsyncClient(timeout=_PERSIST_TIMEOUT_SECONDS) as client:
            return await client.post(url, json=payload, headers=headers)

    # Retried briefly on a transport failure or a 5xx (``internal_retry``); the
    # deterministic message id is what makes a repeated write a no-op. A 404 is
    # final here: the conversation is not there, and it will not appear.
    response = await send_with_retry(_send, label=f"Server-side persist for conversation {conversation_id}")
    if response is None:
        logger.warning("Failed to persist %s message server-side for conversation %s", role, conversation_id)
        return False
    if response.status_code not in (200, 201):
        logger.warning(
            "Server-side persist for conversation %s returned HTTP %s",
            conversation_id,
            response.status_code,
        )
        return False
    logger.info("Persisted %s message server-side for conversation %s", role, conversation_id)
    return True


async def post_internal_run_report(
    *,
    job_id: str,
    text: str,
    metadata: dict[str, Any] | None = None,
    expect_run: bool = False,
) -> str | None:
    """Write a finished run's answer INTO the run's own message. Fail-soft.

    Returns the id of the message the report landed in, so the run's ledger can
    name the same row (``result.reportMessageId``) without deriving it a second
    time. ``""`` when the BFF accepted the write but named no message (an older
    build); ``None`` for every reason to fall back, below.

    A run is one message in the thread that commissioned it (ADR-0062): the BFF
    mints that message when the run is submitted, and this fills it in. Keyed on
    the BACKEND job id because that is the only id a worker holds — the message
    id is derived from the ``task_runs`` id, which this service never sees.

    Returns ``None`` for every reason a caller should fall back to writing an
    ordinary turn instead, and they are not all failures: **404 is the answer for
    a run that has no message** (an interactive deep-research job has no task row
    at all; a run submitted before this shipped has no message). The caller's
    fallback is today's question-and-answer pair, so a deploy in either order
    still lands the report in front of the reader.

    The write goes over the internal HTTP API with the service token, like every
    other backend→BFF write: ``grid_app`` is single-writer and Python never
    touches the database.

    Retried briefly (``internal_retry``). ``expect_run`` says the job was
    submitted for a ``task_runs`` row, so a 404 may only mean the BFF has not
    recorded the row's backend job id yet; it is retried before the caller
    falls back to the older question-and-answer pair.
    """
    base_url = internal_base_url()
    headers = internal_headers()
    if not base_url or headers is None:
        logger.warning("Cannot write the run report for job %s: internal API not configured", job_id)
        return None

    url = f"{base_url.rstrip('/')}/api/internal/runs/by-job/{job_id}/report"
    payload: dict[str, Any] = {"content": text, "metadata": metadata or {}}

    async def _send() -> httpx.Response:
        async with httpx.AsyncClient(timeout=_PERSIST_TIMEOUT_SECONDS) as client:
            return await client.post(url, json=payload, headers=headers)

    response = await send_with_retry(_send, label=f"Run report for job {job_id}", retry_not_found=expect_run)
    if response is None:
        logger.warning("Failed to write the run report for job %s", job_id)
        return None

    if response.status_code == 404:
        logger.debug("Job %s has no run message; the thread turn is written the old way", job_id)
        return None
    if response.status_code not in (200, 201):
        logger.warning("Run report for job %s returned HTTP %s", job_id, response.status_code)
        return None
    logger.info("Wrote the report into the run message for job %s", job_id)
    try:
        message_id = response.json().get("messageId")
    except Exception:  # noqa: BLE001 — the write happened; a missing id costs only the ledger's link
        message_id = None
    return message_id if isinstance(message_id, str) else ""


#: The confinement check sits in front of a turn, so it gets one short attempt:
#: a "no" closes the socket, and the client's reconnect is the retry.
_CONFINEMENT_TIMEOUT_SECONDS = 5.0


async def conversation_confined_to(*, conversation_id: str, organization_id: str | None, user_id: str | None) -> bool:
    """Whether only ``user_id`` can read the conversation, as the BFF answers it now (ADR-0078).

    ``POST /api/internal/conversations/{id}/confinement``. Fails CLOSED: anything
    but an explicit ``{"confined": true}`` — no internal API, no organization or
    asker to ask about, a transport error, a non-200, a body without the flag —
    is ``False``. The caller withholds restricted content on ``False``, so a
    broken check costs a reconnect, never a leak.
    """
    base_url = internal_base_url()
    headers = internal_headers()
    if not base_url or headers is None or not organization_id or not user_id:
        logger.warning("Cannot check whether conversation %s is private: internal API or ids missing", conversation_id)
        return False
    url = f"{base_url.rstrip('/')}/api/internal/conversations/{conversation_id}/confinement"
    try:
        async with httpx.AsyncClient(timeout=_CONFINEMENT_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url, json={"organizationId": organization_id, "userId": user_id}, headers=headers
            )
        confined = response.json().get("confined") if response.status_code == 200 else None
    except Exception:  # noqa: BLE001 — any failure is a "no"; the reason is logged
        logger.warning("Confinement check for conversation %s failed", conversation_id, exc_info=True)
        return False
    if confined is not True:
        logger.info("Conversation %s is not confined to its asker (HTTP %s)", conversation_id, response.status_code)
    return confined is True

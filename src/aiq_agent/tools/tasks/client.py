"""The one call this tier makes to the task API.

``POST /api/internal/tasks``, op ``create``. Nothing here writes a row: the BFF
is the single writer of ``grid_app`` (ADR-0003) and this module is a CLIENT of
the route (ADR-0055), exactly as ``tools/documents/filing.py`` is a client of the
document-versions route.

## Echo, never sign

Same rule, same reason, and it is worth restating rather than cross-referencing,
because the failure it prevents is invisible: the internal token and the signing
secret are the SAME secret, so a tier that built its own envelope would be
choosing the acting user id with a credential that only authenticates the
service. The envelope the BFF minted at the start of the turn is forwarded
byte-for-byte; the BFF verifies it, resolves that person's pinned session and
creates the task with them as the requester. A run with no envelope — a CLI call,
an eval, the job worker — has no acting person, and the tool refuses rather than
falling back to the unsigned individual headers a caller could have set.

## Why this is not ``tools/documents/filing.py``

It is the same shape and a different contract: a different path, a different body
and a different set of refusals to word for the model. Sharing the transport
would mean one function with a path parameter and two error vocabularies, which
is the fork this repo's own guidance warns about — a helper lifted for half its
callers. What IS shared and must stay shared is the RULE, and the rule is stated
in ``src/aiq_agent/tools/AGENTS.md``, not in a function.

``SignedEnvelope`` itself IS imported from there, because two frozen dataclasses
holding the same two strings would be two types the type checker keeps apart for
no reason. It is safe to import across the plugin boundary that the entry points
draw: that module is stdlib-only, so it drags in no optional dependency — which
is the whole of what the "own entry point" rule in ``src/aiq_agent/AGENTS.md``
protects against.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

from ..documents.filing import SignedEnvelope

logger = logging.getLogger(__name__)

#: The one route. Its op set is `create` and nothing else: a machine may ASK for
#: work, never judge it — reviewing a task is a session route, and a machine that
#: could accept its own output would close the loop ADR-0051 exists to open.
INTERNAL_TASKS_PATH = "/api/internal/tasks"

#: Generous, like the filing call and for the same reason one step further along:
#: creating a task RESOLVES a skill, builds the project's whole run context and
#: submits a job to the backend queue. A turn that gave up early would leave the
#: reader unsure whether the work was queued, which is worse than a refusal.
REQUEST_TIMEOUT_SECONDS = 20


class DelegationError(RuntimeError):
    """The route refused, or could not be reached. Carries what the model may be told."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse to follow redirects — a 3xx here is an auth middleware, not a move.

    Following it would drop the POST body, the envelope and the service token and
    surface a misleading downstream error, so fail fast with the original status.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def _error_code(exc: urllib.error.HTTPError) -> str | None:
    """Best-effort ``code`` field from the BFF's ``{"error", "code"}`` envelope."""
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - body may be empty, unreadable or not JSON
        return None
    return payload.get("code") if isinstance(payload, dict) else None


def post_task(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """One call to the internal tasks route; the parsed JSON body.

    Raises :class:`DelegationError` for every refusal and every transport
    failure, so the tool has exactly one thing to catch. Blocking — call it
    through ``asyncio.to_thread``.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise DelegationError("GRID_INTERNAL_API_TOKEN is not configured")

    request = urllib.request.Request(
        f"{_internal_base_url()}{INTERNAL_TASKS_PATH}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Grid-Internal-Token": token,
            # The two that decide WHO this is. Forwarded exactly as they arrived.
            "X-Grid-Request-Context": envelope.header,
            "X-Grid-Request-Context-Sig": envelope.signature,
        },
        method="POST",
    )

    try:
        with _opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        code = _error_code(exc)
        logger.warning("Delegation refused by the BFF (status=%s code=%s)", exc.code, code)
        raise DelegationError(f"the task API refused the call ({exc.code})", status=exc.code, code=code) from exc
    except Exception as exc:  # noqa: BLE001 - transport; the tool words it for the model
        logger.warning("Delegation could not reach the BFF", exc_info=True)
        raise DelegationError("the task API could not be reached") from exc

    if not isinstance(body, dict):
        raise DelegationError("the task API answered with something that is not an object")
    return body

"""Project Memory client — backend write access via the internal BFF endpoint.

Strict separation of concerns: the ``grid_app`` database has exactly ONE
writer, the Next.js BFF. The backend never opens a connection to it. The
``remember`` tool posts findings to the internal endpoint
``POST /api/internal/memory`` over the compose network, authenticated with a
shared service token (``GRID_INTERNAL_API_TOKEN`` set on both services).

See docs/architecture/project-memory-design.md.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

VALID_KINDS = {"decision", "constraint", "open_question", "derived_fact", "preference"}
VALID_CONFIDENCES = {"low", "medium", "high"}
VALID_SCOPES = {"project", "organization"}

_REQUEST_TIMEOUT_SECONDS = 5


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse to follow redirects.

    The internal endpoint never redirects; a 3xx means an auth middleware
    intercepted the call (e.g. AuthKit sending us to a sign-in page). Following
    it would drop the POST body and the service-token header and surface a
    misleading downstream error, so fail fast with the original status instead.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


VALID_PROVENANCES = {"agent", "distillation"}


def insert_memory_item(
    *,
    scope: str,
    project_id: str | None,
    organization_id: str | None,
    kind: str,
    content: str,
    confidence: str = "medium",
    conversation_id: str | None = None,
    provenance_type: str = "agent",
) -> str | None:
    """Record one memory item via the internal BFF endpoint.

    ``provenance_type`` distinguishes how the item was captured: ``agent`` for a
    deliberate in-turn ``remember`` call, ``distillation`` for the async
    post-answer reflection stage. It lets the UI label the two differently.

    Returns the new item id, or None when the target (project/org) is unknown.
    Raises RuntimeError on configuration problems and urllib errors on
    transport failures — callers translate these into friendly tool output.
    Blocking; call via ``asyncio.to_thread`` from async code.
    """
    if scope not in VALID_SCOPES:
        raise ValueError(f"Invalid scope '{scope}'. Must be one of: {sorted(VALID_SCOPES)}")
    if kind not in VALID_KINDS:
        raise ValueError(f"Invalid kind '{kind}'. Must be one of: {sorted(VALID_KINDS)}")
    if confidence not in VALID_CONFIDENCES:
        raise ValueError(f"Invalid confidence '{confidence}'. Must be one of: {sorted(VALID_CONFIDENCES)}")
    if provenance_type not in VALID_PROVENANCES:
        provenance_type = "agent"

    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise RuntimeError("GRID_INTERNAL_API_TOKEN is not configured")

    payload: dict[str, str] = {
        "scope": scope,
        "kind": kind,
        "content": content.strip()[:2000],
        "confidence": confidence,
        "provenanceType": provenance_type,
    }
    if project_id:
        payload["projectId"] = project_id
    if organization_id:
        payload["organizationId"] = organization_id
    if conversation_id:
        payload["sourceConversationId"] = conversation_id

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/memory",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Grid-Internal-Token": token,
        },
        method="POST",
    )

    try:
        with _opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
            return body.get("item", {}).get("id")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # Unknown project — nothing recorded, not a transport failure.
            return None
        if 300 <= exc.code < 400:
            logger.error(
                "Internal memory endpoint redirected (%s) — an auth middleware is "
                "intercepting %s/api/internal/memory. Exclude /api/internal/* from "
                "the frontend auth proxy (unauthenticatedPaths in proxy.ts).",
                exc.code,
                _internal_base_url(),
            )
        elif exc.code == 403:
            logger.error(
                "Internal memory endpoint rejected the service token (403) — "
                "GRID_INTERNAL_API_TOKEN mismatch between aiq-agent and frontend."
            )
        elif exc.code == 503:
            logger.error(
                "Internal memory endpoint disabled (503) — GRID_INTERNAL_API_TOKEN "
                "is unset, or is the dev default in a non-dev environment "
                "(set APP_ENV=development on the frontend or configure a real token)."
            )
        else:
            logger.warning("Internal memory endpoint returned %s", exc.code)
        raise

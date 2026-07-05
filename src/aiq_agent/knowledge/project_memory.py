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


def _internal_base_url() -> str:
    url = (
        os.environ.get("FRONTEND_INTERNAL_URL")
        or os.environ.get("FRONTEND_URL")
        or "http://frontend:3000"
    )
    return url.rstrip("/")


def insert_memory_item(
    *,
    scope: str,
    project_id: str | None,
    organization_id: str | None,
    kind: str,
    content: str,
    confidence: str = "medium",
    conversation_id: str | None = None,
) -> str | None:
    """Record one memory item via the internal BFF endpoint.

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

    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise RuntimeError("GRID_INTERNAL_API_TOKEN is not configured")

    payload: dict[str, str] = {
        "scope": scope,
        "kind": kind,
        "content": content.strip()[:2000],
        "confidence": confidence,
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
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
            return body.get("item", {}).get("id")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # Unknown project — nothing recorded, not a transport failure.
            return None
        logger.warning("Internal memory endpoint returned %s", exc.code)
        raise

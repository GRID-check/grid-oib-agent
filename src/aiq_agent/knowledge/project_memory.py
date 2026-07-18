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
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)


class OrgMemoryDisabledError(RuntimeError):
    """The frontend refused an agent organization-scoped write on purpose.

    Raised when ``POST /api/internal/memory`` returns 403 with the
    ``ORG_MEMORY_DISABLED`` code — i.e. ``GRID_ALLOW_AGENT_ORG_MEMORY`` is not
    enabled on the frontend service (audit finding S1 default-deny). This is a
    deployment-policy denial, NOT a service-token mismatch, so callers surface
    it to the user distinctly instead of retrying.
    """


VALID_KINDS = {"decision", "constraint", "open_question", "derived_fact", "preference"}
VALID_CONFIDENCES = {"low", "medium", "high"}
VALID_SCOPES = {"project", "organization"}

_REQUEST_TIMEOUT_SECONDS = 5
# The digest read runs on the per-turn critical path, right before intent
# classification, so a slow BFF must never stall the turn for the full 5s the
# write calls allow. Keep it tight; on timeout fetch_memory_digest raises and
# the caller falls back to the frozen connection-time digest (fail-open).
_DIGEST_TIMEOUT_SECONDS = 1.5


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


def _error_code(exc: urllib.error.HTTPError) -> str | None:
    """Best-effort ``code`` field from a JSON error envelope, tolerating non-JSON.

    The internal API's error responses are ``{"error": ..., "code": ...}`` (see
    ``lib/api/handler.ts``). Returns the machine-readable code or ``None`` when
    the body is empty, unreadable, or not the expected JSON shape.
    """
    try:
        raw = exc.read()
    except Exception:  # noqa: BLE001 — body may already be consumed / unreadable
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    code = data.get("code")
    return code if isinstance(code, str) else None


VALID_PROVENANCES = {"agent", "distillation"}


def fetch_memory_digest(
    *,
    project_id: str | None,
    organization_id: str | None,
) -> str | None:
    """Fetch the CURRENT core-memory digest via the internal BFF endpoint.

    The digest normally rides the ``x-grid-project-memory`` header set on the WS
    upgrade, but that header is frozen for the connection's life — memory written
    mid-session never reaches the agent until a reconnect. Calling this at the
    start of a turn re-serves the up-to-date digest.

    Returns the digest string, or ``None`` when there is no active memory (a valid
    empty result). Raises RuntimeError on configuration problems and urllib errors
    on transport failures, so the caller can fall back to the frozen header digest
    instead of dropping memory entirely. Blocking; call via ``asyncio.to_thread``.
    """
    if not project_id and not organization_id:
        return None

    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise RuntimeError("GRID_INTERNAL_API_TOKEN is not configured")

    params = {}
    if project_id:
        params["projectId"] = project_id
    if organization_id:
        params["organizationId"] = organization_id
    query = urllib.parse.urlencode(params)

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/memory/digest?{query}",
        headers={"X-Grid-Internal-Token": token},
        method="GET",
    )

    with _opener.open(request, timeout=_DIGEST_TIMEOUT_SECONDS) as response:
        body = json.loads(response.read().decode("utf-8"))
    digest = body.get("digest")
    return digest if isinstance(digest, str) and digest.strip() else None


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
            if _error_code(exc) == "ORG_MEMORY_DISABLED":
                # Expected default-deny (audit finding S1), not a misconfiguration:
                # an agent's service token may not write org-wide memory, so the
                # caller routes the user to the confirmation-card path instead.
                # Logged at INFO (the caller logs the handled outcome); set
                # GRID_ALLOW_AGENT_ORG_MEMORY=true on the frontend to let agents
                # write org-wide directly.
                logger.info(
                    "Internal memory endpoint declined an agent organization-scoped write "
                    "(403 ORG_MEMORY_DISABLED); routing to the user confirmation card"
                )
                raise OrgMemoryDisabledError("agent organization-scoped memory is disabled on the frontend") from exc
            logger.error(
                "Internal memory endpoint rejected the service token (403) — GRID_INTERNAL_API_TOKEN "
                "mismatch between the aiq-agent and frontend services (the same value must be set on both)."
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


def check_internal_api() -> bool:
    """Startup handshake against the internal API health endpoint.

    GETs ``/api/internal/health`` with the service token to make the internal
    write path's health visible AT DEPLOY TIME rather than only when the first
    ``remember`` call fails. Purely diagnostic and NON-FATAL: logs the outcome
    and never raises, so a not-yet-up (or misconfigured) frontend never blocks
    backend startup. Blocking; call via ``asyncio.to_thread`` / a background
    task. Returns ``True`` only on a confirmed 200.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        logger.error(
            "Cannot verify the internal API: GRID_INTERNAL_API_TOKEN is not configured on the "
            "aiq-agent service. The `remember` tool will not be able to write memory."
        )
        return False

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/health",
        headers={"X-Grid-Internal-Token": token},
        method="GET",
    )

    try:
        with _opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            response.read()
        logger.info("internal API reachable, service token accepted")
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            logger.error(
                "Internal API rejected the service token (403) — GRID_INTERNAL_API_TOKEN mismatch "
                "between the aiq-agent and frontend services (the same value must be set on both)."
            )
        elif exc.code == 503:
            logger.error(
                "Internal API disabled (503) — GRID_INTERNAL_API_TOKEN is unset on the frontend, "
                "or is the well-known dev default in a non-dev environment (set APP_ENV=development "
                "on the frontend or configure a real token)."
            )
        else:
            logger.warning("Internal API health check returned %s", exc.code)
        return False
    except (urllib.error.URLError, OSError) as exc:
        # Connection refused / DNS / timeout — the frontend may simply not be up
        # yet at backend startup. Non-fatal; the first `remember` call re-checks.
        logger.warning(
            "Internal API health check could not reach %s (%s) — the frontend may not be up yet.",
            _internal_base_url(),
            exc,
        )
        return False

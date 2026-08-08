"""BIM query client — deterministic read access to a project's IFC models.

Same separation of concerns as :mod:`aiq_agent.knowledge.project_memory`: the
``grid_app`` database has exactly one owner, the Next.js BFF, and the backend
never opens a connection to it. The ``ifc_query`` tool posts to the internal
endpoint ``POST /api/internal/bim/query`` over the compose network,
authenticated with the shared service token (``GRID_INTERNAL_API_TOKEN`` set on
both services).

Why a structured query instead of retrieval: a model question ("how many
external walls on the ground floor", "total net floor area per storey") has an
exact answer that is a SQL aggregate. Retrieving text about the model and
asking a language model to count would turn a fact into a guess. The retrieval
path still exists for the model — an ingested Markdown digest — but it answers
"what is this model of", not "how many".
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

# The query itself is a bounded aggregate over one model's rows; 10s covers a
# cold page cache on a large model without letting a stuck BFF hold the turn.
_REQUEST_TIMEOUT_SECONDS = 10


class BimQueryUnavailableError(RuntimeError):
    """The internal endpoint could not be reached or refused the request.

    Distinct from "the model has no such elements": the tool must tell the user
    it could not look rather than that it looked and found nothing.
    """


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects — a 3xx means an auth middleware intercepted the call.

    Following it would drop the POST body and the service-token header and
    surface a misleading downstream error. Mirrors the project-memory client.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def _service_token() -> str | None:
    return os.environ.get("GRID_INTERNAL_API_TOKEN") or None


def run_bim_query(
    *,
    organization_id: str,
    project_id: str | None,
    query: dict[str, Any],
    model_id: str | None = None,
    model_name: str | None = None,
    compare_with_name: str | None = None,
) -> dict[str, Any]:
    """Execute one structured query against a project's BIM model.

    Returns the endpoint's JSON body verbatim. A body with ``resolved: false``
    is a normal outcome (no model, several models, extraction still running) and
    carries a ``message`` written for the user; the caller reports it rather
    than treating it as a failure.

    :raises BimQueryUnavailableError: transport failure, missing service token,
        or a non-2xx status — i.e. cases where nothing was looked up at all.
    """
    token = _service_token()
    if not token:
        raise BimQueryUnavailableError("GRID_INTERNAL_API_TOKEN is not configured")

    payload: dict[str, Any] = {"organizationId": organization_id, "query": query}
    if project_id:
        payload["projectId"] = project_id
    if model_id:
        payload["modelId"] = model_id
    if model_name:
        payload["modelName"] = model_name
    if compare_with_name:
        payload["compareWithName"] = compare_with_name

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/bim/query",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-grid-internal-token": token,
        },
        method="POST",
    )

    try:
        with _opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        # Never log the body: it can carry element names and property values
        # from a tenant's model. The status is what a reader needs.
        logger.warning("BIM query rejected by the frontend (status=%s)", exc.code)
        raise BimQueryUnavailableError(f"internal BIM endpoint returned {exc.code}") from exc
    except Exception as exc:  # noqa: BLE001 — urllib raises a wide family here
        logger.warning("BIM query could not reach the frontend: %s", type(exc).__name__)
        raise BimQueryUnavailableError("internal BIM endpoint unreachable") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise BimQueryUnavailableError("internal BIM endpoint returned a non-JSON body") from exc
    if not isinstance(parsed, dict):
        raise BimQueryUnavailableError("internal BIM endpoint returned an unexpected body")
    return parsed

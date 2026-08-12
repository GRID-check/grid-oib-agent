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

# Ops that read the WHOLE element set rather than a page, and are therefore
# allowed longer than the default.
#
# Two numbers have to be kept on the right side of each other: the BFF's
# `statement_timeout` is 30s, so a client that gives up sooner abandons a query
# the server is still running — the pool slot stays held, the work still
# completes, and the agent is told "the model could not be read" about a model
# that was being read perfectly well. A ceiling above the server's means the
# server always loses the race and reports the real reason.
_LONG_OPERATIONS = frozenset({"compare", "compliance", "compliance-diff", "schedule", "takeoff", "profile"})
_LONG_TIMEOUT_SECONDS = 35


def _timeout_for(query: dict[str, Any]) -> int:
    """Seconds to wait, by how much of the model the op has to read."""
    return _LONG_TIMEOUT_SECONDS if query.get("op") in _LONG_OPERATIONS else _REQUEST_TIMEOUT_SECONDS


class BimQueryUnavailableError(RuntimeError):
    """The internal endpoint could not be reached or refused the request.

    Distinct from "the model has no such elements": the tool must tell the user
    it could not look rather than that it looked and found nothing.
    """


class BimQueryRejectedError(ValueError):
    """The endpoint understood the request and refused it as malformed.

    Distinct from :class:`BimQueryUnavailableError`, and the distinction is the
    whole point: an unavailable service is nothing the agent can do anything
    about, while a rejected query is a mistake it can correct and retry. Every
    4xx used to be reported as "the model service is unavailable", so a
    `group_by` typo, an invented filter key, or the deliberate "gt/gte/lt/lte
    need a numeric value" message dead-ended the turn — with the agent
    instructed to state nothing about the building, on a correctable slip.
    """


def _issue_summary(details: Any) -> str:
    """`query.filter.filters: Unrecognized key(s) …` for the first few issues.

    The BFF's top-level text for a schema failure is the generic "Invalid
    request body"; everything a caller can act on is in the Zod issue list —
    which key it did not recognise, which operator needs a number.

    Only ``path`` and ``message`` are read, and never ``received``/``input``:
    a message is either Zod's own (naming the key the CALLER invented) or one
    of this schema's four hand-written ones, none of which interpolate a
    value. A value in a property filter is a value out of the tenant's model
    and does not belong in a log line or an agent's context.
    """
    if not isinstance(details, list):
        return ""
    parts: list[str] = []
    for issue in details[:3]:
        if not isinstance(issue, dict):
            continue
        message = issue.get("message")
        if not isinstance(message, str) or not message:
            continue
        path = issue.get("path")
        where = ".".join(str(step) for step in path) if isinstance(path, list) else ""
        parts.append(f"{where}: {message}" if where else message)
    return "; ".join(parts)[:300]


def _rejection_message(exc: urllib.error.HTTPError) -> str:
    """The endpoint's own explanation of why it refused, or a bare status.

    The envelope is ``{error, code, details}`` — see `errorResponse` in
    `lib/api/handler.ts`. It was read as ``message``, a key the BFF has never
    emitted, so every 4xx degraded to the bare status and the whole point of
    :class:`BimQueryRejectedError` was lost: the deliberate, correctable texts
    ("gt/gte/lt/lte need a numeric value", the unrecognised filter key named
    by `.strict()`) reached the agent as "the query was refused (400)".
    """
    try:
        body = json.loads(exc.read().decode("utf-8", errors="replace"))
    except Exception:  # noqa: BLE001 — an unreadable body is just no message
        return f"the query was refused ({exc.code})"
    if not isinstance(body, dict):
        return f"the query was refused ({exc.code})"

    # `message` is accepted as a fallback so this keeps working if the envelope
    # ever grows one; `error` is what it actually carries today.
    headline = body.get("error") or body.get("message")
    headline = headline if isinstance(headline, str) and 0 < len(headline) <= 300 else ""
    issues = _issue_summary(body.get("details"))

    if headline and issues:
        return f"{headline} — {issues}"
    return headline or issues or f"the query was refused ({exc.code})"


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
        with _opener.open(request, timeout=_timeout_for(query)) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        # Never log the body: it can carry element names and property values
        # from a tenant's model. The status is what a reader needs.
        logger.warning("BIM query rejected by the frontend (status=%s)", exc.code)
        if 400 <= exc.code < 500 and exc.code not in (401, 403, 429):
            # The endpoint understood the request and refused it. Its message
            # was written for a caller who can fix the arguments, so it is the
            # one part of the body worth reading — and it describes the
            # REQUEST, never the tenant's model.
            raise BimQueryRejectedError(_rejection_message(exc)) from exc
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

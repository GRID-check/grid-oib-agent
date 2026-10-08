"""Typed client of the BFF's authenticated per-turn prompt-context API.

Requester identity comes only from the original signed capsule, echoed without
re-signing. An unavailable or refused context is an error, not an empty brief:
answering without the office's current instructions would silently drop policy.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass

from aiq_agent.project_context import MEMORY_HEADER_MAX_CHARS
from aiq_agent.project_context import GridRequestContext
from aiq_agent.project_context import normalize_org_instructions
from aiq_agent.project_context import normalize_project_context

INTERNAL_TURN_CONTEXT_PATH = "/api/internal/turn-context"
REQUEST_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class ContextBlocks:
    """The three prompt blocks, independently nullable and bounded at intake."""

    project_context: str | None
    project_memory: str | None
    org_instructions: str | None


class TurnContextError(RuntimeError):
    """Required context could not be loaded; the turn must not answer without it."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Do not forward requester credentials to a redirect destination."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, "unexpected turn-context redirect", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def _nullable_text(data: dict[str, object], field: str) -> str | None:
    if field not in data:
        raise TurnContextError(f"the turn-context API omitted {field}")
    value = data[field]
    if value is not None and not isinstance(value, str):
        raise TurnContextError(f"the turn-context API returned an invalid {field}")
    return value


def _parse_blocks(body: object) -> ContextBlocks:
    if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
        raise TurnContextError("the turn-context API returned an invalid data envelope")
    data = body["data"]
    return ContextBlocks(
        project_context=normalize_project_context(_nullable_text(data, "projectContext")),
        project_memory=normalize_project_context(
            _nullable_text(data, "projectMemory"), max_chars=MEMORY_HEADER_MAX_CHARS
        ),
        org_instructions=normalize_org_instructions(_nullable_text(data, "orgInstructions")),
    )


def fetch_turn_context(request: GridRequestContext, *, query: str | None = None) -> ContextBlocks:
    """Read fresh context for this signed requester. Blocking; use ``to_thread``."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise TurnContextError("GRID_INTERNAL_API_TOKEN is not configured for turn context")
    if not request.envelope_header or not request.envelope_signature:
        raise TurnContextError("signed requester credentials are required for turn context")
    payload: dict[str, str] = {}
    if query and query.strip():
        payload["query"] = query.strip()[:2000]
    http_request = urllib.request.Request(
        f"{_internal_base_url()}{INTERNAL_TURN_CONTEXT_PATH}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Grid-Internal-Token": token,
            "X-Grid-Request-Context": request.envelope_header,
            "X-Grid-Request-Context-Sig": request.envelope_signature,
        },
        method="POST",
    )
    try:
        with _opener.open(http_request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if not 200 <= response.status < 300:
                raise TurnContextError("the turn-context API refused the call", status=response.status)
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise TurnContextError(f"the turn-context API refused the call ({exc.code})", status=exc.code) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise TurnContextError("the turn-context API could not be reached") from exc
    except (ValueError, UnicodeDecodeError) as exc:
        raise TurnContextError("the turn-context API returned malformed JSON") from exc
    return _parse_blocks(body)

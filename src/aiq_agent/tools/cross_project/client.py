"""The cross-project lookups' client: ``POST /api/internal/cross-project/{search,projects,brief}``.

Nothing here decides access. The BFF reads the acting person out of the signed
request-context envelope this module forwards byte-for-byte, builds that
person's pinned session, decides which projects and folders are in reach,
records what it hands out on the conversation, and refuses a conversation that
is not its asker's alone (ADR-0054 §4, ADR-0055, ADR-0085). Echo, never sign:
see ``src/aiq_agent/tools/AGENTS.md``.

The request bodies are described once, in zod (``frontends/ui/src/lib/cross-project/types.ts``),
and exported as JSON Schema (``frontends/ui/tests/fixtures/cross-project.schema.json``);
``tests/aiq_agent/tools/cross_project/test_wire_contract.py`` validates the
bodies this tool builds against that file. There is no Pydantic twin.
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

SEARCH_PATH = "/api/internal/cross-project/search"
PROJECTS_PATH = "/api/internal/cross-project/projects"
BRIEF_PATH = "/api/internal/cross-project/brief"

#: A search fans out over up to eight projects on the BFF, four at a time, each
#: a vector search and a reconciliation read. Generous, so a slow page is an
#: answer rather than a timeout the model retries into a second fan-out.
REQUEST_TIMEOUT_SECONDS = 30


class CrossProjectLookupError(RuntimeError):
    """The route refused, or could not be reached. ``status`` and ``code`` say which."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects: a 3xx means an auth middleware intercepted the call."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def _error_body(exc: urllib.error.HTTPError) -> dict[str, Any]:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - the body may be empty, unreadable or not JSON
        return {}
    return payload if isinstance(payload, dict) else {}


def post_lookup(path: str, payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """POST one lookup and return the parsed body. Blocking; call through ``asyncio.to_thread``.

    Raises :class:`CrossProjectLookupError` for every refusal and transport failure, with
    the BFF's ``error`` sentence when it sent one: the refusals the reader must
    hear (a shared chat) are worded there, in German.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise CrossProjectLookupError("GRID_INTERNAL_API_TOKEN is not configured")
    request = urllib.request.Request(
        f"{_internal_base_url()}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Grid-Internal-Token": token,
            # Who this is, forwarded exactly as the BFF minted it for the turn.
            "X-Grid-Request-Context": envelope.header,
            "X-Grid-Request-Context-Sig": envelope.signature,
        },
        method="POST",
    )
    try:
        with _opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        error = _error_body(exc)
        detail = error.get("error")
        code = error.get("code")
        raise CrossProjectLookupError(
            detail if isinstance(detail, str) and detail.strip() else f"the lookup was refused ({exc.code})",
            status=exc.code,
            code=code if isinstance(code, str) else None,
        ) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        logger.warning("Cross-project lookup %s failed", path, exc_info=True)
        raise CrossProjectLookupError("the lookup could not be reached") from exc
    if not isinstance(body, dict):
        raise CrossProjectLookupError("the lookup answered with something that is not an object")
    return body

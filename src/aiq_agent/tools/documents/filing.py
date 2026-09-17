"""Filing a draft into the project: the one call this tier makes to the lifecycle API.

``POST /api/internal/document-versions``, ops ``create``, ``update`` and
``submit``. Nothing here writes a row: the BFF is the single writer of
``grid_app`` (ADR-0003) and this module is a CLIENT of the route the browser's
own filing goes through (ADR-0055).

Beside the write door, the READ one:
``GET /api/internal/document-versions/<id>/content`` hands back one version's
text plus the four facts a filing record is made of. It is the same lifecycle
API and therefore the same client, and it carries NO envelope, because it acts
as nobody — see :func:`get_document_version_content`.

## The tool echoes the envelope; it never signs one

The route carries a static service token and no user, and the agent's principal
is wider than any human's. So the acting identity does not come from anything
this process chooses: it comes from the **signed request-context envelope** the
BFF minted at the start of the turn, forwarded here byte-for-byte
(``GridRequestContext.envelope_header`` / ``envelope_signature``), verified there
with the same secret, and turned into that person's pinned session
(ADR-0054 §4). Every permission check, every ``created_by`` and every audit actor
downstream is the human who asked.

Re-signing a payload of our own with ``GRID_INTERNAL_API_TOKEN`` would work, and
that is the point: it would let this tier CHOOSE the user id, with a secret that
authenticates the service. The rule is therefore stated as a rule and not as an
implementation detail — **echo, never sign** — and
``tests/aiq_agent/tools/documents/test_filing.py`` asserts the bytes go out
unchanged.

## Why `_internal_base_url` is a sixth copy

Five modules already read ``FRONTEND_INTERNAL_URL``/``FRONTEND_URL`` into a base
URL exactly like this (``knowledge/project_memory.py``, ``common/profiler.py``,
``stages/flags.py`` and two more). Lifting it into ``common/`` is the right
change and is not this one: four of the five live under ``knowledge/``, which
this change may not touch, and a helper lifted for half its callers is a fork
with a shared name. Written down here so the next person doing the lift finds
the sixth copy rather than five.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: The one route. Its op set is closed (`create`, `update`, `submit`) on the BFF
#: side, derived there from the transition table's `actor` field — approve,
#: request changes, reject, publish and archive have no machine path at all.
INTERNAL_DOCUMENT_VERSIONS_PATH = "/api/internal/document-versions"

#: The READ side, and a different door: one version's bytes, by version id.
#:
#: No envelope, because nothing here acts as a person — the route writes nothing
#: and the organization is the whole of its predicate, exactly as
#: ``/api/internal/document-file`` works for a document's storage key. It lives
#: in this module rather than a seventh copy of the base-URL read, and beside
#: the write door so the two halves of the lifecycle client are one file.
INTERNAL_DOCUMENT_VERSION_CONTENT_PATH = "/api/internal/document-versions/{version_id}/content"

#: Ceiling for the read. Shorter than the filing timeout because this one is on
#: the TIME-TO-FIRST-BYTE path: it runs in the turn's setup gather, before the
#: graph starts, and a subject that cannot be fetched costs the model one
#: document rather than the answer. Five seconds is generous for one object
#: fetch and short enough that an unreachable BFF does not become a hung chat.
CONTENT_TIMEOUT_SECONDS = 5

#: Generous next to a memory write and deliberately so: filing renders Markdown,
#: admits a quota, writes an object to SeaweedFS and opens a version row. A turn
#: that gave up at five seconds would leave the reader with a draft that may or
#: may not have been filed, which is the one outcome worse than a refusal.
REQUEST_TIMEOUT_SECONDS = 15


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse to follow redirects.

    The internal endpoint never redirects; a 3xx means an auth middleware
    intercepted the call (AuthKit sending us to a sign-in page). Following it
    would drop the POST body, the envelope and the service token, and surface a
    misleading downstream error — so fail fast with the original status.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


class FilingError(RuntimeError):
    """The route refused, or could not be reached. Carries what the model may be told."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class SignedEnvelope:
    """The envelope as received. Both halves, or this is not one."""

    header: str
    signature: str


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


def get_document_version_content(version_id: str, organization_id: str, conversation_id: str) -> dict[str, Any]:
    """One version's text and identity from the internal read route.

    Returns the parsed body: ``content`` plus the facts the caller has to stamp
    onto the working-directory file it writes — ``documentId``, ``versionId``,
    ``state`` and ``contentHash`` — so a later ``file_draft`` on that path
    REPLACES this open version instead of filing a second document.

    **Both scopes travel, and neither is optional.** ``organizationId`` is the
    tenant boundary; ``conversationId`` is the narrower one the BFF now requires,
    and it refuses unless the version is that conversation's SUBJECT. A version
    id is the only thing a client chooses, so without the second predicate the
    route would read any version in the tenant on the say-so of an id — the
    conversation is what says the reader was already looking at this document.
    A version that is not this conversation's subject comes back ``404``, which
    the caller reads as "no subject to load".

    Raises :class:`FilingError` for every refusal and every transport failure,
    the same one thing every caller in this module has to catch. Blocking — call
    it through ``asyncio.to_thread``.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise FilingError("GRID_INTERNAL_API_TOKEN is not configured")

    path = INTERNAL_DOCUMENT_VERSION_CONTENT_PATH.format(version_id=urllib.parse.quote(version_id, safe=""))
    query = urllib.parse.urlencode({"organizationId": organization_id, "conversationId": conversation_id})
    request = urllib.request.Request(
        f"{_internal_base_url()}{path}?{query}",
        headers={"X-Grid-Internal-Token": token},
        method="GET",
    )

    try:
        with _opener.open(request, timeout=CONTENT_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        code = _error_code(exc)
        logger.warning("Version content refused by the BFF (status=%s code=%s)", exc.code, code)
        raise FilingError(f"the document API refused the read ({exc.code})", status=exc.code, code=code) from exc
    except Exception as exc:  # noqa: BLE001 - transport; the caller decides what to do about it
        logger.warning("Version content could not be read from the BFF", exc_info=True)
        raise FilingError("the document API could not be reached") from exc

    if not isinstance(body, dict):
        raise FilingError("the document API answered with something that is not an object")
    return body


def post_document_version(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """One call to the internal document-versions route; the parsed JSON body.

    Raises :class:`FilingError` for every refusal and every transport failure, so
    the tool has exactly one thing to catch. Blocking — call it through
    ``asyncio.to_thread``.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise FilingError("GRID_INTERNAL_API_TOKEN is not configured")

    request = urllib.request.Request(
        f"{_internal_base_url()}{INTERNAL_DOCUMENT_VERSIONS_PATH}",
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
        logger.warning("Filing refused by the BFF (status=%s code=%s)", exc.code, code)
        raise FilingError(f"the document API refused the call ({exc.code})", status=exc.code, code=code) from exc
    except Exception as exc:  # noqa: BLE001 - transport; the tool words it for the model
        logger.warning("Filing could not reach the BFF", exc_info=True)
        raise FilingError("the document API could not be reached") from exc

    if not isinstance(body, dict):
        raise FilingError("the document API answered with something that is not an object")
    return body

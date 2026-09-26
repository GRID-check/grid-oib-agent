"""Enforcement for the consolidated, signed ``X-Grid-Request-Context`` envelope.

User-mandated requirement (2026-07-16): a workflow-invoking request from a
WorkOS-authenticated user MUST carry the consolidated context envelope —
without it we cannot verify who the user is, which organization they belong
to, and what model overrides the organization has configured, so the request
is not valid. This module is the FAIL-CLOSED enforcement point for that rule.

Design
------
``GridContextEnvelopeMiddleware`` is a raw ASGI middleware, following the
same pattern as ``aiq_api.auth.middleware.AuthMiddleware`` (not Starlette's
``BaseHTTPMiddleware``, which buffers the response body and breaks SSE
streaming — several routes here stream). It is registered in
``plugin.py::AIQAPIWorker.build_app`` and must be added to the app BEFORE
``AuthMiddleware`` is added: Starlette's ``add_middleware`` inserts each
middleware as the new OUTERMOST layer, so whichever is added *last* runs
*first* on the way in. Adding this middleware first (so ``AuthMiddleware`` is
added after, becoming the outer layer) means ``AuthMiddleware`` always
resolves ``scope["state"]["user"]`` before this middleware reads it for HTTP
requests.

For WebSocket upgrades, ``AuthMiddleware`` deliberately no-ops (see its
module docstring) — the real handshake auth lives in
``aiq_api.websocket_reconnect.authenticate_websocket_connection``, which this
module does not import or modify (it is not owned by this change). Instead,
for the ``/websocket`` path this middleware independently re-runs the same
``resolve_request_user`` classification the WS handshake will *also* run,
purely to decide whether an authenticated JWT caller is present and must
therefore carry the envelope — it never itself validates token *authenticity*
beyond that classification, so no auth behavior changes; a request that fails
this check today would also have failed (or been treated as internal by) the
downstream handshake.

Enforcement matrix
-------------------
Enforcement (403 / WS policy-violation close) applies only when ALL of:

1. ``REQUIRE_AUTH=true`` (the same flag ``AuthMiddleware``/``plugin.py`` read);
2. the resolved caller is a WorkOS-authenticated user (``user["type"] ==
   "jwt"``, set by ``JWTValidator.validate`` — see ``auth/jwt_validator.py``);
3. the request path matches one of the conservative, explicitly enumerated
   ``ENFORCED_*_PATH_PREFIXES`` below (chat WS upgrade, async job submit,
   the internal workflow-submit route, and NAT's ``/generate`` endpoint —
   easily extended by adding a prefix, nothing else to wire up);
4. no valid envelope is present (see ``GridRequestContext.from_envelope``
   in ``aiq_agent.project_context`` — the single verify function this module
   calls, shared with the runtime ``from_context()`` parse path).

EXEMPT (enforcement never applies), regardless of path:

- anonymous mode (``REQUIRE_AUTH=false``);
- internal-token-authenticated service calls — either because
  ``AuthMiddleware`` already classified the caller as ``"internal"``/
  ``"unverified_jwt"`` (not ``"jwt"``), or because the request explicitly
  carries a valid ``x-internal-token``/``x-grid-internal-token`` matching
  ``GRID_INTERNAL_API_TOKEN`` (the two internal-auth header names used
  elsewhere in this codebase — ``routes/internal_auth.py`` and
  ``routes/config_info.py`` respectively);
- health checks and every other non-enumerated path (the enforced-path list
  is an allowlist, not a denylist — nothing is enforced unless explicitly
  added to it).

Fail-open note (dev): when ``GRID_INTERNAL_API_TOKEN`` is unset,
``GridRequestContext.from_envelope`` skips HMAC verification but still
requires the envelope header to be present and well-formed — so local dev
without the token configured still exercises the "did every producer
remember to attach the envelope" contract, just without the integrity check
that requires a shared secret to perform.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
from typing import Any

from starlette.types import ASGIApp
from starlette.types import Receive
from starlette.types import Scope
from starlette.types import Send

from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from aiq_agent.project_context import GridRequestContext

from .auth.middleware import _load_external_hostnames
from .auth.middleware import resolve_request_user

logger = logging.getLogger(__name__)

# Conservative, explicitly enumerated allowlist of workflow-invoking paths.
# Extend by adding a prefix here — nothing else needs to change. A path
# matches a prefix on an exact match or a "/"-bounded sub-path, mirroring
# AuthMiddleware._path_allowed's semantics for the "/" -suffixed entries.
ENFORCED_HTTP_PATH_PREFIXES: tuple[str, ...] = (
    "/v1/jobs/async/submit",
    "/v1/internal/skills/submit",
    "/generate",
)
ENFORCED_WEBSOCKET_PATH_PREFIXES: tuple[str, ...] = ("/websocket",)

# Same status code aiq_api.websocket_reconnect uses for a rejected handshake
# (WS_POLICY_VIOLATION) — duplicated as a literal rather than imported so
# this module never needs to import (and thus never risks coupling to
# internal state in) websocket_reconnect.py, which this change does not own.
_WS_POLICY_VIOLATION = 1008

_INTERNAL_TOKEN_HEADER_NAMES: tuple[bytes, ...] = (b"x-internal-token", b"x-grid-internal-token")


def _path_is_enforced(path: str, prefixes: tuple[str, ...]) -> bool:
    for prefix in prefixes:
        if path == prefix or path.startswith(f"{prefix}/"):
            return True
    return False


def _header(headers: dict[bytes, bytes], name: str) -> str | None:
    raw = headers.get(name.encode("ascii"))
    if raw is None:
        return None
    return raw.decode("utf-8", errors="replace")


def _is_internal_token_call(headers: dict[bytes, bytes]) -> bool:
    """True when the request carries a valid internal-service token.

    Checked independently of ``AuthMiddleware``'s caller classification so
    this exemption holds even in configurations where a service call happens
    to also present a bearer token that resolves to ``type != "internal"``.
    """
    secret = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not secret:
        return False
    for name in _INTERNAL_TOKEN_HEADER_NAMES:
        provided = headers.get(name)
        if provided is not None and hmac.compare_digest(provided.decode("utf-8", errors="replace"), secret):
            return True
    return False


def _has_valid_envelope(headers: dict[bytes, bytes]) -> bool:
    envelope = _header(headers, REQUEST_CONTEXT_ENVELOPE_HEADER)
    sig = _header(headers, REQUEST_CONTEXT_ENVELOPE_SIG_HEADER)
    secret = os.environ.get("GRID_INTERNAL_API_TOKEN")
    return GridRequestContext.from_envelope(envelope, sig, secret) is not None


class GridContextEnvelopeMiddleware:
    """Fail-closed enforcement of the signed context envelope (see module docstring).

    Args:
        app: The inner ASGI application.
        require_auth: Mirrors ``AuthMiddleware``'s ``REQUIRE_AUTH`` flag — when
            ``False`` (anonymous-mode deployments), enforcement never applies.
        validators: Same validator chain passed to ``AuthMiddleware``, needed
            here only to independently classify WebSocket callers (see module
            docstring) since ``AuthMiddleware`` skips WS scopes entirely.
        external_hostnames: Same set ``AuthMiddleware`` uses to decide which
            requests are "external"; defaults to the ``AIQ_EXTERNAL_HOSTNAMES``
            env var like ``AuthMiddleware`` does.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        require_auth: bool = False,
        validators: list | None = None,
        external_hostnames: set[str] | None = None,
        enforced_http_path_prefixes: tuple[str, ...] = ENFORCED_HTTP_PATH_PREFIXES,
        enforced_websocket_path_prefixes: tuple[str, ...] = ENFORCED_WEBSOCKET_PATH_PREFIXES,
    ) -> None:
        self.app = app
        self._require_auth = require_auth
        self._validators: list = validators or []
        self._external_hostnames: set[str] = (
            external_hostnames if external_hostnames is not None else _load_external_hostnames()
        )
        self._enforced_http = tuple(enforced_http_path_prefixes)
        self._enforced_websocket = tuple(enforced_websocket_path_prefixes)
        logger.info(
            "GridContextEnvelopeMiddleware: require_auth=%s enforced_http=%s enforced_websocket=%s",
            require_auth,
            self._enforced_http,
            self._enforced_websocket,
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope_type = scope.get("type")
        if scope_type not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        if not self._require_auth:
            # Anonymous-mode deployments never have a WorkOS-authenticated
            # caller to enforce against — same gate AuthMiddleware itself
            # uses to decide whether token validation applies at all.
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")
        prefixes = self._enforced_http if scope_type == "http" else self._enforced_websocket
        if not _path_is_enforced(path, prefixes):
            await self.app(scope, receive, send)
            return

        headers: dict[bytes, bytes] = dict(scope.get("headers") or [])

        if scope_type == "http":
            state = scope.get("state") or {}
            user: dict[str, Any] = state.get("user") or {}
        else:
            # AuthMiddleware never sees websocket scopes; reclassify
            # independently here (see module docstring) purely to decide
            # whether enforcement applies. This never accepts or rejects the
            # connection on auth grounds itself — only on envelope presence.
            user, _status, _is_external, _err = await resolve_request_user(
                headers,
                validators=self._validators,
                require_auth=self._require_auth,
                external_hostnames=self._external_hostnames,
            )
            user = user or {}

        if user.get("type") != "jwt":
            # Not a WorkOS-authenticated caller (anonymous / internal /
            # unverified bearer) — exempt regardless of internal-token
            # presence.
            await self.app(scope, receive, send)
            return

        if _is_internal_token_call(headers):
            await self.app(scope, receive, send)
            return

        if _has_valid_envelope(headers):
            await self.app(scope, receive, send)
            return

        logger.warning(
            "Rejecting %s %s: authenticated request missing a valid X-Grid-Request-Context envelope",
            scope_type,
            path,
        )
        await self._reject(scope_type, receive, send)

    @staticmethod
    async def _reject(scope_type: str, receive: Receive, send: Send) -> None:
        if scope_type == "http":
            payload = json.dumps(
                {
                    "detail": "missing or invalid X-Grid-Request-Context envelope",
                    "error": "context_envelope_required",
                }
            ).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 403,
                    "headers": [
                        [b"content-type", b"application/json"],
                        [b"content-length", str(len(payload)).encode()],
                    ],
                }
            )
            await send({"type": "http.response.body", "body": payload})
            return

        # WebSocket: the ASGI spec requires consuming the 'websocket.connect'
        # event before responding; some servers reject an immediate close
        # otherwise. The handshake is never accepted.
        message = await receive()
        if message.get("type") == "websocket.connect":
            await send({"type": "websocket.close", "code": _WS_POLICY_VIOLATION})
        else:  # pragma: no cover - defensive; ASGI servers always send connect first
            await send({"type": "websocket.close", "code": _WS_POLICY_VIOLATION})

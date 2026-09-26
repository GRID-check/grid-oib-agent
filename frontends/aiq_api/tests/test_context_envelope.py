"""Tests for aiq_api.context_envelope (signed X-Grid-Request-Context envelope enforcement).

Follows the same raw-ASGI-middleware testing pattern as test_auth.py
(TestAuthMiddleware*): call the middleware's __call__ directly with a
hand-built ASGI scope and record what it sends, rather than going through a
full FastAPI TestClient — this middleware, like AuthMiddleware, never
buffers a response body and is trivially exercised without HTTP plumbing.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from unittest.mock import AsyncMock

import pytest

from aiq_api.context_envelope import ENFORCED_HTTP_PATH_PREFIXES
from aiq_api.context_envelope import ENFORCED_WEBSOCKET_PATH_PREFIXES
from aiq_api.context_envelope import GridContextEnvelopeMiddleware
from aiq_api.context_envelope import _path_is_enforced

SECRET = "envelope-test-secret"  # noqa: S105 - test fixture value, not a real credential


def _sign(raw_json: str, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), raw_json.encode("utf-8"), hashlib.sha256).hexdigest()


def _envelope_headers(payload: dict, secret: str | None = SECRET) -> list[tuple[bytes, bytes]]:
    raw = json.dumps(payload)
    header = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")
    headers = [(b"x-grid-request-context", header.encode())]
    if secret:
        headers.append((b"x-grid-request-context-sig", _sign(raw, secret).encode()))
    return headers


def _http_scope(
    path: str,
    *,
    user: dict | None = None,
    extra_headers: list[tuple[bytes, bytes]] | None = None,
) -> dict:
    headers: list[tuple[bytes, bytes]] = [(b"host", b"internal.local")]
    if extra_headers:
        headers.extend(extra_headers)
    return {
        "type": "http",
        "path": path,
        "headers": headers,
        "state": {"user": user or {}},
    }


def _ws_scope(path: str, *, extra_headers: list[tuple[bytes, bytes]] | None = None) -> dict:
    headers: list[tuple[bytes, bytes]] = [(b"host", b"internal.local")]
    if extra_headers:
        headers.extend(extra_headers)
    return {"type": "websocket", "path": path, "headers": headers}


@pytest.fixture
def capture_asgi():
    calls: list[str] = []

    async def app(scope, receive, send):
        calls.append(scope["path"])

    return app, calls


@pytest.fixture(autouse=True)
def _clear_internal_token(monkeypatch):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)


class TestPathMatching:
    def test_exact_match(self):
        assert _path_is_enforced("/v1/jobs/async/submit", ENFORCED_HTTP_PATH_PREFIXES)

    def test_sub_path_match(self):
        assert _path_is_enforced("/generate/stream", ENFORCED_HTTP_PATH_PREFIXES)

    def test_unrelated_path_not_prefix_polluted(self):
        # "/generate-report" must NOT match the "/generate" prefix.
        assert not _path_is_enforced("/generate-report", ENFORCED_HTTP_PATH_PREFIXES)

    def test_websocket_prefix(self):
        assert _path_is_enforced("/websocket", ENFORCED_WEBSOCKET_PATH_PREFIXES)

    def test_non_enforced_path(self):
        assert not _path_is_enforced("/v1/admin/oib/sync", ENFORCED_HTTP_PATH_PREFIXES)


class TestDisabledWhenAuthNotRequired:
    @pytest.mark.asyncio
    async def test_passes_through_when_require_auth_false(self, capture_asgi):
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=False)
        scope = _http_scope("/v1/jobs/async/submit", user={"type": "jwt"})

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/v1/jobs/async/submit"]


class TestNonEnforcedPaths:
    @pytest.mark.asyncio
    async def test_passes_through_unenforced_http_path(self, capture_asgi):
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        scope = _http_scope("/v1/admin/oib/sync", user={"type": "jwt"})

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/v1/admin/oib/sync"]

    @pytest.mark.asyncio
    async def test_lifespan_scope_reaches_inner_app(self):
        calls: list[str] = []

        async def app(scope, receive, send):
            calls.append(scope["type"])

        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        await mw({"type": "lifespan"}, AsyncMock(), AsyncMock())

        assert calls == ["lifespan"]


class TestExemptions:
    @pytest.mark.asyncio
    async def test_anonymous_caller_exempt(self, capture_asgi):
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        scope = _http_scope("/v1/jobs/async/submit", user={"type": "anonymous"})

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/v1/jobs/async/submit"]

    @pytest.mark.asyncio
    async def test_internal_caller_exempt(self, capture_asgi):
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        scope = _http_scope("/v1/internal/skills/submit", user={"type": "internal"})

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/v1/internal/skills/submit"]

    @pytest.mark.asyncio
    async def test_unverified_jwt_caller_exempt(self, capture_asgi):
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        scope = _http_scope("/v1/jobs/async/submit", user={"type": "unverified_jwt"})

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/v1/jobs/async/submit"]

    @pytest.mark.asyncio
    async def test_valid_internal_token_call_exempt_even_with_jwt_type(self, monkeypatch, capture_asgi):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "internal-secret")
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        scope = _http_scope(
            "/v1/jobs/async/submit",
            user={"type": "jwt"},
            extra_headers=[(b"x-internal-token", b"internal-secret")],
        )

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/v1/jobs/async/submit"]

    @pytest.mark.asyncio
    async def test_grid_internal_token_header_name_also_exempts(self, monkeypatch, capture_asgi):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "internal-secret")
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        scope = _http_scope(
            "/v1/jobs/async/submit",
            user={"type": "jwt"},
            extra_headers=[(b"x-grid-internal-token", b"internal-secret")],
        )

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/v1/jobs/async/submit"]

    @pytest.mark.asyncio
    async def test_wrong_internal_token_does_not_exempt(self, monkeypatch, capture_asgi):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "internal-secret")
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        messages: list[dict] = []

        async def send(msg):
            messages.append(msg)

        scope = _http_scope(
            "/v1/jobs/async/submit",
            user={"type": "jwt"},
            extra_headers=[(b"x-internal-token", b"wrong-token")],
        )

        await mw(scope, AsyncMock(), send)

        assert calls == []
        assert messages[0]["status"] == 403


class TestHttpEnforcement:
    @pytest.mark.asyncio
    async def test_authenticated_jwt_without_envelope_rejected_403(self, capture_asgi):
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        messages: list[dict] = []

        async def send(msg):
            messages.append(msg)

        scope = _http_scope("/v1/jobs/async/submit", user={"type": "jwt", "sub": "user-1"})

        await mw(scope, AsyncMock(), send)

        assert calls == []
        assert messages[0]["type"] == "http.response.start"
        assert messages[0]["status"] == 403
        body = json.loads(messages[1]["body"].decode())
        assert body["error"] == "context_envelope_required"
        assert body["detail"] == "missing or invalid X-Grid-Request-Context envelope"

    @pytest.mark.asyncio
    async def test_authenticated_jwt_with_valid_envelope_allowed(self, monkeypatch, capture_asgi):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", SECRET)
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)

        scope = _http_scope(
            "/v1/jobs/async/submit",
            user={"type": "jwt", "sub": "user-1"},
            extra_headers=_envelope_headers({"organizationId": "org_1"}),
        )

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/v1/jobs/async/submit"]

    @pytest.mark.asyncio
    async def test_authenticated_jwt_with_tampered_envelope_rejected(self, monkeypatch, capture_asgi):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", SECRET)
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        messages: list[dict] = []

        async def send(msg):
            messages.append(msg)

        headers = _envelope_headers({"organizationId": "org_1"})
        # Tamper the signature (last header appended by _envelope_headers).
        name, sig = headers[-1]
        tampered = (b"0" if sig[:1] != b"0" else b"1") + sig[1:]
        headers[-1] = (name, tampered)

        scope = _http_scope("/v1/jobs/async/submit", user={"type": "jwt"}, extra_headers=headers)

        await mw(scope, AsyncMock(), send)

        assert calls == []
        assert messages[0]["status"] == 403

    @pytest.mark.asyncio
    async def test_dev_mode_no_secret_still_requires_envelope_presence(self, capture_asgi):
        # GRID_INTERNAL_API_TOKEN unset (autouse fixture clears it): signature
        # verification is skipped, but presence is still enforced.
        assert not os.environ.get("GRID_INTERNAL_API_TOKEN")
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        messages: list[dict] = []

        async def send(msg):
            messages.append(msg)

        scope = _http_scope("/v1/jobs/async/submit", user={"type": "jwt"})
        await mw(scope, AsyncMock(), send)

        assert calls == []
        assert messages[0]["status"] == 403

    @pytest.mark.asyncio
    async def test_dev_mode_no_secret_accepts_unsigned_envelope(self, capture_asgi):
        assert not os.environ.get("GRID_INTERNAL_API_TOKEN")
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)

        scope = _http_scope(
            "/v1/jobs/async/submit",
            user={"type": "jwt"},
            extra_headers=_envelope_headers({"organizationId": "org_1"}, secret=None),
        )

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/v1/jobs/async/submit"]


class TestWebSocketEnforcement:
    @pytest.mark.asyncio
    async def test_jwt_caller_without_envelope_closes_with_policy_violation(self, monkeypatch, capture_asgi):
        from unittest.mock import AsyncMock as AM
        from unittest.mock import MagicMock

        app, calls = capture_asgi
        mock_v = MagicMock()
        mock_v.can_handle.return_value = True
        mock_v.validate = AM(return_value=({"type": "jwt", "sub": "user-1"}, None))
        mw = GridContextEnvelopeMiddleware(app, require_auth=True, validators=[mock_v])

        async def receive():
            return {"type": "websocket.connect"}

        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)

        scope = _ws_scope("/websocket", extra_headers=[(b"authorization", b"Bearer good")])

        await mw(scope, receive, send)

        assert calls == []
        assert sent == [{"type": "websocket.close", "code": 1008}]

    @pytest.mark.asyncio
    async def test_jwt_caller_with_valid_envelope_passes_through(self, monkeypatch, capture_asgi):
        from unittest.mock import AsyncMock as AM
        from unittest.mock import MagicMock

        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", SECRET)
        app, calls = capture_asgi
        mock_v = MagicMock()
        mock_v.can_handle.return_value = True
        mock_v.validate = AM(return_value=({"type": "jwt", "sub": "user-1"}, None))
        mw = GridContextEnvelopeMiddleware(app, require_auth=True, validators=[mock_v])

        headers = [(b"authorization", b"Bearer good"), *_envelope_headers({"organizationId": "org_1"})]
        scope = _ws_scope("/websocket", extra_headers=headers)

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/websocket"]

    @pytest.mark.asyncio
    async def test_non_jwt_websocket_caller_exempt(self, capture_asgi):
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True, validators=[])
        scope = _ws_scope("/websocket")

        await mw(scope, AsyncMock(), AsyncMock())

        # No auth header -> detect_internal_caller() -> type "internal" -> exempt.
        assert calls == ["/websocket"]

    @pytest.mark.asyncio
    async def test_non_enforced_websocket_path_passes_through(self, capture_asgi):
        app, calls = capture_asgi
        mw = GridContextEnvelopeMiddleware(app, require_auth=True)
        scope = _ws_scope("/some/other/ws/path")

        await mw(scope, AsyncMock(), AsyncMock())

        assert calls == ["/some/other/ws/path"]

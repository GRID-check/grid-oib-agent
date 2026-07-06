"""Security tests for the internal maintenance-endpoint token guard.

`_require_internal_token` protects destructive purge endpoints called only by
the purger service. It must fail closed (unset/missing/wrong token, or the
well-known dev default outside a dev environment) and compare the token in
constant time.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from aiq_api.routes.maintenance import _DEV_DEFAULT_TOKEN
from aiq_api.routes.maintenance import _require_internal_token


class _Req:
    """Minimal stand-in exposing only `.headers.get`, as the guard uses."""

    def __init__(self, token: str | None) -> None:
        self.headers = {} if token is None else {"x-internal-token": token}


def test_rejects_when_token_env_unset(monkeypatch):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    with pytest.raises(HTTPException) as exc:
        _require_internal_token(_Req("anything"))
    assert exc.value.status_code == 403


def test_rejects_dev_default_outside_dev(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", _DEV_DEFAULT_TOKEN)
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(HTTPException) as exc:
        _require_internal_token(_Req(_DEV_DEFAULT_TOKEN))
    assert exc.value.status_code == 503


def test_rejects_wrong_header(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "real-secret")
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(HTTPException) as exc:
        _require_internal_token(_Req("wrong"))
    assert exc.value.status_code == 403


def test_rejects_missing_header(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "real-secret")
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(HTTPException) as exc:
        _require_internal_token(_Req(None))
    assert exc.value.status_code == 403


def test_accepts_correct_token(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "real-secret")
    monkeypatch.setenv("APP_ENV", "production")
    # Must not raise.
    _require_internal_token(_Req("real-secret"))


def test_accepts_dev_default_in_dev(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", _DEV_DEFAULT_TOKEN)
    monkeypatch.setenv("APP_ENV", "development")
    _require_internal_token(_Req(_DEV_DEFAULT_TOKEN))

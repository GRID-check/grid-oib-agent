"""Tests for insert_memory_item and check_internal_api error handling.

Reuses the fake-opener harness pattern from test_project_memory_digest.py so
the internal HTTP calls can be driven without a real frontend.
"""

import contextlib
import io
import json
import logging
import urllib.error

import pytest

from aiq_agent.knowledge import project_memory as pm


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@contextlib.contextmanager
def _patched_opener(monkeypatch, *, body=None, error=None):
    captured = {}

    class _Opener:
        def open(self, request, timeout=None):  # noqa: ANN001
            captured["url"] = request.full_url
            captured["headers"] = request.headers
            captured["method"] = request.get_method()
            if error is not None:
                raise error
            return _FakeResponse(json.dumps(body).encode("utf-8"))

    monkeypatch.setattr(pm, "_opener", _Opener())
    yield captured


def _http_error(code, body=b""):
    """Build an HTTPError whose .read() yields ``body`` (JSON error envelope)."""
    fp = io.BytesIO(body)
    return urllib.error.HTTPError("http://frontend:3000/api/internal/memory", code, "err", {}, fp)


# ---------------------------------------------------------------------------
# insert_memory_item
# ---------------------------------------------------------------------------


def test_insert_returns_item_id(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"item": {"id": "item-1"}}) as captured:
        result = pm.insert_memory_item(
            scope="project", project_id="p1", organization_id=None, kind="derived_fact", content="x"
        )
    assert result == "item-1"
    assert captured["method"] == "POST"


def test_insert_raises_without_token(monkeypatch):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError):
        pm.insert_memory_item(
            scope="project", project_id="p1", organization_id=None, kind="derived_fact", content="x"
        )


def test_org_memory_disabled_raises_typed_error(monkeypatch, caplog):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    body = json.dumps({"error": "Agent organization-scoped memory is disabled", "code": "ORG_MEMORY_DISABLED"}).encode()
    with _patched_opener(monkeypatch, error=_http_error(403, body)):
        with caplog.at_level(logging.ERROR, logger=pm.logger.name):
            with pytest.raises(pm.OrgMemoryDisabledError):
                pm.insert_memory_item(
                    scope="organization",
                    project_id=None,
                    organization_id="o1",
                    kind="preference",
                    content="Prefer metric units.",
                )
    assert "ORG_MEMORY_DISABLED" in caplog.text
    assert "GRID_ALLOW_AGENT_ORG_MEMORY" in caplog.text


def test_bare_403_logs_token_mismatch_and_reraises(monkeypatch, caplog):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    # Bare 403 (token guard): body {"error":"Forbidden"} with no code.
    body = json.dumps({"error": "Forbidden"}).encode()
    with _patched_opener(monkeypatch, error=_http_error(403, body)):
        with caplog.at_level(logging.ERROR, logger=pm.logger.name):
            with pytest.raises(urllib.error.HTTPError):
                pm.insert_memory_item(
                    scope="project", project_id="p1", organization_id=None, kind="derived_fact", content="x"
                )
    assert "GRID_INTERNAL_API_TOKEN" in caplog.text
    assert "mismatch" in caplog.text
    # Must NOT be mislabeled as the org-disabled case.
    assert not any(isinstance(r.exc_info, pm.OrgMemoryDisabledError) for r in caplog.records)


def test_forbidden_code_403_treated_as_token_mismatch(monkeypatch, caplog):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    body = json.dumps({"error": "Forbidden", "code": "FORBIDDEN"}).encode()
    with _patched_opener(monkeypatch, error=_http_error(403, body)):
        with caplog.at_level(logging.ERROR, logger=pm.logger.name):
            with pytest.raises(urllib.error.HTTPError):
                pm.insert_memory_item(
                    scope="project", project_id="p1", organization_id=None, kind="derived_fact", content="x"
                )
    assert "mismatch" in caplog.text


def test_503_logs_disabled_and_reraises(monkeypatch, caplog):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, error=_http_error(503, b'{"error":"Internal API disabled"}')):
        with caplog.at_level(logging.ERROR, logger=pm.logger.name):
            with pytest.raises(urllib.error.HTTPError):
                pm.insert_memory_item(
                    scope="project", project_id="p1", organization_id=None, kind="derived_fact", content="x"
                )
    assert "503" in caplog.text


def test_404_returns_none(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, error=_http_error(404, b'{"error":"Unknown project"}')):
        result = pm.insert_memory_item(
            scope="project", project_id="p-unknown", organization_id=None, kind="derived_fact", content="x"
        )
    assert result is None


# ---------------------------------------------------------------------------
# check_internal_api
# ---------------------------------------------------------------------------


def test_check_internal_api_ok(monkeypatch, caplog):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"ok": True}) as captured:
        with caplog.at_level(logging.INFO, logger=pm.logger.name):
            result = pm.check_internal_api()
    assert result is True
    assert "/api/internal/health" in captured["url"]
    assert "service token accepted" in caplog.text


def test_check_internal_api_no_token(monkeypatch, caplog):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    with caplog.at_level(logging.ERROR, logger=pm.logger.name):
        result = pm.check_internal_api()
    assert result is False
    assert "GRID_INTERNAL_API_TOKEN" in caplog.text


def test_check_internal_api_403(monkeypatch, caplog):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, error=_http_error(403, b'{"error":"Forbidden"}')):
        with caplog.at_level(logging.ERROR, logger=pm.logger.name):
            result = pm.check_internal_api()
    assert result is False
    assert "GRID_INTERNAL_API_TOKEN" in caplog.text


def test_check_internal_api_503(monkeypatch, caplog):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, error=_http_error(503, b'{"error":"Internal API disabled"}')):
        with caplog.at_level(logging.ERROR, logger=pm.logger.name):
            result = pm.check_internal_api()
    assert result is False
    assert "503" in caplog.text


def test_check_internal_api_connection_error(monkeypatch, caplog):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, error=urllib.error.URLError("connection refused")):
        with caplog.at_level(logging.WARNING, logger=pm.logger.name):
            result = pm.check_internal_api()
    assert result is False
    assert "may not be up yet" in caplog.text


def test_check_internal_api_never_raises_on_oserror(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, error=OSError("boom")):
        # Must swallow the error and return False, never propagate.
        assert pm.check_internal_api() is False

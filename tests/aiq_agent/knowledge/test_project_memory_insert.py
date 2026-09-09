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
            captured["payload"] = json.loads(request.data.decode("utf-8")) if request.data else None
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


def test_insert_sends_the_supersedes_quote(monkeypatch):
    """How the agent corrects memory instead of only appending to it: the entry
    being replaced is quoted verbatim and the frontend retires it."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"item": {"id": "item-2"}}) as captured:
        pm.insert_memory_item(
            scope="project",
            project_id="p1",
            organization_id=None,
            kind="derived_fact",
            content="OIB-RL 2.1 ist anwendbar.",
            supersedes_content="  OIB-RL 2.1 ist nicht anwendbar  ",
        )
    assert captured["payload"]["supersedesContent"] == "OIB-RL 2.1 ist nicht anwendbar"


def test_insert_omits_the_supersedes_quote_when_absent(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"item": {"id": "item-3"}}) as captured:
        pm.insert_memory_item(
            scope="project",
            project_id="p1",
            organization_id=None,
            kind="derived_fact",
            content="x",
            supersedes_content="   ",
        )
    assert "supersedesContent" not in captured["payload"]


def test_a_retirement_is_recorded_and_said_out_loud(monkeypatch):
    """ADR-0055 contract C4: a correction is the quietest event in the system.

    The route reports ``supersededId`` rather than letting the caller derive it
    from the returned row, and this is the one place either writer learns that a
    correction landed — so it is where the turn's tally and its live line come
    from.
    """
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    said: list[int] = []
    monkeypatch.setattr("aiq_agent.common.turn_status.emit_memory_superseded", said.append)
    token = pm.begin_turn_memory_log()
    try:
        with _patched_opener(monkeypatch, body={"item": {"id": "new-1"}, "supersededId": "old-1"}):
            pm.insert_memory_item(
                scope="project",
                project_id="p1",
                organization_id="o1",
                kind="decision",
                content="Flachdach gewählt",
                supersedes_content="Satteldach gewählt",
            )
        assert pm.turn_memory_supersessions() == ("old-1",)
        # The running total, not one line per retirement: the live line replaces
        # rather than accumulates.
        assert said == [1]
    finally:
        pm.end_turn_memory_log(token)


def test_a_write_that_retired_nothing_says_nothing(monkeypatch):
    """`supersededId` is null when the quote resolved to nothing, or to an entry
    the agent may not retire. The caller must then be honest about it."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    said: list[int] = []
    monkeypatch.setattr("aiq_agent.common.turn_status.emit_memory_superseded", said.append)
    token = pm.begin_turn_memory_log()
    try:
        with _patched_opener(monkeypatch, body={"item": {"id": "new-1"}, "supersededId": None}):
            pm.insert_memory_item(scope="project", project_id="p1", organization_id="o1", kind="decision", content="x")
        assert pm.turn_memory_supersessions() == ()
        assert said == []
    finally:
        pm.end_turn_memory_log(token)


def test_a_background_write_does_not_push_a_line_into_a_closed_turn(monkeypatch):
    """The post-answer reflection stage writes corrections too, minutes after the
    reader stopped watching. Outside a bound turn there is nothing to say it to,
    and the write still lands."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    said: list[int] = []
    monkeypatch.setattr("aiq_agent.common.turn_status.emit_memory_superseded", said.append)
    with _patched_opener(monkeypatch, body={"item": {"id": "new-1"}, "supersededId": "old-1"}):
        item_id = pm.insert_memory_item(
            scope="project", project_id="p1", organization_id="o1", kind="decision", content="x"
        )
    assert item_id == "new-1"
    assert said == []


def test_profile_graduation_is_not_a_kind_this_side_knows(monkeypatch):
    """ADR-0055 contract C7, from the Python half.

    No writer ever produced `profile_graduation`, and the enum guard below fails
    closed on it. Pinned so that re-adding a kind nothing writes is a decision
    rather than a merge — and so the TypeScript union dropping it cannot leave
    this side quietly accepting a value the database no longer has.
    """
    assert "profile_graduation" not in pm.VALID_KINDS
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with pytest.raises(ValueError):
        pm.insert_memory_item(
            scope="project",
            project_id="p1",
            organization_id="o1",
            kind="profile_graduation",
            content="x",
        )


def test_insert_raises_without_token(monkeypatch):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError):
        pm.insert_memory_item(scope="project", project_id="p1", organization_id=None, kind="derived_fact", content="x")


def test_org_memory_disabled_raises_typed_error(monkeypatch, caplog):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    body = json.dumps({"error": "Agent organization-scoped memory is disabled", "code": "ORG_MEMORY_DISABLED"}).encode()
    with _patched_opener(monkeypatch, error=_http_error(403, body)):
        # The default-deny is expected and handled by the caller (confirmation
        # card), so it is logged at INFO, not ERROR — capture from INFO up.
        with caplog.at_level(logging.INFO, logger=pm.logger.name):
            with pytest.raises(pm.OrgMemoryDisabledError):
                pm.insert_memory_item(
                    scope="organization",
                    project_id=None,
                    organization_id="o1",
                    kind="preference",
                    content="Prefer metric units.",
                )
    # The typed error is the contract; the log is informational, not an error.
    assert "ORG_MEMORY_DISABLED" in caplog.text
    org_deny_records = [r for r in caplog.records if "ORG_MEMORY_DISABLED" in r.getMessage()]
    assert org_deny_records and all(r.levelno <= logging.INFO for r in org_deny_records)


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

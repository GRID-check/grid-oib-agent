"""Tests for the per-turn memory digest fetch client (fetch_memory_digest)."""

import contextlib
import io
import json

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
            captured["timeout"] = timeout
            if error is not None:
                raise error
            return _FakeResponse(json.dumps(body).encode("utf-8"))

    monkeypatch.setattr(pm, "_opener", _Opener())
    yield captured


def test_returns_none_without_ids(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    assert pm.fetch_memory_digest(project_id=None, organization_id=None) is None


def test_raises_without_token(monkeypatch):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError):
        pm.fetch_memory_digest(project_id="p1", organization_id="o1")


def test_returns_digest_string(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"digest": "PROJECT_MEMORY v1\n- x"}) as captured:
        result = pm.fetch_memory_digest(project_id="p1", organization_id="o1")
    assert result is not None
    assert result.digest == "PROJECT_MEMORY v1\n- x"
    assert "/api/internal/memory/digest?" in captured["url"]
    assert "projectId=p1" in captured["url"]
    assert "organizationId=o1" in captured["url"]
    assert captured["method"] == "GET"


def test_null_digest_reads_as_no_active_memory(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"digest": None}):
        result = pm.fetch_memory_digest(project_id="p1", organization_id=None)
    # A successful call, and an empty one: distinct from "we did not ask",
    # which is the only thing that returns None.
    assert result is not None
    assert result.digest is None


def test_blank_digest_reads_as_no_active_memory(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"digest": "   "}):
        result = pm.fetch_memory_digest(project_id="p1", organization_id=None)
    assert result is not None
    assert result.digest is None


def test_the_digest_reports_what_it_carried(monkeypatch):
    """Contract C2: the reader is told what the model was told (ADR-0055)."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    body = {
        "digest": "PROJECT_MEMORY v1\n- x",
        "carried": [
            {"id": "m1", "kind": "decision", "content": "Flachdach gewählt"},
            {"id": "m2", "kind": "constraint", "content": "x" * 400},
            {"id": "", "kind": "decision", "content": "unusable, no id"},
            "not a dict",
        ],
        "omitted": 7,
        "total": 29,
    }
    with _patched_opener(monkeypatch, body=body):
        result = pm.fetch_memory_digest(project_id="p1", organization_id="o1")
    assert result is not None
    assert [note.id for note in result.carry.carried] == ["m1", "m2"]
    # Bounded on the way in, so a long note cannot ride the frame at full size.
    assert len(result.carry.carried[1].content) == 120
    assert result.carry.omitted == 7
    assert result.carry.total == 29


def test_an_older_bff_without_the_carry_fields_costs_the_turn_nothing(monkeypatch):
    """The endpoint half ships separately; the digest must not need it."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"digest": "PROJECT_MEMORY v1"}):
        result = pm.fetch_memory_digest(project_id="p1", organization_id="o1")
    assert result is not None
    assert result.digest == "PROJECT_MEMORY v1"
    assert result.carry.carried == ()
    assert result.carry.omitted == 0
    assert result.carry.total == 0


def test_transport_error_propagates(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, error=OSError("boom")):
        with pytest.raises(OSError):
            pm.fetch_memory_digest(project_id="p1", organization_id=None)


def test_digest_uses_tight_timeout(monkeypatch):
    """The per-turn digest read must use the tight critical-path timeout, not
    the longer timeout the write calls allow, so a slow BFF never stalls the
    turn before intent classification."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"digest": "d"}) as captured:
        pm.fetch_memory_digest(project_id="p1", organization_id=None)
    assert captured["timeout"] == pm._DIGEST_TIMEOUT_SECONDS
    # 2.5s, was 1.5: the digest build now embeds the turn's question for
    # relevance-ranked recall (the BFF caps that embed at ~1s of this budget).
    # Still a critical-path ceiling — raising it further needs the same
    # TTFT argument this comment carries, not just a bigger number.
    assert pm._DIGEST_TIMEOUT_SECONDS <= 2.5
    # And it must be tighter than the timeout the (off-critical-path) writes use.
    assert pm._DIGEST_TIMEOUT_SECONDS < pm._REQUEST_TIMEOUT_SECONDS


def test_timeout_error_propagates_for_failopen(monkeypatch):
    """On timeout the fetch raises so the caller can fall back to the frozen
    connection-time digest (fail-open) instead of dropping memory."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, error=TimeoutError("timed out")):
        with pytest.raises(TimeoutError):
            pm.fetch_memory_digest(project_id="p1", organization_id=None)

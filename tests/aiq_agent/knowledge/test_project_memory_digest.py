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
    assert result == "PROJECT_MEMORY v1\n- x"
    assert "/api/internal/memory/digest?" in captured["url"]
    assert "projectId=p1" in captured["url"]
    assert "organizationId=o1" in captured["url"]
    assert captured["method"] == "GET"


def test_null_digest_returns_none(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"digest": None}):
        assert pm.fetch_memory_digest(project_id="p1", organization_id=None) is None


def test_blank_digest_returns_none(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"digest": "   "}):
        assert pm.fetch_memory_digest(project_id="p1", organization_id=None) is None


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


def test_the_turns_restricted_collections_ride_the_query(monkeypatch):
    """ADR-0086: restricted memory is served only for these."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"digest": "d"}) as captured:
        pm.fetch_memory_digest(
            project_id="p1",
            organization_id="o1",
            conversation_id="",
            restricted_collections=["proj_p1_raaaaaaaaaaaa", " ", "proj_p1_rbbbbbbbbbbbb"],
        )
    assert "restrictedCollections=proj_p1_raaaaaaaaaaaa%2Cproj_p1_rbbbbbbbbbbbb" in captured["url"]


def test_no_restricted_collections_no_param(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    with _patched_opener(monkeypatch, body={"digest": "d"}) as captured:
        pm.fetch_memory_digest(project_id="p1", organization_id="o1", conversation_id="")
    assert "restrictedCollections" not in captured["url"]


def test_the_asker_travels_and_served_restricted_notes_confine_the_turn(monkeypatch):
    """ADR-0087: restricted notes in the digest are use of their folders, recorded by the BFF."""
    from aiq_agent.knowledge.restricted_use import RestrictedUse
    from aiq_agent.knowledge.restricted_use import bind_restricted_use
    from aiq_agent.knowledge.restricted_use import reset_restricted_use

    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    use = RestrictedUse(organization_id="o1", user_id="u1", conversation_id="c1", project_id="p1")
    token = bind_restricted_use(use)
    try:
        body = {"digest": "PROJECT_MEMORY v1\n- x", "restrictedFoldersServed": ["f-1"]}
        with _patched_opener(monkeypatch, body=body) as captured:
            pm.fetch_memory_digest(
                project_id="p1",
                organization_id="o1",
                conversation_id="c1",
                user_id="u1",
                restricted_collections=["proj_p1_r0123456789ab"],
            )
    finally:
        reset_restricted_use(token)
    assert "userId=u1" in captured["url"]
    assert "restrictedCollections=proj_p1_r0123456789ab" in captured["url"]  # pragma: allowlist secret
    assert use.confined is True


def test_a_digest_without_restricted_notes_leaves_the_turn_open(monkeypatch):
    from aiq_agent.knowledge.restricted_use import RestrictedUse
    from aiq_agent.knowledge.restricted_use import bind_restricted_use
    from aiq_agent.knowledge.restricted_use import reset_restricted_use

    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
    use = RestrictedUse(organization_id="o1", user_id="u1", conversation_id="c1", project_id="p1")
    token = bind_restricted_use(use)
    try:
        with _patched_opener(monkeypatch, body={"digest": "x", "restrictedFoldersServed": []}):
            pm.fetch_memory_digest(project_id="p1", organization_id="o1", conversation_id="c1")
    finally:
        reset_restricted_use(token)
    assert use.confined is False

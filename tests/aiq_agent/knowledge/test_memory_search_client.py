"""The recall client: contract C1's request, and its fail-open answer.

``GET /api/internal/memory/search`` is the same trust boundary the digest read
crosses — same service token, same no-redirect opener, same single-writer rule —
so what this file pins is the REQUEST (what the BFF is asked, and what it is
never asked) and the refusal to raise. Recall is a second path to memory, not
the turn's correctness: a search that could not run must cost the answer nothing.
"""

from __future__ import annotations

import contextlib
import io
import json
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
    captured: dict = {}

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


_ONE_HIT = {
    "items": [
        {
            "id": "m1",
            "kind": "decision",
            "content": "Flachdach gewählt",
            "confidence": "high",
            "verification": "user_confirmed",
            "pinned": True,
            "scope": "project",
            "updatedAt": "2026-09-01T10:00:00Z",
            "score": 0.81,
        }
    ],
    "total": 31,
    "returned": 1,
}


class TestTheRequest:
    def test_a_project_turn_asks_for_its_project_and_its_organization(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=_ONE_HIT) as captured:
            pm.search_memory_notes(query="Dachaufbau", project_id="p1", organization_id="o1")
        assert "/api/internal/memory/search?" in captured["url"]
        assert "projectId=p1" in captured["url"]
        assert "organizationId=o1" in captured["url"]
        assert "q=Dachaufbau" in captured["url"]
        assert captured["method"] == "GET"
        assert captured["headers"]["X-grid-internal-token"] == "t"

    def test_an_office_turn_sends_no_projectid_at_all(self, monkeypatch):
        """The ABSENCE of the parameter is what asks for organization-scoped
        notes only (contract C1). An empty `projectId=` is a different request."""
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=_ONE_HIT) as captured:
            pm.search_memory_notes(query="Dachaufbau", project_id=None, organization_id="o1")
        assert "projectId" not in captured["url"]

    @pytest.mark.parametrize(
        ("asked", "expected"), [(None, "limit=8"), (3, "limit=3"), (0, "limit=8"), (99, "limit=20")]
    )
    def test_the_limit_is_clamped_before_it_is_sent(self, monkeypatch, asked, expected):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        kwargs = {} if asked is None else {"limit": asked}
        with _patched_opener(monkeypatch, body=_ONE_HIT) as captured:
            pm.search_memory_notes(query="x", project_id=None, organization_id="o1", **kwargs)
        assert expected in captured["url"]

    def test_the_query_is_bounded_so_a_transcript_cannot_be_posted_as_a_param(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=_ONE_HIT) as captured:
            pm.search_memory_notes(query="w" * 9000, project_id=None, organization_id="o1")
        assert captured["url"].count("w") <= 2000

    def test_no_organization_means_no_request(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=_ONE_HIT) as captured:
            assert pm.search_memory_notes(query="x", project_id="p1", organization_id=None) is None
        assert captured == {}

    def test_an_empty_query_means_no_request(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=_ONE_HIT) as captured:
            assert pm.search_memory_notes(query="   ", project_id="p1", organization_id="o1") is None
        assert captured == {}

    def test_an_unconfigured_token_is_a_skip_not_a_crash(self, monkeypatch):
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        assert pm.search_memory_notes(query="x", project_id=None, organization_id="o1") is None


class TestTheAnswer:
    def test_it_reads_every_field_the_model_weighs_a_note_by(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=_ONE_HIT):
            result = pm.search_memory_notes(query="x", project_id="p1", organization_id="o1")
        assert result is not None
        hit = result.items[0]
        assert (hit.id, hit.kind, hit.confidence, hit.verification) == (
            "m1",
            "decision",
            "high",
            "user_confirmed",
        )
        assert hit.pinned is True
        assert (result.total, result.returned) == (31, 1)

    def test_a_malformed_row_is_dropped_and_the_rest_still_arrives(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        body = {"items": [{"id": "m1", "content": "a"}, {"content": "no id"}, {"id": "m2"}, "x"], "total": 3}
        with _patched_opener(monkeypatch, body=body):
            result = pm.search_memory_notes(query="x", project_id=None, organization_id="o1")
        assert result is not None
        assert [hit.id for hit in result.items] == ["m1"]

    @pytest.mark.parametrize(
        "failure",
        [
            urllib.error.HTTPError("u", 500, "boom", {}, None),
            urllib.error.URLError("down"),
            TimeoutError("slow"),
            OSError("refused"),
        ],
    )
    def test_it_never_raises_at_the_caller(self, monkeypatch, failure):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, error=failure):
            assert pm.search_memory_notes(query="x", project_id=None, organization_id="o1") is None

    def test_a_body_that_is_not_an_object_is_a_miss_not_a_crash(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=["surprise"]):
            assert pm.search_memory_notes(query="x", project_id=None, organization_id="o1") is None

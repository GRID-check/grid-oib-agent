"""Asking the BFF whether a dispatched document still exists.

Only a definite answer counts: ``True``/``False`` from a 200 whose body says so.
Everything else is ``None``, which the ingestor reads as "present", because a
BFF it cannot reach must never cost a live document its chunks. The ingest
side of this contract is in ``test_reingest_replaces_versions.py``.
"""

from __future__ import annotations

import httpx
import pytest
from knowledge_layer.llamaindex import document_presence


@pytest.fixture()
def configured(monkeypatch):
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000/")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret")


class _Response:
    def __init__(self, status_code: int, body=None, raises: Exception | None = None):
        self.status_code = status_code
        self._body = body
        self._raises = raises

    def json(self):
        if self._raises:
            raise self._raises
        return self._body


def _answer(monkeypatch, response=None, raises: Exception | None = None) -> list[dict]:
    calls: list[dict] = []

    def get(url, **kwargs):
        calls.append({"url": url, **kwargs})
        if raises:
            raise raises
        return response

    monkeypatch.setattr(httpx, "get", get)
    return calls


@pytest.mark.parametrize("exists", [True, False])
def test_a_definite_answer_is_returned_as_it_came(configured, monkeypatch, exists):
    calls = _answer(monkeypatch, _Response(200, {"exists": exists}))

    assert document_presence.document_still_exists("d1", "proj_1", "org_1") is exists
    assert calls[0]["url"] == "http://frontend:3000/api/internal/document-exists"
    assert calls[0]["params"] == {"documentId": "d1", "collection": "proj_1", "organizationId": "org_1"}
    assert calls[0]["headers"] == {"x-grid-internal-token": "secret"}


def test_no_organization_is_not_sent(configured, monkeypatch):
    calls = _answer(monkeypatch, _Response(200, {"exists": True}))
    document_presence.document_still_exists("d1", "proj_1")
    assert calls[0]["params"] == {"documentId": "d1", "collection": "proj_1"}


@pytest.mark.parametrize(
    "response",
    [
        # A BFF that predates the route answers 404: that is not "gone".
        _Response(404, {"error": "not found"}),
        _Response(500, {"exists": False}),
        _Response(403, {"exists": False}),
        _Response(200, {}),
        _Response(200, {"exists": "false"}),
        _Response(200, None, raises=ValueError("not json")),
    ],
)
def test_anything_short_of_a_definite_answer_is_unknown(configured, monkeypatch, response):
    _answer(monkeypatch, response)
    assert document_presence.document_still_exists("d1", "proj_1") is None


def test_an_unreachable_bff_is_unknown(configured, monkeypatch):
    _answer(monkeypatch, raises=httpx.ConnectError("refused"))
    assert document_presence.document_still_exists("d1", "proj_1") is None


@pytest.mark.parametrize("missing", ["FRONTEND_INTERNAL_URL", "GRID_INTERNAL_API_TOKEN"])
def test_an_unconfigured_transport_asks_nothing(configured, monkeypatch, missing):
    monkeypatch.delenv(missing)
    calls = _answer(monkeypatch, _Response(200, {"exists": False}))
    assert document_presence.document_still_exists("d1", "proj_1") is None
    assert calls == []

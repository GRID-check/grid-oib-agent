"""``conversation_confined_to``: the per-turn question a restricted scope asks the BFF (ADR-0078).

It fails CLOSED. Every answer but an explicit ``{"confined": true}`` reads as
"not the asker's alone", because the chat socket withholds restricted content
on ``False``: a broken check costs a reconnect, never a leak.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from aiq_api import internal_api
from aiq_api.internal_api import conversation_confined_to

ASK = {"conversation_id": "s_conv", "organization_id": "org_1", "user_id": "user_asker"}


class _Requests(list):
    """Every request the BFF received; ``answer`` is what it replies next (or an exception to raise)."""

    answer: tuple[int, Any] | Exception = (200, {"confined": True})


@pytest.fixture
def bff(monkeypatch) -> _Requests:
    """The BFF behind a mock transport."""
    requests = _Requests()
    real_client = httpx.AsyncClient

    def reply(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if isinstance(requests.answer, Exception):
            raise requests.answer
        status, body = requests.answer
        return httpx.Response(status, json=body)

    def client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        return real_client(*args, transport=httpx.MockTransport(reply), **kwargs)

    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "service-token")
    monkeypatch.setattr(internal_api.httpx, "AsyncClient", client)
    return requests


async def test_the_bff_is_asked_with_the_signed_asker_and_organization(bff):
    assert await conversation_confined_to(**ASK) is True

    (request,) = bff
    assert request.url == "http://frontend:3000/api/internal/conversations/s_conv/confinement"
    assert request.headers["x-grid-internal-token"] == "service-token"
    assert request.read() == b'{"organizationId":"org_1","userId":"user_asker"}'


@pytest.mark.parametrize(
    "answer",
    [
        (200, {"confined": False}),
        (200, {}),
        (200, {"confined": "true"}),
        (200, ["confined"]),
        (403, {"confined": True}),
        (500, {"error": "boom"}),
        httpx.ConnectError("down"),
    ],
)
async def test_anything_but_an_explicit_yes_is_a_no(bff, answer):
    bff.answer = answer

    assert await conversation_confined_to(**ASK) is False


@pytest.mark.parametrize(
    "missing",
    [{"organization_id": None}, {"user_id": None}],
)
async def test_without_someone_to_ask_about_it_is_a_no_and_nothing_is_sent(bff, missing):
    assert await conversation_confined_to(**{**ASK, **missing}) is False
    assert bff == []


async def test_without_the_internal_api_it_is_a_no(bff, monkeypatch):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN")

    assert await conversation_confined_to(**ASK) is False
    assert bff == []

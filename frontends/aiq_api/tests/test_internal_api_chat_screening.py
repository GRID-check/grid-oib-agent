"""``chat_screening_for``: the office's chat screening, read from the BFF once per socket (ADR-0079).

It fails CLOSED. Anything but a well-formed answer from the BFF masks with
every detector and no term (``CHAT_SCREENING_FALLBACK``), and says so by
``from_office=False``, so the socket asks again on its next message.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from aiq_agent.common.content_screen import DETECTORS
from aiq_api import internal_api
from aiq_api.internal_api import CHAT_SCREENING_FALLBACK
from aiq_api.internal_api import chat_screening_for
from aiq_api.internal_api import chat_screening_from


class _Requests(list):
    """Every request the BFF received; ``answer`` is what it replies next (or an exception to raise)."""

    answer: tuple[int, Any] | Exception = (
        200,
        {"enabled": True, "content_terms": ["Gehaltsabrechnung"], "detectors": ["iban"]},
    )


@pytest.fixture
def bff(monkeypatch) -> _Requests:
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


async def test_the_office_s_content_terms_and_detectors_are_read_with_the_service_token(bff):
    screening = await chat_screening_for("org_1")

    (request,) = bff
    assert str(request.url) == "http://frontend:3000/api/internal/chat-screening?organizationId=org_1"
    assert request.headers["x-grid-internal-token"] == "service-token"
    assert screening.from_office
    assert screening.rules is not None
    assert (screening.rules.terms, screening.rules.detectors) == (("Gehaltsabrechnung",), ("iban",))


async def test_an_office_that_switched_screening_off_masks_nothing(bff):
    bff.answer = (200, {"enabled": False, "content_terms": ["Gehalt"], "detectors": ["iban"]})
    screening = await chat_screening_for("org_1")
    assert (screening.rules, screening.from_office) == (None, True)


@pytest.mark.parametrize(
    "answer",
    [
        (404, {"error": "Not Found"}),  # a BFF older than the route
        (500, {"error": "boom"}),
        (200, {"content_terms": ["Gehalt"]}),  # no switch
        (200, {"enabled": True, "content_terms": "Gehalt"}),
        (200, ["Gehalt"]),
        httpx.ConnectError("refused"),
    ],
)
async def test_anything_else_masks_every_detector_and_is_asked_again(bff, answer):
    bff.answer = answer
    assert await chat_screening_for("org_1") == CHAT_SCREENING_FALLBACK
    assert CHAT_SCREENING_FALLBACK.rules is not None
    assert CHAT_SCREENING_FALLBACK.rules.detectors == DETECTORS
    assert CHAT_SCREENING_FALLBACK.rules.terms == ()
    assert not CHAT_SCREENING_FALLBACK.from_office


async def test_no_organization_asks_nobody(bff):
    assert await chat_screening_for(None) == CHAT_SCREENING_FALLBACK
    assert bff == []


def test_an_office_with_both_lists_empty_masks_nothing():
    screening = chat_screening_from({"enabled": True, "content_terms": [], "detectors": []})
    assert (screening.rules, screening.from_office) == (None, True)

"""Tests for the internal RIS document-reader route.

The route exists so a RIS citation opens INSIDE Piloti rather than in a browser
tab (#622), and everything it must not do is a refusal it inherits from
``RisClient``: a non-RIS host, a document RIS only publishes as a PDF, a
reference that is neither a number nor a URL. Those are all statements about
the REQUEST, so they must come back as 400s the BFF can turn into "this source
cannot be shown here" — never as 502s that send it looking for an outage.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import patch

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_api.routes.ris import MAX_DOCUMENT_TEXT_CHARS
from aiq_api.routes.ris import add_ris_routes

TOKEN = "test-internal-token"
URL = "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    app = FastAPI()
    router = APIRouter()
    add_ris_routes(router)
    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _document(text: str = "§ 108. Schutz vor Brandgefahr", title: str = "Bauordnung für Wien"):
    from ris_adapter.client import RisDocument

    return RisDocument(url=URL, title=title, text=text)


@pytest.mark.asyncio
async def test_requires_the_internal_token(client):
    async with client as http:
        response = await http.get("/v1/ris/document", params={"reference": URL})
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_returns_the_document_text(client):
    with patch(
        "ris_adapter.client.RisClient.fetch_document_text",
        new=AsyncMock(return_value=_document()),
    ):
        async with client as http:
            response = await http.get(
                "/v1/ris/document",
                params={"reference": URL},
                headers={"x-grid-internal-token": TOKEN},
            )

    assert response.status_code == 200
    body = response.json()
    assert body["url"] == URL
    assert body["title"] == "Bauordnung für Wien"
    assert "Brandgefahr" in body["text"]
    assert body["truncated"] is False


@pytest.mark.asyncio
async def test_accepts_a_bare_document_number(client):
    fetch = AsyncMock(return_value=_document())
    with patch("ris_adapter.client.RisClient.fetch_document_text", new=fetch):
        async with client as http:
            response = await http.get(
                "/v1/ris/document",
                params={"reference": "NOR40217157"},
                headers={"x-grid-internal-token": TOKEN},
            )

    assert response.status_code == 200
    # A citation can carry either form, so both have to reach a URL the client
    # will accept — the number goes through the adapter's own URL builder.
    assert fetch.await_args.args[0].startswith("https://www.ris.bka.gv.at/")


@pytest.mark.asyncio
async def test_says_truncated_rather_than_ending_mid_sentence(client):
    long_text = "a" * (MAX_DOCUMENT_TEXT_CHARS + 500)
    with patch(
        "ris_adapter.client.RisClient.fetch_document_text",
        new=AsyncMock(return_value=_document(text=long_text)),
    ):
        async with client as http:
            response = await http.get(
                "/v1/ris/document",
                params={"reference": URL},
                headers={"x-grid-internal-token": TOKEN},
            )

    body = response.json()
    assert body["truncated"] is True
    assert len(body["text"]) == MAX_DOCUMENT_TEXT_CHARS


@pytest.mark.asyncio
async def test_a_non_ris_url_is_the_callers_error_not_an_outage(client):
    # The refusal comes from the client's own host allow-list; the route must
    # not launder it into a 502.
    async with client as http:
        response = await http.get(
            "/v1/ris/document",
            params={"reference": "https://example.org/gesetz"},
            headers={"x-grid-internal-token": TOKEN},
        )

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_an_unreachable_ris_is_a_bad_gateway(client):
    with patch(
        "ris_adapter.client.RisClient.fetch_document_text",
        new=AsyncMock(side_effect=RuntimeError("connection reset")),
    ):
        async with client as http:
            response = await http.get(
                "/v1/ris/document",
                params={"reference": URL},
                headers={"x-grid-internal-token": TOKEN},
            )

    assert response.status_code == 502

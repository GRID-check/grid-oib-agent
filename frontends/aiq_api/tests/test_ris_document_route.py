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

from aiq_api.routes import ris as ris_module
from aiq_api.routes.ris import MAX_DOCUMENT_TEXT_CHARS
from aiq_api.routes.ris import add_ris_routes

TOKEN = "test-internal-token"
URL = "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006"


@pytest.fixture(autouse=True)
def _no_cached_documents(monkeypatch):
    """Isolate each case from the two caches the route legitimately has.

    The route holds ONE ``RisClient`` for the process (a per-request client
    leaks its connection pool and defeats the client's own in-memory cache) and
    reads through the shared Dragonfly cache. Both are the point in production
    and both are pollution here: every case below fetches the same URL, so
    without this the first case's document is served to all the rest and a test
    asserting a transport failure passes on an earlier test's success. Which is
    exactly what happened when this file was first written.

    The caching itself is asserted on purpose in its own case below, rather than
    left as an accident of ordering.
    """
    ris_module._RIS_CLIENT = None
    monkeypatch.setattr("ris_adapter.cache.cache_get_json", AsyncMock(return_value=None))
    monkeypatch.setattr("ris_adapter.cache.cache_set_json", AsyncMock(return_value=None))
    yield
    ris_module._RIS_CLIENT = None


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
    long_text = "a " * MAX_DOCUMENT_TEXT_CHARS
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
async def test_an_over_long_document_is_windowed_around_the_cited_passage(client):
    """A citation is a pointer INTO a document, so clipping the head loses it.

    Measured 2026-09-04: the Bauordnung für Wien is 759,595 characters and its
    § 108 sits at 524,079; the ASVG is 4,294,779. Whatever the ceiling is set to,
    a document clipped at its start is the one shape the answer must never take,
    because it drops the very paragraph the reader clicked to check.
    """
    passage = "Bauwerke oder Bauwerksteile in denen gefaehrliche Stoffe gelagert werden"
    # The passage sits three million characters in — far past any head clip.
    text = ("x " * 1_500_000) + passage + (" y" * 1_000_000)

    with patch(
        "ris_adapter.client.RisClient.fetch_document_text",
        new=AsyncMock(return_value=_document(text=text)),
    ):
        async with client as http:
            response = await http.get(
                "/v1/ris/document",
                params={"reference": URL, "passage": passage},
                headers={"x-grid-internal-token": TOKEN},
            )

    body = response.json()
    assert body["truncated"] is True
    assert len(body["text"]) == MAX_DOCUMENT_TEXT_CHARS
    assert passage in body["text"]


@pytest.mark.asyncio
async def test_a_passage_that_cannot_be_located_falls_back_to_the_head(client):
    """No window is better than a wrong one, and the head is the honest default."""
    text = ("x " * 1_500_000) + "eine ganz andere Stelle" + (" y" * 1_000_000)

    with patch(
        "ris_adapter.client.RisClient.fetch_document_text",
        new=AsyncMock(return_value=_document(text=text)),
    ):
        async with client as http:
            response = await http.get(
                "/v1/ris/document",
                params={"reference": URL, "passage": "worte die nirgendwo im dokument stehen"},
                headers={"x-grid-internal-token": TOKEN},
            )

    body = response.json()
    assert body["truncated"] is True
    assert body["text"].startswith("x ")


@pytest.mark.asyncio
async def test_a_document_that_fits_is_never_clipped_or_moved(client):
    with patch(
        "ris_adapter.client.RisClient.fetch_document_text",
        new=AsyncMock(return_value=_document(text="§ 108. Lagerung gefaehrlicher Stoffe")),
    ):
        async with client as http:
            response = await http.get(
                "/v1/ris/document",
                params={"reference": URL, "passage": "Lagerung gefaehrlicher Stoffe"},
                headers={"x-grid-internal-token": TOKEN},
            )

    body = response.json()
    assert body["truncated"] is False
    assert body["text"] == "§ 108. Lagerung gefaehrlicher Stoffe"


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


@pytest.mark.asyncio
async def test_reads_through_the_shared_cache_rather_than_refetching(client, monkeypatch):
    """The reader and the agent share one cached document.

    The read-through used to be written inline in ``ris_fetch_document``, so this
    route — added later — fetched live on every open while its own docstring
    claimed the cache. A helper only one caller applies is a helper the next
    caller forgets, which is why it is a shared function now.
    """
    monkeypatch.setattr(
        "ris_adapter.cache.cache_get_json",
        AsyncMock(return_value={"url": URL, "title": "Aus dem Cache", "text": "§ 108. Gecacht"}),
    )
    fetch = AsyncMock(return_value=_document())
    with patch("ris_adapter.client.RisClient.fetch_document_text", new=fetch):
        async with client as http:
            response = await http.get(
                "/v1/ris/document",
                params={"reference": URL},
                headers={"x-grid-internal-token": TOKEN},
            )

    assert response.json()["text"] == "§ 108. Gecacht"
    fetch.assert_not_awaited()

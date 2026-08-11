"""Tests for the platform card-catalog endpoint (`GET /v1/platform/cards`)."""

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.cards.models import GridCard
from aiq_api.routes.cards import FEATURE_REQUEST_URL
from aiq_api.routes.cards import add_card_catalog_routes

_CARD_TYPES = [getattr(c.model_fields["type"].annotation, "__args__", ("?",))[0] for c in GridCard.__args__]


@pytest.fixture
def app():
    app = FastAPI()
    router = APIRouter()
    add_card_catalog_routes(router)
    app.include_router(router)
    return app


@pytest.fixture
async def catalog(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/v1/platform/cards")
    assert response.status_code == 200
    return response.json()


async def test_lists_every_card_type_with_a_count(catalog):
    assert [card["type"] for card in catalog["cards"]] == _CARD_TYPES
    # The count is served rather than left to be derived: a client that renders
    # "27 cards" from a truncated list would be confidently wrong.
    assert catalog["cardCount"] == len(_CARD_TYPES)


async def test_each_card_carries_what_it_shows(catalog):
    checklist = next(c for c in catalog["cards"] if c["type"] == "requirement_checklist")
    assert checklist["summary"]
    assert checklist["emittedBy"] == "agent"
    assert checklist["interaction"] == "presentational"

    fields = {field["name"]: field for field in checklist["fields"]}
    assert fields["title"]["required"] is True
    assert fields["items"]["type"] == "[ChecklistItem]"
    # The shape a field names must be resolvable from the same response, or the
    # catalog answers "what can it show?" with a name and nothing behind it.
    assert "ChecklistItem" in catalog["buildingBlocks"]


async def test_points_at_the_github_feature_request_form(catalog):
    feature_request = catalog["featureRequest"]
    assert feature_request["url"] == FEATURE_REQUEST_URL
    assert feature_request["repository"] == "https://github.com/GRID-check/grid-oib-agent"
    # The enhancement ISSUE FORM, not the bare new-issue page: a request that
    # arrives pre-structured is one that can be triaged.
    assert "template=02-enhancement.yml" in feature_request["url"]
    assert feature_request["label"]


async def test_the_route_is_json_serializable_end_to_end(catalog):
    """Worked examples travel with the cards (they are the 'showcase' part)."""
    compliance = next(c for c in catalog["cards"] if c["type"] == "ifc_compliance")
    assert compliance["example"]["type"] == "ifc_compliance"

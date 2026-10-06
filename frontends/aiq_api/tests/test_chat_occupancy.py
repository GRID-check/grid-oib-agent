"""The chat-occupancy route: the number KEDA scales the chat tier on (ADR-0079)."""

from __future__ import annotations

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_agent.common import turn_admission
from aiq_api.routes.chat_occupancy import CHAT_OCCUPANCY_PATH
from aiq_api.routes.chat_occupancy import add_chat_occupancy_routes

TOKEN = "real-secret"  # pragma: allowlist secret


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    monkeypatch.setenv("APP_ENV", "production")
    router = APIRouter()
    add_chat_occupancy_routes(router)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_reports_the_active_turn_count_in_the_shape_keda_reads(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(turn_admission, "active_turns", lambda: 9)
    monkeypatch.setattr(turn_admission, "MAX_ACTIVE_TURNS", 24)
    response = client.get(CHAT_OCCUPANCY_PATH, headers={"x-grid-internal-token": TOKEN})
    assert response.status_code == 200
    assert response.json() == {"activeTurns": 9, "maxActiveTurns": 24}


def test_refuses_a_caller_without_the_internal_token(client: TestClient):
    assert client.get(CHAT_OCCUPANCY_PATH).status_code == 403
    assert client.get(CHAT_OCCUPANCY_PATH, headers={"x-grid-internal-token": "wrong"}).status_code == 403


def test_an_unknown_count_is_a_503_so_keda_keeps_its_replicas(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(turn_admission, "active_turns", lambda: None)
    response = client.get(CHAT_OCCUPANCY_PATH, headers={"x-grid-internal-token": TOKEN})
    assert response.status_code == 503

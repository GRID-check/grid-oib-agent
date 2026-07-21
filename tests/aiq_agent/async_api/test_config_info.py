"""Tests for the /v1/config/llm-defaults introspection route."""

from types import SimpleNamespace

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_api.routes.config_info import add_config_info_routes


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    router = APIRouter()
    llm_configs = {
        "intent_llm": SimpleNamespace(model_name="deepseek/deepseek-v4-flash"),
        "card_llm": SimpleNamespace(model_name="deepseek/deepseek-v4-flash"),
        "weird_llm": SimpleNamespace(),  # no model field → None
    }
    add_config_info_routes(router, llm_configs)
    app.include_router(router)
    return TestClient(app)


def test_returns_llm_defaults_without_token_in_dev(client, monkeypatch):
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    response = client.get("/v1/config/llm-defaults")
    assert response.status_code == 200
    llms = response.json()["llms"]
    assert llms["intent_llm"] == "deepseek/deepseek-v4-flash"
    assert llms["card_llm"] == "deepseek/deepseek-v4-flash"
    assert llms["weird_llm"] is None
    # The env-configured ingestion VLM default is surfaced under a synthetic
    # `vlm` key so the model-config UI's ingest_vlm group shows a workflow
    # default (it is not a `llms:` entry).
    assert isinstance(llms["vlm"], str) and llms["vlm"]


def test_vlm_default_reflects_env(monkeypatch):
    """The synthetic `vlm` default mirrors AIQ_VLM_MODEL (resolved at
    route-registration time)."""
    monkeypatch.setenv("AIQ_VLM_MODEL", "vendor/vision-x")
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    app = FastAPI()
    router = APIRouter()
    add_config_info_routes(router, {})
    app.include_router(router)
    client = TestClient(app)

    assert client.get("/v1/config/llm-defaults").json()["llms"]["vlm"] == "vendor/vision-x"


def test_requires_matching_token_when_configured(client, monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")

    assert client.get("/v1/config/llm-defaults").status_code == 403
    assert client.get("/v1/config/llm-defaults", headers={"x-grid-internal-token": "wrong"}).status_code == 403

    ok = client.get("/v1/config/llm-defaults", headers={"x-grid-internal-token": "secret-token"})
    assert ok.status_code == 200
    assert ok.json()["llms"]["intent_llm"] == "deepseek/deepseek-v4-flash"

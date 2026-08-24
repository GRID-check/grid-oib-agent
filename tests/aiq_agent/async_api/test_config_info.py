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
        "intent_llm": SimpleNamespace(
            model_name="deepseek/deepseek-v4-flash",
            base_url="https://openrouter.ai/api/v1",
            reasoning_effort="none",
        ),
        "card_llm": SimpleNamespace(
            model_name="deepseek/deepseek-v4-flash",
            base_url="https://openrouter.ai/api/v1",
            reasoning_effort="medium",
        ),
        "weird_llm": SimpleNamespace(),  # no model/base_url/effort field → None
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


def test_reports_the_base_url_each_llm_targets(client, monkeypatch):
    """The BFF refuses to seed a platform default unless the deployment actually
    targets the platform catalog's provider, so the endpoint each LLM talks to is
    part of the contract — not just the model id."""
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    base_urls = client.get("/v1/config/llm-defaults").json()["baseUrls"]

    assert base_urls["intent_llm"] == "https://openrouter.ai/api/v1"
    assert base_urls["card_llm"] == "https://openrouter.ai/api/v1"
    # An LLM config without a base_url reports None rather than being omitted:
    # "unknown endpoint" must be distinguishable from "no such LLM".
    assert base_urls["weird_llm"] is None
    # The ingestion VLM has its own credential plane (AIQ_VLM_BASE_URL) and is
    # routinely a different provider from the `llms:` block.
    assert isinstance(base_urls["vlm"], str) and base_urls["vlm"]


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


def test_reports_the_reasoning_effort_each_llm_ships_with(client, monkeypatch):
    """The platform owner can override the thinking level per agent group, so the
    admin surface must be able to name what clearing that override returns to."""
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    efforts = client.get("/v1/config/llm-defaults").json()["reasoningEfforts"]

    assert efforts["intent_llm"] == "none"
    assert efforts["card_llm"] == "medium"
    # An LLM config without the field reports None rather than being omitted:
    # "role ships no effort" must be distinguishable from "no such LLM".
    assert efforts["weird_llm"] is None

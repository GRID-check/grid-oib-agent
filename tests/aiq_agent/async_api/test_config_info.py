# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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
    assert response.json() == {
        "llms": {
            "intent_llm": "deepseek/deepseek-v4-flash",
            "card_llm": "deepseek/deepseek-v4-flash",
            "weird_llm": None,
        }
    }


def test_requires_matching_token_when_configured(client, monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")

    assert client.get("/v1/config/llm-defaults").status_code == 403
    assert client.get("/v1/config/llm-defaults", headers={"x-grid-internal-token": "wrong"}).status_code == 403

    ok = client.get("/v1/config/llm-defaults", headers={"x-grid-internal-token": "secret-token"})
    assert ok.status_code == 200
    assert ok.json()["llms"]["intent_llm"] == "deepseek/deepseek-v4-flash"

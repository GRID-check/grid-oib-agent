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

"""Tests for the tavily_web_search NAT registration."""

import sys
import types
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from pydantic import SecretStr
from tavily_web_search.register import TavilyWebSearchToolConfig
from tavily_web_search.register import tavily_web_search


@pytest.fixture
def fake_langchain_tavily(monkeypatch):
    """Install a fake `langchain_tavily` module so tests never hit the network.

    Returns the `TavilySearch` MagicMock so tests can assert construction kwargs.
    """

    module = types.ModuleType("langchain_tavily")
    instance = MagicMock()
    instance.ainvoke = AsyncMock(
        return_value={"results": [{"url": "https://a.example", "title": "A", "content": "body a"}]}
    )

    module.TavilySearch = MagicMock(return_value=instance)
    monkeypatch.setitem(sys.modules, "langchain_tavily", module)
    return module.TavilySearch


@pytest.fixture(autouse=True)
def _reset_warn_flag():
    import tavily_web_search.register as reg

    reg._missing_key_warned = False
    yield
    reg._missing_key_warned = False


@pytest.fixture(autouse=True)
def _set_api_key(monkeypatch):
    # Ensure the live path (not the stub) is exercised in these tests.
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")


async def _run_search(config, query="question"):
    builder = MagicMock()
    async with tavily_web_search(config, builder) as info:
        return await info.single_fn(query)


def _construction_kwargs(tavily_search_mock):
    tavily_search_mock.assert_called_once()
    _, kwargs = tavily_search_mock.call_args
    return kwargs


class TestTavilyWebSearchToolConfig:
    def test_domain_defaults_are_empty_lists(self):
        config = TavilyWebSearchToolConfig()
        assert config.include_domains == []
        assert config.exclude_domains == []

    def test_domain_fields_accept_lists(self):
        config = TavilyWebSearchToolConfig(
            include_domains=["ris.bka.gv.at"],
            exclude_domains=["example.com"],
        )
        assert config.include_domains == ["ris.bka.gv.at"]
        assert config.exclude_domains == ["example.com"]

    def test_inherits_from_function_base_config(self):
        from nat.data_models.function import FunctionBaseConfig

        assert issubclass(TavilyWebSearchToolConfig, FunctionBaseConfig)


class TestDomainFilterKwargs:
    async def test_domains_omitted_kwargs_absent(self, fake_langchain_tavily):
        config = TavilyWebSearchToolConfig(api_key=SecretStr("tvly-cfg"))
        await _run_search(config)

        kwargs = _construction_kwargs(fake_langchain_tavily)
        assert "include_domains" not in kwargs
        assert "exclude_domains" not in kwargs

    async def test_include_domains_set_kwarg_present(self, fake_langchain_tavily):
        config = TavilyWebSearchToolConfig(include_domains=["ris.bka.gv.at", "eur-lex.europa.eu"])
        await _run_search(config)

        kwargs = _construction_kwargs(fake_langchain_tavily)
        assert kwargs["include_domains"] == ["ris.bka.gv.at", "eur-lex.europa.eu"]
        assert "exclude_domains" not in kwargs

    async def test_exclude_domains_set_kwarg_present(self, fake_langchain_tavily):
        config = TavilyWebSearchToolConfig(exclude_domains=["spam.example"])
        await _run_search(config)

        kwargs = _construction_kwargs(fake_langchain_tavily)
        assert kwargs["exclude_domains"] == ["spam.example"]
        assert "include_domains" not in kwargs

    async def test_both_domain_lists_set(self, fake_langchain_tavily):
        config = TavilyWebSearchToolConfig(
            include_domains=["a.example"],
            exclude_domains=["b.example"],
        )
        await _run_search(config)

        kwargs = _construction_kwargs(fake_langchain_tavily)
        assert kwargs["include_domains"] == ["a.example"]
        assert kwargs["exclude_domains"] == ["b.example"]

    async def test_empty_lists_kwargs_absent(self, fake_langchain_tavily):
        # Explicitly empty lists must behave like the default: no restriction.
        config = TavilyWebSearchToolConfig(include_domains=[], exclude_domains=[])
        await _run_search(config)

        kwargs = _construction_kwargs(fake_langchain_tavily)
        assert "include_domains" not in kwargs
        assert "exclude_domains" not in kwargs

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


def _override_setting(monkeypatch, values):
    """Patch the platform retrieval-settings resolver: only the listed keys are
    overridden, every other key falls through to its config fallback — exactly
    what the real resolver does for unpinned keys."""
    from aiq_agent.common import retrieval_settings

    def fake_get(key, fallback):
        return values.get(key, fallback)

    monkeypatch.setattr(retrieval_settings, "get_retrieval_setting", fake_get)


class TestPlatformMaxResultsOverride:
    """The web-search result count comes from Platform → Retrieval when pinned
    there, and falls back to the YAML config value otherwise."""

    async def test_platform_override_builds_a_one_off_client(self, fake_langchain_tavily, monkeypatch):
        _override_setting(monkeypatch, {"web.max_results": 7})

        output = await _run_search(TavilyWebSearchToolConfig(max_results=5))

        assert fake_langchain_tavily.call_count == 2
        _, second_kwargs = fake_langchain_tavily.call_args_list[1]
        assert second_kwargs["max_results"] == 7
        assert "https://a.example" in output

    async def test_no_override_reuses_the_shared_client(self, fake_langchain_tavily):
        output = await _run_search(TavilyWebSearchToolConfig(max_results=5))

        kwargs = _construction_kwargs(fake_langchain_tavily)
        assert kwargs["max_results"] == 5
        assert "https://a.example" in output

    async def test_advanced_search_uses_the_advanced_key(self, fake_langchain_tavily, monkeypatch):
        _override_setting(monkeypatch, {"web.advanced_max_results": 4})

        await _run_search(TavilyWebSearchToolConfig(max_results=2, advanced_search=True))

        assert fake_langchain_tavily.call_count == 2
        _, second_kwargs = fake_langchain_tavily.call_args_list[1]
        assert second_kwargs["max_results"] == 4
        assert second_kwargs["search_depth"] == "advanced"

    async def test_resolver_failure_falls_back_to_config(self, fake_langchain_tavily, monkeypatch):
        from aiq_agent.common import retrieval_settings

        def boom(key, fallback):
            raise RuntimeError("BFF unreachable")

        monkeypatch.setattr(retrieval_settings, "get_retrieval_setting", boom)

        output = await _run_search(TavilyWebSearchToolConfig(max_results=5))

        kwargs = _construction_kwargs(fake_langchain_tavily)
        assert kwargs["max_results"] == 5
        assert "https://a.example" in output

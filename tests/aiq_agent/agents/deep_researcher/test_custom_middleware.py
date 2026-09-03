"""Tests for custom middleware."""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage

from aiq_agent.agents.deep_researcher.custom_middleware import DeferredStructuredOutputMiddleware
from aiq_agent.agents.deep_researcher.custom_middleware import SelectiveToolRetryMiddleware
from aiq_agent.agents.deep_researcher.custom_middleware import SourceRegistryMiddleware
from aiq_agent.agents.deep_researcher.custom_middleware import ToolNameSanitizationMiddleware
from aiq_agent.agents.deep_researcher.custom_middleware import ToolVisibilityMiddleware
from aiq_agent.agents.deep_researcher.custom_middleware import is_retryable_tool_error
from aiq_agent.agents.deep_researcher.models import ResearchNotes
from aiq_agent.agents.deep_researcher.tools.source_registry import build_get_verified_sources_tool
from aiq_agent.common.budget_guard import RunBudgetExceededError
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.cost_tracking import BudgetExceededError
from aiq_agent.common.data_source_registry import populate_from_config
from aiq_agent.common.data_source_registry import reset_registry


class TestToolNameSanitizationMiddleware:
    """Tests for ToolNameSanitizationMiddleware."""

    @pytest.fixture
    def valid_tool_names(self):
        return ["advanced_web_search_tool", "paper_search_tool", "read_file", "write_file", "grep", "glob", "think"]

    @pytest.fixture
    def middleware(self, valid_tool_names):
        return ToolNameSanitizationMiddleware(valid_tool_names=valid_tool_names)

    def test_sanitize_channel_suffix(self, middleware):
        """Strip <|channel|> and everything after it."""
        assert (
            middleware._sanitize_tool_name("advanced_web_search_tool<|channel|>commentary")
            == "advanced_web_search_tool"
        )

    def test_sanitize_channel_json_suffix(self, middleware):
        """Strip <|channel|>json suffix."""
        assert middleware._sanitize_tool_name("advanced_web_search_tool<|channel|>json") == "advanced_web_search_tool"

    def test_sanitize_dot_suffix(self, middleware):
        """Strip .commentary suffix when base name is valid."""
        assert middleware._sanitize_tool_name("advanced_web_search_tool.commentary") == "advanced_web_search_tool"

    def test_sanitize_dot_exec_suffix(self, middleware):
        """Strip .exec suffix when base name is valid."""
        assert middleware._sanitize_tool_name("advanced_web_search_tool.exec") == "advanced_web_search_tool"

    def test_sanitize_paper_search_channel(self, middleware):
        """Strip channel suffix from paper_search_tool too."""
        assert middleware._sanitize_tool_name("paper_search_tool<|channel|>commentary") == "paper_search_tool"

    def test_map_open_file_to_read_file(self, middleware):
        """Map hallucinated open_file to read_file."""
        assert middleware._sanitize_tool_name("open_file") == "read_file"

    def test_map_find_to_grep(self, middleware):
        """Map hallucinated find to grep."""
        assert middleware._sanitize_tool_name("find") == "grep"

    def test_map_find_file_to_glob(self, middleware):
        """Map hallucinated find_file to glob."""
        assert middleware._sanitize_tool_name("find_file") == "glob"

    def test_passthrough_valid_name(self, middleware):
        """Valid tool names pass through unchanged."""
        assert middleware._sanitize_tool_name("advanced_web_search_tool") == "advanced_web_search_tool"

    def test_passthrough_unknown_invalid_name(self, middleware):
        """Unknown invalid names pass through unchanged (let framework report the error)."""
        assert middleware._sanitize_tool_name("totally_fake_tool") == "totally_fake_tool"

    def test_dot_suffix_with_invalid_base_passes_through(self, middleware):
        """Dot suffix stripping only applies when base name is valid."""
        assert middleware._sanitize_tool_name("fake_tool.commentary") == "fake_tool.commentary"

    @pytest.mark.asyncio
    async def test_awrap_model_call_sanitizes_tool_calls(self, middleware):
        """Integration: middleware sanitizes tool_calls in AIMessage."""
        from langchain.agents.middleware.types import ModelResponse

        ai_msg = AIMessage(
            content="",
            tool_calls=[
                {"name": "advanced_web_search_tool<|channel|>commentary", "args": {"question": "test"}, "id": "tc1"},
            ],
        )
        mock_response = ModelResponse(result=[ai_msg])
        mock_handler = AsyncMock(return_value=mock_response)
        mock_request = MagicMock()

        result = await middleware.awrap_model_call(mock_request, mock_handler)

        assert result.result[0].tool_calls[0]["name"] == "advanced_web_search_tool"

    @pytest.mark.asyncio
    async def test_awrap_model_call_preserves_message_metadata(self, middleware):
        """Sanitizing tool names keeps usage/metadata fields for usage accounting."""
        from langchain.agents.middleware.types import ModelResponse

        ai_msg = AIMessage(
            content="",
            tool_calls=[
                {"name": "advanced_web_search_tool.exec", "args": {"question": "test"}, "id": "tc1"},
            ],
            id="msg-1",
            usage_metadata={"input_tokens": 11, "output_tokens": 7, "total_tokens": 18},
            additional_kwargs={"reasoning_content": "thinking..."},
            response_metadata={"model_name": "test-model", "token_usage": {"prompt_tokens": 11}},
        )
        mock_response = ModelResponse(result=[ai_msg])
        mock_handler = AsyncMock(return_value=mock_response)

        result = await middleware.awrap_model_call(MagicMock(), mock_handler)

        sanitized = result.result[0]
        assert sanitized.tool_calls[0]["name"] == "advanced_web_search_tool"
        assert sanitized.id == "msg-1"
        assert sanitized.content == ""
        assert sanitized.usage_metadata == {"input_tokens": 11, "output_tokens": 7, "total_tokens": 18}
        assert sanitized.additional_kwargs == {"reasoning_content": "thinking..."}
        assert sanitized.response_metadata == {"model_name": "test-model", "token_usage": {"prompt_tokens": 11}}

    @pytest.mark.asyncio
    async def test_awrap_model_call_no_tool_calls_passthrough(self, middleware):
        """Messages without tool_calls pass through unchanged."""
        from langchain.agents.middleware.types import ModelResponse

        ai_msg = AIMessage(content="Just text, no tools")
        mock_response = ModelResponse(result=[ai_msg])
        mock_handler = AsyncMock(return_value=mock_response)
        mock_request = MagicMock()

        result = await middleware.awrap_model_call(mock_request, mock_handler)

        assert result.result[0].content == "Just text, no tools"
        assert not result.result[0].tool_calls


class TestSelectiveToolRetryMiddleware:
    """Tests for retry exclusions on deliberate tool error signals."""

    def _middleware(self, **kwargs) -> SelectiveToolRetryMiddleware:
        return SelectiveToolRetryMiddleware(
            max_retries=3,
            backoff_factor=0.0,
            initial_delay=0.0,
            jitter=False,
            retry_on=is_retryable_tool_error,
            no_retry_tools={"run_research_batch"},
            **kwargs,
        )

    def _request(self, tool_name: str):
        request = MagicMock()
        request.tool = SimpleNamespace(name=tool_name)
        request.tool_call = {"name": tool_name, "id": "tc1"}
        return request

    @pytest.mark.asyncio
    async def test_no_retry_tool_error_reaches_model_without_re_execution(self):
        """run_research_batch failures are never re-executed below the LLM."""
        middleware = self._middleware()
        error = RuntimeError("run_research_batch failed for 1 of 3 researcher worker(s)")
        handler = AsyncMock(side_effect=error)

        result = await middleware.awrap_tool_call(self._request("run_research_batch"), handler)

        handler.assert_awaited_once()
        assert isinstance(result, ToolMessage)
        assert result.status == "error"
        assert "run_research_batch failed for 1 of 3 researcher worker(s)" in result.content

    @pytest.mark.asyncio
    async def test_no_retry_tool_success_passes_through(self):
        """Successful no-retry tool calls return the handler result unchanged."""
        middleware = self._middleware()
        message = ToolMessage(content="[]", tool_call_id="tc1")
        handler = AsyncMock(return_value=message)

        result = await middleware.awrap_tool_call(self._request("run_research_batch"), handler)

        handler.assert_awaited_once()
        assert result is message

    @pytest.mark.asyncio
    async def test_value_error_is_never_retried(self):
        """Deliberate ValueError signals reach the model immediately on any tool."""
        middleware = self._middleware()
        error = ValueError("run_research_batch accepts at most 6 curated queries")
        handler = AsyncMock(side_effect=error)

        result = await middleware.awrap_tool_call(self._request("web_search_tool"), handler)

        handler.assert_awaited_once()
        assert isinstance(result, ToolMessage)
        assert result.status == "error"
        assert "accepts at most 6 curated queries" in result.content

    @pytest.mark.asyncio
    async def test_transient_error_on_other_tools_is_retried(self):
        """Genuinely transient failures on regular tools keep retrying."""
        middleware = self._middleware()
        handler = AsyncMock(
            side_effect=[
                RuntimeError("connection reset"),
                ToolMessage(content="recovered", tool_call_id="tc1"),
            ]
        )

        result = await middleware.awrap_tool_call(self._request("web_search_tool"), handler)

        assert handler.await_count == 2
        assert result.content == "recovered"

    def test_sync_no_retry_tool_error_reaches_model_without_re_execution(self):
        """The sync path mirrors the async no-retry behavior."""
        middleware = self._middleware()
        handler = MagicMock(side_effect=RuntimeError("partial batch failure"))

        result = middleware.wrap_tool_call(self._request("run_research_batch"), handler)

        handler.assert_called_once()
        assert isinstance(result, ToolMessage)
        assert result.status == "error"
        assert "partial batch failure" in result.content


class TestBudgetExhaustionIsTerminal:
    """Backlog item 2 ratchet: budget exhaustion is terminal, never a retryable ToolMessage.

    ``RunBudgetExceededError`` (token ceiling) raised inside ``run_research_batch``
    used to fall into ``except Exception -> _handle_failure`` and return as
    "failed after 1 attempt ... Please try again", so the orchestrator resubmitted
    into an already-exceeded tracker until the wall clock. It must propagate so the
    run salvages once, marked, instead of looping.
    """

    def _middleware(self, **kwargs) -> SelectiveToolRetryMiddleware:
        return SelectiveToolRetryMiddleware(
            max_retries=3,
            backoff_factor=0.0,
            initial_delay=0.0,
            jitter=False,
            retry_on=is_retryable_tool_error,
            no_retry_tools={"run_research_batch"},
            **kwargs,
        )

    def _request(self, tool_name: str):
        request = MagicMock()
        request.tool = SimpleNamespace(name=tool_name)
        request.tool_call = {"name": tool_name, "id": "tc1"}
        return request

    def test_is_retryable_rejects_token_budget(self):
        assert is_retryable_tool_error(RunBudgetExceededError(ceiling=1000, used=1500)) is False

    def test_is_retryable_rejects_usd_budget(self):
        assert is_retryable_tool_error(BudgetExceededError(scope="organization")) is False

    @pytest.mark.asyncio
    async def test_no_retry_tool_budget_propagates_without_tool_message(self):
        """The batch path: one execution, no ToolMessage, no retry loop."""
        middleware = self._middleware()
        handler = AsyncMock(side_effect=RunBudgetExceededError(ceiling=1000, used=1500))

        with pytest.raises(RunBudgetExceededError):
            await middleware.awrap_tool_call(self._request("run_research_batch"), handler)

        handler.assert_awaited_once()

    def test_sync_no_retry_tool_budget_propagates(self):
        middleware = self._middleware()
        handler = MagicMock(side_effect=RunBudgetExceededError(ceiling=1000, used=1500))

        with pytest.raises(RunBudgetExceededError):
            middleware.wrap_tool_call(self._request("run_research_batch"), handler)

        handler.assert_called_once()

    @pytest.mark.asyncio
    async def test_regular_tool_budget_is_not_retried(self):
        """Even off the no-retry list, a budget error must not burn retries."""
        middleware = self._middleware()
        handler = AsyncMock(side_effect=RunBudgetExceededError(ceiling=1000, used=1500))

        with pytest.raises(RunBudgetExceededError):
            await middleware.awrap_tool_call(self._request("web_search_tool"), handler)

        handler.assert_awaited_once()

    def test_handle_failure_reraises_budget_as_safety_net(self):
        """Exhausted-retry callers of _handle_failure still cannot launder a budget error."""
        middleware = self._middleware()

        with pytest.raises(RunBudgetExceededError):
            middleware._handle_failure(
                "run_research_batch",
                "tc1",
                RunBudgetExceededError(ceiling=1000, used=1500),
                4,
            )


class TestToolVisibilityMiddleware:
    """Tests for hiding tools from model requests."""

    def test_wrap_model_call_filters_hidden_tools(self):
        middleware = ToolVisibilityMiddleware(hidden_tool_names={"execute"})
        execute_tool = SimpleNamespace(name="execute")
        read_file_tool = SimpleNamespace(name="read_file")
        mock_request = MagicMock()
        mock_request.tools = [execute_tool, read_file_tool, {"function": {"name": "execute"}}]
        filtered_request = MagicMock()
        mock_request.override.return_value = filtered_request
        mock_handler = MagicMock(return_value="ok")

        result = middleware.wrap_model_call(mock_request, mock_handler)

        assert result == "ok"
        mock_request.override.assert_called_once_with(tools=[read_file_tool])
        mock_handler.assert_called_once_with(filtered_request)

    @pytest.mark.asyncio
    async def test_awrap_model_call_filters_hidden_tools(self):
        middleware = ToolVisibilityMiddleware(hidden_tool_names={"execute"})
        execute_tool = SimpleNamespace(name="execute")
        read_file_tool = SimpleNamespace(name="read_file")
        mock_request = MagicMock()
        mock_request.tools = [execute_tool, read_file_tool, {"function": {"name": "execute"}}]
        filtered_request = MagicMock()
        mock_request.override.return_value = filtered_request
        mock_handler = AsyncMock(return_value="ok")

        result = await middleware.awrap_model_call(mock_request, mock_handler)

        assert result == "ok"
        mock_request.override.assert_called_once_with(tools=[read_file_tool])
        mock_handler.assert_awaited_once_with(filtered_request)


class TestSourceRegistryMiddleware:
    """Tests for SourceRegistryMiddleware allowlist + source extraction."""

    @pytest.fixture
    def source_tools(self):
        return {"advanced_web_search_tool", "knowledge_search", "paper_search_tool"}

    @pytest.fixture(autouse=True)
    def _reset_data_source_registry(self):
        """Keep the global data_source_registry clean across tests.

        Tests that need a populated registry either depend on
        ``_default_data_sources`` (via the ``middleware`` fixture) or
        populate their own registry explicitly in the test body.
        """
        reset_registry()
        yield
        reset_registry()

    @pytest.fixture
    def _default_data_sources(self):
        """Populate the three default data sources used by the shared tests."""
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web for real-time information.",
                    "tools": ["advanced_web_search_tool"],
                },
                {
                    "id": "knowledge_layer",
                    "name": "Knowledge Base",
                    "description": "Search uploaded documents and files.",
                    "tools": ["knowledge_search"],
                },
                {
                    "id": "paper_search",
                    "name": "Academic Papers",
                    "description": "Search academic papers.",
                    "tools": ["paper_search_tool"],
                },
            ]
        )

    @pytest.fixture
    def middleware(self, source_tools, _default_data_sources):
        return SourceRegistryMiddleware(source_tool_names=source_tools)

    def _make_request(self, tool_name: str):
        req = MagicMock()
        req.tool_call = {"name": tool_name}
        return req

    def _make_tool_result(self, content: str):
        return ToolMessage(content=content, tool_call_id="tc1")

    # -- URL extraction --

    @pytest.mark.asyncio
    async def test_url_source_captured(self, middleware):
        """URLs in tool output are extracted and registered."""
        content = "Found result at https://arxiv.org/abs/2401.00001"
        handler = AsyncMock(return_value=self._make_tool_result(content))
        request = self._make_request("advanced_web_search_tool")

        await middleware.awrap_tool_call(request, handler)

        sources = middleware.registry.all_sources()
        assert len(sources) == 1
        assert sources[0].url == "https://arxiv.org/abs/2401.00001"

    @pytest.mark.asyncio
    async def test_multiple_urls_captured(self, middleware):
        """Multiple URLs from a single tool call are all captured."""
        content = "Result from https://a.com/page and also https://b.com/page"
        handler = AsyncMock(return_value=self._make_tool_result(content))
        request = self._make_request("advanced_web_search_tool")

        await middleware.awrap_tool_call(request, handler)

        urls = {s.url for s in middleware.registry.all_sources()}
        assert urls == {"https://a.com/page", "https://b.com/page"}

    @pytest.mark.asyncio
    async def test_knowledge_layer_citation_key_captured(self, middleware):
        """Knowledge layer citation keys are captured via regex."""
        content = (
            "--- Result 1 ---\n"
            "Source: report.pdf\n"
            "Page: 5\n"
            "Citation: report.pdf, p.5\n"
            "Content Type: pdf\n"
            "\nSome content here."
        )
        handler = AsyncMock(return_value=self._make_tool_result(content))
        request = self._make_request("knowledge_search")

        await middleware.awrap_tool_call(request, handler)

        sources = middleware.registry.all_sources()
        assert len(sources) == 1
        assert sources[0].citation_key == "report.pdf, p.5"

    # -- Allowlist filtering --

    @pytest.mark.asyncio
    async def test_think_tool_ignored(self, middleware):
        """Internal tools not in the allowlist are ignored."""
        content = "Thinking about https://hallucinated.com"
        handler = AsyncMock(return_value=self._make_tool_result(content))
        request = self._make_request("think")

        await middleware.awrap_tool_call(request, handler)

        assert len(middleware.registry.all_sources()) == 0

    @pytest.mark.asyncio
    async def test_unknown_tool_ignored(self, middleware):
        """Tools not in the allowlist are ignored."""
        content = "https://unknown.com/data"
        handler = AsyncMock(return_value=self._make_tool_result(content))
        request = self._make_request("some_random_tool")

        await middleware.awrap_tool_call(request, handler)

        assert len(middleware.registry.all_sources()) == 0

    @pytest.mark.asyncio
    async def test_allowlisted_tool_not_in_data_source_registry_is_still_captured(self):
        """Agent-loaded tools are captured even when not declared under data_sources.

        Tools may be passed directly to the agent (programmatically or via
        `tools:` in YAML) without being declared under `data_sources:`. Their
        outputs are still real, citable evidence and must contribute to the
        citation registry.
        """
        # Autouse fixture already reset the registry; leave it empty.
        mw = SourceRegistryMiddleware(source_tool_names={"mcp_time__get_current_time"})
        content = "2026-05-11T14:30:00+09:00"
        handler = AsyncMock(return_value=self._make_tool_result(content))
        request = self._make_request("mcp_time__get_current_time")

        await mw.awrap_tool_call(request, handler)

        sources = mw.registry.all_sources()
        assert len(sources) == 1
        assert sources[0].citation_key == "mcp_time__get_current_time"
        assert sources[0].source_type == "tool_result"

    @pytest.mark.asyncio
    async def test_registered_group_tool_without_urls_captured(self):
        """Registered group child tools without URLs can be non-URL citation sources."""
        populate_from_config(
            [
                {
                    "id": "mcp_time",
                    "name": "MCP Time",
                    "description": "Get current time and timezone information through MCP.",
                    "tools": ["mcp_time"],
                }
            ],
            group_names={"mcp_time"},
        )
        mw = SourceRegistryMiddleware(source_tool_names={"mcp_time__get_current_time"})
        content = "2026-05-11T14:30:00+09:00"
        handler = AsyncMock(return_value=self._make_tool_result(content))
        request = self._make_request("mcp_time__get_current_time")

        await mw.awrap_tool_call(request, handler)

        sources = mw.registry.all_sources()
        assert len(sources) == 1
        assert sources[0].citation_key == "mcp_time__get_current_time"
        assert sources[0].source_type == "tool_result"

    @pytest.mark.asyncio
    async def test_registered_exact_data_source_tool_without_urls_captured(self):
        """Any exact tool declared under data_sources can be a non-URL citation source."""
        populate_from_config(
            [
                {
                    "id": "weather_observations",
                    "name": "Weather Observations",
                    "description": "Current observed weather conditions.",
                    "tools": ["weather_observation_tool"],
                }
            ]
        )
        mw = SourceRegistryMiddleware(source_tool_names={"weather_observation_tool"})
        content = "Current conditions for San Francisco: clear, 68F"
        handler = AsyncMock(return_value=self._make_tool_result(content))
        request = self._make_request("weather_observation_tool")

        await mw.awrap_tool_call(request, handler)

        sources = mw.registry.all_sources()
        assert len(sources) == 1
        assert sources[0].citation_key == "weather_observation_tool"
        assert sources[0].source_type == "tool_result"

    @pytest.mark.asyncio
    async def test_mixed_source_tools(self, middleware):
        """Multiple tool calls — only allowlisted tools contribute sources."""
        h1 = AsyncMock(return_value=self._make_tool_result("See https://a.com"))
        h2 = AsyncMock(return_value=self._make_tool_result("See https://b.com"))

        await middleware.awrap_tool_call(self._make_request("advanced_web_search_tool"), h1)
        await middleware.awrap_tool_call(self._make_request("paper_search_tool"), h2)

        urls = {s.url for s in middleware.registry.all_sources()}
        assert urls == {"https://a.com", "https://b.com"}

    def test_get_verified_sources_defaults_to_research_note_compact_subset(self, middleware):
        """The writer-facing source list prefers sources carried forward by ResearchNotes."""
        middleware.registry.add(SourceEntry(url="https://used.example/report", title="Used Report"))
        middleware.registry.add(SourceEntry(url="https://unused.example/report", title="Unused Report"))
        middleware.register_research_note_sources(
            [SimpleNamespace(sources=[SimpleNamespace(locator="https://used.example/report")])]
        )
        tool = build_get_verified_sources_tool(middleware)

        compact = tool.invoke({})
        full = tool.invoke({"mode": "full"})
        compact_entries = middleware.get_source_entries()
        full_entries = middleware.get_source_entries(mode="full")

        assert "https://used.example/report" in compact
        assert "https://unused.example/report" not in compact
        assert [entry.url for entry in compact_entries] == ["https://used.example/report"]
        assert "https://used.example/report" in full
        assert "https://unused.example/report" in full
        assert {entry.url for entry in full_entries} == {
            "https://used.example/report",
            "https://unused.example/report",
        }

    def test_get_verified_sources_compact_matches_internal_citation_keys(self, middleware):
        """Compact source filtering also works for URL-less internal citation keys."""
        middleware.registry.add(SourceEntry(citation_key="report.pdf, p.5", title="report.pdf"))
        middleware.registry.add(SourceEntry(citation_key="other.pdf, p.9", title="other.pdf"))
        middleware.register_research_note_sources(
            [SimpleNamespace(sources=[SimpleNamespace(locator="report.pdf, p.5")])]
        )
        tool = build_get_verified_sources_tool(middleware)

        compact = tool.invoke({})
        full = tool.invoke({"mode": "full"})

        assert "report.pdf, p.5" in compact
        assert "other.pdf, p.9" not in compact
        assert "report.pdf, p.5" in full
        assert "other.pdf, p.9" in full

    def test_compact_internal_citation_matches_across_pages(self, middleware):
        """A note citing a different page of a registered document still rescues it.

        The registry dedups knowledge-layer entries per file and keeps the
        first-seen page (p.3); notes may carry any page of the same document
        (p.12). Matching is per filename, not per full locator string.
        """
        middleware.registry.add(SourceEntry(citation_key="handbuch.pdf, p.3", title="handbuch.pdf"))
        middleware.registry.add(SourceEntry(citation_key="other.pdf, p.9", title="other.pdf"))
        middleware.register_research_note_sources(
            [SimpleNamespace(sources=[SimpleNamespace(locator="handbuch.pdf, p.12")])]
        )

        compact_entries = middleware.get_source_entries()

        assert [entry.citation_key for entry in compact_entries] == ["handbuch.pdf, p.3"]
        compact = middleware.get_source_list_text()
        assert "handbuch.pdf, p.3" in compact
        assert "other.pdf" not in compact

    # -- Edge cases --

    @pytest.mark.asyncio
    async def test_empty_content_skipped(self, middleware):
        """Empty content is ignored gracefully."""
        handler = AsyncMock(return_value=self._make_tool_result(""))
        request = self._make_request("advanced_web_search_tool")

        await middleware.awrap_tool_call(request, handler)

        assert len(middleware.registry.all_sources()) == 0

    @pytest.mark.asyncio
    async def test_non_tool_message_passthrough(self, middleware):
        """Non-ToolMessage results pass through without error."""
        handler = AsyncMock(return_value=AIMessage(content="just an AI reply"))
        request = self._make_request("advanced_web_search_tool")

        result = await middleware.awrap_tool_call(request, handler)

        assert isinstance(result, AIMessage)
        assert len(middleware.registry.all_sources()) == 0

    @pytest.mark.asyncio
    async def test_default_empty_allowlist_captures_nothing(self):
        """Middleware with no source_tool_names captures nothing."""
        mw = SourceRegistryMiddleware()
        content = "See https://should-not-be-captured.com"
        handler = AsyncMock(return_value=ToolMessage(content=content, tool_call_id="tc1"))
        request = MagicMock()
        request.tool_call = {"name": "advanced_web_search_tool"}

        await mw.awrap_tool_call(request, handler)

        assert len(mw.registry.all_sources()) == 0

    @pytest.mark.asyncio
    async def test_content_returned_unchanged(self, middleware):
        """Tool result content is not modified by the middleware."""
        content = "Results from https://example.com/page"
        handler = AsyncMock(return_value=self._make_tool_result(content))
        request = self._make_request("advanced_web_search_tool")

        result = await middleware.awrap_tool_call(request, handler)

        assert result.content == content


class _FakeModelRequest:
    """Minimal stand-in for the ModelRequest the middleware sees (messages + override)."""

    def __init__(self, messages, response_format=None):
        self.messages = messages
        self.response_format = response_format

    def override(self, *, messages=None, response_format=None):
        return _FakeModelRequest(
            self.messages if messages is None else messages,
            self.response_format if response_format is None else response_format,
        )


class TestDeferredStructuredOutputMiddleware:
    """Strict structured output must bind only on the agent's exit turn (backlog T2-8).

    Binding response_format on every tool-loop call makes constrained decoders
    answer immediately with no tool calls; the middleware keeps the loop
    format-free and re-issues only the final, no-tool-call turn with the
    strict schema.
    """

    @pytest.fixture
    def middleware(self):
        return DeferredStructuredOutputMiddleware(ResearchNotes)

    @pytest.mark.asyncio
    async def test_tool_call_turn_passes_through_without_formatting(self, middleware):
        """A response with tool calls continues the loop untouched."""
        draft = AIMessage(content="", tool_calls=[{"name": "ris_search_tool", "args": {}, "id": "c1"}])
        response = SimpleNamespace(result=[draft], structured_response=None)
        handler = AsyncMock(return_value=response)

        result = await middleware.awrap_model_call(_FakeModelRequest([HumanMessage(content="q")]), handler)

        assert result is response
        handler.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_non_ai_last_message_passes_through(self, middleware):
        response = SimpleNamespace(
            result=[ToolMessage(content="t", tool_call_id="c1")],
            structured_response=None,
        )
        handler = AsyncMock(return_value=response)

        result = await middleware.awrap_model_call(_FakeModelRequest([HumanMessage(content="q")]), handler)

        assert result is response
        handler.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_exit_turn_reissues_with_draft_and_strict_schema(self, middleware):
        """The first no-tool-call turn is re-issued with the draft appended and the strict schema."""
        request = _FakeModelRequest([HumanMessage(content="q")])
        draft = AIMessage(content="researched findings ...")
        first = SimpleNamespace(result=[draft], structured_response=None)
        formatted = SimpleNamespace(
            result=[AIMessage(content='{"query_topic": "t"}')],
            structured_response={"query_topic": "t"},
        )
        handler = AsyncMock(side_effect=[first, formatted])

        result = await middleware.awrap_model_call(request, handler)

        assert result is formatted
        assert handler.await_count == 2
        second_request = handler.await_args_list[1].args[0]
        assert second_request.response_format is middleware.strategy
        assert second_request.messages[-1] is draft
        assert second_request.messages[:-1] == request.messages

    @pytest.mark.asyncio
    async def test_formatting_failure_returns_draft_for_content_fallback(self, middleware):
        """A provider schema rejection must not lose the researched draft."""
        draft = AIMessage(content='```json\n{"query_topic": "t"}\n```')
        first = SimpleNamespace(result=[draft], structured_response=None)
        handler = AsyncMock(side_effect=[first, RuntimeError("provider 400: schema rejected")])

        result = await middleware.awrap_model_call(_FakeModelRequest([HumanMessage(content="q")]), handler)

        assert result is first

    def test_strategy_is_strict_json_schema(self, middleware):
        """The deferred contract keeps the provider-native strict json_schema shape."""
        wire = middleware.strategy.to_model_kwargs()["response_format"]
        assert wire["type"] == "json_schema"
        assert wire["json_schema"]["strict"] is True

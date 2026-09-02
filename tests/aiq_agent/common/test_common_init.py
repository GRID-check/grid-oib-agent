"""Tests for common module __init__.py utilities."""

import os
import tempfile
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

from aiq_agent.common import DEFAULT_DATA_SOURCES
from aiq_agent.common import _create_chat_response
from aiq_agent.common import extract_messages_and_sources
from aiq_agent.common import filter_tools_by_sources
from aiq_agent.common import format_data_source_tools
from aiq_agent.common import get_checkpointer
from aiq_agent.common import is_postgres_dsn
from aiq_agent.common import is_verbose
from aiq_agent.common import parse_data_sources


class TestIsVerbose:
    """Tests for the is_verbose function."""

    def test_verbose_env_true_overrides_config_false(self):
        """Test that env var 'true' overrides config False."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": "true"}):
            assert is_verbose(config_verbose=False) is True

    def test_verbose_env_1_overrides_config_false(self):
        """Test that env var '1' overrides config False."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": "1"}):
            assert is_verbose(config_verbose=False) is True

    def test_verbose_env_yes_overrides_config_false(self):
        """Test that env var 'yes' overrides config False."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": "yes"}):
            assert is_verbose(config_verbose=False) is True

    def test_verbose_env_false_overrides_config_true(self):
        """Test that env var 'false' overrides config True."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": "false"}):
            assert is_verbose(config_verbose=True) is False

    def test_verbose_env_0_overrides_config_true(self):
        """Test that env var '0' overrides config True."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": "0"}):
            assert is_verbose(config_verbose=True) is False

    def test_verbose_env_no_overrides_config_true(self):
        """Test that env var 'no' overrides config True."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": "no"}):
            assert is_verbose(config_verbose=True) is False

    def test_verbose_env_empty_uses_config_true(self):
        """Test that empty env var falls back to config."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": ""}):
            assert is_verbose(config_verbose=True) is True

    def test_verbose_env_empty_uses_config_false(self):
        """Test that empty env var falls back to config False."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": ""}):
            assert is_verbose(config_verbose=False) is False

    def test_verbose_env_unset_uses_config_true(self):
        """Test that unset env var falls back to config True."""
        with patch.dict(os.environ, clear=True):
            os.environ.pop("AIQ_VERBOSE", None)
            assert is_verbose(config_verbose=True) is True

    def test_verbose_env_unset_uses_config_false(self):
        """Test that unset env var falls back to config False."""
        with patch.dict(os.environ, clear=True):
            os.environ.pop("AIQ_VERBOSE", None)
            assert is_verbose(config_verbose=False) is False

    def test_verbose_env_uppercase_true(self):
        """Test that uppercase 'TRUE' is recognized."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": "TRUE"}):
            assert is_verbose(config_verbose=False) is True

    def test_verbose_env_random_value_uses_config(self):
        """Test that random env value falls back to config."""
        with patch.dict(os.environ, {"AIQ_VERBOSE": "maybe"}):
            assert is_verbose(config_verbose=True) is True
            assert is_verbose(config_verbose=False) is False


class TestCreateChatResponse:
    """Tests for the _create_chat_response function."""

    def test_create_chat_response_basic(self):
        """Test basic chat response creation."""
        response = _create_chat_response("Hello, world!")

        assert response.id == "conversational_response"
        assert len(response.choices) == 1
        assert response.choices[0].message.content == "Hello, world!"
        assert response.choices[0].finish_reason == "stop"
        assert response.choices[0].index == 0

    def test_create_chat_response_custom_id(self):
        """Test chat response creation with custom ID."""
        response = _create_chat_response("Test content", response_id="custom_id")

        assert response.id == "custom_id"
        assert response.choices[0].message.content == "Test content"

    def test_create_chat_response_custom_model(self):
        """Test chat response creation with custom model."""
        response = _create_chat_response("Test content", model="deep_research_workflow")

        assert response.model == "deep_research_workflow"

    def test_create_chat_response_default_model(self):
        """Test chat response creation falls back to unknown-model."""
        response = _create_chat_response("Test content")

        assert response.model == "unknown-model"

    def test_create_chat_response_empty_content(self):
        """Test chat response with empty content."""
        response = _create_chat_response("")

        assert response.choices[0].message.content == ""

    def test_create_chat_response_long_content(self):
        """Test chat response with long content."""
        long_content = "A" * 10000
        response = _create_chat_response(long_content)

        assert response.choices[0].message.content == long_content
        assert len(response.choices[0].message.content) == 10000

    def test_create_chat_response_has_created_timestamp(self):
        """Test that response has a created timestamp."""
        response = _create_chat_response("Test")

        assert response.created is not None

    def test_create_chat_response_has_usage(self):
        """Test that response has usage field."""
        response = _create_chat_response("Test")

        assert response.usage is not None

    def test_create_chat_response_special_characters(self):
        """Test chat response with special characters."""
        special_content = "Hello\n\tWorld! 🌍 <script>alert('xss')</script>"
        response = _create_chat_response(special_content)

        assert response.choices[0].message.content == special_content

    def test_create_chat_response_unicode(self):
        """Test chat response with Unicode content."""
        unicode_content = "こんにちは世界 Привет мир مرحبا بالعالم"
        response = _create_chat_response(unicode_content)

        assert response.choices[0].message.content == unicode_content


class TestDataSourcesExports:
    """Tests to verify data sources utilities are properly exported."""

    def test_default_data_sources_exported(self):
        """Test DEFAULT_DATA_SOURCES is exported."""
        assert DEFAULT_DATA_SOURCES is not None
        assert isinstance(DEFAULT_DATA_SOURCES, list)
        assert "web_search" in DEFAULT_DATA_SOURCES

    def test_parse_data_sources_exported(self):
        """Test parse_data_sources is exported and functional."""
        result = parse_data_sources(["web_search"])
        assert result == ["web_search"]

    def test_filter_tools_by_sources_exported(self):
        """Test filter_tools_by_sources is exported and functional."""
        result = filter_tools_by_sources([], None)
        assert result == []

    def test_extract_messages_and_sources_exported(self):
        """Test extract_messages_and_sources is exported and functional."""
        from langchain_core.messages import HumanMessage

        messages = [HumanMessage(content="Test")]
        result_messages, result_sources = extract_messages_and_sources(messages)
        assert result_messages == messages
        assert result_sources is None

    def test_format_data_source_tools_exported(self):
        """Test format_data_source_tools is exported and functional."""
        result = format_data_source_tools(["web_search"])
        assert len(result) == 1
        # Falls back to title-cased ID when registry is empty
        assert result[0]["name"] == "Web Search"

    def test_get_all_tool_refs_exported(self):
        """Test get_all_tool_refs is exported."""
        from aiq_agent.common import get_all_tool_refs

        assert callable(get_all_tool_refs)

    def test_get_source_id_for_tool_exported(self):
        """Test get_source_id_for_tool is exported."""
        from aiq_agent.common import get_source_id_for_tool

        assert callable(get_source_id_for_tool)


class TestIsPostgresDsn:
    """Tests for the is_postgres_dsn function."""

    def test_postgresql_scheme(self):
        """Test that postgresql:// scheme is recognized."""
        assert is_postgres_dsn("postgresql://user:pass@localhost:5432/db") is True

    def test_postgres_scheme(self):
        """Test that postgres:// scheme is recognized."""
        assert is_postgres_dsn("postgres://user:pass@localhost:5432/db") is True

    def test_sqlite_path_not_postgres(self):
        """Test that SQLite paths are not recognized as Postgres."""
        assert is_postgres_dsn("./checkpoints.db") is False
        assert is_postgres_dsn("/tmp/checkpoints.db") is False

    def test_empty_string(self):
        """Test that empty string is not Postgres."""
        assert is_postgres_dsn("") is False

    def test_http_url_not_postgres(self):
        """Test that HTTP URLs are not recognized as Postgres."""
        assert is_postgres_dsn("http://localhost:5432") is False
        assert is_postgres_dsn("https://example.com") is False

    def test_postgres_with_options(self):
        """Test Postgres DSN with connection options."""
        dsn = "postgresql://user:pass@localhost:5432/db?sslmode=require"
        assert is_postgres_dsn(dsn) is True

    def test_postgres_without_port(self):
        """Test Postgres DSN without explicit port."""
        assert is_postgres_dsn("postgresql://user:pass@localhost/db") is True


class TestGetCheckpointer:
    """Tests for the get_checkpointer function."""

    @pytest.fixture(autouse=True)
    def clear_checkpointer_cache(self):
        """Clear the checkpointer cache before each test."""
        import aiq_agent.common as common_module

        common_module._checkpointers.clear()
        common_module._postgres_pools.clear()
        yield
        common_module._checkpointers.clear()
        common_module._postgres_pools.clear()

    @staticmethod
    async def _close_sqlite_checkpointers():
        """Close cached SQLite connections so temp files can be deleted on Windows."""
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        import aiq_agent.common as common_module

        for checkpointer in common_module._checkpointers.values():
            if isinstance(checkpointer, AsyncSqliteSaver):
                await checkpointer.conn.close()

    @pytest.mark.asyncio
    async def test_sqlite_checkpointer_creation(self):
        """Test that SQLite checkpointer is created for file paths."""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name

        try:
            checkpointer = await get_checkpointer(db_path)

            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

            assert isinstance(checkpointer, AsyncSqliteSaver)
        finally:
            await self._close_sqlite_checkpointers()
            os.unlink(db_path)

    @pytest.mark.asyncio
    async def test_checkpointer_caching(self):
        """Test that checkpointers are cached and reused."""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name

        try:
            checkpointer1 = await get_checkpointer(db_path)
            checkpointer2 = await get_checkpointer(db_path)

            assert checkpointer1 is checkpointer2
        finally:
            await self._close_sqlite_checkpointers()
            os.unlink(db_path)

    @pytest.mark.asyncio
    async def test_different_paths_different_checkpointers(self):
        """Test that different paths create different checkpointers."""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f1:
            db_path1 = f1.name
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f2:
            db_path2 = f2.name

        try:
            checkpointer1 = await get_checkpointer(db_path1)
            checkpointer2 = await get_checkpointer(db_path2)

            assert checkpointer1 is not checkpointer2
        finally:
            await self._close_sqlite_checkpointers()
            os.unlink(db_path1)
            os.unlink(db_path2)

    @pytest.mark.asyncio
    async def test_postgres_checkpointer_creation(self):
        """Test that Postgres checkpointer is created for Postgres DSNs."""
        postgres_dsn = "postgresql://user:pass@localhost:5432/testdb"

        mock_pool = MagicMock()
        mock_checkpointer = MagicMock()
        mock_checkpointer.setup = AsyncMock()

        with (
            patch("aiq_agent.common.AsyncConnectionPool", return_value=mock_pool),
            patch("aiq_agent.common.AsyncPostgresSaver", return_value=mock_checkpointer),
        ):
            checkpointer = await get_checkpointer(postgres_dsn)

            assert checkpointer is mock_checkpointer
            mock_checkpointer.setup.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_postgres_pool_default_sizing(self, monkeypatch):
        """Pool defaults to min_size=1, max_size=10 (raised from the old hard-coded 3)."""
        monkeypatch.delenv("GRID_CHECKPOINT_POOL_MIN_SIZE", raising=False)
        monkeypatch.delenv("GRID_CHECKPOINT_POOL_MAX_SIZE", raising=False)
        mock_checkpointer = MagicMock()
        mock_checkpointer.setup = AsyncMock()
        with (
            patch("aiq_agent.common.AsyncConnectionPool", return_value=MagicMock()) as mock_pool_class,
            patch("aiq_agent.common.AsyncPostgresSaver", return_value=mock_checkpointer),
        ):
            await get_checkpointer("postgresql://user:pass@localhost:5432/testdb")
        kwargs = mock_pool_class.call_args.kwargs
        assert kwargs["min_size"] == 1
        assert kwargs["max_size"] == 10

    @pytest.mark.asyncio
    async def test_postgres_pool_sizing_env_override(self, monkeypatch):
        """Env vars override pool sizing; max is floored to min."""
        monkeypatch.setenv("GRID_CHECKPOINT_POOL_MIN_SIZE", "4")
        monkeypatch.setenv("GRID_CHECKPOINT_POOL_MAX_SIZE", "2")  # < min -> floored to min
        mock_checkpointer = MagicMock()
        mock_checkpointer.setup = AsyncMock()
        with (
            patch("aiq_agent.common.AsyncConnectionPool", return_value=MagicMock()) as mock_pool_class,
            patch("aiq_agent.common.AsyncPostgresSaver", return_value=mock_checkpointer),
        ):
            await get_checkpointer("postgresql://user:pass@localhost:5432/testdb")
        kwargs = mock_pool_class.call_args.kwargs
        assert kwargs["min_size"] == 4
        assert kwargs["max_size"] == 4

    @pytest.mark.asyncio
    async def test_postgres_pool_caching(self):
        """Test that Postgres pools are cached and reused."""
        postgres_dsn = "postgresql://user:pass@localhost:5432/testdb"

        mock_pool = MagicMock()
        mock_checkpointer = MagicMock()
        mock_checkpointer.setup = AsyncMock()

        with (
            patch("aiq_agent.common.AsyncConnectionPool", return_value=mock_pool) as mock_pool_class,
            patch("aiq_agent.common.AsyncPostgresSaver", return_value=mock_checkpointer),
        ):
            await get_checkpointer(postgres_dsn)

            import aiq_agent.common as common_module

            common_module._checkpointers.clear()

            await get_checkpointer(postgres_dsn)

            assert mock_pool_class.call_count == 1

    @pytest.mark.asyncio
    async def test_sqlite_serde_round_trips_all_state_types(self):
        """A fully-populated ChatResearcherState survives an AsyncSqliteSaver round-trip.

        Exercises the explicit msgpack allow-list serde: both custom pydantic
        state types (ShallowResult, AvailableDocument) plus messages must
        deserialize back equal.
        """
        import aiosqlite
        from langchain_core.messages import AIMessage
        from langchain_core.messages import HumanMessage
        from langgraph.checkpoint.base import empty_checkpoint
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        from aiq_agent.agents.chat_researcher.models.result import ShallowResult
        from aiq_agent.agents.chat_researcher.models.state import ChatResearcherState
        from aiq_agent.common import _build_checkpointer_serde
        from aiq_agent.knowledge.schema import AvailableDocument

        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name

        conn = await aiosqlite.connect(db_path)
        try:
            checkpointer = AsyncSqliteSaver(conn, serde=_build_checkpointer_serde())
            await checkpointer.setup()

            state = ChatResearcherState(
                messages=[HumanMessage(content="hi"), AIMessage(content="hello")],
                routing_decision="deep",
                shallow_result=ShallowResult(
                    answer="the answer",
                    confidence="low",
                    escalate_to_deep=True,
                    escalation_reason="insufficient",
                ),
                available_documents=[AvailableDocument(file_name="doc.txt", summary="s", tags=["oib"])],
                answer_confidence="high",
            )

            checkpoint = empty_checkpoint()
            checkpoint["channel_values"] = {
                "messages": state.messages,
                "routing_decision": state.routing_decision,
                "shallow_result": state.shallow_result,
                "available_documents": state.available_documents,
                "answer_confidence": state.answer_confidence,
            }
            config = {"configurable": {"thread_id": "t1", "checkpoint_ns": ""}}
            saved_config = await checkpointer.aput(config, checkpoint, {}, {})

            restored = (await checkpointer.aget_tuple(saved_config)).checkpoint["channel_values"]

            assert restored["routing_decision"] == "deep"
            assert restored["shallow_result"] == state.shallow_result
            assert isinstance(restored["shallow_result"], ShallowResult)
            assert restored["available_documents"] == state.available_documents
            assert isinstance(restored["available_documents"][0], AvailableDocument)
            assert restored["answer_confidence"] == "high"
            assert [m.content for m in restored["messages"]] == ["hi", "hello"]
        finally:
            await conn.close()
            os.unlink(db_path)

"""Tests for the DeepResearcherAgent."""

import asyncio
import contextlib
import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from deepagents.backends.protocol import FileUploadResponse
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from aiq_agent.agents.deep_researcher.custom_middleware import DeferredStructuredOutputMiddleware
from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.agents.deep_researcher.models import ResearchNotes
from aiq_agent.agents.deep_researcher.models import ResearchPlan
from aiq_agent.agents.deep_researcher.models import ResearchQuery
from aiq_agent.agents.deep_researcher.tools.research import build_research_batch_tool
from aiq_agent.agents.deep_researcher.tools.research import researcher_invoke_state
from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry


@tool
def web_search_tool(query: str) -> str:
    """Search the web for information."""
    return f"Results for: {query}"


# The shared per-run middleware stack (factory.build_common_middleware).
_COMMON_MIDDLEWARE_CLASSES = {
    "EmptyContentFixMiddleware",
    "ToolNameSanitizationMiddleware",
    "SelectiveToolRetryMiddleware",
    "SourceRegistryMiddleware",
    "ToolResultPruningMiddleware",
    "ModelRetryMiddleware",
}


@contextlib.contextmanager
def seeded_session_registry(*entries: SourceEntry):
    """Bind a session-scoped SourceRegistry pre-populated with entries.

    run() builds a fresh source registry middleware per run (ADR-0018), so tests
    that simulate mid-run captured sources must seed the session registry the
    same way the chat entrypoint binds one per conversation.
    """
    registry = SourceRegistry()
    for entry in entries:
        registry.add(entry)
    token = set_session_registry(registry)
    try:
        yield registry
    finally:
        reset_session_registry(token)


def output_markdown_file(markdown: str | None = None) -> dict:
    """Return virtual filesystem content for /shared/output.md."""
    return {
        "/shared/output.md": {
            "content": markdown or "Deep research answer [1].\n\n## Sources\n[1] Example: https://example.com",
            "encoding": "utf-8",
        }
    }


def streaming_graph_mock(*chunks, error: BaseException | None = None, hang: bool = False) -> MagicMock:
    """A mock compiled graph that STREAMS, the way run() now drives it.

    run() calls ``astream(state, config=..., stream_mode="values", ...)`` rather
    than ``ainvoke`` so a cut-off run still has the last graph state to salvage.
    The mock yields ``chunks`` in order (each one a full graph state, as
    ``stream_mode="values"`` produces), then optionally raises ``error`` or hangs
    forever so the wall-clock guard can fire. Call args land on ``.astream``, so
    config/durability assertions read from there.
    """
    graph = MagicMock()
    graph.with_config = MagicMock(return_value=graph)

    def _astream(*_args, **_kwargs):
        async def _generate():
            for chunk in chunks:
                yield chunk
            if error is not None:
                raise error
            if hang:
                await asyncio.sleep(3600)

        return _generate()

    graph.astream = MagicMock(side_effect=_astream)
    return graph


@pytest.fixture(autouse=True)
def mock_research_summarization_middleware():
    """Avoid requiring a concrete BaseChatModel for researcher runnable construction tests."""

    class FakeSummarizationMiddleware(AgentMiddleware):
        pass

    researcher_runnable = MagicMock(name="researcher_runnable")
    researcher_runnable.ainvoke = AsyncMock()
    with (
        patch(
            "aiq_agent.agents.deep_researcher.factory.create_summarization_middleware",
            return_value=FakeSummarizationMiddleware(),
        ) as summarization,
        patch(
            "aiq_agent.agents.deep_researcher.factory.create_agent",
            return_value=researcher_runnable,
        ) as create_researcher,
    ):
        yield {"summarization": summarization, "create_researcher": create_researcher}


class TestDeepResearcherAgent:
    """Tests for the DeepResearcherAgent class."""

    @pytest.fixture
    def mock_llm(self):
        """Create a mock LLM."""
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        """Create a mock LLM provider."""
        provider = LLMProvider()
        provider.set_default(mock_llm)
        provider.configure(LLMRole.ORCHESTRATOR, mock_llm)
        provider.configure(LLMRole.ROUTER, mock_llm)
        provider.configure(LLMRole.PLANNER, mock_llm)
        provider.configure(LLMRole.RESEARCHER, mock_llm)
        provider.configure(LLMRole.REPORT_WRITER, mock_llm)
        provider.get = MagicMock(wraps=provider.get)
        return provider

    @pytest.fixture
    def real_tool(self):
        """Create a real LangChain tool."""
        return web_search_tool

    def _build_batch_tool(self, agent, researcher_runnable, backend=None, researcher_tool_names=None):
        """Build a batch tool plus the run-scoped middleware it registers into.

        Mirrors _prepare_run(): the source registry middleware is per-run
        state, so tests construct one alongside the tool (ADR-0018). The
        researcher tool-name set mirrors the worker's real registry (source
        tools plus the always-present helper tools) so preferred_tools
        validation matches production.
        """
        from aiq_agent.agents.deep_researcher.custom_middleware import SourceRegistryMiddleware

        if researcher_tool_names is None:
            researcher_tool_names = set(agent.source_tool_names) | {"think", "get_verified_sources"}
        source_registry_middleware = SourceRegistryMiddleware(source_tool_names=agent.source_tool_names)
        batch_tool = build_research_batch_tool(
            researcher_runnable=researcher_runnable,
            backend=backend,
            callbacks=agent.callbacks,
            max_research_concurrency=agent.max_research_concurrency,
            researcher_tool_names=researcher_tool_names,
            source_registry_middleware=source_registry_middleware,
        )
        return batch_tool, source_registry_middleware

    def _structured_notes_response(self, query_topic: str = "Research Topic"):
        return {
            "structured_response": {
                "query_topic": query_topic,
                "target_components": ["overview"],
                "summary": "A useful note.",
                "findings": [
                    {
                        "claim": "A fact.",
                        "evidence": "Evidence from https://example.test/source.",
                        "source_ids": [1],
                        "confidence": "high",
                        "caveats": [],
                    }
                ],
                "gaps": [],
                "sources": [
                    {
                        "id": 1,
                        "title": "Source",
                        "source_type": "url",
                        "locator": "https://example.test/source",
                    }
                ],
                "narrative_notes": "Useful narrative notes.",
                "language": "English",
                "evidence_judgment": None,
            }
        }

    @pytest.fixture
    def mock_create_deep_agent(self):
        """Create a mock for create_deep_agent (deepagents)."""
        return streaming_graph_mock(
            {
                "messages": [AIMessage(content="Deep research answer")],
                "files": output_markdown_file(),
            }
        )

    def test_init_with_defaults(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """Test DeepResearcherAgent initialization with defaults."""
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_create_deep_agent,
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
            )

            assert agent.llm_provider == mock_llm_provider
            assert len(agent.tools) == 1
            assert agent.verbose is True
            assert agent.callbacks == []
            assert agent.deepagents_runtime.skill_sources_for("orchestrator") is None
            assert agent.enable_source_router is True

    def test_init_with_custom_settings(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """Test DeepResearcherAgent initialization with custom settings."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
            from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSandboxConfig
            from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSkillsConfig

            callbacks = [MagicMock()]
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                verbose=False,
                callbacks=callbacks,
                enable_citation_verification=False,
                skills=DeepResearchSkillsConfig(agents={"researcher-agent": ("research",)}),
                sandbox=DeepResearchSandboxConfig(app_name="custom-aiq"),
                domain_catalog_path="configs/domain_catalogs/deep_research_domain_catalog.yml",
                enable_source_router=False,
                max_research_concurrency=2,
                max_concurrent_source_tool_calls=3,
                max_source_tool_batch_size=4,
            )

            assert agent.verbose is False
            assert agent.callbacks == callbacks
            assert agent.max_research_concurrency == 2
            assert agent.max_concurrent_source_tool_calls == 3
            assert agent.max_source_tool_batch_size == 4
            assert agent.domain_catalog_path == "configs/domain_catalogs/deep_research_domain_catalog.yml"
            assert agent.enable_source_router is False
            assert agent.enable_citation_verification is False
            assert agent.deepagents_runtime.skill_sources_for("orchestrator") is None
            assert agent.deepagents_runtime.skill_sources_for("researcher-agent") == ["/skills/research/"]

    def test_init_defaults_checkpointer_to_none(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """No checkpoint_db configured -> no durable checkpointer (current in-memory-only behavior)."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

            assert agent.checkpointer is None

    def test_init_stores_configured_checkpointer(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """An explicitly configured checkpointer is retained on the agent instance."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            fake_checkpointer = MagicMock(name="fake_checkpointer")
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                checkpointer=fake_checkpointer,
            )

            assert agent.checkpointer is fake_checkpointer

    def test_prepare_run_forwards_checkpointer_to_graph_builder(
        self, mock_llm_provider, real_tool, mock_create_deep_agent
    ):
        """_prepare_run passes the configured checkpointer into build_deep_research_graph (T3-8)."""
        fake_checkpointer = MagicMock(name="fake_checkpointer")
        with patch(
            "aiq_agent.agents.deep_researcher.agent.build_deep_research_graph",
            return_value=mock_create_deep_agent,
        ) as build_graph:
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                checkpointer=fake_checkpointer,
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="q")])

            agent._prepare_run(state)

        assert build_graph.call_args.kwargs["checkpointer"] is fake_checkpointer

    def test_sandbox_config_rejects_unsupported_provider(self):
        """Unsupported sandbox providers fail early with a clear error."""
        from pydantic import ValidationError

        from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSandboxConfig

        with pytest.raises(ValidationError, match="Input should be 'modal'"):
            DeepResearchSandboxConfig(provider="not-modal")

    def test_register_uses_runtime_config_models(self):
        """NAT config uses the same skills and sandbox models as runtime."""
        from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSandboxConfig
        from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSkillsConfig
        from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig

        config = DeepResearchAgentConfig(
            orchestrator_llm="llm",
            source_router_llm="source-router-llm",
            writer_llm="writer-llm",
            enable_citation_verification=False,
            skills=DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)}),
            sandbox=DeepResearchSandboxConfig(app_name="custom-aiq", packages=["matplotlib", "pillow"]),
            max_research_concurrency=2,
            max_concurrent_source_tool_calls=3,
            max_source_tool_batch_size=4,
            domain_catalog_path="configs/domain_catalogs/deep_research_domain_catalog.yml",
            enable_source_router=False,
        )

        assert config.skills is not None
        assert config.skills.agents == {"writer-agent": ("synthesis",)}
        assert config.source_router_llm == "source-router-llm"
        assert config.writer_llm == "writer-llm"
        assert config.enable_citation_verification is False
        assert config.domain_catalog_path == "configs/domain_catalogs/deep_research_domain_catalog.yml"
        assert config.max_research_concurrency == 2
        assert config.max_concurrent_source_tool_calls == 3
        assert config.max_source_tool_batch_size == 4
        assert config.enable_source_router is False
        assert config.sandbox is not None
        assert config.sandbox.provider == "modal"
        assert config.sandbox.app_name == "custom-aiq"
        assert config.sandbox.packages == ("matplotlib", "pillow")

    def test_register_resolves_named_runtime_config_refs(self):
        """Deep research agent config can reference config-only skills and sandbox functions."""
        from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSandboxConfig
        from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSkillsConfig
        from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig
        from aiq_agent.agents.deep_researcher.register import resolve_deep_research_runtime_config

        skills = DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)})
        sandbox = DeepResearchSandboxConfig(app_name="custom-aiq")
        builder = MagicMock()
        builder.get_function_config.side_effect = {
            "deep_research_skills": skills,
            "deep_research_sandbox": sandbox,
        }.__getitem__
        config = DeepResearchAgentConfig(
            orchestrator_llm="llm",
            skills="deep_research_skills",
            sandbox="deep_research_sandbox",
        )

        resolved_skills, resolved_sandbox = resolve_deep_research_runtime_config(config, builder)

        assert resolved_skills is skills
        assert resolved_sandbox is sandbox

    def test_register_checkpoint_db_defaults_to_none(self):
        """checkpoint_db is opt-in; omitting it preserves current in-memory-only behavior (T3-8)."""
        from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig

        config = DeepResearchAgentConfig(orchestrator_llm="llm")

        assert config.checkpoint_db is None

    @pytest.mark.asyncio
    async def test_register_builds_checkpointer_when_checkpoint_db_configured(self):
        """A configured checkpoint_db resolves a durable checkpointer and threads it into the agent.

        Mirrors chat_researcher/register.py's ``get_checkpointer`` precedent: the checkpointer is built
        once via ``aiq_agent.common.get_checkpointer`` (cached by db path/DSN) and passed to every
        DeepResearcherAgent this registration builds.
        """
        import aiq_agent.common as common_module
        from aiq_agent.agents.deep_researcher import register as register_module
        from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig
        from aiq_agent.agents.deep_researcher.register import deep_research_agent

        fake_checkpointer = MagicMock(name="fake_checkpointer")
        get_checkpointer_mock = AsyncMock(return_value=fake_checkpointer)
        captured_kwargs = {}

        def _stub_agent(*args, **kwargs):
            captured_kwargs.update(kwargs)
            agent = MagicMock()
            agent.run = AsyncMock(side_effect=lambda state: state)
            return agent

        class _FakeBuilder:
            async def get_tools(self, tool_names, wrapper_type):
                return [web_search_tool] if "web_search_tool" in tool_names else []

            async def get_llm(self, ref, wrapper_type):
                return MagicMock()

            def get_function_config(self, ref):
                return None

        config = DeepResearchAgentConfig(
            orchestrator_llm="orch_llm",
            tools=["web_search_tool"],
            checkpoint_db="./deep_research_checkpoints.db",
        )

        with (
            patch.object(register_module, "DeepResearcherAgent", _stub_agent),
            patch.object(common_module, "get_checkpointer", get_checkpointer_mock),
        ):
            gen = deep_research_agent.__wrapped__(config, _FakeBuilder())
            await gen.__anext__()
            await gen.aclose()

        get_checkpointer_mock.assert_awaited_once_with("./deep_research_checkpoints.db")
        assert captured_kwargs["checkpointer"] is fake_checkpointer

    @pytest.mark.asyncio
    async def test_register_omits_checkpointer_when_checkpoint_db_unset(self):
        """Default (no checkpoint_db) behavior is unchanged: no get_checkpointer call, checkpointer=None."""
        import aiq_agent.common as common_module
        from aiq_agent.agents.deep_researcher import register as register_module
        from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig
        from aiq_agent.agents.deep_researcher.register import deep_research_agent

        get_checkpointer_mock = AsyncMock()
        captured_kwargs = {}

        def _stub_agent(*args, **kwargs):
            captured_kwargs.update(kwargs)
            agent = MagicMock()
            agent.run = AsyncMock(side_effect=lambda state: state)
            return agent

        class _FakeBuilder:
            async def get_tools(self, tool_names, wrapper_type):
                return [web_search_tool] if "web_search_tool" in tool_names else []

            async def get_llm(self, ref, wrapper_type):
                return MagicMock()

            def get_function_config(self, ref):
                return None

        config = DeepResearchAgentConfig(orchestrator_llm="orch_llm", tools=["web_search_tool"])

        with (
            patch.object(register_module, "DeepResearcherAgent", _stub_agent),
            patch.object(common_module, "get_checkpointer", get_checkpointer_mock),
        ):
            gen = deep_research_agent.__wrapped__(config, _FakeBuilder())
            await gen.__anext__()
            await gen.aclose()

        get_checkpointer_mock.assert_not_awaited()
        assert captured_kwargs["checkpointer"] is None

    def test_modal_sandbox_name_is_job_id(self):
        """Modal sandbox names use the resolved job ID directly."""
        from aiq_agent.agents.deep_researcher.deepagents_runtime import _validate_modal_sandbox_name

        assert _validate_modal_sandbox_name("job-123") == "job-123"

    def test_modal_sandbox_name_rejects_invalid_job_id(self):
        """Invalid custom job IDs fail before creating a Modal sandbox."""
        from aiq_agent.agents.deep_researcher.deepagents_runtime import _validate_modal_sandbox_name

        with pytest.raises(ValueError, match="valid Modal sandbox name"):
            _validate_modal_sandbox_name("bad/job/id")

    def test_init_without_tools(self, mock_llm_provider, mock_create_deep_agent):
        """Test DeepResearcherAgent initialization without tools."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=None,
            )

            assert agent.tools == []

    def test_load_prompts(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """Test _load_prompts loads all required prompts."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
            )

            # Should have planner, researcher, orchestrator, and writer prompts
            assert "planner" in agent._prompts
            assert "researcher" in agent._prompts
            assert "orchestrator" in agent._prompts
            assert "writer" in agent._prompts
            assert "source_router" in agent._prompts

    def test_build_orchestrator_passes_skills_to_writer_only(
        self,
        mock_llm_provider,
        real_tool,
        mock_create_deep_agent,
    ):
        """Only writer-agent receives synthesis skills when configured that way."""
        with (
            patch(
                "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
                return_value=mock_create_deep_agent,
            ) as create,
            patch(
                "aiq_agent.agents.deep_researcher.factory.create_agent",
                return_value=mock_create_deep_agent,
            ) as create_researcher,
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
            from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSkillsConfig

            synthesis_skill_source = "/skills/synthesis/"
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                skills=DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)}),
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Compare revenue growth")])

            agent._prepare_run(state)

            assert create.call_count == 1
            assert create_researcher.call_count == 1
            researcher_kwargs = create_researcher.call_args.kwargs
            kwargs = create.call_args.kwargs
            assert "response_format" not in researcher_kwargs
            researcher_deferred = [
                m for m in researcher_kwargs["middleware"] if isinstance(m, DeferredStructuredOutputMiddleware)
            ]
            assert [m.strategy.schema for m in researcher_deferred] == [ResearchNotes]
            researcher_middleware = researcher_kwargs["middleware"]
            assert not any(m.__class__.__name__ == "TodoListMiddleware" for m in researcher_middleware)
            researcher_skills = [m for m in researcher_middleware if m.__class__.__name__ == "SkillsMiddleware"]
            assert researcher_skills == []
            assert any(m.__class__.__name__ == "FilesystemMiddleware" for m in researcher_middleware)
            assert any(m.__class__.__name__ == "PatchToolCallsMiddleware" for m in researcher_middleware)
            assert _COMMON_MIDDLEWARE_CLASSES <= {m.__class__.__name__ for m in researcher_middleware}
            assert "skills" not in researcher_kwargs
            assert "backend" not in researcher_kwargs
            assert _COMMON_MIDDLEWARE_CLASSES <= {m.__class__.__name__ for m in kwargs["middleware"]}
            assert any(m.__class__.__name__ == "ToolVisibilityMiddleware" for m in kwargs["middleware"])
            assert "Mandatory skill use" in researcher_kwargs["system_prompt"]
            assert "The body is the method" in researcher_kwargs["system_prompt"]
            assert "read that skill's `SKILL.md`" in researcher_kwargs["system_prompt"]
            assert "data-table-analysis" not in researcher_kwargs["system_prompt"]
            assert "/shared/plan.json" in researcher_kwargs["system_prompt"]
            assert "read_file" in researcher_kwargs["system_prompt"]
            assert "SKILL.md" in researcher_kwargs["system_prompt"]
            assert "ResearchQuery.target_components" in researcher_kwargs["system_prompt"]
            assert "Evidence judgment" in researcher_kwargs["system_prompt"]
            assert "Do not call `write_file` or `edit_file`" in researcher_kwargs["system_prompt"]
            assert "write_file` filesystem tool exactly once" not in researcher_kwargs["system_prompt"]
            assert "After the `write_file` tool returns" not in researcher_kwargs["system_prompt"]
            assert "Default source budget per ResearchQuery" in researcher_kwargs["system_prompt"]
            assert "one primary source-tool call" in researcher_kwargs["system_prompt"]
            assert "at most one fallback or corroboration call" in researcher_kwargs["system_prompt"]
            assert "at most one extra targeted follow-up" in researcher_kwargs["system_prompt"]
            assert "Do not run every possible source angle" in researcher_kwargs["system_prompt"]
            assert "skills" not in kwargs
            assert not callable(kwargs["backend"])
            assert [tool.name for tool in kwargs["tools"]] == [
                "think",
                "get_verified_sources",
                "run_research_batch",
            ]
            assert real_tool.name not in {tool.name for tool in kwargs["tools"]}
            assert "Available Skills:" not in kwargs["system_prompt"]
            assert "Use read_file to load the relevant SKILL.md BEFORE writing any code" not in kwargs["system_prompt"]
            assert 'execute("python /workspace/[name].py")' not in kwargs["system_prompt"]
            assert "read_writer_context" not in kwargs["system_prompt"]
            assert "Shell commands cannot see `/shared/`" not in kwargs["system_prompt"]
            assert "to /shared/output.md" in kwargs["system_prompt"]
            assert "returns only a short completion marker" in kwargs["system_prompt"]
            assert "do not echo the full Markdown" in kwargs["system_prompt"]
            assert (
                "Never call `source-router-agent` and `planner-agent` in the same assistant turn"
                in kwargs["system_prompt"]
            )
            assert "Only after the source-router-agent tool result has returned" in kwargs["system_prompt"]
            assert "at most 6 full ResearchQuery objects per call" in kwargs["system_prompt"]
            assert "all needed queries in one call when there are 6 or fewer" in kwargs["system_prompt"]
            assert "fewest ordered batches" in kwargs["system_prompt"]
            assert "do not create smaller curated waves" in kwargs["system_prompt"]
            assert "Never repeat a covered query" in kwargs["system_prompt"]
            assert "revise only the invalid, failed, or missing ResearchQuery objects" in kwargs["system_prompt"]
            assert "max_batch_research_queries" not in kwargs["system_prompt"]
            assert "data-table-analysis" not in kwargs["system_prompt"]
            subagents = {subagent["name"]: subagent for subagent in kwargs["subagents"]}
            assert set(subagents) == {"source-router-agent", "planner-agent", "writer-agent"}
            assert "response_format" not in subagents["source-router-agent"]
            assert "skills" not in subagents["source-router-agent"]
            assert {tool.name for tool in subagents["source-router-agent"]["tools"]} == {"lookup_source_catalog"}
            assert "write_todos" in subagents["source-router-agent"]["system_prompt"]
            assert "Use at most two tool calls total" in subagents["source-router-agent"]["system_prompt"]
            assert real_tool.name not in {tool.name for tool in subagents["source-router-agent"]["tools"]}
            assert "response_format" not in subagents["planner-agent"]
            planner_deferred = [
                m for m in subagents["planner-agent"]["middleware"] if isinstance(m, DeferredStructuredOutputMiddleware)
            ]
            assert [m.strategy.schema for m in planner_deferred] == [ResearchPlan]
            assert "skills" not in subagents["planner-agent"]
            assert real_tool.name in {tool.name for tool in subagents["planner-agent"]["tools"]}
            assert "response_format" not in subagents["writer-agent"]
            assert [tool.name for tool in subagents["writer-agent"]["tools"]] == [
                "think",
                "get_verified_sources",
            ]
            assert real_tool.name not in {tool.name for tool in subagents["writer-agent"]["tools"]}
            assert _COMMON_MIDDLEWARE_CLASSES <= {m.__class__.__name__ for m in subagents["writer-agent"]["middleware"]}
            assert any(
                m.__class__.__name__ == "ToolVisibilityMiddleware" for m in subagents["writer-agent"]["middleware"]
            )
            assert subagents["writer-agent"]["skills"] == [synthesis_skill_source]
            assert "/skills/synthesis/" not in subagents["writer-agent"]["system_prompt"]
            assert "read_writer_context" not in subagents["writer-agent"]["system_prompt"]
            assert "/shared/plan.json" in subagents["writer-agent"]["system_prompt"]
            assert "Skill Use" not in subagents["writer-agent"]["system_prompt"]
            assert "Required Skill Use" not in subagents["writer-agent"]["system_prompt"]
            assert "General Cross-Synthesis Guidance" in subagents["writer-agent"]["system_prompt"]
            assert "Retain useful detail" in subagents["writer-agent"]["system_prompt"]
            assert "Point out meaningful conflicts" in subagents["writer-agent"]["system_prompt"]
            assert "Use tables when the evidence has comparable entities" in subagents["writer-agent"]["system_prompt"]
            assert "do not mechanically mirror them as final headings" in subagents["writer-agent"]["system_prompt"]
            assert "coherent analytical narrative" in subagents["writer-agent"]["system_prompt"]
            assert "Use bullets sparingly" in subagents["writer-agent"]["system_prompt"]
            assert "/shared/evidence_judgments.json" not in subagents["writer-agent"]["system_prompt"]
            assert "ResearchNotes.evidence_judgment" in subagents["writer-agent"]["system_prompt"]
            assert (
                "high-score/high-confidence notes are synthesis anchors" in subagents["writer-agent"]["system_prompt"]
            )
            assert "default compact mode" in subagents["writer-agent"]["system_prompt"]
            assert 'get_verified_sources(mode="full")' in subagents["writer-agent"]["system_prompt"]
            assert "Wrote /shared/output.md" in subagents["writer-agent"]["system_prompt"]
            assert "Do not return the full Markdown" in subagents["writer-agent"]["system_prompt"]
            assert "Do not use `edit_file` or repeated search-and-replace" in subagents["writer-agent"]["system_prompt"]
            assert "Final Output Grading Rubric" not in subagents["writer-agent"]["system_prompt"]
            assert "rubric" not in subagents["writer-agent"]["system_prompt"].lower()
            assert "long-form-report-writer" not in subagents["writer-agent"]["system_prompt"]
            assert "prediction-report-writer" not in subagents["writer-agent"]["system_prompt"]
            assert "answer_strategy.answer_type" in subagents["writer-agent"]["system_prompt"]
            assert "answer_strategy.title" in subagents["writer-agent"]["system_prompt"]
            assert "answer_strategy.required_components" in subagents["writer-agent"]["system_prompt"]
            for removed_field in ("assembly_instruction", "selection_mode", "expected_count", "options"):
                assert removed_field not in subagents["writer-agent"]["system_prompt"]
            planner_prompt = subagents["planner-agent"]["system_prompt"]
            assert "Skills System" not in planner_prompt
            assert "run_research_batch" in planner_prompt
            assert "subqueries" in planner_prompt
            assert "researcher agent" not in planner_prompt
            assert "data-table-analysis" not in planner_prompt
            assert "answer_strategy" in planner_prompt
            assert "Dynamic Discovery Budget" in planner_prompt
            assert "Do not turn planning into full evidence gathering" in planner_prompt
            assert "configured batch concurrency of 6" in planner_prompt
            assert "Thorough evidence gathering is essential" not in planner_prompt
            assert "Table of Contents" not in planner_prompt
            assert "/shared/source_routing.json" in planner_prompt
            assert "Do not call `ls` and `read_file` for `/shared/source_routing.json` in the same assistant turn" in (
                planner_prompt
            )
            assert "continue planning without source-routing guidance" in planner_prompt
            assert "all highest-priority routed recommendations' exact `tool_names`" in planner_prompt
            for removed_field in ("assembly_instruction", "selection_mode", "expected_count", "options"):
                assert removed_field not in planner_prompt

    def test_prompts_carry_grid_oib_domain_grounding(
        self,
        mock_llm_provider,
        real_tool,
        mock_create_deep_agent,
    ):
        """All deep research prompts identify as Grid OIB and anchor regulation citations."""
        with (
            patch(
                "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
                return_value=mock_create_deep_agent,
            ) as create,
            patch(
                "aiq_agent.agents.deep_researcher.factory.create_agent",
                return_value=mock_create_deep_agent,
            ) as create_researcher,
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
            state = DeepResearchAgentState(messages=[HumanMessage(content="OIB 4 stair requirements")])

            agent._prepare_run(state)

            kwargs = create.call_args.kwargs
            subagents = {subagent["name"]: subagent for subagent in kwargs["subagents"]}
            assert "Grid OIB" in kwargs["system_prompt"]
            assert "Austrian building regulations" in kwargs["system_prompt"]
            assert "Grid OIB" in subagents["planner-agent"]["system_prompt"]
            assert "Bundesland" in subagents["planner-agent"]["system_prompt"]
            assert "Grid OIB" in subagents["writer-agent"]["system_prompt"]
            assert "edition/year" in subagents["writer-agent"]["system_prompt"]
            researcher_prompt = create_researcher.call_args.kwargs["system_prompt"]
            assert "Grid OIB" in researcher_prompt
            assert "regulatory anchor" in researcher_prompt

    def test_build_orchestrator_omits_skills_when_disabled(
        self,
        mock_llm_provider,
        real_tool,
        mock_create_deep_agent,
    ):
        """Default deep research runs do not add SkillsMiddleware."""
        with (
            patch(
                "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
                return_value=mock_create_deep_agent,
            ) as create,
            patch(
                "aiq_agent.agents.deep_researcher.factory.create_agent",
                return_value=mock_create_deep_agent,
            ) as create_researcher,
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
            state = DeepResearchAgentState(messages=[HumanMessage(content="Compare CUDA vs OpenCL")])

            agent._prepare_run(state)

            assert create.call_count == 1
            assert create_researcher.call_count == 1
            researcher_kwargs = create_researcher.call_args.kwargs
            assert "response_format" not in researcher_kwargs
            researcher_deferred = [
                m for m in researcher_kwargs["middleware"] if isinstance(m, DeferredStructuredOutputMiddleware)
            ]
            assert [m.strategy.schema for m in researcher_deferred] == [ResearchNotes]
            researcher_middleware = researcher_kwargs["middleware"]
            assert not any(m.__class__.__name__ == "TodoListMiddleware" for m in researcher_middleware)
            assert not any(m.__class__.__name__ == "SkillsMiddleware" for m in researcher_middleware)
            assert any(m.__class__.__name__ == "FilesystemMiddleware" for m in researcher_middleware)
            assert any(m.__class__.__name__ == "PatchToolCallsMiddleware" for m in researcher_middleware)
            assert _COMMON_MIDDLEWARE_CLASSES <= {m.__class__.__name__ for m in researcher_middleware}
            assert _COMMON_MIDDLEWARE_CLASSES <= {m.__class__.__name__ for m in create.call_args.kwargs["middleware"]}
            assert any(
                m.__class__.__name__ == "ToolVisibilityMiddleware" for m in create.call_args.kwargs["middleware"]
            )
            assert "skills" not in researcher_kwargs
            assert "skills" not in create.call_args.kwargs
            assert [tool.name for tool in create.call_args.kwargs["tools"]] == [
                "think",
                "get_verified_sources",
                "run_research_batch",
            ]
            assert real_tool.name not in {tool.name for tool in create.call_args.kwargs["tools"]}
            subagents = {subagent["name"]: subagent for subagent in create.call_args.kwargs["subagents"]}
            assert set(subagents) == {"source-router-agent", "planner-agent", "writer-agent"}
            assert "response_format" not in subagents["source-router-agent"]
            assert "skills" not in subagents["source-router-agent"]
            assert "response_format" not in subagents["planner-agent"]
            planner_deferred = [
                m for m in subagents["planner-agent"]["middleware"] if isinstance(m, DeferredStructuredOutputMiddleware)
            ]
            assert [m.strategy.schema for m in planner_deferred] == [ResearchPlan]
            assert real_tool.name in {tool.name for tool in subagents["planner-agent"]["tools"]}
            assert "response_format" not in subagents["writer-agent"]
            assert [tool.name for tool in subagents["writer-agent"]["tools"]] == [
                "think",
                "get_verified_sources",
            ]
            assert real_tool.name not in {tool.name for tool in subagents["writer-agent"]["tools"]}
            assert _COMMON_MIDDLEWARE_CLASSES <= {m.__class__.__name__ for m in subagents["writer-agent"]["middleware"]}
            assert any(
                m.__class__.__name__ == "ToolVisibilityMiddleware" for m in subagents["writer-agent"]["middleware"]
            )
            assert (
                "When available skills apply during planning, research, or synthesis"
                not in (create.call_args.kwargs["system_prompt"])
            )

    def test_build_orchestrator_can_disable_source_router(
        self,
        mock_llm_provider,
        real_tool,
        mock_create_deep_agent,
    ):
        """Source routing can be disabled without disabling planning, research, or writing."""
        with (
            patch(
                "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
                return_value=mock_create_deep_agent,
            ) as create,
            patch(
                "aiq_agent.agents.deep_researcher.factory.create_agent",
                return_value=mock_create_deep_agent,
            ),
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                enable_source_router=False,
                max_research_concurrency=2,
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Compare CUDA vs OpenCL")])

            agent._prepare_run(state)

            kwargs = create.call_args.kwargs
            prompt = kwargs["system_prompt"]
            subagents = {subagent["name"]: subagent for subagent in kwargs["subagents"]}
            requested_roles = [args[0] for args, _kwargs in mock_llm_provider.get.call_args_list]
            assert set(subagents) == {"planner-agent", "writer-agent"}
            assert "source-router-agent" not in prompt
            assert "/shared/source_routing.json" not in prompt
            assert "Start with `planner-agent`" in prompt
            assert "at most 2 full ResearchQuery objects per call" in prompt
            assert "all needed queries in one call when there are 2 or fewer" in prompt
            assert "fewest ordered batches" in prompt
            assert "Never repeat a covered query" in prompt
            assert "re-attempt each failed query at most 2 times" in prompt
            assert "state what could not be researched" in prompt
            assert "response_format" not in subagents["planner-agent"]
            planner_deferred = [
                m for m in subagents["planner-agent"]["middleware"] if isinstance(m, DeferredStructuredOutputMiddleware)
            ]
            assert [m.strategy.schema for m in planner_deferred] == [ResearchPlan]
            assert "/shared/source_routing.json" not in subagents["planner-agent"]["system_prompt"]
            assert real_tool.name in {tool.name for tool in subagents["planner-agent"]["tools"]}
            assert [tool.name for tool in subagents["writer-agent"]["tools"]] == [
                "think",
                "get_verified_sources",
            ]
            assert LLMRole.ROUTER not in requested_roles
            assert LLMRole.EVIDENCE_JUDGE not in requested_roles

    @pytest.mark.asyncio
    async def test_run_research_batch_returns_structured_notes(
        self,
        mock_llm_provider,
        real_tool,
    ):
        """Batch research invokes the compiled researcher and returns ResearchNotes JSON."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        class FakeResearcherRunnable:
            def __init__(self) -> None:
                self.calls = []

            async def ainvoke(self, state, config=None):
                self.calls.append((state, config))
                return {
                    "structured_response": {
                        "query_topic": "CUDA / OpenCL portability",
                        "target_components": ["programming_model"],
                        "summary": "CUDA is NVIDIA-specific while OpenCL targets portability.",
                        "findings": [
                            {
                                "claim": "OpenCL is designed for cross-vendor heterogeneous compute.",
                                "evidence": (
                                    "The source describes OpenCL as an open standard for heterogeneous platforms."
                                ),
                                "source_ids": [1],
                                "confidence": "high",
                                "caveats": [],
                            }
                        ],
                        "gaps": [],
                        "sources": [
                            {
                                "id": 1,
                                "title": "OpenCL Overview",
                                "source_type": "url",
                                "locator": "https://example.test/opencl",
                            }
                        ],
                        "narrative_notes": "OpenCL emphasizes portability; CUDA emphasizes NVIDIA ecosystem depth.",
                        "language": "English",
                        "evidence_judgment": None,
                    }
                }

        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool], callbacks=[MagicMock(spec=[])])
        fake_runnable = FakeResearcherRunnable()
        fake_backend = MagicMock()
        fake_backend.upload_files.side_effect = lambda files: [
            FileUploadResponse(path=path, error=None) for path, _content in files
        ]

        batch_tool, source_mw = self._build_batch_tool(agent, fake_runnable, backend=fake_backend)
        source_mw.registry.add(SourceEntry(url="https://example.test/opencl", title="OpenCL"))
        source_mw.registry.add(SourceEntry(url="https://example.test/unused", title="Unused"))
        tool_properties = batch_tool.tool_call_schema.model_json_schema()["properties"]
        assert "runtime" not in tool_properties
        assert "max_concurrency" not in tool_properties
        result = await batch_tool.ainvoke(
            {
                "queries": [
                    {
                        "query": "CUDA OpenCL portability comparison",
                        "subqueries": ["CUDA OpenCL portability", "OpenCL cross vendor standard"],
                        "preferred_tools": ["web_search_tool"],
                        "fallback_tools": [],
                        "target_components": ["programming_model"],
                        "rationale": "Supports the comparison section.",
                    }
                ]
            }
        )

        payload = json.loads(result)
        assert len(payload) == 1
        assert payload[0]["query_topic"] == "CUDA / OpenCL portability"
        assert payload[0]["target_components"] == ["programming_model"]
        assert len(fake_runnable.calls) == 1
        call_state, call_config = fake_runnable.calls[0]
        assert "Batch research invocation" in call_state["messages"][0].content
        assert "return a structured ResearchNotes response" in call_state["messages"][0].content
        assert "Do not call write_file or edit_file" in call_state["messages"][0].content
        assert (
            "write the resulting ResearchNotes JSON under /shared/ exactly once"
            not in call_state["messages"][0].content
        )
        assert '"subqueries": [' in call_state["messages"][0].content
        assert "Execution order" not in call_state["messages"][0].content
        assert call_config == {"callbacks": agent.callbacks, "recursion_limit": 100}
        fake_backend.upload_files.assert_called_once()
        persisted_files = fake_backend.upload_files.call_args.args[0]
        assert len(persisted_files) == 1
        persisted_path, persisted_content = persisted_files[0]
        assert persisted_path.startswith("/shared/research_note_cuda_opencl_portability_comparison_")
        assert persisted_path.endswith(".json")
        persisted_payload = json.loads(persisted_content.decode("utf-8"))
        assert persisted_payload["query_topic"] == "CUDA / OpenCL portability"
        assert persisted_payload["target_components"] == ["programming_model"]
        compact_sources = source_mw.get_source_list_text()
        assert compact_sources is not None
        assert "https://example.test/opencl" in compact_sources
        assert "https://example.test/unused" not in compact_sources

    @pytest.mark.asyncio
    async def test_run_research_batch_rejects_unranked_oversized_batches(
        self,
        mock_llm_provider,
        real_tool,
    ):
        """Oversized batches must be curated by the caller instead of silently truncated."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        fake_runnable = MagicMock()
        fake_runnable.ainvoke = AsyncMock()
        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        batch_tool, _source_mw = self._build_batch_tool(agent, fake_runnable)

        with pytest.raises(ValueError, match="run_research_batch accepts at most 6 curated queries"):
            await batch_tool.ainvoke(
                {
                    "queries": [
                        {
                            "query": f"query {i}",
                            "subqueries": [],
                            "preferred_tools": ["web_search_tool"],
                            "fallback_tools": [],
                            "target_components": [f"component_{i}"],
                            "rationale": "coverage",
                        }
                        for i in range(7)
                    ]
                }
            )
        fake_runnable.ainvoke.assert_not_called()

    @pytest.mark.asyncio
    async def test_run_research_batch_rejects_unavailable_preferred_tools(
        self,
        mock_llm_provider,
        real_tool,
    ):
        """A query preferring a tool absent from the worker registry fails at submission."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        fake_runnable = MagicMock()
        fake_runnable.ainvoke = AsyncMock(return_value=self._structured_notes_response("AI agents overview"))
        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        batch_tool, _source_mw = self._build_batch_tool(agent, fake_runnable)

        with pytest.raises(ValueError, match="preferred_tools are not available"):
            await batch_tool.ainvoke(
                {
                    "queries": [
                        {
                            "query": "AI agents overview",
                            "subqueries": ["AI agents definition 2025", "LLM agents architecture 2025"],
                            "preferred_tools": ["external"],
                            "fallback_tools": [],
                            "target_components": ["overview"],
                            "rationale": "External overview.",
                        }
                    ]
                }
            )

        # Fail fast: no researcher worker is spawned for an unexecutable query.
        fake_runnable.ainvoke.assert_not_called()

    @pytest.mark.asyncio
    async def test_run_research_batch_recovers_fenced_json_notes(
        self,
        mock_llm_provider,
        real_tool,
    ):
        """Notes emitted as a ```json-fenced message (no structured_response) are recovered.

        DeepSeek-class models intermittently wrap the ResearchNotes JSON in a
        markdown fence (sometimes with a natural-language preamble) instead of
        using the structured-output channel. The worker should recover the
        well-formed JSON instead of failing and forcing an orchestrator resubmit.
        """
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        note_json = json.dumps(self._structured_notes_response()["structured_response"])
        fenced = f"以下为研究笔记：\n\n```json\n{note_json}\n```"
        fake_runnable = MagicMock()
        fake_runnable.ainvoke = AsyncMock(return_value={"messages": [AIMessage(content=fenced)]})
        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        batch_tool, _source_mw = self._build_batch_tool(agent, fake_runnable)

        result = await batch_tool.ainvoke(
            {
                "queries": [
                    {
                        "query": "fenced output query",
                        "subqueries": [],
                        "preferred_tools": ["web_search_tool"],
                        "fallback_tools": [],
                        "target_components": ["overview"],
                        "rationale": "coverage",
                    }
                ]
            }
        )

        payload = json.loads(result)
        assert len(payload) == 1
        assert payload[0]["query_topic"] == "Research Topic"

    @pytest.mark.asyncio
    async def test_run_research_batch_rejects_empty_notes_as_failed_worker(
        self,
        mock_llm_provider,
        real_tool,
    ):
        """A note with no findings and a blank summary is a failed worker, not a success."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        empty_note = {
            "structured_response": {
                "query_topic": "Empty",
                "target_components": ["overview"],
                "summary": "   ",
                "findings": [],
                "gaps": [],
                "sources": [],
                "narrative_notes": "",
                "language": "English",
                "evidence_judgment": None,
            }
        }
        fake_runnable = MagicMock()
        fake_runnable.ainvoke = AsyncMock(return_value=empty_note)
        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        batch_tool, _source_mw = self._build_batch_tool(agent, fake_runnable)

        with pytest.raises(RuntimeError, match="empty ResearchNotes"):
            await batch_tool.ainvoke(
                {
                    "queries": [
                        {
                            "query": "survey of AI agents 2023-2025",
                            "subqueries": [],
                            "preferred_tools": ["web_search_tool"],
                            "fallback_tools": [],
                            "target_components": ["overview"],
                            "rationale": "Gather coverage.",
                        }
                    ]
                }
            )

    @pytest.mark.asyncio
    async def test_run_research_batch_delegates_empty_subqueries(
        self,
        mock_llm_provider,
        real_tool,
    ):
        """The lightweight batch tool does not reintroduce planner-shape guards."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        fake_runnable = MagicMock()
        fake_runnable.ainvoke = AsyncMock(return_value=self._structured_notes_response("AI agents survey"))
        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        batch_tool, _source_mw = self._build_batch_tool(agent, fake_runnable)

        result = await batch_tool.ainvoke(
            {
                "queries": [
                    {
                        "query": "survey of AI agents 2023-2025",
                        "subqueries": [],
                        "preferred_tools": ["web_search_tool"],
                        "fallback_tools": [],
                        "target_components": ["definitions", "architecture", "taxonomy"],
                        "rationale": "Gather comprehensive survey coverage.",
                    }
                ]
            }
        )

        assert json.loads(result)[0]["query_topic"] == "AI agents survey"
        fake_runnable.ainvoke.assert_awaited_once()
        call_state = fake_runnable.ainvoke.call_args.args[0]
        assert '"subqueries": []' in call_state["messages"][0].content

    @pytest.mark.asyncio
    async def test_run_research_batch_waits_for_slow_workers_and_preserves_errors(
        self,
        mock_llm_provider,
        real_tool,
    ):
        """Failed researchers are surfaced as tool errors without timing out slow workers."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        class FakeResearcherRunnable:
            async def ainvoke(self, state, config=None):
                content = state["messages"][0].content
                if "slow query" in content:
                    await asyncio.sleep(0.02)
                if "bad query" in content:
                    raise RuntimeError("search backend exploded")
                if "slow query" in content:
                    topic = "Slow Query"
                    title = "Slow"
                    locator = "https://example.test/slow"
                    component = "c"
                else:
                    topic = "Good Query"
                    title = "Good"
                    locator = "https://example.test/good"
                    component = "a"
                return {
                    "structured_response": {
                        "query_topic": topic,
                        "target_components": [component],
                        "summary": "A useful note.",
                        "findings": [
                            {
                                "claim": "A fact.",
                                "evidence": f"Evidence from {locator}.",
                                "source_ids": [1],
                                "confidence": "high",
                                "caveats": [],
                            }
                        ],
                        "gaps": [],
                        "sources": [
                            {
                                "id": 1,
                                "title": title,
                                "source_type": "url",
                                "locator": locator,
                            }
                        ],
                        "narrative_notes": "Useful narrative notes.",
                        "language": "English",
                        "evidence_judgment": None,
                    }
                }

        agent = DeepResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            max_research_concurrency=3,
        )

        fake_backend = MagicMock()
        fake_backend.upload_files.side_effect = lambda files: [
            FileUploadResponse(path=path, error=None) for path, _content in files
        ]
        batch_tool, source_mw = self._build_batch_tool(agent, FakeResearcherRunnable(), backend=fake_backend)
        source_mw.registry.add(SourceEntry(url="https://example.test/good", title="Good"))
        source_mw.registry.add(SourceEntry(url="https://example.test/slow", title="Slow"))
        source_mw.registry.add(SourceEntry(url="https://example.test/unused", title="Unused"))
        query_payloads = [
            {
                "query": "good query",
                "subqueries": [],
                "preferred_tools": ["web_search_tool"],
                "fallback_tools": [],
                "target_components": ["a"],
                "rationale": "success",
            },
            {
                "query": "bad query",
                "subqueries": [],
                "preferred_tools": ["web_search_tool"],
                "fallback_tools": [],
                "target_components": ["b"],
                "rationale": "failure",
            },
            {
                "query": "slow query",
                "subqueries": [],
                "preferred_tools": ["web_search_tool"],
                "fallback_tools": [],
                "target_components": ["c"],
                "rationale": "timeout",
            },
        ]
        with pytest.raises(RuntimeError) as exc_info:
            await batch_tool.ainvoke({"queries": query_payloads})

        assert "run_research_batch failed for 1 of 3 researcher worker" in str(exc_info.value)
        assert "search backend exploded" in str(exc_info.value)
        assert "timed out" not in str(exc_info.value)
        assert "2 successful researcher worker(s) were registered and persisted under /shared/" in str(exc_info.value)
        assert "resubmit only the failed queries" in str(exc_info.value)
        fake_backend.upload_files.assert_called_once()
        persisted_files = fake_backend.upload_files.call_args.args[0]
        assert len(persisted_files) == 2
        from aiq_agent.agents.deep_researcher.tools.research import _research_note_path

        persisted_notes = [
            ResearchNotes.model_validate(json.loads(content.decode("utf-8"))) for _path, content in persisted_files
        ]
        query_models = [ResearchQuery.model_validate(payload) for payload in query_payloads]
        assert [note.query_topic for note in persisted_notes] == ["Good Query", "Slow Query"]
        assert persisted_files[0][0] == _research_note_path(query_models[0])
        assert persisted_files[1][0] == _research_note_path(query_models[2])
        compact_sources = source_mw.get_source_list_text()
        assert compact_sources is not None
        assert "https://example.test/good" in compact_sources
        assert "https://example.test/slow" in compact_sources
        assert "https://example.test/unused" not in compact_sources

    @pytest.mark.asyncio
    async def test_run_research_queries_isolates_stateful_callbacks_per_worker(self):
        """Concurrent researcher workers must not share one stateful callback instance.

        _run_research_queries fans out to up to max_concurrency concurrent
        researcher invocations. Passing the exact same callbacks list to all
        of them would let concurrent workers race on one handler's mutable
        state (VerboseTraceCallback's docstring warns a single instance must
        not span concurrent runs, ADR-0018). Each worker must instead receive
        callbacks built via for_new_run(); callbacks without for_new_run are
        forwarded unchanged.
        """
        from aiq_agent.agents.deep_researcher.tools.research import _run_research_queries

        class FakeIsolatingCallback:
            """Stand-in for VerboseTraceCallback's for_new_run() contract."""

            def __init__(self) -> None:
                self.spawned: list[FakeIsolatingCallback] = []

            def for_new_run(self) -> "FakeIsolatingCallback":
                fresh = FakeIsolatingCallback()
                self.spawned.append(fresh)
                return fresh

        shared_cb = FakeIsolatingCallback()
        passthrough_cb = MagicMock(spec=[])  # no for_new_run -> forwarded unchanged
        seen_callbacks_per_call: list[list] = []

        class FakeResearcherRunnable:
            async def ainvoke(self, state, config=None):
                seen_callbacks_per_call.append(config["callbacks"])
                return {
                    "structured_response": {
                        "query_topic": "topic",
                        "target_components": ["overview"],
                        "summary": "note",
                        "findings": [],
                        "gaps": [],
                        "sources": [],
                        "narrative_notes": "note",
                        "language": "English",
                        "evidence_judgment": None,
                    }
                }

        queries = [
            ResearchQuery(
                query=f"query {i}",
                subqueries=[],
                preferred_tools=["web_search_tool"],
                fallback_tools=[],
                target_components=["overview"],
                rationale="coverage",
            )
            for i in range(4)
        ]

        successful, notes, errors = await _run_research_queries(
            queries=queries,
            researcher_runnable=FakeResearcherRunnable(),
            runtime=None,
            callbacks=[shared_cb, passthrough_cb],
            max_concurrency=4,
        )

        assert errors == []
        assert len(successful) == 4
        assert len(notes) == 4
        assert len(seen_callbacks_per_call) == 4

        # Every concurrent worker received its own fresh instance, never the
        # shared original, and no two workers received the same instance.
        assert len(shared_cb.spawned) == 4
        assert len(set(id(cb) for cb in shared_cb.spawned)) == 4
        spawned_per_call = [callbacks[0] for callbacks in seen_callbacks_per_call]
        assert shared_cb not in spawned_per_call
        assert len(set(id(cb) for cb in spawned_per_call)) == 4
        for callbacks in seen_callbacks_per_call:
            spawned_cb, forwarded_cb = callbacks
            assert spawned_cb in shared_cb.spawned
            # The plain callback (no for_new_run) is forwarded unchanged.
            assert forwarded_cb is passthrough_cb

    def test_researcher_invoke_state_carries_parent_files(self):
        """Nested researcher invocations inherit parent files for StateBackend-backed skills."""
        query = ResearchQuery(
            query="CUDA OpenCL portability comparison",
            subqueries=[],
            preferred_tools=["web_search_tool"],
            fallback_tools=[],
            target_components=["programming_model"],
            rationale="Supports the comparison section.",
        )
        files = {"/skills/test/SKILL.md": {"content": "skill", "encoding": "utf-8"}}
        runtime = MagicMock(state={"messages": [], "files": files})

        invoke_state = researcher_invoke_state(query, runtime)

        assert invoke_state["files"] is files
        assert invoke_state["messages"][0].content.startswith("Batch research invocation")
        assert "Batch research invocation" in invoke_state["messages"][0].content

    def test_modal_backend_is_concrete_cached_and_routes_skills_locally(self, mock_llm_provider, real_tool):
        """Modal backend creation is lazy, cached, and skill reads do not hit Modal."""
        from deepagents.backends import FilesystemBackend
        from deepagents.backends import StateBackend

        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
        from aiq_agent.agents.deep_researcher.deepagents_runtime import BUILTIN_SKILL_SOURCE
        from aiq_agent.agents.deep_researcher.deepagents_runtime import SHARED_ROUTE
        from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSandboxConfig
        from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSkillsConfig

        sandbox = DeepResearchSandboxConfig()
        agent = DeepResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            skills=DeepResearchSkillsConfig(agents={"writer-agent": ("synthesis",)}),
            sandbox=sandbox,
            job_id="job-123",
        )
        fake_modal_backend = MagicMock()

        with (
            patch(
                "aiq_agent.agents.deep_researcher.deepagents_runtime._create_sandbox_backend",
                return_value=fake_modal_backend,
            ) as create_backend,
        ):
            backend_one = agent.deepagents_runtime.backend
            backend_two = agent.deepagents_runtime.backend

        assert backend_one is backend_two
        assert backend_one.default is fake_modal_backend
        create_backend.assert_called_once_with(
            sandbox,
            "job-123",
        )
        assert isinstance(backend_one.routes[BUILTIN_SKILL_SOURCE], FilesystemBackend)
        assert isinstance(backend_one.routes[SHARED_ROUTE], StateBackend)
        fake_modal_backend.ls.assert_not_called()
        fake_modal_backend.read.assert_not_called()

    def test_modal_backend_creates_sandbox_lazily(self):
        """Modal sandbox lifetime starts on first sandbox operation, not agent construction."""
        from deepagents.backends.protocol import ExecuteResponse

        from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSandboxConfig
        from aiq_agent.agents.deep_researcher.deepagents_runtime import _create_sandbox_backend

        fake_modal_backend = MagicMock()
        fake_modal_backend.execute.return_value = ExecuteResponse(output="ok", exit_code=0)

        with patch(
            "aiq_agent.agents.deep_researcher.deepagents_runtime._create_modal_backend_now",
            return_value=fake_modal_backend,
        ) as create_modal:
            backend = _create_sandbox_backend(DeepResearchSandboxConfig(), "job-123")

            create_modal.assert_not_called()
            result = backend.execute("echo ok", timeout=5)

        assert result.output == "ok"
        create_modal.assert_called_once()
        fake_modal_backend.execute.assert_called_once_with("echo ok", timeout=5)

    def test_modal_backend_recreates_and_retries_once_on_not_found(self):
        """A disappeared Modal container is recreated once for the same job-scoped name."""
        import modal
        from deepagents.backends.protocol import ExecuteResponse

        from aiq_agent.agents.deep_researcher.deepagents_runtime import DeepResearchSandboxConfig
        from aiq_agent.agents.deep_researcher.deepagents_runtime import _create_sandbox_backend

        first_modal_backend = MagicMock()
        first_modal_backend.execute.side_effect = modal.exception.NotFoundError("gone")
        second_modal_backend = MagicMock()
        second_modal_backend.execute.return_value = ExecuteResponse(output="ok", exit_code=0)
        config = DeepResearchSandboxConfig()

        with patch(
            "aiq_agent.agents.deep_researcher.deepagents_runtime._create_modal_backend_now",
            side_effect=[first_modal_backend, second_modal_backend],
        ) as create_modal:
            backend = _create_sandbox_backend(config, "job-123")
            result = backend.execute("echo ok", timeout=5)

        assert result.output == "ok"
        assert create_modal.call_args_list[0].args == (config, "job-123")
        assert create_modal.call_args_list[0].kwargs == {}
        assert create_modal.call_args_list[1].args == (config, "job-123")
        assert create_modal.call_args_list[1].kwargs == {"force_new": True}
        first_modal_backend.execute.assert_called_once_with("echo ok", timeout=5)
        second_modal_backend.execute.assert_called_once_with("echo ok", timeout=5)

    def test_load_prompts_raises_when_missing(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """Missing prompts fail fast instead of silently using inline defaults."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            with patch(
                "aiq_agent.agents.deep_researcher.agent.load_prompt",
                side_effect=FileNotFoundError(),
            ):
                from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

                with pytest.raises(FileNotFoundError):
                    DeepResearcherAgent(
                        llm_provider=mock_llm_provider,
                        tools=[real_tool],
                    )

    @pytest.mark.asyncio
    async def test_provider_roles_used_on_init(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """Test LLM roles (planner, researcher, orchestrator) are requested when run() is invoked."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Quick query")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                await agent.run(state)

            mock_llm_provider.get.assert_any_call(LLMRole.PLANNER)
            mock_llm_provider.get.assert_any_call(LLMRole.ROUTER)
            mock_llm_provider.get.assert_any_call(LLMRole.RESEARCHER)
            mock_llm_provider.get.assert_any_call(LLMRole.REPORT_WRITER)
            mock_llm_provider.get.assert_any_call(LLMRole.ORCHESTRATOR)
            requested_roles = [args[0] for args, _kwargs in mock_llm_provider.get.call_args_list]
            assert LLMRole.EVIDENCE_JUDGE not in requested_roles

    @pytest.mark.asyncio
    async def test_run_basic_query(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """Test run() with a basic query."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
            )

            state = DeepResearchAgentState(messages=[HumanMessage(content="Compare CUDA vs OpenCL in depth")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                result = await agent.run(state)

            assert result is not None
            assert result.messages is not None
            assert len(result.messages) > 0

    @pytest.mark.asyncio
    async def test_run_empty_messages(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """Test run() with empty messages."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
            )

            state = DeepResearchAgentState(messages=[])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                result = await agent.run(state)

            assert result is not None

    @pytest.mark.asyncio
    async def test_run_enforces_wall_clock_budget(self, mock_llm_provider, real_tool):
        """A run past max_run_seconds fails with a clear budget error instead of hanging.

        The graph never emits a single state chunk here, so there is nothing to
        salvage and the budget error is still raised, not softened.
        """
        mock_agent = streaming_graph_mock(hang=True)
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                max_run_seconds=1,
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])
            with pytest.raises(TimeoutError, match="wall-clock budget"):
                await agent.run(state)

    @pytest.mark.asyncio
    async def test_run_zero_budget_disables_wall_clock_guard(
        self, mock_llm_provider, real_tool, mock_create_deep_agent
    ):
        """max_run_seconds=0 runs unguarded (no wait_for wrapper)."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                max_run_seconds=0,
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                result = await agent.run(state)
            assert result is not None

    @pytest.mark.asyncio
    async def test_run_with_callbacks(self, mock_llm_provider, real_tool, mock_create_deep_agent):
        """Test run() uses callbacks."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            mock_callback = MagicMock()
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                callbacks=[mock_callback],
            )

            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                await agent.run(state)

            # Callbacks should have been passed to the streamed invocation
            call_kwargs = mock_create_deep_agent.astream.call_args
            assert call_kwargs is not None

    @pytest.mark.asyncio
    async def test_run_wires_thread_id_and_durability_when_checkpointer_set(
        self, mock_llm_provider, real_tool, mock_create_deep_agent
    ):
        """A configured checkpointer threads job_id as thread_id and requests async durability (T3-8)."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            fake_checkpointer = MagicMock(name="fake_checkpointer")
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                checkpointer=fake_checkpointer,
                job_id="job-durable-1",
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                await agent.run(state)

            call = mock_create_deep_agent.astream.call_args
            assert call.kwargs["config"]["configurable"] == {"thread_id": "job-durable-1"}
            assert call.kwargs["durability"] == "async"

    @pytest.mark.asyncio
    async def test_run_omits_thread_id_and_durability_when_no_checkpointer(
        self, mock_llm_provider, real_tool, mock_create_deep_agent
    ):
        """Default (no checkpointer) behavior is unchanged: no configurable/durability kwargs reach the graph."""
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_create_deep_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                await agent.run(state)

            call = mock_create_deep_agent.astream.call_args
            assert call.kwargs.get("config") is None
            assert "durability" not in call.kwargs

    @pytest.mark.asyncio
    async def test_run_handles_error(self, mock_llm_provider, real_tool):
        """Test run() handles errors gracefully."""
        mock_agent = streaming_graph_mock(error=Exception("Agent error"))

        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
            )

            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])

            with pytest.raises(Exception, match="Agent error"):
                await agent.run(state)
            assert mock_agent.astream.call_count == 1

    @pytest.mark.asyncio
    async def test_run_empty_result_messages(self, mock_llm_provider, real_tool):
        """Test run() handles empty result messages."""
        mock_agent = streaming_graph_mock({"messages": [], "files": output_markdown_file()})

        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
            )

            state = DeepResearchAgentState(messages=[HumanMessage(content="Test")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                result = await agent.run(state)

            # Should handle empty messages
            assert result is not None

    @pytest.mark.asyncio
    async def test_run_replaces_final_message_with_writer_markdown(self, mock_llm_provider, real_tool):
        """The final answer comes from /shared/output.md."""
        result_messages = [
            HumanMessage(content="Original query"),
            AIMessage(content="I'll help with that."),
            ToolMessage(content="Search results here", tool_call_id="123"),
            AIMessage(content="Raw orchestrator handoff."),
        ]

        mock_agent = streaming_graph_mock(
            {
                "messages": result_messages,
                "files": output_markdown_file("Writer markdown [1].\n\n## Sources\n[1] Example: https://example.com"),
            }
        )

        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
            )

            state = DeepResearchAgentState(messages=[HumanMessage(content="Original query")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                result = await agent.run(state)

            assert result.messages[0].content == "Original query"
            assert result.messages[1].content == "I'll help with that."
            assert result.messages[2].content == "Search results here"
            # The LLM-written source line is labeled with the deterministic
            # origin token (URL source → [Web]) injected by verify_citations.
            assert (
                result.messages[3].content
                == "Writer markdown [1].\n\n## Sources\n[1] [Web] Example: https://example.com\n"
            )

    def test_extract_last_message_text(self):
        """The fallback extractor returns the last message text, or None."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent as A

        assert A._extract_last_message_text({"messages": [AIMessage(content="hello")]}) == "hello"
        assert A._extract_last_message_text({"messages": [AIMessage(content="  padded  ")]}) == "padded"
        assert A._extract_last_message_text({"messages": [AIMessage(content="   ")]}) is None
        assert A._extract_last_message_text({"messages": []}) is None
        assert A._extract_last_message_text({}) is None

    def test_extract_last_message_text_joins_structured_blocks(self):
        """Structured block content yields joined text, not a Python repr."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent as A

        blocks = [
            {"type": "text", "text": "First paragraph."},
            {"type": "tool_use", "id": "tc1", "name": "think", "input": {}},
            {"type": "text", "text": "Second paragraph."},
        ]
        extracted = A._extract_last_message_text({"messages": [AIMessage(content=blocks)]})

        assert extracted == "First paragraph.\nSecond paragraph."
        assert "{'type'" not in extracted

        mixed = ["Plain string block.", {"type": "text", "text": "Dict block."}]
        assert A._extract_last_message_text({"messages": [AIMessage(content=mixed)]}) == (
            "Plain string block.\nDict block."
        )
        assert A._extract_last_message_text({"messages": [AIMessage(content=[])]}) is None

    def test_research_note_path_is_deterministic_per_query(self):
        """Note filenames derive from the query alone so re-runs overwrite, not accumulate."""
        from aiq_agent.agents.deep_researcher.tools.research import _research_note_path

        query = ResearchQuery(
            query="OIB Richtlinie 2 Brandschutz Anforderungen",
            subqueries=[],
            preferred_tools=["web_search_tool"],
            fallback_tools=[],
            target_components=["fire_safety"],
            rationale="coverage",
        )
        other = query.model_copy(update={"query": "OIB Richtlinie 6 Energieeinsparung"})

        first_path = _research_note_path(query)
        assert first_path == _research_note_path(query)
        assert first_path.startswith("/shared/research_note_oib_richtlinie_2_brandschutz_anforderungen_")
        assert first_path.endswith(".json")
        assert _research_note_path(other) != first_path

    @pytest.mark.asyncio
    async def test_run_falls_back_to_last_message_when_no_report_file(self, mock_llm_provider, real_tool):
        """No /shared/output.md → fall back to the agent's last message, not a hard job failure."""
        mock_agent = streaming_graph_mock(
            {
                "messages": [
                    HumanMessage(content="q"),
                    AIMessage(content="Here is what I found, though I did not persist a report file."),
                ],
                "files": {},  # writer never wrote /shared/output.md
            }
        )

        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                # Isolate the fallback path from the empty-source-registry gate.
                enable_citation_verification=False,
            )

            state = DeepResearchAgentState(messages=[HumanMessage(content="q")])
            result = await agent.run(state)

        assert result is not None
        assert "did not persist a report file" in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_missing_report_file_marks_the_answer_degraded(self, mock_llm_provider, real_tool):
        """The message-instead-of-report fallback is announced, not only logged."""
        mock_agent = streaming_graph_mock(
            {
                "messages": [
                    HumanMessage(content="q"),
                    AIMessage(content="Here is what I found, though I did not persist a report file."),
                ],
                "files": {},
            }
        )

        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                enable_citation_verification=False,
            )

            state = DeepResearchAgentState(messages=[HumanMessage(content="q")])
            result = await agent.run(state)

        assert result.degraded_reasons == ["no_report_file"]
        # The reader of the answer alone is told, too.
        assert result.messages[-1].content.startswith("> **Hinweis:**")
        assert "did not persist a report file" in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_run_raises_when_no_report_and_no_message(self, mock_llm_provider, real_tool):
        """No report file AND no usable message → still a hard failure (nothing to return)."""
        mock_agent = streaming_graph_mock({"messages": [], "files": {}})

        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                enable_citation_verification=False,
            )

            state = DeepResearchAgentState(messages=[HumanMessage(content="q")])
            with pytest.raises(ValueError, match="did not produce a final Markdown answer"):
                await agent.run(state)


class TestDeepResearchCutoffSalvage:
    """A cut-off run ships what it has, marked — or fails loudly with nothing."""

    #: Long enough to clear MIN_SALVAGE_REPORT_CHARS: a real partial report.
    PARTIAL_REPORT = (
        "## Zwischenstand\n\n"
        "Die Recherche hat die wesentlichen Anforderungen bereits erfasst und haelt "
        "die bisher gesicherten Feststellungen samt Quellenlage fest, bevor die "
        "verbleibenden Teilfragen bearbeitet werden konnten [1].\n\n"
        "## Sources\n[1] Example: https://example.com"
    )

    #: Below the bar: a stub under a truncation banner still reads as an answer.
    STUB_REPORT = "Zu kurz [1].\n\n## Sources\n[1] Example: https://example.com"

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        provider.configure(LLMRole.ORCHESTRATOR, mock_llm)
        provider.configure(LLMRole.ROUTER, mock_llm)
        provider.configure(LLMRole.PLANNER, mock_llm)
        provider.configure(LLMRole.RESEARCHER, mock_llm)
        provider.configure(LLMRole.REPORT_WRITER, mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        return web_search_tool

    @staticmethod
    def _partial_state(report: str) -> dict:
        """The last graph state a cut-off run streamed: a report is already on disk."""
        return {
            "messages": [AIMessage(content="orchestrator handoff")],
            "files": output_markdown_file(report),
        }

    @pytest.mark.asyncio
    async def test_wall_clock_cutoff_salvages_the_partial_report(self, mock_llm_provider, real_tool):
        """Partial state with a written report → a MARKED answer, not a failed job."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        mock_agent = streaming_graph_mock(self._partial_state(self.PARTIAL_REPORT), hang=True)

        with (
            patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent),
            patch("aiq_agent.agents.deep_researcher.agent.emit_deep_research_cutoff") as emit,
        ):
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                max_run_seconds=1,
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                result = await agent.run(state)

        assert result.research_truncated is True
        assert result.truncation_reason == "wall_clock"

        answer = result.messages[-1].content
        # The report itself says it is partial, so an exported PDF says it too.
        assert answer.startswith("> **Hinweis:**")
        assert "Zeitlimit" in answer
        assert "Zwischenstand" in answer

        assert emit.call_args.kwargs["reason"] == "wall_clock"
        assert emit.call_args.kwargs["salvaged"] is True
        assert emit.call_args.kwargs["source_count"] == 1

    @pytest.mark.asyncio
    async def test_cutoff_with_too_short_a_report_raises(self, mock_llm_provider, real_tool):
        """Below MIN_SALVAGE_REPORT_CHARS there is nothing worth shipping — fail loudly."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        mock_agent = streaming_graph_mock(self._partial_state(self.STUB_REPORT), hang=True)

        with (
            patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent),
            patch("aiq_agent.agents.deep_researcher.agent.emit_deep_research_cutoff") as emit,
        ):
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                max_run_seconds=1,
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                with pytest.raises(TimeoutError, match="wall-clock budget"):
                    await agent.run(state)

        assert emit.call_args.kwargs["salvaged"] is False

    @pytest.mark.asyncio
    async def test_step_limit_cutoff_salvages_the_partial_report(self, mock_llm_provider, real_tool):
        """A GraphRecursionError is the same story as the clock, told with a different token."""
        from langgraph.errors import GraphRecursionError

        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        mock_agent = streaming_graph_mock(
            self._partial_state(self.PARTIAL_REPORT),
            error=GraphRecursionError("Recursion limit of 150 reached"),
        )

        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                result = await agent.run(state)

        assert result.research_truncated is True
        assert result.truncation_reason == "step_limit"

        answer = result.messages[-1].content
        assert answer.startswith("> **Hinweis:**")
        assert "Schritt-Limit" in answer

    @pytest.mark.asyncio
    async def test_step_limit_cutoff_without_partial_state_raises(self, mock_llm_provider, real_tool):
        """No streamed state at all → the recursion error itself, unswallowed."""
        from langgraph.errors import GraphRecursionError

        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        mock_agent = streaming_graph_mock(error=GraphRecursionError("Recursion limit of 150 reached"))

        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
            state = DeepResearchAgentState(messages=[HumanMessage(content="Test query")])
            with pytest.raises(GraphRecursionError):
                await agent.run(state)


class TestPerRunIsolation:
    """Per-run construction (ADR-0018): no run can observe another run's state."""

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        provider.configure(LLMRole.ORCHESTRATOR, mock_llm)
        provider.configure(LLMRole.PLANNER, mock_llm)
        provider.configure(LLMRole.RESEARCHER, mock_llm)
        provider.configure(LLMRole.REPORT_WRITER, mock_llm)
        return provider

    def test_prepare_run_builds_fresh_artifacts_per_run(self, mock_llm_provider):
        """Each run gets its own middleware, tool set, and middleware stacks."""
        mock_agent = MagicMock()
        mock_agent.with_config = MagicMock(return_value=mock_agent)
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[web_search_tool])
            state = DeepResearchAgentState(messages=[HumanMessage(content="Request")])

            first = agent._prepare_run(state)
            second = agent._prepare_run(state)

            assert first.source_registry_middleware is not second.source_registry_middleware
            assert first.tool_set is not second.tool_set
            assert first.middleware_set is not second.middleware_set
            # The agent instance itself holds no per-run capture state anymore.
            assert not hasattr(agent, "source_registry_middleware")

    def test_prepare_run_middleware_starts_empty_even_after_prior_capture(self, mock_llm_provider):
        """Sources captured by one run's middleware are invisible to the next run."""
        mock_agent = MagicMock()
        mock_agent.with_config = MagicMock(return_value=mock_agent)
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[web_search_tool])
            state = DeepResearchAgentState(messages=[HumanMessage(content="Request")])

            first = agent._prepare_run(state)
            first.source_registry_middleware.registry.add(SourceEntry(url="https://run-one.example.com"))
            note = MagicMock()
            note.sources = [MagicMock(locator="https://run-one.example.com")]
            first.source_registry_middleware.register_research_note_sources([note])

            second = agent._prepare_run(state)

            assert second.source_registry_middleware.registry.all_sources() == []
            assert second.source_registry_middleware._compact_source_keys == set()
            # And the first run's state is untouched by preparing the second.
            assert [s.url for s in first.source_registry_middleware.registry.all_sources()] == [
                "https://run-one.example.com"
            ]

    def test_prepare_run_builds_fresh_trace_callbacks(self, mock_llm_provider):
        """Stateful trace callbacks are rebuilt per run instead of shared across runs."""
        from aiq_agent.common import VerboseTraceCallback

        mock_agent = MagicMock()
        mock_agent.with_config = MagicMock(return_value=mock_agent)
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            shared_callback = VerboseTraceCallback(log_reasoning=False, max_chars=123)
            plain_callback = MagicMock(spec=[])  # no for_new_run → passed through as-is
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[web_search_tool],
                callbacks=[shared_callback, plain_callback],
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Request")])

            first = agent._prepare_run(state)
            second = agent._prepare_run(state)

            assert isinstance(first.callbacks[0], VerboseTraceCallback)
            assert first.callbacks[0] is not shared_callback
            assert first.callbacks[0] is not second.callbacks[0]
            # Configuration carries over; per-run mutable state does not.
            assert first.callbacks[0].log_reasoning is False
            assert first.callbacks[0].max_chars == 123
            # Callbacks without per-run state are reused unchanged.
            assert first.callbacks[1] is plain_callback

    @pytest.mark.asyncio
    async def test_second_run_does_not_reuse_first_run_sources(self, mock_llm_provider):
        """A reused prebuilt agent starts each standalone run with an empty registry."""
        mock_agent = streaming_graph_mock(
            {
                "messages": [AIMessage(content="done")],
                "files": output_markdown_file(),
            }
        )
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[web_search_tool])

            # First run succeeds against a session-scoped registry (conversation mode).
            state = DeepResearchAgentState(messages=[HumanMessage(content="First request")])
            with seeded_session_registry(SourceEntry(url="https://run-one.example.com")):
                first_result = await agent.run(state)

            assert "Deep research answer" in first_result.messages[-1].content

            # Second run without a session registry sees none of the first
            # run's sources: its fresh per-run registry is empty. An empty
            # registry at the end of a run now fails loudly — which also proves
            # the second run did not inherit run-one's captured source (it would
            # otherwise have a non-empty registry and succeed).
            from aiq_agent.common.citation_verification import EmptySourceRegistryError

            state = DeepResearchAgentState(messages=[HumanMessage(content="Next request")])
            with pytest.raises(EmptySourceRegistryError):
                await agent.run(state)


class TestFinalMarkdownExtraction:
    """Tests for extracting the writer's final Markdown."""

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        provider.configure(LLMRole.ORCHESTRATOR, mock_llm)
        provider.configure(LLMRole.PLANNER, mock_llm)
        provider.configure(LLMRole.RESEARCHER, mock_llm)
        provider.configure(LLMRole.REPORT_WRITER, mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        return web_search_tool

    def test_extract_final_markdown_does_not_download_from_backend(self, mock_llm_provider, real_tool):
        """Final Markdown extraction only reads files returned by graph state."""
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=MagicMock(),
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
            fake_backend = MagicMock()
            agent.deepagents_runtime._backend = fake_backend

            output = agent._extract_final_markdown({"messages": [AIMessage(content="done")], "files": {}})

            assert output is None
            fake_backend.download_files.assert_not_called()

    def test_extract_final_markdown_from_shared_output_file(self, mock_llm_provider, real_tool):
        """Final Markdown can be loaded from /shared/output.md if the writer used the shared path."""
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=MagicMock(),
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
            report = "Shared report [1].\n\n## Sources\n[1] Example: https://example.com"
            output = agent._extract_final_markdown(
                {
                    "messages": [AIMessage(content="done")],
                    "files": {"/shared/output.md": {"content": report}},
                }
            )

            assert output == report

    def test_extract_final_markdown_ignores_orchestrator_chatter(self, mock_llm_provider, real_tool):
        """Plain messages are not accepted as final Markdown."""
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=MagicMock(),
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
            output = agent._extract_final_markdown(
                {
                    "messages": [
                        AIMessage(content="Next distributed constraints file."),
                        AIMessage(content="Let's call get_verified_sources now."),
                    ],
                    "files": {},
                }
            )

            assert output is None

    @pytest.mark.asyncio
    async def test_run_fails_on_missing_writer_output_before_citation_verification(
        self,
        mock_llm_provider,
        real_tool,
    ):
        """Missing /shared/output.md with nothing to fall back to is a writer
        failure, not a citation failure — and is diagnosed before citation
        verification (the seeded source registry would otherwise let a citation
        pass run first)."""
        mock_agent = streaming_graph_mock(
            {
                # No report file AND no usable message → genuine writer failure
                # (a present message would instead degrade to it; covered
                # separately by test_run_falls_back_to_last_message_*).
                "messages": [],
                "files": {},
            }
        )

        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

            state = DeepResearchAgentState(messages=[HumanMessage(content="Write a report")])
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                with pytest.raises(ValueError, match="writer-agent did not produce a final Markdown answer"):
                    await agent.run(state)


class TestDeepResearcherCitationVerification:
    """Tests for deep researcher citation post-processing."""

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        provider.configure(LLMRole.ORCHESTRATOR, mock_llm)
        provider.configure(LLMRole.PLANNER, mock_llm)
        provider.configure(LLMRole.RESEARCHER, mock_llm)
        provider.configure(LLMRole.REPORT_WRITER, mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        return web_search_tool

    @pytest.mark.asyncio
    async def test_run_returns_report_when_verify_finds_no_valid_citations(self, mock_llm_provider, real_tool, caplog):
        """Verifier false negatives degrade to a warning instead of discarding the report."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        report = "CUDA findings here [1].\n\n## Sources\n[1] CUDA Docs: https://docs.nvidia.com/cuda/"
        sanitized_report = f"{report}\n"
        deep_result = {
            "messages": [AIMessage(content="done")],
            "files": output_markdown_file(report),
        }

        mock_agent = streaming_graph_mock(deep_result)

        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

            # Force the verifier to report "no valid citations" while leaving the report unchanged,
            # so we can assert post-processing does not synthesize a citation.
            with (
                # Pre-populate registry with the matching URL plus an unrelated tool source.
                seeded_session_registry(
                    SourceEntry(
                        citation_key="weather_observation_tool",
                        source_type="tool_result",
                        tool_name="weather_observation_tool",
                    ),
                    SourceEntry(url="https://docs.nvidia.com/cuda/", title="CUDA Docs", tool_name="web_search"),
                ),
                patch(
                    "aiq_agent.agents.deep_researcher.agent.verify_citations",
                    return_value=MagicMock(
                        verified_report=report,
                        removed_citations=[],
                        valid_citations=[],
                    ),
                ),
                patch(
                    "aiq_agent.agents.deep_researcher.agent.sanitize_report",
                    return_value=MagicMock(sanitized_report=sanitized_report),
                ),
                caplog.at_level("WARNING", logger="aiq_agent.agents.deep_researcher.agent"),
            ):
                state = DeepResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
                result = await agent.run(state)

        # The report itself is preserved verbatim; it now arrives under the
        # honesty banner that says nothing in it is provably grounded.
        assert result.messages[-1].content.endswith(sanitized_report)
        assert "Citation verification found no valid citations" in caplog.text

    @pytest.mark.asyncio
    async def test_no_valid_citations_marks_the_answer_degraded(self, mock_llm_provider, real_tool):
        """Zero valid citations is surfaced on the state, not only in the log."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        report = "CUDA findings here [1].\n\n## Sources\n[1] CUDA Docs: https://docs.nvidia.com/cuda/"
        deep_result = {
            "messages": [AIMessage(content="done")],
            "files": output_markdown_file(report),
        }
        mock_agent = streaming_graph_mock(deep_result)

        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

            with (
                seeded_session_registry(
                    SourceEntry(url="https://docs.nvidia.com/cuda/", title="CUDA Docs", tool_name="web_search")
                ),
                patch(
                    "aiq_agent.agents.deep_researcher.agent.verify_citations",
                    return_value=MagicMock(
                        verified_report=report,
                        removed_citations=[],
                        valid_citations=[],
                    ),
                ),
            ):
                state = DeepResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
                result = await agent.run(state)

        assert result.degraded_reasons == ["no_valid_citations"]
        # Not a cutoff: only the degradation is announced.
        assert result.research_truncated is None
        assert result.messages[-1].content.startswith("> **Hinweis:**")
        assert "eingeschränkt belastbar" in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_run_fails_when_registry_is_empty_despite_report(self, mock_llm_provider, real_tool):
        """A report produced with zero captured sources is unverifiable, so the run fails."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
        from aiq_agent.common.citation_verification import EmptySourceRegistryError

        report = "Completed report without captured sources."
        deep_result = {
            "messages": [AIMessage(content="done")],
            "files": output_markdown_file(report),
        }
        mock_agent = streaming_graph_mock(deep_result)

        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

            state = DeepResearchAgentState(messages=[HumanMessage(content="Write a report")])
            with pytest.raises(EmptySourceRegistryError):
                await agent.run(state)

    @pytest.mark.asyncio
    async def test_run_raises_empty_registry_error_when_nothing_to_salvage(self, mock_llm_provider, real_tool):
        """No report, no fallback message, no sources → EmptySourceRegistryError."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
        from aiq_agent.common.citation_verification import EmptySourceRegistryError

        mock_agent = streaming_graph_mock({"messages": [], "files": {}})

        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

            state = DeepResearchAgentState(messages=[HumanMessage(content="Write a report")])
            with pytest.raises(EmptySourceRegistryError):
                await agent.run(state)

    @pytest.mark.asyncio
    async def test_run_verifies_and_sanitizes_writer_markdown(self, mock_llm_provider, real_tool):
        """Final writer Markdown still goes through citation verification and sanitization."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        raw_answer = "CUDA docs are authoritative [1].\n\n## Sources\n[1] CUDA Docs: https://docs.nvidia.com/cuda/"
        verified_answer = raw_answer.replace("authoritative", "official")
        sanitized_answer = verified_answer + "\n"
        deep_result = {
            "messages": [AIMessage(content="done")],
            "files": output_markdown_file(raw_answer),
        }
        mock_agent = streaming_graph_mock(deep_result)

        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

            with (
                seeded_session_registry(
                    SourceEntry(url="https://docs.nvidia.com/cuda/", title="CUDA Docs", tool_name="web_search")
                ),
                patch(
                    "aiq_agent.agents.deep_researcher.agent.verify_citations",
                    return_value=MagicMock(
                        verified_report=verified_answer,
                        removed_citations=[],
                        valid_citations=[MagicMock()],
                    ),
                ) as verify,
                patch(
                    "aiq_agent.agents.deep_researcher.agent.sanitize_report",
                    return_value=MagicMock(sanitized_report=sanitized_answer),
                ) as sanitize,
            ):
                state = DeepResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
                result = await agent.run(state)

        verify.assert_called_once()
        sanitize.assert_called_once_with(verified_answer)
        assert result.messages[-1].content == sanitized_answer

    @pytest.mark.asyncio
    async def test_removed_citations_populate_citations_removed(self, mock_llm_provider, real_tool):
        """≥1 removed citation → the result carries a {count, reasons} transparency summary."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        report = "CUDA findings [1].\n\n## Sources\n[1] CUDA Docs: https://docs.nvidia.com/cuda/"
        sanitized_report = f"{report}\n"
        deep_result = {
            "messages": [AIMessage(content="done")],
            "files": output_markdown_file(report),
        }
        mock_agent = streaming_graph_mock(deep_result)

        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

            with (
                seeded_session_registry(
                    SourceEntry(url="https://docs.nvidia.com/cuda/", title="CUDA Docs", tool_name="web_search")
                ),
                patch(
                    "aiq_agent.agents.deep_researcher.agent.verify_citations",
                    return_value=MagicMock(
                        verified_report=report,
                        removed_citations=[
                            {"number": 2, "line": "[2] Bad: https://nope.example.com", "reason": "url_not_in_registry"},
                            {"number": 3, "line": "[3] Also bad", "reason": "url_not_in_registry"},
                            {"number": 4, "line": "[4] Mystery", "reason": "unverifiable"},
                        ],
                        valid_citations=[MagicMock()],
                    ),
                ),
                patch(
                    "aiq_agent.agents.deep_researcher.agent.sanitize_report",
                    return_value=MagicMock(sanitized_report=sanitized_report),
                ),
            ):
                state = DeepResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
                result = await agent.run(state)

        # count is the raw removed count; reasons deduplicated in first-seen order.
        assert result.citations_removed == {
            "count": 3,
            "reasons": ["url_not_in_registry", "unverifiable"],
        }

    @pytest.mark.asyncio
    async def test_no_removed_citations_leaves_field_none(self, mock_llm_provider, real_tool):
        """Nothing removed → citations_removed stays absent (None), never null-spammed."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        report = "CUDA findings [1].\n\n## Sources\n[1] CUDA Docs: https://docs.nvidia.com/cuda/"
        sanitized_report = f"{report}\n"
        deep_result = {
            "messages": [AIMessage(content="done")],
            "files": output_markdown_file(report),
        }
        mock_agent = streaming_graph_mock(deep_result)

        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=mock_agent,
        ):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

            with (
                seeded_session_registry(
                    SourceEntry(url="https://docs.nvidia.com/cuda/", title="CUDA Docs", tool_name="web_search")
                ),
                patch(
                    "aiq_agent.agents.deep_researcher.agent.verify_citations",
                    return_value=MagicMock(
                        verified_report=report,
                        removed_citations=[],
                        valid_citations=[MagicMock()],
                    ),
                ),
                patch(
                    "aiq_agent.agents.deep_researcher.agent.sanitize_report",
                    return_value=MagicMock(sanitized_report=sanitized_report),
                ),
            ):
                state = DeepResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
                result = await agent.run(state)

        assert result.citations_removed is None


class TestDeepResearcherQuoteVerification:
    """Deep researcher annotates fabricated quotes inline."""

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        provider.configure(LLMRole.ORCHESTRATOR, mock_llm)
        provider.configure(LLMRole.PLANNER, mock_llm)
        provider.configure(LLMRole.RESEARCHER, mock_llm)
        provider.configure(LLMRole.REPORT_WRITER, mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        return web_search_tool

    _KB_ENTRY = SourceEntry(
        citation_key="OIB-330.pdf, p.12",
        source_type="knowledge_layer",
        tool_name="knowledge_search",
        chunk_text="Die lichte Durchgangshoehe von Treppen muss mindestens 2,10 m betragen.",
    )

    async def _run(self, mock_llm_provider, real_tool, markdown):
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        mock_agent = streaming_graph_mock(
            {"messages": [AIMessage(content="handoff")], "files": output_markdown_file(markdown)}
        )
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
            state = DeepResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])
            with seeded_session_registry(self._KB_ENTRY):
                return await agent.run(state)

    @pytest.mark.asyncio
    async def test_fabricated_quote_annotated_inline(self, mock_llm_provider, real_tool):
        markdown = (
            "Laut Norm gilt „Treppen muessen mit einer automatischen Loeschanlage "
            'ausgestattet sein" [1].\n\n## Sources\n[1] OIB-330.pdf, p.12'
        )
        result = await self._run(mock_llm_provider, real_tool, markdown)
        output = result.messages[-1].content
        assert "[nicht wörtlich in der Quelle belegt]" in output
        # Fail-open: the fabricated sentence is preserved verbatim.
        assert "automatischen Loeschanlage" in output

    @pytest.mark.asyncio
    async def test_verbatim_quote_not_annotated(self, mock_llm_provider, real_tool):
        markdown = (
            "Es gilt: „Die lichte Durchgangshoehe von Treppen muss mindestens 2,10 m "
            'betragen" [1].\n\n## Sources\n[1] OIB-330.pdf, p.12'
        )
        result = await self._run(mock_llm_provider, real_tool, markdown)
        output = result.messages[-1].content
        assert "[nicht wörtlich in der Quelle belegt]" not in output


class TestSessionRegistryBinding:
    """The live citation stream needs a registry to read; the chat path owns its own.

    In a Dask worker nothing binds a session registry, so every knowledge-base
    and OIB citation failed the "was this actually retrieved?" check and was
    never marked as cited -- a run citing four Richtlinien and one web page
    showed the web page alone. The run binds its own registry so the check has
    something true to read, and must NOT bind over the chat entrypoint's, which
    deliberately spans turns.
    """

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        for role in (
            LLMRole.ORCHESTRATOR,
            LLMRole.ROUTER,
            LLMRole.PLANNER,
            LLMRole.RESEARCHER,
            LLMRole.REPORT_WRITER,
        ):
            provider.configure(role, mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        return web_search_tool

    async def _run_capturing_registry(self, agent):
        """Run the agent, returning what get_session_registry() saw mid-run."""
        from aiq_agent.common.citation_verification import get_session_registry

        seen = []
        graph = streaming_graph_mock({"messages": [], "files": output_markdown_file()})
        original = graph.astream.side_effect

        def _spy(*args, **kwargs):
            seen.append(get_session_registry())
            return original(*args, **kwargs)

        graph.astream = MagicMock(side_effect=_spy)
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=graph):
            await agent.run(DeepResearchAgentState(messages=[HumanMessage(content="Q")]))
        return seen[0]

    @pytest.mark.asyncio
    async def test_binds_the_runs_registry_when_nothing_is_bound(self, mock_llm_provider, real_tool):
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
        from aiq_agent.common.citation_verification import get_session_registry

        # Citation verification off: this run captures no sources (the graph is a
        # mock), and an unverifiable report is correctly a hard failure -- which
        # is a different behaviour than the one under test here.
        agent = DeepResearcherAgent(
            llm_provider=mock_llm_provider, tools=[real_tool], enable_citation_verification=False
        )
        during = await self._run_capturing_registry(agent)

        assert during is not None, "the worker run bound no registry, so citations cannot be recognised"
        # Reset afterwards: a Dask worker is reused, and a leaked registry would
        # hand the next job a previous question's sources.
        assert get_session_registry() is None

    @pytest.mark.asyncio
    async def test_leaves_an_existing_session_registry_alone(self, mock_llm_provider, real_tool):
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
        from aiq_agent.common.citation_verification import get_session_registry

        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        with seeded_session_registry(SourceEntry(url="https://conversation.example")):
            conversation = get_session_registry()
            during = await self._run_capturing_registry(agent)
            # The conversation's registry spans TURNS; narrowing it to this one
            # run would lose cross-turn source continuity.
            assert during is conversation
            assert get_session_registry() is conversation


class TestDeepReportConfidence:
    """The writer's `[CONFIDENCE:...]` self-assessment: stripped, capped, surfaced.

    Deep answers shipped without the confidence chip every shallow answer wears,
    so the product's "is this trustworthy?" affordance was simply missing on the
    longest reports it writes. These tests pin the three things that must hold:
    the marker never reaches a reader, the level never exceeds what the run can
    back up, and a malformed marker costs nothing but the chip.
    """

    #: A knowledge-base passage the fixtures below cite, so citation verification
    #: and quote verification both have something real to check against.
    _KB_ENTRY = SourceEntry(
        citation_key="OIB-330.pdf, p.12",
        source_type="knowledge_layer",
        tool_name="knowledge_search",
        chunk_text="Die lichte Durchgangshoehe von Treppen muss mindestens 2,10 m betragen.",
    )

    #: Long enough to clear MIN_SALVAGE_REPORT_CHARS on the cutoff path.
    _BODY = (
        "## Ergebnis\n\n"
        "Die lichte Durchgangshoehe von Treppen betraegt mindestens 2,10 m und ist "
        "damit fuer die geplante Nutzung ausreichend bemessen; die uebrigen "
        "Anforderungen an Steigungsverhaeltnis und Handlauf bleiben davon "
        "unberuehrt [1].\n\n"
        "## Sources\n[1] OIB-330.pdf, p.12"
    )

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        provider.configure(LLMRole.ORCHESTRATOR, mock_llm)
        provider.configure(LLMRole.PLANNER, mock_llm)
        provider.configure(LLMRole.RESEARCHER, mock_llm)
        provider.configure(LLMRole.REPORT_WRITER, mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        return web_search_tool

    @staticmethod
    def _report(marker: str | None = None, body: str | None = None) -> str:
        """A written report, optionally ending in a confidence marker line."""
        text = body if body is not None else TestDeepReportConfidence._BODY
        return f"{text}\n{marker}" if marker else text

    async def _run(self, mock_llm_provider, real_tool, markdown, *, callbacks=None, cutoff=False):
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        mock_agent = streaming_graph_mock(
            {"messages": [AIMessage(content="handoff")], "files": output_markdown_file(markdown)},
            hang=cutoff,
        )
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=mock_agent):
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                callbacks=list(callbacks or []),
                max_run_seconds=1 if cutoff else 0,
            )
            state = DeepResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])
            with seeded_session_registry(self._KB_ENTRY):
                return await agent.run(state)

    @pytest.mark.asyncio
    async def test_grounded_report_surfaces_the_writers_own_level(self, mock_llm_provider, real_tool):
        """Verified citations and no fabricated quote → the self-report stands."""
        result = await self._run(
            mock_llm_provider,
            real_tool,
            self._report("[CONFIDENCE:high | OIB-330 woertlich belegt]"),
        )

        assert result.answer_confidence == "high"
        assert result.answer_confidence_reason == "OIB-330 woertlich belegt"
        assert result.answer_confidence_capped_reason is None

    @pytest.mark.asyncio
    async def test_marker_never_survives_into_the_returned_report(self, mock_llm_provider, real_tool):
        """The control token must not reach the reader, the socket, or the PDF."""

        class _Emitter:
            """The narrowest stand-in for the streaming callback: it only emits."""

            def __init__(self) -> None:
                self.emitted: list[str] = []

            def emit_final_report(self, report: str) -> None:
                self.emitted.append(report)

        emitter = _Emitter()
        result = await self._run(
            mock_llm_provider,
            real_tool,
            self._report("[CONFIDENCE:medium | Nur eine Quelle]"),
            callbacks=[emitter],
        )

        answer = result.messages[-1].content
        assert "CONFIDENCE" not in answer
        assert "Nur eine Quelle" not in answer
        # The report itself is otherwise untouched.
        assert "2,10 m" in answer
        # And the re-emitted report the frontend overwrites with is just as clean.
        assert emitter.emitted and "CONFIDENCE" not in emitter.emitted[-1]

    @pytest.mark.asyncio
    async def test_cutoff_run_cannot_ship_high_confidence(self, mock_llm_provider, real_tool):
        """A run that never finished gathering evidence is capped below "high"."""
        result = await self._run(
            mock_llm_provider,
            real_tool,
            self._report("[CONFIDENCE:high | Alles belegt]"),
            cutoff=True,
        )

        assert result.research_truncated is True
        assert result.answer_confidence == "medium"
        # Truncation speaks through its own channel; it invents no cap token.
        assert result.answer_confidence_capped_reason is None
        assert "CONFIDENCE" not in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_cutoff_does_not_raise_a_modest_self_report(self, mock_llm_provider, real_tool):
        """The ceiling only clamps down: "low" stays "low" on a salvaged run."""
        result = await self._run(
            mock_llm_provider,
            real_tool,
            self._report("[CONFIDENCE:low | Recherche unvollstaendig]"),
            cutoff=True,
        )

        assert result.answer_confidence == "low"

    @pytest.mark.asyncio
    async def test_malformed_marker_degrades_to_no_confidence(self, mock_llm_provider, real_tool):
        """An invented level yields no chip — and is still stripped from the report."""
        result = await self._run(
            mock_llm_provider,
            real_tool,
            self._report("[CONFIDENCE:absolut sicher | Bauchgefuehl]"),
        )

        assert result.answer_confidence is None
        assert result.answer_confidence_reason is None
        assert result.answer_confidence_capped_reason is None
        answer = result.messages[-1].content
        assert "CONFIDENCE" not in answer
        assert "Bauchgefuehl" not in answer
        # Fail-open: the report still ships.
        assert "2,10 m" in answer

    @pytest.mark.asyncio
    async def test_missing_marker_leaves_the_answer_unassessed(self, mock_llm_provider, real_tool):
        """No marker is "not assessed", never a level — and never a failed run."""
        result = await self._run(mock_llm_provider, real_tool, self._report())

        assert result.answer_confidence is None
        assert result.answer_confidence_reason is None
        assert "2,10 m" in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_ungrounded_report_is_capped_to_low(self, mock_llm_provider, real_tool):
        """Nothing survived verification → "low", named as ungrounded."""
        body = "## Ergebnis\n\nDie Hoehe ist ausreichend bemessen.\n\n## Sources\n[1] Kein Nachweis"
        result = await self._run(mock_llm_provider, real_tool, self._report("[CONFIDENCE:high]", body=body))

        assert result.degraded_reasons == ["no_valid_citations"]
        assert result.answer_confidence == "low"
        assert result.answer_confidence_capped_reason == "ungrounded"

    @pytest.mark.asyncio
    async def test_fabricated_quote_caps_the_whole_answer(self, mock_llm_provider, real_tool):
        """One quote that is not in the source drops the report to "low"."""
        body = (
            'Laut Richtlinie gilt „Treppen muessen eine Loeschanlage haben" [1].\n\n## Sources\n[1] OIB-330.pdf, p.12'
        )
        result = await self._run(mock_llm_provider, real_tool, self._report("[CONFIDENCE:high]", body=body))

        assert result.answer_confidence == "low"
        assert result.answer_confidence_capped_reason == "quote_unverified"

    @pytest.mark.asyncio
    async def test_citation_health_ledger_records_the_cap_and_no_fallback(self, mock_llm_provider, real_tool):
        """The ledger finally gets a cap reason — and deep's explicit "never falls back"."""
        body = "## Ergebnis\n\nDie Hoehe ist ausreichend bemessen.\n\n## Sources\n[1] Kein Nachweis"
        with patch("aiq_agent.agents.deep_researcher.agent.citation_events.record_turn") as record_turn:
            await self._run(mock_llm_provider, real_tool, self._report("[CONFIDENCE:high]", body=body))

        kwargs = record_turn.call_args.kwargs
        assert kwargs["agent"] == "deep"
        assert kwargs["confidence_capped_reason"] == "ungrounded"
        assert kwargs["fallback_used"] is False


class TestCallbackRegistryHandover:
    """The live citation stream is handed the registry, not left to find one.

    The callback resolves a registry in three tiers: one handed to it, then the
    session contextvar, then its own mirror. Tier 2 works and is what production
    ran on -- but a contextvar does not survive every thread hop LangChain's
    callback machinery can make, and when it is lost the symptom is not an
    error: it is a Richtlinie the run genuinely retrieved, silently reported as
    uncited. Tier 1 is the one that cannot be lost, so it has to be wired.
    """

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        for role in (
            LLMRole.ORCHESTRATOR,
            LLMRole.ROUTER,
            LLMRole.PLANNER,
            LLMRole.RESEARCHER,
            LLMRole.REPORT_WRITER,
        ):
            provider.configure(role, mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        return web_search_tool

    def test_a_callback_that_can_hold_a_registry_is_given_one(self, mock_llm_provider, real_tool):
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        received = []

        class RegistryHolder:
            def set_source_registry(self, source_registry):
                received.append(source_registry)

        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool], callbacks=[RegistryHolder()])
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=streaming_graph_mock({"messages": [], "files": output_markdown_file()}),
        ):
            artifacts = agent._prepare_run(DeepResearchAgentState(messages=[HumanMessage(content="Q")]))

        assert len(received) == 1, "the run built a registry and handed it to nobody"
        # The ACCESSOR, not the registry object: the middleware swaps in a
        # session-scoped registry mid-run, and a callback holding the first one
        # would judge the report against a registry the run stopped using.
        assert callable(received[0])
        assert received[0]() is artifacts.source_registry_middleware.active_registry()

    def test_each_run_hands_over_its_own_registry(self, mock_llm_provider, real_tool):
        """Two runs of one agent must not share a registry (ADR-0018)."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        received = []

        class RegistryHolder:
            def set_source_registry(self, source_registry):
                received.append(source_registry)

        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool], callbacks=[RegistryHolder()])
        state = DeepResearchAgentState(messages=[HumanMessage(content="Q")])
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=streaming_graph_mock({"messages": [], "files": output_markdown_file()}),
        ):
            first = agent._prepare_run(state)
            second = agent._prepare_run(state)

        assert len(received) == 2
        assert received[0]() is first.source_registry_middleware.active_registry()
        assert received[1]() is second.source_registry_middleware.active_registry()
        assert received[0]() is not received[1]()

    def test_a_callback_without_the_seam_is_left_alone(self, mock_llm_provider, real_tool):
        """Most callbacks are trace sinks; handing them a registry must not crash."""
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        plain = MagicMock(spec=[])  # no attributes at all
        agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool], callbacks=[plain])
        with patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=streaming_graph_mock({"messages": [], "files": output_markdown_file()}),
        ):
            agent._prepare_run(DeepResearchAgentState(messages=[HumanMessage(content="Q")]))


class TestReportSinkCannotUnmakeTheAnswer:
    """A display that throws must not destroy the answer it was handed.

    ``emit_final_report`` runs inside ``_finalize``, and ``_finalize_cutoff``
    reads a raised ``_finalize`` as "nothing to salvage" — so an unguarded sink
    could throw away a verified report that existed and then log the false
    sentence "nothing salvageable" about it. Delivering the answer outranks
    echoing it: a sink that fails costs its own echo and nothing else.
    """

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        for role in (
            LLMRole.ORCHESTRATOR,
            LLMRole.ROUTER,
            LLMRole.PLANNER,
            LLMRole.RESEARCHER,
            LLMRole.REPORT_WRITER,
        ):
            provider.configure(role, mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        return web_search_tool

    @pytest.mark.asyncio
    async def test_a_raising_sink_still_returns_the_report(self, mock_llm_provider, real_tool):
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent

        class ExplodingSink:
            def emit_final_report(self, report, cards=None):
                raise RuntimeError("the display is down")

        report = "Brandabschnitte sind zu begrenzen [1].\n\n## Sources\n[1] Example: https://example.com"
        graph = streaming_graph_mock(
            {"messages": [AIMessage(content="handoff")], "files": output_markdown_file(report)}
        )
        with patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=graph):
            agent = DeepResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
                callbacks=[ExplodingSink()],
            )
            with seeded_session_registry(SourceEntry(url="https://example.com")):
                result = await agent.run(DeepResearchAgentState(messages=[HumanMessage(content="Q")]))

        # The answer survives the display failing: run() RETURNED (rather than
        # raising into the "nothing salvageable" path) and the verified report
        # is on the message it replaced.
        assert result is not None
        assert result.messages, "a failing echo destroyed the answer"
        assert "Brandabschnitte" in str(result.messages[-1].content)


class TestSalvageBarExcludesOurOwnBanner:
    """The bar measures the REPORT, not the banner we prepended to it.

    ``MIN_SALVAGE_REPORT_CHARS`` exists so a stub is not shipped as an answer.
    The honesty banner is ~135 characters the agent wrote ABOUT the run, so
    counting it would let a stub clear the bar purely because it had been
    labelled as a stub — the label buying the thing it labels a pass.

    Unpinned until now: an independent check reverted this to
    ``len(text.strip())`` and the whole backend suite stayed green, because the
    existing fixture's stub was short enough to fail either way. Any body of
    65-199 characters shipped as a report with nothing noticing, which is the
    window this fixes.
    """

    def test_a_banner_does_not_buy_a_stub_a_pass(self):
        from aiq_agent.agents.deep_researcher.agent import _HONESTY_BANNER_PREFIX
        from aiq_agent.agents.deep_researcher.agent import MIN_SALVAGE_REPORT_CHARS
        from aiq_agent.agents.deep_researcher.agent import _salvaged_report_length

        # A body inside the dangerous window: too short to be an answer, long
        # enough that the banner would carry it over the bar.
        body = "Die Recherche fand nur einen Hinweis auf GK4."
        assert len(body) < MIN_SALVAGE_REPORT_CHARS
        banner = f"{_HONESTY_BANNER_PREFIX} Die Recherche wurde vorzeitig beendet (Zeitgrenze erreicht)."
        banner_text = f"{banner}\n\n{body}"

        # The naive measure would pass it; the real one must not.
        assert _salvaged_report_length(banner_text) == len(body)
        assert _salvaged_report_length(banner_text) < MIN_SALVAGE_REPORT_CHARS

    def test_the_window_is_real(self):
        """A banner+body that the naive measure WOULD have cleared."""
        from aiq_agent.agents.deep_researcher.agent import _HONESTY_BANNER_PREFIX
        from aiq_agent.agents.deep_researcher.agent import MIN_SALVAGE_REPORT_CHARS
        from aiq_agent.agents.deep_researcher.agent import _salvaged_report_length

        body = "x" * (MIN_SALVAGE_REPORT_CHARS - 30)
        banner = f"{_HONESTY_BANNER_PREFIX} " + ("y" * 120)
        combined = f"{banner}\n\n{body}"
        # Naive: over the bar. Correct: under it.
        assert len(combined.strip()) >= MIN_SALVAGE_REPORT_CHARS
        assert _salvaged_report_length(combined) < MIN_SALVAGE_REPORT_CHARS

    def test_an_unbannered_report_is_measured_whole(self):
        from aiq_agent.agents.deep_researcher.agent import _salvaged_report_length

        report = "Brandabschnitte sind zu begrenzen. " * 10
        assert _salvaged_report_length(report) == len(report.strip())


class TestUpstreamTimeoutIsNotTheBudget:
    """A provider hiccup must not be counted as a budget overrun.

    ``asyncio.wait_for`` raises ``TimeoutError``, and so does any provider or
    transport call that times out inside the graph -- indistinguishably, since
    ``asyncio.TimeoutError`` IS ``TimeoutError``. Blaming the budget for both
    made an operator counting overruns count a 30-second hiccup as a
    2400-second one: worse than no metric, because it reads as evidence for
    raising a budget that was never reached.

    Both are salvaged identically. They are only NAMED apart.
    """

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = LLMProvider()
        provider.set_default(mock_llm)
        for role in (
            LLMRole.ORCHESTRATOR,
            LLMRole.ROUTER,
            LLMRole.PLANNER,
            LLMRole.RESEARCHER,
            LLMRole.REPORT_WRITER,
        ):
            provider.configure(role, mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        return web_search_tool

    @pytest.mark.asyncio
    async def test_an_inner_timeout_is_named_upstream_not_wall_clock(self, mock_llm_provider, real_tool):
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
        from aiq_agent.common.turn_status import CUTOFF_UPSTREAM_TIMEOUT

        # Raised from INSIDE the graph, immediately -- nowhere near the budget.
        graph = streaming_graph_mock(error=TimeoutError("provider read timed out"))
        seen: dict[str, object] = {}

        def _capture(*, reason, **kwargs):
            seen["reason"] = reason

        with (
            patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=graph),
            patch("aiq_agent.agents.deep_researcher.agent.emit_deep_research_cutoff", _capture),
        ):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool], max_run_seconds=2400)
            with pytest.raises(TimeoutError, match="upstream timeout"):
                await agent.run(DeepResearchAgentState(messages=[HumanMessage(content="Q")]))

        assert seen["reason"] == CUTOFF_UPSTREAM_TIMEOUT, (
            "a provider timeout was counted as a wall-clock budget overrun"
        )

    @pytest.mark.asyncio
    async def test_the_real_budget_is_still_named_wall_clock(self, mock_llm_provider, real_tool):
        from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
        from aiq_agent.common.turn_status import CUTOFF_WALL_CLOCK

        graph = streaming_graph_mock(hang=True)
        seen: dict[str, object] = {}

        def _capture(*, reason, **kwargs):
            seen["reason"] = reason

        with (
            patch("aiq_agent.agents.deep_researcher.factory.create_deep_agent", return_value=graph),
            patch("aiq_agent.agents.deep_researcher.agent.emit_deep_research_cutoff", _capture),
        ):
            agent = DeepResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool], max_run_seconds=1)
            with pytest.raises(TimeoutError, match="wall-clock budget"):
                await agent.run(DeepResearchAgentState(messages=[HumanMessage(content="Q")]))

        assert seen["reason"] == CUTOFF_WALL_CLOCK

"""Tests for the ShallowResearcherAgent."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.shallow_researcher.agent import _INTERACTION_TOOL_ALLOWANCE
from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
from aiq_agent.agents.shallow_researcher.agent import _append_minimal_citation
from aiq_agent.agents.shallow_researcher.agent import _count_interaction_calls
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common.answer_envelope import render_envelope_response_format
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.data_source_registry import populate_from_config
from aiq_agent.common.data_source_registry import reset_registry


async def _run_with_captured_registry(agent, state):
    """Run the agent with a bound session registry and return (result, registry).

    Standalone runs use a fresh per-run registry (discarded afterwards) instead
    of the shared instance one, so tests observe source capture by binding a
    session registry for the duration of the run.
    """
    registry = SourceRegistry()
    token = set_session_registry(registry)
    try:
        result = await agent.run(state)
    finally:
        reset_session_registry(token)
    return result, registry


async def _run_with_bound_registry(agent, state, registry):
    """Run the agent with a caller-supplied (pre-populated) session registry.

    Lets a test seed the registry with prior-turn sources — mirroring the
    cumulative per-session registry hydrated from Redis — so the emission path's
    citation→SourceEntry resolution (entry_for_url / entry_for_citation_key)
    finds real entries.
    """
    token = set_session_registry(registry)
    try:
        result = await agent.run(state)
    finally:
        reset_session_registry(token)
    return result


@tool
def web_search_tool(query: str) -> str:
    """Search the web for information."""
    return f"Results for: {query}"


@tool
def emit_card(card_json: str) -> str:
    """Render a rich UI card alongside your answer."""
    return f"Card will be shown with your answer: {card_json}"


@tool
def describe_card(card_types: str) -> str:
    """Return the exact JSON shape for one or more card types."""
    return f"Shapes for: {card_types}"


class TestShallowResearcherAgent:
    """Tests for the ShallowResearcherAgent class."""

    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        """Bypass citation verification for tests that don't test it.

        These tests mock the LLM to return AIMessage directly (no tool calls),
        so no tools execute and the source registry stays empty. Patching the
        pipeline avoids EmptySourceRegistryError in run().
        """
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify,
            patch("aiq_agent.agents.shallow_researcher.agent.sanitize_report") as mock_sanitize,
        ):
            mock_verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
                verified_report=content, removed_citations=[]
            )
            mock_sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

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
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.fixture
    def real_tool(self):
        """Create a real LangChain tool."""
        return web_search_tool

    def test_init_with_defaults(self, mock_llm_provider, real_tool):
        """Test ShallowResearcherAgent initialization with defaults."""
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert agent.llm_provider == mock_llm_provider
        assert len(agent.tools) == 1
        assert agent.max_llm_turns == 10
        assert agent.max_tool_iterations == 5
        assert agent.callbacks == []
        assert agent.system_prompt is not None

    def test_init_with_custom_prompt(self, mock_llm_provider, real_tool):
        """Test ShallowResearcherAgent initialization with custom system prompt."""
        custom_system = "Custom system prompt"
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            system_prompt=custom_system,
        )
        assert agent.system_prompt == custom_system

    def test_init_with_custom_limits(self, mock_llm_provider, real_tool):
        """Test ShallowResearcherAgent initialization with custom limits."""
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            max_llm_turns=5,
            max_tool_iterations=3,
        )

        assert agent.max_llm_turns == 5
        assert agent.max_tool_iterations == 3

    def test_init_with_callbacks(self, mock_llm_provider, real_tool):
        """Test ShallowResearcherAgent initialization with callbacks."""
        callbacks = [MagicMock()]
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            callbacks=callbacks,
        )

        assert agent.callbacks == callbacks

    def test_init_with_empty_tools(self, mock_llm_provider):
        """Test ShallowResearcherAgent initialization with empty tools."""
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[],
        )

        assert agent.tools == []
        assert agent.tools_info == []

    def test_build_tools_info(self, mock_llm_provider, real_tool):
        """Test _build_tools_info correctly extracts tool information."""
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert len(agent.tools_info) == 1
        assert agent.tools_info[0]["name"] == "web_search_tool"
        assert "Search the web" in agent.tools_info[0]["description"]

    def test_get_llm(self, mock_llm_provider, mock_llm, real_tool):
        """Test _get_llm returns LLM from provider."""
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        result = agent._get_llm()

        mock_llm_provider.get.assert_called_with(LLMRole.RESEARCHER)
        assert result == mock_llm

    def test_graph_property(self, mock_llm_provider, real_tool):
        """Test graph property returns compiled graph."""
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert agent.graph is not None
        assert agent.graph == agent._graph

    @pytest.mark.asyncio
    async def test_run_basic_query(self, mock_llm_provider, mock_llm, real_tool):
        """Test run() with a basic query."""
        # Create a proper AI response for the agent node
        agent_response = AIMessage(content="CUDA is a parallel computing platform.")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])

        result = await agent.run(state)

        assert result is not None
        assert result.messages is not None

    @pytest.mark.asyncio
    async def test_run_with_callbacks(self, mock_llm_provider, mock_llm, real_tool):
        """Test run() passes callbacks to config."""
        agent_response = AIMessage(content="Answer")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        mock_callback = MagicMock()
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            callbacks=[mock_callback],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="Test")])

        await agent.run(state)

        # Agent should complete without errors

    @pytest.mark.asyncio
    async def test_run_extracts_and_strips_control_markers(self, mock_llm_provider, mock_llm, real_tool):
        """Both control markers are stripped before emit_final_report and in the returned message.

        The detected signals are carried as structured state fields.
        """
        from langchain_core.callbacks import BaseCallbackHandler

        agent_response = AIMessage(content="The answer body.\n[CONFIDENCE:high]\n[ESCALATE_TO_DEEP]")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        class _EmitCallback(BaseCallbackHandler):
            def __init__(self):
                self.reports = []

            def emit_final_report(self, content):
                self.reports.append(content)

        emit_callback = _EmitCallback()
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            callbacks=[emit_callback],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state)

        # emit_final_report received marker-free content.
        assert len(emit_callback.reports) == 1
        emitted = emit_callback.reports[0]
        assert "[CONFIDENCE" not in emitted
        assert "[ESCALATE_TO_DEEP]" not in emitted

        # Returned message content is marker-free too.
        final_content = result.messages[-1].content
        assert "[CONFIDENCE" not in final_content
        assert "[ESCALATE_TO_DEEP]" not in final_content

        # Structured signals populated (escalation_requested is a bool, i.e. not
        # None, signalling extraction ran on a real answer message).
        assert result.escalation_requested is True
        assert result.answer_confidence_marker == "high"

    @pytest.mark.asyncio
    async def test_run_without_markers_sets_neutral_structured_signals(self, mock_llm_provider, mock_llm, real_tool):
        """A clean answer still marks extraction done, with neutral signals."""
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content="A clean grounded answer [1]."))
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        # Extraction ran on a real answer message → escalation_requested is the
        # bool False (not the None "not-extracted" sentinel); no markers present.
        assert result.escalation_requested is False
        assert result.answer_confidence_marker is None

    @pytest.mark.asyncio
    async def test_run_flattens_list_shaped_answer_content(self, mock_llm_provider, mock_llm, real_tool):
        """Reasoning models can return the answer as a list of content blocks.

        Regression: ``str(answer_msg.content)`` turned that list into a Python
        repr (``"[{'type': 'text', ...}]"``) as the answer text, which every
        downstream filter (marker extraction, citation checks) then no-oped on.
        The answer text must be the flattened block text, not the list repr.
        """
        agent_response = AIMessage(
            content=[
                {"type": "text", "text": "The flattened answer body [1]."},
                {"type": "text", "text": "[CONFIDENCE:high]"},
            ]
        )
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        final_content = result.messages[-1].content
        # Flattened prose, not a Python list repr.
        assert "The flattened answer body" in final_content
        assert "'type'" not in final_content
        assert not final_content.startswith("[{")
        # The marker embedded in a separate block was still detected + stripped.
        assert "[CONFIDENCE" not in final_content
        assert result.answer_confidence_marker == "high"

    # ------------------------------------------------------------------
    # The answer envelope, END TO END: a scripted ```answer_json reply goes
    # into the real run() and the structured state comes out the other side —
    # extraction, control-field consumption (confidence, escalation), the
    # deterministic gates and the versioned answer_meta wire payload. The
    # parser has its own unit suite (test_answer_envelope.py); these tests
    # exist so a wiring regression anywhere along that chain fails HERE.
    # ------------------------------------------------------------------

    @staticmethod
    def _envelope_reply(*, fenced: bool = True, **overrides):
        """One contract-shaped envelope reply, long enough to earn takeaways."""
        import json as _json

        prose = (
            "Die erforderliche Geländerhöhe für die Terrasse beträgt 100 cm, weil die "
            "Absturzhöhe unter 12 m liegt [1]. "
            + "Die Höhe wird vom fertigen Fußboden bis zur Oberkante der Umwehrung gemessen. "
            * 10
        )
        envelope = {
            "answer": prose + "\n\n## References\n- [1] https://example.com",
            "verdict": {
                "value": "100 cm",
                "subject": "Erforderliche Geländerhöhe",
                "reference": {"document": "OIB-Richtlinie 4", "section": "Punkt 2.1.1"},
            },
            "takeaways": [
                {"text": "Unter 12 m Absturzhöhe genügen 100 cm."},
                {"text": "Gemessen wird ab fertigem Fußboden.", "detail": "Aufkantungen zählen mit."},
            ],
            "callout": {"kind": "achtung", "text": "Ab 12 m Absturzhöhe sind 110 cm erforderlich."},
            "confidence": {"level": "medium", "reason": "eine Fundstelle, nicht am Projekt gemessen"},
            "summary": "Unter 12 m Absturzhöhe genügen 100 cm, gemessen ab fertigem Fußboden.",
        }
        envelope.update(overrides)
        body = _json.dumps(envelope, ensure_ascii=False)
        return f"```answer_json\n{body}\n```" if fenced else body

    @pytest.mark.asyncio
    async def test_run_consumes_a_full_answer_envelope(self, mock_llm_provider, mock_llm, real_tool):
        """Envelope in → prose out, confidence consumed, anatomy gated onto state."""
        from langchain_core.callbacks import BaseCallbackHandler

        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply()))

        class _EmitCallback(BaseCallbackHandler):
            def __init__(self):
                self.reports = []

            def emit_final_report(self, content):
                self.reports.append(content)

        emit_callback = _EmitCallback()
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool], callbacks=[emit_callback])

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Geländerhöhe Terrasse?")]))

        # The reader gets the PROSE — the envelope apparatus never reaches them.
        final_content = result.messages[-1].content
        assert "Die erforderliche Geländerhöhe für die Terrasse beträgt 100 cm" in final_content
        assert "```" not in final_content
        assert '"verdict"' not in final_content
        emitted = emit_callback.reports[-1]
        assert "```" not in emitted
        assert '"confidence"' not in emitted

        # The envelope's control fields were consumed, not just stripped.
        assert result.escalation_requested is False
        assert result.answer_confidence_marker == "medium"
        assert result.answer_confidence_marker_reason == "eine Fundstelle, nicht am Projekt gemessen"

        # The anatomy survived the gates and rides state as the versioned payload.
        assert result.answer_meta is not None
        assert result.answer_meta["v"] == 1
        assert result.answer_meta["verdict"]["value"] == "100 cm"
        assert result.answer_meta["summary"].startswith("Unter 12 m Absturzhöhe")
        assert result.answer_meta["verdict"]["reference"]["document"] == "OIB-Richtlinie 4"
        assert len(result.answer_meta["takeaways"]) == 2
        assert result.answer_meta["callout"]["kind"] == "achtung"

    @pytest.mark.asyncio
    async def test_run_accepts_the_bare_object_json_mode_produces(self, mock_llm_provider, mock_llm, real_tool):
        """Provider JSON mode emits an UNFENCED object; the chain must not care."""
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply(fenced=False)))
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        final_content = result.messages[-1].content
        assert "Die erforderliche Geländerhöhe für die Terrasse beträgt 100 cm" in final_content
        assert not final_content.strip().startswith("{")
        assert result.answer_confidence_marker == "medium"
        assert result.answer_meta is not None and result.answer_meta["verdict"]["value"] == "100 cm"

    @pytest.mark.asyncio
    async def test_run_keeps_one_placed_callout_marker(self, mock_llm_provider, mock_llm, real_tool):
        """A surviving callout keeps its FIRST own-line `[[callout]]`, and only that."""
        prose = (
            "Die erforderliche Geländerhöhe beträgt 100 cm [1].\n\n"
            "[[callout]]\n\n"
            "Weitere Erläuterung.\n\n[[callout]]\n\n"
            "## References\n- [1] https://example.com"
        )
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply(answer=prose)))
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        final_content = result.messages[-1].content
        assert final_content.count("[[callout]]") == 1
        assert result.answer_meta is not None and result.answer_meta["callout"]["kind"] == "achtung"

    @pytest.mark.asyncio
    async def test_run_strips_the_marker_when_no_callout_survived(self, mock_llm_provider, mock_llm, real_tool):
        """A marker with nothing behind it must never reach the reader."""
        prose = "Die Antwort [1].\n\n[[callout]]\n\nMehr Text.\n\n## References\n- [1] https://example.com"
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply(answer=prose, callout=None)))
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        assert "[[callout]]" not in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_run_envelope_escalation_discards_the_anatomy(self, mock_llm_provider, mock_llm, real_tool):
        """`escalate_to_deep: true` sets the signal and drops the decoration."""
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply(escalate_to_deep=True)))
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        # A shallow answer about to be superseded by deep research must not
        # ship a verdict for the discarded text.
        assert result.escalation_requested is True
        assert result.answer_meta is None
        assert result.answer_confidence_marker == "medium"

    # ------------------------------------------------------------------
    # Provider JSON mode for the envelope (`response_format: json_object`),
    # the OpenRouter-safe variant `cards/generate.py` established. Bound on
    # the tool-free forced-synthesis call; tool-bound iterations only by
    # explicit opt-in (`envelope_json_mode_with_tools`).
    # ------------------------------------------------------------------

    def _bindable(self, mock_llm, reply):
        """Configure `mock_llm.bind(...)` to return a working bound double."""
        bound = MagicMock()
        bound.ainvoke = AsyncMock(return_value=AIMessage(content=reply))
        mock_llm.bind = MagicMock(return_value=bound)
        return bound

    @pytest.mark.asyncio
    async def test_forced_synthesis_binds_json_mode_on_research_turns(self, mock_llm_provider, mock_llm, real_tool):
        """Budget exhausted on a research turn → the synthesis call requests JSON."""
        bound = self._bindable(mock_llm, self._envelope_reply(fenced=False))
        # Ceiling 0: the very first agent_node call is forced synthesis.
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool], max_tool_iterations=0)

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        # The strongest rung binds first: strict structured outputs, derived
        # from the envelope models themselves.
        mock_llm.bind.assert_called_once_with(response_format=render_envelope_response_format())
        bound.ainvoke.assert_awaited_once()
        # The JSON-mode response flowed through the same extraction chain.
        assert result.answer_confidence_marker == "medium"
        assert "```" not in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_json_mode_falls_back_to_a_plain_call(self, mock_llm_provider, mock_llm, real_tool):
        """A provider that rejects response_format degrades to prose, never fails."""
        bound = self._bindable(mock_llm, "")
        bound.ainvoke = AsyncMock(side_effect=RuntimeError("response_format not supported"))
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply()))
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool], max_tool_iterations=0)

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        # The whole ladder was tried in order — json_schema, then json_object —
        # before the plain call answered.
        formats = [call.kwargs["response_format"]["type"] for call in mock_llm.bind.call_args_list]
        assert formats == ["json_schema", "json_object"]
        mock_llm.ainvoke.assert_awaited()
        assert result.answer_confidence_marker == "medium"

    @pytest.mark.asyncio
    async def test_tool_bound_iterations_bind_json_mode_only_by_opt_in(self, mock_llm_provider, mock_llm, real_tool):
        """Default OFF on tool-bound calls (silent tool-suppression risk); flag turns it on."""
        mock_llm.bind = MagicMock()
        mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=self._envelope_reply()))
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))
        mock_llm.bind.assert_not_called()

        bound = self._bindable(mock_llm, self._envelope_reply())
        opted_in = ShallowResearcherAgent(
            llm_provider=mock_llm_provider, tools=[real_tool], envelope_json_mode_with_tools=True
        )
        result = await opted_in.run(ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")]))

        mock_llm.bind.assert_called_once_with(response_format=render_envelope_response_format())
        bound.ainvoke.assert_awaited_once()
        assert result.answer_confidence_marker == "medium"

    @pytest.mark.asyncio
    async def test_run_with_user_info(self, mock_llm_provider, mock_llm, real_tool):
        """Test run() with user info in state."""
        agent_response = AIMessage(content="Personalized answer")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        # Use custom system_prompt that doesn't require email field
        custom_prompt = "You are an assistant. User: {{ user_info }}."
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            system_prompt=custom_prompt,
        )

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            user_info={"name": "John", "role": "developer"},
        )

        result = await agent.run(state)

        assert result is not None

    @pytest.mark.asyncio
    async def test_run_with_tools_info_in_state(self, mock_llm_provider, mock_llm, real_tool):
        """Test run() uses tools_info from state if provided."""
        agent_response = AIMessage(content="Answer")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        custom_tools_info = [
            {"name": "custom_tool", "description": "A custom tool"},
        ]

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            tools_info=custom_tools_info,
        )

        result = await agent.run(state)

        assert result is not None

    def test_load_system_prompt_fallback(self, mock_llm_provider, real_tool):
        """Test _load_system_prompt returns fallback when file not found."""
        with patch(
            "aiq_agent.agents.shallow_researcher.agent.load_prompt",
            side_effect=FileNotFoundError(),
        ):
            agent = ShallowResearcherAgent(
                llm_provider=mock_llm_provider,
                tools=[real_tool],
            )
            assert "research" in agent.system_prompt.lower()

    def test_default_prompt_requires_tool_result_references(self, mock_llm_provider, real_tool):
        """Default prompt tells the model to cite non-URL tool results by exact tool name."""
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert "When you used a tool result to answer" in agent.system_prompt
        assert "exact tool name" in agent.system_prompt
        assert "- [1] mcp_time__get_current_time" in agent.system_prompt

    def test_default_prompt_matches_user_language(self, mock_llm_provider, real_tool):
        """Default prompt instructs the model to answer in the user's language."""
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        assert "Answer in the language of the user's request" in agent.system_prompt
        # German questions should get German answers.
        assert "German" in agent.system_prompt

    def test_default_prompt_keeps_escalate_marker_language_independent(self, mock_llm_provider, real_tool):
        """Language matching must NOT disturb the literal escalation marker contract."""
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        # The marker stays literal/language-independent alongside the new
        # language-matching instruction.
        assert "[ESCALATE_TO_DEEP]" in agent.system_prompt
        assert "exactly as written" in agent.system_prompt

    def _render_default_prompt(
        self,
        mock_llm_provider,
        real_tool,
        *,
        project_context: str | None = None,
    ) -> str:
        from aiq_agent.common import render_prompt_template

        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])
        return render_prompt_template(
            agent.system_prompt,
            tools=[{"name": real_tool.name, "description": "Search the web"}],
            user_info=None,
            current_datetime="2026-07-15",
            available_documents=[],
            project_context=project_context,
            ris_catalog=None,
        )

    def test_the_formatting_block_routes_a_diagram_to_a_drawing_card(self, mock_llm_provider, real_tool):
        """The model-side half of "a diagram printed as a shell listing".

        Asked for a diagram the model drew ASCII box art into a bare fence, and
        the answer promised a drawing and printed a listing. The formatting rule
        now routes a named diagram request to the drawing CARDS — the surface
        with the caption, the Fundstelle and the PDF path — keeps the ban on box
        art, and leaves the tagged mermaid fence only as the last resort.
        """
        rendered = self._render_default_prompt(mock_llm_provider, real_tool)
        formatting = rendered.split("<formatting>")[1].split("</formatting>")[0]
        assert "A picture is a CARD" in formatting
        assert "`diagram`" in formatting
        # The box-art ban must survive the rewrite: the third field
        # transcript drew box-drawing characters where a diagram was asked.
        assert "never draw with them" in formatting
        # And the fallback still names the notation that renders.
        assert "flowchart TD" in formatting
        # And the consequence, so an edit that keeps the rule and drops the
        # reason still fails: a listing where a drawing was promised.
        assert "monospace listing" in formatting
        assert "│" in formatting

    def test_project_memory_is_framed_as_fallible_not_binding(self, mock_llm_provider, real_tool):
        """The digest rides inside <project_context>, whose "binding constraints —
        never contradict them" rule is meant for CONFIRMED profile facts. Without an
        explicit carve-out, agent-authored `unverified` notes inherit that weight and
        the agent defends stale memory instead of accepting a correction."""
        rendered = self._render_default_prompt(
            mock_llm_provider,
            real_tool,
            project_context=(
                "PROJECT_MEMORY v1\n"
                '- [derived_fact | high | unverified] "Für Bergsteiggasse ist OIB-RL 2.1 nicht anwendbar"'
            ),
        )

        assert "not** confirmed project facts" in rendered
        assert "The current conversation outranks memory, always." in rendered
        assert "never argue the user out of their own correction" in rendered
        # Memory must never be laundered into a legal citation.
        assert "never a source for a legal requirement" in rendered

    def test_research_turn_prompt_keeps_the_envelope_mandate(self, mock_llm_provider, real_tool):
        """The envelope contract is rendered on every turn; there is no suppression note."""
        rendered = self._render_default_prompt(mock_llm_provider, real_tool)

        assert "<answer_envelope>" in rendered
        assert "<control_signals>" in rendered
        assert "Every researched answer carries `confidence`" in rendered
        # The schema the validator enforces is the one the model is taught —
        # injected by the renderer, never an empty block.
        assert "answer*: string" in rendered
        assert "escalate_to_deep" in rendered
        assert "classified as conversational / meta" not in rendered

    def test_the_confidence_marker_does_not_depend_on_having_sources(self, mock_llm_provider, real_tool):
        """A measured answer cites nothing, and used to drop the marker with it.

        On the first live run of this branch the marker was absent from 4 of 32
        real answers — and the split was not random. Every answer that produced
        a `**Quellen:**` section carried the marker (18/18); every answer that
        produced none dropped it 4 times in 14. The raw model output was
        captured BEFORE the strip, so this is the model omitting the marker,
        not the parser losing it.

        The cause is the shape of the contract rather than a lack of emphasis:
        the confidence line is step 3 of a research-turn shape whose steps 1
        and 2 are inline `[N]` citations and a sources section, and whose level
        definitions were written purely in terms of „the sources you actually
        retrieved". An answer built on an `ifc_measure` result has none of
        those, so the model dropped the whole shape. The prompt therefore has
        to say that step 3 stands alone, and to give a measurement somewhere to
        land among the levels.

        Nothing here makes the marker enforceable: a missing marker stays a
        soft degradation (no chip), never an error and never a retry.
        """
        rendered = self._render_default_prompt(mock_llm_provider, real_tool)

        # Grounding is evidence, not sources alone — a measurement counts.
        assert "the sources you retrieved AND the measurements you took" in rendered
        assert "a measurement made this turn" in rendered
        # And WHY it matters, which is what the model was never told.
        assert "An answer that cites nothing still carries it" in rendered
        assert "there is no confidence chip" in rendered

    @pytest.mark.asyncio
    async def test_tool_iterations_incremented_on_tool_calls(self, mock_llm_provider, mock_llm, real_tool):
        """Test tool_iterations counter increments when LLM makes tool calls."""
        # First call returns tool calls, second call returns final answer
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "web_search_tool", "args": {"query": "test"}, "id": "1"}],
        )
        final_response = AIMessage(content="Final answer")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            tool_iterations=0,
        )

        result = await agent.run(state)

        # tool_iterations should have been incremented
        assert result.tool_iterations >= 1

    @pytest.mark.asyncio
    async def test_forced_synthesis_at_max_iterations(self, mock_llm_provider, mock_llm, real_tool):
        """Test that agent forces synthesis when max_tool_iterations is reached."""
        # Response would normally include tool calls, but should be overridden
        final_response = AIMessage(content="Forced synthesis response")
        mock_llm.ainvoke = AsyncMock(return_value=final_response)

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            max_tool_iterations=3,
        )

        # Start with iterations already at max
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            tool_iterations=3,
        )

        result = await agent.run(state)

        assert result is not None
        # The unbounded LLM should have been called (without tools)
        mock_llm.ainvoke.assert_called()

    @pytest.mark.asyncio
    async def test_a_card_call_does_not_spend_the_research_budget(self, mock_llm_provider, mock_llm, real_tool):
        """The regression behind "an answer only ever carries one card".

        One search, then one ``emit_card``, on a research budget of one. Every
        tool call used to be charged to ``max_tool_iterations``, so the card
        round met ``iterations >= ceiling`` and the turn was forced into
        synthesis with "Do not attempt any further tool calls" — the card never
        reached the registry, and nothing in the answer said why. Cards are
        emitted LAST, after the searching, so the ceiling always landed on them
        rather than on the research.
        """
        search_round = AIMessage(
            content="",
            tool_calls=[{"name": "web_search_tool", "args": {"query": "test"}, "id": "1"}],
        )
        # A shape lookup and the first card, the way the tool description asks
        # for them: one `describe_card` for the types the answer wants, then the
        # cards. Three interaction calls in total across two rounds.
        first_card_round = AIMessage(
            content="",
            tool_calls=[
                {"name": "describe_card", "args": {"card_types": "verdict_header,typed_table"}, "id": "2"},
                {"name": "emit_card", "args": {"card_json": "{}"}, "id": "3"},
            ],
        )
        second_card_round = AIMessage(
            content="",
            tool_calls=[{"name": "emit_card", "args": {"card_json": "{}"}, "id": "4"}],
        )
        mock_llm.ainvoke = AsyncMock(
            side_effect=[search_round, first_card_round, second_card_round, AIMessage(content="Final answer")]
        )

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool, emit_card, describe_card],
            max_tool_iterations=2,
        )

        result = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Test query")]))

        # Only the search was research, so the turn never reached its ceiling
        # and was never cut off: the second card is emitted rather than refused.
        assert result.tool_iterations == 1
        assert result.interaction_iterations == 3
        assert result.research_truncated is None
        assert sum(1 for message in result.messages if getattr(message, "name", None) == "emit_card") == 2

    @pytest.mark.asyncio
    async def test_the_interaction_allowance_is_a_ceiling_not_a_free_pass(self, mock_llm_provider, mock_llm, real_tool):
        """Past the allowance an interaction call is charged like any other.

        Without this the tool loop would have no bound at all on the card
        channel: a model looping on ``emit_card`` would never reach
        ``tool_iteration_ceiling`` and would only stop at the recursion limit,
        which is an exception rather than an answer.
        """
        card_round = AIMessage(
            content="",
            tool_calls=[{"name": "emit_card", "args": {"card_json": "{}"}, "id": "1"}],
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[card_round, AIMessage(content="Final answer")])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool, emit_card],
            max_tool_iterations=5,
        )

        result = await agent.run(
            ShallowResearchAgentState(
                messages=[HumanMessage(content="Test query")],
                interaction_iterations=_INTERACTION_TOOL_ALLOWANCE,
            )
        )

        assert result.tool_iterations == 1
        assert result.interaction_iterations == _INTERACTION_TOOL_ALLOWANCE + 1

    def test_state_has_interaction_iterations_field(self):
        """The card channel's counter is per-turn state, defaulting to unspent."""
        state = ShallowResearchAgentState(messages=[])
        assert state.interaction_iterations == 0

    def test_state_has_tool_iterations_field(self):
        """Test that ShallowResearchAgentState has tool_iterations field."""
        state = ShallowResearchAgentState(messages=[HumanMessage(content="Test")])
        assert hasattr(state, "tool_iterations")
        assert state.tool_iterations == 0

    def test_state_tool_iterations_default_value(self):
        """Test tool_iterations defaults to 0."""
        state = ShallowResearchAgentState(messages=[HumanMessage(content="Test")])
        assert state.tool_iterations == 0

    def test_state_tool_iterations_can_be_set(self):
        """Test tool_iterations can be set to custom value."""
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Test")],
            tool_iterations=5,
        )
        assert state.tool_iterations == 5

    @pytest.mark.asyncio
    async def test_run_returns_updated_tool_iterations(self, mock_llm_provider, mock_llm, real_tool):
        """Test that run() returns state with updated tool_iterations."""
        agent_response = AIMessage(content="Answer")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
        )

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Test")],
            tool_iterations=0,
        )

        result = await agent.run(state)

        # Result should have tool_iterations field
        assert hasattr(result, "tool_iterations")

    @pytest.mark.asyncio
    async def test_forced_synthesis_adds_instruction_message(self, mock_llm_provider, mock_llm, real_tool):
        """Test that forced synthesis adds instruction to synthesize."""
        captured_messages = []

        async def capture_messages(messages):
            captured_messages.append(messages)
            return AIMessage(content="Synthesized response")

        mock_llm.ainvoke = AsyncMock(side_effect=capture_messages)

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[real_tool],
            max_tool_iterations=2,
        )

        # Start at max iterations to trigger forced synthesis
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Test query")],
            tool_iterations=2,
        )

        await agent.run(state)

        # Check that synthesis instruction was added
        last_call_messages = captured_messages[0]
        synthesis_instruction_found = any(
            "synthesize" in str(msg.content).lower() for msg in last_call_messages if hasattr(msg, "content")
        )
        assert synthesis_instruction_found


# ---------------------------------------------------------------------------
# Integration tests — verify end-to-end source capture without bypasses
# ---------------------------------------------------------------------------


@tool
def web_search_with_urls(query: str) -> str:
    """Search the web and return results with URLs."""
    return (
        '<Document href="https://docs.nvidia.com/cuda/">\n'
        "<title>\nCUDA Toolkit Documentation\n</title>\n"
        "CUDA is a parallel computing platform.\n"
        "</Document>"
    )


@tool
def mcp_time__get_current_time(timezone: str = "UTC") -> str:
    """Get the current time for a timezone."""
    return "2026-05-11T14:30:00+09:00"


@tool
def weather_observation_tool(location: str) -> str:
    """Get current observed weather conditions."""
    return f"Current conditions for {location}: clear, 68F"


@tool
def empty_web_search_tool(query: str) -> str:
    """Search the web (returns no results)."""
    return ""


@tool
def remember_tool(fact: str) -> str:
    """Durably save a user preference, decision, or project fact."""
    return f"Saved: {fact}"


_SPY_SEARCH_EXECUTIONS: list[str] = []


@tool
def spy_search_tool(query: str) -> str:
    """Search the web (spy: records every actual execution)."""
    _SPY_SEARCH_EXECUTIONS.append(query)
    return f"Results for: {query}"


class TestShallowResearcherSourceRegistryGating:
    """Tests that shallow source capture is gated by data_source_registry."""

    @pytest.fixture(autouse=True)
    def _reset_data_source_registry(self):
        reset_registry()
        yield
        reset_registry()

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.mark.asyncio
    async def test_explicit_tool_not_declared_as_data_source_is_not_captured(self, mock_llm_provider, mock_llm):
        """Loaded agent tools are not enough; the tool must be in data_source_registry.

        A tool outside the registry captures no sources, and because no
        data-source lookup was attempted the answer is returned rather than
        rejected by the citation guard.
        """
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "mcp_time__get_current_time", "args": {"timezone": "Asia/Tokyo"}, "id": "1"}],
        )
        final_response = AIMessage(
            content=("The current time was returned by the MCP tool.\n\n## Sources\n[1] mcp_time__get_current_time")
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="What time is it in Tokyo?")])
        result = await agent.run(state)

        assert agent.source_registry.all_sources() == []
        assert "current time" in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_an_answer_that_looked_nothing_up_is_returned_as_is(self, mock_llm_provider, mock_llm):
        """A reply from project context calls no data-source tool. An empty
        registry then is not a failure — the answer is returned as it is, and
        the result says no source was consulted (which is what the chat node
        reads a direct reply from).
        """
        final_response = AIMessage(content="Your project **test 1** is a Neubau, Beherbergung, GK3 building.")
        mock_llm.ainvoke = AsyncMock(side_effect=[final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="what do you know about my project")],
        )
        result = await agent.run(state)

        assert agent.source_registry.all_sources() == []
        assert "test 1" in result.messages[-1].content
        assert result.source_lookup_attempted is False

    @pytest.mark.asyncio
    async def test_a_greeting_keeps_the_full_binding(self, mock_llm_provider, mock_llm):
        """No turn is narrowed by a classification any more (ADR-0052): the
        greeting is answered from the same construction-time binding a
        Baurecht question uses, search tool included. Whether to call it is
        the model's decision, made with the tool in hand.
        """
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["empty_web_search_tool"],
                }
            ],
        )
        final_response = AIMessage(content="Hallo! Bei mir läuft alles super.")
        mock_llm.ainvoke = AsyncMock(side_effect=[final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[empty_web_search_tool, remember_tool],
        )
        bound_at_construction = {getattr(t, "name", t) for t in mock_llm.bind_tools.call_args.args[0]}
        assert bound_at_construction == {"empty_web_search_tool", "remember_tool"}
        mock_llm.bind_tools.reset_mock()

        state = ShallowResearchAgentState(messages=[HumanMessage(content="wie läufts so")])
        result = await agent.run(state)

        # No second, narrower binding was made for the turn.
        assert mock_llm.bind_tools.call_count == 0
        assert "läuft alles super" in result.messages[-1].content
        assert result.source_lookup_attempted is False

    @pytest.mark.asyncio
    async def test_a_search_the_model_calls_on_a_greeting_executes(self, mock_llm_provider, mock_llm):
        """The other half of the same rule: a tool the model decides to call
        runs, on any turn. The old meta partition returned an invalid-tool
        error here; that partition is what made "zeig mir die Grundrisse"
        answer that its tool was not available in this session.
        """
        _SPY_SEARCH_EXECUTIONS.clear()
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["spy_search_tool"],
                }
            ],
        )
        search_call = AIMessage(
            content="",
            tool_calls=[{"name": "spy_search_tool", "args": {"query": "wie läufts so"}, "id": "1"}],
        )
        final_response = AIMessage(content="Hallo! Bei mir läuft alles super.")
        mock_llm.ainvoke = AsyncMock(side_effect=[search_call, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[spy_search_tool, remember_tool],
            repair_pass=False,
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="wie läufts so")])
        result = await agent.run(state)

        assert _SPY_SEARCH_EXECUTIONS == ["wie läufts so"]
        assert "läuft alles super" in result.messages[-1].content
        assert result.source_lookup_attempted is True

    @pytest.mark.asyncio
    async def test_research_turn_hallucinated_search_call_executes(self, mock_llm_provider, mock_llm):
        """A research question: the search tool is available and a tool call
        executes normally."""
        _SPY_SEARCH_EXECUTIONS.clear()
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["spy_search_tool"],
                }
            ],
        )
        search_call = AIMessage(
            content="",
            tool_calls=[{"name": "spy_search_tool", "args": {"query": "OIB 2.2"}, "id": "1"}],
        )
        final_response = AIMessage(content="Answer [1].\n\n**References:**\n- [1] Results for: OIB 2.2")
        mock_llm.ainvoke = AsyncMock(side_effect=[search_call, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[spy_search_tool, remember_tool],
            # This test is about tool GATING. The answer's "[1]" resolves to
            # nothing, which is exactly what the repair pass re-searches for;
            # that second search is the repair's own tests' business.
            repair_pass=False,
        )

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Which OIB Richtlinie applies?")],
        )
        await _run_with_captured_registry(agent, state)

        # On a research turn the search tool really runs.
        assert _SPY_SEARCH_EXECUTIONS == ["OIB 2.2"]

    @pytest.mark.asyncio
    async def test_research_turn_keeps_search_tools_bound(self, mock_llm_provider, mock_llm):
        """A research question uses the full construction-time binding, so the
        search tool remains available."""
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["empty_web_search_tool"],
                }
            ],
        )
        final_response = AIMessage(content="Answer from context.")
        mock_llm.ainvoke = AsyncMock(side_effect=[final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[empty_web_search_tool, remember_tool],
        )
        mock_llm.bind_tools.reset_mock()

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Which OIB Richtlinie applies to high-rise buildings?")],
        )
        await agent.run(state)

        # Research turns reuse the full binding made at construction; no
        # additional (narrowed) binding is created.
        assert mock_llm.bind_tools.call_count == 0

    @pytest.mark.asyncio
    async def test_research_turn_with_failed_source_lookup_still_raises(self, mock_llm_provider, mock_llm):
        """Guard the genuine-failure cell: a research turn that DID query a
        registered data-source tool but captured no sources (empty result)
        raises EmptySourceRegistryError — retrieval was attempted and failed.
        """
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["empty_web_search_tool"],
                }
            ],
        )
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "empty_web_search_tool", "args": {"query": "OIB 2.2"}, "id": "1"}],
        )
        final_response = AIMessage(content="Here is an answer that cites nothing.")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[empty_web_search_tool],
        )

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Which OIB Richtlinie applies to high-rise buildings?")],
        )
        with pytest.raises(EmptySourceRegistryError):
            await agent.run(state)

    @pytest.mark.asyncio
    async def test_research_turn_answered_from_context_returns_answer(self, mock_llm_provider, mock_llm):
        """A research-routed turn the agent answers from conversation/project
        context WITHOUT attempting any data-source lookup must return the
        answer, not raise. Regression for the misrouted-conversational-turn
        incident: the citation guard replaced a substantive answer with a
        misleading "search tools did not return any results" error even though
        no tool was ever called.
        """
        final_response = AIMessage(content="To fill in hohe_gebaeude_details I need the exact building height.")
        mock_llm.ainvoke = AsyncMock(side_effect=[final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="what do you need to know to fill that in?")],
        )
        result = await agent.run(state)

        assert agent.source_registry.all_sources() == []
        assert "building height" in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_registered_group_tool_without_urls_is_captured(self, mock_llm_provider, mock_llm):
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
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "mcp_time__get_current_time", "args": {"timezone": "Asia/Tokyo"}, "id": "1"}],
        )
        final_response = AIMessage(
            content=("The current time was returned by the MCP tool.\n\n## Sources\n[1] mcp_time__get_current_time")
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="What time is it in Tokyo?")])
        result, registry = await _run_with_captured_registry(agent, state)

        sources = registry.all_sources()
        assert len(sources) == 1
        assert sources[0].citation_key == "mcp_time__get_current_time"
        assert sources[0].source_type == "tool_result"
        assert result.messages[-1].content.rstrip().endswith("[1] mcp_time__get_current_time")

    @pytest.mark.asyncio
    async def test_missing_tool_result_citation_is_appended(self, mock_llm_provider, mock_llm):
        """Captured non-URL tool sources are appended when the model omits references."""
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
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "mcp_time__get_current_time", "args": {"timezone": "Asia/Tokyo"}, "id": "1"}],
        )
        final_response = AIMessage(content="It's currently 4:54 AM in Tokyo.")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="What time is it in Tokyo?")])
        result = await agent.run(state)

        assert result.messages[-1].content.rstrip() == (
            "It's currently 4:54 AM in Tokyo [1].\n\n## Sources\n- [1] mcp_time__get_current_time"
        )

    @pytest.mark.asyncio
    async def test_missing_citation_fallback_skips_ambiguous_multi_source_registry(self, mock_llm_provider, mock_llm):
        """Do not inject the first captured source when multiple sources exist."""
        populate_from_config(
            [
                {
                    "id": "mcp_time",
                    "name": "MCP Time",
                    "description": "Get current time and timezone information through MCP.",
                    "tools": ["mcp_time"],
                },
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web for real-time information.",
                    "tools": ["web_search_with_urls"],
                },
            ],
            group_names={"mcp_time"},
        )
        tool_call_response = AIMessage(
            content="",
            tool_calls=[
                {"name": "mcp_time__get_current_time", "args": {"timezone": "Asia/Tokyo"}, "id": "1"},
                {"name": "web_search_with_urls", "args": {"query": "CUDA"}, "id": "2"},
            ],
        )
        final_response = AIMessage(content="CUDA is a parallel computing platform.")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[mcp_time__get_current_time, web_search_with_urls],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="What is CUDA? Also note the time.")])
        result, registry = await _run_with_captured_registry(agent, state)

        sources = registry.all_sources()
        assert len(sources) >= 2
        assert sources[0].citation_key == "mcp_time__get_current_time"
        assert any(source.url == "https://docs.nvidia.com/cuda/" for source in sources)
        assert result.messages[-1].content == "CUDA is a parallel computing platform."

    @pytest.mark.asyncio
    async def test_registered_exact_data_source_tool_without_urls_is_captured(self, mock_llm_provider, mock_llm):
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
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "weather_observation_tool", "args": {"location": "San Francisco"}, "id": "1"}],
        )
        final_response = AIMessage(content="The weather is clear.\n\n## Sources\n[1] weather_observation_tool")
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[weather_observation_tool],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="What is the weather in San Francisco?")])
        result, registry = await _run_with_captured_registry(agent, state)

        sources = registry.all_sources()
        assert len(sources) == 1
        assert sources[0].citation_key == "weather_observation_tool"
        assert sources[0].source_type == "tool_result"
        assert result.messages[-1].content.rstrip().endswith("[1] weather_observation_tool")


class TestShallowResearcherSourceCaptureIntegration:
    """Integration tests verifying source capture through the full pipeline.

    These tests do NOT bypass the citation pipeline — they verify that
    tool_node_with_source_capture registers sources from real tool execution,
    and that verify_citations + sanitize_report run on the final output.
    """

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.fixture(autouse=True)
    def _register_web_search_source(self):
        reset_registry()
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web for real-time information.",
                    "tools": ["web_search_with_urls"],
                }
            ]
        )
        yield
        reset_registry()

    @pytest.mark.asyncio
    async def test_source_registry_populated_from_tool_call(self, mock_llm_provider, mock_llm):
        """Tool execution populates the source registry with extracted URLs."""
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "web_search_with_urls", "args": {"query": "CUDA"}, "id": "1"}],
        )
        final_response = AIMessage(
            content=(
                "CUDA is a parallel computing platform.\n\n"
                "## Sources\n"
                "[1] CUDA Toolkit Documentation: https://docs.nvidia.com/cuda/"
            )
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[web_search_with_urls],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
        result, registry = await _run_with_captured_registry(agent, state)

        # Source registry should have the URL from tool output
        sources = registry.all_sources()
        assert len(sources) >= 1
        assert any(s.url == "https://docs.nvidia.com/cuda/" for s in sources)

        # Final output should exist and have been processed
        assert result.messages[-1].content

    @pytest.mark.asyncio
    async def test_invalid_citation_removed_end_to_end(self, mock_llm_provider, mock_llm):
        """Citations not backed by registry sources are removed from output."""
        tool_call_response = AIMessage(
            content="",
            tool_calls=[{"name": "web_search_with_urls", "args": {"query": "CUDA"}, "id": "1"}],
        )
        # LLM fabricates a citation [2] not in the registry
        final_response = AIMessage(
            content=(
                "CUDA is great [1]. Also see this [2].\n\n"
                "## Sources\n"
                "[1] CUDA Docs: https://docs.nvidia.com/cuda/\n"
                "[2] Fake Source: https://totally-fabricated.example.com/fake"
            )
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[tool_call_response, final_response])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[web_search_with_urls],
        )

        state = ShallowResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
        result = await agent.run(state)

        output = result.messages[-1].content
        # The fabricated URL should have been removed by verify_citations
        assert "totally-fabricated.example.com" not in output
        # The valid citation should survive
        assert "docs.nvidia.com/cuda" in output


# ---------------------------------------------------------------------------
# Session registry integration tests
# ---------------------------------------------------------------------------


class TestShallowResearcherSessionRegistry:
    """Tests verifying session-scoped SourceRegistry integration.

    These tests do NOT use the _bypass_citation_pipeline fixture — they verify
    the actual ContextVar-based session registry behavior.
    """

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.mark.asyncio
    async def test_run_uses_session_registry_when_set(self, mock_llm_provider, mock_llm):
        """When session registry is set via ContextVar, run() uses it and doesn't raise."""
        from aiq_agent.common.citation_verification import set_session_registry

        # Pre-populate a session registry with a source from a "prior turn"
        session_reg = SourceRegistry()
        session_reg.add(SourceEntry(url="https://prior-turn.example.com/article"))

        # LLM answers from memory (no tool calls) citing the prior-turn URL
        agent_response = AIMessage(
            content=(
                "Answer based on prior context [1].\n\n"
                "## Sources\n"
                "[1] Prior Article: https://prior-turn.example.com/article"
            )
        )
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[web_search_tool],
        )

        set_session_registry(session_reg)
        try:
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Follow-up question")])
            result = await agent.run(state)
            # Should NOT raise EmptySourceRegistryError because session registry has sources
            assert result is not None
            assert "prior-turn.example.com/article" in result.messages[-1].content
        finally:
            set_session_registry(None)

    @pytest.mark.asyncio
    async def test_run_clears_registry_in_standalone_mode(self, mock_llm_provider, mock_llm):
        """Without session registry ContextVar, run() uses a fresh per-run
        registry: stale instance-registry sources must not leak into the output
        (a consulted single-source registry would be auto-appended as a
        citation on the answer)."""
        from aiq_agent.common.citation_verification import set_session_registry

        set_session_registry(None)  # Ensure no session registry

        # LLM answers without calling tools
        agent_response = AIMessage(content="Answer without sources")
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[web_search_tool],
        )
        # Pre-populate the instance registry (simulating stale data)
        agent.source_registry.add(SourceEntry(url="https://stale.example.com"))

        state = ShallowResearchAgentState(messages=[HumanMessage(content="Test")])
        result = await agent.run(state)

        assert "stale.example.com" not in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_session_registry_does_not_mutate_shared_instance(self, mock_llm_provider, mock_llm):
        """Setting a session registry must NOT overwrite self.source_registry on the agent."""
        from aiq_agent.common.citation_verification import set_session_registry

        session_reg = SourceRegistry()
        session_reg.add(SourceEntry(url="https://session.example.com/doc"))

        agent_response = AIMessage(content=("Answer [1].\n\n## Sources\n[1] Doc: https://session.example.com/doc"))
        mock_llm.ainvoke = AsyncMock(return_value=agent_response)

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[web_search_tool],
        )
        original_registry = agent.source_registry

        set_session_registry(session_reg)
        try:
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Q")])
            await agent.run(state)
            # The instance attribute must remain unchanged
            assert agent.source_registry is original_registry
        finally:
            set_session_registry(None)


class TestAppendMinimalCitation:
    """Unit tests for the `_append_minimal_citation` fallback."""

    def _tool_source(self) -> SourceEntry:
        return SourceEntry(
            source_type="tool_result",
            citation_key="mcp_time__get_current_time",
            tool_name="mcp_time__get_current_time",
        )

    def test_strips_leftover_bold_references_header(self):
        # Simulates verify_citations stripping every fabricated citation under
        # a **References:** section but leaving the bare header behind.
        report = "Body sentence.\n\n**References:**\n"

        result = _append_minimal_citation(report, self._tool_source())

        assert result.count("**References:**") == 1
        assert result == "Body sentence [1].\n\n**References:**\n- [1] mcp_time__get_current_time"

    def test_strips_leftover_references_heading(self):
        report = "Body sentence.\n\n## References\n"

        result = _append_minimal_citation(report, self._tool_source())

        assert "## References" not in result
        assert result.count("**References:**") == 1

    def test_strips_leftover_sources_heading(self):
        report = "Body sentence.\n\n### Sources\n"

        result = _append_minimal_citation(report, self._tool_source())

        assert "### Sources" not in result
        assert result.count("**References:**") == 1

    def test_no_leftover_header_passes_through(self):
        report = "Body sentence."

        result = _append_minimal_citation(report, self._tool_source())

        assert result == "Body sentence [1].\n\n**References:**\n- [1] mcp_time__get_current_time"

    def test_knowledge_base_source_carries_kb_token(self):
        source = SourceEntry(
            source_type="knowledge_layer",
            citation_key="OIB-Richtlinie-2.pdf, p.3",
            tool_name="knowledge_search",
        )
        result = _append_minimal_citation("Body sentence.", source)

        assert result == ("Body sentence [1].\n\n**References:**\n- [1] [KB] OIB-Richtlinie-2.pdf, p.3")

    def test_web_source_carries_web_token(self):
        source = SourceEntry(
            source_type="generic",
            url="https://example.com/a",
            title="Article A",
            tool_name="web_search_tool",
        )
        result = _append_minimal_citation("Body sentence.", source)

        assert result == ("Body sentence [1].\n\n**References:**\n- [1] [Web] Article A - https://example.com/a")

    def test_ris_source_carries_ris_token(self):
        source = SourceEntry(
            source_type="generic",
            url="https://www.ris.bka.gv.at/eli/bgbl/1985/446",
            title="BauO",
            tool_name="ris_search_tool",
        )
        result = _append_minimal_citation("Body sentence.", source)

        assert result == (
            "Body sentence [1].\n\n**References:**\n- [1] [RIS] BauO - https://www.ris.bka.gv.at/eli/bgbl/1985/446"
        )


class TestShallowResearcherAnswerGrounding:
    """The ``answer_citation_grounded`` overconfidence-guard signal set by run().

    This class deliberately does NOT inherit the citation-bypass autouse fixture
    of TestShallowResearcherAgent: each test controls the verification outcome
    and registry contents itself.
    """

    @pytest.fixture(autouse=True)
    def _reset_data_source_registry(self):
        reset_registry()
        yield
        reset_registry()

    @staticmethod
    def _after_a_lookup(mock_llm, answer: str, *, query: str = "q") -> None:
        """Script one web search, then the answer.

        The single-source fallback grounds an answer in the one source THIS
        turn retrieved; a turn that looked nothing up gets no citation appended
        (or a greeting would inherit last turn's source). So the tests that
        exercise the fallback have to look something up first.
        """
        populate_from_config(
            [{"id": "web_search", "name": "Web Search", "description": "Search the web.", "tools": ["web_search_tool"]}]
        )
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(content="", tool_calls=[{"name": "web_search_tool", "args": {"query": query}, "id": "1"}]),
                AIMessage(content=answer),
            ]
        )

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    def _agent(self, provider, **kwargs):
        # The fallback tests script exactly one search and one answer; the
        # repair pass would spend a third call and is not what they test.
        return ShallowResearcherAgent(llm_provider=provider, tools=[web_search_tool], **kwargs)

    @pytest.mark.asyncio
    async def test_grounded_when_verification_keeps_valid_citation(self, mock_llm_provider, mock_llm):
        mock_llm.ainvoke.return_value = AIMessage(content="OIB-Richtlinie 2 regelt Brandschutz [1].")
        source = SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool")
        # valid_citations must be dict-shaped (matching real verify_citations
        # output) so the emission path can resolve each cited citation back to
        # its registry SourceEntry.
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[source]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="OIB-Richtlinie 2 regelt Brandschutz [1].",
                valid_citations=[{"number": 1, "url": "https://example.com/a", "citation_key": None, "line": "[1]"}],
                removed_citations=[],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Brandschutz?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.answer_citation_grounded is True

    @pytest.mark.asyncio
    async def test_grounded_when_single_source_appended_as_minimal_citation(self, mock_llm_provider, mock_llm):
        # No model citation survives, but exactly one registry source exists →
        # appended as the one minimal citation, which grounds the answer.
        self._after_a_lookup(mock_llm, "Answer without any citation.")
        source = SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool")
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[source]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="Answer without any citation.",
                valid_citations=[],
                removed_citations=[{"number": 1, "line": "[1]", "reason": "unverifiable"}],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Q?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider, repair_pass=False), state)
        assert result.answer_citation_grounded is True

    @pytest.mark.asyncio
    async def test_not_grounded_when_all_citations_removed_and_many_sources(self, mock_llm_provider, mock_llm):
        mock_llm.ainvoke.return_value = AIMessage(content="Answer [1][2].")
        sources = [
            SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool"),
            SourceEntry(url="https://example.com/b", title="B", tool_name="web_search_tool"),
        ]
        with (
            patch.object(SourceRegistry, "all_sources", return_value=sources),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="Answer.",
                valid_citations=[],
                removed_citations=["[1]", "[2]"],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Q?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.answer_citation_grounded is False

    @pytest.mark.asyncio
    async def test_not_grounded_when_registry_empty_and_nothing_was_looked_up(self, mock_llm_provider, mock_llm):
        # Empty registry, a greeting: nothing to cite → not grounded (a
        # self-report would be capped to "low" downstream).
        mock_llm.ainvoke.return_value = AIMessage(content="Hallo! Wie kann ich helfen?")
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Hi")],
        )
        result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.answer_citation_grounded is False

    @pytest.mark.asyncio
    async def test_an_unresolvable_citation_falls_back_to_the_turns_one_source(self, mock_llm_provider, mock_llm):
        # Inline [1] citation, NO Sources section written by the model, and a
        # registry whose one source the REAL verifier cannot resolve the [1]
        # to (``all_sources`` is patched; the URL index is not): the citation
        # is removed, and the single-source fallback grounds the answer in the
        # one source this turn retrieved. Uses the REAL verification/
        # sanitization pipeline.
        self._after_a_lookup(mock_llm, "The building height limit is 12 m [1].")
        source = SourceEntry(url="https://example.gv.at/oib", title="OIB Richtlinie", tool_name="web_search_tool")
        with patch.object(SourceRegistry, "all_sources", return_value=[source]):
            state = ShallowResearchAgentState(messages=[HumanMessage(content="What is the height limit?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider, repair_pass=False), state)

        answer = next(m for m in reversed(result.messages) if isinstance(m, AIMessage) and not m.tool_calls)
        assert "Sources" in answer.content
        assert "OIB Richtlinie" in answer.content
        assert result.answer_citation_grounded is True

    # --- verified_sources emission: only THIS turn's cited sources become chips ---

    @pytest.mark.asyncio
    async def test_verified_sources_empty_when_answer_cites_nothing(self, mock_llm_provider, mock_llm):
        # The reported bug: a per-session registry carries a prior turn's RIS
        # source, but this turn's answer cites nothing (e.g. a greeting routed
        # as research). No citation survives verification → NO chips are emitted
        # (must not re-emit the previous turn's source).
        mock_llm.ainvoke.return_value = AIMessage(content="Hallo! Wie kann ich helfen?")
        registry = SourceRegistry()
        registry.add(
            SourceEntry(
                url="https://ris.bka.gv.at/prev",
                title="Prior RIS source",
                tool_name="ris_search",
            )
        )
        with patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Hallo! Wie kann ich helfen?",
                valid_citations=[],
                removed_citations=[],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="hallo wie gehts")])
            # Two registry sources would exist here in the real bug; add a second
            # so the single-source minimal-citation path does NOT fire.
            registry.add(
                SourceEntry(
                    url="https://ris.bka.gv.at/prev2",
                    title="Prior RIS source 2",
                    tool_name="ris_search",
                )
            )
            result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert result.verified_sources is None

    @pytest.mark.asyncio
    async def test_verified_sources_only_the_one_cited_of_many(self, mock_llm_provider, mock_llm):
        # Registry holds three sources; the answer cites exactly one → chips
        # contain only that one (the model's own relevance decision).
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1].")
        registry = SourceRegistry()
        cited = SourceEntry(url="https://example.com/b", title="B", tool_name="web_search_tool")
        registry.add(SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool"))
        registry.add(cited)
        registry.add(SourceEntry(url="https://example.com/c", title="C", tool_name="web_search_tool"))
        with patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1].",
                valid_citations=[{"number": 1, "url": "https://example.com/b", "citation_key": None, "line": "[1]"}],
                removed_citations=[],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert result.verified_sources is not None
        assert [s["url"] for s in result.verified_sources] == ["https://example.com/b"]

    @pytest.mark.asyncio
    async def test_verified_sources_citation_key_resolves(self, mock_llm_provider, mock_llm):
        # A knowledge-layer citation (citation_key, no URL) resolves to its entry.
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1].")
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool"))
        registry.add(SourceEntry(citation_key="oib-richtlinie-2.pdf#p3", title="OIB 2", tool_name="kb_search"))
        with patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1].",
                valid_citations=[
                    {
                        "number": 1,
                        "url": None,
                        "citation_key": "oib-richtlinie-2.pdf#p3",
                        "line": "[1]",
                    }
                ],
                removed_citations=[],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert result.verified_sources is not None
        assert [s["citation_key"] for s in result.verified_sources] == ["oib-richtlinie-2.pdf#p3"]

    @pytest.mark.asyncio
    async def test_verified_sources_single_source_minimal_citation_path(self, mock_llm_provider, mock_llm):
        # Exactly one registry source and no surviving model citation → the
        # single minimal-citation path fires and that one source IS emitted.
        # The search result names the same URL, so the registry keeps ONE source.
        self._after_a_lookup(mock_llm, "Answer without any citation.", query="https://example.com/only")
        registry = SourceRegistry()
        only = SourceEntry(url="https://example.com/only", title="Only", tool_name="web_search_tool")
        registry.add(only)
        with patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Answer without any citation.",
                valid_citations=[],
                removed_citations=[{"number": 1, "line": "[1]", "reason": "unverifiable"}],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Q?")])
            result = await _run_with_bound_registry(self._agent(mock_llm_provider, repair_pass=False), state, registry)
        assert result.verified_sources is not None
        assert [s["url"] for s in result.verified_sources] == ["https://example.com/only"]

    @pytest.mark.asyncio
    async def test_verified_sources_empty_when_a_greeting_cites_nothing_from_a_populated_registry(
        self, mock_llm_provider, mock_llm
    ):
        # A greeting on a conversation whose registry still holds last turn's
        # source: nothing is cited and nothing was looked up this turn, so the
        # single-source fallback must not hand the greeting that source as its
        # citation, and no chip is emitted.
        mock_llm.ainvoke.return_value = AIMessage(content="Hallo! Wie kann ich helfen?")
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://ris.bka.gv.at/prev", title="Prior RIS", tool_name="ris_search"))
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Hi")],
        )
        result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert result.verified_sources is None

    # --- citation numbers: the [N] label each cited source carries in the prose ---

    @pytest.mark.asyncio
    async def test_verified_sources_carry_their_citation_number(self, mock_llm_provider, mock_llm):
        # The [N] → source binding exists only inside verify_citations. Emitting
        # it lets the frontend render ONE numbered provenance block instead of
        # the written source list plus an unnumbered chip row.
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1][2].")
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool"))
        registry.add(SourceEntry(citation_key="oib-rl_4.pdf, p.9", title="OIB 4", tool_name="kb_search"))
        with patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1][2].",
                valid_citations=[
                    {"number": 1, "url": "https://example.com/a", "citation_key": None, "line": "[1]"},
                    {"number": 2, "url": None, "citation_key": "oib-rl_4.pdf, p.9", "line": "[2]"},
                ],
                removed_citations=[],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)
        assert [s["number"] for s in result.verified_sources] == [1, 2]

    @pytest.mark.asyncio
    async def test_minimal_citation_source_is_numbered_one(self, mock_llm_provider, mock_llm):
        # ``_append_minimal_citation`` writes "[1]" into the answer, so the one
        # emitted source must claim that number.
        self._after_a_lookup(mock_llm, "Answer without any citation.", query="https://example.com/only")
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://example.com/only", title="Only", tool_name="web_search_tool"))
        with patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify:
            mock_verify.return_value = MagicMock(
                verified_report="Answer without any citation.",
                valid_citations=[],
                removed_citations=[],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Q?")])
            result = await _run_with_bound_registry(self._agent(mock_llm_provider, repair_pass=False), state, registry)
        assert [s["number"] for s in result.verified_sources] == [1]

    @pytest.mark.asyncio
    async def test_citation_numbers_survive_the_sanitize_renumber(self, mock_llm_provider, mock_llm):
        # Real pipeline (no mocked verifier): the model cites [1] and [2], but
        # [1] is fabricated. verify_citations drops it, then sanitize_report
        # closes the gap so the surviving source becomes [1] in the prose. The
        # wire number must follow, or the chip is labelled [2] while the answer
        # points at [1] — and the inline marker's anchor leads nowhere.
        answer = (
            "Erfunden [1]. Belegt [2].\n\n"
            "**References:**\n"
            "- [1] Fake - https://not-in-registry.example/x\n"
            "- [2] Real - https://example.com/real\n"
        )
        mock_llm.ainvoke.return_value = AIMessage(content=answer)
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://example.com/real", title="Real", tool_name="web_search_tool"))

        state = ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")])
        result = await _run_with_bound_registry(self._agent(mock_llm_provider), state, registry)

        final_text = result.messages[-1].content
        assert "[2]" not in final_text  # the gap was closed
        assert "Belegt [1]" in final_text
        assert [s["number"] for s in result.verified_sources] == [1]
        assert [s["url"] for s in result.verified_sources] == ["https://example.com/real"]

    # --- citations_removed: transparency summary of dropped citations ---

    @pytest.mark.asyncio
    async def test_citations_removed_populated_when_verification_drops_citations(self, mock_llm_provider, mock_llm):
        # ≥1 citation removed → the result carries a {count, reasons} summary
        # (reasons deduplicated in first-seen order).
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1].")
        source = SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool")
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[source]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1].",
                valid_citations=[{"number": 1, "url": "https://example.com/a", "citation_key": None, "line": "[1]"}],
                removed_citations=[
                    {"number": 2, "line": "[2] Bad: https://nope.example.com", "reason": "url_not_in_registry"},
                    {"number": 3, "line": "[3] Also bad", "reason": "url_not_in_registry"},
                    {"number": 4, "line": "[4] Mystery", "reason": "unverifiable"},
                ],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.citations_removed == {
            "count": 3,
            "reasons": ["url_not_in_registry", "unverifiable"],
        }

    @pytest.mark.asyncio
    async def test_citations_removed_absent_when_nothing_removed(self, mock_llm_provider, mock_llm):
        # Nothing removed → citations_removed stays None (never null-spammed).
        mock_llm.ainvoke.return_value = AIMessage(content="Antwort [1].")
        source = SourceEntry(url="https://example.com/a", title="A", tool_name="web_search_tool")
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[source]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify,
        ):
            mock_verify.return_value = MagicMock(
                verified_report="Antwort [1].",
                valid_citations=[{"number": 1, "url": "https://example.com/a", "citation_key": None, "line": "[1]"}],
                removed_citations=[],
            )
            state = ShallowResearchAgentState(messages=[HumanMessage(content="Frage?")])
            result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.citations_removed is None

    @pytest.mark.asyncio
    async def test_citations_removed_absent_on_a_greeting_without_verification(self, mock_llm_provider, mock_llm):
        # A greeting with an empty registry: no verification runs, so
        # citations_removed is never populated.
        mock_llm.ainvoke.return_value = AIMessage(content="Hallo! Wie kann ich helfen?")
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Hi")],
        )
        result, _ = await _run_with_captured_registry(self._agent(mock_llm_provider), state)
        assert result.citations_removed is None


@tool
def knowledge_search(query: str) -> str:
    """Search the internal knowledge base (returns KB-format results)."""
    return (
        "Found 1 relevant document(s):\n\n"
        "--- Result 1 ---\n"
        "Source: OIB-330.pdf\n"
        "Collection: oib_knowledge\n"
        "Page: 12\n"
        "Citation: OIB-330.pdf, p.12\n"
        "Content Type: text\n"
        "Relevance Score: 0.88\n"
        "\n"
        "Die lichte Durchgangshoehe von Treppen muss mindestens 2,10 m betragen.\n"
        "\n"
        "## Trace-Lanes\n"
        '{"lanes":[]}\n'
    )


class TestShallowResearcherQuoteVerification:
    """The shallow agent annotates fabricated quotes and flips answer_quotes_verified."""

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.fixture(autouse=True)
    def _register_kb_source(self):
        reset_registry()
        populate_from_config(
            [
                {
                    "id": "oib_knowledge",
                    "name": "OIB Knowledge",
                    "description": "Search the internal OIB knowledge base.",
                    "tools": ["knowledge_search"],
                }
            ]
        )
        yield
        reset_registry()

    def _tool_call(self):
        return AIMessage(
            content="",
            tool_calls=[{"name": "knowledge_search", "args": {"query": "Treppe"}, "id": "1"}],
        )

    @pytest.mark.asyncio
    async def test_fabricated_quote_annotated_and_flagged(self, mock_llm_provider, mock_llm):
        final = AIMessage(
            content=(
                "Die Richtlinie fordert „Treppen muessen mit einer automatischen "
                'Loeschanlage ausgestattet sein" [1].\n\n'
                "## Sources\n[1] OIB-330.pdf, p.12"
            )
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), final])
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[knowledge_search])
        state = ShallowResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])
        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        output = result.messages[-1].content
        assert "[nicht wörtlich in der Quelle belegt]" in output
        # Fail-open: the fabricated sentence itself is preserved, never stripped.
        assert "automatische" in output.lower()
        assert result.answer_quotes_verified is False

    @pytest.mark.asyncio
    async def test_verbatim_quote_not_annotated_and_verified(self, mock_llm_provider, mock_llm):
        final = AIMessage(
            content=(
                "Es gilt: „Die lichte Durchgangshoehe von Treppen muss mindestens "
                '2,10 m betragen" [1].\n\n## Sources\n[1] OIB-330.pdf, p.12'
            )
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), final])
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[knowledge_search])
        state = ShallowResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])
        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        output = result.messages[-1].content
        assert "[nicht wörtlich in der Quelle belegt]" not in output
        # REGRESSION: without quote verification this stays at the default True,
        # so the assertion below only exercises the new path when a fabricated
        # quote is present (covered by the sibling test); here it must remain True.
        assert result.answer_quotes_verified is True

    def test_state_defaults_quotes_verified_true(self):
        state = ShallowResearchAgentState(messages=[HumanMessage(content="hi")])
        assert state.answer_quotes_verified is True


class TestRepairLookups:
    """The repair searches for exactly what failed, where the answer said it was."""

    def _quote(self, body: str, inner: str):
        from aiq_agent.common.citation_verification import UnverifiedQuote

        span = f"„{inner}“"
        start = body.index(span)
        return UnverifiedQuote(quote=inner, span=span, start=start, end=start + len(span), best_coverage=0.1)

    def test_a_failed_quote_is_looked_up_in_the_document_it_was_attributed_to(self):
        from aiq_agent.agents.shallow_researcher.agent import _repair_lookups

        body = "Die Richtlinie fordert „Treppen muessen rot sein“ [2].\n\n## Sources\n[2] OIB-330.pdf, p.12"
        lookups = _repair_lookups(
            body,
            valid_citations=[{"number": 2, "citation_key": "OIB-330.pdf, p.12", "url": None}],
            removed_citations=[],
            unverified_quotes=[self._quote(body, "Treppen muessen rot sein")],
        )
        assert lookups == [("Treppen muessen rot sein", "OIB-330.pdf")]

    def test_a_quote_with_no_citation_nearby_searches_everywhere(self):
        from aiq_agent.agents.shallow_researcher.agent import _repair_lookups

        body = "„Treppen muessen rot sein“ steht irgendwo."
        lookups = _repair_lookups(
            body,
            valid_citations=[],
            removed_citations=[],
            unverified_quotes=[self._quote(body, "Treppen muessen rot sein")],
        )
        assert lookups == [("Treppen muessen rot sein", None)]

    def test_a_removed_citation_is_searched_with_the_claim_not_the_reference_line(self):
        from aiq_agent.agents.shallow_researcher.agent import _repair_lookups

        body = (
            "Einleitung. Die lichte Hoehe muss 2,10 m betragen [1]. Weiter im Text.\n\n"
            "## Sources\n- [1] OIB-RL 4 – oib-rl_4.pdf, p.7"
        )
        lookups = _repair_lookups(
            body,
            valid_citations=[],
            removed_citations=[
                {"number": 1, "line": "- [1] OIB-RL 4 – oib-rl_4.pdf, p.7", "reason": "not_in_registry"}
            ],
            unverified_quotes=[],
        )
        assert lookups == [("Die lichte Hoehe muss 2,10 m betragen.", "oib-rl_4.pdf")]

    def test_two_is_a_repair_and_more_is_a_second_turn(self):
        from aiq_agent.agents.shallow_researcher.agent import _repair_lookups

        body = "A [1]. B [2]. C [3]."
        removed = [{"number": n, "line": f"[{n}] x.pdf, p.{n}"} for n in (1, 2, 3)]
        assert len(_repair_lookups(body, valid_citations=[], removed_citations=removed, unverified_quotes=[])) == 2


class TestShallowResearcherRepairPass:
    """One bounded repair: a failed quote is re-searched and rewritten, once,
    and the answer that verifies better ships."""

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @pytest.fixture(autouse=True)
    def _register_kb_source(self):
        reset_registry()
        populate_from_config(
            [
                {
                    "id": "oib_knowledge",
                    "name": "OIB Knowledge",
                    "description": "Search the internal OIB knowledge base.",
                    "tools": ["knowledge_search"],
                }
            ]
        )
        yield
        reset_registry()

    def _tool_call(self):
        return AIMessage(
            content="",
            tool_calls=[{"name": "knowledge_search", "args": {"query": "Treppe"}, "id": "1"}],
        )

    FABRICATED = AIMessage(
        content=(
            "Die Richtlinie fordert „Treppen muessen mit einer automatischen "
            'Loeschanlage ausgestattet sein" [1].\n\n'
            "## Sources\n[1] OIB-330.pdf, p.12"
        )
    )
    VERBATIM = AIMessage(
        content=(
            "Es gilt: „Die lichte Durchgangshoehe von Treppen muss mindestens "
            '2,10 m betragen" [1].\n\n## Sources\n[1] OIB-330.pdf, p.12'
        )
    )

    @pytest.mark.asyncio
    async def test_a_fabricated_quote_is_re_searched_and_rewritten_once(self, mock_llm_provider, mock_llm):
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.FABRICATED, self.VERBATIM])
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[knowledge_search])
        state = ShallowResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        output = result.messages[-1].content
        assert "[nicht wörtlich in der Quelle belegt]" not in output
        assert "2,10 m" in output
        assert result.answer_quotes_verified is True
        # Exactly one extra model call, and it was told what failed.
        assert mock_llm.ainvoke.await_count == 3
        repair_messages = mock_llm.ainvoke.await_args_list[2].args[0]
        anchor = repair_messages[-1].content
        assert "did not pass verification" in anchor
        assert "automatischen" in anchor
        assert "Durchgangshoehe" in anchor  # the fresh retrieval rides along

    @pytest.mark.asyncio
    async def test_a_repair_that_does_not_verify_better_is_discarded(self, mock_llm_provider, mock_llm):
        still_wrong = AIMessage(
            content=(
                'Die Richtlinie fordert „Treppen muessen rot gestrichen sein" [1].\n\n## Sources\n[1] OIB-330.pdf, p.12'
            )
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.FABRICATED, still_wrong])
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[knowledge_search])
        state = ShallowResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        output = result.messages[-1].content
        # The ORIGINAL ships, marked — never the rewrite that verified no better.
        assert "Loeschanlage" in output
        assert "rot gestrichen" not in output
        assert "[nicht wörtlich in der Quelle belegt]" in output
        assert result.answer_quotes_verified is False
        assert mock_llm.ainvoke.await_count == 3

    @pytest.mark.asyncio
    async def test_a_clean_answer_costs_no_extra_call(self, mock_llm_provider, mock_llm):
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.VERBATIM])
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[knowledge_search])
        state = ShallowResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        await _run_with_bound_registry(agent, state, SourceRegistry())

        assert mock_llm.ainvoke.await_count == 2

    @pytest.mark.asyncio
    async def test_switched_off_ships_the_marker_as_before(self, mock_llm_provider, mock_llm):
        mock_llm.ainvoke = AsyncMock(side_effect=[self._tool_call(), self.FABRICATED])
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[knowledge_search], repair_pass=False)
        state = ShallowResearchAgentState(messages=[HumanMessage(content="Treppenhoehe?")])

        result = await _run_with_bound_registry(agent, state, SourceRegistry())

        assert "[nicht wörtlich in der Quelle belegt]" in result.messages[-1].content
        assert mock_llm.ainvoke.await_count == 2


class TestShallowClarificationGuidance:
    """The shallow agent must be told to push back on under-specified queries —
    in shallow mode too, and independent of whether project_context is present.

    Regression: the only Rueckfrage/pushback guidance lived INSIDE the
    ``{% if project_context %}`` block, so a shallow turn with no project brief
    got zero clarification guidance and always answered straight through.
    """

    def _render(self, *, project_context):
        from pathlib import Path

        from aiq_agent.agents.shallow_researcher import agent as shallow_agent
        from aiq_agent.common import load_prompt
        from aiq_agent.common import render_prompt_template

        prompt = load_prompt(
            Path(shallow_agent.__file__).parent / "prompts",
            "researcher",
        )
        return render_prompt_template(
            prompt,
            tools=[{"name": "knowledge_search"}],
            user_info={"name": "Alex", "email": "a@example.com"},
            current_datetime="2026-07-23",
            available_documents=[],
            project_context=project_context,
            ris_catalog=None,
            norm_doctrine=None,
            parcel_note=None,
        )

    def test_clarification_guidance_present_on_research_turn_without_project_context(self):
        """A turn with NO project context still gets the push-back guidance —
        the core regression."""
        rendered = self._render(project_context=None)
        assert "<clarification>" in rendered
        assert "Folgefrage" in rendered
        # It must explicitly extend push-back to the shallow/quick path.
        lowered = rendered.lower()
        assert "shallow" in lowered
        # And it must teach the "state your assumption" alternative, not only asking.
        assert "assumption" in lowered

    def test_clarification_guidance_present_with_project_context_too(self):
        rendered = self._render(project_context="facts:\n  bundesland: unknown")
        assert "<clarification>" in rendered
        assert "Folgefrage" in rendered


class TestOffTopicDeclineShape:
    """Out-of-scope questions reach the assistant like every other turn, and
    the assistant must DECLINE + redirect them — not answer them from its own
    knowledge.

    Regression: the direct-reply shape said "answer from your own knowledge",
    so a clearly off-topic question (e.g. "how do I bake a cake") risked
    getting a cheerful full answer. The contract carves out an explicit
    off-topic decline shape.
    """

    def _render(self):
        from pathlib import Path

        from aiq_agent.agents.shallow_researcher import agent as shallow_agent
        from aiq_agent.common import load_prompt
        from aiq_agent.common import render_prompt_template

        prompt = load_prompt(Path(shallow_agent.__file__).parent / "prompts", "researcher")
        return render_prompt_template(
            prompt,
            tools=[],
            user_info={"name": "Alex", "email": "a@example.com"},
            current_datetime="2026-07-23",
            available_documents=[],
            project_context=None,
            ris_catalog=None,
            norm_doctrine=None,
            parcel_note=None,
        )

    def test_contract_has_explicit_off_topic_decline_shape(self):
        rendered = self._render()
        assert "An off-topic decline" in rendered
        # The decisive instruction: do not answer, decline + redirect.
        assert "Do NOT answer" in rendered
        lowered = rendered.lower()
        assert "decline" in lowered and "redirect" in lowered
        # A worked off-topic decline example is present to anchor the behavior.
        assert 'type="off_topic"' in rendered

    def test_in_scope_conversational_shape_still_answers(self):
        """Guard against over-correction: genuine conversational/platform turns
        (greetings, capability questions) are still answered directly."""
        rendered = self._render()
        assert "A direct reply" in rendered
        # The capability example that DOES answer is retained.
        assert 'type="direct_reply"' in rendered


class TestADirectReplyMayStillEmitACard:
    """The direct-reply shape and the `<cards>` block must not contradict.

    Field case: „Wie läuft das Baubewilligungsverfahren in Wien ab?" was offered
    a deep-research plan, refused twice, then retyped in plain words — and the
    reply came as prose because the conversational shape said "no tool calls"
    while `<cards>` told the model to emit one. Every tool is bound on every
    turn (ADR-0052), so the shape now says so, and the restraint lives where it
    lived: a greeting has nothing to put on a card and emits none.
    """

    def _render(self):
        return TestOffTopicDeclineShape._render(self)

    def test_the_direct_reply_shape_has_every_tool(self):
        contract = self._render().split("<output_contract>")[1].split("</output_contract>")[0]
        direct_shape = contract.split("An off-topic decline")[0]
        assert "every tool on every turn" in direct_shape
        assert "no tool calls" not in direct_shape
        # A search is the model's call, and files the user wants to SEE are a
        # surface call, not a list of names — the case that used to answer
        # "the tool is not available in this session".
        assert "A search is not wrong here" in direct_shape
        assert "`surface_documents`" in direct_shape

    def test_the_off_topic_shape_still_forbids_every_tool_call(self):
        # The carve-out is for a turn that ANSWERS something. A decline has no
        # content, so nothing here is loosened for it.
        contract = self._render().split("<output_contract>")[1].split("</output_contract>")[0]
        off_topic = contract.split("An off-topic decline")[1].split("A researched answer")[0]
        assert "no tool calls" in off_topic

    def test_the_direct_reply_shape_names_the_card_rule_and_its_limit(self):
        contract = self._render().split("<output_contract>")[1].split("</output_contract>")[0]
        direct_shape = contract.split("An off-topic decline")[0]
        assert "A card only when the reply carries real subject matter" in direct_shape
        # ...and closed again for the turns with nothing to show.
        assert "so emit none" in direct_shape

    def test_the_hand_off_shape_escalates_a_commissioned_report_at_once(self):
        contract = self._render().split("<output_contract>")[1].split("</output_contract>")[0]
        hand_off = contract.split("A hand-off to deep research")[1]
        assert "`escalate_to_deep`" in hand_off and "`escalation_reason`" in hand_off
        assert "needs no retrieval of your own first" in hand_off
        assert 'type="hand_off"' in self._render()

    def test_the_cards_block_says_out_loud_that_it_is_always_on(self):
        cards = self._render().split("\n<cards>\n")[1].split("\n</cards>\n")[0]
        assert "on for EVERY turn" in cards


class TestKnowledgeInventoryIsNotCitable:
    """The corpus inventory in the prompt must not read as citable evidence.

    Every research turn renders the whole knowledge base — base OIB corpus
    included — as `file_name: summary` lines. Those filenames are the exact
    citation keys verification matches against, so a model that cites one it
    never retrieved produces citations that are all dropped
    (`citation_key_not_in_registry`) and an answer that ships with no source at
    all. The prompt used to forbid recalling URLs from memory but said nothing
    about document keys, while handing the model a list of them.
    """

    def _render(self, prompt: str, documents: list[dict]) -> str:
        from aiq_agent.common import render_prompt_template

        return render_prompt_template(
            prompt,
            tools=[{"name": "knowledge_search", "description": "Search the knowledge base"}],
            user_info=None,
            current_datetime="2026-07-28",
            available_documents=documents,
            project_context=None,
            ris_catalog=None,
            norm_doctrine=None,
            parcel_note=None,
            execution_enabled=False,
            jurisdiction_grounding=None,
            enable_source_router=False,
            max_research_concurrency=3,
        )

    @staticmethod
    def _prompt(path: str) -> str:
        from pathlib import Path

        import aiq_agent

        return (Path(aiq_agent.__file__).parent / "agents" / path).read_text(encoding="utf-8")

    DOCUMENTS = [{"file_name": "oib-rl_2_ausgabe_mai_2023.pdf", "summary": "Brandschutz.", "tags": []}]

    def test_shallow_prompt_marks_the_inventory_as_not_a_source(self):
        rendered = self._render(self._prompt("shallow_researcher/prompts/researcher.j2"), self.DOCUMENTS)

        # The inventory still lists the file — the agent must know it exists.
        assert "oib-rl_2_ausgabe_mai_2023.pdf" in rendered
        # …but it is labelled an index, not evidence.
        assert "NOT sources" in rendered
        assert "not a citable source" in rendered
        # And the anti-memory rule covers document keys, not only URLs.
        citation_block = rendered.split("<citation_format>")[1].split("</citation_format>")[0]
        assert "document citation keys" in citation_block
        assert "knowledge_search" in citation_block

    def test_shallow_prompt_asks_for_disagreement_between_sources_to_be_shown(self):
        """The everyday chat surface had no rule about contradictory sources.

        `deep_researcher/prompts/writer.j2` has told the writer to surface
        disagreement for a long time; the shallow prompt — the one that answers
        almost every question — mentioned contradiction only as a reason to
        escalate or to lower confidence, never as something to TELL the reader.
        In a legal product a smoothed-over difference is the dangerous failure:
        an unqualified answer reads as a settled one, and gets built on.
        """
        source = self._prompt("shallow_researcher/prompts/researcher.j2")

        assert "<source_disagreement>" in source
        block = source.split("<source_disagreement>")[1].split("</source_disagreement>")[0]
        # Show the difference rather than silently choosing.
        assert "Do not silently pick one" in block
        # Then resolve it by the precedence chain the domain brief already teaches.
        assert "binds outranks what interprets" in block
        # And when the chain cannot resolve it, say so instead of inventing a winner.
        assert "sources disagree" in block
        # An unresolved conflict must not be reported as high confidence.
        assert "not `high`" in block

    def test_deep_researcher_prompt_marks_the_inventory_as_not_a_source(self):
        rendered = self._render(self._prompt("deep_researcher/prompts/researcher.j2"), self.DOCUMENTS)

        assert "oib-rl_2_ausgabe_mai_2023.pdf" in rendered
        assert "NOT sources" in rendered
        assert "not a citable source" in rendered

    def test_no_prompt_still_calls_the_base_corpus_a_user_upload(self):
        """The list mixes the platform's OIB corpus with project uploads, so
        "User Uploaded Documents" was also simply untrue — and a heading rename
        must not leave dangling references to the old one."""
        for path in (
            "shallow_researcher/prompts/researcher.j2",
            "deep_researcher/prompts/researcher.j2",
            "deep_researcher/prompts/orchestrator.j2",
            "deep_researcher/prompts/planner.j2",
            "deep_researcher/prompts/source_router.j2",
        ):
            source = self._prompt(path)
            assert "Uploaded Documents" not in source, path

    def test_shallow_prompt_teaches_the_four_shelves(self):
        source = self._prompt("shallow_researcher/prompts/researcher.j2")
        assert "<knowledge_shelves>" in source
        assert "Büroarchiv" in source
        assert "NEVER the OIB corpus" in source
        assert "which files sit on which shelf" in source

    def test_grouped_inventory_does_not_mix_oib_into_archiv(self):
        documents = [
            {"file_name": "oib-rl_2.pdf", "summary": "Brandschutz.", "shelf": "base", "collection": "oib_knowledge"},
            {
                "file_name": "Buero-Standard.pdf",
                "summary": "Detail.",
                "shelf": "archiv",
                "collection": "archiv_org",
            },
        ]
        rendered = self._render(self._prompt("shallow_researcher/prompts/researcher.j2"), documents)
        archiv = rendered.split("### Büroarchiv", 1)[1].split("### ", 1)[0]
        assert "Buero-Standard.pdf" in archiv
        assert "oib-rl_2.pdf" not in archiv


class TestTheModelCardsAreActuallyAskedFor:
    """The five IFC cards had renderers and no instruction that named them.

    That instruction now lives in ``ifc-spatial-reasoning``, because most turns
    never touch a model and the always-on prompt must not teach a minority
    path. The prompt keeps a pointer so the model loads that skill before it
    emits. The skill keeps the card types and the id rule.
    """

    def _render(self):
        from pathlib import Path

        from aiq_agent.agents.shallow_researcher import agent as shallow_agent
        from aiq_agent.common import load_prompt
        from aiq_agent.common import render_prompt_template

        prompt = load_prompt(Path(shallow_agent.__file__).parent / "prompts", "researcher")
        return render_prompt_template(
            prompt,
            tools=[{"name": "ifc_query"}, {"name": "emit_card"}],
            user_info={"name": "Alex", "email": "a@example.com"},
            current_datetime="2026-07-23",
            available_documents=[],
            project_context=None,
            ris_catalog=None,
            norm_doctrine=None,
            parcel_note=None,
        )

    def _ifc_skill(self) -> str:
        from pathlib import Path

        import aiq_agent

        return (
            Path(aiq_agent.__file__).parent / "skills" / "builtin" / "bim" / "ifc-spatial-reasoning" / "SKILL.md"
        ).read_text(encoding="utf-8")

    def test_the_prompt_points_at_the_skill_instead_of_teaching_the_cards(self):
        rendered = self._render()
        assert "ifc-spatial-reasoning" in rendered
        assert "Most turns never touch a model." in rendered
        from aiq_agent.cards.catalog import MODEL_BACKED_CARD_TYPES

        for card_type in MODEL_BACKED_CARD_TYPES:
            assert card_type not in rendered.split("<cards>")[1].split("</cards>")[0], card_type

    def test_every_model_backed_card_is_named_in_the_skill(self):
        from aiq_agent.cards.catalog import MODEL_BACKED_CARD_TYPES

        body = self._ifc_skill()
        for card_type in MODEL_BACKED_CARD_TYPES:
            assert card_type in body, card_type

    def test_it_says_where_the_ids_must_come_from(self):
        # The one rule that keeps this from making things worse. An invented
        # GlobalId renders as an unresolved element, which tells the user their
        # model is broken when it is not.
        body = self._ifc_skill()
        assert "THIS turn" in body

    def test_the_card_does_not_replace_the_written_answer(self):
        rendered = self._render()
        assert "always write the prose reply too" in rendered


# ---------------------------------------------------------------------------
# Measurements in the Herleitung — and the wall between them and the gate
# ---------------------------------------------------------------------------


#: One decidable, computed, quantity-shaped envelope answer — the shape the
#: engine returns for „wie hoch ist der Keller". Written out rather than built
#: through ``ifc_spatial.envelope`` because the backend CI job does not install
#: the spatial engine, and a module-level import of it takes this whole file
#: down at collection (see the fix in commit 3ec4a3b3). Every field here is a
#: field of ``ifc_spatial.envelope.Answer``; ``test_ifc_measure_tool.py`` is
#: where the two are pinned against each other.
_MEASURED_BASEMENT = {
    "value": 2.703,
    "unit": "m",
    "tolerance": 0.005,
    "provenance": "computed",
    "from": ["3xR9kQvB7Fp8sT2mW1nZdY"],
    "method": "clearHeight(space 3xR9kQvB7Fp8sT2mW1nZdY)",
    "decidable": True,
    "caveat": "Nur die Räume mit exportierter Geschoßebene.",
}

_MEASURED_MODEL = {"model": {"filename": "Institut.ifc", "schemaVersion": "IFC4", "elements": 12043}}


@tool
def ifc_measure(operation: str = "measure") -> str:
    """Measure the project's IFC/BIM model and report the provenance."""
    from aiq_agent.agents.bim.measure_register import _render

    return _render(
        "measure",
        dict(_MEASURED_BASEMENT),
        source=dict(_MEASURED_MODEL),
        handle="0f1e2d3c4b5a",  # pragma: allowlist secret - an IFC model handle, not a credential
        detail="clearHeight",
    )


class TestMeasurementSourcesDoNotGroundCitations:
    """A measurement reaches the Herleitung; it never reaches the citation gate.

    The reason this class exists is the mixed answer:

        (a) „Der Keller ist 2,70 m hoch"            — measured, reproducible
        (b) „…und erfüllt damit OIB 4 Punkt 2.1"    — a legal claim, uncited

    Giving measurements a derivation trail means they now travel on the citation
    WIRE, beside the retrieved sources. If that also put them in the
    ``SourceRegistry``, ``citation_grounded`` would flip true off (a) and the
    normative brake — which is gated on its ABSENCE — would never run, so (b)
    would ride out at the model's own "high" on the strength of a basement
    measurement. That is the laundering path ``grounding`` exists to close, and
    these tests are what keep the Herleitung from re-opening it.
    """

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    def _measuring_turn(self, mock_llm, answer: str, *, tools=None):
        """An agent whose one tool call is a measurement, then the given answer."""
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="",
                    tool_calls=[{"name": "ifc_measure", "args": {"operation": "measure"}, "id": "m1"}],
                ),
                AIMessage(content=answer),
            ]
        )
        return tools or [ifc_measure]

    @staticmethod
    def _measurement_sources(result):
        return [s for s in (result.verified_sources or []) if s.get("kind") == "messung"]

    # -- the property that must not regress -----------------------------------

    @pytest.mark.asyncio
    async def test_measured_answer_with_uncited_normative_claim_still_surfaces_low(self, mock_llm_provider, mock_llm):
        """THE mixed case, after measurements appear in the Herleitung.

        Named so a reviewer looking for the laundering guard finds it. The
        assertion is deliberately the whole chain the chat node walks — the
        measurement IS in the derivation trail, and the answer is STILL "low"
        for ``normative_claim_uncited``.
        """
        from aiq_agent.agents.shallow_researcher.markers import answer_confidence_capped_reason
        from aiq_agent.agents.shallow_researcher.markers import surface_answer_confidence

        tools = self._measuring_turn(
            mock_llm,
            "Der Keller ist 2,70 m hoch und erfüllt damit die Mindestraumhöhe nach OIB-Richtlinie 4.",
        )
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=tools)
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        result, registry = await _run_with_captured_registry(agent, state)

        # The measurement really did reach the Herleitung…
        assert self._measurement_sources(result), "the measurement produced no Herleitung source"
        assert result.answer_measurement_grounded is True
        # …and the registry — the thing `citation_grounded` is derived from —
        # never saw it.
        assert registry.all_sources() == []
        assert result.answer_citation_grounded is False
        assert result.answer_normative_claim_uncited is True

        # The composition the chat node performs, on this turn's own signals.
        assert (
            surface_answer_confidence(
                "high",
                result.answer_citation_grounded,
                True,
                measurement_grounded=result.answer_measurement_grounded,
                normative_claim_uncited=result.answer_normative_claim_uncited,
                citation_fallback_used=result.answer_citation_fallback_used,
            )
            == "low"
        )
        assert (
            answer_confidence_capped_reason(
                "high",
                result.answer_citation_grounded,
                True,
                measurement_grounded=result.answer_measurement_grounded,
                normative_claim_uncited=result.answer_normative_claim_uncited,
                citation_fallback_used=result.answer_citation_fallback_used,
            )
            == "normative_claim_uncited"
        )

    @pytest.mark.asyncio
    async def test_a_lone_measurement_is_never_a_minimal_citation(self, mock_llm_provider, mock_llm):
        """The single-source fallback must not find a measurement to attach.

        ``len(sources) == 1`` appends that source as „[1]" and sets
        ``citation_grounded``. A measurement in the registry would BE that one
        source on a purely measured turn — the shortest path from a card in the
        Herleitung to a laundered verdict.
        """
        tools = self._measuring_turn(mock_llm, "Der Keller ist 2,70 m hoch.")
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=tools)
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        result, registry = await _run_with_captured_registry(agent, state)

        assert self._measurement_sources(result)
        assert registry.all_sources() == []
        assert result.answer_citation_grounded is False
        assert result.answer_citation_fallback_used is False
        answer = next(m for m in reversed(result.messages) if isinstance(m, AIMessage) and not m.tool_calls)
        assert "[1]" not in answer.content

    @pytest.mark.asyncio
    async def test_measured_descriptive_answer_still_reaches_medium(self, mock_llm_provider, mock_llm):
        """The signal this work must not weaken: measured + descriptive → medium.

        Same turn as above minus the legal claim. ``measurement_only`` is the
        reason, exactly as before measurements had a Herleitung.
        """
        from aiq_agent.agents.shallow_researcher.markers import answer_confidence_capped_reason
        from aiq_agent.agents.shallow_researcher.markers import surface_answer_confidence

        tools = self._measuring_turn(mock_llm, "Der Keller ist 2,70 m hoch.")
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=tools)
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        result, _ = await _run_with_captured_registry(agent, state)

        assert result.answer_measurement_grounded is True
        assert result.answer_normative_claim_uncited is False
        assert (
            surface_answer_confidence(
                "high",
                result.answer_citation_grounded,
                True,
                measurement_grounded=True,
                normative_claim_uncited=False,
                citation_fallback_used=result.answer_citation_fallback_used,
            )
            == "medium"
        )
        assert (
            answer_confidence_capped_reason(
                "high",
                result.answer_citation_grounded,
                True,
                measurement_grounded=True,
                normative_claim_uncited=False,
                citation_fallback_used=result.answer_citation_fallback_used,
            )
            == "measurement_only"
        )

    @pytest.mark.asyncio
    async def test_failed_retrieval_still_raises_even_when_the_turn_measured(self, mock_llm_provider, mock_llm):
        """``EmptySourceRegistryError`` keeps its meaning.

        The error asks "did retrieval capture anything to cite?", and it is
        raised from the branch guarded by ``if registry.all_sources()``. A
        measurement in the registry would answer that question with a value that
        was never retrieved, so a turn whose web search came back empty would
        quietly stop reporting the failure it exists to report.
        """
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["empty_web_search_tool"],
                }
            ],
        )
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "ifc_measure", "args": {"operation": "measure"}, "id": "m1"},
                        {"name": "empty_web_search_tool", "args": {"query": "OIB 4 Raumhöhe"}, "id": "w1"},
                    ],
                ),
                AIMessage(content="Der Keller ist 2,70 m hoch."),
            ]
        )
        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[ifc_measure, empty_web_search_tool],
        )
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        with pytest.raises(EmptySourceRegistryError):
            await _run_with_captured_registry(agent, state)

    # -- what the card actually carries ---------------------------------------

    @pytest.mark.asyncio
    async def test_the_card_carries_the_audit_trail_the_envelope_had(self, mock_llm_provider, mock_llm):
        """Value, tolerance, German provenance, method, GlobalIds, model, caveat."""
        tools = self._measuring_turn(mock_llm, "Der Keller ist 2,70 m hoch.")
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=tools)
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        result, _ = await _run_with_captured_registry(agent, state)

        (card,) = self._measurement_sources(result)
        assert card["lane"] == "messung"
        assert card["title"] == "clearHeight"
        measurement = card["measurement"]
        assert measurement["provenance"] == "computed"
        # The renderer's own verb, so the card and the prose agree.
        assert measurement["provenance_label"] == "gemessen"
        assert measurement["value_text"] == "2.703 m"
        assert measurement["tolerance_text"] == "±0.005 m"
        assert measurement["method"] == _MEASURED_BASEMENT["method"]
        assert [e["global_id"] for e in measurement["elements"]] == _MEASURED_BASEMENT["from"]
        assert measurement["model"] == "Institut.ifc (IFC4, 12043 Bauteile)"
        assert measurement["caveat"] == _MEASURED_BASEMENT["caveat"]

    @pytest.mark.asyncio
    async def test_the_measurement_does_not_count_as_a_cited_source(self, mock_llm_provider, mock_llm):
        """The citation-health ledger counts CITATIONS, not measurements.

        ``cited_count`` is measured against ``source_count`` — this turn's
        retrieval. A measurement appended to the wire and then counted as a
        citation would report one cited source out of zero retrieved.
        """
        tools = self._measuring_turn(mock_llm, "Der Keller ist 2,70 m hoch.")
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=tools)
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist der Keller?")],
        )
        with patch("aiq_agent.agents.shallow_researcher.agent.citation_events") as events:
            result, _ = await _run_with_captured_registry(agent, state)

        assert self._measurement_sources(result)
        assert events.record_turn.call_args.kwargs["cited_count"] == 0
        assert events.record_turn.call_args.kwargs["source_count"] == 0


# ---------------------------------------------------------------------------
# The research budget: what it counts, and what it must stop counting
# ---------------------------------------------------------------------------


class TestTheResearchBudgetIsNotSpentOnForcedSkills:
    """``max_tool_iterations`` is the RESEARCH ceiling, not the tool-call ceiling.

    The budget is charged per CALL (``new_iterations += len(response.tool_calls)``),
    and the deployment forces two standard skills, so on this fleet the model
    has to spend two of them on ``use_skill`` before it may read a single
    source. The config's traced floors assume ONE, which is how an OIB 3
    daylight chain — knowledge_search, find_elements, relations, overhang,
    light_incidence — lands exactly on the ceiling and gets forced into
    synthesis before the measurement that answers the question.

    So the overhead the DEPLOYMENT imposes is reserved on top of the number,
    and the research ceiling stops depending on how many house skills the
    platform owner happens to have published.
    """

    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as verify,
            patch("aiq_agent.agents.shallow_researcher.agent.sanitize_report") as sanitize,
        ):
            verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
                verified_report=content, removed_citations=[]
            )
            sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

    def _agent(self, reserved: int, iterations: int = 3):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        return (
            ShallowResearcherAgent(
                llm_provider=provider,
                tools=[web_search_tool],
                max_tool_iterations=iterations,
                reserved_tool_iterations=reserved,
            ),
            llm,
        )

    def test_the_reserve_is_added_to_the_ceiling_not_taken_from_it(self):
        agent, _ = self._agent(reserved=2, iterations=7)
        # The research budget is untouched — it is what the config's floors are
        # traced against — and the forced-skill overhead rides on top of it.
        assert agent.max_tool_iterations == 7
        assert agent.tool_iteration_ceiling == 9

    def test_a_deployment_with_no_standard_skills_is_unchanged(self):
        agent, _ = self._agent(reserved=0, iterations=7)
        assert agent.tool_iteration_ceiling == 7

    @pytest.mark.asyncio
    async def test_the_reserved_calls_do_not_end_the_research(self):
        """The behaviour, not the arithmetic: two skill calls, then full research.

        With a 3-call research budget and two forced skills, a turn that opens
        both skills must still get three research calls. Charge the skills to
        the research budget and the third one never happens — the model is
        handed the "you have exhausted your research budget" anchor instead,
        with no tools bound, and whatever it had by then becomes the answer.
        """
        agent, llm = self._agent(reserved=2, iterations=3)
        calls = [
            AIMessage(content="", tool_calls=[{"name": "web_search_tool", "args": {"query": "a"}, "id": "c1"}]),
            AIMessage(content="", tool_calls=[{"name": "web_search_tool", "args": {"query": "b"}, "id": "c2"}]),
            AIMessage(content="", tool_calls=[{"name": "web_search_tool", "args": {"query": "c"}, "id": "c3"}]),
            AIMessage(content="Die Antwort [1]."),
        ]
        llm.ainvoke = AsyncMock(side_effect=calls)

        # Two `use_skill` calls are already charged when research begins.
        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="Wie tief ist der Lichteinfall?")],
            tool_iterations=2,
        )
        await agent.run(state)

        anchored = [
            index
            for index, call in enumerate(llm.ainvoke.call_args_list)
            if any("exhausted your research budget" in str(m.content) for m in call.args[0])
        ]
        # Calls 0, 1 and 2 are the three research calls the budget promises;
        # only call 3, with the budget genuinely spent, may be forced synthesis.
        # Charge the two skill loads to the research budget and the anchor
        # arrives on call 1 instead — two thirds of the research never happens.
        assert anchored == [3], (
            f"forced synthesis fired on LLM call(s) {anchored}; expected only the last. "
            "The forced-skill calls were charged to the research budget."
        )
        assert llm.ainvoke.await_count == 4


class TestTruncationIsObservable:
    """Silent truncation is the worst failure this product has; make it countable.

    Hitting the ceiling means evidence-gathering was CUT OFF and the answer was
    written from whatever had been gathered by then. ``[CONFIDENCE:…]`` does not
    cover it — that grades whether the claims are sourced, not whether the
    search finished — so before this there was nothing anywhere that could
    answer "how often does this happen, and on which question shapes".
    """

    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as verify,
            patch("aiq_agent.agents.shallow_researcher.agent.sanitize_report") as sanitize,
        ):
            verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
                verified_report=content, removed_citations=[]
            )
            sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

    @pytest.fixture
    def steps(self):
        """Every custom step pushed during the test, as parsed payloads."""
        import json

        from nat.builder.context import ContextState
        from nat.utils.reactive.subject import Subject

        state = ContextState.get()
        state.active_span_id_stack.set(["root"])
        state._event_stream.set(Subject())
        seen: list[dict] = []

        def _on_next(step) -> None:
            payload = step.payload
            body = getattr(payload.data, "input", None)
            if isinstance(body, str) and str(payload.event_type).endswith("START"):
                seen.append({"step": payload.name, **json.loads(body)})

        state.event_stream.get().subscribe(_on_next)
        yield seen
        state.active_span_id_stack.set(["root"])
        state._event_stream.set(Subject())

    async def _truncated_run(self):
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Die Antwort [1]."))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = ShallowResearcherAgent(
            llm_provider=provider,
            tools=[web_search_tool],
            max_tool_iterations=3,
            reserved_tool_iterations=2,
        )
        # A run that already spent its whole ceiling: two skill loads and three
        # searches — the shape of an OIB measurement chain walking into the wall.
        history = [
            HumanMessage(content="Wie tief ist der Lichteinfall?"),
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "use_skill", "args": {"skill_name": "piloti-voice"}, "id": "s1"},
                    {"name": "use_skill", "args": {"skill_name": "piloti-cards"}, "id": "s2"},
                ],
            ),
            AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {}, "id": "k1"}]),
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "find_elements", "args": {}, "id": "f1"},
                    {"name": "light_incidence", "args": {}, "id": "l1"},
                ],
            ),
        ]
        state = ShallowResearchAgentState(messages=history, tool_iterations=5)
        await agent.run(state)

    @pytest.mark.asyncio
    async def test_the_log_says_what_was_cut_off_and_on_what_shape(self, caplog):
        import logging

        with caplog.at_level(logging.WARNING, logger="aiq_agent.agents.shallow_researcher.agent"):
            await self._truncated_run()

        lines = [m for m in caplog.messages if "Research budget exhausted" in m]
        assert lines, f"the turn was cut off and left no countable record of it; warnings logged were {caplog.messages}"
        line = lines[0]
        # The numbers that make "how often" answerable per deployment…
        assert "ceiling=5" in line
        assert "research_budget=3" in line
        assert "reserved=2" in line
        assert "spent=5" in line
        # …rounds beside calls, because one greedy parallel batch and a long
        # walk into the wall are different failures…
        assert "rounds=3" in line
        assert "skill_calls=2" in line
        # …and the SHAPE, which is what makes "on which questions" answerable
        # without putting the reader's own words in a log line.
        assert "shape=use_skill>use_skill>knowledge_search>find_elements>light_incidence" in line
        assert "Lichteinfall" not in line

    @pytest.mark.asyncio
    async def test_the_turn_records_the_truncation_as_telemetry(self, steps):
        await self._truncated_run()

        records = [step for step in steps if step.get("slot") == "budget"]
        assert records, (
            "evidence-gathering was cut off and the turn emitted no truncation telemetry — "
            f"nothing here can answer how often it happens; steps were {[s.get('step') for s in steps]}"
        )
        record = records[0]
        assert record["truncated"] is True
        assert (record["ceiling"], record["research_budget"], record["reserved"]) == (5, 3, 2)
        assert record["spent"] == 5
        assert record["rounds"] == 3
        assert record["tools"][:2] == ["use_skill", "use_skill"]
        # Technical channel, and therefore no `key`: whether the READER is told
        # the answer stopped early is a product decision, and a live key would
        # make it silently.
        assert record["channel"] == "technical"
        assert "key" not in record

    @pytest.mark.asyncio
    async def test_the_answer_carries_the_fact_out_of_the_graph(self):
        """The log is for us; this field is the half the reader gets.

        Telemetry answers "how often". It cannot put a line under the answer
        the reader is looking at, and that answer is the one place where "the
        search stopped early" changes what a person does next.
        """
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Die Antwort [1]."))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = ShallowResearcherAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=2)

        truncated = await agent.run(
            ShallowResearchAgentState(messages=[HumanMessage(content="Wie tief?")], tool_iterations=2)
        )
        assert truncated.research_truncated is True

    @pytest.mark.asyncio
    async def test_an_answer_that_finished_its_research_claims_nothing(self):
        """Absent, not False: presence is the fact, so nothing has to read a default."""
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Die Antwort [1]."))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = ShallowResearcherAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=3)

        finished = await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Kurz gefragt")]))
        assert finished.research_truncated is None

    @pytest.mark.asyncio
    async def test_a_turn_that_finishes_inside_its_budget_records_nothing(self, steps):
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Die Antwort [1]."))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = ShallowResearcherAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=3)

        await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="Kurz gefragt")]))

        assert [s for s in steps if s.get("slot") == "budget"] == []


class TestInteractionCallCounting:
    """``_count_interaction_calls`` — which calls the research budget skips."""

    def test_it_counts_the_answers_own_output_channel(self):
        calls = [
            {"name": "emit_card", "args": {}, "id": "1"},
            {"name": "describe_card", "args": {}, "id": "2"},
            {"name": "remember", "args": {}, "id": "3"},
        ]
        assert _count_interaction_calls(calls) == 3

    def test_it_does_not_count_research(self):
        calls = [
            {"name": "web_search_tool", "args": {}, "id": "1"},
            {"name": "emit_card", "args": {}, "id": "2"},
        ]
        assert _count_interaction_calls(calls) == 1

    def test_it_resolves_a_qualified_tool_name(self):
        # NAT/MCP qualify a tool name; `tool_basename` resolves the base name
        # the same way, and an unrecognised `emit_card` would be charged to
        # research on exactly the deployments that qualify names.
        assert _count_interaction_calls([{"name": "aiq_cards__emit_card", "args": {}, "id": "1"}]) == 1

    def test_an_unreadable_call_counts_as_research(self):
        # The conservative direction: it can shorten a turn's research, never
        # let the tool loop run longer than its ceiling.
        assert _count_interaction_calls([None, {"args": {}}, {"name": ""}]) == 0

    def test_it_tolerates_no_calls(self):
        assert _count_interaction_calls([]) == 0
        assert _count_interaction_calls(None) == 0

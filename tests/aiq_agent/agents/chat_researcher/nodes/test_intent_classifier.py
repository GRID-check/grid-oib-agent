"""Tests for the IntentClassifier node (combined intent + depth + meta orchestration)."""

from typing import ClassVar
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.nodes.intent_classifier import IntentClassifier


class TestIntentClassifier:
    """Tests for the IntentClassifier class."""

    @pytest.fixture
    def mock_llm(self):
        """Create a mock LLM."""
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        return llm

    def test_init_with_defaults(self, mock_llm):
        """Test IntentClassifier initialization with defaults."""
        classifier = IntentClassifier(llm=mock_llm)
        assert classifier.llm == mock_llm
        assert classifier.tools_info == []
        assert classifier.prompt is not None
        assert classifier.callbacks == []

    def test_init_with_tools_info(self, mock_llm):
        """Test IntentClassifier initialization with tools_info."""
        tools = [{"name": "web_search", "description": "Search the web"}]
        classifier = IntentClassifier(llm=mock_llm, tools_info=tools)
        assert classifier.tools_info == tools

    def test_init_with_custom_prompt(self, mock_llm):
        """Test IntentClassifier initialization with custom prompt."""
        custom_prompt = "Custom intent prompt {{ query }}"
        classifier = IntentClassifier(llm=mock_llm, prompt=custom_prompt)
        assert classifier.prompt == custom_prompt

    def test_init_with_callbacks(self, mock_llm):
        """Test IntentClassifier initialization with callbacks."""
        callbacks = [MagicMock()]
        classifier = IntentClassifier(llm=mock_llm, callbacks=callbacks)
        assert classifier.callbacks == callbacks

    @pytest.mark.asyncio
    async def test_run_classifies_meta_intent(self, mock_llm):
        """Test run() is a pure router: meta intent produces NO messages (the shallow agent answers)."""
        mock_response = MagicMock()
        mock_response.content = '{"intent":"meta","research_depth":null,"depth_reasoning":null}'
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="Hello?")])

        result = await classifier.run(state)

        assert isinstance(result, dict)
        assert result["user_intent"].intent == "meta"
        # Pure router: never authors user-facing text; downstream agent replies.
        assert "messages" not in result
        # Depth still defaults to shallow so routing has a decision either way.
        assert result["depth_decision"].decision == "shallow"
        mock_llm.ainvoke.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_classifies_research_intent(self, mock_llm):
        """Test run() returns dict with research intent and depth_decision when LLM returns research JSON."""
        mock_response = MagicMock()
        mock_response.content = (
            '{"intent":"research","meta_response":null,"research_depth":"shallow","depth_reasoning":"Simple query"}'
        )
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="What is CUDA?")])

        result = await classifier.run(state)

        assert isinstance(result, dict)
        assert result["user_intent"].intent == "research"
        assert result["depth_decision"].decision == "shallow"
        assert result["depth_decision"].raw_reasoning == "Simple query"

    @pytest.mark.asyncio
    async def test_run_defaults_to_research_on_ambiguous(self, mock_llm):
        """Test run() defaults to research when LLM returns intent that is not meta or research."""
        mock_response = MagicMock()
        mock_response.content = (
            '{"intent":"unknown_intent","meta_response":null,"research_depth":"shallow","depth_reasoning":""}'
        )
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="Something")])

        result = await classifier.run(state)

        # Invalid/ambiguous intent is normalized to research so workflow continues
        assert result["user_intent"].intent == "research"
        assert result["depth_decision"].decision == "shallow"

    @pytest.mark.asyncio
    async def test_run_empty_messages_returns_dict_no_llm_call(self, mock_llm):
        """Test run() with empty messages returns dict with research + depth_decision, no LLM call."""
        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[])

        result = await classifier.run(state)

        assert isinstance(result, dict)
        assert result["user_intent"].intent == "research"
        assert result["depth_decision"].decision == "deep"
        mock_llm.ainvoke.assert_not_called()

    @pytest.mark.asyncio
    async def test_run_handles_llm_error(self, mock_llm):
        """Test run() on LLM error returns error intent + message so flow ends (no routing)."""
        mock_llm.ainvoke = AsyncMock(side_effect=Exception("LLM error"))

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="Test query")])

        result = await classifier.run(state)

        assert isinstance(result, dict)
        assert result["user_intent"].intent == "error"
        assert "messages" in result
        assert len(result["messages"]) == 1
        assert isinstance(result["messages"][0], AIMessage)
        assert "temporary error" in result["messages"][0].content

    @pytest.mark.asyncio
    async def test_run_with_callbacks(self, mock_llm):
        """Test run() passes callbacks via config to LLM ainvoke(rendered_prompt, config=...)."""
        mock_response = MagicMock()
        mock_response.content = '{"intent":"meta","research_depth":null,"depth_reasoning":null}'
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        mock_callback = MagicMock()
        classifier = IntentClassifier(llm=mock_llm, callbacks=[mock_callback])
        state = ChatResearcherState(messages=[HumanMessage(content="Hi there")])

        await classifier.run(state)

        call_args = mock_llm.ainvoke.call_args
        # ainvoke(rendered_prompt, config=config)
        assert call_args[0][0]  # first positional arg is the prompt string
        config = call_args[1].get("config", {})
        assert config.get("callbacks") == [mock_callback]

    @pytest.mark.asyncio
    async def test_run_meta_in_longer_response(self, mock_llm):
        """Test run() parses meta from JSON in response."""
        mock_response = MagicMock()
        mock_response.content = '{"intent":"meta","research_depth":null,"depth_reasoning":null}'
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="Hello!")])

        result = await classifier.run(state)

        assert result["user_intent"].intent == "meta"

    @pytest.mark.asyncio
    async def test_run_research_in_longer_response(self, mock_llm):
        """Test run() parses research from JSON in response."""
        mock_response = MagicMock()
        mock_response.content = (
            '{"intent":"research","meta_response":null,'
            '"research_depth":"deep","depth_reasoning":"This requires research."}'
        )
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="What is CUDA?")])

        result = await classifier.run(state)

        assert result["user_intent"].intent == "research"
        assert result["depth_decision"].decision == "deep"

    @pytest.mark.asyncio
    async def test_run_invalid_json_fallback(self, mock_llm):
        """Test run() on unparseable JSON returns fallback research + shallow depth_decision."""
        mock_response = MagicMock()
        mock_response.content = "not valid json at all"
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="Test")])

        result = await classifier.run(state)

        assert result["user_intent"].intent == "research"
        assert result["depth_decision"].decision == "shallow"

    def test_load_default_prompt_fallback(self, mock_llm):
        """Test _load_default_prompt returns fallback when not found."""
        with patch(
            "aiq_agent.agents.chat_researcher.nodes.intent_classifier.load_prompt",
            side_effect=FileNotFoundError(),
        ):
            classifier = IntentClassifier(llm=mock_llm)
            prompt_lower = classifier.prompt.lower()
            assert "meta" in prompt_lower or "research" in prompt_lower

    def test_default_prompt_treats_project_profile_questions_as_meta(self, mock_llm):
        """The taxonomy must cover project-profile/context turns explicitly.

        Regression: "what do you need to know to fill that in?" had no bucket —
        neither small talk nor a regulations lookup — and fell into research via
        the tie-break, where the citation contract then rejected the answer.
        """
        classifier = IntentClassifier(llm=mock_llm)
        meta_bullet = next(line for line in classifier.prompt.splitlines() if '**intent = "meta"**' in line)
        assert "project profile" in meta_bullet

    def test_default_prompt_routes_out_of_scope_to_meta(self, mock_llm):
        """Out-of-scope queries must be an explicit `meta` bucket, not swept into
        research by the tie-break.

        Regression: "how do I bake a cake" matched no meta sub-bucket and the
        old tie-break ("mixed or unclear intent -> research") routed it to a
        research lookup, producing a dishonest classification and wasting a
        search. It must classify as meta so the assistant gives a friendly
        redirect instead.
        """
        classifier = IntentClassifier(llm=mock_llm)
        prompt = classifier.prompt
        # An explicit out-of-scope -> meta rule exists.
        assert "Out-of-scope" in prompt
        out_of_scope_line = next(line for line in prompt.splitlines() if "Out-of-scope" in line)
        assert "meta" in out_of_scope_line
        assert "never research" in out_of_scope_line
        # The tie-break no longer blanket-routes unclear intent to research: it
        # only keeps IN-DOMAIN ambiguity as research, sending clearly
        # out-of-domain queries to meta.
        tie_break_line = next(line for line in prompt.splitlines() if "Tie-breaks" in line)
        assert "in-domain" in tie_break_line.lower()
        assert "meta" in tie_break_line


class _BindSpyChatModel(FakeMessagesListChatModel):
    """Fake chat model that records the kwargs passed to bind()."""

    bind_kwargs: ClassVar[list[dict]] = []

    def bind(self, **kwargs):
        type(self).bind_kwargs.append(kwargs)
        return super().bind(**kwargs)


class _StructuredRejectingChatModel(FakeMessagesListChatModel):
    """Fake chat model whose structured-output binding fails at request time."""

    def bind(self, **kwargs):
        failing = MagicMock()
        failing.ainvoke = AsyncMock(side_effect=Exception("400: response_format is not supported by this model"))
        return failing


class TestIntentClassifierRobustness:
    """JSON-enforcement layers: message shape, structured output, corrective retry.

    Regression suite for the misrouting incident where the classifier model
    answered the user's question in prose instead of emitting routing JSON,
    and the parse-failure fallback sent a conversational turn down the strict
    research path.
    """

    _META_JSON = '{"intent":"meta","research_depth":null,"depth_reasoning":null}'

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        return llm

    @pytest.mark.asyncio
    async def test_final_turn_is_classification_instruction(self, mock_llm):
        """The last message sent to the LLM must demand the routing JSON, so a
        chat-tuned model doesn't just continue the replayed conversation."""
        mock_response = MagicMock()
        mock_response.content = self._META_JSON
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="what do you need to know to fill that in?")])
        await classifier.run(state)

        sent_messages = mock_llm.ainvoke.call_args[0][0]
        assert isinstance(sent_messages[-1], HumanMessage)
        assert "ONLY the raw JSON" in sent_messages[-1].content

    @pytest.mark.asyncio
    async def test_prose_response_retried_once_then_parsed(self, mock_llm):
        """A prose reply triggers exactly one corrective retry; a valid JSON
        reply on the retry is used for routing."""
        prose = MagicMock()
        prose.content = "To fill in the missing details, I need to know the exact building height."
        json_reply = MagicMock()
        json_reply.content = self._META_JSON
        mock_llm.ainvoke = AsyncMock(side_effect=[prose, json_reply])

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="what do you need to know?")])
        result = await classifier.run(state)

        assert result["user_intent"].intent == "meta"
        assert mock_llm.ainvoke.call_count == 2
        retry_messages = mock_llm.ainvoke.call_args_list[1][0][0]
        # The retry quotes the bad reply back and re-demands bare JSON.
        assert any(isinstance(m, AIMessage) and "building height" in str(m.content) for m in retry_messages)
        assert "not the required JSON" in retry_messages[-1].content

    @pytest.mark.asyncio
    async def test_parse_failure_after_retry_falls_back_to_research(self, mock_llm):
        """Two prose replies exhaust the retry and hit the research/shallow fallback."""
        prose = MagicMock()
        prose.content = "Still just chatting, no JSON here."
        mock_llm.ainvoke = AsyncMock(return_value=prose)

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="hi")])
        result = await classifier.run(state)

        assert mock_llm.ainvoke.call_count == 2
        assert result["user_intent"].intent == "research"
        assert result["depth_decision"].decision == "shallow"
        assert result["depth_decision"].raw_reasoning == "Parse failed"

    @pytest.mark.asyncio
    async def test_list_content_routes_normally(self, mock_llm):
        """Reasoning models can return content as a list of blocks; the classifier
        must flatten it and route, not fall into the blanket-except error path.

        Regression: ``(list or "").strip()`` raised AttributeError on non-empty
        list content, so the first step of every chat turn returned intent=error.
        """
        mock_response = MagicMock()
        mock_response.content = [
            {"type": "text", "text": self._META_JSON},
        ]
        mock_llm.ainvoke = AsyncMock(return_value=mock_response)

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="Hello?")])
        result = await classifier.run(state)

        assert result["user_intent"].intent == "meta"
        assert result["user_intent"].intent != "error"

    @pytest.mark.asyncio
    async def test_list_content_on_retry_path_parsed(self, mock_llm):
        """List-shaped content on the corrective retry is also flattened and parsed."""
        prose = MagicMock()
        prose.content = [{"type": "text", "text": "Just chatting, no JSON."}]
        json_reply = MagicMock()
        json_reply.content = [{"type": "text", "text": self._META_JSON}]
        mock_llm.ainvoke = AsyncMock(side_effect=[prose, json_reply])

        classifier = IntentClassifier(llm=mock_llm)
        state = ChatResearcherState(messages=[HumanMessage(content="hi")])
        result = await classifier.run(state)

        assert mock_llm.ainvoke.call_count == 2
        assert result["user_intent"].intent == "meta"

    @pytest.mark.asyncio
    async def test_chat_model_gets_structured_output_binding(self):
        """Real chat models are bound with an OpenAI-style json_schema
        response_format so the provider enforces the JSON server-side."""
        _BindSpyChatModel.bind_kwargs.clear()
        llm = _BindSpyChatModel(responses=[AIMessage(content=self._META_JSON)])

        classifier = IntentClassifier(llm=llm)
        state = ChatResearcherState(messages=[HumanMessage(content="Hello?")])
        result = await classifier.run(state)

        assert result["user_intent"].intent == "meta"
        assert len(_BindSpyChatModel.bind_kwargs) == 1
        response_format = _BindSpyChatModel.bind_kwargs[0]["response_format"]
        assert response_format["type"] == "json_schema"
        assert response_format["json_schema"]["schema"]["properties"]["intent"]["enum"] == ["meta", "research"]

    @pytest.mark.asyncio
    async def test_structured_output_rejection_falls_back_to_plain_call(self):
        """Providers that reject response_format degrade to a plain call with
        prose parsing instead of surfacing an error."""
        llm = _StructuredRejectingChatModel(responses=[AIMessage(content=self._META_JSON)])

        classifier = IntentClassifier(llm=llm)
        state = ChatResearcherState(messages=[HumanMessage(content="Hello?")])
        result = await classifier.run(state)

        assert result["user_intent"].intent == "meta"


_REASONING_400 = (
    "Error code: 400 - {'error': {'message': 'Reasoning is mandatory for this endpoint "
    "and cannot be disabled.', 'code': 400}}"
)


class _ReasoningMandatoryChatModel(FakeMessagesListChatModel):
    """Fake overridden model that 400s like grok-4.5 with reasoning_effort none."""

    def bind(self, **kwargs):
        failing = MagicMock()
        failing.ainvoke = AsyncMock(side_effect=Exception(_REASONING_400))
        return failing

    async def ainvoke(self, *args, **kwargs):
        raise Exception(_REASONING_400)  # noqa: TRY002 — mirrors provider error shape


class TestReasoningIncompatibleOverrideFallback:
    """Regression: org override intent -> reasoning-mandatory model must not kill the turn.

    Production incident 2026-07-18: override `intent -> x-ai/grok-4.5` with the
    YAML's reasoning_effort:none 400'd on both classifier attempts and every
    greeting returned 'temporary error'. The classifier now falls back to the
    workflow-default model when the override is reasoning-incompatible.
    """

    _META_JSON = '{"intent":"meta","research_depth":null,"depth_reasoning":null}'

    def test_error_matcher(self):
        from aiq_agent.common import is_reasoning_incompatible_error

        assert is_reasoning_incompatible_error(Exception(_REASONING_400))
        assert is_reasoning_incompatible_error(Exception("[400] reasoning cannot be disabled"))
        assert not is_reasoning_incompatible_error(Exception("400: response_format not supported"))
        assert not is_reasoning_incompatible_error(Exception("the reasoning in this answer is wrong"))

    @pytest.mark.asyncio
    async def test_fallback_to_default_model_when_override_incompatible(self, monkeypatch):
        from langchain_core.messages import AIMessage as _AI

        default_llm = FakeMessagesListChatModel(responses=[_AI(content=self._META_JSON)])
        broken_override = _ReasoningMandatoryChatModel(responses=[_AI(content="unused")])

        classifier = IntentClassifier(llm=default_llm)
        monkeypatch.setattr(
            "aiq_agent.common.apply_model_override",
            lambda llm, group, overrides=None: broken_override,
        )
        monkeypatch.setattr("aiq_agent.common.apply_org_credential", lambda llm: llm)

        state = ChatResearcherState(messages=[HumanMessage(content="hello")])
        result = await classifier.run(state)
        assert result["user_intent"].intent == "meta"  # answered via the default model, turn not dead

    @pytest.mark.asyncio
    async def test_no_fallback_when_default_model_itself_fails(self, monkeypatch):
        """A reasoning-400 from the un-overridden default must surface, not loop."""
        broken_default = _ReasoningMandatoryChatModel(responses=[])
        classifier = IntentClassifier(llm=broken_default)
        monkeypatch.setattr("aiq_agent.common.apply_model_override", lambda llm, group, overrides=None: llm)
        monkeypatch.setattr("aiq_agent.common.apply_org_credential", lambda llm: llm)

        state = ChatResearcherState(messages=[HumanMessage(content="hello")])
        result = await classifier.run(state)
        assert result["user_intent"].intent == "error"

"""Tests for the provider-portable chat-request contract.

These cover the failure family behind issues #291-#294, #333, #335, #336 and
#340: a request whose last message is an assistant turn, which OpenAI-compatible
providers accept and Google rejects with
``400 INVALID_ARGUMENT - Requests ending with a model turn are not supported``.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage

from aiq_agent.common.llm_factory import enforce_chat_request_contract
from aiq_agent.common.message_contract import CONTINUATION_TURN
from aiq_agent.common.message_contract import ends_on_model_turn
from aiq_agent.common.message_contract import normalize_chat_request
from tests.conftest import ProviderContractError


class TestNormalizeChatRequest:
    def test_appends_a_continuation_when_the_request_ends_on_an_assistant_turn(self):
        messages = [HumanMessage(content="Brauche ich einen Aufzug?"), AIMessage(content="Ja, vermutlich.")]

        result = normalize_chat_request(messages)

        assert not ends_on_model_turn(result)
        assert result[-1].content == CONTINUATION_TURN
        # Context-preserving: the assistant answer is still there, untouched.
        assert result[:2] == messages

    def test_leaves_a_request_that_already_ends_on_a_user_turn_alone(self):
        messages = [SystemMessage(content="sys"), AIMessage(content="prior"), HumanMessage(content="now this")]

        assert normalize_chat_request(messages) == messages

    def test_leaves_a_request_ending_on_tool_results_alone(self):
        messages = [
            HumanMessage(content="q"),
            AIMessage(content="", tool_calls=[{"name": "search", "args": {}, "id": "1"}]),
            ToolMessage(content="results", tool_call_id="1"),
        ]

        assert normalize_chat_request(messages) == messages

    def test_is_idempotent(self):
        messages = [HumanMessage(content="q"), AIMessage(content="a")]

        once = normalize_chat_request(messages)

        assert normalize_chat_request(once) == once

    def test_empty_request_is_passed_through(self):
        assert normalize_chat_request([]) == []

    def test_unanswered_tool_calls_are_left_to_fail_loudly(self):
        """A graph bug must stay visible rather than be papered over.

        A trailing assistant turn with pending ``tool_calls`` is malformed on
        every provider, so normalizing it would hide a tool node that never ran
        behind a silently degraded answer.
        """
        messages = [
            HumanMessage(content="q"),
            AIMessage(content="", tool_calls=[{"name": "search", "args": {}, "id": "1"}]),
        ]

        assert normalize_chat_request(messages) == messages


class TestEndsOnModelTurn:
    @pytest.mark.parametrize(
        ("messages", "expected"),
        [
            ([], False),
            ([HumanMessage(content="q")], False),
            ([HumanMessage(content="q"), AIMessage(content="a")], True),
            ([AIMessage(content="a"), HumanMessage(content="q")], False),
        ],
    )
    def test_predicate(self, messages, expected):
        assert ends_on_model_turn(messages) is expected


class TestContractEnforcementAtTheLLMChokepoint:
    """The contract has to hold for every path a model can be called through.

    Wrapping ``ainvoke`` would have been bypassed by the streaming and
    structured-output paths — which is where the production failures actually
    came from — so enforcement sits on the generate/stream hooks that all of
    these converge on.
    """

    @pytest.mark.asyncio
    async def test_unprotected_model_rejects_a_trailing_assistant_turn(self, strict_provider_llm):
        """Guards the guard: without the contract this request really does fail."""
        llm = strict_provider_llm(with_contract=False)

        with pytest.raises(ProviderContractError, match="ending with a model turn"):
            await llm.ainvoke([HumanMessage(content="q"), AIMessage(content="a")])

    @pytest.mark.asyncio
    async def test_ainvoke_is_protected(self, strict_provider_llm):
        llm = strict_provider_llm(["done"])

        result = await llm.ainvoke([HumanMessage(content="q"), AIMessage(content="a")])

        assert result.content == "done"
        assert llm.received[-1][-1].content == CONTINUATION_TURN

    def test_sync_invoke_is_protected(self, strict_provider_llm):
        llm = strict_provider_llm(["done"])

        assert llm.invoke([HumanMessage(content="q"), AIMessage(content="a")]).content == "done"

    @pytest.mark.asyncio
    async def test_tool_bound_calls_are_protected(self, strict_provider_llm):
        llm = strict_provider_llm(["done"])

        bound = llm.bind_tools([])
        result = await bound.ainvoke([HumanMessage(content="q"), AIMessage(content="a")])

        assert result.content == "done"

    @pytest.mark.asyncio
    async def test_bound_request_format_calls_are_protected(self, strict_provider_llm):
        """The structured-output path (``llm.bind(response_format=...)``)."""
        llm = strict_provider_llm(["done"])

        bound = llm.bind(response_format={"type": "json_object"})
        result = await bound.ainvoke([HumanMessage(content="q"), AIMessage(content="a")])

        assert result.content == "done"

    @pytest.mark.asyncio
    async def test_streaming_is_protected(self, strict_provider_llm):
        llm = strict_provider_llm(["streamed"])

        chunks = [chunk async for chunk in llm.astream([HumanMessage(content="q"), AIMessage(content="a")])]

        assert "".join(chunk.content for chunk in chunks) == "streamed"

    @pytest.mark.asyncio
    async def test_per_request_model_copies_carry_the_contract(self, strict_provider_llm):
        """``model_overrides`` serves per-org requests from ``model_copy`` instances."""
        llm = strict_provider_llm(["done"])

        copied = llm.model_copy()
        result = await copied.ainvoke([HumanMessage(content="q"), AIMessage(content="a")])

        assert result.content == "done"

    def test_enforcement_is_idempotent(self, strict_provider_llm):
        llm = strict_provider_llm()
        before = type(llm)

        assert type(enforce_chat_request_contract(llm)) is before

    def test_enforcement_preserves_isinstance_checks(self, strict_provider_llm):
        """``cards.generate`` branches on ``isinstance(llm, BaseChatModel)``."""
        from langchain_core.language_models import BaseChatModel

        assert isinstance(strict_provider_llm(), BaseChatModel)

    def test_enforcement_does_not_advertise_streaming_a_model_lacks(self):
        """A non-streaming model must not start claiming it can stream.

        LangChain decides streaming support by comparing ``_stream``/``_astream``
        against ``BaseChatModel``'s, so defining them unconditionally on the
        contract subclass would route non-streaming models into a
        ``NotImplementedError``.
        """
        from langchain_core.language_models import BaseChatModel
        from langchain_core.outputs import ChatGeneration
        from langchain_core.outputs import ChatResult

        class NonStreamingModel(BaseChatModel):
            @property
            def _llm_type(self) -> str:
                return "non-streaming"

            def _generate(self, messages, stop=None, run_manager=None, **kwargs):
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])

        model = enforce_chat_request_contract(NonStreamingModel())

        assert type(model)._stream is BaseChatModel._stream
        assert type(model)._astream is BaseChatModel._astream

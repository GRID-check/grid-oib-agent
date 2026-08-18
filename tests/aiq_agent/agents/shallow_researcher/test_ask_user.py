"""Tests for the blocking ``ask_user`` interaction tool.

The tool stops a live turn on a future somebody else has to resolve, so the
failure modes matter more than the happy path: every one of them must return a
short instruction to answer with a stated assumption instead of hanging,
raising, or asking twice.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

from aiq_agent.agents.shallow_researcher import ask_user as ask_user_module
from aiq_agent.agents.shallow_researcher.ask_user import AskUserConfig
from aiq_agent.agents.shallow_researcher.ask_user import ask_user
from nat.data_models.interactive import HumanPromptRadio
from nat.data_models.interactive import HumanResponseRadio
from nat.data_models.interactive import HumanResponseText
from nat.data_models.interactive import InteractionResponse
from nat.data_models.interactive import MultipleChoiceOption


@pytest.fixture(autouse=True)
def _clean_guards():
    """Reset the process-wide ask_user guards between tests.

    They are keyed by conversation and turn id in production; in-process they
    would otherwise carry one test's "already asked" claim into the next.
    """
    ask_user_module._asked_turns.clear()
    ask_user_module._pending_conversations.clear()
    yield
    ask_user_module._asked_turns.clear()
    ask_user_module._pending_conversations.clear()


def _interaction_response(content) -> InteractionResponse:
    return InteractionResponse(id="i-1", timestamp="2026-08-18T10:00:00Z", content=content)


def _fake_context(prompt_user_input, *, conversation_id="conv-1", user_message_id="turn-1"):
    """A NAT context whose interaction manager is the given prompt callable."""
    manager = MagicMock()
    manager.prompt_user_input = prompt_user_input
    context = MagicMock()
    context.conversation_id = conversation_id
    context.user_message_id = user_message_id
    context.user_interaction_manager = manager
    holder = MagicMock()
    holder.get = MagicMock(return_value=context)
    return holder


async def _call(prompt_user_input=None, *, context=None, **kwargs):
    """Invoke the real tool body with a patched NAT context.

    NAT folds a multi-argument tool fn into one generated pydantic input
    model, so the call goes through `info.input_schema` — the same object the
    LLM's tool call is validated into.
    """
    async with ask_user(AskUserConfig(), MagicMock()) as info:
        payload = info.input_schema(**kwargs)
        if prompt_user_input is None and context is None:
            return await info.single_fn(payload)
        holder = context or _fake_context(prompt_user_input)
        with patch("aiq_agent.agents.shallow_researcher.ask_user.Context", holder):
            return await info.single_fn(payload)


class TestAskUserAnswers:
    """The two answer shapes a picker can produce must both come back as text."""

    @pytest.mark.asyncio
    async def test_picked_option_is_returned(self):
        """A radio answer carries no `.text`; reading it wrong feeds the LLM junk."""
        prompt_user_input = AsyncMock(
            return_value=_interaction_response(
                HumanResponseRadio(selected_option=MultipleChoiceOption(value="Castle.ifc", label="Castle.ifc"))
            )
        )

        result = await _call(
            prompt_user_input,
            question="Welches Modell meinst du?",
            options=["Castle.ifc", "Institute.ifc"],
        )

        assert "Castle.ifc" in result

    @pytest.mark.asyncio
    async def test_the_prompt_carries_the_options_as_structured_data(self):
        """Without this the client has nothing to render buttons from."""
        prompt_user_input = AsyncMock(return_value=_interaction_response(HumanResponseText(text="Castle.ifc")))

        await _call(
            prompt_user_input,
            question="Welches Modell meinst du?",
            options=["Castle.ifc", "Institute.ifc"],
        )

        prompt = prompt_user_input.await_args.args[0]
        assert isinstance(prompt, HumanPromptRadio)
        assert [option.value for option in prompt.options] == ["Castle.ifc", "Institute.ifc"]
        assert prompt.text == "Welches Modell meinst du?"

    @pytest.mark.asyncio
    async def test_free_text_answer_is_returned(self):
        """The user may type something that is not one of the options."""
        prompt_user_input = AsyncMock(
            return_value=_interaction_response(HumanResponseText(text="Das dritte, aus dem Archiv"))
        )

        result = await _call(prompt_user_input, question="Welches Modell?", options=["A.ifc", "B.ifc"])

        assert "Das dritte, aus dem Archiv" in result

    @pytest.mark.asyncio
    async def test_declining_tells_the_agent_to_assume(self):
        """ "skip"/"egal" means decide for me — the turn must still produce an answer."""
        prompt_user_input = AsyncMock(return_value=_interaction_response(HumanResponseText(text="egal")))

        result = await _call(prompt_user_input, question="Welches Modell?", options=["A.ifc", "B.ifc"])

        assert "assumption" in result
        assert "declined" in result

    @pytest.mark.asyncio
    async def test_options_may_arrive_as_a_json_string(self):
        """Weaker models stringify list arguments; that is a slip, not a mistake."""
        prompt_user_input = AsyncMock(return_value=_interaction_response(HumanResponseText(text="A.ifc")))

        result = await _call(prompt_user_input, question="Welches Modell?", options='["A.ifc", "B.ifc"]')

        assert "A.ifc" in result
        assert isinstance(prompt_user_input.await_args.args[0], HumanPromptRadio)


class TestAskUserRefusals:
    """Every refusal has to hand the agent a usable next move, never an error."""

    @pytest.mark.asyncio
    async def test_no_interaction_channel_degrades(self):
        """The real NAT default callback raises NotImplementedError.

        Entrypoints without HITL (async job runner, REST, CLI) hit this. The
        prompt would never be shown and no future would ever resolve, so the
        tool must not wait on one.
        """
        result = await _call(question="Welches Modell?", options=["A.ifc", "B.ifc"])

        assert "assumption" in result
        assert "No channel" in result

    @pytest.mark.asyncio
    async def test_timeout_degrades(self):
        """An unanswered prompt expires in the transport; the turn still answers."""
        prompt_user_input = AsyncMock(side_effect=TimeoutError)

        result = await _call(prompt_user_input, question="Welches Modell?", options=["A.ifc", "B.ifc"])

        assert "did not answer" in result
        assert "assumption" in result

    @pytest.mark.asyncio
    async def test_unexpected_failure_is_swallowed(self):
        """A raised exception inside a tool aborts a turn the user is watching."""
        prompt_user_input = AsyncMock(side_effect=RuntimeError("socket gone"))

        result = await _call(prompt_user_input, question="Welches Modell?", options=["A.ifc", "B.ifc"])

        assert "could not be delivered" in result

    @pytest.mark.asyncio
    async def test_too_few_options_is_refused(self):
        """One option is not a choice; that question belongs in the prose."""
        prompt_user_input = AsyncMock()

        result = await _call(prompt_user_input, question="Welches Modell?", options=["A.ifc"])

        assert "at least 2 options" in result
        prompt_user_input.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_too_many_options_is_refused(self):
        """A seven-way picker is not the "small, enumerable set" this is for."""
        prompt_user_input = AsyncMock()

        result = await _call(
            prompt_user_input,
            question="Welches Modell?",
            options=[f"{i}.ifc" for i in range(7)],
        )

        assert "at most 6 options" in result
        prompt_user_input.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_question_is_refused(self):
        prompt_user_input = AsyncMock()

        result = await _call(prompt_user_input, question="   ", options=["A.ifc", "B.ifc"])

        assert "empty" in result
        prompt_user_input.assert_not_awaited()


class TestAskUserPendingSlot:
    """One pending interaction per conversation is a hard transport constraint."""

    @pytest.mark.asyncio
    async def test_a_second_question_does_not_steal_the_pending_slot(self):
        """Registering a second prompt orphans the first future.

        The transport keeps ONE pending interaction per conversation and the
        second registration overwrites the first — a question another
        participant is looking at would silently stop being answerable.
        """
        released = asyncio.Event()
        first_prompt_arrived = asyncio.Event()

        async def _slow_prompt(prompt):
            first_prompt_arrived.set()
            await released.wait()
            return _interaction_response(HumanResponseText(text="A.ifc"))

        holder = _fake_context(_slow_prompt)

        async def _first():
            return await _call(context=holder, question="Erste Frage?", options=["A.ifc", "B.ifc"])

        first = asyncio.create_task(_first())
        await asyncio.wait_for(first_prompt_arrived.wait(), timeout=2)

        second = await _call(context=holder, question="Zweite Frage?", options=["C.ifc", "D.ifc"])

        assert "already waiting" in second
        assert "assumption" in second

        released.set()
        assert "A.ifc" in await asyncio.wait_for(first, timeout=2)

    @pytest.mark.asyncio
    async def test_only_one_question_per_turn(self):
        """Asking twice in one turn reads as interrogation, and the doctrine is one."""
        prompt_user_input = AsyncMock(return_value=_interaction_response(HumanResponseText(text="A.ifc")))
        holder = _fake_context(prompt_user_input, conversation_id="conv-turn", user_message_id="turn-7")

        first = await _call(context=holder, question="Welches Modell?", options=["A.ifc", "B.ifc"])
        second = await _call(context=holder, question="Und welches Geschoss?", options=["EG", "OG"])

        assert "A.ifc" in first
        assert "already asked the user once this turn" in second
        assert prompt_user_input.await_count == 1

    @pytest.mark.asyncio
    async def test_a_new_turn_may_ask_again(self):
        """The one-per-turn cap must not silence the tool for the whole conversation."""
        prompt_user_input = AsyncMock(return_value=_interaction_response(HumanResponseText(text="A.ifc")))

        first = await _call(
            context=_fake_context(prompt_user_input, conversation_id="conv-next", user_message_id="turn-1"),
            question="Welches Modell?",
            options=["A.ifc", "B.ifc"],
        )
        second = await _call(
            context=_fake_context(prompt_user_input, conversation_id="conv-next", user_message_id="turn-2"),
            question="Welches Modell?",
            options=["A.ifc", "B.ifc"],
        )

        assert "A.ifc" in first
        assert "A.ifc" in second
        assert prompt_user_input.await_count == 2

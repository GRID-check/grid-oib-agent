# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for post-hoc Grid card generation (the async-jobs / deep-research path)."""

from typing import ClassVar
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

from aiq_agent.cards.generate import _parse_cards_text
from aiq_agent.cards.generate import generate_cards

_ONE_CARD_OBJECT = '{"cards": [{"type": "summary", "title": "Überblick", "content": "Kurzfassung."}]}'


class TestParseCardsText:
    """The tolerant parser must survive the failure modes a strict json.loads can't."""

    def test_object_wrapper(self):
        assert _parse_cards_text(_ONE_CARD_OBJECT) == [
            {"type": "summary", "title": "Überblick", "content": "Kurzfassung."}
        ]

    def test_bare_array(self):
        assert _parse_cards_text('[{"type": "summary", "title": "T"}]') == [{"type": "summary", "title": "T"}]

    def test_single_object_is_wrapped(self):
        assert _parse_cards_text('{"type": "summary", "title": "T"}') == [{"type": "summary", "title": "T"}]

    def test_code_fence_wrapping(self):
        assert _parse_cards_text('```json\n' + _ONE_CARD_OBJECT + '\n```')[0]["title"] == "Überblick"

    def test_leading_and_trailing_prose_is_salvaged(self):
        """The reported failure mode: a whole-string json.loads throws on any
        prose around the JSON and loses every card. The salvage path recovers it."""
        text = "Here are the cards you asked for:\n" + _ONE_CARD_OBJECT + "\nHope that helps!"
        assert _parse_cards_text(text) == [{"type": "summary", "title": "Überblick", "content": "Kurzfassung."}]

    def test_unparseable_returns_none(self):
        assert _parse_cards_text("no json here at all") is None

    def test_empty_cards_array(self):
        assert _parse_cards_text('{"cards": []}') == []


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


class TestGenerateCards:
    """End-to-end behaviour of the best-effort card generator."""

    @pytest.mark.asyncio
    async def test_returns_none_on_missing_inputs(self):
        llm = MagicMock()
        assert await generate_cards(None, "q", "ctx") is None
        assert await generate_cards(llm, "", "ctx") is None
        assert await generate_cards(llm, "q", "") is None

    @pytest.mark.asyncio
    async def test_chat_model_gets_structured_output_binding(self):
        _BindSpyChatModel.bind_kwargs.clear()
        llm = _BindSpyChatModel(responses=[AIMessage(content=_ONE_CARD_OBJECT)])

        cards = await generate_cards(llm, "Was ist GK4?", "Ein Gebäude der Klasse 4.")

        assert cards == [{"type": "summary", "title": "Überblick", "content": "Kurzfassung."}]
        assert len(_BindSpyChatModel.bind_kwargs) == 1
        response_format = _BindSpyChatModel.bind_kwargs[0]["response_format"]
        assert response_format["type"] == "json_schema"
        # Root must be an object wrapping the card array (OpenAI structured-output rule).
        assert response_format["json_schema"]["schema"]["properties"]["cards"]["type"] == "array"

    @pytest.mark.asyncio
    async def test_structured_output_rejection_falls_back_to_plain_call(self):
        llm = _StructuredRejectingChatModel(responses=[AIMessage(content=_ONE_CARD_OBJECT)])

        cards = await generate_cards(llm, "Was ist GK4?", "Ein Gebäude der Klasse 4.")

        assert cards == [{"type": "summary", "title": "Überblick", "content": "Kurzfassung."}]

    @pytest.mark.asyncio
    async def test_prose_wrapped_response_still_yields_cards(self):
        """Regression: a non-chat LLM (no structured output) that wraps JSON in
        prose previously produced zero cards; the tolerant parser recovers them."""
        llm = MagicMock()
        llm.ainvoke = AsyncMock(
            return_value=AIMessage(content="Sure! " + _ONE_CARD_OBJECT + " Let me know if you need more.")
        )

        cards = await generate_cards(llm, "Was ist GK4?", "Ein Gebäude der Klasse 4.")

        assert cards == [{"type": "summary", "title": "Überblick", "content": "Kurzfassung."}]

    @pytest.mark.asyncio
    async def test_invalid_cards_dropped_but_valid_kept(self):
        payload = (
            '{"cards": ['
            '{"type": "summary", "title": "Gut"},'
            '{"type": "summary"}'  # missing required title → dropped by validate_cards
            "]}"
        )
        llm = MagicMock()
        llm.ainvoke = AsyncMock(return_value=AIMessage(content=payload))

        cards = await generate_cards(llm, "q", "ctx")

        assert cards == [{"type": "summary", "title": "Gut"}]

    @pytest.mark.asyncio
    async def test_llm_exception_returns_none(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock(side_effect=RuntimeError("boom"))

        assert await generate_cards(llm, "q", "ctx") is None

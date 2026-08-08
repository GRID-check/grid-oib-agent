"""Tests for ingest-only conversation context (ADR-0034 addendum).

The gap these pin down: the agent's history IS its LangGraph checkpoint, so a human
turn that never reached the agent could never be referred back to. "Always send,
never always judge" — every human message reaches the agent tagged with whether it is
addressed to it; a message that is not is ingested and answered with nothing.
"""

from __future__ import annotations

import json

import pytest

from aiq_agent.conversation_context import MAX_CONTEXT_AUTHOR_CHARS
from aiq_agent.conversation_context import MAX_CONTEXT_MESSAGE_CHARS
from aiq_agent.conversation_context import ContextOnlyMessage
from aiq_agent.conversation_context import append_conversation_context
from aiq_agent.conversation_context import format_context_turn
from aiq_agent.conversation_context import get_context_appender
from aiq_agent.conversation_context import parse_context_only_payload
from aiq_agent.conversation_context import register_context_appender


@pytest.fixture(autouse=True)
def _clear_appender():
    """The appender is a process global; never leak one test's stub into the next."""
    register_context_appender(None)
    yield
    register_context_appender(None)


def _payload(**fields) -> str:
    base = {"query": "Das Atrium ist ein eigener Abschnitt.", "data_sources": []}
    base.update(fields)
    return json.dumps(base)


class TestParseContextOnlyPayload:
    """Detection: narrow, explicit, and absent by default."""

    def test_reads_the_flag_and_the_author(self) -> None:
        parsed = parse_context_only_payload(_payload(context_only=True, author_name="Anna Weber"))

        assert parsed == ContextOnlyMessage(text="Das Atrium ist ein eigener Abschnitt.", author="Anna Weber")

    def test_an_ordinary_message_is_not_context_only(self) -> None:
        # THE compatibility guarantee in the "new backend, old client" direction:
        # absence of the field must mean "behave exactly as before it existed".
        assert parse_context_only_payload(_payload()) is None

    def test_a_falsy_or_stringy_flag_is_not_a_directive(self) -> None:
        # `is True`, not truthiness: suppressing the agent is consequential enough
        # that only the exact wire value counts.
        assert parse_context_only_payload(_payload(context_only=False)) is None
        assert parse_context_only_payload(_payload(context_only="true")) is None
        assert parse_context_only_payload(_payload(context_only=1)) is None

    def test_non_json_and_empty_payloads_read_as_ordinary(self) -> None:
        assert parse_context_only_payload("just a question") is None
        assert parse_context_only_payload("{not json}") is None
        assert parse_context_only_payload("") is None
        assert parse_context_only_payload(None) is None

    def test_a_flagged_but_empty_body_is_swallowed(self) -> None:
        # Nothing to remember and nothing to answer.
        assert parse_context_only_payload(json.dumps({"query": "   ", "context_only": True})) is None
        assert parse_context_only_payload(json.dumps({"context_only": True})) is None

    def test_the_text_alias_is_accepted(self) -> None:
        parsed = parse_context_only_payload(json.dumps({"text": "eine Bemerkung", "context_only": True}))

        assert parsed is not None
        assert parsed.text == "eine Bemerkung"

    def test_a_blank_author_name_is_dropped(self) -> None:
        parsed = parse_context_only_payload(_payload(context_only=True, author_name="   "))

        assert parsed is not None
        assert parsed.author is None


class TestFormatContextTurn:
    """Attribution and bounds."""

    def test_attributes_the_turn_to_its_author(self) -> None:
        message = ContextOnlyMessage(text="Ja, eigener Abschnitt.", author="Anna Weber")

        assert format_context_turn(message) == "Anna Weber: Ja, eigener Abschnitt."

    def test_the_verified_principal_beats_the_client_supplied_name(self) -> None:
        # A client must not be able to attribute text to a colleague inside the
        # agent's own history.
        message = ContextOnlyMessage(text="Bemerkung", author="Matthias Bigl")

        assert format_context_turn(message, author="Anna Weber") == "Anna Weber: Bemerkung"

    def test_an_unknown_author_yields_the_words_alone(self) -> None:
        # No invented narration: an unattributed turn is the human's text, nothing
        # product-authored dressed up as a user message.
        assert format_context_turn(ContextOnlyMessage(text="Bemerkung")) == "Bemerkung"

    def test_an_oversized_body_is_truncated(self) -> None:
        message = ContextOnlyMessage(text="x" * (MAX_CONTEXT_MESSAGE_CHARS * 3), author="Anna")

        rendered = format_context_turn(message)

        assert len(rendered) == len("Anna: ") + MAX_CONTEXT_MESSAGE_CHARS
        assert rendered.startswith("Anna: xxx")

    def test_truncation_prefers_a_line_boundary(self) -> None:
        body = "erste Zeile\n" + "y" * (MAX_CONTEXT_MESSAGE_CHARS * 2)

        rendered = format_context_turn(ContextOnlyMessage(text=body))

        assert rendered == "erste Zeile"

    def test_an_oversized_author_name_is_truncated(self) -> None:
        message = ContextOnlyMessage(text="kurz", author="A" * (MAX_CONTEXT_AUTHOR_CHARS * 2))

        rendered = format_context_turn(message)

        assert rendered == "A" * MAX_CONTEXT_AUTHOR_CHARS + ": kurz"


class TestAppendConversationContext:
    """The indirection the socket tier uses, and its fail-soft contract."""

    @pytest.mark.asyncio
    async def test_appends_through_the_registered_appender(self) -> None:
        seen: list[tuple[str, str]] = []

        async def appender(thread_id: str, text: str) -> None:
            seen.append((thread_id, text))

        register_context_appender(appender)
        assert get_context_appender() is appender

        assert await append_conversation_context("conv-1", "Anna: ja") is True
        assert seen == [("conv-1", "Anna: ja")]

    @pytest.mark.asyncio
    async def test_no_registered_appender_is_a_logged_no_op(self) -> None:
        # The human's message is already in Postgres; a missing appender costs the
        # agent a line of memory and must not raise into the socket handler.
        assert await append_conversation_context("conv-1", "Anna: ja") is False

    @pytest.mark.asyncio
    async def test_an_appender_that_raises_never_propagates(self) -> None:
        async def boom(_thread_id: str, _text: str) -> None:
            raise RuntimeError("checkpointer down")

        register_context_appender(boom)

        assert await append_conversation_context("conv-1", "Anna: ja") is False

    @pytest.mark.asyncio
    async def test_missing_thread_or_text_is_refused_without_calling_out(self) -> None:
        calls: list[tuple[str, str]] = []

        async def appender(thread_id: str, text: str) -> None:
            calls.append((thread_id, text))

        register_context_appender(appender)

        assert await append_conversation_context(None, "Anna: ja") is False
        assert await append_conversation_context("conv-1", "") is False
        assert calls == []

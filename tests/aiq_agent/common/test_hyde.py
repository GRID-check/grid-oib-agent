"""Tests for aiq_agent.common.hyde — the HyDE-as-channel experiment (backlog item 14).

The contract under test: the channel fires ONLY for queries with no exact
identifier SHAPE (never vocabulary), the draft prompt carries no entities,
and every draft failure reads as "no draft" (fail-open to the baseline).
"""

import asyncio
from types import SimpleNamespace

import pytest

from aiq_agent.common.hyde import HYDE_MAX_DRAFT_CHARS
from aiq_agent.common.hyde import build_draft_messages
from aiq_agent.common.hyde import draft_passage
from aiq_agent.common.hyde import has_exact_identifier
from aiq_agent.common.hyde import should_draft


class _FakeLLM:
    """Recording chat-model double: canned reply, optional delay or error."""

    def __init__(self, reply: str = "", delay: float = 0.0, error: Exception | None = None) -> None:
        self.reply = reply
        self.delay = delay
        self.error = error
        self.calls: list[list[tuple[str, str]]] = []

    async def ainvoke(self, messages):
        self.calls.append(messages)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(content=self.reply)


class TestHasExactIdentifier:
    @pytest.mark.parametrize(
        "query",
        [
            "Was sagt § 3 zur Bauweise?",  # paragraph reference
            "§5.1.1 OIB-RL 2 Gehweglänge",  # attached paragraph reference
            "Was fordert OIB-Richtlinie 2?",  # Richtlinie reference
            'Suche nach "Fluchtweg Breite" im Dokument',  # quoted span
            "Der Begriff „Mindestabstand“ ist definiert",  # German quotes
            "Was ist die OIB?",  # ALLCAPS code
            "was weißt du über die oib 2",  # casefold identifier (item 13)
            "oib-rl_2_ausgabe_mai_2023.pdf",  # filename
            "siehe Anhang bericht.pdf Seite 3",  # generic filename shape
            "Punkt 5.1.1 Gehweglänge",  # bare dotted number
            "Wie breit? Mindestens 1,20 m",  # dimension digits
            "Was bedeutet Gebäudeklasse 4 für mein Haus?",  # name-number shape
            "Was gilt seit Ausgabe 2023?",  # bare year
            "",  # blank drafts nothing
            "   ",
        ],
    )
    def test_identifier_shapes_never_draft(self, query: str) -> None:
        assert has_exact_identifier(query) is True
        assert should_draft(query, enabled=True) is False

    @pytest.mark.parametrize(
        "query",
        [
            "was weißt du über die oib-richtlinien",
            "welche oib-richtlinien gibt es für wohngebäude",
            "was steht in den begriffsbestimmungen",
            "Begriffsbestimmungen Gebäudeklasse",
            "Brandschutz im Wohnhaus — was gilt?",
            "Wie breit muss ein Fluchtweg mindestens sein?",
            "Brauche ich einen zweiten Fluchtweg aus meiner Wohnung?",
        ],
    )
    def test_vague_queries_carry_no_identifier_shape(self, query: str) -> None:
        assert has_exact_identifier(query) is False
        assert should_draft(query, enabled=True) is True

    def test_bare_paragraph_glyph_still_gates_out(self) -> None:
        # No number, so no exact term — but the glyph alone already marks
        # identifier intent by shape, and drafting beside it is pure noise.
        assert has_exact_identifier("Das § Symbol allein") is True


class TestShouldDraft:
    def test_disabled_switch_never_drafts(self) -> None:
        assert should_draft("was weißt du über die oib-richtlinien", enabled=False) is False

    def test_disabled_switch_never_drafts_even_for_vague_queries(self) -> None:
        assert should_draft("Brandschutz im Wohnhaus — was gilt?", enabled=False) is False


class TestDraftPromptHygiene:
    """The prompt states the register, never the entities: no word lists, no
    examples that could steer the draft toward (or away from) a designation."""

    def test_prompt_has_no_identifier_shape(self) -> None:
        import re

        messages = build_draft_messages("was weißt du über die oib-richtlinien")
        assert [role for role, _ in messages] == ["system", "user"]
        system = messages[0][1]
        assert "§" not in system
        assert re.search(r"\d", system) is None
        assert ".pdf" not in system
        assert '"' not in system and "„" not in system

    def test_prompt_states_register_and_cap(self) -> None:
        system = build_draft_messages("frage")[0][1]
        assert "zweihundert" in system
        assert "Muss-Anforderungen" in system

    def test_user_turn_is_the_verbatim_query(self) -> None:
        assert build_draft_messages("frage")[1] == ("user", "frage")


class TestDraftPassage:
    async def test_no_model_means_no_draft(self) -> None:
        assert await draft_passage(None, "was weißt du über die oib-richtlinien") is None

    async def test_blank_query_means_no_draft_and_no_call(self) -> None:
        llm = _FakeLLM(reply="text")
        assert await draft_passage(llm, "   ") is None
        assert llm.calls == []

    async def test_success_returns_stripped_text(self) -> None:
        llm = _FakeLLM(reply="  Die Anforderung muss erfüllt sein.  ")
        assert await draft_passage(llm, "frage") == "Die Anforderung muss erfüllt sein."
        assert len(llm.calls) == 1

    async def test_empty_reply_is_no_draft(self) -> None:
        assert await draft_passage(_FakeLLM(reply="   "), "frage") is None

    async def test_model_error_is_no_draft(self) -> None:
        llm = _FakeLLM(error=RuntimeError("provider down"))
        assert await draft_passage(llm, "frage") is None

    async def test_slow_model_is_no_draft(self) -> None:
        llm = _FakeLLM(reply="zu spät", delay=5.0)
        assert await draft_passage(llm, "frage", timeout_seconds=0.05) is None

    async def test_long_reply_is_truncated_to_the_cap(self) -> None:
        llm = _FakeLLM(reply="x" * (HYDE_MAX_DRAFT_CHARS + 500))
        draft = await draft_passage(llm, "frage")
        assert draft is not None
        assert len(draft) <= HYDE_MAX_DRAFT_CHARS

"""Tests for parsing what one user message states about how to answer it."""

from unittest.mock import MagicMock

from aiq_agent.turn.payload import _extract_query_and_sources
from aiq_agent.turn.payload import _extract_query_from_text
from aiq_agent.turn.payload import _extract_text_from_message
from aiq_agent.turn.payload import extract_turn_inputs


class TestExtractTextFromMessage:
    """Tests for _extract_text_from_message."""

    def test_extract_from_string(self):
        """Test extracting text from a plain string."""
        assert _extract_text_from_message("Hello world") == "Hello world"

    def test_extract_from_none(self):
        """Test that None returns None."""
        assert _extract_text_from_message(None) is None

    def test_extract_from_object_content(self):
        """Test extracting text from object content attribute."""
        obj = MagicMock()
        obj.content = "Content from attribute"
        assert _extract_text_from_message(obj) == "Content from attribute"

    def test_extract_from_multipart_list(self):
        """Test extracting text from multipart list."""
        obj = MagicMock()
        part1 = MagicMock()
        part1.type = "text"
        part1.text = "First part"
        part2 = MagicMock()
        part2.type = "text"
        part2.text = "Second part"
        obj.content = [part1, part2]
        result = _extract_text_from_message(obj)
        assert result == "First part\nSecond part"

    def test_extract_from_dict_message(self):
        """Test extracting text from dict message."""
        message = {"content": [{"type": "text", "text": "Hello"}]}
        assert _extract_text_from_message(message) == "Hello"


class TestExtractQueryFromText:
    """Tests for _extract_query_from_text."""

    def test_extract_simple_text(self):
        """Test extracting from plain text."""
        query, sources, skills, _intent = _extract_query_from_text("What is CUDA?")
        assert query == "What is CUDA?"
        assert sources is None
        assert skills is None

    def test_extract_empty_text(self):
        """Test extracting from empty string."""
        query, sources, skills, _intent = _extract_query_from_text("")
        assert query == ""
        assert sources is None
        assert skills is None

    def test_extract_json_payload(self):
        """Test extracting from JSON payload."""
        text = '{"query": "Test query", "data_sources": ["web_search"]}'
        query, sources, skills, _intent = _extract_query_from_text(text)
        assert query == "Test query"
        assert sources == ["web_search"]
        assert skills is None

    def test_the_parser_returns_the_intent_and_sets_nothing(self):
        """A parser with a side effect hid a failure to set the turn's focus
        behind ``except Exception: pass``, so the previous turn's subject
        leaked into the next. The intent is now a return value."""
        from aiq_agent.common.focus_file import get_focused_file_name
        from aiq_agent.common.focus_file import set_turn_intent

        set_turn_intent(file_name="Vorher.pdf")
        try:
            parsed = _extract_query_from_text(
                '{"query": "Fass zusammen", "focus_file_name": "Protokoll.pdf", "focus_shelf": "session"}'
            )
            assert parsed.query_text == "Fass zusammen"
            assert parsed.intent.file_name == "Protokoll.pdf"
            assert parsed.intent.shelf == "session"
            assert get_focused_file_name() == "Vorher.pdf", "parsing must not touch the ContextVars"
        finally:
            set_turn_intent()

    def test_extract_json_payload_maps_source_preset(self):
        parsed = _extract_query_from_text('{"query": "Was gilt?", "source_preset": "law"}')
        assert parsed.query_text == "Was gilt?"
        assert parsed.intent.source_preset == "law"

    def test_extract_json_payload_ignores_client_include_shelves(self):
        parsed = _extract_query_from_text('{"query": "x", "focus_file_name": "a.pdf", "include_shelves": ["archiv"]}')
        assert parsed.intent.file_name == "a.pdf"
        assert parsed.intent.shelf is None

    def test_extract_json_payload_with_skills(self):
        """Test extracting forced skills from a JSON payload."""
        text = '{"query": "Analyse", "skills": ["forecast-analysis", "data-table-analysis"]}'
        query, _, skills, _intent = _extract_query_from_text(text)
        assert query == "Analyse"
        assert skills == ["forecast-analysis", "data-table-analysis"]

    def test_extract_invalid_json(self):
        """Test invalid JSON returns original text."""
        text = '{"invalid json'
        query, sources, skills, _intent = _extract_query_from_text(text)
        assert query == text
        assert sources is None
        assert skills is None


class TestExtractQueryAndSources:
    """Tests for _extract_query_and_sources."""

    def test_extract_from_dict_payload(self):
        """Test extracting from dict payload."""
        payload = {
            "content": {
                "messages": [{"role": "user", "content": "Query text"}],
                "data_sources": ["confluence"],
            }
        }
        query, sources, skills, _intent = _extract_query_and_sources(payload)
        assert query == "Query text"
        assert sources == ["confluence"]
        assert skills is None

    def test_extract_from_object_payload(self):
        """Test extracting from object payload with messages."""
        user_msg = MagicMock()
        user_msg.role = "user"
        user_msg.content = "Object query"
        payload = MagicMock()
        payload.messages = [user_msg]
        payload.data_sources = None
        payload.skills = None
        query, sources, skills, _intent = _extract_query_and_sources(payload)
        assert query == "Object query"
        assert sources is None
        assert skills is None

    def test_extract_from_string_payload(self):
        """Test extracting from string payload."""
        query, sources, skills, _intent = _extract_query_and_sources("Plain query string")
        assert query == "Plain query string"
        assert sources is None
        assert skills is None

    def test_explicit_empty_data_sources_preserved(self):
        """An explicit [] ("no data-source tools") must not fall back to None."""
        payload = {
            "data_sources": [],
            "content": {"messages": [{"role": "user", "content": "Query text"}]},
        }
        query, sources, skills, _intent = _extract_query_and_sources(payload)
        assert query == "Query text"
        # [] must survive: `or`-chaining would overwrite it with None ("all tools").
        assert sources == []
        assert skills is None

    def test_top_level_empty_not_overwritten_by_content_sources(self):
        """A top-level [] wins over content-level sources (both explicit)."""
        payload = {
            "data_sources": [],
            "content": {
                "messages": [{"role": "user", "content": "Query text"}],
                "data_sources": ["confluence"],
            },
        }
        _query, sources, _skills, _intent = _extract_query_and_sources(payload)
        assert sources == []

    def test_forced_skills_extracted_top_level(self):
        """The WS content JSON's `skills` array is extracted at the top level."""
        payload = {
            "skills": ["forecast-analysis"],
            "content": {"messages": [{"role": "user", "content": "Prognose für Krankenhaus?"}]},
        }
        query, _sources, skills, _intent = _extract_query_and_sources(payload)
        assert query == "Prognose für Krankenhaus?"
        assert skills == ["forecast-analysis"]

    def test_forced_skills_content_level_when_top_level_absent(self):
        """`skills` inside `content` is the fallback location."""
        payload = {
            "content": {
                "messages": [{"role": "user", "content": "Berechnung"}],
                "skills": ["lightweight-calculation"],
            }
        }
        query, _sources, skills, _intent = _extract_query_and_sources(payload)
        assert query == "Berechnung"
        assert skills == ["lightweight-calculation"]

    def test_top_level_empty_skills_not_overwritten_by_content_skills(self):
        """An explicit top-level [] wins over content-level skills."""
        payload = {
            "skills": [],
            "content": {
                "messages": [{"role": "user", "content": "Query text"}],
                "skills": ["lightweight-calculation"],
            },
        }
        _query, _sources, skills, _intent = _extract_query_and_sources(payload)
        assert skills == []

    def test_forced_skills_from_inline_json(self):
        """Inline JSON inside the user message also carries the skills array."""
        payload = {
            "content": {
                "messages": [{"role": "user", "content": '{"query": "Analyse", "skills": ["data-table-analysis"]}'}]
            }
        }
        query, _sources, skills, _intent = _extract_query_and_sources(payload)
        assert query == "Analyse"
        assert skills == ["data-table-analysis"]

    def test_malformed_skills_content_cleaned(self):
        """Non-name junk in the skills array is stringified (mirroring
        parse_data_sources); unknown names are resolved away downstream by the
        reminder runtime (never an error)."""
        payload = {
            "skills": ["forecast-analysis", 42, None, " "],
            "content": {"messages": [{"role": "user", "content": "Query"}]},
        }
        query, _sources, skills, _intent = _extract_query_and_sources(payload)
        assert query == "Query"
        assert skills == ["forecast-analysis", "42", "None"]


class TestExtractTurnInputs:
    """The wire → state lift.

    Retrieval reads the turn focus from ContextVars that the query parse is
    what sets. Reading them was previously a separate step in the register
    layer, ordered only by a comment, and nothing in the suite noticed when it
    was removed entirely — so the one seam that makes the composer subject
    reachable in production was the one seam with no test.
    """

    def test_lifts_the_focus_the_parse_just_set(self):
        from aiq_agent.turn.payload import extract_turn_inputs

        text = '{"query": "fass zusammen", "focus_file_name": "Aufsicht.pdf", "focus_shelf": "project"}'
        inputs = extract_turn_inputs(text)

        assert inputs.query_text == "fass zusammen"
        assert inputs.focus_file_name == "Aufsicht.pdf"
        assert inputs.focus_shelf == "project"

    def test_lifts_it_from_a_nested_chat_payload(self):
        from aiq_agent.turn.payload import extract_turn_inputs

        text = '{"query": "was steht drin", "focus_file_name": "Protokoll.pdf", "focus_shelf": "session"}'
        inputs = extract_turn_inputs(
            {"content": {"messages": [{"role": "user", "content": [{"type": "text", "text": text}]}]}}
        )

        assert inputs.query_text == "was steht drin"
        assert inputs.focus_file_name == "Protokoll.pdf"
        assert inputs.focus_shelf == "session"

    def test_a_turn_without_a_subject_clears_the_previous_one(self):
        """The vars outlive one turn; a plain message must not inherit a subject."""
        from aiq_agent.turn.payload import extract_turn_inputs

        extract_turn_inputs('{"query": "fass zusammen", "focus_file_name": "Aufsicht.pdf"}')
        inputs = extract_turn_inputs('{"query": "welche OIB-Richtlinien gelten in Wien?"}')

        assert inputs.focus_file_name is None
        assert inputs.focus_shelf is None

    def test_an_unparseable_shelf_is_dropped_not_forwarded(self):
        from aiq_agent.turn.payload import extract_turn_inputs

        inputs = extract_turn_inputs('{"query": "x", "focus_file_name": "a.pdf", "focus_shelf": "buero"}')

        assert inputs.focus_file_name == "a.pdf"
        assert inputs.focus_shelf is None

    def test_data_sources_and_skills_still_come_through(self):
        from aiq_agent.turn.payload import extract_turn_inputs

        inputs = extract_turn_inputs('{"query": "x", "data_sources": ["web_search"], "skills": ["oib"]}')

        assert inputs.data_sources == ["web_search"]
        assert inputs.force_skills == ["oib"]

    def test_the_intent_is_set_for_retrieval_by_the_lift(self):
        from aiq_agent.common.focus_file import get_focused_file_name
        from aiq_agent.common.focus_file import get_turn_shelves
        from aiq_agent.common.focus_file import set_turn_intent
        from aiq_agent.turn.payload import extract_turn_inputs

        try:
            extract_turn_inputs(
                '{"query": "Fass zusammen", "focus_file_name": "Protokoll.pdf", "focus_shelf": "session"}'
            )
            assert get_focused_file_name() == "Protokoll.pdf"
            # `base` rides along with every subject shelf — a subject narrows
            # which documents the turn reads, not whether the law applies.
            assert get_turn_shelves() == frozenset({"session", "base"})
            extract_turn_inputs('{"query": "Was gilt?", "source_preset": "law"}')
            assert get_turn_shelves() == frozenset({"base"})
        finally:
            set_turn_intent()

    def test_a_failure_to_set_the_focus_raises_instead_of_leaking_the_last_turn(self, monkeypatch):
        """The bug: ``except Exception: pass`` around ``set_turn_intent`` let a
        turn run with the PREVIOUS turn's subject. Now it fails loudly."""
        import pytest

        from aiq_agent.turn import payload as payload_module

        def broken(**_kw):
            raise RuntimeError("focus store gone")

        monkeypatch.setattr(payload_module, "set_turn_intent", broken)
        with pytest.raises(RuntimeError, match="focus store gone"):
            payload_module.extract_turn_inputs('{"query": "x", "focus_file_name": "a.pdf"}')


class TestTheSubjectVersion:
    """What the composer says about the subject's OPEN version, and only that."""

    def test_it_travels_beside_the_focus_file_name(self):
        parsed = _extract_query_from_text(
            '{"query": "warum GK 4?", "focus_file_name": "Befund.md", "focus_shelf": "project",'
            ' "focus_document_id": "doc-9", "focus_version_id": "ver-9", "focus_version_state": "draft"}'
        )
        assert parsed.intent.subject.document_id == "doc-9"
        assert parsed.intent.subject.version_id == "ver-9"
        assert parsed.intent.subject.state == "draft"
        assert parsed.intent.subject.is_open

    def test_a_published_subject_is_not_open(self):
        parsed = _extract_query_from_text(
            '{"query": "x", "focus_document_id": "doc-9", "focus_version_id": "ver-9",'
            ' "focus_version_state": "published"}'
        )
        # Nothing to do: a published version has chunks and the focus filter works.
        assert not parsed.intent.subject.is_open

    def test_an_ordinary_message_names_no_subject_version(self):
        parsed = _extract_query_from_text("Wie lang darf ein Fluchtweg sein?")
        assert parsed.intent.subject.document_id is None
        assert not parsed.intent.subject.is_open

    def test_blank_and_non_string_fields_are_not_a_subject(self):
        parsed = _extract_query_from_text(
            '{"query": "x", "focus_document_id": "  ", "focus_version_id": 7, "focus_version_state": "draft"}'
        )
        assert parsed.intent.subject.document_id is None
        assert parsed.intent.subject.version_id is None
        assert not parsed.intent.subject.is_open

    def test_a_state_the_lifecycle_does_not_have_is_not_open(self):
        # The open set is mirrored from `OPEN_DOCUMENT_VERSION_STATES`; anything
        # else is left to retrieval, which is the behaviour that already works.
        parsed = _extract_query_from_text(
            '{"query": "x", "focus_document_id": "d", "focus_version_id": "v", "focus_version_state": "invented"}'
        )
        assert not parsed.intent.subject.is_open

    def test_it_reaches_the_turn_inputs(self):
        inputs = extract_turn_inputs(
            '{"query": "warum GK 4?", "focus_document_id": "doc-9", "focus_version_id": "ver-9",'
            ' "focus_version_state": "in_review"}'
        )
        assert inputs.subject.is_open
        assert inputs.subject.version_id == "ver-9"

    def test_a_plain_turn_does_not_inherit_the_previous_ones_subject(self):
        extract_turn_inputs(
            '{"query": "a", "focus_document_id": "doc-9", "focus_version_id": "ver-9", "focus_version_state": "draft"}'
        )
        assert not extract_turn_inputs("und jetzt?").subject.is_open

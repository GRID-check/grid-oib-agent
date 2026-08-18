"""Tests for chat researcher utilities."""

from unittest.mock import MagicMock

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from aiq_agent.agents.chat_researcher.utils import _count_message_tokens
from aiq_agent.agents.chat_researcher.utils import _extract_query_and_sources
from aiq_agent.agents.chat_researcher.utils import _extract_query_from_text
from aiq_agent.agents.chat_researcher.utils import _extract_text_from_message
from aiq_agent.agents.chat_researcher.utils import trim_message_history


class TestTrimMessageHistory:
    """Tests for the trim_message_history function."""

    def test_trim_message_history_basic(self):
        """Test basic message trimming."""
        messages = [
            HumanMessage(content="Hello"),
            AIMessage(content="Hi there!"),
            HumanMessage(content="How are you?"),
            AIMessage(content="I'm doing well!"),
        ]

        result = trim_message_history(messages, max_tokens=10)

        # Should keep messages within token limit
        assert isinstance(result, list)

    def test_trim_message_history_empty(self):
        """Test trimming empty message list."""
        messages = []
        result = trim_message_history(messages, max_tokens=10)
        assert result == []

    def test_trim_message_history_single_message(self):
        """Test trimming with single message."""
        messages = [HumanMessage(content="Hello")]
        result = trim_message_history(messages, max_tokens=10)
        assert len(result) >= 0  # May be empty if message exceeds limit

    def test_trim_message_history_with_system_message(self):
        """Test trimming includes system messages."""
        messages = [
            SystemMessage(content="You are a helpful assistant."),
            HumanMessage(content="Hello"),
            AIMessage(content="Hi!"),
        ]

        result = trim_message_history(messages, max_tokens=20)

        # System messages should be preserved according to include_system=True
        assert isinstance(result, list)

    def test_trim_message_history_large_limit(self):
        """Test trimming with large token limit keeps all messages."""
        messages = [
            HumanMessage(content="A"),
            AIMessage(content="B"),
            HumanMessage(content="C"),
        ]

        result = trim_message_history(messages, max_tokens=1000)

        # With a large limit, should keep messages
        assert isinstance(result, list)

    def test_trim_message_history_strategy_last(self):
        """Test that trimming uses 'last' strategy (keeps recent messages)."""
        messages = [
            HumanMessage(content="First message"),
            AIMessage(content="Response 1"),
            HumanMessage(content="Second message"),
            AIMessage(content="Response 2"),
            HumanMessage(content="Third message"),
        ]

        result = trim_message_history(messages, max_tokens=5)

        # Strategy 'last' should prioritize recent messages
        assert isinstance(result, list)

    def test_counts_tokens_not_message_count(self):
        """The budget is tokens: one huge message can exceed a budget that many
        tiny messages fit under — the old token_counter=len could not tell them
        apart."""
        tiny = [HumanMessage(content="hi"), AIMessage(content="ok"), HumanMessage(content="yo")]
        huge = [HumanMessage(content="word " * 500)]
        assert _count_message_tokens(huge) > _count_message_tokens(tiny)

    def test_token_budget_drops_oversized_history(self):
        """With a real token counter, an oversized older turn is trimmed while a
        small recent turn within budget is kept."""
        messages = [
            HumanMessage(content="word " * 2000),  # very large, older
            AIMessage(content="big answer " * 2000),
            HumanMessage(content="short recent question"),
        ]
        result = trim_message_history(messages, max_tokens=200)
        # Budget is real tokens now, so the giant early turns cannot all survive.
        assert len(result) < len(messages)

    def test_injected_counter_is_used(self):
        """token_counter is injectable; passing len reproduces message-count
        semantics (used to prove the default differs from len)."""
        messages = [HumanMessage(content="a" * 10_000), AIMessage(content="b" * 10_000)]
        # Under len-counting, both messages count as 2 tokens total -> both kept.
        result = trim_message_history(messages, max_tokens=2, token_counter=len)
        assert len(result) == 2


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
        query, sources, skills = _extract_query_from_text("What is CUDA?")
        assert query == "What is CUDA?"
        assert sources is None
        assert skills is None

    def test_extract_empty_text(self):
        """Test extracting from empty string."""
        query, sources, skills = _extract_query_from_text("")
        assert query == ""
        assert sources is None
        assert skills is None

    def test_extract_json_payload(self):
        """Test extracting from JSON payload."""
        text = '{"query": "Test query", "data_sources": ["web_search"]}'
        query, sources, skills = _extract_query_from_text(text)
        assert query == "Test query"
        assert sources == ["web_search"]
        assert skills is None

    def test_extract_json_payload_sets_focus_from_intent(self):
        from aiq_agent.common.focus_file import get_focused_file_name
        from aiq_agent.common.focus_file import get_turn_shelves
        from aiq_agent.common.focus_file import set_turn_intent

        text = '{"query": "Fass zusammen", "focus_file_name": "Protokoll.pdf", "focus_shelf": "session"}'
        try:
            query, _sources, _skills = _extract_query_from_text(text)
            assert query == "Fass zusammen"
            assert get_focused_file_name() == "Protokoll.pdf"
            assert get_turn_shelves() == frozenset({"session"})
        finally:
            set_turn_intent()

    def test_extract_json_payload_maps_source_preset(self):
        from aiq_agent.common.focus_file import get_turn_shelves
        from aiq_agent.common.focus_file import set_turn_intent

        text = '{"query": "Was gilt?", "source_preset": "law"}'
        try:
            query, _sources, _skills = _extract_query_from_text(text)
            assert query == "Was gilt?"
            assert get_turn_shelves() == frozenset({"base"})
        finally:
            set_turn_intent()

    def test_extract_json_payload_ignores_client_include_shelves(self):
        from aiq_agent.common.focus_file import get_turn_shelves
        from aiq_agent.common.focus_file import set_turn_intent

        text = '{"query": "Fass zusammen", "focus_file_name": "a.pdf", "include_shelves": ["archiv", "base"]}'
        try:
            _extract_query_from_text(text)
            assert get_turn_shelves() is None
        finally:
            set_turn_intent()

    def test_extract_json_payload_with_skills(self):
        """Test extracting forced skills from a JSON payload."""
        text = '{"query": "Analyse", "skills": ["forecast-analysis", "data-table-analysis"]}'
        query, _, skills = _extract_query_from_text(text)
        assert query == "Analyse"
        assert skills == ["forecast-analysis", "data-table-analysis"]

    def test_extract_invalid_json(self):
        """Test invalid JSON returns original text."""
        text = '{"invalid json'
        query, sources, skills = _extract_query_from_text(text)
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
        query, sources, skills = _extract_query_and_sources(payload)
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
        query, sources, skills = _extract_query_and_sources(payload)
        assert query == "Object query"
        assert sources is None
        assert skills is None

    def test_extract_from_string_payload(self):
        """Test extracting from string payload."""
        query, sources, skills = _extract_query_and_sources("Plain query string")
        assert query == "Plain query string"
        assert sources is None
        assert skills is None

    def test_explicit_empty_data_sources_preserved(self):
        """An explicit [] ("no data-source tools") must not fall back to None."""
        payload = {
            "data_sources": [],
            "content": {"messages": [{"role": "user", "content": "Query text"}]},
        }
        query, sources, skills = _extract_query_and_sources(payload)
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
        _query, sources, _skills = _extract_query_and_sources(payload)
        assert sources == []

    def test_forced_skills_extracted_top_level(self):
        """The WS content JSON's `skills` array is extracted at the top level."""
        payload = {
            "skills": ["forecast-analysis"],
            "content": {"messages": [{"role": "user", "content": "Prognose für Krankenhaus?"}]},
        }
        query, _sources, skills = _extract_query_and_sources(payload)
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
        query, _sources, skills = _extract_query_and_sources(payload)
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
        _query, _sources, skills = _extract_query_and_sources(payload)
        assert skills == []

    def test_forced_skills_from_inline_json(self):
        """Inline JSON inside the user message also carries the skills array."""
        payload = {
            "content": {
                "messages": [{"role": "user", "content": '{"query": "Analyse", "skills": ["data-table-analysis"]}'}]
            }
        }
        query, _sources, skills = _extract_query_and_sources(payload)
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
        query, _sources, skills = _extract_query_and_sources(payload)
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
        from aiq_agent.agents.chat_researcher.utils import extract_turn_inputs

        text = '{"query": "fass zusammen", "focus_file_name": "Aufsicht.pdf", "focus_shelf": "project"}'
        inputs = extract_turn_inputs(text)

        assert inputs.query_text == "fass zusammen"
        assert inputs.focus_file_name == "Aufsicht.pdf"
        assert inputs.focus_shelf == "project"

    def test_lifts_it_from_a_nested_chat_payload(self):
        from aiq_agent.agents.chat_researcher.utils import extract_turn_inputs

        text = '{"query": "was steht drin", "focus_file_name": "Protokoll.pdf", "focus_shelf": "session"}'
        inputs = extract_turn_inputs(
            {"content": {"messages": [{"role": "user", "content": [{"type": "text", "text": text}]}]}}
        )

        assert inputs.query_text == "was steht drin"
        assert inputs.focus_file_name == "Protokoll.pdf"
        assert inputs.focus_shelf == "session"

    def test_a_turn_without_a_subject_clears_the_previous_one(self):
        """The vars outlive one turn; a plain message must not inherit a subject."""
        from aiq_agent.agents.chat_researcher.utils import extract_turn_inputs

        extract_turn_inputs('{"query": "fass zusammen", "focus_file_name": "Aufsicht.pdf"}')
        inputs = extract_turn_inputs('{"query": "welche OIB-Richtlinien gelten in Wien?"}')

        assert inputs.focus_file_name is None
        assert inputs.focus_shelf is None

    def test_an_unparseable_shelf_is_dropped_not_forwarded(self):
        from aiq_agent.agents.chat_researcher.utils import extract_turn_inputs

        inputs = extract_turn_inputs('{"query": "x", "focus_file_name": "a.pdf", "focus_shelf": "buero"}')

        assert inputs.focus_file_name == "a.pdf"
        assert inputs.focus_shelf is None

    def test_data_sources_and_skills_still_come_through(self):
        from aiq_agent.agents.chat_researcher.utils import extract_turn_inputs

        inputs = extract_turn_inputs('{"query": "x", "data_sources": ["web_search"], "skills": ["oib"]}')

        assert inputs.data_sources == ["web_search"]
        assert inputs.force_skills == ["oib"]

"""Tests for chat_researcher register.py helper functions."""

import asyncio
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.register import _aggregate_documents_across_collections
from aiq_agent.agents.chat_researcher.register import _fold_chunks_to_response
from aiq_agent.agents.chat_researcher.register import _iter_answer_deltas
from aiq_agent.agents.chat_researcher.register import _reflection_answer_is_substantive
from aiq_agent.agents.chat_researcher.register import _response_to_chunks
from aiq_agent.agents.chat_researcher.utils import _extract_query_and_sources
from aiq_agent.agents.chat_researcher.utils import _extract_query_from_text
from aiq_agent.agents.chat_researcher.utils import _extract_text_from_message
from aiq_agent.common import _create_chat_response


class _Doc:
    """Minimal stand-in for a document summary (only file_name is used)."""

    def __init__(self, file_name):
        self.file_name = file_name

    def __eq__(self, other):
        return isinstance(other, _Doc) and other.file_name == self.file_name

    def __hash__(self):
        return hash(self.file_name)

    def __repr__(self):
        return f"_Doc({self.file_name!r})"


def _sequential_reference(collections, per_collection):
    """The old sequential loop, kept as an oracle for the concurrent version."""
    aggregated = []
    seen = set()
    for coll in collections:
        docs = per_collection.get(coll)
        if docs is None:  # a raising collection contributed nothing
            continue
        for doc in docs:
            if doc.file_name in seen:
                continue
            seen.add(doc.file_name)
            aggregated.append(doc)
    return aggregated


class TestAggregateDocumentsAcrossCollections:
    """The concurrent per-collection loader must return the SAME merged data as
    the old sequential loop: same order, same dedup, same per-collection
    fail-open behavior — only the round-trips now overlap."""

    def _run(self, collections, per_collection):
        """Drive the concurrent helper against a mock async fetch_one."""
        call_order = []

        async def fetch_one(coll):
            call_order.append(coll)
            # Yield control so collections genuinely interleave (proves the
            # merge does not depend on completion order).
            await asyncio.sleep(0)
            docs = per_collection.get(coll)
            if docs is None:
                raise RuntimeError(f"no summaries for {coll}")
            return list(docs)

        result = asyncio.run(_aggregate_documents_across_collections(collections, fetch_one))
        return result, call_order

    def test_matches_sequential_merge_order(self):
        collections = ["base", "session"]
        per_collection = {
            "base": [_Doc("a.pdf"), _Doc("b.pdf")],
            "session": [_Doc("c.pdf")],
        }
        result, _ = self._run(collections, per_collection)
        assert result == _sequential_reference(collections, per_collection)
        assert [d.file_name for d in result] == ["a.pdf", "b.pdf", "c.pdf"]

    def test_dedup_first_seen_wins_across_collections(self):
        collections = ["base", "session"]
        per_collection = {
            "base": [_Doc("dup.pdf"), _Doc("a.pdf")],
            "session": [_Doc("dup.pdf"), _Doc("b.pdf")],
        }
        result, _ = self._run(collections, per_collection)
        assert result == _sequential_reference(collections, per_collection)
        assert [d.file_name for d in result] == ["dup.pdf", "a.pdf", "b.pdf"]

    def test_dedup_within_a_single_collection(self):
        collections = ["base"]
        per_collection = {"base": [_Doc("x.pdf"), _Doc("x.pdf"), _Doc("y.pdf")]}
        result, _ = self._run(collections, per_collection)
        assert [d.file_name for d in result] == ["x.pdf", "y.pdf"]

    def test_one_collection_failing_still_merges_the_rest(self):
        # Fail-open per collection: the raising one yields empty, not a wipeout.
        collections = ["base", "session"]
        per_collection = {
            "base": [_Doc("a.pdf")],
            "session": None,  # raises inside fetch_one
        }
        result, _ = self._run(collections, per_collection)
        assert result == _sequential_reference(collections, per_collection)
        assert [d.file_name for d in result] == ["a.pdf"]

    def test_first_collection_failing_keeps_second(self):
        collections = ["base", "session"]
        per_collection = {
            "base": None,  # raises
            "session": [_Doc("only.pdf")],
        }
        result, _ = self._run(collections, per_collection)
        assert [d.file_name for d in result] == ["only.pdf"]

    def test_all_collections_empty_returns_empty(self):
        collections = ["base", "session"]
        result, _ = self._run(collections, {"base": [], "session": []})
        assert result == []

    def test_no_collections_returns_empty(self):
        result, call_order = self._run([], {})
        assert result == []
        assert call_order == []

    def test_every_collection_is_fetched(self):
        collections = ["base", "session", "extra"]
        per_collection = {"base": [_Doc("a")], "session": [_Doc("b")], "extra": [_Doc("c")]}
        _, call_order = self._run(collections, per_collection)
        assert sorted(call_order) == ["base", "extra", "session"]

    def test_merge_is_order_deterministic_regardless_of_completion(self):
        # session resolves before base (base sleeps longer), but the merged
        # order must still follow the input order, not the completion order.
        async def fetch_one(coll):
            if coll == "base":
                await asyncio.sleep(0.02)
                return [_Doc("base.pdf")]
            await asyncio.sleep(0)
            return [_Doc("session.pdf")]

        result = asyncio.run(_aggregate_documents_across_collections(["base", "session"], fetch_one))
        assert [d.file_name for d in result] == ["base.pdf", "session.pdf"]


class _Intent:
    def __init__(self, intent):
        self.intent = intent


class _State:
    def __init__(self, intent):
        self.user_intent = _Intent(intent)


class TestReflectionAnswerIsSubstantive:
    """Gate that keeps memory reflection off meta/error/insufficiency turns."""

    def test_real_research_answer_passes(self):
        assert _reflection_answer_is_substantive(_State("research"), "The building is Gebäudeklasse 4.")

    def test_meta_intent_skipped(self):
        assert not _reflection_answer_is_substantive(_State("meta"), "Hello! How can I help?")

    def test_error_intent_skipped(self):
        assert not _reflection_answer_is_substantive(_State("error"), "Something went wrong.")

    def test_insufficiency_answer_skipped(self):
        assert not _reflection_answer_is_substantive(
            _State("research"), "I don't have enough information to answer that."
        )

    def test_canned_error_answer_skipped(self):
        assert not _reflection_answer_is_substantive(
            _State("research"), "An error occurred while researching your question. Please try again."
        )

    def test_empty_answer_skipped(self):
        assert not _reflection_answer_is_substantive(_State("research"), "   ")

    def test_works_with_dict_result(self):
        assert _reflection_answer_is_substantive({"user_intent": _Intent("research")}, "A concrete finding.")
        assert not _reflection_answer_is_substantive({"user_intent": _Intent("meta")}, "hi there")


def _answer_response(text, *, cards=None, sources=None, confidence=None, **extras):
    """A fully-built ChatResponse like the one _run assembles before delivery.

    ``extras`` accepts the transparency extras (routing_decision, etc.) set the
    same way _run attaches them, so tests can assert they ride the terminal chunk.
    """
    resp = _create_chat_response(text, response_id="research_response", model="m")
    if cards is not None:
        resp.cards = cards
    if sources is not None:
        resp.sources = sources
    if confidence is not None:
        resp.answer_confidence = confidence
    for name, value in extras.items():
        setattr(resp, name, value)
    return resp


def _finish(chunk):
    return chunk.choices[0].finish_reason


def _content(chunk):
    return chunk.choices[0].delta.content


class TestIterAnswerDeltas:
    """Deltas must tile the answer exactly — no bytes added or lost."""

    def test_join_reproduces_text_verbatim(self):
        for text in [
            "Gebäudeklasse 4 [1].\n\n## Quellen\n[1] OIB-RL 2",
            "  leading and  double   spaces\tand\ttabs ",
            "single",
            "a\n\nb\n\nc",
        ]:
            assert "".join(_iter_answer_deltas(text)) == text

    def test_empty_text_yields_no_deltas(self):
        assert _iter_answer_deltas("") == []

    def test_words_are_not_split_across_deltas(self):
        # Each delta boundary falls on whitespace, so no delta starts mid-word
        # (every non-first delta begins after a space the prior delta absorbed).
        deltas = _iter_answer_deltas("the quick brown fox jumps over the lazy dog", target_size=8)
        assert len(deltas) > 1
        assert "".join(deltas) == "the quick brown fox jumps over the lazy dog"


class TestResponseToChunks:
    """The chunk sequence _run yields for a fully-built response."""

    def test_flag_off_single_terminal_chunk(self):
        resp = _answer_response("The answer.", cards=[{"type": "summary"}])
        chunks = _response_to_chunks(resp, stream=False)
        assert len(chunks) == 1
        assert _finish(chunks[0]) == "stop"
        assert _content(chunks[0]) == "The answer."
        assert getattr(chunks[0], "cards", None) == [{"type": "summary"}]

    def test_stream_deltas_then_terminal(self):
        text = "Gebäudeklasse 4 gilt hier [1]. Die OIB-Richtlinie 2 ist maßgeblich [2]."
        resp = _answer_response(text, cards=[{"type": "summary"}], sources=[{"citation_key": "k"}], confidence="high")
        chunks = _response_to_chunks(resp, stream=True)
        # last chunk is the terminal; all others are deltas
        assert _finish(chunks[-1]) == "stop"
        assert all(_finish(c) is None for c in chunks[:-1])
        assert len(chunks) > 1
        # delta contents concatenate to exactly the answer text
        assert "".join(_content(c) for c in chunks[:-1]) == text

    def test_extras_only_on_terminal_never_on_deltas(self):
        resp = _answer_response("some answer text here", cards=[{"type": "summary"}], sources=[{"citation_key": "k"}])
        chunks = _response_to_chunks(resp, stream=True)
        assert getattr(chunks[-1], "cards", None) == [{"type": "summary"}]
        assert getattr(chunks[-1], "sources", None) == [{"citation_key": "k"}]
        for delta in chunks[:-1]:
            assert getattr(delta, "cards", None) is None
            assert getattr(delta, "sources", None) is None

    def test_terminal_carries_full_content_for_persistence(self):
        # The terminal must carry the FULL text (not empty) so the disconnect
        # persistence path stores the complete answer, not a partial.
        text = "a somewhat longer answer that spans multiple streaming deltas for sure"
        resp = _answer_response(text)
        chunks = _response_to_chunks(resp, stream=True)
        assert _content(chunks[-1]) == text

    def test_transparency_extras_ride_the_terminal_chunk(self):
        # WP-A extras set on the ChatResponse are lifted onto the terminal chunk
        # (never onto deltas), just like cards/sources.
        resp = _answer_response(
            "some answer text that spans multiple deltas for the stream",
            routing_decision="deep",
            routing_reason="The question needs multi-source synthesis.",
            escalation_reason="Die erste Antwort war unzureichend.",
            answer_confidence_capped_reason="ungrounded",
            citations_removed={"count": 2, "reasons": ["broken"]},
        )
        chunks = _response_to_chunks(resp, stream=True)
        terminal = chunks[-1]
        assert getattr(terminal, "routing_decision", None) == "deep"
        assert getattr(terminal, "routing_reason", None) == "The question needs multi-source synthesis."
        assert getattr(terminal, "escalation_reason", None) == "Die erste Antwort war unzureichend."
        assert getattr(terminal, "answer_confidence_capped_reason", None) == "ungrounded"
        assert getattr(terminal, "citations_removed", None) == {"count": 2, "reasons": ["broken"]}
        for delta in chunks[:-1]:
            assert getattr(delta, "routing_decision", None) is None
            assert getattr(delta, "citations_removed", None) is None

    def test_absent_transparency_extras_not_set_on_terminal(self):
        # Absent-when-not-applicable: a plain answer carries none of the extras.
        resp = _answer_response("a plain answer with no transparency extras at all")
        terminal = _response_to_chunks(resp, stream=True)[-1]
        for field in (
            "routing_decision",
            "routing_reason",
            "escalation_reason",
            "answer_confidence_capped_reason",
            "citations_removed",
            "job_admission_rejected",
            "retry_after_seconds",
        ):
            assert getattr(terminal, field, None) is None

    def test_job_admission_rejection_extras_ride_terminal(self):
        # The queue-rejection notice carries both fields onto the terminal chunk.
        resp = _answer_response(
            "The research queue is full. Please retry shortly.",
            job_admission_rejected=True,
            retry_after_seconds=30,
        )
        terminal = _response_to_chunks(resp, stream=False)[-1]
        assert getattr(terminal, "job_admission_rejected", None) is True
        assert getattr(terminal, "retry_after_seconds", None) == 30

    def test_rejection_streams_no_deltas_only_terminal(self):
        # A queue rejection is surfaced by the frontend banner, NOT an answer
        # bubble: even with streaming ON it must yield NO delta chunks — only the
        # single terminal chunk carrying both extras — so no bubble is opened.
        resp = _answer_response(
            "The research queue is full. Please retry shortly.",
            job_admission_rejected=True,
            retry_after_seconds=30,
        )
        chunks = _response_to_chunks(resp, stream=True)
        assert len(chunks) == 1
        terminal = chunks[0]
        assert _finish(terminal) == "stop"
        assert getattr(terminal, "job_admission_rejected", None) is True
        assert getattr(terminal, "retry_after_seconds", None) == 30

    def test_normal_answer_still_streams_deltas_when_not_rejected(self):
        # Guard: the rejection short-circuit must not suppress deltas for a
        # normal answer of comparable length.
        text = "A normal answer that is long enough to span several streaming deltas here."
        resp = _answer_response(text)
        chunks = _response_to_chunks(resp, stream=True)
        assert len(chunks) > 1
        assert "".join(_content(c) for c in chunks[:-1]) == text


class TestFoldChunksToResponse:
    """Single-output consumers (--input CLI, single-shot HTTP) get one response
    folded from the stream — never a doubled body."""

    def test_fold_stream_uses_terminal_not_doubled(self):
        text = "Antwort mit Beleg [1]."
        resp = _answer_response(text, cards=[{"type": "summary"}], sources=[{"citation_key": "k"}], confidence="high")
        folded = _fold_chunks_to_response(_response_to_chunks(resp, stream=True))
        assert folded.choices[0].message.content == text  # NOT doubled
        assert folded.cards == [{"type": "summary"}]
        assert folded.sources == [{"citation_key": "k"}]
        assert folded.answer_confidence == "high"

    def test_fold_single_terminal_reproduces_response(self):
        resp = _answer_response("Just one chunk.", cards=[{"type": "summary"}])
        folded = _fold_chunks_to_response(_response_to_chunks(resp, stream=False))
        assert folded.choices[0].message.content == "Just one chunk."
        assert folded.cards == [{"type": "summary"}]

    def test_fold_deltas_only_concatenates(self):
        # Defensive: a stream with no terminal folds to the concatenation.
        from nat.data_models.api_server import ChatResponseChunk

        deltas = [ChatResponseChunk.create_streaming_chunk(t, finish_reason=None) for t in ["Hel", "lo!"]]
        folded = _fold_chunks_to_response(deltas)
        assert folded.choices[0].message.content == "Hello!"


class TestExtractTextFromMessageString:
    """Tests for _extract_text_from_message with string inputs."""

    def test_extract_from_string(self):
        """Test extracting text from a plain string."""
        result = _extract_text_from_message("Hello world")
        assert result == "Hello world"

    def test_extract_from_none(self):
        """Test that None returns None."""
        result = _extract_text_from_message(None)
        assert result is None

    def test_extract_from_empty_string(self):
        """Test extracting from empty string."""
        result = _extract_text_from_message("")
        assert result == ""


class TestExtractTextFromMessageObject:
    """Tests for _extract_text_from_message with message objects."""

    def test_extract_from_human_message(self):
        """Test extracting from HumanMessage."""
        message = HumanMessage(content="User query")
        result = _extract_text_from_message(message)
        assert result == "User query"

    def test_extract_from_ai_message(self):
        """Test extracting from AIMessage."""
        message = AIMessage(content="AI response")
        result = _extract_text_from_message(message)
        assert result == "AI response"

    def test_extract_from_object_with_content_attribute(self):
        """Test extracting from object with content attribute."""
        obj = MagicMock()
        obj.content = "Content from attribute"
        result = _extract_text_from_message(obj)
        assert result == "Content from attribute"


class TestExtractTextFromMessageMultipart:
    """Tests for _extract_text_from_message with multipart content."""

    def test_extract_from_multipart_content_list(self):
        """Test extracting from message with list content."""
        obj = MagicMock()
        part1 = MagicMock()
        part1.type = "text"
        part1.text = "First part"
        part2 = MagicMock()
        part2.type = "text"
        part2.text = "Second part"
        obj.content = [part1, part2]

        result = _extract_text_from_message(obj)
        assert "First part" in result
        assert "Second part" in result

    def test_extract_from_dict_multipart(self):
        """Test extracting from dict with multipart content."""
        message = {
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "image", "url": "http://example.com"},
                {"type": "text", "text": "World"},
            ]
        }
        result = _extract_text_from_message(message)
        assert "Hello" in result
        assert "World" in result

    def test_extract_skips_non_text_parts(self):
        """Test that non-text parts are skipped."""
        obj = MagicMock()
        text_part = MagicMock()
        text_part.type = "text"
        text_part.text = "Text content"
        image_part = MagicMock()
        image_part.type = "image"
        obj.content = [text_part, image_part]

        result = _extract_text_from_message(obj)
        assert result == "Text content"


class TestExtractTextFromMessageDict:
    """Tests for _extract_text_from_message with dict inputs."""

    def test_extract_from_dict_with_content(self):
        """Test extracting from dict with content key."""
        message = {"content": "Dict content"}
        result = _extract_text_from_message(message)
        assert result == "Dict content"

    def test_extract_from_dict_with_text_key(self):
        """Test extracting from dict with text key."""
        message = {"text": "Text value"}
        result = _extract_text_from_message(message)
        assert result == "Text value"

    def test_extract_from_dict_content_takes_precedence(self):
        """Test that content key is preferred over text key in dict lists."""
        message = {"content": "Content value", "text": "Text value"}
        result = _extract_text_from_message(message)
        assert result == "Content value"


class TestExtractQueryFromText:
    """Tests for _extract_query_from_text function."""

    def test_extract_plain_text(self):
        """Test that plain text is returned as-is."""
        query, sources = _extract_query_from_text("What is CUDA?")
        assert query == "What is CUDA?"
        assert sources is None

    def test_extract_empty_text(self):
        """Test extracting from empty text."""
        query, sources = _extract_query_from_text("")
        assert query == ""
        assert sources is None

    def test_extract_json_payload_with_query(self):
        """Test extracting from JSON payload with query key."""
        text = '{"query": "What is CUDA?", "data_sources": ["web_search"]}'
        query, sources = _extract_query_from_text(text)
        assert query == "What is CUDA?"
        assert sources == ["web_search"]

    def test_extract_json_payload_with_text_key(self):
        """Test extracting from JSON payload with text key."""
        text = '{"text": "Hello world", "data_sources": "confluence"}'
        query, sources = _extract_query_from_text(text)
        assert query == "Hello world"
        assert sources == ["confluence"]

    def test_extract_json_payload_no_data_sources(self):
        """Test extracting from JSON without data_sources."""
        text = '{"query": "Simple query"}'
        query, sources = _extract_query_from_text(text)
        assert query == "Simple query"
        assert sources is None

    def test_extract_invalid_json_returns_original(self):
        """Test that invalid JSON returns original text."""
        text = '{"invalid json'
        query, sources = _extract_query_from_text(text)
        assert query == '{"invalid json'
        assert sources is None

    def test_extract_json_with_whitespace(self):
        """Test extracting from JSON with surrounding whitespace."""
        text = '  {"query": "Test"}  '
        query, sources = _extract_query_from_text(text)
        assert query == "Test"
        assert sources is None

    def test_extract_json_missing_query_returns_none_text(self):
        """Test JSON without query or text returns None query."""
        text = '{"data_sources": ["web_search"]}'
        query, sources = _extract_query_from_text(text)
        assert query == '{"data_sources": ["web_search"]}'
        assert sources is None


class TestExtractQueryAndSourcesDict:
    """Tests for _extract_query_and_sources with dict payloads."""

    def test_extract_from_simple_dict(self):
        """Test extracting from simple dict structure."""
        payload = {
            "content": {
                "messages": [{"role": "user", "content": "What is AI?"}],
                "data_sources": ["web_search"],
            }
        }
        query, sources = _extract_query_and_sources(payload)
        assert query == "What is AI?"
        assert sources == ["web_search"]

    def test_extract_from_dict_with_message_key(self):
        """Test extracting from dict with message key."""
        payload = {"message": "Direct message"}
        query, sources = _extract_query_and_sources(payload)
        assert query == "Direct message"
        assert sources is None

    def test_extract_from_dict_with_text_key(self):
        """Test extracting from dict with text key."""
        payload = {"text": "Text message"}
        query, sources = _extract_query_and_sources(payload)
        assert query == "Text message"
        assert sources is None

    def test_extract_prefers_last_user_message(self):
        """Test that last user message is preferred."""
        payload = {
            "content": {
                "messages": [
                    {"role": "user", "content": "First question"},
                    {"role": "assistant", "content": "First answer"},
                    {"role": "user", "content": "Second question"},
                ]
            }
        }
        query, sources = _extract_query_and_sources(payload)
        assert query == "Second question"
        assert sources is None

    def test_extract_data_sources_from_payload_level(self):
        """Test extracting data_sources from payload level."""
        payload = {
            "data_sources": ["confluence", "sharepoint"],
            "content": {
                "messages": [{"role": "user", "content": "Query"}],
            },
        }
        query, sources = _extract_query_and_sources(payload)
        assert query == "Query"
        assert sources == ["confluence", "sharepoint"]

    def test_extract_data_sources_from_content_level(self):
        """Test extracting data_sources from content level."""
        payload = {
            "content": {
                "messages": [{"role": "user", "content": "Query"}],
                "data_sources": ["google_drive"],
            },
        }
        query, sources = _extract_query_and_sources(payload)
        assert query == "Query"
        assert sources == ["google_drive"]


class TestExtractQueryAndSourcesObject:
    """Tests for _extract_query_and_sources with object payloads."""

    def test_extract_from_object_with_messages(self):
        """Test extracting from object with messages attribute."""
        user_msg = MagicMock()
        user_msg.role = "user"
        user_msg.content = "Object query"

        payload = MagicMock()
        payload.messages = [user_msg]
        payload.data_sources = None

        query, sources = _extract_query_and_sources(payload)
        assert query == "Object query"
        assert sources is None

    def test_extract_from_object_with_data_sources(self):
        """Test extracting from object with data_sources attribute."""
        user_msg = MagicMock()
        user_msg.role = "user"
        user_msg.content = "Query with sources"

        payload = MagicMock()
        payload.messages = [user_msg]
        payload.data_sources = ["web_search", "confluence"]

        query, sources = _extract_query_and_sources(payload)
        assert query == "Query with sources"
        assert sources == ["web_search", "confluence"]


class TestExtractQueryAndSourcesString:
    """Tests for _extract_query_and_sources with string payloads."""

    def test_extract_from_plain_string(self):
        """Test extracting from plain string (no inline JSON)."""
        query, sources = _extract_query_and_sources("Plain query string")
        assert query == "Plain query string"
        assert sources is None

    def test_extract_from_json_string(self):
        """Test extracting from JSON string."""
        payload = '{"query": "JSON query", "data_sources": ["web_search"]}'
        query, sources = _extract_query_and_sources(payload)
        assert query == "JSON query"
        assert sources == ["web_search"]


class TestExtractQueryAndSourcesInlineJson:
    """Tests for inline JSON extraction in messages."""

    def test_extract_inline_json_in_message_content(self):
        """Test extracting inline JSON from message content."""
        payload = {
            "content": {
                "messages": [
                    {
                        "role": "user",
                        "content": ('{"query": "Inline JSON", "data_sources": ["sharepoint"]}'),
                    }
                ]
            }
        }
        query, sources = _extract_query_and_sources(payload)
        assert query == "Inline JSON"
        assert sources == ["sharepoint"]

    def test_inline_sources_used_when_payload_sources_missing(self):
        """Test inline sources are used when payload has no sources."""
        payload = {
            "content": {
                "messages": [
                    {
                        "role": "user",
                        "content": ('{"query": "Test", "data_sources": ["jira"]}'),
                    }
                ]
            }
        }
        query, sources = _extract_query_and_sources(payload)
        assert query == "Test"
        assert sources == ["jira"]

    def test_payload_sources_take_precedence_over_inline(self):
        """Test that payload-level sources take precedence."""
        payload = {
            "data_sources": ["confluence"],
            "content": {
                "messages": [
                    {
                        "role": "user",
                        "content": ('{"query": "Test", "data_sources": ["jira"]}'),
                    }
                ]
            },
        }
        query, sources = _extract_query_and_sources(payload)
        assert query == "Test"
        assert sources == ["confluence"]


class TestExtractQueryAndSourcesEdgeCases:
    """Edge case tests for _extract_query_and_sources."""

    def test_extract_empty_messages_list(self):
        """Test with empty messages list."""
        payload = {"content": {"messages": []}}
        query, sources = _extract_query_and_sources(payload)
        assert query == ""
        assert sources is None

    def test_extract_no_user_messages(self):
        """Test with no user messages in list."""
        payload = {
            "content": {
                "messages": [
                    {"role": "assistant", "content": "AI response"},
                    {"role": "system", "content": "System prompt"},
                ]
            }
        }
        query, sources = _extract_query_and_sources(payload)
        assert query == "System prompt"
        assert sources is None

    def test_extract_with_langchain_messages(self):
        """Test with actual LangChain message objects in dict payload."""
        payload = {
            "content": {
                "messages": [
                    {"role": "user", "content": "LangChain query"},
                    {"role": "assistant", "content": "LangChain response"},
                ]
            }
        }

        query, sources = _extract_query_and_sources(payload)
        assert query == "LangChain query"
        assert sources is None

    def test_extract_with_explicit_data_sources_list(self):
        """Test with explicitly specified data sources list."""
        payload = {
            "data_sources": ["web_search", "confluence"],
            "content": {
                "messages": [{"role": "user", "content": "Query"}],
            },
        }
        query, sources = _extract_query_and_sources(payload)
        assert query == "Query"
        assert sources == ["web_search", "confluence"]

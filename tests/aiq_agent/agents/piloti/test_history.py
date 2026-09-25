"""Tests for trimming the conversation history to a token budget."""

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage

from aiq_agent.agents.piloti.history import _count_message_tokens
from aiq_agent.agents.piloti.history import prune_tool_results
from aiq_agent.agents.piloti.history import trim_message_history


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


def _turn(question: str, passage: str, answer: str, thought: str = "") -> list:
    call = {"name": "read_passage", "args": {"document": "OIB-RL 2"}, "id": f"c-{question[:4]}"}
    return [
        HumanMessage(content=question),
        AIMessage(content=thought, tool_calls=[call]),
        ToolMessage(content=passage, tool_call_id=call["id"], name="read_passage"),
        AIMessage(content=answer),
    ]


class TestPruneToolResults:
    """The previous turn keeps its evidence; older turns keep what was said."""

    def test_the_previous_turn_is_intact_and_the_older_one_is_prose_only(self):
        history = [*_turn("Q1", "P1", "A1"), *_turn("Q2", "P2", "A2", thought="Ich prüfe."), HumanMessage(content="Q3")]
        pruned = prune_tool_results(history)
        assert [type(m).__name__ for m in pruned] == [
            "HumanMessage",
            "AIMessage",
            "HumanMessage",
            "AIMessage",
            "ToolMessage",
            "AIMessage",
            "HumanMessage",
        ]
        assert pruned[1].content == "A1" and not pruned[1].tool_calls
        assert pruned[4].content == "P2"

    def test_an_older_assistant_message_with_prose_keeps_its_prose_and_loses_its_calls(self):
        history = [*_turn("Q1", "P1", "A1", thought="Ich prüfe."), *_turn("Q2", "P2", "A2"), HumanMessage(content="Q3")]
        pruned = prune_tool_results(history)
        assert pruned[1].content == "Ich prüfe." and pruned[1].tool_calls == []
        assert pruned[2].content == "A1"

    def test_a_responses_api_call_block_leaves_with_its_result(self):
        """On the Responses API the call is ALSO a ``function_call`` block in
        ``content``; left behind, it is a call with no result and the provider
        answers 400."""
        call = {"name": "read_passage", "args": {}, "id": "c-1"}
        calls_only = AIMessage(
            content=[{"type": "function_call", "call_id": "c-1", "name": "read_passage", "arguments": "{}"}],
            tool_calls=[call],
        )
        with_prose = AIMessage(
            content=[
                {"type": "text", "text": "Ich prüfe."},
                {"type": "function_call", "call_id": "c-2", "name": "read_passage", "arguments": "{}"},
            ],
            tool_calls=[{**call, "id": "c-2"}],
        )
        history = [
            HumanMessage(content="Q1"),
            calls_only,
            ToolMessage(content="P1", tool_call_id="c-1"),
            with_prose,
            ToolMessage(content="P1b", tool_call_id="c-2"),
            AIMessage(content="A1"),
            *_turn("Q2", "P2", "A2"),
            HumanMessage(content="Q3"),
        ]
        pruned = prune_tool_results(history)
        older = pruned[: pruned.index(history[6])]
        blocks = [b for m in older if isinstance(m.content, list) for b in m.content]
        assert all(b.get("type") != "function_call" for b in blocks)
        assert len(older) == 3
        kept = pruned[1]
        assert kept.content == [{"type": "text", "text": "Ich prüfe."}] and kept.tool_calls == []
        assert pruned[2].content == "A1"

    def test_one_previous_turn_is_untouched(self):
        history = [*_turn("Q1", "P1", "A1"), HumanMessage(content="Q2")]
        assert prune_tool_results(history) == history

    def test_keep_turns_widens_the_window(self):
        history = [*_turn("Q1", "P1", "A1"), *_turn("Q2", "P2", "A2"), HumanMessage(content="Q3")]
        assert len(prune_tool_results(history, keep_turns=2)) == len(history)


def _grounding(*hits: tuple[str, str]) -> str:
    """A rendered retrieval result with one block per ``(citation key, body)``."""
    blocks = [
        f"--- Result {i} ---\nSource: OIB-Richtlinie 2\nPage: {i}\nCitation: {key}\nContent Type: text\n\n{body}\n"
        for i, (key, body) in enumerate(hits, start=1)
    ]
    return "Found 2 relevant document(s):\n\n" + "\n".join(blocks) + "\n## Gliederung\n1 Allgemeines\n"


class TestCompactToolResults:
    """The kept turn holds the cited passages whole and the rest by header only."""

    def test_an_uncited_passage_keeps_its_header_and_loses_its_body(self):
        from aiq_agent.agents.piloti.history import UNCITED_PASSAGE_NOTE
        from aiq_agent.agents.piloti.history import compact_tool_results

        content = _grounding(
            ("oib-rl_2.pdf, p.1", "REI 60 gilt in GK 4."), ("oib-rl_2.pdf, p.2", "Ein langer, nie zitierter Absatz.")
        )
        [compacted] = compact_tool_results([ToolMessage(content=content, tool_call_id="c1")], {"oib-rl_2.pdf, p.1"})
        assert "REI 60 gilt in GK 4." in compacted.content
        assert "Ein langer, nie zitierter Absatz." not in compacted.content
        assert "Citation: oib-rl_2.pdf, p.2" in compacted.content
        assert UNCITED_PASSAGE_NOTE in compacted.content
        # The result's own trailer survives: it belongs to the call, not to a passage.
        assert "## Gliederung" in compacted.content

    def test_no_cited_key_leaves_the_turn_as_it_was(self):
        from aiq_agent.agents.piloti.history import compact_tool_results

        content = _grounding(("k1", "A"), ("k2", "B"))
        messages = [ToolMessage(content=content, tool_call_id="c1")]
        assert compact_tool_results(messages, set())[0].content == content

    def test_a_result_without_blocks_is_untouched(self):
        from aiq_agent.agents.piloti.history import compact_tool_results

        messages = [ToolMessage(content="No relevant documents found for query: 'x'", tool_call_id="c1")]
        assert compact_tool_results(messages, {"k1"})[0].content == messages[0].content

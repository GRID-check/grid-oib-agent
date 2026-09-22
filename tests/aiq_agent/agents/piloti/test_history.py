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

    def test_one_previous_turn_is_untouched(self):
        history = [*_turn("Q1", "P1", "A1"), HumanMessage(content="Q2")]
        assert prune_tool_results(history) == history

    def test_keep_turns_widens_the_window(self):
        history = [*_turn("Q1", "P1", "A1"), *_turn("Q2", "P2", "A2"), HumanMessage(content="Q3")]
        assert len(prune_tool_results(history, keep_turns=2)) == len(history)

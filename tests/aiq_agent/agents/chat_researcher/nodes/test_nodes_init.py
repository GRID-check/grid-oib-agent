"""Tests for the chat researcher nodes __init__ module."""


class TestNodesInit:
    """Tests for the nodes module initialization."""

    def test_import_intent_classifier(self):
        """Test that IntentClassifier can be imported from nodes."""
        from aiq_agent.agents.chat_researcher.nodes import IntentClassifier

        assert IntentClassifier is not None

    def test_all_exports(self):
        """Test that __all__ contains expected exports (orchestration is IntentClassifier only)."""
        from aiq_agent.agents.chat_researcher import nodes

        assert "IntentClassifier" in nodes.__all__
        assert nodes.__all__ == ["IntentClassifier"]

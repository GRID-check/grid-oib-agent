"""Tests for the chat researcher models __init__ module."""


class TestModelsInit:
    """Tests for the models module initialization."""

    def test_import_chat_researcher_state(self):
        """Test that ChatResearcherState can be imported from models."""
        from aiq_agent.agents.chat_researcher.models import ChatResearcherState

        assert ChatResearcherState is not None

    def test_import_depth_decision(self):
        """Test that DepthDecision can be imported from models."""
        from aiq_agent.agents.chat_researcher.models import DepthDecision

        assert DepthDecision is not None

    def test_import_intent_result(self):
        """Test that IntentResult can be imported from models."""
        from aiq_agent.agents.chat_researcher.models import IntentResult

        assert IntentResult is not None

    def test_import_shallow_result(self):
        """Test that ShallowResult can be imported from models."""
        from aiq_agent.agents.chat_researcher.models import ShallowResult

        assert ShallowResult is not None

    def test_all_exports(self):
        """Test that __all__ contains expected exports."""
        from aiq_agent.agents.chat_researcher import models

        assert "ChatResearcherState" in models.__all__
        assert "DepthDecision" in models.__all__
        assert "IntentResult" in models.__all__
        assert "ShallowResult" in models.__all__

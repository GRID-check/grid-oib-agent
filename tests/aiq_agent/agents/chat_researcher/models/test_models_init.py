"""Tests for the chat researcher models __init__ module."""


class TestModelsInit:
    """Tests for the models module initialization."""

    def test_import_chat_researcher_state(self):
        """Test that ChatResearcherState can be imported from models."""
        from aiq_agent.agents.chat_researcher.models import ChatResearcherState

        assert ChatResearcherState is not None

    def test_import_shallow_result(self):
        """Test that ShallowResult can be imported from models."""
        from aiq_agent.agents.chat_researcher.models import ShallowResult

        assert ShallowResult is not None

    def test_all_exports(self):
        """Test that __all__ contains exactly the surviving exports.

        ``IntentResult`` and ``DepthDecision`` went with the classifier
        (ADR-0052); a re-export would be a state type nobody sets.
        """
        from aiq_agent.agents.chat_researcher import models

        assert set(models.__all__) == {"ChatResearcherState", "ShallowResult"}
        assert not hasattr(models, "IntentResult")
        assert not hasattr(models, "DepthDecision")

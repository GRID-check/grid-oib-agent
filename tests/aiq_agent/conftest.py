"""Pytest fixtures for tests."""

from unittest.mock import MagicMock

import pytest

from aiq_agent.common.llm_provider import LLMProvider


@pytest.fixture
def mock_llm():
    """Create a mock LLM for testing."""
    llm = MagicMock()
    llm.ainvoke = MagicMock()
    return llm


@pytest.fixture
def llm_provider(mock_llm):
    """Create an LLMProvider with a mock default LLM."""
    provider = LLMProvider()
    provider.set_default(mock_llm)
    return provider

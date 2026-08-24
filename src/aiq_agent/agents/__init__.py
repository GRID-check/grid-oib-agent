"""Agents for the AI-Q Blueprint."""

from .chat_researcher import chat_deepresearcher_agent
from .deep_researcher import deep_research_agent
from .shallow_researcher import shallow_research_agent

__all__ = [
    "chat_deepresearcher_agent",
    "shallow_research_agent",
    "deep_research_agent",
]

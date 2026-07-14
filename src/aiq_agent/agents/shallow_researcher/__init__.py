"""Shallow research agent."""

from . import register  # noqa: F401
from .register import shallow_research_agent  # noqa: F401
from .register import shallow_research_workflow  # noqa: F401

__all__ = [
    "shallow_research_agent",
    "shallow_research_workflow",
]

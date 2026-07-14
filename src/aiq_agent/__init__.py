"""AI-Q Blueprint core package.

This module uses lazy imports to avoid loading heavy dependencies (langgraph, etc.)
when only lightweight submodules like `aiq_agent.knowledge` are needed.
"""

__all__ = [
    "chat_deepresearcher_agent",
    "shallow_research_agent",
    "deep_research_agent",
]

from typing import Any

# Cache for lazy-loaded modules to avoid repeated imports
_lazy_imports: dict[str, Any] = {}


def __getattr__(name: str):
    """Lazy import agents to avoid loading langgraph/ray dependencies unnecessarily.

    This allows `from aiq_agent.knowledge import ...` to work without pulling in
    the full agent stack and its heavy dependencies (langgraph, etc.).
    """
    if name in _lazy_imports:
        return _lazy_imports[name]

    if name == "chat_deepresearcher_agent":
        from .agents import chat_deepresearcher_agent

        _lazy_imports[name] = chat_deepresearcher_agent
        return chat_deepresearcher_agent

    if name == "shallow_research_agent":
        from .agents import shallow_research_agent

        _lazy_imports[name] = shallow_research_agent
        return shallow_research_agent

    if name == "deep_research_agent":
        from .agents import deep_research_agent

        _lazy_imports[name] = deep_research_agent
        return deep_research_agent

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

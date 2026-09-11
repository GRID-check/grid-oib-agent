"""The research agent: the general answering agent for a chat turn.

Two NAT registrations, because a chat turn is two things. ``register`` is the
answering agent itself; ``conversation_register`` is the workflow NAT calls per
turn, which wires this agent and the deep researcher into the conversation
graph in :mod:`aiq_agent.agents.piloti.conversation`.
"""

from . import conversation_register  # noqa: F401
from . import register  # noqa: F401
from .conversation_register import chat_deepresearcher_agent  # noqa: F401
from .register import research_agent  # noqa: F401
from .register import research_workflow  # noqa: F401

__all__ = [
    "chat_deepresearcher_agent",
    "research_agent",
    "research_workflow",
]

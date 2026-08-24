"""Utility functions for clarifier agent."""

from aiq_agent.common import extract_user_response

# Re-exported rather than reimplemented: the clarifier is no longer the only
# caller that stops a run to ask the user something (see the shallow
# researcher's `ask_user` tool), and both have to read the same set of
# HumanResponse shapes — a typed answer and a picked option arrive as
# different models. Two copies of that mapping is how one of them ends up
# unable to read a picked option. This alias keeps the historical
# `clarifier.utils.extract_user_response` import path working.
__all__ = ["extract_user_response"]

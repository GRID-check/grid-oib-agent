"""The reply a turn gets when its searches left nothing citable.

Answer feedback (October 2026): a user who had narrowed nothing was told not to
narrow the question to one file, twice, on an OIB question the corpus answers.
"""

from types import SimpleNamespace

import pytest
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.register import _run_agent
from aiq_agent.common.canned_replies import NO_SOURCES_MESSAGE
from aiq_agent.common.canned_replies import SCOPED_NO_SOURCES_MESSAGE
from aiq_agent.common.citation_verification import EmptySourceRegistryError


def _deployment_that_finds_nothing() -> SimpleNamespace:
    async def run(_state, *, turn):
        raise EmptySourceRegistryError("research", unavailable_tools=[], available_count=3)

    return SimpleNamespace(agent=SimpleNamespace(run=run))


def _state(**scope) -> ResearchAgentState:
    return ResearchAgentState(messages=[HumanMessage(content="Welche Absturzhöhe gilt für Brüstungen?")], **scope)


@pytest.mark.asyncio
async def test_a_miss_without_a_scope_gets_the_unscoped_reply():
    assert await _run_agent(_deployment_that_finds_nothing(), _state(), turn=None) == NO_SOURCES_MESSAGE


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", [{"focus_file_name": "Plan.pdf"}, {"focus_shelf": "projekt"}])
async def test_a_miss_inside_a_scope_gets_the_scoped_reply(scope):
    assert await _run_agent(_deployment_that_finds_nothing(), _state(**scope), turn=None) == SCOPED_NO_SOURCES_MESSAGE

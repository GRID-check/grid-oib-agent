"""``skills_hidden`` crosses from Piloti onto the answer.

Piloti records which of the skills it activated are
``grid-hidden`` (the house voice, the card grammar) on its own state, and the
frontend mutes exactly those rows in the "Skills used" disclosure. Between
those two ends is a Python-to-Python hop inside the chat agent — the result
→ ``ConversationState`` → ``TurnResult`` — and that hop is what was
missing: both ends were tested, the hop was not, so ``skills_hidden`` was set
on every answer with skills and reached no reader on any of them. Hidden skills
rendered at full weight in the disclosure, which is the one thing the field
exists to prevent.

So this pins the HOP. Nothing here stubs the chat agent's graph or the lift:
a real ``ResearchAgentState`` — the same object Piloti's register
sets ``skills_hidden`` on — is returned by Piloti, run through the
real ``ConversationGraph`` and through the real ``build_result``. What is
asserted is the ``RUN_FINISHED`` result the socket persists and sends. A rename
on either side of the hop, or a missing kwarg anywhere along it, fails here.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.conversation import ConversationGraph
from aiq_agent.agents.piloti.markers import ESCALATION_MARKER
from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.turn.response import build_result
from tests.aiq_agent.agents.piloti.conversation import turn

VOICE = "piloti-voice"
CARDS = "piloti-cards"
VISIBLE = "forecast-analysis"


def _agent(research_fn, deep_fn=None):
    return ConversationGraph(
        research_fn=research_fn,
        deep_research_fn=deep_fn or (lambda state: None),
        clarifier_fn=None,
    )


def _research_returning(answer: str, **fields):
    """A research node that answers with a REAL Piloti state carrying ``fields``."""

    async def research(state):
        return ResearchAgentState(
            messages=list(state.messages) + [AIMessage(content=answer)],
            escalation_requested=False,
            **fields,
        )

    return research


async def _turn(research_fn, deep_fn=None):
    """One turn: the terminal graph state, and the result a client receives for it.

    Both ends are returned because the result carries ``skills_hidden`` only
    alongside the list it mutes — so an answer that drops ``skills_activated``
    would hide a leaking mute list from the result, and the state is where
    that shows.
    """
    state = ConversationState(messages=[HumanMessage(content="Wie tief darf der Erker sein?")])
    result = await turn(_agent(research_fn, deep_fn), state, thread_id="t")
    return result, build_result(result, [], "m1")


@pytest.mark.asyncio
async def test_the_hidden_subset_rides_the_answer_it_belongs_to():
    """The skill the research turn marked hidden arrives on the answer finished.

    Both names travel, and travel together: the disclosure renders every
    activated skill and mutes the subset named here, so a mute list that
    arrives without its list — or a list that arrives without its mute — is a
    disclosure that says something the turn did not do.
    """
    _, finished = await _turn(
        _research_returning(
            "Antwort [1].",
            skills_activated=[VOICE, CARDS, VISIBLE],
            skills_hidden=[VOICE, CARDS],
        )
    )

    assert finished.skills_activated == [VOICE, CARDS, VISIBLE]
    assert finished.skills_hidden == [VOICE, CARDS], (
        "Piloti marked piloti-voice/piloti-cards grid-hidden and the answer "
        "reached the client without saying so — the disclosure will render the house voice at "
        "full weight, which is exactly the internal vocabulary the field exists to mute"
    )


@pytest.mark.asyncio
async def test_a_turn_with_nothing_hidden_carries_no_mute_list():
    """No mute list: the frame omits a field at its default."""
    _, finished = await _turn(_research_returning("Antwort [1].", skills_activated=[VISIBLE]))

    assert finished.skills_activated == [VISIBLE]
    assert finished.skills_hidden == []


@pytest.mark.asyncio
async def test_an_escalating_turn_drops_the_mute_list_with_the_list_it_mutes():
    """The deep report supersedes this answer, so its skills are not its record."""

    async def research_escalating(state):
        return ResearchAgentState(
            messages=list(state.messages) + [AIMessage(content=f"Reicht nicht. {ESCALATION_MARKER}")],
            escalation_requested=True,
            skills_activated=[VOICE],
            skills_hidden=[VOICE],
        )

    async def deep(state):
        return ResearchAgentState(messages=list(state.messages) + [AIMessage(content="Deep report.")])

    result, finished = await _turn(research_escalating, deep)

    assert result.skills_activated is None
    assert result.skills_hidden is None, (
        "the superseded research turn's mute list survived into the deep-research answer's "
        "state: it names skills that shaped an answer the reader is never shown"
    )
    assert finished.skills_activated == []
    assert finished.skills_hidden == []

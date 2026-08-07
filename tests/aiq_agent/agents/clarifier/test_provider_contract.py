"""End-to-end regression for the clarifier's outgoing request shape.

Reproduces the production path behind issue #294 (and its siblings #291-#293,
#333, #335, #336, #340). The stack trace lands on
``clarifier/agent.py`` ``agent_node`` -> ``bound_llm.ainvoke(messages)``, and the
reason it reached a provider at all is architectural rather than local:

``chat_researcher`` hands the clarifier a *conversation window*
(``trim_message_history(state.messages)``). On an escalated turn that window
ends with the shallow answer the agent just produced — an assistant turn. The
clarifier then sends ``[SystemMessage] + window``, so the request ends on a
model turn, which Google rejects and OpenAI-compatible providers do not.

The suite never caught it because every clarifier LLM double was a bare
``MagicMock``, which accepts any message sequence. These tests drive the real
compiled graph against a model that enforces the provider contract, so the
assembly bug is now observable in CI.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.clarifier.agent import ClarifierAgent
from aiq_agent.agents.clarifier.models import ClarificationResponse
from aiq_agent.agents.clarifier.models import ClarifierAgentState
from aiq_agent.common import LLMProvider
from tests.conftest import ProviderContractError

#: The window ``chat_researcher`` hands the clarifier on an escalated turn: the
#: user's question followed by the shallow answer that triggered the escalation.
ESCALATED_TURN_HISTORY = [
    HumanMessage(content="Brauche ich einen Aufzug bei meinem Projekt?"),
    AIMessage(content="Ja - bei deinem Projekt ist praktisch von einer Aufzugspflicht auszugehen."),
]


def _agent_for(llm) -> ClarifierAgent:
    provider = LLMProvider()
    provider.set_default(llm)
    return ClarifierAgent(llm_provider=provider, user_prompt_callback=AsyncMock(return_value="skip"))


@pytest.mark.asyncio
async def test_clarifier_survives_a_history_that_ends_on_an_assistant_turn(strict_provider_llm):
    """The regression: this is the exact request that 400'd in production."""
    complete = ClarificationResponse(needs_clarification=False, clarification_question=None)
    llm = strict_provider_llm([AIMessage(content=complete.model_dump_json())])

    result = await _agent_for(llm).run(ClarifierAgentState(messages=list(ESCALATED_TURN_HISTORY)))

    assert result is not None
    # Every request the clarifier actually sent is a legal request.
    assert llm.received, "the clarifier never called the model"
    for request in llm.received:
        assert request[-1].type != "ai"


@pytest.mark.asyncio
async def test_the_escalated_history_is_rejected_without_the_contract(strict_provider_llm):
    """Guards the guard.

    Without the fleet-wide contract this same graph run fails, which is what
    makes the test above meaningful rather than vacuously green.
    """
    complete = ClarificationResponse(needs_clarification=False, clarification_question=None)
    llm = strict_provider_llm([AIMessage(content=complete.model_dump_json())], with_contract=False)

    with pytest.raises(ProviderContractError, match="ending with a model turn"):
        await _agent_for(llm).run(ClarifierAgentState(messages=list(ESCALATED_TURN_HISTORY)))


@pytest.mark.asyncio
async def test_the_prior_assistant_answer_is_kept_as_context(strict_provider_llm):
    """Normalization must not solve the 400 by throwing context away.

    The shallow answer is the most useful thing the clarifier can read on an
    escalated turn; dropping it would trade a visible error for a quietly worse
    clarification.
    """
    complete = ClarificationResponse(needs_clarification=False, clarification_question=None)
    llm = strict_provider_llm([AIMessage(content=complete.model_dump_json())])

    await _agent_for(llm).run(ClarifierAgentState(messages=list(ESCALATED_TURN_HISTORY)))

    first_request = llm.received[0]
    assert any(m.type == "ai" and "Aufzugspflicht" in m.content for m in first_request)

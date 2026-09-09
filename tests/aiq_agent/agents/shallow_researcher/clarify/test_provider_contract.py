"""End-to-end regression for the clarification step's outgoing request shape.

Reproduces the production path behind issue #294 (and its siblings #291-#293,
#333, #335, #336, #340). The stack trace lands on the clarification call's
``llm.ainvoke(messages)``, and the reason it reached a provider at all is
architectural rather than local:

The conversation graph hands the step a *conversation window*
(``trim_message_history(state.messages)``). On an escalated turn that window
ends with the shallow answer the agent just produced — an assistant turn. The
step then sends ``[SystemMessage] + window``, so the request ends on a model
turn, which Google rejects and OpenAI-compatible providers do not.

The suite never caught it because every clarifier LLM double was a bare
``MagicMock``, which accepts any message sequence. These tests drive the real
step against a model that enforces the provider contract, so the assembly bug
is observable in CI.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.shallow_researcher.clarify import ClarifierSettings
from aiq_agent.agents.shallow_researcher.clarify import build_deps
from aiq_agent.agents.shallow_researcher.clarify import clarify
from aiq_agent.agents.shallow_researcher.models import ClarificationResponse
from aiq_agent.agents.shallow_researcher.models import ClarifyRequest
from aiq_agent.common import LLMProvider
from tests.conftest import ProviderContractError

#: The window the conversation graph hands the step on an escalated turn: the
#: user's question followed by the shallow answer that triggered the escalation.
ESCALATED_TURN_HISTORY = [
    HumanMessage(content="Brauche ich einen Aufzug bei meinem Projekt?"),
    AIMessage(content="Ja - bei deinem Projekt ist praktisch von einer Aufzugspflicht auszugehen."),
]


def _deps_for(llm):
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return build_deps(provider, [], None, ClarifierSettings(llm="clarifier_llm"), AsyncMock(return_value="skip"))


def _request() -> ClarifyRequest:
    return ClarifyRequest(messages=list(ESCALATED_TURN_HISTORY))


@pytest.mark.asyncio
async def test_the_step_survives_a_history_that_ends_on_an_assistant_turn(strict_provider_llm):
    """The regression: this is the exact request that 400'd in production."""
    complete = ClarificationResponse(needs_clarification=False, clarification_question=None)
    llm = strict_provider_llm([AIMessage(content=complete.model_dump_json())])

    result = await clarify(_request(), _deps_for(llm))

    assert result is not None
    # Every request the step actually sent is a legal request.
    assert llm.received, "the clarification step never called the model"
    for request in llm.received:
        assert request[-1].type != "ai"


@pytest.mark.asyncio
async def test_the_escalated_history_is_rejected_without_the_contract(strict_provider_llm):
    """Guards the guard.

    Without the fleet-wide contract this same run fails, which is what makes
    the test above meaningful rather than vacuously green.
    """
    complete = ClarificationResponse(needs_clarification=False, clarification_question=None)
    llm = strict_provider_llm([AIMessage(content=complete.model_dump_json())], with_contract=False)

    with pytest.raises(ProviderContractError, match="ending with a model turn"):
        await clarify(_request(), _deps_for(llm))


@pytest.mark.asyncio
async def test_the_prior_assistant_answer_is_kept_as_context(strict_provider_llm):
    """Normalization must not solve the 400 by throwing context away.

    The shallow answer is the most useful thing the step can read on an
    escalated turn; dropping it would trade a visible error for a quietly worse
    clarification.
    """
    complete = ClarificationResponse(needs_clarification=False, clarification_question=None)
    llm = strict_provider_llm([AIMessage(content=complete.model_dump_json())])

    await clarify(_request(), _deps_for(llm))

    first_request = llm.received[0]
    assert any(m.type == "ai" and "Aufzugspflicht" in m.content for m in first_request)

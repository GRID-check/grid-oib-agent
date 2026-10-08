"""The chat entrypoint hands the reflection stage what the turn could take from
restricted folders (ADR-0086).

``_finished`` is the one call site for every post-answer stage. What is pinned:
the restriction evidence on the stage facts comes from the conversation's
citation registry (``TurnRegistries.source_collections``) and from the turn's
UNCAPPED inventory rows — what ``list_files`` could show — not only from the
prompt's capped rows.
"""

from __future__ import annotations

from unittest.mock import MagicMock
from unittest.mock import patch

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti import conversation_register
from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.stages import TurnFacts
from aiq_agent.turn.admission import TurnOutcome
from aiq_agent.turn.registries import TurnRegistries

RESTRICTED = "proj_1_r0123456789ab"


def test_finished_carries_the_registry_and_the_uncapped_listing_into_the_stage_facts():
    state = ConversationState(
        messages=[HumanMessage(content="Was ist vereinbart?"), AIMessage(content="Pauschal.")],
        collection_scope=["proj_1", RESTRICTED],
        available_documents=[],
    )
    registries = TurnRegistries(cards=CardRegistry(), source_collections=(RESTRICTED,))
    context = MagicMock(stage_facts=TurnFacts(project_id="p1"))
    inputs = MagicMock(query_text="Was ist vereinbart?")
    listed = ({"collection": RESTRICTED, "file_name": "Vertrag.pdf", "summary": "Honorar"},)

    with (
        patch.object(conversation_register, "schedule_post_answer_stages") as schedule,
        patch.object(conversation_register, "get_turn_documents", return_value=listed),
    ):
        conversation_register._finished(
            TurnOutcome(state=state, refusal=None), registries, context, inputs, message_id="m1", stage_llms={}
        )

    facts = schedule.call_args.args[0]
    assert facts.restriction.scope == (RESTRICTED,)
    assert facts.restriction.read == (RESTRICTED,)
    assert [doc.name for doc in facts.restriction.documents] == ["Vertrag.pdf"]

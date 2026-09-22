"""The register applies the turn decision by ADDING only (ADR-0064).

The decision itself is mocked; what is pinned is the seam: the facts the
decider is shown come from the state the gather filled, a model answer
inlines the IFC skill, the chosen card types become the turn's shapes block,
and the prefetch calls reach ``TurnConfig`` — while a decision that did not
run, or a config that switched it off, leaves all three untouched.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

import aiq_agent.agents.piloti.register as register_module
from aiq_agent.agents.piloti.decisions import TurnDecisions
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.register import ResearchAgentConfig
from aiq_agent.agents.piloti.register import _apply_decisions
from aiq_agent.agents.piloti.register import _turn_facts
from aiq_agent.agents.piloti.register import research_agent
from aiq_agent.skills.models import Skill
from aiq_agent.skills.runtime import SkillRuntime


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    return query


class _FakeBuilder:
    def __init__(self, tools_by_name):
        self._tools_by_name = tools_by_name

    async def get_tools(self, tool_names, wrapper_type):
        return [self._tools_by_name[n] for n in tool_names if n in self._tools_by_name]

    async def get_llm(self, ref, wrapper_type):
        return MagicMock()


IFC = "ifc-spatial-reasoning"


def _runtime() -> SkillRuntime:
    """Two skills, nothing inlined by budget — the shipped default."""
    ifc = Skill(name=IFC, description="Am Modell messen.", body="x" * 5000, origin="platform")
    short = Skill(
        name="brandschutz",
        description="Brandabschnitt, Fluchtweg.",
        body="short",
        metadata={"grid-cards": "fire_compartment,egress_diagram,legal_basis"},
        origin="platform",
    )
    return SkillRuntime(skills=(short, ifc))


class TestTheFacts:
    def test_the_decider_is_shown_the_question_the_subject_and_the_offered_skill(self):
        state = ResearchAgentState(
            messages=[HumanMessage(content="Wie hoch?")],
            focus_file_name="EG.pdf",
            project_context="confirmed:\n- gebaeudeklasse=4\n",
        )
        facts = _turn_facts(state, _runtime())
        assert facts.question == "Wie hoch?" and facts.focus_file_name == "EG.pdf"
        # Every resolved skill is an option of the choice, the long IFC one included.
        assert facts.skills == [("brandschutz", "Brandabschnitt, Fluchtweg."), (IFC, "Am Modell messen.")]
        assert facts.project_facts == {"gebaeudeklasse": "4"}
        # The card types are the content cards beyond the taught eight.
        names = {t for t, _ in facts.card_types}
        assert "fire_compartment" in names and "legal_basis" not in names


class TestTheEffects:
    def test_the_chosen_skill_rides_the_prompt_whatever_its_size(self):
        runtime = _runtime()
        assert runtime.inlined == ()
        _apply_decisions(
            TurnDecisions(decided=True, skill=IFC, skill_p=0.9, skill_fit=0.8), ResearchAgentState(messages=[]), runtime
        )
        assert [s.name for s in runtime.inlined] == [IFC]
        block = runtime.prompt_block() or ""
        assert "x" * 100 in block and "- `brandschutz`:" in block

    def test_chosen_cards_become_the_shapes_block(self):
        state = ResearchAgentState(messages=[])
        _apply_decisions(
            TurnDecisions(decided=True, cards=(("fire_compartment", 0.9), ("stair_diagram", 0.2))), state, None
        )
        assert state.card_shapes_block and "fire_compartment" in state.card_shapes_block
        assert "stair_diagram" not in state.card_shapes_block

    def test_the_chosen_skills_preferred_shapes_beyond_the_eight_ride_the_turn(self):
        state = ResearchAgentState(messages=[])
        decided = TurnDecisions(decided=True, skill="brandschutz", skill_p=0.8, skill_fit=0.9)
        runtime = _runtime()
        _apply_decisions(decided, state, runtime)
        assert [s.name for s in runtime.inlined] == ["brandschutz"]
        block = state.card_shapes_block or ""
        assert "fire_compartment" in block and "egress_diagram" in block
        # `legal_basis` is one of the eight the envelope already teaches.
        assert '"legal_basis"' not in block

    def test_a_second_human_message_becomes_the_previous_message(self):
        state = ResearchAgentState(
            messages=[HumanMessage(content="Wie hoch ist die GK?"), HumanMessage(content="und in GK 4?")]
        )
        facts = _turn_facts(state, None)
        assert facts.question == "und in GK 4?" and facts.previous_message == "Wie hoch ist die GK?"

    def test_no_decision_changes_nothing(self):
        state = ResearchAgentState(messages=[])
        runtime = _runtime()
        _apply_decisions(TurnDecisions.none(), state, runtime)
        assert state.card_shapes_block is None
        assert runtime.inlined == ()


async def _run_turn(config: ResearchAgentConfig, decisions: TurnDecisions):
    builder = _FakeBuilder({"knowledge_search": knowledge_search})
    agent = MagicMock()
    agent.run = AsyncMock(side_effect=lambda state, turn=None: state)
    with (
        patch.object(register_module, "PilotiAgent", return_value=agent),
        patch.object(register_module, "decide_turn", new_callable=AsyncMock, return_value=decisions) as decide,
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        ResolverCls.return_value.resolve.return_value = ()
        gen = research_agent.__wrapped__(config, builder)
        info = await gen.__anext__()
        state = ResearchAgentState(messages=[HumanMessage(content="Was weißt du über die OIB 2?")])
        await info.single_fn(state)
        await gen.aclose()
    return agent.run.await_args.kwargs["turn"], state, decide


class TestTheTurn:
    async def test_the_prefetch_reaches_the_turn_config(self):
        decided = TurnDecisions(decided=True, needs_evidence=0.9, corpus="baurecht", corpus_p=0.8)
        turn, _state, decide = await _run_turn(
            ResearchAgentConfig(llm="research_llm", tools=["knowledge_search"], skills_enabled=False), decided
        )
        decide.assert_awaited_once()
        assert turn.prefetch == ({"name": "knowledge_search", "args": {"query": "Was weißt du über die OIB 2?"}},)

    async def test_switched_off_means_no_decision_and_no_prefetch(self):
        turn, _state, decide = await _run_turn(
            ResearchAgentConfig(
                llm="research_llm", tools=["knowledge_search"], skills_enabled=False, turn_decisions=False
            ),
            TurnDecisions(decided=True, needs_evidence=0.9, corpus="baurecht", corpus_p=0.8),
        )
        decide.assert_not_awaited()
        assert turn.prefetch == ()

    async def test_a_failing_decider_leaves_the_turn_as_before(self):
        builder = _FakeBuilder({"knowledge_search": knowledge_search})
        agent = MagicMock()
        agent.run = AsyncMock(side_effect=lambda state, turn=None: state)
        with (
            patch.object(register_module, "PilotiAgent", return_value=agent),
            patch.object(register_module, "decide_turn", new_callable=AsyncMock, side_effect=RuntimeError("down")),
            patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
            patch.object(register_module, "SkillResolver") as ResolverCls,
        ):
            ResolverCls.return_value.resolve.return_value = ()
            gen = research_agent.__wrapped__(
                ResearchAgentConfig(llm="research_llm", tools=["knowledge_search"], skills_enabled=False), builder
            )
            info = await gen.__anext__()
            await info.single_fn(ResearchAgentState(messages=[HumanMessage(content="Hallo")]))
            await gen.aclose()
        assert agent.run.await_args.kwargs["turn"].prefetch == ()

"""A turn whose conversation drew on another project shuts every door a whole project reads (ADR-0082).

The BFF refuses each of them on its own (a run, a task, a profile patch, a
filing, a memory write). These pin the agent's half, so the model is not
offered what will be refused: the turn learns it from the turn context or from
a lookup it just made, and then the shut-doors prompt block renders, deep
research and tasks are withdrawn, a ``project_profile_patch`` card is refused,
``remember`` saves nothing (and never offers a card that would save it through
the reader's own session), and reflection does not run.
"""

from __future__ import annotations

import io
import json
import urllib.error
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import aiq_agent.knowledge.project_memory as pm
import aiq_agent.project_context as pc
from aiq_agent.cards.envelope import REFUSED_CONFINED
from aiq_agent.cards.envelope import validate_model_card
from aiq_agent.knowledge import scoping
from aiq_agent.knowledge.restricted_use import CrossProjectTurn
from aiq_agent.knowledge.restricted_use import bind_cross_project_turn
from aiq_agent.knowledge.restricted_use import reset_cross_project_turn
from aiq_agent.memory import register as memory_register
from aiq_agent.memory.register import ProjectMemoryRememberConfig
from aiq_agent.memory.register import project_memory_remember
from aiq_agent.stages import TurnFacts
from aiq_agent.stages.memory_reflection import _handler as reflection_handler
from aiq_agent.stages.spec import StageContext
from aiq_agent.turn import context as turn_context
from aiq_agent.turn.context import TurnContext
from aiq_agent.turn.context import settle_restriction
from aiq_agent.turn.context_client import ContextBlocks
from aiq_agent.turn.context_client import _parse_blocks

PATCH = {
    "type": "project_profile_patch",
    "title": "Projektkontext aktualisieren",
    "rationale": "Laut Brief des anderen Projekts.",
    "patch": [{"op": "add", "path": "/facts/gebaeudeklasse", "value": "GK4"}],
}


@pytest.fixture
def turn():
    bound = CrossProjectTurn()
    token = bind_cross_project_turn(bound)
    yield bound
    reset_cross_project_turn(token)


def _context() -> TurnContext:
    return TurnContext(project_context=None, platform_lessons=None, org_instructions=None, stage_facts=TurnFacts())


class TestTheTurnLearnsIt:
    def test_the_turn_context_answer_says_so_and_an_older_bff_reads_as_not(self) -> None:
        base = {"projectContext": None, "projectMemory": None, "orgInstructions": None}

        assert _parse_blocks({"data": {**base, "drewOnOtherProjects": True}}).drew_on_other_projects is True
        assert _parse_blocks({"data": base}).drew_on_other_projects is False

    async def test_loading_the_context_marks_the_turn(self, monkeypatch, turn) -> None:
        async def blocks(*_args, **_kwargs) -> ContextBlocks:
            return ContextBlocks(None, None, None, drew_on_other_projects=True)

        async def nothing(*_args, **_kwargs):
            return None

        monkeypatch.setattr(turn_context, "_context_blocks", blocks)
        monkeypatch.setattr(turn_context, "_platform_lessons", nothing)
        monkeypatch.setattr(
            turn_context,
            "_turn_flags",
            lambda *_a, **_k: _awaitable(
                SimpleNamespace(deep_research_allowed=True, tasks_allowed=True, enabled_stages=())
            ),
        )
        request = SimpleNamespace(organization_id="org", project_id="p1", user_id="u1", bundesland=None)

        await turn_context._load_turn_context(request, conversation_id="c1", query_text="q", resolve_stages=False)

        assert turn.drew_on_others

    def test_a_marked_turn_is_confined_and_offers_no_run_and_no_task(self, turn) -> None:
        request = SimpleNamespace(envelope_header=None, collection_scope=None)
        assert settle_restriction(_context(), request).confined is False

        turn.drew_on_others = True
        settled = settle_restriction(_context(), request)

        assert settled.confined
        assert not settled.deep_research_allowed
        assert not settled.tasks_allowed


async def _awaitable(value):
    return value


class TestTheDoorsStayShut:
    def test_a_profile_patch_card_is_refused(self, monkeypatch, turn) -> None:
        monkeypatch.setattr(scoping, "get_collection_scope_from_context", lambda: ["proj_p1"])
        assert validate_model_card(dict(PATCH))[1] is None

        turn.drew_on_others = True
        card, refusal = validate_model_card(dict(PATCH))

        assert card is None
        assert refusal is not None and refusal.kind == REFUSED_CONFINED

    async def test_remember_saves_nothing_and_says_why(self, monkeypatch, turn) -> None:
        monkeypatch.setattr(pc, "get_project_id_from_context", lambda: "p1")
        monkeypatch.setattr(pc, "get_organization_id_from_context", lambda: "o1")
        monkeypatch.setattr(pc, "get_conversation_id_from_context", lambda: "c1")
        insert = MagicMock(return_value="item-1")
        monkeypatch.setattr(pm, "insert_memory_item", insert)
        turn.drew_on_others = True

        async with project_memory_remember(ProjectMemoryRememberConfig(), MagicMock()) as info:
            result = await info.single_fn(info.input_schema(kind="derived_fact", content="Traufe hinterlüftet."))

        assert "andere Projekte" in result
        insert.assert_not_called()

    def test_a_refused_write_never_becomes_a_card_that_would_save_it_anyway(self, monkeypatch) -> None:
        cards = MagicMock(return_value=True)
        monkeypatch.setattr(memory_register, "_emit_memory_proposal_card", cards)

        result = memory_register._failure_result(
            pm.CrossProjectMemoryRefusedError("drew on another project"),
            scope="organization",
            kind="derived_fact",
            content="x",
            confidence="medium",
        )

        assert "andere Projekte" in result
        cards.assert_not_called()

    def test_the_memory_client_names_the_bffs_refusal(self, monkeypatch) -> None:
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        refusal = urllib.error.HTTPError(
            "http://frontend/api/internal/memory",
            409,
            "Conflict",
            {},
            io.BytesIO(json.dumps({"error": "…", "code": "CROSS_PROJECT_MEMORY"}).encode()),
        )
        monkeypatch.setattr(pm._opener, "open", MagicMock(side_effect=refusal))

        with pytest.raises(pm.CrossProjectMemoryRefusedError):
            pm.insert_memory_item(
                scope="project",
                project_id="p1",
                organization_id="o1",
                kind="derived_fact",
                content="Traufe hinterlüftet.",
            )

    async def test_reflection_does_not_run(self, monkeypatch) -> None:
        from aiq_agent.memory import reflection

        run = MagicMock(side_effect=AssertionError("reflection must not run"))
        monkeypatch.setattr(reflection, "run_memory_reflection", run)

        result = await reflection_handler(StageContext(facts=TurnFacts(drew_on_other_projects=True), llm=object()))

        assert result is None
        run.assert_not_called()

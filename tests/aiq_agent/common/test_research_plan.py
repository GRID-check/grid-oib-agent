"""The Python mirror of the research plan validates against the BFF's own schema.

The zod source in ``frontends/ui/src/lib/plans/plan-types.ts`` is exported to
``tests/fixtures/research-plan.schema.json``; a model here that the schema
refuses is a plan the BFF would answer 400 to.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from aiq_agent.common.plan_documents import PlanDocument
from aiq_agent.common.research_plan import PLAN_GENRES
from aiq_agent.common.research_plan import PLAN_STATUSES
from aiq_agent.common.research_plan import ResearchPlan
from aiq_agent.common.research_plan import ResearchPlanDraft

SCHEMA_PATH = (
    Path(__file__).resolve().parents[3] / "frontends" / "ui" / "tests" / "fixtures" / "research-plan.schema.json"
)


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    with SCHEMA_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def _validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]})


def _plan(**overrides: Any) -> ResearchPlan:
    base: dict[str, Any] = {
        "id": "8b2d3f10-6f1a-4a4e-9a4e-2f0f1a6d9c31",
        "projectId": "11111111-1111-4111-8111-111111111111",
        "conversationId": "s_conv",
        "runId": None,
        "author": "agent",
        "status": "proposed",
        "question": "Fluchtwege im Bestand prüfen",
        "title": "Fluchtwege im Bestand",
        "sections": ["Bestand", "Anforderungen OIB 2", "Befund"],
        "genre": "pruefbericht",
        "depth": "gutachten",
        "grundlage": [PlanDocument(name="Einreichplan.pdf", shelf="project")],
        "ausgeschlossen": [],
        "dataSources": ["knowledge_search"],
        "unterlagen": [PlanDocument(name="Einreichplan.pdf", title="Einreichplan", shelf="project")],
        "startsAt": "2026-09-22T08:00:45.000Z",
        "createdAt": "2026-09-22T08:00:00.000Z",
        "updatedAt": "2026-09-22T08:00:00.000Z",
    }
    base.update(overrides)
    return ResearchPlan(**base)


class TestTheWire:
    def test_the_fixture_is_where_the_contract_lives(self, schema: dict[str, Any]) -> None:
        assert set(schema["$defs"]) == {"researchPlan", "researchPlanDraft", "researchPlanEdit"}

    def test_a_plan_this_tier_builds_is_one_the_bff_accepts(self, schema: dict[str, Any]) -> None:
        _validator(schema, "researchPlan").validate(_plan().to_wire())

    def test_a_draft_the_clarifier_proposes_is_one_the_bff_accepts(self, schema: dict[str, Any]) -> None:
        draft = ResearchPlanDraft(
            question="Fluchtwege im Bestand prüfen",
            title="Fluchtwege",
            sections=["Bestand", "Befund"],
            genre="pruefbericht",
            grundlage=["Einreichplan.pdf"],
            unterlagen=[PlanDocument(name="Einreichplan.pdf", shelf="project")],
        )
        _validator(schema, "researchPlanDraft").validate(draft.to_wire())

    def test_both_vocabularies_are_the_schemas(self, schema: dict[str, Any]) -> None:
        properties = schema["$defs"]["researchPlan"]["properties"]
        assert tuple(properties["status"]["enum"]) == PLAN_STATUSES
        assert tuple(properties["genre"]["enum"]) == PLAN_GENRES

    def test_a_plan_with_nothing_named_carries_no_documents(self) -> None:
        assert _plan(grundlage=[], ausgeschlossen=[]).documents() is None
        docs = _plan().documents()
        assert docs is not None and [d.name for d in docs.grundlage] == ["Einreichplan.pdf"]

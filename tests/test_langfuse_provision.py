"""``task langfuse:provision``: what Grid declares in Langfuse, and what it would change (ADR-0089)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

from aiq_agent.observability.langfuse_catalog import JUDGES
from aiq_agent.observability.langfuse_catalog import QUEUES
from aiq_agent.observability.langfuse_catalog import RULES
from aiq_agent.observability.langfuse_catalog import golden_dataset_items
from aiq_agent.observability.langfuse_scores import SCORE_DEFINITIONS

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


provision = _load("scripts.langfuse_provision", "scripts/langfuse_provision.py")
DEFINED = {definition.name: definition for definition in SCORE_DEFINITIONS}


def _config(definition, **overrides):
    fields = {
        "name": definition.name,
        "data_type": definition.data_type,
        "categories": [SimpleNamespace(label=label) for label in definition.categories],
        "is_archived": False,
    }
    fields.update(overrides)
    return SimpleNamespace(**fields)


def _state(**overrides):
    state = {
        "score_configs": [],
        "queues": [],
        "evaluators": [],
        "rules": [],
        "llm_connections": 1,
        "dataset": False,
        "dataset_item_ids": [],
    }
    state.update(overrides)
    return state


class TestPlan:
    def test_an_empty_project_gets_everything(self):
        plan = provision.plan_against(_state())

        assert [definition.name for definition in plan.score_configs] == list(DEFINED)
        assert plan.queues == [queue.name for queue in QUEUES]
        assert plan.judges == [judge.name for judge in JUDGES]
        assert plan.rules == [rule.name for rule in RULES]
        assert plan.dataset
        assert len(plan.dataset_items) == len(golden_dataset_items(REPO_ROOT))

    def test_a_provisioned_project_is_left_alone(self):
        state = _state(
            score_configs=[_config(definition) for definition in SCORE_DEFINITIONS],
            queues=[SimpleNamespace(name=queue.name) for queue in QUEUES],
            evaluators=[SimpleNamespace(name=judge.name) for judge in JUDGES],
            rules=[SimpleNamespace(name=rule.name) for rule in RULES],
            dataset=True,
            dataset_item_ids=[item["id"] for item in golden_dataset_items(REPO_ROOT)],
        )

        plan = provision.plan_against(state)

        assert plan.is_empty()
        assert not plan.drift
        assert provision.render(plan).startswith("Nothing to change")

    def test_a_config_that_differs_is_drift_for_a_person_not_an_overwrite(self):
        reason = DEFINED["user-feedback-reason"]
        state = _state(score_configs=[_config(reason, categories=[SimpleNamespace(label="inaccurate")])])

        plan = provision.plan_against(state)

        assert reason not in plan.score_configs
        assert any("user-feedback-reason" in drift for drift in plan.drift)

    def test_judges_without_a_model_say_so(self):
        plan = provision.plan_against(_state(llm_connections=0))

        assert any("LLM connection" in note for note in plan.notes)


class TestCatalog:
    """The catalog refers to scores by name; a typo would fail only against a live Langfuse."""

    def test_queue_scores_are_reviewer_scores(self):
        for queue in QUEUES:
            assert {DEFINED[name].writer for name in queue.score_names} == {"annotation"}

    def test_every_judge_writes_a_defined_judge_score(self):
        for judge in JUDGES:
            assert DEFINED[judge.name].writer == "judge"

    def test_every_judge_variable_appears_in_its_prompt(self):
        for judge in JUDGES:
            for variable in judge.variables:
                assert f"{{{{{variable}}}}}" in judge.prompt, (judge.name, variable)

    def test_rules_are_written_in_filters_langfuse_accepts(self):
        from langfuse.api.evaluation_commons.types.evaluation_rule_filter import EvaluationRuleFilter
        from pydantic import TypeAdapter

        for rule in RULES:
            for condition in rule.filter:
                TypeAdapter(EvaluationRuleFilter).validate_python(condition)

    def test_judge_outputs_build(self):
        for judge in JUDGES:
            provision._output_definition(DEFINED[judge.name])
            provision._variable_mapping(judge)

    def test_golden_items_have_stable_unique_ids(self):
        items = golden_dataset_items(REPO_ROOT)

        assert len({item["id"] for item in items}) == len(items)
        assert all(item["input"]["text"] for item in items)

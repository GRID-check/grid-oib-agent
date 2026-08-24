"""Tests for the compliance-checker pydantic contracts."""

import pytest
from pydantic import ValidationError

from aiq_agent.agents.compliance_checker.models import ComplianceCheckAgentState
from aiq_agent.agents.compliance_checker.models import ComplianceCheckRequest
from aiq_agent.agents.compliance_checker.models import EvidenceBatchResult
from aiq_agent.agents.compliance_checker.models import GapItem
from aiq_agent.agents.compliance_checker.models import RequirementItem
from aiq_agent.agents.compliance_checker.models import RequirementProfile


def _walk_strict_mode_unsupported_keys(node: object, path: str = "$") -> list[str]:
    """Recursively collect JSON-Schema keys that strict json_schema mode rejects.

    Mirrors tests/aiq_agent/agents/deep_researcher/models/test_subagent_contracts.py.
    """
    unsupported = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern"}
    hits: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key in unsupported:
                hits.append(f"{path}.{key}")
            hits.extend(_walk_strict_mode_unsupported_keys(value, f"{path}.{key}"))
    elif isinstance(node, list):
        for index, item in enumerate(node):
            hits.extend(_walk_strict_mode_unsupported_keys(item, f"{path}[{index}]"))
    return hits


@pytest.mark.parametrize("schema_cls", [RequirementProfile, EvidenceBatchResult])
def test_llm_facing_schemas_have_no_strict_mode_unsupported_constraints(schema_cls):
    """RequirementProfile and EvidenceBatchResult are the only schemas sent to an LLM as structured output."""
    schema = schema_cls.model_json_schema()
    hits = _walk_strict_mode_unsupported_keys(schema)
    assert hits == [], f"{schema_cls.__name__}: strict-mode-unsupported schema constraints found: {hits}"


def test_gap_item_is_not_llm_facing_so_ge_le_is_fine():
    """GapItem.risk_score is a Stage 3 pure-Python computation -- ge/le is fine here on purpose."""
    schema = GapItem.model_json_schema()
    hits = _walk_strict_mode_unsupported_keys(schema)
    assert sorted(hits) == ["$.properties.risk_score.maximum", "$.properties.risk_score.minimum"]


def test_requirement_item_validates_expected_shape():
    item = RequirementItem.model_validate(
        {
            "id": "R1-3.1.2",
            "richtlinie": 1,
            "punkt": "3.1.2",
            "requirement": "Tragwerk muss rechnerisch nachgewiesen werden.",
            "applicability": "anwendbar",
            "rationale": "Neubau mit tragenden Waenden.",
        }
    )
    assert item.richtlinie == 1
    assert item.applicability == "anwendbar"


def test_requirement_item_rejects_out_of_range_richtlinie():
    with pytest.raises(ValidationError):
        RequirementItem.model_validate(
            {
                "id": "R9-1",
                "richtlinie": 9,
                "punkt": "1",
                "requirement": "x",
                "applicability": "anwendbar",
                "rationale": "x",
            }
        )


def test_requirement_profile_rejects_extra_fields():
    with pytest.raises(ValidationError):
        RequirementProfile.model_validate(
            {
                "richtlinie": 1,
                "scope_notes": "x",
                "requirements": [],
                "unexpected": "value",
            }
        )


def test_requirement_profile_rejects_out_of_range_richtlinie():
    with pytest.raises(ValidationError):
        RequirementProfile.model_validate({"richtlinie": 0, "scope_notes": "x", "requirements": []})


def test_evidence_batch_result_validates_expected_shape():
    result = EvidenceBatchResult.model_validate(
        {
            "findings": [
                {
                    "requirement_id": "R1-3.1.2",
                    "status": "erfuellt",
                    "evidence_quotes": ["Statiknachweis liegt vor."],
                    "source_files": ["statik.pdf"],
                    "confidence": "high",
                    "reasoning": "Statiknachweis deckt die Anforderung ab.",
                    "open_question": None,
                }
            ]
        }
    )
    assert result.findings[0].status == "erfuellt"
    assert result.findings[0].open_question is None


def test_evidence_batch_result_rejects_extra_fields():
    with pytest.raises(ValidationError):
        EvidenceBatchResult.model_validate({"findings": [], "unexpected": "value"})


class TestComplianceCheckRequest:
    """ComplianceCheckRequest is a pipeline input, not LLM-facing -- ge/le-style validation is fine."""

    def test_default_richtlinien_is_all_six(self):
        request = ComplianceCheckRequest()
        assert request.richtlinien == [1, 2, 3, 4, 5, 6]

    def test_empty_richtlinien_defaults_to_all(self):
        request = ComplianceCheckRequest(richtlinien=[])
        assert request.richtlinien == [1, 2, 3, 4, 5, 6]

    def test_richtlinien_deduped_and_sorted(self):
        request = ComplianceCheckRequest(richtlinien=[3, 1, 3, 2])
        assert request.richtlinien == [1, 2, 3]

    def test_rejects_out_of_range_richtlinie(self):
        with pytest.raises(ValidationError):
            ComplianceCheckRequest(richtlinien=[0])
        with pytest.raises(ValidationError):
            ComplianceCheckRequest(richtlinien=[7])

    def test_project_descriptors_default_empty_dict(self):
        request = ComplianceCheckRequest()
        assert request.project_descriptors == {}


class TestComplianceCheckAgentState:
    def test_defaults(self):
        state = ComplianceCheckAgentState()
        assert state.messages == []
        assert state.richtlinien is None
        assert state.project_descriptors == {}

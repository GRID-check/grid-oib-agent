"""Tests for deep researcher structured response contracts."""

import pytest
from pydantic import ValidationError

from aiq_agent.agents.deep_researcher.models import AnswerStrategy
from aiq_agent.agents.deep_researcher.models import Constraint
from aiq_agent.agents.deep_researcher.models import EvidenceJudgment
from aiq_agent.agents.deep_researcher.models import ResearchNotes
from aiq_agent.agents.deep_researcher.models import ResearchPlan
from aiq_agent.agents.deep_researcher.models import ResearchQuery
from aiq_agent.agents.deep_researcher.models import SourceRoutingPlan


def _answer_strategy() -> dict:
    return {
        "answer_type": "comparison",
        "title": "CUDA and OpenCL Trade-offs",
        "required_components": [
            {
                "id": "programming_model",
                "name": "Programming model",
                "description": "Compare kernel, memory, and execution models.",
            }
        ],
    }


def _task_analysis() -> dict:
    return {
        "user_intent": "Understand CUDA and OpenCL trade-offs.",
        "explicit_requirements": ["Compare CUDA and OpenCL"],
        "implicit_requirements": ["Cover ecosystem and portability"],
        "out_of_scope": ["General GPU purchasing advice"],
        "language": "English",
    }


def test_research_plan_contract_validates_expected_shape():
    plan = ResearchPlan.model_validate(
        {
            "task_analysis": _task_analysis(),
            "answer_strategy": _answer_strategy(),
            "constraints": [
                {
                    "category": "content",
                    "constraint": "Compare portability, performance, and ecosystem maturity.",
                    "rationale": "These dimensions determine practical adoption.",
                }
            ],
            "queries": [
                {
                    "query": "CUDA OpenCL portability performance ecosystem comparison",
                    "subqueries": ["CUDA OpenCL portability", "CUDA OpenCL benchmark comparison"],
                    "preferred_tools": ["web_search_tool"],
                    "fallback_tools": [],
                    "target_components": ["programming_model"],
                    "rationale": "Supports the comparison component.",
                }
            ],
        }
    )

    assert plan.answer_strategy.required_components[0].id == "programming_model"
    assert plan.constraints[0].category == "content"
    assert plan.queries[0].target_components == ["programming_model"]
    assert plan.queries[0].subqueries == ["CUDA OpenCL portability", "CUDA OpenCL benchmark comparison"]
    assert plan.queries[0].preferred_tools == ["web_search_tool"]
    assert plan.queries[0].fallback_tools == []


def test_research_plan_contract_accepts_prediction_answer_type():
    answer_strategy = _answer_strategy()
    answer_strategy["answer_type"] = "prediction"
    answer_strategy["title"] = "Election Forecast"

    plan = ResearchPlan.model_validate(
        {
            "task_analysis": _task_analysis(),
            "answer_strategy": answer_strategy,
            "constraints": [],
            "queries": [
                {
                    "query": "Example election forecast evidence",
                    "subqueries": [],
                    "preferred_tools": ["polymarket_search_tool"],
                    "fallback_tools": [],
                    "target_components": ["programming_model"],
                    "rationale": "Supports the forecast evidence component.",
                }
            ],
        }
    )

    assert plan.answer_strategy.answer_type == "prediction"
    assert plan.queries[0].preferred_tools == ["polymarket_search_tool"]


def test_reduced_answer_strategy_contract_validates():
    strategy = AnswerStrategy.model_validate(_answer_strategy())

    assert strategy.answer_type == "comparison"
    assert strategy.title == "CUDA and OpenCL Trade-offs"
    assert strategy.required_components[0].id == "programming_model"


def test_constraint_contract_rejects_verification_field():
    with pytest.raises(ValidationError):
        Constraint.model_validate(
            {
                "category": "content",
                "constraint": "Compare portability, performance, and ecosystem maturity.",
                "rationale": "These dimensions determine practical adoption.",
                "verification": "Each dimension appears in the final answer.",
            }
        )


def test_research_notes_contract_validates_expected_shape():
    notes = ResearchNotes.model_validate(
        {
            "query_topic": "CUDA vs OpenCL portability",
            "target_components": ["programming_model"],
            "summary": "CUDA is NVIDIA-specific while OpenCL targets cross-vendor portability.",
            "findings": [
                {
                    "claim": "OpenCL is designed for cross-vendor heterogeneous compute.",
                    "evidence": "The source describes OpenCL as an open standard for heterogeneous platforms.",
                    "source_ids": [1],
                    "confidence": "high",
                    "caveats": ["Portability does not guarantee equal performance across vendors."],
                }
            ],
            "gaps": [
                {
                    "description": "Recent benchmark coverage is sparse.",
                    "impact": "Limits quantitative comparison.",
                    "suggested_follow_up_queries": ["CUDA OpenCL benchmark 2026"],
                }
            ],
            "sources": [
                {
                    "id": 1,
                    "title": "OpenCL Overview",
                    "source_type": "url",
                    "locator": "https://example.test/opencl",
                }
            ],
            "narrative_notes": "OpenCL offers broader portability, while CUDA typically has deeper vendor tooling.",
            "language": "English",
            "evidence_judgment": None,
        }
    )

    assert notes.target_components == ["programming_model"]
    assert notes.findings[0].source_ids == [1]
    assert notes.sources[0].source_type == "url"
    assert notes.sources[0].locator == "https://example.test/opencl"
    assert notes.evidence_judgment is None


def test_research_notes_contract_accepts_evidence_judgment():
    notes = ResearchNotes.model_validate(
        {
            "query_topic": "CUDA vs OpenCL portability",
            "target_components": ["programming_model"],
            "summary": "CUDA is NVIDIA-specific while OpenCL targets portability.",
            "findings": [],
            "gaps": [],
            "sources": [],
            "narrative_notes": "OpenCL offers broader portability.",
            "language": "English",
            "evidence_judgment": {
                "relevance_score": 85,
                "confidence": "high",
                "rationale": "Directly supports the programming model component.",
            },
        }
    )

    assert notes.evidence_judgment is not None
    assert notes.evidence_judgment.relevance_score == 85
    assert notes.evidence_judgment.confidence == "high"


def test_evidence_judgment_contract_clamps_out_of_range_score():
    """Out-of-range scores degrade to the nearest bound instead of failing the worker.

    relevance_score dropped its Field(ge=0, le=100) constraint because strict
    json_schema structured-output mode does not support JSON-Schema
    minimum/maximum, so the range is now enforced by a field_validator that
    clamps instead of raising.
    """
    high = EvidenceJudgment.model_validate(
        {
            "relevance_score": 150,
            "confidence": "high",
            "rationale": "Score must stay within the configured range.",
        }
    )
    assert high.relevance_score == 100

    low = EvidenceJudgment.model_validate(
        {
            "relevance_score": -5,
            "confidence": "high",
            "rationale": "Score must stay within the configured range.",
        }
    )
    assert low.relevance_score == 0

    in_range = EvidenceJudgment.model_validate(
        {
            "relevance_score": 42,
            "confidence": "high",
            "rationale": "Score must stay within the configured range.",
        }
    )
    assert in_range.relevance_score == 42


def test_research_query_contract_rejects_empty_preferred_tools():
    """preferred_tools lost its Field(min_length=1) for the same strict-mode reason.

    Unlike relevance_score, an empty tool list cannot be clamped to something
    valid, so the field_validator still raises -- matching the previous
    Field(min_length=1) failure semantics.
    """
    with pytest.raises(ValidationError):
        ResearchQuery.model_validate(
            {
                "query": "Example query",
                "subqueries": [],
                "preferred_tools": [],
                "fallback_tools": [],
                "target_components": ["overview"],
                "rationale": "coverage",
            }
        )


def _walk_strict_mode_unsupported_keys(node: object, path: str = "$") -> list[str]:
    """Recursively collect JSON-Schema keys that strict json_schema mode rejects."""
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


def test_research_notes_schema_has_no_strict_mode_unsupported_constraints():
    """ResearchNotes.model_json_schema() must not emit minimum/maximum/etc anywhere in its tree.

    Field(ge=..., le=...) and friends compile to JSON-Schema keywords that
    strict json_schema structured-output mode does not support; langchain's
    ProviderStrategy ships the schema verbatim without sanitizing them, which
    can 400 or otherwise misbehave for researcher-worker structured
    responses (ResearchNotes nests EvidenceJudgment). field_validator-based
    enforcement (see EvidenceJudgment.relevance_score) does not appear in
    model_json_schema(), so this should find nothing.
    """
    schema = ResearchNotes.model_json_schema()
    hits = _walk_strict_mode_unsupported_keys(schema)
    assert hits == [], f"strict-mode-unsupported schema constraints found: {hits}"


def test_research_plan_schema_has_no_strict_mode_unsupported_constraints():
    """Re-verify ResearchPlan is clean now that ResearchQuery.preferred_tools lost its min_length."""
    schema = ResearchPlan.model_json_schema()
    hits = _walk_strict_mode_unsupported_keys(schema)
    assert hits == [], f"strict-mode-unsupported schema constraints found: {hits}"


def test_source_routing_plan_contract_validates_expected_shape():
    route = SourceRoutingPlan.model_validate(
        {
            "domain_id": "current_news",
            "domain_name": "Current News",
            "routing_reason": "The user asks for recent developments.",
            "recommendations": [
                {
                    "source_id": "news_search",
                    "tool_names": ["duckduckgo_news_search_tool"],
                    "priority": 1,
                    "rationale": "Best fit for recent news.",
                }
            ],
            "fallback_sources": [
                {
                    "source_id": "web_search",
                    "tool_names": ["web_search_tool"],
                    "priority": 2,
                    "rationale": "Broad web fallback.",
                }
            ],
            "planner_guidance": "Use news_search first, then web_search if coverage is weak.",
        }
    )

    assert route.domain_id == "current_news"
    assert route.recommendations[0].tool_names == ["duckduckgo_news_search_tool"]


def test_subagent_contracts_reject_extra_fields_and_old_plan_shape():
    with pytest.raises(ValidationError):
        ResearchPlan.model_validate(
            {
                "task_analysis": _task_analysis(),
                "answer_strategy": _answer_strategy(),
                "constraints": [],
                "queries": [],
                "unexpected": "value",
            }
        )

    with pytest.raises(ValidationError):
        ResearchPlan.model_validate(
            {
                "task_analysis": _task_analysis(),
                "report_title": "Title",
                "report_toc": [],
                "constraints": [],
                "queries": [],
            }
        )

    with pytest.raises(ValidationError):
        ResearchNotes.model_validate(
            {
                "query_topic": "CUDA vs OpenCL portability",
                "target_sections": ["Programming Model Differences"],
                "summary": "Old field should fail.",
                "findings": [],
                "gaps": [],
                "sources": [],
                "narrative_notes": "",
                "language": "English",
            }
        )

    for removed_field, value in (
        ("assembly_instruction", "Synthesize evidence into a comparison."),
        ("selection_mode", "none"),
        ("expected_count", None),
        ("options", []),
    ):
        old_strategy = _answer_strategy()
        old_strategy[removed_field] = value
        with pytest.raises(ValidationError):
            AnswerStrategy.model_validate(old_strategy)

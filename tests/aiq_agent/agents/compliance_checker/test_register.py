"""Tests for the compliance-check agent NAT registration config."""

import pytest
from pydantic import ValidationError

from aiq_agent.agents.compliance_checker.register import ComplianceCheckAgentConfig


class TestComplianceCheckAgentConfig:
    """Tests for the ComplianceCheckAgentConfig model."""

    def test_config_with_required_fields(self):
        config = ComplianceCheckAgentConfig(llm="test_llm", knowledge_search_tool="knowledge_search")

        assert config.llm == "test_llm"
        assert config.knowledge_search_tool == "knowledge_search"
        assert config.max_concurrency == 3
        assert config.richtlinien == [1, 2, 3, 4, 5, 6]
        assert config.requirement_batch_size == 9
        assert config.verbose is False

    def test_config_with_all_fields(self):
        config = ComplianceCheckAgentConfig(
            llm="test_llm",
            knowledge_search_tool="knowledge_search",
            max_concurrency=5,
            richtlinien=[2, 4],
            requirement_batch_size=6,
            verbose=True,
        )

        assert config.max_concurrency == 5
        assert config.richtlinien == [2, 4]
        assert config.requirement_batch_size == 6
        assert config.verbose is True

    def test_config_requires_llm(self):
        with pytest.raises(ValidationError):
            ComplianceCheckAgentConfig(knowledge_search_tool="knowledge_search")

    def test_config_requires_knowledge_search_tool(self):
        with pytest.raises(ValidationError):
            ComplianceCheckAgentConfig(llm="test_llm")

    def test_config_rejects_invalid_richtlinien(self):
        with pytest.raises(ValidationError):
            ComplianceCheckAgentConfig(llm="test_llm", knowledge_search_tool="knowledge_search", richtlinien=[7])

    def test_config_empty_richtlinien_defaults_to_all(self):
        config = ComplianceCheckAgentConfig(llm="test_llm", knowledge_search_tool="knowledge_search", richtlinien=[])
        assert config.richtlinien == [1, 2, 3, 4, 5, 6]

    def test_config_richtlinien_default_factory_is_independent_per_instance(self):
        config1 = ComplianceCheckAgentConfig(llm="llm", knowledge_search_tool="ks")
        config2 = ComplianceCheckAgentConfig(llm="llm", knowledge_search_tool="ks")
        assert config1.richtlinien is not config2.richtlinien

    def test_config_inherits_from_function_base_config(self):
        from nat.data_models.function import FunctionBaseConfig

        assert issubclass(ComplianceCheckAgentConfig, FunctionBaseConfig)

    def test_config_field_descriptions(self):
        fields = ComplianceCheckAgentConfig.model_fields
        assert fields["llm"].description is not None
        assert fields["knowledge_search_tool"].description is not None
        assert fields["max_concurrency"].description is not None
        assert fields["richtlinien"].description is not None

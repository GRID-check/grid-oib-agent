"""Tests for the compliance-check NAT registration: the config model and the context reads."""

import pytest
from pydantic import ValidationError

from aiq_agent.agents.compliance_checker import register
from aiq_agent.agents.compliance_checker.register import ComplianceCheckAgentConfig
from aiq_agent.agents.compliance_checker.register import ComplianceCheckInput
from aiq_agent.agents.compliance_checker.register import project_documents_in_scope
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.scoping import ScopedCollection


class TestComplianceCheckAgentConfig:
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


def test_tool_input_has_no_dead_focus_field():
    assert set(ComplianceCheckInput.model_fields) == {"richtlinien"}


class TestProjectDocumentsInScope:
    """Defect (a), the guard half: the tool searches everything when a shelf restriction empties its scope."""

    def test_missing_header_means_legacy_layers_and_is_kept(self, monkeypatch):
        monkeypatch.setattr(register, "get_scoped_collections_from_context", lambda: None)
        assert project_documents_in_scope() is True

    def test_base_only_scope_has_nothing_to_judge_against(self, monkeypatch):
        scope = [ScopedCollection("oib_corpus", Shelf.BASE)]
        monkeypatch.setattr(register, "get_scoped_collections_from_context", lambda: scope)
        assert project_documents_in_scope() is False

    @pytest.mark.parametrize("shelf", [Shelf.PROJECT, Shelf.SESSION, None])
    def test_project_session_or_unknown_shelf_counts(self, monkeypatch, shelf):
        scope = [ScopedCollection("oib_corpus", Shelf.BASE), ScopedCollection("proj_alpha", shelf)]
        monkeypatch.setattr(register, "get_scoped_collections_from_context", lambda: scope)
        assert project_documents_in_scope() is True

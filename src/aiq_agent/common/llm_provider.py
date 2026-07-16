"""LLM Provider for role-based LLM access and A/B testing."""

import logging
from collections.abc import Mapping
from enum import StrEnum

from langchain_core.language_models import BaseChatModel

from aiq_agent.common.model_overrides import AgentGroup
from aiq_agent.common.model_overrides import override_model

logger = logging.getLogger(__name__)


class LLMRole(StrEnum):
    """
    Semantic roles for LLMs in the research workflow.

    Allows mapping different LLM configurations to different roles
    for A/B testing and cost optimization.
    """

    ROUTER = "router"
    PLANNER = "planner"
    RESEARCHER = "researcher"
    EVIDENCE_JUDGE = "evidence_judge"
    GRADER = "grader"
    SUMMARIZER = "summarizer"
    ORCHESTRATOR = "orchestrator"
    REFLECTION = "reflection"
    CLARIFIER = "clarifier"
    META_CHATTER = "meta_chatter"
    REPORT_WRITER = "report_writer"


class LLMProvider:
    """
    Role-based LLM provider for A/B testing different models per role.

    Allows configuring different LLMs for different semantic roles in
    the research workflow. Falls back to a default LLM if no specific
    LLM is configured for a role.

    Example:
        >>> provider = LLMProvider()
        >>> provider.set_default(nim_llm)
        >>> provider.configure(LLMRole.REPORT_WRITER, qwen_llm)
        >>>
        >>> # Uses qwen_llm
        >>> writer_llm = provider.get(LLMRole.REPORT_WRITER)
        >>>
        >>> # Falls back to nim_llm
        >>> router_llm = provider.get(LLMRole.ROUTER)
    """

    def __init__(self) -> None:
        self._llms: dict[LLMRole, BaseChatModel] = {}
        self._default: BaseChatModel | None = None
        # Agent-group tags used by with_model_overrides() to apply per-org
        # runtime model overrides (see aiq_agent.common.model_overrides).
        self._groups: dict[LLMRole, AgentGroup] = {}
        self._default_group: AgentGroup | None = None

    def set_default(self, llm: BaseChatModel, group: AgentGroup | None = None) -> None:
        """
        Set the default LLM for roles that don't have a specific configuration.

        Args:
            llm: The LangChain chat model to use as default.
            group: Optional agent group this default belongs to, making it
                eligible for per-org runtime model overrides.
        """
        self._default = llm
        self._default_group = group

    def configure(self, role: LLMRole, llm: BaseChatModel, group: AgentGroup | None = None) -> None:
        """
        Configure a specific LLM for a role.

        Args:
            role: The semantic role to configure.
            llm: The LangChain chat model to use for this role.
            group: Optional agent group this role belongs to, making it
                eligible for per-org runtime model overrides.
        """
        self._llms[role] = llm
        if group is not None:
            self._groups[role] = group

    def get(self, role: LLMRole) -> BaseChatModel:
        """
        Get the LLM configured for a role.

        Args:
            role: The semantic role to get the LLM for.

        Returns:
            The LangChain chat model for this role.

        Raises:
            ValueError: If no LLM is configured for the role and no default is set.
        """
        if role in self._llms:
            return self._llms[role]
        if self._default is not None:
            return self._default
        raise ValueError(
            f"No LLM configured for role '{role}' and no default LLM set. Call set_default() or configure() first."
        )

    def with_model_overrides(self, overrides: Mapping[str, str]) -> "LLMProvider":
        """Return a provider with per-org model overrides applied per group.

        Returns ``self`` unchanged when no override targets any group this
        provider was tagged with, so callers can cheaply detect "nothing to
        do" via an identity check (mirroring the tools-filtering pattern in
        the agent registrations). The returned provider copies each affected
        LLM via ``model_copy`` — the original build-time provider is never
        mutated, keeping overrides strictly request-scoped.
        """
        override_groups = {g for g in AgentGroup if g.value in overrides}
        tagged_groups = {g for g in (self._default_group, *self._groups.values()) if g is not None}
        applied_groups = override_groups & tagged_groups
        if not applied_groups:
            return self

        # Observability: this per-group override path (used by the async deep
        # research worker) was previously silent, unlike apply_model_override.
        # Log which groups actually take an override so a run can be diagnosed.
        logger.info(
            "Applying model overrides: %s",
            {g.value: overrides[g.value] for g in sorted(applied_groups, key=lambda g: g.value)},
        )

        derived = LLMProvider()
        derived._groups = dict(self._groups)
        derived._default_group = self._default_group

        def _resolve(llm: BaseChatModel, group: AgentGroup | None) -> BaseChatModel:
            model_id = overrides.get(group.value) if group is not None else None
            return override_model(llm, model_id) if model_id else llm

        if self._default is not None:
            derived._default = _resolve(self._default, self._default_group)
        for role, llm in self._llms.items():
            derived._llms[role] = _resolve(llm, self._groups.get(role))
        return derived

    def with_credential(self, credential) -> "LLMProvider":
        """Return a provider whose every LLM uses the org's BYOK credential.

        Unlike model overrides, a credential applies to ALL groups — BYOK
        re-points the whole tenant's traffic (ADR-0022). Returns ``self``
        when there is no credential. LLM instances shared between roles are
        rebuilt once (identity-deduped) so the derived provider preserves
        the original sharing topology.
        """
        if credential is None:
            return self

        from aiq_agent.common.llm_credentials import apply_org_credential

        rebuilt: dict[int, BaseChatModel] = {}

        def _resolve(llm: BaseChatModel) -> BaseChatModel:
            key = id(llm)
            if key not in rebuilt:
                rebuilt[key] = apply_org_credential(llm, credential)
            return rebuilt[key]

        derived = LLMProvider()
        derived._groups = dict(self._groups)
        derived._default_group = self._default_group
        if self._default is not None:
            derived._default = _resolve(self._default)
        for role, llm in self._llms.items():
            derived._llms[role] = _resolve(llm)
        return derived

    def has_role(self, role: LLMRole) -> bool:
        """Check if a specific LLM is configured for a role."""
        return role in self._llms

    def configured_roles(self) -> list[LLMRole]:
        """Get list of roles that have specific LLM configurations."""
        return list(self._llms.keys())

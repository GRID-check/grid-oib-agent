"""NAT register function for the OIB compliance-check agent.

This function is NOT yet wired into any workflow config under ``configs/`` --
see README.md for the exact YAML snippet + the pending ``pyproject.toml``
entry-point addition needed to complete integration.

Configuration example in YAML (see README.md for the full annotated version):
    functions:
      compliance_check:
        _type: compliance_check_agent
        llm: compliance_llm
        knowledge_search_tool: knowledge_search
        max_concurrency: 3
        richtlinien: [1, 2, 3, 4, 5, 6]
        requirement_batch_size: 9
"""

import logging

from langchain_core.messages import AIMessage
from pydantic import Field
from pydantic import field_validator

from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from aiq_agent.common import VerboseTraceCallback
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import get_org_llm_credential_from_context
from aiq_agent.common import get_zdr_only_from_context
from aiq_agent.common import is_verbose
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import FunctionRef
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig

from .agent import ComplianceCheckAgent
from .agent import build_request_from_state
from .models import ALL_RICHTLINIEN
from .models import ComplianceCheckAgentState

logger = logging.getLogger(__name__)


class ComplianceCheckAgentConfig(FunctionBaseConfig, name="compliance_check_agent"):
    """Configuration for the staged OIB compliance-check pipeline."""

    llm: LLMRef = Field(..., description="LLM used for Stage 1 requirement derivation and Stage 2 evidence judging.")
    knowledge_search_tool: FunctionRef = Field(
        ...,
        description=(
            "Reference to the knowledge_search tool, invoked tool-free (direct .ainvoke, not "
            "an LLM tool-calling loop) for both base-OIB and project-document retrieval."
        ),
    )
    max_concurrency: int = Field(default=3, description="Bounded concurrency for Stage 1/Stage 2 LLM fan-out.")
    richtlinien: list[int] = Field(
        default_factory=lambda: list(ALL_RICHTLINIEN),
        description="Default OIB-Richtlinien scope (1-6); a request's own richtlinien override this.",
    )
    requirement_batch_size: int = Field(
        default=9, description="Requirements grouped per Stage 2 evidence-check LLM call (~8-10 target)."
    )
    verbose: bool = Field(default=False, description="Whether to enable verbose logging")

    @field_validator("richtlinien", mode="after")
    @classmethod
    def _validate_richtlinien(cls, value: list[int]) -> list[int]:
        """Mirror ComplianceCheckRequest's own validator so a bad config fails at build time."""
        if not value:
            return list(ALL_RICHTLINIEN)
        invalid = sorted(set(value) - set(ALL_RICHTLINIEN))
        if invalid:
            raise ValueError(f"Unknown Richtlinie number(s): {invalid}. Valid range is 1-6.")
        return sorted(set(value))


@register_function(config_type=ComplianceCheckAgentConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def compliance_check_agent(config: ComplianceCheckAgentConfig, builder: Builder):
    """Staged OIB compliance-check pipeline (backlog T4-3, v1).

    Deterministic three-stage pipeline (see ``agent.py`` module docstring):
    requirement profile per Richtlinie, evidence check per requirement batch,
    then pure-Python matrix assembly and Markdown rendering. NOT an open
    agent/tool-calling loop -- total LLM calls for a full 6-Richtlinien check
    is ~10-25 (README.md has the exact budget math).
    """
    llm = await get_langchain_llm(builder, config.llm)
    knowledge_search_tool = await builder.get_tool(
        config.knowledge_search_tool, wrapper_type=LLMFrameworkEnum.LANGCHAIN
    )

    provider = LLMProvider()
    # TODO(compliance): AgentGroup (aiq_agent.common.model_overrides) has no
    # dedicated entry for this pipeline yet. Reusing DEEP_RESEARCH for now so
    # per-org runtime model overrides at least apply to *something* sane;
    # once this agent is wired into a workflow config, add a one-line
    # `COMPLIANCE_CHECK = "compliance_check"` member to AgentGroup (and the
    # matching entry in frontends/ui/src/lib/model-config/agent-groups.ts)
    # and switch this to the dedicated group.
    provider.set_default(llm, group=AgentGroup.DEEP_RESEARCH)

    verbose = is_verbose(config.verbose)
    callbacks = [VerboseTraceCallback()] if verbose else []

    agent = ComplianceCheckAgent(
        llm_provider=provider,
        knowledge_search_tool=knowledge_search_tool,
        max_concurrency=config.max_concurrency,
        requirement_batch_size=config.requirement_batch_size,
        callbacks=callbacks,
    )

    async def _run(state: ComplianceCheckAgentState) -> ComplianceCheckAgentState:
        try:
            # Per-org runtime model overrides (X-Grid-Model-Overrides) + BYOK
            # (ADR-0022), same pattern as shallow_researcher/clarifier
            # register.py: both return the build-time provider unchanged when
            # inactive, so the identity check below keeps the prebuilt agent.
            active_provider = (
                provider.with_model_overrides(get_model_overrides_from_context())
                .with_credential(get_org_llm_credential_from_context())
                .with_zdr(get_zdr_only_from_context())
            )
            active_agent = agent
            if active_provider is not provider:
                active_agent = ComplianceCheckAgent(
                    llm_provider=active_provider,
                    knowledge_search_tool=knowledge_search_tool,
                    max_concurrency=config.max_concurrency,
                    requirement_batch_size=config.requirement_batch_size,
                    callbacks=callbacks,
                )

            request = build_request_from_state(state, default_richtlinien=config.richtlinien)
            result = await active_agent.run(state, request=request)

            return state.model_copy(update={"messages": [*state.messages, AIMessage(content=result.report_markdown)]})
        except Exception:
            logger.exception("Error in compliance-check pipeline execution.")
            raise

    yield FunctionInfo.from_fn(
        _run,
        description=(
            "Deterministic, staged OIB compliance-check pipeline (Soll-Ist-Abgleich). Derives "
            "applicable requirements per Richtlinie, checks project-document evidence, and returns "
            "a German Markdown compliance report with a risk-ranked gap list and open questions."
        ),
    )

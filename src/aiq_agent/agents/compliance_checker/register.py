"""NAT register function for the OIB compliance-check agent.

Registered as ``compliance_check`` and listed on ``shallow_research_agent``
so a chat turn can doorbell the staged Soll-Ist pipeline. See README.md.

Configuration example in YAML:
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
from pydantic import BaseModel
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


class ComplianceCheckInput(BaseModel):
    """Chat-tool input for the staged OIB Soll-Ist pipeline."""

    focus: str = Field(
        default="",
        description="Optional focus (one Richtlinie, one Frage). Empty runs OIB 1-6 against this project.",
    )
    richtlinien: list[int] | None = Field(
        default=None,
        description="OIB Richtlinie numbers 1-6. Omit for all six.",
    )

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
    provider.set_default(llm, group=AgentGroup.COMPLIANCE_CHECK)

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

    async def _as_tool(inp: ComplianceCheckInput) -> str:
        from langchain_core.messages import HumanMessage as ToolHumanMessage

        from aiq_agent.knowledge.scoping import get_collection_scope_from_context
        from aiq_agent.project_context import get_project_context_from_context

        ctx = get_project_context_from_context() or ""
        collection = None
        try:
            scope = get_collection_scope_from_context() or []
            names: list[str] = []
            for item in scope:
                name = getattr(item, "collection", item)
                names.append(str(name))
            collection = next((name for name in names if name.startswith("proj_")), None)
        except Exception:
            collection = None
        state = ComplianceCheckAgentState(
            messages=[ToolHumanMessage(content=inp.focus or "Pruefe die OIB-Konformitaet dieses Vorhabens.")],
            project_context=ctx,
            richtlinien=inp.richtlinien,
            collection_name=collection,
        )
        out = await _run(state)
        last = out.messages[-1]
        content = getattr(last, "content", last)
        return content if isinstance(content, str) else str(content)

    yield FunctionInfo.from_fn(
        _as_tool,
        description=(
            "Staged OIB Soll-Ist against this project. Use when the user asks for a full "
            "Richtlinien check, Konformitaetspruefung, or a risk-ranked gap list. Not for a "
            "single-clause question. Returns German Markdown."
        ),
    )

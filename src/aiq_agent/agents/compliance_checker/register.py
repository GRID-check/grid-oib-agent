"""NAT register function for the OIB compliance-check pipeline.

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
from collections.abc import Sequence
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool
from pydantic import BaseModel
from pydantic import Field
from pydantic import field_validator

from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common import VerboseTraceCallback
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import get_org_llm_credential_from_context
from aiq_agent.common import get_zdr_only_from_context
from aiq_agent.common import is_verbose
from aiq_agent.knowledge.scoping import get_scoped_collections_from_context
from aiq_agent.project_context import get_project_context_from_context
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import FunctionRef
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig

from .agent import EVIDENCE_SHELVES
from .agent import build_request
from .agent import run_compliance_check
from .models import ALL_RICHTLINIEN
from .models import normalize_richtlinien

logger = logging.getLogger(__name__)


class ComplianceCheckInput(BaseModel):
    """Chat-tool input for the staged OIB Soll-Ist pipeline."""

    richtlinien: list[int] | None = Field(
        default=None,
        description="OIB Richtlinie numbers 1-6. Omit for all six.",
    )


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
    max_concurrency: int = Field(default=3, description="Bounded concurrency for Stage 1/Stage 2 LLM calls.")
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
        """A bad scope fails at build time, in the same words as a bad request."""
        return normalize_richtlinien(value)


def project_documents_in_scope() -> bool:
    """Whether the request's collection scope holds anything Stage 2 may judge evidence against.

    The knowledge tool falls back to EVERY shelf when a turn's shelf restriction
    would empty its scope, so without this guard a request with no project and no
    upload would judge the Richtlinie text as its own evidence. A missing header
    means the legacy config-resolved layers, which the tool builds itself.
    Shelf ``None`` is a legacy bare-string entry: unknown, so kept.
    """
    scope = get_scoped_collections_from_context()
    if scope is None:
        return True
    return any(entry.shelf is None or entry.shelf in EVIDENCE_SHELVES for entry in scope)


def _active_llm(provider: LLMProvider) -> BaseChatModel:
    """Per-org runtime model overrides (X-Grid-Model-Overrides) + BYOK (ADR-0022) + ZDR, as the other agents do."""
    return (
        provider.with_model_overrides(get_model_overrides_from_context())
        .with_credential(get_org_llm_credential_from_context())
        .with_zdr(get_zdr_only_from_context())
        .get(LLMRole.RESEARCHER)
    )


async def check_from_context(
    inp: ComplianceCheckInput,
    *,
    config: ComplianceCheckAgentConfig,
    provider: LLMProvider,
    knowledge_search: BaseTool,
    callbacks: Sequence[Any] = (),
) -> str:
    """The chat tool: read the request context, run the pipeline, return the Markdown report."""
    request = build_request(
        project_context=get_project_context_from_context(),
        richtlinien=inp.richtlinien,
        default_richtlinien=config.richtlinien,
        project_documents_in_scope=project_documents_in_scope(),
    )
    result = await run_compliance_check(
        request,
        llm=_active_llm(provider),
        knowledge_search=knowledge_search,
        max_concurrency=config.max_concurrency,
        batch_size=config.requirement_batch_size,
        callbacks=callbacks,
    )
    return result.report_markdown


@register_function(config_type=ComplianceCheckAgentConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def compliance_check_agent(config: ComplianceCheckAgentConfig, builder: Builder):
    """Staged OIB compliance-check pipeline (backlog T4-3).

    Requirement profile per Richtlinie, evidence check per requirement batch,
    then pure-Python matrix assembly and Markdown rendering. NOT an open
    agent/tool-calling loop: the LLM call count is one per Richtlinie plus one
    per batch of applicable requirements.
    """
    llm = await get_langchain_llm(builder, config.llm)
    knowledge_search = await builder.get_tool(config.knowledge_search_tool, wrapper_type=LLMFrameworkEnum.LANGCHAIN)

    provider = LLMProvider()
    provider.set_default(llm, group=AgentGroup.COMPLIANCE_CHECK)
    callbacks = [VerboseTraceCallback()] if is_verbose(config.verbose) else []

    async def _as_tool(inp: ComplianceCheckInput) -> str:
        return await check_from_context(
            inp, config=config, provider=provider, knowledge_search=knowledge_search, callbacks=callbacks
        )

    yield FunctionInfo.from_fn(
        _as_tool,
        description=(
            "Staged OIB Soll-Ist against this project. Use when the user asks for a full "
            "Richtlinien check, Konformitaetspruefung, or a risk-ranked gap list. Not for a "
            "single-clause question. Returns German Markdown."
        ),
    )

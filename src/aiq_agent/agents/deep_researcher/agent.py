# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Deep research agent using deepagents library for multi-phase workflow."""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from langchain_core.tools import BaseTool

from aiq_agent.common import LLMProvider
from aiq_agent.common import load_prompt
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.citation_verification import sanitize_report
from aiq_agent.common.citation_verification import verify_citations

from .custom_middleware import SourceRegistryMiddleware
from .deepagents_runtime import DeepAgentsRuntime
from .deepagents_runtime import DeepResearchSandboxConfig
from .deepagents_runtime import DeepResearchSkillsConfig
from .factory import DeepResearchMiddlewareSet
from .factory import DeepResearchToolSet
from .factory import build_deep_research_graph
from .factory import build_deep_research_middleware_set
from .factory import build_deep_research_tool_set
from .models import DeepResearchAgentState
from .tools.source_tool_batching import DEFAULT_MAX_CONCURRENT_SOURCE_TOOL_CALLS
from .tools.source_tool_batching import DEFAULT_MAX_SOURCE_TOOL_BATCH_SIZE

logger = logging.getLogger(__name__)

DEFAULT_MAX_RESEARCH_CONCURRENCY = 6

# Path to this agent's directory (for loading prompts)
AGENT_DIR = Path(__file__).parent


@dataclass(frozen=True)
class DeepResearchRunArtifacts:
    """Everything one deep research run needs, built fresh per run (ADR-0018).

    The agent instance holds only immutable configuration; anything that
    accumulates state during a run lives here so concurrent or consecutive
    runs of the same (possibly shared, prebuilt) agent cannot observe each
    other's captured sources, compact citation keys, or throttle state.
    """

    graph: Any
    source_registry_middleware: SourceRegistryMiddleware
    tool_set: DeepResearchToolSet
    middleware_set: DeepResearchMiddlewareSet


class DeepResearcherAgent:
    """
    Deep research agent using deepagents library for multi-phase workflow.
    """

    def __init__(
        self,
        llm_provider: LLMProvider,
        tools: Sequence[BaseTool] | None = None,
        *,
        verbose: bool = True,
        callbacks: list[Any] | None = None,
        domain_catalog_path: str | None = None,
        enable_source_router: bool = True,
        enable_citation_verification: bool = True,
        skills: DeepResearchSkillsConfig | None = None,
        sandbox: DeepResearchSandboxConfig | None = None,
        job_id: str | None = None,
        max_research_concurrency: int = DEFAULT_MAX_RESEARCH_CONCURRENCY,
        max_concurrent_source_tool_calls: int = DEFAULT_MAX_CONCURRENT_SOURCE_TOOL_CALLS,
        max_source_tool_batch_size: int = DEFAULT_MAX_SOURCE_TOOL_BATCH_SIZE,
    ) -> None:
        """
        Initialize the deep researcher agent.

        Args:
            llm_provider: LLMProvider for role-based LLM access.
            tools: Optional sequence of LangChain tools for research.
            verbose: Enable detailed logging.
            callbacks: Optional list of callbacks.
            domain_catalog_path: Optional YAML/JSON domain catalog path for source-router-agent.
            enable_source_router: Enable the advisory source-router-agent before planning.
            enable_citation_verification: Verify generated citations against the captured source registry.
            skills: Optional DeepAgents skills config.
            sandbox: Optional DeepAgents sandbox config.
            job_id: Optional async job identifier used to scope sandbox backends.
            max_research_concurrency: Maximum ResearchQuery items accepted and run concurrently per
                run_research_batch call.
            max_concurrent_source_tool_calls: Shared source-tool concurrency limit across researcher workers.
            max_source_tool_batch_size: Maximum concrete inputs per batch-capable source tool call.
        """
        self.llm_provider = llm_provider
        self.tools = list(tools) if tools else []
        self.verbose = verbose
        self.callbacks = callbacks or []
        self.max_research_concurrency = max_research_concurrency
        self.max_concurrent_source_tool_calls = max_concurrent_source_tool_calls
        self.max_source_tool_batch_size = max_source_tool_batch_size
        self.domain_catalog_path = domain_catalog_path
        self.enable_source_router = enable_source_router
        self.enable_citation_verification = enable_citation_verification
        self.job_id = str(job_id) if job_id is not None else str(uuid4())

        self.deepagents_runtime = DeepAgentsRuntime(skills=skills, sandbox=sandbox, job_id=self.job_id)

        self._prompts = self._load_prompts()
        # Immutable, cheap derivations only. All mutable per-run state (the
        # source registry middleware, tool wrappers, middleware stacks, and
        # the graph itself) is built per run in _prepare_run() — see
        # ADR-0018. Constructing it here made the agent instance a hidden
        # shared-state container across requests.
        self.source_tool_names = {tool.name for tool in self.tools}
        self.tools_info = [{"name": tool.name, "description": tool.description} for tool in self.tools]

    def _load_prompts(self) -> dict[str, str]:
        """Load all prompts for subagents."""
        prompts = {}
        prompt_names = ["planner", "researcher", "orchestrator", "writer", "source_router"]

        for name in prompt_names:
            prompts[name] = load_prompt(AGENT_DIR / "prompts", name)

        return prompts

    def _prepare_run(self, state: DeepResearchAgentState) -> DeepResearchRunArtifacts:
        """Build the graph and all mutable run state for one deep research run.

        Everything that can accumulate data during a run — the source
        registry middleware (captured sources, compact ResearchNotes keys),
        the batch/throttle tool wrappers with their concurrency limiter, and
        the middleware stacks referencing them — is constructed fresh here so
        no run can observe another run's state (ADR-0018).
        """
        source_registry_middleware = SourceRegistryMiddleware(source_tool_names=self.source_tool_names)
        tool_set = build_deep_research_tool_set(
            self.tools,
            source_registry_middleware=source_registry_middleware,
            max_concurrent_source_tool_calls=self.max_concurrent_source_tool_calls,
            max_source_tool_batch_size=self.max_source_tool_batch_size,
        )
        middleware_set = build_deep_research_middleware_set(
            tool_set=tool_set,
            source_registry_middleware=source_registry_middleware,
        )
        graph = build_deep_research_graph(
            llm_provider=self.llm_provider,
            state=state,
            prompts=self._prompts,
            tools=self.tools,
            runtime=self.deepagents_runtime,
            tool_set=tool_set,
            middleware_set=middleware_set,
            source_registry_middleware=source_registry_middleware,
            callbacks=self.callbacks,
            domain_catalog_path=self.domain_catalog_path,
            enable_source_router=self.enable_source_router,
            max_research_concurrency=self.max_research_concurrency,
        )
        return DeepResearchRunArtifacts(
            graph=graph,
            source_registry_middleware=source_registry_middleware,
            tool_set=tool_set,
            middleware_set=middleware_set,
        )

    def _extract_final_markdown(self, result: dict | Any) -> str | None:
        """Extract final Markdown from output files."""
        output_paths = ("/shared/output.md", "/output.md")
        files = result.get("files", {}) if isinstance(result, dict) else getattr(result, "files", {})
        if isinstance(files, dict):
            for output_path in output_paths:
                output_entry = files.get(output_path)
                if isinstance(output_entry, dict):
                    output_entry = output_entry.get("content")
                if isinstance(output_entry, bytes):
                    output_entry = output_entry.decode("utf-8")
                if isinstance(output_entry, str) and output_entry.strip():
                    return output_entry.strip()
        return None

    @staticmethod
    def _replace_last_message_content(result: dict | Any, content: str) -> None:
        """Overwrite the final message content in-place with post-processed Markdown."""
        messages = result.get("messages") if isinstance(result, dict) else getattr(result, "messages", None)
        if not messages:
            return
        last_msg = messages[-1]
        if hasattr(last_msg, "model_copy"):
            messages[-1] = last_msg.model_copy(update={"content": content})
        else:
            messages[-1] = type(last_msg)(content=content)

    async def run(self, state: DeepResearchAgentState) -> DeepResearchAgentState:
        """
        Execute deep research with multi-phase workflow.
        """
        run_artifacts = self._prepare_run(state)
        agent = run_artifacts.graph
        source_registry_middleware = run_artifacts.source_registry_middleware

        messages = state.messages
        if messages:
            query_content = messages[-1].content
            query = query_content if isinstance(query_content, str) else str(query_content)
            logger.info("=" * 80)
            logger.info("Deep Research Subagent: Starting workflow")
            logger.info("Query: %s...", query[:100])
            logger.info("=" * 80)

        try:
            result = await agent.ainvoke(state, config={"callbacks": self.callbacks} if self.callbacks else None)

            final_message = self._extract_final_markdown(result)
            if final_message is None:
                raise ValueError("writer-agent did not produce a final Markdown answer")

            # Post-process: verify citations against source registry
            if self.enable_citation_verification and source_registry_middleware.has_sources():
                registry = source_registry_middleware.active_registry()
                verification = verify_citations(
                    final_message,
                    registry,
                    reference_sources=source_registry_middleware.get_source_entries(mode="compact"),
                )
                if verification.removed_citations:
                    removed_details = []
                    for c in verification.removed_citations:
                        url_match = re.search(r"https?://\S+", c.get("line", ""))
                        url_str = url_match.group(0).rstrip(".,;)") if url_match else "(no url)"
                        removed_details.append(f"[{c['number']}] {c['reason']}: {url_str}")
                    logger.info(
                        "Citation verification removed %d invalid citation(s):\n  %s",
                        len(verification.removed_citations),
                        "\n  ".join(removed_details),
                    )
                final_message = verification.verified_report
                if not verification.valid_citations:
                    logger.warning(
                        "Citation verification found no valid citations in writer-agent output; "
                        "returning the generated report without failing the job. "
                        "This may indicate unsupported citation formatting or over-aggressive verification."
                    )
            elif self.enable_citation_verification:
                from aiq_agent.common.tool_validation import validate_tool_availability

                _, available_count, unavailable = validate_tool_availability(
                    self.tools,
                    research_type="deep research",
                    enable_logging=False,
                )
                raise EmptySourceRegistryError(
                    "deep research",
                    unavailable_tools=unavailable,
                    available_count=available_count,
                )

            # Post-process: sanitize report (strip body URLs, shortened URLs, unsafe URLs)
            sanitization = sanitize_report(final_message)
            final_message = sanitization.sanitized_report

            # Re-emit the verified/sanitized report so the frontend overwrites
            # the raw version that on_llm_end auto-emitted during ainvoke().
            for cb in self.callbacks:
                if hasattr(cb, "emit_final_report"):
                    cb.emit_final_report(final_message)
                    break

            self._replace_last_message_content(result, final_message)

            logger.info("=" * 80)
            logger.info("Deep Research Subagent: Workflow complete")
            logger.info("Final answer length: %d characters", len(final_message))
            logger.info("=" * 80)
            return DeepResearchAgentState.model_validate(result)

        except Exception as ex:
            logger.error("Deep Research Subagent failed: %s", ex, exc_info=True)
            raise

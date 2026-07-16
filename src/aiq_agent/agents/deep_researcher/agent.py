"""Deep research agent using deepagents library for multi-phase workflow."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from langchain_core.tools import BaseTool
from langgraph.types import Checkpointer

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

# Wall-clock budget for one deep-research run (40 min). Generous relative to a
# healthy run so it only fires on pathological ones; 0 disables the guard.
DEFAULT_MAX_RUN_SECONDS = 2400

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
    callbacks: list[Any]


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
        max_run_seconds: int = DEFAULT_MAX_RUN_SECONDS,
        checkpointer: Checkpointer | None = None,
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
            job_id: Optional async job identifier used to scope sandbox backends AND, when
                ``checkpointer`` is set, as the durable graph's thread_id (see ``run()``).
            max_research_concurrency: Maximum ResearchQuery items accepted and run concurrently per
                run_research_batch call.
            max_concurrent_source_tool_calls: Shared source-tool concurrency limit across researcher workers.
            max_source_tool_batch_size: Maximum concrete inputs per batch-capable source tool call.
            max_run_seconds: Wall-clock budget for one run; 0 disables the guard.
            checkpointer: Optional LangGraph checkpointer (e.g. from ``aiq_agent.common.get_checkpointer``)
                for restart-safe async jobs. None (default) preserves current behavior: an in-memory-only
                graph with no execution-state durability. This is distinct from the DeepAgents longterm
                ``store`` (always an ``InMemoryStore`` — see factory.build_deep_research_graph); the
                checkpointer instead persists per-thread graph execution state (messages, filesystem,
                todos) so a re-run of the same job_id can resume. See ``run()`` for the resume contract.
        """
        self.llm_provider = llm_provider
        self.tools = list(tools) if tools else []
        self.verbose = verbose
        self.callbacks = callbacks or []
        self.max_research_concurrency = max_research_concurrency
        self.max_concurrent_source_tool_calls = max_concurrent_source_tool_calls
        self.max_source_tool_batch_size = max_source_tool_batch_size
        self.max_run_seconds = max_run_seconds
        self.domain_catalog_path = domain_catalog_path
        self.enable_source_router = enable_source_router
        self.enable_citation_verification = enable_citation_verification
        self.job_id = str(job_id) if job_id is not None else str(uuid4())
        self.checkpointer = checkpointer

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
            max_research_concurrency=self.max_research_concurrency,
        )
        # Stateful trace callbacks (e.g. VerboseTraceCallback) mutate internal
        # per-run state, so a shared instance must not span runs (ADR-0018).
        callbacks = [cb.for_new_run() if hasattr(cb, "for_new_run") else cb for cb in self.callbacks]
        graph = build_deep_research_graph(
            llm_provider=self.llm_provider,
            state=state,
            prompts=self._prompts,
            tools=self.tools,
            runtime=self.deepagents_runtime,
            tool_set=tool_set,
            middleware_set=middleware_set,
            source_registry_middleware=source_registry_middleware,
            callbacks=callbacks,
            domain_catalog_path=self.domain_catalog_path,
            enable_source_router=self.enable_source_router,
            max_research_concurrency=self.max_research_concurrency,
            checkpointer=self.checkpointer,
        )
        return DeepResearchRunArtifacts(
            graph=graph,
            source_registry_middleware=source_registry_middleware,
            tool_set=tool_set,
            middleware_set=middleware_set,
            callbacks=callbacks,
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
    def _extract_last_message_text(result: dict | Any) -> str | None:
        """Last-resort answer: the final assistant message text.

        Used only when no report file was persisted — the writer normally
        writes ``/shared/output.md``. Returns None when there is no usable
        message content to fall back to.
        """
        messages = result.get("messages") if isinstance(result, dict) else getattr(result, "messages", None)
        if not messages:
            return None
        content = getattr(messages[-1], "content", None)
        if isinstance(content, str):
            return content.strip() or None
        if isinstance(content, list):
            # Structured block content: join the text blocks instead of
            # producing a Python repr of the block list.
            parts = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict) and isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif isinstance(getattr(block, "text", None), str):
                    parts.append(block.text)
            return "\n".join(parts).strip() or None
        if content is not None:
            return str(content).strip() or None
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

    def _empty_source_registry_error(self) -> EmptySourceRegistryError:
        """Build an EmptySourceRegistryError enriched with tool availability details."""
        from aiq_agent.common.tool_validation import validate_tool_availability

        _, available_count, unavailable = validate_tool_availability(
            self.tools,
            research_type="deep research",
            enable_logging=False,
        )
        return EmptySourceRegistryError(
            "deep research",
            unavailable_tools=unavailable,
            available_count=available_count,
        )

    async def run(self, state: DeepResearchAgentState) -> DeepResearchAgentState:
        """
        Execute deep research with multi-phase workflow.
        """
        run_artifacts = self._prepare_run(state)
        agent = run_artifacts.graph
        source_registry_middleware = run_artifacts.source_registry_middleware
        callbacks = run_artifacts.callbacks

        messages = state.messages
        if messages:
            query_content = messages[-1].content
            query = query_content if isinstance(query_content, str) else str(query_content)
            logger.info("=" * 80)
            logger.info("Deep Research Subagent: Starting workflow")
            logger.info("Query: %s...", query[:100])
            logger.info("=" * 80)

        try:
            invoke_config: dict[str, Any] = {}
            if callbacks:
                invoke_config["callbacks"] = callbacks
            ainvoke_kwargs: dict[str, Any] = {}
            if self.checkpointer is not None:
                # Stable, job-scoped thread_id: re-invoking run() with the same
                # job_id (i.e. the same DeepResearcherAgent.job_id) targets the
                # same checkpoint thread, so LangGraph resumes from the last
                # persisted checkpoint instead of starting a bare run. This is
                # additive config -- merge_configs() composes it with the
                # recursion_limit bound at graph-build time via .with_config()
                # (factory.build_deep_research_graph), so neither is lost.
                #
                # durability="async" is LangGraph's canonical durable-execution
                # mode for long batch-style runs: each step's checkpoint is
                # persisted while the NEXT step executes (near-sync durability,
                # much cheaper than "sync"). It is also the library default
                # once a checkpointer is present, but is passed explicitly here
                # to document the choice and pin it against upstream default
                # changes. "exit" (checkpoint only when the graph returns) is
                # explicitly NOT crash-safe and would defeat the point of this
                # feature.
                #
                # Resume caveat (LangGraph durable-execution semantics): only
                # COMPLETED steps are persisted, so a worker that dies mid-step
                # (e.g. mid `run_research_batch` tool call, which fans out
                # several researcher subagents and mutates the source
                # registry / captured files) loses that step entirely, and a
                # resumed run redoes it from the last completed checkpoint.
                # Side-effecting tool calls inside a step are therefore NOT
                # guaranteed to run only once across a resume -- callers that
                # rely on this must be tolerant of at-least-once execution.
                #
                # Resume is also manual today, not automatic: nothing in this
                # codebase re-invokes a job for an existing job_id --
                # frontends/aiq_api/src/aiq_api/jobs/submit.py::submit_agent_job
                # explicitly rejects a caller-supplied job_id that already
                # exists (DuplicateJobIdError). A resume therefore requires an
                # out-of-band re-invocation of the job runner with the same
                # job_id (e.g. by an operator or a future retry endpoint), not
                # something reachable through the public submit API yet.
                #
                # That resumed call also always passes the full initial state
                # (including the human query message) rather than `None` as
                # `state` -- it does not use LangGraph's "continue exactly from
                # the interrupted step" resume path (`ainvoke(None, config=...)`
                # against a thread with a pending task). Instead each call is a
                # fresh graph invocation that layers new input onto the
                # checkpointed thread's state via the state schema's reducers
                # (e.g. `messages`/`add_messages`). A dedicated resume entry
                # point that detects an existing thread and passes `None` is
                # NOT implemented: there is no real caller for it today (see
                # above), so it is out of scope rather than approximated here.
                invoke_config["configurable"] = {"thread_id": self.job_id}
                ainvoke_kwargs["durability"] = "async"

            # Wall-clock budget: per-call request_timeout bounds a single HTTP
            # request, recursion_limit bounds step COUNT — neither bounds total
            # run time, so a pathological run could otherwise hold a worker
            # slot forever.
            invocation = agent.ainvoke(state, config=invoke_config or None, **ainvoke_kwargs)
            if self.max_run_seconds > 0:
                try:
                    result = await asyncio.wait_for(invocation, timeout=self.max_run_seconds)
                except TimeoutError as exc:
                    raise RuntimeError(
                        f"deep research exceeded the {self.max_run_seconds} s wall-clock budget"
                    ) from exc
            else:
                result = await invocation

            final_message = self._extract_final_markdown(result)
            if final_message is None:
                # The writer normally persists the report to /shared/output.md.
                # When it doesn't — the agent went off-task, replied only
                # conversationally, or ran out of steps mid-write — fall back to
                # its last message so the user gets the produced content instead
                # of a hard job failure. Raise only when there is truly nothing.
                fallback = self._extract_last_message_text(result)
                if fallback is None:
                    if self.enable_citation_verification and not source_registry_middleware.has_sources():
                        # No report AND no captured sources: research never
                        # produced anything salvageable.
                        raise self._empty_source_registry_error()
                    raise ValueError("writer-agent did not produce a final Markdown answer")
                logger.warning(
                    "writer-agent did not persist a report to /shared/output.md; "
                    "falling back to the agent's last message (%d chars) instead of failing the job",
                    len(fallback),
                )
                final_message = fallback

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
                # A completed report exists but no sources were ever captured:
                # every finding is ungrounded (the writer answered from model
                # memory), so the report cannot be citation-verified. Fail the
                # job loudly instead of shipping an unverifiable report — an
                # empty registry at the end of a research run is a failure, not
                # a degraded success.
                raise self._empty_source_registry_error()

            # Post-process: sanitize report (strip body URLs, shortened URLs, unsafe URLs)
            sanitization = sanitize_report(final_message)
            final_message = sanitization.sanitized_report

            # Re-emit the verified/sanitized report so the frontend overwrites
            # the raw version that on_llm_end auto-emitted during ainvoke().
            for cb in callbacks:
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

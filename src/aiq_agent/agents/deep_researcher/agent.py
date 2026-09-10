"""Deep research agent using deepagents library for multi-phase workflow."""

from __future__ import annotations

import asyncio
import functools
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from langchain_core.tools import BaseTool
from langgraph.types import Checkpointer

from aiq_agent.agents.researcher.markers import ConfidenceLevel
from aiq_agent.agents.researcher.markers import detect_and_strip_confidence_marker
from aiq_agent.common import LLMProvider
from aiq_agent.common import citation_events
from aiq_agent.common import load_prompt
from aiq_agent.common import validate_tool_availability
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.citation_verification import get_session_registry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.turn_status import DEGRADED_NO_REPORT_FILE
from aiq_agent.observability.langfuse_trace_attributes import begin_trace_contributions
from aiq_agent.observability.langfuse_trace_attributes import end_trace_contributions
from aiq_agent.project_context import get_organization_id_from_context
from aiq_agent.skills import Skill
from aiq_agent.skills import SkillRuntime
from aiq_agent.skills import resolve_served_skills
from aiq_agent.skills.events import emit_skills_offered

from .custom_middleware import SourceRegistryMiddleware
from .cutoff import classify_cutoff
from .cutoff import salvage_cutoff
from .cutoff import stream_with_budget
from .deepagents_runtime import DeepAgentsRuntime
from .deepagents_runtime import DeepResearchSandboxConfig
from .deepagents_runtime import DeepResearchSkillsConfig
from .factory import DeepResearchMiddlewareSet
from .factory import DeepResearchToolSet
from .factory import build_deep_research_graph
from .factory import build_deep_research_middleware_set
from .factory import build_deep_research_tool_set
from .finalize import _HONESTY_BANNER_PREFIX  # noqa: F401 - re-exported for tests
from .finalize import MIN_SALVAGE_REPORT_CHARS  # noqa: F401 - re-exported for tests
from .finalize import Verification
from .finalize import _apply_renumbering  # noqa: F401 - re-exported for tests
from .finalize import _cited_sources_to_wire  # noqa: F401 - re-exported for tests
from .finalize import _prepend_honesty_banner  # noqa: F401 - re-exported for tests
from .finalize import _salvaged_report_length  # noqa: F401 - re-exported for tests
from .finalize import annotate_state
from .finalize import emit_final_report
from .finalize import extract_final_markdown
from .finalize import finalize_report
from .finalize import log_completion
from .finalize import record_citation_ledger
from .finalize import replace_last_message_content
from .finalize import verify_report
from .models import DeepResearchAgentState
from .models import last_message_text
from .tools.source_tool_batching import DEFAULT_MAX_CONCURRENT_SOURCE_TOOL_CALLS
from .tools.source_tool_batching import DEFAULT_MAX_SOURCE_TOOL_BATCH_SIZE

logger = logging.getLogger(__name__)

DEFAULT_MAX_RESEARCH_CONCURRENCY = 6

# Wall-clock budget for one deep-research run (40 min). Generous relative to a
# healthy run so it only fires on pathological ones; 0 disables the guard.
DEFAULT_MAX_RUN_SECONDS = 2400

# Path to this agent's directory (for loading prompts)
AGENT_DIR = Path(__file__).parent

#: This agent's name in ``grid-agents``, the one gate a skill declares itself
#: with. It is the ``AGENT_REGISTRY`` identifier, so the string a schedule's
#: ``agent_type`` uses, the string the Skills tab writes, and the string
#: resolved here are the same string.
SKILL_AGENT = "deep_researcher"

_PROMPT_NAMES = ("planner", "researcher", "orchestrator", "writer", "source_router")


@functools.cache
def _prompt_templates() -> dict[str, str]:
    """The five subagent prompt templates, read from disk once per process.

    ``register.py`` constructs a new agent for every request that carries a
    model override, and each construction used to re-read five files. The
    templates are immutable at runtime. ``_prompt_templates.cache_clear()``
    is the reset for tests that want a missing file to fail construction.
    """
    return {name: load_prompt(AGENT_DIR / "prompts", name) for name in _PROMPT_NAMES}


def _resolve_skills_blocking(organization_id: str | None) -> tuple[Skill, ...]:
    """The BFF round trip for this agent's skills: synchronous httpx, so never on the loop."""
    return resolve_served_skills(SKILL_AGENT, organization_id)


def _skills_block(runtime: SkillRuntime) -> str | None:
    """The writer's skills section: the catalog, then what is required of it.

    The same two blocks the researcher renders, from the same runtime,
    so a skill that names both agents is presented to both of them in the same
    words. None when the run resolved no skills — the writer prompt then shows
    no skills section at all rather than an empty heading.
    """
    blocks = [block for block in (runtime.prompt_block(), runtime.forced_block()) if block]
    return "\n\n".join(blocks) if blocks else None


def _run_scoped_callbacks(callbacks: Sequence[Any], source_registry_middleware: SourceRegistryMiddleware) -> list[Any]:
    """Fresh trace callbacks for one run, each holding this run's registry accessor.

    Stateful trace callbacks (``VerboseTraceCallback``) mutate per-run state,
    so a shared instance must not span runs (ADR-0018). Each is handed the
    registry ACCESSOR, not the registry: the middleware swaps in a
    session-scoped registry mid-run in conversation mode, and a callback
    holding the first one would judge the whole report against a registry the
    run stopped using. ``run()`` also binds the session contextvar the callback
    falls back to, but a contextvar does not survive every thread hop
    LangChain's callback machinery can make, and that failure is silent: a
    citation reported as uncited.
    """
    scoped = [cb.for_new_run() if hasattr(cb, "for_new_run") else cb for cb in callbacks]
    for cb in scoped:
        setter = getattr(cb, "set_source_registry", None)
        if callable(setter):
            setter(source_registry_middleware.active_registry)
    return scoped


def _log_run_start(state: DeepResearchAgentState) -> None:
    if not state.messages:
        return
    query_content = state.messages[-1].content
    query = query_content if isinstance(query_content, str) else str(query_content)
    logger.info("=" * 80)
    logger.info("Deep Research Subagent: Starting workflow")
    logger.info("Query: %s...", query[:100])
    logger.info("=" * 80)


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
    #: This run's resolved skills. The runtime accumulates the activation list
    #: DURING the run and ``_finalize`` reports it — a runtime that went out of
    #: scope at graph-build time is why deep research shipped
    #: ``skills_activated=None`` on every answer while the researcher reported it.
    skill_runtime: SkillRuntime


class DeepResearcherAgent:
    """Deep research agent using deepagents library for multi-phase workflow."""

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
        """Immutable configuration only; everything mutable is built per run.

        ``job_id`` scopes the sandbox backend and, when ``checkpointer`` is set,
        is the durable graph's ``thread_id`` (see :meth:`run`). ``checkpointer``
        is execution-state durability (messages, filesystem, todos per thread),
        distinct from the DeepAgents longterm ``store``, which is always an
        ``InMemoryStore`` here. ``max_run_seconds=0`` disables the wall clock.
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
        self._prompts = _prompt_templates()
        self.source_tool_names = {tool.name for tool in self.tools}

    # -- per-run construction ------------------------------------------------

    def _prepare_run(
        self,
        state: DeepResearchAgentState,
        skill_runtime: SkillRuntime | None = None,
    ) -> DeepResearchRunArtifacts:
        """Build the graph and all mutable run state for one deep research run.

        Everything that can accumulate data during a run — the source registry
        middleware, the batch/throttle tool wrappers with their limiter, the
        middleware stacks referencing them — is constructed fresh here so no
        run can observe another run's state (ADR-0018).

        ``skill_runtime`` is resolved by :meth:`run` off the event loop, since
        it is an HTTP round trip to the BFF. A caller without one gets a run
        with no platform skills, the shape of a run whose BFF did not answer.
        """
        if skill_runtime is None:
            skill_runtime = SkillRuntime(force_names=state.force_skills)
        source_registry_middleware = SourceRegistryMiddleware(source_tool_names=self.source_tool_names)
        tool_set = build_deep_research_tool_set(
            self.tools,
            source_registry_middleware=source_registry_middleware,
            max_concurrent_source_tool_calls=self.max_concurrent_source_tool_calls,
            max_source_tool_batch_size=self.max_source_tool_batch_size,
            writer_skill_tools=skill_runtime.build_tools(),
        )
        middleware_set = build_deep_research_middleware_set(
            tool_set=tool_set,
            source_registry_middleware=source_registry_middleware,
            max_research_concurrency=self.max_research_concurrency,
        )
        callbacks = _run_scoped_callbacks(self.callbacks, source_registry_middleware)
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
            skills_block=_skills_block(skill_runtime),
        )
        return DeepResearchRunArtifacts(
            graph=graph,
            source_registry_middleware=source_registry_middleware,
            tool_set=tool_set,
            middleware_set=middleware_set,
            callbacks=callbacks,
            skill_runtime=skill_runtime,
        )

    @staticmethod
    async def _build_skill_runtime(state: DeepResearchAgentState) -> SkillRuntime:
        """Resolve this run's platform/org skills into a fresh runtime.

        Per run, for the reason the source registry is (ADR-0018): the runtime
        owns one run's activation list and this instance is shared across runs
        and tenants. The organization comes off the STATE first — in a Dask
        worker ``get_organization_id_from_context()`` reads no headers because
        there is no request — and falls back to the request context for the
        synchronous path and evaluation runs. ``force_skills`` is the user's
        own instruction (a skill ticked in the composer, or named by a
        schedule); passing it as ``force_names`` puts the skill's body in front
        of the writer instead of merely listing its name.

        The resolver is a SYNCHRONOUS HTTP call to the BFF. Run on the loop it
        stalled the Dask worker's heartbeat for as long as the BFF took to
        answer, and the ghost reaper failed healthy jobs for it
        (``docs/contributing/gotchas.md``), so it runs in a worker thread.
        ``resolve_served_skills`` never raises: an empty skill set produces an
        empty runtime, no tool and no prompt block.
        """
        organization_id = state.organization_id or get_organization_id_from_context()
        skills = await asyncio.to_thread(_resolve_skills_blocking, organization_id)
        runtime = SkillRuntime(skills=skills, force_names=state.force_skills)
        if not skills:
            return runtime
        emit_skills_offered(runtime)
        logger.info(
            "Deep research resolved %d organization skill(s) for the writer; required: %s",
            len(skills),
            list(runtime.forced) or "none",
        )
        return runtime

    # -- the run --------------------------------------------------------------

    def _invocation(self, callbacks: list[Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        """The ``astream`` config and kwargs for one run.

        With a checkpointer the thread_id is the job_id, so re-invoking
        ``run()`` for the same job resumes from the last persisted checkpoint;
        ``merge_configs`` composes it with the ``recursion_limit`` bound at
        graph-build time. ``durability="async"`` persists each step's checkpoint
        while the next executes — the library default with a checkpointer,
        pinned here against upstream changes ("exit" is not crash-safe).

        Only COMPLETED steps are persisted, so a worker that dies mid-step (a
        ``run_research_batch`` fan-out, say) redoes that step on resume: tool
        side effects are at-least-once across a resume. Resume is also manual
        today — ``jobs/submit.py`` rejects a duplicate job_id — and always
        passes the full initial state, layering it onto the checkpointed
        thread through the state reducers; a "continue from the interrupted
        step" entry point (``ainvoke(None, ...)``) has no caller and is not
        built.
        """
        config: dict[str, Any] = {"callbacks": callbacks} if callbacks else {}
        stream_kwargs: dict[str, Any] = {}
        if self.checkpointer is not None:
            config["configurable"] = {"thread_id": self.job_id}
            stream_kwargs["durability"] = "async"
        return config or None, stream_kwargs

    async def run(self, state: DeepResearchAgentState) -> DeepResearchAgentState:
        """Execute deep research with multi-phase workflow.

        Two contextvars are bound for the run and reset in ``finally``, because
        a Dask worker process is reused across jobs and tenants. The SESSION
        registry, only when nothing is bound: the live citation stream reads it
        to tell a source the run retrieved from one the model merely named, and
        in a worker nothing else binds one — while in conversation mode the
        chat entrypoint binds one that spans turns and must be left alone. The
        Langfuse trace contributions, unconditionally: without a per-job
        binding job N's ``feature:ifc`` tag would be stamped onto job N+1's
        traces for another tenant.
        """
        skill_runtime = await self._build_skill_runtime(state)
        artifacts = self._prepare_run(state, skill_runtime)
        _log_run_start(state)
        registry_token = None
        if get_session_registry() is None:
            registry_token = set_session_registry(artifacts.source_registry_middleware.active_registry())
        contributions_token = begin_trace_contributions()
        try:
            config, stream_kwargs = self._invocation(artifacts.callbacks)
            outcome = await stream_with_budget(
                artifacts.graph,
                state,
                config=config,
                stream_kwargs=stream_kwargs,
                max_run_seconds=self.max_run_seconds,
            )
            if outcome.error is None:
                return self._finalize(outcome.last_state, artifacts=artifacts, cutoff_reason=None)
            reason, original = classify_cutoff(
                outcome.error, elapsed_seconds=outcome.elapsed_seconds, max_run_seconds=self.max_run_seconds
            )
            return salvage_cutoff(
                outcome.last_state,
                cutoff_reason=reason,
                elapsed_seconds=outcome.elapsed_seconds,
                source_count=len(artifacts.source_registry_middleware.active_registry().all_sources()),
                finalize=functools.partial(self._finalize, artifacts=artifacts, cutoff_reason=reason),
                original=original,
                cause=outcome.error,
            )
        finally:
            if registry_token is not None:
                reset_session_registry(registry_token)
            end_trace_contributions(contributions_token)

    # -- post-processing ------------------------------------------------------

    def _finalize(
        self,
        result: Any,
        *,
        artifacts: DeepResearchRunArtifacts,
        cutoff_reason: str | None,
    ) -> DeepResearchAgentState:
        """Turn a graph state into the finished, verified, honestly-labelled answer.

        Shared by the normal path and the salvage path, so a cut-off run is
        post-processed by exactly the same citation verification, quote
        verification and sanitisation as a complete one — the only difference
        being the banner and the flags that say it was cut off.
        """
        middleware = artifacts.source_registry_middleware
        report, degraded_reasons = self._extract_report(result, middleware)
        # The writer's self-assessment comes out before ANY other reader touches
        # the text, or a stray "[CONFIDENCE:high]" reaches the PDF.
        report, self_confidence, self_confidence_reason = detect_and_strip_confidence_marker(report)
        verification = self._verify(report, middleware, self_confidence)
        finalized = finalize_report(
            verification,
            self_confidence=self_confidence,
            self_confidence_reason=self_confidence_reason,
            degraded_reasons=degraded_reasons,
            cutoff_reason=cutoff_reason,
        )
        annotate_state(result, finalized, artifacts.skill_runtime)
        emit_final_report(artifacts.callbacks, finalized.report)
        replace_last_message_content(result, finalized.report)
        log_completion(finalized)
        return DeepResearchAgentState.model_validate(result)

    def _extract_report(self, result: Any, middleware: SourceRegistryMiddleware) -> tuple[str, list[str]]:
        """The report text and the degradation, if it had to come from a chat message.

        The writer normally persists the report to ``/shared/output.md``. When it
        does not — went off-task, replied conversationally, ran out of steps
        mid-write — the agent's last message is shipped instead of failing the
        job, MARKED: a chat message wearing a report's clothes is materially
        weaker than a written report. Raises only when there is truly nothing.
        """
        report = extract_final_markdown(result)
        if report is not None:
            return report, []
        fallback = last_message_text(result)
        if fallback is None:
            if self.enable_citation_verification and not middleware.has_sources():
                raise self._empty_source_registry_error()
            raise ValueError("writer-agent did not produce a final Markdown answer")
        logger.warning(
            "writer-agent did not persist a report to /shared/output.md; "
            "falling back to the agent's last message (%d chars) instead of failing the job",
            len(fallback),
        )
        return fallback, [DEGRADED_NO_REPORT_FILE]

    def _verify(
        self,
        report: str,
        middleware: SourceRegistryMiddleware,
        self_confidence: ConfidenceLevel | None,
    ) -> Verification:
        """Verify the report against this run's registry, or fail an unverifiable one.

        A completed report with no captured sources means every finding is
        ungrounded (the writer answered from model memory). That is a failure,
        not a degraded success, and the job fails loudly rather than shipping it.
        """
        if not self.enable_citation_verification:
            return Verification(report=report)
        if not middleware.has_sources():
            raise self._empty_source_registry_error()
        registry = middleware.active_registry()
        verification = verify_report(report, registry, middleware.get_source_entries(mode="compact"))
        record_citation_ledger(verification, registry, self_confidence)
        return verification

    def _empty_source_registry_error(self) -> EmptySourceRegistryError:
        """Build an EmptySourceRegistryError enriched with tool availability details."""
        _, available_count, unavailable = validate_tool_availability(
            self.tools,
            research_type="deep research",
            enable_logging=False,
        )
        # The hardest citation failure there is — the run captured nothing to
        # cite — lands on the citation-health dashboard, not only in the logs.
        citation_events.record_empty_registry(
            agent="deep",
            unavailable_tools=unavailable,
            available_count=available_count,
        )
        return EmptySourceRegistryError(
            "deep research",
            unavailable_tools=unavailable,
            available_count=available_count,
        )

    # -- thin accessors kept for callers and tests ----------------------------

    def _extract_final_markdown(self, result: Any) -> str | None:
        """Extract final Markdown from output files."""
        return extract_final_markdown(result)

    @staticmethod
    def _extract_last_message_text(result: Any) -> str | None:
        """Last-resort answer: the final assistant message text."""
        return last_message_text(result)

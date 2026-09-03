"""Deep research agent using deepagents library for multi-phase workflow."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING
from typing import Any
from uuid import uuid4

from langchain_core.tools import BaseTool
from langgraph.types import Checkpointer

from aiq_agent.agents.shallow_researcher.markers import ConfidenceLevel
from aiq_agent.agents.shallow_researcher.markers import answer_confidence_capped_reason
from aiq_agent.agents.shallow_researcher.markers import detect_and_strip_confidence_marker
from aiq_agent.agents.shallow_researcher.markers import surface_answer_confidence
from aiq_agent.common import LLMProvider
from aiq_agent.common import citation_events
from aiq_agent.common import load_prompt
from aiq_agent.common.budget_guard import RunBudgetExceededError
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.citation_verification import annotate_unverified_quotes
from aiq_agent.common.citation_verification import get_session_registry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import sanitize_report
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.citation_verification import source_entry_to_wire
from aiq_agent.common.citation_verification import source_label
from aiq_agent.common.citation_verification import source_origin_token
from aiq_agent.common.citation_verification import verify_citations
from aiq_agent.common.citation_verification import verify_quoted_spans
from aiq_agent.common.cost_tracking import BudgetExceededError
from aiq_agent.common.turn_status import CUTOFF_RUN_BUDGET
from aiq_agent.common.turn_status import CUTOFF_STEP_LIMIT
from aiq_agent.common.turn_status import CUTOFF_UPSTREAM_TIMEOUT
from aiq_agent.common.turn_status import CUTOFF_WALL_CLOCK
from aiq_agent.common.turn_status import DEGRADED_NO_REPORT_FILE
from aiq_agent.common.turn_status import DEGRADED_NO_VALID_CITATIONS
from aiq_agent.common.turn_status import DEGRADED_UNVERIFIED_QUOTES
from aiq_agent.common.turn_status import emit_answer_degraded
from aiq_agent.common.turn_status import emit_deep_research_cutoff

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

if TYPE_CHECKING:
    from aiq_agent.skills import SkillRuntime

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

#: How much salvaged report is worth shipping. Below this the "report" is a
#: stub — a heading, a half sentence, the writer's opening line — and handing it
#: to a reader under a "was cut off" banner would be worse than the honest
#: failure: it looks like an answer. A cutoff with less than this raises the
#: original error instead.
MIN_SALVAGE_REPORT_CHARS = 200

#: The ceiling a run that never finished gathering its evidence may reach. Deep
#: research is the ONE path that knows it was cut off, and a report salvaged at
#: the wall clock — or written without the sources that would have proved it —
#: has not seen what it set out to see. "high" is the level reserved for a claim
#: checked against a retrieved passage, so an incomplete run cannot earn it from
#: whatever it happened to reach first. Nothing downstream could reconstruct
#: this: by the time the report leaves here it reads exactly like a complete one.
_INCOMPLETE_EVIDENCE_CONFIDENCE_CEILING: ConfidenceLevel = "medium"

#: Ordering used only to clamp DOWN. Spelled out here rather than reached into
#: the markers module for, so this file can never end up RAISING a self-report —
#: the one thing the overconfidence guard exists to make impossible.
_CONFIDENCE_RANK: dict[str, int] = {"low": 0, "medium": 1, "high": 2}


def _cap_for_incomplete_evidence(
    level: ConfidenceLevel | None,
    *,
    cutoff_reason: str | None,
    degraded_reasons: list[str],
) -> ConfidenceLevel | None:
    """Clamp a self-report the run's own incompleteness cannot back up.

    Applied ON TOP of the shared overconfidence guard, never instead of it: the
    guard grades whether the claims are sourced, this grades whether the run
    that made them ever finished. A truncated run whose few citations all
    verified sails through the guard at the writer's own "high", and shipping
    that would tell the reader the most confident thing the product can say
    about the least complete answer it produces.

    WHY the cap carries no reason token of its own: truncation already has a
    dedicated channel to the reader — ``research_truncated`` on the state and the
    honesty banner at the top of the report — and inventing a sixth
    ``CappedReason`` would put a token on the platform dashboard and in the
    frontend's chip tooltip that neither has a dictionary entry for.
    """
    if level is None or (cutoff_reason is None and not degraded_reasons):
        return level
    ceiling = _INCOMPLETE_EVIDENCE_CONFIDENCE_CEILING
    return level if _CONFIDENCE_RANK[level] <= _CONFIDENCE_RANK[ceiling] else ceiling


class _NeverRaised(Exception):
    """Placeholder so ``except _GRAPH_RECURSION_ERRORS`` is always a valid clause.

    ``except ()`` is a syntactically fine but semantically dead clause, and an
    empty tuple is what a failed guarded import would otherwise leave behind.
    Catching a class nothing ever raises is the same no-op, spelled safely.
    """


try:  # langgraph's error module is not part of any stability promise we rely on
    from langgraph.errors import GraphRecursionError

    _GRAPH_RECURSION_ERRORS: tuple[type[BaseException], ...] = (GraphRecursionError,)
except ImportError:  # pragma: no cover - only on a langgraph that moved the name
    logger.warning(
        "langgraph.errors.GraphRecursionError is unavailable; a deep run that exhausts "
        "the orchestrator's step limit will fail instead of salvaging its partial report"
    )
    _GRAPH_RECURSION_ERRORS = (_NeverRaised,)

#: The banner's opening, in the report and in the length check that ignores it.
_HONESTY_BANNER_PREFIX = "> **Hinweis:**"

#: Why a reader is told the run stopped, as the clause after "wurde …".
#: Deliberately coarse: the operator channel carries the token, the reader gets
#: the kind of cause and nothing that pretends to be an error taxonomy. An
#: upstream timeout is NOT a time limit — a source did not answer — and calling
#: it one had readers asking for a longer budget on runs that died in three
#: minutes.
_CUTOFF_CAUSE_CLAUSES = {
    CUTOFF_WALL_CLOCK: "wegen des erreichten Zeitlimits",
    CUTOFF_STEP_LIMIT: "wegen des erreichten Schritt-Limits",
    CUTOFF_UPSTREAM_TIMEOUT: "weil eine angefragte Quelle nicht rechtzeitig geantwortet hat",
    CUTOFF_RUN_BUDGET: "wegen des erreichten Recherche-Budgets",
}


def _set_state_field(result: Any, key: str, value: Any) -> None:
    """Set ``key`` on a graph state that may be a dict or an object.

    LangGraph hands back a plain dict today, but the salvage path also sees
    whatever the last streamed chunk happened to be, so both shapes are
    supported. Guarded: annotating the state is transparency, never a reason to
    lose an answer that is otherwise ready to ship.
    """
    try:
        if isinstance(result, dict):
            result[key] = value
        else:
            setattr(result, key, value)
    except Exception:  # noqa: BLE001 - annotation must never fail the run
        logger.debug("Could not set state field %r", key, exc_info=True)


def _prepend_honesty_banner(
    report: str,
    *,
    cutoff_reason: str | None,
    degraded_reasons: list[str] | None,
) -> str:
    """Put the answer's own limitations at the top of the answer.

    German, like every other line this product writes to a reader, and in the
    register of the job runner's ``FAILURE_NOTICE``: factual, short, Sie-form,
    no invented error taxonomy. It rides the REPORT rather than only the state
    flags because the report is what travels furthest — into the conversation,
    the job output, the exported PDF — and someone reading only that must still
    be able to tell that it is partial.
    """
    sentences: list[str] = []
    if cutoff_reason is not None:
        cause = _CUTOFF_CAUSE_CLAUSES.get(cutoff_reason)
        if cause:
            sentences.append(
                f"Diese Recherche wurde {cause} vorzeitig beendet, der folgende Bericht ist daher unvollständig."
            )
        else:
            sentences.append("Diese Recherche wurde vorzeitig beendet, der folgende Bericht ist daher unvollständig.")
    if degraded_reasons:
        sentences.append("Die Angaben konnten nicht vollständig geprüft werden und sind nur eingeschränkt belastbar.")
    if not sentences:
        return report
    return f"{_HONESTY_BANNER_PREFIX} {' '.join(sentences)}\n\n{report.lstrip()}"


def _salvaged_report_length(text: str) -> int:
    """Length of the salvaged report itself, not counting the banner.

    The banner is roughly a hundred characters the agent wrote about itself.
    Counting it toward :data:`MIN_SALVAGE_REPORT_CHARS` would let a stub clear
    the bar purely because we had labelled it as a stub.
    """
    body = text
    if body.startswith(_HONESTY_BANNER_PREFIX):
        _, separator, remainder = body.partition("\n\n")
        if separator:
            body = remainder
    return len(body.strip())


def _summarize_removed_citations(removed_citations: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Summarize ``verify_citations`` drops for the transparency wire.

    Returns ``{"count": int, "reasons": [str, ...]}`` (reasons deduplicated in
    first-seen order, max 5) only when ≥1 citation was removed; otherwise
    ``None`` so the ``citations_removed`` field stays absent. Shape matches the
    chat researcher's ``_normalize_citations_removed`` reader.
    """
    if not removed_citations:
        return None
    reasons: list[str] = []
    for entry in removed_citations:
        reason = str(entry.get("reason") or "unverifiable") if isinstance(entry, dict) else "unverifiable"
        if reason and reason not in reasons:
            reasons.append(reason)
        if len(reasons) >= 5:
            break
    return {"count": len(removed_citations), "reasons": reasons}


def _cited_sources_to_wire(registry: Any, valid_citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Resolve the citations that survived verification back to wire sources.

    ``verify_citations`` proves each ``[N]`` marker points at a source the run
    really captured, and it is the ONLY place the ``[N]``→source binding exists.
    Everything a reader needs from a citation — the page to open the PDF at, the
    snippet to hover, the lane and binding note that say whether the norm binds
    them — lives on the registry entry behind that binding. Deep research
    computed both halves and then threw them away, so a deep answer's citations
    reached the frontend as bare numbers scraped back out of the Markdown while
    a shallow answer's arrived structured. This is the join, mirroring
    ``ShallowResearcherAgent``'s so both agents emit one shape.

    Deduplicated by entry identity in first-cited order: four passages of one
    Richtlinie are four citations but the reader wants the document once, and
    the first mention is the one whose ``[N]`` the prose leads with.

    Guarded twice over, because this runs on the SALVAGE path as well as the
    normal one and a truncated run is the likeliest producer of a half-built
    entry: one source that fails to serialise costs the reader that single chip,
    and a registry that fails outright costs the provenance block — never the
    finished answer it hangs off.
    """
    wire_sources: list[dict[str, Any]] = []
    try:
        seen_ids: set[int] = set()
        for citation in valid_citations:
            entry = None
            if citation.get("citation_key"):
                entry = registry.entry_for_citation_key(citation["citation_key"])
            elif citation.get("url"):
                entry = registry.entry_for_url(citation["url"])
            if entry is None or id(entry) in seen_ids:
                continue
            seen_ids.add(id(entry))
            number = citation.get("number")
            try:
                wire_sources.append(source_entry_to_wire(entry, number=number if isinstance(number, int) else None))
            except Exception:  # noqa: BLE001 - one bad source must not zero out the rest
                logger.warning(
                    "Skipping source that failed wire serialization: %s",
                    getattr(entry, "url", None) or getattr(entry, "citation_key", None),
                    exc_info=True,
                )
    except Exception:  # noqa: BLE001 - provenance is never worth failing an answer for
        logger.warning("Could not resolve cited sources for the citation wire", exc_info=True)
    return wire_sources


def _apply_renumbering(
    wire_sources: list[dict[str, Any]],
    renumber_map: dict[int, int] | None,
    removed_numbers: set[int] | frozenset[int] | list[int] | tuple[int, ...] | dict[int, Any] | None = None,
) -> None:
    """Re-label the wire sources with the numbers the READER will see.

    ``sanitize_report`` closes the gaps that ``verify_citations``' removals left
    in the ``[N]`` sequence, so the numbers captured during verification are
    stale by the time the report ships. Without this remap a chip is labelled
    ``[3]`` while the prose pointing at it now says ``[2]``, and the inline
    marker's anchor scrolls to a row that does not exist.

    Fail-closed on sanitize deaths: ``sanitize_report`` also DELETES source
    lines with shortened / truncated / unsafe URLs and strips their orphaned
    ``[N]`` markers from the prose. Those numbers arrive via
    ``removed_numbers`` (the pre-renumber originals) and their chips are
    dropped here — never remapped, never shipped as trusted/clickable at a
    URL the reader no longer sees. A wire number absent from a non-empty
    ``renumber_map`` is likewise dead (its line is gone) and is dropped too,
    so a future sanitizer rule that forgets to report a death still cannot
    leave a trusted chip at a removed URL.
    """
    # Defensive: tests mock sanitize_report with a MagicMock whose
    # renumber_map/removed numbers are auto-created mocks, not containers.
    if not isinstance(renumber_map, dict):
        renumber_map = {}
    if isinstance(removed_numbers, dict):
        dead: set[int] = {n for n in removed_numbers.keys() if isinstance(n, int)}
    elif isinstance(removed_numbers, (set, frozenset, list, tuple)):
        dead = {n for n in removed_numbers if isinstance(n, int)}
    else:
        dead = set()

    if dead or renumber_map:
        kept: list[dict[str, Any]] = []
        dropped = 0
        for source in wire_sources:
            number = source.get("number")
            if isinstance(number, int):
                if number in dead:
                    dropped += 1
                    continue
                if renumber_map and number not in renumber_map:
                    dropped += 1
                    continue
            kept.append(source)
        if dropped:
            logger.info(
                "Dropping %d wire source(s) whose citations sanitize_report removed: dead=%s",
                dropped,
                sorted(dead),
            )
            wire_sources[:] = kept

    if not renumber_map:
        return
    for source in wire_sources:
        number = source.get("number")
        if isinstance(number, int):
            source["number"] = renumber_map.get(number, number)


def _skills_block(runtime: SkillRuntime) -> str | None:
    """The writer's skills section: the catalog, then what is required of it.

    The same two blocks the shallow researcher renders, from the same runtime,
    so a skill that names both agents is presented to both of them in the same
    words. None when the run resolved no skills — the writer prompt then shows
    no skills section at all rather than an empty heading.
    """
    blocks = [block for block in (runtime.prompt_block(), runtime.forced_block()) if block]
    return "\n\n".join(blocks) if blocks else None


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
    #: This run's resolved skills. Carried here rather than staying local to
    #: ``_prepare_run`` because the runtime accumulates the activation list
    #: DURING the run, and ``_finalize`` is what reports it — a runtime that
    #: went out of scope at graph-build time is why deep research shipped
    #: ``skills_activated=None`` on every answer while shallow reported it.
    skill_runtime: SkillRuntime


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
        skill_runtime = self._build_skill_runtime(state)
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
        # Stateful trace callbacks (e.g. VerboseTraceCallback) mutate internal
        # per-run state, so a shared instance must not span runs (ADR-0018).
        callbacks = [cb.for_new_run() if hasattr(cb, "for_new_run") else cb for cb in self.callbacks]
        # Hand this run's registry to any callback that can hold one, so the
        # live citation stream can tell a source the run RETRIEVED from one the
        # model merely named. The accessor, not the registry object: the
        # middleware swaps in a session-scoped registry mid-run in conversation
        # mode, and a callback holding the first one would judge the whole
        # report against a registry the run stopped using.
        #
        # Done HERE rather than by whoever built the callback, for the reason
        # everything else in this method is: the registry is born per run, and
        # a caller that wired it once would be wiring one run's state onto an
        # instance shared by every run (ADR-0018). It also covers the
        # synchronous path, which no job runner touches at all.
        #
        # This is belt AND braces: run() also binds the session contextvar,
        # which is what the callback falls back to. That fallback is the one
        # that breaks quietly -- a contextvar does not survive every thread
        # hop LangChain's callback machinery can make, and the symptom is not
        # an error but a citation silently reported as uncited.
        for cb in callbacks:
            setter = getattr(cb, "set_source_registry", None)
            if callable(setter):
                setter(source_registry_middleware.active_registry)
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
    def _build_skill_runtime(state: DeepResearchAgentState) -> SkillRuntime:
        """Resolve this run's platform/org skills into a fresh runtime.

        Built HERE, per run, for the same reason the source registry and the
        tool wrappers are (ADR-0018): the runtime owns the activation list of
        one run, and this agent instance is shared across runs and across
        tenants. A runtime cached on ``self`` would announce one organization's
        house voice under another organization's report.

        The organization comes off the STATE first — deep research runs in a
        Dask worker where ``get_organization_id_from_context()`` reads no
        headers because there is no request — and falls back to the request
        context for the synchronous path and for evaluation runs.

        ``force_skills`` comes off the state too, and it is the user's own
        explicit instruction: a skill ticked in the composer, or named by a
        scheduled run. Passing it as ``force_names`` is what puts the skill's
        body in front of the writer instead of merely listing its name in the
        catalog — without it, a turn the user escalated to deep research
        silently ignored the skill they had just asked for.

        Nothing here can fail the run: ``resolve_served_skills`` swallows its
        own errors and an empty skill set produces an empty runtime, no tool and
        no prompt block, which is exactly the shape of a run that has no skills.
        """
        from aiq_agent.project_context import get_organization_id_from_context
        from aiq_agent.skills import SkillRuntime
        from aiq_agent.skills import resolve_served_skills

        organization_id = state.organization_id
        if not organization_id:
            try:
                organization_id = get_organization_id_from_context()
            except Exception:  # noqa: BLE001 - no NAT context in sync/eval paths
                organization_id = None
        skills = resolve_served_skills(SKILL_AGENT, organization_id)
        runtime = SkillRuntime(skills=skills, force_names=state.force_skills)
        if skills:
            from aiq_agent.skills.events import emit_skills_offered

            emit_skills_offered(runtime)
            logger.info(
                "Deep research resolved %d organization skill(s) for the writer; required: %s",
                len(skills),
                list(runtime.forced) or "none",
            )
        return runtime

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
        # Record the hardest citation failure there is — the run captured
        # nothing to cite — so it lands on the platform's citation-health
        # dashboard beside the softer defects, not only in the logs.
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

    async def run(self, state: DeepResearchAgentState) -> DeepResearchAgentState:
        """
        Execute deep research with multi-phase workflow.
        """
        run_artifacts = self._prepare_run(state)
        agent = run_artifacts.graph
        source_registry_middleware = run_artifacts.source_registry_middleware
        callbacks = run_artifacts.callbacks
        skill_runtime = run_artifacts.skill_runtime

        messages = state.messages
        if messages:
            query_content = messages[-1].content
            query = query_content if isinstance(query_content, str) else str(query_content)
            logger.info("=" * 80)
            logger.info("Deep Research Subagent: Starting workflow")
            logger.info("Query: %s...", query[:100])
            logger.info("=" * 80)

        # The live citation stream reads the SESSION registry to decide whether a
        # source it saw quoted was one this run actually retrieved. In a Dask
        # worker nothing binds one -- only the synchronous chat entrypoints do --
        # so every knowledge-base and OIB citation failed that check and was
        # never marked as cited: a run citing four Richtlinien and one web page
        # showed the web page alone, in a product whose sources are mostly
        # Richtlinien. Bind this run's registry so the check has something true
        # to read.
        #
        # ONLY when nothing is bound. In conversation mode the chat entrypoint
        # binds a registry that spans TURNS (see the README's run-lifecycle
        # note); replacing it with this run's would narrow cross-turn source
        # continuity to a single turn. An existing binding is someone else's
        # broader truth and is left alone.
        registry_token = None
        if get_session_registry() is None:
            registry_token = set_session_registry(source_registry_middleware.active_registry())

        # Fresh Langfuse trace contributions for THIS job. A Dask worker process
        # is reused across jobs and tenants, so without a per-job binding job N's
        # `feature:ifc` tag and `ifc_*` metadata would still be bound when job N+1
        # starts and would be stamped onto another tenant's traces. Unconditional:
        # even a job that never touches a model must not inherit the last one
        # that did. Reset in `finally` below, beside the session registry.
        from aiq_agent.observability.langfuse_trace_attributes import begin_trace_contributions
        from aiq_agent.observability.langfuse_trace_attributes import end_trace_contributions

        contributions_token = begin_trace_contributions()

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

            # The graph is STREAMED, not awaited as one opaque call, purely so a
            # cutoff has something to salvage. ``stream_mode="values"`` yields the
            # full graph state after every step, so the newest one we saw is the
            # run's last known state — including any report the writer already
            # persisted to /shared/output.md. Awaiting ``ainvoke`` instead meant
            # the wall-clock and step-limit cutoffs raised out of a call that had
            # never returned a state, and every research note, captured source,
            # and finished-but-unreturned report died with the exception.
            last_state: Any = None
            started = time.monotonic()

            async def _consume() -> Any:
                nonlocal last_state
                async for chunk in agent.astream(
                    state,
                    config=invoke_config or None,
                    stream_mode="values",
                    **ainvoke_kwargs,
                ):
                    last_state = chunk
                return last_state

            # Wall-clock budget: per-call request_timeout bounds a single HTTP
            # request, recursion_limit bounds step COUNT — neither bounds total
            # run time, so a pathological run could otherwise hold a worker
            # slot forever.
            try:
                if self.max_run_seconds > 0:
                    result = await asyncio.wait_for(_consume(), timeout=self.max_run_seconds)
                else:
                    result = await _consume()
            except TimeoutError as exc:
                # `asyncio.wait_for` raises TimeoutError -- and so does any
                # provider or transport call that times out inside the graph,
                # indistinguishably, because asyncio.TimeoutError IS
                # TimeoutError. Blaming the budget for both made an operator
                # counting budget overruns count 30-second provider hiccups as
                # 2400-second ones, which is worse than no metric: it reads as
                # evidence for raising a budget that was never reached.
                #
                # Elapsed time is the honest discriminator. Both are salvaged
                # identically -- what the run produced is worth the same either
                # way -- they are only NAMED apart.
                elapsed = time.monotonic() - started
                hit_budget = self.max_run_seconds > 0 and elapsed >= self.max_run_seconds
                if hit_budget:
                    reason = CUTOFF_WALL_CLOCK
                    original: BaseException = TimeoutError(
                        f"deep research exceeded the {self.max_run_seconds} s wall-clock budget"
                    )
                else:
                    reason = CUTOFF_UPSTREAM_TIMEOUT
                    original = TimeoutError(
                        f"deep research was cut off by an upstream timeout after {elapsed:.1f} s "
                        f"(well inside its {self.max_run_seconds} s budget)"
                    )
                return self._finalize_cutoff(
                    last_state,
                    cutoff_reason=reason,
                    elapsed_seconds=elapsed,
                    source_registry_middleware=source_registry_middleware,
                    callbacks=callbacks,
                    skill_runtime=skill_runtime,
                    original=original,
                    cause=exc,
                )
            except _GRAPH_RECURSION_ERRORS as exc:
                # The orchestrator ran out of steps. Identical treatment to the
                # clock: whatever it had produced by step N is still worth more
                # than an error page.
                return self._finalize_cutoff(
                    last_state,
                    cutoff_reason=CUTOFF_STEP_LIMIT,
                    elapsed_seconds=time.monotonic() - started,
                    source_registry_middleware=source_registry_middleware,
                    callbacks=callbacks,
                    skill_runtime=skill_runtime,
                    original=exc,
                    cause=exc,
                )
            except (RunBudgetExceededError, BudgetExceededError) as exc:
                # The run exhausted its completion-token ceiling or a USD budget
                # mid-batch. The batch tool re-raises (never a resubmittable
                # ToolMessage) and the middleware propagates, so the graph aborts
                # here instead of looping to the wall clock. Salvage what the run
                # had produced, marked — the same contract as the clock/steps,
                # counted apart so a sizing signal never reads as a slow run.
                return self._finalize_cutoff(
                    last_state,
                    cutoff_reason=CUTOFF_RUN_BUDGET,
                    elapsed_seconds=time.monotonic() - started,
                    source_registry_middleware=source_registry_middleware,
                    callbacks=callbacks,
                    skill_runtime=skill_runtime,
                    original=exc,
                    cause=exc,
                )

            return self._finalize(
                result,
                source_registry_middleware=source_registry_middleware,
                callbacks=callbacks,
                skill_runtime=skill_runtime,
                cutoff_reason=None,
            )

        except Exception as ex:
            logger.error("Deep Research Subagent failed: %s", ex, exc_info=True)
            raise
        finally:
            # A contextvar set in a worker process outlives the run that set it.
            # Leaking this one would hand the NEXT job on the same worker a
            # registry full of a previous question's sources, and it would look
            # like a run that cited things it never retrieved. Reset whether the
            # run returned, was cut off, or raised. Same for the trace
            # contributions: without it job N's IFC tags/metadata bleed into job
            # N+1's traces across tenants on a reused Dask worker.
            if registry_token is not None:
                reset_session_registry(registry_token)
            end_trace_contributions(contributions_token)

    def _finalize_cutoff(
        self,
        last_state: Any,
        *,
        cutoff_reason: str,
        elapsed_seconds: float,
        source_registry_middleware: SourceRegistryMiddleware,
        callbacks: list[Any],
        skill_runtime: SkillRuntime | None = None,
        original: BaseException,
        cause: BaseException,
    ) -> DeepResearchAgentState:
        """Salvage a cut-off run, or re-raise loudly when there is nothing to save.

        The salvage bar, deliberately conservative: post-processing has to yield
        a report of at least :data:`MIN_SALVAGE_REPORT_CHARS` characters, and the
        run's normal grounding guard still applies — a run that captured no
        sources still fails with ``EmptySourceRegistryError`` rather than shipping
        an unciteable stub under a "was cut off" banner. Anything that clears the
        bar is returned MARKED, never quietly.
        """
        source_count = 0
        try:
            source_count = len(source_registry_middleware.active_registry().all_sources())
        except Exception:  # noqa: BLE001 - counting must not mask the cutoff
            logger.debug("Could not count captured sources on cutoff", exc_info=True)

        if last_state is None:
            emit_deep_research_cutoff(
                reason=cutoff_reason,
                salvaged=False,
                source_count=source_count,
                report_chars=0,
                elapsed_seconds=elapsed_seconds,
            )
            logger.error(
                "Deep research cut off (%s) after %.1fs with NO partial state to salvage (captured sources: %d)",
                cutoff_reason,
                elapsed_seconds,
                source_count,
            )
            raise original from cause

        try:
            finalized = self._finalize(
                last_state,
                source_registry_middleware=source_registry_middleware,
                callbacks=callbacks,
                skill_runtime=skill_runtime,
                cutoff_reason=cutoff_reason,
            )
        except Exception as salvage_error:
            # Salvage failed its own guards (no report, nothing grounded). The
            # cutoff is the real story, so raise THAT — with the salvage failure
            # attached so the log shows why nothing was recoverable.
            emit_deep_research_cutoff(
                reason=cutoff_reason,
                salvaged=False,
                source_count=source_count,
                report_chars=0,
                elapsed_seconds=elapsed_seconds,
            )
            logger.error(
                "Deep research cut off (%s) after %.1fs; nothing salvageable (%s: %s)",
                cutoff_reason,
                elapsed_seconds,
                type(salvage_error).__name__,
                salvage_error,
            )
            raise original from salvage_error

        report_chars = _salvaged_report_length(self._extract_last_message_text(finalized) or "")
        if report_chars < MIN_SALVAGE_REPORT_CHARS:
            # Post-processing produced something, but not enough of something.
            # A stub under a truncation banner still reads as an answer, so it
            # is treated as nothing to salvage and the cutoff is raised loudly.
            emit_deep_research_cutoff(
                reason=cutoff_reason,
                salvaged=False,
                source_count=source_count,
                report_chars=report_chars,
                elapsed_seconds=elapsed_seconds,
            )
            logger.error(
                "Deep research cut off (%s) after %.1fs; salvaged only %d char(s), below the "
                "%d-char bar — failing the run instead of shipping a stub",
                cutoff_reason,
                elapsed_seconds,
                report_chars,
                MIN_SALVAGE_REPORT_CHARS,
            )
            raise original from cause

        emit_deep_research_cutoff(
            reason=cutoff_reason,
            salvaged=True,
            source_count=source_count,
            report_chars=report_chars,
            elapsed_seconds=elapsed_seconds,
        )
        logger.warning(
            "Deep research cut off (%s) after %.1fs; SALVAGED a %d-char report from "
            "%d captured source(s) instead of failing the run",
            cutoff_reason,
            elapsed_seconds,
            report_chars,
            source_count,
        )
        return finalized

    @staticmethod
    def _record_skill_transparency(result: Any, skill_runtime: SkillRuntime | None) -> None:
        """Say which skills shaped this report, and shout when a forced one did not.

        The runtime accumulates activations while the graph runs; nothing wrote
        them back, so ``skills_activated`` was None on every deep answer and the
        thread showed no skill transparency at all — while the same skill on the
        same question, answered shallow, was named. Mirrors the shallow
        researcher's post-run block so both agents report the same two facts.

        DELIVERED, not merely forced: a skill whose body the model never opened
        shaped nothing and must not be claimed. Its counterpart — the turn told
        the model to apply a skill and it never asked for it — is the failure
        nobody can see from the answer, so it is logged loudly. What the READER
        should be told about it is a product decision, not this function's.

        Guarded whole: transparency about an answer must never unmake it.
        """
        if skill_runtime is None:
            return
        try:
            activated = list(skill_runtime.activated)
            if activated:
                _set_state_field(result, "skills_activated", activated)
            hidden = list(skill_runtime.hidden_activated)
            if hidden:
                _set_state_field(result, "skills_hidden", hidden)
            unread = skill_runtime.forced_not_activated
            if unread:
                logger.warning(
                    "Deep research: forced skills never loaded by the writer: %s (activated=%s)",
                    ", ".join(unread),
                    ", ".join(activated) or "-",
                )
        except Exception:  # noqa: BLE001 - reporting skills must never fail the run
            logger.warning("Could not record deep-research skill transparency", exc_info=True)

    def _finalize(
        self,
        result: Any,
        *,
        source_registry_middleware: SourceRegistryMiddleware,
        callbacks: list[Any],
        skill_runtime: SkillRuntime | None = None,
        cutoff_reason: str | None,
    ) -> DeepResearchAgentState:
        """Turn a graph state into the finished, verified, honestly-labelled answer.

        Shared by the normal path and the salvage path so a cut-off run is
        post-processed by exactly the same citation verification, quote
        verification and sanitisation as a complete one — the only difference
        being the banner and the flags that say it was cut off. That sharing is
        why the transparency this writes — the structured sources, the skills
        that shaped the report — is built with the same guards on both paths: a
        run that was cut off still owes the reader whatever provenance it did
        manage to capture.
        """
        degraded_reasons: list[str] = []
        # What the overconfidence guard is allowed to see. The defaults describe
        # a run that checked nothing: no citation survived verification (none was
        # ever verified) and no quoted span was contradicted. They hold on the
        # ``enable_citation_verification=False`` path, where "no verified
        # citation" is the literal truth about the answer and the guard therefore
        # refuses to surface anything above "low" — a report nobody checked must
        # not wear the chip that means "checked against a retrieved passage".
        citation_grounded = False
        quotes_verified = True
        # The sources this report cited, wire-ready. Collected inside the
        # verification branch (only the verifier knows which citations are real)
        # but serialised onto the state below, AFTER sanitisation has settled
        # the numbers the reader will actually see.
        wire_sources: list[dict[str, Any]] = []

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
            # Not just a log line any more: an answer that is a chat message
            # wearing a report's clothes is materially weaker than a written
            # report, and the reader is now told so.
            degraded_reasons.append(DEGRADED_NO_REPORT_FILE)
            final_message = fallback

        # Take the writer's self-assessment out of the report before ANY other
        # reader touches it. Everything below this line — citation verification,
        # quote annotation, sanitisation, the honesty banner, the re-emit to the
        # live socket, the message the job runner stores and the PDF exported
        # from it — operates on the text this produces, so a marker left in place
        # here surfaces to a reader as a stray "[CONFIDENCE:high]" in the prose
        # of the product's most formal artifact. Fail-open by construction:
        # a missing or malformed marker yields no signal and changes nothing.
        final_message, self_reported_confidence, self_reported_confidence_reason = detect_and_strip_confidence_marker(
            final_message
        )

        # Post-process: verify citations against source registry
        if self.enable_citation_verification and source_registry_middleware.has_sources():
            registry = source_registry_middleware.active_registry()
            verification = verify_citations(
                final_message,
                registry,
                reference_sources=source_registry_middleware.get_source_entries(mode="compact"),
            )
            unverified_quote_count = 0
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
                # Transparency: surface the removal on the result state so the
                # chat orchestrator can lift it onto the terminal chunk. Only
                # set when >=1 citation was actually removed (field stays absent
                # otherwise). result is the LangGraph state dict validated below.
                citations_removed_summary = _summarize_removed_citations(verification.removed_citations)
                if citations_removed_summary is not None:
                    _set_state_field(result, "citations_removed", citations_removed_summary)
            final_message = verification.verified_report
            # Quote verification: verify_citations only proves each cited
            # SOURCE is real, not that a QUOTED sentence actually appears in
            # it. Catch the weak model's "real section, fabricated quote"
            # pattern by checking each quoted span against the retrieved
            # passage text. Fail-open: annotate inline, never strip.
            unverified_quotes = verify_quoted_spans(final_message, registry)
            if unverified_quotes:
                final_message = annotate_unverified_quotes(final_message, unverified_quotes)
                unverified_quote_count = len(unverified_quotes)
                logger.info(
                    "Citation verification: %d quoted span(s) not verbatim in any retrieved passage; annotated inline",
                    len(unverified_quotes),
                )
                # An annotated quote still ships, so it must ship MARKED: without
                # this the salvaged report reads exactly like a verified one.
                # Shared by the normal and salvage paths (_finalize_cutoff calls
                # through here), so a budget cut-off can never launder an
                # unverified quote into a verified answer.
                degraded_reasons.append(DEGRADED_UNVERIFIED_QUOTES)
            if not verification.valid_citations:
                logger.warning(
                    "Citation verification found no valid citations in writer-agent output; "
                    "returning the generated report without failing the job. "
                    "This may indicate unsupported citation formatting or over-aggressive verification."
                )
                # A report with nothing provably grounded looked exactly like a
                # good one until here. It still ships — over-aggressive
                # verification is a real possibility, so this is not a failure —
                # but it no longer ships silently.
                degraded_reasons.append(DEGRADED_NO_VALID_CITATIONS)

            # Resolve the surviving citations back to their registry entries and
            # serialise them for the wire. Everything needed was already in hand
            # here and was previously discarded after logging, which is why a
            # deep reader got numbers and nothing to click.
            wire_sources = _cited_sources_to_wire(registry, list(verification.valid_citations))

            # Citation-health ledger: one batch per deep-research run, the
            # same shape the shallow researcher posts — including, now that the
            # writer states one, the reason its self-assessment was capped.
            #
            # The whole registry IS this run's retrieval here — the deep
            # researcher builds a fresh SourceRegistry per run (ADR-0018),
            # unlike the shallow agent's registry, which is cumulative
            # across a conversation and therefore needs the per-turn capture
            # log to keep source_count comparable to cited_count. The
            # asymmetry is intentional; do not "align" them.
            registry_sources = registry.all_sources()
            citation_grounded = bool(verification.valid_citations)
            # One fabricated quotation is enough: the guard drops the whole
            # answer to "low" rather than letting the citations that DID verify
            # vouch for the sentence that did not.
            quotes_verified = unverified_quote_count == 0
            citation_events.record_turn(
                agent="deep",
                source_count=len(registry_sources),
                cited_count=len(verification.valid_citations),
                removed_citations=list(verification.removed_citations),
                unverified_quote_count=unverified_quote_count,
                grounded=bool(verification.valid_citations),
                # Deep research has NO single-source fallback — an ungrounded
                # report hard-fails with EmptySourceRegistryError rather than
                # borrowing the one source lying around (deliberate strictness;
                # do not align it with shallow). Stated explicitly so the
                # dashboard's fallback rate reads "deep never falls back"
                # instead of inheriting a default nobody chose.
                fallback_used=False,
                # Recomputed from the same inputs the state field below uses, so
                # the dashboard and the reader's chip can never disagree about
                # WHY a report was downgraded. Deriving it here rather than
                # threading the value down keeps the shallow researcher's
                # arrangement, where this call and the surfacing site each ask
                # the one function that owns the taxonomy.
                confidence_capped_reason=answer_confidence_capped_reason(
                    self_reported_confidence,
                    citation_grounded,
                    quotes_verified,
                ),
                source_origins=[source_origin_token(entry).strip("[]").lower() or None for entry in registry_sources],
                # The retrieval lane of each CITED source, which the dashboard's
                # defect mix breaks down by. Only the wire entries carry it —
                # the lane is derived during serialisation, not stored on the
                # registry entry — so this is the first run at which deep can
                # report it at all.
                source_lanes=[source.get("lane") for source in wire_sources],
                source_tools=[entry.tool_name or None for entry in registry_sources],
                # Source IDENTITIES (URL / document key) — never report prose.
                retrieved_source_labels=[label for label in map(source_label, registry_sources) if label],
                cited_source_labels=[
                    label
                    for label in ((c.get("citation_key") or c.get("url")) for c in verification.valid_citations)
                    if label
                ],
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
        # Sanitisation renumbers the surviving ``[N]`` markers, so the chips have
        # to follow the prose or they point at rows that no longer exist — and
        # it DELETES shortened/unsafe/truncated source lines, whose chips must
        # be dropped fail-closed (never a trusted chip at a removed URL).
        _apply_renumbering(
            wire_sources,
            sanitization.renumber_map,
            getattr(sanitization, "removed_citation_numbers", None),
        )
        if wire_sources:
            # Absent, never empty: a run that cited nothing resolvable says so by
            # carrying no field, exactly like ``degraded_reasons`` below — a
            # surface cannot tell "we checked and found none" from "we lost them"
            # once an empty list is written.
            _set_state_field(result, "verified_sources", wire_sources)

        # A cut-off run is salvaged, never disguised. The banner rides the REPORT
        # itself rather than only the state flags, because the report is the
        # artifact that travels furthest — into the conversation, the job output,
        # and the exported document — and a flag that only the live socket
        # understands would not reach a reader opening the PDF next week.
        if cutoff_reason is not None or degraded_reasons:
            final_message = _prepend_honesty_banner(
                final_message,
                cutoff_reason=cutoff_reason,
                degraded_reasons=degraded_reasons,
            )

        self._record_skill_transparency(result, skill_runtime)

        if cutoff_reason is not None:
            _set_state_field(result, "research_truncated", True)
            _set_state_field(result, "truncation_reason", cutoff_reason)
        if degraded_reasons:
            _set_state_field(result, "degraded_reasons", list(degraded_reasons))
            emit_answer_degraded(agent="deep", reasons=degraded_reasons)

        # The confidence chip, at last, on the longest answers the product
        # writes. Surfaced only after the run's own limitations are known, since
        # both of them cap it: the shared guard downgrades a report whose
        # citations or quotations did not survive verification, and the deep-only
        # ceiling above downgrades one whose evidence-gathering never finished.
        # Guarded whole — a self-assessment is a label on an answer, never a
        # reason to lose one, so a run cut off at its budget still returns its
        # salvaged report even if this block cannot say how sure of it we are.
        try:
            surfaced_confidence = _cap_for_incomplete_evidence(
                surface_answer_confidence(self_reported_confidence, citation_grounded, quotes_verified),
                cutoff_reason=cutoff_reason,
                degraded_reasons=degraded_reasons,
            )
            if surfaced_confidence is not None:
                # Absent, never null-spammed: no marker means "not assessed", and
                # a surface must be able to tell that from a level of "low".
                _set_state_field(result, "answer_confidence", surfaced_confidence)
                if self_reported_confidence_reason:
                    _set_state_field(result, "answer_confidence_reason", self_reported_confidence_reason)
                capped_reason = answer_confidence_capped_reason(
                    self_reported_confidence,
                    citation_grounded,
                    quotes_verified,
                )
                if capped_reason is not None:
                    _set_state_field(result, "answer_confidence_capped_reason", capped_reason)
        except Exception:  # noqa: BLE001 - grading an answer must never unmake it
            logger.warning("Could not surface the deep report's self-assessed confidence", exc_info=True)

        # Re-emit the verified/sanitized report so the frontend overwrites
        # the raw version that on_llm_end auto-emitted during the stream.
        #
        # Guarded, because this runs INSIDE _finalize and _finalize_cutoff
        # treats a raised _finalize as "nothing to salvage": a report sink that
        # throws would destroy a verified report that exists and then log the
        # false sentence "nothing salvageable" about it. Delivering the answer
        # to the caller outranks echoing it to a display, so a sink that fails
        # costs its own echo and nothing else. (The shipped event store swallows
        # its own errors, so this is a latent path, not a hot one — which is
        # exactly when a guard is cheap.)
        for cb in callbacks:
            if hasattr(cb, "emit_final_report"):
                try:
                    cb.emit_final_report(final_message)
                except Exception:  # noqa: BLE001 - an echo must never unmake the answer
                    logger.warning("Could not re-emit the final report to a callback", exc_info=True)
                break

        self._replace_last_message_content(result, final_message)

        logger.info("=" * 80)
        logger.info("Deep Research Subagent: Workflow complete")
        logger.info("Final answer length: %d characters", len(final_message))
        if cutoff_reason or degraded_reasons:
            logger.info(
                "Answer shipped MARKED (cutoff=%s degraded=%s)",
                cutoff_reason or "-",
                ",".join(degraded_reasons) or "-",
            )
        logger.info("=" * 80)
        return DeepResearchAgentState.model_validate(result)

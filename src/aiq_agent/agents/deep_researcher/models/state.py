"""State models for deep research agent."""

from typing import Annotated
from typing import Any
from typing import Literal

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel
from pydantic import Field

from aiq_agent.knowledge import AvailableDocument


def _merge_dict_state(left: dict[str, Any] | None, right: dict[str, Any] | None) -> dict[str, Any]:
    if not left:
        return right or {}
    if not right:
        return left
    merged = dict(left)
    merged.update(right)
    return merged


class DeepResearchAgentState(BaseModel):
    """
    State for deep research agent.

    The deepagents-based DeepResearcherAgent manages its own internal state
    through the deepagents library. This state primarily handles the interface
    with the orchestrator.

    Attributes:
        messages: Conversation history with LangGraph message reducer.
        data_sources: List of data sources selected by the user.
        user_info: Optional user information.
        tools_info: Information about available tools.
        todos: Todo list managed by TodoListMiddleware.
        files: Virtual filesystem managed by FilesystemMiddleware.
        subagents: Status of configured DeepAgents subagents.
        rubric: DeepAgents rubric used by RubricMiddleware when available.
        clarifier_result: Log from clarifier agent dialog.
        available_documents: User-uploaded documents with summaries for context.
    """

    messages: Annotated[list[AnyMessage], add_messages]
    data_sources: list[str] | None = None
    user_info: dict[str, Any] | None = None
    tools_info: list[dict[str, Any]] | None = None
    todos: list[dict[str, Any]] = Field(default_factory=list)
    files: Annotated[dict[str, Any], _merge_dict_state] = Field(default_factory=dict)
    subagents: list[dict[str, Any]] = Field(default_factory=list)
    rubric: str | None = None
    clarifier_result: str | None = None
    available_documents: list[AvailableDocument] | None = None
    project_context: str | None = None
    # The rendered PLATFORM_LESSONS block — anonymized fleet-wide process
    # cautions distilled from user down-votes. Injected like project_context
    # (the chat orchestrator sets it for the in-process path; the async job
    # carries it in its payload), because a deep-research report is exactly
    # the kind of long answer a reported failure pattern should not recur in.
    platform_lessons: str | None = None
    # Transparency summary of citations dropped by ``verify_citations`` during
    # report post-processing (``{"count": int, "reasons": [str, ...]}``).
    # Populated by ``run()`` ONLY when ≥1 citation was removed; None otherwise.
    # The chat orchestrator lifts it onto the terminal chunk via
    # ``_normalize_citations_removed``.
    citations_removed: dict[str, Any] | None = None
    # Evidence-gathering was CUT OFF, not completed: the run hit its wall-clock
    # budget or the orchestrator's step limit and the answer was salvaged from
    # whatever it had reached by then. Set ONLY on a cutoff (None otherwise), so
    # presence is the fact — the same contract the shallow researcher's
    # ``research_truncated`` uses, and the field the websocket layer already
    # lifts onto the terminal frame.
    research_truncated: bool | None = None
    # WHY the run was cut off, as a stable token (``wall_clock`` / ``step_limit``)
    # for the operator channel. Never prose: the reader is told about truncation
    # by the report's own banner, in the product's voice.
    truncation_reason: str | None = None
    # Ways this answer is weaker than a clean run, as stable tokens
    # (``no_report_file``, ``no_valid_citations``). These used to be
    # ``logger.warning`` only — a degraded answer shipped looking exactly like a
    # good one. Empty/None means the run degraded in none of the known ways.
    degraded_reasons: list[str] | None = None
    # The tenant whose skills this run resolves (``x-grid-organization-id`` on
    # the synchronous path). Carried on the STATE rather than read from the
    # request context because deep research runs in a Dask worker, where no
    # request headers exist: the job runner captured the identity at submit time
    # and injects it here, the same way it injects ``project_context`` and
    # ``force_skills``. None means anonymous — the run then resolves no
    # organization skills and writes its report without them.
    organization_id: str | None = None
    # Structured provenance for the sources this report actually CITED:
    # wire-ready dicts from ``source_entry_to_wire``, each carrying the ``[N]``
    # label it wears in the prose plus the locator (document/file/page), the
    # coarse ``kind`` and the norm registry's binding note. Same field name and
    # same shape as the shallow researcher's, because the two feed one reader:
    # the job runner lifts it into the job output and into the message metadata
    # as ``sources``, where the BFF's ``normalizeAgentAnswerMetadata`` decodes
    # it into the stored ``citations`` envelope. Without it a deep answer's
    # citations were nothing but numbers parsed back out of the Markdown — no
    # open-PDF-at-page, no hover snippet, no authority badge — even though the
    # run had resolved every one of those facts and then dropped them.
    # None when the run cited nothing it could resolve to a captured source.
    verified_sources: list[dict[str, Any]] | None = None
    # Skill names the incoming request FORCED for this run (the user ticked them
    # in the composer, or a scheduled run named one). The job runner injects
    # them the same way it injects ``project_context`` — and until this field
    # existed the injection was guarded out silently, so escalating a turn to
    # deep research quietly discarded an explicit instruction. None = none forced.
    force_skills: list[str] | None = None
    # Ordered names of the skills whose BODY reached the writer, forced ones
    # first. DELIVERED, not merely forced: this is rendered to the reader as
    # "what shaped this answer", and a skill the model never opened shaped
    # nothing. None when the run resolved or activated no skills.
    skills_activated: list[str] | None = None
    # The writer's own self-assessment of how well the report is grounded in the
    # sources it cited, parsed from the trailing ``[CONFIDENCE:...]`` marker in
    # ``/shared/output.md`` and already passed through the deterministic
    # overconfidence guard. Same three names and shapes the shallow/chat path
    # uses, because one reader consumes both: the job runner lifts them onto the
    # job output and the frontend renders one confidence chip either way. A deep
    # answer used to carry none of this, so the chip the product shows beside
    # every shallow answer was simply missing on the longest reports it writes —
    # which reads as a broken feature, not as "not assessed". None means "no
    # signal" (marker absent or malformed) and nothing renders.
    answer_confidence: Literal["low", "medium", "high"] | None = None
    # The writer's own one-clause justification from ``[CONFIDENCE:level | reason]``,
    # shown to the reader verbatim. Describes the RAW self-assessment: when the
    # guard capped the level, this reason may still argue for the pre-cap one.
    answer_confidence_reason: str | None = None
    # Why the surfaced level is lower than the writer claimed, in the shared
    # five-token taxonomy (see ``shallow_researcher.markers.CappedReason``).
    # Deep never measures an IFC model and has no single-source fallback, so in
    # practice only ``ungrounded`` and ``quote_unverified`` can occur here — the
    # other three are kept so a surface never has to branch on which agent wrote
    # the answer. A run cut off by its budget is capped too, but says so through
    # ``research_truncated`` and the report's own banner rather than through a
    # sixth token no reader's dictionary has.
    answer_confidence_capped_reason: (
        Literal[
            "ungrounded",
            "quote_unverified",
            "normative_claim_uncited",
            "measurement_only",
            "citation_fallback",
        ]
        | None
    ) = None
    # The subset of ``skills_activated`` marked ``grid-hidden`` — a skill that
    # runs on every answer (the house voice) is still named in the disclosure,
    # just de-emphasised until the reader opens the reasoning view. Named, never
    # dropped: the transparency doctrine forbids a class of instruction the
    # product declines to admit ran.
    skills_hidden: list[str] | None = None

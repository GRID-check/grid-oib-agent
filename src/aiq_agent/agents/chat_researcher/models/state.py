"""State models for chat researcher agent.

NOTE: any new pydantic state type added below (or nested inside these fields)
MUST also be added to the checkpointer allow-list in
``aiq_agent/common/__init__.py`` (``_build_checkpointer_serde``). The
checkpointer deserializes with a STRICT msgpack allow-list; a type missing from
that list will break checkpoint restore for states that contain it.
"""

from typing import Annotated
from typing import Any
from typing import Literal

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel

from aiq_agent.knowledge import AvailableDocument

from .depth import DepthDecision
from .intent import IntentResult
from .result import ShallowResult


class ChatResearcherState(BaseModel):
    """
    State for the main chat researcher workflow graph.

    Attributes:
        messages: Conversation history with LangGraph message reducer.
        tools_info: Information about available tools.
        user_info: Optional user information for personalization.
        data_sources: Optional list of user-selected data source IDs.
        user_intent: Result of intent classification.
        depth_decision: Result of depth routing.
        final_report: The final research report.
        shallow_result: Result from shallow research (if executed).
        clarifier_result: Log from clarifier agent dialog.
        original_query: The latest user query, preserved for deep research.
        available_documents: User-uploaded documents with summaries for context.
        in_flight_documents: Filenames whose ingestion has not finished, so they
            are absent from ``available_documents`` AND unreachable by retrieval.
            The distinction matters: without it a just-attached plan looks
            exactly like a file that does not exist, and the answer omits it
            silently instead of saying it could not be read yet.
        focus_file_name: Filename of the composer's "Asking about <file>" subject.
        focus_shelf: Shelf that focused file sits on (session/project/archiv).
        cards: Structured response cards generated from the final research context.
        skip_clarifier: When True the clarifier node is bypassed regardless of
            ``enable_clarifier``.  Set automatically for API-key and anonymous
            callers so headless workflows do not stall waiting for user input.
        deep_research_declined: Sticky per-conversation flag set when the user
            rejects or cancels a research plan; suppresses the deep route
            thereafter.
    """

    messages: Annotated[list[AnyMessage], add_messages]
    user_info: dict[str, Any] | None = None
    data_sources: list[str] | None = None
    user_intent: IntentResult | None = None
    depth_decision: DepthDecision | None = None
    final_report: str | None = None
    shallow_result: ShallowResult | None = None
    clarifier_result: str | None = None
    original_query: str | None = None
    available_documents: list[AvailableDocument] | None = None
    in_flight_documents: list[str] | None = None
    collection_scope: list[str] | None = None
    # The composer's "Asking about <file>" subject, as stated on the wire
    # (``focus_file_name`` / ``focus_shelf``). Retrieval already reads it from
    # the turn ContextVars; the state carries it so the ANSWERING prompts can
    # resolve a deictic question ("summarize this document") to a filename.
    # Without it a bare "fass zusammen" has no antecedent and the model asks
    # which file instead of retrieving the one the user is looking at.
    focus_file_name: str | None = None
    focus_shelf: str | None = None
    cards: list[dict[str, Any]] | None = None
    skip_clarifier: bool = False
    # STICKY, for the life of the conversation: the user rejected a research
    # plan. A rejection is not a cancel — the question is still on the table and
    # is answered on the shallow path in the same turn — but it is also durable
    # information about what this reader wants, so it keeps the deep route (both
    # the classifier's "deep" and the shallow agent's [ESCALATE_TO_DEEP]) from
    # putting another plan in front of them for the rest of the thread. A user
    # who has said no to a plan should not have to say it again.
    #
    # It survives the turn boundary by being DELIBERATELY ABSENT from the input
    # dict `run()` builds: fields listed there are overwritten with the fresh
    # per-turn state's defaults, fields omitted keep their checkpointed value.
    # Adding it to that dict would reset it every turn and make it useless.
    # A new conversation is a new thread and therefore a clean slate — that is
    # the deliberate way back to deep research.
    deep_research_declined: bool | None = None
    project_context: str | None = None
    # The bounded PLATFORM_LESSONS digest — anonymized failure patterns
    # distilled from user down-votes across the whole platform
    # (docs/architecture/platform-failure-learning.md). Fetched per turn by the
    # register layer (TTL-cached, fail-open to None) and rendered as its own
    # guarded prompt section, deliberately OUTSIDE project_context: lessons
    # apply to every turn, project or not, and must not inherit the profile's
    # "confirmed facts bind" framing.
    platform_lessons: str | None = None
    # Set when a deep-research run is dispatched as an async job. Carried as a
    # STRUCTURED signal to the frontend (instead of the frontend regex-parsing
    # the "Deep research job submitted. Job ID: ..." prose) so deep-research
    # visibility no longer breaks on any wording change.
    deep_research_job_id: str | None = None
    # The model's own self-assessment of how well the shallow answer is grounded
    # in its sources, parsed from the trailing `[CONFIDENCE:...]` marker and
    # already passed through the deterministic overconfidence guard. Surfaced to
    # the frontend as an honest self-assessment chip. None means "no signal"
    # (marker absent/malformed, or an error/escalation turn) — nothing renders.
    # Distinct from the internal ShallowResult.confidence error-certainty proxy.
    answer_confidence: Literal["low", "medium", "high"] | None = None
    # Structured sources from the shallow researcher's registry (wire dicts with
    # file_name/page/collection/origin). Attached to ChatResponse as ``sources``.
    verified_sources: list[dict[str, Any]] | None = None
    # --- Transparency extras (WP-A) -------------------------------------------
    # All optional/additive: absent means "unknown/not applicable". Lifted onto
    # the terminal ChatResponseChunk (register._STREAM_EXTRA_FIELDS) and then onto
    # the terminal system_response_message (websocket_reconnect), same path as
    # ``answer_confidence``/``deep_research_job_id``. Never null-spammed.
    #
    # Which path the turn took after intent classification (derived from
    # ``user_intent``/``depth_decision`` — see ``derive_routing_decision``).
    routing_decision: Literal["meta", "shallow", "deep", "error"] | None = None
    # Human-readable why, verbatim from the depth classifier's ``raw_reasoning``.
    routing_reason: str | None = None
    # Present only when a shallow→deep escalation happened this turn. Set by the
    # clarifier node from ``ShallowResult.escalation_reason`` or, on the
    # keyword-fallback path, the fixed German notice.
    escalation_reason: str | None = None
    # Present only when the self-reported confidence was downgraded. Five causes:
    #   "ungrounded"              nothing verified and nothing measured.
    #   "quote_unverified"        a quoted span matched no retrieved passage.
    #   "normative_claim_uncited" the answer WAS measurement-grounded but also
    #                             asserts something normative with no verified
    #                             citation — the mixed case, held at "low" and
    #                             named rather than resolved in the measurement's
    #                             favour.
    #   "measurement_only"        measured and purely descriptive, so "high" was
    #                             reduced to "medium" rather than to "low".
    #   "citation_fallback"       the only citation came from the single-source
    #                             fallback — real, but not one the model wrote,
    #                             and possibly captured on an earlier turn — so
    #                             it lifts no further than a measurement does.
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
    # The model's own one-clause justification for its self-assessment, parsed
    # from the ``[CONFIDENCE:level | reason]`` marker. Present only when the
    # marker carried a reason; surfaced so the UI can show WHY the level was
    # chosen. Note it describes the RAW self-assessment — when the guard capped
    # the level (``answer_confidence_capped_reason`` set), the model's reason may
    # refer to the pre-cap level.
    answer_confidence_reason: str | None = None
    # Present only when citation verification removed ≥1 citation from the answer:
    # ``{"count": int, "reasons": [str, ...]}`` (reasons deduplicated, max 5).
    citations_removed: dict[str, Any] | None = None
    # TRUE when the research turn was cut off at its tool-iteration ceiling and
    # forced into synthesis. Absent on every turn that finished inside its
    # budget: presence is the fact. Lifted onto the terminal ChatResponse as
    # ``research_truncated`` so the answer can say that its evidence-gathering
    # stopped early — which is orthogonal to ``answer_confidence`` (that grades
    # whether the claims are sourced; a truncated answer can be perfectly
    # grounded in the little it did find).
    research_truncated: bool | None = None
    # Marks the answer text as a queue-rejection notice (deep-research admission
    # control refused the job), NOT a research answer.
    job_admission_rejected: bool | None = None
    # Retry hint in seconds, only alongside ``job_admission_rejected``.
    retry_after_seconds: int | None = None
    # Skill names the user's request FORCED for this turn (parsed from the WS
    # content JSON's `skills` array). Threaded into the shallow researcher's
    # per-run SkillRuntime — research turns resolve them against the run's
    # skill set; meta turns and deep-research jobs ignore them.
    # NOTE: plain types only (list[str] | None) — a new pydantic TYPE would
    # also need registering in the checkpointer serde allowlist
    # (aiq_agent/common/__init__.py).
    force_skills: list[str] | None = None
    # Ordered names of the skills whose BODY reached the model this turn, in
    # delivery order (``use_skill``), deduped — never a skill that was merely
    # forced, which shaped nothing. Set on the success path of
    # ``_finalize_shallow_answer`` and lifted onto the terminal ChatResponse
    # ONLY when present (escaped escalations and generation failures leave it
    # None), the ``skills_activated`` transparency extra.
    skills_activated: list[str] | None = None
    # The subset of ``skills_activated`` marked ``grid-hidden`` — the house
    # voice and the card grammar, craft machinery the reader has no use for
    # reading as a topic. Carried for the same reason and by the same route as
    # ``skills_activated`` (set on the success path of
    # ``_finalize_shallow_answer``, dropped on escalation, lifted onto the
    # terminal ChatResponse only when non-empty): the disclosure NAMES these
    # skills like any other — the transparency doctrine forbids an instruction
    # class the product declines to admit ran — and only DE-EMPHASISES them
    # until the reader turns the reasoning view on. Absent means "none hidden",
    # which is why the frontend mutes nothing when it never arrives.
    skills_hidden: list[str] | None = None

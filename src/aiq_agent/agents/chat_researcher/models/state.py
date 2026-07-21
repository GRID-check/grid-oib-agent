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
        cards: Structured response cards generated from the final research context.
        skip_clarifier: When True the clarifier node is bypassed regardless of
            ``enable_clarifier``.  Set automatically for API-key and anonymous
            callers so headless workflows do not stall waiting for user input.
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
    collection_scope: list[str] | None = None
    cards: list[dict[str, Any]] | None = None
    skip_clarifier: bool = False
    project_context: str | None = None
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
    # Present only when the self-reported confidence was downgraded: "ungrounded"
    # (answer lacked citation grounding) or "quote_unverified" (a quoted span was
    # not verifiable against a retrieved passage).
    answer_confidence_capped_reason: Literal["ungrounded", "quote_unverified"] | None = None
    # Present only when citation verification removed ≥1 citation from the answer:
    # ``{"count": int, "reasons": [str, ...]}`` (reasons deduplicated, max 5).
    citations_removed: dict[str, Any] | None = None
    # Marks the answer text as a queue-rejection notice (deep-research admission
    # control refused the job), NOT a research answer.
    job_admission_rejected: bool | None = None
    # Retry hint in seconds, only alongside ``job_admission_rejected``.
    retry_after_seconds: int | None = None

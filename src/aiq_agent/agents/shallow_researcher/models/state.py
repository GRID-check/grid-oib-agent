"""State models for shallow research agent."""

from typing import Annotated
from typing import Any
from typing import Literal

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel

from aiq_agent.knowledge import AvailableDocument


class ShallowResearchAgentState(BaseModel):
    """
    State for shallow research agent subgraph.

    Attributes:
        messages: Conversation history with LangGraph message reducer.
        data_sources: List of data sources selected by the user.
        user_info: Optional user information.
        tools_info: Information about available tools.
        available_documents: User-uploaded documents with summaries for context.
        collection_name: Knowledge collection name (for fetching documents).
        tool_iterations: Counter for tool-calling iterations.
        requires_sources: Whether this turn must be grounded in captured sources.
            True for research turns (an empty source registry is a failure —
            EmptySourceRegistryError). False for conversational/meta turns, which
            legitimately answer from persona/project context without any sources;
            the orchestrator sets this based on the classified intent. Defaults to
            True so standalone/eval callers keep the strict research contract.
        answer_citation_grounded: Whether the final answer carries at least one
            verified citation after citation verification. Set by ``run()`` — it
            is True only when verification kept a valid citation (or a single
            registry source was appended as the one minimal citation), and False
            when the registry was empty or verification removed every citation.
            The chat node reads it as the deterministic overconfidence guard:
            a model self-reported "high"/"medium" is capped to "low" when the
            answer is not grounded. Defaults to False (conservative).
    """

    messages: Annotated[list[AnyMessage], add_messages]
    data_sources: list[str] | None = None
    user_info: dict[str, Any] | None = None
    tools_info: list[dict[str, Any]] | None = None
    available_documents: list[AvailableDocument] | None = None
    collection_name: str | None = None
    tool_iterations: int = 0
    project_context: str | None = None
    requires_sources: bool = True
    answer_citation_grounded: bool = False
    # Whether every QUOTED span in the final answer was found (fuzzily) in a
    # retrieved passage. Set by ``run()``: True by default (and when there is
    # nothing to check — no sources or no quotes), False when a quoted sentence
    # could not be verified against any source's chunk text (the weak model's
    # "real section, fabricated quote" pattern). The chat node composes it with
    # ``answer_citation_grounded`` to cap confidence to "low" with the
    # ``quote_unverified`` reason. Fail-open default True.
    answer_quotes_verified: bool = True
    # Structured control-marker signals extracted (and stripped from the answer
    # text) inside ShallowResearcherAgent.run(). The chat orchestrator reads these
    # instead of re-parsing the answer string. ``escalation_requested`` doubles as
    # the extraction sentinel: None means "extraction did not run" (older caller,
    # or no real answer message) → the chat node falls back to string detection;
    # a bool means extraction ran and the value is authoritative.
    escalation_requested: bool | None = None
    # Parsed ``[CONFIDENCE:...]`` self-assessment level (the raw marker value,
    # before the chat node's overconfidence guard). None = marker absent/malformed
    # (or extraction did not run — disambiguated via ``escalation_requested``).
    answer_confidence_marker: Literal["low", "medium", "high"] | None = None
    # The marker's optional ``| …`` justification (one clause, already
    # length-capped by the parser). None when the marker had no reason or was
    # absent/malformed. The chat node surfaces it as ``answer_confidence_reason``
    # so the UI can show WHY the model chose the level.
    answer_confidence_marker_reason: str | None = None
    # Structured sources captured this turn (wire-ready dicts from
    # ``source_entry_to_wire``). Surfaced on the final ChatResponse so the FE
    # can open document previews without inventing filenames.
    verified_sources: list[dict[str, Any]] | None = None
    # Skill names FORCED for this turn by the incoming request (parsed from the
    # WS content JSON's `skills` array by the chat researcher). Research turns
    # resolve them against the run's skill set and build the forced-activation
    # list; meta turns ignore them. None = no skills were forced.
    force_skills: list[str] | None = None
    # Pre-rendered skills section for the system prompt (guarded in the
    # template): the progressive-disclosure catalog plus the forced-skills
    # block. Set by the register layer before ``run()`` on research turns when
    # skills are enabled; None otherwise.
    skills_block: str | None = None
    # Ordered names of the skills activated THIS turn (forced first, then
    # model-invoked via ``use_skill``, deduped). Set by the register layer
    # after ``run()`` whenever skills are enabled on a research turn; None on
    # meta turns / disabled config — the chat node lifts it onto the terminal
    # ChatResponse only when present.
    skills_activated: list[str] | None = None
    # The subset of ``skills_activated`` marked ``grid-hidden`` — a skill that
    # runs on every answer (the house voice) is named in the disclosure but
    # de-emphasised there until the reader opens the reasoning view. Named, never
    # dropped: the transparency doctrine forbids a class of instruction the
    # product declines to admit ran.
    skills_hidden: list[str] | None = None
    # Transparency summary of citations dropped by ``verify_citations`` this turn
    # (``{"count": int, "reasons": [str, ...]}``). Populated by ``run()`` ONLY
    # when ≥1 citation was removed; None otherwise. The chat orchestrator lifts
    # it onto the terminal chunk via ``_normalize_citations_removed`` so the FE
    # can note "N Quellenangabe(n) entfernt (nicht verifizierbar)".
    citations_removed: dict[str, Any] | None = None
    # INTERNAL per-run render cache — NOT part of the public state contract.
    # Every input to the system-prompt render (system_prompt, tools_info,
    # user_info, current_datetime at DATE precision, available_documents,
    # project_context, the three norm blocks, requires_sources) is fixed for the
    # life of a single ``run()``, so the rendered prompt is byte-identical across
    # tool-loop iterations. ``agent_node`` renders it once, returns it here, and
    # LangGraph persists it across the loop; state is per-invocation, so
    # concurrent runs of the shared compiled graph never collide. Defaults to
    # None (first call / graph-direct path renders inline as before).
    cached_system_prompt: str | None = None

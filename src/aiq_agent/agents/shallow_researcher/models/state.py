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
        focus_file_name: Filename of the composer's "Asking about <file>" subject.
        focus_shelf: Shelf that focused file sits on (session/project/archiv).
        collection_name: Knowledge collection name (for fetching documents).
        tool_iterations: Counter for tool-calling iterations (the RESEARCH
            budget; see ``interaction_iterations`` for the output channel).
        interaction_iterations: Counter for interaction-tool calls (`emit_card`,
            `describe_card`, `remember`), which are budgeted separately.
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
            answer is neither citation-grounded nor measurement-grounded, and it
            is the ONLY route to a surfaced "high". Defaults to False
            (conservative).
    """

    messages: Annotated[list[AnyMessage], add_messages]
    data_sources: list[str] | None = None
    user_info: dict[str, Any] | None = None
    tools_info: list[dict[str, Any]] | None = None
    available_documents: list[AvailableDocument] | None = None
    collection_name: str | None = None
    tool_iterations: int = 0
    # Interaction-tool calls spent this turn (`emit_card`, `describe_card`,
    # `remember`). Counted APART from ``tool_iterations`` because those calls are
    # the answer's output channel rather than research: charging them to the
    # research budget made the turn's second card unreachable on any turn that
    # had actually searched, since cards are emitted last and forced synthesis
    # forbids further tool calls. The first
    # ``agent._INTERACTION_TOOL_ALLOWANCE`` of them cost no research budget; the
    # rest are charged normally, so the loop still terminates on the same
    # ceiling. Per-turn: the chat node builds a fresh state each turn.
    interaction_iterations: int = 0
    project_context: str | None = None
    # Anonymized fleet-wide failure patterns distilled from user feedback,
    # threaded through from ChatResearcherState (see the note there).
    platform_lessons: str | None = None
    # The composer's "Asking about <file>" subject for this turn (filename +
    # shelf). Rendered into the system prompt so "summarize this document"
    # has an antecedent, and widens the tool binding below: a bound file is an
    # explicit statement that a file is in play, so the search tools are
    # offered even on a turn the classifier called conversational.
    focus_file_name: str | None = None
    focus_shelf: str | None = None
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
    # The SECOND kind of grounding: whether THIS turn produced at least one
    # `declared`/`computed` answer from the IFC model (see
    # ``shallow_researcher.grounding``). An IFC measurement carries a provenance,
    # a tolerance, a readable method and the GlobalIds it was derived from, and
    # has no passage to quote — so it can never satisfy the citation gate, and a
    # correctly measured number used to be capped to "low" for lacking evidence
    # it structurally cannot have. Set by the tools node as a sticky OR across
    # the tool loop (never un-set by a later refusal); per-turn by construction,
    # because the chat node builds a fresh state each turn. Lifts the surfaced
    # confidence off the "low" floor to at most "medium" — and only when
    # ``answer_normative_claim_uncited`` is False. Defaults to False.
    answer_measurement_grounded: bool = False
    # The anti-laundering brake. True when the answer talks about regulatory
    # material or passes a verdict („erfüllt damit OIB 4 Punkt 2.1", „ausreichend",
    # „Gebäudeklasse 3") while carrying NO verified citation. A measurement grounds
    # the measurement; it must not ground a claim about the Bauordnung, and there
    # is no per-sentence confidence to separate them with — so the mixed answer
    # keeps the "low" it gets today and says why (`normative_claim_uncited`)
    # instead of resolving silently in the measurement's favour. Set by ``run()``
    # from the final, cleaned answer text; only meaningful alongside
    # ``answer_measurement_grounded``. Defaults to False.
    answer_normative_claim_uncited: bool = False
    # Whether ``answer_citation_grounded`` rests on the single-source FALLBACK
    # rather than on a citation the model itself wrote. The registry is
    # cumulative across the conversation, so the one source the fallback appends
    # can have been retrieved on an earlier turn for a different question —
    # grounding of a kind, but not the kind "high" is reserved for. Read by the
    # chat node's guard, which treats it exactly like measurement grounding: a
    # ceiling of "medium", and the normative brake still applies (it is computed
    # against this flag, not against ``answer_citation_grounded``, or one stale
    # source would switch the brake off entirely). Defaults to False.
    answer_citation_fallback_used: bool = False
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
    # The answer's structured anatomy — verdict / takeaways / callout — parsed
    # from the ```answer_json envelope, validated and GATED in run() (see
    # ``common.answer_envelope.gate_answer_meta``). A native field of the
    # answer like the confidence above, never a card: the frontend renders it
    # as answer typography. None when the envelope was absent, malformed, or
    # nothing survived the gates.
    answer_meta: dict[str, Any] | None = None
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
    # Ordered names of the skills whose BODY reached the model this turn, in
    # delivery order, deduped. DELIVERED, not forced: the disclosure renders
    # this as "what shaped this answer", and a forced skill contributes only
    # its NAME to the prompt until the model calls ``use_skill`` — so a model
    # that ignores the forced block has read nothing, and this list is empty.
    # Set by the register layer after ``run()`` whenever skills are enabled on
    # a research turn; None on meta turns / disabled config — the chat node
    # lifts it onto the terminal ChatResponse only when present.
    skills_activated: list[str] | None = None
    # The subset of ``skills_activated`` marked ``grid-hidden`` — a skill that
    # runs on every answer (the house voice) is named in the disclosure but
    # de-emphasised there until the reader opens the reasoning view. Named, never
    # dropped: the transparency doctrine forbids a class of instruction the
    # product declines to admit ran.
    skills_hidden: list[str] | None = None
    # TRUE when this turn hit its tool-iteration ceiling and was forced into
    # synthesis — i.e. evidence-gathering was CUT OFF rather than finished, and
    # the answer is written from whatever had been gathered by then. Set by
    # ``agent_node`` at the forced-synthesis branch; absent (None) on every turn
    # that finished inside its budget, so presence IS the fact and no reader has
    # to interpret a False.
    #
    # A BOOLEAN, deliberately. Where the chain stopped is a fact about the
    # turn's PROCESS, not about the answer, and the process channel already
    # carries it: the ``status:budget`` step emitted alongside this flag carries
    # the ordered tool shape, and the Herleitung is built from that step stream.
    # Putting the tool name here too would be the same fact on two wires.
    research_truncated: bool | None = None
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

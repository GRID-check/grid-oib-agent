"""State models for research agent."""

from typing import Annotated
from typing import Any
from typing import Literal

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel

from aiq_agent.knowledge import AvailableDocument

from ..markers import CappedReason
from ..markers import ConfidenceLevel
from ..markers import answer_confidence_capped_reason
from ..markers import surface_answer_confidence

#: What KIND of turn the answering agent made of it, read off what it did.
#: Only two of the four ``routing_decision`` values can be observed here —
#: ``deep`` and ``error`` are facts about the conversation graph's path, not
#: about the answer, and are set by the nodes that take them.
ObservedRouting = Literal["meta", "shallow"]


class ResearchAgentState(BaseModel):
    """
    State for research agent subgraph.

    Attributes:
        messages: Conversation history with LangGraph message reducer.
        data_sources: List of data sources selected by the user.
        user_info: Optional user information.
        tools_info: Information about available tools.
        available_documents: User-uploaded documents with summaries for context.
        focus_file_name: Filename of the composer's "Asking about <file>" subject.
        focus_shelf: Shelf that focused file sits on (session/project/archiv).
        collection_name: Knowledge collection name (for fetching documents).
        tool_iterations: Counter for tool-calling ROUNDS (the research budget).
        source_lookup_attempted: Whether the turn called a data-source tool at
            all. Set by ``run()``. With the self-assessment it is what the chat
            node reads the observed routing from: neither → a direct reply.
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
    #: Filenames whose ingestion has not finished — absent from
    #: ``available_documents`` AND unreachable by retrieval. Carried so the
    #: inventory block can say a file is coming, rather than letting a
    #: just-attached plan look exactly like a file that does not exist.
    in_flight_documents: list[str] | None = None
    #: Whether this tenant may be offered a deep-research hand-off. Read by the
    #: prompt renderer, which tells the model so in one line: a capability the
    #: model is told about is one it can decline out loud, where an absent one
    #: is a promise it makes and something downstream breaks — the same argument
    #: `TurnConfig.disabled_sources` makes about refusing a tool call rather
    #: than unbinding the tool.
    #:
    #: It varies per ORG, so the line it renders sits below the KV-cache
    #: boundary with the other per-tenant blocks; it is one sentence, and the
    #: alternative (narrowing the static contract per tenant) would shard the
    #: prompt cache on a workload that is ~99 % input tokens.
    deep_research_allowed: bool = True
    #: Whether this tenant may have work handed over (`create_task`). Read by
    #: the prompt renderer for the same reason and in the same shape as the
    #: field above: the tool stays BOUND and the call is refused at the BFF, so
    #: the tool payload — and the prompt-cache shard keyed on it — is identical
    #: for every tenant. What changes per org is one sentence of prose.
    tasks_allowed: bool = True
    #: The answer envelope declared ``kind: "handoff"``: the prose is the
    #: hand-off sentence, not an answer. Read only when an escalation is
    #: REFUSED, to decide whether the unavailability note replaces the content
    #: or is appended to it. It is the envelope's own word, because the two
    #: escalating shapes are indistinguishable from the prose alone.
    answer_is_handoff: bool = False
    collection_name: str | None = None
    #: Tool-calling ROUNDS this turn has spent — LLM decisions that emitted tool
    #: calls — against ``max_tool_iterations``. The NAME says iterations and is
    #: kept deliberately: it is what the config key, the agent kwarg and the
    #: suite all call this number, and renaming it would buy nothing but churn.
    #: What changed is the UNIT. It used to be emitted CALLS, so a round of five
    #: parallel ``read_passage`` opens — the family overview the prompt asks for
    #: — cost five of seven and the commonest question the product answers ran
    #: out of budget. A round is one decision; how many calls the model fans it
    #: into is the model using the round well or badly, and that is not
    #: something a budget should price. An interaction-only round (`emit_card`,
    #: `remember`, the working directory's file verbs) costs one like every
    #: other, which is why there is no second counter beside this one any more.
    tool_iterations: int = 0
    #: How many SEARCH rounds this turn has already announced. Distinct from
    #: ``tool_iterations`` so ``emit_card`` / ``remember`` cannot steal the
    #: next ``status:retrieval:N`` slot.
    retrieval_round: int = 0
    #: What each announced round WAS (slot, query, tools, purpose), in slot
    #: order. Recorded beside ``emit_retrieval`` from the same calls, so the
    #: stored account and the live line cannot disagree. Read at finalize to
    #: join each round with the hits it returned (the retrieval ledger);
    #: per-turn like the counter (the chat node builds a fresh state each turn).
    #: Plain dicts (see ``turn_status.record_round_announcement`` for the shape),
    #: never checkpointed — ``ResearchAgentState`` is one turn, not history.
    retrieval_rounds: list[dict[str, Any]] = []
    #: Signatures (``turn_status.fetch_signature``) of the fetches this turn
    #: has actually RUN, in execution order. Written by the TOOLS node, after
    #: the ``ToolNode`` returned, from the calls it really executed — never
    #: from the calls the model asked for, or a withheld repeat would mark
    #: itself as done. Both nodes read it to derive the same withholding
    #: (``common.retrieval_rounds.repeat_fetches``): the agent node decides what
    #: not to CHARGE, the tools node what not to RUN. Per-turn like the round counter — the
    #: chat node builds a fresh state each turn, and a fetch is only wasted
    #: within the turn that already holds its result.
    executed_fetches: list[str] = []
    #: What each of those fetches RETURNED, signature → the tool's own text.
    #: The other half of ``executed_fetches``, written by the same node from the
    #: same calls under the same rule (a failure signs nothing). It exists so a
    #: withheld repeat can be answered with the ORIGINAL RESULT instead of a
    #: sentence pointing at the transcript: a tool delivers an answer, and a
    #: model told to go and look further up asks a third time. Holds references
    #: to strings the transcript already carries, so it costs the turn nothing
    #: beyond the dict. Per-turn like the signatures beside it.
    fetch_results: dict[str, str] = {}
    project_context: str | None = None
    # Anonymized fleet-wide failure patterns distilled from user feedback,
    # threaded through from ``ConversationState`` (see the note there).
    platform_lessons: str | None = None
    # The office's standing instructions for this turn, threaded through from
    # ``ConversationState`` (see the note there). Bounded at the header
    # boundary; rendered below the KV-cache boundary as its own section.
    org_instructions: str | None = None
    # The composer's "Asking about <file>" subject for this turn (filename +
    # shelf). Rendered into the system prompt so "summarize this document"
    # has an antecedent.
    focus_file_name: str | None = None
    focus_shelf: str | None = None
    source_lookup_attempted: bool = False
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
    # ``piloti.grounding``). An IFC measurement carries a provenance,
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
    # text) inside PilotiAgent.run(). The chat orchestrator reads these
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
    # The envelope's own clause for WHY deep research is needed, when the
    # model asked for it. The chat node narrates it; None falls back to a
    # fixed string there.
    answer_escalation_reason: str | None = None
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
    # Retrieved-but-NOT-cited documents this turn (wire-ready dicts from
    # ``read_source_to_wire``: document key + lane/kind + page, NO prose).
    # Set by ``ledger.assemble_result`` from this turn's captures minus the
    # cited documents; the frontend renders them as the collapsed
    # "Gelesen, nicht zitiert" disclosure. None when everything retrieved
    # was cited (or nothing was retrieved) — absent, never an empty list.
    read_sources: list[dict[str, Any]] | None = None
    # The conversation's "already read" digest, IN for the prompt and OUT for
    # the merge: ``conversation._research_input`` threads the checkpointed lines
    # in (so the prompt can render ``## Bereits gelesen`` and the locator rule
    # can act on it) and ``PilotiAgent.run`` writes the merged lines back
    # (previous plus this turn's captures). Plain strings only, like the
    # conversation field it mirrors — never a new pydantic type.
    already_read_digest: list[str] | None = None
    # The backend's own account of this turn's retrieval rounds (see
    # ``common.retrieval_ledger.build_retrieval_ledger`` for the shape): one entry per
    # announced round with query, tools, returned docs and which of them were
    # new. Carried for the Herleitung — no renderer reads it yet (phase b).
    # None when no round was announced — a direct reply has no retrieval to
    # account for, and the wire field stays absent rather than null.
    retrieval_ledger: list[dict[str, Any]] | None = None
    # Pre-rendered skills section for the system prompt (guarded in the
    # template): the progressive-disclosure catalog the model picks from. Set
    # by the register layer before ``run()`` when skills are enabled; None
    # otherwise.
    skills_block: str | None = None
    # The full shapes of the card types the turn-start decision (ADR-0064)
    # says this answer is likely to earn, for the types the taught envelope
    # does not already carry. Rendered by the register before ``run()``;
    # None renders no section.
    card_shapes_block: str | None = None
    # Ordered names of the skills whose BODY reached the model this turn, in
    # delivery order, deduped. DELIVERED, not offered: the disclosure renders
    # this as "what shaped this answer", and a skill the model read past in the
    # catalog shaped nothing. Set by the register layer after ``run()`` whenever
    # skills are enabled on a research turn; None on meta turns / disabled
    # config — the chat node lifts it onto the terminal ChatResponse only when
    # present.
    skills_activated: list[str] | None = None
    # What the ANSWER ENVELOPE said the model followed among the skills whose
    # body rode the prompt (ADR-0063). Raw names, lifted by the ledger; the
    # register turns the accepted ones into ``skills_activated`` after ``run()``.
    # Never lifted to the reader itself.
    skills_applied: list[str] | None = None
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
    # it onto the terminal chunk unchanged so the FE can note
    # "N Quellenangabe(n) entfernt (nicht verifizierbar)".
    citations_removed: dict[str, Any] | None = None
    # INTERNAL per-run render cache — NOT part of the public state contract.
    # Every input to the system-prompt render (system_prompt, tools_info,
    # user_info, current_datetime at DATE precision, available_documents,
    # project_context, the three norm blocks) is fixed for the
    # life of a single ``run()``, so the rendered prompt is byte-identical across
    # tool-loop iterations. ``agent_node`` renders it once, returns it here, and
    # LangGraph persists it across the loop; state is per-invocation, so
    # concurrent runs of the shared compiled graph never collide. Defaults to
    # None (first call / graph-direct path renders inline as before).
    cached_system_prompt: str | None = None

    # -- derived signals --------------------------------------------------------
    # Read-only properties, NOT fields: they are pure functions of the signals
    # above, so they are computed where those signals live instead of being
    # re-derived by every reader. Properties rather than fields on purpose —
    # LangGraph builds one channel per model FIELD, and a derived value is not
    # something a node may write.

    @property
    def observed_routing(self) -> ObservedRouting:
        """What kind of turn this was, read off what the turn did.

        Nothing classifies a turn up front (ADR-0052); the model has every tool
        on every turn and picks the reply's shape itself. Two facts of the
        finished answer say which shape it picked: whether it consulted a data
        source, and whether it graded itself (a direct reply — a greeting, a
        shelf listing, an off-topic decline, "what can you do" — carries no
        confidence marker, because there is nothing to grade). Neither →
        ``meta``, the transparency surface's word for a direct reply. Either →
        ``shallow``: a researched answer, or at least one the model presented
        as one.
        """
        if not self.source_lookup_attempted and self.answer_confidence_marker is None:
            return "meta"
        return "shallow"

    @property
    def answer_confidence(self) -> ConfidenceLevel | None:
        """The self-assessment as it may be SURFACED, after the overconfidence guard.

        ``answer_confidence_marker`` is what the model claimed;
        :func:`~aiq_agent.agents.piloti.markers.surface_answer_confidence`
        decides how much of that claim the evidence in this same state supports.
        """
        return surface_answer_confidence(
            self.answer_confidence_marker,
            self.answer_citation_grounded,
            self.answer_quotes_verified,
            measurement_grounded=self.answer_measurement_grounded,
            normative_claim_uncited=self.answer_normative_claim_uncited,
            citation_fallback_used=self.answer_citation_fallback_used,
        )

    @property
    def answer_confidence_capped_reason(self) -> CappedReason | None:
        """Why the guard lowered the model's own level, when it did; else None."""
        return answer_confidence_capped_reason(
            self.answer_confidence_marker,
            self.answer_citation_grounded,
            self.answer_quotes_verified,
            measurement_grounded=self.answer_measurement_grounded,
            normative_claim_uncited=self.answer_normative_claim_uncited,
            citation_fallback_used=self.answer_citation_fallback_used,
        )

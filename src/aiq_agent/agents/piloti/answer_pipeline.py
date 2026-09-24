"""Post-answer verification: what happens to the model's text before a reader sees it.

Pure stages over ``(messages, registry)``, in this order: DSML strip, envelope
split, control-marker extraction, citation and quote verification with the
turn's ONE repair, the single-source fallback citation, sanitisation, the
``answer_meta`` gates, callout resolution and the normative-claim brake.
:func:`finalize_answer` runs them and returns a :class:`FinalAnswer`; the agent
copies its signal fields onto the state (``ledger.assemble_result``).
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from dataclasses import replace
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from pydantic import ValidationError

from aiq_agent.common import citation_events
from aiq_agent.common import content_to_text
from aiq_agent.common import get_source_id_for_tool
from aiq_agent.common.answer_envelope import TAKEAWAYS_MIN_PROSE_CHARS
from aiq_agent.common.answer_envelope import AnswerMeta
from aiq_agent.common.answer_envelope import extract_answer_envelope
from aiq_agent.common.answer_envelope import gate_answer_meta
from aiq_agent.common.answer_envelope import resolve_callout_marker
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import UnverifiedQuote
from aiq_agent.common.citation_verification import agent_authored_document_names
from aiq_agent.common.citation_verification import annotate_unverified_quotes
from aiq_agent.common.citation_verification import drop_ungrounded_trailer_values
from aiq_agent.common.citation_verification import expand_grouped_citations
from aiq_agent.common.citation_verification import get_turn_captures
from aiq_agent.common.citation_verification import lost_citations
from aiq_agent.common.citation_verification import sanitize_report
from aiq_agent.common.citation_verification import source_origin_token
from aiq_agent.common.citation_verification import verify_citations
from aiq_agent.common.citation_verification import verify_quoted_spans
from aiq_agent.common.tool_validation import validate_tool_availability
from aiq_agent.common.turn_status import emit_citation_check

from .answer_shape import drop_restated_mindmaps
from .dsml import strip_and_salvage_dsml_tool_calls
from .grounding import answer_mentions_normative_claim
from .history import prose_history
from .markers import detect_and_strip_confidence_marker
from .markers import detect_and_strip_escalation_marker
from .repair import Repair
from .repair import VerificationFailures

logger = logging.getLogger(__name__)

#: The repair the agent injects: ``(original prose, failures, history)`` →
#: a rewrite, or ``None`` to keep the marked answer. ``None`` as the function
#: means the repair pass is off.
RepairFn = Callable[[str, VerificationFailures, list[Any]], Awaitable[Repair | None]]

#: The card repair the agent injects: ``(card as written, the refusal with the
#: shape, the answer prose)`` → the corrected card object, or ``None`` to drop
#: it. ``None`` as the function means a shape miss is dropped without a repair.
CardRepairFn = Callable[[dict[str, Any], str, str], Awaitable[dict[str, Any] | None]]

#: A ``[[card:N]]`` marker, with N captured: the envelope's own cards are
#: addressed by these, and renumbered to their registry positions.
_CARD_MARKER_NUMBER_RE = re.compile(r"\[\[card:(\d+)\]\]")


@dataclass(frozen=True)
class CitedSource:
    """A registry entry the answer cites, with the ``[N]`` label it carries."""

    entry: SourceEntry
    number: int | None


@dataclass(frozen=True)
class FinalAnswer:
    """The answer as the reader gets it, plus every signal the chat node reads.

    ``answered`` is False when the run produced no answer message at all; the
    defaults below are then the conservative ones the state documents.
    """

    messages: list[Any]
    answered: bool
    content: str | None = None
    citation_grounded: bool = False
    citation_fallback_used: bool = False
    quotes_verified: bool = True
    unverified_quote_count: int = 0
    normative_claim_uncited: bool = False
    escalation_requested: bool | None = None
    #: The envelope said ``kind: "handoff"`` — the answer IS the hand-off and
    #: nothing else. The prompt makes the two escalating shapes different:
    #: an insufficiency escalation still writes its best partial answer, a
    #: commissioned hand-off writes one sentence naming what will be researched.
    #: Only the envelope can tell them apart; the prose cannot be matched on.
    answer_is_handoff: bool = False
    confidence_marker: str | None = None
    confidence_marker_reason: str | None = None
    escalation_reason: str | None = None
    source_lookup_attempted: bool = False
    answer_meta: dict[str, Any] | None = None
    #: The envelope's ``skills_applied``: the inlined skills the model says it
    #: followed. Names as written; the register hands them to the skill
    #: runtime, which accepts only those whose body was in the prompt.
    skills_applied: tuple[str, ...] = ()
    cited: tuple[CitedSource, ...] = ()
    removed_citations: tuple[dict[str, Any], ...] = ()
    #: The retrieval of an ADOPTED repair: already in the registry, and part
    #: of this turn's capture for the ledger.
    repair_sources: tuple[SourceEntry, ...] = ()


# --------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------

#: A trailing reference list, in the headings this agent and the models it runs
#: actually produce.
_REFERENCES_SECTION_RE = re.compile(
    r"\n\s*(?:\*\*(?:References|Sources|Quellen):?\*\*|#{2,3}\s+(?:References|Sources|Quellen))\s*(?:\n|$)",
    re.IGNORECASE,
)

#: What a reference list is allowed to consist of: a blank line, or a line that
#: carries an actual REFERENCE, a URL or a „[n]" citation marker. List
#: punctuation is not enough and never was: „- " is available to any sentence,
#: so accepting it let „- Damit ist der Raum unzulässig …" under a
#: „**Quellen:**" heading count as a bibliography entry and leave the text
#: before the brake ever read it.
_REFERENCE_LINE_RE = re.compile(r"^\s*$|\[\d+\]|<?https?://")


def prose_without_references(content: str) -> str:
    """The answer's own sentences, with any trailing reference list removed.

    The normative brake judges what the ANSWER asserts, and a bibliography
    asserts nothing. It matters because of where that line comes from: the
    single-source fallback appends it, so leaving it in made every
    fallback-grounded answer read as normative and floored measured,
    purely descriptive answers to "low" under a reason that was not true of a
    single sentence the model wrote.

    Only a genuinely TRAILING list is cut: a heading is a cut point only when
    every line after it points at a source (a URL or a „[n]" marker) or is
    blank; otherwise the search moves to the previous heading, and failing
    that nothing is removed. Erring towards keeping text is the safe
    direction: a reference line that survives costs a hedge, a verdict that
    is dropped costs a claim about the law.

    Known gap, left open deliberately: ANY tail line carrying a URL or a „[n]"
    marker is cut, so a verdict smuggled into an all-references tail with a
    marker on it („- Damit ist der Raum unzulässig [1]") is cut too. Keeping
    the lines the normative brake fires on was measured and is inverted: a
    compliance bibliography is a list of exactly the instrument names the
    brake's strong tier matches (11 of 14 genuine entries fire, including the
    line this module appends itself). A real finite-verb test needs a POS
    tagger; a heuristic that cuts the wrong way is worse than the gap.
    """
    if not isinstance(content, str):
        return ""
    for match in reversed(list(_REFERENCES_SECTION_RE.finditer(content))):
        tail = content[match.end() :]
        if all(_REFERENCE_LINE_RE.search(line) for line in tail.splitlines()):
            return content[: match.start()]
    return content


def append_minimal_citation(report_text: str, source: SourceEntry) -> str:
    """Append one verified citation when the model omitted references.

    ``verify_citations`` may strip every citation line under a References
    header and leave the empty header behind; it is dropped first so the
    final output has exactly one references section.
    """
    citation_target = source.url or source.citation_key
    if not citation_target:
        return report_text
    content = report_text.rstrip()
    content = re.sub(r"\n{1,2}\*\*References:?\*\*\s*$", "", content, flags=re.IGNORECASE).rstrip()
    content = re.sub(r"\n{1,2}#{2,3}\s+(?:References|Sources)\s*$", "", content, flags=re.IGNORECASE).rstrip()
    if content.endswith((".", "!", "?")):
        content = f"{content[:-1]} [1]{content[-1]}"
    else:
        content = f"{content} [1]"

    token = source_origin_token(source)
    prefix = f"{token} " if token else ""
    if source.url:
        reference = f"- [1] {prefix}{source.title or source.url} - {source.url}"
    else:
        reference = f"- [1] {prefix}{citation_target}"
    return f"{content}\n\n**References:**\n{reference}"


# --------------------------------------------------------------------------
# Stages
# --------------------------------------------------------------------------


def answer_index(messages: Sequence[Any]) -> int | None:
    """The answer message, by the SAME selector the chat node uses: the last
    AIMessage that is not a tool call."""
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, AIMessage) and not message.tool_calls:
            return index
    return None


@dataclass(frozen=True)
class _Extracted:
    """The prose with both control grammars stripped, and what they said."""

    content: str
    meta: AnswerMeta | None
    escalation_requested: bool
    confidence: str | None
    confidence_reason: str | None
    escalation_reason: str | None = None


def _skills_applied(meta: AnswerMeta | None) -> tuple[str, ...]:
    """The envelope's ``skills_applied`` as clean names, deduped, in the model's order."""
    if meta is None or not meta.skills_applied:
        return ()
    names: list[str] = []
    for raw in meta.skills_applied:
        name = str(raw).strip().strip("`")
        if name and name not in names:
            names.append(name)
    return tuple(names)


def _extract(raw: str) -> _Extracted:
    """Strip DSML leaks, split the envelope, extract both control markers.

    The envelope comes apart FIRST: a research reply is one ```answer_json
    object whose ``answer`` field is the prose, so until it is split the two
    tail-anchored marker detectors would be reading JSON instead of the
    answer's final lines. The envelope's CONTROL fields are the canonical
    carriers; the bracket markers stay understood as the fallback and are
    stripped regardless, so neither grammar ever reaches the reader.
    Escalation is OR-ed: either channel saying "insufficient" is the model
    saying it.
    """
    content = strip_and_salvage_dsml_tool_calls(raw)
    content, meta = extract_answer_envelope(content)
    content = expand_grouped_citations(content)
    content, escalation = detect_and_strip_escalation_marker(content)
    content, confidence, reason = detect_and_strip_confidence_marker(content)
    escalation_reason: str | None = None
    if meta is not None and meta.escalate_to_deep:
        escalation = True
        escalation_reason = (meta.escalation_reason or "").strip()[:300] or None
    if meta is not None and meta.confidence is not None:
        confidence = meta.confidence.level
        reason = (meta.confidence.reason or "").strip()[:300] or None
    return _Extracted(content, meta, escalation, confidence, reason, escalation_reason)


def _handed_markers(messages: Sequence[Any]) -> set[int]:
    """The ``[[card:N]]`` numbers a TOOL handed the model this turn.

    A tool that pushes a system card (``write_file`` → ``document_draft``,
    ``surface_documents`` → ``document_grid``, ``emit_card`` on an older
    prompt) answers with the marker to write, so the numbers in its replies
    are taken. Read off the transcript rather than off the registry's size:
    the registry says how many cards exist, the replies say which of them the
    model was told to address by number.
    """
    handed: set[int] = set()
    for message in messages:
        if not isinstance(message, ToolMessage):
            continue
        for match in _CARD_MARKER_NUMBER_RE.finditer(content_to_text(message.content)):
            handed.add(int(match.group(1)))
    return handed


def _renumber_envelope_markers(content: str, *, handed: set[int], positions: dict[int, int], count: int) -> str:
    """The envelope's card markers moved from array numbers to registry positions.

    The taught rule (``cards/envelope._MARKER_RULE``) numbers the ``cards``
    array from 1, and from after the highest marker a tool handed out this
    turn when there was one, so the model's numbers never collide with a
    tool's. N therefore names array card ``N - offset`` (``offset`` = the
    highest handed number, 0 when none), and that card becomes the registry
    position it landed at (``positions``). A marker a tool handed out keeps its
    number: it already IS a registry position. A model that ignored the offset
    and wrote a number at or below it is read as an array number, the only
    reading left. The marker of a card that was DROPPED is removed, so the
    reader never meets a marker with nothing behind it and no later card
    slides onto its neighbour's place. A marker past the array is left alone,
    as it always was.
    """
    if count == 0:
        return content
    offset = max(handed, default=0)

    def substitute(match: re.Match[str]) -> str:
        number = int(match.group(1))
        if number in handed:
            return match.group(0)
        index = number - offset if number > offset else number
        if not 1 <= index <= count:
            return match.group(0)
        position = positions.get(index)
        return f"[[card:{position}]]" if position is not None else ""

    return _CARD_MARKER_NUMBER_RE.sub(substitute, content)


async def _register_envelope_cards(
    meta: AnswerMeta | None,
    content: str,
    messages: Sequence[Any],
    card_repair: CardRepairFn | None,
) -> str:
    """Validate the envelope's cards into the turn's registry; the prose with its markers resolved.

    The same validator and the same two closed channels ``emit_card`` runs
    (``cards/envelope.validate_model_card``), so the envelope buys a card no
    softer standard than the tool would. A shape miss goes to the repair once
    — a bounded call on the small card model, never a round — and a card that
    still fails is dropped and recorded (``status:card:invalid:N``). Cards
    register in array order after whatever the tools pushed, and the prose's
    markers are moved to those positions. Fail-open throughout: no registry
    bound (a CLI run) means the answer ships without cards, as it always did.
    """
    from aiq_agent.cards.envelope import envelope_card_objects
    from aiq_agent.cards.registry import get_card_registry

    raw = envelope_card_objects(meta.cards if meta is not None else None)
    if not raw:
        return content
    registry = get_card_registry()
    if registry is None:
        logger.info("answer envelope carried %d card(s) with no card registry bound; dropped", len(raw))
        return content
    handed = _handed_markers(messages)
    # Repairs run side by side: each is bounded by the card model's timeout,
    # and in series three malformed cards would hold a final answer for three
    # of them. Registration stays in array order.
    checked = await asyncio.gather(
        *(_checked_envelope_card(payload, index, content, card_repair) for index, payload in enumerate(raw))
    )
    positions: dict[int, int] = {}
    for index, validated in enumerate(checked):
        if validated is None:
            continue
        registry.add(validated)
        positions[index + 1] = len(registry)
        logger.info("answer envelope registered a '%s' card as card %d", validated["type"], len(registry))
    return _renumber_envelope_markers(content, handed=handed, positions=positions, count=len(raw))


async def _checked_envelope_card(
    payload: Any, index: int, content: str, card_repair: CardRepairFn | None
) -> dict[str, Any] | None:
    """One envelope card validated, repaired once on a shape miss, or ``None`` (recorded)."""
    from aiq_agent.cards.envelope import REFUSED_SHAPE
    from aiq_agent.cards.envelope import validate_model_card
    from aiq_agent.common.turn_status import CARD_INVALID_DROPPED
    from aiq_agent.common.turn_status import CARD_INVALID_REPAIRED
    from aiq_agent.common.turn_status import emit_card_invalid

    validated, refusal = validate_model_card(payload)
    card_type = refusal.card_type if refusal is not None else str(validated["type"])
    # Only a SHAPE miss is repairable: a system or envelope type is refused
    # whatever its fields, and a non-object has no fields to fix.
    if validated is None and refusal is not None and refusal.kind == REFUSED_SHAPE and card_repair is not None:
        repaired = await card_repair(payload, refusal.for_repair(), content)
        if repaired is not None:
            validated, _ = validate_model_card(repaired)
        if validated is not None:
            emit_card_invalid(card_type=card_type, index=index, outcome=CARD_INVALID_REPAIRED)
    if validated is None:
        emit_card_invalid(card_type=card_type, index=index, outcome=CARD_INVALID_DROPPED)
    return validated


def this_turn(messages: Sequence[Any]) -> list[Any]:
    """The messages of THIS turn: everything after the last human message.

    The transcript now carries the previous turn's tool calls and results
    (``conversation._answer_update`` writes the whole turn back), so a scan
    that means "this turn" must stop at the turn boundary: a previous turn's
    search must not count as this turn's lookup — a follow-up answered from
    the transcript against an empty registry would otherwise ship the
    "nothing retrieved" refusal — and a marker a tool handed out last turn
    must not be a number this turn's cards have to skip.
    """
    for index in range(len(messages) - 1, -1, -1):
        if isinstance(messages[index], HumanMessage):
            return list(messages[index + 1 :])
    return list(messages)


def _source_lookup_attempted(messages: Sequence[Any]) -> bool:
    """Whether any data-source tool ran this turn (pass this turn's messages)."""
    return any(
        isinstance(msg, ToolMessage) and get_source_id_for_tool(getattr(msg, "name", "") or "") is not None
        for msg in messages
    )


@dataclass(frozen=True)
class _Verified:
    """The answer after citation and quote verification (and maybe a repair)."""

    content: str
    verification: Any
    unverified_quotes: tuple[UnverifiedQuote, ...]
    repair_sources: tuple[SourceEntry, ...] = ()

    @property
    def failure_count(self) -> int:
        return len(lost_citations(self.verification.removed_citations)) + len(self.unverified_quotes)


def _verify(content: str, registry: SourceRegistry) -> _Verified:
    """Citations against the registry, then quoted spans against the passages.

    ``verify_citations`` only proves a cited SOURCE is real, not that a QUOTED
    sentence appears in it; ``verify_quoted_spans`` catches the "real section,
    fabricated quote" pattern. Fail-open: quotes are annotated, never stripped.
    """
    verification = verify_citations(content, registry, reference_sources=registry.all_sources())
    logger.debug(
        "Piloti: citation verification complete — %d valid, %d removed",
        len(verification.valid_citations),
        len(verification.removed_citations),
    )
    quotes = verify_quoted_spans(verification.verified_report, registry)
    return _Verified(verification.verified_report, verification, tuple(quotes))


def _distinct_cited(valid_citations: Sequence[dict[str, Any]]) -> int:
    """How many distinct sources the verified citations point at."""
    return len({citation.get("citation_key") or citation.get("url") for citation in valid_citations} - {None, ""})


def _adopt_if_better(verified: _Verified, repaired: Repair, registry: SourceRegistry) -> _Verified | None:
    """Verify the rewrite against a scratch registry; adopt it only if it verifies better.

    Only an adopted repair changes what the answer is grounded in: a discarded
    one leaves the registry, and every decision downstream that reads it, such
    as the single-source fallback, exactly as it was.
    """
    scratch = SourceRegistry()
    for source in (*registry.all_sources(), *repaired.sources):
        scratch.add(source)
    candidate = verify_citations(repaired.prose, scratch, reference_sources=scratch.all_sources())
    candidate_quotes = tuple(verify_quoted_spans(candidate.verified_report, scratch))
    after = len(candidate.removed_citations) + len(candidate_quotes)
    # Fewer failures alone is not better: a rewrite that drops most of its
    # citations has fewer failures by construction. Live, one replaced a
    # streamed answer citing nine sources with one citing two, 22 s after the
    # reader had it (ADR-0066). So the rewrite must also cite at least as many
    # sources as the verified original still does.
    before_cited, after_cited = (
        _distinct_cited(verified.verification.valid_citations),
        _distinct_cited(candidate.valid_citations),
    )
    if not (after < verified.failure_count and candidate.valid_citations and after_cited >= before_cited):
        logger.info(
            "Piloti: repair pass discarded (%d -> %d failures, %d -> %d cited sources)",
            verified.failure_count,
            after,
            before_cited,
            after_cited,
        )
        return None
    logger.info("Piloti: repair pass adopted (%d -> %d failures)", verified.failure_count, after)
    for source in repaired.sources:
        registry.add(source)
    return _Verified(candidate.verified_report, candidate, candidate_quotes, tuple(repaired.sources))


async def _verify_with_repair(
    content: str,
    registry: SourceRegistry,
    repair: RepairFn | None,
    history: list[Any],
) -> _Verified:
    verified = _verify(content, registry)
    failures = VerificationFailures(
        # Merged duplicates lost nothing, so they are not something to repair
        # (``citation_verification.lost_citations``): the same rule as the count.
        removed_citations=tuple(lost_citations(verified.verification.removed_citations)),
        unverified_quotes=verified.unverified_quotes,
        valid_citations=tuple(verified.verification.valid_citations),
    )
    if repair is None or not failures:
        return verified
    repaired = await repair(content, failures, history)
    if repaired is None:
        return verified
    return _adopt_if_better(verified, repaired, registry) or verified


@dataclass(frozen=True)
class _Grounding:
    """What the answer is grounded in, once verification has spoken."""

    content: str
    citation_grounded: bool = False
    citation_fallback_used: bool = False
    cited: tuple[CitedSource, ...] = ()
    unverified_quotes: tuple[UnverifiedQuote, ...] = ()
    removed_citations: tuple[dict[str, Any], ...] = ()
    repair_sources: tuple[SourceEntry, ...] = ()


def _entry_for(citation: dict[str, Any], registry: SourceRegistry) -> SourceEntry | None:
    if citation.get("citation_key"):
        return registry.entry_for_citation_key(citation["citation_key"])
    if citation.get("url"):
        return registry.entry_for_url(citation["url"])
    return None


def _cited_sources(valid_citations: Sequence[dict[str, Any]], registry: SourceRegistry) -> tuple[CitedSource, ...]:
    """The registry entries the model actually cited in THIS answer, first-cited order.

    Only these become chips, never the cumulative session registry. The
    ``[N]`` label rides along: only the verifier knows that binding, and the
    FE folds the written source list and the chip row into one provenance
    block from it. A citation of a source retrieved on an earlier turn is
    still a citation the verifier resolved: it earns its chip.
    """
    cited: list[CitedSource] = []
    seen: set[int] = set()
    for citation in valid_citations:
        entry = _entry_for(citation, registry)
        if entry is None or id(entry) in seen:
            continue
        seen.add(id(entry))
        number = citation.get("number")
        cited.append(CitedSource(entry, number if isinstance(number, int) else None))
    return tuple(cited)


def _ground(verified: _Verified, registry: SourceRegistry, *, lookup_attempted: bool) -> _Grounding:
    """Resolve the surviving citations, or fall back to the turn's one source.

    The fallback fires only on a turn that looked something up: a greeting on
    a conversation whose registry still holds last turn's source must not be
    handed that source as its citation.
    """
    content = verified.content
    if verified.unverified_quotes:
        content = annotate_unverified_quotes(content, list(verified.unverified_quotes))
        logger.info(
            "Piloti: %d quoted span(s) not verbatim in any retrieved passage; annotated inline",
            len(verified.unverified_quotes),
        )
    common = {
        "unverified_quotes": verified.unverified_quotes,
        "removed_citations": tuple(verified.verification.removed_citations),
        "repair_sources": verified.repair_sources,
    }
    if verified.verification.valid_citations:
        cited = _cited_sources(verified.verification.valid_citations, registry)
        return _Grounding(content, citation_grounded=True, cited=cited, **common)
    sources = registry.all_sources()
    if lookup_attempted and len(sources) == 1:
        # ``append_minimal_citation`` always writes "[1]".
        return _Grounding(
            append_minimal_citation(content, sources[0]),
            citation_grounded=True,
            citation_fallback_used=True,
            cited=(CitedSource(sources[0], 1),),
            **common,
        )
    return _Grounding(content, **common)


def _require_retrieval(lookup_attempted: bool, tools: Sequence[BaseTool]) -> None:
    """An empty registry after a lookup is the hardest citation failure there is.

    Distinguishes "retrieval genuinely failed" from "the agent answered
    without ever querying a data source". Only the former is an error: a
    greeting, a shelf listing from the inventory or a reply from project
    context has nothing to cite, and discarding it would replace a
    substantive answer with a misleading "search tools failed" message.
    """
    if not lookup_attempted:
        logger.debug("Piloti: answered without querying any data-source tool; no verification")
        return
    _, available_count, unavailable = validate_tool_availability(
        list(tools), research_type="research", enable_logging=False
    )
    # Recorded before it becomes an error the user sees, so it lands on the
    # platform dashboard beside the softer defects instead of only in the logs.
    # ``agent="shallow"`` is the persisted `citation_events.agent` enum value
    # (`shallow` | `deep`), not a name for this agent — the column and every row
    # already written carry it, so the rename deliberately leaves it alone.
    citation_events.record_empty_registry(
        agent="shallow", unavailable_tools=unavailable, available_count=available_count
    )
    raise EmptySourceRegistryError("research", unavailable_tools=unavailable, available_count=available_count)


def _recite_surface_cards(renumber_map: dict[int, int] | None, cited: tuple[CitedSource, ...]) -> None:
    """Hold the ``[N]`` in this turn's composed surfaces to the prose's citations (``cards/surface_citations``)."""
    from aiq_agent.cards.registry import get_card_registry
    from aiq_agent.cards.surface_citations import recite_surface

    registry = get_card_registry()
    if registry is None:
        return
    numbers = {source.number for source in cited if source.number is not None}
    for index, card in enumerate(registry.snapshot()):
        recited = recite_surface(card, renumber_map or {}, numbers)
        if recited is not card:
            registry.replace(index, recited)


def settle_streamed_citations(prose: str, sources_text: str, registry: SourceRegistry) -> SettledStream | None:
    """The streamed prose with its ``[N]`` markers settled, and the sources they name.

    The same three steps :func:`finalize_answer` runs on the finished answer:
    verify each source line against the registry, sanitise (which drops the
    markers that lost their line and closes the gaps), and read the cited
    sources off the survivors. Run the moment the envelope's ``answer`` string
    closes, which is before the cards and the pipeline: the pending markers on
    screen become the answer's own citations, numbered as the terminal frame
    will number them (ADR-0066). ``None`` when there is nothing to settle.
    """
    from .ledger import wire_sources  # ledger imports this module

    if not sources_text.strip() or not registry.all_sources():
        return None
    verified = verify_citations(prose.rstrip() + "\n\n" + sources_text.strip(), registry)
    sanitized = sanitize_report(verified.verified_report)
    cited = _renumbered(_cited_sources(verified.valid_citations, registry), sanitized.renumber_map)
    # The written source list travels WITH the prose, as it does in the
    # terminal frame: the reader resolves a marker against that list.
    return SettledStream(
        content=sanitized.sanitized_report.rstrip(),
        sources=wire_sources(cited),
        renumber_map=dict(sanitized.renumber_map or {}),
        numbers=frozenset(source.number for source in cited if source.number is not None),
    )


@dataclass(frozen=True)
class SettledStream:
    """What :func:`settle_streamed_citations` hands the wire, and what a card's markers follow."""

    content: str
    sources: list[dict[str, Any]]
    renumber_map: dict[int, int] = field(default_factory=dict)
    numbers: frozenset[int] = frozenset()
    answer_meta: dict[str, Any] | None = None


class LiveAnswer:
    """What the stream may show before the pipeline has run, gated as the pipeline gates it.

    Three moments of one reply (ADR-0066), each through the functions
    :func:`finalize_answer` uses, so the stream cannot show what the finished
    answer would refuse:

    - the masthead, the moment the fields before ``answer`` are written:
      :func:`gate_answer_meta` and the trailer grounding, everything but the
      summary's comparison with a prose not yet written;
    - the prose, when the ``answer`` string closes: verified, renumbered, and
      the masthead gated again, now against the prose;
    - each card, when its object closes: the one card validator, its ``[N]``
      held to the settled numbers. Only while no tool has registered a card
      this turn: the reader places ``[[card:N]]`` against the message's card
      list, which such a card would shift.
    """

    def __init__(self, registry: SourceRegistry) -> None:
        self._registry = registry
        self._settled: SettledStream | None = None

    def masthead(self, fields: dict[str, Any], prose: str = "") -> dict[str, Any] | None:
        from aiq_agent.common.answer_envelope import MASTHEAD_FIELDS

        try:
            meta = AnswerMeta.model_validate({key: value for key, value in fields.items() if key in MASTHEAD_FIELDS})
        except ValidationError:
            return None
        gated = gate_answer_meta(
            meta,
            prose_chars=len(prose),
            prose=prose,
            agent_authored_documents=agent_authored_document_names(self._registry),
        )
        if gated is None:
            return None
        grounded = drop_ungrounded_trailer_values(gated, get_turn_captures()) or {}
        head = {key: value for key, value in grounded.items() if key in MASTHEAD_FIELDS}
        return {"v": grounded.get("v"), **head} if head else None

    def settle(self, prose: str, sources_text: str, fields: dict[str, Any] | None) -> SettledStream | None:
        settled = settle_streamed_citations(prose, sources_text, self._registry)
        if settled is None:
            return None
        meta = self.masthead(fields, prose_without_references(settled.content)) if fields else None
        self._settled = replace(settled, answer_meta=meta)
        return self._settled

    def card(self, payload: Any) -> dict[str, Any] | None:
        from aiq_agent.cards.envelope import validate_model_card
        from aiq_agent.cards.registry import get_card_registry
        from aiq_agent.cards.surface_citations import recite_surface

        registry = get_card_registry()
        if registry is not None and len(registry.snapshot()) > 0:
            return None
        card, _refusal = validate_model_card(payload)
        if card is None:
            return None
        settled = self._settled or SettledStream(content="", sources=[])
        return recite_surface(card, settled.renumber_map, settled.numbers)


def _renumbered(cited: tuple[CitedSource, ...], renumber_map: dict[int, int] | None) -> tuple[CitedSource, ...]:
    """Sanitisation closes the gaps the removals left in the ``[N]`` sequence,
    so the labels captured before it must follow, or a chip is labelled [3]
    while the prose that points at it now says [2]."""
    if not renumber_map:
        return cited
    return tuple(
        CitedSource(source.entry, renumber_map.get(source.number, source.number) if source.number is not None else None)
        for source in cited
    )


def _gated_meta(
    extracted: _Extracted,
    content: str,
    registry: SourceRegistry,
    *,
    turn_sources: Sequence[SourceEntry] | None = None,
) -> dict[str, Any] | None:
    """The structured trailer, gated once the text is final.

    Skipped on an escalating turn: this answer is about to be
    superseded by deep research, and a verdict attached to a discarded answer
    would decorate the job-submission stub. The takeaway gate judges the
    PROSE, not the sources apparatus.

    The registry is the turn's captured sources, and the gate needs exactly one
    fact out of it: which of the documents cited here PILOTI wrote. A verdict
    is the one place an answer names a Fundstelle for a value the reader
    copies, so it is the one place an approved office document must not be able
    to stand in for the OIB.

    Past the envelope gates, every trailer VALUE (a Zahl, Klasse or Frist in a
    verdict, a takeaway or a detail) must name a Fundstelle this turn retrieved
    (``drop_ungrounded_trailer_values``) — a headline number with no source
    behind it is the fabrication the citation check cannot see, because the
    trailer carries no ``[N]`` markers. ``turn_sources`` is this turn's capture
    log; ``None`` (the default) reads the ambient one, so tests pin the gate by
    passing entries explicitly.
    """
    if extracted.meta is None or extracted.escalation_requested:
        return None
    gated = gate_answer_meta(
        extracted.meta,
        prose_chars=len(prose_without_references(content)),
        prose=prose_without_references(content),
        agent_authored_documents=agent_authored_document_names(registry),
    )
    if gated is None:
        return None
    captures = list(turn_sources) if turn_sources is not None else get_turn_captures()
    return drop_ungrounded_trailer_values(gated, captures)


def _normative_claim_uncited(content: str, grounding: _Grounding) -> bool:
    """The anti-laundering brake, read off the FINAL user-visible text.

    Only meaningful when the citation gate already failed: with no verified
    citation, "mentions the law" and "asserts the law without support" are the
    same thing. The single-source FALLBACK does not count as the citation that
    switches it off: one Bauordnung link captured two turns ago was enough to
    disarm the brake AND hand a mixed answer the model's own "high".
    """
    model_cited = grounding.citation_grounded and not grounding.citation_fallback_used
    return not model_cited and answer_mentions_normative_claim(prose_without_references(content))


#: Short-overview card floor. Below this a non-ruling answer without a
#: copyable verdict has not earned cards: the prose IS the answer and a card
#: under it is a trailer on a one-screen reply. It was 800 while a card cost
#: a full-context LLM round (the describe_card + emit_card generations, ~2 s
#: in the production trace) — a cost worth refusing on a short answer. Cards
#: travel in the answer envelope now (``cards/envelope.py``) and cost no
#: round, so what remains of the argument is the degenerate case: a
#: two-sentence reply with a checklist hung under it. 400 characters is
#: about three sentences, the length at which the prompt starts owing a
#: `summary`; below the takeaway floor (600) on purpose, because a short
#: answer with one table is richer than the same answer without it, and a
#: table is not a takeaway list. Mechanical only — the prompt doctrine that
#: teaches WHEN to emit is untouched.
_CARD_SUPPRESS_MIN_PROSE_CHARS = 400

#: The marker emit_card hands back (``[[card:N]]``); stripped when cards are
#: suppressed so the reader never meets a marker with nothing behind it.
_CARD_MARKER_RE = re.compile(r"\[\[card:\d+\]\]")

#: The one model-emitted card suppression must never eat. ``legal_basis`` is
#: not a system card — the model emits it through ``emit_card`` like any other
#: content card, so ``SYSTEM_CARD_TYPES`` cannot cover it — but it is the
#: answer's PROOF, not its trailer: the Fundstelle margin the reader checks the
#: verdict against. Clearing the registry under it would keep the headline
#: number and delete what makes it checkable, so any ``legal_basis`` card in
#: the registry snapshot vetoes the whole suppression, exactly like a system
#: card does.
_LEGAL_BASIS_CARD_TYPE = "legal_basis"


def _should_suppress_meta_cards(content: str, gated_meta: dict[str, Any] | None) -> bool:
    """Whether a short overview's trailer cards should be dropped.

    Pure, so tests pin it without a registry: ``False`` when there is nothing
    to drop, when the prose reaches the floor, or when the answer carries a
    copyable value (a verdict, or ``kind=ruling`` which exists to carry one).
    A short walkthrough/direct answer with takeaways/callout/summary but no
    verdict is the shape that pays full-context card generations for prose
    the reader finishes in one screen.
    """
    if not gated_meta:
        return False
    try:
        prose_chars = len(prose_without_references(content))
    except Exception:
        return False
    if prose_chars >= _CARD_SUPPRESS_MIN_PROSE_CHARS:
        return False
    if gated_meta.get("verdict") is not None:
        return False
    return gated_meta.get("kind") != "ruling"


def _suppress_cards(content: str, gated_meta: dict[str, Any] | None) -> tuple[str, dict[str, Any] | None, bool]:
    """Drop unearned cards on a short overview; ``(content, meta, suppressed)``.

    Clears the turn's emit_card registry (fail-open when unbound) and strips
    ``[[card:N]]`` markers so no dangling marker reaches the reader. Logs the
    drop: a turn that came back with no cards must read as "suppressed", never
    as "the model never tried". Mechanical — no prompt wording, no doctrine
    change.

    The drop is SPLIT: cards go, but the gated trailer goes only when it was
    never earned. At or above the takeaway floor the takeaways stay (with the
    rest of the gated meta); below it the meta shrinks to the callout alone —
    a warning or Frist the reader must see whatever the prose length — and to
    nothing when there is no callout either.

    Two vetoes, both read off the registry snapshot before anything is
    cleared. System cards are the product, not the trailer: ``document_draft``
    (and every other ``SYSTEM_CARD_TYPES`` member) is pushed by the tool that
    did the work, and a short drafting answer (kind=direct, <400 chars, no
    verdict) matches the suppression floor exactly. Clearing the registry
    there would eat the announcement of the work just done, so any system
    card in the registry vetoes the whole suppression — cards, markers and
    meta all stay. ``legal_basis`` vetoes the same way (see
    ``_LEGAL_BASIS_CARD_TYPE``): it is the proof the verdict rests on.
    """
    if not _should_suppress_meta_cards(content, gated_meta):
        return content, gated_meta, False
    try:
        from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
        from aiq_agent.cards.registry import get_card_registry as _get_registry_for_guard

        _veto_types = SYSTEM_CARD_TYPES | {_LEGAL_BASIS_CARD_TYPE}
        _guard_registry = _get_registry_for_guard()
        if _guard_registry is not None and any(card.get("type") in _veto_types for card in _guard_registry.snapshot()):
            logger.info("Piloti: answer cards suppressed: veto card present, keeping cards and meta")
            return content, gated_meta, False
    except Exception:
        logger.debug("Suppression veto guard skipped", exc_info=True)
    try:
        prose_chars = len(prose_without_references(content))
    except Exception:
        prose_chars = -1
    logger.info(
        "Piloti: answer cards suppressed: prose %d chars under the %d floor with no verdict",
        prose_chars,
        _CARD_SUPPRESS_MIN_PROSE_CHARS,
    )
    try:
        from aiq_agent.cards.registry import get_card_registry

        registry = get_card_registry()
        if registry is not None and len(registry) > 0:
            logger.info("Piloti: answer cards suppressed: dropping %d emit_card card(s)", len(registry))
            registry.clear()
    except Exception:
        logger.debug("Card registry suppression skipped", exc_info=True)
    try:
        stripped = _CARD_MARKER_RE.sub("", content)
        # A dropped own-line marker leaves a blank paragraph that reads as a
        # rendering fault; collapse three-plus newlines to two.
        stripped = re.sub(r"\n{3,}", "\n\n", stripped).strip()
        # Never fall back to the marker text: an answer whose prose was only
        # markers has nothing left to say, and a `[[card:N]]` with no card
        # behind it reaches the reader as that literal string.
        content = stripped
    except Exception:
        pass
    if prose_chars >= TAKEAWAYS_MIN_PROSE_CHARS:
        # The takeaway window: the cards were unearned, but the takeaways were
        # earned by length — keep the whole gated trailer.
        return content, gated_meta, True
    # Below the takeaway floor the trailer shrinks to the callout alone. The
    # ``[[callout]]`` marker resolves downstream against exactly this field
    # (``resolve_callout_marker``), so returning ``None`` here would drop the
    # marker with it and silence a warning the gates deliberately kept.
    kept = {key: value for key, value in (gated_meta or {}).items() if key in ("v", "callout")}
    return content, (kept if "callout" in kept else None), True


def _trailer_captures(
    turn_sources: Sequence[SourceEntry] | None,
    repair_sources: Sequence[SourceEntry],
) -> list[SourceEntry]:
    """The capture log the trailer-value gate reads: this turn's reads, plus repairs.

    The caller passes the turn log explicitly because the capture ContextVar is
    already reset when finalization runs; ``None`` (direct callers, tests)
    falls back to the ambient log. An adopted repair fetch is this turn's read
    too, so its sources count — otherwise the gate drops the very values the
    repair established.
    """
    return [*(turn_sources if turn_sources is not None else get_turn_captures()), *repair_sources]


async def finalize_answer(
    messages: Sequence[Any],
    *,
    registry: SourceRegistry,
    tools: Sequence[BaseTool],
    repair: RepairFn | None,
    turn_sources: Sequence[SourceEntry] | None = None,
    card_repair: CardRepairFn | None = None,
) -> FinalAnswer:
    """Run every post-answer stage and return the answer as the reader gets it.

    ``turn_sources`` is this turn's capture, which the caller must pass when it
    finalises AFTER ``end_turn_capture``: the ContextVar is back to its prior
    value by then, so the trailer-grounding veto would read an empty list and
    abstain on every turn. The adopted repair sources are appended to it, so a
    verdict or takeaway the repair established stays grounded. ``None`` falls
    back to the ambient log for direct callers.

    Raises :class:`EmptySourceRegistryError` when a data-source lookup ran and
    nothing came back: that turn has no answer to show.
    """
    index = answer_index(messages)
    if index is None or not messages[index].content:
        return FinalAnswer(messages=list(messages), answered=False)
    extracted = _extract(content_to_text(messages[index].content))
    # The envelope's cards, before verification: registration is what turns
    # the array's numbers into registry positions, and the markers have to be
    # the reader's before the suppression floor and the callout resolver read
    # the prose.
    turn = this_turn(messages)
    with_cards = await _register_envelope_cards(extracted.meta, extracted.content, turn, card_repair)
    if with_cards != extracted.content:
        extracted = replace(extracted, content=with_cards)
    lookup_attempted = _source_lookup_attempted(turn)
    sources = registry.all_sources()
    if sources:
        emit_citation_check(source_count=len(sources))
        history = prose_history(messages[:index])
        verified = await _verify_with_repair(extracted.content, registry, repair, history)
        grounding = _ground(verified, registry, lookup_attempted=lookup_attempted)
    else:
        _require_retrieval(lookup_attempted, tools)
        grounding = _Grounding(extracted.content)

    sanitized = sanitize_report(grounding.content)
    content, _ = drop_restated_mindmaps(sanitized.sanitized_report)
    cited = _renumbered(grounding.cited, sanitized.renumber_map)
    _recite_surface_cards(sanitized.renumber_map, cited)
    meta = _gated_meta(
        extracted,
        content,
        registry,
        turn_sources=_trailer_captures(turn_sources, grounding.repair_sources),
    )
    content, meta, _cards_suppressed = _suppress_cards(content, meta)
    content = resolve_callout_marker(content, has_callout=bool(meta and "callout" in meta))
    final_messages = list(messages)
    final_messages[index] = messages[index].model_copy(update={"content": content})
    return FinalAnswer(
        messages=final_messages,
        answered=True,
        content=content,
        citation_grounded=grounding.citation_grounded,
        citation_fallback_used=grounding.citation_fallback_used,
        quotes_verified=not grounding.unverified_quotes,
        unverified_quote_count=len(grounding.unverified_quotes),
        normative_claim_uncited=_normative_claim_uncited(content, grounding),
        escalation_requested=extracted.escalation_requested,
        answer_is_handoff=bool(extracted.meta is not None and extracted.meta.kind == "handoff"),
        confidence_marker=extracted.confidence,
        confidence_marker_reason=extracted.confidence_reason,
        escalation_reason=extracted.escalation_reason,
        source_lookup_attempted=lookup_attempted,
        answer_meta=meta,
        skills_applied=_skills_applied(extracted.meta),
        cited=cited,
        removed_citations=grounding.removed_citations,
        repair_sources=grounding.repair_sources,
    )

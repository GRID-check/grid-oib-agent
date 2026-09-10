"""Post-answer verification: what happens to the model's text before a reader sees it.

Pure stages over ``(messages, registry)``, in this order: DSML strip, envelope
split, control-marker extraction, citation and quote verification with the
turn's ONE repair, the single-source fallback citation, sanitisation, the
``answer_meta`` gates, callout resolution and the normative-claim brake.
:func:`finalize_answer` runs them and returns a :class:`FinalAnswer`; the agent
copies its signal fields onto the state (``ledger.assemble_result``).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool

from aiq_agent.common import citation_events
from aiq_agent.common import content_to_text
from aiq_agent.common import get_source_id_for_tool
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
from aiq_agent.common.citation_verification import sanitize_report
from aiq_agent.common.citation_verification import source_origin_token
from aiq_agent.common.citation_verification import verify_citations
from aiq_agent.common.citation_verification import verify_quoted_spans
from aiq_agent.common.tool_validation import validate_tool_availability
from aiq_agent.common.turn_status import emit_citation_check

from .dsml import strip_and_salvage_dsml_tool_calls
from .grounding import answer_mentions_normative_claim
from .markers import detect_and_strip_confidence_marker
from .markers import detect_and_strip_escalation_marker
from .repair import Repair
from .repair import VerificationFailures

logger = logging.getLogger(__name__)

#: The repair the agent injects: ``(original prose, failures, history)`` →
#: a rewrite, or ``None`` to keep the marked answer. ``None`` as the function
#: means the repair pass is off.
RepairFn = Callable[[str, VerificationFailures, list[Any]], Awaitable[Repair | None]]


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
    confidence_marker: str | None = None
    confidence_marker_reason: str | None = None
    escalation_reason: str | None = None
    source_lookup_attempted: bool = False
    answer_meta: dict[str, Any] | None = None
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


def _source_lookup_attempted(messages: Sequence[Any]) -> bool:
    """Whether any data-source tool ran this turn."""
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
        return len(self.verification.removed_citations) + len(self.unverified_quotes)


def _verify(content: str, registry: SourceRegistry) -> _Verified:
    """Citations against the registry, then quoted spans against the passages.

    ``verify_citations`` only proves a cited SOURCE is real, not that a QUOTED
    sentence appears in it; ``verify_quoted_spans`` catches the "real section,
    fabricated quote" pattern. Fail-open: quotes are annotated, never stripped.
    """
    verification = verify_citations(content, registry, reference_sources=registry.all_sources())
    logger.debug(
        "Researcher: citation verification complete — %d valid, %d removed",
        len(verification.valid_citations),
        len(verification.removed_citations),
    )
    quotes = verify_quoted_spans(verification.verified_report, registry)
    return _Verified(verification.verified_report, verification, tuple(quotes))


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
    if not (after < verified.failure_count and candidate.valid_citations):
        logger.info("Researcher: repair pass discarded (%d -> %d failures)", verified.failure_count, after)
        return None
    logger.info("Researcher: repair pass adopted (%d -> %d failures)", verified.failure_count, after)
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
        removed_citations=tuple(verified.verification.removed_citations),
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
            "Researcher: %d quoted span(s) not verbatim in any retrieved passage; annotated inline",
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
        logger.debug("Researcher: answered without querying any data-source tool; no verification")
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


def _gated_meta(extracted: _Extracted, content: str, registry: SourceRegistry) -> dict[str, Any] | None:
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
    """
    if extracted.meta is None or extracted.escalation_requested:
        return None
    return gate_answer_meta(
        extracted.meta,
        prose_chars=len(prose_without_references(content)),
        agent_authored_documents=agent_authored_document_names(registry),
    )


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


async def finalize_answer(
    messages: Sequence[Any],
    *,
    registry: SourceRegistry,
    tools: Sequence[BaseTool],
    repair: RepairFn | None,
) -> FinalAnswer:
    """Run every post-answer stage and return the answer as the reader gets it.

    Raises :class:`EmptySourceRegistryError` when a data-source lookup ran and
    nothing came back: that turn has no answer to show.
    """
    index = answer_index(messages)
    if index is None or not messages[index].content:
        return FinalAnswer(messages=list(messages), answered=False)
    extracted = _extract(content_to_text(messages[index].content))
    lookup_attempted = _source_lookup_attempted(messages)
    sources = registry.all_sources()
    if sources:
        emit_citation_check(source_count=len(sources))
        history = [m for m in messages[:index] if not isinstance(m, ToolMessage)]
        verified = await _verify_with_repair(extracted.content, registry, repair, history)
        grounding = _ground(verified, registry, lookup_attempted=lookup_attempted)
    else:
        _require_retrieval(lookup_attempted, tools)
        grounding = _Grounding(extracted.content)

    sanitized = sanitize_report(grounding.content)
    content = sanitized.sanitized_report
    meta = _gated_meta(extracted, content, registry)
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
        confidence_marker=extracted.confidence,
        confidence_marker_reason=extracted.confidence_reason,
        escalation_reason=extracted.escalation_reason,
        source_lookup_attempted=lookup_attempted,
        answer_meta=meta,
        cited=_renumbered(grounding.cited, sanitized.renumber_map),
        removed_citations=grounding.removed_citations,
        repair_sources=grounding.repair_sources,
    )

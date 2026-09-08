"""Post-processing of a deep research graph state into the shipped answer.

Every step here is a plain function over the values ``DeepResearcherAgent``
already holds: the report text, the run's source registry, the writer's
self-assessment. ``DeepResearcherAgent._finalize`` is the pipeline that calls
them in order; the salvage path (``cutoff.salvage_cutoff``) runs the same
pipeline, so a cut-off report is verified, sanitised and labelled by exactly
the code a complete one is.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from aiq_agent.agents.shallow_researcher.markers import ConfidenceLevel
from aiq_agent.agents.shallow_researcher.markers import answer_confidence_capped_reason
from aiq_agent.agents.shallow_researcher.markers import surface_answer_confidence
from aiq_agent.common import citation_events
from aiq_agent.common.citation_verification import annotate_unverified_quotes
from aiq_agent.common.citation_verification import sanitize_report
from aiq_agent.common.citation_verification import source_entry_to_wire
from aiq_agent.common.citation_verification import source_label
from aiq_agent.common.citation_verification import source_origin_token
from aiq_agent.common.citation_verification import verify_citations
from aiq_agent.common.citation_verification import verify_quoted_spans
from aiq_agent.common.turn_status import CUTOFF_RUN_BUDGET
from aiq_agent.common.turn_status import CUTOFF_STEP_LIMIT
from aiq_agent.common.turn_status import CUTOFF_UPSTREAM_TIMEOUT
from aiq_agent.common.turn_status import CUTOFF_WALL_CLOCK
from aiq_agent.common.turn_status import DEGRADED_NO_VALID_CITATIONS
from aiq_agent.common.turn_status import DEGRADED_UNVERIFIED_QUOTES
from aiq_agent.common.turn_status import emit_answer_degraded
from aiq_agent.skills import SkillRuntime

logger = logging.getLogger(__name__)

#: How much salvaged report is worth shipping. Below this the "report" is a
#: stub — a heading, a half sentence, the writer's opening line — and handing it
#: to a reader under a "was cut off" banner would be worse than the honest
#: failure: it looks like an answer. A cutoff with less than this raises the
#: original error instead.
MIN_SALVAGE_REPORT_CHARS = 200

#: The ceiling a run that never finished gathering its evidence may reach. Deep
#: research is the ONE path that knows it was cut off, and a report salvaged at
#: the wall clock — or written without the sources that would have proved it —
#: has not seen what it set out to see. "high" is reserved for a claim checked
#: against a retrieved passage, so an incomplete run cannot earn it from
#: whatever it happened to reach first.
_INCOMPLETE_EVIDENCE_CONFIDENCE_CEILING: ConfidenceLevel = "medium"

#: Ordering used only to clamp DOWN. Spelled out here rather than reached into
#: the markers module for, so this file can never end up RAISING a self-report —
#: the one thing the overconfidence guard exists to make impossible.
_CONFIDENCE_RANK: dict[str, int] = {"low": 0, "medium": 1, "high": 2}

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

_OUTPUT_PATHS = ("/shared/output.md", "/output.md")


# ---------------------------------------------------------------------------
# Reading the graph state
# ---------------------------------------------------------------------------


def _file_text(entry: Any) -> str | None:
    """The non-blank text of one DeepAgents file entry, in any of its shapes."""
    if isinstance(entry, dict):
        entry = entry.get("content")
    if isinstance(entry, bytes):
        entry = entry.decode("utf-8")
    if isinstance(entry, str) and entry.strip():
        return entry.strip()
    return None


def extract_final_markdown(result: Any) -> str | None:
    """The report the writer persisted, or None when no output file exists."""
    files = result.get("files", {}) if isinstance(result, dict) else getattr(result, "files", {})
    if not isinstance(files, dict):
        return None
    for path in _OUTPUT_PATHS:
        text = _file_text(files.get(path))
        if text:
            return text
    return None


def set_state_field(result: Any, key: str, value: Any) -> None:
    """Set ``key`` on a graph state that may be a dict or an object.

    LangGraph hands back a plain dict today, but the salvage path also sees
    whatever the last streamed chunk happened to be, so both shapes are
    supported.
    """
    if isinstance(result, dict):
        result[key] = value
        return
    setattr(result, key, value)


def replace_last_message_content(result: Any, content: str) -> None:
    """Overwrite the final message content in place with the post-processed Markdown."""
    messages = result.get("messages") if isinstance(result, dict) else getattr(result, "messages", None)
    if not messages:
        return
    last_msg = messages[-1]
    if hasattr(last_msg, "model_copy"):
        messages[-1] = last_msg.model_copy(update={"content": content})
        return
    messages[-1] = type(last_msg)(content=content)


# ---------------------------------------------------------------------------
# Labelling
# ---------------------------------------------------------------------------


def _cap_for_incomplete_evidence(
    level: ConfidenceLevel | None,
    *,
    cutoff_reason: str | None,
    degraded_reasons: list[str],
) -> ConfidenceLevel | None:
    """Clamp a self-report the run's own incompleteness cannot back up.

    Applied ON TOP of the shared overconfidence guard, never instead of it: the
    guard grades whether the claims are sourced, this grades whether the run
    that made them ever finished. The cap carries no reason token of its own:
    truncation already reaches the reader through ``research_truncated`` and
    the honesty banner, and a sixth ``CappedReason`` would put a token on the
    dashboard and in the chip tooltip that neither has a dictionary entry for.
    """
    if level is None or (cutoff_reason is None and not degraded_reasons):
        return level
    ceiling = _INCOMPLETE_EVIDENCE_CONFIDENCE_CEILING
    return level if _CONFIDENCE_RANK[level] <= _CONFIDENCE_RANK[ceiling] else ceiling


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
        cause_clause = f" {cause}" if cause else ""
        sentences.append(
            f"Diese Recherche wurde{cause_clause} vorzeitig beendet, der folgende Bericht ist daher unvollständig."
        )
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


# ---------------------------------------------------------------------------
# Citations → wire sources
# ---------------------------------------------------------------------------


def _registry_entry(registry: Any, citation: dict[str, Any]) -> Any:
    if citation.get("citation_key"):
        return registry.entry_for_citation_key(citation["citation_key"])
    if citation.get("url"):
        return registry.entry_for_url(citation["url"])
    return None


def _wire_source(entry: Any, number: Any) -> dict[str, Any] | None:
    """One entry serialised for the wire; None when that one entry cannot be.

    Guarded per entry because this runs on the SALVAGE path as well as the
    normal one, and a truncated run is the likeliest producer of a half-built
    entry: one source that fails to serialise costs the reader that single
    chip, never the rest of the provenance block.
    """
    try:
        return source_entry_to_wire(entry, number=number if isinstance(number, int) else None)
    except Exception:  # noqa: BLE001 - one bad source must not zero out the rest
        logger.warning(
            "Skipping source that failed wire serialization: %s",
            getattr(entry, "url", None) or getattr(entry, "citation_key", None),
            exc_info=True,
        )
        return None


def _cited_sources_to_wire(registry: Any, valid_citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Resolve the citations that survived verification back to wire sources.

    ``verify_citations`` proves each ``[N]`` marker points at a source the run
    really captured, and it is the ONLY place the ``[N]``→source binding
    exists. Everything a reader needs from a citation — the page to open the
    PDF at, the snippet to hover, the lane and binding note — lives on the
    registry entry behind that binding. This is the join, mirroring
    ``ShallowResearcherAgent``'s so both agents emit one shape.

    Deduplicated by entry identity in first-cited order: four passages of one
    Richtlinie are four citations but the reader wants the document once, and
    the first mention is the one whose ``[N]`` the prose leads with.
    """
    wire_sources: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    for citation in valid_citations:
        entry = _registry_entry(registry, citation)
        if entry is None or id(entry) in seen_ids:
            continue
        seen_ids.add(id(entry))
        wire = _wire_source(entry, citation.get("number"))
        if wire is not None:
            wire_sources.append(wire)
    return wire_sources


def _dead_numbers(removed_numbers: Any) -> set[int]:
    """The pre-renumber citation numbers ``sanitize_report`` deleted.

    Tolerant of the shapes tests hand in (a MagicMock's auto-created
    attributes are neither containers nor None).
    """
    if isinstance(removed_numbers, dict):
        return {n for n in removed_numbers if isinstance(n, int)}
    if isinstance(removed_numbers, (set, frozenset, list, tuple)):
        return {n for n in removed_numbers if isinstance(n, int)}
    return set()


def _is_dead(number: Any, dead: set[int], renumber_map: dict[int, int]) -> bool:
    if not isinstance(number, int):
        return False
    return number in dead or (bool(renumber_map) and number not in renumber_map)


def _renumbered(source: dict[str, Any], renumber_map: dict[int, int]) -> dict[str, Any]:
    number = source.get("number")
    if not renumber_map or not isinstance(number, int):
        return source
    return {**source, "number": renumber_map.get(number, number)}


def _apply_renumbering(
    wire_sources: list[dict[str, Any]],
    renumber_map: dict[int, int] | None,
    removed_numbers: Any = None,
) -> list[dict[str, Any]]:
    """The wire sources re-labelled with the numbers the READER will see.

    ``sanitize_report`` closes the gaps that ``verify_citations``' removals
    left in the ``[N]`` sequence, so the numbers captured during verification
    are stale by the time the report ships. Without this remap a chip is
    labelled ``[3]`` while the prose pointing at it now says ``[2]``.

    Fail-closed on sanitize deaths: ``sanitize_report`` also DELETES source
    lines with shortened / truncated / unsafe URLs. Their numbers arrive via
    ``removed_numbers`` and those chips are dropped — never remapped, never
    shipped as clickable at a URL the reader no longer sees. A number absent
    from a non-empty ``renumber_map`` is likewise dead and dropped, so a
    sanitizer rule that forgets to report a death still cannot leave a trusted
    chip at a removed URL. Returns a new list; the input is left alone.
    """
    if not isinstance(renumber_map, dict):
        renumber_map = {}
    dead = _dead_numbers(removed_numbers)
    kept = [source for source in wire_sources if not _is_dead(source.get("number"), dead, renumber_map)]
    dropped = len(wire_sources) - len(kept)
    if dropped:
        logger.info(
            "Dropping %d wire source(s) whose citations sanitize_report removed: dead=%s",
            dropped,
            sorted(dead),
        )
    return [_renumbered(source, renumber_map) for source in kept]


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Verification:
    """What citation verification established about one report.

    ``checked`` is False on the ``enable_citation_verification=False`` path.
    The defaults there describe a run that checked nothing: no citation
    survived verification (none was ever verified) and no quoted span was
    contradicted — so the overconfidence guard refuses to surface anything
    above "low". A report nobody checked must not wear the chip that means
    "checked against a retrieved passage".
    """

    report: str
    checked: bool = False
    valid_citations: list[dict[str, Any]] = field(default_factory=list)
    removed_citations: list[dict[str, Any]] = field(default_factory=list)
    unverified_quote_count: int = 0
    wire_sources: list[dict[str, Any]] = field(default_factory=list)
    degraded_reasons: list[str] = field(default_factory=list)

    @property
    def citation_grounded(self) -> bool:
        return bool(self.valid_citations)

    @property
    def quotes_verified(self) -> bool:
        """One fabricated quotation is enough to drop the whole answer."""
        return self.unverified_quote_count == 0


def _removed_citation_lines(removed_citations: Iterable[dict[str, Any]]) -> list[str]:
    lines = []
    for citation in removed_citations:
        url_match = re.search(r"https?://\S+", citation.get("line", ""))
        url_str = url_match.group(0).rstrip(".,;)") if url_match else "(no url)"
        lines.append(f"[{citation['number']}] {citation['reason']}: {url_str}")
    return lines


def verify_report(report: str, registry: Any, reference_sources: list[Any]) -> Verification:
    """Strip unverifiable citations, annotate unverifiable quotes, resolve the rest.

    ``verify_citations`` proves each cited SOURCE is real; ``verify_quoted_spans``
    catches the weak model's "real section, fabricated quote" pattern by
    checking each quoted span against the retrieved passage text. Quotes are
    annotated inline, never stripped, and an annotated quote ships MARKED so a
    salvaged report can never read exactly like a verified one.
    """
    verification = verify_citations(report, registry, reference_sources=reference_sources)
    if verification.removed_citations:
        logger.info(
            "Citation verification removed %d invalid citation(s):\n  %s",
            len(verification.removed_citations),
            "\n  ".join(_removed_citation_lines(verification.removed_citations)),
        )
    report = verification.verified_report
    degraded_reasons: list[str] = []
    unverified_quotes = verify_quoted_spans(report, registry)
    if unverified_quotes:
        report = annotate_unverified_quotes(report, unverified_quotes)
        logger.info(
            "Citation verification: %d quoted span(s) not verbatim in any retrieved passage; annotated inline",
            len(unverified_quotes),
        )
        degraded_reasons.append(DEGRADED_UNVERIFIED_QUOTES)
    if not verification.valid_citations:
        # Over-aggressive verification is a real possibility, so this is not a
        # failure — but a report with nothing provably grounded no longer
        # ships silently.
        logger.warning(
            "Citation verification found no valid citations in writer-agent output; "
            "returning the generated report without failing the job. "
            "This may indicate unsupported citation formatting or over-aggressive verification."
        )
        degraded_reasons.append(DEGRADED_NO_VALID_CITATIONS)
    valid_citations = list(verification.valid_citations)
    return Verification(
        report=report,
        checked=True,
        valid_citations=valid_citations,
        removed_citations=list(verification.removed_citations),
        unverified_quote_count=len(unverified_quotes),
        wire_sources=_cited_sources_to_wire(registry, valid_citations),
        degraded_reasons=degraded_reasons,
    )


def record_citation_ledger(verification: Verification, registry: Any, self_confidence: ConfidenceLevel | None) -> None:
    """One citation-health batch per deep-research run, the shape shallow posts.

    The whole registry IS this run's retrieval: the deep researcher builds a
    fresh registry per run (ADR-0018), unlike the shallow agent's cumulative
    one, so no per-turn capture log is needed. Deep research has NO
    single-source fallback (an ungrounded report hard-fails instead), stated
    explicitly so the dashboard reads "deep never falls back". The capped
    reason is recomputed from the same inputs the state field uses, so the
    dashboard and the reader's chip can never disagree about WHY.
    """
    registry_sources = registry.all_sources()
    citation_events.record_turn(
        agent="deep",
        source_count=len(registry_sources),
        cited_count=len(verification.valid_citations),
        removed_citations=list(verification.removed_citations),
        unverified_quote_count=verification.unverified_quote_count,
        grounded=verification.citation_grounded,
        fallback_used=False,
        confidence_capped_reason=answer_confidence_capped_reason(
            self_confidence,
            verification.citation_grounded,
            verification.quotes_verified,
        ),
        source_origins=[source_origin_token(entry).strip("[]").lower() or None for entry in registry_sources],
        # The retrieval lane of each CITED source: only the wire entries carry
        # it, since the lane is derived during serialisation.
        source_lanes=[source.get("lane") for source in verification.wire_sources],
        source_tools=[entry.tool_name or None for entry in registry_sources],
        # Source IDENTITIES (URL / document key) — never report prose.
        retrieved_source_labels=[label for label in map(source_label, registry_sources) if label],
        cited_source_labels=[
            label for label in ((c.get("citation_key") or c.get("url")) for c in verification.valid_citations) if label
        ],
    )


# ---------------------------------------------------------------------------
# The finished answer
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FinalizedReport:
    """Everything ``annotate_state`` writes and the report it writes it about."""

    report: str
    degraded_reasons: list[str]
    wire_sources: list[dict[str, Any]]
    cutoff_reason: str | None
    citations_removed: dict[str, Any] | None
    confidence: ConfidenceLevel | None
    confidence_reason: str | None
    confidence_capped_reason: str | None


def finalize_report(
    verification: Verification,
    *,
    self_confidence: ConfidenceLevel | None,
    self_confidence_reason: str | None,
    degraded_reasons: list[str],
    cutoff_reason: str | None,
) -> FinalizedReport:
    """Sanitise, renumber, banner and grade the verified report.

    Sanitisation renumbers the surviving ``[N]`` markers, so the chips have to
    follow the prose; the banner goes on last because it is about everything
    above it; the confidence chip is surfaced only after the run's own
    limitations are known, since both the shared guard and the deep-only
    ceiling cap it.
    """
    degraded = [*degraded_reasons, *verification.degraded_reasons]
    sanitization = sanitize_report(verification.report)
    wire_sources = _apply_renumbering(
        verification.wire_sources,
        sanitization.renumber_map,
        getattr(sanitization, "removed_citation_numbers", None),
    )
    report = _prepend_honesty_banner(
        sanitization.sanitized_report, cutoff_reason=cutoff_reason, degraded_reasons=degraded
    )
    grounded, quotes_ok = verification.citation_grounded, verification.quotes_verified
    confidence = _cap_for_incomplete_evidence(
        surface_answer_confidence(self_confidence, grounded, quotes_ok),
        cutoff_reason=cutoff_reason,
        degraded_reasons=degraded,
    )
    capped_reason = answer_confidence_capped_reason(self_confidence, grounded, quotes_ok)
    return FinalizedReport(
        report=report,
        degraded_reasons=degraded,
        wire_sources=wire_sources,
        cutoff_reason=cutoff_reason,
        citations_removed=_summarize_removed_citations(verification.removed_citations),
        confidence=confidence,
        confidence_reason=self_confidence_reason if confidence is not None else None,
        confidence_capped_reason=capped_reason if confidence is not None else None,
    )


def record_skill_transparency(result: Any, skill_runtime: SkillRuntime | None) -> None:
    """Say which skills shaped this report, and shout when a forced one did not.

    DELIVERED, not merely forced: a skill whose body the model never opened
    shaped nothing and must not be claimed. Its counterpart — the turn told the
    model to apply a skill and it never asked for it — is the failure nobody
    can see from the answer, so it is logged loudly.
    """
    if skill_runtime is None:
        return
    activated = list(skill_runtime.activated)
    if activated:
        set_state_field(result, "skills_activated", activated)
    hidden = list(skill_runtime.hidden_activated)
    if hidden:
        set_state_field(result, "skills_hidden", hidden)
    unread = skill_runtime.forced_not_activated
    if unread:
        logger.warning(
            "Deep research: forced skills never loaded by the writer: %s (activated=%s)",
            ", ".join(unread),
            ", ".join(activated) or "-",
        )


def annotate_state(result: Any, finalized: FinalizedReport, skill_runtime: SkillRuntime | None) -> None:
    """Write the transparency fields onto the graph state.

    Every field is ABSENT rather than empty when there is nothing to say: a
    surface cannot tell "we checked and found none" from "we lost them" once
    an empty list is written, and no confidence marker means "not assessed",
    which a reader must be able to tell from "low".
    """
    if finalized.citations_removed is not None:
        set_state_field(result, "citations_removed", finalized.citations_removed)
    if finalized.wire_sources:
        set_state_field(result, "verified_sources", finalized.wire_sources)
    record_skill_transparency(result, skill_runtime)
    if finalized.cutoff_reason is not None:
        set_state_field(result, "research_truncated", True)
        set_state_field(result, "truncation_reason", finalized.cutoff_reason)
    if finalized.degraded_reasons:
        set_state_field(result, "degraded_reasons", list(finalized.degraded_reasons))
        emit_answer_degraded(agent="deep", reasons=finalized.degraded_reasons)
    if finalized.confidence is None:
        return
    set_state_field(result, "answer_confidence", finalized.confidence)
    if finalized.confidence_reason:
        set_state_field(result, "answer_confidence_reason", finalized.confidence_reason)
    if finalized.confidence_capped_reason is not None:
        set_state_field(result, "answer_confidence_capped_reason", finalized.confidence_capped_reason)


def emit_final_report(callbacks: Iterable[Any], report: str) -> None:
    """Re-emit the verified report so the frontend overwrites the raw stream.

    Guarded, because this runs inside ``_finalize`` and the salvage path reads
    a raised ``_finalize`` as "nothing to salvage": a sink that throws would
    destroy a verified report that exists. Delivering the answer outranks
    echoing it, so a failing sink costs its own echo and nothing else.
    """
    sink = next((cb for cb in callbacks if hasattr(cb, "emit_final_report")), None)
    if sink is None:
        return
    try:
        sink.emit_final_report(report)
    except Exception:  # noqa: BLE001 - an echo must never unmake the answer
        logger.warning("Could not re-emit the final report to a callback", exc_info=True)


def log_completion(finalized: FinalizedReport) -> None:
    logger.info("=" * 80)
    logger.info("Deep Research Subagent: Workflow complete")
    logger.info("Final answer length: %d characters", len(finalized.report))
    if finalized.cutoff_reason or finalized.degraded_reasons:
        logger.info(
            "Answer shipped MARKED (cutoff=%s degraded=%s)",
            finalized.cutoff_reason or "-",
            ",".join(finalized.degraded_reasons) or "-",
        )
    logger.info("=" * 80)

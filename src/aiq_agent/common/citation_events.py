"""Citation-health telemetry: one ledger row per turn per citation defect.

Citation verification (``citation_verification.verify_citations`` /
``verify_quoted_spans``) already *repairs* a turn — it drops unverifiable
citations, annotates fabricated quotes, and caps the surfaced confidence. The
user sees the outcome ("Ohne Quellenangabe", "3 Quellenangabe(n) entfernt",
"Confidence: low"), but until now nothing recorded it, so nobody could answer
"how often does this happen, to which organizations, and why?".

This module is the answer. It is the citation-quality sibling of
``profiler.py`` (timings) and the LLM cost ledger (spend): each research turn
posts a small batch of events through the token-guarded internal BFF endpoint
``POST /api/internal/citation-events``, and the platform owner reads the
aggregate on the platform dashboard.

Design notes:

- **One row per (turn, kind).** Every observed turn emits exactly one
  ``turn_verified`` baseline row, plus one row per defect detected. That makes
  "turns observed" and "turns with defect X" both a plain ``COUNT`` — no jsonb
  digging — and keeps the clean-rate denominator honest.
- **No user prose ever leaves the backend.** Events carry machine reason keys,
  counts, and coarse source metadata (origin/lane/tool names). Answer text,
  quoted spans, and citation lines stay in the agent.
- **Best-effort and non-blocking.** Emission never raises into the answer path
  and never delays it: batches go to a daemon thread pool, exactly like the
  profiler's ``wait=False`` flush.
- **Correlated with the profiler.** The turn id is borrowed from the active
  :class:`~aiq_agent.common.profiler.AgentProfiler` when one is running, so a
  citation defect on the dashboard links to that turn's execution timeline.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from dataclasses import field
from threading import Lock
from typing import Any
from typing import Literal

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Taxonomy
# ---------------------------------------------------------------------------

EventKind = Literal[
    "turn_verified",
    "citations_removed",
    "quote_unverified",
    "answer_ungrounded",
    "registry_empty",
    "citation_fallback",
    "confidence_capped",
    "retrieval_precision",
]

EventSeverity = Literal["ok", "info", "warn", "error"]

#: Severity per kind. Kept here (not on the wire's whim) so the dashboard's
#: severity mix cannot drift between emitters.
SEVERITY_BY_KIND: dict[str, EventSeverity] = {
    # The baseline row every observed turn emits — the clean-rate denominator.
    "turn_verified": "ok",
    # A source was captured but the model cited nothing verifiable; the answer
    # ships with the honest "Ohne Quellenangabe" gap row. Worst user-visible
    # outcome short of an outright failure.
    "answer_ungrounded": "error",
    # Retrieval captured nothing at all — EmptySourceRegistryError, the turn
    # fails rather than answering ungrounded.
    "registry_empty": "error",
    # verify_citations dropped >=1 citation the model wrote.
    "citations_removed": "warn",
    # A QUOTED span was not found (fuzzily) in any retrieved passage — the
    # "real section, fabricated quote" pattern.
    "quote_unverified": "warn",
    # Nothing the model cited survived, but exactly one registry source existed
    # and was appended as a minimal citation. Grounded, but not by the model.
    "citation_fallback": "info",
    # The overconfidence guard downgraded the surfaced confidence. `reasons`
    # carries which gate closed — including `normative_claim_uncited`, the mixed
    # answer whose numbers were measured but whose legal claim was not cited.
    # That row is the only place the normative-claim heuristic's hit rate becomes
    # observable, so it is worth counting even though the level is unchanged from
    # what the answer would have got before measurement grounding existed.
    "confidence_capped": "info",
    # Per-turn retrieval feedback: how many retrieved sources the answer
    # actually cited vs ignored. An observation, not a defect.
    "retrieval_precision": "info",
}

#: Removal reasons ``verify_citations`` produces. ``duplicate_of_citation_<n>``
#: is collapsed to ``duplicate`` so the dashboard's reason breakdown does not
#: explode into one bucket per citation number.
_DUPLICATE_REASON_PREFIX = "duplicate_of_citation_"

#: Cap on distinct reason keys carried per event — a pathological answer must
#: not post an unbounded payload.
_MAX_REASONS = 8

#: Cap on distinct source labels (origin/lane/tool) carried in an event's
#: detail blob.
_MAX_DETAIL_LABELS = 12


def normalize_removal_reason(reason: str) -> str:
    """Collapse a ``verify_citations`` removal reason to a stable bucket key."""
    text = (reason or "").strip() or "unverifiable"
    if text.startswith(_DUPLICATE_REASON_PREFIX):
        return "duplicate"
    return text


def summarize_removal_reasons(removed_citations: list[dict[str, Any]]) -> dict[str, int]:
    """Count normalized removal reasons across one turn's dropped citations."""
    counter: Counter[str] = Counter()
    for entry in removed_citations:
        raw = entry.get("reason") if isinstance(entry, dict) else None
        counter[normalize_removal_reason(str(raw) if raw else "")] += 1
    return dict(counter.most_common(_MAX_REASONS))


# The citation TARGET inside a dropped source line: the URL or the
# "filename.pdf, p.12" key the model claimed. Extracting just the target keeps
# the ledger free of answer prose while still recording WHICH source failed —
# the one fact a diagnosis actually needs.
_TARGET_URL_RE = re.compile(r"https?://[^\s<>\"'\]]+")
_TARGET_FILE_RE = re.compile(r"([^\s\[\]|]+\.[A-Za-z]{2,5})(\s*,\s*(?:p\.?|page|S\.)\s*\d+)?", re.IGNORECASE)

#: Hard bound on a recorded target string.
_MAX_TARGET_LEN = 300
#: Hard bound on how many targets one event carries.
_MAX_TARGETS = 10


def extract_citation_target(line: str) -> str | None:
    """Pull the cited URL or document key out of a dropped source line.

    Returns ``None`` when the line carries no recognizable target (the model
    wrote a bare title), so nothing resembling free prose is ever recorded.
    """
    if not isinstance(line, str) or not line.strip():
        return None
    url_match = _TARGET_URL_RE.search(line)
    if url_match:
        return url_match.group(0).rstrip(".,;)]>")[:_MAX_TARGET_LEN]
    file_match = _TARGET_FILE_RE.search(line)
    if file_match:
        return "".join(part for part in file_match.groups() if part).strip()[:_MAX_TARGET_LEN]
    return None


def summarize_removed_targets(removed_citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Which sources were dropped, and why — the diagnostic payload.

    One entry per dropped citation that carried an identifiable target:
    ``{"target": <url or file key>, "reason": <bucket>}``. Answer prose is
    never included; a line with no extractable target is simply skipped.
    """
    targets: list[dict[str, Any]] = []
    for entry in removed_citations:
        if not isinstance(entry, dict):
            continue
        target = extract_citation_target(str(entry.get("line") or ""))
        if target is None:
            continue
        targets.append({"target": target, "reason": normalize_removal_reason(str(entry.get("reason") or ""))})
        if len(targets) >= _MAX_TARGETS:
            break
    return targets


# ---------------------------------------------------------------------------
# Event model
# ---------------------------------------------------------------------------


@dataclass
class CitationEvent:
    """One citation-health observation for one turn."""

    kind: EventKind
    #: How many individual items the event covers (citations dropped, quotes
    #: unverified, …). Always >= 1; the baseline row uses 1.
    count: int = 1
    #: Machine reason key -> occurrences. Empty for kinds without reasons.
    reasons: dict[str, int] = field(default_factory=dict)
    #: Small, non-prose context blob (source origins, tool names, counts).
    detail: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "severity": SEVERITY_BY_KIND.get(self.kind, "warn"),
            "count": max(1, int(self.count)),
            "reasons": self.reasons or None,
            "detail": self.detail or None,
        }


# ---------------------------------------------------------------------------
# Turn assembly
# ---------------------------------------------------------------------------


def _label_counts(values: list[str | None]) -> dict[str, int]:
    """Count non-empty labels, capped, for an event's detail blob."""
    counter: Counter[str] = Counter(value for value in values if value)
    return dict(counter.most_common(_MAX_DETAIL_LABELS))


def build_turn_events(
    *,
    source_count: int,
    cited_count: int,
    removed_citations: list[dict[str, Any]] | None = None,
    unverified_quote_count: int = 0,
    grounded: bool = True,
    fallback_used: bool = False,
    confidence_capped_reason: str | None = None,
    source_origins: list[str | None] | None = None,
    source_lanes: list[str | None] | None = None,
    source_tools: list[str | None] | None = None,
    retrieved_source_labels: list[str] | None = None,
    cited_source_labels: list[str] | None = None,
) -> list[CitationEvent]:
    """Turn one research turn's verification outcome into ledger events.

    Always returns at least the ``turn_verified`` baseline row, so the clean
    rate has a denominator even for a flawless turn. Pure and side-effect free
    — :func:`record_turn` does the emitting, and the tests exercise this
    function directly.
    """
    removed = removed_citations or []
    source_mix = {
        "origins": _label_counts(source_origins or []),
        "lanes": _label_counts(source_lanes or []),
        "tools": _label_counts(source_tools or []),
    }
    events: list[CitationEvent] = [
        CitationEvent(
            kind="turn_verified",
            detail={
                "source_count": source_count,
                "cited_count": cited_count,
                **{key: value for key, value in source_mix.items() if value},
            },
        )
    ]

    retrieved_labels = [label for label in (retrieved_source_labels or []) if label]
    if retrieved_labels:
        # The retrieval feedback loop: of the sources retrieval handed the
        # model, how many did the answer actually use? Counts are over UNIQUE
        # labels (a source cited twice is still one source); `cited_count` is
        # the overlap with what the model cited, not the raw citation count.
        unique_retrieved = list(dict.fromkeys(retrieved_labels))
        cited_labels = {label for label in (cited_source_labels or []) if label}
        uncited = [label for label in unique_retrieved if label not in cited_labels]
        events.append(
            CitationEvent(
                kind="retrieval_precision",
                detail={
                    "retrieved_count": len(unique_retrieved),
                    "cited_count": len(unique_retrieved) - len(uncited),
                    "uncited_count": len(uncited),
                    "uncited_sources": uncited[:_MAX_TARGETS],
                },
            )
        )

    if removed:
        events.append(
            CitationEvent(
                kind="citations_removed",
                count=len(removed),
                reasons=summarize_removal_reasons(removed),
                detail={
                    "source_count": source_count,
                    "cited_count": cited_count,
                    # WHICH sources were dropped, and why — the payload that makes
                    # the platform export diagnosable rather than merely countable.
                    "targets": summarize_removed_targets(removed),
                },
            )
        )
    if unverified_quote_count > 0:
        events.append(
            CitationEvent(
                kind="quote_unverified",
                count=unverified_quote_count,
                detail={
                    "source_count": source_count,
                    "cited_count": cited_count,
                    # The documents the answer was quoting FROM, so a diagnosis
                    # can be checked against the real passage. The quoted text
                    # itself is answer prose and is deliberately not recorded.
                    "cited_sources": (cited_source_labels or [])[:_MAX_TARGETS],
                },
            )
        )
    if not grounded:
        events.append(
            CitationEvent(
                kind="answer_ungrounded",
                detail={
                    "source_count": source_count,
                    "removed_count": len(removed),
                    # What retrieval DID return while nothing survived citation —
                    # the difference between "nothing relevant found" and "the
                    # model ignored what it was given".
                    "retrieved_sources": (retrieved_source_labels or [])[:_MAX_TARGETS],
                    "targets": summarize_removed_targets(removed),
                },
            )
        )
    if fallback_used:
        events.append(CitationEvent(kind="citation_fallback", detail={"source_count": source_count}))
    if confidence_capped_reason:
        events.append(
            CitationEvent(
                kind="confidence_capped",
                reasons={str(confidence_capped_reason): 1},
            )
        )
    return events


# ---------------------------------------------------------------------------
# Identity + transport
# ---------------------------------------------------------------------------

_REQUEST_TIMEOUT_SECONDS = 5.0
_MAX_EVENTS_PER_BATCH = 50
_post_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="citation-events")

#: Ceiling on batches queued but not yet posted. ThreadPoolExecutor's work queue
#: is UNBOUNDED: with the BFF hung, every worker blocks for the full request
#: timeout while new turns keep submitting, and the backlog (holding each
#: payload) grows without limit. Telemetry must never be the thing that runs a
#: replica out of memory, so past this point new batches are dropped — the
#: honest trade for a best-effort ledger.
_MAX_PENDING_BATCHES = 200
_pending_batches = 0
_pending_lock = Lock()
_dropped_batches = 0


def _release_pending(_future: Any) -> None:
    """Free a backlog slot once a batch has been posted (or failed)."""
    global _pending_batches
    with _pending_lock:
        _pending_batches -= 1


def _submit_batch(payload: dict[str, Any]) -> bool:
    """Queue a batch for posting; return False when the backlog is full."""
    global _pending_batches, _dropped_batches
    with _pending_lock:
        if _pending_batches >= _MAX_PENDING_BATCHES:
            _dropped_batches += 1
            dropped = _dropped_batches
            backlog_full = True
        else:
            _pending_batches += 1
            backlog_full = False
    if backlog_full:
        # Log sparsely: a stuck BFF would otherwise produce one line per turn.
        if dropped == 1 or dropped % 100 == 0:
            logger.warning(
                "Citation-event backlog full (%d pending) — dropped %d batch(es) so far",
                _MAX_PENDING_BATCHES,
                dropped,
            )
        return False
    try:
        _post_executor.submit(_post_batch, payload).add_done_callback(_release_pending)
    except Exception:
        _release_pending(None)
        raise
    return True


def _events_enabled() -> bool:
    """Whether citation-health telemetry is emitted (default on)."""
    return (os.environ.get("GRID_CITATION_EVENTS_ENABLED") or "true").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _read_identity() -> dict[str, str | None]:
    """Organization / conversation for the live request, if any."""
    try:
        from aiq_agent.project_context import get_conversation_id_from_context
        from aiq_agent.project_context import get_organization_id_from_context

        return {
            "organization_id": get_organization_id_from_context(),
            "conversation_id": get_conversation_id_from_context(),
        }
    except Exception:  # pragma: no cover - context module is import-safe in practice
        logger.debug("Could not read identity for citation events", exc_info=True)
        return {"organization_id": None, "conversation_id": None}


def _active_profiler() -> Any | None:
    """The :class:`AgentProfiler` covering this turn, when one is active."""
    try:
        from aiq_agent.common.profiler import agent_profiler_var

        return agent_profiler_var.get()
    except Exception:  # pragma: no cover - defensive
        logger.debug("Could not read the active agent profiler", exc_info=True)
        return None


def _resolve_context(
    identity: dict[str, str | None] | None,
    job_id: str | None,
) -> dict[str, str | None]:
    """Resolve org / conversation / turn / job for one batch.

    Precedence: an explicitly passed ``identity`` wins, then the active
    profiler, then the live request context. The profiler tier is what makes
    async deep-research jobs work — a Dask worker has no request headers, but
    the job runner hands ``track_agent_profile`` the identity captured at
    submit time. Reusing the profiler's ``turn_id`` also links a citation
    defect to that turn's execution timeline on the platform dashboard.
    """
    profiler = _active_profiler()
    resolved = dict(identity) if identity is not None else _read_identity()
    for key in ("organization_id", "conversation_id"):
        if not resolved.get(key) and profiler is not None:
            resolved[key] = getattr(profiler, key, None)
    turn_id = getattr(profiler, "turn_id", None) if profiler is not None else None
    resolved["turn_id"] = str(turn_id) if turn_id else str(uuid.uuid4())
    resolved["job_id"] = job_id or (getattr(profiler, "job_id", None) if profiler is not None else None)
    return resolved


#: Only real HTTP(S) endpoints may be posted to. A misconfigured
#: FRONTEND_INTERNAL_URL must not let urllib open a ``file://`` (or ftp://, …)
#: handler with the internal token and the batch attached.
_ALLOWED_URL_SCHEMES = frozenset({"http", "https"})


def _post_batch(payload: dict[str, Any]) -> None:
    """POST one batch to the BFF ledger endpoint. Best-effort, never raises."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        logger.warning(
            "GRID_INTERNAL_API_TOKEN not configured — dropping %d citation event(s)",
            len(payload.get("events") or ()),
        )
        return
    base_url = (
        os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    ).rstrip("/")
    scheme = urllib.parse.urlparse(base_url).scheme.lower()
    if scheme not in _ALLOWED_URL_SCHEMES:
        logger.warning(
            "Internal frontend URL uses unsupported scheme %r — dropping citation events",
            scheme or "(none)",
        )
        return
    # Serialization and request construction are inside the guard too: a payload
    # that will not serialize is a bug worth a log line, not a silent exception
    # swallowed by an unread Future on the dispatch thread.
    try:
        request = urllib.request.Request(
            f"{base_url}/api/internal/citation-events",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-grid-internal-token": token},
            method="POST",
        )
        # The URL is the deployment-set internal frontend base plus a fixed path;
        # no user input reaches it (same pattern as the profiler/cost ledgers).
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            if response.status not in (200, 201, 202):
                logger.warning("Internal citation-events endpoint returned %s", response.status)
    except urllib.error.HTTPError as error:
        logger.warning("Internal citation-events endpoint rejected batch: HTTP %s", error.code)
    except Exception:
        logger.warning("Failed to post citation events to internal endpoint", exc_info=True)


def emit_events(
    events: list[CitationEvent],
    *,
    agent: str,
    job_id: str | None = None,
    identity: dict[str, str | None] | None = None,
    wait: bool = False,
) -> dict[str, Any] | None:
    """Post ``events`` for one turn. Returns the payload (or ``None`` if skipped).

    ``wait=True`` posts inline — used by callers with no daemon-safe teardown
    (tests, job workers that exit immediately after the turn). Everything here
    is wrapped so a telemetry failure can never surface in an answer.
    """
    if not events or not _events_enabled():
        return None
    try:
        resolved = _resolve_context(identity, job_id)
        payload = {
            "organizationId": resolved.get("organization_id"),
            "conversationId": resolved.get("conversation_id"),
            "turnId": resolved["turn_id"],
            "jobId": resolved.get("job_id"),
            "agent": agent,
            "events": [event.to_payload() for event in events[:_MAX_EVENTS_PER_BATCH]],
        }
    except Exception:
        logger.warning("Could not assemble citation-event batch", exc_info=True)
        return None

    try:
        if wait:
            _post_batch(payload)
        else:
            _submit_batch(payload)
    except Exception:
        logger.warning("Could not dispatch citation-event batch", exc_info=True)
    return payload


def record_turn(
    *,
    agent: str,
    source_count: int,
    cited_count: int,
    removed_citations: list[dict[str, Any]] | None = None,
    unverified_quote_count: int = 0,
    grounded: bool = True,
    fallback_used: bool = False,
    confidence_capped_reason: str | None = None,
    source_origins: list[str | None] | None = None,
    source_lanes: list[str | None] | None = None,
    source_tools: list[str | None] | None = None,
    retrieved_source_labels: list[str] | None = None,
    cited_source_labels: list[str] | None = None,
    job_id: str | None = None,
    identity: dict[str, str | None] | None = None,
) -> dict[str, Any] | None:
    """Record one research turn's citation health. Never raises.

    Call once per turn, right after citation + quote verification has settled,
    from the research agents (shallow and deep).
    """
    try:
        events = build_turn_events(
            source_count=source_count,
            cited_count=cited_count,
            removed_citations=removed_citations,
            unverified_quote_count=unverified_quote_count,
            grounded=grounded,
            fallback_used=fallback_used,
            confidence_capped_reason=confidence_capped_reason,
            source_origins=source_origins,
            source_lanes=source_lanes,
            source_tools=source_tools,
            retrieved_source_labels=retrieved_source_labels,
            cited_source_labels=cited_source_labels,
        )
    except Exception:
        logger.warning("Could not build citation events", exc_info=True)
        return None
    return emit_events(events, agent=agent, job_id=job_id, identity=identity)


def record_empty_registry(
    *,
    agent: str,
    unavailable_tools: list[str] | None = None,
    available_count: int = 0,
    job_id: str | None = None,
    identity: dict[str, str | None] | None = None,
) -> dict[str, Any] | None:
    """Record a turn that captured no sources at all (EmptySourceRegistryError).

    Emitted from the raise site, so the failure shows up on the dashboard next
    to the softer defects instead of only in the logs. Never raises.
    """
    try:
        # `unavailable_tools` comes from tool-validation callers and is not
        # guaranteed to be a list — a set or generator is not sliceable, and the
        # docstring promises this never raises.
        tools = list(unavailable_tools or [])[:_MAX_DETAIL_LABELS]
        event = CitationEvent(
            kind="registry_empty",
            detail={"available_tools": available_count, "unavailable_tools": tools},
        )
    except Exception:
        logger.warning("Could not build the empty-registry citation event", exc_info=True)
        return None
    return emit_events([event], agent=agent, job_id=job_id, identity=identity)

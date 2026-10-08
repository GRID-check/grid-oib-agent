"""Upload screening: a document an office has ruled out never reaches an external model.

An office names terms (``Gehaltsabrechnung``, ``Honorarvereinbarung``) and switches
on detectors for identifiers that must not leave the building (IBAN, the Austrian
social-security number, a payment-card number). The ingest job runs this check on
the text it extracted LOCALLY (pdfplumber, the office and text-format readers) and
before its first model call (OCR, image captioning, VLM enrichment, summary and
tags, embeddings). A match fails the file with a ``quarantined:`` reason and nothing
of it is sent anywhere.

Rule-based and local on purpose: the NVIDIA toolkits evaluated for this read English
only and hook in after the model call, which is one step too late.

Pure: rules in, verdict out. ``ScreeningRules.from_config`` never raises into the job.

The matcher itself (folding, terms, the three detectors, spans, masked samples)
is ``aiq_agent.common.content_screen``, mirrored in the browser; this module
turns its spans into a verdict per file. The names callers use are re-exported
below.

Only checksum-valid matches count, so a document full of order numbers is not
quarantined for looking like one. The verdict never carries a matched value: a
detector reason holds a MASKED sample (``AT61 •••• •••• •••• 3201``), because the
reason is stored on the job status and shown to people who may not see the value.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from dataclasses import field
from typing import Literal

from aiq_agent.common.content_screen import DETECTORS
from aiq_agent.common.content_screen import IBAN_LENGTHS
from aiq_agent.common.content_screen import MAX_TERM_CHARS
from aiq_agent.common.content_screen import MAX_TERMS
from aiq_agent.common.content_screen import MIN_TERM_CHARS
from aiq_agent.common.content_screen import Detector
from aiq_agent.common.content_screen import ScreeningRules
from aiq_agent.common.content_screen import find_spans
from aiq_agent.common.content_screen import fold
from aiq_agent.common.content_screen import luhn_valid
from aiq_agent.common.content_screen import mask_at_svnr
from aiq_agent.common.content_screen import mask_card
from aiq_agent.common.content_screen import mask_iban
from aiq_agent.common.content_screen import valid_at_svnr
from aiq_agent.common.content_screen import valid_card
from aiq_agent.common.content_screen import valid_iban

__all__ = [
    "DETECTORS",
    "IBAN_LENGTHS",
    "MAX_ERROR_CHARS",
    "MAX_REASON_PAGES",
    "MAX_REASONS",
    "MAX_TERM_CHARS",
    "MAX_TERMS",
    "MIN_TERM_CHARS",
    "QUARANTINED_PREFIX",
    "Detector",
    "Reason",
    "ScreeningRules",
    "ScreeningVerdict",
    "document_pages",
    "fold",
    "log_summary",
    "luhn_valid",
    "mask_at_svnr",
    "mask_card",
    "mask_iban",
    "page_number_of",
    "quarantine_error",
    "screen_pages",
    "valid_at_svnr",
    "valid_card",
    "valid_iban",
]

#: What a quarantined file's ``error_message`` starts with; the JSON follows it.
QUARANTINED_PREFIX = "quarantined:"

#: What one reason and one error carry at most.
MAX_REASON_PAGES = 10
MAX_REASONS = 10
MAX_ERROR_CHARS = 2000


# ----------------------------------------------------------------------- verdict


@dataclass(frozen=True)
class Reason:
    """Why a file was quarantined: one term or one detector, never a matched value."""

    kind: str
    count: int
    pages: list[int]
    term: str | None = None
    sample: str | None = None

    def as_json(self) -> dict[str, object]:
        out: dict[str, object] = {"kind": self.kind}
        if self.term is not None:
            out["term"] = self.term
        out["count"] = self.count
        out["pages"] = self.pages
        if self.sample is not None:
            out["sample"] = self.sample
        return out


@dataclass(frozen=True)
class ScreeningVerdict:
    """What the screen found. ``checked`` is ``partial`` when some content was not screened."""

    reasons: list[Reason] = field(default_factory=list)
    checked: Literal["full", "partial"] = "full"

    @property
    def matched(self) -> bool:
        return bool(self.reasons)


@dataclass
class _Tally:
    count: int = 0
    pages: set[int] = field(default_factory=set)
    sample: str | None = None

    def add(self, hits: int, page: int | None, sample: str | None = None) -> None:
        if not hits:
            return
        self.count += hits
        if page is not None:
            self.pages.add(page)
        if self.sample is None:
            self.sample = sample


def screen_pages(
    pages: Iterable[tuple[int | None, str]],
    rules: ScreeningRules,
    *,
    checked: Literal["full", "partial"] = "full",
) -> ScreeningVerdict:
    """Screen ``(page number or None, text)`` pages against ``rules``. Pure.

    ``checked`` is passed through to the verdict: the caller knows whether the
    pages it handed over are all of the document's content.
    """
    term_tallies = {term: _Tally() for term in rules.terms}
    detector_tallies = {name: _Tally() for name in rules.detectors}
    for page, text in pages:
        for span in find_spans(text, rules):
            tally = term_tallies[span.term] if span.kind == "term" else detector_tallies[span.kind]
            tally.add(1, page, span.sample)
    reasons = [
        Reason(kind="term", term=term, count=tally.count, pages=_page_list(tally.pages))
        for term, tally in term_tallies.items()
        if tally.count
    ]
    reasons += [
        Reason(kind=name, count=tally.count, pages=_page_list(tally.pages), sample=tally.sample)
        for name, tally in detector_tallies.items()
        if tally.count
    ]
    return ScreeningVerdict(reasons=reasons, checked=checked)


def _page_list(pages: set[int]) -> list[int]:
    return sorted(pages)[:MAX_REASON_PAGES]


def page_number_of(label: object) -> int | None:
    """A ``page_label`` as a page number when it is one (``"3"``, ``3``); ``None`` otherwise."""
    if isinstance(label, bool):
        return None
    if isinstance(label, int):
        return label
    if isinstance(label, str) and label.strip().isdigit():
        return int(label.strip())
    return None


def document_pages(documents: Iterable[object]) -> list[tuple[int | None, str]]:
    """LlamaIndex Documents as screen pages: their text, paged by ``page_label`` where numeric."""
    pages: list[tuple[int | None, str]] = []
    for document in documents:
        metadata = getattr(document, "metadata", None) or {}
        pages.append((page_number_of(metadata.get("page_label")), getattr(document, "text", "") or ""))
    return pages


def quarantine_error(verdict: ScreeningVerdict) -> str:
    """The file's ``error_message``: the prefix, then compact JSON of at most ten reasons.

    Reasons are dropped from the end until the whole string fits
    ``MAX_ERROR_CHARS``; the JSON is always whole.
    """
    reasons = [reason.as_json() for reason in verdict.reasons[:MAX_REASONS]]
    while True:
        payload = {"reasons": reasons, "checked": verdict.checked}
        error = QUARANTINED_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if len(error) <= MAX_ERROR_CHARS or not reasons:
            return error
        reasons = reasons[:-1]


def log_summary(verdict: ScreeningVerdict) -> str:
    """The reason kinds and counts, for a log line: no term, no sample, no value."""
    return ", ".join(f"{reason.kind}={reason.count}" for reason in verdict.reasons)

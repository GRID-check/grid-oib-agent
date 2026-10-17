"""Upload screening: a document an office has ruled out never reaches an external model.

An office names terms (``Gehaltsabrechnung``, ``Honorarvereinbarung``) and switches
on detectors for identifiers that must not leave the building (IBAN, the Austrian
social-security number, a payment-card number). The ingest job runs this check on
the text it extracted LOCALLY (pdfplumber, the office and text-format readers) and
before its first model call (OCR, image captioning, VLM enrichment, summary and
tags, embeddings). A match fails the file, records why as a typed verdict
(``ScreeningVerdict.to_model``, ``FileProgress.quarantine``, ADR-0113), and nothing
of it is sent anywhere.

Rule-based and local on purpose: the NVIDIA toolkits evaluated for this read English
only and hook in after the model call, which is one step too late.

Pure: rules in, verdict out. ``ScreeningRules.from_config`` never raises into the job.

The matcher itself (folding, terms, the three detectors, spans, masked samples)
is ``aiq_agent.common.content_screen``, shared with the chat socket's mask and
mirrored in the browser; this module turns its spans into a verdict per file.
The names it used to define are re-exported below, so callers did not move.

Only checksum-valid matches count, so a document full of order numbers is not
quarantined for looking like one. The verdict never carries a matched value: a
detector reason holds a MASKED sample (``AT61 •••• •••• •••• 3201``), because the
reason is stored on the job status and shown to people who may not see the value.

The file's ``error_message`` still carries the same verdict as
``quarantined:{json}`` (``quarantine_error``), for one release: a BFF that predates
the typed field reads it from there. It is derived from the model, so the two
never disagree, and nothing new may read it.
"""

from __future__ import annotations

import json
from bisect import bisect_right
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from dataclasses import replace
from typing import Literal

from aiq_agent.common.content_screen import DETECTORS
from aiq_agent.common.content_screen import IBAN_LENGTHS
from aiq_agent.common.content_screen import MAX_TERM_CHARS
from aiq_agent.common.content_screen import MAX_TERMS
from aiq_agent.common.content_screen import MIN_TERM_CHARS
from aiq_agent.common.content_screen import Detector
from aiq_agent.common.content_screen import ScreeningRules
from aiq_agent.common.content_screen import Span
from aiq_agent.common.content_screen import find_spans
from aiq_agent.common.content_screen import fold
from aiq_agent.common.content_screen import luhn_valid
from aiq_agent.common.content_screen import mask_at_svnr
from aiq_agent.common.content_screen import mask_card
from aiq_agent.common.content_screen import mask_iban
from aiq_agent.common.content_screen import valid_at_svnr
from aiq_agent.common.content_screen import valid_card
from aiq_agent.common.content_screen import valid_iban
from aiq_agent.common.page_text import running_furniture
from aiq_agent.common.page_text import without_furniture
from aiq_agent.knowledge.schema import QuarantineReason
from aiq_agent.knowledge.schema import QuarantineVerdict

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

#: What a quarantined file's legacy ``error_message`` starts with; the JSON follows it.
QUARANTINED_PREFIX = "quarantined:"

#: What one reason and one verdict carry at most. A reviewer opens the document
#: at each listed page, so a reason lists every page it was found on up to
#: ``MAX_REASON_PAGES``; past that, or where the verdict with its legacy prefix
#: would outgrow ``MAX_ERROR_CHARS`` of JSON, the reason says its list is cut
#: (``pages_truncated``).
MAX_REASON_PAGES = 50
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
    #: ``pages`` is not every page it was found on; written only when true.
    pages_truncated: bool = False

    def to_model(self) -> QuarantineReason:
        """This reason as the job status stores it."""
        return QuarantineReason(
            kind=self.kind,
            term=self.term,
            count=self.count,
            pages=list(self.pages),
            pages_truncated=self.pages_truncated,
            sample=self.sample,
        )

    def as_json(self) -> dict[str, object]:
        return self.to_model().model_dump()


@dataclass(frozen=True)
class ScreeningVerdict:
    """What the screen found. ``checked`` is ``partial`` when some content was not screened."""

    reasons: list[Reason] = field(default_factory=list)
    checked: Literal["full", "partial"] = "full"
    #: The pages screened were the vision model's transcript of scanned pages:
    #: that model saw them, no later model call did. Written only when true.
    after_transcription: bool = False

    @property
    def matched(self) -> bool:
        return bool(self.reasons)

    def to_model(self) -> QuarantineVerdict:
        """The verdict as the job status stores it: at most ten reasons, bounded as a whole.

        Until its JSON, with the legacy prefix, fits ``MAX_ERROR_CHARS``, the
        reason listing the most pages gives up its last one and says so
        (``pages_truncated``), so every reason keeps at least its first page to
        open the document at. Only when each lists one page are reasons dropped
        from the end. ``omitted`` says how many reasons it left out, so a
        reader is never shown a short list as the complete one.
        """
        listed = list(self.reasons[:MAX_REASONS])
        while True:
            model = QuarantineVerdict(
                reasons=[reason.to_model() for reason in listed],
                checked=self.checked,
                omitted=len(self.reasons) - len(listed),
                after_transcription=self.after_transcription,
            )
            if len(QUARANTINED_PREFIX) + len(_compact_json(model)) <= MAX_ERROR_CHARS or not listed:
                return model
            listed = _with_one_page_fewer(listed) or listed[:-1]


@dataclass
class _Tally:
    count: int = 0
    pages: set[int] = field(default_factory=set)
    sample: str | None = None

    def add(self, hits: int, pages: Iterable[int | None], sample: str | None = None) -> None:
        if not hits:
            return
        self.count += hits
        self.pages.update(page for page in pages if page is not None)
        if self.sample is None:
            self.sample = sample


def screen_pages(
    pages: Iterable[tuple[int | None, str]],
    rules: ScreeningRules,
    *,
    checked: Literal["full", "partial"] = "full",
    stream: Sequence[tuple[int, str]] = (),
) -> ScreeningVerdict:
    """Screen ``(page number or None, text)`` pages against ``rules``. Pure.

    ``checked`` is passed through to the verdict: the caller knows whether the
    pages it handed over are all of the document's content.

    ``stream`` is the document's body text page by page, in reading order (a
    PDF's text layer). Each page is screened on its own above; the stream is
    then read as one text, running headers and footers left out
    (``aiq_agent.common.page_text``), and a match that runs from one page into
    the next counts too, listed on every page it touches. A number split by a
    page break and a „Seite 2 von 3“ is otherwise two halves nobody reads.
    """
    term_tallies = {term: _Tally() for term in rules.terms}
    detector_tallies = {name: _Tally() for name in rules.detectors}
    found = [(span, (page,)) for page, text in pages for span in find_spans(text, rules)]
    found += _spans_across_pages(stream, rules)
    for span, span_pages in found:
        tally = term_tallies[span.term] if span.kind == "term" else detector_tallies[span.kind]
        tally.add(1, span_pages, span.sample)
    reasons = [
        Reason(
            kind="term",
            term=term,
            count=tally.count,
            pages=_page_list(tally.pages),
            pages_truncated=len(tally.pages) > MAX_REASON_PAGES,
        )
        for term, tally in term_tallies.items()
        if tally.count
    ]
    reasons += [
        Reason(
            kind=name,
            count=tally.count,
            pages=_page_list(tally.pages),
            sample=tally.sample,
            pages_truncated=len(tally.pages) > MAX_REASON_PAGES,
        )
        for name, tally in detector_tallies.items()
        if tally.count
    ]
    return ScreeningVerdict(reasons=reasons, checked=checked)


def _spans_across_pages(stream: Sequence[tuple[int, str]], rules: ScreeningRules) -> list[tuple[Span, tuple[int, ...]]]:
    """The matches in ``stream`` read as one text that start on one page and end on a later one."""
    if len(stream) < 2:
        return []
    page_lines = [text.split("\n") for _, text in stream]
    furniture = running_furniture(page_lines)
    bodies = ["\n".join(without_furniture(lines, furniture)) for lines in page_lines]
    starts: list[int] = []
    offset = 0
    for body in bodies:
        starts.append(offset)
        offset += len(body) + 1
    numbers = [page for page, _ in stream]

    def page_index(position: int) -> int:
        return bisect_right(starts, position) - 1

    across: list[tuple[Span, tuple[int, ...]]] = []
    for span in find_spans("\n".join(bodies), rules):
        first, last = page_index(span.start), page_index(span.end - 1)
        if first != last:
            across.append((span, tuple(numbers[first : last + 1])))
    return across


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
    """The file's legacy ``error_message``: the prefix, then compact JSON of ``verdict.to_model()``.

    Kept for one release beside ``FileProgress.quarantine`` (ADR-0113), for a
    BFF that still reads the reason out of the string. Derived from the typed
    verdict, so it holds the same reasons and the same bounds.
    """
    return QUARANTINED_PREFIX + _compact_json(verdict.to_model())


def _compact_json(model: QuarantineVerdict) -> str:
    return json.dumps(model.model_dump(), ensure_ascii=False, separators=(",", ":"))


def _with_one_page_fewer(reasons: list[Reason]) -> list[Reason] | None:
    """``reasons`` with the last page of the one listing the most cut, or ``None`` when none lists two."""
    widest = max(range(len(reasons)), key=lambda index: len(reasons[index].pages))
    pages = reasons[widest].pages
    if len(pages) < 2:
        return None
    trimmed = list(reasons)
    trimmed[widest] = replace(reasons[widest], pages=pages[:-1], pages_truncated=True)
    return trimmed


def log_summary(verdict: ScreeningVerdict) -> str:
    """The reason kinds and counts, for a log line: no term, no sample, no value."""
    return ", ".join(f"{reason.kind}={reason.count}" for reason in verdict.reasons)

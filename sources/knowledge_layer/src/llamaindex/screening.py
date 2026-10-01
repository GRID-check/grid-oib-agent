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

Term matching
-------------
Both sides are folded the same way: Unicode NFKC, ``casefold``, then the German
transliterations (ä→ae, ö→oe, ü→ue; ``casefold`` already makes ß→ss), so
``Gehaltsübersicht``, ``GEHALTSÜBERSICHT`` and ``Gehaltsuebersicht`` are one term.
A term matches at a WORD START and may run on: ``Honorar`` matches
``Honorarvereinbarung`` and ``Honorare``, because German builds its compounds by
appending. It does NOT match inside a word (``Ehrenhonorar``): a term preceded by a
letter or digit is part of a different word, and matching there would quarantine on
every compound that merely ends in the term. A multi-word term matches across any
run of whitespace, line breaks included.

Detectors
---------
Only checksum-valid matches count, so a document full of order numbers is not
quarantined for looking like one. The verdict never carries a matched value: a
detector reason holds a MASKED sample (``AT61 •••• •••• •••• 3201``), because the
reason is stored on the job status and shown to people who may not see the value.
"""

from __future__ import annotations

import json
import logging
import math
import re
import unicodedata
from collections.abc import Iterable
from collections.abc import Mapping
from dataclasses import dataclass
from dataclasses import field
from typing import Literal

logger = logging.getLogger(__name__)

#: What a quarantined file's ``error_message`` starts with; the JSON follows it.
QUARANTINED_PREFIX = "quarantined:"

Detector = Literal["iban", "at_svnr", "credit_card"]
#: Detectors in the order their reasons are reported.
DETECTORS: tuple[str, ...] = ("iban", "at_svnr", "credit_card")

#: Bounds the request model enforces too (``aiq_api.models.requests.ScreeningPolicy``).
MAX_TERMS = 200
MIN_TERM_CHARS = 2
MAX_TERM_CHARS = 80

#: What one reason and one error carry at most.
MAX_REASON_PAGES = 10
MAX_REASONS = 10
MAX_ERROR_CHARS = 2000

_MASK = "••••"

_TRANSLITERATION = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})

#: Not preceded / followed by a letter or digit (``[^\W_]`` is a word character
#: other than the underscore).
_NO_ALNUM_BEFORE = r"(?<![^\W_])"
_NO_ALNUM_AFTER = r"(?![^\W_])"


def fold(text: str) -> str:
    """The form both a term and the document are compared in. Pure."""
    return unicodedata.normalize("NFKC", text).casefold().translate(_TRANSLITERATION)


def _term_pattern(term: str) -> re.Pattern[str]:
    words = [re.escape(word) for word in fold(term).split()]
    return re.compile(_NO_ALNUM_BEFORE + r"\s+".join(words))


@dataclass(frozen=True)
class ScreeningRules:
    """The terms and detectors one job is screened against. Build with ``from_config``."""

    terms: tuple[str, ...] = ()
    detectors: tuple[str, ...] = ()
    patterns: tuple[re.Pattern[str], ...] = field(default=(), repr=False, compare=False)

    @classmethod
    def build(cls, terms: Iterable[str], detectors: Iterable[str]) -> ScreeningRules | None:
        """Rules from already-typed values, normalised; ``None`` when nothing is left to check."""
        kept_terms = _normalised_terms(terms)
        wanted = set(detectors)
        kept_detectors = tuple(name for name in DETECTORS if name in wanted)
        if not kept_terms and not kept_detectors:
            return None
        patterns = tuple(_term_pattern(term) for term in kept_terms)
        return cls(terms=kept_terms, detectors=kept_detectors, patterns=patterns)

    @classmethod
    def from_config(cls, raw: object) -> ScreeningRules | None:
        """The job config's ``screening`` entry as rules; ``None`` when absent, empty or malformed.

        Never raises: the config passed the request model on the way in, so a
        malformed one is a damaged queue row, and it is logged rather than
        allowed to fail every file of the job.
        """
        if raw is None:
            return None
        if not isinstance(raw, Mapping):
            logger.warning("Ignoring screening config of type %s", type(raw).__name__)
            return None
        terms = raw.get("content_terms") or []
        detectors = raw.get("detectors") or []
        if not _is_str_list(terms) or not _is_str_list(detectors):
            logger.warning("Ignoring screening config: content_terms and detectors must be lists of strings")
            return None
        unknown = sorted(set(detectors) - set(DETECTORS))
        if unknown:
            logger.warning("Ignoring unknown screening detector(s): %s", unknown)
        return cls.build(terms, detectors)


def _is_str_list(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _normalised_terms(terms: Iterable[str]) -> tuple[str, ...]:
    """Stripped, in bounds, first spelling of each folded form kept, at most ``MAX_TERMS``."""
    kept: dict[str, str] = {}
    for term in terms:
        stripped = " ".join(term.split())
        if MIN_TERM_CHARS <= len(stripped) <= MAX_TERM_CHARS:
            kept.setdefault(fold(stripped), stripped)
    return tuple(kept.values())[:MAX_TERMS]


# --------------------------------------------------------------------- detectors

#: Registered IBAN lengths for the countries an Austrian office meets most.
#: A country not listed is accepted at any ISO 13616 length (15..34).
IBAN_LENGTHS: dict[str, int] = {
    "AT": 20,
    "BE": 16,
    "CH": 21,
    "CZ": 24,
    "DE": 22,
    "ES": 24,
    "FR": 27,
    "GB": 22,
    "HR": 21,
    "HU": 28,
    "IT": 27,
    "LI": 21,
    "LU": 20,
    "NL": 18,
    "PL": 28,
    "SI": 19,
    "SK": 24,
}

#: Country, check digits, then either groups of four with single spaces (the
#: printed form; the last group may be shorter) or one unbroken run.
_IBAN_RE = re.compile(
    _NO_ALNUM_BEFORE + r"[A-Z]{2}\d{2}(?:(?: [A-Z0-9]{4})+(?: [A-Z0-9]{1,3})?|[A-Z0-9]{11,30})" + _NO_ALNUM_AFTER
)

#: Four digits (the serial and the check digit), the birth date DDMMYY,
#: optionally one space between them.
_SVNR_RE = re.compile(_NO_ALNUM_BEFORE + r"(\d{4}) ?(\d{6})" + _NO_ALNUM_AFTER)
_SVNR_WEIGHTS = (3, 7, 9, 0, 5, 8, 4, 2, 1, 6)

#: A run of digits joined by single spaces or hyphens, starting 2-6 (the major
#: networks). The whole run is the candidate: a card number inside a longer run
#: of numbers is not one. The price is a card printed with one space before
#: its expiry (``… 1111 12/27``), which reads as a longer run and is missed;
#: matching inside runs instead quarantined every long reference number whose
#: tail happens to pass Luhn (one in ten).
_CARD_RE = re.compile(r"(?<![^\W_])(?<!\d[ -])[2-6](?:[ -]?\d){12,18}(?![ -]?\d)" + _NO_ALNUM_AFTER)


def valid_iban(compact: str) -> bool:
    """ISO 13616: the registered length where known, and mod 97 == 1. Pure."""
    expected = IBAN_LENGTHS.get(compact[:2])
    if expected is not None and len(compact) != expected:
        return False
    if not 15 <= len(compact) <= 34:
        return False
    rearranged = compact[4:] + compact[:4]
    digits = "".join(str(int(char, 36)) for char in rearranged)
    return int(digits) % 97 == 1


def _iban_in(candidate: str) -> str | None:
    """The valid IBAN a printed candidate starts with, longest first; ``None`` if none.

    A spaced candidate may have swallowed a following group (``… 3201 EUR``),
    so its group prefixes are tried; an unbroken run must be valid whole.
    """
    groups = candidate.split(" ")
    for end in range(len(groups), 0, -1):
        compact = "".join(groups[:end])
        if valid_iban(compact):
            return compact
    return None


def mask_iban(compact: str) -> str:
    """Country and check digits, then masked groups, then the last four."""
    hidden = math.ceil(max(len(compact) - 8, 0) / 4)
    return " ".join([compact[:4], *([_MASK] * hidden), compact[-4:]])


def valid_at_svnr(digits: str) -> bool:
    """An Austrian social-security number: check digit, first digit, birth day and month. Pure.

    The check digit (4th) is the weighted sum of the other nine mod 11; a sum
    giving 10 is never issued. Months 13-15 stand for an unknown birth month.
    """
    if len(digits) != 10 or not digits.isdigit() or digits[0] == "0":
        return False
    check = sum(int(d) * w for d, w in zip(digits, _SVNR_WEIGHTS, strict=True)) % 11
    if check == 10 or check != int(digits[3]):
        return False
    day, month = int(digits[4:6]), int(digits[6:8])
    return 1 <= day <= 31 and 1 <= month <= 15


def mask_at_svnr(digits: str) -> str:
    return f"{_MASK} {_MASK}{digits[-2:]}"


def luhn_valid(digits: str) -> bool:
    """The Luhn check every payment-card number carries. Pure."""
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char) * (2 if index % 2 else 1)
        total += value - 9 if value > 9 else value
    return total % 10 == 0


def valid_card(digits: str) -> bool:
    return 13 <= len(digits) <= 19 and digits[0] in "23456" and luhn_valid(digits)


def mask_card(digits: str) -> str:
    return f"{_MASK} {digits[-4:]}"


def _ibans(text: str) -> list[str]:
    found = (_iban_in(match.group(0)) for match in _IBAN_RE.finditer(text))
    return [mask_iban(iban) for iban in found if iban]


def _svnrs(text: str) -> list[str]:
    found = (match.group(1) + match.group(2) for match in _SVNR_RE.finditer(text))
    return [mask_at_svnr(digits) for digits in found if valid_at_svnr(digits)]


def _cards(text: str) -> list[str]:
    found = (re.sub(r"[ -]", "", match.group(0)) for match in _CARD_RE.finditer(text))
    return [mask_card(digits) for digits in found if valid_card(digits)]


#: Each detector: the masked samples of its valid matches in one page's text.
_DETECTOR_SCANS = {"iban": _ibans, "at_svnr": _svnrs, "credit_card": _cards}


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
    term_tallies = [_Tally() for _ in rules.terms]
    detector_tallies = {name: _Tally() for name in rules.detectors}
    for page, text in pages:
        if not text:
            continue
        folded = fold(text)
        for tally, pattern in zip(term_tallies, rules.patterns, strict=True):
            tally.add(sum(1 for _ in pattern.finditer(folded)), page)
        for name, tally in detector_tallies.items():
            samples = _DETECTOR_SCANS[name](text)
            tally.add(len(samples), page, samples[0] if samples else None)
    reasons = [
        Reason(kind="term", term=term, count=tally.count, pages=_page_list(tally.pages))
        for term, tally in zip(rules.terms, term_tallies, strict=True)
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

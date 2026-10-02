"""The content screen: an office's terms and number detectors, found and masked in text. Pure.

One matcher for every place Piloti checks text against the office's „Sensible
Daten" policy (ADR-0077):

* the ingest job's content gate (``knowledge_layer.llamaindex.screening``) turns
  the spans into a quarantine verdict before the first model call;
* the chat socket (``aiq_api.chat_socket``) replaces them with a placeholder
  before the agent sees a message or its history keeps one.

The browser runs a TypeScript twin (``frontends/ui/src/lib/upload-screening/content-screen.ts``)
before a chat message leaves it. Both implementations read the cases in
``tests/fixtures/content_screen_cases.json`` (byte-identical twin under
``frontends/ui/tests/fixtures/``), so the same text gives the same spans, the
same masked text and the same findings on both sides.

It lives in ``aiq_agent.common`` because both Python consumers already import
from here, while importing anything under ``knowledge_layer.llamaindex`` loads
LlamaIndex and Chroma (five seconds) into a process that only wants a regex.

Term matching
-------------
Both sides are folded the same way: Unicode NFKC, ``casefold``, then the German
transliterations (ä→ae, ö→oe, ü→ue; ``casefold`` already makes ß→ss), so
``Gehaltsübersicht``, ``GEHALTSÜBERSICHT`` and ``Gehaltsuebersicht`` are one term.
The fold runs per CLUSTER (a character and the combining marks after it), which
is what lets a span found in the folded text be mapped back to the characters
it came from, and makes a decomposed ``ü`` (some PDFs, some keyboards) fold like
the composed one.

A term matches at a WORD START and may run on: ``Honorar`` matches
``Honorarvereinbarung`` and ``Honorare``, because German builds its compounds by
appending. It does NOT match inside a word (``Ehrenhonorar``): a term preceded by a
letter or digit is part of a different word, and matching there would quarantine on
every compound that merely ends in the term. A multi-word term matches across any
run of whitespace, line breaks included. A term's span runs to the end of the
word it starts, so masking ``Honorar`` hides ``Honorarvereinbarung`` whole.

Detectors
---------
Only checksum-valid matches count, so a text full of order numbers is not
flagged for looking like one. Detectors read digits as ASCII ``0-9`` on purpose:
the browser's regular expressions do, and the two must agree. What is reported
never carries a matched value: a detector's ``sample`` is MASKED
(``AT61 •••• •••• •••• 3201``), because it is stored on a job status and shown to
people who may not see the value.

Masking
-------
:func:`mask_text` replaces every span with its placeholder (:data:`PLACEHOLDERS`).
Placeholders are protected: no term or detector match that overlaps one counts,
so masking a masked text is a no-op, even for an office whose list contains
„IBAN" or „Kartennummer". Masking repeats until nothing is left to mask, because
removing one number can expose another that its digits were hiding (a card
printed straight after an IBAN).

Rules see words and number shapes, not meaning: masking a term hides the word,
not the figures around it („Honorar: 12.400 €" keeps the amount).
"""

from __future__ import annotations

import logging
import math
import re
import unicodedata
from collections.abc import Iterable
from collections.abc import Iterator
from collections.abc import Mapping
from dataclasses import dataclass
from dataclasses import field
from typing import Literal

logger = logging.getLogger(__name__)

Detector = Literal["iban", "at_svnr", "credit_card"]
#: Detectors in the order their findings are reported.
DETECTORS: tuple[str, ...] = ("iban", "at_svnr", "credit_card")

#: Bounds the request model enforces too (``aiq_api.models.requests.ScreeningPolicy``).
MAX_TERMS = 200
MIN_TERM_CHARS = 2
MAX_TERM_CHARS = 80

#: What a masked sample hides a group of characters behind.
MASK = "••••"

#: What a masked span is replaced with, by rule kind. Domain data, in German,
#: defined here once: the TypeScript twin and the shared fixture are held to it.
#: None of them may match a term or a detector (they are protected regions).
PLACEHOLDERS: dict[str, str] = {
    "iban": "[IBAN entfernt]",
    "at_svnr": "[SV-Nummer entfernt]",
    "credit_card": "[Kartennummer entfernt]",
    "term": "[Begriff entfernt]",
}

#: How often :func:`mask_text` re-reads its own output. Each pass removes at
#: least one match and adds none (placeholders are protected), so this is a
#: bound against a bug, not a budget a real text reaches.
MAX_MASK_PASSES = 5

_TRANSLITERATION = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})

#: Not preceded / followed by a letter or digit (``[^\W_]`` is a word character
#: other than the underscore, i.e. ``str.isalnum``).
_NO_ALNUM_BEFORE = r"(?<![^\W_])"
_NO_ALNUM_AFTER = r"(?![^\W_])"

_PLACEHOLDER_RE = re.compile("|".join(re.escape(placeholder) for placeholder in PLACEHOLDERS.values()))


# ------------------------------------------------------------------------- fold


def _is_mark(char: str) -> bool:
    return unicodedata.category(char).startswith("M")


def _clusters(text: str) -> Iterator[tuple[int, int]]:
    """``(start, end)`` of each character with the combining marks that follow it."""
    start = 0
    for index in range(1, len(text) + 1):
        if index == len(text) or not _is_mark(text[index]):
            yield start, index
            start = index


def _fold_cluster(cluster: str) -> str:
    return unicodedata.normalize("NFKC", cluster).casefold().translate(_TRANSLITERATION)


def fold(text: str) -> str:
    """The form both a term and the text are compared in. Pure."""
    return "".join(_fold_cluster(text[start:end]) for start, end in _clusters(text))


@dataclass(frozen=True)
class _Folded:
    """A text's fold, and for each folded character the original cluster it came from."""

    text: str
    starts: list[int]
    ends: list[int]


def _fold_mapped(text: str) -> _Folded:
    parts: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    for start, end in _clusters(text):
        folded = _fold_cluster(text[start:end])
        parts.append(folded)
        starts.extend([start] * len(folded))
        ends.extend([end] * len(folded))
    return _Folded("".join(parts), starts, ends)


def _term_pattern(term: str) -> re.Pattern[str]:
    words = [re.escape(word) for word in fold(term).split()]
    return re.compile(_NO_ALNUM_BEFORE + r"\s+".join(words))


# ------------------------------------------------------------------------ rules


@dataclass(frozen=True)
class ScreeningRules:
    """The terms and detectors a text is screened against. Build with ``build`` or ``from_config``."""

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
        """A ``{content_terms, detectors}`` mapping as rules; ``None`` when absent, empty or malformed.

        Never raises: the ingest job reads it from a queue row that passed the
        request model on the way in, so a malformed one is a damaged row, and
        it is logged rather than allowed to fail every file of the job.
        """
        if raw is None:
            return None
        if not isinstance(raw, Mapping):
            logger.warning("Ignoring screening config of type %s", type(raw).__name__)
            return None
        if not is_screening_config(raw):
            logger.warning("Ignoring screening config: content_terms and detectors must be lists of strings")
            return None
        terms = raw.get("content_terms") or []
        detectors = raw.get("detectors") or []
        unknown = sorted(set(detectors) - set(DETECTORS))
        if unknown:
            logger.warning("Ignoring unknown screening detector(s): %s", unknown)
        return cls.build(terms, detectors)


#: The rules a chat message is screened with when the office's policy could not
#: be had: every detector, no terms. A privacy control fails closed, and the
#: detectors need no list to be right.
DETECTORS_ONLY: ScreeningRules = ScreeningRules(detectors=DETECTORS)


def is_screening_config(raw: object) -> bool:
    """Whether ``raw`` has the ``{content_terms?, detectors?}`` shape: a mapping of string lists."""
    if not isinstance(raw, Mapping):
        return False
    terms = raw.get("content_terms") or []
    detectors = raw.get("detectors") or []
    return _is_str_list(terms) and _is_str_list(detectors)


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
    _NO_ALNUM_BEFORE + r"[A-Z]{2}[0-9]{2}(?:(?: [A-Z0-9]{4})+(?: [A-Z0-9]{1,3})?|[A-Z0-9]{11,30})" + _NO_ALNUM_AFTER
)

#: Four digits (the serial and the check digit), the birth date DDMMYY,
#: optionally one space between them.
_SVNR_RE = re.compile(_NO_ALNUM_BEFORE + r"([0-9]{4}) ?([0-9]{6})" + _NO_ALNUM_AFTER)
_SVNR_WEIGHTS = (3, 7, 9, 0, 5, 8, 4, 2, 1, 6)

#: A run of digits joined by single spaces or hyphens, starting 2-6 (the major
#: networks). The whole run is the candidate: a card number inside a longer run
#: of numbers is not one. The price is a card printed with one space before
#: its expiry (``… 1111 12/27``), which reads as a longer run and is missed;
#: matching inside runs instead quarantined every long reference number whose
#: tail happens to pass Luhn (one in ten).
_CARD_RE = re.compile(r"(?<![^\W_])(?<![0-9][ -])[2-6](?:[ -]?[0-9]){12,18}(?![ -]?[0-9])" + _NO_ALNUM_AFTER)


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


def _iban_in(candidate: str) -> tuple[str, int] | None:
    """The valid IBAN a printed candidate starts with, longest first, and its printed length.

    A spaced candidate may have swallowed a following group (``… 3201 EUR``),
    so its group prefixes are tried; an unbroken run must be valid whole.
    """
    groups = candidate.split(" ")
    for end in range(len(groups), 0, -1):
        compact = "".join(groups[:end])
        if valid_iban(compact):
            return compact, len(" ".join(groups[:end]))
    return None


def mask_iban(compact: str) -> str:
    """Country and check digits, then masked groups, then the last four."""
    hidden = math.ceil(max(len(compact) - 8, 0) / 4)
    return " ".join([compact[:4], *([MASK] * hidden), compact[-4:]])


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
    return f"{MASK} {MASK}{digits[-2:]}"


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
    return f"{MASK} {digits[-4:]}"


# ------------------------------------------------------------------------- spans


@dataclass(frozen=True)
class Span:
    """One match: where it is in the ORIGINAL text, which rule found it, and a masked sample."""

    kind: str
    start: int
    end: int
    term: str | None = None
    sample: str | None = None


def _iban_spans(text: str) -> Iterator[Span]:
    for match in _IBAN_RE.finditer(text):
        found = _iban_in(match.group(0))
        if found is not None:
            compact, printed = found
            yield Span("iban", match.start(), match.start() + printed, sample=mask_iban(compact))


def _svnr_spans(text: str) -> Iterator[Span]:
    for match in _SVNR_RE.finditer(text):
        digits = match.group(1) + match.group(2)
        if valid_at_svnr(digits):
            yield Span("at_svnr", match.start(), match.end(), sample=mask_at_svnr(digits))


def _card_spans(text: str) -> Iterator[Span]:
    for match in _CARD_RE.finditer(text):
        digits = re.sub(r"[ -]", "", match.group(0))
        if valid_card(digits):
            yield Span("credit_card", match.start(), match.end(), sample=mask_card(digits))


_DETECTOR_SPANS = {"iban": _iban_spans, "at_svnr": _svnr_spans, "credit_card": _card_spans}


def _word_end(text: str, end: int) -> int:
    """``end`` moved over the rest of the word it is in: letters, digits and their combining marks."""
    while end < len(text) and (text[end].isalnum() or _is_mark(text[end])):
        end += 1
    return end


def _term_spans(text: str, rules: ScreeningRules) -> Iterator[Span]:
    folded = _fold_mapped(text)
    for term, pattern in zip(rules.terms, rules.patterns, strict=True):
        for match in pattern.finditer(folded.text):
            start = folded.starts[match.start()]
            end = _word_end(text, folded.ends[match.end() - 1])
            yield Span("term", start, end, term=term)


def find_spans(text: str, rules: ScreeningRules) -> list[Span]:
    """Every match of every rule in ``text``, in rule order, then by position. Pure.

    Overlapping matches are all kept (each is a match of its own rule); a
    match that overlaps a placeholder is dropped, because a placeholder is what
    an earlier mask left behind.
    """
    if not text:
        return []
    protected = [(match.start(), match.end()) for match in _PLACEHOLDER_RE.finditer(text)]
    spans = list(_term_spans(text, rules))
    for name in rules.detectors:
        spans.extend(_DETECTOR_SPANS[name](text))
    return [span for span in spans if not _overlaps_any(span, protected)]


def _overlaps_any(span: Span, regions: list[tuple[int, int]]) -> bool:
    return any(span.start < end and start < span.end for start, end in regions)


# ------------------------------------------------------------------------ masking


@dataclass(frozen=True)
class Finding:
    """What a mask removed, per rule: the term or detector and how often, never a matched value."""

    kind: str
    count: int
    term: str | None = None
    sample: str | None = None

    def as_json(self) -> dict[str, object]:
        out: dict[str, object] = {"kind": self.kind}
        if self.term is not None:
            out["term"] = self.term
        out["count"] = self.count
        if self.sample is not None:
            out["sample"] = self.sample
        return out


@dataclass(frozen=True)
class MaskedText:
    """A text with every match replaced by its placeholder, and what was found."""

    text: str
    findings: tuple[Finding, ...] = ()

    @property
    def masked(self) -> bool:
        return bool(self.findings)


def _merged(spans: list[Span]) -> list[Span]:
    """Spans by position, overlapping ones joined; a joined span keeps the first one's kind."""
    out: list[Span] = []
    for span in sorted(spans, key=lambda s: (s.start, -s.end)):
        if out and span.start < out[-1].end:
            last = out[-1]
            out[-1] = Span(last.kind, last.start, max(last.end, span.end), last.term, last.sample)
        else:
            out.append(span)
    return out


def _replaced(text: str, spans: list[Span]) -> str:
    parts: list[str] = []
    cursor = 0
    for span in _merged(spans):
        parts.append(text[cursor : span.start])
        parts.append(PLACEHOLDERS[span.kind])
        cursor = span.end
    parts.append(text[cursor:])
    return "".join(parts)


def _findings(spans: list[Span], rules: ScreeningRules) -> tuple[Finding, ...]:
    """One finding per rule that matched: terms in the rules' order, then detectors; the first sample found."""
    by_rule: dict[tuple[str, str | None], list[Span]] = {}
    for span in spans:
        by_rule.setdefault((span.kind, span.term), []).append(span)
    order = [("term", term) for term in rules.terms] + [(name, None) for name in rules.detectors]
    findings: list[Finding] = []
    for kind, term in order:
        matched = by_rule.get((kind, term))
        if matched:
            findings.append(Finding(kind=kind, count=len(matched), term=term, sample=matched[0].sample))
    return tuple(findings)


def mask_text(text: str, rules: ScreeningRules | None) -> MaskedText:
    """``text`` with every term and detector match replaced by its placeholder. Pure.

    ``None`` rules mask nothing. Idempotent: the result's text, masked again,
    is itself with no findings.
    """
    if rules is None or not text:
        return MaskedText(text)
    found: list[Span] = []
    current = text
    for _ in range(MAX_MASK_PASSES):
        spans = find_spans(current, rules)
        if not spans:
            break
        found.extend(spans)
        current = _replaced(current, spans)
    return MaskedText(current, _findings(found, rules))


def findings_summary(findings: Iterable[Finding]) -> str:
    """The finding kinds and counts, for a log line: no term, no sample, no value."""
    return ", ".join(f"{finding.kind}={finding.count}" for finding in findings)

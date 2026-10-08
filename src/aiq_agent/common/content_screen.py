"""The content screen: an office's terms and number detectors, found and masked in text. Pure.

One matcher for every place Piloti checks text against the office's „Sensible
Daten" policy (ADR-0085):

* the ingest job's content gate (``knowledge_layer.llamaindex.screening``) turns
  the spans into a quarantine verdict before the first model call;
* the chat socket (``aiq_api.chat_socket``) replaces them with a placeholder
  before the agent sees a message or its history keeps one.

The browser runs a TypeScript twin (``frontends/ui/src/lib/upload-screening/content-screen.ts``)
before a chat message leaves it. Both implementations read the ONE shared fixture,
``tests/fixtures/content_screen_cases.json`` at the repository root, so the same
text gives the same spans, the same masked text and the same findings on both
sides. The twins agree by construction rather than by luck: neither uses its
runtime's own idea of whitespace, case folding or digits, and the detectors are
the same small parsers on both sides, not two regex dialects.

It lives in ``aiq_agent.common`` because both Python consumers already import
from here, while importing anything under ``knowledge_layer.llamaindex`` loads
LlamaIndex and Chroma (five seconds) into a process that only wants a regex.

Characters
----------
* **Whitespace** is :data:`WHITESPACE`, Unicode's ``White_Space`` property,
  listed. Not ``str.isspace`` (which adds U+001C-U+001F) and not JavaScript's
  ``\\s`` (which adds U+FEFF and drops U+0085).
* **A word character** is a letter or a number (general category ``L*`` or ``N*``).
* **A digit** is any Unicode decimal digit (``Nd``), read as its value: a number
  typed in fullwidth or Arabic-Indic digits is still that number.

Term matching
-------------
Both sides are folded the same way: Unicode NFKC, the default lowercase mapping,
final sigma as sigma, then the German transliterations (ä→ae, ö→oe, ü→ue, ß→ss),
so ``Gehaltsübersicht``, ``GEHALTSÜBERSICHT`` and ``Gehaltsuebersicht`` are one term.
Lowercase, not ``casefold``: JavaScript has the first and not the second.
The fold runs per CLUSTER (a character and the combining marks after it), which
is what lets a span found in the folded text be mapped back to the characters
it came from, and makes a decomposed ``ü`` (some PDFs, some keyboards) fold like
the composed one.

A term matches at a WORD START and may run on: ``Honorar`` matches
``Honorarvereinbarung`` and ``Honorare``, because German builds its compounds by
appending. It does NOT match inside a word (``Ehrenhonorar``): a term whose first
character is preceded by a letter or digit in the ORIGINAL text is part of a
different word. A multi-word term matches across any run of whitespace, line
breaks included. A term's span runs to the end of the word it starts, so masking
``Honorar`` hides ``Honorarvereinbarung`` whole.

Detectors
---------
Only checksum-valid matches count, so a text full of order numbers is not
flagged for looking like one. The checksum is the precision gate; the shapes
around it are wide, because a number a person types is not printed by a bank:

* ``iban``: a registered country code (:data:`IBAN_LENGTHS`, which also fixes
  the length), in either case, two check digits, then the account, in groups of
  four or unbroken. A separator may stand after the country code and between
  groups: a run of whitespace (line breaks too) or one ``-`` or ``.``. Mod 97.
* ``at_svnr``: four digits, then the birth date DDMMYY, optionally separated
  from it (whitespace, ``-``, ``.`` or ``/``), optionally with the date's own
  parts separated. The check digit, the first digit and the date must hold.
* ``credit_card``: a run of digits joined by horizontal whitespace, ``-`` or
  ``.``, starting 2-6 (the major networks). The whole run is the candidate, so a
  number inside a longer run of numbers is not a card; a run that ends in a
  separate group of 3-4 digits (a security code) is a card when the rest is.
  Luhn.

What is reported never carries a matched value: a detector's ``sample`` is
MASKED (``AT61 •••• •••• •••• 3201``), because it is stored on a job status and
shown to people who may not see the value.

Masking
-------
:func:`mask_text` replaces every span with its placeholder (:data:`PLACEHOLDERS`).
Placeholders are protected: no term or detector match that overlaps one counts,
so masking a masked text is a no-op, even for an office whose list contains
„IBAN" or „Kartennummer". Masking repeats until nothing is left to mask, because
removing one number can expose another that its digits were hiding (a card
printed straight after an IBAN reads as part of its run).

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

_PLACEHOLDER_RE = re.compile("|".join(re.escape(placeholder) for placeholder in PLACEHOLDERS.values()))


# ------------------------------------------------------------------- characters

#: Unicode's ``White_Space`` property, all 25 code points. The one definition of
#: whitespace on both sides (the TypeScript twin lists the same, and its spec
#: holds the list to ``\p{White_Space}``).
WHITESPACE = (
    "\t\n\x0b\x0c\r \x85\xa0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)
_LINE_BREAKS = "\n\x0b\x0c\r\x85\u2028\u2029"
#: Whitespace that keeps a line: what may join the groups of a card number.
_HORIZONTAL_SPACE = "".join(char for char in WHITESPACE if char not in _LINE_BREAKS)
_SPACE_RUN = re.compile(f"[{WHITESPACE}]+")

_FOLD_TABLE = str.maketrans({"ς": "σ", "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})


def _is_mark(char: str) -> bool:
    return unicodedata.category(char)[0] == "M"


def _is_word_char(char: str) -> bool:
    """A letter or a number: general category ``L*`` or ``N*``."""
    return unicodedata.category(char)[0] in "LN"


def _word_char_at(text: str, index: int) -> bool:
    return 0 <= index < len(text) and _is_word_char(text[index])


def _digit_at(text: str, index: int) -> str | None:
    """The ASCII digit for a Unicode decimal digit (``Nd``) at ``index``, else ``None``."""
    if index >= len(text):
        return None
    value = unicodedata.decimal(text[index], None)
    return None if value is None else str(value)


def _skip_separator(text: str, index: int, marks: str) -> int:
    """``index`` moved past one separator: a run of whitespace, or one of ``marks``."""
    if index < len(text) and text[index] in WHITESPACE:
        while index < len(text) and text[index] in WHITESPACE:
            index += 1
    elif index < len(text) and text[index] in marks:
        index += 1
    return index


def _split_words(text: str) -> list[str]:
    return [word for word in _SPACE_RUN.split(text) if word]


# ------------------------------------------------------------------------- fold


def _clusters(text: str) -> Iterator[tuple[int, int]]:
    """``(start, end)`` of each character with the combining marks that follow it."""
    start = 0
    for index in range(1, len(text) + 1):
        if index == len(text) or not _is_mark(text[index]):
            yield start, index
            start = index


def _fold_cluster(cluster: str) -> str:
    return unicodedata.normalize("NFKC", cluster).lower().translate(_FOLD_TABLE)


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


def _term_words(term: str) -> tuple[str, ...]:
    return tuple(_split_words(fold(term)))


# ------------------------------------------------------------------------ rules


@dataclass(frozen=True)
class ScreeningRules:
    """The terms and detectors a text is screened against. Build with ``build`` or ``from_config``."""

    terms: tuple[str, ...] = ()
    detectors: tuple[str, ...] = ()
    #: One per term, same order: the term's folded words, matched literally.
    patterns: tuple[tuple[str, ...], ...] = field(default=(), repr=False, compare=False)

    @classmethod
    def build(cls, terms: Iterable[str], detectors: Iterable[str]) -> ScreeningRules | None:
        """Rules from already-typed values, normalised; ``None`` when nothing is left to check."""
        kept_terms = _normalised_terms(terms)
        wanted = set(detectors)
        kept_detectors = tuple(name for name in DETECTORS if name in wanted)
        if not kept_terms and not kept_detectors:
            return None
        patterns = tuple(_term_words(term) for term in kept_terms)
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
        stripped = " ".join(_split_words(term))
        if MIN_TERM_CHARS <= len(stripped) <= MAX_TERM_CHARS:
            kept.setdefault(fold(stripped), stripped)
    return tuple(kept.values())[:MAX_TERMS]


# --------------------------------------------------------------------- detectors

#: Every country that issues IBANs, and the one length its IBANs have: the SWIFT
#: IBAN registry, plus the countries that issue IBANs outside it (French
#: territories, several African states), as ``schwifty`` 2026.7.3 lists them. A
#: country not listed here issues no IBAN, so a candidate from it is not one.
#: The TypeScript twin and the shared fixture hold the same table.
IBAN_LENGTHS: dict[str, int] = {
    "AD": 24, "AE": 23, "AL": 28, "AO": 25, "AT": 20, "AX": 18, "AZ": 28, "BA": 20, "BE": 16, "BF": 28,
    "BG": 22, "BH": 22, "BI": 27, "BJ": 28, "BL": 27, "BR": 29, "BY": 28, "CF": 27, "CG": 27, "CH": 21,
    "CI": 28, "CM": 27, "CR": 22, "CV": 25, "CY": 28, "CZ": 24, "DE": 22, "DJ": 27, "DK": 18, "DO": 28,
    "DZ": 26, "EE": 20, "EG": 29, "ES": 24, "FI": 18, "FK": 18, "FO": 18, "FR": 27, "GA": 27, "GB": 22,
    "GE": 22, "GF": 27, "GG": 22, "GI": 23, "GL": 18, "GP": 27, "GQ": 27, "GR": 27, "GT": 28, "GW": 25,
    "HN": 28, "HR": 21, "HU": 28, "IE": 22, "IL": 23, "IM": 22, "IQ": 23, "IR": 26, "IS": 26, "IT": 27,
    "JE": 22, "JO": 30, "KM": 27, "KW": 30, "KZ": 20, "LB": 28, "LC": 32, "LI": 21, "LT": 20, "LU": 20,
    "LV": 21, "LY": 25, "MA": 28, "MC": 27, "MD": 24, "ME": 22, "MF": 27, "MG": 27, "MK": 19, "ML": 28,
    "MN": 20, "MQ": 27, "MR": 27, "MT": 31, "MU": 30, "MZ": 25, "NC": 27, "NE": 28, "NI": 28, "NL": 18,
    "NO": 15, "OM": 23, "PF": 27, "PK": 24, "PL": 28, "PM": 27, "PS": 29, "PT": 25, "QA": 29, "RE": 27,
    "RO": 24, "RS": 22, "RU": 33, "SA": 24, "SC": 31, "SD": 18, "SE": 24, "SI": 19, "SK": 24, "SM": 27,
    "SN": 28, "SO": 23, "ST": 25, "SV": 28, "TD": 27, "TF": 27, "TG": 28, "TL": 23, "TN": 24, "TR": 26,
    "UA": 29, "VA": 22, "VG": 24, "WF": 27, "XK": 20, "YE": 30, "YT": 27,
}  # fmt: skip

#: Where an IBAN may start: two ASCII letters at a word start. The parse is :func:`_iban_at`.
_IBAN_START = re.compile(r"(?<![^\W_])[A-Za-z]{2}")
#: Where a social-security number may start: a digit at a word start.
_SVNR_START = re.compile(r"(?<![^\W_])\d")
_SVNR_WEIGHTS = (3, 7, 9, 0, 5, 8, 4, 2, 1, 6)
_SVNR_MARKS = "-./"
#: A maximal run of digits joined by horizontal whitespace, ``-`` or ``.``: a card candidate.
_CARD_RUN = re.compile(rf"\d(?:(?:[{_HORIZONTAL_SPACE}]+|[-.])?\d)*")
_DIGIT_GROUP = re.compile(r"\d+")


def valid_iban(compact: str) -> bool:
    """ISO 13616: a registered country, its registered length, and mod 97 == 1. Pure."""
    if IBAN_LENGTHS.get(compact[:2]) != len(compact) or not (compact.isascii() and compact.isalnum()):
        return False
    rearranged = compact[4:] + compact[:4]
    digits = "".join(str(int(char, 36)) for char in rearranged)
    return int(digits) % 97 == 1


def _iban_at(text: str, start: int) -> tuple[str, int] | None:
    """The IBAN printed at ``start``: its compact form and where it ends; ``None`` when there is none.

    The country fixes the length, so the parse reads exactly that many
    characters and stops: what follows (``EUR``, a card number, the next IBAN)
    is never part of it. A separator may stand after the country code and
    before each group of four.
    """
    country = text[start : start + 2].upper()
    length = IBAN_LENGTHS.get(country)
    if length is None:
        return None
    chars = [country]
    index = start + 2
    for position in range(2, length):
        if position == 2 or position % 4 == 0:
            index = _skip_separator(text, index, "-.")
        char = _iban_char(text, index, digits_only=position < 4)
        if char is None:
            return None
        chars.append(char)
        index += 1
    compact = "".join(chars)
    if _word_char_at(text, index) or not valid_iban(compact):
        return None
    return compact, index


def _iban_char(text: str, index: int, *, digits_only: bool) -> str | None:
    """The IBAN character at ``index``: a digit as ASCII, or (past the check digits) an ASCII letter upper-cased."""
    digit = _digit_at(text, index)
    if digit is not None or digits_only or index >= len(text):
        return digit
    char = text[index]
    return char.upper() if char.isascii() and char.isalpha() else None


def mask_iban(compact: str) -> str:
    """Country and check digits, then masked groups, then the last four."""
    hidden = math.ceil(max(len(compact) - 8, 0) / 4)
    return " ".join([compact[:4], *([MASK] * hidden), compact[-4:]])


def valid_at_svnr(digits: str) -> bool:
    """An Austrian social-security number: check digit, first digit, birth day and month. Pure.

    The check digit (4th) is the weighted sum of the other nine mod 11; a sum
    giving 10 is never issued. Months 13-15 stand for an unknown birth month.
    """
    if len(digits) != 10 or not digits.isascii() or not digits.isdigit() or digits[0] == "0":
        return False
    check = sum(int(d) * w for d, w in zip(digits, _SVNR_WEIGHTS, strict=True)) % 11
    if check == 10 or check != int(digits[3]):
        return False
    day, month = int(digits[4:6]), int(digits[6:8])
    return 1 <= day <= 31 and 1 <= month <= 15


def _digits_at(text: str, index: int, count: int) -> str | None:
    """``count`` digits from ``index`` on, as ASCII; ``None`` unless every one is a digit."""
    digits = ""
    for offset in range(count):
        digit = _digit_at(text, index + offset)
        if digit is None:
            return None
        digits += digit
    return digits


def _svnr_at(text: str, start: int) -> tuple[str, int] | None:
    """The social-security number printed at ``start``: its ten digits and where it ends.

    ``SSSS DDMMYY``, with or without a separator after the serial; the date's
    own parts are either all joined (``010180``) or all separated (``01 01 80``,
    ``01.01.80``).
    """
    day_at = _skip_separator(text, start + 4, _SVNR_MARKS)
    month_at = _skip_separator(text, day_at + 2, _SVNR_MARKS)
    split = month_at != day_at + 2
    year_at = _skip_separator(text, month_at + 2, _SVNR_MARKS) if split else month_at + 2
    end = year_at + 2
    parts = [_digits_at(text, start, 4), _digits_at(text, day_at, 2), _digits_at(text, month_at, 2)]
    parts.append(_digits_at(text, year_at, 2))
    if (split and year_at == month_at + 2) or any(part is None for part in parts) or _word_char_at(text, end):
        return None
    digits = "".join(part or "" for part in parts)
    return (digits, end) if valid_at_svnr(digits) else None


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


def _card_in(run: str) -> tuple[str, int] | None:
    """The card a run of digits is, or starts with when a security code ends it: digits and printed length."""
    matches = list(_DIGIT_GROUP.finditer(run))
    groups = [_digits_at(run, match.start(), len(match.group())) or "" for match in matches]
    digits = "".join(groups)
    if valid_card(digits):
        return digits, len(run)
    code = len(groups[-1])
    if len(groups) >= 2 and 3 <= code <= 4 and valid_card(digits[:-code]):
        return digits[:-code], matches[-2].end()
    return None


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
    """Every IBAN, in one pass: each start is parsed on its own, and the scan resumes after a match."""
    resume = 0
    for match in _IBAN_START.finditer(text):
        if match.start() < resume:
            continue
        found = _iban_at(text, match.start())
        if found is not None:
            compact, resume = found
            yield Span("iban", match.start(), resume, sample=mask_iban(compact))


def _svnr_spans(text: str) -> Iterator[Span]:
    resume = 0
    for match in _SVNR_START.finditer(text):
        if match.start() < resume:
            continue
        found = _svnr_at(text, match.start())
        if found is not None:
            digits, resume = found
            yield Span("at_svnr", match.start(), resume, sample=mask_at_svnr(digits))


def _card_spans(text: str) -> Iterator[Span]:
    for match in _CARD_RUN.finditer(text):
        start, end = match.span()
        if _word_char_at(text, start - 1) or _word_char_at(text, end):
            continue
        found = _card_in(match.group(0))
        if found is not None:
            digits, printed = found
            yield Span("credit_card", start, start + printed, sample=mask_card(digits))


_DETECTOR_SPANS = {"iban": _iban_spans, "at_svnr": _svnr_spans, "credit_card": _card_spans}


def _word_end(text: str, end: int) -> int:
    """``end`` moved over the rest of the word it is in: letters, digits and their combining marks."""
    while end < len(text) and unicodedata.category(text[end])[0] in "LNM":
        end += 1
    return end


def _starts_a_word(folded: _Folded, text: str, index: int) -> bool:
    """Whether folded ``index`` begins a cluster that no letter or digit precedes in the original text."""
    if index == 0:
        return True
    previous = folded.starts[index - 1]
    return previous != folded.starts[index] and not _is_word_char(text[previous])


def _words_end(folded: str, start: int, words: tuple[str, ...]) -> int:
    """Where ``words`` end when they stand at ``start`` with whitespace between them; -1 when they do not."""
    cursor = start
    for position, word in enumerate(words):
        gap = cursor
        while position and cursor < len(folded) and folded[cursor] in WHITESPACE:
            cursor += 1
        if (position and cursor == gap) or not folded.startswith(word, cursor):
            return -1
        cursor += len(word)
    return cursor


def _term_matches(folded: _Folded, text: str, words: tuple[str, ...]) -> Iterator[tuple[int, int]]:
    """``(start, end)`` in the folded text of each match of a term, leftmost first and not overlapping."""
    if not words:
        return
    index = folded.text.find(words[0])
    while index != -1:
        end = _words_end(folded.text, index, words) if _starts_a_word(folded, text, index) else -1
        if end > index:
            yield index, end
            index = folded.text.find(words[0], end)
        else:
            index = folded.text.find(words[0], index + 1)


def _term_spans(text: str, rules: ScreeningRules) -> Iterator[Span]:
    folded = _fold_mapped(text)
    for term, words in zip(rules.terms, rules.patterns, strict=True):
        for match_start, match_end in _term_matches(folded, text, words):
            start = folded.starts[match_start]
            end = _word_end(text, folded.ends[match_end - 1])
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
    is itself with no findings, because the loop runs until a pass finds
    nothing; there is no pass limit that could leave a match behind. It ends:
    every pass replaces at least one character outside a placeholder with a
    placeholder, placeholders never overlap (each is bracketed and holds no
    bracket), so the characters outside them strictly decrease.
    """
    if rules is None or not text:
        return MaskedText(text)
    found: list[Span] = []
    current = text
    spans = find_spans(current, rules)
    while spans:
        found.extend(spans)
        current = _replaced(current, spans)
        spans = find_spans(current, rules)
    return MaskedText(current, _findings(found, rules))


def findings_summary(findings: Iterable[Finding]) -> str:
    """The finding kinds and counts, for a log line: no term, no sample, no value."""
    return ", ".join(f"{finding.kind}={finding.count}" for finding in findings)

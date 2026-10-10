"""The content screen: spans, the mask, and the fixture the browser's twin reads too.

``tests/fixtures/content_screen_cases.json`` is the contract between
``aiq_agent.common.content_screen`` and ``frontends/ui/src/lib/upload-screening/content-screen.ts``:
both read that one file, run every case and must produce the same matches, the
same masked text and the same findings. It also holds the character tables both
twins must agree on (whitespace, decimal digits, letter/number/mark classes, the
fold of every code point, the IBAN registry); each side checks its own against
them, so the two agree on every code point, not only on the cases listed.

The unit tests below pin the properties a case list cannot state on its own:
masking is a fixpoint for any input, nothing reported carries a value, and the
placeholders are protected.
"""

from __future__ import annotations

import hashlib
import json
import random
import unicodedata
from pathlib import Path

import pytest

from aiq_agent.common.content_screen import DETECTORS
from aiq_agent.common.content_screen import DETECTORS_ONLY
from aiq_agent.common.content_screen import IBAN_LENGTHS
from aiq_agent.common.content_screen import PLACEHOLDERS
from aiq_agent.common.content_screen import WHITESPACE
from aiq_agent.common.content_screen import ScreeningRules
from aiq_agent.common.content_screen import find_spans
from aiq_agent.common.content_screen import findings_summary
from aiq_agent.common.content_screen import fold
from aiq_agent.common.content_screen import mask_text

REPO = Path(__file__).resolve().parents[3]
FIXTURE_PATH = REPO / "tests" / "fixtures" / "content_screen_cases.json"

_IBAN_AT = "AT61 1904 3002 3457 3201"


def _rules(terms=(), detectors=()) -> ScreeningRules:
    rules = ScreeningRules.build(terms, detectors)
    assert rules is not None
    return rules


def _fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _cases() -> list[dict]:
    return _fixture()["cases"]


# =============================================================================
# The shared fixture
# =============================================================================


def test_the_fixture_holds_the_placeholders_defined_here() -> None:
    assert _fixture()["placeholders"] == PLACEHOLDERS


def test_the_fixture_holds_the_iban_registry_defined_here() -> None:
    assert _fixture()["iban_lengths"] == IBAN_LENGTHS


@pytest.mark.parametrize("case", _cases(), ids=lambda case: case["name"])
def test_each_case_finds_and_masks_what_the_fixture_says(case: dict) -> None:
    rules = ScreeningRules.build(case["terms"], case["detectors"])
    text = case["text"]

    spans = find_spans(text, rules) if rules else []
    matches = [
        {"kind": s.kind, **({"term": s.term} if s.term is not None else {}), "text": text[s.start : s.end]}
        for s in spans
    ]
    masked = mask_text(text, rules)

    assert matches == case["matches"]
    assert masked.text == case["masked"]
    assert [finding.as_json() for finding in masked.findings] == case["findings"]
    again = mask_text(masked.text, rules)
    assert (again.text, again.findings) == (masked.text, ())


# =============================================================================
# The character tables both twins are held to
# =============================================================================

_ALL_CHARS = [chr(cp) for cp in range(0x110000) if not 0xD800 <= cp <= 0xDFFF]


def _unicode() -> dict:
    return _fixture()["unicode"]


def test_the_fixture_was_made_with_this_unicode_version() -> None:
    # A different version changes the tables below; regenerate them and check the TS spec on the same version.
    assert _unicode()["version"] == unicodedata.unidata_version


def test_whitespace_is_the_listed_white_space_property() -> None:
    assert [ord(char) for char in WHITESPACE] == _unicode()["whitespace"]
    assert len(WHITESPACE) == 25
    # str.isspace is White_Space plus the four information separators, which is why neither side uses it.
    assert {char for char in _ALL_CHARS if char.isspace()} - set(WHITESPACE) == {chr(c) for c in range(0x1C, 0x20)}


def test_every_decimal_digit_is_listed_by_its_zero() -> None:
    zeros = [ord(char) for char in _ALL_CHARS if unicodedata.decimal(char, None) == 0]
    assert zeros == _unicode()["decimal_zeros"]
    digits = {
        ord(char): unicodedata.decimal(char) for char in _ALL_CHARS if unicodedata.decimal(char, None) is not None
    }
    assert digits == {zero + value: value for zero in zeros for value in range(10)}


def _assigned_chars() -> list[str]:
    """The code points the fixture's Unicode version assigns: the ones the TS twin is compared on.

    A newer runtime (CI's Node follows the latest 22.x) adds characters; Unicode's
    stability policy keeps the class and case mapping of the assigned ones, so
    the tables compare over these.
    """
    return [chr(cp) for start, end in _unicode()["assigned_ranges"] for cp in range(start, end + 1)]


def test_the_assigned_ranges_are_this_versions() -> None:
    assert [ord(char) for char in _assigned_chars()] == [
        ord(char) for char in _ALL_CHARS if unicodedata.category(char) != "Cn"
    ]


def test_the_character_classes_are_the_fixtures() -> None:
    classes = "".join(c if (c := unicodedata.category(char)[0]) in "LNM" else "-" for char in _assigned_chars())
    assert hashlib.sha256(classes.encode()).hexdigest() == _unicode()["classes_sha256"]


def test_the_fold_of_every_assigned_code_point_is_the_fixtures() -> None:
    folded = "\n".join(fold(char) for char in _assigned_chars())
    assert hashlib.sha256(folded.encode()).hexdigest() == _unicode()["fold_sha256"]


# =============================================================================
# Properties
# =============================================================================


def test_no_rules_mask_nothing() -> None:
    assert mask_text(f"IBAN {_IBAN_AT}", None).text == f"IBAN {_IBAN_AT}"
    assert not mask_text(f"IBAN {_IBAN_AT}", None).masked


def test_detectors_only_is_every_detector_and_no_term() -> None:
    assert DETECTORS_ONLY.detectors == DETECTORS
    assert DETECTORS_ONLY.terms == ()
    text = f"Gehaltsabrechnung, IBAN {_IBAN_AT}, SVNR 1237 010180, Karte 4111 1111 1111 1111"
    masked = mask_text(text, DETECTORS_ONLY)
    assert masked.text == (
        "Gehaltsabrechnung, IBAN [IBAN entfernt], SVNR [SV-Nummer entfernt], Karte [Kartennummer entfernt]"
    )


@pytest.mark.parametrize(
    "text",
    [
        f"IBAN {_IBAN_AT}, SVNR 1237 010180, Karte 4111 1111 1111 1111",
        f"{_IBAN_AT} 4111 1111 1111 1111",
        "Honorarvereinbarung und Gehaltsübersicht",
        "[IBAN entfernt] [Begriff entfernt]",
    ],
)
def test_masking_a_masked_text_is_a_no_op(text: str) -> None:
    rules = _rules(["Honorar", "Gehalt", "IBAN", "Begriff", "entfernt"], DETECTORS)
    once = mask_text(text, rules)
    twice = mask_text(once.text, rules)
    assert twice.text == once.text
    assert twice.findings == ()


def test_no_placeholder_matches_any_rule() -> None:
    every_word = [word.strip("[]") for placeholder in PLACEHOLDERS.values() for word in placeholder.split()]
    rules = _rules(every_word, DETECTORS)
    for placeholder in PLACEHOLDERS.values():
        assert find_spans(f"vorher {placeholder} nachher", rules) == []


def test_findings_never_carry_a_matched_value() -> None:
    text = f"IBAN {_IBAN_AT}, SVNR 1237 010180, Karte 4111 1111 1111 1111"
    masked = mask_text(text, DETECTORS_ONLY)
    reported = json.dumps([finding.as_json() for finding in masked.findings], ensure_ascii=False)
    for value in (_IBAN_AT, "AT611904300234573201", "1237 010180", "1237010180", "4111 1111 1111 1111"):
        assert value not in reported
        assert value not in masked.text
    assert findings_summary(masked.findings) == "iban=1, at_svnr=1, credit_card=1"


def test_the_fold_is_per_character_and_agrees_with_composed_text() -> None:
    assert fold("Gehaltsübersicht") == fold("Gehaltsübersicht") == "gehaltsuebersicht"
    assert fold("STRASSE") == fold("Straße") == "strasse"


def test_final_sigma_folds_as_sigma() -> None:
    assert fold("ΟΔΟΣ") == fold("οδος") == "οδοσ"


# =============================================================================
# Every match in one pass, and masking is a fixpoint for any input
# =============================================================================

_IBANS = ["AT611904300234573201", "DE89370400440532013000", "GB29NWBK60161331926819", "CH9300762011623852957"]
_CARDS = ["4111111111111111", "5555555555554444", "378282246310005"]
_SEPARATORS = [" ", "  ", "\t", "\n", "-", ".", "\u00a0", "\u202f", ""]


def _grouped(compact: str, separator: str) -> str:
    return separator.join(compact[i : i + 4] for i in range(0, len(compact), 4))


def test_fifty_ibans_in_a_row_are_found_in_one_pass() -> None:
    text = " ".join([_IBAN_AT] * 50)
    rules = _rules(detectors=["iban"])
    assert len(find_spans(text, rules)) == 50
    assert mask_text(text, rules).text == " ".join([PLACEHOLDERS["iban"]] * 50)


def test_fifty_ibans_each_followed_by_a_card_leave_no_number() -> None:
    text = " ".join(f"{_grouped(_IBANS[i % 4], ' ')} {_grouped(_CARDS[i % 3], ' ')}" for i in range(50))
    masked = mask_text(text, DETECTORS_ONLY)
    assert not any(char.isdigit() for char in masked.text)
    assert [(f.kind, f.count) for f in masked.findings] == [("iban", 50), ("credit_card", 50)]


def _generated(rng: random.Random) -> str:
    """A text of numbers, near-numbers, terms, placeholders and noise, glued by any separator."""
    blocks = [
        lambda: _grouped(rng.choice(_IBANS), rng.choice(_SEPARATORS)),
        lambda: rng.choice(_IBANS).lower(),
        lambda: " ".join([_grouped(rng.choice(_IBANS), " ")] * rng.randint(2, 12)),  # one IBAN, printed again and again
        lambda: _grouped(rng.choice(_CARDS), rng.choice(_SEPARATORS)) + rng.choice(["", " 123", " 4567"]),
        lambda: "1237" + rng.choice(_SEPARATORS) + rng.choice(["010180", "01 01 80", "01.01.80"]),
        lambda: rng.choice(list(PLACEHOLDERS.values())),
        lambda: rng.choice(["Honorarvereinbarung", "Lohn\nSteuer", "IBAN", "entfernt", "ΟΔΟΣ", "ẗHonorar"]),
        lambda: "".join(rng.choice("0123456789 -.AT[]x\u0660\uff11") for _ in range(rng.randint(1, 12))),
    ]
    count = rng.choice([1, 3, 8, 50])
    return "".join(rng.choice(["", " ", "\n", ", ", "x"]) + rng.choice(blocks)() for _ in range(count))


@pytest.mark.parametrize("seed", range(300))
def test_masking_any_generated_text_twice_changes_nothing(seed: int) -> None:
    rules = _rules(["Honorar", "Lohn Steuer", "οδος", "IBAN", "entfernt"], DETECTORS)
    once = mask_text(_generated(random.Random(seed)), rules)
    twice = mask_text(once.text, rules)
    assert (twice.text, twice.findings) == (once.text, ())
    assert find_spans(once.text, rules) == []

"""The content screen: spans, the mask, and the fixture the browser's twin reads too.

``tests/fixtures/content_screen_cases.json`` is the contract between
``aiq_agent.common.content_screen`` and ``frontends/ui/src/lib/upload-screening/content-screen.ts``:
both read that one file, run every case and must produce the same matches, the
same masked text and the same findings. The unit tests below pin the properties a case list cannot
state on its own: masking is a fixpoint, nothing reported carries a value, and
the placeholders are protected.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aiq_agent.common.content_screen import DETECTORS
from aiq_agent.common.content_screen import DETECTORS_ONLY
from aiq_agent.common.content_screen import PLACEHOLDERS
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


def _cases() -> list[dict]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["cases"]


# =============================================================================
# The shared fixture
# =============================================================================


def test_the_fixture_holds_the_placeholders_defined_here() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert fixture["placeholders"] == PLACEHOLDERS


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

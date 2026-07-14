"""Tests for shallow-to-deep escalation marker detection and keyword matching."""

from aiq_agent.agents.chat_researcher.agent import ESCALATION_MARKER
from aiq_agent.agents.chat_researcher.agent import detect_and_strip_confidence_marker
from aiq_agent.agents.chat_researcher.agent import detect_and_strip_escalation_marker
from aiq_agent.agents.chat_researcher.agent import matches_escalation_keywords
from aiq_agent.agents.chat_researcher.agent import surface_answer_confidence


class TestDetectAndStripEscalationMarker:
    """Tests for detect_and_strip_escalation_marker."""

    def test_marker_on_own_final_line(self):
        content = "Here is my best partial answer.\n\n" + ESCALATION_MARKER
        stripped, present = detect_and_strip_escalation_marker(content)
        assert present is True
        assert ESCALATION_MARKER not in stripped
        assert stripped == "Here is my best partial answer."
        # No trailing blank lines left behind.
        assert not stripped.endswith("\n")

    def test_marker_mid_text(self):
        content = f"Partial answer {ESCALATION_MARKER} continues here."
        stripped, present = detect_and_strip_escalation_marker(content)
        assert present is True
        assert ESCALATION_MARKER not in stripped

    def test_marker_absent(self):
        content = "A perfectly adequate answer with references."
        stripped, present = detect_and_strip_escalation_marker(content)
        assert present is False
        assert stripped == content

    def test_marker_only(self):
        content = ESCALATION_MARKER
        stripped, present = detect_and_strip_escalation_marker(content)
        assert present is True
        assert stripped == ""

    def test_multiple_occurrences_removed(self):
        content = f"{ESCALATION_MARKER} answer body {ESCALATION_MARKER}\n{ESCALATION_MARKER}"
        stripped, present = detect_and_strip_escalation_marker(content)
        assert present is True
        assert ESCALATION_MARKER not in stripped

    def test_non_str_content_unchanged(self):
        content = [{"type": "text", "text": "structured content"}]
        stripped, present = detect_and_strip_escalation_marker(content)
        assert present is False
        assert stripped is content


class TestDetectAndStripConfidenceMarker:
    """Tests for detect_and_strip_confidence_marker."""

    def test_high_marker_on_own_final_line(self):
        content = "OIB-Richtlinie 2 regelt den Brandschutz [1].\n\n[CONFIDENCE:high]"
        stripped, level = detect_and_strip_confidence_marker(content)
        assert level == "high"
        assert "[CONFIDENCE" not in stripped
        assert stripped == "OIB-Richtlinie 2 regelt den Brandschutz [1]."
        assert not stripped.endswith("\n")

    def test_medium_and_low_values(self):
        for value in ("medium", "low"):
            stripped, level = detect_and_strip_confidence_marker(f"Answer.\n[CONFIDENCE:{value}]")
            assert level == value
            assert "[CONFIDENCE" not in stripped

    def test_case_insensitive_and_whitespace_tolerant(self):
        stripped, level = detect_and_strip_confidence_marker("Answer.\n[confidence: HIGH ]")
        assert level == "high"
        assert "[confidence" not in stripped.lower()

    def test_absent_marker(self):
        content = "A perfectly adequate answer with references [1]."
        stripped, level = detect_and_strip_confidence_marker(content)
        assert level is None
        assert stripped == content

    def test_malformed_value_stripped_but_no_signal(self):
        # Unknown value: never shown to the user, but yields no signal.
        content = "Answer.\n[CONFIDENCE:certain]"
        stripped, level = detect_and_strip_confidence_marker(content)
        assert level is None
        assert "[CONFIDENCE" not in stripped
        assert stripped == "Answer."

    def test_empty_value_stripped_but_no_signal(self):
        stripped, level = detect_and_strip_confidence_marker("Answer.\n[CONFIDENCE:]")
        assert level is None
        assert "[CONFIDENCE" not in stripped

    def test_last_valid_marker_wins(self):
        content = "Answer.\n[CONFIDENCE:low]\n[CONFIDENCE:high]"
        stripped, level = detect_and_strip_confidence_marker(content)
        assert level == "high"
        assert "[CONFIDENCE" not in stripped

    def test_combined_with_escalation_marker_any_order(self):
        # Both markers present, confidence before escalation (prompt-defined order).
        content = f"Partial answer.\n[CONFIDENCE:low]\n{ESCALATION_MARKER}"
        without_esc, esc_present = detect_and_strip_escalation_marker(content)
        assert esc_present is True
        stripped, level = detect_and_strip_confidence_marker(without_esc)
        assert level == "low"
        assert "[CONFIDENCE" not in stripped
        assert ESCALATION_MARKER not in stripped
        assert stripped == "Partial answer."

        # Reversed order — detection is order-insensitive.
        reversed_content = f"Partial answer.\n{ESCALATION_MARKER}\n[CONFIDENCE:high]"
        stripped2, level2 = detect_and_strip_confidence_marker(reversed_content)
        without_esc2, esc_present2 = detect_and_strip_escalation_marker(stripped2)
        assert esc_present2 is True
        assert level2 == "high"
        assert "[CONFIDENCE" not in without_esc2
        assert ESCALATION_MARKER not in without_esc2

    def test_non_str_content_unchanged(self):
        content = [{"type": "text", "text": "structured content"}]
        stripped, level = detect_and_strip_confidence_marker(content)
        assert level is None
        assert stripped is content


class TestSurfaceAnswerConfidence:
    """Tests for the deterministic overconfidence guard."""

    def test_none_self_report_surfaces_nothing(self):
        assert surface_answer_confidence(None, True) is None
        assert surface_answer_confidence(None, False) is None

    def test_grounded_answer_surfaces_verbatim(self):
        assert surface_answer_confidence("high", True) == "high"
        assert surface_answer_confidence("medium", True) == "medium"
        assert surface_answer_confidence("low", True) == "low"

    def test_ungrounded_answer_capped_to_low(self):
        assert surface_answer_confidence("high", False) == "low"
        assert surface_answer_confidence("medium", False) == "low"
        assert surface_answer_confidence("low", False) == "low"


class TestMatchesEscalationKeywords:
    """Tests for matches_escalation_keywords."""

    def test_english_phrase_hits(self):
        assert matches_escalation_keywords("Unfortunately I don't have enough information to answer.") is True

    def test_german_phrase_one_hits(self):
        assert matches_escalation_keywords("Es liegen nicht genügend Informationen vor.") is True

    def test_german_phrase_two_hits(self):
        assert matches_escalation_keywords("Weitere Recherche erforderlich, um dies zu klären.") is True

    def test_adequate_german_answer_no_hit(self):
        content = "Die OIB-Richtlinie 2 regelt den Brandschutz umfassend und eindeutig."
        assert matches_escalation_keywords(content) is False

    def test_keyword_before_last_800_chars_no_hit(self):
        # Keyword placed well before the last 800 characters is not matched.
        content = "unable to find" + ("x" * 900)
        assert matches_escalation_keywords(content) is False

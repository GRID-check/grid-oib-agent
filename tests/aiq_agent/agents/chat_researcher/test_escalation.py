"""Tests for shallow-to-deep escalation marker detection and keyword matching."""

from aiq_agent.agents.chat_researcher.agent import ESCALATION_MARKER
from aiq_agent.agents.chat_researcher.agent import detect_and_strip_escalation_marker
from aiq_agent.agents.chat_researcher.agent import matches_escalation_keywords


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

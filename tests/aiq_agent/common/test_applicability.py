"""Tests for the hand-written OIB applicability module."""

from aiq_agent.common.applicability import OibVerdict
from aiq_agent.common.applicability import facts_from_project_context
from aiq_agent.common.applicability import render_project_block
from aiq_agent.common.applicability import resolve_oib_applicability
from aiq_agent.common.applicability import trigger_hints


def _by_code(facts: dict) -> dict[str, OibVerdict]:
    return {verdict.code: verdict for verdict in resolve_oib_applicability(facts)}


class TestResolveOibApplicability:
    def test_empty_facts_return_generic_six_all_required(self):
        verdicts = resolve_oib_applicability({})
        assert [v.code for v in verdicts] == ["OIB 1", "OIB 2", "OIB 3", "OIB 4", "OIB 5", "OIB 6"]
        assert all(v.verdict == "required" for v in verdicts)

    def test_oib_1_2_3_always_required(self):
        for code in ("OIB 1", "OIB 2", "OIB 3"):
            assert _by_code({"hauptnutzung": "wohnen"})[code].verdict == "required"

    def test_gk5_undefined_fluchtniveau_flags_2_3_check(self):
        verdicts = _by_code({"hauptnutzung": "wohnen", "gebaeudeklasse": "GK5"})
        assert verdicts["OIB 2.3"].verdict == "check"
        assert "22 m" in verdicts["OIB 2.3"].reason_de

    def test_fluchtniveau_over_22m_makes_2_3_required_hochhaus(self):
        verdicts = _by_code({"hauptnutzung": "wohnen", "gebaeudeklasse": "GK5", "fluchtniveau": ">22m"})
        assert verdicts["OIB 2.3"].verdict == "required"
        assert "Hochhaus" in verdicts["OIB 2.3"].reason_de

    def test_low_rise_residential_omits_fire_substandards_and_oib5_required(self):
        verdicts = _by_code({"hauptnutzung": "wohnen", "gebaeudeklasse": "GK2", "fluchtniveau": "<=7m"})
        assert "OIB 2.1" not in verdicts
        assert "OIB 2.2" not in verdicts
        assert "OIB 2.3" not in verdicts
        assert verdicts["OIB 5"].verdict == "required"

    def test_lager_makes_2_1_required_and_6_check(self):
        verdicts = _by_code({"hauptnutzung": "lager", "geschosse_unterirdisch": 2})
        assert verdicts["OIB 2.1"].verdict == "required"
        assert verdicts["OIB 2.2"].verdict == "check"  # basement -> garage check
        assert verdicts["OIB 6"].verdict == "check"

    def test_undefined_use_makes_2_1_check(self):
        verdicts = _by_code({"gebaeudeklasse": "GK3"})
        assert verdicts["OIB 2.1"].verdict == "check"

    def test_non_betriebsbau_use_omits_2_1(self):
        verdicts = _by_code({"hauptnutzung": "wohnen"})
        assert "OIB 2.1" not in verdicts

    def test_public_use_gets_stronger_oib4_reason(self):
        verdicts = _by_code({"hauptnutzung": "versammlung"})
        assert verdicts["OIB 4"].verdict == "required"
        assert "öffentlich" in verdicts["OIB 4"].reason_de

    def test_non_noise_sensitive_use_makes_oib5_likely(self):
        verdicts = _by_code({"hauptnutzung": "produzierend"})
        assert verdicts["OIB 5"].verdict == "likely"

    def test_verdict_carries_both_languages(self):
        verdicts = _by_code({"hauptnutzung": "lager"})
        assert verdicts["OIB 2.1"].reason_en == "Manufacturing/storage use is a Betriebsbau."


class TestTriggerHints:
    def test_no_hints_when_no_triggers(self):
        assert trigger_hints({"hauptnutzung": "wohnen"}) == []

    def test_boolean_true_triggers_hint(self):
        hints = trigger_hints({"denkmalschutz": True})
        assert len(hints) == 1
        assert "DMSG" in hints[0]

    def test_string_true_triggers_hint(self):
        assert trigger_hints({"stellplatz_relevant": "true"}) == [
            "Stellplatzverpflichtung: Wiener Garagengesetz (bzw. Landesrecht) prüfen."
        ]

    def test_false_does_not_trigger(self):
        assert trigger_hints({"kleingartengebiet": False, "betriebsanlage": "false"}) == []

    def test_all_four_triggers_in_definition_order(self):
        facts = {
            "stellplatz_relevant": True,
            "kleingartengebiet": True,
            "betriebsanlage": True,
            "denkmalschutz": True,
        }
        hints = trigger_hints(facts)
        assert len(hints) == 4
        assert hints[0].startswith("Kleingartengebiet")
        assert hints[1].startswith("Denkmalschutz")
        assert hints[2].startswith("Betriebsanlage")
        assert hints[3].startswith("Stellplatzverpflichtung")


class TestFactsFromProjectContext:
    def test_parses_confirmed_facts(self):
        text = (
            "PROJECT_CONTEXT v1\n"
            "confirmed:\n"
            "- bundesland=wien\n"
            "- hauptnutzung=wohnen\n"
            "- geschosse_unterirdisch=2\n"
            "goals:\n"
            "- build a house\n"
            "unknown:\n"
            "- fluchtniveau\n"
        )
        facts = facts_from_project_context(text)
        assert facts == {"bundesland": "wien", "hauptnutzung": "wohnen", "geschosse_unterirdisch": 2}

    def test_coerces_booleans(self):
        text = "PROJECT_CONTEXT v1\nconfirmed:\n- stellplatz_relevant=true\n- denkmalschutz=false\n"
        facts = facts_from_project_context(text)
        assert facts == {"stellplatz_relevant": True, "denkmalschutz": False}
        assert facts["stellplatz_relevant"] is True
        assert facts["denkmalschutz"] is False

    def test_ignores_non_confirmed_sections(self):
        text = "PROJECT_CONTEXT v1\ngoals:\n- hauptnutzung=wohnen\n"
        assert facts_from_project_context(text) == {}

    def test_handles_quoted_values(self):
        text = 'PROJECT_CONTEXT v1\nconfirmed:\n- standort_details="Am Hang, 1230 Wien"\n'
        assert facts_from_project_context(text) == {"standort_details": "Am Hang, 1230 Wien"}

    def test_empty_text(self):
        assert facts_from_project_context("") == {}


class TestRenderProjectBlock:
    def test_none_when_facts_empty(self):
        assert render_project_block("") is None
        assert render_project_block("PROJECT_CONTEXT v1\ngoals:\n- x\n") is None

    def test_renders_section_with_verdicts_and_reasons(self):
        context = "PROJECT_CONTEXT v1\nconfirmed:\n- hauptnutzung=lager\n"
        block = render_project_block(context)
        assert block is not None
        assert "### Für dieses Projekt voraussichtlich einschlägig" in block
        assert "OIB 1 — verbindlich —" in block
        assert "OIB 2.1 — verbindlich —" in block
        assert "OIB 6 — zu prüfen —" in block

    def test_appends_trigger_hints(self):
        context = "PROJECT_CONTEXT v1\nconfirmed:\n- hauptnutzung=wohnen\n- denkmalschutz=true\n"
        block = render_project_block(context)
        assert block is not None
        assert "Denkmalschutz:" in block

    def test_no_trigger_lines_when_no_triggers(self):
        context = "PROJECT_CONTEXT v1\nconfirmed:\n- hauptnutzung=wohnen\n"
        block = render_project_block(context)
        assert block is not None
        assert "Denkmalschutz" not in block
        assert "Kleingartengebiet" not in block

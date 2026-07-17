"""Tests for the registry applicability engine (norm-registry Phase 4)."""

from aiq_agent.common.applicability import ApplicabilityVerdict
from aiq_agent.common.applicability import evaluate_condition
from aiq_agent.common.applicability import evaluate_when
from aiq_agent.common.applicability import facts_from_project_context
from aiq_agent.common.applicability import resolve_applicability
from aiq_agent.common.norm_registry import ApplicabilityCondition
from aiq_agent.common.norm_registry import ApplicabilityRule
from aiq_agent.common.norm_registry import ApplicabilityWhen
from aiq_agent.common.norm_registry import Edition
from aiq_agent.common.norm_registry import EditionSource
from aiq_agent.common.norm_registry import Jurisdiction
from aiq_agent.common.norm_registry import NormEntry
from aiq_agent.common.norm_registry import NormRegistry


def _cond(fact, op, value=None):
    return ApplicabilityCondition(fact=fact, op=op, value=value)


class TestEvaluateCondition:
    def test_eq_string(self):
        assert evaluate_condition(_cond("hauptnutzung", "eq", "wohnen"), {"hauptnutzung": "wohnen"}) is True
        assert evaluate_condition(_cond("hauptnutzung", "eq", "wohnen"), {"hauptnutzung": "buero"}) is False

    def test_eq_numeric_aware(self):
        assert evaluate_condition(_cond("gebaeudeklasse", "eq", 5), {"gebaeudeklasse": 5}) is True
        assert evaluate_condition(_cond("gebaeudeklasse", "eq", 5), {"gebaeudeklasse": "5"}) is True

    def test_eq_boolean_cross_representation(self):
        cond = _cond("kleingartengebiet", "eq", True)
        assert evaluate_condition(cond, {"kleingartengebiet": True}) is True
        assert evaluate_condition(cond, {"kleingartengebiet": "true"}) is True
        assert evaluate_condition(cond, {"kleingartengebiet": False}) is False
        assert evaluate_condition(cond, {"kleingartengebiet": "false"}) is False
        assert evaluate_condition(cond, {}) is False

    def test_in(self):
        cond = _cond("hauptnutzung", "in", ["produzierend", "lager"])
        assert evaluate_condition(cond, {"hauptnutzung": "lager"}) is True
        assert evaluate_condition(cond, {"hauptnutzung": "wohnen"}) is False
        assert evaluate_condition(cond, {}) is False

    def test_defined_undefined(self):
        assert evaluate_condition(_cond("x", "defined"), {"x": 0}) is True
        assert evaluate_condition(_cond("x", "defined"), {"x": ""}) is False
        assert evaluate_condition(_cond("x", "undefined"), {}) is True
        assert evaluate_condition(_cond("x", "undefined"), {"x": "y"}) is False

    def test_numeric_comparisons(self):
        assert evaluate_condition(_cond("geschosse_unterirdisch", "gte", 1), {"geschosse_unterirdisch": 2}) is True
        assert evaluate_condition(_cond("geschosse_unterirdisch", "gte", 1), {"geschosse_unterirdisch": 0}) is False
        assert evaluate_condition(_cond("fluchtniveau", "gt", 22), {"fluchtniveau": 25}) is True
        assert evaluate_condition(_cond("fluchtniveau", "lt", 5), {"fluchtniveau": 5}) is False
        assert evaluate_condition(_cond("fluchtniveau", "lte", 5), {"fluchtniveau": 5}) is True

    def test_numeric_comparison_with_non_numeric_fact_is_false(self):
        assert evaluate_condition(_cond("fluchtniveau", "gt", 22), {"fluchtniveau": "hoch"}) is False
        assert evaluate_condition(_cond("fluchtniveau", "gt", 22), {}) is False


class TestEvaluateWhen:
    def test_empty_when_matches(self):
        assert evaluate_when(ApplicabilityWhen(), {}) is True
        assert evaluate_when(None, {}) is True

    def test_all_must_pass(self):
        when = ApplicabilityWhen(all=[_cond("a", "defined"), _cond("b", "eq", 1)])
        assert evaluate_when(when, {"a": 1, "b": 1}) is True
        assert evaluate_when(when, {"a": 1}) is False

    def test_any_one_passes(self):
        when = ApplicabilityWhen(any=[_cond("a", "eq", 1), _cond("b", "eq", 2)])
        assert evaluate_when(when, {"b": 2}) is True
        assert evaluate_when(when, {}) is False

    def test_all_and_any_combined(self):
        when = ApplicabilityWhen(all=[_cond("a", "defined")], any=[_cond("b", "eq", 1), _cond("c", "eq", 2)])
        assert evaluate_when(when, {"a": 1, "c": 2}) is True
        assert evaluate_when(when, {"a": 1}) is False
        assert evaluate_when(when, {"c": 2}) is False


class TestResolveApplicability:
    def _registry(self) -> NormRegistry:
        entry = NormEntry(
            id="oib-rl-2",
            title="Brandschutz",
            short="OIB-RL 2",
            rank="oib_richtlinie",
            role="normativ",
            jurisdiction=Jurisdiction(country="at"),
            editions=[
                Edition(id="2023-05", label="Ausgabe Mai 2023", source=EditionSource(kind="corpus", file="f.pdf"))
            ],
            applicability=[
                ApplicabilityRule(
                    when=ApplicabilityWhen(all=[_cond("hauptnutzung", "in", ["produzierend", "lager"])]),
                    verdict="required",
                    reason_de="Pflicht bei dieser Nutzung.",
                    reason_en="Required for this use.",
                ),
                ApplicabilityRule(
                    when=ApplicabilityWhen(all=[_cond("hauptnutzung", "defined")]),
                    verdict="check",
                    reason_de="Prüfen.",
                    reason_en="Check.",
                ),
            ],
        )
        no_rules = NormEntry(
            id="bo-wien",
            title="Bauordnung für Wien",
            short="BauO Wien",
            rank="landesgesetz",
            role="normativ",
            jurisdiction=Jurisdiction(country="at", state="wien"),
            editions=[],
        )
        return NormRegistry(entries=[entry, no_rules])

    def test_first_match_wins(self):
        verdicts = resolve_applicability(self._registry(), {"hauptnutzung": "lager"})
        assert verdicts["oib-rl-2"].verdict == "required"
        assert verdicts["oib-rl-2"].reason_de == "Pflicht bei dieser Nutzung."

    def test_falls_through_to_second_rule(self):
        verdicts = resolve_applicability(self._registry(), {"hauptnutzung": "wohnen"})
        assert verdicts["oib-rl-2"].verdict == "check"

    def test_no_match_omits_entry(self):
        verdicts = resolve_applicability(self._registry(), {})
        assert "oib-rl-2" not in verdicts

    def test_entry_without_rules_is_omitted(self):
        verdicts = resolve_applicability(self._registry(), {"hauptnutzung": "lager"})
        assert "bo-wien" not in verdicts

    def test_verdict_type(self):
        verdicts = resolve_applicability(self._registry(), {"hauptnutzung": "lager"})
        assert isinstance(verdicts["oib-rl-2"], ApplicabilityVerdict)
        assert verdicts["oib-rl-2"].norm_id == "oib-rl-2"
        assert verdicts["oib-rl-2"].reason_en == "Required for this use."


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

    def test_ignores_non_confirmed_sections(self):
        text = "PROJECT_CONTEXT v1\ngoals:\n- hauptnutzung=wohnen\n"
        assert facts_from_project_context(text) == {}

    def test_handles_quoted_values(self):
        text = 'PROJECT_CONTEXT v1\nconfirmed:\n- standort_details="Am Hang, 1230 Wien"\n'
        assert facts_from_project_context(text) == {"standort_details": "Am Hang, 1230 Wien"}

    def test_empty_text(self):
        assert facts_from_project_context("") == {}


class TestShippedRegistryApplicability:
    def test_oib_rl_2_always_required(self):
        from aiq_agent.common.norm_registry import load_registry

        registry = load_registry()
        assert registry is not None
        verdicts = resolve_applicability(registry, {"hauptnutzung": "wohnen"})
        assert verdicts["oib-rl-2"].verdict == "required"

    def test_betriebsbau_scope(self):
        from aiq_agent.common.norm_registry import load_registry

        registry = load_registry()
        assert registry is not None
        verdicts = resolve_applicability(registry, {"hauptnutzung": "produzierend"})
        assert verdicts["oib-rl-2.1"].verdict == "required"

    def test_trigger_requires_both_facts(self):
        from aiq_agent.common.norm_registry import load_registry

        registry = load_registry()
        assert registry is not None
        assert "garagengesetz-wien" not in resolve_applicability(registry, {"stellplatz_relevant": True})
        verdicts = resolve_applicability(registry, {"stellplatz_relevant": True, "bundesland": "wien"})
        assert verdicts["garagengesetz-wien"].verdict == "check"
        # The prompt-text view renders booleans as strings — both must match.
        verdicts = resolve_applicability(registry, {"stellplatz_relevant": "true", "bundesland": "wien"})
        assert verdicts["garagengesetz-wien"].verdict == "check"


class TestRenderApplicabilityBlock:
    def _registry(self) -> NormRegistry:
        required_entry = NormEntry(
            id="oib-rl-2",
            title="Brandschutz",
            short="OIB-RL 2",
            rank="oib_richtlinie",
            role="normativ",
            jurisdiction=Jurisdiction(country="at"),
            editions=[],
            applicability=[
                ApplicabilityRule(
                    when=ApplicabilityWhen(),
                    verdict="required",
                    reason_de="Gilt für jedes Bauvorhaben.",
                    reason_en="Applies to every project.",
                )
            ],
        )
        check_entry = NormEntry(
            id="garagengesetz-wien",
            title="Wiener Garagengesetz",
            short="GarG W",
            rank="landesgesetz",
            role="normativ",
            jurisdiction=Jurisdiction(country="at", state="wien"),
            editions=[],
            applicability=[
                ApplicabilityRule(
                    when=ApplicabilityWhen(all=[_cond("stellplatz_relevant", "eq", True)]),
                    verdict="check",
                    reason_de="Bei Stellplätzen in Wien zu prüfen.",
                    reason_en="Check for parking in Vienna.",
                )
            ],
        )
        return NormRegistry(entries=[required_entry, check_entry])

    def test_renders_section_with_verdicts_and_reasons(self):
        from aiq_agent.common.applicability import render_applicability_block

        block = render_applicability_block(self._registry(), {"stellplatz_relevant": True})
        assert block is not None
        assert "Anwendbare Normen" in block
        assert "OIB-RL 2" in block and "verbindlich" in block
        assert "Gilt für jedes Bauvorhaben." in block
        assert "GarG W" in block and "zu prüfen" in block
        # required renders before check
        assert block.index("OIB-RL 2") < block.index("GarG W")

    def test_none_when_no_verdicts(self):
        from aiq_agent.common.applicability import render_applicability_block

        check_only = NormRegistry(entries=[e for e in self._registry().entries if e.id == "garagengesetz-wien"])
        assert render_applicability_block(check_only, {}) is None

    def test_render_block_for_prompt_appends_section(self):
        from aiq_agent.common.norm_registry import render_block_for_prompt

        context = "PROJECT_CONTEXT v1\nconfirmed:\n- stellplatz_relevant=true\n- bundesland=wien\n"
        block = render_block_for_prompt(context)
        assert block is not None
        assert "Anwendbare Normen" in block
        assert "Garagengesetz" in block or "GarG" in block

    def test_render_block_for_prompt_without_facts_has_no_section(self):
        from aiq_agent.common.norm_registry import render_block_for_prompt

        block = render_block_for_prompt(None)
        assert block is not None
        assert "Anwendbare Normen" not in block

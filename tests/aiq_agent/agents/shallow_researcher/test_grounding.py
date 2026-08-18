"""Tests for the second kind of grounding and its anti-laundering brake.

Two detectors, and they fail in opposite directions on purpose:

- :func:`tool_result_is_measurement` must not call a refusal, an outage, a
  heuristic or an undecidable finding "evidence" — those are the ways a guess
  gets stamped.
- :func:`answer_mentions_normative_claim` is biased towards firing — a false
  positive costs the hedge the answer already gets today, a false negative lets
  a claim about the Bauordnung out at "medium" — but it is held to BOTH rates.
  It has to catch „muss" and „shall", and it has to leave „für eine Messung
  geeignet" alone, because a false fire re-floors exactly the measured answers
  the other detector exists to un-hedge.

Nothing here writes a tool result by hand. Every fixture is either a real
:class:`ifc_spatial.envelope.Answer` put through ``measure_register._render``,
or — for the refusals that matter most — the engine's own output over the
repository's IFC fixtures. Hand-written prose is how the previous version of
this suite stayed green while every refusal in production granted grounding:
its undecidable fixture said „Räume exportieren", and the real remedies say
„…dessen Höhe gemessen werden könnte".
"""

import functools
from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.bim.measure_register import _render
from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
from aiq_agent.agents.shallow_researcher.agent import _prose_without_references
from aiq_agent.agents.shallow_researcher.grounding import _SENTENCE_SPLIT_RE
from aiq_agent.agents.shallow_researcher.grounding import MEASUREMENT_TOOL_NAMES
from aiq_agent.agents.shallow_researcher.grounding import answer_mentions_normative_claim
from aiq_agent.agents.shallow_researcher.grounding import tool_result_is_measurement
from aiq_agent.agents.shallow_researcher.markers import surface_answer_confidence
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common.data_source_registry import reset_registry

FIXTURES = Path(__file__).resolve().parents[4] / "packages" / "ifc-spatial" / "test" / "fixtures"
#: Geometry everywhere — the fixture that actually measures.
HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
#: Two named rooms and four walls, and not one body the geometry kernel accepts.
#: Every measurement over it comes back ``decidable: false``.
NO_GEOMETRY = FIXTURES / "haus-mit-raeumen.ifc"
#: No IfcBuildingStorey at all — the export `fire kind=fluchtniveau` refuses on.
NO_STOREYS = FIXTURES / "strasse-ifc4x3.ifc"


@pytest.fixture(scope="module")
def run():
    """One ``ifc_measure`` result, straight out of the engine and the renderer.

    One parse per fixture file for the whole module, exactly as a conversation
    would do it.
    """
    engine = pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")
    tools = engine.create_tools()
    handles: dict[Path, str] = {}

    def call(path: Path, operation: str, **args) -> str:
        if path not in handles:
            handles[path] = engine.call(tools, "open_model", {"path": str(path)})["model"]
        payload = engine.call(tools, operation, {"model": handles[path], **args})
        return _render(operation, payload, source={}, handle="")

    return call


def _answer(**kwargs) -> dict:
    """One real :class:`Answer` as the engine would hand it over."""
    from ifc_spatial.envelope import Answer

    kwargs.setdefault("from_", ["3cUkl32yn9qRSPvBJVyWcE"])
    kwargs.setdefault("method", "clearHeight(space)")
    return Answer(**kwargs).to_dict()


class TestMeasurementDetectionAgainstTheRealRenderer:
    """Drift guard: the detector reads what ``ifc_measure`` actually returns.

    The result states its own evidence count (``measurement_evidence``), and
    nothing but this test couples the renderer that writes that line to the gate
    that reads it. So the fixtures are built by ``_render`` from real
    ``Answer`` envelopes — a changed trailer turns this red instead of silently
    switching every measured answer back to "low".
    """

    def test_computed_answer_is_measurement_grounding(self):
        result = _render(
            "measure", _answer(value=2.7, unit="m", tolerance=0.005, provenance="computed", decidable=True)
        )
        assert "gemessen" in result
        assert tool_result_is_measurement("ifc_measure", result) is True

    def test_declared_answer_is_measurement_grounding(self):
        result = _render(
            "measure", _answer(value=15.4, unit="m²", tolerance=None, provenance="declared", decidable=True)
        )
        assert "deklariert" in result
        assert tool_result_is_measurement("ifc_measure", result) is True

    def test_inferred_answer_is_not_grounding(self):
        """„vermutlich" is a heuristic — the renderer itself calls it no Feststellung."""
        result = _render(
            "measure",
            _answer(value=0.9, unit="m", tolerance=None, provenance="inferred", confidence=0.6, decidable=True),
        )
        assert tool_result_is_measurement("ifc_measure", result) is False

    def test_undecidable_finding_is_not_grounding(self):
        """A ``decidable: false`` result is a fact about the EXPORT, carrying no number."""
        from ifc_spatial.envelope import MissingFact

        result = _render(
            "measure",
            _answer(
                value=None,
                unit=None,
                tolerance=None,
                provenance="computed",
                decidable=False,
                missing=MissingFact(
                    what="keine IfcSpace-Elemente",
                    remedy="Räume im CAD anlegen — ohne sie gibt es keine Raumhöhe, die gemessen werden könnte.",
                ),
            ),
        )
        # The remedy uses the very verb the old detector searched for.
        assert "gemessen" in result
        assert tool_result_is_measurement("ifc_measure", result) is False


class TestMeasurementDetectionAgainstTheRealEngine:
    """The refusals that shipped as evidence, reproduced from the real engine.

    Three of ``ifc_measure``'s renderers write „gemessen"/„deklariert" into
    prose that explains why NOTHING could be measured: a survey's head renders
    „gemessen: clearHeight an 0 von 4 Bauteilen", an element profile's head
    renders „gemessen an Wand X" whatever its aspects say, and `fire`'s
    Fluchtniveau remedy ends „…dessen Höhe gemessen werden könnte". Under the
    old vocabulary match all three granted measurement grounding, so a model
    that invented a number on top of a refusal surfaced at "medium".

    No payload here is written by hand — the engine runs over the repository's
    own fixtures, so the German is whatever the product actually emits.
    """

    def test_a_survey_that_measured_something_is_grounding(self, run):
        result = run(HOUSE, "survey", measure="clearHeight", roomKind="alle")
        assert "an 4 von 4 Bauteilen" in result
        assert tool_result_is_measurement("ifc_measure", result) is True

    def test_a_survey_that_measured_nothing_is_not_grounding(self, run):
        """0 of 2 — and the head still opens with „gemessen:"."""
        result = run(NO_GEOMETRY, "survey", measure="clearHeight", roomKind="alle")
        assert result.startswith("gemessen: clearHeight an 0 von 2 Bauteilen")
        assert tool_result_is_measurement("ifc_measure", result) is False

    def test_an_all_undecidable_element_profile_is_not_grounding(self, run):
        result = run(NO_GEOMETRY, "element_profile", globalId="2Haus0Raeume00Wall0001")
        assert result.startswith("gemessen an Aussenwand Sued")
        assert "NICHT ENTSCHEIDBAR" in result
        assert tool_result_is_measurement("ifc_measure", result) is False

    def test_an_undecidable_fluchtniveau_is_not_grounding(self, run):
        """The report that started this: a refusal whose REMEDY says „gemessen"."""
        result = run(NO_STOREYS, "fire", kind="fluchtniveau")
        assert result.startswith("NICHT ENTSCHEIDBAR")
        assert "gemessen werden könnte" in result
        assert tool_result_is_measurement("ifc_measure", result) is False


class TestMeasurementDetectionRejectsFailures:
    """Every ``ifc_measure`` failure path stays un-grounded."""

    @staticmethod
    def _error_texts():
        from aiq_agent.agents.bim.measure_register import ENGINE_UNAVAILABLE_TEXT
        from aiq_agent.agents.bim.measure_register import UNAVAILABLE_TEXT
        from aiq_agent.agents.bim.measure_register import _rejected_text
        from aiq_agent.agents.bim.measure_register import _too_large_text
        from aiq_agent.agents.bim.measure_register import _unrunnable_text
        from aiq_agent.agents.bim.register import NO_PROJECT_TEXT

        return [
            UNAVAILABLE_TEXT,
            ENGINE_UNAVAILABLE_TEXT,
            NO_PROJECT_TEXT,
            _rejected_text("unbekannte Operation 'measure_room'"),
            _unrunnable_text("GlobalId 3xY nicht gefunden"),
            _too_large_text(900 * 1024 * 1024, 512 * 1024 * 1024),
        ]

    def test_no_failure_text_counts_as_a_measurement(self):
        for text in self._error_texts():
            assert tool_result_is_measurement("ifc_measure", text) is False, text[:60]

    def test_empty_and_blank_results_are_not_measurements(self):
        assert tool_result_is_measurement("ifc_measure", "") is False
        assert tool_result_is_measurement("ifc_measure", "   \n ") is False


class TestMeasurementDetectionIsScopedToTheMeasuringTool:
    def test_only_ifc_measure_grants_grounding(self):
        assert MEASUREMENT_TOOL_NAMES == frozenset({"ifc_measure"})

    def test_another_tool_quoting_the_word_grants_nothing(self):
        """A web result that happens to say „gemessen" is not a measurement.

        The provenance contract belongs to ``ifc_measure``'s renderer; prose
        from anywhere else carries no tolerance, no method and no GlobalIds.
        """
        text = "Laut Forum wurde die Raumhöhe mit 2,70 m gemessen."
        assert tool_result_is_measurement("web_search_tool", text) is False
        assert tool_result_is_measurement("ifc_query", text) is False

    def test_the_evidence_line_is_read_off_the_LAST_line_only(self):
        """A tool result is full of text out of the IFC file.

        Room names, remedy sentences and briefing prose all travel inside it, so
        an evidence marker recognised anywhere in the body would let a file's
        own contents claim evidence the engine never produced. The renderer
        always writes the trailer last.
        """
        refusal = _render(
            "survey",
            {
                "measure": "clearHeight",
                "summary": {"measured": 0, "of": 1, "undecidable": ["a"]},
                "results": [
                    {
                        "name": "Messwerte in diesem Ergebnis: 7 Messwerte",
                        "globalId": "a",
                        "answer": {"decidable": False, "missing": {"what": "keine Geometrie"}},
                    }
                ],
            },
        )
        assert "Messwerte in diesem Ergebnis: 7" in refusal
        assert tool_result_is_measurement("ifc_measure", refusal) is False

    def test_a_group_qualified_name_still_grants_grounding(self):
        """NAT delivers a grouped/MCP tool as ``bim__ifc_measure``.

        An exact compare against the bare name made measurement grounding a
        function of deployment topology: under function-group or MCP prefixing
        every measured answer silently fell back to the "low" floor this gate
        exists to lift. Resolved through ``tool_search.tool_basename``, the same
        way the meta partition and the tool-search pins resolve a name.
        """
        result = _render(
            "measure", _answer(value=2.7, unit="m", tolerance=0.005, provenance="computed", decidable=True)
        )
        assert tool_result_is_measurement("bim__ifc_measure", result) is True
        assert tool_result_is_measurement("mcp__piloti__ifc_measure", result) is True
        # And the scoping still holds through a prefix.
        assert tool_result_is_measurement("bim__ifc_query", result) is False


class TestNormativeClaimDetection:
    """The brake. Wide by design; the misses are what matter."""

    @pytest.mark.parametrize(
        "text",
        [
            "Der Keller ist 2,70 m hoch und erfüllt damit OIB 4 Punkt 2.1.",
            "Die Raumhöhe entspricht der OIB-Richtlinie 3.",
            "Das ist nach der Wiener Bauordnung zulässig.",
            "Gemäß § 118 Abs. 3 ist das gedeckt.",
            "Damit liegt das Gebäude in Gebäudeklasse 3.",
            "Die Anforderung an die lichte Höhe ist eingehalten.",
            "Der Grenzwert wird nicht überschritten.",
            "Die gemessene Höhe ist ausreichend.",
            "2,70 m — das genügt.",
            "Die Höhe ist zu niedrig.",
            "Nach ÖNORM B 1600 ist das barrierefrei.",
            "This complies with the building code.",
            "Die Verordnung schreibt das vor.",
            # The shapes a height requirement and a breach of it are actually
            # written in — 26 of 30 of these used to slip past the brake.
            "Die lichte Raumhöhe muss mindestens 2,50 m betragen; gemessen wurden 2,42 m.",
            "Mit 2,42 m wird die Mindesthöhe unterschritten.",
            "Die Raumhöhe darf nicht unter 2,50 m liegen.",
            "Die Höhe unterschreitet den geforderten Wert.",
            "2,70 m — das reicht.",
            "Damit ist die Ausführung normkonform.",
            "Damit ist der Nachweis erbracht.",
            "Bei Aufenthaltsräumen sind 2,50 m vorzusehen.",
            "Die Höhe liegt unter dem Sollwert.",
            "Das ist baurechtlich nicht in Ordnung.",
            "Damit besteht Handlungsbedarf gegenüber der Behörde.",
            "The clear height falls short of the minimum.",
            "The measured height is below the limit set out in the guideline.",
        ],
    )
    def test_normative_answers_fire_the_brake(self, text):
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        ("normative", "descriptive"),
        [
            # Each pair differs in ONE word: the one under test. A test whose
            # sentence carries two triggers proves nothing about either — the
            # previous version of this suite asserted „nachgewiesen" in a
            # sentence about „Feuerwiderstand", and passed on the Feuerwiderstand.
            ("Die Raumhöhe ist damit nachgewiesen.", "Die Raumhöhe ist damit dokumentiert."),
            ("Der Grenzwert liegt bei 2,50 m.", "Der Messwert liegt bei 2,50 m."),
            ("Die Höhe unterschreitet 2,50 m.", "Die Höhe erreicht 2,50 m."),
            ("Hier sind 2,50 m vorzusehen.", "Hier sind 2,50 m vorhanden."),
            ("Die Öffnung ist zu knapp.", "Die Öffnung ist 0,85 m breit."),
            ("Der Feuerwiderstand der Wand steht fest.", "Die Stärke der Wand steht fest."),
        ],
    )
    def test_the_word_under_test_is_the_only_trigger(self, normative, descriptive):
        assert answer_mentions_normative_claim(normative) is True
        assert answer_mentions_normative_claim(descriptive) is False

    @pytest.mark.parametrize(
        "text",
        [
            "Der Keller ist 2,70 m hoch (gemessen ±5 mm).",
            "Die lichte Raumhöhe im Untergeschoss beträgt 2,70 m.",
            "Über 17 Räume liegt die Raumhöhe zwischen 2,54 m und 2,81 m.",
            "Das Fenster im Wohnzimmer hat eine Brüstungshöhe von 0,90 m.",
            "Die Grundfläche des Raums ist 15,4 m², deklariert in der Datei.",
            # „entspricht" was an ordinary descriptive verb doing duty as a
            # compliance verdict: it fired on half of all measurement prose, put
            # the answer back on the "low" floor, and filled the
            # `confidence_capped` ledger with cases nobody should act on.
            "Das entspricht 15,4 m² Bodenfläche.",
            "Die Fläche beträgt 15,4 m², das entspricht rund 14 % der Geschoßfläche.",
            "Die Werte entsprechen einander in allen Geschoßen.",
            # A RANGE is what a survey says about its own numbers.
            "Die Lichteintrittsfläche reicht von 1,2 bis 2,1 m² je Fenster.",
            "Die Deckenhöhe ist an drei Stellen unterschiedlich hoch gemessen worden.",
        ],
    )
    def test_pure_measurement_answers_do_not_fire_the_brake(self, text):
        """These are the answers the change exists to un-hedge.

        A false positive here is not harmless: it puts the measured answer
        straight back on the "low" floor this whole change is about. The
        descriptive superlatives a survey uses about its OWN numbers
        („Mindestwert", „maximal") are deliberately absent from the vocabulary
        for exactly this reason.
        """
        assert answer_mentions_normative_claim(text) is False

    def test_survey_vocabulary_is_not_normative(self):
        text = "Mindestwert 2,54 m, Höchstwert 2,81 m, maximal 2,81 m — Spanne 0,27 m."
        assert answer_mentions_normative_claim(text) is False

    def test_non_string_and_empty_input_is_false(self):
        assert answer_mentions_normative_claim("") is False
        assert answer_mentions_normative_claim(None) is False  # type: ignore[arg-type]
        assert answer_mentions_normative_claim(["OIB 4"]) is False  # type: ignore[arg-type]

    def test_word_boundaries_do_not_manufacture_normativity(self):
        """„normalerweise" is not „Norm"; a substring match would over-cap everything."""
        assert answer_mentions_normative_claim("Normalerweise liegt die Höhe bei 2,50 m.") is False

    @pytest.mark.parametrize(
        "text",
        [
            # THE gap: „muss" is the commonest deontic modal in OIB prose and the
            # vocabulary had no word for it. A whole-answer verdict — the exact
            # shape the agent produces after a real clearHeight measurement —
            # surfaced at "medium" and was logged as a pure measurement.
            "Die lichte Raumhöhe beträgt 2,20 m.\n"
            "Damit ist der Raum kein Aufenthaltsraum; die Decke muss angehoben werden.",
            "Die lichte Raumhöhe beträgt 2,20 m.\nFür einen Aufenthaltsraum ist das zu wenig.",
            "Aufenthaltsräume müssen eine lichte Höhe von 2,50 m aufweisen.",
            "Die Brüstung muß mindestens 1,00 m hoch sein.",
            "Fenster in dieser Lage dürfen nicht öffenbar ausgeführt werden.",
            "Wäre die Raumhöhe geringer, dürfte der Raum nicht als Aufenthaltsraum genutzt werden.",
            "The clear height must not fall below 2.50 m.",
            "Handrails shall be continuous along the full flight.",
            "Openings in this wall may not be provided without a fire damper.",
            "Combustible cladding is not permitted on this façade.",
        ],
    )
    def test_deontic_modals_fire_the_brake(self, text):
        """B1. „muss"/„müssen"/„must"/„shall"/„may not" — the deontic core."""
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            # Austria names its law by putting the instrument on the RIGHT of a
            # compound. A left `\b` matches none of these.
            "Nach der Wiener Landesbauordnung sind 2,50 m vorgesehen.",
            "Das Steiermärkische Baugesetz kennt hier keine Ausnahme.",
            "Die NÖ Bautechnikverordnung sieht für Aufenthaltsräume 2,50 m vor.",
            "Die Ausführungsrichtlinie des Landes weicht davon ab.",
        ],
    )
    def test_instrument_compounds_fire_on_the_right_half(self, text):
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            "Der Wert wurde auf 2,50 m gesetzt.",  # „gesetz" must not eat „gesetzt"
            "Die Höhe wurde vom Planer festgesetzt.",
            "Das Ergebnis beinhaltet 12 Räume.",  # „einhalt" must not eat „beinhaltet"
            "Der Soll-Ist-Vergleich zeigt eine Differenz von 3 cm.",  # bare „Soll"
            "Der Bedarf an zusätzlichen Punkten wurde mit drei angegeben.",  # noun, not „bedarf einer"
            "Die Behördenwege des Bauherrn sind hier nicht dokumentiert.",  # Behörde as LEFT half
            "Ein Nachweisdokument war der Anfrage nicht beigelegt.",  # Nachweis as LEFT half
            "Für 3 der 12 Räume fehlt die Geschoßzuordnung im Modell.",  # not a zu-infinitive
        ],
    )
    def test_dropping_the_left_anchor_does_not_swallow_ordinary_words(self, text):
        """The cost of rule 1 in the module docstring, held to zero.

        Each of these contains a normative stem as a SUBSTRING of an ordinary
        word. Un-anchoring „gesetz", „einhalt", „behörde" and „nachweis" on the
        left is what makes „Baugesetz" and „Baubehörde" work, and it is exactly
        what would make „festgesetzt" and „beinhaltet" read as law.
        """
        assert answer_mentions_normative_claim(text) is False

    @pytest.mark.parametrize(
        "text",
        [
            # Near-verbatim `ifc_measure` renderer output. Every one of these
            # carries a normative STEM used about the APPARATUS, and every one
            # of them used to re-floor the measured answer it was attached to.
            "Für die Ermittlung der lichten Höhe ist eine Geschoßzuordnung erforderlich.",
            "Das Bauteil ist für eine Messung der lichten Höhe geeignet.",
            "Das Bauteil ist für eine Volumenberechnung nicht geeignet.",
            "Die Nachweisführung ist nicht Gegenstand dieser Messung.",
            "Die Datei ist zu groß, um vollständig geladen zu werden.",
            "Der Raum ist zu groß für eine einzelne Messachse, daher wurde in zwei Achsen gemessen.",
            "Der Sollwert aus dem Pset beträgt 2,50 m, gemessen wurden 2,47 m.",
            "Die Wand reicht vom Rohfußboden bis zur Unterkante der Rohdecke.",
            "Das Vordach reicht 1,20 m über die Fassadenflucht hinaus.",
            "Mindestens ein Wert stammt aus einer Deklaration, die übrigen wurden berechnet.",
            "Die Serie umfasst 12 Räume; mindestens drei liegen im Kellergeschoß.",
            "The file is too large to load in a single pass.",
            "The minimum of the series is 2.44 m and the maximum is 2.71 m.",
        ],
    )
    def test_renderer_prose_about_the_apparatus_does_not_fire(self, text):
        """S3. A false fire re-floors the answers this module exists to un-hedge.

        These are not adversarial inventions — they are the shapes
        ``measure_register``'s own renderers emit. Flooring them to "low" costs
        the honest hedge twice over: the measured answer is re-hedged, and the
        ``confidence_capped`` ledger fills with entries nobody should act on.
        """
        assert answer_mentions_normative_claim(text) is False

    @pytest.mark.parametrize(
        ("verdict", "apparatus"),
        [
            # The weak tier turns on the SENTENCE, not the answer. A verdict must
            # survive standing next to a measurement, which is the whole point:
            # „die gemessene Höhe ist zu wenig" is the commonest verdict shape
            # there is, so „gemessen" is deliberately not an apparatus word.
            # Each VERDICT here must carry no strong stem at all, or the case
            # proves nothing about the weak tier: an earlier version paired
            # „Der Raum ist als Aufenthaltsraum geeignet" — which fires on the
            # strong `als aufenthaltsraum` — with its apparatus twin, and would
            # have passed with the weak tier deleted outright.
            ("Die gemessene lichte Höhe ist zu wenig.", "Die Datei ist zu wenig."),
            ("Der Wohnraum ist dafür nicht geeignet.", "Der Raum ist für eine Messung geeignet."),
            ("Ein zweiter Fluchtweg ist hier erforderlich.", "Für die Ermittlung ist ein Geschoß erforderlich."),
            ("Die Höhe liegt unter dem Sollwert.", "Der Sollwert aus dem Pset beträgt 2,50 m."),
        ],
    )
    def test_the_weak_tier_is_scoped_to_its_own_clause(self, verdict, apparatus):
        assert answer_mentions_normative_claim(verdict) is True
        assert answer_mentions_normative_claim(apparatus) is False

    def test_a_verdict_survives_a_measurement_sentence_beside_it(self):
        """The apparatus carve-out must not leak across sentences.

        A two-sentence answer whose FIRST sentence is pure renderer prose and
        whose second passes a verdict is the realistic case; suppressing the
        verdict because another sentence mentioned a Messung would reinstate
        exactly the miss this test class exists to prevent.

        The verdict sentence deliberately carries NO strong stem — an earlier
        version said „der Raum ist kein Aufenthaltsraum", which fires on the
        strong tier, so the test passed however the weak tier behaved.
        """
        text = "Die Messung erfolgte an 4 von 4 Bauteilen.\nDamit ist die lichte Höhe zu wenig."
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            # „Die Auswertung zeigt, dass …" is how a model introduces a
            # conclusion, so scoping the carve-out to the SENTENCE handed every
            # verdict introduced that way to the word „Auswertung".
            "Die Auswertung zeigt, dass der Fluchtweg zu schmal ist.",
            "Die Messung ergibt 2,20 m; das ist zu niedrig.",
            "Das Ergebnis der Berechnung: der Wohnraum ist zu niedrig.",
            # An evidential adjunct CITES the apparatus for the verdict — it
            # does not predicate the verdict of it.
            "Laut Messung ist der Raum als Wohnraum nicht geeignet.",
            "Gemäß der Auswertung ist die lichte Höhe zu gering.",
            "Auf Basis der Berechnung ist der Gang zu schmal.",
        ],
    )
    def test_the_carve_out_does_not_eat_a_verdict_drawn_from_the_measurement(self, text):
        """B1. The suppressor's job is renderer prose, not the model's conclusion.

        This function never sees renderer output — it reads the model's finished
        answer, where naming the apparatus is exactly what a model does when it
        states what the numbers mean. Every sentence here was measured firing at
        ``862e453a^`` and silent at ``862e453a``: a fire-safety or habitability
        verdict shipped at "medium" under reason ``measurement_only``.
        """
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            # The apparatus word and the stem share ONE clause here, so only
            # the strong tier can fire — a weak stem would be suppressed.
            "Die Auswertung zeigt einen zu geringen Feuerwiderstand der Trennwand.",
            "Die Messung ergibt ein zu hohes Fluchtniveau.",
        ],
    )
    def test_the_fire_safety_categories_that_stayed_strong(self, text):
        """„Fluchtniveau" and „Feuerwiderstand" name a PROPERTY that only the
        Bestimmung fixes, so no context may disarm them.

        The other two stems this test used to cover — „Brandschutz" and
        „Brandabschnitt" — are now weak; see
        :meth:`test_a_fire_safety_model_gap_report_is_not_a_verdict` for the
        measurement that moved them and why this assertion was reversed for
        them and not for these two.
        """
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            # REVERSED, deliberately. Both of these were asserted True by the
            # old `test_fire_safety_categories_are_strong_again`, on the
            # strength of „promoting them back cost zero false fires across 294
            # sentences" — which was measured IN-SAMPLE, on the corpora that
            # existed when they were promoted, and did not hold out.
            #
            # Neither sentence is a verdict. Both say what the AUSWERTUNG
            # covers; nothing here is a claim about the building that anyone
            # could act on, so asserting that the brake fires on them was
            # asserting a property nobody wants.
            "Die Auswertung betrifft den baulichen Brandschutz des Stiegenhauses.",
            "Die Messung umfasst den Brandabschnitt im Regelgeschoß.",
            # The shape that actually cost the false fires: the model-gap
            # report, which is the commonest real fire-safety answer there is.
            "Die Messung ergibt, dass im Modell keine Brandabschnitte hinterlegt sind.",
            "Ein Brandschutzkonzept liegt der Auswertung nicht bei.",
        ],
    )
    def test_a_fire_safety_model_gap_report_is_not_a_verdict(self, text):
        """B3. „Brandschutz"/„Brandabschnitt" demoted to the weak tier.

        On the round-5 blind corpus the four fire-safety nouns cost 9 false
        fires, every one of them the same shape: a report that the MODEL does
        not carry the fire-safety data, which is what a fire-safety answer
        mostly is. Re-measured across all 376 sentences of the four
        independently authored corpora, demoting these two clears 5 of those 9
        and adds not one miss (0 misses before, 0 after; 30 false fires → 25).

        Demotion is not free in principle — a weak stem can be disarmed by any
        apparatus word in its clause, against this module's hedge-is-cheap
        asymmetry — so it is taken on the measurement and on nothing else. What
        makes it safe in practice is the CLAUSE scoping: a real verdict about a
        Brandabschnitt lives in its own clause, with no apparatus word in it,
        and :meth:`test_a_demoted_fire_safety_verdict_still_fires` pins that.
        """
        assert answer_mentions_normative_claim(text) is False

    @pytest.mark.parametrize(
        "text",
        [
            # The verdict sits in its own clause, so the carve-out cannot
            # reach it — this is the whole reason the demotion is affordable.
            "Die Auswertung zeigt, dass das Brandschutzkonzept unzureichend ist.",
            "Laut Messung ist der Brandabschnitt zu groß.",
            "Die Messung ergibt 1200 m², der Brandabschnitt ist somit zu groß.",
            # Strong stems in the same sentence still fire unconditionally.
            "Der Brandabschnitt ist unzulässig groß.",
            "Das Brandschutzkonzept entspricht nicht der OIB-Richtlinie 2.",
        ],
    )
    def test_a_demoted_fire_safety_verdict_still_fires(self, text):
        """Demoting the noun must not cost the verdict drawn about it."""
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            # VERBATIM from the first live end-to-end run of this branch:
            # gpt-5.6-luna, the real graph, the real 10.9 MB institute model.
            # A 0,250 m clearHeight outlier in a Keller survey, and the model
            # recommending that the EXPORT be looked at — which re-floored a
            # correct measured answer to "low" as `normative_claim_uncited`.
            "Dieser Ausreißer sollte im Modell geprüft werden",
            "Der Wert von 0,250 m sollte im Modell nachgezogen werden.",
            "Die Abweichung sollte in der Auswertung gesondert behandelt werden.",
        ],
    )
    def test_a_recommendation_about_the_export_is_not_a_verdict(self, text):
        """B4. „soll…" left the deontic modals — the only member that moves.

        „muss" and „darf" state an obligation about the world; „soll…" is also
        the ordinary German for a SUGGESTION, and a measurement answer's
        suggestions are about the export. On the four blind corpora the move is
        exactly neutral (0 → 0 misses, 25 → 25 false fires over 376 sentences),
        which proves no collateral damage but does not supply the case for it:
        only 2 of those 376 sentences carry „soll" at all. The case is the live
        run — 5 fires over 18 descriptive answers, of which this is one.
        """
        assert answer_mentions_normative_claim(text) is False

    @pytest.mark.parametrize(
        "text",
        [
            # No apparatus word in the clause, so nothing disarms the stem.
            "Die Brüstung sollte auf 1,00 m erhöht werden",
            "Aufenthaltsräume sollen eine lichte Höhe von 2,50 m aufweisen.",
            # The clause split reaches the verdict past the apparatus…
            "Die Messung ergibt 0,95 m, der Fluchtweg sollte somit verbreitert werden.",
            "Die Auswertung zeigt, dass die Decke angehoben werden sollte.",
            # …and an evidential adjunct CITES the apparatus, it is not about it.
            "Laut Messung sollte die Brüstung erhöht werden.",
            # A threshold word after bare „soll" stays STRONG whatever else the
            # clause names — the line that bounds the demotion.
            "Das Modell zeigt 2,30 m; die lichte Höhe soll nicht unter 2,50 m liegen.",
        ],
    )
    def test_a_demoted_soll_verdict_still_fires(self, text):
        """Demoting the modal must not cost the verdict stated with it."""
        assert answer_mentions_normative_claim(text) is True

    def test_a_dash_separates_the_measurement_from_the_verdict(self):
        """The module docstring's own headline verdict, next to its number.

        „2,70 m — das reicht" is the shortest route to a verdict there is. Under
        a sentence-scoped carve-out the whole line belonged to „Auswertung".
        """
        assert answer_mentions_normative_claim("Die Auswertung zeigt 2,70 m — das reicht.") is True

    @pytest.mark.parametrize(
        "text",
        [
            # The module's headline verdict, typed on an ordinary keyboard. It
            # split on „;" and on „–" and NOT on „-", so the same sentence
            # shipped a fire-escape-width verdict as ``measurement_only``
            # depending only on which dash the model reached for.
            "Die Messung ergibt 0,95 m - der Fluchtweg ist zu schmal.",
            "Die Messung lief im Vollpfad - der Fluchtweg ist dennoch zu schmal.",
            "Die Auswertung zeigt 2,70 m -- das ist zu wenig.",
        ],
    )
    def test_a_spaced_ascii_hyphen_also_separates_the_verdict(self, text):
        """„–" and „—" were listed; „-" was not, and „-" is what gets typed.

        None of these carries a strong stem, so the split is the only thing
        that can fire them.
        """
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            # „dass|wie|was|damit" are the COMPLEMENT clauses. A verdict is
            # drawn in the CONSEQUENCE clause, and none of those were listed.
            "Die Messung ergibt 0,95 m, sodass der Fluchtweg zu schmal ist.",
            "Die Messung ergibt 0,95 m, so dass der Fluchtweg zu schmal ist.",
            "Die Messung ergibt 0,95 m, weshalb der Fluchtweg zu schmal ist.",
            "Die Auswertung ergibt 2,20 m, weswegen der Raum zu niedrig ist.",
            "Die Auswertung ergibt 1,90 m, womit die Höhe zu gering ist.",
            "Die Messung ergibt 0,90 m, wodurch der Fluchtweg zu schmal wird.",
        ],
    )
    def test_a_consequence_clause_separates_the_verdict(self, text):
        """The apparatus is the subject of the left clause only.

        „Die Messung ergibt 0,95 m, sodass der Fluchtweg zu schmal ist" is one
        sentence with two subjects exactly as „…, dass …" is; leaving the
        consequence connectives out let „Messung" disarm the verdict it was
        introducing.
        """
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            # The module's headline verdict again, joined by the connective a
            # model reaches for most after „sodass" — and the one no lookahead
            # on the comma can see, because it is not a subordinator at all. It
            # sits INSIDE the second clause, after the subject and the finite
            # verb, so „,(?=\s*somit)" matches nothing here.
            "Die Messung ergibt 0,95 m, der Fluchtweg ist somit zu schmal.",
            "Die Auswertung ergibt 2,20 m, der Raum ist folglich zu niedrig.",
            "Die Messung ergibt 1,10 m, die Stiege ist demnach zu schmal.",
            "Die Berechnung ergibt 18 m², der Raum ist daher zu klein.",
            "Die Auswertung ergibt 1,90 m, die Höhe ist mithin zu gering.",
            "Die Messung ergibt 0,90 m, der Gang ist deshalb zu eng.",
        ],
    )
    def test_a_mid_clause_sentence_adverb_separates_the_verdict(self, text):
        """A2. „, … somit …" — the consequence clause with no subordinator.

        „sodass"/„weshalb" introduce their clause, so a lookahead pinned to the
        comma finds them. A sentence adverb does not introduce anything: it
        floats to the middle field, behind the subject and the finite verb. So
        the lookahead has to scan the REST of the clause for it, not the two
        characters after the comma.

        Every sentence here carries no strong stem — „zu schmal"/„zu niedrig"
        and „Fluchtweg" are all weak — so without the split the apparatus word
        in the left clause disarms the verdict in the right one, and a
        fire-escape-width verdict ships as ``measurement_only``.
        """
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            # Both clauses are about the APPARATUS. A conjunction between two
            # descriptive clauses is not a verdict, and splitting here would
            # strand „zu groß"/„zu klein" away from the word that disarms it.
            # Both are corpus sentences (critic3 c3d-32, fixer3 f3d-25).
            "Der Raum ist zu groß für eine einzelne Messachse, daher wurde in zwei Achsen gemessen.",
            "Der Raum ist zu klein bemaßt worden, die Bemaßung wurde daher wiederholt.",
            "Die Messung ergibt 2,48 m, der Wert ist daher belastbar.",
        ],
    )
    def test_the_adverb_split_does_not_invent_a_false_fire(self, text):
        """The narrow version is what makes this affordable.

        Splitting on a BARE comma was measured at 30 → 31 false fires over the
        four blind corpora and rejected. Splitting only when the following
        clause carries a sentence adverb costs nothing: 0 misses and 30 false
        fires before, 0 and 30 after. It changes the clause split of exactly
        two corpus sentences — the first two here — and both stay silent,
        because the apparatus word travels in the same clause as the weak stem.
        """
        assert answer_mentions_normative_claim(text) is False

    @pytest.mark.parametrize(
        "text",
        [
            # „2,48" is a decimal comma, not punctuation — the same rule the
            # unspaced hyphen already follows. The adverb lookahead scans
            # forward to the end of the clause, so without the whitespace guard
            # „…2,48 m ist somit…" splits INSIDE the number, and a weak stem
            # can end up in a clause its apparatus word no longer reaches.
            "Die Raumhöhe von 2,48 m ist somit ausreichend",
            "Die Messung von 0,95 m ist daher zu ungenau",
        ],
    )
    def test_a_decimal_comma_is_not_a_clause_break(self, text):
        """The number must survive the splitter whole."""
        assert _SENTENCE_SPLIT_RE.split(text) == [text]

    @pytest.mark.parametrize(
        ("text", "intact"),
        [
            # A German numeric range, an OIB citation and an ordinary compound.
            # Splitting an UNSPACED hyphen tears each of these in half, which
            # moves a weak stem out of reach of its own apparatus word and
            # invents a false fire — so the hyphen is punctuation only when
            # whitespace flanks it.
            ("Die Geschosshöhe schwankt zwischen 2,20-2,50 m", "2,20-2,50"),
            ("Die Auswertung folgt OIB-RL 4 für dieses Modell", "OIB-RL"),
            ("Für die Auswertung ist eine Modell-ID erforderlich", "Modell-ID"),
        ],
    )
    def test_an_unspaced_hyphen_is_a_compound_not_a_clause_break(self, text, intact):
        """Ranges, citations and compounds must survive the splitter whole."""
        assert _SENTENCE_SPLIT_RE.split(text) == [text]
        assert intact in text

    @pytest.mark.parametrize(
        "text",
        [
            "The minimum is 2.50 m for the series.",
            "Die lichte Höhe beträgt 2.48 m.",
            "Der Mindestwert der Serie liegt bei 2.41 m.",
        ],
    )
    def test_a_decimal_point_is_not_a_sentence_end(self, text):
        """The English half of the decimal guard, and it cost a real false fire.

        German prose writes „2,50 m" and the comma rule already covers it, but a
        model answering in English — or quoting a number straight off the engine
        — writes „2.50 m". Split there, „The minimum is 2" loses „for the
        series", and a stranded `minimum` reads as a threshold: a measured
        answer floored to „low" by its own decimal point.
        """
        assert not answer_mentions_normative_claim(text)

    def test_a_sentence_final_period_still_separates_the_verdict(self):
        """The guard must not cost the split it exists inside of."""
        assert answer_mentions_normative_claim("Die Höhe ist 2.20 m. Damit ist der Raum unzulässig.")
        assert answer_mentions_normative_claim("The clear height must be at least 2.50 m.")

    @pytest.mark.parametrize(
        "text",
        [
            # The same three, as sentences, where tearing the hyphen apart
            # strands „erforderlich"/„Sollwert" in a clause with no apparatus
            # word left in it and the carve-out can no longer reach them.
            "Für die Auswertung ist eine Modell-ID erforderlich.",
            "Die Auswertung nennt 2,20-2,50 m als Sollwert.",
        ],
    )
    def test_tearing_a_compound_apart_would_invent_a_false_fire(self, text):
        """Why the whitespace guard is load-bearing rather than tidy."""
        assert answer_mentions_normative_claim(text) is False

    @pytest.mark.parametrize(
        "text",
        [
            # „Verstoß" is o + ß. Spelling only „verstöß" (ö + ß) and
            # „verstoss" (o + ss) left the canonical singular — the form the
            # verdict is actually written in — matching neither pattern.
            "Ein Verstoß liegt vor.",
            "Gegen § 87 wurde verstoßen.",
            "Verstöße sind der Behörde zu melden.",
            "Ein Verstoss liegt vor.",
            # „unterschritten" was covered from the first round; the other side
            # of the same threshold never was, and it is the side a
            # Gebäudehöhe is breached on.
            "Die Gebäudehöhe wird überschritten.",
            "Die zulaessige Hoehe wird ueberschritten.",
            # „erlaubt" covered one register of permission out of four.
            "Die Nutzung ist untersagt.",
            "Eine Abweichung ist hier nicht gestattet.",
            "Der Grenzwert wurde missachtet.",
        ],
    )
    def test_verdict_vocabulary_that_had_no_pattern(self, text):
        """Gaps confirmed silent on both ``862e453a`` and its parent.

        Each is an unhedged legal verdict a reader acts on, and each used to
        ship at "medium" with reason ``measurement_only``.
        """
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            # L1: „pflicht" as the LEFT half of a compound is a form input, not
            # a duty. Austria's duty nouns all put it on the right.
            "Das Feld model_id ist ein Pflichtfeld.",
            # L2: the „Modell" is the uploaded IFC, not the building.
            "Ein Sollwert ist im Modell nicht hinterlegt.",
            "Das Modell ist zu groß für den Schnellpfad; die Messung lief im Vollpfad.",
        ],
    )
    def test_prose_about_the_upload_is_not_prose_about_the_building(self, text):
        assert answer_mentions_normative_claim(text) is False

    @pytest.mark.parametrize(
        "text",
        [
            "Die Bewilligungspflicht besteht unabhängig davon.",
            "Der Bauherr ist dazu verpflichtet.",
        ],
    )
    def test_left_anchoring_pflicht_keeps_the_duty_nouns(self, text):
        assert answer_mentions_normative_claim(text) is True


# ---------------------------------------------------------------------------
# Plumbing: how the signal actually reaches the confidence computation
# ---------------------------------------------------------------------------


@tool
def ifc_measure(operation: str) -> str:
    """Measure the project's IFC/BIM model and report the provenance."""
    return _MEASURE_RESULT.pop(0) if _MEASURE_RESULT else _measured_line()


#: ``ifc_measure``'s renderer output, queued per call so a test can script a
#: sequence of results across the tool loop. Rendered from a real ``Answer``
#: rather than copied as prose: the gate reads the trailer ``_render`` writes,
#: and a hand-typed line proves nothing about what the tool returns.
_MEASURE_RESULT: list[str] = []


@functools.lru_cache(maxsize=1)
def _measured_line() -> str:
    """Built on FIRST USE, not at import.

    `_answer` imports `ifc_spatial.envelope`. Computed at module scope, a
    missing spatial engine turns collection of this file into an ImportError,
    so the `pytest.importorskip` guards inside the tests never get to run and
    the whole module errors instead of skipping — which is the opposite of what
    those guards are for.
    """
    return _render("measure", _answer(value=2.7, unit="m", tolerance=0.005, provenance="computed", decidable=True))
_REFUSED_LINE = (
    "Error: the request was rejected — unbekannte Operation 'measure_room'. This is a problem with "
    "the arguments, not with the model."
)


class TestMeasurementSignalReachesTheState:
    """``answer_measurement_grounded`` / ``answer_normative_claim_uncited``.

    The signal is written by the tools node (the only place that sees raw tool
    results) and echoed by ``run()`` alongside ``answer_citation_grounded``, so
    both kinds of grounding reach the chat node by one path. ``ifc_measure`` is
    deliberately not a data source — it produces no citable passage — which is
    exactly why the citation gate could never see it.
    """

    @pytest.fixture(autouse=True)
    def _reset_data_source_registry(self):
        reset_registry()
        _MEASURE_RESULT.clear()
        yield
        reset_registry()
        _MEASURE_RESULT.clear()

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @staticmethod
    def _call(*ids: str):
        """One assistant turn asking for ``len(ids)`` measurements (default one)."""
        return AIMessage(
            content="",
            tool_calls=[
                {"name": "ifc_measure", "args": {"operation": "measure"}, "id": idx} for idx in (ids or ("1",))
            ],
        )

    async def _run(self, mock_llm_provider, mock_llm, responses, question="Wie hoch ist der Keller?"):
        mock_llm.ainvoke = AsyncMock(side_effect=responses)
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[ifc_measure])
        return await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content=question)]))

    @pytest.mark.asyncio
    async def test_a_successful_measurement_grounds_the_turn(self, mock_llm_provider, mock_llm):
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call(), AIMessage(content="Der Keller ist 2,70 m hoch (gemessen ±5 mm).")],
        )
        assert result.answer_measurement_grounded is True
        # And the citation gate still says what it always said: nothing to cite.
        assert result.answer_citation_grounded is False
        assert result.answer_normative_claim_uncited is False

    @pytest.mark.asyncio
    async def test_a_refused_measurement_grounds_nothing(self, mock_llm_provider, mock_llm):
        _MEASURE_RESULT.append(_REFUSED_LINE)
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call(), AIMessage(content="Das Modell konnte nicht gemessen werden.")],
        )
        assert result.answer_measurement_grounded is False

    @pytest.mark.asyncio
    async def test_a_refusal_beside_a_measurement_does_not_un_measure_it(self, mock_llm_provider, mock_llm):
        """Both results land in ONE tools-node call, the refusal LAST.

        The agent batches calls, so a single node invocation routinely carries a
        good measurement and a rejected one together. Reading the signal off the
        last result — rather than OR-ing across the batch — silently drops the
        measurement the answer is actually built on, and the turn falls back to
        "low" for evidence it does hold.
        """
        _MEASURE_RESULT.extend([_measured_line(), _REFUSED_LINE])
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call("1", "2"), AIMessage(content="Der Keller ist 2,70 m hoch.")],
        )
        assert result.answer_measurement_grounded is True

    @pytest.mark.asyncio
    async def test_grounding_survives_a_later_barren_iteration(self, mock_llm_provider, mock_llm):
        """And across iterations: a second, fruitless call does not erase the first."""
        _MEASURE_RESULT.extend([_measured_line(), _REFUSED_LINE])
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call("1"), self._call("2"), AIMessage(content="Der Keller ist 2,70 m hoch.")],
        )
        assert result.answer_measurement_grounded is True

    @pytest.mark.asyncio
    async def test_a_turn_that_measured_nothing_carries_no_grounding(self, mock_llm_provider, mock_llm):
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [AIMessage(content="Die Antwort steht in OIB 4.")],
        )
        assert result.answer_measurement_grounded is False

    @pytest.mark.asyncio
    async def test_a_measured_answer_that_judges_raises_the_brake(self, mock_llm_provider, mock_llm):
        """The mixed answer, produced by the real pipeline rather than by hand.

        The number is measured and the verdict is not; ``run()`` must flag the
        answer so the guard holds it at "low" instead of letting „erfüllt damit
        OIB 4" out on the measurement's evidence.
        """
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [
                self._call(),
                AIMessage(content="Der Keller ist 2,70 m hoch und erfüllt damit OIB 4 Punkt 2.1."),
            ],
        )
        assert result.answer_measurement_grounded is True
        assert result.answer_normative_claim_uncited is True

    @pytest.mark.asyncio
    async def test_the_brake_reads_the_answer_the_reader_gets(self, mock_llm_provider, mock_llm):
        """Computed after the control markers are stripped, not before.

        A ``[CONFIDENCE:…]`` marker never reaches the user, so it must not be
        able to influence what the answer is judged to say either way.
        """
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call(), AIMessage(content="Der Keller ist 2,70 m hoch.\n[CONFIDENCE:high]")],
        )
        assert result.answer_normative_claim_uncited is False
        assert result.answer_confidence_marker == "high"
        assert "[CONFIDENCE" not in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_a_refused_measurement_plus_an_invented_number_grounds_nothing(self, mock_llm_provider, mock_llm):
        """The report this fix came from, through the whole agent.

        `fire kind=fluchtniveau` on an export without storeys refuses, and the
        remedy sentence ends „…dessen Höhe gemessen werden könnte". The model
        then writes a number that is in no file anywhere. Nothing was measured,
        so nothing may be measurement-grounded — otherwise the invention rides
        out at "medium".
        """
        engine = pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")
        tools = engine.create_tools()
        handle = engine.call(tools, "open_model", {"path": str(NO_STOREYS)})["model"]
        refusal = _render("fire", engine.call(tools, "fire", {"model": handle, "kind": "fluchtniveau"}))
        _MEASURE_RESULT.append(refusal)

        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [
                self._call(),
                AIMessage(content="Das Fußbodenniveau des obersten Geschoßes liegt bei rund 9,5 m.\n[CONFIDENCE:high]"),
            ],
        )
        assert result.answer_measurement_grounded is False


class TestTheSingleSourceFallbackIsNotTheModelsCitation:
    """One stale session source used to launder a whole mixed answer.

    ``_append_minimal_citation`` fires when nothing the model cited survived
    verification and the cumulative registry holds exactly one source — which,
    across a conversation, is routinely a source captured on an EARLIER turn for
    a different question. It set ``citation_grounded``, and the normative brake
    is gated on the absence of citation grounding, so the brake never ran and
    „Der Keller ist 2,70 m hoch und erfüllt damit OIB 4 Punkt 2.1" surfaced at
    the model's own "high" with an unrelated Bauordnung link beside it.
    """

    @pytest.fixture(autouse=True)
    def _reset_data_source_registry(self):
        reset_registry()
        _MEASURE_RESULT.clear()
        yield
        reset_registry()
        _MEASURE_RESULT.clear()

    @pytest.fixture
    def prior_turn_source(self):
        """A registry holding one source, captured before this turn began."""
        from aiq_agent.common.citation_verification import SourceEntry
        from aiq_agent.common.citation_verification import SourceRegistry
        from aiq_agent.common.citation_verification import reset_session_registry
        from aiq_agent.common.citation_verification import set_session_registry

        registry = SourceRegistry()
        registry.add(
            SourceEntry(
                url="https://ris.bka.gv.at/xyz",
                title="Wiener Bauordnung",
                citation_key="ris-wien-bo",
                source_type="ris",
                tool_name="ris_fetch_tool",
            )
        )
        token = set_session_registry(registry)
        yield registry
        reset_session_registry(token)

    async def _run(self, answer: str):
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="", tool_calls=[{"name": "ifc_measure", "args": {"operation": "measure"}, "id": "1"}]
                ),
                AIMessage(content=answer),
            ]
        )
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = ShallowResearcherAgent(llm_provider=provider, tools=[ifc_measure])
        return await agent.run(
            ShallowResearchAgentState(messages=[HumanMessage(content="Wie hoch ist der Keller und passt das?")])
        )

    @pytest.mark.asyncio
    async def test_a_mixed_answer_on_a_prior_turn_source_stays_at_low(self, prior_turn_source):
        result = await self._run("Der Keller ist 2,70 m hoch und erfüllt damit OIB 4 Punkt 2.1.\n[CONFIDENCE:high]")
        # Grounded — but by the fallback, not by anything the model cited.
        assert result.answer_citation_grounded is True
        assert result.answer_citation_fallback_used is True
        # …so the brake runs, where before it was switched off entirely.
        assert result.answer_measurement_grounded is True
        assert result.answer_normative_claim_uncited is True
        assert (
            surface_answer_confidence(
                result.answer_confidence_marker,
                result.answer_citation_grounded,
                result.answer_quotes_verified,
                measurement_grounded=result.answer_measurement_grounded,
                normative_claim_uncited=result.answer_normative_claim_uncited,
                citation_fallback_used=result.answer_citation_fallback_used,
            )
            == "low"
        )

    @pytest.mark.asyncio
    async def test_a_descriptive_answer_on_a_prior_turn_source_reaches_medium_not_high(self, prior_turn_source):
        """No verdict in it — so it keeps the measurement's ceiling, not "high"."""
        result = await self._run("Der Keller ist 2,70 m hoch (gemessen ±5 mm).\n[CONFIDENCE:high]")
        assert result.answer_citation_fallback_used is True
        assert result.answer_normative_claim_uncited is False
        assert (
            surface_answer_confidence(
                result.answer_confidence_marker,
                result.answer_citation_grounded,
                result.answer_quotes_verified,
                measurement_grounded=result.answer_measurement_grounded,
                normative_claim_uncited=result.answer_normative_claim_uncited,
                citation_fallback_used=result.answer_citation_fallback_used,
            )
            == "medium"
        )


class TestTheBibliographyStripIsNotAnEscapeHatch:
    """S2. What `_prose_without_references` is allowed to throw away.

    The brake reads the answer's PROSE, so a reference list is removed first —
    „- [1] Wiener Bauordnung — https://ris…" is a pointer, not a claim, and the
    single-source fallback appends one to every answer it grounds.

    Cutting at the LAST heading match assumed the heading was the last thing in
    the answer. It is a rule about position, and the model controls position:
    write „**Quellen:**", then keep writing, and every sentence after it left
    the text before the brake saw it.
    """

    def test_prose_after_a_reference_heading_is_not_a_reference(self):
        content = (
            "Die Höhe beträgt 2,20 m.\n\n"
            "**Quellen:**\n"
            "- [1] OIB-Richtlinie 4 - https://example.invalid/oib4\n\n"
            "Die Ausführung erfüllt die Anforderung nicht und ist unzulässig."
        )
        kept = _prose_without_references(content)
        assert "unzulässig" in kept
        assert answer_mentions_normative_claim(kept) is True

    def test_a_heading_inside_a_fenced_block_is_not_a_reference_list(self):
        content = "Beispiel:\n\n```md\n## Sources\n- [1] foo\n```\n\nDer Raum ist damit unzulässig."
        kept = _prose_without_references(content)
        assert "unzulässig" in kept
        assert answer_mentions_normative_claim(kept) is True

    @pytest.mark.parametrize(
        "content",
        [
            "Die Höhe beträgt 2,20 m.\n\n**Quellen:**\n- [1] Wiener Bauordnung - https://example.invalid/bo",
            "Die Höhe beträgt 2,20 m.\n\n### Sources\n- [1] OIB 4 - https://example.invalid/oib4\n",
            "Die Höhe beträgt 2,20 m.\n\n**References:**\n1. https://example.invalid/x\n",
            "Die Höhe beträgt 2,20 m.\n\n**Quellen:**\n[1] Wiener Bauordnung\n",
        ],
    )
    def test_a_genuinely_trailing_list_is_still_removed(self, content):
        """The regression this strip exists to prevent, still prevented.

        Leaving the bibliography in made every fallback-grounded answer read as
        normative and floored purely descriptive measured answers to "low".
        """
        kept = _prose_without_references(content)
        assert kept.strip() == "Die Höhe beträgt 2,20 m."
        assert answer_mentions_normative_claim(kept) is False

    @pytest.mark.parametrize(
        "content",
        [
            # A bullet under „**Quellen:**" that points at nothing.
            "Die Höhe beträgt 2,20 m.\n\n**Quellen:**\n"
            "- [1] Wiener Bauordnung — https://example.invalid/bo\n"
            "- Damit ist der Raum unzulässig und darf nicht als Aufenthaltsraum genutzt werden.",
            # A numbered entry that is a sentence, not a source.
            "Die Höhe beträgt 2,20 m.\n\n## Quellen\n"
            "1. OIB-Richtlinie 3, https://example.invalid/oib3\n"
            "2. Der Raum erfüllt die Anforderung nicht.",
            # A nested item under a real entry.
            "Die Höhe beträgt 2,20 m.\n\n**Quellen:**\n"
            "- [1] Wiener Bauordnung — https://example.invalid/bo\n"
            "  - Der Raum ist unzulässig.",
        ],
    )
    def test_list_punctuation_alone_does_not_make_a_line_a_reference(self, content):
        """S1. „- " is available to any sentence the model writes.

        Accepting any bullet, any numbered entry and any indented line as a
        bibliography entry reopened the door this class exists to close: the
        model writes „**Quellen:**", then writes its verdict as a list item, and
        the verdict left the text before the brake ever read it. A reference has
        to point at something — a URL or a „[n]" marker.
        """
        kept = _prose_without_references(content)
        assert answer_mentions_normative_claim(kept) is True

    def test_an_answer_without_a_reference_list_is_untouched(self):
        content = "Die lichte Raumhöhe beträgt 2,70 m (gemessen ±5 mm)."
        assert _prose_without_references(content) == content

    def test_non_string_input_is_empty(self):
        assert _prose_without_references(None) == ""  # type: ignore[arg-type]

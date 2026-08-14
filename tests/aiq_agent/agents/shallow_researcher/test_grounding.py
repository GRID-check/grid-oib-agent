"""Tests for the second kind of grounding and its anti-laundering brake.

Two detectors, and they fail in opposite directions on purpose:

- :func:`tool_result_is_measurement` must not call a refusal, an outage, a
  heuristic or an undecidable finding "evidence" — those are the ways a guess
  gets stamped.
- :func:`answer_mentions_normative_claim` must over-fire rather than under-fire:
  a false positive costs the hedge the answer already gets today, a false
  negative lets a claim about the Bauordnung out at "medium".

Nothing here writes a tool result by hand. Every fixture is either a real
:class:`ifc_spatial.envelope.Answer` put through ``measure_register._render``,
or — for the refusals that matter most — the engine's own output over the
repository's IFC fixtures. Hand-written prose is how the previous version of
this suite stayed green while every refusal in production granted grounding:
its undecidable fixture said „Räume exportieren", and the real remedies say
„…dessen Höhe gemessen werden könnte".
"""

from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.bim.measure_register import _render
from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
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


# ---------------------------------------------------------------------------
# Plumbing: how the signal actually reaches the confidence computation
# ---------------------------------------------------------------------------


@tool
def ifc_measure(operation: str) -> str:
    """Measure the project's IFC/BIM model and report the provenance."""
    return _MEASURE_RESULT.pop(0) if _MEASURE_RESULT else _MEASURED_LINE


#: ``ifc_measure``'s renderer output, queued per call so a test can script a
#: sequence of results across the tool loop. Rendered from a real ``Answer``
#: rather than copied as prose: the gate reads the trailer ``_render`` writes,
#: and a hand-typed line proves nothing about what the tool returns.
_MEASURE_RESULT: list[str] = []
_MEASURED_LINE = _render(
    "measure", _answer(value=2.7, unit="m", tolerance=0.005, provenance="computed", decidable=True)
)
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
        _MEASURE_RESULT.extend([_MEASURED_LINE, _REFUSED_LINE])
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call("1", "2"), AIMessage(content="Der Keller ist 2,70 m hoch.")],
        )
        assert result.answer_measurement_grounded is True

    @pytest.mark.asyncio
    async def test_grounding_survives_a_later_barren_iteration(self, mock_llm_provider, mock_llm):
        """And across iterations: a second, fruitless call does not erase the first."""
        _MEASURE_RESULT.extend([_MEASURED_LINE, _REFUSED_LINE])
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

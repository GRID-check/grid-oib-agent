"""Tests for the second kind of grounding and its anti-laundering brake.

Two detectors, and they fail in opposite directions on purpose:

- :func:`tool_result_is_measurement` must not call a refusal, an outage, a
  heuristic or an undecidable finding "evidence" — those are the ways a guess
  gets stamped.
- :func:`answer_mentions_normative_claim` must over-fire rather than under-fire:
  a false positive costs the hedge the answer already gets today, a false
  negative lets a claim about the Bauordnung out at "medium".
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
from aiq_agent.agents.shallow_researcher.grounding import MEASUREMENT_TOOL_NAMES
from aiq_agent.agents.shallow_researcher.grounding import answer_mentions_normative_claim
from aiq_agent.agents.shallow_researcher.grounding import tool_result_is_measurement
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common.data_source_registry import reset_registry


class TestMeasurementDetectionAgainstTheRealRenderer:
    """Drift guard: the detector reads ``ifc_measure``'s ACTUAL provenance lines.

    The detector recognises measurement grounding by the German verb the
    renderer puts in front of every answer. Nothing but this test couples the
    two, so it builds the lines with ``measure_register._provenance_line``
    itself rather than with copied strings — a renamed verb turns this red
    instead of silently switching every measured answer back to "low".
    """

    @staticmethod
    def _line(**answer):
        from aiq_agent.agents.bim.measure_register import _provenance_line

        return _provenance_line(answer)

    def test_computed_answer_is_measurement_grounding(self):
        line = self._line(value=2.7, unit="m", tolerance=0.005, provenance="computed", decidable=True)
        assert "gemessen" in line
        assert tool_result_is_measurement("ifc_measure", line) is True

    def test_declared_answer_is_measurement_grounding(self):
        line = self._line(value=15.4, unit="m²", tolerance=None, provenance="declared", decidable=True)
        assert "deklariert" in line
        assert tool_result_is_measurement("ifc_measure", line) is True

    def test_inferred_answer_is_not_grounding(self):
        """„vermutlich" is a heuristic — the renderer itself calls it no Feststellung."""
        line = self._line(value=0.9, unit="m", tolerance=None, provenance="inferred", confidence=0.6, decidable=True)
        assert tool_result_is_measurement("ifc_measure", line) is False

    def test_undecidable_finding_is_not_grounding(self):
        """A ``decidable: false`` result is a fact about the EXPORT, carrying no number."""
        line = self._line(
            decidable=False,
            missing={"what": "keine IfcSpace-Elemente", "remedy": "Räume exportieren"},
        )
        assert tool_result_is_measurement("ifc_measure", line) is False


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
            "Der Feuerwiderstand ist damit nachgewiesen.",
            "Die Verordnung schreibt das vor.",
        ],
    )
    def test_normative_answers_fire_the_brake(self, text):
        assert answer_mentions_normative_claim(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            "Der Keller ist 2,70 m hoch (gemessen ±5 mm).",
            "Die lichte Raumhöhe im Untergeschoss beträgt 2,70 m.",
            "Über 17 Räume liegt die Raumhöhe zwischen 2,54 m und 2,81 m.",
            "Das Fenster im Wohnzimmer hat eine Brüstungshöhe von 0,90 m.",
            "Die Grundfläche des Raums ist 15,4 m², deklariert in der Datei.",
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


#: Stand-in for ``ifc_measure``'s renderer output, queued per call so a test can
#: script a sequence of results across the tool loop.
_MEASURE_RESULT: list[str] = []
_MEASURED_LINE = "gemessen (±0.005 m): 2.700 m — aus der Geometrie berechnet, nicht deklariert."
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

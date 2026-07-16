"""Full-pipeline tests for ComplianceCheckAgent (mocked LLM + mocked knowledge_search tool).

These tests exercise the whole 3-stage pipeline end to end (no NAT builder
involved -- ComplianceCheckAgent is NAT-independent, like the other agents in
this fleet) with canned structured LLM responses and a canned knowledge_search
tool, asserting:
  - Stage 1/Stage 2 LLM call counts stay within the design budget.
  - ComplianceMatrix assembly is correct (rows, not_applicable, status_counts).
  - Gaps are ranked by risk_score descending and never include "erfuellt".
  - Open questions are deduplicated.
  - A Stage 1 (or Stage 2) worker failure degrades gracefully instead of
    aborting the whole run.
  - Stage 1/Stage 2 fan-out respects max_concurrency.
"""

from __future__ import annotations

import asyncio
import json
import re
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from aiq_agent.agents.compliance_checker.agent import ComplianceCheckAgent
from aiq_agent.agents.compliance_checker.models import ComplianceCheckAgentState
from aiq_agent.agents.compliance_checker.models import ComplianceCheckRequest
from aiq_agent.common import LLMProvider

# Fixed Stage 1 canned profile shape: richtlinie -> applicability tags for the
# requirements RequirementProfile should return for that Richtlinie.
_PROFILE_SPEC: dict[int, list[str]] = {
    1: ["anwendbar"] * 5,
    2: ["anwendbar"] * 5,
    3: ["anwendbar"] * 4 + ["nicht_anwendbar"],
    4: ["anwendbar"] * 4,
    5: ["anwendbar"] * 4,
    6: ["anwendbar"] * 3 + ["zu_pruefen"],
}
_TOTAL_REQUIREMENTS = sum(len(tags) for tags in _PROFILE_SPEC.values())  # 27
_TOTAL_APPLICABLE = sum(
    sum(1 for tag in tags if tag in ("anwendbar", "zu_pruefen")) for tags in _PROFILE_SPEC.values()
)  # 26
_TOTAL_NOT_APPLICABLE = _TOTAL_REQUIREMENTS - _TOTAL_APPLICABLE  # 1

_STATUS_CYCLE = ["nicht_erfuellt", "kein_nachweis", "teilweise", "erfuellt"]


def _finding_payload(requirement_id: str, index: int) -> dict:
    status = _STATUS_CYCLE[index % len(_STATUS_CYCLE)]
    return {
        "requirement_id": requirement_id,
        "status": status,
        "evidence_quotes": ["Beispielzitat aus Projektunterlage."] if status != "kein_nachweis" else [],
        "source_files": ["projekt.pdf"] if status != "kein_nachweis" else [],
        "confidence": "high" if status == "nicht_erfuellt" else "medium",
        "reasoning": f"Automatisch generierte Testbewertung fuer {requirement_id}.",
        "open_question": "Bitte Nachweis nachreichen." if status == "kein_nachweis" else None,
    }


class _FakeStructuredLLM:
    """Mimics ``llm.bind(response_format=...).ainvoke(...)`` for both pipeline stages."""

    def __init__(self) -> None:
        self.stage1_calls = 0
        self.stage2_calls = 0

    def bind(self, **_kwargs):
        return self

    async def ainvoke(self, messages, config=None):  # noqa: ARG002 - config unused by the fake
        system_text = messages[0].content
        human_text = messages[1].content

        richtlinie_match = re.search(r"OIB-Richtlinie (\d)", human_text)
        if richtlinie_match and "Leite die anwendbaren" in human_text:
            self.stage1_calls += 1
            richtlinie = int(richtlinie_match.group(1))
            tags = _PROFILE_SPEC[richtlinie]
            requirements = [
                {
                    "id": f"R{richtlinie}-{i + 1}",
                    "richtlinie": richtlinie,
                    "punkt": f"{richtlinie}.{i + 1}",
                    "requirement": f"Testanforderung {richtlinie}.{i + 1}",
                    "applicability": tag,
                    "rationale": "Testbegruendung.",
                }
                for i, tag in enumerate(tags)
            ]
            payload = {"richtlinie": richtlinie, "scope_notes": "Test.", "requirements": requirements}
            return AIMessage(content=json.dumps(payload))

        if "Bewerte den Nachweisstatus" in human_text:
            self.stage2_calls += 1
            ids = re.findall(r"^- id: (\S+)", system_text, re.MULTILINE)
            findings = [_finding_payload(req_id, index) for index, req_id in enumerate(ids)]
            return AIMessage(content=json.dumps({"findings": findings}))

        raise AssertionError(f"Unexpected LLM call, human message: {human_text[:200]!r}")


@pytest.fixture
def fake_knowledge_search_tool():
    tool = MagicMock()
    tool.ainvoke = AsyncMock(return_value="Auszug: Beispielhafter OIB-Wissensbasis-Text.")
    return tool


def _provider_for(fake_llm) -> MagicMock:
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=fake_llm)
    return provider


@pytest.mark.asyncio
async def test_full_pipeline_call_budget_and_matrix_assembly(fake_knowledge_search_tool):
    fake_llm = _FakeStructuredLLM()
    agent = ComplianceCheckAgent(
        llm_provider=_provider_for(fake_llm),
        knowledge_search_tool=fake_knowledge_search_tool,
        max_concurrency=3,
        requirement_batch_size=9,
    )
    request = ComplianceCheckRequest(
        richtlinien=[1, 2, 3, 4, 5, 6],
        project_name="Testprojekt",
        project_description="Buerogebaeude, 4 Geschosse.",
    )

    result = await agent.run(ComplianceCheckAgentState(), request=request)

    # Call-budget assertions: README.md targets ~10-25 LLM calls for a full
    # 6-Richtlinien check. Stage 1 = one call per Richtlinie; Stage 2 =
    # ceil(26 applicable / 9 per batch) = 3.
    assert result.stage1_llm_calls == 6
    assert result.stage2_llm_calls == 3
    assert result.total_llm_calls == 9
    assert result.total_llm_calls <= 25
    assert fake_llm.stage1_calls == 6
    assert fake_llm.stage2_calls == 3

    matrix = result.matrix
    assert len(matrix.not_applicable) == _TOTAL_NOT_APPLICABLE
    assert len(matrix.findings) == _TOTAL_APPLICABLE
    assert sum(matrix.status_counts.values()) == _TOTAL_APPLICABLE

    # Gap ranking: only non-"erfuellt" findings appear, sorted by risk_score desc.
    assert all(gap.status != "erfuellt" for gap in matrix.gaps)
    scores = [gap.risk_score for gap in matrix.gaps]
    assert scores == sorted(scores, reverse=True)
    # nicht_erfuellt (high confidence) must outrank teilweise.
    nicht_erfuellt_scores = [g.risk_score for g in matrix.gaps if g.status == "nicht_erfuellt"]
    teilweise_scores = [g.risk_score for g in matrix.gaps if g.status == "teilweise"]
    assert min(nicht_erfuellt_scores) > max(teilweise_scores)

    # Open questions are deduplicated (every kein_nachweis finding uses the
    # same canned question text in this test).
    assert matrix.open_questions == ["Bitte Nachweis nachreichen."]

    # Markdown report sanity: German headers + matrix table + gap list + open questions.
    report = result.report_markdown
    assert "# Testprojekt: Soll-Ist-Abgleich" in report
    assert "## Compliance-Matrix" in report
    assert "## Risikogewichtete Lueckenliste" in report
    assert "## Offene Fragen" in report
    assert "## Nicht anwendbare Anforderungen" in report
    assert "Bitte Nachweis nachreichen." in report


@pytest.mark.asyncio
async def test_stage1_partial_failure_does_not_abort_pipeline(fake_knowledge_search_tool):
    class _FlakyLLM(_FakeStructuredLLM):
        async def ainvoke(self, messages, config=None):
            if "OIB-Richtlinie 4" in messages[1].content:
                raise RuntimeError("simulated stage1 failure")
            return await super().ainvoke(messages, config=config)

    fake_llm = _FlakyLLM()
    agent = ComplianceCheckAgent(llm_provider=_provider_for(fake_llm), knowledge_search_tool=fake_knowledge_search_tool)
    request = ComplianceCheckRequest(richtlinien=[1, 2, 3, 4, 5, 6], project_description="Test.")

    result = await agent.run(ComplianceCheckAgentState(), request=request)

    # Every Richtlinie is still attempted, even though one failed.
    assert result.stage1_llm_calls == 6
    # Richtlinie 4's requirements never entered the matrix.
    assert all(row.richtlinie != 4 for row in result.matrix.findings)
    assert all(req.richtlinie != 4 for req in result.matrix.not_applicable)


@pytest.mark.asyncio
async def test_stage2_batch_failure_yields_kein_nachweis_not_a_dropped_requirement(fake_knowledge_search_tool):
    """A failed evidence batch must not silently drop requirements from the matrix."""

    class _FlakyEvidenceLLM(_FakeStructuredLLM):
        async def ainvoke(self, messages, config=None):
            if "Bewerte den Nachweisstatus" in messages[1].content:
                raise RuntimeError("simulated stage2 failure")
            return await super().ainvoke(messages, config=config)

    fake_llm = _FlakyEvidenceLLM()
    agent = ComplianceCheckAgent(
        llm_provider=_provider_for(fake_llm),
        knowledge_search_tool=fake_knowledge_search_tool,
        requirement_batch_size=9,
    )
    request = ComplianceCheckRequest(richtlinien=[1], project_description="Test.")

    result = await agent.run(ComplianceCheckAgentState(), request=request)

    assert result.stage2_llm_calls == 1
    assert len(result.matrix.findings) == 5  # all 5 Richtlinie-1 requirements are "anwendbar"
    assert all(row.status == "kein_nachweis" for row in result.matrix.findings)
    assert all(gap.status == "kein_nachweis" for gap in result.matrix.gaps)


@pytest.mark.asyncio
async def test_stage1_respects_max_concurrency(fake_knowledge_search_tool):
    in_flight = 0
    max_in_flight = 0
    lock = asyncio.Lock()

    class _ConcurrencyTrackingLLM(_FakeStructuredLLM):
        async def ainvoke(self, messages, config=None):
            nonlocal in_flight, max_in_flight
            async with lock:
                in_flight += 1
                max_in_flight = max(max_in_flight, in_flight)
            await asyncio.sleep(0.01)
            try:
                return await super().ainvoke(messages, config=config)
            finally:
                async with lock:
                    in_flight -= 1

    fake_llm = _ConcurrencyTrackingLLM()
    agent = ComplianceCheckAgent(
        llm_provider=_provider_for(fake_llm),
        knowledge_search_tool=fake_knowledge_search_tool,
        max_concurrency=2,
    )
    request = ComplianceCheckRequest(richtlinien=[1, 2, 3, 4, 5, 6], project_description="Test.")

    await agent.run(ComplianceCheckAgentState(), request=request)

    assert max_in_flight <= 2


@pytest.mark.asyncio
async def test_no_applicable_requirements_skips_stage2_entirely(fake_knowledge_search_tool):
    class _AllNotApplicableLLM(_FakeStructuredLLM):
        async def ainvoke(self, messages, config=None):
            response = await super().ainvoke(messages, config=config)
            if "Leite die anwendbaren" in messages[1].content:
                payload = json.loads(response.content)
                for req in payload["requirements"]:
                    req["applicability"] = "nicht_anwendbar"
                return AIMessage(content=json.dumps(payload))
            return response

    fake_llm = _AllNotApplicableLLM()
    agent = ComplianceCheckAgent(llm_provider=_provider_for(fake_llm), knowledge_search_tool=fake_knowledge_search_tool)
    request = ComplianceCheckRequest(richtlinien=[1], project_description="Test.")

    result = await agent.run(ComplianceCheckAgentState(), request=request)

    assert result.stage1_llm_calls == 1
    assert result.stage2_llm_calls == 0
    assert result.matrix.findings == []
    assert result.matrix.gaps == []
    assert len(result.matrix.not_applicable) == 5
    assert fake_knowledge_search_tool.ainvoke.await_count > 0  # Stage 1 still retrieved OIB context


def test_build_request_from_state_uses_config_default_when_unset():
    from aiq_agent.agents.compliance_checker.agent import build_request_from_state

    state = ComplianceCheckAgentState(project_context="Ein Testprojekt.")
    request = build_request_from_state(state, default_richtlinien=[2, 4])

    assert request.richtlinien == [2, 4]
    assert request.project_description == "Ein Testprojekt."


def test_build_request_from_state_prefers_state_override():
    from aiq_agent.agents.compliance_checker.agent import build_request_from_state

    state = ComplianceCheckAgentState(richtlinien=[6])
    request = build_request_from_state(state, default_richtlinien=[1, 2, 3])

    assert request.richtlinien == [6]

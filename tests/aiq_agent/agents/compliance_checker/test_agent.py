"""Full-pipeline tests for run_compliance_check (fake LLM + fake knowledge_search tool).

The fake LLM dispatches on the human message of each structured call; the
fake knowledge_search records which turn shelves each retrieval ran under,
which is how the Stage 1 / Stage 2 scoping is pinned.
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import UTC
from datetime import datetime
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from aiq_agent.agents.compliance_checker.agent import EVIDENCE_SHELVES
from aiq_agent.agents.compliance_checker.agent import REGULATION_SHELVES
from aiq_agent.agents.compliance_checker.agent import RichtlinieOutcome
from aiq_agent.agents.compliance_checker.agent import _Judged
from aiq_agent.agents.compliance_checker.agent import assemble_matrix
from aiq_agent.agents.compliance_checker.agent import build_request
from aiq_agent.agents.compliance_checker.agent import gap_sort_key
from aiq_agent.agents.compliance_checker.agent import run_compliance_check
from aiq_agent.agents.compliance_checker.models import UNJUDGED_STATUS
from aiq_agent.agents.compliance_checker.models import ComplianceCheckRequest
from aiq_agent.agents.compliance_checker.models import EvidenceFinding
from aiq_agent.agents.compliance_checker.models import RequirementItem
from aiq_agent.agents.compliance_checker.models import RequirementProfile
from aiq_agent.agents.compliance_checker.report import render_compliance_report
from aiq_agent.common.focus_file import get_turn_shelves

# Stage 1 canned profile shape: richtlinie -> applicability tags of its requirements.
_PROFILE_SPEC: dict[int, list[str]] = {
    1: ["anwendbar"] * 5,
    2: ["anwendbar"] * 5,
    3: ["anwendbar"] * 4 + ["nicht_anwendbar"],
    4: ["anwendbar"] * 4,
    5: ["anwendbar"] * 4,
    6: ["anwendbar"] * 3 + ["zu_pruefen"],
}
_TOTAL_APPLICABLE = 26
_TOTAL_NOT_APPLICABLE = 1

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
            requirements = [
                {
                    "id": f"R{richtlinie}-{i + 1}",
                    "richtlinie": richtlinie,
                    "punkt": f"{richtlinie}.{i + 1}",
                    "requirement": f"Testanforderung {richtlinie}.{i + 1}",
                    "applicability": tag,
                    "rationale": "Testbegruendung.",
                }
                for i, tag in enumerate(_PROFILE_SPEC[richtlinie])
            ]
            payload = {"richtlinie": richtlinie, "scope_notes": "Test.", "requirements": requirements}
            return AIMessage(content=json.dumps(payload))

        if "Bewerte den Nachweisstatus" in human_text:
            self.stage2_calls += 1
            ids = re.findall(r"^- id: (\S+)", system_text, re.MULTILINE)
            findings = [_finding_payload(req_id, index) for index, req_id in enumerate(ids)]
            return AIMessage(content=json.dumps({"findings": findings}))

        raise AssertionError(f"Unexpected LLM call, human message: {human_text[:200]!r}")


class _RecordingSearch:
    """knowledge_search stand-in that records (query, turn shelves) per retrieval."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, frozenset[str] | None]] = []

    async def ainvoke(self, args: dict) -> str:
        self.calls.append((args["query"], get_turn_shelves()))
        return "Auszug: Beispielhafter Wissensbasis-Text."

    def queries(self, prefix: str) -> list[str]:
        return [query for query, _ in self.calls if query.startswith(prefix)]


@pytest.fixture
def fake_knowledge_search_tool():
    tool = MagicMock()
    tool.ainvoke = AsyncMock(return_value="Auszug: Beispielhafter OIB-Wissensbasis-Text.")
    return tool


async def _run(fake_llm, tool, request: ComplianceCheckRequest, **kwargs):
    return await run_compliance_check(request, llm=fake_llm, knowledge_search=tool, **kwargs)


@pytest.mark.asyncio
async def test_full_pipeline_call_budget_and_matrix_assembly(fake_knowledge_search_tool):
    fake_llm = _FakeStructuredLLM()
    request = ComplianceCheckRequest(richtlinien=[1, 2, 3, 4, 5, 6], project_description="Buerogebaeude, 4 Geschosse.")

    result = await _run(fake_llm, fake_knowledge_search_tool, request, max_concurrency=3, batch_size=9)

    # One Stage 1 call per Richtlinie; batches never straddle Richtlinien, so
    # with <= 9 applicable per Richtlinie Stage 2 is one call per Richtlinie.
    assert fake_llm.stage1_calls == 6
    assert fake_llm.stage2_calls == 6
    assert fake_llm.stage1_calls + fake_llm.stage2_calls <= 25

    matrix = result.matrix
    assert matrix.richtlinien == [1, 2, 3, 4, 5, 6]
    assert len(matrix.not_applicable) == _TOTAL_NOT_APPLICABLE
    assert len(matrix.findings) == _TOTAL_APPLICABLE
    assert sum(matrix.status_counts.values()) == _TOTAL_APPLICABLE
    assert matrix.notices == []

    assert all(gap.status != "erfuellt" for gap in matrix.gaps)
    assert [gap_sort_key(g) for g in matrix.gaps] == sorted(gap_sort_key(g) for g in matrix.gaps)
    assert matrix.open_questions == ["Bitte Nachweis nachreichen."]

    report = result.report_markdown
    assert "# OIB-Compliance-Check: Soll-Ist-Abgleich" in report
    assert "## Compliance-Matrix" in report
    assert "## Risikogewichtete Lueckenliste" in report
    assert "## Offene Fragen" in report
    assert "## Nicht anwendbare Anforderungen" in report
    assert "## Hinweise" not in report
    assert "Bitte Nachweis nachreichen." in report


@pytest.mark.asyncio
async def test_stage1_reads_the_law_and_stage2_reads_the_project_documents():
    """Defect (a): the two stages must not search the same collection set.

    Stage 1 derives requirements from the base OIB corpus; Stage 2 judges
    evidence in the user's documents. Before this pin both hit whatever the
    turn's scope held, so Richtlinie text came back as "Projektunterlagen".
    """
    search = _RecordingSearch()
    request = ComplianceCheckRequest(richtlinien=[1, 2], project_description="Test.")

    await _run(_FakeStructuredLLM(), search, request)

    stage1 = [shelves for query, shelves in search.calls if query.startswith("OIB-Richtlinie")]
    stage2 = [shelves for query, shelves in search.calls if query.startswith("Projektunterlagen")]
    assert len(stage1) == 4 and len(stage2) > 0
    assert set(stage1) == {REGULATION_SHELVES}
    assert set(stage2) == {EVIDENCE_SHELVES}
    assert REGULATION_SHELVES.isdisjoint(EVIDENCE_SHELVES)
    assert get_turn_shelves() is None  # the restriction never leaks out of the retrieval task


@pytest.mark.asyncio
async def test_per_richtlinie_evidence_query_is_issued_once():
    search = _RecordingSearch()
    request = ComplianceCheckRequest(richtlinien=[1], project_description="Test.")

    await _run(_FakeStructuredLLM(), search, request, batch_size=2)  # 5 applicable -> 3 batches

    assert len(search.queries("Projektunterlagen Nachweis OIB-Richtlinie 1")) == 1
    assert len(search.queries("Projektunterlagen Nachweis fuer:")) == 3


@pytest.mark.asyncio
async def test_stage1_partial_failure_is_reported_not_swallowed(fake_knowledge_search_tool):
    class _FlakyLLM(_FakeStructuredLLM):
        async def ainvoke(self, messages, config=None):
            if "OIB-Richtlinie 4" in messages[1].content:
                self.stage1_calls += 1
                raise RuntimeError("simulated stage1 failure")
            return await super().ainvoke(messages, config=config)

    fake_llm = _FlakyLLM()
    request = ComplianceCheckRequest(richtlinien=[1, 2, 3, 4, 5, 6], project_description="Test.")

    result = await _run(fake_llm, fake_knowledge_search_tool, request)

    assert fake_llm.stage1_calls == 6  # every Richtlinie was attempted
    assert all(row.richtlinie != 4 for row in result.matrix.findings)
    assert result.matrix.notices == ["OIB-Richtlinie 4: Anforderungsprofil fehlgeschlagen (simulated stage1 failure)."]
    assert "## Hinweise" in result.report_markdown
    assert "simulated stage1 failure" in result.report_markdown


@pytest.mark.asyncio
async def test_stage2_batch_failure_yields_unjudged_rows_not_kein_nachweis(fake_knowledge_search_tool):
    """A failed evidence batch keeps its requirements in the matrix, marked as not judged."""

    class _FlakyEvidenceLLM(_FakeStructuredLLM):
        async def ainvoke(self, messages, config=None):
            if "Bewerte den Nachweisstatus" in messages[1].content:
                self.stage2_calls += 1
                raise RuntimeError("simulated stage2 failure")
            return await super().ainvoke(messages, config=config)

    fake_llm = _FlakyEvidenceLLM()
    request = ComplianceCheckRequest(richtlinien=[1], project_description="Test.")

    result = await _run(fake_llm, fake_knowledge_search_tool, request)

    assert fake_llm.stage2_calls == 1  # one batch, attempted once
    assert len(result.matrix.findings) == 5
    assert {row.status for row in result.matrix.findings} == {UNJUDGED_STATUS}
    assert result.matrix.gaps == []
    assert result.matrix.status_counts == {UNJUDGED_STATUS: 5}
    assert "simulated stage2 failure" in result.matrix.notices[0]
    assert "Nicht geprueft" in result.report_markdown


@pytest.mark.asyncio
async def test_dead_retriever_surfaces_as_retrieval_failed():
    """A retriever that raises must not read as 'the documents are silent'."""

    class _DeadForEvidence:
        async def ainvoke(self, args: dict) -> str:
            if args["query"].startswith("Projektunterlagen"):
                raise ConnectionError("vector store unreachable")
            return "OIB-Auszug."

    fake_llm = _FakeStructuredLLM()
    request = ComplianceCheckRequest(richtlinien=[1], project_description="Test.")

    result = await _run(fake_llm, _DeadForEvidence(), request)

    assert fake_llm.stage2_calls == 0
    assert {row.status for row in result.matrix.findings} == {UNJUDGED_STATUS}
    assert all("vector store unreachable" in row.reasoning for row in result.matrix.findings)
    assert "kein_nachweis" not in result.matrix.status_counts
    assert result.matrix.notices == [
        "OIB-Richtlinie 1: Abruf der Projektunterlagen fehlgeschlagen (vector store unreachable)."
    ]


@pytest.mark.asyncio
async def test_no_project_documents_in_scope_skips_stage2(fake_knowledge_search_tool):
    fake_llm = _FakeStructuredLLM()
    request = ComplianceCheckRequest(richtlinien=[1], project_description="Test.", project_documents_in_scope=False)

    result = await _run(fake_llm, fake_knowledge_search_tool, request)

    assert fake_llm.stage1_calls == 1
    assert fake_llm.stage2_calls == 0
    assert {row.status for row in result.matrix.findings} == {UNJUDGED_STATUS}
    assert all("Keine Projektunterlagen im Suchbereich" in row.reasoning for row in result.matrix.findings)


@pytest.mark.asyncio
async def test_llm_calls_respect_max_concurrency(fake_knowledge_search_tool):
    in_flight = 0
    max_in_flight = 0

    class _ConcurrencyTrackingLLM(_FakeStructuredLLM):
        async def ainvoke(self, messages, config=None):
            nonlocal in_flight, max_in_flight
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
            await asyncio.sleep(0.01)
            try:
                return await super().ainvoke(messages, config=config)
            finally:
                in_flight -= 1

    fake_llm = _ConcurrencyTrackingLLM()
    request = ComplianceCheckRequest(richtlinien=[1, 2, 3, 4, 5, 6], project_description="Test.")

    await _run(fake_llm, fake_knowledge_search_tool, request, max_concurrency=2)

    assert fake_llm.stage1_calls + fake_llm.stage2_calls == 12
    assert max_in_flight <= 2


@pytest.mark.asyncio
async def test_retrievals_are_not_held_back_by_the_llm_bound():
    """Perf item 1: the semaphore bounds LLM calls only; all Stage 1 retrievals may be in flight at once."""
    in_flight = 0
    max_in_flight = 0

    class _SlowSearch:
        async def ainvoke(self, args: dict) -> str:  # noqa: ARG002
            nonlocal in_flight, max_in_flight
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
            await asyncio.sleep(0.01)
            in_flight -= 1
            return "Auszug."

    request = ComplianceCheckRequest(richtlinien=[1, 2, 3, 4, 5, 6], project_description="Test.")

    await _run(_FakeStructuredLLM(), _SlowSearch(), request, max_concurrency=1)

    assert max_in_flight == 12  # 6 Richtlinien x 2 Stage 1 queries


@pytest.mark.asyncio
async def test_no_applicable_requirements_skips_stage2_entirely(fake_knowledge_search_tool):
    class _AllNotApplicableLLM(_FakeStructuredLLM):
        async def ainvoke(self, messages, config=None):
            response = await super().ainvoke(messages, config=config)
            if "Leite die anwendbaren" not in messages[1].content:
                return response
            payload = json.loads(response.content)
            for req in payload["requirements"]:
                req["applicability"] = "nicht_anwendbar"
            return AIMessage(content=json.dumps(payload))

    fake_llm = _AllNotApplicableLLM()
    request = ComplianceCheckRequest(richtlinien=[1], project_description="Test.")

    result = await _run(fake_llm, fake_knowledge_search_tool, request)

    assert fake_llm.stage1_calls == 1
    assert fake_llm.stage2_calls == 0
    assert result.matrix.findings == []
    assert result.matrix.gaps == []
    assert len(result.matrix.not_applicable) == 5
    assert fake_knowledge_search_tool.ainvoke.await_count == 2  # Stage 1 still retrieved OIB context


# --- stage 3 -----------------------------------------------------------------


def _requirement(rid: str, richtlinie: int, punkt: str) -> RequirementItem:
    return RequirementItem(
        id=rid,
        richtlinie=richtlinie,
        punkt=punkt,
        requirement=f"Anforderung {punkt}",
        applicability="anwendbar",
        rationale="x",
    )


def _finding(rid: str, status: str, confidence: str) -> EvidenceFinding:
    return EvidenceFinding(
        requirement_id=rid,
        status=status,
        evidence_quotes=[],
        source_files=[],
        confidence=confidence,
        reasoning=f"{status}/{confidence}",
        open_question=None,
    )


def _outcome(
    richtlinie: int, requirements: list[RequirementItem], findings: list[EvidenceFinding]
) -> RichtlinieOutcome:
    profile = RequirementProfile(richtlinie=richtlinie, scope_notes="", requirements=requirements)
    return RichtlinieOutcome(richtlinie, profile, _Judged(findings=tuple(findings)))


def test_gap_ranking_never_puts_a_confirmed_violation_below_a_guessed_one():
    """Defect (b): the old 0-100 risk_score scored nicht_erfuellt/high (85) below nicht_erfuellt/low (100)."""
    requirements = [_requirement(f"R2-{i}", 2, f"2.{i}") for i in range(1, 6)]
    findings = [
        _finding("R2-1", "teilweise", "high"),
        _finding("R2-2", "nicht_erfuellt", "low"),
        _finding("R2-3", "kein_nachweis", "high"),
        _finding("R2-4", "nicht_erfuellt", "high"),
        _finding("R2-5", "erfuellt", "low"),
    ]

    matrix = assemble_matrix([_outcome(2, requirements, findings)], [2])

    assert [(g.status, g.confidence) for g in matrix.gaps] == [
        ("nicht_erfuellt", "high"),
        ("nicht_erfuellt", "low"),
        ("kein_nachweis", "high"),
        ("teilweise", "high"),
    ]
    assert not hasattr(matrix.gaps[0], "risk_score")


def test_report_prints_status_and_confidence_in_the_gap_list_and_takes_the_timestamp():
    requirements = [_requirement("R2-1", 2, "3.1.2")]
    matrix = assemble_matrix([_outcome(2, requirements, [_finding("R2-1", "nicht_erfuellt", "high")])], [2, 4])

    report = render_compliance_report(matrix, generated_at=datetime(2026, 9, 7, 14, 2, tzinfo=UTC))

    assert "*Erstellt: 2026-09-07 14:02 UTC | Geprueft: OIB-Richtlinien 2, 4*" in report
    assert "- **[Nicht erfuellt, Konfidenz hoch]** OIB-Richtlinie 2, Punkt 3.1.2 -- Anforderung 3.1.2." in report
    assert "Risiko" not in report.replace("Risikogewichtete", "")


def test_report_escapes_pipes_and_renders_the_empty_table_row():
    requirements = [_requirement("R1-1", 1, "1.1").model_copy(update={"requirement": "a | b"})]
    matrix = assemble_matrix([_outcome(1, requirements, [_finding("R1-1", "erfuellt", "high")])], [1])
    assert "| a \\| b |" in render_compliance_report(matrix, generated_at=datetime.now(UTC))

    empty = assemble_matrix([], [1])
    assert "*Keine bewerteten Anforderungen*" in render_compliance_report(empty, generated_at=datetime.now(UTC))


# --- request -----------------------------------------------------------------

_CONTEXT_LAGER = (
    "PROJECT_CONTEXT v1\nconfirmed:\n"
    "- bundesland=wien\n- hauptnutzung=lager\n- gebaeudeklasse=GK1\n- denkmalschutz=true\n"
)


def test_build_request_uses_config_default_when_unset():
    request = build_request(project_context="Ein Testprojekt.", default_richtlinien=[2, 4])

    assert request.richtlinien == [2, 4]
    assert request.project_description == "Ein Testprojekt."
    assert request.project_descriptors == {}


def test_build_request_prefers_explicit_scope_and_never_narrows_it():
    request = build_request(project_context=_CONTEXT_LAGER, richtlinien=[6], default_richtlinien=[1, 2, 3])

    assert request.richtlinien == [6]


def test_build_request_applicability_keeps_check_and_likely_richtlinien():
    """Storage building: RL 6 is verdict `check` and RL 5 `likely`; both are kept (review finding H2)."""
    request = build_request(project_context=_CONTEXT_LAGER)

    assert 6 in request.richtlinien
    assert 5 in request.richtlinien


def test_build_request_populates_descriptors_from_confirmed_facts():
    request = build_request(project_context=_CONTEXT_LAGER)

    assert request.project_descriptors == {
        "bundesland": "wien",
        "hauptnutzung": "lager",
        "gebaeudeklasse": "GK1",
        "denkmalschutz": "ja",
    }

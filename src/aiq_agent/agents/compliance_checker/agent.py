"""Staged OIB compliance-check pipeline (backlog T4-3, v1).

This is a DETERMINISTIC STAGED PIPELINE, not an open agent/tool-calling loop.
See README.md for the full stage breakdown and LLM call-budget math.

Stage 1 (requirement profile): one structured LLM call per Richtlinie in
scope, grounded by direct (tool-free) ``knowledge_search`` retrieval of the
base OIB collection.

Stage 2 (evidence check): one structured LLM call per batch of ~8-10
applicable requirements, grounded by ``knowledge_search`` retrieval scoped to
the project's document collection.

Stage 3 (matrix assembly + report rendering): pure Python, no LLM calls --
see ``_assemble_matrix`` and ``report.render_compliance_report``.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.tools import BaseTool

from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common import extract_json
from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template
from aiq_agent.common import strict_json_response_format

from .models import ALL_RICHTLINIEN
from .models import RICHTLINIE_NAMES
from .models import ComplianceCheckAgentState
from .models import ComplianceCheckRequest
from .models import ComplianceCheckResult
from .models import ComplianceMatrix
from .models import ComplianceMatrixRow
from .models import EvidenceBatchResult
from .models import EvidenceFinding
from .models import GapItem
from .models import RequirementItem
from .models import RequirementProfile
from .report import render_compliance_report

logger = logging.getLogger(__name__)

AGENT_DIR = Path(__file__).parent

DEFAULT_REQUIREMENT_BATCH_SIZE = 9
"""Requirements grouped per Stage 2 evidence-check LLM call (design target: ~8-10)."""

DEFAULT_MAX_CONCURRENCY = 3

_APPLICABLE_TAGS = ("anwendbar", "zu_pruefen")
"""RequirementItem.applicability values that proceed into Stage 2."""

# Stage 3 deterministic risk scoring: base score per status, refined by
# confidence. Computed in code -- never by an LLM -- so GapItem.risk_score
# may freely use Field(ge=0, le=100) (see models/matrix.py).
_STATUS_BASE_RISK: dict[str, int] = {
    "nicht_erfuellt": 90,
    "kein_nachweis": 70,
    "teilweise": 45,
    "erfuellt": 0,
}
_CONFIDENCE_ADJUSTMENT: dict[str, int] = {"low": 10, "medium": 0, "high": -5}

_FALLBACK_PROMPTS: dict[str, str] = {
    "requirement_profile": (
        "/no_think\n\nDu bist ein Sachverstaendiger fuer OIB-Richtlinie {{ richtlinie }} ({{ richtlinie_name }}). "
        "Projekt: {{ project_description }}. Wissensbasis: {{ knowledge_overview }} {{ knowledge_applicability }}. "
        "Antworte als RequirementProfile-JSON mit richtlinie={{ richtlinie }}."
    ),
    "evidence_batch": (
        "/no_think\n\nBeurteile den Nachweisstatus fuer diese Anforderungen: {{ requirements }}. "
        "Belege: {{ evidence_text }}. Antworte als EvidenceBatchResult-JSON."
    ),
}


def _risk_level(score: int) -> str:
    if score >= 70:
        return "hoch"
    if score >= 40:
        return "mittel"
    return "niedrig"


def _compute_risk(finding: EvidenceFinding) -> int:
    base = _STATUS_BASE_RISK.get(finding.status, 50)
    if base == 0:
        return 0
    adjusted = base + _CONFIDENCE_ADJUSTMENT.get(finding.confidence, 0)
    return max(0, min(100, adjusted))


def _batched(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _content_text(response: Any) -> str:
    """Normalize an LLM response's content to plain text (string or content blocks)."""
    content = getattr(response, "content", response)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts)
    return str(content) if content is not None else ""


def _evidence_queries_for_batch(batch: list[RequirementItem]) -> list[str]:
    """Build scoped knowledge_search queries for one Stage 2 batch.

    Kept small and deterministic: one combined query naming every
    requirement's punkt/text, plus one query per distinct Richtlinie
    represented in the batch, so retrieval stays targeted without adding an
    unbounded number of tool calls per LLM call. These are knowledge_search
    (retrieval) calls, not LLM calls -- they do not count against the LLM
    call budget in README.md.
    """
    keyword_parts = "; ".join(f"{r.punkt}: {r.requirement[:80]}" for r in batch)
    combined = f"Projektunterlagen Nachweis fuer: {keyword_parts}"
    richtlinien_in_batch = sorted({r.richtlinie for r in batch})
    per_richtlinie = [
        f"Projektunterlagen Nachweis OIB-Richtlinie {richtlinie} {RICHTLINIE_NAMES.get(richtlinie, '')}"
        for richtlinie in richtlinien_in_batch
    ]
    return [combined, *per_richtlinie]


def _narrow_scope_with_applicability(richtlinien: list[int], project_context: str | None) -> list[int]:
    """Narrow the Richtlinie scope via the norm-registry applicability engine.

    Verdicts `required`/`likely` keep a Richtlinie in scope; `check` and
    unmatched entries drop it. Fail-open everywhere: unparseable context, no
    facts, missing registry, or an intersection that would empty the scope all
    return the original scope unchanged.
    """
    if not project_context:
        return richtlinien
    try:
        from aiq_agent.common.applicability import facts_from_project_context
        from aiq_agent.common.applicability import resolve_applicability
        from aiq_agent.common.norm_registry import load_registry
    except Exception:  # pragma: no cover - defensive import guard
        return richtlinien
    facts = facts_from_project_context(project_context)
    if not facts:
        return richtlinien
    registry = load_registry()
    if registry is None:
        return richtlinien
    verdicts = resolve_applicability(registry, facts)
    keep = {
        int(norm_id.removeprefix("oib-rl-"))
        for norm_id, verdict in verdicts.items()
        if norm_id.removeprefix("oib-rl-").isdigit() and verdict.verdict in ("required", "likely")
    }
    if not keep:
        return richtlinien
    narrowed = [rl for rl in richtlinien if rl in keep]
    return narrowed or richtlinien


def build_request_from_state(
    state: ComplianceCheckAgentState,
    *,
    default_richtlinien: list[int] | None = None,
) -> ComplianceCheckRequest:
    """Build a ComplianceCheckRequest from the agent's message-based input state.

    ``state.richtlinien`` overrides ``default_richtlinien`` (the config
    default) when set; an unset/empty scope on both falls back to all six
    Richtlinien via ComplianceCheckRequest's own validator. When the project
    context carries parseable intake facts, the norm-registry applicability
    engine narrows the scope to Richtlinien with verdict `required`/`likely`
    (never below the explicit scope it would otherwise empty).
    """
    richtlinien = state.richtlinien if state.richtlinien else (default_richtlinien or list(ALL_RICHTLINIEN))
    richtlinien = _narrow_scope_with_applicability(richtlinien, state.project_context)
    return ComplianceCheckRequest(
        richtlinien=richtlinien,
        project_description=state.project_context or "",
        project_descriptors=state.project_descriptors,
        collection_name=state.collection_name,
    )


class ComplianceCheckAgent:
    """Staged OIB compliance-check pipeline (v1).

    The agent instance holds only immutable configuration (LLM provider,
    knowledge_search tool, concurrency knobs, prompts). ``run()`` executes
    the three stages described in the module docstring and returns a
    ``ComplianceCheckResult`` with the assembled matrix, the rendered
    Markdown report, and the exact LLM call counts spent.
    """

    def __init__(
        self,
        llm_provider: LLMProvider,
        knowledge_search_tool: BaseTool,
        *,
        max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
        requirement_batch_size: int = DEFAULT_REQUIREMENT_BATCH_SIZE,
        callbacks: list[Any] | None = None,
    ) -> None:
        self.llm_provider = llm_provider
        self.knowledge_search_tool = knowledge_search_tool
        self.max_concurrency = max(1, max_concurrency)
        self.requirement_batch_size = max(1, requirement_batch_size)
        self.callbacks = callbacks or []

        self.requirement_profile_prompt = self._load_prompt("requirement_profile")
        self.evidence_batch_prompt = self._load_prompt("evidence_batch")

    def _load_prompt(self, name: str) -> str:
        try:
            return load_prompt(AGENT_DIR / "prompts", name)
        except Exception:
            logger.warning("Compliance checker prompt %s not found, using inline default", name)
            return _FALLBACK_PROMPTS[name]

    def _get_llm(self) -> BaseChatModel:
        return self.llm_provider.get(LLMRole.RESEARCHER)

    def _invoke_config(self) -> dict[str, Any] | None:
        return {"callbacks": self.callbacks} if self.callbacks else None

    async def _search_knowledge(self, query: str) -> str:
        """Direct, tool-free invocation of the injected knowledge_search tool.

        No LLM is involved in deciding to call this -- the pipeline issues a
        fixed, code-determined set of queries per stage item.
        """
        try:
            result = await self.knowledge_search_tool.ainvoke({"query": query})
        except Exception:
            logger.warning("knowledge_search failed for query %r", query, exc_info=True)
            return ""
        return result if isinstance(result, str) else str(result)

    async def _derive_requirement_profile(
        self,
        richtlinie: int,
        request: ComplianceCheckRequest,
    ) -> RequirementProfile:
        """Stage 1, one Richtlinie: retrieve OIB context, then exactly ONE structured LLM call."""
        richtlinie_name = RICHTLINIE_NAMES[richtlinie]
        overview_query = f"OIB-Richtlinie {richtlinie} {richtlinie_name}: Anforderungen und Pflichtinhalte"
        applicability_query = f"OIB-Richtlinie {richtlinie} {richtlinie_name}: Anwendungsbereich und Ausnahmen"
        overview_text, applicability_text = await asyncio.gather(
            self._search_knowledge(overview_query),
            self._search_knowledge(applicability_query),
        )

        system_prompt = render_prompt_template(
            self.requirement_profile_prompt,
            richtlinie=richtlinie,
            richtlinie_name=richtlinie_name,
            project_description=request.project_description,
            project_descriptors=request.project_descriptors,
            knowledge_overview=overview_text,
            knowledge_applicability=applicability_text,
        )
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(
                content=(
                    f"Leite die anwendbaren Anforderungen der OIB-Richtlinie {richtlinie} fuer "
                    "dieses Projekt ab und antworte als RequirementProfile-JSON."
                )
            ),
        ]
        structured_llm = self._get_llm().bind(response_format=strict_json_response_format(RequirementProfile))
        response = await structured_llm.ainvoke(messages, config=self._invoke_config())
        parsed = extract_json(_content_text(response))
        if parsed is None:
            raise ValueError(f"Stage 1 LLM call for Richtlinie {richtlinie} did not return valid JSON")
        profile = RequirementProfile.model_validate(parsed)
        if profile.richtlinie != richtlinie:
            logger.warning(
                "Stage 1: LLM returned richtlinie=%s for requested Richtlinie %s; correcting",
                profile.richtlinie,
                richtlinie,
            )
            profile = profile.model_copy(update={"richtlinie": richtlinie})
        return profile

    async def _run_requirement_profiles(
        self,
        request: ComplianceCheckRequest,
    ) -> tuple[list[RequirementProfile], int]:
        """Run Stage 1 across every scoped Richtlinie with bounded concurrency.

        Returns ``(successful_profiles, attempted_calls)``. ``attempted_calls``
        equals ``len(request.richtlinien)`` regardless of per-item failures --
        every Richtlinie in scope issues exactly one LLM call attempt.
        """
        semaphore = asyncio.Semaphore(self.max_concurrency)

        async def _bounded(richtlinie: int) -> RequirementProfile:
            async with semaphore:
                return await self._derive_requirement_profile(richtlinie, request)

        results = await asyncio.gather(*(_bounded(r) for r in request.richtlinien), return_exceptions=True)

        profiles: list[RequirementProfile] = []
        errors: list[str] = []
        for richtlinie, result in zip(request.richtlinien, results, strict=False):
            if isinstance(result, BaseException):
                errors.append(f"Richtlinie {richtlinie}: {result}")
            else:
                profiles.append(result)
        if errors:
            logger.warning(
                "Stage 1: %d/%d Richtlinien failed: %s", len(errors), len(request.richtlinien), "; ".join(errors)
            )
        return profiles, len(request.richtlinien)

    async def _judge_evidence_batch(
        self,
        batch: list[RequirementItem],
        request: ComplianceCheckRequest,
    ) -> EvidenceBatchResult:
        """Stage 2, one batch: retrieve project-document evidence, then exactly ONE structured LLM call."""
        queries = _evidence_queries_for_batch(batch)
        evidence_snippets = await asyncio.gather(*(self._search_knowledge(q) for q in queries))
        evidence_text = "\n\n".join(
            f"--- Suchergebnis: {query} ---\n{text}"
            for query, text in zip(queries, evidence_snippets, strict=False)
            if text
        )

        system_prompt = render_prompt_template(
            self.evidence_batch_prompt,
            requirements=[r.model_dump() for r in batch],
            project_description=request.project_description,
            evidence_text=evidence_text,
        )
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(
                content=(
                    "Bewerte den Nachweisstatus fuer jede Anforderung im Batch anhand der gefundenen "
                    "Projektunterlagen und antworte als EvidenceBatchResult-JSON."
                )
            ),
        ]
        structured_llm = self._get_llm().bind(response_format=strict_json_response_format(EvidenceBatchResult))
        response = await structured_llm.ainvoke(messages, config=self._invoke_config())
        parsed = extract_json(_content_text(response))
        if parsed is None:
            raise ValueError("Stage 2 LLM call did not return valid JSON")
        return EvidenceBatchResult.model_validate(parsed)

    async def _run_evidence_batches(
        self,
        applicable: list[RequirementItem],
        request: ComplianceCheckRequest,
    ) -> tuple[list[EvidenceFinding], int]:
        """Run Stage 2 across every ~batch_size group of applicable requirements.

        Returns ``(findings, attempted_calls)``. Every applicable requirement
        that a batch call fails (or silently omits from its response) still
        ends up with a ``kein_nachweis`` finding, so Stage 3 never silently
        drops a requirement that was in scope.
        """
        if not applicable:
            return [], 0

        batches = _batched(applicable, self.requirement_batch_size)
        semaphore = asyncio.Semaphore(self.max_concurrency)

        async def _bounded(batch: list[RequirementItem]) -> EvidenceBatchResult:
            async with semaphore:
                return await self._judge_evidence_batch(batch, request)

        results = await asyncio.gather(*(_bounded(b) for b in batches), return_exceptions=True)

        known_ids = {r.id for r in applicable}
        findings: list[EvidenceFinding] = []
        errors: list[str] = []
        for result in results:
            if isinstance(result, BaseException):
                errors.append(str(result))
                continue
            for finding in result.findings:
                if finding.requirement_id not in known_ids:
                    logger.warning("Stage 2: dropping finding for unknown requirement_id %r", finding.requirement_id)
                    continue
                findings.append(finding)
        if errors:
            logger.warning("Stage 2: %d/%d evidence batches failed: %s", len(errors), len(batches), "; ".join(errors))

        covered_ids = {f.requirement_id for f in findings}
        for requirement in applicable:
            if requirement.id not in covered_ids:
                findings.append(
                    EvidenceFinding(
                        requirement_id=requirement.id,
                        status="kein_nachweis",
                        evidence_quotes=[],
                        source_files=[],
                        confidence="low",
                        reasoning="Keine Bewertung durch die Evidenzpruefung erhalten.",
                        open_question=None,
                    )
                )
        return findings, len(batches)

    def _assemble_matrix(
        self,
        profiles: list[RequirementProfile],
        findings: list[EvidenceFinding],
    ) -> ComplianceMatrix:
        """Stage 3: deterministic, pure-Python assembly. No LLM calls."""
        all_requirements: dict[str, RequirementItem] = {}
        not_applicable: list[RequirementItem] = []
        for profile in profiles:
            for requirement in profile.requirements:
                all_requirements[requirement.id] = requirement
                if requirement.applicability == "nicht_anwendbar":
                    not_applicable.append(requirement)

        status_counts: dict[str, int] = {}
        rows: list[ComplianceMatrixRow] = []
        gaps: list[GapItem] = []
        open_questions: list[str] = []
        seen_questions: set[str] = set()

        for finding in findings:
            requirement = all_requirements.get(finding.requirement_id)
            richtlinie = requirement.richtlinie if requirement else 0
            punkt = requirement.punkt if requirement else "?"
            requirement_text = requirement.requirement if requirement else "(unbekannte Anforderung)"

            status_counts[finding.status] = status_counts.get(finding.status, 0) + 1
            rows.append(
                ComplianceMatrixRow(
                    requirement_id=finding.requirement_id,
                    richtlinie=richtlinie,
                    punkt=punkt,
                    requirement=requirement_text,
                    status=finding.status,
                    confidence=finding.confidence,
                    evidence_quotes=finding.evidence_quotes,
                    source_files=finding.source_files,
                    reasoning=finding.reasoning,
                )
            )
            if finding.open_question and finding.open_question not in seen_questions:
                seen_questions.add(finding.open_question)
                open_questions.append(finding.open_question)
            if finding.status == "erfuellt":
                continue
            risk_score = _compute_risk(finding)
            gaps.append(
                GapItem(
                    requirement_id=finding.requirement_id,
                    richtlinie=richtlinie,
                    punkt=punkt,
                    requirement=requirement_text,
                    status=finding.status,
                    risk_score=risk_score,
                    risk_level=_risk_level(risk_score),
                    rationale=finding.reasoning,
                )
            )

        rows.sort(key=lambda row: (row.richtlinie, row.punkt))
        gaps.sort(key=lambda gap: gap.risk_score, reverse=True)

        return ComplianceMatrix(
            findings=rows,
            not_applicable=not_applicable,
            gaps=gaps,
            open_questions=open_questions,
            status_counts=status_counts,
        )

    async def run(
        self,
        state: ComplianceCheckAgentState,
        *,
        request: ComplianceCheckRequest | None = None,
    ) -> ComplianceCheckResult:
        """Execute the full three-stage pipeline and return the assembled result.

        ``request`` may be passed explicitly (register.py builds it from the
        config default plus any per-request override); otherwise it is
        derived from ``state`` alone via ``build_request_from_state``.
        """
        if request is None:
            request = build_request_from_state(state)

        profiles, stage1_calls = await self._run_requirement_profiles(request)
        applicable = [
            requirement
            for profile in profiles
            for requirement in profile.requirements
            if requirement.applicability in _APPLICABLE_TAGS
        ]
        findings, stage2_calls = await self._run_evidence_batches(applicable, request)
        matrix = self._assemble_matrix(profiles, findings)
        report_markdown = render_compliance_report(request, matrix)

        return ComplianceCheckResult(
            matrix=matrix,
            report_markdown=report_markdown,
            stage1_llm_calls=stage1_calls,
            stage2_llm_calls=stage2_calls,
        )

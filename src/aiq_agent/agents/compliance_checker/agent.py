"""Staged OIB compliance-check pipeline (backlog T4-3).

A fixed-shape pipeline, not an agent loop: every LLM call is one structured
request/response and code decides every retrieval. Per Richtlinie in scope,
gathered across Richtlinien so no Richtlinie waits for another:

Stage 1 (requirement profile): two ``knowledge_search`` retrievals against the
base OIB corpus, then ONE structured LLM call -> ``RequirementProfile``.

Stage 2 (evidence check): one retrieval per Richtlinie plus one per batch of
``batch_size`` applicable requirements, against the project's own documents
only, then ONE structured LLM call per batch -> ``EvidenceBatchResult``.

Stage 3 (matrix + report): pure Python, see ``assemble_matrix`` and
``report.render_compliance_report``.

Only the LLM calls share the ``max_concurrency`` semaphore; retrievals are
local vector queries and run unbounded. A failure anywhere becomes a row with
status ``nicht_geprueft`` and a notice in the report -- never a silent
``kein_nachweis``.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime
from pathlib import Path
from typing import Any
from typing import TypeVar

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.tools import BaseTool
from pydantic import BaseModel

from aiq_agent.common import extract_json
from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template
from aiq_agent.common import strict_json_response_format
from aiq_agent.common.applicability import Facts
from aiq_agent.common.applicability import facts_from_project_context
from aiq_agent.common.applicability import resolve_oib_applicability

# The knowledge tool restricts its collection set to these shelves
# (``_restrict_scope_to_turn`` in sources/knowledge_layer). The public setter
# ``set_turn_intent`` can only express the composer presets, none of which is
# "project documents without the law", so the pipeline sets the variable
# itself, in a copied context that ends with the retrieval task.
from aiq_agent.common.focus_file import _turn_shelves
from aiq_agent.common.message_utils import content_to_text

from .models import ALL_RICHTLINIEN
from .models import RICHTLINIE_NAMES
from .models import UNJUDGED_STATUS
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

PROMPTS_DIR = Path(__file__).parent / "prompts"
REQUIREMENT_PROFILE_PROMPT = load_prompt(PROMPTS_DIR, "requirement_profile")
EVIDENCE_BATCH_PROMPT = load_prompt(PROMPTS_DIR, "evidence_batch")

DEFAULT_REQUIREMENT_BATCH_SIZE = 9
"""Requirements grouped per Stage 2 evidence-check LLM call (design target: ~8-10)."""

DEFAULT_MAX_CONCURRENCY = 3

REGULATION_SHELVES: frozenset[str] = frozenset({"base"})
"""Stage 1 reads the law: the base OIB corpus and nothing the user uploaded."""

EVIDENCE_SHELVES: frozenset[str] = frozenset({"archiv", "project", "session"})
"""Stage 2 reads the user's documents: the office archive, the project collection, this turn's uploads.

Every shelf in ``focus_file.SHELVES`` except ``base``, and the exclusion is the whole point:
``base`` is the OIB corpus, the law Stage 1 already read. Leaving it in is what let Stage 2
"find evidence" for a requirement in the Richtlinie that states the requirement, so a project
with no documents at all scored as compliant against itself.

``archiv`` is IN. An office keeps submitted project documents on the Archiv shelf (ADR-0024),
and those are evidence in exactly the sense this stage means. Dropping it narrowed the scope
past the defect: every requirement came back ``nicht_geprueft`` for such an office, because
``register.project_documents_in_scope()`` sees no in-scope shelf and ``_run_richtlinie``
short-circuits. ``test_evidence_shelves_are_pinned`` pins this set.
"""

_APPLICABLE_TAGS = frozenset({"anwendbar", "zu_pruefen"})
"""RequirementItem.applicability values that proceed into Stage 2."""

_STATUS_RANK: dict[str, int] = {"nicht_erfuellt": 0, "kein_nachweis": 1, "teilweise": 2}
_CONFIDENCE_RANK: dict[str, int] = {"high": 0, "medium": 1, "low": 2}

_NO_DOCUMENTS_REASON = "Keine Projektunterlagen im Suchbereich (kein Projekt ausgewaehlt, keine Uploads)."
_OMITTED_REASON = "Keine Bewertung durch die Evidenzpruefung erhalten."

_StructuredT = TypeVar("_StructuredT", bound=BaseModel)


# --- request -----------------------------------------------------------------


def _richtlinie_number(code: str) -> int | None:
    """The Richtlinie number an OIB verdict code belongs to ("OIB 2.1" -> 2)."""
    match = re.match(r"OIB\s+(\d+)", code)
    return int(match.group(1)) if match else None


def _narrow_scope_with_applicability(richtlinien: list[int], facts: Facts) -> list[int]:
    """Keep the Richtlinien the project's facts flag as ``required``/``likely``/``check``.

    ``check`` means "needs verification", so the checker still looks at it
    (review finding H2). Fail-open: no facts, or a narrowing that would empty
    the scope, returns the scope unchanged.
    """
    if not facts:
        return richtlinien
    keep = {
        number
        for verdict in resolve_oib_applicability(facts)
        if (number := _richtlinie_number(verdict.code)) is not None
    }
    narrowed = [richtlinie for richtlinie in richtlinien if richtlinie in keep]
    return narrowed or richtlinien


def _descriptor(value: object) -> str:
    if isinstance(value, bool):
        return "ja" if value else "nein"
    return str(value)


def build_request(
    *,
    project_context: str | None,
    richtlinien: Sequence[int] | None = None,
    default_richtlinien: Sequence[int] = ALL_RICHTLINIEN,
    project_documents_in_scope: bool = True,
) -> ComplianceCheckRequest:
    """Build the request for one run.

    An explicit ``richtlinien`` is used untouched; otherwise the configured
    default is narrowed by the project's confirmed intake facts. Those facts
    also become ``project_descriptors`` for the prompts.
    """
    facts = facts_from_project_context(project_context or "")
    scope = list(richtlinien) if richtlinien else _narrow_scope_with_applicability(list(default_richtlinien), facts)
    return ComplianceCheckRequest(
        richtlinien=scope,
        project_description=project_context or "",
        project_descriptors={key: _descriptor(value) for key, value in facts.items()},
        project_documents_in_scope=project_documents_in_scope,
    )


# --- collaborators -----------------------------------------------------------


@dataclass(frozen=True)
class _Runtime:
    """What every stage needs: the model, the retriever, and the LLM concurrency bound."""

    llm: BaseChatModel
    knowledge_search: BaseTool
    llm_slots: asyncio.Semaphore
    batch_size: int
    callbacks: tuple[Any, ...]


async def _search(runtime: _Runtime, query: str, *, shelves: frozenset[str]) -> str:
    """One knowledge_search retrieval restricted to ``shelves``.

    The restriction lives in a copied context that the retrieval task owns, so
    the caller's turn intent is untouched. Raises whatever the tool raises.
    """
    context = contextvars.copy_context()
    context.run(_turn_shelves.set, shelves)
    result = await asyncio.create_task(runtime.knowledge_search.ainvoke({"query": query}), context=context)
    return result if isinstance(result, str) else str(result)


async def _call_structured_llm(
    runtime: _Runtime,
    schema: type[_StructuredT],
    system_prompt: str,
    human_prompt: str,
) -> _StructuredT:
    """One strict-JSON LLM call, holding one of the ``max_concurrency`` slots while it runs."""
    messages = [SystemMessage(content=system_prompt), HumanMessage(content=human_prompt)]
    structured = runtime.llm.bind(response_format=strict_json_response_format(schema))
    config = {"callbacks": list(runtime.callbacks)} if runtime.callbacks else None
    async with runtime.llm_slots:
        response = await structured.ainvoke(messages, config=config)
    parsed = extract_json(content_to_text(getattr(response, "content", response)))
    if parsed is None:
        raise ValueError(f"LLM did not return valid {schema.__name__} JSON")
    return schema.model_validate(parsed)


# --- stage 1 -----------------------------------------------------------------


async def _derive_profile(runtime: _Runtime, richtlinie: int, request: ComplianceCheckRequest) -> RequirementProfile:
    """Retrieve OIB context for one Richtlinie, then exactly ONE structured LLM call."""
    name = RICHTLINIE_NAMES[richtlinie]
    overview, applicability = await asyncio.gather(
        _search(
            runtime, f"OIB-Richtlinie {richtlinie} {name}: Anforderungen und Pflichtinhalte", shelves=REGULATION_SHELVES
        ),
        _search(
            runtime, f"OIB-Richtlinie {richtlinie} {name}: Anwendungsbereich und Ausnahmen", shelves=REGULATION_SHELVES
        ),
    )
    system_prompt = render_prompt_template(
        REQUIREMENT_PROFILE_PROMPT,
        richtlinie=richtlinie,
        richtlinie_name=name,
        project_description=request.project_description,
        project_descriptors=request.project_descriptors,
        knowledge_overview=overview,
        knowledge_applicability=applicability,
    )
    human_prompt = (
        f"Leite die anwendbaren Anforderungen der OIB-Richtlinie {richtlinie} fuer "
        "dieses Projekt ab und antworte als RequirementProfile-JSON."
    )
    profile = await _call_structured_llm(runtime, RequirementProfile, system_prompt, human_prompt)
    if profile.richtlinie == richtlinie:
        return profile
    logger.warning("Stage 1: LLM returned richtlinie=%s for Richtlinie %s; correcting", profile.richtlinie, richtlinie)
    return profile.model_copy(update={"richtlinie": richtlinie})


# --- stage 2 -----------------------------------------------------------------


def _batched(items: list[RequirementItem], size: int) -> list[list[RequirementItem]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _richtlinie_query(richtlinie: int) -> str:
    return f"Projektunterlagen Nachweis OIB-Richtlinie {richtlinie} {RICHTLINIE_NAMES[richtlinie]}"


def _batch_query(batch: list[RequirementItem]) -> str:
    punkte = "; ".join(f"{r.punkt}: {r.requirement[:80]}" for r in batch)
    return f"Projektunterlagen Nachweis fuer: {punkte}"


def _evidence_text(snippets: dict[str, str]) -> str:
    """Retrieved passages keyed by the query that found them, as one prompt block."""
    return "\n\n".join(f"--- Suchergebnis: {query} ---\n{text}" for query, text in snippets.items() if text)


async def _judge_batch(
    runtime: _Runtime,
    batch: list[RequirementItem],
    request: ComplianceCheckRequest,
    richtlinie_evidence: dict[str, str],
) -> EvidenceBatchResult:
    """Retrieve evidence for one batch, then exactly ONE structured LLM call."""
    query = _batch_query(batch)
    text = await _search(runtime, query, shelves=EVIDENCE_SHELVES)
    system_prompt = render_prompt_template(
        EVIDENCE_BATCH_PROMPT,
        requirements=[r.model_dump() for r in batch],
        project_description=request.project_description,
        evidence_text=_evidence_text({query: text, **richtlinie_evidence}),
    )
    human_prompt = (
        "Bewerte den Nachweisstatus fuer jede Anforderung im Batch anhand der gefundenen "
        "Projektunterlagen und antworte als EvidenceBatchResult-JSON."
    )
    return await _call_structured_llm(runtime, EvidenceBatchResult, system_prompt, human_prompt)


@dataclass(frozen=True)
class _Judged:
    """Stage 2 outcome for one Richtlinie: judged findings, unjudged requirement ids with a reason, notices."""

    findings: tuple[EvidenceFinding, ...] = ()
    unjudged: tuple[tuple[str, str], ...] = ()
    notices: tuple[str, ...] = ()


def _merge_batch_results(
    richtlinie: int,
    batches: list[list[RequirementItem]],
    results: list[EvidenceBatchResult | BaseException],
) -> _Judged:
    """Keep findings for known ids; a failed batch or an omitted requirement becomes unjudged, with the reason."""
    findings: list[EvidenceFinding] = []
    unjudged: list[tuple[str, str]] = []
    notices: list[str] = []
    for batch, result in zip(batches, results, strict=True):
        if isinstance(result, BaseException):
            unjudged.extend((r.id, f"Evidenzpruefung fehlgeschlagen ({result}).") for r in batch)
            notices.append(f"OIB-Richtlinie {richtlinie}: Evidenzpruefung fehlgeschlagen ({result}).")
            continue
        known = {r.id for r in batch}
        judged = [finding for finding in result.findings if finding.requirement_id in known]
        unknown = {finding.requirement_id for finding in result.findings} - known
        if unknown:
            logger.warning("Stage 2: dropping findings for unknown requirement ids %s", sorted(unknown))
        covered = {finding.requirement_id for finding in judged}
        findings.extend(judged)
        unjudged.extend((r.id, _OMITTED_REASON) for r in batch if r.id not in covered)
    return _Judged(tuple(findings), tuple(unjudged), tuple(notices))


async def _judge_requirements(
    runtime: _Runtime,
    richtlinie: int,
    applicable: list[RequirementItem],
    request: ComplianceCheckRequest,
) -> _Judged:
    """Stage 2 for one Richtlinie: its evidence query once, then the batches gathered."""
    query = _richtlinie_query(richtlinie)
    try:
        richtlinie_text = await _search(runtime, query, shelves=EVIDENCE_SHELVES)
    except Exception as exc:  # noqa: BLE001 - typed failure: every requirement is reported as unjudged
        reason = f"Abruf der Projektunterlagen fehlgeschlagen ({exc})."
        logger.warning("Stage 2: retrieval failed for Richtlinie %s", richtlinie, exc_info=True)
        return _Judged(
            unjudged=tuple((r.id, reason) for r in applicable), notices=(f"OIB-Richtlinie {richtlinie}: {reason}",)
        )
    batches = _batched(applicable, runtime.batch_size)
    results = await asyncio.gather(
        *(_judge_batch(runtime, batch, request, {query: richtlinie_text}) for batch in batches),
        return_exceptions=True,
    )
    return _merge_batch_results(richtlinie, batches, list(results))


# --- per-Richtlinie pipeline -------------------------------------------------


@dataclass(frozen=True)
class RichtlinieOutcome:
    """Everything one Richtlinie produced; ``profile`` is None when Stage 1 failed."""

    richtlinie: int
    profile: RequirementProfile | None
    judged: _Judged = _Judged()
    notices: tuple[str, ...] = ()


async def _check_richtlinie(runtime: _Runtime, richtlinie: int, request: ComplianceCheckRequest) -> RichtlinieOutcome:
    """Profile -> evidence -> findings for one Richtlinie, independent of the other five."""
    try:
        profile = await _derive_profile(runtime, richtlinie, request)
    except Exception as exc:  # noqa: BLE001 - typed failure: the Richtlinie is reported, not the run aborted
        logger.warning("Stage 1: Richtlinie %s failed", richtlinie, exc_info=True)
        return RichtlinieOutcome(
            richtlinie, None, notices=(f"OIB-Richtlinie {richtlinie}: Anforderungsprofil fehlgeschlagen ({exc}).",)
        )
    applicable = [r for r in profile.requirements if r.applicability in _APPLICABLE_TAGS]
    if not applicable:
        return RichtlinieOutcome(richtlinie, profile)
    if not request.project_documents_in_scope:
        return RichtlinieOutcome(
            richtlinie, profile, _Judged(unjudged=tuple((r.id, _NO_DOCUMENTS_REASON) for r in applicable))
        )
    judged = await _judge_requirements(runtime, richtlinie, applicable, request)
    return RichtlinieOutcome(richtlinie, profile, judged, judged.notices)


# --- stage 3 -----------------------------------------------------------------


def _index_requirements(outcomes: Sequence[RichtlinieOutcome]) -> dict[str, RequirementItem]:
    return {r.id: r for outcome in outcomes if outcome.profile for r in outcome.profile.requirements}


def _row_for(finding: EvidenceFinding, requirements: dict[str, RequirementItem]) -> ComplianceMatrixRow:
    requirement = requirements[finding.requirement_id]
    return ComplianceMatrixRow(
        requirement_id=finding.requirement_id,
        richtlinie=requirement.richtlinie,
        punkt=requirement.punkt,
        requirement=requirement.requirement,
        status=finding.status,
        confidence=finding.confidence,
        evidence_quotes=finding.evidence_quotes,
        source_files=finding.source_files,
        reasoning=finding.reasoning,
    )


def _unjudged_row(requirement: RequirementItem, reason: str) -> ComplianceMatrixRow:
    return ComplianceMatrixRow(
        requirement_id=requirement.id,
        richtlinie=requirement.richtlinie,
        punkt=requirement.punkt,
        requirement=requirement.requirement,
        status=UNJUDGED_STATUS,
        confidence="low",
        reasoning=reason,
    )


def _gap_for(row: ComplianceMatrixRow) -> GapItem | None:
    """A gap is a judged, non-'erfuellt' row; an unjudged row is a notice, not a gap."""
    if row.status not in _STATUS_RANK:
        return None
    return GapItem(
        requirement_id=row.requirement_id,
        richtlinie=row.richtlinie,
        punkt=row.punkt,
        requirement=row.requirement,
        status=row.status,
        confidence=row.confidence,
        rationale=row.reasoning,
    )


def gap_sort_key(gap: GapItem) -> tuple[int, int, int, str]:
    """Worst first: a confirmed violation outranks a guessed one, and any violation outranks 'teilweise'."""
    return (
        _STATUS_RANK[gap.status],
        _CONFIDENCE_RANK.get(gap.confidence, len(_CONFIDENCE_RANK)),
        gap.richtlinie,
        gap.punkt,
    )


def _open_questions(findings: Sequence[EvidenceFinding]) -> list[str]:
    return list(dict.fromkeys(finding.open_question for finding in findings if finding.open_question))


def assemble_matrix(outcomes: Sequence[RichtlinieOutcome], richtlinien: Sequence[int]) -> ComplianceMatrix:
    """Stage 3: join requirements with findings. Pure Python, no LLM calls."""
    requirements = _index_requirements(outcomes)
    findings = [finding for outcome in outcomes for finding in outcome.judged.findings]
    unjudged = [(requirements[rid], reason) for outcome in outcomes for rid, reason in outcome.judged.unjudged]
    rows = [_row_for(finding, requirements) for finding in findings] + [_unjudged_row(r, why) for r, why in unjudged]
    rows.sort(key=lambda row: (row.richtlinie, row.punkt))
    return ComplianceMatrix(
        richtlinien=list(richtlinien),
        findings=rows,
        not_applicable=[r for r in requirements.values() if r.applicability == "nicht_anwendbar"],
        gaps=sorted(filter(None, map(_gap_for, rows)), key=gap_sort_key),
        open_questions=_open_questions(findings),
        status_counts=dict(Counter(row.status for row in rows)),
        notices=[notice for outcome in outcomes for notice in outcome.notices],
    )


# --- entry point -------------------------------------------------------------


async def run_compliance_check(
    request: ComplianceCheckRequest,
    *,
    llm: BaseChatModel,
    knowledge_search: BaseTool,
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
    batch_size: int = DEFAULT_REQUIREMENT_BATCH_SIZE,
    callbacks: Sequence[Any] = (),
    generated_at: datetime | None = None,
) -> ComplianceCheckResult:
    """Run all three stages for ``request.richtlinien`` and render the report."""
    runtime = _Runtime(
        llm=llm,
        knowledge_search=knowledge_search,
        llm_slots=asyncio.Semaphore(max(1, max_concurrency)),
        batch_size=max(1, batch_size),
        callbacks=tuple(callbacks),
    )
    outcomes = await asyncio.gather(*(_check_richtlinie(runtime, r, request) for r in request.richtlinien))
    matrix = assemble_matrix(outcomes, request.richtlinien)
    report = render_compliance_report(matrix, generated_at=generated_at or datetime.now(UTC))
    return ComplianceCheckResult(matrix=matrix, report_markdown=report)

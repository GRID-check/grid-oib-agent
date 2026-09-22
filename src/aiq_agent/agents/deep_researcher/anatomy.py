"""The report's anatomy and its findings, extracted after the report is written.

The deep writer produces Markdown. The chat answer carries a structured
envelope beside its prose (``common/answer_envelope.py``): the summary that
renders as the standfirst, a verdict when there is a copyable value, the
takeaways, one callout. A report reached the reader with none of that, and
with no list of what it found, so a twelve-minute run landed as one wall of
text. This module reads the finished report ONCE with a structured call and
returns both: the gated ``answer_meta`` the masthead renders, and the
``findings`` the Befundmatrix renders (``common/findings.py``).

Post hoc rather than in the writer, deliberately: the writer's contract and
its citation verification stay untouched, the extraction cannot change a word
of the report, and a failure here costs the reader the masthead and the
matrix, never the report. Same footing as the post-hoc cards beside it.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any
from typing import Literal

from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from pydantic import BaseModel
from pydantic import ConfigDict

from aiq_agent.common.answer_envelope import AnswerMeta
from aiq_agent.common.answer_envelope import gate_answer_meta
from aiq_agent.common.findings import sanitize_findings

logger = logging.getLogger(__name__)

#: Bounded like the card pass: the report is complete before this runs.
_ANATOMY_TIMEOUT_S = 45.0
#: What the model reads. A long report is cut from the END: the lead, the
#: findings and the tables are at the front, the sources list is last.
_MAX_REPORT_CHARS = 60_000


class _Reference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: str
    section: str | None
    page: int | None


class _Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requirement: str
    value: str | None
    status: Literal["erfuellt", "nicht_erfuellt", "offen", "nicht_anwendbar"] | None
    grounding: Literal["belegt", "abgeleitet", "offen"]
    reference: _Reference | None
    citations: list[int]
    comment: str | None
    area: str | None


class _Takeaway(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    detail: str | None


class _Callout(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["hinweis", "achtung", "frist", "tipp"]
    text: str
    title: str | None
    detail: str | None


class _Verdict(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str
    subject: str
    reference: _Reference | None


class ReportAnatomyDraft(BaseModel):
    """The strict-JSON shape the extraction asks for. Every field present,
    optionals nullable, as the strict schema requires."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["walkthrough", "ruling"]
    summary: str | None
    topic: str | None
    context: str | None
    verdict: _Verdict | None
    takeaways: list[_Takeaway]
    callout: _Callout | None
    findings: list[_Finding]


@dataclass(frozen=True)
class ReportAnatomy:
    """What the extraction produced. ``failed`` says the call itself lost, so
    the runner can tell "no findings" from "could not look"."""

    answer_meta: dict[str, Any] | None = None
    findings: dict[str, Any] | None = None
    failed: bool = False


SYSTEM_PROMPT = (
    "You read a finished research report from an Austrian planning office and return its anatomy as JSON. "
    "You did not write the report and you change nothing in it: every value you return is copied or "
    "condensed from the report, never added.\n"
    "\n"
    "Write every free-text field in the report's own language. Field names and enum values are contract "
    "tokens and stay exactly as given.\n"
    "\n"
    '- `kind`: "ruling" only when the report\'s central answer is ONE copyable legal value (a number, a '
    'class, "Nicht geregelt"); otherwise "walkthrough".\n'
    "- `summary`: the whole report in one to two sentences, outcome plus the decisive qualifier, under "
    "320 characters. Not the first sentence restated.\n"
    "- `topic`: a nominal title of the subject, under 90 characters, or null.\n"
    "- `context`: the scope in one line (Richtlinie and Ausgabe, Bundesland, Gebäudeklasse), under 160 "
    "characters, or null.\n"
    '- `verdict`: only for kind "ruling": the value (under 60 characters), what it answers, and the one '
    "Fundstelle that carries it, else null.\n"
    "- `takeaways`: two to five rows for a long report, each one move the report made (an Einstufung, the "
    "requirement that follows, the exception), most consequential first; `detail` carries the Fundstelle "
    "or the case where it does not hold, or null. Empty for a short report.\n"
    "- `callout`: at most the ONE sentence that changes what the reader does (a Frist, a "
    "Landesabweichung, a condition skimming misses), or null.\n"
    "- `findings`: one row per requirement the report read against the project. `requirement` is a noun "
    "phrase; `value` the copyable value or null; `status` one of erfuellt / nicht_erfuellt / offen / "
    'nicht_anwendbar, where "offen" means the report could not decide (missing project fact, pending '
    "Behörde) — or null when the report STATES the row without judging it (a Vergleich's criterion, an "
    "Aktenvermerk's point), so a table of results never wears a verdict it did not give; `grounding` is "
    "belegt when a cited passage states it, abgeleitet when it is computed or "
    "inferred from cited values, offen when no source carries it; `reference` the document and Punkt or "
    "page the report names; `citations` the [N] numbers the report attaches to it; `comment` what "
    "qualifies the status in one sentence or null; `area` the section it belongs to or null. "
    "Keep the report's order. A report with no requirement-shaped content returns an empty list.\n"
    "\n"
)


def _user_prompt(query: str, report: str) -> str:
    return f"## Question\n{query.strip()}\n\n## Report\n{report[:_MAX_REPORT_CHARS]}"


async def extract_report_anatomy(llm: Any, query: str, report: str) -> ReportAnatomy:
    """One structured call over the finished report; never raises."""
    if llm is None or not report.strip():
        return ReportAnatomy()
    try:
        draft = await asyncio.wait_for(_ask(llm, query, report), timeout=_ANATOMY_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 — a masthead is worth less than the report
        logger.warning("Report anatomy extraction failed (non-fatal): %s", type(exc).__name__)
        return ReportAnatomy(failed=True)
    if draft is None:
        return ReportAnatomy(failed=True)
    return ReportAnatomy(answer_meta=_gated_meta(draft, report), findings=_findings(draft))


async def _ask(llm: Any, query: str, report: str) -> ReportAnatomyDraft | None:
    from aiq_agent.common.llm_factory import strict_json_response_format

    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=_user_prompt(query, report))]
    try:
        bound = llm.bind(response_format=strict_json_response_format(ReportAnatomyDraft))
        response = await bound.ainvoke(messages)
    except Exception:  # noqa: BLE001 — a provider without strict mode answers plain JSON
        response = await llm.ainvoke(messages)
    text = response.content if isinstance(response.content, str) else json.dumps(response.content)
    return _parse(text)


def _parse(text: str) -> ReportAnatomyDraft | None:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        stripped = stripped[4:] if stripped.startswith("json") else stripped
    try:
        return ReportAnatomyDraft.model_validate(json.loads(stripped))
    except (ValueError, TypeError) as exc:
        logger.warning("Report anatomy did not parse: %s", type(exc).__name__)
        return None


def _gated_meta(draft: ReportAnatomyDraft, report: str) -> dict[str, Any] | None:
    payload: dict[str, Any] = {
        "kind": draft.kind,
        "summary": draft.summary,
        "topic": draft.topic,
        "context": draft.context,
        "takeaways": [t.model_dump() for t in draft.takeaways] or None,
        "callout": draft.callout.model_dump() if draft.callout else None,
    }
    if draft.kind == "ruling" and draft.verdict is not None:
        verdict = draft.verdict.model_dump()
        reference = verdict.pop("reference")
        if reference:
            verdict["reference"] = {"document": reference["document"], "section": reference.get("section")}
        payload["verdict"] = verdict
    try:
        meta = AnswerMeta.model_validate({k: v for k, v in payload.items() if v is not None})
    except ValueError as exc:
        logger.info("Report anatomy failed the envelope's validation: %s", exc)
        return None
    return gate_answer_meta(meta, prose_chars=len(report))


def _findings(draft: ReportAnatomyDraft) -> dict[str, Any] | None:
    return sanitize_findings({"items": [f.model_dump() for f in draft.findings]})

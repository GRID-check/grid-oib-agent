"""German Markdown rendering for an assembled ``ComplianceMatrix`` (Stage 3, no LLM)."""

from __future__ import annotations

from datetime import datetime

from .models import UNJUDGED_STATUS
from .models import ComplianceMatrix
from .models import GapItem

_STATUS_LABELS: dict[str, str] = {
    "erfuellt": "Erfuellt",
    "teilweise": "Teilweise erfuellt",
    "nicht_erfuellt": "Nicht erfuellt",
    "kein_nachweis": "Kein Nachweis",
    UNJUDGED_STATUS: "Nicht geprueft",
}

_CONFIDENCE_LABELS: dict[str, str] = {"high": "hoch", "medium": "mittel", "low": "niedrig"}


def _status_label(status: str) -> str:
    return _STATUS_LABELS.get(status, status)


def _summary(matrix: ComplianceMatrix) -> list[str]:
    if not matrix.status_counts:
        return []
    counts = ", ".join(f"{_status_label(status)}: {count}" for status, count in sorted(matrix.status_counts.items()))
    return [f"**Zusammenfassung:** {counts}", ""]


def _notices(matrix: ComplianceMatrix) -> list[str]:
    if not matrix.notices:
        return []
    return ["## Hinweise", "", *(f"- {notice}" for notice in matrix.notices), ""]


def _matrix_table(matrix: ComplianceMatrix) -> list[str]:
    header = [
        "| Richtlinie | Punkt | Anforderung | Status | Konfidenz | Nachweis |",
        "|---|---|---|---|---|---|",
    ]
    if not matrix.findings:
        return [*header, "| - | - | *Keine bewerteten Anforderungen* | - | - | - |"]
    rows = []
    for row in matrix.findings:
        quotes = "; ".join(row.evidence_quotes) if row.evidence_quotes else "-"
        sources = ", ".join(row.source_files)
        nachweis = f"{quotes} ({sources})" if sources else quotes
        requirement = row.requirement.replace("|", "\\|")
        rows.append(
            f"| {row.richtlinie} | {row.punkt} | {requirement} | "
            f"{_status_label(row.status)} | {row.confidence} | {nachweis} |"
        )
    return [*header, *rows]


def _gap_line(gap: GapItem) -> str:
    confidence = _CONFIDENCE_LABELS.get(gap.confidence, gap.confidence)
    return (
        f"- **[{_status_label(gap.status)}, Konfidenz {confidence}]** "
        f"OIB-Richtlinie {gap.richtlinie}, Punkt {gap.punkt} -- {gap.requirement}. {gap.rationale}"
    )


def _gap_list(matrix: ComplianceMatrix) -> list[str]:
    if not matrix.gaps:
        return ["Keine offenen Luecken identifiziert."]
    return [_gap_line(gap) for gap in matrix.gaps]


def _open_questions_list(matrix: ComplianceMatrix) -> list[str]:
    if not matrix.open_questions:
        return ["Keine offenen Fragen."]
    return [f"- {question}" for question in matrix.open_questions]


def _not_applicable_list(matrix: ComplianceMatrix) -> list[str]:
    if not matrix.not_applicable:
        return []
    items = [f"- OIB-Richtlinie {r.richtlinie}, Punkt {r.punkt}: {r.rationale}" for r in matrix.not_applicable]
    return ["", "## Nicht anwendbare Anforderungen", "", *items]


def render_compliance_report(matrix: ComplianceMatrix, *, generated_at: datetime) -> str:
    """Render the assembled matrix as a German Markdown compliance report."""
    generated = generated_at.strftime("%Y-%m-%d %H:%M UTC")
    richtlinien = ", ".join(str(r) for r in matrix.richtlinien)
    lines = [
        "# OIB-Compliance-Check: Soll-Ist-Abgleich",
        "",
        f"*Erstellt: {generated} | Geprueft: OIB-Richtlinien {richtlinien}*",
        "",
        *_summary(matrix),
        *_notices(matrix),
        "## Compliance-Matrix",
        "",
        *_matrix_table(matrix),
        "",
        "## Risikogewichtete Lueckenliste",
        "",
        *_gap_list(matrix),
        "",
        "## Offene Fragen",
        "",
        *_open_questions_list(matrix),
        *_not_applicable_list(matrix),
    ]
    return "\n".join(lines) + "\n"

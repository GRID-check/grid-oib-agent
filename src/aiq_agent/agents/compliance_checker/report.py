"""Deterministic German Markdown rendering for the assembled ComplianceMatrix.

Stage 3 -- pure Python, no LLM calls. See ``agent.py`` for where this is
invoked after ``_assemble_matrix``.
"""

from __future__ import annotations

from datetime import UTC
from datetime import datetime

from .models import ComplianceCheckRequest
from .models import ComplianceMatrix

_STATUS_LABELS: dict[str, str] = {
    "erfuellt": "Erfuellt",
    "teilweise": "Teilweise erfuellt",
    "nicht_erfuellt": "Nicht erfuellt",
    "kein_nachweis": "Kein Nachweis",
}

_RISK_LABELS: dict[str, str] = {
    "hoch": "Hoch",
    "mittel": "Mittel",
    "niedrig": "Niedrig",
}


def _status_label(status: str) -> str:
    return _STATUS_LABELS.get(status, status)


def _matrix_table(matrix: ComplianceMatrix) -> list[str]:
    lines = [
        "| Richtlinie | Punkt | Anforderung | Status | Konfidenz | Nachweis |",
        "|---|---|---|---|---|---|",
    ]
    if not matrix.findings:
        lines.append("| - | - | *Keine bewerteten Anforderungen* | - | - | - |")
        return lines
    for row in matrix.findings:
        evidence_cell = "; ".join(row.evidence_quotes) if row.evidence_quotes else "-"
        sources_cell = ", ".join(row.source_files) if row.source_files else ""
        nachweis = f"{evidence_cell} ({sources_cell})" if sources_cell else evidence_cell
        requirement_cell = row.requirement.replace("|", "\\|")
        lines.append(
            f"| {row.richtlinie} | {row.punkt} | {requirement_cell} | "
            f"{_status_label(row.status)} | {row.confidence} | {nachweis} |"
        )
    return lines


def _gap_list(matrix: ComplianceMatrix) -> list[str]:
    if not matrix.gaps:
        return ["Keine offenen Luecken identifiziert."]
    lines: list[str] = []
    for gap in matrix.gaps:
        lines.append(
            f"- **[{_RISK_LABELS.get(gap.risk_level, gap.risk_level)}, Risiko {gap.risk_score}]** "
            f"OIB-Richtlinie {gap.richtlinie}, Punkt {gap.punkt} -- {gap.requirement} "
            f"(Status: {_status_label(gap.status)}). {gap.rationale}"
        )
    return lines


def _open_questions_list(matrix: ComplianceMatrix) -> list[str]:
    if not matrix.open_questions:
        return ["Keine offenen Fragen."]
    return [f"- {question}" for question in matrix.open_questions]


def _not_applicable_list(matrix: ComplianceMatrix) -> list[str]:
    if not matrix.not_applicable:
        return []
    lines = ["", "## Nicht anwendbare Anforderungen", ""]
    for requirement in matrix.not_applicable:
        lines.append(f"- OIB-Richtlinie {requirement.richtlinie}, Punkt {requirement.punkt}: {requirement.rationale}")
    return lines


def render_compliance_report(request: ComplianceCheckRequest, matrix: ComplianceMatrix) -> str:
    """Render the assembled ComplianceMatrix as a German Markdown compliance report."""
    title = request.project_name or "OIB-Compliance-Check"
    generated = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    richtlinien_label = ", ".join(str(r) for r in request.richtlinien)

    status_summary = ", ".join(
        f"{_status_label(status)}: {count}" for status, count in sorted(matrix.status_counts.items())
    )

    lines: list[str] = [
        f"# {title}: Soll-Ist-Abgleich",
        "",
        f"*Erstellt: {generated} | Geprueft: OIB-Richtlinien {richtlinien_label}*",
        "",
    ]
    if status_summary:
        lines.append(f"**Zusammenfassung:** {status_summary}")
        lines.append("")

    lines.append("## Compliance-Matrix")
    lines.append("")
    lines.extend(_matrix_table(matrix))
    lines.append("")

    lines.append("## Risikogewichtete Lueckenliste")
    lines.append("")
    lines.extend(_gap_list(matrix))
    lines.append("")

    lines.append("## Offene Fragen")
    lines.append("")
    lines.extend(_open_questions_list(matrix))

    lines.extend(_not_applicable_list(matrix))

    return "\n".join(lines) + "\n"

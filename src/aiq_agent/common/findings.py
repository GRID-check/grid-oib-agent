"""The findings of a report: one Befund per requirement, as data.

A planning office commissions a Prüfung, not a whitepaper: which requirements
apply to this project, is each one met, where is that written, and what is
still open. The unit of that work is a *Befund*, and this module is its
contract. The deep report is extracted into a list of them after it is
written (``agents/deep_researcher/anatomy.py``); the frontend renders the list
as the Befundmatrix over the prose, mirrors this contract in
``lib/conversations/message-findings.ts``, and a committed fixture
(``tests/fixtures/findings/wire_payload.json``) pins the two to one shape.

Every string is bounded here and again on the client, because the payload
lands in message jsonb and is rendered as a table.
"""

from __future__ import annotations

from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

FINDINGS_VERSION = 1

#: Whether the requirement is met, in the reader's words on the wire.
FindingStatus = Literal["erfuellt", "nicht_erfuellt", "offen", "nicht_anwendbar"]
#: How the finding stands on its evidence: quoted from a source, derived from
#: cited values, or still without a source.
FindingGrounding = Literal["belegt", "abgeleitet", "offen"]

FINDING_STATUSES: tuple[FindingStatus, ...] = ("erfuellt", "nicht_erfuellt", "offen", "nicht_anwendbar")
FINDING_GROUNDINGS: tuple[FindingGrounding, ...] = ("belegt", "abgeleitet", "offen")

MAX_FINDINGS = 40
MAX_LABEL_CHARS = 200
MAX_VALUE_CHARS = 120
MAX_COMMENT_CHARS = 600
MAX_CITATIONS = 8


class FindingReference(BaseModel):
    """Where the requirement is written: the document, and the Punkt or page."""

    model_config = ConfigDict(extra="forbid")

    document: str = Field(min_length=1, max_length=MAX_LABEL_CHARS, description="e.g. 'OIB-Richtlinie 2'")
    section: str | None = Field(
        default=None, max_length=MAX_LABEL_CHARS, description="e.g. 'Pkt. 3.1.1' or 'Tabelle 1b'"
    )
    page: int | None = Field(default=None, ge=1)


class Finding(BaseModel):
    """One requirement read against the project."""

    model_config = ConfigDict(extra="forbid")

    requirement: str = Field(min_length=1, max_length=MAX_LABEL_CHARS, description="the requirement, as a noun phrase")
    value: str | None = Field(default=None, max_length=MAX_VALUE_CHARS, description="the copyable value, e.g. 'REI 60'")
    #: The verdict, when the report judged the requirement. None for a row a
    #: Vergleich or an Aktenvermerk states without judging it: the matrix is a
    #: list of Ergebnisse then, not of Befunde.
    status: FindingStatus | None = None
    grounding: FindingGrounding
    reference: FindingReference | None = None
    citations: list[int] = Field(default_factory=list, max_length=MAX_CITATIONS, description="the [N] the report cites")
    comment: str | None = Field(default=None, max_length=MAX_COMMENT_CHARS, description="what qualifies the status")
    area: str | None = Field(default=None, max_length=MAX_LABEL_CHARS, description="the section the finding belongs to")


class Findings(BaseModel):
    """The versioned wire payload: ``metadata.findings`` on a report message."""

    model_config = ConfigDict(extra="forbid")

    v: int = FINDINGS_VERSION
    items: list[Finding] = Field(min_length=1, max_length=MAX_FINDINGS)

    def counts(self) -> dict[str, int]:
        """How many findings carry each status, for the summary line."""
        return {status: sum(1 for item in self.items if item.status == status) for status in FINDING_STATUSES}

    def judged(self) -> bool:
        """Whether any row carries a verdict: Befunde then, Ergebnisse otherwise."""
        return any(item.status is not None for item in self.items)


def sanitize_findings(raw: Any) -> dict[str, Any] | None:
    """Reduce an untrusted findings payload to the contract, or ``None``.

    Fail-soft per item: a row the contract rejects is dropped, the rest stay,
    and an empty result is ``None`` rather than an empty table.
    """
    if not isinstance(raw, dict):
        return None
    items = raw.get("items")
    if not isinstance(items, list):
        return None
    kept: list[Finding] = []
    for item in items[:MAX_FINDINGS]:
        if not isinstance(item, dict):
            continue
        try:
            kept.append(Finding.model_validate(_trimmed(item)))
        except ValueError:
            continue
    if not kept:
        return None
    return Findings(items=kept).model_dump(exclude_none=True)


def _trimmed(item: dict[str, Any]) -> dict[str, Any]:
    """Cut the free text to the bounds instead of refusing the row for length."""
    out = dict(item)
    for key, limit in (
        ("requirement", MAX_LABEL_CHARS),
        ("value", MAX_VALUE_CHARS),
        ("comment", MAX_COMMENT_CHARS),
        ("area", MAX_LABEL_CHARS),
    ):
        value = out.get(key)
        if isinstance(value, str):
            value = value.strip()
            out[key] = value[:limit] if value else None
    reference = out.get("reference")
    if isinstance(reference, dict):
        ref = dict(reference)
        for key in ("document", "section"):
            value = ref.get(key)
            if isinstance(value, str):
                ref[key] = value.strip()[:MAX_LABEL_CHARS] or None
        out["reference"] = ref if ref.get("document") else None
    citations = out.get("citations")
    if isinstance(citations, list):
        out["citations"] = [n for n in citations if isinstance(n, int) and n > 0][:MAX_CITATIONS]
    else:
        out["citations"] = []
    return out

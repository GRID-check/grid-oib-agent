"""Who wrote a document, and who approved it — the metadata an ingested
agent-authored document carries, and the one place that reads it back.

A published Piloti document is EVIDENCE and it is not a NORM. Both halves have
to survive the trip from the BFF's ingest call to the sentence the model reads
and the chip the architect sees, and nothing already in the pipeline can carry
them:

- ``doc_class`` cannot. It is a closed nine-value vocabulary describing a
  document's role in the NORM HIERARCHY (``document_classification.py``), it is
  human-set, and its fail-open lane is ``baurecht_basis`` — "Basisdokument", in
  law blue. Adding ``agent_authored`` to it would file authorship under the
  hierarchy of authority, where a missing value reads as a weak norm rather
  than as an unknown author.
- The SHELF cannot. A published Piloti document sits on the project or the
  Archiv shelf like every other document there, because that is where it IS.

So authorship travels as its OWN axis, in four chunk-metadata keys the BFF
stamps at ingest and this module parses back:

===================  ==========================================================
``authored_by``      ``"agent"`` for a document Piloti wrote. Anything else —
                     a missing key included — is a human document and gets no
                     provenance at all: :func:`parse_agent_provenance` returns
                     ``None`` and every reader is byte-for-byte unchanged.
``approved_by``      The DISPLAY NAME of the person who approved it. A
                     published version cannot exist without one (the lifecycle
                     CHECK), but this parser never assumes it arrived.
``approved_at``      ISO date/timestamp of that approval.
``producer``         The producer id the filing path stamped in the bytes —
                     which pipeline wrote the document.
===================  ==========================================================

Two consumers, and the split between them is the point: the KEYS travel as
data (Trace-Lanes, the wire), and the GERMAN LINE
(:func:`provenance_label`) is rendering — built here once so the grounding
block, the fan-out and any later surface say the same sentence.

The gate that keeps such a document from becoming the Fundstelle of a verdict
is ``common/answer_envelope._gate_verdict``; the lane and label are in
``common/source_kinds.py``. See
``docs/architecture/agent-document-provenance.md``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date

from aiq_agent.common.source_kinds import AGENT_AUTHORED_LANE_LABEL

#: Chunk/document metadata keys. Spelled once, because the BFF writes them and
#: this module reads them and a typo on either side is silent.
KEY_AUTHORED_BY = "authored_by"
KEY_APPROVED_BY = "approved_by"
KEY_APPROVED_AT = "approved_at"
KEY_PRODUCER = "producer"

#: The one value of ``authored_by`` that means "Piloti wrote this". A closed
#: vocabulary of one: every other value, and the absence of the key, is a human
#: document. Fails CLOSED in the safe direction — an unrecognised author never
#: acquires the agent's restrictions, and never loses them either, because the
#: restriction only ever attaches to this exact token.
AGENT_AUTHOR = "agent"


@dataclass(frozen=True)
class AgentProvenance:
    """The provenance of ONE agent-authored, human-approved document.

    Field names are the metadata keys, so ``dataclasses.asdict`` round-trips
    through the session-registry cache and back through
    :func:`parse_agent_provenance` unchanged.
    """

    authored_by: str = AGENT_AUTHOR
    approved_by: str | None = None
    approved_at: str | None = None
    producer: str | None = None


def _text(value: object) -> str | None:
    """A non-empty stripped string, or ``None``. Tolerates any wire value."""
    if not isinstance(value, str):
        return None
    return value.strip() or None


def is_agent_author(value: object) -> bool:
    """Whether a raw ``authored_by`` value means "Piloti wrote this"."""
    return (_text(value) or "").lower() == AGENT_AUTHOR


def is_agent_authored(metadata: object) -> bool:
    """Whether ``metadata`` states that an agent authored this document."""
    if not isinstance(metadata, Mapping):
        return False
    return is_agent_author(metadata.get(KEY_AUTHORED_BY))


def parse_agent_provenance(metadata: object) -> AgentProvenance | None:
    """The agent provenance stated by ``metadata``; ``None`` when there is none.

    Tolerates absence in every direction: a missing mapping, a missing
    ``authored_by``, a human author, and an agent-authored document whose
    approval fields never arrived (which the lifecycle forbids, but a parser
    that trusts a producer is a parser that raises in production).
    """
    if not isinstance(metadata, Mapping) or not is_agent_authored(metadata):
        return None
    return AgentProvenance(
        authored_by=AGENT_AUTHOR,
        approved_by=_text(metadata.get(KEY_APPROVED_BY)),
        approved_at=_text(metadata.get(KEY_APPROVED_AT)),
        producer=_text(metadata.get(KEY_PRODUCER)),
    )


def provenance_metadata(provenance: AgentProvenance) -> dict[str, str]:
    """``provenance`` back as wire metadata, empty fields dropped.

    What the Trace-Lanes fan-out carries so a later frontend can render the
    approver itself instead of parsing him out of a German sentence.
    """
    fields = {
        KEY_AUTHORED_BY: provenance.authored_by,
        KEY_APPROVED_BY: provenance.approved_by,
        KEY_APPROVED_AT: provenance.approved_at,
        KEY_PRODUCER: provenance.producer,
    }
    return {key: value for key, value in fields.items() if value}


_ISO_DATE_PREFIX_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


def german_date(value: str | None) -> str | None:
    """An ISO date (or timestamp) as ``TT.MM.JJJJ``; the raw string otherwise.

    The label this feeds is German prose the reader and the model both see, and
    ``2026-09-01`` inside it reads as a machine field rather than as a date. The
    ISO value still travels untouched as data — only the sentence is localised.
    """
    text = (value or "").strip()
    match = _ISO_DATE_PREFIX_RE.match(text)
    if not match:
        return text or None
    year, month, day = (int(part) for part in match.groups())
    try:
        date(year, month, day)
    except ValueError:
        return text
    return f"{day:02d}.{month:02d}.{year}"


def provenance_label(provenance: AgentProvenance) -> str:
    """The ONE German line that says what this document is and who cleared it.

    ``Piloti-Dokument · freigegeben von Maria Huber am 01.09.2026``. One line,
    no sentence: the grounding block is text a model copies, and a full
    sentence about approval is a sentence that ends up in an answer. Degrades
    to the bare label when the approval fields are absent — never to a
    half-clause with a hole in it.
    """
    approved_by = provenance.approved_by
    approved_at = german_date(provenance.approved_at)
    if approved_by and approved_at:
        return f"{AGENT_AUTHORED_LANE_LABEL} · freigegeben von {approved_by} am {approved_at}"
    if approved_by:
        return f"{AGENT_AUTHORED_LANE_LABEL} · freigegeben von {approved_by}"
    if approved_at:
        return f"{AGENT_AUTHORED_LANE_LABEL} · freigegeben am {approved_at}"
    return AGENT_AUTHORED_LANE_LABEL


_NON_WORD_RE = re.compile(r"[^0-9a-zäöüß]+")
_FILE_EXTENSION_RE = re.compile(r"\.[0-9a-z]{1,5}$")


def normalize_document_name(value: str | None) -> str:
    """A document name reduced to what two spellings of it share.

    Used to decide whether a verdict's ``reference.document`` — free text a
    model wrote — names a document the turn actually retrieved. Casefolded, the
    file extension dropped, every run of punctuation and whitespace collapsed
    to one space: ``"**Brandschutzkonzept Haus B.md**"`` and
    ``"Brandschutzkonzept Haus-B"`` both reduce to
    ``"brandschutzkonzept haus b"``. Returns ``""`` for nothing usable, which
    every caller must treat as "no match" rather than as a wildcard.
    """
    text = (value or "").strip().lower()
    if not text:
        return ""
    text = _FILE_EXTENSION_RE.sub("", text)
    return _NON_WORD_RE.sub(" ", text).strip()

"""A measurement as a SOURCE — the derivation trail a measured answer earns.

The agent measures a basement correctly and the Herleitungspfad shows nothing.
That is the defect this module closes, and the reason it was open is worth
stating: ``ifc_measure`` is deliberately not a data source
(:mod:`aiq_agent.agents.shallow_researcher.grounding`), so nothing it produced
ever reached the citation registry, and the Herleitung is fed from the
registry.

Which is a shame, because a measurement carries a BETTER audit trail than a
citation does. Every :class:`ifc_spatial.envelope.Answer` states the GlobalIds
the value was derived from in the order they were used, the operator expression
as "text a reviewer can read back", an absolute tolerance in the value's unit,
a provenance (``declared``/``computed``/``inferred``) and a caveat the answer is
not valid without. A citation says "this passage exists in this document"; a
measurement says "this number came from these elements by this method, ±this
much". Only the second is reproducible.

## Why this is a separate channel and not a ``SourceEntry``

``citation_grounded`` is derived from the contents of
:class:`~aiq_agent.common.citation_verification.SourceRegistry`: a non-empty
registry runs ``verify_citations``, a surviving citation sets the flag, and a
registry holding exactly ONE source triggers the single-source fallback that
sets it too. That flag is the only route to a surfaced "high", and the
normative brake in ``grounding`` is gated on its absence.

So a measurement in the registry would mean: an answer that measured a basement
and then asserted „…und erfüllt damit OIB 4 Punkt 2.1" — with no passage behind
the second half — reaches the model's own confidence on the strength of the
first. That is the laundering path four rounds of adversarial review closed,
and re-opening it through the Herleitung would be an unusually quiet way to do
it. It would also change what ``EmptySourceRegistryError`` means: a turn that
retrieved nothing and measured something would stop being a turn with no
retrieved evidence.

Hence: measurements never touch the registry. They accumulate in their own
per-turn capture log — the same ContextVar shape ``citation_verification``'s
``begin_turn_capture`` uses — and meet the retrieved sources only on the wire,
where the coarse ``kind`` is all that is left of either and the rendering
surfaces pick both up automatically (``source_kinds.MEASUREMENT_SOURCE_KIND``).

## What is and is not emitted

Exactly the values ``measure_register._measured_count`` counts as EVIDENCE:
decidable, ``declared``/``computed``, and quantity-shaped. That is not a
coincidence to be maintained by hand — it is the same predicate, applied once,
so the number of measurement cards in the Herleitung equals the count in the
result's own „Messwerte in diesem Ergebnis:" trailer, which is the number the
confidence gate stands on.

Two exclusions follow from it and both are deliberate:

- an **undecidable** answer produces no card. „Dieser Export liefert keine
  IfcSpace-Elemente" is a finding about the EXPORT, not evidence about the
  building, and a card claiming otherwise would put a source chip under an
  answer that measured nothing. The renderer still says it, in prose, where it
  reads as the remedy it is.
- an **inferred** answer produces no card, for the reason the renderer already
  gives it: „ein Vorschlag zur Bestätigung, keine Feststellung". A heuristic
  must not raise anybody's confidence, and a chip labelled „Belegt durch" is a
  confidence claim.

The German is the renderer's own. ``PROVENANCE_LABELS`` holds the same three
verbs ``measure_register._provenance_line`` puts in front of a value, and the
value/tolerance text is formatted by that module's helpers rather than re-derived
here, so a card and the sentence the agent writes about it cannot disagree.
"""

from __future__ import annotations

import contextvars
import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from aiq_agent.common.source_kinds import MEASUREMENT_SOURCE_KIND

#: The fine lane a measurement is filed under, and its German sub-label. A lane
#: is the Herleitung card's folder tab; measurements have exactly one, because
#: unlike Baurecht they carry no authority ladder to sit on.
MEASUREMENT_LANE = "messung"
MEASUREMENT_LANE_LABEL = "Modellmessung"

#: Provenance → the German verb the renderer puts in front of the value.
#: THE SAME THREE WORDS as ``measure_register._provenance_line`` — „vermutlich",
#: not „vermutet", because that is what the prose says and the card sits beside
#: the prose. ``inferred`` is mapped even though no inferred answer is emitted
#: today (see the module docstring): the mapping is what makes the renderer
#: total, so relaxing the gate later is a one-line change and not a hunt for a
#: missing word.
PROVENANCE_LABELS: dict[str, str] = {
    "declared": "deklariert",
    "computed": "gemessen",
    "inferred": "vermutlich",
}


@dataclass(frozen=True)
class MeasuredElement:
    """One element a value was derived from — a GlobalId, named where known.

    The name matters more than it looks. A reviewer who has to act on „einer
    dieser Räume ist 0,25 m hoch" needs to know WHICH, and a 22-character
    GlobalId is not something a person can carry to a CAD window.
    """

    global_id: str
    name: str | None = None
    ifc_type: str | None = None

    def to_wire(self) -> dict[str, Any]:
        payload = {"global_id": self.global_id, "name": self.name, "ifc_type": self.ifc_type}
        return {key: value for key, value in payload.items() if value}


@dataclass(frozen=True)
class MeasurementSource:
    """One measured value, with everything needed to audit it.

    Every field is copied off an :class:`ifc_spatial.envelope.Answer` or
    formatted from one by ``measure_register``; nothing here is inferred from
    the German prose around it.
    """

    #: What was measured, in the register's own vocabulary — the measure key,
    #: qualified by the element when the payload names one
    #: (``clearHeight · Keller 01``).
    headline: str
    #: The full provenance sentence the agent reads, verbatim
    #: (``_provenance_line``). The card renders its parts; this is what a
    #: reviewer compares the card against.
    statement: str
    #: ``declared`` / ``computed`` / ``inferred``, straight off the envelope.
    provenance: str
    #: The value with its unit, formatted to the tolerance's decade.
    value_text: str
    #: ``±0,005 m``, or None for a declared value (which has no measurement
    #: error, only authoring error).
    tolerance_text: str | None
    #: The operator expression, as text a reviewer can read back.
    method: str
    #: The GlobalIds the value was derived from, in the order they were used.
    elements: tuple[MeasuredElement, ...] = ()
    #: Which file this was measured in (``Haus-A.ifc (IFC4, 12.043 Bauteile)``).
    model: str | None = None
    #: A qualification the answer is not valid without. A card that drops this
    #: reports a subset as a total.
    caveat: str | None = None

    @property
    def provenance_label(self) -> str:
        """The German verb for this provenance; the raw token when unknown."""
        return PROVENANCE_LABELS.get(self.provenance, self.provenance)

    def identity(self) -> str:
        """Stable document identity for this measurement.

        Deterministic (no clock, no randomness) and derived from what the
        measurement IS — the method, the value and the elements — so the same
        measurement keys the same way across processes, and re-measuring the
        same element in a later turn folds onto one card instead of two.

        Namespaced ``measure:`` because the frontend's document identity would
        otherwise fall through to a label key, where an element named after a
        Richtlinie could collapse a measurement onto a document.
        """
        digest = hashlib.sha256(
            "\x1f".join(
                (
                    self.method,
                    self.value_text,
                    self.headline,
                    *(element.global_id for element in self.elements),
                )
            ).encode("utf-8")
        ).hexdigest()[:16]
        return f"measure:{digest}"

    def to_wire(self) -> dict[str, Any]:
        """The wire shape, alongside the retrieved sources it renders beside.

        Deliberately the same envelope ``source_entry_to_wire`` produces —
        ``document_id`` / ``title`` / ``kind`` / ``lane`` — so every surface
        that already folds wire sources into documents picks this up without
        learning a second shape. The measurement-only facts hang off one
        ``measurement`` object rather than being smeared across new top-level
        fields, so a consumer that does not know about measurements renders a
        titled, tinted card and nothing is malformed.
        """
        measurement: dict[str, Any] = {
            "provenance": self.provenance,
            "provenance_label": self.provenance_label,
            "value_text": self.value_text,
            "method": self.method,
            "statement": self.statement,
            "elements": [element.to_wire() for element in self.elements],
        }
        if self.tolerance_text:
            measurement["tolerance_text"] = self.tolerance_text
        if self.model:
            measurement["model"] = self.model
        if self.caveat:
            measurement["caveat"] = self.caveat
        return {
            "document_id": self.identity(),
            "title": self.headline,
            "content": self.statement,
            "kind": MEASUREMENT_SOURCE_KIND,
            "lane": MEASUREMENT_LANE,
            "lane_label": MEASUREMENT_LANE_LABEL,
            "source_type": "ifc_measurement",
            "tool": "ifc_measure",
            "measurement": measurement,
        }


# ---------------------------------------------------------------------------
# Per-turn capture
# ---------------------------------------------------------------------------
#
# The same ContextVar shape ``citation_verification.begin_turn_capture`` uses,
# and for the same reasons: concurrent turns must not mix, and the log is
# per-TURN rather than cumulative — a measurement taken two turns ago is not
# part of this answer's derivation.
#
# It is emphatically NOT a ``SourceRegistry`` and must never become one. See the
# module docstring.

_turn_measurements: contextvars.ContextVar[list[MeasurementSource] | None] = contextvars.ContextVar(
    "_turn_measurements", default=None
)


def begin_measurement_capture() -> contextvars.Token:
    """Start recording this turn's measurements. Pair with :func:`end_measurement_capture`."""
    return _turn_measurements.set([])


def end_measurement_capture(token: contextvars.Token) -> None:
    """Stop recording this turn's measurements."""
    _turn_measurements.reset(token)


def record_measurements(entries: Sequence[MeasurementSource]) -> None:
    """Note measurements a tool call produced. No-op when nothing is recording.

    Silent when unbound on purpose: ``measure_register._render`` is a formatting
    function called from tests, from the CLI and from paths that have no turn
    around them, and none of them should have to know this log exists.
    """
    log = _turn_measurements.get()
    if log is not None:
        log.extend(entries)


def get_measurement_captures() -> list[MeasurementSource]:
    """Distinct measurements this turn produced, in first-seen order.

    Deduplicated on :meth:`MeasurementSource.identity`, so an agent that asks
    the same question twice within a turn — which the retry-shaped tool loop
    makes routine — contributes one card, not two.
    """
    log = _turn_measurements.get()
    if not log:
        return []
    seen: set[str] = set()
    unique: list[MeasurementSource] = []
    for entry in log:
        identity = entry.identity()
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(entry)
    return unique


def measurement_sources_to_wire(entries: Sequence[MeasurementSource]) -> list[dict[str, Any]]:
    """Serialize measurements for the citation wire, skipping any that fail.

    Per-entry, mirroring the retrieved-source path: one malformed measurement
    must not zero out a turn's whole derivation trail.
    """
    out: list[dict[str, Any]] = []
    for entry in entries:
        try:
            out.append(entry.to_wire())
        except Exception:  # pragma: no cover — a frozen dataclass of strings
            continue
    return out

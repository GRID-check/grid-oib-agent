"""The answer contract — a faithful port of ``packages/ifc-spatial/src/envelope.ts``.

Every operator in this library returns an :class:`Answer`, and an ``Answer``
always says three things beyond the value itself: **how it was obtained**,
**which elements it came from**, and **whether it could be obtained at all**.

## Why this shape, and not ``float``

The consumer of this library is a language model writing a sentence that a human
being will sign. Three claims that a bare number cannot tell apart:

  - *the model says the wall is 290 mm thick* — the file declares it, and the
    claim is wrong only if the export is wrong;
  - *I measured the roof projecting 0.647 m past the facade* — geometry, true
    within a tolerance that must travel with it;
  - *this room is probably an Aufenthaltsraum* — a heuristic with a reason.

Collapsing those into one number is how a guess gets stamped. So provenance is
not optional metadata; it is the first field a caller reads, and the renderer is
expected to put a different German verb in front of each one (``deklariert`` /
``gemessen`` / ``vermutlich``).

## Undecidable is a result, not an error

``decidable=False`` means the question was well-formed and this file cannot
answer it. It carries :attr:`Answer.missing` — what would settle it — because
"the model does not publish a fire rating" is a finding about the EXPORT that
the architect can act on, while a raised exception is a finding about us.

An exception is reserved for the third case: we could not look at all. A caller
must be able to distinguish "looked, and the file cannot say" from "never
looked". See :class:`ifc_spatial.model.UnknownElementError`.

## What changes in the port, and what may not

Nothing in this module is allowed to change. The engine underneath swaps from a
WASM tessellator to IfcOpenShell/OCCT; the sentence an architect reads must not.
The only Python-specific liberty taken is that ``from`` is a keyword, so the
field is ``from_`` and serialises back to ``from`` in :func:`to_dict`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from typing import Generic
from typing import Literal
from typing import TypeVar

T = TypeVar("T")

#: How a value came to be known. The caller must render these differently.
#:
#: - ``declared``  — the file states it. Wrong only if the export is wrong.
#: - ``computed``  — derived from the file's own structure or geometry, within
#:   ``tolerance``.
#: - ``inferred``  — a heuristic. Always carries ``confidence`` and ``because``.
Provenance = Literal["declared", "computed", "inferred"]


@dataclass(frozen=True)
class MissingFact:
    """What would make an undecidable question decidable."""

    #: What is absent, in the file's own vocabulary — a property path
    #: (``Pset_WindowCommon.SillHeight``), an entity (``IfcSpace``), or a
    #: relation (``IfcRelFillsElement``).
    what: str
    #: Where it would have to appear, in words an architect can act on.
    remedy: str
    #: Elements the gap applies to, when it is not model-wide.
    elements: list[str] | None = None


@dataclass
class Answer(Generic[T]):
    """One answer, with everything needed to audit it."""

    value: T | None
    #: SI or the file's declared unit, spelled the way it should be printed.
    unit: str | None
    #: Absolute tolerance in ``unit``, for computed values. ``None`` for declared
    #: values (a declared number has no measurement error, only authoring error)
    #: and for non-numeric answers.
    tolerance: float | None
    provenance: Provenance
    #: GlobalIds the value was derived from, in the order they were used.
    from_: list[str]
    #: The operator expression, as text a reviewer can read back.
    method: str
    decidable: bool
    #: Present exactly when ``decidable`` is false.
    missing: MissingFact | None = None
    #: Present for ``inferred`` answers: 0..1, and the reasons behind it.
    confidence: float | None = None
    because: list[str] | None = None
    #: A qualification the answer is not valid without — the analogue of the
    #: truncation caveats the query layer already carries. A caller that drops
    #: this is reporting a subset as a total.
    caveat: str | None = None
    #: Set only by :func:`triangulate`: ``agree`` / ``disagree`` / ``single``.
    agreement: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """The wire shape, with ``from_`` spelled ``from`` as in the TS envelope.

        Optional fields are omitted rather than sent as ``null``, so that a
        consumer written against the TypeScript JSON cannot tell the two engines
        apart — which is the whole point of the port.
        """
        out: dict[str, Any] = {
            "value": self.value,
            "unit": self.unit,
            "tolerance": self.tolerance,
            "provenance": self.provenance,
            "from": list(self.from_),
            "method": self.method,
            "decidable": self.decidable,
        }
        if self.missing is not None:
            missing: dict[str, Any] = {"what": self.missing.what, "remedy": self.missing.remedy}
            if self.missing.elements is not None:
                missing["elements"] = list(self.missing.elements)
            out["missing"] = missing
        if self.confidence is not None:
            out["confidence"] = self.confidence
        if self.because is not None:
            out["because"] = list(self.because)
        if self.caveat is not None:
            out["caveat"] = self.caveat
        if self.agreement is not None:
            out["agreement"] = self.agreement
        return out


def declared(
    value: T,
    *,
    from_: list[str],
    method: str,
    unit: str | None = None,
    caveat: str | None = None,
) -> Answer[T]:
    """The file states it."""
    return Answer(
        value=value,
        unit=unit,
        tolerance=None,
        provenance="declared",
        from_=list(from_),
        method=method,
        decidable=True,
        caveat=caveat,
    )


def computed(
    value: T,
    *,
    from_: list[str],
    method: str,
    unit: str | None = None,
    tolerance: float | None = None,
    caveat: str | None = None,
) -> Answer[T]:
    """We worked it out, within a tolerance."""
    return Answer(
        value=value,
        unit=unit,
        tolerance=tolerance,
        provenance="computed",
        from_=list(from_),
        method=method,
        decidable=True,
        caveat=caveat,
    )


def inferred(
    value: T,
    *,
    from_: list[str],
    method: str,
    confidence: float,
    because: list[str],
    unit: str | None = None,
    caveat: str | None = None,
) -> Answer[T]:
    """A heuristic.

    ``because`` is required rather than optional: an inference whose reasons are
    invisible cannot be argued with, and this library's whole stance is that a
    reviewer must be able to disagree with it in specific terms.
    """
    return Answer(
        value=value,
        unit=unit,
        tolerance=None,
        provenance="inferred",
        from_=list(from_),
        method=method,
        decidable=True,
        confidence=confidence,
        because=list(because),
        caveat=caveat,
    )


def undecidable(
    *,
    from_: list[str],
    method: str,
    missing: MissingFact,
    provenance: Provenance = "declared",
) -> Answer[Any]:
    """Well-formed question, and this file cannot answer it.

    ``provenance`` stays meaningful here — it records which ROUTE was attempted,
    so "no declared value" and "geometry absent" are different answers to the
    reader even though both are undecidable.
    """
    return Answer(
        value=None,
        unit=None,
        tolerance=None,
        provenance=provenance,
        from_=list(from_),
        method=method,
        decidable=False,
        missing=missing,
    )


def triangulate(
    a: Answer[float],
    b: Answer[float],
    *,
    method: str = "triangulate",
    relative_tolerance: float = 0.02,
) -> Answer[float]:
    """Two independent routes to the same number, and what to say about the pair.

    Agreement raises confidence in a declared value; disagreement is a finding
    about the export — the architect's schedule and their geometry are saying
    different things, which is worth more to them than either number alone.

    ``relative_tolerance`` defaults to 2 %, the band inside which two ways of
    measuring the same room are not usefully different.

    The returned answer carries ``agreement`` ∈ {``agree``, ``disagree``,
    ``single``} in addition to the envelope's own fields.

    ## Why ``agree`` now writes a caveat too

    It only wrote one on ``disagree``. An agreeing pair came back as a bare
    ``computed``, which the renderer prints as „aus der Geometrie berechnet,
    **nicht deklariert**" — and the sample house's Bedroom
    (``3w0zWKm7n8SB1qbfwUzt0J``) declares ``BaseQuantities.NetFloorArea =
    15.41678125`` against a measured 15.4168 m². The file DOES declare it, the
    two routes agree to seven digits, and the answer said it was not declared at
    all: „declared and confirmed" and „no schedule entry exists" rendered
    identically, with the stronger of the two claims wearing the weaker one's
    sentence.

    Two independent routes agreeing is a stronger statement than either alone —
    it is the one thing that rules out both an authoring slip in the schedule and
    a tessellation problem in the body, and it is what makes a declared quantity
    quotable. So it is said, in the same place a contradiction would be said.
    """
    both = a.decidable and b.decidable and isinstance(a.value, (int, float)) and isinstance(b.value, (int, float))

    if not both:
        present = a if a.decidable else (b if b.decidable else None)
        if present is None:
            out = undecidable(
                from_=[*a.from_, *b.from_],
                method=method,
                missing=a.missing
                or b.missing
                or MissingFact(what="both routes", remedy="no route to this value in this file"),
            )
            out.agreement = "single"
            return out
        out = _copy(present)
        out.method = method
        out.agreement = "single"
        return out

    av = float(a.value)  # type: ignore[arg-type]
    bv = float(b.value)  # type: ignore[arg-type]
    scale = max(abs(av), abs(bv), 2.220446049250313e-16)
    delta = abs(av - bv) / scale

    # The COMPUTED value is reported when the two disagree. A declared quantity
    # that contradicts the geometry it is supposed to describe is the thing under
    # suspicion; the geometry is what the building will be built from.
    winner = a if delta <= relative_tolerance else (a if a.provenance == "computed" else b)

    out = _copy(winner)
    out.method = method
    out.from_ = list(dict.fromkeys([*a.from_, *b.from_]))
    out.agreement = "agree" if delta <= relative_tolerance else "disagree"
    if delta > relative_tolerance:
        verdict = (
            f"Zwei Wege zu dieser Zahl widersprechen sich: {_fmt(av)} ({a.provenance}) gegen "
            f"{_fmt(bv)} ({b.provenance}), Abweichung {delta * 100:.1f} %. "
            "Das ist ein Befund über den Export, nicht über das Gebäude."
        )
    else:
        # Named only when one side really is `declared` — `triangulate` takes any
        # two routes, and claiming a schedule entry that neither side came from
        # would be the same false-provenance error in the other direction.
        declared_side = "declared" in (a.provenance, b.provenance)
        verdict = (
            f"Zwei unabhängige Wege bestätigen diese Zahl: {_fmt(av)} ({a.provenance}) und "
            f"{_fmt(bv)} ({b.provenance}), Abweichung {delta * 100:.1f} %. "
            + (
                "Die Datei DEKLARIERT diesen Wert und die Geometrie bestätigt ihn — das ist belastbarer "
                "als jeder der beiden Wege allein."
                if declared_side
                else "Beide Wege führen zum selben Ergebnis."
            )
        )
    # Appended, never substituted: the winning answer's own caveat („Gemessene
    # Grundfläche 0 m²…", a unit conversion note) is a qualification the value is
    # not valid without, and overwriting it would drop it.
    out.caveat = f"{out.caveat} {verdict}" if out.caveat else verdict
    return out


def _copy(answer: Answer[T]) -> Answer[T]:
    return Answer(
        value=answer.value,
        unit=answer.unit,
        tolerance=answer.tolerance,
        provenance=answer.provenance,
        from_=list(answer.from_),
        method=answer.method,
        decidable=answer.decidable,
        missing=answer.missing,
        confidence=answer.confidence,
        because=list(answer.because) if answer.because is not None else None,
        caveat=answer.caveat,
        agreement=answer.agreement,
    )


def _fmt(n: float) -> str:
    if float(n).is_integer():
        return str(int(n))
    return f"{n:.3f}".rstrip("0").rstrip(".")


@dataclass(frozen=True)
class ElementRef:
    """What an element looks like when it is the ANSWER rather than the subject.

    A bare GlobalId is unusable at both ends of the pipe: an agent cannot write a
    sentence about ``3Zq7$fRxT8kOa1bC2dE3fG``, and a reviewer cannot check one.
    So every topological operator hands back the fields needed to NAME the thing
    — plus ``via``, which records how it was reached whenever the edge that
    produced it was derived rather than declared.

    ``name`` follows the TS rule: ``IfcSpace.LongName`` wins over ``Name``,
    because a space's ``Name`` is routinely a room number (``1.14``) while the
    name a person would use (``Wohnzimmer``) is in ``LongName``.
    """

    global_id: str
    ifc_type: str
    name: str | None
    kind: str
    via: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out = {
            "globalId": self.global_id,
            "ifcType": self.ifc_type,
            "name": self.name,
            "kind": self.kind,
        }
        if self.via:
            out["via"] = self.via
        return out


__all__ = [
    "Answer",
    "ElementRef",
    "MissingFact",
    "Provenance",
    "computed",
    "declared",
    "inferred",
    "triangulate",
    "undecidable",
]

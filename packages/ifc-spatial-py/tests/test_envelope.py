"""The answer contract itself — the part that must not change when the engine does.

`envelope.spec.ts` guards these same properties on the TypeScript side. They are
asserted here separately from the parity table because they are true of the
contract regardless of which file is open: a caller written against the TS JSON
must not be able to tell the two engines apart.
"""

from __future__ import annotations

import json

from ifc_spatial.envelope import MissingFact
from ifc_spatial.envelope import computed
from ifc_spatial.envelope import declared
from ifc_spatial.envelope import inferred
from ifc_spatial.envelope import triangulate
from ifc_spatial.envelope import undecidable


def test_declared_carries_no_tolerance() -> None:
    # A declared number has no measurement error, only authoring error.
    answer = declared(0.29, unit="m", from_=["wall"], method="Qto_WallBaseQuantities.Width(wall)")
    assert answer.provenance == "declared"
    assert answer.tolerance is None
    assert answer.decidable is True


def test_computed_carries_one_and_inferred_carries_reasons() -> None:
    measured = computed(1.32, unit="m", tolerance=0.005, from_=["roof", "wall"], method="overhang(roof, wall)")
    assert measured.tolerance == 0.005

    guess = inferred(
        "aufenthaltsraum",
        from_=["space"],
        method="inventory(graph, 'aufenthaltsraum')",
        confidence=0.8,
        because=["Name „Wohnen“", "24,3 m²", "Fenster an der Südfassade"],
    )
    # An inference whose reasons are invisible cannot be argued with.
    assert guess.confidence == 0.8
    assert len(guess.because) == 3
    assert guess.tolerance is None


def test_undecidable_is_a_result_and_names_what_would_settle_it() -> None:
    answer = undecidable(
        from_=["window"],
        method="sillAndHead(window)",
        provenance="computed",
        missing=MissingFact(
            what="IfcBuildingStorey.Elevation",
            remedy="Das Bauteil einem Geschoss zuordnen und die Geschosshöhe setzen.",
            elements=["window"],
        ),
    )
    assert answer.decidable is False
    assert answer.value is None
    # The provenance records which ROUTE was attempted, so "no declared value"
    # and "geometry absent" read differently even though both are undecidable.
    assert answer.provenance == "computed"
    assert answer.missing.what == "IfcBuildingStorey.Elevation"


def test_triangulate_agreeing_keeps_the_measured_route_and_says_nothing() -> None:
    measured = computed(51.9948, unit="m²", tolerance=0.52, from_=["space"], method="floorArea(space)")
    schedule = declared(51.8, unit="m²", from_=["space"], method="NetFloorArea(space)")
    answer = triangulate(measured, schedule, method="floorArea(space)")
    assert answer.agreement == "agree"
    assert answer.value == 51.9948
    # Agreement is SAID. A bare `computed` renders as „aus der Geometrie
    # berechnet, nicht deklariert" — which is false about a file that declares
    # the value, and throws away the stronger of the two claims.
    assert "bestätigen diese Zahl" in answer.caveat
    assert "DEKLARIERT" in answer.caveat


def test_triangulate_disagreeing_reports_the_geometry_and_calls_it_a_finding() -> None:
    measured = computed(51.9948, unit="m²", tolerance=0.52, from_=["space"], method="floorArea(space)")
    schedule = declared(45.0, unit="m²", from_=["space"], method="NetFloorArea(space)")
    answer = triangulate(measured, schedule, method="floorArea(space)")
    # The declared quantity is the thing under suspicion; the geometry is what
    # the building will be built from.
    assert answer.agreement == "disagree"
    assert answer.value == 51.9948
    assert "widersprechen sich" in answer.caveat
    assert "Befund über den Export" in answer.caveat
    assert "13.5 %" in answer.caveat


def test_triangulate_with_one_route_says_single_rather_than_agreeing() -> None:
    measured = computed(51.9948, unit="m²", tolerance=0.52, from_=["space"], method="floorArea(space)")
    absent = undecidable(
        from_=["space"],
        method="NetFloorArea(space)",
        missing=MissingFact(what="Qto_SpaceBaseQuantities.NetFloorArea", remedy="Mengen mitexportieren"),
    )
    answer = triangulate(measured, absent, method="floorArea(space)")
    assert answer.agreement == "single"
    assert answer.value == 51.9948

    both_absent = triangulate(absent, absent, method="floorArea(space)")
    assert both_absent.decidable is False
    assert both_absent.agreement == "single"


def test_the_wire_shape_spells_from_the_way_the_typescript_does() -> None:
    answer = computed(1.32, unit="m", tolerance=0.005, from_=["roof", "wall"], method="overhang(roof, wall)")
    wire = json.loads(json.dumps(answer.to_dict()))
    assert wire["from"] == ["roof", "wall"]
    assert "from_" not in wire
    # Absent optional fields are omitted rather than sent as null, so a consumer
    # written against the TS JSON sees the same object.
    assert set(wire) == {"value", "unit", "tolerance", "provenance", "from", "method", "decidable"}

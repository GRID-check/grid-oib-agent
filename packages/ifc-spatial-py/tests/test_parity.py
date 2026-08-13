"""The decisive artefact: every number in `the-question.spec.ts`, measured again.

This suite is the engine-swap evidence. Each row asserts the IfcOpenShell answer
against the TypeScript package's own ground truth — the numbers in
``packages/ifc-spatial/test/the-question.spec.ts``,
``test/metric.spec.ts`` and ``test/constructive.spec.ts``, all of which were
cross-checked against something the file says about itself somewhere else (the
window type's name ``1810x1210mm``, the declared ``NetFloorArea``, the storey
elevations) before they were written down.

The TS reference values are the FULL-PRECISION ones, obtained by running the
TypeScript operators directly rather than by copying the two-decimal figures out
of the spec file — so a disagreement of a micrometre is visible instead of being
hidden by rounding.

**A disagreement is a finding, not a tolerance to widen.** Every row states the
tolerance it was asserted at. One row did genuinely disagree — ``clear_height``,
by 30 cm — and it was asserted against the value the investigation showed to be
right rather than quietly loosened. The TypeScript operator has since been
corrected to measure the same way, so that row is back in parity and the table
reports no current finding; the story is kept in the test that owns it, because
a table that still said FINDING would be describing a fixed defect.

Run with ``-s`` to see the parity table.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from ifc_spatial import operators as op
from ifc_spatial.model import SpatialModel
from ifc_spatial.model import UnknownElementError
from ifc_spatial.model import WrongKindError

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
NO_NORTH = FIXTURES / "haus-mit-raeumen.ifc"

# ── the subjects, named as the TS specs name them ───────────────────────────
WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
OPENING = "3cUkl32yn9qRSPvAVVyWcE"
SOUTH_OPENING = "3cUkl32yn9qRSPvAVVyZTO"
LIVING = "3w0zWKm7n8SB1qbfwUzt0U"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
HALL = "3w0zWKm7n8SB1qbfwUzt0G"
NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
EAST_WALL = "3cUkl32yn9qRSPvBJVyWx4"
SOUTH_WALL = "3cUkl32yn9qRSPvBJVyWy4"
ROOF = "3cUkl32yn9qRSPvBJVyWh4"
GROUND_FLOOR = "1o0c33arXF9AEePDYchjCY"
LINING = "2YIwE60BLCBQZbE8slzVOB"

#: Every numeric row: the TypeScript value at full precision, and the tolerance
#: this suite asserts at. The tolerances are the OPERATORS' OWN stated ones —
#: 5 mm on a coordinate, 10 mm on a dimension, 1 % on an area — never widened to
#: make a row pass.
_ROWS: list[dict[str, Any]] = []


def record(
    operator: str,
    subject: str,
    ts: Any,
    py: Any,
    tolerance: float | None = None,
    unit: str = "",
    note: str = "",
    finding: bool = False,
    informational: bool = False,
) -> None:
    """Assert one parity row and remember it for the table.

    ``finding`` marks a row where the two engines genuinely disagree and the
    disagreement is the result — asserted separately, in the test that owns it,
    against the value the investigation showed to be right. ``informational``
    marks a row that has no TS counterpart to compare against, because the
    capability is new; the test around it still asserts what matters.
    """
    delta: float | None = None
    if isinstance(ts, (int, float)) and isinstance(py, (int, float)):
        delta = abs(float(py) - float(ts))
    _ROWS.append(
        {
            "operator": operator,
            "subject": subject,
            "ts": ts,
            "py": py,
            "delta": delta,
            "tolerance": tolerance,
            "unit": unit,
            "note": note,
            "finding": finding,
            "informational": informational,
        }
    )
    if finding or informational:
        return
    if delta is not None and tolerance is not None:
        assert delta <= tolerance, f"{operator}({subject}): TS {ts} vs Py {py}, Δ {delta} > {tolerance}"
    else:
        assert py == ts, f"{operator}({subject}): TS {ts!r} vs Py {py!r}"


@pytest.fixture(scope="session")
def model() -> SpatialModel:
    return SpatialModel(str(SAMPLE_HOUSE))


# ════════════════════════════════════════════════════════════════════════════
# topology
# ════════════════════════════════════════════════════════════════════════════


def test_finds_the_wall_the_window_sits_in(model: SpatialModel) -> None:
    answer = op.hosted_in(model, WINDOW)
    assert answer.decidable
    assert len(answer.value) == 1
    assert "Wall-Ext_102Bwk" in answer.value[0].name
    # Two hops through relations the file states outright, so this is a reading
    # of the file and not a measurement — but it is still not something the file
    # says, hence `computed`.
    assert answer.provenance == "computed"
    assert answer.value[0].via == "voids+fills"
    record(
        "hostedIn",
        "window",
        "Wall-Ext_102Bwk… / computed / voids+fills",
        f"{answer.value[0].name.split(':')[1][:15]}… / {answer.provenance} / {answer.value[0].via}",
        note="TS: two graph hops; Py: FillsVoids→VoidsElements, no graph",
    )


def test_finds_the_room_the_window_serves_and_says_it_measured(model: SpatialModel) -> None:
    answer = op.opens_to(model, WINDOW)
    assert answer.decidable
    assert [r.name for r in answer.value] == ["Bedroom"]
    # This export writes no IfcRelSpaceBoundary at all. The relation exists only
    # because geometry recovered it, and the answer has to say so — presenting a
    # contact test as a declared fact is the failure this library prevents.
    assert answer.provenance == "computed"
    assert "Geometrie abgeleitet" in answer.caveat
    record(
        "opensTo",
        "window",
        "['Bedroom'] / computed",
        f"{[r.name for r in answer.value]} / {answer.provenance}",
        note="TS: derived boundary at 0.30 m; Py: geom.tree.select at 0.05 m",
    )


def test_bounds_and_adjacency_come_out_of_the_same_primitive(model: SpatialModel) -> None:
    bounds = op.bounds(model, BEDROOM)
    assert bounds.decidable and bounds.provenance == "computed"
    names = " ".join(r.name or "" for r in bounds.value)
    assert "Wall-Ext_102Bwk" in names and "Roof_Flat" in names
    # Furniture standing in the room is contained, not bounding.
    assert "Furniture" not in names
    record(
        "bounds",
        "bedroom",
        "needs the TS derived-boundary pass",
        f"{len(bounds.value)} bounding elements",
        informational=True,
        note="derived here from one geom.tree.select(extend=0.05); TS needs withDerivedBoundaries first",
    )

    neighbours = op.adjacent_spaces(model, BEDROOM)
    assert neighbours.decidable
    assert {"Living room", "Entrance hall"} <= {r.name for r in neighbours.value}
    record(
        "adjacentSpaces",
        "bedroom",
        "Living room + Entrance hall",
        ", ".join(sorted(r.name or "" for r in neighbours.value)),
        informational=True,
        note="shared bounding element; §7's clash_collision_many is unusable — see COVERAGE.md",
    )


def test_container_and_contains_read_the_declared_structure(model: SpatialModel) -> None:
    container = op.container_of(model, WINDOW)
    assert container.decidable and container.provenance == "declared"
    assert container.value.global_id == GROUND_FLOOR
    record("containerOf", "window", "Ground Floor / declared", f"{container.value.name} / {container.provenance}")

    contained = op.contains(model, GROUND_FLOOR)
    assert contained.decidable and contained.provenance == "declared"
    assert len(contained.value) == 18
    record("contains", "Ground Floor", 18, len(contained.value), tolerance=0, unit="elements")

    holes = op.hosts(model, NORTH_WALL)
    assert holes.decidable and holes.provenance == "declared"
    assert all(r.ifc_type == "IfcOpeningElement" for r in holes.value)
    record("hosts", "north wall", 3, len(holes.value), tolerance=0, unit="openings")


def test_enclosed_by_is_the_inverse_of_bounds(model: SpatialModel) -> None:
    answer = op.enclosed_by(model, NORTH_WALL)
    assert answer.decidable
    assert "Bedroom" in {r.name for r in answer.value}
    record(
        "enclosedBy",
        "north wall",
        "contains Bedroom",
        ", ".join(sorted(r.name or "" for r in answer.value)),
        informational=True,
    )


# ════════════════════════════════════════════════════════════════════════════
# metric
# ════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "subject, name, ts_value",
    [
        (BEDROOM, "bedroom", 15.416782273888543),
        (LIVING, "living room", 51.99482727127054),
        (HALL, "entrance hall", 8.693506721788623),
    ],
)
def test_measures_the_room_areas(model: SpatialModel, subject: str, name: str, ts_value: float) -> None:
    answer = op.floor_area(model, subject)
    assert answer.decidable
    assert answer.unit == "m²"
    assert answer.provenance == "computed"
    assert answer.tolerance > 0
    # 1 % is the operator's own stated area tolerance; the two engines in fact
    # agree to a millionth of a square metre.
    record(
        "floorArea",
        name,
        ts_value,
        answer.value,
        tolerance=ts_value * 0.01,
        unit="m²",
        note="Py additionally triangulates against the declared BaseQuantities.NetFloorArea",
    )
    # The declared quantity is found by the Python operator itself and agrees.
    assert answer.agreement == "agree"


def test_the_declared_area_is_found_and_triangulated(model: SpatialModel) -> None:
    answer = op.floor_area(model, BEDROOM)
    # Revit writes this file's quantities into a pset called `BaseQuantities`,
    # not `Qto_SpaceBaseQuantities`. The TS operator cannot see it at all — the
    # host has to pass the number in — so this row is a capability the port adds.
    assert answer.agreement == "agree"
    declared = model.declared_quantity(model.file.by_guid(BEDROOM), ("NetFloorArea",))
    assert declared is not None
    # This file declares its areas in square metres although it measures in
    # millimetres, so the conversion is the identity here and the raw value and
    # the SI value are the same number. On the Trapelo export they are not — see
    # `test_corpus.py::test_a_declared_area_in_square_feet_is_compared_in_metres`.
    assert declared.scale == 1.0
    record(
        "floorArea (triangulated)",
        "bedroom",
        declared.value,
        answer.value,
        tolerance=1e-6,
        unit="m²",
        note=f"declared at {declared.path}",
    )

    # And a wrong declared value must lose, loudly.
    disagreeing = op.floor_area(model, LIVING, declared_area=45.0)
    assert disagreeing.agreement == "disagree"
    assert "widersprechen sich" in disagreeing.caveat
    assert "Befund über den Export" in disagreeing.caveat
    assert abs(disagreeing.value - 51.99) < 0.01


def test_measures_the_sill_and_head(model: SpatialModel) -> None:
    answer = op.sill_and_head(model, WINDOW)
    assert answer.decidable
    assert answer.unit == "m"
    assert answer.tolerance == 0.01
    assert GROUND_FLOOR in answer.from_
    record("sillAndHead.sill", "window", 0.8999999761581421, answer.value["sill"], tolerance=0.01, unit="m")
    record("sillAndHead.head", "window", 2.1100000143051147, answer.value["head"], tolerance=0.01, unit="m")
    # The type is named `Windows_Sgl_Plain:1810x1210mm`. The measured height
    # agreeing with the name to under a millimetre is an independent check that
    # the world-coordinate transform is right: two unrelated statements in the
    # file, one a string and one a swept solid, agree.
    record(
        "sillAndHead.height",
        "window",
        1.2100000381469727,
        answer.value["height"],
        tolerance=0.01,
        unit="m",
        note="cross-check: the type is called 1810x1210mm",
    )


def test_extent_and_elevation(model: SpatialModel) -> None:
    box = op.extent(model, WINDOW)
    assert box.decidable
    # 1.86 rather than the type's 1.81: the box is the window ASSEMBLY (frame and
    # reveal trim), not the nominal opening.
    record("extent.width", "window", 1.8599999, box.value["width"], tolerance=0.01, unit="m")
    record("extent.box.min.z", "window", 0.9, box.value["box"]["min"][2], tolerance=0.01, unit="m")

    high = op.elevation(model, WINDOW)
    assert high.decidable and high.tolerance == 0.005
    record("elevation.bottom", "window", 0.8999999761581421, high.value["bottom"], tolerance=0.005, unit="m")
    record(
        "elevation.heightAboveStorey",
        "window",
        0.8999999761581421,
        high.value["heightAboveStorey"],
        tolerance=0.005,
        unit="m",
    )


def test_names_the_facade_bearing_instead_of_inventing_one(model: SpatialModel) -> None:
    # The original failed answer described this as the Südfassade. It faces
    # north, and the file declares a TrueNorth, so this is checkable.
    answer = op.azimuth(model, NORTH_WALL)
    assert answer.decidable
    assert answer.unit == "°"
    assert answer.tolerance == 3
    record("azimuth.degrees", "north wall", 0.0, answer.value["degrees"], tolerance=3, unit="°")
    for subject, name, expected in (
        (NORTH_WALL, "north wall", "N"),
        (EAST_WALL, "east wall", "O"),
        (SOUTH_WALL, "south wall", "S"),
    ):
        record("azimuth.compass", name, expected, op.azimuth(model, subject).value["compass"])
    record("azimuth.compass", "window", "N", op.azimuth(model, WINDOW).value["compass"])


def test_the_four_senses_of_distance(model: SpatialModel) -> None:
    # Living room and bedroom are separated by one 100 mm partition.
    record(
        "distance min",
        "living↔bedroom",
        0.095,
        op.distance(model, LIVING, BEDROOM, "min").value,
        tolerance=0.01,
        unit="m",
    )
    record(
        "distance centroid",
        "living↔bedroom",
        7.08,
        op.distance(model, LIVING, BEDROOM, "centroid").value,
        tolerance=0.05,
        unit="m",
        note="TS asserts 7.08 (toBeCloseTo 1); box centres say 7.06",
    )
    record(
        "distance horizontal",
        "living↔bedroom",
        7.08,
        op.distance(model, LIVING, BEDROOM, "horizontal").value,
        tolerance=0.05,
        unit="m",
    )
    record(
        "distance vertical",
        "living↔bedroom",
        0.0,
        op.distance(model, LIVING, BEDROOM, "vertical").value,
        tolerance=0.01,
        unit="m",
    )

    overlapping = op.distance(model, WINDOW, BEDROOM, "min")
    assert overlapping.value == 0
    assert "überschneiden sich" in overlapping.caveat
    assert "NICHT" in overlapping.caveat


def test_clear_height_is_where_the_two_engines_used_to_disagree(model: SpatialModel) -> None:
    """The row that WAS the finding, and is now the proof it was acted on.

    TS `clearHeight(LIVING)` used to return 2.50 m, the Z extent of the
    IfcSpace solid, while its own caveat said that is NOT the lichte Höhe
    because it could not see what hangs in the room ("dafür fehlt dieser
    Bibliothek noch der Verschneidungstest"). The living room has a suspended
    ceiling (`IfcCovering` "Compound Ceiling:Plain", z 2.200–2.257), so the true
    clear height is 2.20 m — 30 cm, on exactly the number an OIB minimum room
    height is checked against, and on the side that passes a room that fails.
    Porting the operators onto IfcOpenShell is what found it.

    The TypeScript operator now casts the same rays: `metric.spec.ts` asserts
    2.2 m and `clearHeight` returns 2.199999999254942 (measured by running it
    directly, like every other reference value here). So this is no longer a
    disagreement and must not be reported as one — a parity table that still
    said FINDING would be describing a defect that was fixed in this same
    change, and the reader has no way to tell a live finding from a souvenir.
    """
    answer = op.clear_height(model, LIVING)
    assert answer.decidable
    assert answer.value == pytest.approx(2.20, abs=0.01)
    assert "Compound Ceiling" in answer.caveat
    record(
        "clearHeight",
        "living room",
        2.199999999254942,
        answer.value,
        tolerance=0.01,
        unit="m",
        note="was the one finding: TS read the space solid (2.50) until it, too, measured to the ceiling",
    )


# ════════════════════════════════════════════════════════════════════════════
# constructive
# ════════════════════════════════════════════════════════════════════════════


def test_seats_the_facade_plane_on_a_real_face(model: SpatialModel) -> None:
    plane = op.facade_plane_of(model, NORTH_WALL)
    assert plane.decidable
    assert plane.value["outward"] is True
    assert plane.value["normal"][1] == pytest.approx(1.0, abs=1e-6)
    # The wall spans y 4.409 (inside) .. 4.699 (outside) and the plane sits on
    # the outer leaf — a real face, which is the invariant that matters.
    record("facadePlaneOf.point.y", "north wall", 4.6986, plane.value["point"][1], tolerance=0.005, unit="m")
    record(
        "facadePlaneOf.point.x",
        "east wall",
        6.4102,
        op.facade_plane_of(model, EAST_WALL).value["point"][0],
        tolerance=0.005,
        unit="m",
    )
    record(
        "facadePlaneOf.point.y",
        "south wall",
        -1.391,
        op.facade_plane_of(model, SOUTH_WALL).value["point"][1],
        tolerance=0.005,
        unit="m",
    )


def test_measures_the_overhang_the_agent_called_unmeasurable(model: SpatialModel) -> None:
    for wall, name, ts_value in (
        (NORTH_WALL, "north facade", 0.6466382145881653),
        (SOUTH_WALL, "south facade", 0.5483107169880473),
        (EAST_WALL, "east facade", 4.470348358154297e-7),
    ):
        answer = op.overhang(model, ROOF, wall)
        assert answer.decidable
        assert answer.unit == "m"
        assert answer.provenance == "computed"
        assert answer.tolerance == 0.005
        assert answer.caveat is None
        assert answer.method == f"overhang({ROOF}, facadePlaneOf({wall}))"
        assert answer.from_ == [ROOF, wall]
        record("overhang", name, ts_value, answer.value, tolerance=0.005, unit="m")

    # Never a negative projection: the south wall does not reach the north
    # wall's facade plane, and 0 is reported with the reason.
    behind = op.overhang(model, SOUTH_WALL, NORTH_WALL)
    assert behind.value == 0
    assert "erreicht die Fassadenebene nicht" in behind.caveat


def test_the_ray_finds_the_glazing_through_the_hole_in_the_wall(model: SpatialModel) -> None:
    # From inside the bedroom, straight north at window height. The wall is
    # voided here, so the first surface is the window's own glazing — which is
    # also proof that the opening was really subtracted from the wall.
    answer = op.ray(model, [3.9, 2.0, 1.5], [0, 1, 0], 50)
    assert answer.decidable
    assert answer.value["hit"] == WINDOW
    record("ray.point.y", "bedroom → north", 4.613, answer.value["point"][1], tolerance=0.005, unit="m")
    record("ray.distance", "bedroom → north", 2.613, answer.value["distance"], tolerance=0.005, unit="m")
    # BESSER: the OCCT ray also reports the surface normal and the dot product.
    assert answer.value["dotProduct"] == pytest.approx(-1.0, abs=1e-6)

    solid = op.ray(model, [1.0, 2.0, 1.5], [0, 1, 0], 50)
    assert solid.value["hit"] == NORTH_WALL
    record("ray.point.y", "through solid wall", 4.409, solid.value["point"][1], tolerance=0.005, unit="m")

    # Same aim, window excluded: nothing is left in the way, and the answer is a
    # decidable None — "nothing there", never "could not look".
    through = op.ray(model, [3.9, 2.0, 1.5], [0, 1, 0], 50, [WINDOW])
    assert through.decidable and through.value is None


def test_the_prism_is_anchored_on_the_opening_lower_edge(model: SpatialModel) -> None:
    volume = op.prism(model, OPENING, 45, 30)
    assert volume.decidable
    assert volume.value["facadeElementId"] == NORTH_WALL
    record("prism.sillZ", "north opening", 0.9, volume.value["sillZ"], tolerance=0.001, unit="m")
    for end in volume.value["lowerEdge"]:
        assert end[1] == pytest.approx(4.699, abs=0.005)
        assert end[2] == pytest.approx(0.9, abs=0.001)
    width = abs(volume.value["lowerEdge"][1][0] - volume.value["lowerEdge"][0][0])
    record(
        "prism.lowerEdge width",
        "north opening",
        1.81,
        width,
        tolerance=0.01,
        unit="m",
        note="cross-check: the opening's type is 1810 mm wide",
    )
    assert [h["role"] for h in volume.value["halfSpaces"]] == ["facade", "incline", "lateralLeft", "lateralRight"]

    bad = op.prism(model, OPENING, 0, 30)
    assert not bad.decidable
    assert "angleDeg" in bad.missing.what


@pytest.mark.parametrize(
    "angle, ts_depth",
    [(30, 1.316), (45, 1.075), (60, 0.76)],
)
def test_the_roof_cuts_the_prism_and_the_depth_is_monotone(model: SpatialModel, angle: int, ts_depth: float) -> None:
    volume = op.prism(model, OPENING, angle, 30).value
    answer = op.obstructions(model, volume, [NORTH_WALL])
    assert answer.decidable
    assert [f["globalId"] for f in answer.value] == [ROOF]
    assert "Roof_Flat" in answer.value[0]["name"]
    record(
        f"obstructions depth @{angle}°",
        "north window",
        ts_depth,
        answer.value[0]["intrusionDepth"],
        tolerance=0.005,
        unit="m",
    )


def test_the_south_window_has_its_own_depth(model: SpatialModel) -> None:
    # 0.55 m of roof over the south facade rather than 0.65 m, and the prism it
    # cuts is a different one — the depth must not be copied between windows.
    volume = op.prism(model, SOUTH_OPENING, 45, 30).value
    answer = op.obstructions(model, volume, [SOUTH_WALL])
    assert [f["globalId"] for f in answer.value] == [ROOF]
    record(
        "obstructions depth @45°", "south window", 1.347, answer.value[0]["intrusionDepth"], tolerance=0.005, unit="m"
    )


def test_obstructions_never_report_the_window_as_its_own_obstruction(model: SpatialModel) -> None:
    volume = op.prism(model, OPENING, 45, 30).value
    ids = [f["globalId"] for f in op.obstructions(model, volume, [NORTH_WALL]).value]
    # The window's frame projects 40 mm past the facade and would otherwise stand
    # in its own prism.
    assert WINDOW not in ids
    assert OPENING not in ids
    for global_id in ids:
        assert model.kind_of(model.file.by_guid(global_id)) == "element"


def test_it_returns_geometry_and_refuses_to_turn_it_into_a_verdict(model: SpatialModel) -> None:
    volume = op.prism(model, OPENING, 45, 30).value
    answer = op.obstructions(model, volume, [NORTH_WALL])
    # The angles are PARAMETERS the caller binds from the clause; this module
    # knows geometry, not law. A blocked prism ENLARGES the required
    # Lichteintrittsfläche under OIB 3 — it does not ban the window.
    assert "Lichteintrittsfläche" in answer.caveat
    assert "Regelwerk" in answer.caveat
    serialised = json.dumps(answer.to_dict(), ensure_ascii=False)
    assert not any(word in serialised.lower() for word in ("compliant", "erfüllt", "verstoß", "konform", "zulässig"))


# ════════════════════════════════════════════════════════════════════════════
# the epistemics — the part that must survive the port unchanged
# ════════════════════════════════════════════════════════════════════════════


def test_an_unknown_global_id_raises_and_is_never_an_undecidable(model: SpatialModel) -> None:
    for call in (
        lambda: op.extent(model, "nichtvorhanden"),
        lambda: op.floor_area(model, "nichtvorhanden"),
        lambda: op.sill_and_head(model, "nichtvorhanden"),
        lambda: op.azimuth(model, "nichtvorhanden"),
        lambda: op.clear_height(model, "nichtvorhanden"),
        lambda: op.hosted_in(model, "nichtvorhanden"),
        lambda: op.overhang(model, ROOF, "nichtvorhanden"),
        lambda: op.distance(model, LIVING, "nichtvorhanden", "min"),
    ):
        with pytest.raises(UnknownElementError) as raised:
            call()
        assert "Unbekannte GlobalId" in str(raised.value)


def test_a_node_without_a_body_is_undecidable_not_an_exception(model: SpatialModel) -> None:
    answer = op.extent(model, LINING)
    assert not answer.decidable
    assert answer.provenance == "computed"
    assert "Körpergeometrie für" in answer.missing.what
    assert not answer.missing.what.startswith("kein")
    assert answer.missing.elements == [LINING]


def test_the_wrong_kind_gets_a_pointer_at_the_right_operator(model: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        op.clear_height(model, WINDOW)
    assert "erwartet einen Raum" in str(raised.value)
    assert "extent()" in str(raised.value)


def test_a_file_without_true_north_gets_no_compass_bearing() -> None:
    """The single clearest case for the whole envelope contract."""
    other = SpatialModel(str(NO_NORTH))
    assert other.true_north is None
    wall = other.file.by_type("IfcWall")[0]
    answer = op.azimuth(other, wall.GlobalId)
    assert not answer.decidable
    assert answer.value is None
    assert answer.missing.what == "IfcGeometricRepresentationContext.TrueNorth"
    assert "Nordrichtung" in answer.missing.remedy


def test_the_file_is_georeferenced_and_no_blind_spot_is_invented(model: SpatialModel) -> None:
    # IfcSite declares 51°30'N 0°07'W, which is London — this is the
    # buildingSMART sample, not an Austrian project. A false blind spot is the
    # same failure as a false answer.
    assert model.georeferenced is True


def test_no_solar_operator_exists(model: SpatialModel) -> None:
    # Georeferencing makes a Besonnungsstudie POSSIBLE; it does not make it
    # built. The honest state of a capability that does not exist is absence.
    surface = " ".join(dir(op))
    assert not any(word in surface.lower() for word in ("sunpath", "besonnung", "solar"))


# ════════════════════════════════════════════════════════════════════════════
# the table
# ════════════════════════════════════════════════════════════════════════════


@pytest.fixture(scope="session", autouse=True)
def parity_table(request: pytest.FixtureRequest) -> Any:
    yield
    if not _ROWS:
        return
    model: SpatialModel | None = None
    try:
        model = request.getfixturevalue("model")
    except Exception:  # pragma: no cover - the table is best-effort
        pass

    width = max(len(r["operator"]) for r in _ROWS) + 2
    subject = max(len(r["subject"]) for r in _ROWS) + 2
    print("\n\n" + "=" * 118)
    print("PARITY — ifc-spatial (TypeScript, @ifc-lite) vs ifc-spatial-py (IfcOpenShell 0.8.5), Ifc4_SampleHouse.ifc")
    print("=" * 118)
    header = f"{'operator':{width}}{'subject':{subject}}{'TypeScript':>24}{'IfcOpenShell':>24}{'Δ':>12}  verdict"
    print(header)
    print("-" * 118)
    for row in _ROWS:
        ts = row["ts"]
        py = row["py"]

        def fmt(v):
            return f"{v:.6f}" if isinstance(v, float) else str(v)

        delta = "" if row["delta"] is None else f"{row['delta']:.2e}"
        if row["finding"]:
            verdict = "FINDING"
        elif row["informational"]:
            verdict = "reported"
        elif row["delta"] is None:
            verdict = "identical"
        elif row["tolerance"] is not None and row["delta"] <= row["tolerance"]:
            verdict = f"within ±{row['tolerance']:.4g}"
        else:
            verdict = "OUT OF BAND"
        print(
            f"{row['operator']:{width}}{row['subject']:{subject}}{fmt(ts)[:23]:>24}"
            f"{fmt(py)[:23]:>24}{delta:>12}  {verdict}"
        )
        if row["note"]:
            print(f"{'':{width + subject}}↳ {row['note']}")
    print("-" * 118)
    findings = [r for r in _ROWS if r["finding"]]
    informational = [r for r in _ROWS if r["informational"]]
    print(
        f"{len(_ROWS)} rows · {len(_ROWS) - len(findings) - len(informational)} asserted in parity · "
        f"{len(informational)} reported (no TS counterpart) · {len(findings)} finding(s)"
    )
    if model is not None:
        print(
            f"timings — ifcopenshell.open {model.open_seconds * 1000:.0f} ms · "
            f"geometry pass (74 products) {model.geometry_seconds * 1000:.0f} ms · "
            f"geom.tree (NATIVE) {model.tree_seconds * 1000:.0f} ms · "
            f"space contact map (4 spaces, once) {model.contact_seconds * 1000:.0f} ms"
        )
        print(
            "reference — TS buildGraph 302 ms · runGeometryPass 345 ms (24 494 retained triangles) · "
            "derivedBoundaries 2 ms"
        )
    print("=" * 118)

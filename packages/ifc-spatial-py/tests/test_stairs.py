"""Stairs and ramps, against an oracle that is arithmetic rather than a rerun.

## There is no stair in this repository

Checked before anything was designed around it: ``Ifc4_SampleHouse.ifc`` contains
**no ``IfcStair``, no ``IfcStairFlight``, no ``IfcRamp``, no ``IfcRampFlight``
and no ``IfcRailing``** — it is a single-storey house, and none of the four other
fixtures has one either. So the whole module is tested against a staircase built
here, in ``tmp_path``, the same way ``test_clearance.py`` builds the two jambs of
a doorway it needs and ``test_corpus.py`` builds an export in square feet.

That is the stricter arrangement, not the weaker one. Every number below is known
on paper before the code runs:

===============================  ==============================================
Lauf 1 / Lauf 2                  9 risers × 0.180 m, Auftritt 0.270 m, 1.200 m wide
Lauf 1 declares                  ``RiserHeight = 0.170`` — 5.6 % off its own body
Treppe Süd                       risers 0.160 / 0.190 / 0.170 / 0.200 / 0.180 m
                                 → mean exactly 0.180, **spread 0.040**
Durchgangshöhe over Lauf 1       perpendicular **1.348 m**, vertical 1.645 m
Rampe Eingang                    0.300 m over 5.000 m = **6.00 %** = 1:16.7
===============================  ==============================================

The headroom figure is the one worth spelling out, because it is the whole
argument for the operator. The pitch line runs from the first nosing (0, 0.180)
to the last (2.160, 1.620); the slab overhead has its front-bottom edge at
x = 1.200, soffit 2.600. The perpendicular distance from that edge to the pitch
line is

    |1.200 · sin θ − 2.420 · cos θ| with θ = atan(0.180/0.270) = 33.690°
    = |0.6656 − 2.0136| = **1.3479 m**

and the foot of that perpendicular lands 2.340 m up a 2.596 m pitch line, i.e.
inside the flight. A vertical measurement over the same flight bottoms out at
1.645 m. Both numbers are correct; only one of them is a Durchgangshöhe.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import ifcopenshell
import numpy as np
import pytest
from ifc_spatial import stairs as st
from ifc_spatial.model import SpatialModel
from ifc_spatial.model import UnknownElementError
from ifc_spatial.model import WrongKindError

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"


def _gid(tag: str) -> str:
    """A syntactically valid 22-character GlobalId that a human can read."""
    return f"1Treppe{tag:0>15}"


STAIR_NORTH = _gid("SA")
FLIGHT_ONE = _gid("F1")
LANDING = _gid("P1")
FLIGHT_TWO = _gid("F2")
STAIR_SOUTH = _gid("SB")
STAIR_SURVEYED = _gid("SC")
STAIR_MUTE = _gid("SD")
STAIR_WEDGE = _gid("SE")
CEILING = _gid("D1")
CEILING_RAMP = _gid("D2")
RAMP_ENTRY = _gid("RA")
RAMP_ENTRY_FLIGHT = _gid("R1")
RAMP_GARAGE = _gid("RB")
RAMP_GARAGE_FLAT = _gid("R2")
RAMP_GARAGE_STEEP = _gid("R3")
WALL = _gid("W1")

#: Riser and going of the regular flights, and the pitch that follows from them.
RISER = 0.180
GOING = 0.270
PITCH = math.atan2(RISER, GOING)


# ════════════════════════════════════════════════════════════════════════════
# the fixture — a two-flight staircase, an irregular one, and two ramps
# ════════════════════════════════════════════════════════════════════════════


def _build(path: Path) -> None:
    """Write the staircase this module is tested against.

    A stair flight is authored as a **sawtooth profile extruded sideways**: the
    profile lies in the vertical plane of the run (x, z) and is swept across the
    flight's width. That is one entity per flight and it produces exactly what a
    real flight's body has — horizontal tread faces at regular heights, vertical
    risers between them — which is what the operator reads. Building it out of
    per-step boxes would have tested a mesh no exporter writes.
    """
    f = ifcopenshell.file(schema="IFC4")
    person = f.create_entity("IfcPerson", FamilyName="x")
    organisation = f.create_entity("IfcOrganization", Name="x")
    history = f.create_entity(
        "IfcOwnerHistory",
        f.create_entity("IfcPersonAndOrganization", person, organisation),
        f.create_entity("IfcApplication", organisation, "1", "x", "x"),
        ChangeAction="ADDED",
        CreationDate=0,
    )
    x_axis = f.create_entity("IfcDirection", (1.0, 0.0, 0.0))
    z_axis = f.create_entity("IfcDirection", (0.0, 0.0, 1.0))
    axes = f.create_entity("IfcAxis2Placement3D", f.create_entity("IfcCartesianPoint", (0.0, 0.0, 0.0)), z_axis, x_axis)
    radian = f.create_entity("IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN")
    # A DEGREE plane-angle unit, because `Pset_RampFlightCommon.Slope` is an
    # IfcPlaneAngleMeasure and every real exporter writes it in degrees. Reading
    # it as a raw number would make 3.43 mean 343 % instead of 6 %.
    degree = f.create_entity(
        "IfcConversionBasedUnit",
        Dimensions=f.create_entity("IfcDimensionalExponents", 0, 0, 0, 0, 0, 0, 0),
        UnitType="PLANEANGLEUNIT",
        Name="DEGREE",
        ConversionFactor=f.create_entity(
            "IfcMeasureWithUnit", f.create_entity("IfcPlaneAngleMeasure", math.pi / 180.0), radian
        ),
    )
    units = f.create_entity(
        "IfcUnitAssignment",
        (
            f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE"),
            f.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE"),
            f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE"),
            degree,
        ),
    )
    ctx = f.create_entity("IfcGeometricRepresentationContext", None, "Model", 3, 1e-5, axes, None)
    f.create_entity(
        "IfcProject",
        _gid("PR"),
        history,
        "Treppenhaus",
        RepresentationContexts=(ctx,),
        UnitsInContext=units,
    )
    placement = f.create_entity("IfcLocalPlacement", None, axes)

    def profile_body(name: str, points: list[tuple[float, float]], origin: tuple[float, float, float], width: float):
        """A profile in the vertical (x, z) plane, swept across ``width`` in −y."""
        polyline = f.create_entity(
            "IfcPolyline",
            [f.create_entity("IfcCartesianPoint", (float(a), float(b))) for a, b in [*points, points[0]]],
        )
        position = f.create_entity(
            "IfcAxis2Placement3D",
            f.create_entity("IfcCartesianPoint", (origin[0], origin[1] + width, origin[2])),
            f.create_entity("IfcDirection", (0.0, -1.0, 0.0)),
            x_axis,
        )
        solid = f.create_entity(
            "IfcExtrudedAreaSolid",
            f.create_entity("IfcArbitraryClosedProfileDef", "AREA", name, polyline),
            position,
            z_axis,
            float(width),
        )
        return f.create_entity(
            "IfcProductDefinitionShape",
            Representations=(f.create_entity("IfcShapeRepresentation", ctx, "Body", "SweptSolid", (solid,)),),
        )

    def sawtooth(risers: list[float], going: float) -> list[tuple[float, float]]:
        points = [(0.0, 0.0)]
        x = z = 0.0
        for riser in risers:
            z += riser
            points.append((x, z))
            x += going
            points.append((x, z))
        points.append((x, 0.0))
        return points

    def box(name: str, x0: float, x1: float, y0: float, y1: float, z0: float, z1: float):
        profile = f.create_entity(
            "IfcRectangleProfileDef",
            "AREA",
            name,
            f.create_entity(
                "IfcAxis2Placement2D", f.create_entity("IfcCartesianPoint", ((x0 + x1) / 2, (y0 + y1) / 2))
            ),
            x1 - x0,
            y1 - y0,
        )
        solid = f.create_entity(
            "IfcExtrudedAreaSolid",
            profile,
            f.create_entity(
                "IfcAxis2Placement3D", f.create_entity("IfcCartesianPoint", (0.0, 0.0, z0)), z_axis, x_axis
            ),
            z_axis,
            z1 - z0,
        )
        return f.create_entity(
            "IfcProductDefinitionShape",
            Representations=(f.create_entity("IfcShapeRepresentation", ctx, "Body", "SweptSolid", (solid,)),),
        )

    def pset(element: Any, name: str, values: dict[str, tuple[str, float]]) -> None:
        properties = [
            f.create_entity("IfcPropertySingleValue", key, None, f.create_entity(measure, value), None)
            for key, (measure, value) in values.items()
        ]
        f.create_entity(
            "IfcRelDefinesByProperties",
            _gid(f"X{abs(hash(name + element.GlobalId)) % 10**9}"),
            history,
            RelatedObjects=(element,),
            RelatingPropertyDefinition=f.create_entity(
                "IfcPropertySet", _gid(f"S{name[:6]}{element.GlobalId[-2:]}"), history, name, None, properties
            ),
        )

    def flight(gid: str, name: str, risers: list[float], going: float, width: float, origin, kind="IfcStairFlight"):
        return f.create_entity(
            kind,
            gid,
            history,
            name,
            ObjectPlacement=placement,
            Representation=profile_body(name, sawtooth(risers, going), origin, width),
            # The two enumerations do not share a member: a flight is STRAIGHT,
            # a stair is a STRAIGHT_RUN_STAIR.
            PredefinedType="STRAIGHT" if kind == "IfcStairFlight" else "STRAIGHT_RUN_STAIR",
        )

    # ── Treppe Nord: two regular flights with a landing between them ────────
    one = flight(FLIGHT_ONE, "Lauf 1", [RISER] * 9, GOING, 1.2, (0.0, 0.0, 0.0))
    # 0.170 against a body whose treads sit 0.180 apart: the schedule/geometry
    # conflict `envelope.triangulate` exists for, written into the fixture.
    pset(
        one,
        "Pset_StairFlightCommon",
        {
            "NumberOfRiser": ("IfcInteger", 9),
            "RiserHeight": ("IfcPositiveLengthMeasure", 0.17),
            "TreadLength": ("IfcPositiveLengthMeasure", 0.27),
        },
    )
    landing = f.create_entity(
        "IfcSlab",
        LANDING,
        history,
        "Zwischenpodest",
        ObjectPlacement=placement,
        Representation=box("Podest", 2.43, 3.63, 0.0, 1.2, 1.44, 1.62),
        PredefinedType="LANDING",
    )
    two = flight(FLIGHT_TWO, "Lauf 2", [RISER] * 9, GOING, 1.2, (3.63, 0.0, 1.62))
    north = f.create_entity(
        "IfcStair", STAIR_NORTH, history, "Treppe Nord", ObjectPlacement=placement, PredefinedType="STRAIGHT_RUN_STAIR"
    )
    f.create_entity("IfcRelAggregates", _gid("AG1"), history, RelatingObject=north, RelatedObjects=(one, landing, two))
    pset(
        north,
        "Pset_StairCommon",
        {"NumberOfRiser": ("IfcInteger", 18), "TreadLength": ("IfcPositiveLengthMeasure", 0.27)},
    )

    # The floor above, with its front edge at x = 1.200 and its soffit at 2.600 —
    # the pinch the perpendicular measurement exists to catch.
    f.create_entity(
        "IfcSlab",
        CEILING,
        history,
        "Geschossdecke über Lauf 1",
        ObjectPlacement=placement,
        Representation=box("Decke", -2.0, 1.2, -0.5, 1.7, 2.6, 2.9),
        PredefinedType="FLOOR",
    )

    # ── Treppe Süd: one monolithic IfcStair, risers deliberately unequal ────
    south = flight(
        STAIR_SOUTH,
        "Treppe Süd",
        [0.16, 0.19, 0.17, 0.20, 0.18],
        0.29,
        1.1,
        (20.0, 0.0, 0.0),
        kind="IfcStair",
    )
    # Mean of those five risers is exactly 0.180, so the declared value AGREES
    # and the stair is still not walkable. Only the spread says so.
    pset(
        south,
        "Pset_StairCommon",
        {
            "NumberOfRiser": ("IfcInteger", 5),
            "RiserHeight": ("IfcPositiveLengthMeasure", 0.18),
            "TreadLength": ("IfcPositiveLengthMeasure", 0.29),
        },
    )

    # ── a surveyed stair with a schedule and no body, and one with neither ──
    surveyed = f.create_entity("IfcStair", STAIR_SURVEYED, history, "Treppe Bestand", ObjectPlacement=placement)
    pset(
        surveyed,
        "Pset_StairCommon",
        {
            "NumberOfRiser": ("IfcInteger", 16),
            "RiserHeight": ("IfcPositiveLengthMeasure", 0.1875),
            "TreadLength": ("IfcPositiveLengthMeasure", 0.26),
        },
    )
    f.create_entity("IfcStair", STAIR_MUTE, history, "Treppe ohne Angaben", ObjectPlacement=placement)
    # A stair exported as a bare wedge: a body, no steps in it, nothing declared.
    f.create_entity(
        "IfcStair",
        STAIR_WEDGE,
        history,
        "Treppe als Keil exportiert",
        ObjectPlacement=placement,
        Representation=profile_body(
            "Keil", [(0.0, 0.0), (2.43, 1.62), (2.43, 1.42), (0.0, -0.2)], (60.0, 0.0, 0.0), 1.2
        ),
    )

    # ── ramps: one declared 6 % flight, one two-flight ramp ─────────────────
    def ramp_flight(gid: str, name: str, rise: float, run: float, width: float, origin):
        points = [(0.0, 0.0), (run, rise), (run, rise - 0.2), (0.0, -0.2)]
        return f.create_entity(
            "IfcRampFlight",
            gid,
            history,
            name,
            ObjectPlacement=placement,
            Representation=profile_body(name, points, origin, width),
            PredefinedType="STRAIGHT",
        )

    entry_flight = ramp_flight(RAMP_ENTRY_FLIGHT, "Rampenlauf Eingang", 0.3, 5.0, 1.5, (30.0, 0.0, 0.0))
    pset(
        entry_flight,
        "Pset_RampFlightCommon",
        {"Slope": ("IfcPlaneAngleMeasure", math.degrees(math.atan(0.06)))},
    )
    entry = f.create_entity(
        "IfcRamp", RAMP_ENTRY, history, "Rampe Eingang", ObjectPlacement=placement, PredefinedType="STRAIGHT_RUN_RAMP"
    )
    f.create_entity("IfcRelAggregates", _gid("AG2"), history, RelatingObject=entry, RelatedObjects=(entry_flight,))

    flat = ramp_flight(RAMP_GARAGE_FLAT, "Rampenlauf flach", 0.3, 5.0, 2.5, (40.0, 0.0, 0.0))
    steep = ramp_flight(RAMP_GARAGE_STEEP, "Rampenlauf steil", 0.3, 3.0, 2.5, (46.0, 0.0, 0.0))
    garage = f.create_entity("IfcRamp", RAMP_GARAGE, history, "Rampe Tiefgarage", ObjectPlacement=placement)
    f.create_entity("IfcRelAggregates", _gid("AG3"), history, RelatingObject=garage, RelatedObjects=(flat, steep))
    # The garage deck over the steep flight, its front edge at x = 48.000 and its
    # soffit at 2.500 — the same pinch as over Lauf 1, on a running surface
    # instead of a nosing line.
    f.create_entity(
        "IfcSlab",
        CEILING_RAMP,
        history,
        "Decke über der Rampe",
        ObjectPlacement=placement,
        Representation=box("Rampendecke", 45.5, 48.0, -0.5, 3.0, 2.5, 2.8),
        PredefinedType="FLOOR",
    )

    f.create_entity(
        "IfcWall",
        WALL,
        history,
        "Wand",
        ObjectPlacement=placement,
        Representation=box("Wand", 50.0, 54.0, 0.0, 0.3, 0.0, 2.5),
    )
    f.write(str(path))


@pytest.fixture(scope="module")
def stairs(tmp_path_factory: pytest.TempPathFactory) -> SpatialModel:
    path = tmp_path_factory.mktemp("stairs") / "treppenhaus.ifc"
    _build(path)
    return SpatialModel(str(path))


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(SAMPLE_HOUSE))


# ════════════════════════════════════════════════════════════════════════════
# the fixtures in this repository, stated rather than assumed
# ════════════════════════════════════════════════════════════════════════════


def test_the_sample_house_has_no_stair_at_all(house: SpatialModel) -> None:
    """Why this module is tested against a synthetic file, pinned so it stays true.

    If a stair is ever added to the sample house this test fails, and the failure
    is the notification that the operators can be pointed at a real export.
    """
    for kind in ("IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight"):
        assert house.file.by_type(kind) == [], kind


# ════════════════════════════════════════════════════════════════════════════
# stair_geometry — the flight
# ════════════════════════════════════════════════════════════════════════════


def test_a_regular_flight_is_measured_off_its_own_solid(stairs: SpatialModel) -> None:
    """9 risers of 0.180 m and 0.270 m of going, read from the tread faces.

    Nothing declared is involved in these three numbers: the flight's declared
    ``RiserHeight`` is 0.170 (see the next test) and the measurement does not move
    toward it.
    """
    answer = st.stair_geometry(stairs, FLIGHT_ONE)
    assert answer.decidable
    assert answer.provenance == "computed"
    value = answer.value

    assert value["riserHeight"]["measured"] == pytest.approx(RISER, abs=1e-9)
    assert value["riserHeight"]["min"] == pytest.approx(RISER, abs=1e-9)
    assert value["riserHeight"]["max"] == pytest.approx(RISER, abs=1e-9)
    assert value["riserHeight"]["spread"] == pytest.approx(0.0, abs=1e-9)
    assert value["treadDepth"]["measured"] == pytest.approx(GOING, abs=1e-9)
    assert value["risers"]["measured"] == 9
    assert value["totalRise"] == pytest.approx(9 * RISER, abs=1e-9)
    # Nine treads of 0.270 m in plan projection.
    assert value["totalGoing"] == pytest.approx(9 * GOING, abs=1e-9)


def test_the_nutzbreite_is_the_tread_surface_and_not_the_bounding_box(stairs: SpatialModel) -> None:
    """1.200 m — the number the golden benchmark's question is about.

    Measured across the tread faces, so a flight whose stringers stand outside
    the treads reports the treads. Here they coincide, and the box is the same
    1.200 m; the caveat still has to say which of the two was measured, because
    on the next file they will differ.
    """
    value = st.stair_geometry(stairs, FLIGHT_ONE).value
    assert value["clearWidth"] == pytest.approx(1.2, abs=1e-9)
    caveat = st.stair_geometry(stairs, FLIGHT_ONE).caveat
    assert "Nutzbreite" in caveat and "Rohbaulichte" in caveat


def test_a_declared_riser_height_that_contradicts_the_body_is_a_finding(stairs: SpatialModel) -> None:
    """``RiserHeight = 0.170`` over treads that sit 0.180 apart.

    The geometry wins the value — a declared quantity that contradicts the solid
    it describes is the thing under suspicion — and the disagreement travels in
    the caveat, in ``envelope.triangulate``'s own words. A reader must not be able
    to tell this finding on a riser apart from the same finding on a room area.
    """
    answer = st.stair_geometry(stairs, FLIGHT_ONE)
    block = answer.value["riserHeight"]

    assert block["declared"] == pytest.approx(0.17, abs=1e-9)
    assert block["measured"] == pytest.approx(0.18, abs=1e-9)
    assert block["agreement"] == "disagree"
    assert block["value"] == pytest.approx(0.18, abs=1e-9)
    assert "widersprechen sich" in answer.caveat
    assert "Befund über den Export" in answer.caveat

    # …and the tread length in the same pset agrees, so a disagreement is not
    # something this operator reports about every declared value it sees.
    assert answer.value["treadDepth"]["agreement"] == "agree"


def test_unequal_risers_are_reported_even_when_their_mean_is_exactly_right(stairs: SpatialModel) -> None:
    """The finding this operator exists for.

    ``Treppe Süd`` has risers of 0.160 / 0.190 / 0.170 / 0.200 / 0.180 m. Their
    mean is 0.180 to the last bit, which is exactly what the file declares — so
    every check that compares a mean against a limit passes, and the stair is a
    trip hazard. The spread is 0.040 m and it is in the answer and in the German.
    """
    answer = st.stair_geometry(stairs, STAIR_SOUTH)
    block = answer.value["riserHeight"]

    assert block["measured"] == pytest.approx(0.18, abs=1e-9)
    assert block["declared"] == pytest.approx(0.18, abs=1e-9)
    assert block["agreement"] == "agree"
    assert block["min"] == pytest.approx(0.16, abs=1e-9)
    assert block["max"] == pytest.approx(0.20, abs=1e-9)
    assert block["spread"] == pytest.approx(0.04, abs=1e-9)
    assert "nicht gleich hoch" in answer.caveat
    assert "0.160 m bis 0.200 m" in answer.caveat


def test_no_threshold_and_no_verdict_appears_anywhere_in_the_answer(stairs: SpatialModel) -> None:
    """The contract, asserted rather than trusted.

    OIB 4 names a maximum riser and a minimum width; this layer must not know
    them. A caveat that said „unzulässig" would be a Bestimmung, and the
    Bestimmung is a different layer with a different citation.
    """
    forbidden = ("erfüllt", "zulässig", "unzulässig", "Anforderung erfüllt", "compliant", "verstößt")
    for global_id in (FLIGHT_ONE, STAIR_SOUTH, STAIR_NORTH):
        answer = st.stair_geometry(stairs, global_id)
        text = (answer.caveat or "") + str(answer.value)
        for word in forbidden:
            assert word not in text, (global_id, word)


# ════════════════════════════════════════════════════════════════════════════
# stair_geometry — the assembly, and the routes without geometry
# ════════════════════════════════════════════════════════════════════════════


def test_an_assembly_pools_its_flights_and_still_lists_them_separately(stairs: SpatialModel) -> None:
    """Treppe Nord: 18 risers over two flights, and both flights still visible.

    Pooling is what makes an irregularity BETWEEN two flights findable — each one
    regular on its own, the pair unwalkable — and the per-flight breakdown is what
    lets a caller ask about one of them anyway.
    """
    answer = st.stair_geometry(stairs, STAIR_NORTH)
    value = answer.value

    assert value["risers"]["measured"] == 18
    assert value["risers"]["declared"] == 18
    assert value["risers"]["agreement"] == "agree"
    assert value["riserHeight"]["mean"] == pytest.approx(RISER, abs=1e-9)
    assert value["totalRise"] == pytest.approx(18 * RISER, abs=1e-9)
    assert value["landings"] == 1

    assert [flight["globalId"] for flight in value["flights"]] == [FLIGHT_ONE, FLIGHT_TWO]
    assert all(flight["risers"] == 9 for flight in value["flights"])


def test_a_stair_with_a_schedule_and_no_body_answers_declared_and_says_so(stairs: SpatialModel) -> None:
    """A surveyed stair in an existing building: a pset and nothing else.

    This is a real answer and it is emphatically NOT a measurement — the caveat
    has to say that the file's numbers are what somebody typed, because the one
    thing a schedule can never show is whether the risers are equal.
    """
    answer = st.stair_geometry(stairs, STAIR_SURVEYED)
    assert answer.decidable
    assert answer.provenance == "declared"
    assert answer.value["riserCount"] == 16
    assert answer.value["riserHeight"]["value"] == pytest.approx(0.1875, abs=1e-9)
    assert answer.value["totalRise"] == pytest.approx(3.0, abs=1e-9)
    assert "keinen auswertbaren Körper" in answer.caveat


def test_a_stair_with_neither_body_nor_schedule_is_undecidable_with_a_remedy(stairs: SpatialModel) -> None:
    answer = st.stair_geometry(stairs, STAIR_MUTE)
    assert answer.decidable is False
    assert answer.value is None
    assert "IfcStair" in answer.missing.what
    # The remedy is something an architect DOES in their CAD.
    assert "exportieren" in answer.missing.remedy


def test_the_operator_refuses_a_wall_and_names_the_one_that_would_answer(stairs: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        st.stair_geometry(stairs, WALL)
    assert "stairGeometry() erwartet" in str(raised.value)
    assert "IfcWall" in str(raised.value)
    assert "rampSlope()" in str(raised.value)


def test_an_unknown_global_id_raises_and_is_never_an_undecidable(stairs: SpatialModel) -> None:
    """A hallucinated id must not be reportable as „das Modell sagt dazu nichts"."""
    for operator in (st.stair_geometry, st.ramp_slope, st.headroom, st.steps_of):
        with pytest.raises(UnknownElementError):
            operator(stairs, "0erfundene0000000000id")


# ════════════════════════════════════════════════════════════════════════════
# ramp_slope
# ════════════════════════════════════════════════════════════════════════════


def test_a_six_percent_ramp_is_six_percent_and_one_to_sixteen_seven(stairs: SpatialModel) -> None:
    """0.300 m of rise over 5.000 m of run, in all three forms at once.

    A bare "6" is ambiguous between 6 %, 1:6 and 6°, and those differ by a factor
    of ten on the number a barrier-free clause turns on. So all three are present
    and the percentage is defined in the answer itself.
    """
    answer = st.ramp_slope(stairs, RAMP_ENTRY)
    assert answer.decidable
    value = answer.value

    assert value["slopePercent"] == pytest.approx(6.0, abs=1e-6)
    assert value["slopeRatio"] == pytest.approx(1 / 0.06, abs=1e-4)
    assert value["slopeRatioText"] == "1:16.7"
    assert value["slopeDegrees"] == pytest.approx(3.4336, abs=1e-3)
    assert value["rise"] == pytest.approx(0.3, abs=1e-6)
    assert value["run"] == pytest.approx(5.0, abs=1e-6)
    assert value["clearWidth"] == pytest.approx(1.5, abs=1e-6)
    assert value["definition"] == "slopePercent = Höhenunterschied / Grundrisslänge × 100"
    # rise / run reproduces the percentage — a reader can check the number.
    assert value["rise"] / value["run"] * 100 == pytest.approx(value["slopePercent"], abs=1e-9)


def test_a_declared_slope_in_degrees_is_read_through_the_files_angle_unit(stairs: SpatialModel) -> None:
    """``Pset_RampFlightCommon.Slope = 3.4336 DEGREE`` means 6 %, not 343 %.

    The property is an ``IfcPlaneAngleMeasure``, so its value is in the file's
    plane-angle unit, and this file declares DEGREE as a conversion-based unit.
    Reading the raw number would put the ramp at 343 % — and reading a radian
    file as degrees would put it at 0.1 %.
    """
    answer = st.ramp_slope(stairs, RAMP_ENTRY)
    assert answer.value["declaredSlopePercent"] == pytest.approx(6.0, abs=1e-4)
    assert answer.value["agreement"] == "agree"


def test_a_ramp_with_two_flights_reports_the_steepest_and_lists_both(stairs: SpatialModel) -> None:
    """0.300 m over 3.000 m is 10 %, and it governs the ramp it belongs to.

    Which flight answers "how steep is this ramp" is a choice about the question,
    not a verdict: nothing here knows what steep enough is.
    """
    answer = st.ramp_slope(stairs, RAMP_GARAGE)
    assert answer.value["slopePercent"] == pytest.approx(10.0, abs=1e-6)
    assert len(answer.value["flights"]) == 2
    assert sorted(round(f["slopePercent"], 6) for f in answer.value["flights"]) == [6.0, 10.0]
    assert "steilste" in answer.caveat


def test_one_ramp_flight_can_be_asked_about_on_its_own(stairs: SpatialModel) -> None:
    answer = st.ramp_slope(stairs, RAMP_GARAGE_FLAT)
    assert answer.value["slopePercent"] == pytest.approx(6.0, abs=1e-6)
    assert answer.value["clearWidth"] == pytest.approx(2.5, abs=1e-6)


def test_ramp_slope_refuses_a_stair(stairs: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        st.ramp_slope(stairs, FLIGHT_ONE)
    assert "stairGeometry()" in str(raised.value)


# ════════════════════════════════════════════════════════════════════════════
# headroom — the measurement people get wrong
# ════════════════════════════════════════════════════════════════════════════


def test_the_durchgangshoehe_is_perpendicular_to_the_pitch_and_not_vertical(stairs: SpatialModel) -> None:
    """1.348 m against 1.645 m — 27 cm of headroom that is not there.

    The expected value is arithmetic, not a rerun: the perpendicular distance
    from the slab's front-bottom edge (1.200, 2.600) to the pitch line through
    (0, 0.180) and (2.160, 1.620) is

        |1.200·sin(33.690°) − 2.420·cos(33.690°)| = 1.3479 m.

    A vertical ray from the same flight cannot get below 1.620 m, and the sampled
    vertical minimum is 1.645 m. The vertical figure is the generous one, which is
    the direction that turns a failing Durchgangshöhe into a passing one.
    """
    expected = abs(1.2 * math.sin(PITCH) - (2.6 - RISER) * math.cos(PITCH))
    assert expected == pytest.approx(1.3479, abs=1e-3)

    answer = st.headroom(stairs, FLIGHT_ONE)
    assert answer.decidable
    assert answer.value["obstructed"] is True
    assert answer.value["headroom"] == pytest.approx(expected, abs=0.005)
    assert answer.value["vertical"] == pytest.approx(1.645, abs=0.02)
    assert answer.value["vertical"] - answer.value["headroom"] > 0.25
    assert answer.value["obstructedBy"] == CEILING
    assert "senkrecht zur Lauflinie" in answer.caveat
    assert "Geschossdecke" in answer.caveat


def test_the_exact_measurement_beats_its_own_ray_sampling(stairs: SpatialModel) -> None:
    """Why the number is not read off the rays that found the obstruction.

    The tight point on this stair is the EDGE of the slab, and no ray hits an
    edge: the sampled perpendicular minimum comes out above the true clearance
    because the sample that would have hit it lies between two samples. The
    reported value is measured against the surfaces instead, so it does not
    depend on where the samples happened to fall.
    """
    value = st.headroom(stairs, FLIGHT_ONE).value
    flight = value["flights"][0]
    assert flight["sampledPerpendicular"] > flight["headroom"]
    assert flight["headroom"] == pytest.approx(value["headroom"], abs=1e-9)


def test_a_flight_with_nothing_above_it_says_so_instead_of_measuring_zero(stairs: SpatialModel) -> None:
    """Lauf 2 runs up into open air — decidable, and not a measurement of 0.

    „Nichts darüber" is a statement about the EXPORT (most often that the storey
    above is missing) and it must never be confused with a clearance of zero.
    """
    answer = st.headroom(stairs, FLIGHT_TWO)
    assert answer.decidable
    assert answer.value["obstructed"] is False
    assert answer.value["headroom"] is None
    assert answer.value["searchedTo"] == st.HEADROOM_REACH
    assert "kein Bauteil" in answer.caveat


def test_headroom_over_a_ramp_is_measured_from_its_running_surface(stairs: SpatialModel) -> None:
    """A ramp has no nosings, so the walking plane is the running surface itself.

    Same arithmetic as the stair, on a 10 % flight: the deck's front-bottom edge
    sits at (48.000, 2.500) and the running surface runs from (46.000, 0) at
    θ = atan(0.1) = 5.711°, so the clear passage is

        |2.000 · sin θ − 2.500 · cos θ| = 2.289 m

    against 2.300 m measured lotrecht. The gap is 11 mm rather than the stair's
    270 mm because a ramp is nearly flat — which is the point: the perpendicular
    and the vertical converge as the pitch goes to zero, and diverge exactly
    where a staircase lives.
    """
    answer = st.headroom(stairs, RAMP_ENTRY_FLIGHT)
    assert answer.decidable
    assert answer.value["obstructed"] is False

    pitch = math.atan(0.1)
    expected = abs(2.0 * math.sin(pitch) - 2.5 * math.cos(pitch))
    assert expected == pytest.approx(2.2886, abs=1e-3)

    steep = st.headroom(stairs, RAMP_GARAGE_STEEP)
    assert steep.value["headroom"] == pytest.approx(expected, abs=0.005)
    assert steep.value["vertical"] == pytest.approx(2.3, abs=0.02)
    assert steep.value["obstructedBy"] == CEILING_RAMP


def test_an_assembly_reports_the_tightest_of_its_flights(stairs: SpatialModel) -> None:
    """Treppe Nord: Lauf 1 is pinched, Lauf 2 is not, and the stair is as tight as Lauf 1."""
    answer = st.headroom(stairs, STAIR_NORTH)
    assert answer.value["headroom"] == pytest.approx(st.headroom(stairs, FLIGHT_ONE).value["headroom"], abs=1e-9)
    assert len(answer.value["flights"]) == 2


def test_headroom_refuses_a_wall(stairs: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        st.headroom(stairs, WALL)
    assert "clearHeight()" in str(raised.value)


# ════════════════════════════════════════════════════════════════════════════
# steps_of
# ════════════════════════════════════════════════════════════════════════════


def test_a_stair_reports_its_flights_and_the_landing_between_them(stairs: SpatialModel) -> None:
    """The decomposition OIB 4's „Steigungen je Lauf ohne Podest" needs."""
    answer = st.steps_of(stairs, STAIR_NORTH)
    assert answer.decidable
    assert answer.provenance == "declared"

    assert [ref.global_id for ref in answer.value["flights"]] == [FLIGHT_ONE, FLIGHT_TWO]
    assert [ref.global_id for ref in answer.value["landings"]] == [LANDING]
    assert answer.value["landings"][0].name == "Zwischenpodest"
    assert answer.value["risersPerFlight"][FLIGHT_ONE] == 9
    # Lauf 2 declares nothing, and a null is not a zero.
    assert answer.value["risersPerFlight"][FLIGHT_TWO] is None
    assert "stairGeometry() zählt sie am Körper nach" in answer.caveat


def test_a_landing_is_recognised_by_its_predefined_type_and_not_by_its_name(stairs: SpatialModel) -> None:
    """Renaming the slab must not change the classification.

    The name is „Podest" here, „Landing" in an English export and
    „Slab:Generic 200mm:314159" in Revit; ``PredefinedType = LANDING`` is the only
    statement the file makes that means the same thing in all three.
    """
    slab = stairs.file.by_guid(LANDING)
    original = slab.Name
    slab.Name = "Slab:Generic 200mm:314159"
    try:
        answer = st.steps_of(stairs, STAIR_NORTH)
        assert [ref.global_id for ref in answer.value["landings"]] == [LANDING]
    finally:
        slab.Name = original


def test_a_stair_without_parts_reports_the_export_and_not_the_building(stairs: SpatialModel) -> None:
    """Treppe Süd is one body with no IfcRelAggregates — Revit's normal output.

    An empty list rendered on its own reads as „diese Treppe hat keine Läufe",
    which is a claim about the building. The truth is a claim about the file, and
    the caveat has to be the one that gets rendered.
    """
    answer = st.steps_of(stairs, STAIR_SOUTH)
    assert answer.decidable
    assert answer.value["flights"] == []
    assert "nicht in Läufe gegliedert" in answer.caveat
    assert "heißt NICHT" in answer.caveat


def test_steps_of_on_a_flight_points_at_the_assembly_it_belongs_to(stairs: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        st.steps_of(stairs, FLIGHT_ONE)
    assert STAIR_NORTH in str(raised.value)


def test_a_ramp_decomposes_the_same_way_a_stair_does(stairs: SpatialModel) -> None:
    answer = st.steps_of(stairs, RAMP_GARAGE)
    assert [ref.global_id for ref in answer.value["flights"]] == [RAMP_GARAGE_FLAT, RAMP_GARAGE_STEEP]


# ════════════════════════════════════════════════════════════════════════════
# the envelope contract, on every operator at once
# ════════════════════════════════════════════════════════════════════════════


def test_every_answer_carries_its_method_its_sources_and_serialises(stairs: SpatialModel) -> None:
    """The three things an auditor reads before the value itself."""
    cases = [
        (st.stair_geometry, FLIGHT_ONE, "stairGeometry"),
        (st.ramp_slope, RAMP_ENTRY, "rampSlope"),
        (st.headroom, FLIGHT_ONE, "headroom"),
        (st.steps_of, STAIR_NORTH, "stepsOf"),
    ]
    for operator, global_id, name in cases:
        answer = operator(stairs, global_id)
        assert answer.method.startswith(f"{name}(")
        assert global_id in answer.from_
        wire = answer.to_dict()
        assert wire["decidable"] is True
        assert wire["provenance"] in ("declared", "computed", "inferred")
        assert "from" in wire and "value" not in wire.get("missing", {})


def test_measured_answers_carry_a_tolerance_and_declared_ones_do_not(stairs: SpatialModel) -> None:
    """A declared number has no measurement error, only authoring error."""
    assert st.stair_geometry(stairs, FLIGHT_ONE).tolerance is not None
    assert st.stair_geometry(stairs, STAIR_SURVEYED).tolerance is None
    assert st.steps_of(stairs, STAIR_NORTH).tolerance is None


def test_a_body_with_no_horizontal_faces_is_a_finding_and_not_an_exception(stairs: SpatialModel) -> None:
    """A "stair" whose body is a plain wedge has no treads to read.

    The ramp flight is exactly that shape — sloped top, sloped soffit, no
    horizontal face anywhere — so it stands in for a stair exported as a swept
    solid without steps. The tread reader must come back empty-handed rather than
    inventing a riser, and ``stair_geometry`` must turn that into an undecidable
    with a remedy.
    """
    assert st._read_flight(stairs, stairs.file.by_guid(RAMP_ENTRY_FLIGHT)) is None

    answer = st.stair_geometry(stairs, STAIR_WEDGE)
    assert answer.decidable is False
    assert "keine waagrechten Trittflächen" in answer.missing.what
    assert "IfcStairFlight" in answer.missing.remedy


def test_the_nosing_line_is_the_front_edge_of_each_tread(stairs: SpatialModel) -> None:
    """Not the tread centre, and not the back.

    A plane through the back of each tread sits half a going behind the nosings
    and would report a headroom too large by ``going · sin(pitch)`` ≈ 0.15 m on
    this flight — in the generous direction, again.
    """
    flight = st._read_flight(stairs, stairs.file.by_guid(FLIGHT_ONE))
    assert flight is not None
    nosings = np.asarray(flight.nosings)
    assert nosings.shape == (9, 3)
    assert nosings[0][0] == pytest.approx(0.0, abs=1e-9)
    assert nosings[0][2] == pytest.approx(RISER, abs=1e-9)
    assert nosings[-1][0] == pytest.approx(8 * GOING, abs=1e-9)
    assert nosings[-1][2] == pytest.approx(9 * RISER, abs=1e-9)


# ════════════════════════════════════════════════════════════════════════════
# units — a schedule is stated in the file's own length unit
# ════════════════════════════════════════════════════════════════════════════

#: An IFC4 stair in MILLIMETRES with a schedule and no body. Written as literal
#: STEP rather than through the API because the point of it is the unit
#: assignment, and a unit assignment is easier to read than to assemble.
_MILLIMETRE_STAIR = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('millimeter.ifc','2026-08-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,'x',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'x',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','x','x');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#6=IFCDIRECTION((1.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCCARTESIANPOINT((0.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#8,#7,#6);
#10=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#11=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#12=IFCUNITASSIGNMENT((#10,#11));
#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);
#14=IFCPROJECT('1Millimeter0000000000P',#5,'P',$,$,$,$,(#13),#12);
#20=IFCSTAIR('1Millimeter0000000000T',#5,'Treppe in Millimetern',$,$,$,$,$,$);
#21=IFCPROPERTYSINGLEVALUE('NumberOfRiser',$,IFCINTEGER(18),$);
#22=IFCPROPERTYSINGLEVALUE('RiserHeight',$,IFCPOSITIVELENGTHMEASURE(175.),$);
#23=IFCPROPERTYSINGLEVALUE('TreadLength',$,IFCPOSITIVELENGTHMEASURE(280.),$);
#24=IFCPROPERTYSET('1Millimeter0000000000S',#5,'Pset_StairCommon',$,(#21,#22,#23));
#25=IFCRELDEFINESBYPROPERTIES('1Millimeter0000000000R',#5,$,$,(#20),#24);
ENDSEC;
END-ISO-10303-21;
"""


def test_a_schedule_in_millimetres_is_read_in_metres_and_the_count_is_not(tmp_path: Path) -> None:
    """175.0 in a millimetre file is 0.175 m — and 18 risers are still 18.

    Both halves matter and they pull in opposite directions. ``RiserHeight`` is
    an ``IfcPositiveLengthMeasure`` stated in the file's own unit, so it MUST be
    converted; ``NumberOfRiser`` is an ``IfcInteger`` with no unit at all, and
    running it through the same conversion would turn 18 risers into 0.018. That
    is why the two are read by different methods — ``declared_quantity`` for the
    lengths, ``declared_property`` for the count.
    """
    path = tmp_path / "millimeter.ifc"
    path.write_text(_MILLIMETRE_STAIR)
    model = SpatialModel(str(path))

    answer = st.stair_geometry(model, "1Millimeter0000000000T")
    assert answer.provenance == "declared"
    assert answer.value["riserCount"] == 18
    assert answer.value["riserHeight"]["value"] == pytest.approx(0.175, abs=1e-9)
    assert answer.value["treadDepth"]["value"] == pytest.approx(0.28, abs=1e-9)
    assert answer.value["totalRise"] == pytest.approx(3.15, abs=1e-9)


def test_both_routes_produce_the_same_key_shape(stairs: SpatialModel) -> None:
    """A consumer must not have to know which route answered.

    The declared-only route (a surveyed stair with no body) and the measured
    route return the same keys, with the other half set to ``None``. Provenance
    already says which one ran; a ``KeyError`` is a worse way to find out.
    """
    measured = st.stair_geometry(stairs, FLIGHT_ONE).value
    schedule = st.stair_geometry(stairs, STAIR_SURVEYED).value
    assert set(schedule) == set(measured)
    for key in ("risers", "riserHeight", "treadDepth"):
        assert set(schedule[key]) <= set(measured[key]), key
        assert {"value", "measured", "declared", "declaredAs", "agreement"} <= set(schedule[key]), key

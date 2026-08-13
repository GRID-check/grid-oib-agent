"""Barrier-free clearances, against oracles that are not this code.

Four oracles, and none of them is "what the function returned last time":

1. **The fixture's own dimensions.** ``Ifc4_SampleHouse``'s bedroom measures
   4.4525 × 3.4625 m and its entrance hall 4.4525 × 1.9525 m. The largest circle
   that fits in a rectangle is its short side, so those two numbers ARE the
   expected turning circles, and they are read off ``extent()`` inside the test
   rather than pasted in. A largest circle that does not land on the room's own
   clear width means the polygon is not the room.
2. **GEOS's ``maximum_inscribed_circle``.** A Voronoi-cell search, which is a
   completely different algorithm from the erode-and-bisect in
   :func:`~ifc_spatial.accessibility._largest_circle`. Two algorithms agreeing
   on 3.4625 m is evidence; one algorithm repeating itself is not.
3. **Hand-computed synthetic geometry.** A 1.10 m corridor beside a 4.00 m room
   whose floor is 45 mm higher, a column 0.60 m in front of a door, and a window
   0.30 m above a floor that is 2.545 m above the ground outside — every one of
   those numbers is known on paper before the code runs, and the file is written
   in ``tmp_path`` with ``ifcopenshell.file()`` because no fixture in this
   repository has a step, a drop, or a room too narrow to turn in.
4. **The failures the operators exist to prevent**, asserted directly. The
   unfiltered obstacle list makes every room in the sample house measure ZERO
   free floor, because the ceiling, the roof and the upper slab each project
   over 100 % of the plan; the test asserts that the ceiling is not in the
   obstacle list AND that the free area is nearly the whole footprint, so the
   filter cannot quietly stop working.

The contract is tested as hard as the geometry: that a file with no
``IfcRailing`` produces an undecidable rather than „kein Geländer", that the two
caller-bound parameters default to ``None`` and never to an OIB number, and that
no answer any of the four operators returns contains a verdict word.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any

import ifcopenshell
import pytest
import shapely
from ifc_spatial import accessibility as ac
from ifc_spatial import clearance as cl
from ifc_spatial import operators as op
from ifc_spatial.envelope import Answer
from ifc_spatial.model import SpatialModel
from ifc_spatial.model import UnknownElementError
from ifc_spatial.model import WrongKindError

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"

BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
LIVING_ROOM = "3w0zWKm7n8SB1qbfwUzt0U"
ENTRANCE_HALL = "3w0zWKm7n8SB1qbfwUzt0G"

#: ``Doors_IntSgl:810x2110mm`` between bedroom and living room.
INTERNAL_DOOR = "3cUkl32yn9qRSPvBJVyWax"
#: ``Doors_ExtDbl_Flush:1810x2110mm`` — the entrance, with no space outside it.
EXTERNAL_DOOR = "3cUkl32yn9qRSPvBJVyWYp"
#: ``Windows_Sgl_Plain:1810x1210mm``, sill 0.900 m.
BEDROOM_WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
#: ``Compound Ceiling:Plain`` over the bedroom — 15.42 m² of plan at 2.20 m.
BEDROOM_CEILING = "3cUkl32yn9qRSPvBJVyWfk"
BEDROOM_BED = "1RS53LK$j6KOlAGwxTiY8D"
GROUND_SLAB = "3cUkl32yn9qRSPvBJVyWgQ"
ROOF = "3cUkl32yn9qRSPvBJVyWh4"

# ── the synthetic building, in metres, all of it on paper first ─────────────
#
# In plan, looking down:
#
#     x=0.00      1.10  1.30                       5.30  5.50        9.50
#      ┌───────────┐████┌──────────────────────────┐████┌─ ─ ─ ─ ─ ─ ─┐
#      │  Flur     │Wnd1│  Zimmer                  │Wnd2│  Gelände    │  y=4.00
#      │  1.10 wide│Tür │  4.00 × 4.00             │Fen.│  z = −2.50  │
#      │  ▪ Stütze │    │  Fußboden z = +0.045     │    │             │
#      └───────────┘████└──────────────────────────┘████└─ ─ ─ ─ ─ ─ ─┘  y=0.00
#
# Known before the code runs:
#   - Flur turning circle          = 1.10 m (its own width)
#   - Zimmer turning circle        = 4.00 m
#   - threshold at the door        = 0.045 m, the two floors being 0.000/0.045
#   - approach into the Flur       = 1.10 − 0.50 = 0.60 m, ended by the column
#   - approach into the Zimmer     = 5.30 − 1.30 = 4.00 m, ended by the far wall
#   - fall at the window           = 0.045 − (−2.50) = 2.545 m
#   - parapet at the window        = 0.345 − 0.045  = 0.300 m
#   - railing height (rail variant)= 0.945 − 0.045  = 0.900 m

FLUR = "0aaaaaaaaaaaaaaaaaFlur"
ZIMMER = "0aaaaaaaaaaaaaaaZimmer"
SYNTH_DOOR = "0aaaaaaaaaaaaaaaaaTuer"
SYNTH_WINDOW = "0aaaaaaaaaaaaaaaaFenst"
COLUMN = "0aaaaaaaaaaaaaaaaaSt01"
RAILING = "0aaaaaaaaaaaaaaaaaGel1"


def _write_synthetic(path: Path, *, railing: bool) -> None:
    """A two-room building with a step, a drop and an obstructed door.

    Written with ``ifcopenshell.file()`` rather than as literal STEP text
    because every solid here is one axis-aligned box and the coordinates are the
    point of the fixture: a reader has to be able to check ``0.045`` against the
    step the test asserts, and counting ``#`` numbers in a wall of SPF is not
    that.
    """
    f = ifcopenshell.file(schema="IFC4")
    org = f.create_entity("IfcOrganization", Name="Testwerk")
    person = f.create_entity("IfcPerson", FamilyName="Test")
    who = f.create_entity("IfcPersonAndOrganization", ThePerson=person, TheOrganization=org)
    app = f.create_entity(
        "IfcApplication",
        ApplicationDeveloper=org,
        Version="1",
        ApplicationFullName="test_accessibility",
        ApplicationIdentifier="test",
    )
    hist = f.create_entity(
        "IfcOwnerHistory", OwningUser=who, OwningApplication=app, ChangeAction="ADDED", CreationDate=0
    )
    z_axis = f.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
    x_axis = f.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0, 0.0))
    axes = f.create_entity(
        "IfcAxis2Placement3D",
        Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)),
        Axis=z_axis,
        RefDirection=x_axis,
    )
    units = f.create_entity(
        "IfcUnitAssignment",
        Units=[
            f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE"),
            f.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE"),
            f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE"),
        ],
    )
    ctx = f.create_entity(
        "IfcGeometricRepresentationContext",
        ContextType="Model",
        CoordinateSpaceDimension=3,
        Precision=1e-5,
        WorldCoordinateSystem=axes,
    )
    project = f.create_entity(
        "IfcProject",
        GlobalId="0aaaaaaaaaaaaaaaaaaaa0",
        OwnerHistory=hist,
        Name="Barrierefrei-Testfall",
        RepresentationContexts=[ctx],
        UnitsInContext=units,
    )
    placement = f.create_entity("IfcLocalPlacement", RelativePlacement=axes)

    def box(cls: str, gid: str, name: str, x0: float, y0: float, z0: float, x1: float, y1: float, z1: float, **extra):
        profile = f.create_entity(
            "IfcRectangleProfileDef",
            ProfileType="AREA",
            ProfileName=name,
            Position=f.create_entity(
                "IfcAxis2Placement2D",
                Location=f.create_entity("IfcCartesianPoint", Coordinates=((x0 + x1) / 2, (y0 + y1) / 2)),
            ),
            XDim=x1 - x0,
            YDim=y1 - y0,
        )
        solid = f.create_entity(
            "IfcExtrudedAreaSolid",
            SweptArea=profile,
            Position=f.create_entity(
                "IfcAxis2Placement3D",
                Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, z0)),
                Axis=z_axis,
                RefDirection=x_axis,
            ),
            ExtrudedDirection=z_axis,
            Depth=z1 - z0,
        )
        shape = f.create_entity(
            "IfcShapeRepresentation",
            ContextOfItems=ctx,
            RepresentationIdentifier="Body",
            RepresentationType="SweptSolid",
            Items=[solid],
        )
        return f.create_entity(
            cls,
            GlobalId=gid,
            OwnerHistory=hist,
            Name=name,
            ObjectPlacement=placement,
            Representation=f.create_entity("IfcProductDefinitionShape", Representations=[shape]),
            **extra,
        )

    site = f.create_entity("IfcSite", GlobalId="0aaaaaaaaaaaaaaaaaaaa1", OwnerHistory=hist, Name="Gelaende")
    building = f.create_entity("IfcBuilding", GlobalId="0aaaaaaaaaaaaaaaaaaaa2", OwnerHistory=hist, Name="Haus")
    storey = f.create_entity(
        "IfcBuildingStorey", GlobalId="0aaaaaaaaaaaaaaaaaaaa3", OwnerHistory=hist, Name="Erdgeschoss", Elevation=0.0
    )

    flur = box("IfcSpace", FLUR, "Flur", 0.0, 0.0, 0.0, 1.10, 4.0, 2.5, LongName="Flur")
    zimmer = box("IfcSpace", ZIMMER, "Zimmer", 1.30, 0.0, 0.045, 5.30, 4.0, 2.545, LongName="Zimmer")

    partition = box("IfcWall", "0aaaaaaaaaaaaaaaaaWnd1", "Trennwand", 1.10, 0.0, 0.0, 1.30, 4.0, 2.6)
    outer_wall = box("IfcWall", "0aaaaaaaaaaaaaaaaaWnd2", "Aussenwand", 5.30, 0.0, 0.045, 5.50, 4.0, 2.645)
    elements = [
        partition,
        outer_wall,
        box(
            "IfcSlab",
            "0aaaaaaaaaaaaaaaaaSlbA",
            "Rohdecke Flur",
            -0.2,
            -0.2,
            -0.2,
            1.30,
            4.2,
            0.0,
            PredefinedType="FLOOR",
        ),
        box(
            "IfcSlab",
            "0aaaaaaaaaaaaaaaaaSlbB",
            "Rohdecke Zimmer",
            1.30,
            -0.2,
            -0.2,
            5.50,
            4.2,
            0.045,
            PredefinedType="FLOOR",
        ),
        box(
            "IfcSlab",
            "0aaaaaaaaaaaaaaaaaGrnd",
            "Gelaendeplatte",
            5.50,
            -1.0,
            -2.6,
            9.5,
            5.0,
            -2.5,
            PredefinedType="BASESLAB",
        ),
        box("IfcColumn", COLUMN, "Stuetze", 0.30, 1.60, 0.0, 0.50, 2.0, 2.5),
    ]
    door = box(
        "IfcDoor", SYNTH_DOOR, "Tuer 900x2100", 1.10, 1.50, 0.0, 1.30, 2.40, 2.11, OverallHeight=2.10, OverallWidth=0.90
    )
    door_void = box("IfcOpeningElement", "0aaaaaaaaaaaaaaaaTuerO", "Tueroeffnung", 1.10, 1.50, 0.0, 1.30, 2.40, 2.10)
    window = box(
        "IfcWindow",
        SYNTH_WINDOW,
        "Fenster 1800x1200",
        5.30,
        1.0,
        0.345,
        5.50,
        2.80,
        1.545,
        OverallHeight=1.20,
        OverallWidth=1.80,
    )
    window_void = box(
        "IfcOpeningElement", "0aaaaaaaaaaaaaaaFenstO", "Fensteroeffnung", 5.30, 1.0, 0.345, 5.50, 2.80, 1.545
    )
    elements += [door, window]
    if railing:
        elements.append(
            box("IfcRailing", RAILING, "Gelaender", 5.50, 1.0, 0.045, 5.60, 2.80, 0.945, PredefinedType="BALUSTRADE")
        )

    def rel(cls: str, gid: str, **kw: Any) -> Any:
        return f.create_entity(cls, GlobalId=gid, OwnerHistory=hist, **kw)

    rel("IfcRelAggregates", "0aaaaaaaaaaaaaaaaaAg01", RelatingObject=project, RelatedObjects=[site])
    rel("IfcRelAggregates", "0aaaaaaaaaaaaaaaaaAg02", RelatingObject=site, RelatedObjects=[building])
    rel("IfcRelAggregates", "0aaaaaaaaaaaaaaaaaAg03", RelatingObject=building, RelatedObjects=[storey])
    rel("IfcRelAggregates", "0aaaaaaaaaaaaaaaaaAg04", RelatingObject=storey, RelatedObjects=[flur, zimmer])
    rel(
        "IfcRelContainedInSpatialStructure",
        "0aaaaaaaaaaaaaaaaaCt01",
        RelatedElements=elements,
        RelatingStructure=storey,
    )
    rel(
        "IfcRelVoidsElement",
        "0aaaaaaaaaaaaaaaaaVd01",
        RelatingBuildingElement=partition,
        RelatedOpeningElement=door_void,
    )
    rel("IfcRelFillsElement", "0aaaaaaaaaaaaaaaaaFl01", RelatingOpeningElement=door_void, RelatedBuildingElement=door)
    rel(
        "IfcRelVoidsElement",
        "0aaaaaaaaaaaaaaaaaVd02",
        RelatingBuildingElement=outer_wall,
        RelatedOpeningElement=window_void,
    )
    rel(
        "IfcRelFillsElement",
        "0aaaaaaaaaaaaaaaaaFl02",
        RelatingOpeningElement=window_void,
        RelatedBuildingElement=window,
    )
    f.write(str(path))


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(SAMPLE_HOUSE))


@pytest.fixture(scope="module")
def stepped(tmp_path_factory: pytest.TempPathFactory) -> SpatialModel:
    """The synthetic building WITHOUT a railing — the undecidable case."""
    path = tmp_path_factory.mktemp("accessibility") / "stufe.ifc"
    _write_synthetic(path, railing=False)
    return SpatialModel(str(path))


@pytest.fixture(scope="module")
def stepped_with_railing(tmp_path_factory: pytest.TempPathFactory) -> SpatialModel:
    """The same building with an ``IfcRailing`` standing at the window."""
    path = tmp_path_factory.mktemp("accessibility-railing") / "gelaender.ifc"
    _write_synthetic(path, railing=True)
    return SpatialModel(str(path))


def _dimensions(model: SpatialModel, global_id: str) -> tuple[float, float]:
    """The element's two plan dimensions, measured independently by ``extent()``."""
    box = op.extent(model, global_id).value
    return float(box["width"]), float(box["depth"])


# ════════════════════════════════════════════════════════════════════════════
# turning_circle — the largest circle, against the room's own clear width
# ════════════════════════════════════════════════════════════════════════════


def test_the_largest_circle_in_a_rectangular_room_is_its_own_clear_width(house: SpatialModel) -> None:
    """A rectangle's inscribed circle is its short side. That is arithmetic, not
    an expectation read off this code, and it is where the whole construction is
    checked: footprint, obstacle filter, erosion and bisection all have to be
    right for 3.4625 m to come out of a 4.4525 × 3.4625 m bedroom.
    """
    for space, expected in ((BEDROOM, min(_dimensions(house, BEDROOM))), (ENTRANCE_HALL, None)):
        answer = ac.turning_circle(house, space)
        assert answer.decidable
        short_side = expected if expected is not None else min(_dimensions(house, space))
        # The door leaf reaches a couple of centimetres into each room, so the
        # circle is allowed to be a hair under the bare rectangle — never over.
        assert answer.value["diameter"] <= short_side + 1e-6
        assert answer.value["diameter"] > short_side - 0.05


def test_the_inscribed_circle_agrees_with_geos_own_maximum_inscribed_circle(house: SpatialModel) -> None:
    """A second algorithm, not a second run.

    ``shapely.maximum_inscribed_circle`` is a Voronoi-cell search inside GEOS and
    shares no code with the erode-and-bisect here. It carries its own tolerance
    (derived from the polygon's size) and comes out a few millimetres SHORT, so
    the comparison is one-sided as well as loose: this implementation must not
    exceed GEOS by more than that tolerance, and must not fall below it at all.
    """
    for space in (BEDROOM, LIVING_ROOM, ENTRANCE_HALL):
        subject = house.file.by_guid(space)
        free = ac._free_floor(house, subject)
        assert isinstance(free, ac._FreeFloor)
        geos = 2 * float(shapely.maximum_inscribed_circle(free.fixed).length)
        mine = ac.turning_circle(house, space).value["diameter"]
        assert mine >= geos - 1e-6
        assert mine - geos < 0.01


def test_the_footprint_polygon_is_the_area_floor_area_reports(house: SpatialModel) -> None:
    """The polygon and ``floor_area`` must not drift apart.

    ``_plan_footprint`` and ``operators._footprint_area`` are the same
    projection; one returns the shape and the other the number. If they ever
    diverge, every free-floor figure in this module is measured on a room the
    rest of the library does not recognise.
    """
    for space in (BEDROOM, LIVING_ROOM, ENTRANCE_HALL):
        triangles = house.geometry(space).triangles
        assert ac._plan_footprint(triangles).area == pytest.approx(op._footprint_area(triangles), abs=1e-9)


def test_the_ceiling_and_the_roof_are_not_obstacles_on_the_floor(house: SpatialModel) -> None:
    """The failure the floor-contact rule exists to prevent, asserted directly.

    The bedroom's ceiling covering, the roof and the upper slab each project over
    100 % of its plan. Counted as obstacles they leave 0.00 m² of free floor in a
    15.42 m² room — a confident zero, which is the worst answer this library can
    produce. So they must be absent from the obstacle list AND the free area must
    still be almost the whole footprint.
    """
    answer = ac.turning_circle(house, BEDROOM)
    named = {obstacle["globalId"] for obstacle in answer.value["obstacles"]}
    assert BEDROOM_CEILING not in named
    assert ROOF not in named
    assert GROUND_SLAB not in named
    assert answer.value["freeArea"] > 0.99 * answer.value["footprintArea"]


def test_loose_furniture_is_reported_beside_the_headline_and_never_inside_it(house: SpatialModel) -> None:
    """The judgment this module is most exposed on, pinned down.

    A permit is granted on the building, so the headline counts fixed
    obstruction only; the bed and the desk shrink the bedroom's circle from
    3.46 m to under 2.6 m and that figure travels beside it, labelled, because a
    room that only turns when it is empty is a real finding.
    """
    answer = ac.turning_circle(house, BEDROOM)
    value = answer.value
    loose = [o for o in value["obstacles"] if o["zaehlt"] == "möbliert"]
    fixed = [o for o in value["obstacles"] if o["zaehlt"] == "fest"]

    assert BEDROOM_BED in {o["globalId"] for o in loose}
    assert BEDROOM_BED not in {o["globalId"] for o in fixed}
    assert value["mitMoeblierung"]["diameter"] < value["diameter"] - 0.5
    assert value["mitMoeblierung"]["freeArea"] < value["freeArea"]
    assert value["mitMoeblierung"]["pieces"] == len(loose)
    assert "IfcFurnishingElement" in value["counted"]


def test_the_reported_centre_really_is_a_centre_the_circle_fits_at(house: SpatialModel) -> None:
    """A radius without a checkable centre is not a measurement anybody can audit.

    The circle is rebuilt at the reported point, one millimetre under the
    reported radius, and must lie entirely inside the room's footprint and clear
    of every fixed obstacle's plan shadow.
    """
    answer = ac.turning_circle(house, LIVING_ROOM)
    centre_x, centre_y, centre_z = answer.value["centre"]
    circle = shapely.Point(centre_x, centre_y).buffer(answer.value["radius"] - 0.001, quad_segs=32)

    footprint = ac._plan_footprint(house.geometry(LIVING_ROOM).triangles)
    assert circle.within(footprint.buffer(1e-9))
    assert centre_z == pytest.approx(float(house.geometry(LIVING_ROOM).box[0][2]), abs=1e-6)

    for obstacle in answer.value["obstacles"]:
        if obstacle["zaehlt"] != "fest":
            continue
        shadow = ac._plan_silhouette(house.geometry(obstacle["globalId"]).triangles)
        assert circle.intersection(shadow).area <= ac.MIN_OBSTACLE_AREA


def test_a_room_too_narrow_to_turn_in_reports_the_width_it_has(stepped: SpatialModel) -> None:
    """1.10 m of corridor, and a requested 1.50 m that does not fit.

    ``fits`` is a comparison of two measured lengths — it says the circle fits on
    this geometry, not that the room complies — and the 1.50 comes from the test,
    which is standing in for the Bestimmung.
    """
    answer = ac.turning_circle(stepped, FLUR, 1.50)
    assert answer.decidable
    assert answer.value["diameter"] == pytest.approx(1.10, abs=0.002)
    assert answer.value["requested"] == {"diameter": 1.50, "fits": False, "fitsWithFurnishing": False}

    roomy = ac.turning_circle(stepped, ZIMMER, 1.50)
    assert roomy.value["diameter"] == pytest.approx(4.00, abs=0.002)
    assert roomy.value["requested"]["fits"] is True


def test_the_column_is_subtracted_and_named(stepped: SpatialModel) -> None:
    """0.20 × 0.40 m of column, 0.08 m² of it, out of 4.40 m² of corridor."""
    answer = ac.turning_circle(stepped, FLUR)
    assert answer.value["footprintArea"] == pytest.approx(4.40, abs=0.002)
    assert answer.value["freeArea"] == pytest.approx(4.32, abs=0.002)
    assert [o["globalId"] for o in answer.value["obstacles"]] == [COLUMN]
    assert answer.value["obstacles"][0]["zaehlt"] == "fest"


@pytest.mark.parametrize("bad", [0, -1.5, "1.50", None if False else float("inf"), True])
def test_a_diameter_that_is_not_a_length_is_refused_and_sent_back_to_the_clause(
    stepped: SpatialModel, bad: Any
) -> None:
    answer = ac.turning_circle(stepped, FLUR, bad)
    assert not answer.decidable
    assert "diameter" in answer.missing.what
    assert "Bestimmung" in answer.missing.remedy


def test_without_a_diameter_the_measurement_still_stands(stepped: SpatialModel) -> None:
    """The choice argued in the docstring, asserted: no parameter, no refusal.

    ``light_incidence`` must refuse without its angle because there is no prism
    to build. There IS a largest circle without a diameter, so it is measured and
    handed over, and nothing in the answer names a threshold.
    """
    answer = ac.turning_circle(stepped, FLUR)
    assert answer.decidable
    assert answer.value["diameter"] == pytest.approx(1.10, abs=0.002)
    assert answer.value["requested"] is None
    assert "1.5" not in answer.method


def test_the_two_caller_bound_parameters_are_never_defaulted_to_an_oib_number() -> None:
    """The one thing that is out of the question: an OIB value as a default."""
    assert inspect.signature(ac.turning_circle).parameters["diameter"].default is None
    assert inspect.signature(ac.balustrade_check).parameters["fall_height"].default is None


def test_turning_circle_is_aimed_at_a_room(house: SpatialModel) -> None:
    """A door is not a room, and that is the CALLER's mistake, not the export's.

    It used to come back ``decidable: false`` with a ``missing.remedy``, which
    the renderer publishes as „ein Befund über den EXPORT" — an accusation about
    a file with nothing wrong with it. It raises now; the suggestion travels in
    the message so the refusal still points at the operator that would answer.
    """
    with pytest.raises(WrongKindError) as raised:
        ac.turning_circle(house, INTERNAL_DOOR)
    assert "IfcSpace" in str(raised.value)
    assert "clearApproach" in str(raised.value)


# ════════════════════════════════════════════════════════════════════════════
# threshold_height — millimetres, and what they were measured on
# ════════════════════════════════════════════════════════════════════════════


def test_a_real_step_between_two_rooms_is_measured(stepped: SpatialModel) -> None:
    """45 mm, from floors at 0.000 and 0.045 — known before the code ran."""
    answer = ac.threshold_height(stepped, SYNTH_DOOR)
    assert answer.decidable
    assert answer.value["threshold"] == pytest.approx(0.045, abs=0.001)
    assert answer.value["thresholdMm"] == pytest.approx(45.0, abs=1.0)

    levels = sorted(side["level"] for side in answer.value["sides"])
    assert levels == pytest.approx([0.0, 0.045], abs=0.001)
    assert all(side["via"].startswith("Unterkante des Raumkörpers") for side in answer.value["sides"])


def test_a_flush_door_says_the_zero_is_about_the_rohbau(house: SpatialModel) -> None:
    """The most misleading number this module could produce, and its caveat.

    Both rooms' bodies start at z = 0.000 and the slab under them tops out at
    z = 0.000, so the measurement is 0 mm — and this file's only three
    ``IfcCovering`` are ceilings, so there is no finished floor in it at all. The
    answer has to say that the zero is about the structural slab before anybody
    quotes it as a barrier-free threshold.
    """
    answer = ac.threshold_height(house, INTERNAL_DOOR)
    assert answer.decidable
    assert answer.value["threshold"] == pytest.approx(0.0, abs=0.001)
    assert answer.value["basis"].startswith("Rohbau")
    assert answer.value["floorFinishes"] == []
    assert "FLOORING" in answer.caveat
    assert "Estrich" in answer.caveat
    assert "ROHBAU" in answer.caveat


def test_the_tolerance_is_as_coarse_as_the_step_it_is_measuring(house: SpatialModel) -> None:
    """A 10 mm tolerance on a measurement that matters at 20 mm, said out loud."""
    answer = ac.threshold_height(house, INTERNAL_DOOR)
    assert answer.tolerance == pytest.approx(op.DIMENSION_TOLERANCE)
    assert "±10 mm" in answer.caveat
    assert "NICHT zu unterscheiden" in answer.caveat


def test_an_external_door_measures_the_far_side_with_a_ray(house: SpatialModel) -> None:
    """No ``IfcSpace`` outside the entrance, so the ground is probed instead —
    and the answer says which route each side took, because "the room body says
    0.000" and "a ray 0.30 m outside found a slab at 0.000" are different claims.
    """
    answer = ac.threshold_height(house, EXTERNAL_DOOR)
    assert answer.decidable
    inside = [s for s in answer.value["sides"] if s["space"] is not None]
    outside = [s for s in answer.value["sides"] if s["space"] is None]
    assert len(inside) == 1 and len(outside) == 1
    assert inside[0]["space"] == ENTRANCE_HALL
    assert "Strahl nach unten" in outside[0]["via"]
    assert outside[0]["surface"]["globalId"] == GROUND_SLAB
    assert answer.value["threshold"] == pytest.approx(0.0, abs=0.001)


def test_the_declared_lining_threshold_is_not_folded_into_the_measurement(house: SpatialModel) -> None:
    """``ThresholdThickness`` is a board, not a level difference.

    This file carries an ``IfcDoorLiningProperties`` for each of its three doors
    and leaves every attribute of all three unset — so nothing is reported, and
    the test asserts both halves: the entities exist, and no number was invented
    from them.
    """
    assert house.file.by_type("IfcDoorLiningProperties")
    answer = ac.threshold_height(house, INTERNAL_DOOR)
    assert answer.value["declared"] == []


def test_a_window_has_no_threshold(house: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        ac.threshold_height(house, BEDROOM_WINDOW)
    assert "IfcDoor" in str(raised.value)
    assert "sillAndHead" in str(raised.value)


# ════════════════════════════════════════════════════════════════════════════
# balustrade_check — the drop, and honesty about what stands at it
# ════════════════════════════════════════════════════════════════════════════


def test_a_window_over_a_drop_is_found_with_its_fall_and_its_parapet(stepped_with_railing: SpatialModel) -> None:
    """2.545 m of fall over a 0.300 m parapet — both on paper before the run."""
    answer = ac.balustrade_check(stepped_with_railing, ZIMMER, 1.0)
    assert answer.decidable
    edges = answer.value["kanten"]
    assert [e["globalId"] for e in edges] == [SYNTH_WINDOW]
    assert edges[0]["fall"] == pytest.approx(2.545, abs=0.002)
    assert edges[0]["parapet"] == pytest.approx(0.300, abs=0.002)
    assert edges[0]["inside"]["space"] == ZIMMER
    assert edges[0]["outside"]["space"] is None


def test_a_railing_at_that_edge_is_reported_with_its_height_over_the_floor(
    stepped_with_railing: SpatialModel,
) -> None:
    """0.945 m of railing over a 0.045 m floor is 0.900 m of protection — and the
    height that matters is the one above the floor somebody stands on, not above
    the project zero.
    """
    answer = ac.balustrade_check(stepped_with_railing, ZIMMER, 1.0)
    railings = answer.value["kanten"][0]["railings"]
    assert [r["globalId"] for r in railings] == [RAILING]
    assert railings[0]["height"] == pytest.approx(0.900, abs=0.002)
    assert railings[0]["top"] == pytest.approx(0.945, abs=0.002)
    assert answer.value["railingsInModel"] == 1


def test_a_file_with_no_railings_is_undecidable_and_keeps_the_numbers(stepped: SpatialModel) -> None:
    """„kein Geländer" would be a finding about the export wearing the clothes of
    a finding about the building.

    The same 2.545 m edge, in a file that exports no ``IfcRailing`` at all. The
    answer refuses — and because an ``undecidable`` carries no value by contract,
    the measured fall and parapet are written into the German sentence rather
    than lost.
    """
    answer = ac.balustrade_check(stepped, ZIMMER, 1.0)
    assert not answer.decidable
    assert "IfcRailing" in answer.missing.what
    assert "2.545" in answer.missing.what
    assert "0.300" in answer.missing.what
    assert answer.missing.elements == [SYNTH_WINDOW]
    assert "NICHT" in answer.missing.remedy
    assert "mitexportieren" in answer.missing.remedy


def test_without_a_fall_height_nothing_is_an_edge_and_nothing_is_refused(stepped: SpatialModel) -> None:
    """No parameter, no Absturzkante — which is coherent rather than evasive.

    Whether a fall needs protecting is exactly what the parameter decides, so
    with no parameter the same file that refuses above answers freely, with the
    2.545 m sitting in plain sight under ``openings``.
    """
    answer = ac.balustrade_check(stepped, ZIMMER)
    assert answer.decidable
    assert answer.value["kanten"] == []
    assert answer.value["fallHeight"] is None
    falls = {o["globalId"]: o["fall"] for o in answer.value["openings"]}
    assert falls[SYNTH_WINDOW] == pytest.approx(2.545, abs=0.002)


def test_openings_at_grade_report_a_measured_zero_rather_than_refusing(house: SpatialModel) -> None:
    """Every opening in this ground-floor fixture stands on the ground it faces.

    A decidable empty ``kanten`` is a result — there is nothing to fall off — and
    must not be rendered as "nicht ermittelbar", even though this file has no
    railings and would refuse the moment a real edge appeared.
    """
    answer = ac.balustrade_check(house, BEDROOM, 0.50)
    assert answer.decidable
    assert answer.value["kanten"] == []
    assert answer.value["railingsInModel"] == 0
    assert {o["ifcType"] for o in answer.value["openings"]} == {"IfcDoor", "IfcWindow"}
    for opening in answer.value["openings"]:
        assert opening["fall"] == pytest.approx(0.0, abs=0.01)
    window = next(o for o in answer.value["openings"] if o["ifcType"] == "IfcWindow")
    assert window["parapet"] == pytest.approx(0.900, abs=0.01)


def test_a_single_opening_can_be_checked_directly(house: SpatialModel) -> None:
    answer = ac.balustrade_check(house, BEDROOM_WINDOW)
    assert answer.decidable
    assert [o["globalId"] for o in answer.value["openings"]] == [BEDROOM_WINDOW]


@pytest.mark.parametrize("bad", [0, -2.0, "1", float("nan")])
def test_a_fall_height_that_is_not_a_height_is_refused(house: SpatialModel, bad: Any) -> None:
    answer = ac.balustrade_check(house, BEDROOM, bad)
    assert not answer.decidable
    assert "fallHeight" in answer.missing.what
    assert "Bestimmung" in answer.missing.remedy


def test_balustrade_check_is_aimed_at_a_room_or_an_opening(house: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        ac.balustrade_check(house, GROUND_SLAB)
    assert "IfcSpace" in str(raised.value)


# ════════════════════════════════════════════════════════════════════════════
# clear_approach — the floor in front of the door, not the hole in the wall
# ════════════════════════════════════════════════════════════════════════════


def test_the_free_depth_in_front_of_a_door_is_the_room_behind_it(house: SpatialModel) -> None:
    """The bedroom side of the internal door, checked against the room's own box.

    ``6.1202 − 1.7307 = 4.3895`` m, both numbers measured by ``extent()`` in the
    test rather than pasted in. Nothing fixed stands in the way, so ``limitedBy``
    is empty — which is an answer and not a hole in one.
    """
    answer = ac.clear_approach(house, INTERNAL_DOOR)
    assert answer.decidable
    bedroom = next(s for s in answer.value["sides"] if s["space"] == BEDROOM)

    room_box = op.extent(house, BEDROOM).value["box"]
    door_box = op.extent(house, INTERNAL_DOOR).value["box"]
    expected = float(room_box["max"][0]) - float(door_box["max"][0])
    assert bedroom["depth"] == pytest.approx(expected, abs=0.005)
    assert bedroom["limitedBy"] == []
    assert bedroom["boundedByRoom"] is True

    # The living room is NOT ended by its own far wall: the curtain wall's
    # mullions stand 5 cm proud of it. Two different findings, told apart.
    living = next(s for s in answer.value["sides"] if s["space"] == LIVING_ROOM)
    assert living["boundedByRoom"] is False
    assert living["limitedBy"]


def test_the_width_measured_is_the_clear_opening_width(house: SpatialModel) -> None:
    """The strip is as wide as the aperture ``clear_opening_width`` reports —
    0.810 m for a door whose own type name is ``810x2110mm``.
    """
    answer = ac.clear_approach(house, INTERNAL_DOOR)
    assert answer.value["width"] == pytest.approx(cl.clear_opening_width(house, INTERNAL_DOOR).value["width"], abs=1e-6)
    assert answer.value["width"] == pytest.approx(0.810, abs=0.001)


def test_furniture_shortens_the_approach_and_is_named(house: SpatialModel) -> None:
    """The difference between a door you can open and a door you can open in a
    photograph: 4.39 m of bedroom becomes 2.38 m once the bed is counted.
    """
    answer = ac.clear_approach(house, INTERNAL_DOOR)
    bedroom = next(s for s in answer.value["sides"] if s["space"] == BEDROOM)
    furnished = bedroom["withFurnishing"]
    assert furnished["depth"] < bedroom["depth"] - 1.0
    assert BEDROOM_BED in {o["globalId"] for o in furnished["limitedBy"]}
    assert all(o["zaehlt"] == "möbliert" or o["zaehlt"] == "fest" for o in furnished["limitedBy"])


def test_a_column_in_front_of_a_door_ends_the_approach_where_it_stands(stepped: SpatialModel) -> None:
    """0.60 m: the corridor is 1.10 m deep and the column starts 0.50 m in."""
    answer = ac.clear_approach(stepped, SYNTH_DOOR)
    corridor = next(s for s in answer.value["sides"] if s["space"] == FLUR)
    assert corridor["depth"] == pytest.approx(0.60, abs=0.005)
    assert [o["globalId"] for o in corridor["limitedBy"]] == [COLUMN]
    assert corridor["boundedByRoom"] is False

    room = next(s for s in answer.value["sides"] if s["space"] == ZIMMER)
    assert room["depth"] == pytest.approx(4.00, abs=0.005)
    assert room["limitedBy"] == []
    assert room["boundedByRoom"] is True


def test_a_door_to_the_outside_reports_null_and_not_zero_on_the_far_side(house: SpatialModel) -> None:
    """Zero is a number an agent will put in a sentence; ``None`` with a reason
    is not.
    """
    answer = ac.clear_approach(house, EXTERNAL_DOOR)
    outside = next(s for s in answer.value["sides"] if s["space"] is None)
    assert outside["depth"] is None
    assert outside["withFurnishing"] is None
    assert "IfcSpace" in outside["because"]
    assert "IfcSpace" in answer.caveat


def test_clear_approach_is_aimed_at_an_opening(house: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        ac.clear_approach(house, BEDROOM)
    assert "turningCircle" in str(raised.value)


# ════════════════════════════════════════════════════════════════════════════
# the contract — the envelope, and the words that must never appear
# ════════════════════════════════════════════════════════════════════════════


def _answers(model: SpatialModel) -> list[Answer[Any]]:
    return [
        ac.turning_circle(model, BEDROOM),
        ac.turning_circle(model, ENTRANCE_HALL, 1.50),
        ac.threshold_height(model, INTERNAL_DOOR),
        ac.threshold_height(model, EXTERNAL_DOOR),
        ac.balustrade_check(model, BEDROOM),
        ac.balustrade_check(model, LIVING_ROOM, 0.50),
        ac.clear_approach(model, INTERNAL_DOOR),
        ac.clear_approach(model, EXTERNAL_DOOR),
    ]


def test_every_answer_carries_the_envelope(house: SpatialModel) -> None:
    for answer in _answers(house):
        wire = answer.to_dict()
        assert set(wire) >= {"value", "unit", "tolerance", "provenance", "from", "method", "decidable"}
        assert answer.provenance in ("declared", "computed", "inferred")
        assert answer.decidable
        assert answer.unit == "m"
        assert answer.tolerance == pytest.approx(op.DIMENSION_TOLERANCE)
        assert answer.from_ and answer.from_[0] in answer.method
        assert answer.caveat


def test_no_answer_ever_renders_a_verdict(house: SpatialModel) -> None:
    """The discipline this module is named for, tested on every string it emits.

    OIB 4 names 1.50 m and a maximum step. This layer measures; the Bestimmung
    decides. A verdict word anywhere in a caveat, a method or a missing fact
    would mean the clause had been skipped rather than applied — and in a module
    about accessibility that is the failure that costs a real person a building
    they cannot use.
    """
    forbidden = ("barrierefrei", "erfüllt", "entspricht", "zulässig", "unzulässig", "konform", "genügt der")
    for answer in _answers(house):
        text = " ".join(
            filter(
                None,
                [
                    answer.method,
                    answer.caveat,
                    answer.missing.what if answer.missing else None,
                    answer.missing.remedy if answer.missing else None,
                ],
            )
        ).lower()
        for word in forbidden:
            assert word not in text, f"{word!r} in {answer.method}"
        assert "kein Grenzwert" in (answer.caveat or "") or "Bestimmung" in (answer.caveat or "")


@pytest.mark.parametrize(
    "call",
    [
        ac.turning_circle,
        ac.threshold_height,
        ac.balustrade_check,
        ac.clear_approach,
    ],
)
def test_a_hallucinated_global_id_raises_rather_than_answering_undecidable(house: SpatialModel, call: Any) -> None:
    """A GlobalId that names nothing must not come back as „das Modell sagt dazu
    nichts" — that sentence is reserved for questions this file genuinely cannot
    answer.
    """
    with pytest.raises(UnknownElementError):
        call(house, "0nichtVorhanden000000")

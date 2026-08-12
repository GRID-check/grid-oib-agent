"""Room depth, vertical stacking and sun position, checked against the file.

Three groups of tests, one per operator, and each group is built around the
number that would be WRONG if the operator were written the obvious way:

  - **room depth** — the sanity check is arithmetic, not an expectation. A
    rectangular room's ``depth × width`` has to land on its independently
    measured floor area; the bedroom does so to 1e-11 m². Nothing here asserts a
    depth that was read off the code.
  - **above / below** — the assertions are that a couch is not what is above a
    floor, and that a wall a window sits in is 0 m below it and not the 0.90 m
    where that wall's far side happens to be. Both of those are what an
    unfiltered ray answers on this fixture, and both are checked with the
    unfiltered ray beside them so the exclusion is visibly load-bearing.
  - **sun position** — validated against two independent published sources, the
    NREL SPA reference case and three U.S. Naval Observatory almanac positions.
    The oracle values are in the test, not in the module, and the module is not
    allowed to move them.

The fixture's site is London (51°30′N, 0°07′34″W) because ``Ifc4_SampleHouse``
is the buildingSMART sample and not an Austrian project. That is convenient
rather than awkward: it makes the sign of a west longitude — which lives in the
MINUTES component, the degrees being 0 — a thing this suite actually tests.
"""

from __future__ import annotations

import datetime as dt
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from ifc_spatial import daylight as dl
from ifc_spatial import operators as op
from ifc_spatial.model import SpatialModel
from ifc_spatial.model import UnknownElementError

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
NO_NORTH = FIXTURES / "haus-mit-raeumen.ifc"
FEET = FIXTURES / "einheiten-fuss.ifc"

BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
LIVING_ROOM = "3w0zWKm7n8SB1qbfwUzt0U"
ENTRANCE_HALL = "3w0zWKm7n8SB1qbfwUzt0G"
LOFT = "09J5N7xMHBfQZeQGAEMota"

NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
EAST_WALL = "3cUkl32yn9qRSPvBJVyWx4"
SOUTH_WALL = "3cUkl32yn9qRSPvBJVyWy4"
PARTITION = "3cUkl32yn9qRSPvBJVyWXt"
CURTAIN_WALL_PANE = "3cUkl32yn9qRSPvBJVyW_O"

BEDROOM_WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
ROOF = "3cUkl32yn9qRSPvBJVyWh4"
GROUND_SLAB = "3cUkl32yn9qRSPvBJVyWgQ"

#: Measured by `floor_area` and asserted by the parity suite; the depth tests
#: reconcile against these rather than against a hard-coded depth.
BEDROOM_FLOOR_AREA = 15.41678125
LIVING_ROOM_FLOOR_AREA = 51.994825
ENTRANCE_HALL_FLOOR_AREA = 8.69350625
#: `clear_height` on every room of this fixture — the suspended ceiling, not the
#: 2.500 m the IfcSpace solid is drawn to.
CLEAR_HEIGHT = 2.2


@pytest.fixture(scope="module")
def model() -> SpatialModel:
    """One open model for the module: the geometry pass, the OCCT tree and the
    contact map are each paid for once, exactly as one conversation would."""
    return SpatialModel(str(SAMPLE_HOUSE))


@pytest.fixture(scope="module")
def no_north() -> SpatialModel:
    return SpatialModel(str(NO_NORTH))


@pytest.fixture(scope="module")
def feet() -> SpatialModel:
    return SpatialModel(str(FEET))


# ════════════════════════════════════════════════════════════════════════════
# room depth — the arithmetic has to close before any number is believed
# ════════════════════════════════════════════════════════════════════════════


def test_bedroom_depth_times_width_is_its_floor_area(model: SpatialModel) -> None:
    """The check that catches a wrong projection.

    A rectangular room's depth and width, measured perpendicular to and along
    its facade, must multiply out to the area measured independently from the
    footprint union. If the projection direction were wrong — the model's Y axis
    instead of the facade's normal, or the bounding box instead of the footprint
    — the product would drift off the area, and no expectation written here
    would catch it because the expectation would have been copied from the code.
    """
    answer = dl.room_depth(model, BEDROOM)
    assert answer.decidable
    depth = answer.value["depth"]
    width = answer.value["width"]

    assert depth * width == pytest.approx(BEDROOM_FLOOR_AREA, abs=1e-6)
    assert answer.value["floorArea"] == pytest.approx(BEDROOM_FLOOR_AREA, abs=1e-4)
    # 3.4625 × 4.4525: the room runs back 3.46 m from its north window over a
    # 4.45 m front. Depth is the SHORTER of the two here, which is the point of
    # measuring it against a facade instead of taking the box's larger side.
    assert depth == pytest.approx(3.4625, abs=op.DIMENSION_TOLERANCE)
    assert width == pytest.approx(4.4525, abs=op.DIMENSION_TOLERANCE)
    assert answer.provenance == "computed"
    assert answer.unit == "m"
    assert answer.tolerance == op.DIMENSION_TOLERANCE


def test_entrance_hall_depth_times_width_is_its_floor_area(model: SpatialModel) -> None:
    """The same closure on a room whose daylight comes through an external DOOR.

    The hall has no window; its only outward aperture is the 3.819 m² entrance
    door in the south wall. A facade chooser that looked for ``IfcWindow`` alone
    would refuse this room, and 1.95 m is exactly the sort of depth an OIB
    daylight question is asked about.
    """
    answer = dl.room_depth(model, ENTRANCE_HALL)
    assert answer.decidable
    assert answer.value["depth"] * answer.value["width"] == pytest.approx(ENTRANCE_HALL_FLOOR_AREA, abs=1e-6)
    assert answer.value["depth"] == pytest.approx(1.9525, abs=op.DIMENSION_TOLERANCE)
    assert answer.value["facade"]["globalId"] == SOUTH_WALL
    assert answer.value["facade"]["azimuth"]["compass"] == "S"


def test_the_chosen_facade_is_named_with_the_reason_and_the_ranking(model: SpatialModel) -> None:
    """A depth without its facade is not an answer; a corner room has two."""
    answer = dl.room_depth(model, BEDROOM)
    facade = answer.value["facade"]

    assert facade["globalId"] == NORTH_WALL
    assert facade["azimuth"] == {"degrees": 0.0, "compass": "N"}
    # The reason carries the number the choice was made on, so a reviewer can
    # check the ranking rather than trust it.
    assert "2.1901 m²" in facade["why"]
    assert answer.method == f"roomDepth({BEDROOM}, facade={NORTH_WALL})"
    assert answer.from_[:3] == [BEDROOM, NORTH_WALL, BEDROOM_WINDOW]

    # Both external walls of the room are in the ranking, including the one that
    # carries nothing — "this wall has no window" is part of the evidence.
    ranked = {c["globalId"]: c["apertureArea"] for c in answer.value["candidates"]}
    assert ranked == {NORTH_WALL: pytest.approx(2.1901, abs=1e-3), EAST_WALL: 0.0}


def test_the_corner_room_says_which_facade_it_did_not_choose(model: SpatialModel) -> None:
    """The living room carries 2 × 2.19 m² north and 1 × 2.19 m² south.

    North wins on aperture area, and it wins by a factor of two — which is not a
    landslide. Reporting 5.655 m without saying that 9.3075 m is the answer to
    the same question asked of the other facade would be reporting one of two
    true numbers as the number.
    """
    answer = dl.room_depth(model, LIVING_ROOM)
    assert answer.value["facade"]["globalId"] == NORTH_WALL
    assert answer.value["depth"] == pytest.approx(5.655, abs=op.DIMENSION_TOLERANCE)

    ranked = {c["globalId"]: c["apertureArea"] for c in answer.value["candidates"]}
    assert ranked[NORTH_WALL] == pytest.approx(2 * 2.1901, abs=1e-3)
    assert ranked[SOUTH_WALL] == pytest.approx(2.1901, abs=1e-3)

    assert "Eckraum" in answer.caveat
    assert f"facade={SOUTH_WALL}" in answer.caveat


def test_an_explicit_facade_turns_the_measurement_ninety_degrees(model: SpatialModel) -> None:
    """The living room is 5.655 m deep from the north and 9.3075 m from the west.

    Both are true, and which one the reader wants depends on which facade the
    daylight is being argued about. The west facade of this room is the curtain
    wall — an ``IfcPlate``, not a wall — so this also exercises the route for a
    glazed facade that the automatic chooser cannot rank.
    """
    north = dl.room_depth(model, LIVING_ROOM, NORTH_WALL)
    west = dl.room_depth(model, LIVING_ROOM, CURTAIN_WALL_PANE)

    assert north.value["depth"] == pytest.approx(5.655, abs=op.DIMENSION_TOLERANCE)
    assert west.value["depth"] == pytest.approx(9.3075, abs=op.DIMENSION_TOLERANCE)
    # Depth and width swap, because they are the same two extents read against
    # perpendicular directions.
    assert west.value["width"] == pytest.approx(north.value["depth"], abs=1e-6)
    assert west.value["facade"]["azimuth"]["compass"] == "W"
    assert west.value["facade"]["why"] == "vom Aufrufer vorgegeben"
    # A facade that is not one of the room's declared external walls is still
    # measured against — and the answer says it was not in the ranking.
    assert "gehört nicht zu den außenliegenden Wänden" in west.caveat


def test_the_ratio_is_taken_against_the_clear_height_not_the_room_solid(model: SpatialModel) -> None:
    """2.200 m, not 2.500 m — a 30 cm suspended ceiling.

    On the bedroom's 3.4625 m the two heights give 1.574 and 1.385. Both are
    plausible-looking numbers and only one of them describes a room a person can
    stand in. The modelled height is the flattering side of a daylight ratio,
    which is why it must not be the one used.
    """
    answer = dl.room_depth(model, BEDROOM)
    modelled_height = 2.5  # the IfcSpace solid's own Z extent

    assert answer.value["clearHeight"] == pytest.approx(CLEAR_HEIGHT, abs=op.DIMENSION_TOLERANCE)
    assert answer.value["depthToHeight"] == pytest.approx(3.4625 / CLEAR_HEIGHT, abs=1e-3)
    assert answer.value["depthToHeight"] != pytest.approx(3.4625 / modelled_height, abs=1e-3)
    assert "LICHTE Höhe" in answer.caveat


def test_the_living_room_is_not_a_rectangle_and_the_caveat_refuses_to_pretend(model: SpatialModel) -> None:
    """52.6339 m² of bounding rectangle over 51.9948 m² of floor.

    0.639 m² notched out of one corner, 1.23 %. Depth and width are still the
    room's real extents; what is not true is that they describe the room, and a
    reader who multiplies them to get an area has to be told so in the answer.
    """
    answer = dl.room_depth(model, LIVING_ROOM)
    assert answer.value["depthTimesWidth"] == pytest.approx(52.6339, abs=1e-3)
    assert answer.value["floorArea"] == pytest.approx(LIVING_ROOM_FLOOR_AREA, abs=1e-4)
    assert "NICHT rechteckig" in answer.caveat

    # And the rooms that ARE rectangles get the other sentence.
    assert "füllt das Rechteck" in dl.room_depth(model, BEDROOM).caveat


def test_the_curtain_wall_is_reported_rather_than_silently_dropped(model: SpatialModel) -> None:
    """21 ``IfcPlate``/``IfcMember`` bound the living room and none is ranked.

    Curtain-wall glazing carries no ``IfcOpeningElement``, so its aperture is not
    measurable with the same ruler as a window's Rohbaulichte. Leaving it out is
    defensible; leaving it out silently would let a west-glazed room be reported
    as if its only daylight came from two north windows.
    """
    answer = dl.room_depth(model, LIVING_ROOM)
    assert "Vorhangfassade" in answer.caveat
    assert "IfcPlate/IfcMember" in answer.caveat


def test_depth_is_a_projection_and_a_bounding_box_would_be_wrong(model: SpatialModel) -> None:
    """The reason the operator does not call ``extent()``.

    The bedroom's footprint is turned 30° in plan and measured both ways. The
    projection onto the (equally turned) facade normal returns the room's real
    3.4625 m depth; the axis-aligned box of the same room returns 5.22 m — a
    51 % overstatement, with a unit, a tolerance and nothing on the answer to
    say it is the diagonal spread of a tilted rectangle.
    """
    geo = model.geometry(BEDROOM)
    points = dl._footprint_points(geo.triangles)
    assert points is not None

    theta = math.radians(30.0)
    rotate = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    turned = points @ rotate.T
    facade_normal = rotate @ np.array([0.0, 1.0])

    projected = dl._extent_along(turned, facade_normal)
    axis_aligned = float(turned[:, 1].max() - turned[:, 1].min())

    assert projected == pytest.approx(3.4625, abs=1e-6)
    assert axis_aligned == pytest.approx(3.4625 * math.cos(theta) + 4.4525 * math.sin(theta), abs=1e-6)
    assert axis_aligned > projected * 1.5


def test_a_room_whose_external_walls_carry_no_aperture_is_undecidable(model: SpatialModel) -> None:
    """The fixture's loft void is bounded by external walls and has no window.

    Not "measure against the longest external wall". Without an aperture there
    is no daylight facade, and a depth taken perpendicular to an arbitrarily
    chosen wall is as likely to be the room's width as its depth. The remedy
    names both ways out: fix the export, or pass the facade.
    """
    answer = dl.room_depth(model, LOFT)
    assert not answer.decidable
    assert answer.provenance == "computed"
    assert answer.missing.what == "keine außenliegende Fensteröffnung an den Außenwänden dieses Raums"
    assert "Öffnungen und Füllungen" in answer.missing.remedy
    assert "roomDepth()" in answer.missing.remedy
    assert answer.missing.elements == [LOFT]


def test_room_depth_aimed_at_a_wall_says_which_operator_would_answer(model: SpatialModel) -> None:
    answer = dl.room_depth(model, NORTH_WALL)
    assert not answer.decidable
    assert answer.missing.what == "roomDepth() erwartet einen Raum (IfcSpace), bekam IfcWall"
    assert "extent()" in answer.missing.remedy


def test_a_hallucinated_id_raises_rather_than_answering(model: SpatialModel) -> None:
    """ "Could not look" is an exception; "looked and the file cannot say" is an
    answer. A made-up GlobalId must never be reportable as the second."""
    with pytest.raises(UnknownElementError):
        dl.room_depth(model, "0000000000000000000000")
    with pytest.raises(UnknownElementError):
        dl.above(model, "0000000000000000000000")
    with pytest.raises(UnknownElementError):
        dl.below(model, "0000000000000000000000")


def test_a_space_the_kernel_cannot_build_is_reported_as_such(no_north: SpatialModel) -> None:
    """`haus-mit-raeumen.ifc` carries rooms whose bodies OCCT rejects.

    The refusal has to be about the BODY, not about a missing facade — sending
    the architect to set ``IsExternal`` on a file whose room solids will not
    build is sending them to fix the wrong thing.
    """
    space = no_north.file.by_type("IfcSpace")[0]
    answer = dl.room_depth(no_north, space.GlobalId)
    assert not answer.decidable
    assert "Körpergeometrie" in answer.missing.what


# ════════════════════════════════════════════════════════════════════════════
# above / below — the exclusions are the operator
# ════════════════════════════════════════════════════════════════════════════


def test_above_the_bedroom_is_the_roof_and_below_it_is_the_ground_slab(model: SpatialModel) -> None:
    over = dl.above(model, BEDROOM)
    under = dl.below(model, BEDROOM)

    assert [entry["globalId"] for entry in over.value] == [ROOF]
    assert over.value[0]["ifcType"] == "IfcRoof"
    assert over.value[0]["samples"] == 25
    # The roof is not flat over this room: 0.174 m at the nearest grid point and
    # 0.858 m at the furthest. One number would have hidden that.
    assert over.value[0]["gap"] == pytest.approx(0.1743, abs=op.DIMENSION_TOLERANCE)
    assert over.value[0]["gapMax"] > over.value[0]["gap"] + 0.5

    assert [entry["globalId"] for entry in under.value] == [GROUND_SLAB]
    assert under.value[0]["gap"] == 0.0  # the room stands ON it
    assert over.unit == "m" and over.tolerance == op.DIMENSION_TOLERANCE


def test_furniture_is_never_what_is_above_a_floor(model: SpatialModel) -> None:
    """The bug the exclusion list exists for, with the unfiltered ray beside it.

    Cast without a filter, the five nearest things over this model's ground slab
    are a chair at 0.119 m, a chair at 0.124 m, a couch at 0.135 m, a bed at
    0.203 m and a dining chair at 0.225 m. The first structural element is
    1.993 m up. A headroom, a storey height or a "was liegt über diesem Raum"
    built on the unfiltered answer is off by an order of magnitude.
    """
    answer = dl.above(model, GROUND_SLAB)
    types = {entry["ifcType"] for entry in answer.value}
    assert not types & {"IfcFurnishingElement", "IfcFurniture", "IfcSystemFurnitureElement"}
    assert answer.value[0]["globalId"] == ROOF
    assert answer.value[0]["gap"] == pytest.approx(1.9933, abs=op.DIMENSION_TOLERANCE)

    # The control: the same rays with nothing filtered out.
    geo = model.geometry(GROUND_SLAB)
    low, high = geo.box
    nearest: dict[str, float] = {}
    for ix in range(5):
        for iy in range(5):
            x = float(low[0] + (high[0] - low[0]) * (ix + 0.5) / 5)
            y = float(low[1] + (high[1] - low[1]) * (iy + 0.5) / 5)
            for hit in model.tree.select_ray((x, y, float(high[2]) + 0.01), (0.0, 0.0, 1.0), length=20.0):
                element = model.file.by_id(hit.instance.id())
                if element.GlobalId == GROUND_SLAB:
                    continue
                nearest[element.is_a()] = min(nearest.get(element.is_a(), 9e9), float(hit.distance))
    assert nearest["IfcFurniture"] < 0.2
    assert nearest["IfcFurniture"] < nearest["IfcRoof"] / 10


def test_an_element_the_subject_touches_reports_zero_not_its_far_side(model: SpatialModel) -> None:
    """The 0.90 m that is a sill height and not a clearance.

    The bedroom window sits in a wall whose parapet it touches. A ray started
    1 cm under the window's bottom starts INSIDE that parapet, and OCCT returns
    the parapet's exit face — down at floor level, 0.90 m away. Reported as
    "0.90 m unter dem Fenster" that reads as free space under a window that is
    in fact bedded straight into masonry.
    """
    under = dl.below(model, BEDROOM_WINDOW)
    by_id = {entry["globalId"]: entry for entry in under.value}

    assert by_id[NORTH_WALL]["gap"] == 0.0
    # The slab genuinely is 0.90 m below: that is the sill height, correctly
    # reported for the element that really is that far away.
    assert by_id[GROUND_SLAB]["gap"] == pytest.approx(0.9, abs=op.DIMENSION_TOLERANCE)
    assert "Berührung oder Durchdringung" in under.caveat


def test_nothing_above_the_roof_is_a_decidable_empty_answer(model: SpatialModel) -> None:
    """Free sky is a result. Rendering `[]` as "nicht ermittelbar" would turn the
    one thing the operator is certain about into a gap in the model."""
    answer = dl.above(model, ROOF)
    assert answer.decidable
    assert answer.value == []
    assert answer.provenance == "computed"
    assert answer.missing is None
    assert "Das ist ein Ergebnis, kein fehlender Wert." in answer.caveat

    assert dl.below(model, GROUND_SLAB).value == []


def test_hits_come_back_nearest_first(model: SpatialModel) -> None:
    answer = dl.below(model, ROOF)
    gaps = [entry["gap"] for entry in answer.value]
    assert gaps == sorted(gaps)
    assert len(answer.value) > 3
    # The whole ground slab sits 1.74 m under the roof over 24 of 25 points; the
    # walls and windows that carry the roof are in contact at 0 m. Both are in
    # the list, and `samples` is what tells them apart.
    assert answer.value[0]["gap"] == 0.0
    assert answer.value[-1]["globalId"] == GROUND_SLAB
    assert answer.value[-1]["samples"] >= 20


def test_the_overhead_caveat_states_the_grid_and_the_exclusions(model: SpatialModel) -> None:
    caveat = dl.above(model, BEDROOM).caveat
    assert "geom.tree.select_ray" in caveat
    assert "25 von 25 Rasterpunkten" in caveat
    assert "IfcFurnishingElement" in caveat
    assert "keine Vollständigkeitsaussage" in caveat


def test_the_grid_drops_points_that_are_over_the_box_but_not_the_element(model: SpatialModel) -> None:
    """A bounding box covers plan area its element does not.

    The roof of this fixture fills 24 of the 25 grid points over its own box;
    the 25th is a notch. Rays from there would report what is above the BOX —
    which for an L-shaped room or a pitched roof is a different building.
    """
    assert "24 von 25 Rasterpunkten" in dl.below(model, ROOF).caveat
    assert "25 von 25 Rasterpunkten" in dl.below(model, BEDROOM).caveat


def test_a_grid_that_tested_nothing_refuses_instead_of_answering_empty(model: SpatialModel) -> None:
    """An empty grid must not come back as an empty sky.

    ``samples=0`` casts no rays at all, and the two things it could report are
    "nichts darüber" and "ich habe nicht hingesehen". Only the second is true,
    and the whole contract of this library is that a caller can tell them apart.
    """
    answer = dl.above(model, BEDROOM, samples=0)
    assert not answer.decidable
    assert answer.value is None
    assert answer.missing.what == "kein Rasterpunkt lag über bzw. unter diesem Bauteil"
    assert "samples" in answer.missing.remedy


# ════════════════════════════════════════════════════════════════════════════
# sun position — the oracle lives here, not in the module
# ════════════════════════════════════════════════════════════════════════════

# Published reference 1 — NREL/TP-560-34302, Reda & Andreas, *Solar Position
# Algorithm for Solar Radiation Applications*, the report's own worked example:
# 2003-10-17 12:30:30 at time zone −7 (= 19:30:30 UT), latitude 39.742476°,
# longitude −105.1786°. Published result: topocentric zenith angle 50.11162°,
# topocentric azimuth 194.34024° eastward from north. SPA's zenith is REFRACTED
# (820 mbar, 11 °C ⇒ ≈ 0.020° of lift at this altitude) while this module returns
# the geometric position, so the altitudes are compared at a wider band and the
# azimuth — which refraction does not move — at the algorithm's own 0.01°.
SPA_REFERENCE = {
    "when": "2003-10-17T19:30:30Z",
    "latitude": 39.742476,
    "longitude": -105.1786,
    "azimuth": 194.34024,
    "altitude": 90.0 - 50.11162,
}

# Published reference 2 — the U.S. Naval Observatory's astronomical almanac data
# (aa.usno.navy.mil/api/celnav), computed altitude `hc` and azimuth `zn` of the
# Sun's centre. Three instants at the sample house's OWN declared site, chosen to
# span the year and the sky: a high midsummer sun, a low winter one 5° up, and an
# equinox afternoon. Geometric, so directly comparable.
USNO_LONDON = [
    ("2026-06-21T12:00:00Z", 178.867641, 61.934279, 23.437851),
    ("2026-12-21T09:00:00Z", 139.648384, 5.464107, -23.436468),
    ("2026-03-20T15:00:00Z", 230.020747, 27.075004, 0.003984),
]

LONDON_LATITUDE = 51.5
LONDON_LONGITUDE = -0.1262


def test_matches_the_nrel_spa_published_reference_case() -> None:
    sun = dl._solar_azimuth_altitude(
        dt.datetime.fromisoformat(SPA_REFERENCE["when"].replace("Z", "+00:00")),
        SPA_REFERENCE["latitude"],
        SPA_REFERENCE["longitude"],
    )
    assert sun["azimuth"] == pytest.approx(SPA_REFERENCE["azimuth"], abs=dl.SOLAR_TOLERANCE_DEGREES)
    # 0.016° apart, of which ≈ 0.020° is the refraction SPA applies and this does
    # not. Deliberately NOT tightened by adding a refraction term: the geometric
    # sun is the one that casts the shadow this library measures.
    assert sun["altitude"] == pytest.approx(SPA_REFERENCE["altitude"], abs=0.03)
    assert sun["declination"] == pytest.approx(-9.31434, abs=dl.SOLAR_TOLERANCE_DEGREES)


@pytest.mark.parametrize(("when", "azimuth", "altitude", "declination"), USNO_LONDON)
def test_matches_the_usno_almanac_at_the_fixtures_own_site(
    when: str, azimuth: float, altitude: float, declination: float
) -> None:
    sun = dl._solar_azimuth_altitude(
        dt.datetime.fromisoformat(when.replace("Z", "+00:00")), LONDON_LATITUDE, LONDON_LONGITUDE
    )
    assert sun["azimuth"] == pytest.approx(azimuth, abs=dl.SOLAR_TOLERANCE_DEGREES)
    assert sun["altitude"] == pytest.approx(altitude, abs=dl.SOLAR_TOLERANCE_DEGREES)
    assert sun["declination"] == pytest.approx(declination, abs=dl.SOLAR_TOLERANCE_DEGREES)


@pytest.mark.parametrize(
    ("components", "expected"),
    [
        # The sample house: 51°30′00.549316″ N and 0°07′34.450321″ W. The west
        # sign lives in the MINUTES, because the degrees are zero — reading it
        # off the first component alone puts the building 0.25° east of itself.
        ((51, 30, 0, 549316), 51.500152588),
        ((0, -7, -34, -450321), -0.126236200),
        ((48, 12, 30), 48.208333333),
        ((-33, -52, -0), -33.866666667),
        ((0, 0, 0), 0.0),
    ],
)
def test_reads_an_ifc_compound_angle_with_its_sign(components: tuple[int, ...], expected: float) -> None:
    assert dl._compound_angle(components) == pytest.approx(expected, abs=1e-9)


def test_reads_the_site_coordinates_off_the_fixture(model: SpatialModel) -> None:
    """The fixture declares London, and the operator has to arrive there."""
    site = dl._site_coordinates(model)
    assert site is not None
    latitude, longitude, site_id = site
    assert latitude == pytest.approx(51.500152588, abs=1e-9)
    assert longitude == pytest.approx(-0.126236200, abs=1e-9)
    assert model.file.by_guid(site_id).is_a() == "IfcSite"


def test_the_operator_agrees_with_the_almanac_end_to_end(model: SpatialModel) -> None:
    """The whole call, not the private helper: file → coordinates → sun.

    The site's declared longitude is 0.0000362° from the round number the USNO
    query used, so the two agree well inside the algorithm's own tolerance.
    """
    answer = dl.sun_position(model, "2026-06-21T12:00:00Z")
    assert answer.decidable
    assert answer.provenance == "computed"
    assert answer.unit == "°"
    assert answer.tolerance == dl.SOLAR_TOLERANCE_DEGREES
    assert answer.value["azimuth"] == pytest.approx(178.867641, abs=dl.SOLAR_TOLERANCE_DEGREES)
    assert answer.value["altitude"] == pytest.approx(61.934279, abs=dl.SOLAR_TOLERANCE_DEGREES)
    assert answer.value["compass"] == "S"
    assert answer.value["aboveHorizon"] is True
    assert answer.from_ == [dl._site_coordinates(model)[2]]


def test_the_model_direction_is_the_bearing_read_back(model: SpatialModel) -> None:
    """`directionInModel` is what ray() and obstructions() take.

    It has to be a unit vector, and turning it back into a compass bearing
    through the model's TrueNorth has to return the azimuth it was built from —
    otherwise the sun direction handed to a shading query points somewhere else
    than the sun.
    """
    answer = dl.sun_position(model, "2026-06-21T12:00:00Z")
    direction = np.array(answer.value["directionInModel"])
    assert float(np.linalg.norm(direction)) == pytest.approx(1.0, abs=1e-5)

    theta = model.true_north
    north = np.array([math.sin(theta), math.cos(theta)])
    east = np.array([north[1], -north[0]])
    bearing = math.degrees(math.atan2(float(direction[:2] @ east), float(direction[:2] @ north))) % 360.0
    assert bearing == pytest.approx(answer.value["azimuth"], abs=1e-3)
    assert math.degrees(math.asin(direction[2])) == pytest.approx(answer.value["altitude"], abs=1e-3)
    # Midsummer noon over a building whose +Y is north: the sun is in the south,
    # so the direction towards it runs into −Y and steeply up.
    assert direction[1] < 0 and direction[2] > 0.8


def test_night_is_a_negative_altitude_and_says_so(model: SpatialModel) -> None:
    answer = dl.sun_position(model, "2026-12-21T23:00:00Z")
    assert answer.decidable
    assert answer.value["altitude"] < 0
    assert answer.value["aboveHorizon"] is False
    assert "UNTER dem Horizont" in answer.caveat


def test_a_model_without_a_coordinate_is_undecidable_in_german(no_north: SpatialModel) -> None:
    """The branch this operator exists to get right.

    Never a computed guess. The remedy is something an architect does in their
    CAD — the menu path is in it — and it names the cost of the alternative.
    """
    answer = dl.sun_position(no_north, "2026-06-21T12:00:00+02:00")
    assert not answer.decidable
    assert answer.value is None
    assert answer.missing.what == "IfcSite.RefLatitude / RefLongitude"
    assert "Standort des Projekts" in answer.missing.remedy
    assert "Revit" in answer.missing.remedy and "ArchiCAD" in answer.missing.remedy
    assert no_north.true_north is None


def test_an_ifc2x3_file_does_not_explode_on_the_map_conversion_lookup(feet: SpatialModel) -> None:
    """``IfcMapConversion`` arrived in IFC4.

    ``by_type`` on an IFC2X3 file raises ``RuntimeError: Entity with name
    'IfcMapConversion' not found in schema 'IFC2X3'`` instead of returning an
    empty list, and this fixture is IFC2X3. An unguarded lookup turns a clean
    "nicht georeferenziert" into a traceback — a could-not-look dressed as a
    crash.
    """
    answer = dl.sun_position(feet, "2026-06-21T12:00:00+02:00")
    assert not answer.decidable
    assert answer.missing.what == "IfcSite.RefLatitude / RefLongitude"
    assert dl._by_type(feet, "IfcMapConversion") == []


def test_a_timestamp_without_a_zone_is_refused(model: SpatialModel) -> None:
    """Two hours of shadow is the cost of assuming UTC over Austria."""
    answer = dl.sun_position(model, "2026-06-21T12:00:00")
    assert not answer.decidable
    assert "Zeitzone fehlt" in answer.missing.what
    assert "+02:00" in answer.missing.remedy

    unreadable = dl.sun_position(model, "irgendwann im Juni")
    assert not unreadable.decidable
    assert "kein lesbarer Zeitpunkt" in unreadable.missing.what


def test_an_offset_and_its_utc_equivalent_are_the_same_instant(model: SpatialModel) -> None:
    with_offset = dl.sun_position(model, "2026-06-21T14:00:00+02:00")
    as_utc = dl.sun_position(model, "2026-06-21T12:00:00Z")
    assert with_offset.value["azimuth"] == as_utc.value["azimuth"]
    assert with_offset.value["utc"] == as_utc.value["utc"] == "2026-06-21T12:00:00Z"


def test_caller_supplied_coordinates_are_allowed_and_loudly_flagged(no_north: SpatialModel) -> None:
    """A surveyed coordinate beats an exporter's default — but the answer then
    rests on the caller, and nothing in the file can corroborate it."""
    answer = dl.sun_position(no_north, "2026-06-21T12:00:00+02:00", latitude=48.2082, longitude=16.3738)
    assert answer.decidable
    assert answer.value["latitude"] == pytest.approx(48.2082)
    assert "stehen NICHT in der Datei" in answer.caveat
    assert answer.from_ == []
    # No TrueNorth in this file, so there is no way to say where the sun is
    # relative to the BUILDING — and that is stated rather than defaulted to 0°.
    assert answer.value["directionInModel"] is None
    assert answer.value["trueNorthDegrees"] is None
    assert "keine Nordrichtung" in answer.caveat

    half = dl.sun_position(no_north, "2026-06-21T12:00:00+02:00", latitude=48.2082)
    assert not half.decidable
    assert half.missing.what == "nur eine der beiden Koordinaten übergeben"


def test_outside_michalskys_span_the_tolerance_widens_and_says_why(model: SpatialModel) -> None:
    answer = dl.sun_position(model, "2101-06-21T12:00:00Z")
    assert answer.decidable
    assert answer.tolerance == dl.SOLAR_TOLERANCE_DEGREES_EXTRAPOLATED
    assert "1950–2050" in answer.caveat


def test_the_caveat_says_a_sun_position_is_not_a_besonnungsstudie(model: SpatialModel) -> None:
    """The sentence the whole operator hangs on.

    Where the sun is and what is shaded are different questions, and the second
    one needs the neighbours, the terrain and the balconies — none of which are
    in a single building's IFC. An agent that reads "Sonnenstand" and writes
    "Besonnung" has made the claim this caveat exists to block.
    """
    caveat = dl.sun_position(model, "2026-06-21T12:00:00Z").caveat
    assert "KEINE Besonnungsstudie" in caveat
    assert "nicht, was beschattet ist" in caveat
    assert "Michalsky" in caveat
    assert "ohne Refraktion" in caveat


# ════════════════════════════════════════════════════════════════════════════
# the rule that outranks all of the above
# ════════════════════════════════════════════════════════════════════════════


def test_no_operator_here_ever_delivers_a_verdict(model: SpatialModel) -> None:
    """OIB names the limits; this layer must not know them.

    Every string any of these three operators can put in front of a reader,
    scanned for the vocabulary of a finding. A depth-to-height ratio is a
    geometric fact; "1,57 — zulässig" is a legal one, and the moment this
    library writes it, nobody downstream can tell which threshold was applied or
    from which edition.
    """
    answers: list[Any] = [
        dl.room_depth(model, BEDROOM),
        dl.room_depth(model, LIVING_ROOM),
        dl.room_depth(model, LOFT),
        dl.above(model, BEDROOM),
        dl.below(model, BEDROOM_WINDOW),
        dl.sun_position(model, "2026-06-21T12:00:00Z"),
        dl.sun_position(model, "2026-06-21T12:00:00"),
    ]
    surface = " ".join(
        " ".join(
            str(piece)
            for piece in (
                answer.caveat,
                answer.method,
                answer.missing.what if answer.missing else "",
                answer.missing.remedy if answer.missing else "",
            )
            if piece
        )
        for answer in answers
    ).lower()

    for word in ("erfüllt", "nicht erfüllt", "compliant", "verstoß", "zulässig", "unzulässig", "grenzwert", "oib"):
        assert word not in surface, f"Befundvokabular in der Ausgabe: {word}"
    assert "besonnungsstudie" in surface  # …but the refusal to be one is in it

"""Clearances and oriented extents, against an oracle that is not this code.

Two oracles, and neither of them is "what the function returned last time":

1. **The sample house's own type names.** ``Doors_IntSgl:810x2110mm`` is the
   architect's statement of what that door is. A clear opening width that does
   not come out at 0.810 m means the projection is wrong, and the expected value
   does not move to meet it. Likewise ``1810x1210mm`` and ``1810x2110mm``.
2. **Hand-computed geometry.** Two 30 cm walls with a 1.00 m gap between them,
   and a 4.00 × 0.30 m wall turned 30° in plan, written into a synthetic IFC in
   ``tmp_path``. Their clear width, their oriented extent and the axis-aligned box
   that misreports it are all known on paper before the code runs:
   4·cos30° + 0.3·sin30° = 3.6141 m of bounding box for a 4 m wall.

The exact triangle-triangle distance carries a third: a dense barycentric
sampling of both triangles, which is a completely different algorithm and can
only ever be an upper bound on the true distance. If the fast path ever exceeds
it, the fast path is wrong.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest
import shapely
from ifc_spatial import clearance as cl
from ifc_spatial import operators as op
from ifc_spatial.model import SpatialModel
from ifc_spatial.model import UnknownElementError

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
NO_GEOMETRY = FIXTURES / "haus-mit-raeumen.ifc"

#: ``Windows_Sgl_Plain:1810x1210mm``
WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
#: ``Doors_ExtDbl_Flush:1810x2110mm``
EXTERNAL_DOOR = "3cUkl32yn9qRSPvBJVyWYp"
#: ``Doors_IntSgl:810x2110mm``
INTERNAL_DOOR = "3cUkl32yn9qRSPvBJVyWax"
INTERNAL_DOOR_OPENING = "3cUkl32yn9qRSPvAVVyWax"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
LIVING_ROOM = "3w0zWKm7n8SB1qbfwUzt0U"
NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
PARTITION = "3cUkl32yn9qRSPvBJVyWY1"
ROOF = "3cUkl32yn9qRSPvBJVyWh4"
#: ``Furniture_Chair_Viper:1120x940x350mm``, standing 37° off the model axes.
CHAIR = "3cUkl32yn9qRSPvBJVyY1R"
#: The same chair type, at 35°.
OTHER_CHAIR = "3cUkl32yn9qRSPvBJVyY48"

#: A wall with no body at all — the file states the wall and no geometry.
BODYLESS_WALL = "2Haus0Raeume00Wall0001"

# Two 30 cm walls with a 1.00 m opening between them, and a 4.00 × 0.30 × 2.50 m
# wall turned 30° in plan, plus a doorset with a body and NO opening chain. The
# first pair is the defect this module exists for, written down: their surfaces
# are 1.000 m apart and their centroids 1.300 m. The third element is the only
# way to reach the element-body fallback deterministically, since every window
# and door in the sample house does have its opening.
_HAND_BUILT = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('laibungen.ifc','2026-08-12T00:00:00',(''),(''),'','','');
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
#10=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#11=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#12=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#13=IFCUNITASSIGNMENT((#10,#11,#12));
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);
#15=IFCPROJECT('0aaaaaaaaaaaaaaaaaaaa0',#5,'P',$,$,$,$,(#14),#13);
#20=IFCCARTESIANPOINT((0.15,0.));
#21=IFCAXIS2PLACEMENT2D(#20,$);
#22=IFCRECTANGLEPROFILEDEF(.AREA.,'links',#21,0.3,3.);
#23=IFCEXTRUDEDAREASOLID(#22,#9,#7,2.5);
#24=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#23));
#25=IFCPRODUCTDEFINITIONSHAPE($,$,(#24));
#26=IFCLOCALPLACEMENT($,#9);
#27=IFCWALL('0aaaaaaaaaaaaaaaaaaaa1',#5,'Laibung links',$,$,#26,#25,$,$);
#30=IFCCARTESIANPOINT((1.45,0.));
#31=IFCAXIS2PLACEMENT2D(#30,$);
#32=IFCRECTANGLEPROFILEDEF(.AREA.,'rechts',#31,0.3,3.);
#33=IFCEXTRUDEDAREASOLID(#32,#9,#7,2.5);
#34=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#33));
#35=IFCPRODUCTDEFINITIONSHAPE($,$,(#34));
#36=IFCWALL('0aaaaaaaaaaaaaaaaaaaa2',#5,'Laibung rechts',$,$,#26,#35,$,$);
#40=IFCCARTESIANPOINT((0.,0.));
#41=IFCAXIS2PLACEMENT2D(#40,$);
#42=IFCRECTANGLEPROFILEDEF(.AREA.,'schraeg',#41,4.,0.3);
#43=IFCDIRECTION((0.86602540378443865,0.5,0.));
#44=IFCCARTESIANPOINT((10.,10.,0.));
#45=IFCAXIS2PLACEMENT3D(#44,#7,#43);
#46=IFCEXTRUDEDAREASOLID(#42,#45,#7,2.5);
#47=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#46));
#48=IFCPRODUCTDEFINITIONSHAPE($,$,(#47));
#49=IFCWALL('0aaaaaaaaaaaaaaaaaaaa3',#5,'Schraege Wand',$,$,#26,#48,$,$);
#50=IFCCARTESIANPOINT((0.,0.));
#51=IFCAXIS2PLACEMENT2D(#50,$);
#52=IFCRECTANGLEPROFILEDEF(.AREA.,'tuerblatt',#51,0.9,0.05);
#53=IFCCARTESIANPOINT((20.,20.,0.));
#54=IFCAXIS2PLACEMENT3D(#53,#7,#6);
#55=IFCEXTRUDEDAREASOLID(#52,#54,#7,2.);
#56=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#55));
#57=IFCPRODUCTDEFINITIONSHAPE($,$,(#56));
#58=IFCDOOR('0aaaaaaaaaaaaaaaaaaaa4',#5,'Tuer ohne Oeffnung',$,$,#26,#57,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"""

LEFT_JAMB = "0aaaaaaaaaaaaaaaaaaaa1"
RIGHT_JAMB = "0aaaaaaaaaaaaaaaaaaaa2"
SKEWED_WALL = "0aaaaaaaaaaaaaaaaaaaa3"
UNCHAINED_DOOR = "0aaaaaaaaaaaaaaaaaaaa4"


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(SAMPLE_HOUSE))


@pytest.fixture(scope="module")
def hand_built(tmp_path_factory: pytest.TempPathFactory) -> SpatialModel:
    path = tmp_path_factory.mktemp("clearance") / "laibungen.ifc"
    path.write_text(_HAND_BUILT)
    return SpatialModel(str(path))


# ════════════════════════════════════════════════════════════════════════════
# clear_width — the defect, written down and measured
# ════════════════════════════════════════════════════════════════════════════


def test_the_opening_between_two_walls_is_the_clear_width_not_the_axis_distance(
    hand_built: SpatialModel,
) -> None:
    """The exact case the tool description used to get wrong.

    Two 30 cm walls, a 1.00 m opening. ``distance(…, 'horizontal')`` — which was
    once described as "what a lichte Breite check needs" — returns 1.30 m,
    because it measures centroid to centroid and half of each wall is inside the
    number. On an escape-route width that is the difference between a failure and
    a pass.
    """
    answer = cl.clear_width(hand_built, LEFT_JAMB, RIGHT_JAMB)
    assert answer.decidable
    assert answer.value["distance"] == pytest.approx(1.0, abs=1e-9)

    axis_distance = op.distance(hand_built, LEFT_JAMB, RIGHT_JAMB, "horizontal")
    assert axis_distance.value == pytest.approx(1.3, abs=1e-9)
    # 30 % too generous, and in the direction nobody checks.
    assert axis_distance.value > answer.value["distance"]


def test_the_answer_carries_the_two_points_it_was_measured_between(hand_built: SpatialModel) -> None:
    value = cl.clear_width(hand_built, LEFT_JAMB, RIGHT_JAMB).value
    first = np.array(value["pointOnA"])
    second = np.array(value["pointOnB"])
    assert float(np.linalg.norm(first - second)) == pytest.approx(value["distance"], abs=1e-9)
    # Each witness is on its own element's surface: x = 0.3 is the right face of
    # the left wall, x = 1.3 the left face of the right one.
    assert first[0] == pytest.approx(0.3, abs=1e-9)
    assert second[0] == pytest.approx(1.3, abs=1e-9)


def test_a_box_gap_of_zero_does_not_mean_the_solids_touch(house: SpatialModel) -> None:
    """The pitched roof against the partition wall, in the sample house.

    ``distance('min')`` reports 0 m because the roof's bounding box swallows the
    wall's, and its own caveat admits that overlapping boxes prove nothing. The
    surfaces are 0.995 m apart. A caller reading the 0 as contact is wrong by a
    metre; a caller reading it as a lower bound is right, which is all a box gap
    can ever be.
    """
    box = op.distance(house, ROOF, PARTITION, "min")
    assert box.value == pytest.approx(0.0, abs=1e-9)

    answer = cl.clear_width(house, ROOF, PARTITION)
    assert answer.value["distance"] == pytest.approx(0.9947, abs=0.001)
    assert answer.value["boxGap"] == pytest.approx(0.0, abs=1e-9)
    assert "unterschätzt" in answer.caveat


def test_solids_that_really_do_touch_measure_zero_and_say_which_kind_of_zero(house: SpatialModel) -> None:
    """The window sits in its reveal in the north wall — the surfaces meet.

    This zero is a statement about the FACES (triangles of both bodies intersect),
    not about two boxes overlapping, and the caveat has to distinguish them or the
    operator adds nothing over ``distance('min')``.
    """
    answer = cl.clear_width(house, WINDOW, NORTH_WALL)
    assert answer.value["distance"] == 0.0
    assert "berühren oder durchdringen" in answer.caveat
    assert "Hüllbox-Aussage" in answer.caveat


def test_the_partition_between_two_rooms_is_its_thickness(house: SpatialModel) -> None:
    """Bedroom to living room: 0.095 m of partition, against 7.08 m of Achsabstand."""
    answer = cl.clear_width(house, BEDROOM, LIVING_ROOM)
    assert answer.value["distance"] == pytest.approx(0.095, abs=0.001)
    assert op.distance(house, BEDROOM, LIVING_ROOM, "horizontal").value == pytest.approx(7.08, abs=0.01)
    # Both subjects are air. Measuring a clearance to a void is legitimate — it is
    # how a partition thickness is read off two rooms — but it is not a distance
    # between built surfaces, and the answer has to say so.
    assert "Luft" in answer.caveat and "IfcSpace" in answer.caveat


def test_the_measurement_is_never_smaller_than_the_box_gap(house: SpatialModel) -> None:
    """The invariant that makes the box gap safe to keep reporting.

    An axis-aligned box contains its solid, so the gap between two boxes is a
    lower bound on the distance between the solids — always, for every pair. If
    this ever fails, the surface measurement is wrong, not the box.
    """
    pairs = [(ROOF, PARTITION), (CHAIR, OTHER_CHAIR), (CHAIR, NORTH_WALL), (BEDROOM, LIVING_ROOM)]
    for first, second in pairs:
        value = cl.clear_width(house, first, second).value
        assert value["distance"] >= value["boxGap"] - 1e-9, (first, second)


def test_asking_for_the_clearance_of_one_element_to_itself_is_refused(house: SpatialModel) -> None:
    answer = cl.clear_width(house, NORTH_WALL, NORTH_WALL)
    assert answer.decidable is False
    assert "zweimal dasselbe Bauteil" in answer.missing.what
    # The remedy names the operator that WOULD answer it.
    assert "clearOpeningWidth()" in answer.missing.remedy


def test_an_element_without_a_body_is_a_finding_and_not_an_exception() -> None:
    model = SpatialModel(str(NO_GEOMETRY))
    answer = cl.clear_width(model, BODYLESS_WALL, "2Haus0Raeume00Wall0002")
    assert answer.decidable is False
    assert answer.provenance == "computed"
    assert "keine geometrische Repräsentation" in answer.missing.what


def test_an_unknown_global_id_raises_rather_than_answering(house: SpatialModel) -> None:
    # A hallucinated id must never come back as "das Modell sagt dazu nichts".
    with pytest.raises(UnknownElementError):
        cl.clear_width(house, NORTH_WALL, "3nOtAnIdInThisModel00")
    with pytest.raises(UnknownElementError):
        cl.clear_opening_width(house, "3nOtAnIdInThisModel00")
    with pytest.raises(UnknownElementError):
        cl.oriented_extent(house, "3nOtAnIdInThisModel00")


def test_a_mesh_too_fine_to_measure_is_refused_before_it_is_attempted(
    house: SpatialModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cl, "CLEARANCE_MAX_TRIANGLE_PAIRS", 10)
    answer = cl.clear_width(house, CHAIR, OTHER_CHAIR)
    assert answer.decidable is False
    # The refusal names the counts, so the reader can see how far over it is.
    assert "3618 × 3618 Dreiecke" in answer.missing.what
    assert "gröberer Tessellierung" in answer.missing.remedy


def test_running_out_of_budget_refuses_instead_of_reporting_an_upper_bound(
    house: SpatialModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An abandoned search holds an UPPER bound, and an upper bound read as a
    clear width is exactly the failure this module exists to prevent."""
    monkeypatch.setattr(cl, "CLEARANCE_BUDGET_SECONDS", 0.0)
    answer = cl.clear_width(house, CHAIR, OTHER_CHAIR)
    assert answer.decidable is False
    assert answer.value is None
    assert "abgebrochen" in answer.missing.what
    assert "OBERGRENZE" in answer.missing.remedy


# ════════════════════════════════════════════════════════════════════════════
# the exact triangle-triangle distance, against an independent algorithm
# ════════════════════════════════════════════════════════════════════════════


def _sampled_pair_distance(first: np.ndarray, second: np.ndarray, steps: int = 40) -> float:
    """Dense barycentric sampling of both triangles — an upper bound on the truth.

    Deliberately the dumbest algorithm that could work, and unrelated to the one
    under test: no Voronoi regions, no clamping, no Möller–Trumbore. Every sample
    pair is a real pair of points on the two triangles, so the fast path may never
    exceed this and must come close to it.
    """
    weights = np.array(
        [(i / steps, j / steps, 1 - i / steps - j / steps) for i in range(steps + 1) for j in range(steps + 1 - i)]
    )
    left = weights @ first
    right = weights @ second
    return float(np.sqrt(((left[:, None, :] - right[None, :, :]) ** 2).sum(-1)).min())


def test_the_exact_pair_distance_agrees_with_dense_sampling() -> None:
    generator = np.random.default_rng(20260812)
    for _ in range(60):
        first = generator.normal(size=(3, 3))
        second = generator.normal(size=(3, 3)) + generator.normal(scale=1.5, size=3)
        measured = float(cl._triangle_distances(first, second[None])[0][0])
        sampled = _sampled_pair_distance(first, second)
        assert measured <= sampled + 1e-9
        assert measured > sampled - 0.08


def test_crossing_triangles_are_zero_even_though_no_vertex_and_no_edge_meet() -> None:
    """The case fifteen vertex/edge tests get wrong, and get wrong dangerously.

    These two triangles pass through each other in an X. No vertex of either lies
    on the other, and no pair of edges meets, so every closest-point test returns
    a comfortable positive number — 0.2 m of "clearance" between two bodies that
    intersect. Only the segment-through-triangle test sees it.
    """
    first = np.array([[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    second = np.array([[0.0, -1.0, 0.2], [0.0, 1.0, 0.2], [0.0, 0.0, -1.0]])
    assert float(cl._triangle_distances(first, second[None])[0][0]) == 0.0


def test_parallel_and_nested_and_skew_triangles_are_all_exact() -> None:
    flat = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    above = flat + np.array([0.0, 0.0, 0.25])
    assert float(cl._triangle_distances(flat, above[None])[0][0]) == pytest.approx(0.25, abs=1e-12)

    # Coplanar, one strictly inside the other: no crossing edges anywhere, and the
    # answer is still zero because a vertex sits in the other triangle.
    large = np.array([[-5.0, -5.0, 0.0], [5.0, -5.0, 0.0], [0.0, 5.0, 0.0]])
    small = np.array([[-1.0, -1.0, 0.0], [1.0, -1.0, 0.0], [0.0, 1.0, 0.0]])
    assert float(cl._triangle_distances(large, small[None])[0][0]) == 0.0

    # Two edges crossing in projection with a 1.0 m gap: the minimum is in the
    # interior of both edges, where no vertex test can find it.
    lying = np.array([[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [5.0, 0.001, 0.0]])
    standing = np.array([[5.0, -5.0, 1.0], [5.0, 5.0, 1.0], [5.0, 0.0, 1.5]])
    assert float(cl._triangle_distances(lying, standing[None])[0][0]) == pytest.approx(1.0, abs=1e-12)


def test_the_pruned_search_finds_what_the_unpruned_one_would(house: SpatialModel) -> None:
    """The box pre-filter and the sorted break must not change the answer.

    Checked against the same code with both switched off — every triangle of A
    against every triangle of B — on a pair small enough to brute-force.
    """
    left = cl._usable_triangles(house.geometry(ROOF))
    right = cl._usable_triangles(house.geometry(PARTITION))
    pruned = cl._soup_distance(left, right, 60.0)[0]
    brute = min(float(cl._triangle_distances(triangle, right)[0].min()) for triangle in left)
    assert pruned == pytest.approx(brute, abs=1e-12)


# ════════════════════════════════════════════════════════════════════════════
# clear_opening_width — the type names are the oracle
# ════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    ("global_id", "type_name", "width", "height"),
    [
        (INTERNAL_DOOR, "810x2110mm", 0.810, 2.110),
        (EXTERNAL_DOOR, "1810x2110mm", 1.810, 2.110),
        (WINDOW, "1810x1210mm", 1.810, 1.210),
    ],
)
def test_the_clear_opening_matches_the_type_name_to_the_millimetre(
    house: SpatialModel, global_id: str, type_name: str, width: float, height: float
) -> None:
    element = house.file.by_guid(global_id)
    assert element.ObjectType == type_name  # the oracle is in the file, not here

    answer = cl.clear_opening_width(house, global_id)
    assert answer.decidable and answer.unit == "m"
    assert answer.value["width"] == pytest.approx(width, abs=1e-6)
    assert answer.value["height"] == pytest.approx(height, abs=1e-6)
    # A rectangular opening: the width is the clear width over the whole height,
    # not just at the widest point.
    assert answer.value["rectangularity"] == pytest.approx(1.0, abs=1e-6)
    assert answer.value["via"] == "IfcOpeningElement"


def test_the_window_is_followed_through_fills_voids_to_its_own_opening(house: SpatialModel) -> None:
    answer = cl.clear_opening_width(house, WINDOW)
    opening = house.file.by_guid(WINDOW).FillsVoids[0].RelatingOpeningElement
    assert answer.value["measuredOn"] == opening.GlobalId
    # Both ends of the derivation are in `from`, so the chain is auditable.
    assert answer.from_ == [WINDOW, opening.GlobalId]


def test_the_opening_can_be_asked_directly_and_answers_the_same(house: SpatialModel) -> None:
    """An agent chaining off ``hosts()`` holds the opening's id, not the door's."""
    through_door = cl.clear_opening_width(house, INTERNAL_DOOR).value
    direct = cl.clear_opening_width(house, INTERNAL_DOOR_OPENING).value
    assert direct["width"] == pytest.approx(through_door["width"], abs=1e-12)
    assert direct["height"] == pytest.approx(through_door["height"], abs=1e-12)
    assert direct["measuredOn"] == INTERNAL_DOOR_OPENING


def test_the_projection_is_the_one_the_area_operator_already_uses(house: SpatialModel) -> None:
    """This module's polygon and ``operators._clear_opening_area`` must not drift.

    The width cannot be recovered from an area, so the projection is repeated
    here — and a repeated projection that quietly stops matching the original is
    how two operators end up reporting different apertures for the same opening.
    """
    for global_id in (WINDOW, EXTERNAL_DOOR, INTERNAL_DOOR):
        opening = house.file.by_guid(global_id).FillsVoids[0].RelatingOpeningElement
        polygon, _ = cl._aperture_polygon(house, opening)
        assert polygon.area == pytest.approx(op._clear_opening_area(house, opening), abs=1e-12)


def test_the_element_body_is_wider_than_the_opening_it_sits_in(house: SpatialModel) -> None:
    """Which way the fallback is wrong, measured rather than assumed.

    The lining and the architrave lap onto the wall face on both sides, so the
    door's own silhouette is WIDER than the hole: 0.880 m against 0.810 m for the
    internal door, 1.860 against 1.810 for both 1810 mm units. As a clear width
    that is an upper bound — the direction that turns a failing escape route into
    a passing one — which is why the fallback is labelled every time it is used.
    """
    measured = {}
    for global_id in (INTERNAL_DOOR, WINDOW, EXTERNAL_DOOR):
        element = house.file.by_guid(global_id)
        opening = element.FillsVoids[0].RelatingOpeningElement
        body, _ = cl._aperture_polygon(house, element)
        hole, _ = cl._aperture_polygon(house, opening)
        measured[global_id] = (body.bounds[2] - body.bounds[0], hole.bounds[2] - hole.bounds[0])

    assert measured[INTERNAL_DOOR][0] == pytest.approx(0.880, abs=1e-6)
    assert measured[INTERNAL_DOOR][1] == pytest.approx(0.810, abs=1e-6)
    for body_width, hole_width in measured.values():
        assert body_width > hole_width


def test_a_door_with_no_opening_chain_falls_back_and_calls_it_an_upper_bound(
    hand_built: SpatialModel,
) -> None:
    """84 % of the fenestration in one corpus export is in this state — the wall
    body carries the hole already subtracted and no ``IfcOpeningElement`` exists.
    The element's own body is then all there is, and it is not the same number."""
    answer = cl.clear_opening_width(hand_built, UNCHAINED_DOOR)
    assert answer.decidable
    assert answer.value["width"] == pytest.approx(0.9, abs=1e-9)
    assert answer.value["height"] == pytest.approx(2.0, abs=1e-9)
    assert answer.value["via"].startswith("Bauteilkörper")
    assert answer.value["measuredOn"] == UNCHAINED_DOOR
    assert "OBERGRENZE" in answer.caveat
    assert "zu groß" in answer.caveat


def test_the_caveat_says_rohbaulichte_and_never_says_erfuellt(house: SpatialModel) -> None:
    """This layer measures; the Bestimmung judges.

    The Rohbaulichte and the lichte Durchgangsbreite differ by 15–25 % on an
    ordinary door, and substituting one for the other silently is a number that is
    right to the millimetre and answers a different question.
    """
    answers = [
        cl.clear_opening_width(house, INTERNAL_DOOR),
        cl.clear_width(house, BEDROOM, LIVING_ROOM),
        cl.oriented_extent(house, NORTH_WALL),
    ]
    for answer in answers:
        assert answer.provenance == "computed"
        assert answer.caveat
        for verdict in ("erfüllt", "compliant", "zulässig", "Grenzwert von"):
            assert verdict not in answer.caveat
    opening = answers[0]
    assert "ROHBAULICHTE" in opening.caveat
    assert "DURCHGANGSBREITE" in opening.caveat


def test_clear_opening_width_aimed_at_a_wall_says_which_operator_wanted(house: SpatialModel) -> None:
    answer = cl.clear_opening_width(house, NORTH_WALL)
    assert answer.decidable is False
    assert "IfcWall" in answer.missing.what
    assert "hosts()" in answer.missing.remedy


# ════════════════════════════════════════════════════════════════════════════
# oriented_extent
# ════════════════════════════════════════════════════════════════════════════


def test_a_wall_skewed_thirty_degrees_is_measured_as_itself(hand_built: SpatialModel) -> None:
    """4.00 × 0.30 × 2.50 m, turned 30° in plan, all of it known on paper.

    The axis-aligned box is 4·cos30° + 0.3·sin30° = 3.6141 m by
    4·sin30° + 0.3·cos30° = 2.2598 m: a wall reported as 3.61 m long and 2.26 m
    thick. The 2.26 m is the number that would end up in a sentence about a wall
    thickness.
    """
    answer = cl.oriented_extent(hand_built, SKEWED_WALL)
    assert answer.decidable
    value = answer.value
    assert value["length"] == pytest.approx(4.0, abs=1e-6)
    assert value["width"] == pytest.approx(0.3, abs=1e-6)
    assert value["height"] == pytest.approx(2.5, abs=1e-6)
    assert value["deviation"] == pytest.approx(30.0, abs=1e-6)
    assert value["axisAligned"] is False

    box = op.extent(hand_built, SKEWED_WALL).value
    assert box["width"] == pytest.approx(4 * math.cos(math.radians(30)) + 0.3 * math.sin(math.radians(30)), abs=1e-6)
    assert box["depth"] == pytest.approx(4 * math.sin(math.radians(30)) + 0.3 * math.cos(math.radians(30)), abs=1e-6)
    # 1.20 m² of wall reported as 8.17 m² of bounding box.
    assert value["footprintArea"] == pytest.approx(1.2, abs=1e-6)
    assert value["axisAlignedFootprintArea"] == pytest.approx(8.1672, abs=1e-3)


def test_without_a_declared_north_the_shape_is_still_answered(hand_built: SpatialModel) -> None:
    """Unlike ``azimuth``, this does not refuse: the length and width are facts in
    model coordinates whether or not anybody said which way north is. What changes
    is that ``rotation`` stops being a compass bearing, and the answer says so."""
    assert hand_built.true_north is None
    answer = cl.oriented_extent(hand_built, SKEWED_WALL)
    assert answer.decidable
    assert answer.value["northKnown"] is False
    assert "TrueNorth" in answer.caveat
    assert "KEINE Himmelsrichtung" in answer.caveat


def test_an_axis_aligned_wall_says_that_extent_would_have_done(house: SpatialModel) -> None:
    answer = cl.oriented_extent(house, NORTH_WALL)
    assert answer.value["axisAligned"] is True
    assert answer.value["deviation"] < 1e-9
    box = op.extent(house, NORTH_WALL).value
    assert answer.value["length"] == pytest.approx(box["width"], abs=1e-9)
    assert answer.value["width"] == pytest.approx(box["depth"], abs=1e-9)
    assert "extent() liefert dieselben Zahlen" in answer.caveat


def test_every_wall_window_and_door_of_this_house_is_axis_aligned(house: SpatialModel) -> None:
    """The claim behind :data:`AXIS_ALIGNED_DEGREES`, checked rather than assumed."""
    worst = 0.0
    for element in house.file.by_type("IfcProduct"):
        if not any(element.is_a(kind) for kind in ("IfcWall", "IfcWindow", "IfcDoor", "IfcSpace")):
            continue
        answer = cl.oriented_extent(house, element.GlobalId)
        if answer.decidable:
            worst = max(worst, answer.value["deviation"])
            assert answer.value["axisAligned"] is True
    assert worst < 1.2e-13


def test_the_skewed_chair_is_1116_by_973_and_not_1428_by_1400(house: SpatialModel) -> None:
    """``Furniture_Chair_Viper:1120x940x350mm`` at 37° off the model axes.

    The oriented long side is 1.116 m against the type name's 1120 mm — four
    millimetres, which is the chair's own hull rather than its nominal box. The
    axis-aligned 1.428 m is a dimension of nothing at all, and the footprint it
    implies is 84 % too large.
    """
    answer = cl.oriented_extent(house, CHAIR)
    value = answer.value
    assert value["length"] == pytest.approx(1.1163, abs=1e-3)
    assert value["width"] == pytest.approx(0.9731, abs=1e-3)
    assert value["deviation"] == pytest.approx(37.0, abs=0.05)
    assert value["axisAligned"] is False

    box = op.extent(house, CHAIR).value
    assert box["width"] == pytest.approx(1.4281, abs=1e-3)
    assert box["depth"] == pytest.approx(1.4004, abs=1e-3)
    inflation = value["axisAlignedFootprintArea"] / value["footprintArea"]
    assert inflation == pytest.approx(1.84, abs=0.01)

    # The same chair type at a different angle must measure the same chair.
    other = cl.oriented_extent(house, OTHER_CHAIR).value
    assert other["length"] == pytest.approx(value["length"], abs=1e-6)
    assert other["width"] == pytest.approx(value["width"], abs=1e-6)
    assert other["deviation"] == pytest.approx(35.0, abs=0.05)


def test_the_minimum_area_rectangle_is_exact_on_a_hand_rotated_rectangle() -> None:
    angle = math.radians(30)
    rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    corners = np.array([[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]]) @ rotation.T

    length, width, axis = cl._minimum_area_rectangle(corners)
    assert length == pytest.approx(2.0, abs=1e-12)
    assert width == pytest.approx(1.0, abs=1e-12)
    assert length * width == pytest.approx(2.0, abs=1e-12)
    # The axis is a direction-free line, so ±180° is the same answer.
    bearing = math.degrees(math.atan2(axis[1], axis[0])) % 180.0
    assert bearing == pytest.approx(30.0, abs=1e-9)


def test_the_hand_rolled_calipers_agree_with_shapely(house: SpatialModel) -> None:
    """``shapely.minimum_rotated_rectangle`` exists in 2.1.2 and is trustworthy.

    It is not used — a polygon hands back four corners and neither the axis nor
    the two extents — but it is an independent implementation of the same theorem,
    so it is worth exactly one assertion: they must agree.
    """
    assert hasattr(shapely, "minimum_rotated_rectangle")
    for global_id in (CHAIR, OTHER_CHAIR, NORTH_WALL, ROOF):
        points = house.geometry(global_id).verts[:, :2]
        length, width, _ = cl._minimum_area_rectangle(points)
        reference = shapely.minimum_rotated_rectangle(shapely.MultiPoint([tuple(p) for p in points]))
        assert length * width == pytest.approx(reference.area, rel=1e-12)


def test_sampling_angles_instead_of_hull_edges_would_have_missed_it(house: SpatialModel) -> None:
    """Why only hull edges are tried, with the number the shortcut would produce.

    A 5° sweep over the chair returns 1.148 m² at 35°, 5.7 % above the true
    1.086 m² at 37°, and puts the long axis 2° out. The rectangle it describes is
    a real rectangle that contains the chair — it is simply not the smallest one,
    and "not the smallest" always errs on the side of too big.
    """
    points = house.geometry(CHAIR).verts[:, :2]
    length, width, _ = cl._minimum_area_rectangle(points)
    exact = length * width

    best = min(
        float(np.ptp(points @ np.array([math.cos(a), math.sin(a)])))
        * float(np.ptp(points @ np.array([-math.sin(a), math.cos(a)])))
        for a in np.radians(np.arange(0.0, 90.0, 5.0))
    )
    assert exact == pytest.approx(1.0862, abs=1e-3)
    assert best == pytest.approx(1.1481, abs=1e-3)
    assert best > exact


def test_a_footprint_with_no_area_has_no_oriented_box() -> None:
    """Collinear points are a line, not a rectangle, and the operator must say so
    rather than return a zero-width box that reads like a measurement."""
    line = np.array([[0.0, 0.0], [1.0, 1.0], [2.0, 2.0], [3.0, 3.0]])
    assert cl._minimum_area_rectangle(line) is None


def test_the_answers_carry_the_envelope_the_rest_of_the_library_does(house: SpatialModel) -> None:
    for answer, method, sources in (
        (cl.clear_width(house, ROOF, PARTITION), f"clearWidth({ROOF}, {PARTITION})", [ROOF, PARTITION]),
        (cl.oriented_extent(house, CHAIR), f"orientedExtent({CHAIR})", [CHAIR]),
    ):
        assert answer.method == method  # the method reads back like the call
        assert answer.from_ == sources
        assert answer.unit == "m"
        assert answer.tolerance == op.DIMENSION_TOLERANCE
        assert answer.to_dict()["from"] == sources

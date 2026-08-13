"""Defects an adversarial review reproduced, each pinned so it cannot return.

None of these failed a test when they were found. That is the point of the file:
the suite was green and the operators were wrong, because every test had been
written by whoever wrote the code and asked it the questions it was built to
answer. These ask the questions it was not.

Ordered as the review ordered them — by whether they would change a number an
architect signs.
"""

from __future__ import annotations

from pathlib import Path

import ifcopenshell
import ifcopenshell.util.shape as us
import numpy as np
import pytest
from ifc_spatial import briefing as br
from ifc_spatial import operators as op
from ifc_spatial.envelope import computed
from ifc_spatial.envelope import declared
from ifc_spatial.envelope import triangulate
from ifc_spatial.geometry import dominant_plane
from ifc_spatial.geometry import dominant_vertical_plane
from ifc_spatial.geometry import outermost_parallel_face
from ifc_spatial.model import SpatialModel
from ifc_spatial.model import WrongKindError
from ifc_spatial.model import _unit_scale_to_si
from ifc_spatial.tools import ToolError
from ifc_spatial.tools import call
from ifc_spatial.tools import create_tools

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
STACKED = FIXTURES / "geschossdecke-und-fenster.ifc"
NO_BODIES = FIXTURES / "haus-mit-raeumen.ifc"
FEET = FIXTURES / "einheiten-fuss.ifc"

LIVING = "3w0zWKm7n8SB1qbfwUzt0U"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
LOFT = "09J5N7xMHBfQZeQGAEMota"

NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
SOUTH_WALL = "3cUkl32yn9qRSPvBJVyWy4"
GROUND_SLAB = "3cUkl32yn9qRSPvBJVyWgQ"
SIMPLE_FLOOR = "3ntFzSulnDNeQ4nJrMgcOt"
CURTAIN_PANE = "3cUkl32yn9qRSPvBJVyW_5"
BEDROOM_WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
#: `einheiten-fuss.ifc` declares this wall and gives it no representation.
BODYLESS_WALL = "3Fuss000000Wall000001"


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(HOUSE))


@pytest.fixture(scope="module")
def tools() -> list:
    return create_tools()


@pytest.fixture(scope="module")
def handle(tools: list) -> str:
    return call(tools, "open_model", {"path": str(HOUSE)})["model"]


class TestAdjacencyIsNotStacking:
    """Two rooms on either side of the same floor slab are not neighbours.

    `geschossdecke-und-fenster.ifc` was authored to pin exactly this — its header
    records a real export in which one slab produced 4 278 false pairs — and no
    test had ever run `adjacentSpaces` against it.
    """

    def test_a_shared_floor_does_not_make_two_rooms_adjacent(self) -> None:
        model = SpatialModel(str(STACKED))
        answer = op.adjacent_spaces(model, "4Decke00000Space00001")
        names = {ref.name for ref in (answer.value or [])}
        assert "Kueche" in names, "a genuinely adjacent room was lost"
        assert "Bad" not in names, "rooms stacked across a slab came back as neighbours"

    def test_the_conclusion_is_never_declared_however_declared_its_inputs(self) -> None:
        """The file states which elements bound each room. It nowhere states
        that two rooms are neighbours — that is our set-intersection over two
        declared lists, and stamping it `declared` hands the reader our
        inference as the architect's own statement.

        It also silently dropped the caveat, because only the computed branch
        carried one.
        """
        model = SpatialModel(str(STACKED))
        answer = op.adjacent_spaces(model, "4Decke00000Space00001")
        assert answer.provenance == "computed"
        assert answer.caveat
        assert "NICHT begehbare Verbindung" in answer.caveat
        # And it says the inputs were declared, which is the part that IS true.
        assert "deklariert" in answer.caveat

    def test_the_sample_house_still_finds_its_real_neighbours(self, house: SpatialModel) -> None:
        answer = op.adjacent_spaces(house, BEDROOM)
        assert {"Living room", "Entrance hall"} <= {r.name for r in (answer.value or [])}


class TestLightEntryAreaCountsEachOpeningOnce:
    def test_a_doubled_space_boundary_does_not_double_the_ratio(self, house: SpatialModel) -> None:
        """A 2nd-level export publishes one IfcRelSpaceBoundary PER FACE.

        `bounds` therefore returns the same window twice and the sum doubled —
        the bedroom reported 28.41 % against a true 14.21 %, listing one
        GlobalId in two lines. The better the export, the more reliably it hit.
        """
        answer = op.light_entry_area(house, BEDROOM)
        value = answer.value
        ids = [entry["globalId"] for entry in value["openings"]]
        assert len(ids) == len(set(ids)), "the same opening was counted twice"
        assert abs(value["percent"] - 14.21) < 0.05

    def test_an_opening_is_split_between_the_rooms_it_passes(self, house: SpatialModel) -> None:
        """A curtain wall runs past a floor.

        The 31.09 m² facade spans z 0–3.36 and was credited IN FULL to the
        living room (z 0–2.5) and IN FULL to the 1.00 m loft above it, which
        came out at 40.65 %. Two rooms cannot each own all of the same glass.
        """
        living = op.light_entry_area(house, LIVING).value
        loft = op.light_entry_area(house, LOFT).value

        assert living["percent"] < 72.0, "the living room still claims glass above its ceiling"
        assert loft["percent"] < 15.0, "the loft still claims the full-height facade"
        # Each room keeps a real share rather than being zeroed by the clip.
        assert living["lightEntryArea"] > 25.0
        assert loft["lightEntryArea"] > 1.0


class TestTheDoorHeuristicOnlyJudgesDoors:
    def test_glazing_without_is_external_is_undetermined_not_internal(self, tmp_path) -> None:
        """`_faces_outside`'s fallback is "touches two rooms, therefore
        interior" — a DOOR heuristic. A curtain-wall pane runs past a floor and
        touches two rooms, so on an export without `IsExternal` six panes of a
        glass facade were labelled „Innentür" and the living room fell from
        72.42 % to 12.64 %.

        Undetermined is the honest answer: neither counted nor discarded.
        """
        model = ifcopenshell.file(schema="IFC4")
        plate = model.create_entity("IfcPlate", GlobalId=ifcopenshell.guid.new())
        door = model.create_entity("IfcDoor", GlobalId=ifcopenshell.guid.new())

        class _Stub(SpatialModel):
            def __init__(self) -> None:  # no file to open
                self.file = model

            def declared_property(self, element, names):
                return None

        stub = _Stub()
        # The plate cannot be judged by a door rule, so it must come back None.
        external, why = op._faces_outside(stub, plate)
        assert external is None
        assert "weder IsExternal" in why
        # A door still reaches the fallback (it has no boundaries here, so it
        # also ends undetermined — what matters is that the branch is entered).
        assert op._faces_outside(stub, door)[0] is None


class TestAnSiPrefixOnAnAreaIsSquared:
    """A centimetre is a hundredth of a metre; a SQUARE centimetre is a
    ten-thousandth of a square metre.

    Applied linearly, a correct declared area came out 100x wrong and
    `triangulate` published the gap as a 99 % „WIDERSPRUCH zwischen zwei Wegen
    zu dieser Zahl" — a fabricated finding against a file that was right.
    """

    @pytest.mark.parametrize(
        ("prefix", "unit_type", "name", "expected"),
        [
            ("CENTI", "AREAUNIT", "SQUARE_METRE", 1e-4),
            ("MILLI", "AREAUNIT", "SQUARE_METRE", 1e-6),
            ("MILLI", "VOLUMEUNIT", "CUBIC_METRE", 1e-9),
            # The linear case must not regress in the other direction.
            ("CENTI", "LENGTHUNIT", "METRE", 1e-2),
            ("MILLI", "LENGTHUNIT", "METRE", 1e-3),
            (None, "AREAUNIT", "SQUARE_METRE", 1.0),
        ],
    )
    def test_the_prefix_is_raised_to_the_units_dimension(self, prefix, unit_type, name, expected) -> None:
        model = ifcopenshell.file(schema="IFC4")
        unit = model.create_entity("IfcSIUnit", UnitType=unit_type, Prefix=prefix, Name=name)
        assert _unit_scale_to_si(unit) == pytest.approx(expected, rel=1e-12)


# ════════════════════════════════════════════════════════════════════════════
# The second pass — the ENGINE-side findings the first commit left standing.
# ════════════════════════════════════════════════════════════════════════════


class TestACallerMistakeIsNotAFindingAboutTheExport:
    """`decidable: false` means „die Datei kann das nicht" and carries a remedy
    an architect performs in their CAD. Aiming an operator at the wrong element
    is neither of those things.

    The review's sweep put a number on it: **316 of 1 850** `measure`/`relations`
    calls over the five fixtures came back rendered as „NICHT ENTSCHEIDBAR:
    dieser Export liefert … nicht. Das ist ein Befund über den EXPORT" — for
    files with nothing wrong with them.
    """

    def test_asking_a_window_for_a_room_height_raises_instead_of_answering(self, house: SpatialModel) -> None:
        with pytest.raises(WrongKindError) as raised:
            op.clear_height(house, BEDROOM_WINDOW)
        message = str(raised.value)
        # It says whose mistake it is …
        assert "Fehler im Aufruf" in message
        assert "an dieser Datei ist nichts zu ändern" in message
        # … and it still points at the operator that would answer.
        assert "extent()" in message

    def test_no_operator_publishes_a_wrong_kind_as_an_undecidable(self, house: SpatialModel) -> None:
        """A sweep in the review's own shape, on the operators reachable through
        `measure` and `relations`, aimed at three deliberately wrong subjects.

        Every refusal must be an exception. Not one may be an `Answer` — because
        an `Answer` with `decidable: false` is a statement about the export.
        """
        from ifc_spatial.tools import MEASURE_FN
        from ifc_spatial.tools import RELATION_FN

        subjects = [BEDROOM, NORTH_WALL, CURTAIN_PANE]
        seen_refusals = 0
        for fn in (*MEASURE_FN.values(), *RELATION_FN.values()):
            for subject in subjects:
                try:
                    answer = fn(house, subject)
                except WrongKindError:
                    seen_refusals += 1
                    continue
                if answer.decidable:
                    continue
                assert "erwartet" not in (answer.missing.what if answer.missing else ""), (
                    f"{answer.method} published a wrong-kind refusal as a finding about the export"
                )
        assert seen_refusals > 0, "the sweep never hit a wrong kind — it is not testing anything"

    def test_the_tool_layer_turns_it_into_a_readable_refusal(self, tools: list, handle: str) -> None:
        """`clearWidth` on a curtain-wall pane — the review's own reproduction.

        It rendered as „dieser Export liefert clearOpeningWidth() erwartet eine
        Öffnung … bekam IfcPlate nicht" — ungrammatical, and an accusation.
        """
        with pytest.raises(ToolError) as raised:
            call(tools, "measure", {"model": handle, "globalId": CURTAIN_PANE, "measure": "clearWidth"})
        assert "IfcPlate" in str(raised.value)
        assert "Fehler im Aufruf" in str(raised.value)

    def test_the_element_menu_still_probes_without_blowing_up(self, tools: list, handle: str) -> None:
        """The one caller for which a wrong kind is a QUESTION.

        `element` asks every non-geometric relation whether it applies. A room
        answers `hosts` with "no", and that has to stay a skipped menu entry
        rather than an exception out of the tool.
        """
        out = call(tools, "element", {"model": handle, "globalId": BEDROOM})
        # `contains` applies to a space and answers; `hosts` and `fillerOf` do
        # not apply to one and used to be skipped on `decidable is False`. They
        # now raise inside the loop and must still be skipped.
        assert out["available"] == ["contains"]
        assert out["element"]["ifcType"] == "IfcSpace"


class TestTheNoGeometryRefusalIsNotDoublyNegated:
    """`_provenance_line` renders „dieser Export liefert {what} nicht", so a
    `what` beginning with „keine" produces a sentence meaning the opposite:

        dieser Export liefert keine geometrische Repräsentation für IfcWall
        „Aussenwand“ in dieser Datei nicht.
    """

    def test_a_missing_body_reads_as_one_negation(self) -> None:
        model = SpatialModel(str(FEET))
        answer = op.extent(model, BODYLESS_WALL)
        assert not answer.decidable
        what = answer.missing.what
        assert not what.startswith("kein")
        assert what == "Körpergeometrie für IfcWall „Aussenwand“"
        # The sentence the reader gets, spelled out:
        assert f"dieser Export liefert {what} nicht." == (
            "dieser Export liefert Körpergeometrie für IfcWall „Aussenwand“ nicht."
        )

    def test_a_body_the_kernel_rejects_reads_the_same_way(self) -> None:
        model = SpatialModel(str(NO_BODIES))
        space = model.file.by_type("IfcSpace")[0]
        answer = op.extent(model, space.GlobalId)
        assert not answer.decidable
        assert not answer.missing.what.startswith("kein")
        # The two failures still say different things — that distinction is what
        # `_no_geometry` exists for and it survives the rewording.
        assert "Geometriekern" in answer.missing.what


class TestTheBriefingDoesNotPromiseGeometryAFileHasNot:
    """„sie sind aber berechenbar, dieser Export trägt Geometrie" was
    unconditional. Four of the five fixtures carry a `Representation` on ZERO
    products, and every one of them was told the geometric answers were one call
    away — costing the agent a geometry pass and a turn, and propagating into the
    IDS summary.
    """

    @pytest.mark.parametrize("fixture", [NO_BODIES, FEET, STACKED])
    def test_a_file_with_no_bodies_is_told_so(self, fixture: Path) -> None:
        model = SpatialModel(str(fixture))
        assert not [p for p in model.file.by_type("IfcProduct") if getattr(p, "Representation", None)]
        spots = br._geometry_blind_spots(model)
        assert len(spots) == 1
        assert "trägt Geometrie" not in spots[0].consequence
        assert "NICHT berechenbar" in spots[0].consequence
        # And the remedy is a re-export, not a call that cannot help.
        assert "neu exportieren" in spots[0].remedy

    def test_a_file_that_does_carry_bodies_keeps_the_old_promise(self) -> None:
        model = SpatialModel(str(HOUSE))
        assert model.geometry_seconds == 0.0
        spots = br._geometry_blind_spots(model)
        assert len(spots) == 1
        assert "berechenbar" in spots[0].consequence
        assert "measure/distance aufrufen" in spots[0].remedy
        # The claim is now backed by a count rather than asserted.
        assert "Bauteil(e) in diesem Export tragen Geometrie" in spots[0].consequence

    def test_the_rendered_briefing_says_it_too(self) -> None:
        model = SpatialModel(str(NO_BODIES))
        text = br.render_briefing(model)
        assert "dieser Export trägt Geometrie" not in text


class TestStoreyHeightsAreDeclaredNotMeasured:
    """`elevation` is `IfcBuildingStorey.Elevation` verbatim and `height` is one
    declared number minus the next. It came back `computed`, which renders as
    „aus der Geometrie berechnet, nicht deklariert" — contradicting this
    answer's own caveat („gebildet aus den deklarierten Höhenlagen") two lines
    further down.
    """

    def test_the_provenance_is_declared(self, house: SpatialModel) -> None:
        answer = br.storey_heights(house)
        assert answer.provenance == "declared"
        assert [entry["height"] for entry in answer.value] == [2.5, None]
        assert "deklarierten Höhenlagen" in answer.caveat

    def test_no_geometry_is_touched_on_the_way_there(self) -> None:
        """The reviewer's own instrument: a fresh model, and the geometry clock
        has to still read 0.000 afterwards. A `computed` answer from a call that
        never shapes anything is a provenance claim with nothing behind it."""
        model = SpatialModel(str(HOUSE))
        assert model.geometry_seconds == 0.0
        answer = br.storey_heights(model)
        assert answer.decidable
        assert model.geometry_seconds == 0.0

    def test_a_declared_value_carries_no_measurement_tolerance(self, house: SpatialModel) -> None:
        # A declared number has authoring error, not measurement error, and a ±
        # on it would invite a reader to treat the elevations as measured.
        assert br.storey_heights(house).tolerance is None


class TestAgreementIsSaidOutLoud:
    """`triangulate` wrote a caveat only on `disagree`. An agreeing pair came
    back a bare `computed` and rendered as „aus der Geometrie berechnet, **nicht
    deklariert**" — for the sample house's Bedroom, which declares
    `BaseQuantities.NetFloorArea = 15.41678125`.
    """

    def test_a_declared_area_that_agrees_is_not_reported_as_undeclared(self, house: SpatialModel) -> None:
        answer = op.floor_area(house, BEDROOM)
        assert answer.agreement == "agree"
        assert answer.value == pytest.approx(15.41678125, abs=1e-6)
        # The file DOES declare it, and the answer now says so.
        assert "DEKLARIERT" in answer.caveat
        assert "bestätigen diese Zahl" in answer.caveat
        assert "(declared)" in answer.caveat

    def test_two_computed_routes_do_not_claim_a_declaration(self) -> None:
        """`triangulate` takes any two routes. Naming a schedule entry that
        neither side came from would be the same false provenance, mirrored."""
        answer = triangulate(
            computed(10.0, unit="m²", tolerance=0.1, from_=["a"], method="a"),
            computed(10.05, unit="m²", tolerance=0.1, from_=["b"], method="b"),
        )
        assert answer.agreement == "agree"
        assert "DEKLARIERT" not in answer.caveat
        assert "Beide Wege führen zum selben Ergebnis" in answer.caveat

    def test_the_winning_answers_own_caveat_survives(self) -> None:
        """The verdict is appended, never substituted — a unit-conversion note
        or „Gemessene Grundfläche 0 m²" is a qualification the value is not
        valid without."""
        measured = computed(
            10.0, unit="m²", tolerance=0.1, from_=["a"], method="a", caveat="Gemessen an einer Ersatzfläche."
        )
        answer = triangulate(measured, declared(10.0, unit="m²", from_=["b"], method="b"))
        assert "Ersatzfläche" in answer.caveat
        assert "bestätigen diese Zahl" in answer.caveat

    def test_a_contradiction_still_reads_as_a_finding_about_the_export(self) -> None:
        answer = triangulate(
            computed(51.9948, unit="m²", tolerance=0.5, from_=["a"], method="a"),
            declared(45.0, unit="m²", from_=["b"], method="b"),
        )
        assert answer.agreement == "disagree"
        assert "widersprechen sich" in answer.caveat
        assert "DEKLARIERT" not in answer.caveat


class TestAFlatElementHasNoCompassBearing:
    """A slab has a rim, and the rim is vertical. `dominant_vertical_plane`
    found the biggest sliver of it and `azimuth` reported **0.0° / „N"** for the
    sample house's ground slab off 7.9 m² of edge faces — a facade bearing for a
    floor plate, which went into an orientation table as though it meant
    something.
    """

    @pytest.mark.parametrize("slab", [GROUND_SLAB, SIMPLE_FLOOR])
    def test_a_slab_refuses_rather_than_answering_off_its_edge(self, house: SpatialModel, slab: str) -> None:
        answer = op.azimuth(house, slab)
        assert not answer.decidable
        assert answer.value is None
        assert "senkrechte Hauptfläche" in answer.missing.what
        assert "waagrechtes Bauteil hat keine" in answer.missing.remedy
        # Not a wrong-kind refusal: an IfcSlab CAN be a vertical sandwich panel,
        # so this is a measured fact about this element and stays an answer.
        assert answer.provenance == "computed"

    def test_the_slab_really_does_have_vertical_faces_to_be_fooled_by(self, house: SpatialModel) -> None:
        """Without this the test above would pass for the wrong reason."""
        geo = house.geometry(GROUND_SLAB)
        assert dominant_vertical_plane(geo.triangles) is not None
        assert abs(float(dominant_plane(geo.triangles)[2])) == pytest.approx(1.0, abs=1e-6)

    def test_walls_and_windows_still_answer(self, house: SpatialModel) -> None:
        assert op.azimuth(house, NORTH_WALL).value == {"degrees": 0.0, "compass": "N"}
        assert op.azimuth(house, BEDROOM_WINDOW).decidable
        geo = house.geometry(NORTH_WALL)
        assert abs(float(dominant_plane(geo.triangles)[2])) < 1e-6


class TestASeatingWeightIsNotAFaceArea:
    """`outermost_parallel_face` sums the triangle areas in the merged outermost
    bin. Coincident and opposite-facing triangles are added together, so the
    sample house's south wall reported **23.527 m²** where the union of those
    same triangles — the real outer face — is **17.776 m²**, a 32 % overstatement
    of a facade.

    The number is right for what it does — choosing among candidate planes — and
    wrong for anything a reader would call an area, so it is named `support` and
    `facadePlaneOf` no longer publishes it.
    """

    def test_the_plane_carries_no_field_a_caller_can_read_as_an_area(self, house: SpatialModel) -> None:
        geo = house.geometry(SOUTH_WALL)
        normal = dominant_vertical_plane(geo.triangles)
        plane = outermost_parallel_face(geo.triangles, normal)
        assert not hasattr(plane, "area")
        # The double count is still there — it is what the seating votes on.
        assert plane.support == pytest.approx(23.5269, abs=1e-3)

    def test_the_summed_weight_really_does_exceed_the_face(self, house: SpatialModel) -> None:
        """The measurement behind the number in this class's docstring, so that
        a future change to the binning cannot quietly make the two agree while
        the field is still called a weight."""
        import shapely.geometry as sg
        import shapely.ops as so

        geo = house.geometry(SOUTH_WALL)
        normal = dominant_vertical_plane(geo.triangles)
        normals, areas = op.triangle_normals_areas(geo.triangles)
        parallel = np.abs(normals @ normal) >= 0.985
        tris = geo.triangles[parallel]
        offsets = tris[:, 0] @ normal
        outer = np.abs(offsets - offsets.max()) <= 0.02
        summed = float(areas[parallel][outer].sum())
        union = so.unary_union([sg.Polygon([(p[0], p[2]) for p in t]) for t in tris[outer]]).area
        assert summed == pytest.approx(23.5269, abs=1e-3)
        assert union == pytest.approx(17.7761, abs=1e-3)
        assert summed > union * 1.3

    def test_the_facade_plane_answer_publishes_position_and_direction_only(self, house: SpatialModel) -> None:
        answer = op.facade_plane_of(house, SOUTH_WALL)
        assert set(answer.value) == {"normal", "point", "outward"}
        # It is still seated on a real surface — that is what the operator is
        # for. Facing out of the building (−Y), the south wall's outer leaf sits
        # at y = −1.3914, which is a plane the wall really has.
        assert answer.value["outward"] is True
        assert answer.value["normal"] == pytest.approx([0.0, -1.0, 0.0], abs=1e-6)
        assert answer.value["point"][1] == pytest.approx(-1.3914, abs=0.005)


class TestAHandedOutTriangulationOutlivesTheNextGeometryCall:
    """`geometry()` shaped the element again and overwrote `self._shapes[gid]`.
    `util.shape`'s readers hand back NumPy views over the shape's C++ buffer, so
    dropping the last reference freed the triangulation a caller was already
    holding — which is the exact failure the „shapes we own, kept alive on
    purpose" comment in `SpatialModel.__init__` is about.
    """

    def test_the_volume_readable_before_is_readable_after(self) -> None:
        model = SpatialModel(str(HOUSE))
        triangulation = model.triangulation(BEDROOM)
        before = us.get_volume(triangulation)
        assert before == pytest.approx(38.54195, abs=1e-4)

        # This used to raise `IndexError: list index out of range` on the line
        # below, because `geometry()` had rebuilt the shape underneath it.
        assert model.geometry(BEDROOM) is not None
        assert us.get_volume(triangulation) == pytest.approx(before, abs=1e-9)

    def test_the_other_order_survives_too(self) -> None:
        model = SpatialModel(str(HOUSE))
        assert model.geometry(BEDROOM) is not None
        triangulation = model.triangulation(BEDROOM)
        assert us.get_volume(triangulation) == pytest.approx(38.54195, abs=1e-4)

    def test_the_shape_is_built_once_and_only_once(self) -> None:
        """The mechanism, not only the symptom: a second `create_shape` for an
        id we already hold is what freed the first one."""
        model = SpatialModel(str(HOUSE))
        model.triangulation(BEDROOM)
        first = model._shapes[BEDROOM]
        model.geometry(BEDROOM)
        assert model._shapes[BEDROOM] is first


class TestAnInvalidRoomKindIsARefusalAndNotATraceback:
    """`tools.room_inventory` passed `kind` straight through and
    `briefing.inventory` indexed `GERMAN_KIND` with it — `KeyError: ''` out of
    `briefing.py`. Every other enum in `tools.py` answers with a German sentence
    naming the allowed values; `mcp_server` hands arguments here unfiltered, so
    the JSON Schema's `required` is not a guard.
    """

    def test_a_missing_kind_names_the_three_that_exist(self, tools: list, handle: str) -> None:
        with pytest.raises(ToolError) as raised:
            call(tools, "room_inventory", {"model": handle})
        assert "aufenthaltsraum" in str(raised.value)
        assert "nebenraum" in str(raised.value)
        assert "erschliessung" in str(raised.value)

    def test_an_unknown_kind_is_named_back_to_the_caller(self, tools: list, handle: str) -> None:
        with pytest.raises(ToolError) as raised:
            call(tools, "room_inventory", {"model": handle, "kind": "wohnraum"})
        assert '"wohnraum"' in str(raised.value)

    def test_a_valid_kind_still_answers(self, tools: list, handle: str) -> None:
        out = call(tools, "room_inventory", {"model": handle, "kind": "aufenthaltsraum"})
        assert out["provenance"] == "inferred"
        assert out["value"]


class TestACaptionMayNotDescribeADrawingThatIsNotThere:
    """`render.plan` returns `None` only when there is neither structure NOR a
    room, so a storey with a room outline and nothing crossing the 1.2 m cut
    came back as a page with `elementsDrawn: 0` — captioned „auf dieser Höhe
    erscheinen Tür- und Fensteröffnungen als Lücken in der Wand". An agent
    reading that in front of the picture concludes the loft has no walls.
    """

    def test_an_empty_plan_says_that_nothing_was_drawn(self, tools: list, handle: str) -> None:
        out = call(tools, "view", {"model": handle, "storey": "Roof"})
        assert out["elementsDrawn"] == 0
        assert out["rooms"] == ["Roof"]
        note = out["note"]
        assert "KEIN Bauteil gezeichnet" in note
        assert "elementsDrawn = 0" in note
        # And it says what the absence does NOT mean.
        assert "keine Aussage über das Gebäude" in note
        # The sentence about window openings is gone — there are no walls to
        # have openings in.
        assert "Lücken in der Wand" not in note

    def test_a_plan_that_did_draw_something_keeps_its_caption(self, tools: list, handle: str) -> None:
        out = call(tools, "view", {"model": handle, "storey": "Ground Floor"})
        assert out["elementsDrawn"] == 26
        assert "Lücken in der Wand" in out["note"]
        assert "KEIN Bauteil" not in out["note"]

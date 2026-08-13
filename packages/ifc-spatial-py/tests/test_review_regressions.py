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
from ifc_spatial import daylight as dl
from ifc_spatial import envelope_geometry as eg
from ifc_spatial import fire
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
HALL = "3w0zWKm7n8SB1qbfwUzt0G"
LOFT = "09J5N7xMHBfQZeQGAEMota"

NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
#: The living room's interior partition — an external wall with no window in
#: `TestOnlyFacadesWithAnOpeningAreCountedAsSuch`.
PARTITION = "3cUkl32yn9qRSPvBJVyWXt"
SOUTH_WALL = "3cUkl32yn9qRSPvBJVyWy4"
GROUND_SLAB = "3cUkl32yn9qRSPvBJVyWgQ"
SIMPLE_FLOOR = "3ntFzSulnDNeQ4nJrMgcOt"
CURTAIN_PANE = "3cUkl32yn9qRSPvBJVyW_5"
BEDROOM_WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
#: `Doors_IntSgl:810x2110mm` — the interior door in
#: `TestAWindowsDeclaredAreaIsNotAnOpeningArea`, which publishes a
#: `BaseQuantities.Area` of its own that is not an opening area either.
INTERNAL_DOOR = "3cUkl32yn9qRSPvBJVyWaG"
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
    """`_faces_outside`'s fallback is „touches two rooms, therefore interior".

    That is a DOOR rule. A curtain-wall pane runs past a floor and touches two
    rooms, so on an export without `IsExternal` six panes of a glass facade were
    labelled „Innentür" and the living room fell from 72.42 % to 12.64 %.

    ## Why this class is written the hard way

    Its first version stubbed `opens_to` out of existence: the stub model
    declared no boundaries, so the plate never entered the two-space branch and
    landed on the same `return None` that every unjudgeable element lands on.
    It passed against the BROKEN code and against the fixed code alike, which is
    worse than no test — a commit message cited it as proof of a fix that was
    never in the tree.

    So `opens_to` is patched to report two spaces, which is the condition the
    defect actually needs. Verify by reverting the `is_a("IfcDoor")` guard: the
    plate assertion must go red.
    """

    class _Stub(SpatialModel):
        """A model with no file to open and no declared properties."""

        def __init__(self, file) -> None:
            self.file = file

        def declared_property(self, element, names):
            return None

    @staticmethod
    def _two_spaces(monkeypatch) -> None:
        """`opens_to` reports two rooms — the branch the defect lives in."""
        monkeypatch.setattr(
            op,
            "opens_to",
            lambda model, gid: computed([object(), object()], from_=[gid], method="stub"),
        )

    def test_a_pane_touching_two_rooms_is_undetermined_not_interior(self, monkeypatch) -> None:
        model = ifcopenshell.file(schema="IFC4")
        plate = model.create_entity("IfcPlate", GlobalId=ifcopenshell.guid.new())
        self._two_spaces(monkeypatch)

        external, why = op._faces_outside(self._Stub(model), plate)
        assert external is None, "a glass pane was judged by a door rule"
        assert "Innentür" not in why
        assert "weder IsExternal" in why

    def test_a_door_touching_two_rooms_still_is_interior(self, monkeypatch) -> None:
        """The heuristic is not deleted — for a DOOR it is exactly right, and an
        interior door counted as daylight is the bug the split came from."""
        model = ifcopenshell.file(schema="IFC4")
        door = model.create_entity("IfcDoor", GlobalId=ifcopenshell.guid.new())
        self._two_spaces(monkeypatch)

        external, why = op._faces_outside(self._Stub(model), door)
        assert external is False
        assert "Innentür" in why

    def test_a_declared_is_external_still_outranks_everything(self, monkeypatch) -> None:
        model = ifcopenshell.file(schema="IFC4")
        plate = model.create_entity("IfcPlate", GlobalId=ifcopenshell.guid.new())
        self._two_spaces(monkeypatch)

        class _Declares(self._Stub):
            def declared_property(self, element, names):
                return True

        external, why = op._faces_outside(_Declares(model), plate)
        assert external is True
        assert "deklariert" in why


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


def _second_level_export(path: Path) -> SpatialModel:
    """The sample house with the bedroom's boundaries written 2nd-level.

    A 2nd-level exporter publishes one ``IfcRelSpaceBoundary`` row per boundary
    SURFACE, so a wall or a window that bounds the room across two faces arrives
    twice. Here every element `bounds` derives for the bedroom is written as a
    declared row, and the walls and the window are written twice — which is what
    the real export does and what makes `bounds` prefer the declared route.
    """
    file = ifcopenshell.open(str(HOUSE))
    space = file.by_guid(BEDROOM)
    derived = op.bounds(SpatialModel(str(HOUSE)), BEDROOM)
    for ref in derived.value or []:
        element = file.by_guid(ref.global_id)
        rows = 2 if element.is_a() in ("IfcWindow", "IfcWall", "IfcWallStandardCase") else 1
        for part in range(rows):
            file.create_entity(
                "IfcRelSpaceBoundary",
                GlobalId=ifcopenshell.guid.new(),
                Name=f"{ref.global_id}-Flaeche{part}",
                RelatingSpace=space,
                RelatedBuildingElement=element,
                PhysicalOrVirtualBoundary="PHYSICAL",
                InternalOrExternalBoundary="EXTERNAL",
            )
    file.write(str(path))
    return SpatialModel(str(path))


class TestBoundsReturnsEachElementOnce:
    """One element, one entry — deduplicated in `bounds` and not in the callers.

    `light_entry_area` had already been patched against this (28.41 % against a
    true 14.21 % on the bedroom), and the same duplicate row was still reaching
    `daylight.room_depth` and `fire.separating_elements`, which were written
    afterwards. Six operators call `bounds`; the seventh would have inherited it.
    """

    def test_a_boundary_written_per_face_yields_one_reference(self, tmp_path: Path) -> None:
        model = _second_level_export(tmp_path / "zweite-ebene.ifc")
        answer = op.bounds(model, BEDROOM)
        assert answer.provenance == "declared", "the declared route is the one that carries the duplicates"
        ids = [ref.global_id for ref in (answer.value or [])]
        assert len(ids) == len(set(ids)), "one element came back once per boundary surface"
        assert BEDROOM_WINDOW in ids
        # `from_` is the provenance trail and must not repeat either.
        assert len(answer.from_) == len(set(answer.from_))

    def test_the_facade_ranking_does_not_double_its_aperture(self, tmp_path: Path) -> None:
        """The bedroom's north wall carries ONE 2.1901 m² window.

        Summed per boundary row it came back as 4.3802 m² „aus 2 Öffnung(en)" —
        enough to outrank a genuinely larger facade and measure the depth
        perpendicular to the wrong wall, which on a rectangular room is its
        width.
        """
        model = _second_level_export(tmp_path / "zweite-ebene.ifc")
        bounding = [model.file.by_guid(ref.global_id) for ref in op.bounds(model, BEDROOM).value]
        candidates = {c["globalId"]: c for c in dl._facade_candidates(model, BEDROOM, bounding)}
        north = candidates[NORTH_WALL]
        assert north["apertureArea"] == pytest.approx(2.1901, abs=5e-4)
        assert north["apertures"] == [BEDROOM_WINDOW]
        assert dl.room_depth(model, BEDROOM).value["facade"]["why"].count("1 Öffnung(en)") == 1

    def test_a_separating_wall_is_listed_once_and_both_ways_round(self, tmp_path: Path) -> None:
        """`separatingElements(a, b)` and `(b, a)` are the same question.

        `shared` was built by walking `bounds(b)` against a dict of `bounds(a)`,
        so the duplicates on whichever side was passed second survived: the
        entrance hall against the bedroom answered „6 Bauteile" with one wall
        twice under `trennend` and twice under `ohneFeuerwiderstand`, and the
        bedroom against the entrance hall answered „4 Bauteile".
        """
        model = _second_level_export(tmp_path / "zweite-ebene.ifc")
        forward = fire.separating_elements(model, HALL, BEDROOM).value
        backward = fire.separating_elements(model, BEDROOM, HALL).value
        for value in (forward, backward):
            for key in ("trennend", "gemeinsam"):
                ids = [entry["globalId"] for entry in value[key]]
                assert len(ids) == len(set(ids)), f"{key} listed one element twice"
            assert len(value["ohneFeuerwiderstand"]) == len(set(value["ohneFeuerwiderstand"]))
        assert [e["globalId"] for e in forward["trennend"]] == [e["globalId"] for e in backward["trennend"]]
        assert [e["globalId"] for e in forward["gemeinsam"]] == [e["globalId"] for e in backward["gemeinsam"]]


class TestOnlyFacadesWithAnOpeningAreCountedAsSuch:
    """„Dieser Raum hat N Außenwände mit Öffnungen" counted the blank ones too.

    `_facade_candidates` enters every external wall bounding the room, giving
    the ones that carry nothing `apertureArea = 0.0` so a caller may still name
    them. The caveat then reported `len(candidates)` under the words „mit
    Öffnungen", and the ranking printed in the same sentence contradicts it.
    """

    @staticmethod
    def _blank_external_wall(path: Path) -> SpatialModel:
        """The living room's partition, re-declared as a blank external wall.

        It hosts two interior doors, which `_faces_outside` rejects, so it lands
        in `candidates` with `apertureArea = 0.0` — a gable wall beside the two
        walls that do carry glass. A fresh `IfcPropertySingleValue` rather than
        an edit in place: the file shares one `IsExternal` property entity
        across many products, and writing through it flips the doors too.
        """
        file = ifcopenshell.open(str(HOUSE))
        wall = file.by_guid(PARTITION)
        for relation in wall.IsDefinedBy or []:
            pset = getattr(relation, "RelatingPropertyDefinition", None)
            if pset is None or not pset.is_a("IfcPropertySet") or pset.Name != "Pset_WallCommon":
                continue
            pset.HasProperties = [p for p in pset.HasProperties if p.Name != "IsExternal"] + [
                file.create_entity(
                    "IfcPropertySingleValue",
                    Name="IsExternal",
                    NominalValue=file.create_entity("IfcBoolean", True),
                )
            ]
        file.write(str(path))
        return SpatialModel(str(path))

    def test_a_blank_external_wall_is_not_a_facade_with_an_opening(self, tmp_path: Path) -> None:
        model = self._blank_external_wall(tmp_path / "fensterlose-giebelwand.ifc")
        bounding = [model.file.by_guid(ref.global_id) for ref in op.bounds(model, LIVING).value]
        candidates = dl._facade_candidates(model, LIVING, bounding)
        assert len(candidates) == 3
        assert sum(1 for c in candidates if c["apertureArea"] > 0) == 2

        caveat = dl.room_depth(model, LIVING).caveat
        assert "2 Außenwand/Außenwände mit Öffnungen" in caveat
        # The total is kept, because a blank wall is still a wall a depth could
        # be measured to — it is just not a daylight facade.
        assert "von 3 begrenzenden Außenwänden insgesamt" in caveat
        assert "3 Außenwände mit Öffnungen" not in caveat

    def test_the_sample_house_still_counts_its_two_glazed_facades(self, house: SpatialModel) -> None:
        caveat = dl.room_depth(house, LIVING).caveat
        assert "2 Außenwand/Außenwände mit Öffnungen" in caveat
        assert "von 2 begrenzenden Außenwänden insgesamt" in caveat


class TestTheDeclaredVolumeSumCoversTheMeasuredSpaces:
    """A space with no body must leave BOTH sums, or the file is called a liar.

    `declared_total` accumulated before the `continue` that skips an unmeasurable
    space, so Σ(declared over N) was reconciled against Σ(measured over N−1).
    """

    @staticmethod
    def _hall_without_a_body(path: Path) -> SpatialModel:
        file = ifcopenshell.open(str(HOUSE))
        file.by_guid(HALL).Representation = None
        file.write(str(path))
        return SpatialModel(str(path))

    def test_a_bodyless_space_does_not_fabricate_a_contradiction(self, tmp_path: Path) -> None:
        """All four of the sample house's spaces declare a volume, and all four
        declarations match their bodies to 1e-6 m³. Drop the entrance hall's
        representation and the answer read „die Datei widerspricht sich":
        244.995 m³ (computed) against 266.728 m³ (declared), 8.1 % apart, from
        nothing but the 21.734 m³ of a space that was counted on one side only.
        """
        model = self._hall_without_a_body(tmp_path / "raum-ohne-koerper.ifc")
        answer = eg.compactness(model)
        assert answer.decidable
        assert [v["globalId"] for v in answer.value["spaces"]] == [LIVING, BEDROOM, LOFT]
        assert answer.value["volume"] == pytest.approx(244.994532, abs=1e-4)
        assert answer.value["volumeAgreement"] == "agree"
        assert "widerspricht sich" not in answer.caveat

    def test_the_space_that_left_the_sum_is_named(self, tmp_path: Path) -> None:
        """V is a subtotal now, and a subtotal published as a total is the
        defect this package exists to prevent.
        """
        model = self._hall_without_a_body(tmp_path / "raum-ohne-koerper.ifc")
        caveat = eg.compactness(model).caveat
        assert "1 von 4 IfcSpace tragen keinen auswertbaren Körper" in caveat
        assert "Entrance hall" in caveat
        assert "V ist insofern eine Untergrenze" in caveat

    def test_the_intact_file_still_reconciles_both_routes(self, house: SpatialModel) -> None:
        answer = eg.compactness(house)
        assert answer.value["volumeAgreement"] == "agree"
        assert answer.value["volume"] == pytest.approx(266.728298, abs=1e-4)
        assert "keinen auswertbaren Körper" not in answer.caveat


class TestAWindowsDeclaredAreaIsNotAnOpeningArea:
    """A window's `Area` may never reach `triangulate`, whatever it turns out to be.

    Nothing in either engine reads `Qto_WindowBaseQuantities` or
    `OverallWidth`/`OverallHeight` today, so this is not a fix — it is the guard
    that keeps it that way, and the guard is one tuple wide: `floor_area` narrows
    its declared-quantity search to `("NetFloorArea", "GrossFloorArea")` for
    anything that is not an `IfcSpace`, and a window publishes neither.

    Widen that tuple by one entry and the sample house convicts itself. Its
    bedroom window declares `BaseQuantities.Area = 3.53486 m²` — a Revit *surface*
    figure, not an elevation area — while `floor_area` measures the window's
    horizontal footprint at **0.63928 m²**. `triangulate` would publish those as
    „Zwei Wege zu dieser Zahl widersprechen sich … Abweichung 81.9 %. Das ist ein
    Befund über den Export" against a file that is right, and the architect would
    be told to go and fix a window that has nothing wrong with it.

    The measured shape of the trap, on this file:

    | route | bedroom window | interior door |
    |---|---|---|
    | `OverallWidth × OverallHeight` | 2.19010 m² | 1.70910 m² |
    | opening geometry (Rohbaulichte) | 2.19010 m² | 1.70910 m² |
    | declared `BaseQuantities.Area` | 3.53486 m² | 2.27348 m² |

    Note which pair is the dangerous one. The nominal rectangle and the clear
    opening are the SAME number here to 1e-9 m², because Revit writes
    `OverallWidth` as the rough-opening dimension for these families — so the
    third route is not off by the 15–25 % that separates a Rohbaulichte from a
    lichte Durchgangsbreite. The declared area is the outlier, at +61 % on the
    window and +33 % on the door, and it is the one route no measurement can
    normalise because only the exporter knows what it published.
    """

    def test_a_window_answers_with_one_route_and_no_contradiction(self, house: SpatialModel) -> None:
        answer = op.floor_area(house, BEDROOM_WINDOW)
        assert answer.decidable
        assert answer.provenance == "computed"
        # `single` is never reached here: with no declared side found at all,
        # `floor_area` returns the measured answer before `triangulate` is called,
        # so the field stays unset. Either way there is no pair and no verdict.
        assert answer.agreement is None
        assert answer.value == pytest.approx(0.639275, abs=1e-5)
        assert answer.caveat is None

    def test_the_declared_area_really_is_there_to_be_picked_up(self, house: SpatialModel) -> None:
        """Otherwise the test above passes for the wrong reason — a file with no
        declared window area cannot demonstrate a guard against reading one.
        """
        for global_id, published in ((BEDROOM_WINDOW, 3.5348570571731), (INTERNAL_DOOR, 2.27347800000496)):
            element = house.file.by_guid(global_id)
            found = house.declared_quantity(element, ("Area",))
            assert found is not None
            assert found.path == "BaseQuantities.Area"
            assert found.value == pytest.approx(published, abs=1e-9)
            # And the tuple `floor_area` actually asks with finds nothing, which
            # is the whole of the protection.
            assert house.declared_quantity(element, ("NetFloorArea", "GrossFloorArea")) is None

    def test_the_nominal_rectangle_is_this_files_rohbaulichte_not_a_third_opinion(self, house: SpatialModel) -> None:
        """The measurement behind the table in this class's docstring.

        `OverallWidth × OverallHeight` agreeing with the opening geometry to
        1e-9 m² is a fact about THIS exporter, not a licence to triangulate the
        two — an exporter that writes the leaf size instead would put them
        centimetres apart with nothing in the file to say which happened. It is
        recorded so the claim „those are 15–25 % apart" is never made about this
        pair again on the strength of a figure borrowed from a different one.
        """
        for global_id, nominal in ((BEDROOM_WINDOW, 2.19010), (INTERNAL_DOOR, 1.70910)):
            element = house.file.by_guid(global_id)
            rectangle = element.OverallWidth * element.OverallHeight * house.unit_scale**2
            assert rectangle == pytest.approx(nominal, abs=1e-5)

            void = [rel.RelatingOpeningElement for rel in element.FillsVoids][0]
            clear = op._clear_opening_area(house, void)
            assert clear == pytest.approx(rectangle, abs=1e-9)

            declared_area = house.declared_quantity(element, ("Area",)).value
            assert declared_area > clear * 1.3


class TestATriangleWithNoDirectionDoesNotVoteOnThePlane:
    """`triangle_normals_areas` zeroes a normal at |cross| ≤ 1e-12 and still
    reports `area = |cross| / 2`, so `dominant_plane`'s `areas > 0` filter let
    triangles through that carry no direction at all. They fold to the sign
    fallback 1.0, land in the (0, 0, 0) bin and vote with a zero vector.

    For a mesh whose triangles are ALL in that band the function returned
    `array([0., 0., 0.])` instead of `None`, and that is not a harmless zero:
    `azimuth` gates on `|face[2]| >= VERTICAL_TOLERANCE`, reads 0.0 as vertical
    and reports a compass bearing for a body with no measurable face — the exact
    failure `dominant_plane` was added to prevent for the ground slab.
    """

    #: One triangle 1 µm on a side: |cross| = 1e-12, area = 5e-13 > 0.
    BAND = np.array([[[0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0]]])

    def test_the_band_really_does_pass_an_area_filter_with_a_zero_normal(self) -> None:
        """Without this the test below would pass for the wrong reason."""
        normals, areas = op.triangle_normals_areas(self.BAND)
        assert (areas > 0).all(), "the old gate would have dropped these anyway"
        assert areas[0] == pytest.approx(5e-13, rel=1e-9)
        assert not normals.any(), "a triangle that still has a direction is not the case at issue"

    def test_a_mesh_of_them_has_no_dominant_plane(self) -> None:
        assert dominant_plane(self.BAND) is None

    def test_azimuth_refuses_instead_of_reporting_north(self, house: SpatialModel, monkeypatch) -> None:
        """The consequence, on the operator that reads the gate.

        Handed through a stub rather than a file: IfcOpenShell REFUSES to build
        such a body — a tessellation this small comes back as
        „shape-failed: Failed to process shape" and never reaches an operator —
        so the band is only reachable from a mesh that arrives some other way.
        The refusal must not depend on the kernel's willingness to reject it.
        """
        from ifc_spatial.model import ElementGeometry

        degenerate = ElementGeometry(
            global_id=NORTH_WALL,
            verts=np.array([[0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0]]),
            faces=np.array([[0, 1, 2]]),
            box=(np.zeros(3), np.full(3, 1e-6)),
            centroid=np.zeros(3),
        )
        monkeypatch.setattr(house, "geometry", lambda gid: degenerate)

        answer = op.azimuth(house, NORTH_WALL)
        assert not answer.decidable
        assert answer.value is None
        assert "senkrechte Hauptfläche" in answer.missing.what

    def test_the_house_is_nowhere_near_the_band(self, house: SpatialModel) -> None:
        """The measurement behind the claim that this fix moves no number.

        All 25 312 triangles of the sample house, and the smallest doubled area
        among them is 2.63e-07 — five orders of magnitude above the 1e-12 the
        gate rejects, so not one triangle changes side.
        """
        smallest = None
        total = 0
        for element in house.file.by_type("IfcProduct"):
            geo = house.geometry(element.GlobalId)
            if geo is None or len(geo.triangles) == 0:
                continue
            _, areas = op.triangle_normals_areas(geo.triangles)
            total += len(areas)
            doubled = float((areas * 2).min())
            smallest = doubled if smallest is None else min(smallest, doubled)
        assert total == 25_312
        assert smallest == pytest.approx(2.6267e-07, rel=1e-3)
        assert smallest > 1e-12 * 100_000


class TestAnUnwrappedHandlerStillCannotLeakATraceback:
    """`overhang` and `light_incidence` call operators that raise
    `UnknownElementError`, and neither handler wraps its call in `run`.

    That is safe only because `call` converts the same two exceptions itself —
    documented there as the net for „a handler which forgot to wrap its
    operator". This pins the net rather than the handlers: `mcp_server` hands
    arguments straight to `call` and has no second one.
    """

    def test_overhang_answers_a_typo_with_a_correction(self, tools: list, handle: str) -> None:
        with pytest.raises(ToolError) as raised:
            call(tools, "overhang", {"model": handle, "projecting": "0" * 22, "facade": NORTH_WALL})
        assert "Unbekannte GlobalId" in str(raised.value)
        assert "find_elements" in str(raised.value)

    def test_light_incidence_answers_a_typo_with_a_correction(self, tools: list, handle: str) -> None:
        with pytest.raises(ToolError) as raised:
            call(tools, "light_incidence", {"model": handle, "globalId": "0" * 22, "angle": 45})
        assert "Unbekannte GlobalId" in str(raised.value)
        assert "find_elements" in str(raised.value)


class TestARoomWhoseBodyIsAShellIsStillMeasurable:
    """`clearHeight` answered nothing at all on an ArchiCAD export.

    Reported from production. „In dem Institut wie hoch ist der Keller?" came
    back with the DECLARED storey height of 3.00 m and the note that the lichte
    Höhe „war in diesem Export nicht entscheidbar (Raumkörper zu schmal/
    zerklüftet für das Standardraster)".

    Neither half of that was true. The room is an 11.6 × 11.4 m seminar room,
    and it was not the grid: on `AC20-Institute-Var-2.ifc` **all 82 spaces**
    were undecidable, while all 82 build in the triangulated pass.

    The cause is `geom.tree.select(point)`, which needs a closed orientable
    SOLID to classify against. ArchiCAD writes `IfcSpace` bodies as `Brep`
    shells; OCCT accepts them into the tree — `select_box` finds them — and
    will not classify them, so the containment test that decides which grid
    points count returned nothing for every room in the file.

    The answer the user got was the storey pitch, 3.00 m, for a room whose
    modelled body is 2.70 m. A structural height reported where a clear height
    was asked for is wrong in the unsafe direction, and it was dressed in a
    sentence blaming the architect's room shape.

    The fixture is that seminar room and the slab above it, extracted from
    `AC20-Institute-Var-2.ifc` (KIT/IFC Wiki example, free use) — 6.8 KB, and
    it reproduces the classifier miss exactly.
    """

    FIXTURE = FIXTURES / "keller-brep-raum.ifc"

    @pytest.fixture(scope="class")
    @classmethod
    def model(cls) -> SpatialModel:
        return SpatialModel(str(cls.FIXTURE))

    def test_the_solid_classifier_really_does_miss_this_room(self, model: SpatialModel) -> None:
        """The anti-vacuity guard.

        If a future IfcOpenShell classifies these shells, this test goes red and
        the fixture stops reproducing the defect — at which point the fix below
        is still correct but is no longer being exercised, and somebody should
        know that rather than read a green tick.
        """
        space = model.file.by_type("IfcSpace")[0]
        geo = model.geometry(space.GlobalId)
        assert geo is not None, "the room triangulates — it is only the classifier that fails"
        low, high = geo.box
        x = float((low[0] + high[0]) / 2)
        y = float((low[1] + high[1]) / 2)
        z = float(low[2]) + 0.06
        hits = [e.GlobalId for e in model.tree.select((x, y, z))]
        assert space.GlobalId not in hits, "the classifier now works; this fixture no longer reproduces"

    def test_the_room_is_measured_rather_than_refused(self, model: SpatialModel) -> None:
        space = model.file.by_type("IfcSpace")[0]
        answer = op.clear_height(model, space.GlobalId)
        assert answer.decidable is True, "every room in this export used to come back undecidable"
        assert answer.value == pytest.approx(2.7, abs=0.01)
        assert answer.unit == "m"

    def test_every_grid_point_is_used_because_the_room_is_large(self, model: SpatialModel) -> None:
        """„Zu schmal oder zu zerklüftet" was the diagnosis the operator printed.
        The room is 132 m²; all 25 points land in it."""
        space = model.file.by_type("IfcSpace")[0]
        answer = op.clear_height(model, space.GlobalId)
        assert "aus 25 von 25 Rasterpunkten" in (answer.caveat or "")

    def test_the_footprint_is_the_room_not_its_bounding_box(self) -> None:
        """The containment test must still reject a point outside an L-shaped
        room, which is the whole reason the old code asked the classifier."""
        from ifc_spatial.geometry import plan_footprint
        from shapely.geometry import Point

        # An L: 10x10 with the (5..10, 5..10) quadrant removed, as two boxes of
        # downward-facing triangles.
        def box(x0, y0, x1, y1):
            return [
                [[x0, y0, 0.0], [x1, y0, 0.0], [x1, y1, 0.0]],
                [[x0, y0, 0.0], [x1, y1, 0.0], [x0, y1, 0.0]],
            ]

        # Wound so the normals point DOWN (-z), which is what a floor facet is.
        tris = np.array([list(reversed(t)) for t in box(0, 0, 10, 5) + box(0, 5, 5, 10)], dtype=float)
        footprint = plan_footprint(tris)
        assert footprint is not None
        assert footprint.area == pytest.approx(75.0, abs=1e-6)
        assert footprint.covers(Point(2.0, 2.0))
        assert footprint.covers(Point(8.0, 2.0))
        # Inside the bounding box, outside the room — the point the old
        # classifier existed to reject.
        assert not footprint.covers(Point(8.0, 8.0))

    def test_the_remedy_no_longer_names_an_argument_no_tool_exposes(self) -> None:
        """The refusal used to tell the caller to „clearHeight() mit einem
        höheren samples-Wert aufrufen".

        No tool surface takes `samples` — not `MEASURE_FN`, not the agent's
        `ifc_measure`. So the one instruction the agent was given on this path
        was one it could not carry out, which is how the production turn ended
        up reporting the storey height instead.
        """
        import inspect

        from ifc_spatial import tools

        source = inspect.getsource(op.clear_height)
        remedy = source[source.index("kein Rasterpunkt lag im Raumkörper") :]
        remedy = remedy[: remedy.index("elements=")]
        assert "samples" not in remedy
        assert "extent()" in remedy
        # And the reason it is unreachable, pinned: no tool takes the argument.
        assert "samples" not in inspect.getsource(tools.create_tools)


class TestAnExternalWallBoundsMoreThanOneRoom:
    """„Bounds two rooms, therefore a partition" is wrong for the ordinary case.

    An external wall runs along a whole side of a building, so it bounds every
    room on that side. The count called that a Trennbauteil, and on
    `AC20-FZK-Haus.ifc` — which declares `IsExternal` on NONE of its 26 walls,
    so this rung decided all of them — it put `Wand-Ext-ERDG-1` (3 rooms), `-2`
    (3), `-3` (2) and `-4` (2) outside the thermal envelope. Four external
    ground-floor walls missing from an OIB 6 envelope, described as partitions.

    What separates inside from outside is having rooms on ONE SIDE only, so the
    test is the side and not the count. Measured against the exporter's own
    naming on that house (every wall is `Wand-Ext-*` or `Wand-Int-*`): **26 of
    26 correct, against 22 of 26 for the count.**

    The knock-on was larger than the envelope. A window is external when its
    wall is, and `_faces_outside` could only read a DECLARED flag off the host
    wall — so every window in that house was undetermined and
    `light_entry_area` reported **0.00 %** for the Schlafzimmer, the Bad, the
    Büro, the Küche and the Galerie. A house with a window in every room.

    The fixture is `Wand-Ext-ERDG-1`, the three rooms it bounds, its two
    openings and their windows, extracted from that file.
    """

    FIXTURE = FIXTURES / "aussenwand-ohne-isexternal.ifc"

    @pytest.fixture(scope="class")
    @classmethod
    def model(cls) -> SpatialModel:
        return SpatialModel(str(cls.FIXTURE))

    @staticmethod
    def _wall(model: SpatialModel):
        walls = list(model.file.by_type("IfcWall")) + list(model.file.by_type("IfcWallStandardCase"))
        return walls[0]

    def test_the_file_really_declares_nothing(self, model: SpatialModel) -> None:
        """The anti-vacuity guard: if this wall ever declares `IsExternal`, the
        first rung decides it and nothing below is being exercised."""
        assert model.declared_property(self._wall(model), ("IsExternal",)) is None

    def test_it_really_does_bound_more_than_one_room(self, model: SpatialModel) -> None:
        """…which is what made the count call it a partition."""
        rooms = op.enclosed_by(model, self._wall(model).GlobalId)
        assert rooms.decidable and len(rooms.value or []) >= 2

    def test_the_wall_is_external_because_its_rooms_are_all_on_one_side(self, model: SpatialModel) -> None:
        wall = self._wall(model)
        rooms = op.enclosed_by(model, wall.GlobalId)
        assert op._rooms_on_one_side(model, wall, rooms.value) is True

        external, _route, why = eg._external_route(model, wall)
        assert external is True
        assert "alle auf derselben Seite" in why

    def test_a_window_in_an_undeclared_wall_faces_outside(self, model: SpatialModel) -> None:
        """The rung that turned five rooms of daylight from 0.00 % into a
        measurement. Without it the window is undetermined — honest, and still a
        0 % headline on an OIB 3 check."""
        windows = list(model.file.by_type("IfcWindow")) + list(model.file.by_type("IfcWindowStandardCase"))
        assert windows, "the fixture carries the windows the defect was about"
        for window in windows:
            faces_outside, why = op._faces_outside(model, window)
            assert faces_outside is True, model.label(window)
            assert "tragende Wand" in why and "Geometrie" in why

    def test_a_partition_is_still_a_partition(self, house: SpatialModel) -> None:
        """The fix must not simply call everything external. The sample house's
        interior partition has rooms on both sides and stays out of the
        envelope — checked on the fixture that DOES declare its flags, so the
        first rung is what answers here."""
        external, _route, _why = eg._external_route(house, house.file.by_guid("3cUkl32yn9qRSPvBJVyWY1"))
        assert external is False

"""The thermal envelope, against oracles that are not this code.

Four of them, and none is "what the function returned last time":

1. **The sample house's own declarations, read for a purpose the module does not
   otherwise use.** ``Pset_RoofCommon`` states ``TotalArea = 117.4305`` and
   ``ProjectedArea = 108.1177`` for a 390-triangle curved shell. Those are the
   architect's two numbers for the two areas this module measures, and if the
   measurement does not land on them the measurement is wrong — the expectation
   does not move to meet it. ``BaseQuantities.GrossArea = 146.19905625`` on the
   ground slab and ``BaseQuantities.GrossVolume`` on all four spaces do the same
   job for the flat case and for the volume.
2. **Arithmetic that has to close.** A wall's net elevation area plus the areas
   of the openings cut out of it is the gross elevation of the wall, and the
   gross elevation is the bounding box. If the wall area double-counted its
   windows or the windows were measured on the frame instead of the reveal, the
   sum stops closing. On the south wall it closes to 0.009 m² in 25.263.
3. **Hand-computed geometry.** A synthetic two-room IFC written into
   ``tmp_path`` with **no property sets and no TrueNorth**: 4.00 × 3.00 and
   3.90 × 3.00 rooms, one 100 mm partition between them and two external walls.
   Its envelope is 7.50 + 10.00 = 17.50 m², its volume 30.00 + 29.25 =
   59.25 m³, and its A/V 0.29536 1/m — all known on paper before the code runs.
   It is the only way to exercise the geometry route, because every candidate in
   the sample house is declared.
4. **The contract itself.** Every refusal must be an ``Answer`` with a German
   ``missing.what`` and an actionable ``remedy``, never an exception and never a
   confident zero — and no answer anywhere may carry a verdict.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from ifc_spatial import envelope_geometry as eg
from ifc_spatial.envelope import Answer
from ifc_spatial.model import SpatialModel

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
#: Declares IsExternal and ThermalTransmittance and has NO body on any element,
#: and no TrueNorth.
DECLARED_NO_GEOMETRY = FIXTURES / "haus-mit-raeumen.ifc"
#: Declares nothing at all, has no bodies, but DOES write IfcRelSpaceBoundary.
BOUNDARIES_NO_PSETS = FIXTURES / "geschossdecke-und-fenster.ifc"
#: One wall, in FEET, with no psets, no geometry and no rooms.
FEET = FIXTURES / "einheiten-fuss.ifc"
#: An IFC4X3 road — no building element of any kind.
ROAD = FIXTURES / "strasse-ifc4x3.ifc"

NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
EAST_WALL = "3cUkl32yn9qRSPvBJVyWx4"
SOUTH_WALL = "3cUkl32yn9qRSPvBJVyWy4"
PARTITION = "3cUkl32yn9qRSPvBJVyWY1"
ROOF = "3cUkl32yn9qRSPvBJVyWh4"
GROUND_SLAB = "3cUkl32yn9qRSPvBJVyWgQ"
UPPER_SLAB = "3ntFzSulnDNeQ4nJrMgcOt"
GLAZED_PANE = "3cUkl32yn9qRSPvBJVyW_O"
NORTH_WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
SOUTH_DOOR = "3cUkl32yn9qRSPvBJVyWYp"
INTERNAL_DOOR = "3cUkl32yn9qRSPvBJVyWax"
LIVING_ROOM = "3w0zWKm7n8SB1qbfwUzt0U"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
ENTRANCE_HALL = "3w0zWKm7n8SB1qbfwUzt0G"

# Two rooms side by side, one 100 mm partition between them and two external
# walls, with NO property set anywhere and NO TrueNorth. Everything about it is
# known on paper:
#
#   Raum A  4.00 × 3.00 × 2.50 = 30.00 m³      Raum B  3.90 × 3.00 × 2.50 = 29.25 m³
#   Aussenwand West   3.00 × 2.50 =  7.50 m²   berührt nur Raum A
#   Aussenwand Nord   4.00 × 2.50 = 10.00 m²   berührt nur Raum A
#   Trennwand         3.00 × 2.50 =  7.50 m²   berührt beide Räume
#
# The north wall stops at x = 4.00 and room B starts at x = 4.10, so the 50 mm
# contact tolerance cannot reach across and the wall really does bound one room.
# A/V = 17.50 / 59.25 = 0.29536 1/m, which is below the band a real house sits
# in — this is two rooms with two of their four walls modelled, not a building.
_TWO_ROOMS = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('huelle-ohne-norden.ifc','2026-08-12T00:00:00',(''),(''),'','','');
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
#15=IFCPROJECT('1bbbbbbbbbbbbbbbbbbbb0',#5,'Huelle',$,$,$,$,(#14),#13);
#16=IFCLOCALPLACEMENT($,#9);
#20=IFCCARTESIANPOINT((2.,1.5));
#21=IFCAXIS2PLACEMENT2D(#20,$);
#22=IFCRECTANGLEPROFILEDEF(.AREA.,'raumA',#21,4.,3.);
#23=IFCEXTRUDEDAREASOLID(#22,#9,#7,2.5);
#24=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#23));
#25=IFCPRODUCTDEFINITIONSHAPE($,$,(#24));
#26=IFCSPACE('1bbbbbbbbbbbbbbbbbbbb1',#5,'A',$,$,#16,#25,'Wohnen',.ELEMENT.,.INTERNAL.,$);
#30=IFCCARTESIANPOINT((6.05,1.5));
#31=IFCAXIS2PLACEMENT2D(#30,$);
#32=IFCRECTANGLEPROFILEDEF(.AREA.,'raumB',#31,3.9,3.);
#33=IFCEXTRUDEDAREASOLID(#32,#9,#7,2.5);
#34=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#33));
#35=IFCPRODUCTDEFINITIONSHAPE($,$,(#34));
#36=IFCSPACE('1bbbbbbbbbbbbbbbbbbbb2',#5,'B',$,$,#16,#35,'Kueche',.ELEMENT.,.INTERNAL.,$);
#40=IFCCARTESIANPOINT((4.05,1.5));
#41=IFCAXIS2PLACEMENT2D(#40,$);
#42=IFCRECTANGLEPROFILEDEF(.AREA.,'trennwand',#41,0.1,3.);
#43=IFCEXTRUDEDAREASOLID(#42,#9,#7,2.5);
#44=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#43));
#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#46=IFCWALL('1bbbbbbbbbbbbbbbbbbbb3',#5,'Trennwand',$,$,#16,#45,$,$);
#50=IFCCARTESIANPOINT((-0.15,1.5));
#51=IFCAXIS2PLACEMENT2D(#50,$);
#52=IFCRECTANGLEPROFILEDEF(.AREA.,'west',#51,0.3,3.);
#53=IFCEXTRUDEDAREASOLID(#52,#9,#7,2.5);
#54=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#53));
#55=IFCPRODUCTDEFINITIONSHAPE($,$,(#54));
#56=IFCWALL('1bbbbbbbbbbbbbbbbbbbb4',#5,'Aussenwand West',$,$,#16,#55,$,$);
#60=IFCCARTESIANPOINT((2.,3.15));
#61=IFCAXIS2PLACEMENT2D(#60,$);
#62=IFCRECTANGLEPROFILEDEF(.AREA.,'nord',#61,4.,0.3);
#63=IFCEXTRUDEDAREASOLID(#62,#9,#7,2.5);
#64=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#63));
#65=IFCPRODUCTDEFINITIONSHAPE($,$,(#64));
#66=IFCWALL('1bbbbbbbbbbbbbbbbbbbb5',#5,'Aussenwand Nord',$,$,#16,#65,$,$);
ENDSEC;
END-ISO-10303-21;
"""

TWO_ROOMS_PARTITION = "1bbbbbbbbbbbbbbbbbbbb3"
TWO_ROOMS_WEST = "1bbbbbbbbbbbbbbbbbbbb4"
TWO_ROOMS_NORTH = "1bbbbbbbbbbbbbbbbbbbb5"


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(SAMPLE_HOUSE))


@pytest.fixture(scope="module")
def envelope(house: SpatialModel) -> Answer:
    return eg.thermal_envelope(house)


@pytest.fixture(scope="module")
def orientation(house: SpatialModel) -> Answer:
    return eg.envelope_area_by_orientation(house)


@pytest.fixture(scope="module")
def compact(house: SpatialModel) -> Answer:
    return eg.compactness(house)


@pytest.fixture(scope="module")
def two_rooms(tmp_path_factory: pytest.TempPathFactory) -> SpatialModel:
    path = tmp_path_factory.mktemp("huelle") / "huelle-ohne-norden.ifc"
    path.write_text(_TWO_ROOMS, encoding="ascii")
    return SpatialModel(str(path))


def _by_id(entries: list[dict]) -> dict[str, dict]:
    return {e["globalId"]: e for e in entries}


def _all_entries(value: dict) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for group in value["byKind"].values():
        found.update(_by_id(group))
    found.update(_by_id(value["innenliegend"]))
    found.update(_by_id(value["unbestimmt"]))
    return found


# ── thermal_envelope: which elements, by which route ────────────────────────


def test_every_candidate_in_the_sample_house_is_decided_by_declaration(envelope: Answer) -> None:
    """All 23 candidates carry Pset_*Common.IsExternal, so route 2 never runs.

    This is what makes the synthetic two-room file necessary: without it the
    geometry route would have no test at all in this repository.
    """
    assert envelope.decidable
    value = envelope.value
    assert value["routes"] == {eg.ROUTE_DECLARED: 17}
    assert len(_all_entries(value)) == 23
    assert value["unbestimmt"] == []
    for entry in _all_entries(value).values():
        assert entry["route"] == eg.ROUTE_DECLARED
        assert entry["because"].startswith("Pset_")


def test_the_envelope_is_the_declared_outside_and_nothing_else(envelope: Answer) -> None:
    value = envelope.value
    assert {kind: len(group) for kind, group in value["byKind"].items()} == {
        "Wand": 5,  # 3 IfcWall + 2 IfcCurtainWall shells
        "Fenster": 4,
        "Tür": 1,
        "Verglasungsfeld": 6,
        "Dach": 1,
    }
    assert value["elementCount"] == 17
    inside = _by_id(value["innenliegend"])
    # Two partitions, two internal doors, two slabs.
    assert set(inside) == {
        PARTITION,
        "3cUkl32yn9qRSPvBJVyWXt",
        INTERNAL_DOOR,
        "3cUkl32yn9qRSPvBJVyWaG",
        GROUND_SLAB,
        UPPER_SLAB,
    }


def test_total_area_is_the_sum_of_the_measured_elements(envelope: Answer) -> None:
    value = envelope.value
    measured = [e for group in value["byKind"].values() for e in group if e["area"] is not None]
    assert len(measured) == 15
    assert value["totalArea"] == pytest.approx(sum(e["area"] for e in measured), abs=1e-6)
    assert value["totalArea"] == pytest.approx(225.700565, abs=1e-3)
    assert value["totalArea"] == pytest.approx(sum(value["areaByKind"].values()), abs=1e-6)


def test_the_curtain_wall_shells_are_in_the_envelope_without_an_area(envelope: Answer) -> None:
    """A curtain wall carries no body of its own; its panels do.

    Reporting it with ``area = None`` and a reason keeps the element count
    honest without letting a null into the sum — the alternative, dropping it,
    would make the envelope disagree with the file about how many external
    elements there are.
    """
    walls = _by_id(envelope.value["byKind"]["Wand"])
    shells = [e for e in walls.values() if e["ifcType"] == "IfcCurtainWall"]
    assert len(shells) == 2
    for shell in shells:
        assert shell["area"] is None
        assert "Vorhangfassade" in shell["via"]
    assert "keine Fläche messbar" in envelope.caveat


def test_the_ground_slab_declared_internal_is_named_not_absorbed(envelope: Answer) -> None:
    """146.199 m² that OIB 6 would count and this file says are not external.

    The declaration is not overruled and the slab is not silently dropped
    either: it sits in ``innenliegend`` with its area, and the caveat says in
    German why an architect should look at it.
    """
    slab = _by_id(envelope.value["innenliegend"])[GROUND_SLAB]
    assert slab["external"] is False
    assert slab["route"] == eg.ROUTE_DECLARED
    assert slab["area"] == pytest.approx(146.19905625, rel=1e-4)
    assert "Bodenplatte gegen Erdreich" in envelope.caveat
    assert "146.199" in envelope.caveat


def test_declared_u_values_are_passed_through_with_their_pset(envelope: Answer) -> None:
    """The U-value is repeated, never recomputed from the layers.

    Both numbers come out of the file untouched, and the pset they came from
    travels with them so a reviewer can find them in their own software.
    """
    entries = _all_entries(envelope.value)
    wall = entries[NORTH_WALL]
    assert wall["thermalTransmittance"] == 0.235926059936681
    assert wall["thermalTransmittanceVia"] == "Pset_WallCommon.ThermalTransmittance"
    pane = entries[GLAZED_PANE]
    assert pane["thermalTransmittance"] == 6.7069
    assert pane["thermalTransmittanceVia"] == "Pset_PlateCommon.ThermalTransmittance"
    assert entries[PARTITION]["thermalTransmittance"] == 0.350997935306263
    # The external door declares none, and none is invented for it.
    assert entries[SOUTH_DOOR]["thermalTransmittance"] is None
    assert entries[SOUTH_DOOR]["thermalTransmittanceVia"] is None


def test_the_curtain_wall_mullions_are_excluded_and_the_caveat_says_how_many(envelope: Answer) -> None:
    entries = _all_entries(envelope.value)
    assert not any(e["ifcType"] == "IfcMember" for e in entries.values())
    assert "20 IfcMember" in envelope.caveat


# ── how an area is measured ─────────────────────────────────────────────────


def test_a_wall_and_its_openings_add_up_to_its_gross_elevation(house: SpatialModel, envelope: Answer) -> None:
    """The arithmetic that proves nothing was double-counted.

    The south wall's own area is measured with its holes subtracted, so
    wall + door + window must reconstruct the gross elevation — here the
    bounding box, 8.955 × 2.82109 = 25.2629 m². The three parts come to
    25.2539, which is 0.009 m² short: the 36 mm of tessellation slack around
    two reveals, not a counting error. Had the wall been measured gross, the sum
    would have exceeded the box by a whole door.
    """
    entries = _all_entries(envelope.value)
    low, high = house.geometry(SOUTH_WALL).box
    gross = float((high[0] - low[0]) * (high[2] - low[2]))
    assert gross == pytest.approx(25.2629, abs=1e-3)

    parts = entries[SOUTH_WALL]["area"] + entries[SOUTH_DOOR]["area"] + entries["3cUkl32yn9qRSPvBJVyZTO"]["area"]
    assert entries[SOUTH_WALL]["area"] == pytest.approx(19.2537, abs=1e-3)
    assert parts == pytest.approx(gross, abs=0.05)
    assert parts < gross  # never above: a hole cannot be counted twice


def test_the_roof_matches_the_files_own_total_and_projected_area(house: SpatialModel, envelope: Answer) -> None:
    """The oracle: Pset_RoofCommon states both numbers this module measures.

    A 390-triangle curved shell, and the file says its surface is 117.4305 m²
    and its plan projection 108.1177 m². Measured independently here: 117.3984
    and 108.1157 — 0.03 % and 0.002 %. If the developed area were being taken
    over the wrong set of faces, or the projection were summing instead of
    unioning, neither would land.
    """
    roof = house.file.by_guid(ROOF)
    declared_total = house.declared_property(roof, ("TotalArea",))
    declared_projected = house.declared_property(roof, ("ProjectedArea",))
    assert declared_total == pytest.approx(117.430474580487)
    assert declared_projected == pytest.approx(108.117682237461)

    entry = _all_entries(envelope.value)[ROOF]
    assert entry["horizontal"] is True
    assert entry["area"] == pytest.approx(declared_total, rel=1e-3)
    assert entry["projectedArea"] == pytest.approx(declared_projected, rel=1e-3)
    # The two differ by 8.6 %, which is exactly why both are reported.
    assert entry["area"] > entry["projectedArea"] * (1 + eg.SLOPE_REPORT_FRACTION)
    assert entry["via"] == "abgewickelte Oberfläche (geneigt oder gekrümmt)"


def test_a_flat_slab_reports_one_area_matching_its_declared_quantity(house: SpatialModel, envelope: Answer) -> None:
    """Flat: developed and projected are the same number, and the file agrees.

    ``BaseQuantities.GrossArea = 146.19905625``, read through
    ``declared_quantity`` so the file's own area unit is honoured — the sample
    house measures in MILLIMETRES and declares areas in square metres, and
    scaling by ``unit_scale ** 2`` would have made this 146 mm².
    """
    slab = _by_id(envelope.value["innenliegend"])[GROUND_SLAB]
    assert slab["area"] == pytest.approx(slab["projectedArea"], abs=1e-6)
    assert slab["via"] == "Grundrissprojektion"
    found = house.declared_quantity(house.file.by_guid(GROUND_SLAB), ("GrossArea",))
    assert found is not None
    assert found.value == pytest.approx(146.19905625)
    assert slab["area"] == pytest.approx(found.value, rel=1e-5)


def test_the_branch_is_chosen_by_measurement_not_by_ifc_type(envelope: Answer) -> None:
    """A slab is horizontal and a wall vertical because they measure that way.

    The sample house's roof has a perfectly good vertical plane — a 4.5 m²
    fascia — and typing it by its largest vertical face would have reported a
    108 m² roof as 4.5 m² of envelope.
    """
    entries = _all_entries(envelope.value)
    assert entries[NORTH_WALL]["horizontal"] is False
    assert entries[GLAZED_PANE]["horizontal"] is False
    assert entries[NORTH_WINDOW]["horizontal"] is False
    assert entries[ROOF]["horizontal"] is True
    assert entries[GROUND_SLAB]["horizontal"] is True


# ── envelope_area_by_orientation ────────────────────────────────────────────


def test_the_orientation_table_of_the_sample_house(orientation: Answer) -> None:
    """N/O/S/W, opaque against transparent, with the ratio each carries.

    The north wall ``3cUkl32yn9qRSPvBJVyWw5`` bears 0°, which is what anchors
    the whole table.
    """
    assert orientation.decidable
    value = orientation.value
    assert value["orientationKnown"] is True
    table = value["byOrientation"]
    assert list(table) == ["N", "O", "S", "W"]

    assert table["N"]["opaque"] == pytest.approx(27.4084, abs=1e-3)
    assert table["N"]["transparent"] == pytest.approx(6.5741, abs=1e-3)
    assert table["N"]["windowWallRatio"] == pytest.approx(0.19346, abs=1e-4)
    assert table["O"]["transparent"] == 0.0
    assert table["O"]["windowWallRatio"] == 0.0
    assert table["S"]["opaque"] == pytest.approx(23.0625, abs=1e-3)
    assert table["S"]["transparent"] == pytest.approx(15.6728, abs=1e-3)
    assert table["S"]["windowWallRatio"] == pytest.approx(0.40461, abs=1e-4)

    north = {e["globalId"]: e for e in table["N"]["elements"]}
    assert north[NORTH_WALL]["degrees"] == pytest.approx(0.0, abs=1e-6)
    assert north[NORTH_WALL]["transparent"] is False
    assert north[NORTH_WINDOW]["transparent"] is True


def test_a_fully_glazed_facade_reports_1_0_and_says_why(orientation: Answer) -> None:
    """The west elevation is a curtain wall and nothing else is counted on it.

    A window-to-wall ratio of exactly 1.0 read without the sentence beside it is
    a modelling error rather than a building, so the caveat names the reason:
    the mullions are ``IfcMember`` and out of scope, and the ``IfcCurtainWall``
    itself has no body.
    """
    west = orientation.value["byOrientation"]["W"]
    assert west["opaque"] == 0.0
    assert west["transparent"] == pytest.approx(17.6037, abs=1e-3)
    assert west["windowWallRatio"] == 1.0
    assert "genau 1,0" in orientation.caveat
    assert "IfcMember" in orientation.caveat


def test_horizontal_elements_get_no_bearing_but_stay_in_the_totals(orientation: Answer) -> None:
    value = orientation.value
    horizontal = {e["globalId"] for e in value["ohneAusrichtung"]}
    assert horizontal == {ROOF}
    assert all(ROOF not in {e["globalId"] for e in b["elements"]} for b in value["byOrientation"].values())
    assert value["opaque"] + value["transparent"] == pytest.approx(value["total"], abs=1e-6)
    oriented = sum(b["total"] for b in value["byOrientation"].values())
    assert oriented + 117.398357 == pytest.approx(value["total"], abs=1e-3)


def test_orientation_totals_agree_with_the_envelope_total(orientation: Answer, envelope: Answer) -> None:
    """Three operators, one survey — they may not disagree about the building."""
    assert orientation.value["total"] == pytest.approx(envelope.value["totalArea"], abs=1e-6)
    assert orientation.value["windowWallRatio"] == pytest.approx(0.176564, abs=1e-5)


# ── compactness ─────────────────────────────────────────────────────────────


def test_compactness_reports_both_inputs_and_lands_in_the_plausible_band(compact: Answer) -> None:
    """A = 225.700 m², V = 266.728 m³, A/V = 0.846 1/m, l_c = 1.182 m.

    The band 0.3–1.5 1/m is where a small detached house sits. It is asserted
    here as a trip-wire on the whole chain: an A that lost the roof, or a V that
    picked up the site, leaves it immediately.
    """
    assert compact.decidable
    assert compact.unit == "1/m"
    value = compact.value
    assert value["envelopeArea"] == pytest.approx(225.7006, abs=1e-3)
    assert value["volume"] == pytest.approx(266.7283, abs=1e-3)
    assert value["ratio"] == pytest.approx(value["envelopeArea"] / value["volume"], abs=1e-6)
    assert value["ratio"] == pytest.approx(0.846182, abs=1e-4)
    assert 0.3 <= value["ratio"] <= 1.5
    assert value["characteristicLength"] == pytest.approx(1.0 / value["ratio"], abs=1e-6)


def test_the_volume_is_named_as_net_and_the_gross_one_is_refused(compact: Answer) -> None:
    """An energy calculation names which volume it wants; this one says which it is."""
    assert compact.value["volumeIs"].startswith("netto")
    assert "NETTOVOLUMEN" in compact.caveat
    assert "Bruttovolumen" in compact.caveat
    assert "AUSSENFLÄCHEN" in compact.caveat


def test_the_measured_volume_agrees_with_the_declared_space_volumes(compact: Answer) -> None:
    """Two routes to 266.728 m³, and the file's own is in the file's own unit.

    Every space declares ``BaseQuantities.GrossVolume`` and every one matches
    the mesh — 129.987 / 38.542 / 21.734 / 76.466 m³. The sample house measures
    in millimetres, so a volume scaled by ``unit_scale ** 3`` would have come
    back as 1.3e-4 m³ and ``triangulate`` would have called the export 100 %
    wrong; ``declared_quantity`` reads the quantity's own unit instead.
    """
    assert compact.value["volumeAgreement"] == "agree"
    spaces = {s["globalId"]: s for s in compact.value["spaces"]}
    assert len(spaces) == 4
    assert spaces[LIVING_ROOM]["volume"] == pytest.approx(129.98706, abs=1e-4)
    assert spaces[BEDROOM]["volume"] == pytest.approx(38.54195, abs=1e-4)
    assert spaces[ENTRANCE_HALL]["volume"] == pytest.approx(21.73377, abs=1e-4)
    for space in spaces.values():
        assert space["declaredAt"] == "BaseQuantities.GrossVolume"
        assert space["declaredVolume"] == pytest.approx(space["volume"], rel=1e-6)


def test_compactness_says_which_rooms_it_treated_as_heated(compact: Answer) -> None:
    """The file draws no heated/unheated line, so all four rooms are in V.

    The roof space is 76.466 m³ of that. Whether an attic is heated is a fact
    about the building services, and there is nothing in this export that states
    it — so it is counted and the caveat says so, rather than being guessed away.
    """
    assert "beheizt/unbeheizt" in compact.caveat
    assert "IfcZone" in compact.caveat
    assert sum(s["volume"] for s in compact.value["spaces"]) == pytest.approx(compact.value["volume"], abs=1e-4)


def test_compactness_area_agrees_with_the_envelope_operator(compact: Answer, envelope: Answer) -> None:
    assert compact.value["envelopeArea"] == pytest.approx(envelope.value["totalArea"], abs=1e-6)
    assert compact.value["areaByKind"] == envelope.value["areaByKind"]


# ── the geometry route, and a file with no north ────────────────────────────


def test_the_geometry_route_decides_when_nothing_is_declared(two_rooms: SpatialModel) -> None:
    """No psets at all: the walls are placed by how many rooms they bound.

    Two external walls at 7.50 and 10.00 m², one partition between the rooms,
    and the numbers are the paper ones to the millimetre.
    """
    answer = eg.thermal_envelope(two_rooms)
    assert answer.decidable
    value = answer.value
    assert value["routes"] == {eg.ROUTE_BOUNDED_SPACES: 2}

    walls = _by_id(value["byKind"]["Wand"])
    assert set(walls) == {TWO_ROOMS_WEST, TWO_ROOMS_NORTH}
    assert walls[TWO_ROOMS_WEST]["area"] == pytest.approx(7.5, abs=1e-6)
    assert walls[TWO_ROOMS_NORTH]["area"] == pytest.approx(10.0, abs=1e-6)
    for wall in walls.values():
        assert wall["because"].startswith("begrenzt genau einen Raum")

    partition = _by_id(value["innenliegend"])[TWO_ROOMS_PARTITION]
    assert partition["external"] is False
    assert partition["because"].startswith("begrenzt 2 Räume")
    assert value["totalArea"] == pytest.approx(17.5, abs=1e-6)


def test_without_true_north_the_areas_come_back_without_a_compass(two_rooms: SpatialModel) -> None:
    """Degrade, never invent — and never withhold the area over the compass.

    ``azimuth`` refuses without ``TrueNorth`` and is right to. This operator
    keeps the answer decidable, drops ``byOrientation`` entirely rather than
    labelling the model's +Y axis "Norden", and names the remedy.
    """
    assert two_rooms.true_north is None
    answer = eg.envelope_area_by_orientation(two_rooms)
    assert answer.decidable
    value = answer.value
    assert value["orientationKnown"] is False
    assert "byOrientation" not in value
    assert value["opaque"] == pytest.approx(17.5, abs=1e-6)
    assert value["transparent"] == 0.0
    assert value["windowWallRatio"] == 0.0
    assert "TrueNorth" in answer.caveat
    assert "geraten" in answer.caveat


def test_compactness_on_the_hand_built_rooms(two_rooms: SpatialModel) -> None:
    """17.50 / 59.25 = 0.29536 1/m — arithmetic done before the code ran."""
    answer = eg.compactness(two_rooms)
    assert answer.decidable
    value = answer.value
    assert value["envelopeArea"] == pytest.approx(17.5, abs=1e-6)
    assert value["volume"] == pytest.approx(59.25, abs=1e-6)
    assert value["ratio"] == pytest.approx(17.5 / 59.25, abs=1e-6)
    # Nothing declares a volume here, so there is only one route and no verdict
    # on agreement — `triangulate` is not run against a partial declared sum.
    assert value["volumeAgreement"] is None
    assert all(s["declaredVolume"] is None for s in value["spaces"])


def test_declared_space_boundaries_are_not_reported_as_geometry(
    tmp_path: Path,  # noqa: ARG001 — kept for symmetry with the other file-based tests
) -> None:
    """``geschossdecke-und-fenster.ifc`` writes IfcRelSpaceBoundary and no bodies.

    So the space-count rung answers from a DECLARATION, and saying "aus der
    Geometrie abgeleitet" about it would be a false claim about a file that has
    no geometry at all.
    """
    model = SpatialModel(str(BOUNDARIES_NO_PSETS))
    answer = eg.thermal_envelope(model)
    assert answer.decidable
    entries = _all_entries(answer.value)
    wall = entries["4Decke00000Wall000003"]
    assert wall["external"] is True
    assert wall["route"] == eg.ROUTE_BOUNDED_SPACES
    assert "deklarierte Raumgrenzen" in wall["because"]
    partition = entries["4Decke00000Wall000002"]
    assert partition["external"] is False
    assert "deklarierte Raumgrenzen" in partition["because"]


# ── refusals: every one an Answer, in German, with a remedy ─────────────────


def test_declared_without_geometry_never_reports_a_confident_zero() -> None:
    """``haus-mit-raeumen.ifc``: four external elements and not one body.

    ``totalArea`` is ``None``, not ``0.0``. Zero is a number an agent will put
    in a sentence, and "die Hüllfläche beträgt 0 m²" would be a statement about
    a building where the truth is a statement about an export.
    """
    model = SpatialModel(str(DECLARED_NO_GEOMETRY))
    answer = eg.thermal_envelope(model)
    assert answer.decidable
    assert answer.value["totalArea"] is None
    assert answer.value["areaByKind"] == {}
    assert answer.value["routes"] == {eg.ROUTE_DECLARED: 4}
    assert answer.tolerance is None

    for refusal in (eg.envelope_area_by_orientation(model), eg.compactness(model)):
        assert not refusal.decidable
        assert refusal.value is None
        assert "Körper" in refusal.missing.remedy


def test_a_file_in_feet_with_no_psets_refuses_by_name() -> None:
    """One wall, in FEET, no psets, no geometry, no rooms.

    Nothing here is decidable and nothing is invented — in particular no area is
    produced by scaling a length. All three operators refuse with the same named
    reason and an actionable German remedy.
    """
    model = SpatialModel(str(FEET))
    assert model.unit_scale == pytest.approx(0.3048)
    for operator in (eg.thermal_envelope, eg.envelope_area_by_orientation, eg.compactness):
        answer = operator(model)
        assert not answer.decidable
        assert answer.value is None
        assert answer.missing.what.startswith("Pset_*Common.IsExternal")
        assert "IsExternal" in answer.missing.remedy
        assert "IfcSpace" in answer.missing.remedy
        assert answer.missing.elements == ["3Fuss000000Wall000001"]


def test_a_model_with_no_building_elements_says_so_rather_than_naming_psets() -> None:
    """An IFC4X3 road is not a building whose walls forgot to declare themselves.

    The two refusals are told apart because they send the architect to different
    settings.
    """
    model = SpatialModel(str(ROAD))
    for operator in (eg.thermal_envelope, eg.envelope_area_by_orientation, eg.compactness):
        answer = operator(model)
        assert not answer.decidable
        assert answer.missing.what.startswith("keine Bauteile der thermischen Hülle")
        assert "Infrastruktur" in answer.missing.remedy


# ── the boundary this module may not cross ──────────────────────────────────


def test_no_operator_returns_a_verdict(envelope: Answer, orientation: Answer, compact: Answer) -> None:
    """No threshold, no U-value limit, no „erfüllt“, no rating — anywhere.

    OIB 6 names maximum U-values and a permitted Heizwärmebedarf against l_c.
    None of them are in this layer, and the caveats say so in German so that an
    agent quoting a number cannot present it as a compliance statement.
    """
    forbidden = ("erfüllt", "erfuellt", "compliant", "zulässig", "unzulässig", "bestanden", "Anforderung erfüllt")
    for answer in (envelope, orientation, compact):
        text = (answer.caveat or "") + repr(answer.value)
        for word in forbidden:
            assert word not in text
        for key in ("compliant", "passes", "verdict", "limit", "erfuellt"):
            assert key not in answer.value
    assert "Kein Grenzwert" in envelope.caveat
    assert "Kein Grenzwert" in orientation.caveat
    assert "kein Grenzwert angewandt" in compact.caveat


def test_declared_u_values_are_never_derived_from_material_layers(house: SpatialModel, envelope: Answer) -> None:
    """Every reported U-value is a value the file states, verbatim.

    Checked against ``declared_property`` rather than against a constant, so the
    test fails the moment anything starts computing one.
    """
    for entry in _all_entries(envelope.value).values():
        element = house.file.by_guid(entry["globalId"])
        assert entry["thermalTransmittance"] == house.declared_property(element, ("ThermalTransmittance",))


def test_every_answer_is_an_answer_and_carries_its_method(house: SpatialModel) -> None:
    for operator, method in (
        (eg.thermal_envelope, "thermalEnvelope()"),
        (eg.envelope_area_by_orientation, "envelopeAreaByOrientation()"),
        (eg.compactness, "compactness()"),
    ):
        answer = operator(house)
        assert isinstance(answer, Answer)
        assert answer.method == method
        assert answer.provenance == "computed"
        assert answer.tolerance is not None
        assert answer.from_
        assert answer.caveat

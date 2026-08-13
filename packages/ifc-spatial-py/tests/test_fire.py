"""The fire module, against numbers that were known before the code ran.

Three oracles, and none of them is "what the function returned last time":

1. **Hand-computed geometry.** A synthetic two-compartment office written into
   ``tmp_path`` (:func:`_office`), whose every dimension is a round number
   chosen on paper: two ground-floor offices of 5.8 × 9.6 m and 3.6 × 9.6 m —
   **55.68 + 34.56 = 90.24 m²** — separated by a 200 mm Brandwand carrying
   ``REI 90`` with an ``EI2 30-C`` door in it, an upper office of 9.6 × 9.6 m =
   **92.16 m²** at storey elevation 3.5, and a Technikgeschoss at 7.0. Its
   Fluchtniveau is therefore **3.500 m** and not 7.000 m, and its distance to
   the western site boundary is **3.000 m** (building face at x = 0, boundary
   at x = −3).

2. **The repository's own fixtures, and what they demonstrably lack.** Read out
   of the files before any of this was written:

   ===============================  =========================================
   fixture                          what it establishes here
   ===============================  =========================================
   ``Ifc4_SampleHouse.ifc``         geometry everywhere, ``FireRating``
                                    NOWHERE — 0 of 75 products carry it
   ``haus-mit-raeumen.ifc``         ``FireRating = REI 90`` on three outer
                                    walls and NOT on the Trennwand, and no
                                    body on anything
   ``geschossdecke-und-fenster.ifc`` declared 2nd-level boundaries, no bodies
   ``einheiten-fuss.ifc``           one storey, no spaces at all
   ``strasse-ifc4x3.ifc``           no storeys at all
   ===============================  =========================================

   And the one that decides :func:`distance_to_site_boundary`: **not one of the
   five carries a site boundary.** All five have ``IfcSite.Representation =
   None`` and there is not a single ``IfcAnnotation`` between them.

3. **The contract.** Provenance, German remedies, and the refusals — that no
   answer here ever names a Gebäudeklasse, states a verdict or applies a
   threshold. Those are asserted as hard as the numbers, because they are the
   part a later change is most likely to erode.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import ifcopenshell
import pytest
from ifc_spatial import fire
from ifc_spatial.model import SpatialModel
from ifc_spatial.model import UnknownElementError
from ifc_spatial.model import WrongKindError

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
#: Declares FireRating on its outer walls and not on its Trennwand, and has no
#: geometry at all — the only fixture that reaches the declared-only routes.
NO_GEOMETRY = FIXTURES / "haus-mit-raeumen.ifc"
#: One storey, no spaces.
NO_SPACES = FIXTURES / "einheiten-fuss.ifc"
#: No storeys.
NO_STOREYS = FIXTURES / "strasse-ifc4x3.ifc"
BOUNDARIES_ONLY = FIXTURES / "geschossdecke-und-fenster.ifc"

GROUND_FLOOR = "1o0c33arXF9AEePDYchjCY"
ROOF_STOREY = "1o0c33arXF9AEePDYchj2Z"
LIVING = "3w0zWKm7n8SB1qbfwUzt0U"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
HALL = "3w0zWKm7n8SB1qbfwUzt0G"
ROOF_SPACE = "09J5N7xMHBfQZeQGAEMota"
#: ``Wall-Partn_12P-70MStd-12P``, 95 mm, between the living room and the bedroom.
PARTITION = "3cUkl32yn9qRSPvBJVyWXt"
#: The living room's own outer wall — bounds it and does not separate it from
#: anything.
NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
DOOR_LIVING_BEDROOM = "3cUkl32yn9qRSPvBJVyWax"

WOHNZIMMER = "2Haus0Raeume00Space001"
KUECHE = "2Haus0Raeume00Space002"
TRENNWAND = "2Haus0Raeume00Wall0003"
AUSSENWAND_SUED = "2Haus0Raeume00Wall0001"
ZIMMERTUER = "2Haus0Raeume00Door0001"
ZONE = "2Haus0Raeume00Zone0001"

#: The sample house's three ground-floor rooms, measured by ``floor_area``.
#: 51.99482500 + 15.41678125 + 8.69350625.
SAMPLE_GROUND_FLOOR_AREA = 76.1051


def _bounds_of(model: SpatialModel, space: str) -> list[Any]:
    """The bounding elements the FILE gives for a space — the oracle this
    module's intersection is checked against, taken from the operator it is
    built on rather than from this module's own output."""
    from ifc_spatial import operators as op

    return op.bounds(model, space).value or []


def _adjacent_of(model: SpatialModel, space: str) -> list[Any]:
    """What ``adjacent_spaces`` calls a neighbour — a different question from
    „was liegt dazwischen", and this module must not be read as answering it."""
    from ifc_spatial import operators as op

    return op.adjacent_spaces(model, space).value or []


def _gid(tag: str) -> str:
    """A readable 22-character GlobalId.

    IFC asks for 22 base64 characters and says nothing about which; a fixture
    whose ids cannot be read is a fixture nobody checks against the file.
    """
    return f"1Brand{tag}".ljust(22, "0")[:22]


class _Writer:
    """The boilerplate every synthetic model here needs, and nothing else."""

    def __init__(self, name: str) -> None:
        self.file = ifcopenshell.file(schema="IFC4")
        f = self.file
        self.z = f.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
        self.x = f.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0, 0.0))
        axes = f.create_entity(
            "IfcAxis2Placement3D",
            Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)),
            Axis=self.z,
            RefDirection=self.x,
        )
        self.context = f.create_entity(
            "IfcGeometricRepresentationContext",
            ContextType="Model",
            CoordinateSpaceDimension=3,
            Precision=1e-5,
            WorldCoordinateSystem=axes,
        )
        self.placement = f.create_entity("IfcLocalPlacement", RelativePlacement=axes)
        # Metres, so every number in this file is the number in the assertion.
        units = f.create_entity(
            "IfcUnitAssignment",
            Units=[
                f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE"),
                f.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE"),
                f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE"),
            ],
        )
        self.project = f.create_entity(
            "IfcProject",
            GlobalId=_gid("Project"),
            Name=name,
            RepresentationContexts=[self.context],
            UnitsInContext=units,
        )

    def box(self, name: str, coords: tuple[float, float, float, float, float, float]) -> Any:
        """An axis-aligned box as a swept solid: (x0, x1, y0, y1, z0, z1)."""
        x0, x1, y0, y1, z0, z1 = coords
        f = self.file
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
                Axis=self.z,
                RefDirection=self.x,
            ),
            ExtrudedDirection=self.z,
            Depth=z1 - z0,
        )
        return f.create_entity(
            "IfcProductDefinitionShape",
            Representations=[
                f.create_entity(
                    "IfcShapeRepresentation",
                    ContextOfItems=self.context,
                    RepresentationIdentifier="Body",
                    RepresentationType="SweptSolid",
                    Items=[solid],
                )
            ],
        )

    def product(self, cls: str, tag: str, name: str, coords: Any = None, **extra: Any) -> Any:
        return self.file.create_entity(
            cls,
            GlobalId=_gid(tag),
            Name=name,
            ObjectPlacement=self.placement,
            Representation=None if coords is None else self.box(name, coords),
            **extra,
        )

    def curve(self, corners: list[tuple[float, float]], identifier: str) -> Any:
        points = [self.file.create_entity("IfcCartesianPoint", Coordinates=c) for c in corners]
        return self.file.create_entity(
            "IfcProductDefinitionShape",
            Representations=[
                self.file.create_entity(
                    "IfcShapeRepresentation",
                    ContextOfItems=self.context,
                    RepresentationIdentifier=identifier,
                    RepresentationType="Curve2D",
                    Items=[self.file.create_entity("IfcPolyline", Points=points)],
                )
            ],
        )

    def pset(self, tag: str, name: str, properties: list[tuple[str, str, Any]], elements: list[Any]) -> None:
        f = self.file
        values = [
            f.create_entity("IfcPropertySingleValue", Name=key, NominalValue=f.create_entity(kind, value))
            for key, kind, value in properties
        ]
        f.create_entity(
            "IfcRelDefinesByProperties",
            GlobalId=_gid(f"Def{tag}"),
            RelatedObjects=elements,
            RelatingPropertyDefinition=f.create_entity(
                "IfcPropertySet", GlobalId=_gid(f"Pset{tag}"), Name=name, HasProperties=values
            ),
        )

    def rel(self, cls: str, tag: str, **kwargs: Any) -> Any:
        return self.file.create_entity(cls, GlobalId=_gid(tag), **kwargs)

    def write(self, path: Path) -> SpatialModel:
        self.file.write(str(path))
        return SpatialModel(str(path))


#: Every id in the synthetic office, so an assertion reads as the thing it means.
BUERO_01 = _gid("Space01")
BUERO_02 = _gid("Space02")
BUERO_03 = _gid("Space03")
TECHNIKRAUM = _gid("Space04")
EG = _gid("StoreyEG")
OG = _gid("StoreyOG")
TG = _gid("StoreyTG")
BRANDWAND = _gid("Wall05")
SUEDWAND = _gid("Wall03")
WESTWAND = _gid("Wall01")
OSTWAND = _gid("Wall02")
DECKE_EG = _gid("Slab01")
BRANDSCHUTZTUER = _gid("Door01")
BAUPLATZ = _gid("Site")
BRANDABSCHNITT = _gid("Zone01")


def _office(path: Path) -> SpatialModel:
    """A two-compartment office, every dimension a round number.

    Ground floor: ``Buero 01`` 5.8 × 9.6 m and ``Buero 02`` 3.6 × 9.6 m, split
    by a 200 mm Brandwand from x = 6.00 to x = 6.20 with a door in it. Upper
    floor: one 9.6 × 9.6 m office at elevation 3.5. Top: a Technikgeschoss at
    7.0 whose only room is a Lüftungszentrale. The site carries the plot
    boundary as a ``FootPrint`` polyline from (−3, −5) to (25, 20), so the
    building's west face at x = 0 stands exactly 3.00 m from it.

    Space boundaries are declared, so :func:`~ifc_spatial.operators.bounds`
    answers from the file and the answers here come back ``declared`` — which
    also keeps the suite off the multi-second geometric derivation.
    """
    w = _Writer("Buerogebaeude Brandabschnitte")
    f = w.file

    site = f.create_entity(
        "IfcSite",
        GlobalId=BAUPLATZ,
        Name="Bauplatz 42",
        ObjectPlacement=w.placement,
        Representation=w.curve([(-3.0, -5.0), (25.0, -5.0), (25.0, 20.0), (-3.0, 20.0), (-3.0, -5.0)], "FootPrint"),
        CompositionType="ELEMENT",
    )
    building = w.product("IfcBuilding", "Building", "Haus A", CompositionType="ELEMENT")
    storeys = [
        w.product("IfcBuildingStorey", "StoreyEG", "Erdgeschoss", CompositionType="ELEMENT", Elevation=0.0),
        w.product("IfcBuildingStorey", "StoreyOG", "Obergeschoss", CompositionType="ELEMENT", Elevation=3.5),
        w.product("IfcBuildingStorey", "StoreyTG", "Technikgeschoss", CompositionType="ELEMENT", Elevation=7.0),
    ]
    w.rel("IfcRelAggregates", "Aggr1", RelatingObject=w.project, RelatedObjects=[site])
    w.rel("IfcRelAggregates", "Aggr2", RelatingObject=site, RelatedObjects=[building])
    w.rel("IfcRelAggregates", "Aggr3", RelatingObject=building, RelatedObjects=storeys)

    # Only the WEST wall reaches x = 0.00; everything else stops at 0.20. That
    # makes the nearest element to the boundary unique, so the assertion about
    # WHICH element is closest is an assertion and not a tie-break on GlobalId.
    west = w.product("IfcWall", "Wall01", "Aussenwand West", (0.0, 0.2, 0.0, 10.0, 0.0, 3.5))
    east = w.product("IfcWall", "Wall02", "Aussenwand Ost", (9.8, 10.0, 0.0, 10.0, 0.0, 3.5))
    south = w.product("IfcWall", "Wall03", "Aussenwand Sued", (0.2, 9.8, 0.0, 0.2, 0.0, 3.5))
    north = w.product("IfcWall", "Wall04", "Aussenwand Nord", (0.2, 9.8, 9.8, 10.0, 0.0, 3.5))
    brandwand = w.product("IfcWall", "Wall05", "Brandwand BA-01/BA-02", (6.0, 6.2, 0.2, 9.8, 0.0, 3.5))
    base = w.product("IfcSlab", "Slab00", "Bodenplatte", (0.2, 9.8, 0.2, 9.8, -0.3, 0.0), PredefinedType="BASESLAB")
    decke = w.product(
        "IfcSlab", "Slab01", "Geschossdecke ueber EG", (0.2, 9.8, 0.2, 9.8, 3.2, 3.5), PredefinedType="FLOOR"
    )
    dach = w.product(
        "IfcSlab", "Slab02", "Geschossdecke ueber OG", (0.2, 9.8, 0.2, 9.8, 6.7, 7.0), PredefinedType="FLOOR"
    )

    door = w.product(
        "IfcDoor",
        "Door01",
        "Brandschutztuer BA-01/BA-02",
        (6.0, 6.2, 4.5, 5.5, 0.0, 2.1),
        OverallHeight=2.1,
        OverallWidth=1.0,
        PredefinedType="DOOR",
    )
    opening = w.product(
        "IfcOpeningElement",
        "Openin01",
        "Tueroeffnung Brandwand",
        (6.0, 6.2, 4.5, 5.5, 0.0, 2.1),
        PredefinedType="OPENING",
    )
    w.rel("IfcRelVoidsElement", "Void01", RelatingBuildingElement=brandwand, RelatedOpeningElement=opening)
    w.rel("IfcRelFillsElement", "Fill01", RelatingOpeningElement=opening, RelatedBuildingElement=door)

    def space(tag: str, name: str, long_name: str, coords: Any) -> Any:
        return w.product(
            "IfcSpace", tag, name, coords, LongName=long_name, CompositionType="ELEMENT", PredefinedType="SPACE"
        )

    a = space("Space01", "R.01", "Buero 01", (0.2, 6.0, 0.2, 9.8, 0.0, 3.2))
    b = space("Space02", "R.02", "Buero 02", (6.2, 9.8, 0.2, 9.8, 0.0, 3.2))
    c = space("Space03", "R.03", "Buero 03", (0.2, 9.8, 0.2, 9.8, 3.5, 6.7))
    d = space("Space04", "R.04", "Technikraum Lueftung", (0.2, 4.2, 0.2, 4.2, 7.0, 9.5))

    w.rel("IfcRelAggregates", "Aggr4", RelatingObject=storeys[0], RelatedObjects=[a, b])
    w.rel("IfcRelAggregates", "Aggr5", RelatingObject=storeys[1], RelatedObjects=[c])
    w.rel("IfcRelAggregates", "Aggr6", RelatingObject=storeys[2], RelatedObjects=[d])
    w.rel(
        "IfcRelContainedInSpatialStructure",
        "Cont1",
        RelatingStructure=storeys[0],
        RelatedElements=[west, east, south, north, brandwand, base, decke, door],
    )
    w.rel("IfcRelContainedInSpatialStructure", "Cont2", RelatingStructure=storeys[1], RelatedElements=[dach])

    index = 0
    for room, elements in (
        (a, [west, south, north, brandwand, base, decke, door]),
        (b, [east, south, north, brandwand, base, decke, door]),
        (c, [west, east, south, north, decke, dach]),
    ):
        for element in elements:
            index += 1
            w.rel(
                "IfcRelSpaceBoundary",
                f"Bnd{index:02d}",
                RelatingSpace=room,
                RelatedBuildingElement=element,
                PhysicalOrVirtualBoundary="PHYSICAL",
                InternalOrExternalBoundary="INTERNAL",
            )

    w.pset(
        "01",
        "Pset_WallCommon",
        [
            ("FireRating", "IfcLabel", "REI 90"),
            ("Compartmentation", "IfcBoolean", True),
            ("IsExternal", "IfcBoolean", False),
        ],
        [brandwand],
    )
    w.pset("02", "Pset_WallCommon", [("IsExternal", "IfcBoolean", True)], [west, east, south, north])
    w.pset("03", "Pset_DoorCommon", [("FireRating", "IfcLabel", "EI2 30-C")], [door])
    w.pset("04", "Pset_SlabCommon", [("FireRating", "IfcLabel", "REI 90")], [decke])

    zone = f.create_entity("IfcZone", GlobalId=BRANDABSCHNITT, Name="BA-01", LongName="Brandabschnitt Erdgeschoss")
    w.rel("IfcRelAssignsToGroup", "Grp01", RelatedObjects=[a, b], RelatingGroup=zone)
    w.pset("05", "Pset_ZoneCommon", [("Category", "IfcLabel", "Brandabschnitt")], [zone])

    return w.write(path)


@pytest.fixture(scope="module")
def office(tmp_path_factory: pytest.TempPathFactory) -> SpatialModel:
    return _office(tmp_path_factory.mktemp("fire") / "brandabschnitte.ifc")


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(SAMPLE_HOUSE))


@pytest.fixture(scope="module")
def bodyless() -> SpatialModel:
    return SpatialModel(str(NO_GEOMETRY))


# ════════════════════════════════════════════════════════════════════════════
# fluchtniveau
# ════════════════════════════════════════════════════════════════════════════


def test_fluchtniveau_is_the_top_occupied_floor_above_the_lowest_ground(office: SpatialModel) -> None:
    """3.500 m, and specifically NOT 7.000 m.

    The building's highest storey is the Technikgeschoss at 7.0. Counting it
    would nearly double the number the Gebäudeklasse turns on, so the whole
    operator is really this one exclusion plus a subtraction.
    """
    answer = fire.fluchtniveau(office)
    assert answer.decidable
    assert answer.unit == "m"
    assert answer.value["fluchtniveau"] == pytest.approx(3.5, abs=1e-9)
    assert answer.value["topOccupiedFloor"]["globalId"] == OG
    assert answer.value["groundReference"]["z"] == pytest.approx(0.0, abs=1e-9)


def test_fluchtniveau_is_inferred_and_never_computed(office: SpatialModel) -> None:
    """„Zum Aufenthalt bestimmt" is a judgement, so the envelope has to say so.

    A ``computed`` provenance would put this number beside a measured wall
    thickness, and it is not that kind of number: change one storey's name and
    it changes by 3.5 m.
    """
    answer = fire.fluchtniveau(office)
    assert answer.provenance == "inferred"
    assert answer.confidence is not None and 0.0 < answer.confidence <= 1.0
    assert answer.because


def test_every_storey_is_reported_with_its_reason_counted_or_not(office: SpatialModel) -> None:
    """The dropped storey is the whole point of reporting the list.

    A reviewer who knows the Technikgeschoss is a rooftop flat has to be able to
    name it and redo the subtraction. That is impossible if only the surviving
    storey is published.
    """
    answer = fire.fluchtniveau(office)
    storeys = {entry["globalId"]: entry for entry in answer.value["storeys"]}
    assert set(storeys) == {EG, OG, TG}
    assert storeys[EG]["gezaehlt"] is True
    assert storeys[OG]["gezaehlt"] is True
    assert storeys[TG]["gezaehlt"] is False
    assert "technik" in storeys[TG]["warum"].lower()
    # And the rooms behind each judgement, so the reason can be checked too.
    assert [room["name"] for room in storeys[EG]["raeume"]] == ["Buero 01", "Buero 02"]
    assert storeys[EG]["raeume"][0]["nutzung"] == "aufenthaltsraum"


def test_the_sample_houses_roof_storey_is_not_an_occupied_level(house: SpatialModel) -> None:
    """Ground Floor at 0.0 and a storey literally called ``Roof`` at 2.5.

    A bungalow's Fluchtniveau is 0 m, and that is the answer. Counting the roof
    level would report 2.5 m for a single-storey house.
    """
    answer = fire.fluchtniveau(house)
    assert answer.decidable
    assert answer.value["fluchtniveau"] == pytest.approx(0.0, abs=1e-9)
    assert answer.value["topOccupiedFloor"]["globalId"] == GROUND_FLOOR
    dropped = [entry for entry in answer.value["storeys"] if not entry["gezaehlt"]]
    assert [entry["globalId"] for entry in dropped] == [ROOF_STOREY]
    assert "roof" in dropped[0]["warum"].lower()


def test_a_storey_with_no_rooms_is_counted_because_silence_is_not_evidence(bodyless: SpatialModel) -> None:
    """``haus-mit-raeumen.ifc`` has an Obergeschoss at 3.0 with no IfcSpace.

    An absent room is not proof that nobody lives there. Dropping the storey
    would report 0.0 m for a two-storey house — understating the height the
    classification turns on, which is the direction that loosens every
    requirement behind it. So it is counted, and the reason says exactly that.
    """
    answer = fire.fluchtniveau(bodyless)
    assert answer.value["fluchtniveau"] == pytest.approx(3.0, abs=1e-9)
    upper = [entry for entry in answer.value["storeys"] if entry["name"] == "Obergeschoss"][0]
    assert upper["gezaehlt"] is True
    assert upper["raeume"] == []
    assert "Im Zweifel MITGEZÄHLT" in upper["warum"]
    assert "gefährliche Richtung" in upper["warum"]
    # And the uncertainty is priced into the confidence rather than hidden.
    assert any("ohne positives Nutzungssignal" in reason for reason in answer.because)


def test_the_ground_reference_says_which_route_it_used_and_lists_the_others(house: SpatialModel) -> None:
    """Three routes disagree by the depth of a foundation; the answer names one.

    In the sample house the lowest storey sits at 0.00 and the underside of the
    ground slab at −0.47. A reader who cannot see which was used cannot correct
    it, and 0.47 m is a real difference on a number read against height bands.
    """
    ground = fire.fluchtniveau(house).value["groundReference"]
    assert "IfcBuildingStorey.Elevation" in ground["via"]
    assert "kein Gelände" in ground["via"]
    candidates = {round(entry["z"], 3) for entry in ground["candidates"]}
    assert candidates == {0.0, -0.47}
    # No IfcSite body in this file, so the terrain route is absent entirely.
    assert not any("IfcSite-Körpergeometrie" in entry["via"] for entry in ground["candidates"])


def test_ref_elevation_is_reported_and_never_subtracted(house: SpatialModel) -> None:
    """``IfcSite.RefElevation`` is a SEA-LEVEL datum and the geometry is not.

    Mixing the two is the tens-of-metres datum error ``_storey_datum_drift``
    exists to catch. The sample house declares one, so it must appear under
    ``nichtVerwendet`` and never among the candidates that could be chosen.
    """
    ground = fire.fluchtniveau(house).value["groundReference"]
    assert [entry["globalId"] for entry in ground["nichtVerwendet"]] == ["1o0c33arXF9AEePDXPKItd"]
    assert "Meereshöhe" in ground["nichtVerwendet"][0]["via"]
    assert all("RefElevation" not in entry["via"] for entry in ground["candidates"])


def test_a_file_without_storeys_is_refused_with_a_remedy() -> None:
    answer = fire.fluchtniveau(SpatialModel(str(NO_STOREYS)))
    assert answer.decidable is False
    assert answer.missing.what == "IfcBuildingStorey"
    assert "Elevation" in answer.missing.remedy


def test_storeys_without_an_elevation_are_refused_rather_than_estimated(tmp_path: Path) -> None:
    """A guessed 2.80 m storey height would arrive looking like a measurement.

    ``storey_heights`` refuses the same way and for the same reason: the answer
    contract has no way to mark one number in a list as fabricated.
    """
    w = _Writer("Ohne Hoehen")
    building = w.product("IfcBuilding", "Building", "Haus", CompositionType="ELEMENT")
    storey = w.product("IfcBuildingStorey", "StoreyEG", "Erdgeschoss", CompositionType="ELEMENT")
    w.rel("IfcRelAggregates", "Aggr1", RelatingObject=w.project, RelatedObjects=[building])
    w.rel("IfcRelAggregates", "Aggr2", RelatingObject=building, RelatedObjects=[storey])
    model = w.write(tmp_path / "ohne-hoehen.ifc")

    answer = fire.fluchtniveau(model)
    assert answer.decidable is False
    assert answer.missing.what == "IfcBuildingStorey.Elevation"
    assert "Schätzung" in answer.missing.remedy


def test_modelled_terrain_beats_the_lowest_floor_and_changes_the_number(tmp_path: Path) -> None:
    """The route no fixture in this repository can reach, and the one OIB means.

    „Über dem tiefer gelegenen anschließenden Gelände" is about the *ground*, and
    the ground is only in the file when somebody modelled it. Here an ``IfcSite``
    carries a terrain body from z = −2.00 to z = 0.00, so the reference is
    −2.00 and the Fluchtniveau of a storey at 3.00 comes out at **5.00 m** — not
    the 3.00 m the lowest-floor fallback would have given.

    Two metres of difference on the number a Gebäudeklasse is read against, from
    nothing but which of two available references was taken. That is why the
    route used is named in the answer instead of being an implementation detail.
    """
    w = _Writer("Mit Gelaende")
    site = w.file.create_entity(
        "IfcSite",
        GlobalId=BAUPLATZ,
        Name="Bauplatz mit Gelaendemodell",
        ObjectPlacement=w.placement,
        Representation=w.box("Gelaende", (-10.0, 20.0, -10.0, 20.0, -2.0, 0.0)),
        CompositionType="ELEMENT",
    )
    building = w.product("IfcBuilding", "Building", "Haus", CompositionType="ELEMENT")
    eg = w.product("IfcBuildingStorey", "StoreyEG", "Erdgeschoss", CompositionType="ELEMENT", Elevation=0.0)
    og = w.product("IfcBuildingStorey", "StoreyOG", "Obergeschoss", CompositionType="ELEMENT", Elevation=3.0)
    unten = w.product("IfcSpace", "Space01", "R.01", (0.0, 4.0, 0.0, 5.0, 0.0, 2.8), LongName="Buero 01")
    oben = w.product("IfcSpace", "Space02", "R.02", (0.0, 4.0, 0.0, 5.0, 3.0, 5.8), LongName="Buero 02")
    w.rel("IfcRelAggregates", "Aggr1", RelatingObject=w.project, RelatedObjects=[site])
    w.rel("IfcRelAggregates", "Aggr2", RelatingObject=site, RelatedObjects=[building])
    w.rel("IfcRelAggregates", "Aggr3", RelatingObject=building, RelatedObjects=[eg, og])
    w.rel("IfcRelAggregates", "Aggr4", RelatingObject=eg, RelatedObjects=[unten])
    w.rel("IfcRelAggregates", "Aggr5", RelatingObject=og, RelatedObjects=[oben])
    model = w.write(tmp_path / "mit-gelaende.ifc")

    answer = fire.fluchtniveau(model)
    ground = answer.value["groundReference"]
    assert ground["z"] == pytest.approx(-2.0, abs=1e-6)
    assert ground["via"].startswith("IfcSite-Körpergeometrie")
    assert answer.value["fluchtniveau"] == pytest.approx(5.0, abs=1e-6)
    # The floor-level fallback is still offered, so a reviewer can see the 2.00 m
    # the choice was worth and substitute their own survey level.
    assert 0.0 in [entry["z"] for entry in ground["candidates"]]
    # Terrain was available, so the confidence is not docked for its absence.
    assert not any("Kein Geländemodell" in reason for reason in answer.because)


def test_fluchtniveau_never_names_a_gebaeudeklasse(office: SpatialModel, house: SpatialModel) -> None:
    """The single most important boundary in this module.

    „GK5" is a legal classification from OIB 2 plus the Landesrecht plus the
    Geschoßzahl and the use — none of which is in this file. A library that
    emits it has applied a rule it never read, and the sentence reads exactly
    like the measurement beside it. The refusal must be SAID, and the class
    must never appear.
    """
    for model in (office, house):
        answer = fire.fluchtniveau(model)
        blob = _text(answer)
        assert re.search(r"\bGK\s?[1-5]\b", blob) is None, blob
        assert "Gebäudeklasse" in answer.caveat
        assert "nennt deshalb keine Gebäudeklasse" in answer.caveat


# ════════════════════════════════════════════════════════════════════════════
# compartment_area
# ════════════════════════════════════════════════════════════════════════════


def test_a_declared_zone_is_measured_as_the_sum_of_its_rooms(office: SpatialModel) -> None:
    """55.68 + 34.56 = 90.24 m², and the constituents are visible."""
    answer = fire.compartment_area(office, BRANDABSCHNITT)
    assert answer.decidable
    assert answer.unit == "m²"
    assert answer.value["area"] == pytest.approx(90.24, abs=1e-6)
    areas = {entry["globalId"]: entry["area"] for entry in answer.value["spaces"]}
    assert areas == {BUERO_01: pytest.approx(55.68, abs=1e-6), BUERO_02: pytest.approx(34.56, abs=1e-6)}
    # The sum is checkable against its own parts, which is the whole reason
    # they travel: a reviewer who disagrees can disagree with one room.
    assert sum(areas.values()) == pytest.approx(answer.value["area"], abs=1e-6)


def test_a_declared_grouping_is_reported_as_the_architects_own_statement(office: SpatialModel) -> None:
    answer = fire.compartment_area(office, BRANDABSCHNITT)
    grouping = answer.value["grouping"][0]
    assert grouping["ifcType"] == "IfcZone"
    assert grouping["deklariert"] is True
    assert "IfcRelAssignsToGroup" in grouping["via"]
    assert "DEKLARIERTEN Gruppe" in answer.caveat


def test_a_storey_is_measured_but_is_never_called_a_brandabschnitt(office: SpatialModel) -> None:
    """The same two rooms, and a caveat that refuses the equation.

    A storey and a Brandabschnitt coincide often enough that the substitution is
    tempting and wrong in both directions — one storey can hold several
    compartments and one compartment can span several storeys.
    """
    answer = fire.compartment_area(office, EG)
    assert answer.value["area"] == pytest.approx(90.24, abs=1e-6)
    assert "Ein Geschoß ist kein Brandabschnitt" in answer.caveat
    # And it points at the zone the file itself declares over the same rooms.
    assert "Brandabschnitt Erdgeschoss" in answer.caveat
    assert [z["globalId"] for z in answer.value["deklarierteZonen"]] == [BRANDABSCHNITT]


def test_a_room_reached_twice_is_counted_once_and_the_drop_is_reported(office: SpatialModel) -> None:
    """Passing a space and the storey containing it must not double it.

    This is the exact failure the union was asked to prevent, and here it is
    exact rather than geometric: two GlobalIds either are the same id or they
    are not.
    """
    answer = fire.compartment_area(office, [EG, BUERO_01])
    assert answer.value["area"] == pytest.approx(90.24, abs=1e-6)
    assert answer.value["spaceCount"] == 2
    assert [entry["globalId"] for entry in answer.value["doppelt"]] == [BUERO_01]
    assert "nur EINMAL gezählt" in answer.caveat


def test_rooms_stacked_on_two_storeys_are_summed_and_not_unioned(office: SpatialModel) -> None:
    """The trap a plan-only union would fall into.

    ``Buero 01`` (55.68 m²) sits directly under ``Buero 03`` (92.16 m²) and
    their footprints overlap completely in plan. A Brandabschnitt over two
    floors is measured as the SUM — 147.84 m² — and unioning the plan would
    report 92.16 and lose a whole storey of floor area.
    """
    answer = fire.compartment_area(office, [BUERO_01, BUERO_03])
    assert answer.value["area"] == pytest.approx(147.84, abs=1e-6)
    assert answer.value["ueberschneidungen"] == []


def test_two_rooms_modelled_on_top_of_each_other_are_reported_not_subtracted(tmp_path: Path) -> None:
    """Same height, overlapping plan: one room modelled twice.

    The overlap is measured (a 4.0 × 5.0 m room and a 3.0 × 5.0 m room offset by
    2.0 m share 2.0 × 5.0 = 10 m²) and reported, and the sum stays at 35 m².
    Subtracting would require knowing WHICH of the two is spurious, and nothing
    in the geometry says.
    """
    w = _Writer("Doppelt modelliert")
    storey = w.product("IfcBuildingStorey", "StoreyEG", "Erdgeschoss", CompositionType="ELEMENT", Elevation=0.0)
    a = w.product("IfcSpace", "Space01", "R.01", (0.0, 4.0, 0.0, 5.0, 0.0, 2.5), LongName="Buero A")
    b = w.product("IfcSpace", "Space02", "R.02", (2.0, 5.0, 0.0, 5.0, 0.0, 2.5), LongName="Buero B")
    w.rel("IfcRelAggregates", "Aggr1", RelatingObject=storey, RelatedObjects=[a, b])
    model = w.write(tmp_path / "doppelt.ifc")

    answer = fire.compartment_area(model, [_gid("Space01"), _gid("Space02")])
    assert answer.value["area"] == pytest.approx(20.0 + 15.0, abs=1e-6)
    assert len(answer.value["ueberschneidungen"]) == 1
    assert answer.value["ueberschneidungen"][0]["area"] == pytest.approx(10.0, abs=1e-6)
    assert "NICHT bereinigt" in answer.caveat


def test_the_sample_houses_ground_floor_sums_its_three_rooms(house: SpatialModel) -> None:
    answer = fire.compartment_area(house, GROUND_FLOOR)
    assert answer.value["area"] == pytest.approx(SAMPLE_GROUND_FLOOR_AREA, abs=0.001)
    assert {entry["globalId"] for entry in answer.value["spaces"]} == {LIVING, BEDROOM, HALL}
    # The roof space is on the OTHER storey and must not be in here: it would
    # add 76 m² — as much again as the whole ground floor.
    assert ROOF_SPACE not in {entry["globalId"] for entry in answer.value["spaces"]}


def test_rooms_without_a_body_refuse_rather_than_report_zero(bodyless: SpatialModel) -> None:
    """``haus-mit-raeumen.ifc`` states two rooms and no geometry anywhere.

    0 m² would be a number an agent puts in a sentence. The refusal names
    ``floorArea`` because that is where the per-room reason lives.
    """
    answer = fire.compartment_area(bodyless, ZONE)
    assert answer.decidable is False
    assert "Grundfläche" in answer.missing.what
    assert "floorArea()" in answer.missing.remedy


def test_a_wall_is_not_a_compartment(office: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        fire.compartment_area(office, BRANDWAND)
    assert "compartmentArea() erwartet" in str(raised.value)
    assert "floorArea()" in str(raised.value)


def test_a_whole_building_is_refused_rather_than_silently_summed(office: SpatialModel) -> None:
    """„Alle Räume des Gebäudes" would answer a different question convincingly.

    The number would be the building's floor area wearing the name of a fire
    compartment, and nothing in the answer would show the substitution.
    """
    with pytest.raises(WrongKindError) as raised:
        fire.compartment_area(office, _gid("Building"))
    assert "IfcBuilding" in str(raised.value)


def test_an_unknown_id_raises_rather_than_returning_undecidable(office: SpatialModel) -> None:
    """A hallucinated GlobalId supports no claim about the export at all."""
    with pytest.raises(UnknownElementError):
        fire.compartment_area(office, "3w0zWKm7n8SB1qbfwUztXX")


# ════════════════════════════════════════════════════════════════════════════
# separating_elements
# ════════════════════════════════════════════════════════════════════════════


def test_the_brandwand_between_two_compartments_is_found_with_its_fire_rating(office: SpatialModel) -> None:
    answer = fire.separating_elements(office, BUERO_01, BUERO_02)
    assert answer.decidable
    assert answer.provenance == "declared"  # both spaces carry declared boundaries
    trennend = answer.value["trennend"]
    assert [entry["globalId"] for entry in trennend] == [BRANDWAND]
    assert trennend[0]["fireRating"] == "REI 90"
    assert trennend[0]["fireRatingDeklariert"] is True
    assert trennend[0]["compartmentation"] is True
    assert "Achsentest" in trennend[0]["warum"]


def test_the_door_in_the_fire_wall_is_reported_separately_with_its_own_rating(office: SpatialModel) -> None:
    """A REI 90 wall with an unrated door in it is a finding about the door.

    Reporting only the wall hides the weak point of the whole compartment
    boundary, so the opening travels with its own FireRating and its host.
    """
    answer = fire.separating_elements(office, BUERO_01, BUERO_02)
    openings = answer.value["oeffnungen"]
    assert [entry["globalId"] for entry in openings] == [BRANDSCHUTZTUER]
    assert openings[0]["fireRating"] == "EI2 30-C"
    assert openings[0]["inBauteil"] == BRANDWAND
    # The door must NOT also appear as a separating element: one door is one
    # barrier, and listing it twice would read as two.
    assert BRANDSCHUTZTUER not in [entry["globalId"] for entry in answer.value["trennend"]]


def test_a_facade_running_past_both_rooms_bounds_them_without_separating_them(office: SpatialModel) -> None:
    """The reason a plain intersection of ``bounds()`` is not enough.

    ``Aussenwand Sued`` runs from x = 0 to x = 10 and bounds both offices. It
    separates neither, and calling it a Trennbauteil would put a REI requirement
    on a facade. It is still reported — under ``gemeinsam``, with the reason.
    """
    answer = fire.separating_elements(office, BUERO_01, BUERO_02)
    alongside = {entry["globalId"]: entry for entry in answer.value["gemeinsam"]}
    assert SUEDWAND in alongside
    assert "läuft an beiden Räumen entlang" in alongside[SUEDWAND]["warum"]

    # Nothing is dropped: every element that bounds BOTH rooms lands in exactly
    # one of the three lists. The west and east walls bound one room each and
    # are correctly absent — they are not shared to begin with.
    shared = {ref.global_id for ref in _bounds_of(office, BUERO_01)} & {
        ref.global_id for ref in _bounds_of(office, BUERO_02)
    }
    listed = {entry["globalId"] for entry in answer.value["trennend"]} | set(alongside)
    listed |= {entry["globalId"] for entry in answer.value["oeffnungen"]}
    assert listed == shared
    assert not {WESTWAND, OSTWAND} & shared


def test_a_floor_slab_separates_the_room_above_from_the_room_below(office: SpatialModel) -> None:
    """The vertical case, which is a Brandabschnitt boundary as much as a wall."""
    answer = fire.separating_elements(office, BUERO_01, BUERO_03)
    trennend = {entry["globalId"]: entry for entry in answer.value["trennend"]}
    assert DECKE_EG in trennend
    assert trennend[DECKE_EG]["fireRating"] == "REI 90"
    assert "in z getrennt" in trennend[DECKE_EG]["warum"]


def test_the_sample_houses_partition_is_found_and_its_door_stands_proud_of_it(house: SpatialModel) -> None:
    """The measurement behind ``SEPARATION_SLACK``.

    Living room and bedroom are split by a 95 mm partition whose body fills the
    gap exactly, while the door in it is 63 mm wider on each side. A slack below
    0.063 m loses the door — the one element in a compartment boundary that must
    not go missing.
    """
    answer = fire.separating_elements(house, LIVING, BEDROOM)
    assert [entry["globalId"] for entry in answer.value["trennend"]] == [PARTITION]
    assert DOOR_LIVING_BEDROOM in [entry["globalId"] for entry in answer.value["oeffnungen"]]
    assert fire.SEPARATION_SLACK > 0.063


def test_no_fire_rating_anywhere_is_stated_as_a_finding_about_the_export(house: SpatialModel) -> None:
    """0 of 75 products in ``Ifc4_SampleHouse.ifc`` declare ``FireRating``.

    An empty field reads as "no fire resistance", which is a claim about a
    building. The truth is a claim about a file, and the difference decides
    whether the architect re-exports or redesigns.
    """
    answer = fire.separating_elements(house, LIVING, BEDROOM)
    assert answer.value["trennend"][0]["fireRating"] is None
    assert answer.value["ohneFeuerwiderstand"]
    assert "NIRGENDS ein Feuerwiderstand deklariert" in answer.caveat
    assert "Befund über den EXPORT" in answer.caveat
    assert "Pset_WallCommon.FireRating" in answer.caveat


def test_a_gap_in_a_file_that_declares_elsewhere_reads_differently(bodyless: SpatialModel) -> None:
    """``haus-mit-raeumen.ifc`` declares ``REI 90`` on three outer walls.

    Its Trennwand carries none — so this is a gap in THOSE elements, not a
    file-wide absence, and the sentence has to change accordingly or the
    architect is sent to fix the wrong thing.
    """
    assert bodyless.declared_property(bodyless.file.by_guid(AUSSENWAND_SUED), ("FireRating",)) == "REI 90"
    answer = fire.separating_elements(bodyless, WOHNZIMMER, KUECHE)
    assert [entry["globalId"] for entry in answer.value["trennend"]] == [TRENNWAND]
    assert answer.value["trennend"][0]["fireRating"] is None
    assert "obwohl die Datei ihn andernorts deklariert" in answer.caveat
    assert "NIRGENDS" not in answer.caveat


def test_without_bodies_the_betweenness_test_is_skipped_and_says_so(bodyless: SpatialModel) -> None:
    """Nothing in this file has geometry, so nothing can be excluded.

    Reporting the shared bounding elements is right; reporting them as *tested*
    would not be. Excluding a fire wall on no evidence is the dangerous
    direction, so the untested list goes out with the admission attached.
    """
    answer = fire.separating_elements(bodyless, WOHNZIMMER, KUECHE)
    assert answer.value["gemeinsam"] == []
    assert "nicht geprüft" in answer.value["trennend"][0]["warum"]
    assert "NICHT geprüft" in answer.caveat


def test_a_shared_slab_is_never_reported_as_proof_the_rooms_are_neighbours() -> None:
    """``geschossdecke-und-fenster.ifc`` — one slab under all three rooms.

    That fixture's header states its own invariant: ``Wohnen`` and ``Bad`` share
    ONLY the floor slab, so they are stacked or side by side and NOT neighbours.
    The same unrestricted intersection made 4 278 false pairs out of one slab in
    a real export, which is why ``adjacent_spaces`` now filters purely
    horizontal separators.

    This operator asks a narrower question — *what lies between these two* — and
    so may legitimately report the slab: if the rooms are stacked, the slab is
    exactly the separating element. What it may not do is imply adjacency or
    claim the position was verified. This file has no bodies at all, so the
    entry says betweenness was not checked, and the caveat says the list can
    contain elements that bound both rooms without separating them.
    """
    model = SpatialModel(str(BOUNDARIES_ONLY))
    wohnen, bad = "4Decke00000Space00001", "4Decke00000Space00003"
    answer = fire.separating_elements(model, wohnen, bad)

    slab = answer.value["trennend"]
    assert [entry["ifcType"] for entry in slab] == ["IfcSlab"]
    assert "nicht geprüft" in slab[0]["warum"]
    assert "ohne sie zu trennen" in answer.caveat
    # No claim of adjacency anywhere: that is a different question, and the
    # operator that answers it excludes this pair.
    assert "benachbart" not in _text(answer)
    assert bad not in {ref.global_id for ref in _adjacent_of(model, wohnen)}


def test_the_opening_chain_is_walked_even_without_second_level_boundaries(bodyless: SpatialModel) -> None:
    """The Zimmertür reaches the answer through ``voids`` + ``fills`` alone."""
    openings = fire.separating_elements(bodyless, WOHNZIMMER, KUECHE).value["oeffnungen"]
    assert [entry["globalId"] for entry in openings] == [ZIMMERTUER]
    assert openings[0]["inBauteil"] == TRENNWAND
    assert "IfcRelVoidsElement" in openings[0]["via"]


def test_two_rooms_that_share_nothing_are_a_decidable_empty_answer(office: SpatialModel) -> None:
    """A ground-floor office and the Technikraum two storeys above it.

    They share no bounding element in this export, and that is an ANSWER — not
    a failure and not a missing relation. The caveat has to offer both readings,
    because the file cannot tell them apart: the rooms genuinely do not touch,
    or this export's boundaries are incomplete.
    """
    answer = fire.separating_elements(office, BUERO_02, TECHNIKRAUM)
    assert answer.decidable
    assert answer.value["trennend"] == []
    assert answer.value["oeffnungen"] == []
    assert "KEIN gemeinsames Bauteil" in answer.caveat
    assert "adjacentSpaces()" in answer.caveat


def test_the_same_room_twice_is_refused(house: SpatialModel) -> None:
    answer = fire.separating_elements(house, LIVING, LIVING)
    assert answer.decidable is False
    assert "zweimal derselbe Raum" in answer.missing.what
    assert "bounds()" in answer.missing.remedy


def test_a_wall_is_not_a_room(house: SpatialModel) -> None:
    with pytest.raises(WrongKindError) as raised:
        fire.separating_elements(house, NORTH_WALL, LIVING)
    assert "separatingElements() erwartet" in str(raised.value)
    assert "enclosedBy()" in str(raised.value)


# ════════════════════════════════════════════════════════════════════════════
# distance_to_site_boundary — the one that usually refuses
# ════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("fixture", [SAMPLE_HOUSE, NO_GEOMETRY, NO_SPACES, NO_STOREYS, BOUNDARIES_ONLY])
def test_no_fixture_in_this_repository_can_answer_the_boundary_question(fixture: Path) -> None:
    """All five carry an ``IfcSite`` with no representation and no annotation.

    This is not a gap in the test corpus, it is what an architectural export
    looks like. The assertion is here so that a later change which *invents* a
    number — from the site's bounding box, from the model extent — fails loudly
    instead of quietly producing a plausible Abstand zur Grundstücksgrenze.
    """
    model = SpatialModel(str(fixture))
    assert model.file.by_type("IfcSite")
    assert all(site.Representation is None for site in model.file.by_type("IfcSite"))

    answer = fire.distance_to_site_boundary(model)
    assert answer.decidable is False
    assert answer.value is None
    assert "Grundstücksgrenze" in answer.missing.what


def test_the_refusal_names_what_to_export_and_rejects_the_bounding_box(house: SpatialModel) -> None:
    """An honest refusal is worth more than a number derived from the site box.

    The site's extent in an export is the extent of whatever someone modelled;
    it has no relationship to the parcel in the Katasterplan. The remedy has to
    say both what to draw and why the cheap substitute is not offered.
    """
    remedy = fire.distance_to_site_boundary(house).missing.remedy
    assert "FootPrint" in remedy
    assert "IfcAnnotation" in remedy
    assert "Hüllbox" in remedy and "Erfindung" in remedy
    # The sample house IS georeferenced (RefLatitude 51° 30′) and still has no
    # boundary, so the remedy must say that georeferencing does not substitute.
    assert house.file.by_type("IfcSite")[0].RefLatitude is not None
    assert "RefLatitude" in remedy


def test_the_building_stands_three_metres_from_the_western_boundary(office: SpatialModel) -> None:
    """Building face at x = 0.00, plot boundary at x = −3.00."""
    answer = fire.distance_to_site_boundary(office)
    assert answer.decidable
    assert answer.unit == "m"
    assert answer.value["distance"] == pytest.approx(3.0, abs=1e-9)
    assert answer.value["nearest"]["globalId"] == WESTWAND
    assert answer.value["boundary"]["geschlossen"] is True
    assert "FootPrint" in answer.value["boundary"]["via"]
    assert answer.value["ausserhalb"] is False


def test_both_ends_of_the_measurement_travel_with_it(office: SpatialModel) -> None:
    """A reviewer with two coordinates can put a dimension line on the plan."""
    nearest = fire.distance_to_site_boundary(office).value["nearest"]
    assert nearest["pointOnElement"][0] == pytest.approx(0.0, abs=1e-6)
    assert nearest["pointOnBoundary"][0] == pytest.approx(-3.0, abs=1e-6)
    assert nearest["pointOnElement"][1] == pytest.approx(nearest["pointOnBoundary"][1], abs=1e-6)


def test_air_is_not_measured(office: SpatialModel) -> None:
    """Spaces and openings reach further than the walls that contain them.

    ``Buero 01``'s body starts at x = 0.20, but its solid is air; measuring it
    would report a distance the building does not have. Only physical elements
    are candidates.
    """
    measured = {entry["globalId"] for entry in fire.distance_to_site_boundary(office).value["elemente"]}
    assert not measured & {BUERO_01, BUERO_02, BUERO_03, TECHNIKRAUM}
    assert WESTWAND in measured


def test_one_element_can_be_asked_on_its_own(office: SpatialModel) -> None:
    """The east wall's nearest boundary is the SOUTH edge, not the east one.

    Its body spans x 9.8–10.0 and y 0.0–10.0; the boundary runs x −3…25 and
    y −5…20, so east is 15.0 m away, west 12.8 m, north 10.0 m and south 5.0 m.
    A per-axis shortcut would answer 15.0.
    """
    answer = fire.distance_to_site_boundary(office, OSTWAND)
    assert answer.value["distance"] == pytest.approx(5.0, abs=1e-9)
    assert answer.value["nearest"]["globalId"] == OSTWAND
    assert answer.value["distance"] > fire.distance_to_site_boundary(office).value["distance"]


def test_an_annotation_is_the_second_route_to_a_boundary(tmp_path: Path) -> None:
    """Exporters that cannot put a curve on the site put one in an annotation.

    The polyline here is also left OPEN — two sides of a parcel, as a survey
    layer often is. It must still measure, on the DRAWN segments only, and say
    so. Closing it silently would be the same substitution the bounding-box
    refusal exists to prevent: the invented third side of this very fixture runs
    1.06 m from the wall, against 7.70 m to the nearest line anyone drew.
    """
    w = _Writer("Grenze als Annotation")
    site = w.file.create_entity("IfcSite", GlobalId=BAUPLATZ, Name="Bauplatz", CompositionType="ELEMENT")
    wall = w.product("IfcWall", "Wall01", "Aussenwand", (0.0, 4.0, 0.0, 0.3, 0.0, 3.0))
    annotation = w.file.create_entity(
        "IfcAnnotation",
        GlobalId=_gid("Annot01"),
        Name="Grundstücksgrenze Nord",
        ObjectPlacement=w.placement,
        Representation=w.curve([(-10.0, 8.0), (20.0, 8.0), (20.0, -6.0)], "Annotation"),
    )
    w.rel("IfcRelAggregates", "Aggr1", RelatingObject=w.project, RelatedObjects=[site])
    w.rel("IfcRelContainedInSpatialStructure", "Cont1", RelatingStructure=site, RelatedElements=[wall, annotation])
    model = w.write(tmp_path / "annotation-grenze.ifc")

    answer = fire.distance_to_site_boundary(model)
    assert answer.decidable
    # Wall top edge at y = 0.30, boundary at y = 8.00.
    assert answer.value["distance"] == pytest.approx(7.7, abs=1e-6)
    assert "IfcAnnotation" in answer.value["boundary"]["via"]
    assert answer.value["boundary"]["geschlossen"] is False
    assert "NICHT geschlossen" in answer.caveat
    assert "zu GROSS" in answer.caveat
    # Not `False`: inside/outside cannot be decided against an open line, and a
    # confident `False` would be an answer about a shape nobody drew.
    assert answer.value["ausserhalb"] is None


# ════════════════════════════════════════════════════════════════════════════
# the contract, asserted as hard as the numbers
# ════════════════════════════════════════════════════════════════════════════


def _text(answer: Any) -> str:
    """Everything a reader could be shown, as one string."""
    import json

    return json.dumps(answer.to_dict(), ensure_ascii=False, default=str)


def _every_answer(office: SpatialModel, house: SpatialModel, bodyless: SpatialModel) -> list[Any]:
    return [
        fire.fluchtniveau(office),
        fire.fluchtniveau(house),
        fire.fluchtniveau(bodyless),
        fire.compartment_area(office, BRANDABSCHNITT),
        fire.compartment_area(office, EG),
        fire.compartment_area(house, GROUND_FLOOR),
        fire.compartment_area(bodyless, ZONE),
        fire.separating_elements(office, BUERO_01, BUERO_02),
        fire.separating_elements(office, BUERO_01, BUERO_03),
        fire.separating_elements(house, LIVING, BEDROOM),
        fire.separating_elements(bodyless, WOHNZIMMER, KUECHE),
        fire.distance_to_site_boundary(office),
        fire.distance_to_site_boundary(house),
    ]


def test_no_answer_this_module_produces_states_a_verdict(
    office: SpatialModel, house: SpatialModel, bodyless: SpatialModel
) -> None:
    """Asserted on the ANSWERS, not on the source.

    The source is allowed to discuss verdicts — that is what the docstrings are
    for — and the answers are not. „90,24 m²" is a measurement; „90,24 m² —
    erfüllt" is a ruling, and the moment one turns into the other nobody
    downstream can take them apart again.
    """
    for answer in _every_answer(office, house, bodyless):
        blob = _text(answer).lower()
        for verdict in ("erfüllt", "eingehalten", "compliant", "unzulässig", "zulässig", "verstoß", "konform"):
            assert verdict not in blob, f"{verdict!r} reached a reader via {answer.method}"


def test_no_answer_this_module_produces_applies_a_threshold(
    office: SpatialModel, house: SpatialModel, bodyless: SpatialModel
) -> None:
    """OIB 2 names a maximum compartment area, a maximum height per class and a
    minimum distance to the boundary. None of them is in here."""
    for answer in _every_answer(office, house, bodyless):
        blob = _text(answer).lower()
        assert "grenzwert" not in blob, answer.method
        assert re.search(r"\bgk\s?[1-5]\b", blob) is None, answer.method


def test_every_undecidable_answer_carries_a_german_remedy(
    office: SpatialModel, house: SpatialModel, bodyless: SpatialModel
) -> None:
    """An undecidable without a remedy is a shrug wearing a data structure."""
    refusals = [answer for answer in _every_answer(office, house, bodyless) if not answer.decidable]
    assert refusals, "the fixtures must produce at least one refusal, or this asserts nothing"
    for answer in refusals:
        assert answer.missing is not None
        assert answer.missing.what and answer.missing.remedy
        # German, not English: the reader is an Austrian architect acting in CAD.
        assert re.search(r"[a-zäöüß]", answer.missing.remedy)
        assert any(word in answer.missing.remedy for word in ("exportieren", "setzen", "aufrufen", "CAD", "anlegen"))


def test_every_decidable_answer_names_the_elements_it_came_from(
    office: SpatialModel, house: SpatialModel, bodyless: SpatialModel
) -> None:
    for answer in _every_answer(office, house, bodyless):
        if not answer.decidable:
            continue
        assert answer.from_, answer.method
        assert answer.method
        assert answer.caveat, f"{answer.method} came back without a qualification"

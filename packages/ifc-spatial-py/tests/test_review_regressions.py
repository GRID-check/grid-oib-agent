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
import pytest
from ifc_spatial import operators as op
from ifc_spatial.model import SpatialModel
from ifc_spatial.model import _unit_scale_to_si

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
STACKED = FIXTURES / "geschossdecke-und-fenster.ifc"

LIVING = "3w0zWKm7n8SB1qbfwUzt0U"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
LOFT = "09J5N7xMHBfQZeQGAEMota"


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(HOUSE))


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

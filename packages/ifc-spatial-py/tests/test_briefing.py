"""The briefing, the lexicon and the blind spots.

Three properties are under test here, and only the first is about arithmetic:

  1. the room lexicon classifies the same building the same way whichever
     language and whichever umlaut spelling the exporter used;
  2. a blind spot fires when the file really has the gap and — the half that is
     easy to forget and expensive to get wrong — stays silent when it does not.
     A briefing that reports a false gap teaches the agent to stop asking
     exactly the questions this library exists to answer;
  3. an absent fact never renders as a zero that reads like a statement about
     the building.

The fixtures are the repository's own hand-written IFCs plus, for the lexicon,
a file built in memory here — nothing third-party is committed.
"""

from __future__ import annotations

from pathlib import Path

import ifcopenshell
import pytest
from ifc_spatial.briefing import LEXICON
from ifc_spatial.briefing import briefing
from ifc_spatial.briefing import classify_rooms
from ifc_spatial.briefing import find_blind_spots
from ifc_spatial.briefing import inventory
from ifc_spatial.briefing import measure_dialect
from ifc_spatial.briefing import normalise
from ifc_spatial.briefing import render_briefing
from ifc_spatial.briefing import storey_heights
from ifc_spatial.model import SpatialModel

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
#: English room names, no IfcRelSpaceBoundary, TrueNorth and georeferencing present.
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
#: German room names, WITH IfcRelSpaceBoundary, no TrueNorth, no georeferencing.
GERMAN_HOUSE = FIXTURES / "haus-mit-raeumen.ifc"
#: No spaces at all.
NO_SPACES = FIXTURES / "einheiten-fuss.ifc"


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(SAMPLE_HOUSE))


@pytest.fixture(scope="module")
def german() -> SpatialModel:
    return SpatialModel(str(GERMAN_HOUSE))


@pytest.fixture(scope="module")
def spaceless() -> SpatialModel:
    return SpatialModel(str(NO_SPACES))


def _named_spaces(tmp_path: Path, names: list[str]) -> SpatialModel:
    """A minimal IFC4 file whose only content is rooms with these names.

    Built in memory rather than committed: the lexicon has to be tested on
    spellings no fixture happens to contain (`Waschküche` against `Küche`,
    `KÜCHE` against `Kueche`), and a file written for the test states exactly
    what it is testing.
    """
    file = ifcopenshell.file(schema="IFC4")
    units = file.create_entity(
        "IfcUnitAssignment",
        Units=[file.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")],
    )
    file.create_entity("IfcProject", GlobalId=ifcopenshell.guid.new(), Name="Lexikon", UnitsInContext=units)
    for index, name in enumerate(names):
        file.create_entity("IfcSpace", GlobalId=ifcopenshell.guid.new(), Name=f"R.{index:02d}", LongName=name)
    path = tmp_path / "lexikon.ifc"
    file.write(str(path))
    return SpatialModel(str(path))


# ── the lexicon, in both languages ──────────────────────────────────────────


def test_classifies_german_room_names(german: SpatialModel) -> None:
    rooms = {room.name: room for room in classify_rooms(german)}
    assert rooms["Wohnzimmer"].kind == "aufenthaltsraum"
    assert rooms["Kueche"].kind == "aufenthaltsraum"
    # The reason is part of the answer, not decoration: a reviewer has to be
    # able to disagree with the specific term that decided it.
    assert "wohnzimmer" in rooms["Wohnzimmer"].because[0]


def test_classifies_english_room_names(house: SpatialModel) -> None:
    """The sample file is an English Revit export of an Austrian house.

    A German-only lexicon classified none of its four rooms and reported
    "0 Aufenthaltsräume" about a house full of them — which is the reason the
    English half of the lexicon exists at all.
    """
    rooms = {room.name: room for room in classify_rooms(house)}
    assert rooms["Living room"].kind == "aufenthaltsraum"
    assert rooms["Bedroom"].kind == "aufenthaltsraum"
    assert rooms["Entrance hall"].kind == "erschliessung"
    # "Roof" is a space in this file and is not a room use. Leaving it
    # unclassified is the right answer, not a failure to find one.
    assert rooms["Roof"].kind is None


def test_longest_match_wins_and_umlauts_fold(tmp_path: Path) -> None:
    model = _named_spaces(tmp_path, ["Waschküche", "KÜCHE", "Kueche", "Küche", "Wohnküche"])
    rooms = {room.name: room for room in classify_rooms(model)}

    # `Waschküche` contains `küche`. Ranking by matched-term length is what puts
    # a laundry in `nebenraum` instead of proposing it as a habitable room.
    assert rooms["Waschküche"].kind == "nebenraum"
    # Same room, three spellings an exporter might emit, one classification.
    assert {rooms["KÜCHE"].kind, rooms["Kueche"].kind, rooms["Küche"].kind} == {"aufenthaltsraum"}
    assert rooms["Wohnküche"].kind == "aufenthaltsraum"


def test_short_terms_only_match_on_a_word_boundary(tmp_path: Path) -> None:
    """`bad` inside `Badminton` is not a bathroom, and `BAD-03` is."""
    model = _named_spaces(tmp_path, ["Badminton", "BAD-03", "WCB2", "WC 1"])
    rooms = {room.name: room for room in classify_rooms(model)}
    assert rooms["Badminton"].kind is None
    assert rooms["BAD-03"].kind == "nebenraum"
    assert rooms["WCB2"].kind is None
    assert rooms["WC 1"].kind == "nebenraum"


def test_weak_terms_are_capped_and_say_why(tmp_path: Path) -> None:
    model = _named_spaces(tmp_path, ["Zimmer", "Halle"])
    rooms = {room.name: room for room in classify_rooms(model)}
    assert rooms["Zimmer"].confidence <= 0.55
    assert any("allein sagt die Nutzung nicht" in reason for reason in rooms["Zimmer"].because)
    assert rooms["Halle"].kind == "erschliessung"
    assert rooms["Halle"].confidence <= 0.55


def test_normalise_is_stable_across_unicode_forms() -> None:
    import unicodedata

    composed = "Küche"
    decomposed = unicodedata.normalize("NFD", composed)
    assert composed != decomposed
    assert normalise(composed) == normalise(decomposed) == "kueche"
    assert normalise("Groß-Raum!") == "gross raum"


def test_lexicon_terms_are_already_normalised() -> None:
    """An entry that does not survive `normalise` can never match anything.

    Cheap to assert and impossible to notice otherwise: the failure is a term
    that silently classifies nothing, which looks exactly like a building that
    has no such room.
    """
    for entry in LEXICON:
        assert normalise(entry.term) == entry.term, entry.term


def test_inventory_is_inferred_and_says_it_is_a_proposal(house: SpatialModel) -> None:
    answer = inventory(house, "aufenthaltsraum")
    assert answer.decidable
    assert answer.provenance == "inferred"
    assert {room.name for room in answer.value} == {"Living room", "Bedroom"}
    assert answer.because and answer.confidence is not None
    # The one sentence that must survive every render.
    assert "RECHTLICHE Einstufung" in answer.caveat


def test_inventory_without_spaces_is_undecidable_not_empty(spaceless: SpatialModel) -> None:
    """ "No rooms in the export" and "no habitable rooms in the building" are
    different claims, and only the first one is true here."""
    answer = inventory(spaceless, "aufenthaltsraum")
    assert answer.decidable is False
    assert answer.value is None
    assert answer.missing.what == "IfcSpace"
    assert "IfcSpace exportieren" in answer.missing.remedy


# ── blind spots: firing, and NOT firing ─────────────────────────────────────


def _spots(model: SpatialModel) -> dict[str, str]:
    return {spot.what: spot.consequence for spot in find_blind_spots(model)}


def test_space_boundary_blind_spot_fires_when_the_export_omits_them(house: SpatialModel) -> None:
    assert "keine IfcRelSpaceBoundary" in _spots(house)


def test_space_boundary_blind_spot_stays_silent_when_they_are_there(german: SpatialModel) -> None:
    """The half that matters more.

    This file declares six `IfcRelSpaceBoundary`. Reporting the gap anyway would
    tell the agent that "which walls bound this room" is underivable in a file
    that states it outright — a false undecidable, which is the exact failure
    this library was built to end.
    """
    assert german.file.by_type("IfcRelSpaceBoundary")
    assert "keine IfcRelSpaceBoundary" not in _spots(german)


def test_north_and_georeferencing_fire_only_where_they_are_missing(house: SpatialModel, german: SpatialModel) -> None:
    assert "keine Nordrichtung" in _spots(german)
    assert "keine Georeferenzierung" in _spots(german)
    # The sample house declares TrueNorth and a georeferenced site.
    assert house.true_north is not None and house.georeferenced
    assert "keine Nordrichtung" not in _spots(house)
    assert "keine Georeferenzierung" not in _spots(house)


def test_missing_spaces_fire_only_where_there_are_none(spaceless: SpatialModel, house: SpatialModel) -> None:
    assert "keine IfcSpace-Elemente" in _spots(spaceless)
    assert "keine IfcSpace-Elemente" not in _spots(house)


def test_the_geometry_blind_spot_tracks_the_pass_and_does_not_claim_impossibility(
    tmp_path: Path,
) -> None:
    """The bug this shape exists to kill.

    The TS list was assembled before the geometry pass by construction and said
    "keine Geometrie in dieser Ausbaustufe … nicht berechenbar" on every file,
    including ones whose every element had just been tessellated. Here the
    sentence is about the PASS, it says the measurements are still possible, and
    it disappears once the pass has run.
    """
    model = SpatialModel(str(SAMPLE_HOUSE))
    before = _spots(model)
    lazy = next(k for k in before if k.startswith("Geometrie-Pass noch nicht"))
    assert "sind aber berechenbar" in before[lazy]

    model.geometry_pass()
    after = _spots(model)
    assert not any(k.startswith("Geometrie-Pass noch nicht") for k in after)
    # Every space in this file has a solid, so no room-without-a-body spot either.
    assert not any("ohne Volumenkörper" in k for k in after)


def test_unresolved_openings_are_reported_separately_from_a_missing_relation(
    house: SpatialModel,
) -> None:
    """The file writes `IfcRelFillsElement` and every window resolves, so
    neither the missing-relation spot nor the unresolved-openings spot fires."""
    spots = _spots(house)
    assert "keine IfcRelFillsElement" not in spots
    assert not any("ohne auflösbare Wandzuordnung" in k for k in spots)


# ── the dialect ─────────────────────────────────────────────────────────────


def test_dialect_publishes_this_file_s_own_vocabulary(house: SpatialModel) -> None:
    entries, scanned, sampled = measure_dialect(house)
    assert scanned > 0 and sampled is False
    paths = {f"{e.set}.{e.property}" for e in entries}
    # Revit-flavoured property sets a filter written against `Pset_*` would miss
    # entirely — which is the whole reason the block is printed.
    assert "BaseQuantities.Height" in paths
    assert "Pset_WallCommon.ThermalTransmittance" in paths
    # `get_psets` injects the pset's own express id; it is bookkeeping, not
    # vocabulary, and offering it as something to filter on would be a lie.
    assert not any(e.property == "id" for e in entries)


def test_absent_decisive_properties_are_named_rather_than_left_invisible(house: SpatialModel) -> None:
    absent = {entry["property"] for entry in briefing(house).absent_properties}
    # Nothing in this file publishes a fire rating. Without this line the agent
    # filters on it, gets nothing, and reports "no wall has a fire rating".
    assert "FireRating" in absent
    assert "SillHeight" in absent
    # ...while a property the file DOES publish must not be listed as absent.
    assert "ThermalTransmittance" not in absent


# ── storey heights ──────────────────────────────────────────────────────────


def test_storey_heights_carry_the_caveat_that_makes_them_safe(house: SpatialModel) -> None:
    answer = storey_heights(house)
    # `declared`, not `computed`: every number in this answer is
    # IfcBuildingStorey.Elevation, read verbatim or subtracted from the next.
    assert answer.decidable and answer.provenance == "declared"
    assert [entry["height"] for entry in answer.value] == [2.5, None]
    # The top storey has no next elevation and is left open rather than guessed.
    assert answer.value[-1]["height"] is None
    assert "NICHT die lichte Raumhöhe" in answer.caveat


def test_storey_heights_are_undecidable_below_two_elevations(spaceless: SpatialModel) -> None:
    answer = storey_heights(spaceless)
    if answer.decidable:  # pragma: no cover — guards the fixture, not the code
        pytest.skip("fixture declares two storey elevations")
    assert answer.missing.what == "IfcBuildingStorey.Elevation"
    assert "Höhenlage" in answer.missing.remedy or "Geschoße" in answer.missing.remedy


# ── the render ──────────────────────────────────────────────────────────────


def test_render_is_deterministic(house: SpatialModel) -> None:
    """This text enters the model's context on every conversation about the
    file. A briefing that varies between calls makes two answers about the same
    building differ for reasons nobody can reconstruct afterwards."""
    assert render_briefing(house) == render_briefing(house)


def test_render_names_the_relation_behind_every_zero(house: SpatialModel) -> None:
    text = render_briefing(house)
    # Not "0 Räume mit Raumbegrenzung", which is a sentence about a building.
    assert "0 von 4 — dieser Export schreibt kein IfcRelSpaceBoundary" in text
    assert "Aussage über den Export, nicht über das Gebäude" in text


def test_render_names_absent_containers_by_entity_not_by_zero(tmp_path: Path) -> None:
    model = _named_spaces(tmp_path, ["Wohnzimmer"])
    text = render_briefing(model)
    assert "kein IfcBuilding" in text and "0 Gebäude" not in text
    assert "keine IfcBuildingStorey" in text and "0 Geschoße" not in text


def test_render_announces_what_it_dropped(house: SpatialModel) -> None:
    text = render_briefing(house)
    # Silent truncation is the same bug as a subset reported as a total: a list
    # that ENDS reads as complete.
    assert "weitere Merkmale, nach Befüllung sortiert" in text
    assert "weitere Typen" in text


def test_briefing_does_not_run_geometry() -> None:
    """§8.2 makes the briefing the free rung of the disclosure ladder.

    On this engine the geometry pass costs seconds, so a briefing that triggered
    it would make the cheapest call the most expensive one.
    """
    model = SpatialModel(str(SAMPLE_HOUSE))
    render_briefing(model)
    assert model.geometry_seconds == 0.0
    assert model.contact_seconds == 0.0

"""The tool surface an agent actually calls.

The end-to-end test is the one that matters: open the fixture, find the window,
ask which room it serves, and get `Bedroom` back with the provenance attached.
That path crosses every layer — cache, model, contact map, operator, envelope,
JSON — and it is the path the product is.

The rest guard the three rules the surface exists to keep:

  - an unknown GlobalId is an ERROR (the caller could not look), while "this
    file cannot say" is a SUCCESSFUL result carrying `decidable: false` with a
    German remedy;
  - a no-hit search says so and points at the briefing, instead of letting an
    empty list read as a fact about the building;
  - nothing runs geometry behind the caller's back.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from ifc_spatial.tools import MEASURES
from ifc_spatial.tools import RELATIONS
from ifc_spatial.tools import ToolError
from ifc_spatial.tools import call
from ifc_spatial.tools import create_tools

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
NO_NORTH = FIXTURES / "haus-mit-raeumen.ifc"

WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
GROUND_FLOOR = "1o0c33arXF9AEePDYchjCY"
PARTITION = "3cUkl32yn9qRSPvBJVyWY1"
ROOF = "3cUkl32yn9qRSPvBJVyWh4"


@pytest.fixture(scope="module")
def tools() -> list:
    """One tool list for the module, so the geometry pass and the contact map
    are paid for once — exactly as a conversation would."""
    return create_tools()


@pytest.fixture(scope="module")
def house(tools: list) -> str:
    return call(tools, "open_model", {"path": str(SAMPLE_HOUSE)})["model"]


# ── the end-to-end run ──────────────────────────────────────────────────────


def test_opens_the_fixture_and_resolves_the_window_to_its_room(tools: list, house: str) -> None:
    found = call(tools, "find_elements", {"model": house, "ifcType": "IfcWindow"})
    assert found["total"] == 4 and found["truncated"] is False
    ids = [element["globalId"] for element in found["elements"]]
    assert WINDOW in ids

    wall = call(tools, "relations", {"model": house, "globalId": WINDOW, "relation": "hostedIn"})
    assert wall["decidable"] is True
    # Two hops through relations the file states outright — a reading of the
    # file, but not something the file says, hence `computed`.
    assert wall["provenance"] == "computed"
    assert "Wall-Ext_102Bwk" in wall["value"][0]["name"]

    room = call(tools, "relations", {"model": house, "globalId": WINDOW, "relation": "opensTo"})
    assert [ref["name"] for ref in room["value"]] == ["Bedroom"]
    # This export writes no IfcRelSpaceBoundary at all. The relation exists only
    # because geometry recovered it, and the answer has to say so — presenting a
    # contact test as a declared fact is the failure this library prevents.
    assert room["provenance"] == "computed"
    assert "Geometrie abgeleitet" in room["caveat"]

    area = call(tools, "measure", {"model": house, "globalId": BEDROOM, "measure": "floorArea"})
    assert area["decidable"] is True and area["unit"] == "m²"
    assert abs(area["value"] - 15.41678125) < 0.001
    # The file declares this area too, and both routes agree — which is a
    # stronger claim than either number alone.
    assert area["agreement"] == "agree"


def test_every_result_survives_json(tools: list, house: str) -> None:
    """NumPy scalars and dataclasses arrive from the operators; a transport that
    cannot serialise them turns a good answer into an outage."""
    for name, args in [
        ("briefing", {"model": house}),
        ("element", {"model": house, "globalId": WINDOW}),
        ("relations", {"model": house, "globalId": NORTH_WALL, "relation": "hosts"}),
        ("measure", {"model": house, "globalId": WINDOW, "measure": "extent"}),
        ("distance", {"model": house, "a": WINDOW, "b": BEDROOM, "mode": "horizontal"}),
        ("storey_heights", {"model": house}),
        ("room_inventory", {"model": house, "kind": "aufenthaltsraum"}),
    ]:
        text = json.dumps(call(tools, name, args), ensure_ascii=False)
        assert text and "ndarray" not in text and "object at 0x" not in text


# ── the three rules ─────────────────────────────────────────────────────────


def test_an_unknown_global_id_is_an_error_not_an_undecidable(tools: list, house: str) -> None:
    """A hallucinated id supports no claim about the export whatsoever. Handing
    it back as `decidable: false` would let it be reported as „das Modell sagt
    dazu nichts"."""
    with pytest.raises(ToolError) as raised:
        call(tools, "relations", {"model": house, "globalId": "1234567890abcdefghijkl", "relation": "hostedIn"})
    assert "Unbekannte GlobalId" in str(raised.value)
    assert "find_elements" in str(raised.value)


def test_the_file_cannot_say_is_a_successful_answer(tools: list) -> None:
    handle = call(tools, "open_model", {"path": str(NO_NORTH)})["model"]
    walls = call(tools, "find_elements", {"model": handle, "ifcType": "IfcWall", "limit": 1})
    wall_id = walls["elements"][0]["globalId"]

    answer = call(tools, "measure", {"model": handle, "globalId": wall_id, "measure": "azimuth"})
    assert answer["decidable"] is False
    assert answer["value"] is None
    assert answer["missing"]["what"] == "IfcGeometricRepresentationContext.TrueNorth"
    # A remedy an architect can act on, in German, about the EXPORT.
    assert "Nordrichtung" in answer["missing"]["remedy"]


def test_no_hits_points_at_the_briefing_instead_of_reading_as_a_fact(tools: list, house: str) -> None:
    empty = call(tools, "find_elements", {"model": house, "ifcType": "IfcRamp"})
    assert empty["total"] == 0 and empty["elements"] == []
    assert "gibt es nicht" in empty["hint"] and "Briefing" in empty["hint"]


def test_a_page_is_never_presented_as_a_total(tools: list, house: str) -> None:
    page = call(tools, "find_elements", {"model": house, "ifcType": "IfcWindow", "limit": 2})
    assert len(page["elements"]) == 2
    assert page["total"] == 4
    assert page["truncated"] is True


def test_an_unopened_model_says_which_ones_are_open(tools: list, house: str) -> None:
    with pytest.raises(ToolError) as raised:
        call(tools, "briefing", {"model": "deadbeefdead"})
    assert "open_model" in str(raised.value)


def test_open_and_briefing_do_not_run_geometry() -> None:
    """A fresh tool set, so nothing else has warmed the model."""
    fresh = create_tools()
    opened = call(fresh, "open_model", {"path": str(SAMPLE_HOUSE)})
    assert opened["geometry"]["pass"] == "noch nicht gelaufen"
    call(fresh, "briefing", {"model": opened["model"]})
    call(fresh, "find_elements", {"model": opened["model"], "ifcType": "IfcSpace"})
    call(fresh, "element", {"model": opened["model"], "globalId": WINDOW})
    assert "Geometrie-Pass noch nicht gelaufen" in call(fresh, "briefing", {"model": opened["model"]})["briefing"]


# ── the surface itself ──────────────────────────────────────────────────────


def test_the_tool_list_is_the_ported_surface_plus_what_the_port_added(tools: list) -> None:
    """Ten tools ported from `tools.ts`, and ten the port added.

    `view` sits BEFORE `draw` deliberately. They look like duplicates and are
    not: `draw` writes an SVG file for a human, `view` returns a raster the
    MODEL can see. A model reading the list top-down should meet the one it can
    actually use first, because the one it cannot returns a file path that tells
    it nothing.

    `overhang` and `light_incidence` existed as operators from the start and
    were reachable from nothing. That is worse than not having them: the skill
    teaches a call chain that ends in the overhang, and a chain whose last link
    is missing answers the original question exactly as badly as before. The
    order is asserted because it is the order the model reads them in, and the
    two additions sit after `draw` — after everything they compose.

    `envelope` is the same story one Richtlinie over, and it sits beside `fire`
    because the two are the same shape: one subject, several aspects, no
    GlobalId. Its three operators shipped implemented and tested and reachable
    from nothing, so every OIB 6 question was answered „das kann dieser Export
    nicht" — a sentence about the file that was really about our wiring.

    `clearance` and `sun_position` are the third and fourth instances of that
    same defect, found by walking every public operator against this list.
    `clearance` sits directly after `distance` because it is the operator
    `distance` sends the reader to and never had: on the roof against the
    partition, `distance('min')` reports 0.000 m where the clear dimension is
    0.995 m. `sun_position` sits after `light_incidence` because it is the other
    half of a shading question and composes with nothing else.

    `survey` and `profile` are the two additions that reach no new operator at
    all — they are the two ways `measure` gets composed, and they sit on either
    side of it because a model reading down the list should meet the plural
    form („alle Räume dieses Geschoßes") immediately after the singular. They
    exist because the caller's budget is five tool calls: the capability to
    answer „wie hoch ist der Keller" was present and correct for months, and the
    agent still answered it from the declared storey pitch, because reaching the
    measurement one room at a time did not fit.
    """
    assert [tool.name for tool in tools] == [
        "open_model",
        "briefing",
        "find_elements",
        "element",
        "relations",
        "measure",
        "survey",
        "profile",
        "distance",
        "clearance",
        "fire",
        "envelope",
        "shopping_list",
        "view",
        "draw",
        "overhang",
        "light_incidence",
        "sun_position",
        "storey_heights",
        "room_inventory",
    ]


def test_every_tool_documents_itself_in_german(tools: list) -> None:
    for tool in tools:
        assert tool.title and tool.description
        assert tool.input_schema["type"] == "object"
        for name in tool.input_schema.get("required", []):
            assert name in tool.input_schema["properties"], f"{tool.name}.{name}"


def test_one_relations_tool_carries_every_relation(tools: list) -> None:
    """Eleven tools would be eleven copies of one schema. What must not be
    coarse is the meaning, so the enum documents each relation individually."""
    relations = next(tool for tool in tools if tool.name == "relations")
    enum = relations.input_schema["properties"]["relation"]["enum"]
    assert enum == list(RELATIONS)
    for name, meaning in RELATIONS.items():
        assert f"{name} — {meaning}" in relations.description


def test_measure_lists_every_measurement_and_corrects_the_clear_height(tools: list) -> None:
    measure = next(tool for tool in tools if tool.name == "measure")
    assert measure.input_schema["properties"]["measure"]["enum"] == list(MEASURES)
    # The TS description said clearHeight returns the space solid's height and
    # NOT the lichte Höhe. On this engine it is the lichte Höhe, measured under
    # the lowest obstruction; keeping the old sentence would describe an
    # operator that no longer exists.
    assert "Lichte Raumhöhe" in MEASURES["clearHeight"]
    assert "NICHT die Höhe des Raumkörpers" in MEASURES["clearHeight"]


def test_the_expensive_tools_say_they_are_expensive(tools: list) -> None:
    by_name = {tool.name: tool for tool in tools}
    assert "5 Sekunden" in by_name["draw"].description
    assert "Kontaktkarte" in by_name["relations"].description
    assert "tesselliert" in by_name["measure"].description


def test_clear_height_measures_under_the_suspended_ceiling(tools: list, house: str) -> None:
    """The one number where the engine swap changes an ANSWER.

    The TS operator reports the 2.50 m space solid; this one casts rays and
    finds the ceiling at 2.20 m. An OIB minimum room height is a clear dimension
    under the lowest obstruction, so the TS number would pass a room that fails.
    """
    answer = call(tools, "measure", {"model": house, "globalId": BEDROOM, "measure": "clearHeight"})
    assert answer["decidable"] is True
    assert abs(answer["value"] - 2.20) < 0.01
    assert "Möblierung" in answer["caveat"]


def test_draw_writes_a_file_and_does_not_return_the_svg(tools: list, house: str) -> None:
    """A whole-building plan is hundreds of kilobytes of path data. Putting that
    in an agent's context evicts the conversation to deliver something the agent
    cannot read anyway."""
    result = call(tools, "draw", {"model": house})
    path = Path(result["path"])
    assert path.exists() and path.suffix == ".svg"
    assert result["bytes"] == path.stat().st_size > 1000
    assert path.read_text(encoding="utf-8", errors="replace").lstrip().startswith("<?xml")
    assert "svg" not in result
    assert "Maße nicht aus dem Bild ablesen" in result["note"]


# ── the two tools the original question needed ──────────────────────────────


def test_overhang_measures_the_number_the_agent_called_unmeasurable(tools: list, house: str) -> None:
    """„Überstand/Raum-% im IFC nicht messbar" — the five words this library
    exists to delete. The roof projects 0.647 m past the wall the window sits
    in, normal to that wall's outer plane, straight out of the roof's own
    triangles."""
    roof = call(tools, "find_elements", {"model": house, "ifcType": "IfcRoof"})["elements"][0]["globalId"]
    wall = call(tools, "relations", {"model": house, "globalId": WINDOW, "relation": "hostedIn"})["value"][0]

    answer = call(tools, "overhang", {"model": house, "projecting": roof, "facade": wall["globalId"]})
    assert answer["decidable"] is True
    assert abs(answer["value"] - 0.647) < 0.01
    assert answer["unit"] == "m"
    assert answer["tolerance"] <= 0.01
    # Measured, never declared. Reporting this as a model statement is the one
    # failure mode the envelope exists to make impossible.
    assert answer["provenance"] == "computed"


def test_light_incidence_reports_geometry_and_refuses_to_render_a_verdict(tools: list, house: str) -> None:
    wall = call(tools, "relations", {"model": house, "globalId": WINDOW, "relation": "hostedIn"})["value"][0]
    answer = call(
        tools,
        "light_incidence",
        {"model": house, "globalId": WINDOW, "angle": 45, "swivel": 30, "exclude": [wall["globalId"]]},
    )

    assert answer["decidable"] is True
    assert answer["free"] is False
    # The obstructions stay under `value`, where every other answer keeps its
    # payload. A second key holding the same list would read as a second fact.
    assert "Roof_Flat" in " ".join(ref["name"] or "" for ref in answer["value"])
    # „Was, und wie tief" — a depth is something a design decision can be made
    # from; a boolean is not.
    assert all(ref["intrusionDepth"] > 0 for ref in answer["value"])
    assert answer["prism"] == {"angleDeg": 45.0, "swivelDeg": 30.0, "openingId": WINDOW}
    # The prism is geometry. Under OIB 3 a cut prism ENLARGES the required
    # light-entry area; it does not ban the window. A tool that answered
    # „nicht erfüllt" would be applying a clause it has never read.
    assert "kein Befund" in answer["caveat"]
    serialised = json.dumps(answer, ensure_ascii=False).lower()
    assert not any(word in serialised for word in ("compliant", "erfüllt", "verstoß"))


def test_light_incidence_refuses_without_the_angle_from_the_clause(tools: list, house: str) -> None:
    """The angle is a fact about the RULE, not about the building.

    Defaulting to 45 would make this tool answer a question of law it was never
    asked, and would silently produce OIB numbers for a project under a
    different code. Refusing costs the caller one sentence and keeps the
    boundary where it belongs.
    """
    with pytest.raises(ToolError) as raised:
        call(tools, "light_incidence", {"model": house, "globalId": WINDOW})
    assert "angle" in str(raised.value)

    for bad in (0, 90, 120, "45"):
        with pytest.raises(ToolError):
            call(tools, "light_incidence", {"model": house, "globalId": WINDOW, "angle": bad})


def test_both_new_tools_demand_a_global_id_rather_than_guessing(tools: list, house: str) -> None:
    for name, args in [
        ("overhang", {"model": house, "facade": WINDOW}),
        ("overhang", {"model": house, "projecting": WINDOW}),
        ("light_incidence", {"model": house, "angle": 45}),
    ]:
        with pytest.raises(ToolError) as raised:
            call(tools, name, args)
        assert "GlobalId" in str(raised.value)


def test_the_same_file_opens_twice_to_one_handle(tools: list, house: str) -> None:
    again = call(tools, "open_model", {"path": str(SAMPLE_HOUSE)})
    assert again["model"] == house
    assert again["contentHash"].startswith(house)


def test_base64_and_path_reach_the_same_model(tools: list, house: str) -> None:
    import base64

    encoded = base64.b64encode(SAMPLE_HOUSE.read_bytes()).decode("ascii")
    opened = call(tools, "open_model", {"base64": encoded})
    assert opened["model"] == house


def test_a_missing_source_says_which_ones_exist(tools: list) -> None:
    with pytest.raises(ToolError) as raised:
        call(tools, "open_model", {})
    assert "path, url oder base64" in str(raised.value)


def test_an_unknown_tool_names_the_ones_that_exist(tools: list) -> None:
    with pytest.raises(ToolError) as raised:
        call(tools, "measure_everything", {})
    assert "open_model" in str(raised.value)


def test_an_unreadable_file_is_refused_with_the_reason_a_person_can_act_on(tools: list, tmp_path: Path) -> None:
    """`SpatialModel` refuses a truncated or non-SPF file with a German reason.

    That sentence IS the answer, and the tool layer has to relay it: an agent
    handed „es hat nicht funktioniert" cannot tell the user to re-upload.
    """
    broken = tmp_path / "abgeschnitten.ifc"
    broken.write_text("ISO-10303-21;\nHEADER;\n", encoding="utf-8")
    with pytest.raises(ToolError) as raised:
        call(tools, "open_model", {"path": str(broken)})
    assert "Modell konnte nicht geöffnet werden" in str(raised.value)


class TestTheEnvelopeReachesTheSurface:
    """OIB 6 through the tool surface, which is where it was missing.

    `thermal_envelope`, `envelope_area_by_orientation` and `compactness` shipped
    implemented and covered by `test_envelope_geometry.py`, and were on NO tool
    surface — not in `MEASURE_FN`, not a tool of their own. An agent asked a
    Kompaktheit or Hüllflächen question therefore reached nothing and reported
    that the export could not answer it, which is a statement about the file and
    was really a statement about our wiring. These tests are about the wiring:
    the operators' own numbers are pinned next door.
    """

    def test_all_three_aspects_answer_through_the_tool(self, tools: list, house: str) -> None:
        for what in ("thermalEnvelope", "areaByOrientation", "compactness"):
            answer = call(tools, "envelope", {"model": house, "what": what})
            assert answer["decidable"] is True, what
            assert answer["provenance"] == "computed", what

    def test_the_envelope_area_is_the_same_number_by_all_three_routes(self, tools: list, house: str) -> None:
        """One building has one envelope area, whichever question asked for it.

        The three operators derive it independently, and a disagreement between
        them would mean the same wall was in the envelope for one question and
        out of it for the next — which no caveat could repair.
        """
        thermal = call(tools, "envelope", {"model": house, "what": "thermalEnvelope"})["value"]
        oriented = call(tools, "envelope", {"model": house, "what": "areaByOrientation"})["value"]
        compact = call(tools, "envelope", {"model": house, "what": "compactness"})["value"]
        assert thermal["totalArea"] == pytest.approx(225.700565, abs=1e-6)
        assert oriented["total"] == pytest.approx(thermal["totalArea"], abs=1e-6)
        assert compact["envelopeArea"] == pytest.approx(thermal["totalArea"], abs=1e-6)

    def test_the_window_wall_ratio_survives_per_facade(self, tools: list, house: str) -> None:
        """The split is the point of `areaByOrientation`, so it is pinned here.

        West is 100 % glazed and that is the curtain wall, not a bug — the
        mullions that would be its opaque share are `IfcMember` and out of
        scope. It is pinned BECAUSE it looks wrong: a later change that
        "corrects" it has to argue with this line first.
        """
        value = call(tools, "envelope", {"model": house, "what": "areaByOrientation"})["value"]
        assert value["orientationKnown"] is True
        ratios = {k: v["windowWallRatio"] for k, v in value["byOrientation"].items()}
        assert ratios["N"] == pytest.approx(0.193455, abs=1e-5)
        assert ratios["O"] == pytest.approx(0.0, abs=1e-9)
        assert ratios["S"] == pytest.approx(0.405, abs=5e-3)
        assert ratios["W"] == pytest.approx(1.0, abs=1e-9)

    def test_the_aspect_is_matched_case_insensitively(self, tools: list, house: str) -> None:
        """The trap `fire` documents: lowercasing "areaByOrientation" into the
        key turns it into "areabyorientation", which matches nothing and refuses
        a call that was correct."""
        assert call(tools, "envelope", {"model": house, "what": "AREABYORIENTATION"})["decidable"] is True

    def test_an_unknown_aspect_names_the_ones_that_exist(self, tools: list, house: str) -> None:
        with pytest.raises(ToolError) as raised:
            call(tools, "envelope", {"model": house, "what": "uWert"})
        assert "thermalEnvelope" in str(raised.value)

    def test_no_aspect_returns_a_verdict_or_a_limit(self, tools: list, house: str) -> None:
        """The invariant of the whole engine, checked where OIB 6 is loudest.

        A U-value limit is the single most quotable number in OIB 6, and an
        operator that supplied one would be applying a clause it never read.
        """
        for what in ("thermalEnvelope", "areaByOrientation", "compactness"):
            text = json.dumps(call(tools, "envelope", {"model": house, "what": what}), ensure_ascii=False)
            for forbidden in ("erfüllt", "zulässig", "Grenzwert überschritten", "Gebäudeklasse"):
                assert forbidden not in text, f"{what} carries „{forbidden}“"

    def test_a_declared_u_value_is_never_invented(self, tools: list, house: str) -> None:
        """A U-value derived from a layer set is a different number from the one
        the architect signed, and looks exactly like it."""
        value = call(tools, "envelope", {"model": house, "what": "thermalEnvelope"})["value"]
        entries = [entry for group in value["byKind"].values() for entry in group]
        assert entries, "the sample house has an envelope"
        for entry in entries:
            assert entry.get("uValue") is None or entry.get("uValueSource") == "declared"


class TestTheClearanceReachesTheSurface:
    """The lichte Breite between TWO elements, which had no tool at all.

    `clearance.clear_width` shipped with fifteen tests in `test_clearance.py`
    and was on no surface. What an agent could reach instead was `distance`,
    whose own description sends the reader to „measure/clearWidth on the
    opening" — an operator that takes ONE element and cannot answer the
    two-element question at all. So the honest route for „how wide is the gap
    between these two walls" was a box gap, in the one direction that matters.
    """

    def test_the_box_gap_and_the_clear_dimension_disagree_by_a_metre(self, tools: list, house: str) -> None:
        """The pitched roof over the interior partition — the case that shows why
        this needed a tool rather than a sentence in `distance`'s description.

        The roof's bounding box swallows the partition's, so `distance('min')`
        reports 0.000 m and a reader concludes the two touch. They are 0.995 m
        apart. A box gap is a LOWER bound on a clearance and never an upper one,
        so it can only ever report elements as closer than they are.
        """
        box = call(tools, "distance", {"model": house, "a": ROOF, "b": PARTITION, "mode": "min"})
        assert box["value"] == pytest.approx(0.0, abs=1e-9)

        answer = call(tools, "clearance", {"model": house, "a": ROOF, "b": PARTITION})
        assert answer["decidable"] is True
        assert answer["provenance"] == "computed"
        assert answer["value"]["distance"] == pytest.approx(0.9947, abs=0.001)
        # And it reports what `distance` would have said, so the size of the
        # difference is visible in the same answer rather than needing a second
        # call to discover.
        assert answer["value"]["boxGap"] == pytest.approx(0.0, abs=1e-9)
        assert "unterschätzt" in answer["caveat"]

    def test_the_two_measured_points_come_back_for_a_dimension_line(self, tools: list, house: str) -> None:
        """Without them the number cannot be checked in the architect's own model:
        „0.995 m somewhere between these two solids" is not reviewable."""
        value = call(tools, "clearance", {"model": house, "a": ROOF, "b": PARTITION})["value"]
        assert len(value["pointOnA"]) == 3 and len(value["pointOnB"]) == 3

    def test_both_elements_are_demanded_rather_than_guessed(self, tools: list, house: str) -> None:
        with pytest.raises(ToolError) as raised:
            call(tools, "clearance", {"model": house, "a": ROOF})
        assert "b fehlt" in str(raised.value) and "find_elements" in str(raised.value)

    def test_one_element_twice_is_refused_with_the_operator_that_does_answer(self, tools: list, house: str) -> None:
        """A clear dimension needs two solids. The refusal names `clearOpeningWidth`,
        because „the clear width of this door" is a real question with a real
        operator — it is just not this one."""
        answer = call(tools, "clearance", {"model": house, "a": ROOF, "b": ROOF})
        assert answer["decidable"] is False
        assert "clearOpeningWidth()" in answer["missing"]["remedy"]

    def test_the_description_does_not_let_it_be_mistaken_for_measure_clear_width(self, tools: list) -> None:
        """Two operators, both called a lichte Breite, one surface. The tool has to
        say which is which where the model reads it, or it will pick by name."""
        clearance = next(tool for tool in tools if tool.name == "clearance")
        assert "measure/clearWidth" in clearance.description
        assert "zwei Laibungen" in clearance.description


class TestTheDoorGraphReachesTheSurface:
    """`egressPath` was on the surface and the graph under it was not.

    A route is only as complete as the graph it was found in, and the two lists
    that say how complete — the doors whose rooms could not be resolved and the
    doors deliberately excluded — live on the graph, not on the route. An agent
    could therefore report a Fluchtweg over three doors from a building whose
    export made five doors unreadable, and nothing in its answer said so.
    """

    def test_the_graph_answers_through_fire_and_names_the_room_with_no_exit(self, tools: list, house: str) -> None:
        """The finding this exposes and `egressPath` cannot: „Roof" has no door.

        A room with no edge is not missing from the graph — it is IN it, with
        nothing attached, which is how „dieser Raum hat keinen Ausgang" becomes
        visible instead of the room quietly not being listed.
        """
        answer = call(tools, "fire", {"model": house, "what": "doorGraph"})
        assert answer["decidable"] is True
        assert answer["provenance"] == "computed"
        graph = answer["value"]
        # Four IfcSpace plus the OUTSIDE node.
        assert len(graph["nodes"]) == 5
        assert len(graph["edges"]) == 3
        with_edges = {node for edge in graph["edges"] for node in edge["verbindet"]}
        stranded = [ref["name"] for ref in graph["nodes"] if ref["globalId"] not in with_edges]
        assert stranded == ["Roof"]
        assert "keine Türkante" in answer["caveat"]

    def test_the_doors_that_became_no_edge_are_reported_and_not_dropped(self, tools: list, house: str) -> None:
        """Both lists must be PRESENT even when empty, because their absence and
        their emptiness are different claims: „no unreadable doors" is a fact
        about this export, and a renderer that omits the key says nothing."""
        graph = call(tools, "fire", {"model": house, "what": "doorGraph"})["value"]
        assert graph["unbestimmt"] == []
        assert graph["ausgeschlossen"] == []

    def test_the_aspect_is_matched_case_insensitively(self, tools: list, house: str) -> None:
        assert call(tools, "fire", {"model": house, "what": "DOORGRAPH"})["decidable"] is True

    def test_it_needs_no_global_id(self, tools: list, house: str) -> None:
        """Like `fluchtniveau`, and unlike the other three aspects: the graph IS
        the building, so there is nothing to point at."""
        assert call(tools, "fire", {"model": house, "what": "doorGraph"})["decidable"] is True


class TestTheSunPositionReachesTheSurface:
    """Named „library only" in the coverage map for a whole release, and it was.

    The operator was validated against the NREL SPA reference and three USNO
    almanac positions, and no tool called it — so a question about where the sun
    stood over the building reached nothing.
    """

    def test_the_almanac_position_arrives_through_the_tool(self, tools: list, house: str) -> None:
        answer = call(tools, "sun_position", {"model": house, "when": "2026-06-21T12:00:00Z"})
        assert answer["decidable"] is True
        assert answer["provenance"] == "computed" and answer["unit"] == "°"
        assert answer["value"]["azimuth"] == pytest.approx(178.867641, abs=0.01)
        assert answer["value"]["altitude"] == pytest.approx(61.934279, abs=0.01)
        assert answer["value"]["compass"] == "S"
        # The direction in MODEL coordinates is the part a shading question needs;
        # a bearing alone cannot be cast into a building rotated off north.
        assert len(answer["value"]["directionInModel"]) == 3

    def test_the_answer_says_it_is_not_a_besonnungsstudie(self, tools: list, house: str) -> None:
        """A sun position says where the sun stood. Whether the neighbour's gable
        was in the way needs everything outside the property line, which is not
        in this file — and the gap between the two is exactly the size of the
        mistake an agent would otherwise make."""
        answer = call(tools, "sun_position", {"model": house, "when": "2026-06-21T12:00:00Z"})
        assert "Besonnungsstudie" in answer["caveat"]

    def test_a_timestamp_without_a_zone_is_refused_rather_than_read_as_utc(self, tools: list, house: str) -> None:
        """Austria runs UTC+1 and UTC+2. Reading 12:00 as UTC puts the sun 30°
        east of where it stood — two hours of shadow, from an input that looked
        complete."""
        answer = call(tools, "sun_position", {"model": house, "when": "2026-06-21T12:00:00"})
        assert answer["decidable"] is False
        assert "Zeitzone" in answer["missing"]["what"]

    def test_a_missing_when_is_a_caller_error_phrased_for_a_timestamp(self, tools: list, house: str) -> None:
        """`_require` would answer „eine GlobalId angeben (aus find_elements)",
        which sends the caller hunting in the model for a clock."""
        with pytest.raises(ToolError) as raised:
            call(tools, "sun_position", {"model": house})
        assert "ISO 8601" in str(raised.value) and "GlobalId" not in str(raised.value)

    def test_an_ungeoreferenced_file_is_undecidable_and_stays_undecidable(self, tools: list) -> None:
        """The narrowing this tool makes on purpose.

        The operator accepts `latitude`/`longitude`; the tool does not forward
        them and its schema does not offer them. An agent that CAN supply a
        latitude will supply one, and an assumed 48.2°N Vienna comes back as a
        `computed` number carrying a tolerance — indistinguishable on the page
        from a measured one. Passing them anyway must change nothing.
        """
        handle = call(tools, "open_model", {"path": str(NO_NORTH)})["model"]
        answer = call(tools, "sun_position", {"model": handle, "when": "2026-06-21T12:00:00+02:00"})
        assert answer["decidable"] is False
        assert answer["missing"]["what"] == "IfcSite.RefLatitude / RefLongitude"

        smuggled = call(
            tools,
            "sun_position",
            {"model": handle, "when": "2026-06-21T12:00:00+02:00", "latitude": 48.2082, "longitude": 16.3738},
        )
        assert smuggled["decidable"] is False, "the tool forwarded coordinates it must not accept"

    def test_the_schema_offers_no_coordinates(self, tools: list) -> None:
        sun = next(tool for tool in tools if tool.name == "sun_position")
        assert set(sun.input_schema["properties"]) == {"model", "when"}


# ── nothing may be library-only ─────────────────────────────────────────────


#: The modules whose public functions are the engine's operators.
OPERATOR_MODULES = (
    "operators",
    "circulation",
    "clearance",
    "daylight",
    "stairs",
    "fire",
    "accessibility",
    "envelope_geometry",
    "render",
    "ids_export",
    "relations",
)

#: Public operators deliberately NOT reachable from a tool, each with its reason.
#:
#: An entry here is a DECISION that somebody wrote down, not a backlog item. The
#: point of the test below is that the third state — implemented, tested, and
#: reachable from nothing because nobody noticed — stops existing. It has been
#: found three times: `overhang` and `light_incidence`, then all three
#: `envelope_geometry` operators, then `clearance.clear_width`,
#: `circulation.door_graph` and `daylight.sun_position` — and every time the
#: user was told the export could not answer a question our own wiring could not
#: ask. Only the last of those six was ever written down as „library only",
#: which is what a hand-maintained list is worth.
NOT_ON_THE_SURFACE = {
    "operators.facade_plane_of": (
        "A construction, not an answer: it returns a normal and a point, and the only thing an agent "
        "can do with three floats is quote them. The two things a caller actually wants from it are "
        "already surfaced — the compass direction as measure/azimuth, and the „Außenseite ungesichert“ "
        "caveat, which `overhang` copies verbatim into its own answer."
    ),
    "operators.ray": (
        "Takes raw model coordinates, and the surface offers no honest way to obtain one: every "
        "GlobalId-shaped answer here reports metres, not a point in the file's coordinate system. An "
        "agent would have to invent an origin, and a hit reported from an invented origin is a fact "
        "about a ray nobody cast. Its three real uses are wired as relations/above, relations/below "
        "and light_incidence, which build the geometry themselves."
    ),
    "ids_export.answers_as_ids": (
        "Needs the ANSWERS of a whole conversation, and this surface keeps none: every handler is one "
        "call in and one result out, by design (see the module docstring on why nothing is retained "
        "beyond the model handle). Wiring it would mean an answer ledger inside the tool layer, which "
        "is a host's job. `shopping_list` covers the model-wide half from the briefing's blind spots."
    ),
    "ids_export.to_xml": (
        "Reached, but through `write_ids`, which `shopping_list` calls — the XML is validated against "
        "the bundled XSD on the way to the file. Exposing the string separately would offer an IDS "
        "that skipped the file the checker actually opens."
    ),
}


def _tool_surface_references() -> set[str]:
    """Every ``<module>.<function>`` `tools.py` names, read from its own AST.

    Text search would not do: `MEASURE_FN` and `RELATION_FN` hold BARE
    references (``"extent": op.extent,``), so a `name(` pattern misses twenty
    operators, and a bare `\\bname\\b` pattern matches German prose. The
    aliases are read from the import statements rather than written out here,
    so renaming `env` back to `envelope_geometry` cannot silently empty this
    set and turn the test green.
    """
    import ast
    import pathlib

    import ifc_spatial.tools as tools_module

    tree = ast.parse(pathlib.Path(tools_module.__file__).read_text(encoding="utf-8"))
    alias_of: dict[str, str] = {}
    for node in ast.walk(tree):
        # `from . import accessibility as acc`, wherever it sits — two of them
        # are inside handlers, because their dependencies are optional.
        if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module is None:
            for alias in node.names:
                alias_of[alias.asname or alias.name] = alias.name
    referenced = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            module = alias_of.get(node.value.id)
            if module is not None:
                referenced.add(f"{module}.{node.attr}")
    return referenced


def test_no_operator_is_implemented_tested_and_reachable_from_nothing() -> None:
    """The defect this suite keeps re-learning, checked once for all modules.

    „Library only" is the worst shape a gap can take, because it does not look
    like a gap: the operator is written, the tests are green, the coverage map
    claims the row, and the only person who finds out is the architect who is
    told their export cannot answer a question the engine answers fine. Three
    rounds of it shipped before anybody walked the list.

    A new operator therefore has exactly two ways past this line: reach it from
    a tool, or write down here why it stays unreachable.

    What this alone does NOT catch is a handler that calls the operator and is
    then bound to no `ToolDef` — the reference is in the file either way. That
    half is covered by the surface list above, which pins the tool NAMES; the
    two together are what make the claim.
    """
    import ast
    import pathlib

    import ifc_spatial

    referenced = _tool_surface_references()
    package = pathlib.Path(ifc_spatial.__file__).parent
    unreachable = []
    for module in OPERATOR_MODULES:
        tree = ast.parse((package / f"{module}.py").read_text(encoding="utf-8"))
        for node in tree.body:
            if not isinstance(node, ast.FunctionDef) or node.name.startswith("_"):
                continue
            qualified = f"{module}.{node.name}"
            if qualified not in referenced and qualified not in NOT_ON_THE_SURFACE:
                unreachable.append(qualified)
    assert not unreachable, (
        f"{unreachable} exist, are tested, and no tool reaches them. Either wire them into "
        "create_tools() — a per-element measurement into MEASURE_FN, a whole-model question into a "
        "grouped tool — or record the decision in NOT_ON_THE_SURFACE with the reason."
    )


def test_the_deliberate_omissions_are_still_real_functions() -> None:
    """The allowlist may not outlive what it excuses.

    A stale entry is how a real gap hides: `clearance.clear_width` renamed,
    listed here from a previous round, and the test above goes green on an
    operator nobody can call.
    """
    import importlib

    for qualified in NOT_ON_THE_SURFACE:
        module, _, name = qualified.rpartition(".")
        assert hasattr(importlib.import_module(f"ifc_spatial.{module}"), name), qualified


# ── survey and profile: the two composition shapes ──────────────────────────
#
# Both exist because of the same arithmetic. The agent gets five tool calls
# before it is forced to synthesise, and the question people actually ask
# („wie hoch ist der Keller") is one question about seventeen rooms. Composed
# from find_elements + one measure per room it does not fit in the budget, and
# the failure mode is not an error — it is a confident answer built from the
# declared storey pitch, because that fits in one call and the measurement did
# not.
#
# So these tests guard the properties that make the composition trustworthy
# rather than merely shorter: that a survey measures the SAME set find_elements
# lists, that it returns the SAME per-element answers `measure` would, and that
# a room it could not measure comes back named instead of quietly missing.


def test_survey_measures_every_room_and_reports_the_spread(tools: list, house: str) -> None:
    """The spread is the finding, not a summary statistic.

    The sample house has three rooms at 2.20 m and a roof space at 0.30 m. A
    reviewer who measured one room and generalised would be wrong about the
    house no matter WHICH room they picked, and that is exactly the mistake a
    per-element tool invites when the question is plural.
    """
    result = call(tools, "survey", {"model": house, "measure": "clearHeight", "ifcType": "IfcSpace"})
    summary = result["summary"]

    assert summary["measured"] == summary["of"] == 4
    assert summary["undecidable"] == []
    # Not a hardcoded spread — the relationship, so the test survives a
    # geometry improvement that shifts the numbers without weakening the claim.
    assert summary["spread"] == pytest.approx(summary["max"] - summary["min"])
    assert summary["spread"] > 1.0, "the roof space differs from the rooms by more than a tolerance"
    assert summary["provenance"] == {"computed": 4}


def test_survey_names_the_elements_so_the_outlier_can_be_reported(tools: list, house: str) -> None:
    """A GlobalId is not an answer.

    Surveying without names would leave the caller holding „one of these four
    22-character strings is 0.30 m" and spending another turn on find_elements
    to say which room. The join is free here and costs a turn there.
    """
    result = call(tools, "survey", {"model": house, "measure": "clearHeight", "ifcType": "IfcSpace"})
    lowest = min(result["results"], key=lambda row: row["answer"]["value"])

    assert lowest["name"], "every surveyed element carries its own name"
    assert lowest["storey"], "and the storey it belongs to"
    assert all(row["globalId"] and row["name"] is not None for row in result["results"])


def test_survey_returns_exactly_what_measure_returns_element_by_element(tools: list, house: str) -> None:
    """Pure composition, or the shortcut is a second implementation.

    If `survey` ever computed its numbers differently from `measure` — a
    different sampling density, a skipped triangulation — then the cheap path
    and the careful path would disagree, and a reviewer checking one room by
    hand would find the survey wrong. This is the test that keeps them one
    code path.
    """
    surveyed = call(tools, "survey", {"model": house, "measure": "floorArea", "ifcType": "IfcSpace"})

    for row in surveyed["results"]:
        alone = call(tools, "measure", {"model": house, "globalId": row["globalId"], "measure": "floorArea"})
        assert row["answer"] == alone, f"{row['name']} measured differently in a survey than alone"


def test_survey_names_the_rooms_it_could_not_measure(tools: list) -> None:
    """An undecidable room is a finding about the EXPORT, and it needs a name.

    This fixture writes spaces whose clear height no operator can establish. The
    dangerous rendering is silence — four rooms measured, seven asked for, and a
    summary that reads like a complete answer. Every one of them comes back
    listed, with the name a CAD operator would search for.
    """
    galerie = call(tools, "open_model", {"path": str(FIXTURES / "dachgeschoss-galerie.ifc")})["model"]
    surveyed = call(tools, "survey", {"model": galerie, "measure": "clearHeight", "ifcType": "IfcSpace"})
    summary = surveyed["summary"]

    assert summary["measured"] == 0 and summary["of"] == 7
    assert len(summary["undecidable"]) == 7
    assert all(entry["name"] for entry in summary["undecidable"])
    # No spread over an empty set: min/max/spread are absent rather than zero,
    # because 0.0 would read as „all the rooms agree".
    assert "spread" not in summary and "min" not in summary


def test_survey_of_nothing_says_so_instead_of_measuring_nothing(tools: list, house: str) -> None:
    """An empty selection is a question that missed, not a building without rooms."""
    result = call(tools, "survey", {"model": house, "measure": "clearHeight", "storey": "Kellergeschoß"})

    assert result["results"] == [] and result["summary"]["of"] == 0
    assert "Briefing" in result["hint"], "and it points at where the real storey names are"


def test_survey_selects_exactly_what_find_elements_lists(tools: list, house: str) -> None:
    """Same selector, same set — or the names beside the numbers describe a
    different question than the numbers do."""
    selector = {"ifcType": "IfcSpace", "storey": "Ground Floor"}
    listed = call(tools, "find_elements", {"model": house, **selector, "limit": 500})
    surveyed = call(tools, "survey", {"model": house, "measure": "floorArea", **selector})

    assert [element["globalId"] for element in listed["elements"]] == [row["globalId"] for row in surveyed["results"]]


def test_survey_says_out_loud_when_it_measured_only_a_slice(tools: list, house: str) -> None:
    """A spread over 2 of 4 rooms reported as „the rooms" is the one error this
    package exists to prevent, so truncation is stated rather than inferred."""
    result = call(tools, "survey", {"model": house, "measure": "floorArea", "ifcType": "IfcSpace", "limit": 2})

    assert result["truncated"] is True
    assert result["summary"]["of"] == 2 and result["summary"]["selected"] == 4
    assert "4" in result["hint"] and "2" in result["hint"]


def test_profile_measures_only_what_the_type_is_about(tools: list, house: str) -> None:
    """A door has no lichte Raumhöhe and a room has no Schwellenhöhe.

    Running all twenty kinds and letting the inapplicable ones refuse would
    „work", and it would spend the caller's context on sixteen refusals that say
    nothing about the building — the noise pushing the real numbers out.
    """
    room = call(tools, "profile", {"model": house, "globalId": BEDROOM})
    door_id = call(tools, "find_elements", {"model": house, "ifcType": "IfcDoor"})["elements"][0]["globalId"]
    door = call(tools, "profile", {"model": house, "globalId": door_id})

    assert "clearHeight" in room["measures"] and "clearHeight" not in door["measures"]
    assert "thresholdHeight" in door["measures"] and "thresholdHeight" not in room["measures"]
    assert room["element"]["name"] and room["storey"]
    # What was skipped is stated — a caller must be able to tell „not measured"
    # from „measured and found nothing".
    assert "clearHeight" in door["notMeasured"]["kinds"] and door["notMeasured"]["why"]


def test_profile_leaves_the_expensive_walks_out_unless_asked(tools: list, house: str) -> None:
    """The cheap profile has to stay cheap or nobody can afford the first one."""
    quick = call(tools, "profile", {"model": house, "globalId": BEDROOM})
    full = call(tools, "profile", {"model": house, "globalId": BEDROOM, "include": "expensive"})

    assert "egressPath" not in quick["measures"]
    assert "egressPath" in full["measures"]
    assert set(quick["measures"]) < set(full["measures"])


def test_profile_of_an_unknown_id_is_an_error_not_an_empty_profile(tools: list, house: str) -> None:
    """The caller could not look — that is their bug, and it is not a fact about
    the building. Same rule the rest of the surface keeps."""
    with pytest.raises(ToolError) as raised:
        call(tools, "profile", {"model": house, "globalId": "0" * 22})
    assert "find_elements" in str(raised.value)


def test_every_measure_subject_names_a_real_measure_and_a_real_type(tools: list) -> None:
    """The applicability table decides what `profile` measures, so a typo in it
    silently drops a measurement rather than failing loudly."""
    from ifc_spatial.tools import MEASURE_EXPENSIVE
    from ifc_spatial.tools import MEASURE_SUBJECT

    assert set(MEASURE_SUBJECT) == set(MEASURES), "every measure declares what it is about"
    assert MEASURE_EXPENSIVE <= set(MEASURES)
    for name, subjects in MEASURE_SUBJECT.items():
        for subject in subjects:
            assert subject.startswith("Ifc"), f"{name} names {subject}, which is not an IFC type"

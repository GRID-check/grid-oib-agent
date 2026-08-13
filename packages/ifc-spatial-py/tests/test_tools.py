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
    """Ten tools ported from `tools.ts`, and five the port added.

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
    """
    assert [tool.name for tool in tools] == [
        "open_model",
        "briefing",
        "find_elements",
        "element",
        "relations",
        "measure",
        "distance",
        "fire",
        "shopping_list",
        "view",
        "draw",
        "overhang",
        "light_incidence",
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

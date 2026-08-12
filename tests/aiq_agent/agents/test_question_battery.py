"""Architect questions, end to end, in the German the model actually reads.

Every other suite tests a layer. This one tests the PRODUCT: it takes questions
of the shape a person types into Piloti, runs the call chain a competent agent
would make, and asserts the rendered German — because that string, not the JSON
under it, is what the model reasons from and what an architect ends up signing.

The seam is `_build_call` → `ifc_spatial` → `_render`. Everything except the BFF
hop, which has its own tests and cannot fail in a way this would catch.

## Why this exists as a suite and not as a script

It was a script first, and it found five defects in one afternoon that eighty
unit tests had not: seventeen-digit tolerances, the flagship operator rendering
a Python dict, „1 Bauteil ragen", a doubled caveat, and `free` present in the
payload and in no sentence. None of those is visible from inside a layer. They
are only visible when you read the answer.

## The two halves, and the second one matters more

`ANSWERABLE` are questions this file can answer. `HONESTLY_UNANSWERABLE` are
questions it cannot — and there the assertion is that the tool says so, names
what is missing, and offers the remedy. A tool that answers eight of ten
questions and bluffs the other two is worse than one that answers eight and
says so, because nobody can tell which two.

The turn this whole package exists because of failed in the second half, not
the first: the agent said „Überstand/Raum-% im IFC nicht messbar" about numbers
that were all in the file.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aiq_agent.agents.bim.measure_register import _build_call
from aiq_agent.agents.bim.measure_register import _render

pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "ifc-spatial" / "test" / "fixtures"
HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
NO_NORTH = FIXTURES / "haus-mit-raeumen.ifc"

#: The window the architect asked about, and what surrounds it.
WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
ROOF = "3cUkl32yn9qRSPvBJVyWh4"
FRONT_DOOR = "3cUkl32yn9qRSPvBJVyWYp"


@pytest.fixture(scope="module")
def tools():
    import ifc_spatial.tools as engine

    return engine.create_tools()


@pytest.fixture(scope="module")
def handles(tools):
    """One parse per file for the module — exactly as a conversation would."""
    import ifc_spatial.tools as engine

    return {path: engine.call(tools, "open_model", {"path": str(path)})["model"] for path in (HOUSE, NO_NORTH)}


@pytest.fixture()
def ask(tools, handles):
    """One `ifc_measure` call, through the same code the agent goes through.

    Returns the rendered German. A rejection (`_build_call` refused before
    anything was resolved) and a `ToolError` (the call could not be made at all)
    are returned as their own text rather than raised, because both are things
    the agent READS — and reads in the same place it reads an answer.
    """
    import ifc_spatial.tools as engine

    def run(path: Path = HOUSE, **kwargs) -> str:
        built = _build_call(
            operation=kwargs.pop("operation"),
            global_id=kwargs.pop("global_id", ""),
            other_global_id=kwargs.pop("other_global_id", ""),
            relation=kwargs.pop("relation", ""),
            measure=kwargs.pop("measure", ""),
            mode=kwargs.pop("mode", ""),
            ifc_type=kwargs.pop("ifc_type", ""),
            name_contains=kwargs.pop("name_contains", ""),
            storey=kwargs.pop("storey", ""),
            kind=kwargs.pop("kind", ""),
            room_kind=kwargs.pop("room_kind", ""),
            limit=kwargs.pop("limit", 50),
            angle_deg=kwargs.pop("angle_deg", None),
            swivel_deg=kwargs.pop("swivel_deg", None),
        )
        assert not kwargs, f"unused arguments: {kwargs}"
        if isinstance(built, str):
            return built
        name, args = built
        args["model"] = handles[path]
        try:
            payload = engine.call(tools, name, args)
        except engine.ToolError as exc:
            return f"Error: {exc}"
        return _render(name, payload, source={}, handle="")

    return run


# ── the question that started this, one call at a time ──────────────────────


class TestTheOriginalQuestion:
    """„Passt dieses Fenster mit dem Dach für den Lichteinfall?"

    The agent retrieved OIB 3 §9, explained the 45° prism and the 30° lateral
    swivel correctly, and then answered „Überstand/Raum-% im IFC nicht
    messbar". Every number it named was in the file. Each step below is one of
    the numbers it said it could not have.
    """

    def test_step_1_the_window_is_found_by_type_not_invented(self, ask):
        rendered = ask(operation="find_elements", ifc_type="IfcWindow")
        assert "4 Treffer" in rendered
        assert WINDOW in rendered

    def test_step_2_the_wall_it_sits_in_says_it_was_derived(self, ask):
        rendered = ask(operation="relations", global_id=WINDOW, relation="hostedIn")
        assert "Wall-Ext_102Bwk" in rendered
        assert "über voids+fills" in rendered
        # Two hops through declared relations — a reading of the file, but not
        # something the file says. The distinction has to survive to the text.
        assert "gemessen" in rendered

    def test_step_3_the_room_it_lights_admits_the_export_declares_nothing(self, ask):
        rendered = ask(operation="relations", global_id=WINDOW, relation="opensTo")
        assert "Bedroom" in rendered
        # This export writes no IfcRelSpaceBoundary at all. Presenting a contact
        # test as a declared fact is the failure this package exists to prevent.
        assert "Geometrie abgeleitet" in rendered
        assert "IfcRelSpaceBoundary" in rendered

    def test_step_4_the_floor_area_the_file_never_declares(self, ask):
        rendered = ask(operation="measure", global_id=BEDROOM, measure="floorArea")
        assert "15.42 m²" in rendered
        assert "gemessen" in rendered
        # And to the band, not to seventeen digits.
        assert "15.41678" not in rendered

    def test_step_5_the_sill_and_head_the_file_never_declares(self, ask):
        rendered = ask(operation="measure", global_id=WINDOW, measure="sillAndHead")
        assert "sill=0.900" in rendered and "head=2.110" in rendered
        # The type is named `…1810x1210mm`. A measured 1.210 m agreeing with a
        # string in the file to under a millimetre is an independent check that
        # the frame conversion is right.
        assert "height=1.210" in rendered
        # A floor build-up above the storey datum eats into the Brüstungshöhe,
        # and an Absturzsicherung is decided at exactly 1.00 m.
        assert "Fußbodenaufbau" in rendered

    def test_step_6_the_facade_bearing_instead_of_an_invented_one(self, ask):
        rendered = ask(operation="measure", global_id=NORTH_WALL, measure="azimuth")
        # The original answer called this the Südfassade. It faces north, and
        # the file declares a TrueNorth, so this is checkable rather than
        # narrated.
        assert "compass=N" in rendered

    def test_step_7_the_overhang_the_agent_called_unmeasurable(self, ask):
        rendered = ask(operation="overhang", global_id=ROOF, other_global_id=NORTH_WALL)
        assert "0.6466 m" in rendered
        assert "gemessen (±0.005 m)" in rendered

    def test_step_8_the_prism_is_reported_and_never_judged(self, ask):
        rendered = ask(operation="light_incidence", global_id=WINDOW, angle_deg=45, swivel_deg=30)

        # The answer to the question that was asked, in one sentence.
        assert "NICHT FREI (Prisma 45°, seitlich 30°)" in rendered
        assert "1 Bauteil ragt" in rendered
        assert "Roof_Flat" in rendered
        # Never a Python literal.
        assert "{'globalId'" not in rendered

        # A cut prism ENLARGES the required Lichteintrittsfläche under OIB 3; it
        # does not ban the window. An operator that said „nicht erfüllt" would
        # be applying a clause it has never read.
        assert "kein Befund" in rendered
        for word in ("compliant", "erfüllt", "verstoß", "unzulässig"):
            assert word not in rendered.lower(), word
        # And the caveat is said ONCE. Repeated, it reads as boilerplate — which
        # is the opposite of what a caveat is for.
        assert rendered.lower().count("kein befund") == 1


# ── questions this file CAN answer ──────────────────────────────────────────


class TestAnswerable:
    """Ten more of the shape a person types, each asserted on its German."""

    def test_the_briefing_names_this_file_s_own_storeys(self, ask):
        rendered = ask(operation="briefing")
        assert "Ground Floor" in rendered and "Roof" in rendered
        # A storey pitch is not a room height, and the briefing has to say so
        # where the number appears — a Raumhöhennachweis run on 2.50 m passes a
        # room that fails at 2.20 m.
        assert "nicht die lichte Raumhöhe" in rendered
        # And what this export cannot answer, before anything is filtered.
        assert "BLIND" in rendered and "FEHLT" in rendered

    def test_the_clear_height_is_measured_to_the_ceiling_not_the_space_solid(self, ask):
        """The number a Mindestraumhöhe is checked against.

        The space solids all run 0.000–2.500. The Compound Ceiling hangs at
        2.200, and 30 cm is the difference between a pass and a fail on exactly
        this figure — in the direction that turns a fail into a pass.
        """
        rendered = ask(operation="measure", global_id=BEDROOM, measure="clearHeight")
        assert "2.200 m" in rendered
        assert "Möblierung" in rendered

    def test_which_rooms_border_this_one(self, ask):
        rendered = ask(operation="relations", global_id=BEDROOM, relation="adjacentSpaces")
        assert "Living room" in rendered
        # Adjacency here means a shared bounding element, NOT a walkable
        # connection, and the two are different questions.
        assert "NICHT begehbare Verbindung" in rendered

    def test_which_elements_bound_this_room(self, ask):
        rendered = ask(operation="relations", global_id=BEDROOM, relation="bounds")
        assert "IfcWall" in rendered and "IfcSlab" in rendered
        assert "Berührungstoleranz" in rendered

    def test_the_storey_pitches_with_the_warning_attached(self, ask):
        rendered = ask(operation="storey_heights")
        assert "Ground Floor" in rendered and "2.5" in rendered
        # The top storey has no next elevation. Its height stays open rather
        # than estimated.
        assert "nicht bestimmbar" in rendered
        assert "NICHT die lichte Raumhöhe" in rendered

    def test_the_room_use_is_proposed_and_never_asserted(self, ask):
        rendered = ask(operation="room_inventory", room_kind="aufenthaltsraum")
        assert "vermutlich" in rendered
        assert "Living room" in rendered and "Bedroom" in rendered
        # Aufenthaltsraum is a legal classification, not a geometric property.
        assert "RECHTLICHE Einstufung" in rendered
        assert "Konfidenz" in rendered

    def test_a_door_width_for_a_lichte_durchgangsbreite(self, ask):
        rendered = ask(operation="measure", global_id=FRONT_DOOR, measure="extent")
        assert "width=1.860" in rendered
        # Nested one level, the flat join produced "box=min=[…], max=[…]" —
        # one key appearing to carry two values.
        assert "box=(min=" in rendered

    def test_a_vertical_distance_between_two_elements(self, ask):
        rendered = ask(operation="distance", global_id=WINDOW, other_global_id=BEDROOM, mode="vertical")
        assert "0.179 m" in rendered
        # Centroids are area-weighted over the mesh, not volume centroids, and
        # the answer says so — the number moves by centimetres on an unevenly
        # tessellated element.
        assert "Schwerpunkt" in rendered

    def test_one_element_reports_what_can_be_asked_about_it_next(self, ask):
        rendered = ask(operation="element", global_id=WINDOW)
        assert "IfcWindow" in rendered
        assert "Vorhandene Relationen" in rendered
        # The four geometric relations are listed as askable rather than
        # available, because probing them to build a menu costs seconds.
        assert "opensTo" in rendered

    def test_the_light_entry_ratio_the_agent_also_called_unmeasurable(self, ask):
        """The OTHER half of „Überstand/Raum-% im IFC nicht messbar".

        `overhang` closed the Überstand. This is the Raum-% — the ratio an OIB 3
        daylight check comes down to, and the number that went missing for a
        year because nobody noticed the failing answer named two things.
        """
        rendered = ask(operation="measure", global_id=BEDROOM, measure="lightEntryArea")
        # 1.810 x 1.210 m of clear opening on 15.42 m² of floor. The measured
        # aperture agreeing with the type name `1810x1210mm` to the millimetre
        # is an independent check on the projection.
        assert "Lichteintrittsfläche 2.190 m²" in rendered
        assert "15.42 m² Bodenfläche" in rendered
        assert "14.21 %" in rendered
        # No threshold applied — the percentage is in the clause, not the model.
        assert "Kein Grenzwert angewandt" in rendered
        assert "ROHBAULICHTE" in rendered

    def test_an_internal_door_is_never_counted_as_daylight(self, ask):
        """The defect the first version shipped with.

        Summing every opening bounding the room put the bedroom at 25.3 %,
        because the door to the hallway is 1.71 m². An interior door is not a
        Lichteintrittsfläche under any reading of OIB 3, and 25 % against 14 %
        is two opposite answers to the same check.

        It is EXCLUDED but not hidden: a ratio whose omissions are invisible
        cannot be checked by the person who signs it.
        """
        rendered = ask(operation="measure", global_id=BEDROOM, measure="lightEntryArea")
        assert "NICHT gezählt (innenliegend)" in rendered
        assert "Doors_IntSgl" in rendered
        # The reason travels with the exclusion, so it can be disagreed with.
        assert "IsExternal" in rendered
        assert "25.2" not in rendered and "25.3" not in rendered

    def test_an_external_door_does_count(self, ask):
        """The entrance hall is lit by its front door and nothing else.

        The mirror of the test above: „exclude doors" would have been the easy
        fix and it is wrong — 1.810 x 2.110 m of external double door is
        daylight, and dropping it would have taken the hall to 0 %.
        """
        rendered = ask(operation="measure", global_id="3w0zWKm7n8SB1qbfwUzt0G", measure="lightEntryArea")
        assert "Doors_ExtDbl_Flush" in rendered
        assert "3.819 m²" in rendered
        assert "43.93 %" in rendered

    def test_a_free_prism_renders_as_free(self, ask):
        """The opposite branch of the flagship operator.

        With the roof excluded nothing intrudes, and the value is an EMPTY list
        — which rendered as a provenance header and silence until `free` got its
        own sentence. Asserting „FREI" alone would be worthless, since the
        blocked branch renders „NICHT FREI"; the point is that the two sentences
        are distinguishable, so both are checked against each other.
        """
        free = ask(
            operation="light_incidence",
            global_id=WINDOW,
            other_global_id=ROOF,
            angle_deg=45,
            swivel_deg=30,
        )
        blocked = ask(operation="light_incidence", global_id=WINDOW, angle_deg=45, swivel_deg=30)

        assert "NICHT FREI" in blocked
        assert "NICHT FREI" not in free
        assert "kein Bauteil ragt in das Prisma" in free
        assert "Prisma 45°, seitlich 30°" in free
        # Even with a clear prism the answer stays geometry, not a pass.
        assert "kein Befund" in free
        assert "erfüllt" not in free.lower()


# ── questions this file CANNOT answer, and says so ──────────────────────────


class TestHonestlyUnanswerable:
    """The half that matters more.

    A tool that answers eight of ten questions and bluffs the other two is worse
    than one that answers eight and says which two — because nobody downstream
    can tell them apart.
    """

    def test_a_facade_bearing_without_a_true_north_refuses_and_says_what_to_add(self, ask):
        rendered = ask(NO_NORTH, operation="measure", global_id="2Haus0Raeume00Wall0001", measure="azimuth")
        assert "NICHT ENTSCHEIDBAR" in rendered
        assert "TrueNorth" in rendered
        # A finding about the EXPORT, with the change an architect makes in CAD.
        assert "Befund über den EXPORT" in rendered
        assert "Abhilfe" in rendered
        # And no compass direction anywhere — the failure being prevented is a
        # plausible „Südfassade" invented to fill the gap.
        for compass in (" N.", " S.", "Süden", "Norden"):
            assert compass not in rendered

    def test_a_type_this_export_has_none_of_does_not_read_as_a_fact(self, ask):
        rendered = ask(operation="find_elements", ifc_type="IfcRamp")
        assert "0 Treffer" in rendered
        # „keine Treffer" is about the search. „das Gebäude hat keine Rampe" is
        # about the building, and only one of them was established.
        assert "gibt es nicht" in rendered and "Briefing" in rendered

    def test_an_invented_global_id_is_an_error_and_not_an_answer(self, ask):
        """A hallucinated id supports no claim about the export whatsoever.

        Handed back as `decidable: false` it would be reported as „das Modell
        sagt dazu nichts" — a fact about the building, manufactured from a typo.
        """
        rendered = ask(operation="element", global_id="0abcdefghijklmnopqrstu")
        assert rendered.startswith("Error:")
        assert "nicht enthalten" in rendered
        assert "find_elements" in rendered
        assert "NICHT ENTSCHEIDBAR" not in rendered

    def test_light_incidence_refuses_to_supply_the_angle_from_the_clause(self, ask):
        """45° is a fact about OIB 3, not about the building.

        A tool that defaults to it is answering a question of law it was never
        asked — and would silently produce OIB numbers for a project under a
        different code.
        """
        rendered = ask(operation="light_incidence", global_id=WINDOW)
        assert rendered.startswith("Error:")
        assert "angle_deg" in rendered
        assert "comes from the Bestimmung, not from the model" in rendered

    def test_an_overhang_needs_both_elements_and_says_where_to_get_the_second(self, ask):
        rendered = ask(operation="overhang", global_id=NORTH_WALL)
        assert rendered.startswith("Error:")
        assert "TWO elements" in rendered
        # Correctable in the same turn, because it names the call that yields
        # the missing argument.
        assert "relations/hostedIn" in rendered

    def test_a_measure_that_does_not_exist_is_refused_with_the_list(self, ask):
        rendered = ask(operation="measure", global_id=WINDOW, measure="brandwiderstand")
        assert rendered.startswith("Error:")
        assert "does not exist" in rendered
        assert "clearHeight" in rendered

    def test_a_file_without_rooms_says_so_about_the_export(self, ask):
        """`einheiten-fuss.ifc` has one wall and nothing else.

        Every room question against it has to come back as a fact about what was
        exported, never as a fact about the building.
        """
        import ifc_spatial.tools as engine

        tools = engine.create_tools()
        handle = engine.call(tools, "open_model", {"path": str(FIXTURES / "einheiten-fuss.ifc")})
        rendered = _render("briefing", {"briefing": handle["briefing"]}, source={}, handle="")
        assert "keine IfcSpace" in rendered
        assert "Räume wurden nicht exportiert" in rendered
        assert "sagt das nichts" in rendered
        # And the blind spots name their remedies.
        assert "TrueNorth" in rendered and "Abhilfe" in rendered


# ── the standing guarantee across every answer above ────────────────────────


class TestNoAnswerEverBecomesAVerdict:
    """Geometry is not law, in every rendering this tool has.

    The tools measure. Whether a measurement satisfies a requirement is decided
    by the Bestimmung, which comes from the knowledge base. The single most
    damaging thing this package could do is let a number arrive already judged —
    it would be a compliance finding with no clause behind it, in a document an
    architect signs.
    """

    VERDICT_WORDS = ("compliant", "konform", "erfüllt", "verstoß", "unzulässig", "genehmigungsfähig")

    @pytest.mark.parametrize(
        "call",
        [
            {"operation": "measure", "global_id": BEDROOM, "measure": "clearHeight"},
            {"operation": "measure", "global_id": WINDOW, "measure": "sillAndHead"},
            {"operation": "measure", "global_id": BEDROOM, "measure": "floorArea"},
            {"operation": "overhang", "global_id": ROOF, "other_global_id": NORTH_WALL},
            {"operation": "light_incidence", "global_id": WINDOW, "angle_deg": 45, "swivel_deg": 30},
            {"operation": "room_inventory", "room_kind": "aufenthaltsraum"},
            {"operation": "storey_heights"},
        ],
    )
    def test_no_rendered_answer_contains_a_compliance_word(self, ask, call):
        rendered = ask(**call).lower()
        for word in self.VERDICT_WORDS:
            assert word not in rendered, f"{call} rendered a verdict: {word}"

    @pytest.mark.parametrize(
        "call",
        [
            {"operation": "measure", "global_id": BEDROOM, "measure": "clearHeight"},
            {"operation": "measure", "global_id": WINDOW, "measure": "sillAndHead"},
            {"operation": "measure", "global_id": BEDROOM, "measure": "floorArea"},
            {"operation": "overhang", "global_id": ROOF, "other_global_id": NORTH_WALL},
            {"operation": "distance", "global_id": WINDOW, "other_global_id": BEDROOM, "mode": "min"},
        ],
    )
    def test_every_measured_number_carries_its_verb_and_its_band(self, ask, call):
        """„gemessen (±tol)" and never „das Modell sagt".

        Reporting a measurement as a model statement is the heaviest error this
        tool makes possible, and it is invisible downstream — the sentence reads
        exactly as well either way.
        """
        rendered = ask(**call)
        assert "gemessen" in rendered
        assert "±" in rendered
        assert "nicht deklariert" in rendered
        assert "deklariert:" not in rendered

    @pytest.mark.parametrize(
        "call",
        [
            {"operation": "measure", "global_id": BEDROOM, "measure": "floorArea"},
            {"operation": "measure", "global_id": BEDROOM, "measure": "clearHeight"},
            {"operation": "overhang", "global_id": ROOF, "other_global_id": NORTH_WALL},
            {"operation": "distance", "global_id": WINDOW, "other_global_id": BEDROOM, "mode": "vertical"},
        ],
    )
    def test_no_number_is_shown_to_more_digits_than_its_band_allows(self, ask, call):
        """The regression for the defect the battery was written to find.

        A value printed to seventeen digits beside a centimetre tolerance is a
        float artifact, and the skill instructs the model to quote tool numbers
        verbatim — so it would have reached an architect intact.
        """
        import re

        rendered = ask(**call)
        for number in re.findall(r"\d+\.\d+", rendered):
            _, _, fraction = number.partition(".")
            assert len(fraction) <= 6, f"{number} in {call}"


class TestTheAgentCanLookAtThePlan:
    """`view` — the operation that hands the model a picture, not a path.

    `draw` writes an SVG and returns a file path and a byte count. For a human
    that is right; for the agent it is nothing at all, because it has no eyes on
    the filesystem and could not read path data if it did. So the agent has been
    generating drawings it cannot see.

    `view` rasterises the same geometry and returns an image content block, plus
    a caption carrying what pixels cannot state exactly — and the prohibition
    that matters: a dimension read off a raster is guessed even when it happens
    to be right.
    """

    def _blocks(self, tools, handles, **kwargs):
        import ifc_spatial.tools as engine

        from aiq_agent.agents.bim.measure_register import _build_call
        from aiq_agent.agents.bim.measure_register import _image_blocks

        built = _build_call(
            operation="view",
            global_id=kwargs.pop("global_id", ""),
            other_global_id="",
            relation="",
            measure="",
            mode=kwargs.pop("mode", ""),
            ifc_type="",
            name_contains="",
            storey=kwargs.pop("storey", ""),
            kind="",
            room_kind="",
            limit=50,
            angle_deg=None,
            swivel_deg=None,
        )
        if isinstance(built, str):
            return built
        name, args = built
        args["model"] = handles[HOUSE]
        return _image_blocks(engine.call(tools, name, args), source={}, handle="")

    def test_it_returns_an_image_the_model_can_see(self, tools, handles):
        blocks = self._blocks(tools, handles)
        assert [block["type"] for block in blocks] == ["text", "image_url"]
        url = blocks[1]["image_url"]["url"]
        assert url.startswith("data:image/png;base64,")
        # A real raster, not a placeholder: a silently failed render produces a
        # tiny blob that a data URL carries just as willingly.
        assert len(url) > 8_000

    def test_the_caption_names_the_rooms_and_the_cut(self, tools, handles):
        caption = self._blocks(tools, handles)[0]["text"]
        assert "Ground Floor" in caption
        assert "1.20 m" in caption
        assert "Living room" in caption and "Bedroom" in caption
        # The rule that keeps a picture from becoming a source of numbers.
        assert "Maße NIE daraus ablesen" in caption

    def test_highlighting_is_reported_in_words_as_well_as_pixels(self, tools, handles):
        caption = self._blocks(tools, handles, global_id=f"{WINDOW}, {NORTH_WALL}")[0]["text"]
        # Both ids, because the question "is this window really in that wall" is
        # about a PAIR, and a single-value field would force two renders.
        assert WINDOW in caption and NORTH_WALL in caption
        assert "Rot markiert" in caption

    def test_only_and_highlight_are_different_requests(self, tools, handles):
        marked = self._blocks(tools, handles, global_id=WINDOW, mode="highlight")
        isolated = self._blocks(tools, handles, global_id=WINDOW, mode="only")
        assert marked[1]["image_url"]["url"] != isolated[1]["image_url"]["url"]
        # Isolating removes the rooms, so the caption stops naming them.
        assert "Living room" in marked[0]["text"]
        assert "Räume im Bild" not in isolated[0]["text"]

    def test_isolating_nothing_is_refused_rather_than_drawn_empty(self, tools, handles):
        answer = self._blocks(tools, handles, mode="only")
        assert isinstance(answer, str)
        assert answer.startswith("Error:")
        assert "needs at least one global_id" in answer

    def test_an_unknown_mode_names_the_two_that_exist(self, tools, handles):
        answer = self._blocks(tools, handles, global_id=WINDOW, mode="zoom")
        assert isinstance(answer, str)
        assert "'highlight'" in answer and "'only'" in answer

    def test_a_storey_that_is_not_in_this_file_is_an_error_not_a_blank_page(self, tools, handles):
        import ifc_spatial.tools as engine

        with pytest.raises(engine.ToolError) as raised:
            self._blocks(tools, handles, storey="Dachgeschoss")
        # A blank page and a broken renderer are indistinguishable to a reader.
        assert "Briefing" in str(raised.value)

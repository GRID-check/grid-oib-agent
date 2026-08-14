"""The ``ifc_measure`` tool's argument handling, its errors and its rendering.

The tool is the seam where a language model's free-form intent becomes a
geometric operation on a real building. Three things can go wrong there and
none of them is visible from the engine's own tests:

  - an enum value the engine would refuse arrives as an exception several
    seconds and one download later, by which time the agent has been told only
    that something failed;
  - "the service is unreachable" and "your arguments are wrong" collapse into
    one message, and a typo ends the turn with the agent instructed to say
    nothing about the building;
  - a ``decidable: false`` answer — the file cannot say — is rendered as a
    FAILURE, which turns a finding about the export into a fact about the
    building.

All three are exercised here without a frontend and without IfcOpenShell.
"""

from __future__ import annotations

import io
import json
import pathlib
import urllib.error

import pytest

from aiq_agent.agents.bim.measure_register import ENGINE_UNAVAILABLE_TEXT
from aiq_agent.agents.bim.measure_register import UNAVAILABLE_TEXT
from aiq_agent.agents.bim.measure_register import _build_call
from aiq_agent.agents.bim.measure_register import _provenance_line
from aiq_agent.agents.bim.measure_register import _rejected_text
from aiq_agent.agents.bim.measure_register import _render
from aiq_agent.agents.bim.measure_register import _render_answer
from aiq_agent.agents.bim.measure_register import _render_unresolved
from aiq_agent.agents.bim.measure_register import _unrunnable_text


def build(**overrides):
    defaults = dict(operation="briefing")
    defaults.update(overrides)
    return _build_call(**defaults)


class TestBuildCall:
    """Every enum, checked BEFORE the model is resolved or parsed."""

    def test_the_default_operation_is_the_briefing(self):
        assert build(operation="briefing") == ("briefing", {"format": "text"})

    def test_unknown_operation_is_refused_by_name(self):
        result = build(operation="measure_room")
        assert isinstance(result, str)
        assert "unknown operation" in result
        # The valid set is spelled out so the model can correct itself in one turn.
        assert "storey_heights" in result

    @pytest.mark.parametrize("operation", ["element", "relations", "measure", "distance"])
    def test_an_operation_about_one_element_needs_its_global_id(self, operation):
        answer = build(operation=operation)
        assert isinstance(answer, str)
        assert "needs a global_id" in answer
        # And it says where a real one comes from, because the failure mode
        # this prevents is the model inventing a plausible-looking id.
        assert "find_elements" in answer

    def test_an_unknown_relation_is_refused_with_the_list(self):
        answer = build(operation="relations", global_id="1kTv", relation="borders")
        assert isinstance(answer, str)
        assert "relation 'borders' does not exist" in answer
        assert "adjacentSpaces" in answer

    def test_a_real_relation_passes_through_verbatim(self):
        assert build(operation="relations", global_id="1kTv", relation="opensTo") == (
            "relations",
            {"globalId": "1kTv", "relation": "opensTo"},
        )

    def test_an_unknown_measure_is_refused_with_the_list(self):
        answer = build(operation="measure", global_id="1kTv", measure="area")
        assert isinstance(answer, str)
        assert "measure 'area' does not exist" in answer
        assert "floorArea" in answer

    def test_every_measure_the_engine_has_is_accepted(self):
        """Iterated from `MEASURES`, not from a list written out here.

        This was a hardcoded tuple of six names. Its own title claimed it
        covered every measure, and when a seventh (`lightEntryArea`) was added
        it kept passing while testing nothing about it — the exact failure the
        test exists to catch, hidden inside the test.
        """
        from aiq_agent.agents.bim.measure_register import MEASURES

        assert len(MEASURES) >= 7
        for name in MEASURES:
            assert build(operation="measure", global_id="g1", measure=name) == (
                "measure",
                {"globalId": "g1", "measure": name},
            ), name

    def test_no_distance_mode_is_advertised_as_a_clear_dimension(self):
        """The entry for 'horizontal' read „what a lichte Breite check needs".

        `operators.distance` measures CENTROID to CENTROID in plan — an
        Achsabstand. On a 1.00 m opening between two 30 cm walls that is 1.30 m:
        too large by half of each element, in the direction that turns a failed
        escape-route width into a passing one. The tool description was
        instructing the model to certify a clearance with the wrong number.
        """
        from aiq_agent.agents.bim.measure_register import DISTANCE_MODES

        for name, text in DISTANCE_MODES.items():
            assert "what a lichte Breite check needs" not in text, name
        assert "NOT a lichte Breite" in DISTANCE_MODES["horizontal"]
        assert "NOT a lichte Höhe" in DISTANCE_MODES["vertical"]
        # And each one points at the operator that DOES answer it. This said
        # `extent` until `clearWidth` existed — pointing at the least wrong
        # operator available, which measured a door's THICKNESS as its width.
        assert "clearWidth" in DISTANCE_MODES["horizontal"]
        assert "clearHeight" in DISTANCE_MODES["vertical"]
        # `min` is a box gap, and 0 does not mean the solids touch.
        assert "BOUNDING BOXES" in DISTANCE_MODES["min"]

    def test_the_mode_error_does_not_repeat_the_wrong_advice(self):
        answer = build(operation="distance", global_id="a", other_global_id="b", mode="diagonal")
        assert isinstance(answer, str)
        assert "A lichte Breite needs 'horizontal'" not in answer
        assert "none is a clear dimension" in answer

    def test_light_incidence_can_exclude_more_than_one_element(self):
        """The recessed-window workflow needs two exclusions, not one.

        A window deep in a thick wall is shaded by its own reveal AND by the
        roof. With a single-value field, an agent told to "re-run without the
        host wall" had to drop the roof exclusion to do it — silently answering
        a different question than the one it was asked.
        """
        name, args = build(
            operation="light_incidence",
            global_id="w1",
            other_global_id="wall1, roof1",
            angle_deg=45,
            swivel_deg=30,
        )
        assert name == "light_incidence"
        assert args["exclude"] == ["wall1", "roof1"]

    def test_one_exclusion_still_works_and_blank_entries_are_dropped(self):
        _, single = build(operation="light_incidence", global_id="w1", other_global_id="wall1", angle_deg=45)
        assert single["exclude"] == ["wall1"]

        _, messy = build(operation="light_incidence", global_id="w1", other_global_id=" wall1 , , roof1,", angle_deg=45)
        assert messy["exclude"] == ["wall1", "roof1"]

        _, none_given = build(operation="light_incidence", global_id="w1", angle_deg=45)
        assert "exclude" not in none_given

    def test_distance_needs_two_elements(self):
        answer = build(operation="distance", global_id="a")
        assert isinstance(answer, str)
        assert "other_global_id" in answer

    def test_distance_defaults_to_the_shortest_gap(self):
        assert build(operation="distance", global_id="a", other_global_id="b") == (
            "distance",
            {"a": "a", "b": "b", "mode": "min"},
        )

    def test_an_unknown_distance_mode_is_refused_and_says_which_to_use(self):
        # A lichte Breite measured on the slant is a wrong number that reads
        # perfectly, so the correction names the two directional modes.
        answer = build(operation="distance", global_id="a", other_global_id="b", mode="diagonal")
        assert isinstance(answer, str)
        assert "mode 'diagonal' does not exist" in answer
        assert "horizontal" in answer and "vertical" in answer

    def test_an_unknown_kind_is_refused_and_distinguished_from_an_ifc_type(self):
        # `kind` is the spatial ROLE. A model that puts "IfcSpace" here gets
        # zero matches, which reads as "the building has no rooms".
        answer = build(operation="find_elements", kind="IfcSpace")
        assert isinstance(answer, str)
        assert "kind 'IfcSpace' does not exist" in answer
        assert "'ifc_type'" in answer

    def test_find_elements_passes_the_filters_the_engine_knows(self):
        assert build(
            operation="find_elements",
            ifc_type="IfcWindow",
            name_contains="Nord",
            storey="Ground Floor",
            kind="element",
            limit=10,
        ) == (
            "find_elements",
            {
                "limit": 10,
                "ifcType": "IfcWindow",
                "nameContains": "Nord",
                "storey": "Ground Floor",
                "kind": "element",
            },
        )

    # `limit` is passed THROUGH, not pre-defaulted by the caller. Writing
    # `limit or 50` here meant `_build_call` never saw a 0 and the row asserted
    # the test's own arithmetic; the floor was never reached at all. The
    # ceiling is the engine's page size, and the floor is what keeps a model
    # that computed a limit from a subtraction from asking for 0 or -3 rows and
    # reading the empty answer as "the building has none".
    @pytest.mark.parametrize("limit,expected", [(0, 50), (-3, 1), (1, 1), (5, 5), (10_000, 500)])
    def test_the_element_limit_is_clamped(self, limit, expected):
        name, args = build(operation="find_elements", limit=limit)
        assert name == "find_elements"
        assert args["limit"] == expected

    def test_an_unknown_room_kind_is_refused(self):
        answer = build(operation="room_inventory", room_kind="wohnraum")
        assert isinstance(answer, str)
        assert "room_kind 'wohnraum' does not exist" in answer
        assert "aufenthaltsraum" in answer

    def test_the_room_kinds_the_lexicon_knows_pass_through_lowercased(self):
        for value in ("aufenthaltsraum", "nebenraum", "erschliessung"):
            assert build(operation="room_inventory", room_kind=value.upper()) == (
                "room_inventory",
                {"kind": value},
            ), value

    def test_storey_heights_takes_nothing(self):
        assert build(operation="storey_heights") == ("storey_heights", {})

    def test_clearance_needs_two_elements_and_names_the_one_element_operator(self):
        """The mistake worth catching in the same turn: `clearance` and
        `measure/clearWidth` are both called a lichte Breite and take a
        different number of elements. A model that reaches for the wrong one by
        name has to be told which is which, not merely refused."""
        answer = build(operation="clearance", global_id="a")
        assert isinstance(answer, str)
        assert "TWO elements" in answer
        assert "clearWidth" in answer

    def test_clearance_passes_both_elements_through(self):
        assert build(operation="clearance", global_id="a", other_global_id="b") == (
            "clearance",
            {"a": "a", "b": "b"},
        )

    def test_sun_position_refuses_without_an_instant_and_says_it_needs_a_zone(self):
        """A timestamp without a zone read as UTC moves the sun 30° in Austria.
        The refusal spells out the two accepted spellings so the model can fix
        it in the same turn rather than discovering it as an undecidable."""
        answer = build(operation="sun_position")
        assert isinstance(answer, str)
        assert "ISO 8601" in answer and "time zone" in answer
        assert "+02:00" in answer

    def test_sun_position_forwards_the_instant_and_nothing_else(self):
        """No latitude, no longitude, no global_id — even when the model sets
        them. The operator accepts a coordinate override; offering it here would
        let an agent supply the very number the operator refuses to assume, and
        it would come back stamped `computed` with a tolerance."""
        assert build(operation="sun_position", when=" 2026-06-21T12:00:00+02:00 ", global_id="w1") == (
            "sun_position",
            {"when": "2026-06-21T12:00:00+02:00"},
        )

    def test_draw_narrows_by_storey_and_type(self):
        assert build(operation="draw", storey="Ground Floor", ifc_type="IfcWall") == (
            "draw",
            {"storey": "Ground Floor", "include": ["IfcWall"]},
        )


class TestTheEnumsMatchTheEngine:
    """The tool's vocabulary is a COPY of the package's, and copies drift.

    `measure_register` spells the enums out rather than importing them, so that
    NAT's plugin discovery does not pull IfcOpenShell, numpy and shapely into
    every process at startup. The price of that is this test: an operator
    renamed in the package has to fail HERE, in a sentence naming both sides,
    rather than at a user whose perfectly good call is refused by name.
    """

    @staticmethod
    def _engine():
        return pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")

    def test_the_relations_are_the_engine_s_relations(self):
        from aiq_agent.agents.bim.measure_register import RELATIONS

        assert set(RELATIONS) == set(self._engine().RELATIONS)

    def test_the_geometric_relations_are_the_engine_s(self):
        # The ones the description warns cost ~7 s on a cold model. A relation
        # that quietly joined that set would be called speculatively.
        from aiq_agent.agents.bim.measure_register import GEOMETRIC_RELATIONS

        assert set(GEOMETRIC_RELATIONS) == set(self._engine().GEOMETRIC_RELATIONS)

    def test_the_measures_are_the_engine_s_measures(self):
        from aiq_agent.agents.bim.measure_register import MEASURES

        assert set(MEASURES) == set(self._engine().MEASURES)

    def test_the_kinds_are_the_engine_s_kinds(self):
        from aiq_agent.agents.bim.measure_register import KINDS

        assert set(KINDS) == set(self._engine().KINDS)

    def test_the_fire_aspects_are_the_engine_s(self):
        from aiq_agent.agents.bim.measure_register import FIRE_ASPECTS

        assert set(FIRE_ASPECTS) == set(self._engine().FIRE_ASPECTS)

    def test_the_envelope_aspects_are_the_engine_s(self):
        from aiq_agent.agents.bim.measure_register import ENVELOPE_ASPECTS

        assert set(ENVELOPE_ASPECTS) == set(self._engine().ENVELOPE_ASPECTS)

    def test_the_batch_ceiling_is_the_engine_s(self):
        # The input model refuses a `measure` over more ids than this BEFORE the
        # file is fetched. A ceiling higher than the engine's would let the
        # expensive refusal through again; a lower one would refuse a call the
        # engine would have answered.
        from aiq_agent.agents.bim.measure_register import MAX_BATCH

        assert MAX_BATCH == self._engine().MAX_BATCH

    def test_every_operation_this_tool_offers_exists_on_the_engine(self):
        """The gap this class exists for, checked one level up.

        The enum tests above compare the ASPECT vocabularies. Nothing compared
        the operation names themselves, so an operation could be offered in the
        description, accepted by `_build_call`, and then refused by the engine
        as an unknown tool — a failure the model cannot correct, because from
        where it stands the call was exactly what it was told to make.
        """
        from aiq_agent.agents.bim.measure_register import VALID_OPERATIONS

        engine_tools = {tool.name for tool in self._engine().create_tools()}
        # `open_model` is the host's job, not an operation the model picks.
        assert VALID_OPERATIONS <= engine_tools, VALID_OPERATIONS - engine_tools

    def test_no_engine_tool_is_unreachable_from_the_agent(self):
        """The SAME check in the other direction, which is the one that fails.

        The assertion above catches an operation advertised and not implemented.
        It cannot catch the opposite, and the opposite is what keeps happening:
        `overhang`, `light_incidence`, `envelope`, `clearance` and `sun_position`
        each shipped implemented, tested, and callable by nobody, so every
        question they answered came back „das kann dieser Export nicht" — a
        sentence about the file that was really about our wiring. `survey`
        repeated it within one release.

        A capability nobody can call is indistinguishable from a missing one,
        and the second is what the user was told. The engine-side test that
        caught this for OPERATORS has no counterpart for TOOLS; this is it.
        """
        from aiq_agent.agents.bim.measure_register import VALID_OPERATIONS

        engine_tools = {tool.name for tool in self._engine().create_tools()}
        unreachable = engine_tools - VALID_OPERATIONS - {"open_model"}
        assert not unreachable, (
            f"{sorted(unreachable)} exist on the engine and no operation reaches them. Either add "
            "them to VALID_OPERATIONS and describe them in _TOOL_DESCRIPTION, or take them off "
            "create_tools() — shipping them halfway is the failure this test exists for."
        )

    def test_every_operation_is_actually_described_to_the_model(self):
        """Reachable is not the same as findable.

        An operation in VALID_OPERATIONS that `_TOOL_DESCRIPTION` never mentions
        is reachable only by a model that guesses the name. The description IS
        the discovery mechanism — it is the only place the model learns an
        operation exists — so an undocumented one is shipped off.
        """
        from aiq_agent.agents.bim.measure_register import _TOOL_DESCRIPTION
        from aiq_agent.agents.bim.measure_register import VALID_OPERATIONS

        undocumented = {name for name in VALID_OPERATIONS if name not in _TOOL_DESCRIPTION}
        assert not undocumented, (
            f"{sorted(undocumented)} can be called and are never mentioned to the model. "
            "The model cannot pick an operation it has not been told about."
        )


class TestProvenanceIsThreeDifferentSentences:
    """The reason this tool exists.

    A declared value is the architect's own statement; a computed one is ours,
    with a tolerance; an inferred one is a proposal. Rendering all three the
    same way is how a guess acquires the authority of a measurement.
    """

    def test_a_declared_value_is_reported_as_the_file_s_own_statement(self):
        line = _provenance_line({"value": 15.41678125, "unit": "m²", "provenance": "declared", "decidable": True})
        assert line.startswith("deklariert:")
        assert "so steht es in der Datei" in line

    def test_a_computed_value_carries_its_tolerance_and_says_it_was_measured(self):
        line = _provenance_line(
            {
                "value": 2.2,
                "unit": "m",
                "tolerance": 0.005,
                "provenance": "computed",
                "decidable": True,
            }
        )
        assert line.startswith("gemessen")
        assert "±0.005" in line
        assert "nicht deklariert" in line
        # And it must NOT read as something the model states.
        assert "deklariert:" not in line

    def test_an_inferred_value_is_a_proposal_with_its_confidence(self):
        line = _provenance_line(
            {
                "value": None,
                "unit": None,
                "provenance": "inferred",
                "confidence": 0.72,
                "decidable": True,
            }
        )
        assert line.startswith("vermutlich:")
        assert "0.72" in line
        assert "keine Feststellung" in line

    def test_a_number_with_no_tolerance_is_passed_through_untouched(self):
        # Nothing says how precise this is, so nothing may be dropped from it.
        line = _provenance_line(
            {"value": 15.41678125, "unit": "m²", "tolerance": None, "provenance": "computed", "decidable": True}
        )
        assert "15.41678125" in line

    def test_a_number_is_shown_to_its_tolerance_and_no_further(self):
        """The false-precision rule, and why it is not "reshaping the value".

        Before this, `floorArea` rendered as

            gemessen (±0.15416781250000042 m²): 15.41678125000004 m²

        Seventeen digits against a 15-centimetre band is a binary-float artifact
        wearing the costume of a measurement — LESS faithful than 15.42, because
        it asserts precision the operator disclaims in the same sentence. And the
        skill tells the model that numbers come from the tool and are never to be
        re-rounded, so it would have quoted every digit to an architect.
        """
        line = _provenance_line(
            {
                "value": 15.41678125000004,
                "unit": "m²",
                "tolerance": 0.15416781250000042,
                "provenance": "computed",
                "decidable": True,
            }
        )
        assert "gemessen (±0.15 m²): 15.4 m²" in line
        assert "15.41678125" not in line
        assert "0.15416781" not in line
        # And not 15.42 either: a 15-centimetre band does not support a
        # centimetre digit. `ceil` used to round the tolerance up to the next
        # decade before counting, which authorised one digit too many on every
        # band that was not an exact power of ten.
        assert "15.42" not in line

    @pytest.mark.parametrize(
        ("value", "tolerance", "shown"),
        [
            # One digit finer than the band, so nothing resolved is discarded.
            (0.17913908774709064, 0.01, "0.179"),
            (0.6466378093377606, 0.005, "0.647"),
            (2.1099999999999999, 0.01, "2.110"),
            # A whole-number band leaves no decimal at all: ±3° cannot carry a
            # tenth of a degree, and printing one claimed it could.
            (0.0, 3, "0"),
        ],
    )
    def test_the_precision_follows_the_band(self, value, tolerance, shown):
        line = _provenance_line(
            {"value": value, "unit": "m", "tolerance": tolerance, "provenance": "computed", "decidable": True}
        )
        assert f": {shown} m" in line

    def test_a_declared_figure_is_never_re_rounded(self):
        """The case the old „never round" rule was really protecting.

        A declared value is the architect's own statement. Even where a tolerance
        rides along, the renderer has no standing to restate it.
        """
        line = _provenance_line(
            {
                "value": 0.235926059936681,
                "unit": "W/m²K",
                "tolerance": 0.01,
                "provenance": "declared",
                "decidable": True,
            }
        )
        assert "0.235926059936681" in line


class TestUndecidableIsAFindingAboutTheExport:
    """`decidable: false` is a successful answer, and must never read as an error.

    The question was well formed and THIS FILE cannot answer it. That is a fact
    about the export the architect can act on — `missing.remedy` is literally
    what they change in their CAD — while an error is a fact about us.
    """

    UNDECIDABLE = {
        "value": None,
        "unit": None,
        "tolerance": None,
        "provenance": "declared",
        "from": ["1kTvXnbbzCWw8lcMd1dR4o"],
        "method": "sillAndHead(1kTv…)",
        "decidable": False,
        "missing": {
            "what": "Pset_WindowCommon.SillHeight",
            "remedy": "Brüstungshöhe im CAD am Fenstertyp hinterlegen und neu exportieren.",
        },
    }

    def test_it_renders_as_a_finding_and_not_as_an_error(self):
        rendered = _render("measure", dict(self.UNDECIDABLE))

        assert "NICHT ENTSCHEIDBAR" in rendered
        # The word the agent must not reach for. An "Error:" prefix is how this
        # tool reports that nothing was looked at, and this is the opposite —
        # the file was read and it does not say.
        assert not rendered.startswith("Error")
        assert "Error:" not in rendered

    def test_it_names_what_is_missing_and_what_fixes_it(self):
        rendered = _render("measure", dict(self.UNDECIDABLE))

        assert "Pset_WindowCommon.SillHeight" in rendered
        # The remedy is the actionable half and must survive verbatim.
        assert "Brüstungshöhe im CAD am Fenstertyp hinterlegen" in rendered

    def test_it_says_the_finding_is_about_the_export_not_the_building(self):
        # The sentence that stops "the model does not publish a sill height"
        # becoming "the window has no sill".
        assert "Befund über den EXPORT, nicht über das Gebäude" in _render("measure", dict(self.UNDECIDABLE))

    def test_the_method_is_still_reported_so_the_refusal_can_be_checked(self):
        assert "sillAndHead" in _render("measure", dict(self.UNDECIDABLE))


class TestRendering:
    def test_the_model_line_names_the_file_and_the_parsed_handle(self):
        rendered = _render(
            "measure",
            {"value": 2.5, "unit": "m", "provenance": "computed", "tolerance": 0.005, "decidable": True},
            source={"model": {"filename": "Haus-A_V3.ifc", "schemaVersion": "IFC4", "elements": 74}},
            # A content hash, not a credential — detect-secrets sees 16 hex chars.
            handle="3f2a1b0c9d8e7f6a",  # pragma: allowlist secret
        )
        assert "Modell: Haus-A_V3.ifc (IFC4, 74 Bauteile)" in rendered
        assert "Kennung 3f2a1b0c9d8e" in rendered

    def test_a_relation_lists_the_elements_it_found_with_their_ids(self):
        rendered = _render(
            "relations",
            {
                "value": [
                    {
                        "globalId": "3cUkl32yn9qRSPvBJVyWcE",
                        "ifcType": "IfcSpace",
                        "name": "Living room",
                        "kind": "space",
                        "via": "Kontaktkarte",
                    }
                ],
                "unit": None,
                "provenance": "computed",
                "from": ["1kTv"],
                "method": "opensTo(1kTv)",
                "decidable": True,
            },
        )
        assert "IfcSpace „Living room“ · GlobalId 3cUkl32yn9qRSPvBJVyWcE (über Kontaktkarte)" in rendered

    def test_a_caveat_is_never_dropped(self):
        # The storey-pitch caveat is the difference between a Rohbauhöhe and a
        # Raumhöhennachweis. An answer that loses it publishes a different
        # claim than the operator made.
        rendered = _render(
            "storey_heights",
            {
                "value": [{"storey": "Ground Floor", "elevation": 0.0, "height": 2.85}],
                "unit": "m",
                "provenance": "computed",
                "decidable": True,
                "caveat": "Rohbau-Geschoßhöhe … NICHT die lichte Raumhöhe.",
            },
        )
        assert "Hinweis: Rohbau-Geschoßhöhe" in rendered
        assert "Ground Floor" in rendered and "2.85" in rendered

    def test_a_contradiction_between_two_routes_is_surfaced_as_one(self):
        # Agreement is a fact; DISAGREEMENT is a finding about the export, and
        # one an architect wants before submission.
        rendered = _render(
            "measure",
            {
                "value": 15.41,
                "unit": "m²",
                "provenance": "computed",
                "decidable": True,
                "agreement": "disagree",
                "caveat": "Zwei Wege zu dieser Zahl widersprechen sich: 15.41 gegen 12.00 …",
            },
        )
        assert "WIDERSPRUCH" in rendered
        assert "widersprechen sich" in rendered

    def test_the_briefing_is_handed_over_whole_with_its_instruction(self):
        rendered = _render("briefing", {"briefing": "GEBÄUDE  Haus-A.ifc · IFC4\nBLIND  keine …"})
        assert "GEBÄUDE  Haus-A.ifc" in rendered
        # The briefing is only useful if the agent copies names OUT of it.
        assert "wörtlich übernehmen" in rendered
        assert "BLIND" in rendered

    def test_find_elements_reports_the_total_separately_from_the_page(self):
        # A page presented as a total is the failure this whole surface is
        # built to avoid.
        rendered = _render(
            "find_elements",
            {
                "elements": [{"globalId": "g1", "ifcType": "IfcWindow", "name": "W-01"}],
                "total": 14,
                "truncated": True,
            },
        )
        assert "14 Treffer, 1 aufgelistet." in rendered
        assert "Weitere Treffer vorhanden" in rendered

    def test_a_drawing_forbids_reading_numbers_off_it(self):
        rendered = _render("draw", {"path": "/tmp/plan.svg", "bytes": 120_000, "seconds": 5.1})
        assert "/tmp/plan.svg" in rendered
        assert "NICHT aus dem Bild ablesen" in rendered

    def test_a_unit_goes_after_a_number_and_beside_a_set_of_them(self):
        # "sill=0.9, head=2.11 m" reads as though only the last figure carried
        # the unit, and "2 Einträge m" is not German at all.
        named = _provenance_line(
            {
                "value": {"sill": 0.9, "head": 2.11},
                "unit": "m",
                "tolerance": 0.01,
                "provenance": "computed",
                "decidable": True,
            }
        )
        assert "sill=0.900, head=2.110 (m)" in named
        # The tolerance is a scalar in that unit whatever shape the value has.
        assert "±0.01 m" in named

    def test_a_list_of_one_is_reported_in_the_singular(self):
        line = _provenance_line(
            {
                "value": [{"globalId": "g1", "ifcType": "IfcWall", "name": "W"}],
                "unit": None,
                "provenance": "computed",
                "decidable": True,
            }
        )
        assert "1 Eintrag" in line and "1 Einträge" not in line

    # ── light_incidence, the flagship operator's own rendering ──────────────

    BLOCKED = {
        "value": [
            {
                "globalId": "3cUkl32yn9qRSPvBJVyWh4",
                "name": "Basic Roof:Roof_Flat",
                "intrusionDepth": 1.056308,
            }
        ],
        "unit": "m",
        "tolerance": 0.005,
        "provenance": "computed",
        "decidable": True,
        "free": False,
        "prism": {"angleDeg": 45.0, "swivelDeg": 30.0, "openingId": "3cUkl32yn9qRSPvBJVyWcE"},
        "caveat": "Das ist Geometrie, kein Befund.",
    }

    def test_an_obstruction_is_a_sentence_and_not_a_python_dict(self):
        """The defect the query battery caught.

        `_render_answer` matched entries by `ifcType`, and an obstruction has
        `intrusionDepth` instead — so the flagship operator's own result fell
        through to `- {'globalId': …, 'intrusionDepth': 1.056308}`. Handing a
        model a Python literal after telling it to quote our numbers verbatim
        is how a repr ends up in front of an architect.
        """
        rendered = "\n".join(_render_answer(dict(self.BLOCKED)))
        assert "{" not in rendered and "'globalId'" not in rendered
        assert "Basic Roof:Roof_Flat · GlobalId 3cUkl32yn9qRSPvBJVyWh4 · ragt 1.056 m in das Prisma" in rendered

    def test_the_verdict_line_says_which_way_it_went(self):
        """`free` was in the payload and in no sentence.

        A caller reading only the rendered text could not tell a clear prism
        from a blocked one — the answer to the question that was asked.
        """
        blocked = "\n".join(_render_answer(dict(self.BLOCKED)))
        assert "NICHT FREI (Prisma 45°, seitlich 30°)" in blocked
        assert "1 Bauteil ragt in das Prisma, tiefster Eingriff 1.056 m" in blocked

    def test_an_empty_list_is_the_answer_and_must_not_render_as_nothing(self):
        # `free: true` carries no entries at all, so without its own line the
        # renderer produced a provenance header and silence.
        free = {**self.BLOCKED, "value": [], "free": True}
        rendered = "\n".join(_render_answer(free))
        assert "FREI (Prisma 45°, seitlich 30°): kein Bauteil ragt in das Prisma." in rendered
        assert "NICHT FREI" not in rendered

    def test_the_german_agrees_in_number(self):
        """„1 Bauteil ragen" tells an Austrian architect a machine wrote this,
        and everything after it is read as machine output rather than a finding."""
        one = "\n".join(_render_answer(dict(self.BLOCKED)))
        assert "1 Bauteil ragt" in one

        two = {
            **self.BLOCKED,
            "value": [
                self.BLOCKED["value"][0],
                {"globalId": "g2", "name": "Vordach", "intrusionDepth": 0.4},
            ],
        }
        assert "2 Bauteile ragen" in "\n".join(_render_answer(two))

    def test_the_angles_are_echoed_as_written_not_as_floats(self):
        # 45.0° suggests a measurement to a tenth of a degree. It is the number
        # the clause states, round-tripped through a float.
        rendered = "\n".join(_render_answer(dict(self.BLOCKED)))
        assert "45°" in rendered and "45.0°" not in rendered

    def test_the_verdict_never_becomes_a_compliance_finding(self):
        # A cut prism ENLARGES the required Lichteintrittsfläche under OIB 3.
        rendered = "\n".join(_render_answer(dict(self.BLOCKED))).lower()
        for word in ("compliant", "erfüllt", "verstoß", "unzulässig"):
            assert word not in rendered

    def test_an_unresolved_model_reports_the_reason_and_the_choices(self):
        rendered = _render_unresolved(
            {
                "resolved": False,
                "reason": "ambiguous",
                "message": "Mehrere Modelle.",
                "models": [{"filename": "haus-a.ifc", "status": "ready", "elements": 120}],
            }
        )
        assert "Mehrere Modelle." in rendered
        assert "haus-a.ifc (ready, 120 Bauteile)" in rendered

    def test_a_model_that_is_still_extracting_is_not_offered_as_available(self):
        rendered = _render_unresolved(
            {
                "resolved": False,
                "reason": "not_ready",
                "message": "Wird verarbeitet.",
                "models": [{"filename": "haus-a.ifc", "status": "extracting", "elements": 0}],
            }
        )
        assert "noch nicht abfragbar" in rendered
        assert "Verfügbare Modelle" not in rendered


class TestAConversationWithoutAProjectIsRefusedBeforeTheNetwork:
    """The dead path, decided deliberately.

    `/api/internal/bim/query` and `/api/internal/bim/source` both require
    `projectId` OR `modelId`. Neither tool has ever sent a `modelId` — both
    address a model by project and file name — so a conversation outside a
    project produced a request that could only 400.

    A 400 is a REJECTION here, and a rejection means „there was a problem with
    the arguments, call the tool again". So the agent retried a call no argument
    could fix, for as many turns as its budget allowed, and the user got silence
    instead of the one sentence that would have helped them: open the
    conversation inside the project.

    The alternative was to start sending `modelId`, which the tools have no way
    to obtain without a project first. So the path is not dead code to revive —
    it is a request that should never be made, refused where the reason is known.
    """

    def test_both_halves_of_the_bim_surface_say_the_same_thing(self):
        from aiq_agent.agents.bim.measure_register import NO_PROJECT_TEXT as measure_text
        from aiq_agent.agents.bim.register import NO_PROJECT_TEXT as query_text

        # Literally the same string: an agent that learns it from one tool has
        # to read it correctly from the other.
        assert measure_text is query_text

    def test_it_forbids_the_retry_that_used_to_burn_the_turn(self):
        from aiq_agent.agents.bim.register import NO_PROJECT_TEXT

        assert "Do not retry" in NO_PROJECT_TEXT
        assert "no argument to this tool can fix it" in NO_PROJECT_TEXT

    def test_it_tells_the_user_what_to_actually_do(self):
        from aiq_agent.agents.bim.register import NO_PROJECT_TEXT

        assert "not attached to a project" in NO_PROJECT_TEXT
        assert "inside the project" in NO_PROJECT_TEXT
        # And forbids the failure mode that made this worth finding: filling the
        # silence with something plausible about the building.
        assert "Do not state anything about the building" in NO_PROJECT_TEXT

    def test_it_is_not_the_same_message_as_a_real_rejection(self):
        from aiq_agent.agents.bim.register import NO_PROJECT_TEXT

        assert NO_PROJECT_TEXT != _rejected_text("Unrecognized key(s): 'storeys'")
        assert NO_PROJECT_TEXT != UNAVAILABLE_TEXT


class TestAModelTooBigToMeasureIsNotAnOutage:
    """The third failure that was collapsing into „Dienst nicht erreichbar".

    An outage means wait. A 300 MB export on a 4 GB worker never resolves on its
    own, so the same sentence sent an architect off to wait for a service that
    was never down — while `ifc_query` would have answered half their questions
    the whole time.
    """

    def test_the_ceiling_comes_from_the_memory_this_container_actually_has(self, monkeypatch):
        """`os.sysconf` reports the HOST's RAM inside a cgroup-limited pod.

        Sizing a 2 GB pod's ceiling for a 128 GB node is how a guard that exists
        to prevent an OOM causes one, silently, taking the conversation with it.
        """
        from aiq_agent.knowledge import ifc_spatial_client as client

        monkeypatch.delenv("BIM_SPATIAL_MAX_MODEL_BYTES", raising=False)
        monkeypatch.setattr(client, "_container_memory_bytes", lambda: 4 * 1024**3)
        # Half the container, divided by the measured 20x parse footprint.
        assert client._derive_max_model_bytes() == (2 * 1024**3) // 20

        monkeypatch.setattr(client, "_container_memory_bytes", lambda: 512 * 1024**2)
        # Never below the floor: under it the tool is not worth having.
        assert client._derive_max_model_bytes() == client._MIN_MODEL_BYTES

        monkeypatch.setattr(client, "_container_memory_bytes", lambda: 1024 * 1024**3)
        assert client._derive_max_model_bytes() == client._MAX_MODEL_BYTES_CAP

    def test_the_ratio_is_the_low_end_of_what_was_measured(self):
        """Deliberately a NECESSARY and not a sufficient condition.

        The footprint runs 20x–143x and tracks geometric complexity rather than
        file size, so no static gate can be safe for both ends. At 143x the
        guard would refuse a 30 MB model on a 4 GB pod — most real projects —
        and would have removed the capability instead of protecting it.
        """
        from aiq_agent.knowledge.ifc_spatial_client import PARSE_FOOTPRINT_RATIO

        assert PARSE_FOOTPRINT_RATIO == 20

    def test_an_operator_who_sized_the_worker_can_override_the_arithmetic(self, monkeypatch):
        from aiq_agent.knowledge import ifc_spatial_client as client

        monkeypatch.setenv("BIM_SPATIAL_MAX_MODEL_BYTES", str(900 * 1024**2))
        assert client._derive_max_model_bytes() == 900 * 1024**2

    @pytest.mark.parametrize("value", ["", "   ", "viel", "-1", "0"])
    def test_an_unusable_override_falls_back_instead_of_crashing_the_tool(self, monkeypatch, value):
        from aiq_agent.knowledge import ifc_spatial_client as client

        monkeypatch.setenv("BIM_SPATIAL_MAX_MODEL_BYTES", value)
        monkeypatch.setattr(client, "_container_memory_bytes", lambda: 4 * 1024**3)
        assert client._derive_max_model_bytes() == (2 * 1024**3) // 20

    def test_a_cgroup_limit_wins_over_the_host(self, monkeypatch, tmp_path):
        from aiq_agent.knowledge import ifc_spatial_client as client

        limit = tmp_path / "memory.max"
        limit.write_text("2147483648\n", encoding="ascii")
        real_open = open

        def fake_open(path, *args, **kwargs):
            if path == "/sys/fs/cgroup/memory.max":
                return real_open(limit, *args, **kwargs)
            raise OSError("no such cgroup file")

        monkeypatch.setattr("builtins.open", fake_open)
        assert client._container_memory_bytes() == 2 * 1024**3

    @pytest.mark.parametrize("raw", ["max", "9223372036854771712", "nonsense"])
    def test_an_unlimited_or_unparsable_cgroup_falls_through(self, monkeypatch, tmp_path, raw):
        """cgroup v1 writes a sentinel near 2^63 to mean "no limit"; taking it
        literally would derive a ceiling of several exabytes."""
        from aiq_agent.knowledge import ifc_spatial_client as client

        limit = tmp_path / "memory.max"
        limit.write_text(raw, encoding="ascii")
        real_open = open
        monkeypatch.setattr(
            "builtins.open",
            lambda path, *a, **k: real_open(limit, *a, **k) if "cgroup" in str(path) else real_open(path, *a, **k),
        )
        value = client._container_memory_bytes()
        assert value is None or value < (1 << 62)

    def test_the_message_is_about_the_file_and_names_both_numbers(self):
        from aiq_agent.agents.bim.measure_register import _too_large_text

        text = _too_large_text(310 * 1024 * 1024, 100 * 1024 * 1024)
        assert "310 MB" in text and "100 MB" in text
        # Not an outage, and it says so — waiting is the wrong action.
        assert "kein Ausfall" in text and "Warten hilft nicht" in text
        assert text != UNAVAILABLE_TEXT
        # And the half that still works is offered by name.
        assert "ifc_query" in text
        assert "Keine Maße schätzen" in text

    def test_it_is_still_an_unavailable_error_so_old_handlers_hold(self):
        from aiq_agent.knowledge.bim_query import BimQueryUnavailableError
        from aiq_agent.knowledge.ifc_spatial_client import ModelTooLargeError

        error = ModelTooLargeError(310 * 1024 * 1024, 100 * 1024 * 1024)
        assert isinstance(error, BimQueryUnavailableError)
        assert error.model_bytes == 310 * 1024 * 1024
        assert "310 MB" in str(error)

    def test_an_oversized_model_is_refused_before_a_byte_is_transferred(self, monkeypatch):
        """On the HEAD's byte count. Downloading 300 MB to then refuse it wastes
        the transfer and holds the turn open for the whole of it."""
        from aiq_agent.knowledge import ifc_spatial_client as client
        from aiq_agent.knowledge.ifc_spatial_client import ModelTooLargeError

        monkeypatch.setattr(
            client.urllib.request,
            "urlopen",
            lambda *a, **k: pytest.fail("the oversized model was downloaded"),
        )
        with pytest.raises(ModelTooLargeError):
            client._download("https://example.test/big.ifc", client.MAX_MODEL_BYTES + 1)


class TestUnavailableIsNotRejected:
    """Could-not-look versus looked-and-your-arguments-were-wrong.

    An unavailable service is nothing the agent can do anything about; a
    rejected request is a mistake it can correct in the same turn. Collapsing
    the two ends a turn on a typo, with the agent instructed to say nothing
    about the building.
    """

    def test_the_two_messages_are_different_and_say_different_things(self):
        rejected = _rejected_text("Unrecognized key(s): 'storeys'")

        assert rejected != UNAVAILABLE_TEXT
        assert "problem with the arguments" in rejected
        assert "call the tool again" in rejected
        assert "nicht erreichbar" in UNAVAILABLE_TEXT
        assert "could not be read" in UNAVAILABLE_TEXT

    def test_neither_invites_a_statement_about_the_building(self):
        for text in (_rejected_text("nope"), UNAVAILABLE_TEXT, ENGINE_UNAVAILABLE_TEXT):
            assert "Do NOT" in text

    def test_a_missing_engine_is_not_reported_as_a_broken_model(self):
        # Nothing is wrong with the building or the request: this deployment
        # has no geometry engine. It also names what still works.
        assert "not installed" in ENGINE_UNAVAILABLE_TEXT
        assert "ifc_query" in ENGINE_UNAVAILABLE_TEXT

    def test_an_id_that_is_not_in_the_model_is_a_correctable_mistake(self):
        # And NOT a `decidable: false` — the call could not be made at all.
        text = _unrunnable_text("Bauteil 0xyz ist in diesem Modell nicht enthalten")
        assert "not with the building" in text
        assert "find_elements" in text


class TestTheSourceClientDrawsTheSameDistinction:
    """The client that fetches the bytes, and the two errors it can raise."""

    @pytest.fixture(autouse=True)
    def _token(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")

    @staticmethod
    def _http_error(status: int, body) -> urllib.error.HTTPError:
        payload = json.dumps(body).encode("utf-8")
        return urllib.error.HTTPError(
            "http://frontend:3000/api/internal/bim/source",
            status,
            "Bad Request",
            {},  # type: ignore[arg-type]
            io.BytesIO(payload),
        )

    def _raise(self, monkeypatch, error: Exception) -> None:
        def opener(_request, timeout=None):  # noqa: ANN001, ARG001
            raise error

        monkeypatch.setattr(
            "aiq_agent.knowledge.ifc_spatial_client._opener",
            type("O", (), {"open": staticmethod(opener)})(),
        )

    def test_a_correctable_400_is_a_rejection(self, monkeypatch):
        from aiq_agent.knowledge.bim_query import BimQueryRejectedError
        from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source

        self._raise(monkeypatch, self._http_error(400, {"error": "modelName must not be empty"}))
        with pytest.raises(BimQueryRejectedError) as caught:
            resolve_model_source(organization_id="org", project_id="p", model_name=" ")
        assert "modelName" in str(caught.value)

    @pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
    def test_everything_else_is_unavailable(self, monkeypatch, status):
        # A revoked `ifc-models` flag arrives as a 403 and is NOT something the
        # agent can fix by rewriting its arguments.
        from aiq_agent.knowledge.bim_query import BimQueryUnavailableError
        from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source

        self._raise(monkeypatch, self._http_error(status, {"error": "nope"}))
        with pytest.raises(BimQueryUnavailableError):
            resolve_model_source(organization_id="org", project_id="p")

    def test_a_missing_service_token_never_reaches_the_network(self, monkeypatch):
        from aiq_agent.knowledge.bim_query import BimQueryUnavailableError
        from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source

        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        with pytest.raises(BimQueryUnavailableError):
            resolve_model_source(organization_id="org", project_id="p")

    def test_a_model_is_addressed_by_project_and_file_name_never_by_uuid(self, monkeypatch):
        # ADR-0045: a UUID carried through a conversation is a reliable source
        # of hallucinated identifiers, so the tool names the model the way a
        # person does and the BFF resolves it.
        from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source

        sent: dict = {}

        class _Response:
            def read(self):
                return b'{"resolved": false, "reason": "no_models", "message": "kein Modell"}'

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        def opener(request, timeout=None):  # noqa: ANN001, ARG001
            sent["url"] = request.full_url
            sent["body"] = json.loads(request.data)
            sent["headers"] = request.headers
            return _Response()

        monkeypatch.setattr(
            "aiq_agent.knowledge.ifc_spatial_client._opener",
            type("O", (), {"open": staticmethod(opener)})(),
        )

        result = resolve_model_source(organization_id="org-1", project_id="p-1", model_name="V3")

        assert sent["url"].endswith("/api/internal/bim/source")
        assert sent["body"] == {"organizationId": "org-1", "projectId": "p-1", "modelName": "V3"}
        assert "modelId" not in sent["body"]
        # The service token is the whole authentication of this call.
        assert sent["headers"]["X-grid-internal-token"] == "test-token"
        # A `resolved: false` body is an ANSWER, returned rather than raised.
        assert result["reason"] == "no_models"


class TestTheSourceIdentityDecidesWhatIsReused:
    """What "the same building as last time" means, and what it must not mean."""

    def test_the_object_s_etag_is_preferred(self):
        from aiq_agent.knowledge.ifc_spatial_client import source_identity

        identity = source_identity(
            {"model": {"modelId": "m1", "updatedAt": "2026-05-04T09:30:15.400Z"}, "source": {"etag": "abc123"}}
        )
        assert identity == "etag:abc123"

    def test_it_falls_back_to_the_model_id_and_its_revision(self):
        from aiq_agent.knowledge.ifc_spatial_client import source_identity

        identity = source_identity(
            {"model": {"modelId": "m1", "updatedAt": "2026-05-04T09:30:15.400Z"}, "source": {"etag": None}}
        )
        assert identity == "model:m1:2026-05-04T09:30:15.400Z"

    def test_a_re_export_is_never_served_out_of_the_cache(self):
        # Re-exporting under the same file name is the ordinary way an
        # architect works. Keying on the name would answer questions about a
        # building that no longer exists.
        from aiq_agent.knowledge.ifc_spatial_client import source_identity

        name = "Haus-A.ifc"
        before = {"model": {"modelId": "m1", "filename": name, "updatedAt": "2026-05-04T09:30:15.400Z"}, "source": {}}
        after = {"model": {"modelId": "m1", "filename": name, "updatedAt": "2026-08-12T07:00:00.000Z"}, "source": {}}

        assert source_identity(before) != source_identity(after)


class TestTheSameModelIsParsedOncePerProcess:
    """The claim the two-key cache makes, checked against a real IFC.

    Skipped where the engine is not installed — which is also the deployment
    shape `ifc_measure` refuses in words rather than pretending to answer.
    """

    #: Anchored to THIS FILE, not to the working directory. The fixture is
    #: committed, so the `pytest.skip` below is meant for a checkout without
    #: the engine — resolving it relatively made it fire on a `pytest` run
    #: started from anywhere but the repository root instead, and a suite that
    #: skips silently proves nothing about the cache it is here to prove.
    FIXTURE = pathlib.Path(__file__).resolve().parents[3] / "packages/ifc-spatial/test/fixtures/Ifc4_SampleHouse.ifc"

    @pytest.fixture()
    def engine(self):
        pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")
        from aiq_agent.knowledge import ifc_spatial_client

        ifc_spatial_client.reset_cache_for_tests()
        yield ifc_spatial_client
        ifc_spatial_client.reset_cache_for_tests()

    @pytest.fixture()
    def served(self):
        """The fixture behind an HTTP URL — the only scheme the client reads.

        `file://` is refused by `_download`, and deliberately: a presigned URL
        arrives from the BFF, and a client that would read whatever scheme it
        was handed turns a model lookup into a local file read.
        """
        import functools
        import http.server
        import threading

        fixture = self.FIXTURE
        if not fixture.is_file():
            pytest.skip("the sample house fixture is not in this checkout")

        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(fixture.parent))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            yield fixture, f"http://127.0.0.1:{server.server_address[1]}/{fixture.name}"
        finally:
            server.shutdown()

    def _source(self, served, etag: str = "abc123") -> dict:
        fixture, url = served
        return {
            "resolved": True,
            "model": {"modelId": "m1", "filename": fixture.name, "updatedAt": "2026-08-12T07:00:00Z"},
            "source": {"url": url, "bytes": fixture.stat().st_size, "etag": etag},
        }

    def test_a_file_url_is_never_read(self, engine, served):
        # The guard that keeps "resolve a model" from becoming "read any path
        # this process can reach".
        from aiq_agent.knowledge.bim_query import BimQueryUnavailableError

        fixture, _ = served
        source = self._source(served)
        source["source"]["url"] = fixture.as_uri()
        with pytest.raises(BimQueryUnavailableError):
            engine.open_model(source)

    def test_the_second_question_about_a_building_downloads_nothing(self, engine, served, monkeypatch):
        source = self._source(served)
        first = engine.open_model(source)

        # Anything that reaches the network on the second call fails the test:
        # a 150 MB download per tool call is what the source identity exists to
        # prevent.
        monkeypatch.setattr(engine, "_download", lambda *a, **k: pytest.fail("the model was downloaded twice"))
        assert engine.open_model(source) == first

    def test_a_re_export_under_the_same_name_is_a_different_model(self, engine, served):
        # Same file name, same model id, new bytes in the store: the ETag moves
        # and the second call must not be served from the first one's parse.
        source = self._source(served, etag="abc123")
        engine.open_model(source)

        moved = {**source, "source": {**source["source"], "etag": "def456"}}
        assert engine.source_identity(moved) != engine.source_identity(source)

    def test_an_operator_answers_through_the_handle(self, engine, served):
        handle = engine.open_model(self._source(served))
        found = engine.call_spatial_tool(handle, "find_elements", {"ifcType": "IfcSpace", "limit": 10})

        assert found["total"] == 4
        area = engine.call_spatial_tool(
            handle,
            "measure",
            {"globalId": found["elements"][0]["globalId"], "measure": "floorArea"},
        )
        assert area["decidable"] is True
        assert area["provenance"] == "computed"

    def test_an_id_that_is_not_in_the_model_could_not_be_looked_up(self, engine, served):
        # And is therefore an ERROR, not a `decidable: false` answer.
        handle = engine.open_model(self._source(served))
        with pytest.raises(engine.SpatialToolError):
            engine.call_spatial_tool(handle, "element", {"globalId": "0nichtvorhanden00000"})


class TestWhatTheTraceRecords:
    """The SHAPE of the call, never the building (ADR-0045 §Observability)."""

    @pytest.fixture(autouse=True)
    def _clean(self):
        from aiq_agent.observability.langfuse_trace_attributes import reset_contributions

        reset_contributions()
        yield
        reset_contributions()

    @staticmethod
    def _recorded() -> dict:
        from aiq_agent.observability.langfuse_trace_attributes import _CONTRIBUTED

        return _CONTRIBUTED.get() or {"metadata": {}, "tags": []}

    def test_a_call_records_its_operation_and_its_operator(self):
        from aiq_agent.agents.bim.measure_register import _trace

        _trace("measure", "clearHeight", outcome="resolved")

        assert self._recorded()["metadata"] == {
            "ifc_op": "measure:measure",
            "ifc_outcome": "resolved",
            "ifc_measure_detail": "clearHeight",
        }
        # The same tag `ifc_query` writes: "which turns read a building model"
        # is a trace-list filter, and metadata is the slower path.
        assert self._recorded()["tags"] == ["feature:ifc"]

    def test_free_text_from_the_model_is_not_echoed_onto_the_trace(self):
        # An operation the model invented is not a fact about this call, and an
        # external observability service is not the place to discover it.
        from aiq_agent.agents.bim.measure_register import _trace

        _trace("measure the Wohnzimmer of Familie Mayr", "Brandabschnitt Nord", outcome="rejected")

        recorded = self._recorded()["metadata"]
        assert recorded["ifc_op"] == "measure:unknown"
        assert "ifc_measure_detail" not in recorded
        assert "Mayr" not in str(recorded)

    def test_an_undecidable_answer_is_distinguishable_from_a_failure(self):
        # The two mean opposite things — the file was read and cannot say,
        # versus nothing was read at all — and an operator auditing a wrong
        # answer needs to tell them apart after the fact.
        from aiq_agent.agents.bim.measure_register import _trace

        _trace("measure", "sillAndHead", outcome="undecidable")
        assert self._recorded()["metadata"]["ifc_outcome"] == "undecidable"

    def test_a_transport_failure_is_not_recorded_as_an_empty_building(self):
        from aiq_agent.agents.bim.measure_register import _trace

        _trace("relations", "opensTo", outcome="service_unavailable")
        assert self._recorded()["metadata"]["ifc_outcome"] == "service_unavailable"


class TestTheDescriptionDescribesTheRealTool:
    """The description is the only spec the model reads.

    A parameter documented in it that the function does not have is not a typo
    — it is an instruction the model follows to produce a call that silently
    does something else.
    """

    @staticmethod
    def _description_and_parameters() -> tuple[str, list[str]]:
        """The description, and the arguments the tool actually takes.

        The parameters used to be read off `_ifc_measure`'s signature through
        the AST, because the function is nested inside a registration generator
        and its signature is not reachable without standing up the whole NAT
        builder. It now takes ONE argument — a validated
        :class:`IfcMeasureInput` — so the signature no longer names anything,
        and the spec moved to the model's fields. Which is the point: the model
        is a real object, importable without a builder, and the invariant gets
        cheaper rather than weaker.
        """
        from aiq_agent.agents.bim.measure_register import _TOOL_DESCRIPTION
        from aiq_agent.agents.bim.measure_register import IfcMeasureInput

        return _TOOL_DESCRIPTION, list(IfcMeasureInput.model_fields)

    def test_every_argument_the_description_shows_being_set_exists(self):
        import re

        description, parameters = self._description_and_parameters()
        shown = set(re.findall(r"\b([a-z][a-z0-9_]{2,})\s*=", description))

        assert shown, "the invariant is vacuous if the description shows no arguments at all"
        assert sorted(shown - set(parameters)) == []

    def test_every_argument_a_field_description_shows_being_set_exists(self):
        """The same invariant where the argument teaching now lives.

        Most of what the prose used to say about arguments is in the field
        descriptions, and a field description that shows `kind='expensive'`
        against a field called something else is the same defect one level down
        — an instruction the model follows into a call that silently does
        something else.
        """
        import re

        from aiq_agent.agents.bim.measure_register import IfcMeasureInput

        fields = set(IfcMeasureInput.model_fields)
        shown = {
            name
            for field in IfcMeasureInput.model_fields.values()
            for name in re.findall(r"\b([a-z][a-z0-9_]{2,})\s*=", field.description or "")
        }

        assert shown, "the invariant is vacuous if no field description shows an argument at all"
        assert sorted(shown - fields) == []

    def test_the_schema_and_the_dispatch_take_the_same_arguments(self):
        """The model is the spec, and `_build_call` is what the spec dispatches to.

        A field on the input model that `_build_call` has no parameter for is a
        value the model can set and this tool silently drops. The reverse — a
        `_build_call` parameter with no field — is a capability nothing can
        reach, which is the failure `test_no_engine_tool_is_unreachable` guards
        one layer further down.
        """
        import inspect

        from aiq_agent.agents.bim.measure_register import IfcMeasureInput
        from aiq_agent.agents.bim.measure_register import _build_call

        dispatched = set(inspect.signature(_build_call).parameters)
        fields = set(IfcMeasureInput.model_fields)
        # `model_name` chooses WHICH file to open and never reaches the engine
        # call, so it is the one field with no counterpart.
        assert fields - dispatched == {"model_name"}
        assert dispatched - fields == set()

    def test_every_operation_it_names_is_one_the_tool_accepts(self):
        import re

        from aiq_agent.agents.bim.measure_register import VALID_OPERATIONS

        description, _ = self._description_and_parameters()
        named = set(re.findall(r"'([a-z_]+)'\s+—", description))

        assert named, "the invariant is vacuous if the description names no operations"
        assert named <= VALID_OPERATIONS

    def test_it_tells_the_agent_to_call_the_briefing_first(self):
        # Storey and property names come from THIS file. A name the agent
        # invented matches nothing, and an empty result reads like "the
        # building has none" — the single most expensive failure on this
        # surface.
        description, _ = self._description_and_parameters()

        assert "CALL 'briefing' FIRST" in description
        assert "copied verbatim" in description
        assert "BLIND" in description

    def test_it_teaches_the_three_provenances_as_three_german_sentences(self):
        description, _ = self._description_and_parameters()

        assert "deklariert" in description
        assert "gemessen" in description
        assert "vermutlich" in description
        # And forbids the one substitution that turns our number into the
        # architect's own statement.
        assert "NEVER write a computed number as something the model states" in description

    def test_it_explains_that_undecidable_is_about_the_export(self):
        description, _ = self._description_and_parameters()

        assert "'decidable: false' is NOT an error" in description
        assert "missing.remedy" in description
        assert "what the architect changes in their CAD" in description

    def test_it_forbids_arithmetic_and_reading_numbers_off_a_drawing(self):
        description, _ = self._description_and_parameters()

        assert "NEVER recompute, round, convert or extrapolate" in description
        assert "NEVER read a measurement off a" in description

    def test_it_states_what_the_expensive_calls_cost_before_they_are_made(self):
        # An agent told a call costs seven seconds can decide it is worth it;
        # one that finds out afterwards cannot.
        description, _ = self._description_and_parameters()

        assert "COST" in description
        assert "opensTo" in description
        assert "speculatively" in description

    def test_it_says_which_tool_the_metadata_questions_belong_to(self):
        # `ifc_query` stays the fast path. A tool description that did not say
        # so would make every count cost a download and a geometry pass.
        description, _ = self._description_and_parameters()

        assert "NOT a replacement for ifc_query" in description
        assert "Reach for it first" in description


class TestTheRefusalSentenceAgreesWithItsOwnNoun:
    """„liefert keine IfcSpace-Elemente nicht" is not German.

    Roughly thirty `missing.what` strings across the engine are already negated
    („keine Nordrichtung", „kein auswertbares Prisma"), and the renderer wrapped
    every one of them in a second negation. Read literally the sentence says the
    opposite of the finding — and it is the sentence an architect reads when the
    tool is telling them what to fix in their export.

    Fixed in the renderer rather than by rewriting thirty German strings,
    because the renderer owns the sentence.
    """

    @staticmethod
    def _line(what: str) -> str:
        return _provenance_line({"decidable": False, "missing": {"what": what, "remedy": "R"}})

    @pytest.mark.parametrize(
        "what",
        [
            "keine IfcSpace-Elemente",
            "keine Nordrichtung",
            "kein auswertbares Prisma: halfSpaces fehlt",
            "keiner der Rasterpunkte liegt im Raumkörper",
            "Keine Georeferenzierung",
        ],
    )
    def test_an_already_negated_noun_is_not_negated_twice(self, what: str) -> None:
        line = self._line(what)
        assert f"enthält {what}" in line
        assert "nicht." not in line.split("Das ist")[0]

    @pytest.mark.parametrize(
        "what",
        [
            "IfcGeometricRepresentationContext.TrueNorth",
            "Pset_WindowCommon.SillHeight",
            "Körpergeometrie für IfcWall „Aussenwand“",
            "die Bodenfläche des Raums",
        ],
    )
    def test_a_plain_noun_still_takes_the_negation(self, what: str) -> None:
        assert f"liefert {what} nicht" in self._line(what)

    def test_a_word_merely_starting_with_kein_is_not_mistaken_for_a_negation(self) -> None:
        # `\b` matters: a noun beginning with those letters is not „kein".
        assert "liefert Keinsche Fläche nicht" in self._line("Keinsche Fläche")

    def test_the_finding_is_still_about_the_export_either_way(self) -> None:
        for what in ("keine Nordrichtung", "Pset_WindowCommon.SillHeight"):
            line = self._line(what)
            assert "Befund über den EXPORT" in line
            assert "Abhilfe: R" in line


class TestAWrongOperatorIsNotAWrongId:
    """The engine now RAISES for a wrong kind instead of returning undecidable.

    Both arrive at `_unrunnable_text`, and they need opposite advice. Telling
    the agent to re-check the GlobalId when the id is correct sends it to
    `find_elements` for something it already has, and back with the same wrong
    call — a loop that costs the turn and never terminates in an answer.
    """

    WRONG_KIND = (
        "clearOpeningWidth() erwartet eine Öffnung, ein Fenster oder eine Tür — IfcPlate "
        "(GlobalId 3cUkl32) ist das nicht. Das ist ein Fehler im Aufruf, kein Befund über den "
        "Export: an dieser Datei ist nichts zu ändern. für eine Wand: hosts()"
    )

    def test_a_wrong_kind_does_not_send_the_agent_back_to_find_elements(self) -> None:
        text = _unrunnable_text(self.WRONG_KIND)
        assert "The GlobalId is fine" in text
        assert "Do not look the id up again" in text
        assert "find_elements" not in text

    def test_an_unknown_id_still_does(self) -> None:
        text = _unrunnable_text("Unbekannte GlobalId 0abcdefg in diesem Modell")
        assert "check the GlobalId with operation='find_elements'" in text

    def test_both_say_it_is_the_arguments_and_not_the_building(self) -> None:
        for reason in (self.WRONG_KIND, "Unbekannte GlobalId 0abcdefg"):
            text = _unrunnable_text(reason)
            assert text.startswith("Error:")
            # Never a finding about the export: nothing here is the file's fault.
            assert "Befund über den EXPORT" not in text


class TestOIB6ReachesTheModel:
    """`envelope` — the operation that existed as geometry and as nothing else.

    `thermal_envelope`, `envelope_area_by_orientation` and `compactness` were
    implemented, tested, and on no tool surface. Every OIB 6 question therefore
    came back as „das kann dieser Export nicht beantworten", which is a claim
    about the architect's file and was actually a claim about our wiring — the
    worst shape a gap can take, because it sends them to fix something that is
    not broken.
    """

    def test_the_operation_dispatches_to_the_engine_tool(self):
        assert _build_call(operation="envelope", kind="compactness") == ("envelope", {"what": "compactness"})

    def test_the_aspect_is_matched_case_insensitively(self):
        assert _build_call(operation="envelope", kind="AREABYORIENTATION") == (
            "envelope",
            {"what": "areaByOrientation"},
        )

    def test_it_defaults_to_the_envelope_itself(self):
        """Which elements ARE the envelope is the first question of an OIB 6
        calculation, and the one the other two are built on."""
        assert _build_call(operation="envelope") == ("envelope", {"what": "thermalEnvelope"})

    def test_an_unknown_aspect_names_the_ones_that_exist(self):
        answer = _build_call(operation="envelope", kind="uWert")
        assert isinstance(answer, str) and "thermalEnvelope" in answer

    def test_a_global_id_is_not_forwarded(self):
        """The engine's schema has no `globalId` on this tool, and an envelope is
        not a property of one element anyway. Forwarding a surplus id would turn
        a harmless extra argument into a schema rejection the model cannot read
        its way out of."""
        _, args = _build_call(operation="envelope", kind="compactness", global_id="3cUkl32yn9qRSPvBJVyWw5")
        assert args == {"what": "compactness"}


class TestARatioDoesNotInheritAnAreaTolerance:
    """A dimensionless value must not be rounded to the band of a different unit.

    `_decimals` derives its precision from the answer's tolerance, which carries
    the answer's UNIT. `envelope/areaByOrientation` has a tolerance of ±2.3 m²,
    which earns ZERO decimals — and the window-to-wall ratios, which are the
    entire point of that operator, rendered as `windowWallRatio=0` for north
    (truly 0.193), south (0.405) and the building as a whole (0.177).

    A facade reported at 0 does not read as an imprecise number. It reads as a
    facade with no glazing in it — a statement about the building, produced by a
    rounding rule, and false on three of four elevations.
    """

    @staticmethod
    def _answer():
        return {
            "decidable": True,
            "provenance": "computed",
            "tolerance": 2.3,
            "unit": "m²",
            "value": {
                "opaque": 185.850015,
                "transparent": 39.85055,
                "windowWallRatio": 0.176564,
                "byOrientation": {"N": {"total": 33.982401, "windowWallRatio": 0.193455}},
            },
        }

    def test_the_ratio_survives_at_every_nesting_depth(self):
        text = "\n".join(_render_answer(self._answer()))
        assert "windowWallRatio=0.18" in text
        assert "windowWallRatio=0.19" in text
        assert "windowWallRatio=0," not in text and "windowWallRatio=0\n" not in text

    def test_the_areas_still_follow_their_own_band(self):
        """The band is not abandoned — only stopped from crossing units. A
        ±2.3 m² area has no business showing a centimetre digit."""
        text = "\n".join(_render_answer(self._answer()))
        assert "opaque=186" in text and "transparent=40" in text

    def test_a_ratio_that_carries_a_unit_keeps_its_own_precision(self):
        """`compactness.ratio` is A/V in 1/m — the answer's OWN value, whose
        ±0.021 1/m band is exactly right for it. Overriding that one would be
        this same bug pointing the other way, which is why the rule is a list of
        keys and not a guess from the name."""
        text = "\n".join(
            _render_answer(
                {
                    "decidable": True,
                    "provenance": "computed",
                    "tolerance": 0.021,
                    "unit": "1/m",
                    "value": {"ratio": 0.846182, "characteristicLength": 1.181779},
                }
            )
        )
        assert "ratio=0.85" in text


class TestTheDoorGraphRendersAsDoorsAndNotAsCounts:
    """The graph flattened by `_value_text` reads „nodes=83 Einträge,
    edges=77 Einträge, unbestimmt=0 Einträge" — measured on the institute
    building in the corpus. Four counts and not one door.

    It is the same defect `egressPath` already has a branch for: the counts are
    not the answer. The answer is which rooms have no way out and which doors
    the derivation could not read, and those two lists are the entire reason
    `fire/doorGraph` is worth a call separate from `measure/egressPath`.
    """

    GRAPH = {
        "value": {
            "nodes": [
                {"globalId": "r1", "ifcType": "IfcSpace", "name": "Wohnen"},
                {"globalId": "r2", "ifcType": "IfcSpace", "name": "Dachraum"},
                {"globalId": "AUSSEN", "ifcType": "outside", "name": "Freie (außerhalb des Gebäudes)"},
            ],
            "edges": [
                {
                    "globalId": "d1",
                    "name": "Haustür",
                    "ifcType": "IfcDoor",
                    "verbindet": ["r1", "AUSSEN"],
                    "length": 3.2,
                    "external": True,
                    "via": "geom.tree.select",
                }
            ],
            "unbestimmt": [
                {
                    "globalId": "d2",
                    "name": "Zimmertür",
                    "ifcType": "IfcDoor",
                    "warum": "Körpergeometrie fehlt",
                    "abhilfe": "mit Körpergeometrie exportieren",
                }
            ],
            "ausgeschlossen": [
                {
                    "globalId": "d3",
                    "name": "Bodenluke",
                    "ifcType": "IfcDoor",
                    "warum": "PredefinedType = TRAPDOOR: nicht begehbar",
                }
            ],
            "buildSeconds": 1.005,
        },
        "unit": None,
        "tolerance": None,
        "provenance": "computed",
        "from": ["r1", "r2", "d1"],
        "method": "doorGraph()",
        "decidable": True,
        "caveat": "Der Graph kennt ausschließlich Türen.",
    }

    def _text(self) -> str:
        return "\n".join(_render_answer(json.loads(json.dumps(self.GRAPH))))

    def test_the_headline_counts_rooms_doors_and_exits(self):
        # The OUTSIDE node is not a room and must not be counted as one — a
        # building with two rooms and an outside would otherwise report three.
        # Singular where the count is one — German agrees in number, and this
        # assertion pinned „1 Türverbindungen" until it was fixed.
        assert "2 Räume, 1 Türverbindung, davon 1 ins Freie" in self._text()

    def test_a_room_with_no_door_edge_is_named(self):
        """The finding `egressPath` cannot produce, because it is asked about one
        room and this is about all of them."""
        text = self._text()
        assert "KEINE Türkante" in text and "Dachraum" in text
        assert "keinen Ausgang" in text

    def test_an_unresolved_door_is_named_with_its_reason(self):
        """A hole in EVERY route through this building. A reader who sees only
        the edge count cannot tell a building with one door from one with two of
        which one was unreadable."""
        text = self._text()
        assert "UNBESTIMMT" in text and "Zimmertür" in text and "Körpergeometrie fehlt" in text

    def test_a_deliberately_excluded_door_is_named_too(self):
        text = self._text()
        assert "NICHT als Kante gewertet" in text and "Bodenluke" in text and "TRAPDOOR" in text

    def test_the_counts_alone_never_stand_in_for_the_lists(self):
        """The line this branch exists to prevent."""
        assert "unbestimmt=1 Eintrag" not in self._text()

    def test_the_caveat_and_the_method_still_travel(self):
        text = self._text()
        assert "Hinweis: Der Graph kennt ausschließlich Türen." in text
        assert "Methode: doorGraph()" in text


class TestRenderingASurvey:
    """A survey is many answers, and the rendering decides whether the caller
    reads them as many.

    The failure this branch exists to prevent is not a crash. Flattened through
    the generic value renderer, seventeen measurements print as
    „results=17 Einträge, summary=(…)" — a shape, not a finding — and the model
    downstream reports „der Keller ist 2,70 m hoch" because that is the only
    number it can see. The spread has to come first and the outlier has to have
    a name, or the survey has bought nothing over measuring one room.
    """

    SURVEY = {
        "measure": "clearHeight",
        "results": [
            {
                "globalId": "3UEb2iq7D2tOgbX6Mufs$X",
                "name": "Seminarraum",
                "storey": "Keller",
                "answer": {"value": 2.7, "unit": "m", "tolerance": 0.005, "decidable": True},
            },
            {
                "globalId": "3Gz7u_d1P7IA35Wmtg48Rc",
                "name": "Flur Keller Treppe",
                "storey": "Keller",
                "answer": {"value": 0.2497, "unit": "m", "tolerance": 0.005, "decidable": True},
            },
            {
                "globalId": "0V74RtuUH1zQt_CcawQbBc",
                "name": "Technikraum I",
                "storey": "Keller",
                "answer": {
                    "decidable": False,
                    "missing": {"what": "auswertbare Körpergeometrie", "remedy": "als Solid exportieren"},
                },
            },
        ],
        "summary": {
            "measured": 2,
            "of": 3,
            "undecidable": [{"globalId": "0V74RtuUH1zQt_CcawQbBc", "name": "Technikraum I"}],
            "min": 0.2497,
            "max": 2.7,
            "spread": 2.4503,
            "provenance": {"computed": 2},
        },
    }

    def _text(self, **overrides):
        payload = {**self.SURVEY, **overrides}
        return _render("survey", payload)

    def test_the_spread_is_stated_before_any_single_room(self):
        """Read top-down, the first fact has to be that the rooms disagree."""
        text = self._text()
        head = text.splitlines()[0]
        assert "2.450" in head and "0.250" in head and "2.700" in head
        assert head.index("Spanne") < text.index("Seminarraum")

    def test_the_outlier_is_named_not_just_identified(self):
        """A GlobalId is not something a person can carry to a CAD window."""
        text = self._text()
        assert "Flur Keller Treppe (Keller): 0.250 m" in text
        assert "3Gz7u_d1P7IA35Wmtg48Rc" not in text

    def test_a_room_that_could_not_be_measured_is_never_folded_into_the_others(self):
        text = self._text()
        assert "Technikraum I (Keller): NICHT ENTSCHEIDBAR" in text
        assert "1 Bauteil konnte nicht gemessen werden" in text
        assert "wie die anderen" in text

    def test_the_agreement_line_counts_correctly_in_german(self):
        """„1 Bauteile konnten" is the kind of sentence that makes a reader stop
        trusting the rest of the number."""
        assert "1 Bauteil konnte" in self._text()
        many = self._text(
            summary={**self.SURVEY["summary"], "undecidable": [{"name": "A"}, {"name": "B"}]},
        )
        assert "2 Bauteile konnten" in many

    def test_a_truncated_survey_says_the_spread_covers_only_a_slice(self):
        text = self._text(
            truncated=True,
            hint="200 Bauteile passen zur Auswahl, gemessen wurden die ersten 50.",
            summary={**self.SURVEY["summary"], "selected": 200},
        )
        assert "NUR diese Auswahl" in text
        assert "200 Bauteile passen" in text

    def test_a_declared_computed_conflict_is_reported_as_an_export_defect(self):
        text = self._text(
            summary={**self.SURVEY["summary"], "disagree": [{"name": "Seminarraum", "globalId": "x"}]},
        )
        assert "WIDERSPRUCH" in text and "Seminarraum" in text
        assert "über den Export, nicht über das Gebäude" in text

    def test_a_survey_that_measured_nothing_does_not_lecture_about_a_spread(self):
        """The sentence has to keep meaning something for the cases where it fires."""
        text = self._text(
            results=[],
            summary={"measured": 0, "of": 0, "undecidable": []},
            hint="Kein Bauteil passt zu dieser Auswahl.",
        )
        assert "Die Spanne ist die Aussage" not in text
        assert "Kein Bauteil passt" in text

    def test_the_raw_dict_shape_never_reaches_the_reader(self):
        """The line this branch exists to prevent."""
        text = self._text()
        assert "results=" not in text and "summary=" not in text and "Einträge" not in text


class TestOperationsThatNeedNoSubject:
    """The guard that ate `survey`.

    `_build_call` refuses, with a helpful sentence, any operation reaching the
    bottom of the function without a `global_id`. That is right for `measure`
    and `relations`, which are about one element. It is wrong for the operations
    that take a SELECTION — and `survey` shipped below the guard, so every call
    the skill teaches („alle Räume dieses Geschoßes") came back

        Error: operation 'survey' needs a global_id

    while the engine underneath it was correct, tested, and never reached. The
    engine tests could not see this: they call the handler directly. The
    renderer tests could not see it either, because a payload that never arrives
    is never rendered. Only the dispatch layer knows, so the test belongs here.
    """

    SUBJECTLESS = [
        ("find_elements", {"ifc_type": "IfcSpace"}),
        ("survey", {"measure": "clearHeight", "ifc_type": "IfcSpace", "storey": "Keller"}),
        ("draw", {"storey": "Keller"}),
        ("briefing", {}),
        ("storey_heights", {}),
    ]

    @pytest.mark.parametrize("operation,extra", SUBJECTLESS)
    def test_it_dispatches_without_a_global_id(self, operation, extra):
        built = _build_call(operation=operation, **extra)
        assert isinstance(built, tuple), (
            f"'{operation}' takes a selection, not a subject, and came back as the string {built!r}. "
            "Its branch is below the `if not subject` guard in `_build_call`."
        )
        assert built[0] == operation

    def test_survey_carries_the_whole_selection_through(self):
        """The selector is the operation. Dropping `storey` here would silently
        survey the entire building and report its spread as the Keller's."""
        name, args = _build_call(operation="survey", measure="clearHeight", ifc_type="IfcSpace", storey="Keller")
        assert name == "survey"
        assert args["measure"] == "clearHeight"
        assert args["ifcType"] == "IfcSpace"
        assert args["storey"] == "Keller"

    def test_an_unknown_measure_is_still_refused_by_name(self):
        answer = _build_call(operation="survey", measure="raumhoehe", ifc_type="IfcSpace")
        assert isinstance(answer, str) and "raumhoehe" in answer and "clearHeight" in answer


class TestTheSchemaIsWhatTheModelActuallySees:
    """A pydantic model whose constraints never reach the wire buys nothing.

    The whole benefit of typing this tool's input is invisible unless the enums
    and the per-parameter text survive the trip from `IfcMeasureInput` through
    NAT's `FunctionInfo`, through the framework wrapper, and into the JSON
    schema handed to the model. Each of those three hops is somebody else's
    code, and the failure mode — a beautifully typed model, a bare schema on
    the wire, and no way to tell from inside the process — is exactly what this
    class exists to make impossible.

    So it does not inspect `IfcMeasureInput`. It builds the tool the way the
    agent builds it and reads the schema off the far end.
    """

    @staticmethod
    def _wire_schema() -> dict:
        """The `parameters` object an OpenAI-shaped tool call would carry.

        The same two steps `nat.plugins.langchain.tool_wrapper` takes:
        `args_schema=fn.input_schema` onto a `StructuredTool`, and whatever the
        provider adapter makes of it.
        """
        import asyncio
        from unittest.mock import MagicMock

        from langchain_core.tools.structured import StructuredTool
        from langchain_core.utils.function_calling import convert_to_openai_tool

        from aiq_agent.agents.bim.measure_register import IfcMeasureConfig
        from aiq_agent.agents.bim.measure_register import ifc_measure

        async def build() -> dict:
            async with ifc_measure(IfcMeasureConfig(), MagicMock()) as info:
                assert info.input_schema is not None, "NAT kept no input schema at all"
                tool = StructuredTool.from_function(
                    coroutine=info.single_fn,
                    func=lambda **_: None,
                    name="ifc_measure",
                    description=info.description,
                    args_schema=info.input_schema,
                )
                return convert_to_openai_tool(tool)["function"]["parameters"]

        return asyncio.run(build())

    @staticmethod
    def _enum(field: dict) -> list[str] | None:
        """The allowed values, wherever the serialiser put them.

        An optional `Literal` comes out as `anyOf: [{enum: […]}, {type: null}]`
        rather than a bare `enum`, and a test that only looked for the bare form
        would report the enums missing when they are there.
        """
        if "enum" in field:
            return list(field["enum"])
        for branch in field.get("anyOf", []):
            if "enum" in branch:
                return list(branch["enum"])
        return None

    def test_the_enums_reach_the_wire_and_are_the_engine_s_own(self):
        from aiq_agent.agents.bim.measure_register import ENVELOPE_ASPECTS
        from aiq_agent.agents.bim.measure_register import FIRE_ASPECTS
        from aiq_agent.agents.bim.measure_register import KINDS
        from aiq_agent.agents.bim.measure_register import MEASURES
        from aiq_agent.agents.bim.measure_register import OPERATIONS
        from aiq_agent.agents.bim.measure_register import PROFILE_KINDS
        from aiq_agent.agents.bim.measure_register import RELATIONS
        from aiq_agent.agents.bim.measure_register import ROOM_KINDS

        properties = self._wire_schema()["properties"]

        assert self._enum(properties["operation"]) == list(OPERATIONS)
        assert self._enum(properties["measure"]) == list(MEASURES)
        assert self._enum(properties["relation"]) == list(RELATIONS)
        assert self._enum(properties["room_kind"]) == list(ROOM_KINDS)
        # `kind` is three vocabularies plus the profile opt-in, in that order.
        assert self._enum(properties["kind"]) == [
            *KINDS,
            *FIRE_ASPECTS,
            *ENVELOPE_ASPECTS,
            *PROFILE_KINDS,
        ]

    def test_the_enum_order_is_stable_across_processes(self):
        """`VALID_OPERATIONS` was a set, and string hashing is randomised.

        A set-ordered enum reshuffles between restarts, which makes the tool
        schema a different string to every prefix cache in front of the model
        for no reason at all. Two fresh interpreters have to agree.
        """
        import subprocess
        import sys

        program = (
            "from aiq_agent.agents.bim.measure_register import IfcMeasureInput;"
            "import json;"
            "print(json.dumps(IfcMeasureInput.model_json_schema()['properties']['operation']['enum']))"
        )
        runs = {
            subprocess.run(
                [sys.executable, "-c", program],
                capture_output=True,
                text=True,
                check=True,
                env={"PYTHONHASHSEED": seed, "PATH": "/usr/bin:/bin"},
            ).stdout.strip()
            for seed in ("1", "2", "3")
        }
        assert len(runs) == 1, runs

    def test_every_parameter_carries_its_own_description(self):
        """The fact the prose used to carry, at the point where it is needed.

        A parameter with no description is one the model has to learn about
        from 4 000 tokens of narrative somewhere above — which is what this
        whole change is undoing.
        """
        properties = self._wire_schema()["properties"]
        undescribed = sorted(name for name, field in properties.items() if not field.get("description"))
        assert undescribed == []

    def test_the_operation_is_required_and_nothing_else_is(self):
        """Every other field is scoped BY the operation, so it is the one
        decision no caller can skip. Making the rest required would refuse
        calls that are complete — `briefing` takes nothing at all."""
        assert self._wire_schema()["required"] == ["operation"]

    def test_the_measure_vocabulary_travels_with_its_meanings(self):
        """The enum says WHICH names exist; only the text says which one
        answers the question. Shipping the names without the meanings would
        make `clearHeight` and `extent` look interchangeable, which is the
        confusion a Raumhöhennachweis turns on."""
        description = self._wire_schema()["properties"]["measure"]["description"]

        assert "lichte Raumhöhe" in description
        assert "NOT the height of the space solid" in description
        for name in ("clearHeight", "turningCircle", "egressPath"):
            assert f"{name} —" in description

    def test_the_overloaded_fields_say_which_operations_they_belong_to(self):
        """`mode`, `kind` and `other_global_id` mean different things per
        operation. A flat model can carry that; it cannot carry it silently."""
        properties = self._wire_schema()["properties"]

        for operation in ("distance", "view"):
            assert f"'{operation}'" in properties["mode"]["description"]
        for operation in ("find_elements", "fire", "envelope", "element_profile"):
            assert f"'{operation}'" in properties["kind"]["description"]
        for operation in ("distance", "clearance", "overhang", "light_incidence"):
            assert f"'{operation}'" in properties["other_global_id"]["description"]

    def test_a_list_of_global_ids_is_expressible_as_a_real_array(self):
        """The engine's `highlight`, `only` and `exclude` have always been
        arrays. The wire can carry one, so the field offers one — and still
        takes the comma-separated string the description teaches."""
        branches = self._wire_schema()["properties"]["global_id"]["anyOf"]

        assert {"type": "string"} in branches
        assert {"type": "array", "items": {"type": "string"}} in branches

    def test_no_enum_value_or_description_offers_the_model_a_verdict(self):
        """The governing invariant, checked on the surface the model reads.

        This layer MEASURES and the Bestimmung JUDGES. An enum value called
        `compliant`, or a description that says what a number has to be, would
        move the verdict into the tool — where nobody signs for it.
        """
        import json

        properties = self._wire_schema()["properties"]
        schema = json.dumps(properties, ensure_ascii=False)

        # No VALUE the model can pick is a judgement. Every enum here names a
        # quantity, a relation or a subject — never an outcome.
        for name, field in properties.items():
            for value in self._enum(field) or []:
                assert not any(
                    word in value.lower() for word in ("erfuellt", "erfüllt", "compliant", "zulaessig", "conform")
                ), f"{name} offers the model a verdict: {value!r}"

        # And no description states what a number has to BE.
        for word in ("erfüllt", "compliant", "zulässig", "Grenzwert", "mindestens", "höchstens zulässig"):
            assert word not in schema, f"the input schema applies a clause: {word!r}"

        # `Gebäudeklasse` may appear ONLY where it is being refused: the height
        # is geometry, the class that follows from it is law.
        assert "Gebäudeklasse" in schema, "the sentence that refuses the class went missing"
        assert "Returns a HEIGHT and never a class" in schema
        # The two operators most likely to be read as a check say so themselves.
        assert schema.count("Applies no threshold") == 2


class TestAMalformedCallIsRefusedBeforeTheToolRuns:
    """Where the refusal happens, and what that is actually worth.

    `_build_call` has always refused an unknown measure, and refused it well —
    but it refuses INSIDE the tool, after the call was accepted and dispatched.
    Declaring the vocabulary in the input model moves the refusal in front of
    the tool body: nothing runs, nothing resolves a project or opens a model,
    and the permitted set travels with the error out of the schema itself.

    What it does NOT buy is the turn back. The iteration budget is charged when
    the model EMITS the call (`shallow_researcher.agent`), nothing refunds it,
    and the ToolNode hands the ValidationError back as the tool result rather
    than short-circuiting the loop — so a rejected call costs the same fifth of
    the budget either way. The saving is upstream of all of that: a value the
    schema forbids is one most models never emit, and the enum in the args
    schema is where a model reliably reads the vocabulary from.
    """

    @staticmethod
    def _model():
        from aiq_agent.agents.bim.measure_register import IfcMeasureInput

        return IfcMeasureInput

    def test_an_operation_that_does_not_exist_never_reaches_the_tool(self):
        import pydantic

        with pytest.raises(pydantic.ValidationError) as refused:
            self._model()(operation="measure_room", global_id="1kTv")

        # And the permitted set travels with the refusal, so the retry is informed.
        assert "storey_heights" in str(refused.value)

    def test_a_measure_that_does_not_exist_never_reaches_the_tool(self):
        import pydantic

        with pytest.raises(pydantic.ValidationError):
            self._model()(operation="measure", global_id="1kTv", measure="wandstaerke")

    @pytest.mark.parametrize(
        "field,value",
        [
            ("relation", "borders"),
            ("kind", "raum"),
            ("room_kind", "wohnraum"),
            ("mode", "clear"),
        ],
    )
    def test_every_other_vocabulary_is_closed_too(self, field, value):
        import pydantic

        with pytest.raises(pydantic.ValidationError):
            self._model()(operation="find_elements", **{field: value})

    def test_a_call_that_decided_nothing_is_refused(self):
        """`operation` used to default to 'briefing', so a call with no
        arguments at all came back as a successful briefing. That reads as
        „the tool worked" for a call that named no question."""
        import pydantic

        with pytest.raises(pydantic.ValidationError) as refused:
            self._model()()

        assert "operation" in str(refused.value)

    def test_a_batch_too_big_for_the_engine_is_refused_before_the_download(self):
        """The engine refuses more than MAX_BATCH — after resolving, fetching
        and tessellating the model. Seconds and a turn, to be told to count."""
        import pydantic

        from aiq_agent.agents.bim.measure_register import MAX_BATCH

        ids = ",".join(f"id{n}" for n in range(MAX_BATCH + 1))
        with pytest.raises(pydantic.ValidationError) as refused:
            self._model()(operation="measure", measure="floorArea", global_id=ids)

        assert str(MAX_BATCH) in str(refused.value)
        # And it says what to do instead, in one sentence.
        assert "survey" in str(refused.value)

    def test_the_batch_ceiling_is_not_invented_for_the_other_list_operations(self):
        """`view`, `fire` and `light_incidence` take lists and have no ceiling.
        A schema stricter than the engine refuses calls that would have worked."""
        ids = [f"id{n}" for n in range(80)]
        assert self._model()(operation="view", global_id=ids).global_id.count(",") == 79

    def test_an_angle_outside_the_prism_is_refused_at_the_boundary(self):
        import pydantic

        with pytest.raises(pydantic.ValidationError):
            self._model()(operation="light_incidence", global_id="1kTv", angle_deg=120.0)

    @pytest.mark.parametrize("angle", [0.0, 90.0])
    def test_the_schema_bounds_are_the_bounds_the_tool_actually_accepts(self, angle):
        """The schema said 0 ≤ angle ≤ 90; `_build_call` accepts 0 < angle < 90.

        Both endpoints passed validation and were then refused inside the tool —
        a fifth of the iteration budget spent on an angle the schema had just
        told the model was fine. The same "default written in two places" defect
        the `mode` field was fixed for.
        """
        import pydantic

        with pytest.raises(pydantic.ValidationError):
            self._model()(operation="light_incidence", global_id="1kTv", angle_deg=angle)

    def test_an_absent_angle_is_absent_and_not_zero(self):
        """„not given" and „zero degrees" must not be the same value.

        `_build_call` refuses both, so nothing breaks today — but the default
        lived in the schema AND in an `or None` at the call site, which is
        exactly how the two drift apart. ``swivel_deg=0`` is meanwhile a real
        value (no lateral Verschwenkung) and must survive the trip.
        """
        model = self._model()(operation="light_incidence", global_id="1kTv", angle_deg=45.0, swivel_deg=0.0)
        assert model.angle_deg == 45.0
        assert model.swivel_deg == 0.0
        assert self._model()(operation="briefing").angle_deg is None

    def test_a_name_this_surface_does_not_have_still_reaches_the_backlog(self, monkeypatch):
        """The enums must not silence `capability_gaps`.

        „measure='wandstaerke'" is not really a mistake — it is somebody asking
        for a wall thickness this surface has no operator for, in one word, and
        it is the most useful signal the BIM surface produces. `_build_call`
        recorded it. Once the enum is on the wire the value never gets that
        far, and the backlog would go quiet exactly as the refusals got cheaper.
        """
        import pydantic

        recorded = self._gaps_recorded_by(
            monkeypatch, pydantic, operation="measure", global_id="1kTv", measure="wandstaerke"
        )

        assert [entry["asked_for"] for entry in recorded] == ["wandstaerke"]
        assert recorded[0]["field"] == "measure"

    def test_a_bad_kind_is_recorded_against_the_vocabulary_its_operation_uses(self, monkeypatch):
        """`kind` is three vocabularies. „fire kind='thermalEnvelope'" is a
        different request from „find_elements kind='thermalEnvelope'", and a
        backlog that merged them would rank neither."""
        import pydantic

        recorded = self._gaps_recorded_by(monkeypatch, pydantic, operation="fire", kind="brandabschnitt")

        assert recorded[0]["field"] == "fire.kind"

    @staticmethod
    def _gaps_recorded_by(monkeypatch, pydantic, **arguments) -> list[dict]:
        from aiq_agent.agents.bim import measure_register

        recorded: list[dict] = []
        monkeypatch.setattr(measure_register, "record_gap", lambda **kwargs: recorded.append(kwargs))
        with pytest.raises(pydantic.ValidationError):
            measure_register.IfcMeasureInput(**arguments)
        return recorded


class TestEveryWellFormedCallStillDispatchesIdentically:
    """This is a schema refactor. The calls that worked have to work the same.

    Each row is a call the tool accepted before the input model existed, driven
    through the model and then through `_build_call`, and asserted against the
    engine call it has always produced.
    """

    CALLS = [
        (
            {"operation": "briefing"},
            ("briefing", {"format": "text"}),
        ),
        (
            {"operation": "find_elements", "ifc_type": "IfcSpace", "storey": "Keller", "kind": "space"},
            ("find_elements", {"limit": 50, "ifcType": "IfcSpace", "storey": "Keller", "kind": "space"}),
        ),
        (
            {"operation": "element", "global_id": "1kTv"},
            ("element", {"globalId": "1kTv"}),
        ),
        (
            {"operation": "relations", "global_id": "1kTv", "relation": "opensTo"},
            ("relations", {"globalId": "1kTv", "relation": "opensTo"}),
        ),
        (
            {"operation": "measure", "global_id": "1kTv", "measure": "clearHeight"},
            ("measure", {"globalId": "1kTv", "measure": "clearHeight"}),
        ),
        (
            {"operation": "survey", "measure": "clearHeight", "ifc_type": "IfcSpace", "storey": "Keller"},
            ("survey", {"measure": "clearHeight", "limit": 50, "ifcType": "IfcSpace", "storey": "Keller"}),
        ),
        (
            {"operation": "element_profile", "global_id": "1kTv", "kind": "expensive"},
            ("element_profile", {"globalId": "1kTv", "include": "expensive"}),
        ),
        (
            {"operation": "distance", "global_id": "a", "other_global_id": "b", "mode": "horizontal"},
            ("distance", {"a": "a", "b": "b", "mode": "horizontal"}),
        ),
        (
            {"operation": "clearance", "global_id": "a", "other_global_id": "b"},
            ("clearance", {"a": "a", "b": "b"}),
        ),
        (
            {"operation": "sun_position", "when": "2026-06-21T12:00:00+02:00"},
            ("sun_position", {"when": "2026-06-21T12:00:00+02:00"}),
        ),
        (
            {"operation": "storey_heights"},
            ("storey_heights", {}),
        ),
        (
            {"operation": "room_inventory", "room_kind": "aufenthaltsraum"},
            ("room_inventory", {"kind": "aufenthaltsraum"}),
        ),
        (
            {"operation": "draw", "storey": "Keller", "ifc_type": "IfcWall"},
            ("draw", {"storey": "Keller", "include": ["IfcWall"]}),
        ),
        (
            {"operation": "shopping_list"},
            ("shopping_list", {}),
        ),
        (
            {"operation": "fire", "kind": "compartmentArea", "global_id": "a,b"},
            ("fire", {"what": "compartmentArea", "globalId": "a,b"}),
        ),
        (
            {"operation": "envelope", "kind": "compactness"},
            ("envelope", {"what": "compactness"}),
        ),
        (
            {"operation": "overhang", "global_id": "roof", "other_global_id": "wall"},
            ("overhang", {"projecting": "roof", "facade": "wall"}),
        ),
        (
            {
                "operation": "light_incidence",
                "global_id": "win",
                "other_global_id": "wall,roof",
                "angle_deg": 45.0,
                "swivel_deg": 30.0,
            },
            ("light_incidence", {"globalId": "win", "angle": 45.0, "swivel": 30.0, "exclude": ["wall", "roof"]}),
        ),
        (
            {"operation": "view", "global_id": "1kTv", "mode": "only"},
            ("view", {"only": ["1kTv"]}),
        ),
    ]

    @staticmethod
    def _dispatch(**arguments):
        """Exactly what `_ifc_measure` does between the model and the engine."""
        from aiq_agent.agents.bim.measure_register import IfcMeasureInput

        parsed = IfcMeasureInput(**arguments)
        return _build_call(
            operation=parsed.operation,
            global_id=str(parsed.global_id),
            other_global_id=str(parsed.other_global_id),
            relation=parsed.relation or "",
            measure=parsed.measure or "",
            mode=parsed.mode or "",
            ifc_type=parsed.ifc_type,
            name_contains=parsed.name_contains,
            storey=parsed.storey,
            kind=parsed.kind or "",
            room_kind=parsed.room_kind or "",
            limit=parsed.limit if parsed.limit and parsed.limit > 0 else 50,
            angle_deg=parsed.angle_deg or None,
            swivel_deg=parsed.swivel_deg or None,
            when=parsed.when,
        )

    @pytest.mark.parametrize("arguments,expected", CALLS, ids=[row[0]["operation"] for row in CALLS])
    def test_the_engine_call_is_unchanged(self, arguments, expected):
        assert self._dispatch(**arguments) == expected

    def test_every_operation_is_covered_by_a_row(self):
        """A parity table that quietly stops covering an operation proves
        nothing about the one it dropped."""
        from aiq_agent.agents.bim.measure_register import VALID_OPERATIONS

        assert {row[0]["operation"] for row in self.CALLS} == set(VALID_OPERATIONS)

    def test_an_array_of_ids_and_the_comma_string_are_the_same_call(self):
        """The array is offered because the wire can carry one, not because it
        means something different."""
        assert self._dispatch(operation="view", global_id=["a", "b"]) == self._dispatch(
            operation="view", global_id="a, b"
        )

    def test_a_view_without_a_mode_finally_reaches_the_engine(self):
        """The one behaviour that DOES change, and it changes from broken.

        `_ifc_measure` declared `mode: str = "min"` while the description
        promised `view` defaulted to 'highlight'. Both were internally
        consistent and they disagreed with each other, so every `view` call
        that omitted `mode` — which is what the description invites — arrived
        as mode='min', which `view` does not have, and was refused. The default
        now lives in one place, and 'not given' reaches `_build_call` as 'not
        given'.
        """
        assert self._dispatch(operation="view", global_id="1kTv") == ("view", {"highlight": ["1kTv"]})

    def test_a_kind_the_operation_ignores_is_not_filed_as_a_missing_capability(self, monkeypatch):
        """`element_profile` shrugs at a `kind` that is not 'expensive'.

        `kind` is one field over four vocabularies and the enum is their union,
        because `_build_call` is the layer that knows which one applies. A
        ledger scoped to the operation's own vocabulary would file every one of
        those shrugs as „somebody wanted a capability we lack", and drown the
        entries that mean it.
        """
        from aiq_agent.agents.bim import measure_register

        recorded: list[dict] = []
        monkeypatch.setattr(measure_register, "record_gap", lambda **kwargs: recorded.append(kwargs))

        parsed = measure_register.IfcMeasureInput(operation="element_profile", global_id="1kTv", kind="space")

        assert parsed.kind == "space"
        assert recorded == []

    @pytest.mark.parametrize(
        "field,written,canonical",
        [
            ("operation", "Briefing", "briefing"),
            ("kind", "Compactness", "compactness"),
            ("kind", "FLUCHTNIVEAU", "fluchtniveau"),
            ("room_kind", "Aufenthaltsraum", "aufenthaltsraum"),
            ("mode", "Horizontal", "horizontal"),
        ],
    )
    def test_the_case_the_tool_always_tolerated_is_still_tolerated(self, field, written, canonical):
        """`_build_call` lower-cases these four and case-folds the fire and
        envelope aspects, so kind='Compactness' has always been answered. A
        `Literal` is case-sensitive, and a schema that started refusing calls
        the tool used to answer would be this refactor breaking the very thing
        it exists to make cheaper."""
        from aiq_agent.agents.bim.measure_register import IfcMeasureInput

        arguments = {"operation": "envelope"} | {field: written}
        assert getattr(IfcMeasureInput(**arguments), field) == canonical

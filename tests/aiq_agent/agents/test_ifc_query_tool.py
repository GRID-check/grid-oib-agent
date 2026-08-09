"""The ``ifc_query`` tool's argument handling and rendering.

The tool is the seam where a language model's free-form intent becomes a typed
query. Two things can go wrong there and neither is visible from the endpoint's
own tests: a malformed argument silently becoming a query that means something
else, and a correct answer being rendered in a way that invites the model to
recompute it. Both are exercised here without a running frontend.
"""

from __future__ import annotations

import pytest

from aiq_agent.agents.bim.register import _build_query
from aiq_agent.agents.bim.register import _element_link
from aiq_agent.agents.bim.register import _render


def build(**overrides):
    defaults = dict(
        operation="overview",
        filters="",
        metric="count",
        quantity="",
        group_by="",
        global_id="",
        ifc_type="",
        limit=25,
    )
    defaults.update(overrides)
    return _build_query(**defaults)


class TestBuildQuery:
    def test_overview_and_types_need_nothing_else(self):
        assert build(operation="overview") == {"op": "overview"}
        assert build(operation="types") == {"op": "types"}

    def test_unknown_operation_is_refused_by_name(self):
        result = build(operation="count_walls")
        assert isinstance(result, str)
        assert "unknown operation" in result
        # The valid set is spelled out so the model can correct itself in one turn.
        assert "aggregate" in result

    def test_filters_are_parsed_from_json(self):
        result = build(operation="elements", filters='{"ifcTypes": ["IfcWall"]}')
        assert result == {"op": "elements", "filter": {"ifcTypes": ["IfcWall"]}, "limit": 25, "offset": 0}

    def test_malformed_filters_fail_loudly_rather_than_matching_everything(self):
        # Silently dropping an unparseable filter would turn "external walls on
        # the ground floor" into "every element in the building", and the count
        # would be confidently wrong.
        result = build(operation="elements", filters="ifcTypes=IfcWall")
        assert isinstance(result, str)
        assert "must be a JSON object" in result

    def test_a_json_list_is_not_a_filter_object(self):
        result = build(operation="elements", filters='["IfcWall"]')
        assert isinstance(result, str)
        assert "not a list" in result

    def test_element_requires_a_global_id(self):
        assert "needs a global_id" in build(operation="element")
        assert build(operation="element", global_id=" 0abc ") == {"op": "element", "globalId": "0abc"}

    def test_properties_may_be_narrowed_to_one_type(self):
        assert build(operation="properties") == {"op": "properties"}
        assert build(operation="properties", ifc_type="IfcWindow") == {
            "op": "properties",
            "ifcType": "IfcWindow",
        }

    def test_aggregate_defaults_to_a_count(self):
        assert build(operation="aggregate") == {"op": "aggregate", "filter": {}, "metric": "count", "limit": 25}

    def test_sum_without_a_quantity_is_refused(self):
        # `sum` over nothing would return null and read as "zero square metres".
        result = build(operation="aggregate", metric="sum")
        assert isinstance(result, str)
        assert "needs a 'quantity'" in result

    def test_sum_with_a_quantity_and_grouping(self):
        assert build(
            operation="aggregate",
            metric="sum",
            quantity="NetFloorArea",
            group_by="storey",
            filters='{"ifcTypes": ["IfcSpace"]}',
        ) == {
            "op": "aggregate",
            "filter": {"ifcTypes": ["IfcSpace"]},
            "metric": "sum",
            "quantity": "NetFloorArea",
            "groupBy": "storey",
            "limit": 25,
        }

    def test_compare_sends_no_model_id(self):
        # The endpoint resolves the other revision from `compare_with`; a UUID
        # carried through a conversation is a reliable hallucination source.
        assert build(operation="compare") == {"op": "compare", "limit": 20000}

    def test_unknown_metric_is_refused(self):
        assert "metric must be one of" in build(operation="aggregate", metric="median")

    @pytest.mark.parametrize("limit,expected", [(0, 1), (5, 5), (10_000, 200)])
    def test_limit_is_clamped(self, limit, expected):
        result = build(operation="elements", limit=limit)
        assert result["limit"] == expected


class TestRender:
    def test_an_unresolved_result_reports_the_reason_and_the_choices(self):
        rendered = _render(
            {
                "resolved": False,
                "reason": "ambiguous",
                "message": "Mehrere Modelle.",
                "models": [
                    {"filename": "haus-a.ifc", "status": "ready", "elements": 120},
                    {"filename": "haus-b.ifc", "status": "ready", "elements": 90},
                ],
            }
        )
        assert "Mehrere Modelle." in rendered
        assert "haus-a.ifc (ready, 120 Bauteile)" in rendered

    def test_an_unresolved_result_with_no_models_is_just_the_message(self):
        assert _render({"resolved": False, "message": "Kein Modell hinterlegt."}) == "Kein Modell hinterlegt."

    def test_the_summary_line_is_the_answer(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "aggregate",
                "model": {"filename": "haus-a.ifc"},
                "summary": "Erdgeschoss: 44.5 (2), Obergeschoss: 24.5 (2).",
                "groups": [],
            }
        )
        assert "Modell: haus-a.ifc" in rendered
        assert "Erdgeschoss: 44.5 (2)" in rendered

    def test_overview_adds_storeys_and_types_the_summary_cannot_carry(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "overview",
                "model": {"filename": "haus-a.ifc"},
                "summary": "Modell „Haus A“ (IFC4), 19 Bauteile.",
                "overview": {
                    "storeys": [{"name": "Erdgeschoss", "elementCount": 12}],
                    "typeCounts": {"IfcWall": 5, "IfcSpace": 4},
                },
            }
        )
        assert "Geschosse: Erdgeschoss (12 Bauteile)" in rendered
        assert "Bauteiltypen: IfcWall (5), IfcSpace (4)" in rendered

    def test_element_lists_carry_the_global_id_the_viewer_highlights_by(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "elements",
                "model": {"filename": "haus-a.ifc"},
                "summary": "1 Bauteil erfüllt die Abfrage.",
                "elements": [
                    {
                        "ifcType": "IfcWall",
                        "name": "Aussenwand Nord",
                        "storeyName": "Erdgeschoss",
                        "globalId": "0GridFixtureWall0001",
                    }
                ],
            }
        )
        assert "IfcWall „Aussenwand Nord“ · Erdgeschoss · GlobalId 0GridFixtureWall0001" in rendered

    def test_a_truncated_result_says_so(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "elements",
                "model": {"filename": "haus-a.ifc"},
                "summary": "500 Bauteile erfüllen die Abfrage, davon 25 aufgelistet.",
                "elements": [],
                "truncated": True,
            }
        )
        assert "Abfrage eingrenzen oder aggregieren" in rendered

    def test_a_comparison_lists_added_removed_and_changed_with_deltas(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "compare",
                "model": {"filename": "haus-a-v3.ifc"},
                "summary": "Vergleich: 1 neu, 1 entfallen, 1 geändert, 40 unverändert.",
                "comparison": {
                    "added": [{"ifcType": "IfcDoor", "name": "Fluchttuer", "storeyName": "Erdgeschoss"}],
                    "removed": [{"ifcType": "IfcWall", "name": "Innenwand alt", "storeyName": "Erdgeschoss"}],
                    "changed": [
                        {
                            "ifcType": "IfcWall",
                            "name": "Aussenwand Nord",
                            "changes": [{"field": "Pset_WallCommon.FireRating", "before": "REI 90", "after": "REI 30"}],
                        }
                    ],
                },
            }
        )
        assert "+ IfcDoor „Fluchttuer“ · Erdgeschoss" in rendered
        assert "- IfcWall „Innenwand alt“ · Erdgeschoss" in rendered
        assert "Pset_WallCommon.FireRating: REI 90 → REI 30" in rendered

    def test_the_property_catalog_shows_real_values_with_counts(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "properties",
                "model": {"filename": "haus-a.ifc"},
                "summary": "2 Merkmale im Modell.",
                "properties": [
                    {
                        "set": "Pset_WallCommon",
                        "name": "FireRating",
                        "source": "property",
                        "values": [{"value": "REI 90", "elements": 3}],
                    },
                    {
                        "set": "Qto_SpaceBaseQuantities",
                        "name": "NetFloorArea",
                        "source": "quantity",
                        "values": [{"value": "32", "elements": 1}],
                    },
                ],
            }
        )
        assert "[Merkmal] Pset_WallCommon.FireRating: REI 90 (3×)" in rendered
        assert "[Menge] Qto_SpaceBaseQuantities.NetFloorArea" in rendered


class TestElementLinks:
    """The path that turns a named element in an answer into a clickable chip.

    The frontend recognises exactly one shape (`features/bim/lib/model-link.ts`
    parses it, `element-question.ts` matches it), so these assertions are the
    Python half of a two-sided contract. A drifted parameter name here does not
    fail anything — it just quietly renders as a plain link that opens a model
    with nothing selected.
    """

    def test_the_path_matches_what_the_frontend_parses(self):
        assert _element_link("p1", "haus-a.ifc", "1kTvXnbbzCWw8lcMd1dR4o") == (
            "/app/projects/p1/model?model=haus-a.ifc&element=1kTvXnbbzCWw8lcMd1dR4o&hl=info%3A1kTvXnbbzCWw8lcMd1dR4o"
        )

    def test_a_space_in_the_file_name_is_encoded(self):
        # An unencoded space truncates the query string at the first parameter,
        # so the link would open the model with no element selected.
        assert "model=haus%20a.ifc" in _element_link("p1", "haus a.ifc", "g1")

    def test_no_project_or_no_element_yields_no_link(self):
        # Callers append the result unconditionally; an empty string is how this
        # says "there is nothing to link to" without producing a broken href.
        assert _element_link(None, "haus-a.ifc", "g1") == ""
        assert _element_link("p1", "haus-a.ifc", None) == ""

    def test_a_model_without_a_file_name_still_links_the_element(self):
        assert _element_link("p1", None, "g1") == "/app/projects/p1/model?element=g1&hl=info%3Ag1"

    def test_an_element_list_carries_a_link_per_row(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "elements",
                "model": {"filename": "haus-a.ifc"},
                "summary": "1 Bauteil erfüllt die Abfrage.",
                "elements": [
                    {
                        "ifcType": "IfcWall",
                        "name": "Aussenwand Nord",
                        "storeyName": "Erdgeschoss",
                        "globalId": "0GridFixtureWall0001",
                    }
                ],
            },
            "p1",
        )
        assert "Link: /app/projects/p1/model?model=haus-a.ifc&element=0GridFixtureWall0001" in rendered

    def test_one_element_carries_its_own_link(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "element",
                "model": {"filename": "haus-a.ifc"},
                "summary": "IfcWall „Aussenwand Nord“.",
                "element": {
                    "globalId": "0GridFixtureWall0001",
                    "storeyName": "Erdgeschoss",
                    "materials": [],
                    "properties": {},
                    "quantities": {},
                },
            },
            "p1",
        )
        assert "Link: /app/projects/p1/model?model=haus-a.ifc&element=0GridFixtureWall0001" in rendered

    def test_no_project_context_renders_no_link_line(self):
        # A session with no project cannot address a model page. Emitting a
        # path with an empty id would produce a link to a 404.
        rendered = _render(
            {
                "resolved": True,
                "op": "elements",
                "model": {"filename": "haus-a.ifc"},
                "summary": "1 Bauteil.",
                "elements": [{"ifcType": "IfcWall", "name": "W", "globalId": "g1"}],
            }
        )
        assert "Link:" not in rendered


class TestComplianceOperation:
    """The rule catalogue's tool surface.

    The catalogue's whole value rests on the third state — "nicht entscheidbar"
    — surviving the trip through the tool intact, and on a fact the agent did
    not supply being OMITTED rather than defaulted. A default Gebäudeklasse
    would turn a GK5 building's missing R 90 into a pass.
    """

    def test_compliance_takes_project_facts_not_element_filters(self):
        assert build(operation="compliance", gebaeudeklasse=4, hauptnutzung="Wohnen") == {
            "op": "compliance",
            "gebaeudeklasse": 4,
            "hauptnutzung": "wohnen",
        }

    def test_a_fact_that_was_not_supplied_is_omitted_rather_than_defaulted(self):
        # The rules that need it then stand down WITH their reason, which is the
        # honest outcome; a default would silently pick the mildest class.
        assert build(operation="compliance") == {"op": "compliance"}

    def test_an_out_of_range_gebaeudeklasse_is_dropped_not_clamped(self):
        # Clamping 9 to 5 would invent a requirement the project never stated.
        assert build(operation="compliance", gebaeudeklasse=9) == {"op": "compliance"}

    def test_compliance_ignores_filters_it_cannot_use(self):
        assert build(operation="compliance", filters='{"ifcTypes": ["IfcWall"]}', gebaeudeklasse=2) == {
            "op": "compliance",
            "gebaeudeklasse": 2,
        }

    def test_the_diff_operation_is_addressable(self):
        assert build(operation="compliance-diff")["op"] == "compliance-diff"

    def test_the_shopping_list_reaches_the_model_as_actions(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "compliance",
                "model": {"filename": "haus-a.ifc"},
                "summary": "OIB 2 3 — Tragende Bauteile: 0 erfüllt, 0 nicht erfüllt, 34 nicht entscheidbar",
                "complianceShoppingList": [
                    {
                        "path": "Pset_WallCommon.FireRating",
                        "elements": 34,
                        "rules": ["oib2-feuerwiderstand-tragend"],
                    }
                ],
            },
            "p1",
        )
        assert "fehlt: Pset_WallCommon.FireRating an 34 Bauteilen" in rendered

    def test_a_failing_element_carries_its_reading_and_its_link(self):
        rendered = _render(
            {
                "resolved": True,
                "op": "compliance",
                "model": {"filename": "haus-a.ifc"},
                "summary": "…",
                "compliance": [
                    {
                        "richtlinie": "OIB 4",
                        "failures": [
                            {
                                "globalId": "0GridFixtureDoor00001",
                                "name": "T-14",
                                "reading": "Breite 0.7 m — Schwellwert ≥ 0,80 m",
                            }
                        ],
                    }
                ],
            },
            "p1",
        )
        # The reading is what makes the row checkable, and the link is what
        # makes it fixable.
        assert "Breite 0.7 m — Schwellwert ≥ 0,80 m" in rendered
        assert "element=0GridFixtureDoor00001" in rendered

    def test_the_open_items_come_back_as_a_bcf_download(self):
        # The list of open requirements is the answer; the BCF file is what the
        # architect DOES with it, and a chat answer that cannot hand it over
        # leaves the loop open.
        rendered = _render(
            {
                "resolved": True,
                "op": "compliance",
                "model": {"filename": "Haus-A_V3.ifc"},
                "summary": "…",
                "compliance": [],
            },
            "p1",
            4,
            "wohnen",
        )
        assert (
            "BCF-Export der offenen Punkte: /api/projects/p1/bim/checks/export"
            "?model=Haus-A_V3.ifc&gebaeudeklasse=4&hauptnutzung=wohnen" in rendered
        )

    def test_the_bcf_link_carries_no_fact_the_run_did_not_have(self):
        # A Gebäudeklasse in the URL that the catalogue never applied would
        # build the archive against thresholds nobody chose.
        rendered = _render(
            {"resolved": True, "op": "compliance", "model": {"filename": "haus.ifc"}, "summary": "…"},
            "p1",
        )
        assert "/api/projects/p1/bim/checks/export?model=haus.ifc" in rendered
        assert "gebaeudeklasse" not in rendered
        assert "hauptnutzung" not in rendered

    def test_no_bcf_link_without_a_project_to_hang_it_on(self):
        rendered = _render(
            {"resolved": True, "op": "compliance", "model": {"filename": "haus.ifc"}, "summary": "…"},
            None,
        )
        assert "checks/export" not in rendered

    def test_only_the_compliance_operations_offer_the_export(self):
        # An element lookup that offered a compliance export would be inviting
        # the model to hand over a file for a question nobody asked.
        rendered = _render(
            {
                "resolved": True,
                "op": "elements",
                "model": {"filename": "haus.ifc"},
                "summary": "…",
                "elements": [],
            },
            "p1",
            4,
        )
        assert "checks/export" not in rendered

    def test_the_tool_description_tells_the_model_to_offer_the_file(self):
        from aiq_agent.agents.bim.register import _TOOL_DESCRIPTION

        assert "BCF-Export der offenen Punkte:" in _TOOL_DESCRIPTION
        # Naming the tools is what makes "BCF" mean something to the reader.
        assert "ArchiCAD, Revit, Solibri or BIMcollab" in _TOOL_DESCRIPTION

    def test_the_tool_description_forbids_declaring_the_building_compliant(self):
        from aiq_agent.agents.bim.register import _TOOL_DESCRIPTION

        assert "Never turn a compliance result into a statement that the building complies" in (_TOOL_DESCRIPTION)
        # And it must name what the catalogue cannot see, so the agent does not
        # present a partial check as a whole one.
        assert "Fluchtweglängen" in _TOOL_DESCRIPTION

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
                            "changes": [
                                {"field": "Pset_WallCommon.FireRating", "before": "REI 90", "after": "REI 30"}
                            ],
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

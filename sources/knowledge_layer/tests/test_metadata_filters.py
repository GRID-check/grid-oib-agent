"""Tests for the metadata-filter wiring in the LlamaIndex adapter (norm-registry Phase 0)."""

import pytest
from knowledge_layer.llamaindex.adapter import _filters_fingerprint
from knowledge_layer.llamaindex.adapter import _to_metadata_filters
from llama_index.core.vector_stores.types import FilterOperator


class TestToMetadataFilters:
    def test_none_and_empty_become_none(self):
        assert _to_metadata_filters(None) is None
        assert _to_metadata_filters({}) is None

    def test_bare_value_means_eq(self):
        result = _to_metadata_filters({"rank": "normativ"})

        assert result is not None
        assert len(result.filters) == 1
        assert result.filters[0].key == "rank"
        assert result.filters[0].operator == FilterOperator.EQ
        assert result.filters[0].value == "normativ"

    def test_explicit_operators(self):
        result = _to_metadata_filters(
            {
                "edition_status": {"$eq": "current"},
                "role": {"$nin": ["diff"]},
                "doc_id": {"$in": ["oib-rl-2", "oib-rl-3"]},
                "rank": {"$ne": "plan_parzelle"},
            }
        )

        assert result is not None
        ops = {f.key: f.operator for f in result.filters}
        assert ops == {
            "edition_status": FilterOperator.EQ,
            "role": FilterOperator.NIN,
            "doc_id": FilterOperator.IN,
            "rank": FilterOperator.NE,
        }
        values = {f.key: f.value for f in result.filters}
        assert values["role"] == ["diff"]
        assert values["doc_id"] == ["oib-rl-2", "oib-rl-3"]

    def test_multiple_fields_and_ed(self):
        result = _to_metadata_filters({"a": 1, "b": 2, "c": 3})

        assert result is not None
        assert len(result.filters) == 3

    def test_unknown_operator_fails_loud(self):
        with pytest.raises(ValueError, match="Unsupported metadata filter operator"):
            _to_metadata_filters({"rank": {"$regex": ".*"}})

    def test_non_mapping_value_passthrough_as_eq(self):
        result = _to_metadata_filters({"country": "at"})

        assert result is not None
        assert result.filters[0].operator == FilterOperator.EQ
        assert result.filters[0].value == "at"


class TestFiltersFingerprint:
    def test_empty_is_empty_string(self):
        assert _filters_fingerprint(None) == ""
        assert _filters_fingerprint({}) == ""

    def test_order_independent(self):
        first = _filters_fingerprint({"a": 1, "b": {"$in": [1, 2]}})
        second = _filters_fingerprint({"b": {"$in": [1, 2]}, "a": 1})

        assert first == second
        assert first != ""

    def test_distinguishes_values(self):
        assert _filters_fingerprint({"a": 1}) != _filters_fingerprint({"a": 2})


class TestNestedLogicalFilters:
    def test_or_group_translates_to_nested_or(self):
        from llama_index.core.vector_stores.types import FilterCondition

        result = _to_metadata_filters({"$or": [{"doc_id": "a"}, {"doc_id": "b"}]})

        assert result is not None
        assert result.condition == FilterCondition.AND
        assert len(result.filters) == 1
        or_group = result.filters[0]
        assert or_group.condition == FilterCondition.OR
        assert len(or_group.filters) == 2
        branch = or_group.filters[0]
        assert branch.filters[0].key == "doc_id"
        assert branch.filters[0].operator == FilterOperator.EQ

    def test_and_group_preserves_operators(self):
        result = _to_metadata_filters(
            {"$and": [{"role": {"$nin": ["diff"]}}, {"edition_status": {"$nin": ["superseded"]}}]}
        )

        nested = result.filters[0]
        keys = {(f.key, f.operator) for f in nested.filters}
        assert ("role", FilterOperator.NIN) in keys
        assert ("edition_status", FilterOperator.NIN) in keys

    def test_mixed_fields_and_or_group_are_anded(self):
        result = _to_metadata_filters(
            {
                "file_name": {"$nin": ["x.pdf"]},
                "$or": [{"edition_status": {"$ne": "superseded"}}, {"doc_id": "d", "edition": "e"}],
            }
        )

        assert len(result.filters) == 2
        assert result.filters[0].key == "file_name"
        or_group = result.filters[1]
        and_branch = or_group.filters[1]
        assert {f.key for f in and_branch.filters} == {"doc_id", "edition"}

    def test_unknown_operator_inside_nested_group_raises(self):
        with pytest.raises(ValueError, match="Unsupported metadata filter operator"):
            _to_metadata_filters({"$or": [{"role": {"$regex": "x"}}]})

    def test_fingerprint_covers_nested_structure(self):
        a = _filters_fingerprint({"$or": [{"doc_id": "a"}, {"doc_id": "b"}]})
        b = _filters_fingerprint({"$or": [{"doc_id": "b"}, {"doc_id": "a"}]})
        assert a != b

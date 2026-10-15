"""The backend-neutral filter grammar, as the store compiles it (``qdrant.scope.translate``).

Every caller (``knowledge_search``'s filters, ``read_passage``, the prefilter)
speaks one grammar; this pins what each shape means once it reaches Qdrant,
and that an unknown shape fails loud at the tool boundary instead of
silently over-retrieving. The server-side meaning of a compiled filter is
pinned in ``test_qdrant_store.py`` and ``test_page_chunk_exclusion.py``.
"""

import pytest
from knowledge_layer.llamaindex.adapter import _filters_fingerprint
from knowledge_layer.qdrant.scope import translate
from qdrant_client import models


def _conditions(flt: models.Filter) -> list[models.FieldCondition]:
    """Every field condition in ``flt``, depth first."""
    found: list[models.FieldCondition] = []
    for part in (flt.must or []) + (flt.should or []) + (flt.must_not or []):
        found.extend(_conditions(part) if isinstance(part, models.Filter) else [part])
    return found


class TestTranslate:
    def test_empty_raises(self):
        with pytest.raises(ValueError, match="empty group"):
            translate({})

    def test_bare_value_means_eq(self):
        flt = translate({"doc_class": "normativ"})

        (condition,) = flt.must
        assert condition.key == "doc_class"
        assert condition.match == models.MatchValue(value="normativ")

    def test_explicit_operators(self):
        flt = translate(
            {
                "richtlinie": {"$eq": "2"},
                "chunking": {"$nin": ["page"]},
                "file_name": {"$in": ["oib-rl-2.pdf", "oib-rl-3.pdf"]},
                "doc_class": {"$ne": "plan"},
            }
        )

        eq, nin, in_, ne = flt.must
        assert eq.must[0].match == models.MatchValue(value="2")
        assert nin.must_not[0].match == models.MatchAny(any=["page"])
        assert in_.must[0].match == models.MatchAny(any=["oib-rl-2.pdf", "oib-rl-3.pdf"])
        assert ne.must_not[0].match == models.MatchValue(value="plan")

    def test_multiple_fields_are_anded(self):
        flt = translate({"doc_class": "a", "richtlinie": "2", "chunking": "punkt"})

        assert len(flt.must) == 3 and not flt.should

    def test_unknown_operator_fails_loud(self):
        with pytest.raises(ValueError, match="Unsupported metadata filter condition"):
            translate({"doc_class": {"$regex": ".*"}})

    def test_unindexed_field_fails_loud(self):
        with pytest.raises(ValueError, match="not an indexed payload field"):
            translate({"rank": "normativ"})

    def test_nin_of_nothing_excludes_nothing(self):
        assert translate({"file_name": {"$nin": []}}).must_not == []


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
    def test_or_group_translates_to_should(self):
        flt = translate({"$or": [{"punkt_id": "a"}, {"punkt_id": "b"}]})

        assert len(flt.should) == 2
        assert [c.match.value for c in _conditions(flt)] == ["a", "b"]

    def test_and_group_preserves_operators(self):
        flt = translate({"$and": [{"chunking": {"$nin": ["page"]}}, {"doc_class": {"$nin": ["plan"]}}]})

        assert len(flt.must) == 2
        assert all(part.must_not for part in flt.must)
        assert {c.key for c in _conditions(flt)} == {"chunking", "doc_class"}

    def test_mixed_fields_and_or_group_are_anded(self):
        flt = translate(
            {
                "file_name": {"$nin": ["x.pdf"]},
                "$or": [{"doc_class": {"$ne": "plan"}}, {"punkt_id": "d", "richtlinie": "e"}],
            }
        )

        file_part, or_part = flt.must
        assert file_part.must_not[0].key == "file_name"
        assert {c.key for c in _conditions(or_part.should[1])} == {"punkt_id", "richtlinie"}

    def test_empty_logical_group_raises(self):
        with pytest.raises(ValueError, match="expects a non-empty list"):
            translate({"$or": []})

    def test_unknown_operator_inside_nested_group_raises(self):
        with pytest.raises(ValueError, match="Unsupported metadata filter condition"):
            translate({"$or": [{"doc_class": {"$regex": "x"}}]})

    def test_fingerprint_covers_nested_structure(self):
        a = _filters_fingerprint({"$or": [{"doc_id": "a"}, {"doc_id": "b"}]})
        b = _filters_fingerprint({"$or": [{"doc_id": "b"}, {"doc_id": "a"}]})
        assert a != b

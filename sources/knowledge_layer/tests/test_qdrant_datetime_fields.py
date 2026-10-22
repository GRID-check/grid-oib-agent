"""Datetime payload fields: their index, their coercion, their facts and the range filter on them.

No server needed. What a live collection does with the index (creation on an existing collection, a
range matching real points, a point without the field not matching) is not covered here.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.payload import as_rfc3339
from knowledge_layer.qdrant.payload import build_payload
from knowledge_layer.qdrant.payload import chunk_metadata
from knowledge_layer.qdrant.payload import chunk_own_payload
from knowledge_layer.qdrant.payload import coerce_field
from knowledge_layer.qdrant.payload import document_facts
from knowledge_layer.qdrant.scope import translate
from qdrant_client import models


def _document(**overrides):
    base = {
        "tags": [],
        "topics": [],
        "superseded_by": None,
        "doc_class": None,
        "folder_path": None,
        "revision_facts": None,
        "capture": None,
        "added_at": None,
    }
    return SimpleNamespace(**{**base, **overrides})


class TestSchema:
    def test_both_fields_are_datetime_indexed(self):
        assert schema.DATETIME_FIELDS == ("document_date", "added_at")
        assert set(schema.DATETIME_FIELDS) <= schema.INDEXED_FIELDS
        for field in schema.DATETIME_FIELDS:
            assert schema._field_schema(field) == models.PayloadSchemaType.DATETIME

    def test_ensure_payload_indexes_creates_the_datetime_indexes_on_a_live_collection(self):
        old_fields = schema.INDEXED_FIELDS - set(schema.DATETIME_FIELDS)
        client = MagicMock()
        client.get_collection.return_value.payload_schema = {name: MagicMock() for name in old_fields}

        created = schema.ensure_payload_indexes(client, "piloti_office_v1")

        assert created == sorted(schema.DATETIME_FIELDS)
        made = {call.args[1]: call.kwargs["field_schema"] for call in client.create_payload_index.call_args_list}
        assert made == {name: models.PayloadSchemaType.DATETIME for name in schema.DATETIME_FIELDS}


class TestCoercion:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("2026-01-31", "2026-01-31T00:00:00Z"),
            ("2026-01-31T10:00:00+02:00", "2026-01-31T08:00:00Z"),
            ("2026-01-31T10:00:00Z", "2026-01-31T10:00:00Z"),
            ("2026:01:31 10:15:00", "2026-01-31T10:15:00Z"),
        ],
    )
    def test_a_date_becomes_rfc3339_utc(self, raw, expected):
        assert as_rfc3339(raw) == expected
        assert coerce_field("document_date", raw) == expected

    @pytest.mark.parametrize("raw", ["", "  ", "Frühling 2026", "2026-13-40", 20260131, True, None])
    def test_an_unparsable_value_is_dropped_not_raised(self, raw):
        assert coerce_field("added_at", raw) is None

    def test_a_chunk_with_an_unparsable_date_is_written_without_it(self):
        record = ChunkRecord("c1", "Text", [0.1], {"file_name": "a.pdf"})
        payload = build_payload("proj_a", record, {"document_date": "bald", "added_at": "2026-02-01"})

        assert "document_date" not in payload
        assert payload["added_at"] == "2026-02-01T00:00:00Z"


class TestFacts:
    def test_title_block_date_beats_capture_date(self):
        facts = document_facts(
            _document(
                revision_facts={"revision_date": "2026-03-05"},
                capture={"captured_at": "2025-07-01T09:00:00", "latitude": 48.2},
                added_at="2026-04-01",
            )
        )

        assert facts["document_date"] == "2026-03-05T00:00:00Z"
        assert facts["added_at"] == "2026-04-01T00:00:00Z"

    def test_a_photo_falls_back_to_its_capture_time(self):
        facts = document_facts(_document(capture={"captured_at": "2025-07-01T09:00:00"}))

        assert facts["document_date"] == "2025-07-01T09:00:00Z"

    def test_a_mail_thread_is_dated_by_its_newest_message(self):
        """A filed E-Mail-Verlauf (ADR-0134): „the newest correspondence“ sorts by its last message."""
        facts = document_facts(_document(mail_thread={"latest_sent_at": "2026-05-14T14:40:00Z", "message_count": 5}))

        assert facts["document_date"] == "2026-05-14T14:40:00Z"

    def test_a_file_that_came_with_a_mail_keeps_its_own_date(self):
        """The day it was mailed is where it came from, not when it was written: no date of its own, none."""
        origin = {"sent_at": "2026-05-04T06:30:00Z", "sender_trust": "external_verified"}

        assert document_facts(_document(mail_origin=origin))["document_date"] is None
        dated = document_facts(_document(mail_origin=origin, revision_facts={"revision_date": "2026-03-05"}))
        assert dated["document_date"] == "2026-03-05T00:00:00Z"

    def test_an_unknown_date_is_stated_as_none_so_a_removed_one_is_cleared(self):
        facts = document_facts(_document(revision_facts={"revision_date": "unleserlich"}))

        assert facts["document_date"] is None
        assert facts["added_at"] is None

    def test_the_dates_are_the_stores_not_the_chunks(self):
        record = ChunkRecord("c1", "Text", [0.1], {"file_name": "a.pdf"})
        enriched = build_payload("proj_a", record, {"document_date": "2026-03-05", "added_at": "2026-04-01"})

        own = chunk_own_payload("proj_a", record)
        assert not set(schema.DATETIME_FIELDS) & set(own)
        assert not set(schema.DATETIME_FIELDS) & set(chunk_metadata(enriched))


class TestRangeFilter:
    def test_a_date_only_bound_compiles_to_a_datetime_range(self):
        (condition,) = translate({"document_date": {"$gte": "2026-01-01"}}).must[0:1] or []
        range_ = condition.must[0].range if isinstance(condition, models.Filter) else condition.range

        assert range_ == models.DatetimeRange(gte="2026-01-01T00:00:00Z")

    def test_a_closed_interval_on_added_at(self):
        flt = translate({"$and": [{"added_at": {"$gte": "2026-01-01"}}, {"added_at": {"$lt": "2026-02-01"}}]})

        ranges = []

        def walk(part):
            if isinstance(part, models.Filter):
                for child in (part.must or []) + (part.should or []):
                    walk(child)
            else:
                ranges.append(part.range)

        walk(flt)
        assert ranges == [
            models.DatetimeRange(gte="2026-01-01T00:00:00Z"),
            models.DatetimeRange(lt="2026-02-01T00:00:00Z"),
        ]

    def test_an_unreadable_date_raises_rather_than_matching_everything(self):
        with pytest.raises(ValueError, match="needs an ISO 8601 date"):
            translate({"document_date": {"$gte": "letztes Jahr"}})

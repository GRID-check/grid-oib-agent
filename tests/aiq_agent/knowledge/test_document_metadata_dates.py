"""``added_at`` is the upload day on the office's clock, not on UTC's.

``created_at`` is written by ``CURRENT_TIMESTAMP``: UTC, and naive on both
backends. Cutting its date directly filed an upload made at 00:30 in Vienna
under the day before, so `list_files(added_since=today)` missed it.
"""

from __future__ import annotations

from datetime import UTC
from datetime import date
from datetime import datetime
from datetime import timedelta
from datetime import timezone

import pytest

from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

iso_date = DocumentMetadataStore._iso_date


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # 23:30 UTC on 30 Sep is 01:30 on 1 Oct in Vienna (CEST, UTC+2).
        (datetime(2026, 9, 30, 23, 30), "2026-10-01"),
        ("2026-09-30 23:30:00", "2026-10-01"),
        ("2026-09-30 23:30:00.123456", "2026-10-01"),
        # Winter time: UTC+1, so 22:59 UTC is still the same day and 23:00 is not.
        ("2026-01-15 22:59:59", "2026-01-15"),
        ("2026-01-15 23:00:00", "2026-01-16"),
        # An aware value is converted, not re-labelled.
        (datetime(2026, 9, 30, 23, 30, tzinfo=UTC), "2026-10-01"),
        (datetime(2026, 10, 1, 1, 30, tzinfo=timezone(timedelta(hours=2))), "2026-10-01"),
        (datetime(2026, 9, 30, 12, 0), "2026-09-30"),
        (date(2026, 9, 30), "2026-09-30"),
        ("2026-09-30", "2026-09-30"),
        ("not a date", "not a date"),
        ("", None),
        (None, None),
    ],
)
def test_the_upload_day_is_read_on_the_vienna_clock(raw, expected):
    assert iso_date(raw) == expected

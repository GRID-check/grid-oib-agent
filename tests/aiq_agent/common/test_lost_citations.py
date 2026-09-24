"""A merged duplicate is not a lost citation.

September 2026 census: an answer listed "oib-rl_2 …, p.4" as [1] and [5] (two
Punkte on one page). Verification merged [5] into [1] correctly, then counted
the merge as a failure, which bought a 16-second repair rewrite and a
"Belege entfernt" note for a citation the reader still had.
"""

from __future__ import annotations

from aiq_agent.agents.piloti.ledger import citations_removed_summary
from aiq_agent.common.citation_verification import DUPLICATE_REASON_PREFIX
from aiq_agent.common.citation_verification import lost_citations

MERGED = {"number": 5, "line": "- [5] a.pdf, p.4", "reason": f"{DUPLICATE_REASON_PREFIX}1"}
LOST = {"number": 6, "line": "- [6] b.pdf, p.9", "reason": "citation_key_not_in_registry"}


def test_a_merged_duplicate_is_not_lost():
    assert lost_citations([MERGED]) == []
    assert lost_citations([MERGED, LOST]) == [LOST]


def test_the_reader_is_not_told_a_merge_removed_anything():
    assert citations_removed_summary([MERGED]) is None
    assert citations_removed_summary([MERGED, LOST]) == {"count": 1, "reasons": ["citation_key_not_in_registry"]}


def test_a_merge_does_not_trigger_the_repair_rewrite():
    from types import SimpleNamespace

    from aiq_agent.agents.piloti.answer_pipeline import _Verified

    verified = _Verified("x", SimpleNamespace(removed_citations=[MERGED]), ())
    assert verified.failure_count == 0


async def test_a_merge_alone_never_calls_the_repair():
    from unittest.mock import AsyncMock
    from unittest.mock import patch

    from aiq_agent.agents.piloti import answer_pipeline
    from aiq_agent.common.citation_verification import CitationVerificationResult
    from aiq_agent.common.citation_verification import SourceRegistry

    merged_only = CitationVerificationResult(verified_report="x [1]", removed_citations=[MERGED], valid_citations=[])
    repair = AsyncMock()
    with (
        patch.object(answer_pipeline, "verify_citations", return_value=merged_only),
        patch.object(answer_pipeline, "verify_quoted_spans", return_value=[]),
    ):
        await answer_pipeline._verify_with_repair("x [1] [5]", SourceRegistry(), repair, [])
    repair.assert_not_awaited()

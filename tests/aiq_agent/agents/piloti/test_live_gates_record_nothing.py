"""The live stream gates the masthead provisionally; only the finished answer records a drop."""

from __future__ import annotations

from unittest.mock import patch

from aiq_agent.agents.piloti import answer_pipeline
from aiq_agent.agents.piloti.answer_pipeline import LiveAnswer
from aiq_agent.common import answer_envelope
from aiq_agent.common.answer_envelope import SUMMARY_MAX_CHARS
from aiq_agent.common.answer_envelope import AnswerMeta
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

PROSE = "In GK 4 darf der Fluchtweg höchstens 40 m lang sein [1]."
SOURCES = "**Quellen:**\n- [1] oib-rl_2.pdf, p.12"
FIELDS = {"kind": "direct", "summary": "Zu lang. " * (SUMMARY_MAX_CHARS // 4)}


def _registry() -> SourceRegistry:
    registry = SourceRegistry()
    registry.add(
        SourceEntry(
            citation_key="oib-rl_2.pdf, p.12",
            chunk_text="In Gebäudeklasse 4 darf der Fluchtweg höchstens 40 m lang sein.",
            source_type="knowledge_layer",
        )
    )
    return registry


def test_the_live_masthead_and_settle_record_no_drop_and_the_finished_answer_records_one():
    registry = _registry()
    live = LiveAnswer(registry)
    with patch.object(answer_envelope, "emit_anatomy_dropped") as emitted:
        live.masthead(FIELDS)
        settled = live.settle(PROSE, SOURCES, FIELDS)
        assert settled is not None  # the settle did gate the masthead again
        assert emitted.call_count == 0

        extracted = answer_pipeline._Extracted(
            content=PROSE + "\n\n" + SOURCES,
            meta=AnswerMeta.model_validate(FIELDS),
            escalation_requested=False,
            confidence=None,
            confidence_reason=None,
        )
        answer_pipeline._gated_meta(extracted, extracted.content, registry, turn_sources=[])
    emitted.assert_called_once_with(field="summary", reason="too_long")

"""ADR-0064 use 7: a correction the writer did not quote is found by a yes/no per digest entry."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

import aiq_agent.knowledge.project_memory as pm
import aiq_agent.project_context as pc
from aiq_agent.common.decisions import Decision
from aiq_agent.memory import reflection as R
from aiq_agent.memory import supersede
from aiq_agent.memory.register import ProjectMemoryRememberConfig
from aiq_agent.memory.register import project_memory_remember

DIGEST = "\n".join(
    [
        "PROJECT_MEMORY v1",
        '- [constraint | high | agent] "Das Projekt liegt in Wien, 14. Bezirk."',
        '- [decision | high | agent] "Der Bauherr sagte \\"Flachdach\\"."',
        '- [org-wide | preference | high | human] "Antworten immer mit Tabelle."',
        "(+3 weitere Notizen zu diesem Projekt, hier nicht gezeigt)",
    ]
)


def _answers(by_entry: dict[str, float]):
    async def fake(states, questions, **kwargs):
        return [
            Decision(answers={"replaces": {"type": "noul", "noul": by_entry.get(s["existing_entry"], 0.05)}})
            for s in states
        ]

    return fake


class TestTheDigestIsReadBack:
    def test_project_entries_unescaped_and_org_wide_ones_left_out(self):
        assert supersede.digest_entries(DIGEST) == [
            "Das Projekt liegt in Wien, 14. Bezirk.",
            'Der Bauherr sagte "Flachdach".',
        ]

    def test_no_digest_no_entries(self):
        assert supersede.digest_entries(None) == []


class TestTheDecision:
    async def test_a_confident_contradiction_names_the_whole_entry(self):
        with patch("aiq_agent.common.decisions.decide_many", _answers({"Das Projekt liegt in Wien, 14. Bezirk.": 0.8})):
            quote = await supersede.decided_supersedes(
                "Das Grundstück liegt in St. Pölten.", DIGEST, organization_id="o1"
            )
        assert quote == "Das Projekt liegt in Wien, 14. Bezirk."

    async def test_below_the_threshold_nothing_is_retired(self):
        with patch("aiq_agent.common.decisions.decide_many", _answers({"Das Projekt liegt in Wien, 14. Bezirk.": 0.6})):
            assert await supersede.decided_supersedes("Neu.", DIGEST, organization_id=None) is None

    async def test_no_decision_retires_nothing(self):
        async def none(states, questions, **kwargs):
            return [None] * len(states)

        with patch("aiq_agent.common.decisions.decide_many", none):
            assert await supersede.decided_supersedes("Neu.", DIGEST, organization_id=None) is None

    async def test_the_writers_own_quote_wins_and_is_not_asked(self):
        asked = AsyncMock()
        with patch("aiq_agent.common.decisions.decide_many", asked):
            assert await supersede.supersedes_for("Neu.", "Alt.", DIGEST, organization_id=None) == "Alt."
        asked.assert_not_called()

    async def test_a_failure_is_no_quote(self):
        with patch("aiq_agent.common.decisions.decide_many", AsyncMock(side_effect=RuntimeError)):
            assert await supersede.supersedes_for("Neu.", "", DIGEST, organization_id=None) is None


class TestBothWritersSendIt:
    async def test_reflection_sends_the_decided_quote(self, monkeypatch):
        recorded = []
        monkeypatch.setattr(R, "insert_memory_item", lambda **k: (recorded.append(k), "id-1")[1])
        monkeypatch.setattr(supersede, "decided_supersedes", AsyncMock(return_value="Das Projekt liegt in Wien."))
        finding = R._ReflectionFinding(
            kind="constraint", content="Das Grundstück liegt in St. Pölten.", confidence="high", importance=8
        )
        await R._write_finding(
            finding, project_id="p1", organization_id="o1", conversation_id="c1", memory_digest=DIGEST
        )
        assert recorded[0]["supersedes_content"] == "Das Projekt liegt in Wien."

    @pytest.mark.parametrize(("scope", "asked"), [("project", True), ("organization", False)])
    async def test_the_remember_tool_asks_only_for_a_project_write(self, monkeypatch, scope, asked):
        monkeypatch.setattr(pc, "get_project_id_from_context", lambda: "p1")
        monkeypatch.setattr(pc, "get_organization_id_from_context", lambda: "o1")
        monkeypatch.setattr(pc, "get_conversation_id_from_context", lambda: "c1")
        monkeypatch.setattr(pc, "get_memory_digest_from_context", lambda: DIGEST)
        decided = AsyncMock(return_value="Das Projekt liegt in Wien, 14. Bezirk.")
        monkeypatch.setattr(supersede, "decided_supersedes", decided)
        insert = MagicMock(return_value="item-1")
        monkeypatch.setattr(pm, "insert_memory_item", insert)
        async with project_memory_remember(ProjectMemoryRememberConfig(), MagicMock()) as info:
            await info.single_fn(
                info.input_schema(kind="constraint", content="Das Grundstück liegt in St. Pölten.", scope=scope)
            )
        assert decided.await_count == (1 if asked else 0)
        if asked:
            assert insert.call_args.kwargs["supersedes_content"] == "Das Projekt liegt in Wien, 14. Bezirk."

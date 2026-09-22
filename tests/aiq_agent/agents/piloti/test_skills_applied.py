"""The envelope's ``skills_applied`` reaches the skill runtime, and nothing else.

The pipeline lifts the names, the ledger carries them onto the state, and the
register hands them to the runtime AFTER the run — the runtime decides which
are real (only a body it inlined), and ``skills_activated`` is what it says.
"""

from __future__ import annotations

import json
from unittest.mock import patch

from langchain_core.messages import AIMessage

from aiq_agent.agents.piloti.answer_pipeline import FinalAnswer
from aiq_agent.agents.piloti.answer_pipeline import finalize_answer
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.register import _report_skills
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.skills.models import Skill
from aiq_agent.skills.runtime import SkillRuntime

PROSE = "x" * 900 + " Die Antwort [1].\n\n## References\n- [1] https://example.com"


def _envelope(**meta) -> AIMessage:
    return AIMessage(content="```answer_json\n" + json.dumps({"answer": PROSE, **meta}, ensure_ascii=False) + "\n```")


def _sources() -> SourceRegistry:
    registry = SourceRegistry()
    registry.add(SourceEntry(url="https://example.com", tool_name="web"))
    return registry


async def test_the_pipeline_lifts_the_names_cleaned_and_deduped():
    final = await finalize_answer(
        [_envelope(skills_applied=["`brandschutz`", " gebaeudeklasse", "brandschutz"])],
        registry=_sources(),
        tools=[],
        repair=None,
    )
    assert final.skills_applied == ("brandschutz", "gebaeudeklasse")


async def test_no_field_is_no_names():
    final = await finalize_answer([_envelope()], registry=_sources(), tools=[], repair=None)
    assert final.skills_applied == ()


def test_the_ledger_carries_them_onto_the_state():
    final = FinalAnswer(messages=[AIMessage(content="a")], answered=True, content="a", skills_applied=("kurz",))
    result = assemble_result({"messages": []}, final, turn_sources=(), turn_measurements=())
    assert result.skills_applied == ["kurz"]
    empty = FinalAnswer(messages=[AIMessage(content="a")], answered=True, content="a")
    assert assemble_result({"messages": []}, empty, turn_sources=(), turn_measurements=()).skills_applied is None


def test_the_register_reports_what_the_runtime_accepted():
    """Two inlined, one behind `use_skill`; the model names one of each and a
    fiction. Activated is the inlined one it named, and only that."""
    kurz = Skill(name="kurz", description="k", body="kurz body", origin="platform")
    zwei = Skill(name="zwei", description="z", body="zwei body", origin="platform")
    lang = Skill(name="lang", description="l", body="x" * 5000, origin="org")
    runtime = SkillRuntime(skills=(kurz, zwei, lang), inline_max_body_chars=100, inline_budget_chars=1000)
    with patch("aiq_agent.skills.events.push_custom_step"):
        result = ResearchAgentState(messages=[], skills_applied=["zwei", "lang", "nope"])
        _report_skills(result, runtime)
    assert result.skills_activated == ["zwei"]

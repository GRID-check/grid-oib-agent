"""The report's anatomy and findings, read off the finished report post hoc."""

import json

import pytest
from langchain_core.messages import AIMessage

from aiq_agent.agents.deep_researcher.anatomy import extract_report_anatomy

REPORT = (
    "REI 60 gilt für tragende Bauteile in GK 4 [1].\n\n## Brandschutz\n\n"
    + ("Lange Herleitung. " * 80)
    + "\n\n## Quellen\n[1] oib-rl_2.pdf, p.12\n"
)

DRAFT = {
    "kind": "ruling",
    "summary": "REI 60, weil GK 4; im Kellergeschoß REI 90.",
    "topic": "Feuerwiderstand tragender Bauteile",
    "context": "OIB-RL 2, Ausgabe Mai 2023 · GK 4",
    "verdict": {
        "value": "REI 60",
        "subject": "Feuerwiderstand tragender Bauteile",
        "reference": {"document": "OIB-Richtlinie 2", "section": "Tabelle 1b", "page": 12},
    },
    "takeaways": [
        {"text": "Tragende Bauteile brauchen REI 60.", "detail": "Tabelle 1b."},
        {"text": "Im Keller gilt REI 90.", "detail": None},
    ],
    "callout": {"kind": "achtung", "text": "Wien weicht bei Stiegenhäusern ab.", "title": None, "detail": None},
    "findings": [
        {
            "requirement": "Feuerwiderstand tragender Bauteile",
            "value": "REI 60",
            "status": "erfuellt",
            "grounding": "belegt",
            "reference": {"document": "OIB-Richtlinie 2", "section": "Tabelle 1b", "page": 12},
            "citations": [1],
            "comment": None,
            "area": "Brandschutz",
        }
    ],
}


class _Llm:
    def __init__(self, content, *, strict_fails=False):
        self.content = content
        self.strict_fails = strict_fails
        self.calls = 0

    def bind(self, **_):
        if self.strict_fails:
            raise RuntimeError("no strict mode")
        return self

    async def ainvoke(self, messages):
        self.calls += 1
        return AIMessage(content=self.content)


@pytest.mark.asyncio
async def test_the_masthead_and_the_findings_come_off_one_call():
    llm = _Llm(json.dumps(DRAFT))
    anatomy = await extract_report_anatomy(llm, "Welche Feuerwiderstandsklasse gilt?", REPORT)
    assert not anatomy.failed
    assert anatomy.answer_meta is not None
    assert anatomy.answer_meta["verdict"]["value"] == "REI 60"
    assert anatomy.answer_meta["summary"].startswith("REI 60")
    assert len(anatomy.answer_meta["takeaways"]) == 2
    assert anatomy.findings is not None
    assert anatomy.findings["items"][0]["status"] == "erfuellt"
    assert llm.calls == 1


@pytest.mark.asyncio
async def test_a_walkthrough_carries_no_verdict_even_if_the_model_wrote_one():
    draft = {**DRAFT, "kind": "walkthrough"}
    anatomy = await extract_report_anatomy(_Llm(json.dumps(draft)), "q", REPORT)
    assert anatomy.answer_meta is not None
    assert "verdict" not in anatomy.answer_meta


@pytest.mark.asyncio
async def test_a_fenced_answer_and_a_provider_without_strict_mode_still_parse():
    llm = _Llm("```json\n" + json.dumps(DRAFT) + "\n```", strict_fails=True)
    anatomy = await extract_report_anatomy(llm, "q", REPORT)
    assert anatomy.findings is not None


@pytest.mark.asyncio
async def test_garbage_is_a_failure_the_runner_can_tell_from_nothing_found():
    anatomy = await extract_report_anatomy(_Llm("not json"), "q", REPORT)
    assert anatomy.failed and anatomy.answer_meta is None and anatomy.findings is None


@pytest.mark.asyncio
async def test_no_findings_is_none_not_an_empty_list():
    draft = {**DRAFT, "findings": []}
    anatomy = await extract_report_anatomy(_Llm(json.dumps(draft)), "q", REPORT)
    assert anatomy.findings is None and anatomy.answer_meta is not None


@pytest.mark.asyncio
async def test_no_llm_or_no_report_is_a_quiet_nothing():
    assert (await extract_report_anatomy(None, "q", REPORT)).failed is False
    assert (await extract_report_anatomy(_Llm("{}"), "q", "   ")).answer_meta is None

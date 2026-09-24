"""Which rewrite the one repair pass may put in place of the verified answer."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aiq_agent.agents.piloti import answer_pipeline
from aiq_agent.agents.piloti.answer_pipeline import _adopt_if_better
from aiq_agent.agents.piloti.answer_pipeline import _Verified
from aiq_agent.agents.piloti.repair import Repair
from aiq_agent.common.citation_verification import SourceRegistry


def _cite(key: str) -> dict:
    return {"citation_key": key, "number": 1}


ORIGINAL = _Verified(
    content="Neun Quellen, eine davon falsch zitiert.",
    verification=SimpleNamespace(
        valid_citations=[_cite(f"oib-rl_2.pdf, p.{page}") for page in range(1, 10)],
        removed_citations=[{"citation_key": "oib-rl_2.pdf, p.99", "reason": "not_found"}],
    ),
    unverified_quotes=(),
)


def _rewrite(monkeypatch: pytest.MonkeyPatch, valid: list[dict]) -> None:
    monkeypatch.setattr(
        answer_pipeline,
        "verify_citations",
        lambda prose, registry, reference_sources=None: SimpleNamespace(
            verified_report=prose, valid_citations=valid, removed_citations=[]
        ),
    )
    monkeypatch.setattr(answer_pipeline, "verify_quoted_spans", lambda report, registry: [])


def test_a_rewrite_that_drops_most_of_its_sources_is_not_better(monkeypatch):
    # Zero failures, but by citing two sources instead of nine: the answer the
    # reader already read is the better one (ADR-0066).
    _rewrite(monkeypatch, [_cite("oib-rl_2.pdf, p.1"), _cite("oib-rl_2.pdf, p.2")])

    assert _adopt_if_better(ORIGINAL, Repair(prose="Kurz.", sources=[]), SourceRegistry()) is None


def test_a_rewrite_that_fixes_the_failure_and_keeps_its_sources_is_adopted(monkeypatch):
    _rewrite(monkeypatch, [_cite(f"oib-rl_2.pdf, p.{page}") for page in range(1, 10)])

    adopted = _adopt_if_better(ORIGINAL, Repair(prose="Neun Quellen, alle belegt.", sources=[]), SourceRegistry())

    assert adopted is not None
    assert adopted.content == "Neun Quellen, alle belegt."

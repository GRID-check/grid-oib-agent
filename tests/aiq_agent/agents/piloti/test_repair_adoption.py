"""Which rewrite the one repair pass may put in place of the verified answer."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aiq_agent.agents.piloti import answer_pipeline
from aiq_agent.agents.piloti.answer_pipeline import _adopt_if_better
from aiq_agent.agents.piloti.answer_pipeline import _Verified
from aiq_agent.agents.piloti.repair import Repair
from aiq_agent.cards.models import SURFACE_TEXT
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry


def _cited(number: int):
    return answer_pipeline.CitedSource(SourceEntry(citation_key=f"s{number}.pdf, p.1"), number)


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


def test_a_card_keeps_citing_its_source_through_an_adopted_rewrite(monkeypatch):
    # The original cites A as [1], B as [2], C as [3]; the rewrite drops B and
    # calls C [2]. A card written against the original says "[3]" for C: read
    # against the rewrite's list it would vanish, or with a third source land
    # on the wrong one. It must become [2], and B's [2] must go.
    before = _Verified(
        content="A [1], B [2], C [3].",
        verification=SimpleNamespace(
            valid_citations=[
                {"citation_key": "a.pdf, p.1", "number": 1},
                {"citation_key": "b.pdf, p.1", "number": 2},
                {"citation_key": "c.pdf, p.1", "number": 3},
            ],
            removed_citations=[{"citation_key": "x.pdf, p.1", "reason": "not_found"}],
        ),
        unverified_quotes=(),
    )
    _rewrite(
        monkeypatch,
        [
            {"citation_key": "a.pdf, p.1", "number": 1},
            {"citation_key": "c.pdf, p.1", "number": 2},
            {"citation_key": "d.pdf, p.1", "number": 3},
        ],
    )

    adopted = _adopt_if_better(before, Repair(prose="A [1], C [2], D [3].", sources=[]), SourceRegistry())

    assert adopted is not None and adopted.rewrite_numbers == {1: 1, 3: 2}
    card = {"type": "surface", "components": [{"component": SURFACE_TEXT, "text": "A [1], B [2], C [3]."}]}
    registry = CardRegistry()
    registry.add(card)
    token = set_card_registry(registry)
    try:
        answer_pipeline._recite_surface_cards({}, (_cited(1), _cited(2), _cited(3)), adopted.rewrite_numbers)
    finally:
        reset_card_registry(token)
    assert registry.snapshot()[0]["components"][0]["text"] == "A [1], B, C [2]."

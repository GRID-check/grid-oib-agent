"""A card the deep run EMITS reaches the job result, beside the post-hoc ones, at the index it was addressed by.

Module under test: ``aiq_api.jobs.runner`` — ``_bound_card_registry``, ``_merge_job_cards``
and the ``_build_job_output`` they feed.

Until now the runner never bound a ``CardRegistry`` around the deep run, so
``emit_card`` and ``surface_documents`` inside a job answered "no card channel"
and a deep answer never showed a document card. These tests drive the same
three steps the runner takes — bind, run, merge — with a fake agent that emits
through the registry the way the real tools do.
"""

from __future__ import annotations

import pytest

from aiq_agent.cards.registry import get_card_registry
from aiq_api.jobs.runner import _bound_card_registry
from aiq_api.jobs.runner import _build_job_output
from aiq_api.jobs.runner import _merge_job_cards
from aiq_api.jobs.runner import _run_agent

DOCUMENT_GRID = {"type": "document_grid", "title": "Brandschutzplan.pdf", "query": "Brandschutzplan", "documents": []}
SUMMARY = {"type": "summary", "title": "Kurzfassung"}
LEGAL_BASIS = {"type": "legal_basis", "title": "OIB-Richtlinie 2", "lane": "oib"}


class _EmittingAgent:
    """Runs like ``surface_documents`` does: pushes a card into whatever registry is bound."""

    def __init__(self, cards: list[dict]) -> None:
        self._cards = cards
        self.saw_registry: bool | None = None

    async def run(self, input_text: str) -> str:
        registry = get_card_registry()
        self.saw_registry = registry is not None
        if registry is not None:
            for card in self._cards:
                registry.add(card)
        return f"# Bericht zu {input_text}"


class _NeverCancels:
    """The ``CancellationMonitor`` surface ``run_with_cancellation`` drives.

    Going through the real ``_run_agent`` matters: it runs the agent in a
    CHILD task (``asyncio.create_task``), which is exactly the hop a
    ``ContextVar`` binding has to survive for the tool to find the registry.
    """

    is_cancelled = False

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass


@pytest.mark.asyncio
async def test_a_card_emitted_during_the_deep_run_lands_in_the_job_output_before_generated_cards():
    """The whole point, end to end through the runner's own helpers."""
    agent = _EmittingAgent([DOCUMENT_GRID])

    with _bound_card_registry() as registry:
        report = await _run_agent(agent, "Brandschutz", _NeverCancels())
    cards = _merge_job_cards(registry.snapshot(), [SUMMARY, LEGAL_BASIS])
    output = _build_job_output(report, cards=cards, transparency={}, sources=None)

    assert agent.saw_registry is True
    # Index 0 is the card the model addressed as [[card:1]] during the run.
    assert output["cards"] == [DOCUMENT_GRID, SUMMARY, LEGAL_BASIS]


def test_emitted_cards_keep_their_emission_index_whatever_the_generator_adds():
    """``[[card:N]]`` resolves positionally: the N-th emitted card must stay N-th."""
    first = {"type": "document_grid", "title": "1"}
    second = {"type": "document_grid", "title": "2"}

    merged = _merge_job_cards([first, second], [SUMMARY])

    assert merged is not None
    assert merged[0] is first
    assert merged[1] is second
    assert merged[2] is SUMMARY


def test_nothing_emitted_and_nothing_generated_is_absent_not_empty():
    """No ``cards`` key for ``None``: a run that made none is not a run with an empty list."""
    assert _merge_job_cards([], None) is None
    assert _merge_job_cards([], []) is None
    assert "cards" not in _build_job_output("r", cards=_merge_job_cards([], None), transparency={}, sources=None)


def test_generated_cards_alone_are_unchanged():
    """The pre-existing post-hoc path: no emission, the generator's order stands."""
    assert _merge_job_cards([], [SUMMARY, LEGAL_BASIS]) == [SUMMARY, LEGAL_BASIS]


def test_the_registry_is_fresh_per_run_and_unbound_afterwards():
    """Per-job state, not module state: nothing leaks into the next job this worker runs."""
    assert get_card_registry() is None
    with _bound_card_registry() as first:
        assert get_card_registry() is first
        first.add(DOCUMENT_GRID)
    assert get_card_registry() is None
    with _bound_card_registry() as second:
        assert second is not first
        assert len(second) == 0
    assert get_card_registry() is None


def test_the_registry_is_unbound_when_the_run_raises():
    with pytest.raises(RuntimeError):
        with _bound_card_registry():
            raise RuntimeError("wall clock")
    assert get_card_registry() is None

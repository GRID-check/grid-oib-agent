"""A named § costs no model call at all.

"Was verlangt § 63 BO Wien?" is an ADDRESS, and an address is resolved by
reading, not by inference. The whole reason the address stage runs first is
that a question carrying a § skips both internal LLM calls — the search planner
(the catalog already knows where the Bauordnung is) and the § picker (the
grammar already knows which paragraph § 63 is).

If this test ever needs a picker mock to pass, the tool started paying for a
model to find a number it was handed.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio


async def test_a_named_paragraph_makes_no_picker_call(lookup, catalog, monkeypatch):
    from tests.conftest import FakePicker  # noqa: PLC0415 — the doubles live beside the fixtures

    picker = FakePicker("§ 75")
    lookup.with_llms(monkeypatch, picker=picker)

    output = await lookup.run(question="Was verlangt § 63 BO Wien?", instrument="BO Wien")

    assert picker.calls == [], "the § was named; nothing should have asked a model which § to read"
    assert "Punkt: §63" in output
    assert "Dem Ansuchen um Baubewilligung" in output


async def test_a_named_paragraph_makes_no_planner_call_either(lookup, catalog, monkeypatch):
    """The catalog answers, so no live search is planned and none is run."""
    from tests.conftest import FakePlanner

    planner = FakePlanner()
    lookup.with_llms(monkeypatch, planner=planner)

    await lookup.run(question="Was verlangt § 63 BO Wien?", instrument="BO Wien")

    assert planner.calls == []
    assert lookup.client.search_calls == []


async def test_the_paragraph_comes_back_with_its_absaetze(lookup, catalog):
    output = await lookup.run(question="Was verlangt § 63 BO Wien?", instrument="BO Wien")

    body = lookup.body_of(output)
    assert "(1) Dem Ansuchen" in body
    assert "(2) Die Baupläne" in body
    assert "(3) Die Behörde" in body
    # …and nothing from the next §.
    assert "Bauverhandlung anzuberaumen" not in body


async def test_only_the_named_paragraph_comes_back(lookup, catalog):
    """One § asked for, one § returned — not the law."""
    output = await lookup.run(question="Wie hoch darf das Gebäude sein? § 75", instrument="BO Wien")

    assert output.count("--- Result ") == 1
    assert "Punkt: §75" in output
    assert "Bauklasse" in output


async def test_a_pasted_ris_url_is_an_address_and_needs_no_search(lookup, monkeypatch):
    """No catalog, no live search: the caller already said which document."""
    from tests.conftest import FakePlanner

    planner = FakePlanner()
    lookup.with_llms(monkeypatch, planner=planner)

    output = await lookup.run(question="Was verlangt § 63?", instrument=lookup.WIEN_URL)

    assert planner.calls == []
    assert lookup.client.search_calls == []
    assert lookup.client.fetch_calls == [lookup.WIEN_URL]
    assert "Punkt: §63" in output

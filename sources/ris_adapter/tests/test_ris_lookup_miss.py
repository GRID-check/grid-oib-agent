"""Four ways to find nothing, four things to say. None of them is empty.

An empty tool result is the one output that reliably produces an invented
citation: the model has a question, no evidence, and nothing telling it what to
do instead. Each shape below gets its own vocabulary, and each ends in one
concrete retry.
"""

from __future__ import annotations

import pytest
from ris_adapter.client import RisHit
from ris_adapter.client import RisSearchResult

pytestmark = pytest.mark.asyncio


async def test_nothing_matched_anywhere_still_says_what_was_searched(lookup, monkeypatch):
    """No catalog entry, no live hit: the miss names the terms and the Land."""
    from tests.conftest import FakePlanner

    lookup.with_llms(monkeypatch, planner=FakePlanner(suchworte="Stellplatzverpflichtung"))

    output = await lookup.run(question="Wie viele Stellplätze?", jurisdiction="Wien")

    assert output.strip()
    assert "'Stellplatzverpflichtung'" in output, "the model must see the rewrite it did not write"
    assert "Assumed Bundesland: Wien (from jurisdiction argument)." in output
    assert "Retry once" in output


async def test_an_unresolved_bundesland_is_the_first_thing_the_retry_asks_for(lookup):
    output = await lookup.run(question="Was verlangt die Bauordnung?")

    assert "No Bundesland was resolved" in output
    assert "Retry once: name the Bundesland" in output


async def test_a_catalog_entry_with_no_full_text_is_named_and_not_invented(lookup, catalog):
    """The catalog's own honest case: the norm exists, its text is not in RIS."""
    from tests.conftest import norm_entry

    catalog(
        norm_entry(
            id="oenorm-b-1300",
            title="ÖNORM B 1300",
            short="B 1300",
            application="",
            document_number="",
            citation_url="",
            full_law_url="",
            bundesland="",
            topics=["bauordnung", "objektsicherheit"],
        )
    )

    output = await lookup.run(question="Was verlangt die Bauordnung zur Objektsicherheit?", jurisdiction="Wien")

    assert "Matched but not read:" in output
    assert "ÖNORM B 1300" in output
    assert "Not in RIS - no accessible full text (reference only, say so openly)" in output


async def test_a_web_only_catalog_entry_hands_the_web_tool_its_next_move(lookup, catalog):
    from tests.conftest import norm_entry

    catalog(
        norm_entry(
            id="ma37-merkblatt",
            title="MA 37 Merkblatt Einreichung",
            short="MA 37",
            application="",
            document_number="",
            citation_url="",
            full_law_url="",
            source_url="https://www.wien.gv.at/merkblatt",
            bundesland="Wien",
            topics=["bauordnung", "einreichung"],
        )
    )

    output = await lookup.run(question="Was verlangt die Bauordnung bei der Einreichung?", jurisdiction="Wien")

    assert "Not in RIS - web source: https://www.wien.gv.at/merkblatt" in output


async def test_a_document_that_was_read_but_answers_nothing_returns_its_index(lookup, catalog, monkeypatch):
    """The RIS twin of `read_passage`'s Gliederung — labelled as an index."""
    from tests.conftest import FakePicker

    # The picker names no §: nothing in the table of contents answers this.
    lookup.with_llms(monkeypatch, picker=FakePicker())

    output = await lookup.run(question="Was sagt die Bauordnung zur Grunderwerbsteuer?", jurisdiction="Wien")

    assert lookup.client.fetch_calls == [lookup.WIEN_URL], "the law was read; it just answers nothing"
    assert "INDEX, not evidence" in output
    assert "§ 63 — Bauansuchen" in output
    assert "Citation:" not in output, "an index is not evidence and must carry no citation key"


async def test_a_named_paragraph_the_law_does_not_have_is_a_miss_not_a_guess(lookup, catalog):
    output = await lookup.run(question="Was verlangt § 999?", instrument="BO Wien")

    assert "No RIS passage answered" in output
    assert "Citation:" not in output


async def test_a_failed_live_search_is_a_miss_with_a_retry_not_an_exception(lookup, monkeypatch):
    from ris_adapter.client import RisError

    from tests.conftest import FakePlanner

    lookup.with_llms(monkeypatch, planner=FakePlanner())
    lookup.client.search_result = RisError("OGD-RIS API error: Seitennummer zu hoch")

    output = await lookup.run(question="Was verlangt die Bauordnung?", jurisdiction="Wien")

    assert "No RIS passage answered" in output
    assert "Retry once" in output


async def test_a_live_hit_that_cannot_be_fetched_is_named_as_unread(lookup, monkeypatch):
    """The fetch failed; the miss still says which document it was."""
    from tests.conftest import FakePlanner

    lookup.with_llms(monkeypatch, planner=FakePlanner())
    lookup.client.search_result = RisSearchResult(
        hits=[
            RisHit(
                application="LrKons",
                document_number="NOR40299999",
                title="Wiener Garagengesetz 2008",
                citation_url="https://www.ris.bka.gv.at/Dokumente/Landesnormen/NOR40299999/NOR40299999.html",
                content_urls={"Html": "https://www.ris.bka.gv.at/gone.html"},
            )
        ],
        total=1,
    )
    lookup.client.documents = {}  # every fetch raises

    output = await lookup.run(question="Was verlangt das Garagengesetz?", jurisdiction="Wien")

    assert "Matched but not read:" in output
    assert "Wiener Garagengesetz 2008" in output

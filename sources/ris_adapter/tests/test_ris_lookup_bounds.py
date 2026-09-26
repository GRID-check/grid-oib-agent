"""The pipeline's own bounds, asserted where they are enforced.

Every one of them is what the caller no longer pays in charged research calls:
three candidates, two fetches, six passages across two documents. A bound that
is only a constant is a bound that drifts, so each is measured through the tool
rather than read off the module.
"""

from __future__ import annotations

import pytest
from ris_adapter.client import RisHit
from ris_adapter.client import RisSearchResult
from ris_adapter.lookup.candidates import MAX_CANDIDATES
from ris_adapter.lookup.extract import MAX_DOCUMENTS
from ris_adapter.lookup.extract import MAX_PASSAGES
from ris_adapter.lookup.fetch import MAX_FETCHES

pytestmark = pytest.mark.asyncio


def _many_entries(catalog, count: int):
    """A catalog holding ``count`` fetchable Viennese laws on one topic."""
    from tests.conftest import LookupHarness
    from tests.conftest import norm_entry

    return catalog(
        *(
            norm_entry(
                id=f"law-{index}",
                title=f"Bauordnung Teil {index}",
                short=f"BO {index}",
                document_number=f"NOR4020{index:04d}",
                full_law_url=LookupHarness.WIEN_URL if index % 2 else LookupHarness.TIROL_URL,
                topics=["bauordnung"],
            )
            for index in range(count)
        )
    )


async def test_a_twelve_hit_catalog_match_reads_at_most_two_documents(lookup, catalog):
    _many_entries(catalog, 12)

    await lookup.run(question="Was verlangt die Bauordnung? § 63", jurisdiction="Wien")

    assert len(lookup.client.fetch_calls) <= MAX_FETCHES == 2


async def test_at_most_three_candidates_are_considered(lookup, catalog, monkeypatch):
    """The miss names what it did not read — and it names at most three."""
    from tests.conftest import FakePicker

    _many_entries(catalog, 12)
    lookup.with_llms(monkeypatch, picker=FakePicker())

    output = await lookup.run(question="Was sagt die Bauordnung zur Grunderwerbsteuer?", jurisdiction="Wien")

    named = [line for line in output.splitlines() if line.startswith("  - ")]
    assert len(named) <= MAX_CANDIDATES == 3


async def test_a_live_search_of_twenty_hits_considers_three(lookup, monkeypatch):
    from tests.conftest import FakePlanner

    lookup.with_llms(monkeypatch, planner=FakePlanner())
    lookup.client.search_result = RisSearchResult(
        hits=[
            RisHit(
                application="LrKons",
                document_number=f"NOR402{index:05d}",
                title=f"Gesetz {index}",
                citation_url=f"https://www.ris.bka.gv.at/x/{index}.html",
                full_law_url=lookup.WIEN_URL if index < 2 else f"https://www.ris.bka.gv.at/unfetchable/{index}",
            )
            for index in range(20)
        ],
        total=20,
    )

    await lookup.run(question="Was verlangt § 63?", jurisdiction="Wien")

    # Three candidates, two fetch attempts — never twenty of either.
    assert len(lookup.client.fetch_calls) <= MAX_FETCHES


async def test_at_most_six_passages_come_back(lookup, catalog, monkeypatch):
    from tests.conftest import FakePicker

    lookup.set_text(
        lookup.WIEN_URL,
        "\n".join(f"Titel {n}\n§ {n}. (1) Der Inhalt von Paragraf {n}." for n in range(1, 30)),
    )
    lookup.with_llms(monkeypatch, picker=FakePicker(*(f"§ {n}" for n in range(1, 30))))

    output = await lookup.run(question="Was regelt die Bauordnung alles?", jurisdiction="Wien")

    assert output.count("--- Result ") == MAX_PASSAGES == 6


async def test_passages_come_from_at_most_two_documents(lookup, catalog, monkeypatch):
    from tests.conftest import FakePicker

    _many_entries(catalog, 6)
    lookup.with_llms(monkeypatch, picker=FakePicker("§ 63", "§ 64", "§ 60"))

    output = await lookup.run(question="Was regelt die Bauordnung?", jurisdiction="Wien")

    laws = {line for line in output.splitlines() if line.startswith("Source: ")}
    assert len(laws) <= MAX_DOCUMENTS == 2


async def test_a_nine_hundred_kilobyte_law_does_not_reach_the_transcript(lookup, catalog):
    """The bound that protects the turn: a consolidated law is megabytes.

    `ris_fetch_document` answered this with a 40 000-character cut, which is
    still 40 000 characters of prose with no citation key in it. Here the
    document is read in full (and ingested in full) and what the model SEES is
    one paragraph.
    """
    huge = "\n".join(f"Titel {n}\n§ {n}. (1) " + "Wort " * 400 for n in range(1, 460))
    assert len(huge) > 900_000
    lookup.set_text(lookup.WIEN_URL, huge)

    output = await lookup.run(question="Was verlangt § 63 BO Wien?", instrument="BO Wien")

    assert len(output) < 10_000
    assert "Punkt: § 63" in output

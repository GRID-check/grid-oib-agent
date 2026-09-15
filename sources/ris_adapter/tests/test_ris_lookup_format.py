"""The return format IS the contract: RIS output must parse as evidence.

``ris_fetch_document`` returned 40 000 characters with a ``Source:`` and a
``Title:`` and nothing a citation could resolve to — so
``extract_sources_from_tool_result`` fell through to the generic URL extractor
and the answer cited a link. These tests assert the opposite for
``ris_lookup``: the SAME parser the knowledge layer registers reads the block,
and what comes out carries a citation key, a Punkt and ``doc_class="gesetz"``.

That is the whole claim of the consolidation, as an assertion rather than a
paragraph.
"""

from __future__ import annotations

import json

import pytest

from aiq_agent.common.citation_verification import extract_sources_from_tool_result

pytestmark = pytest.mark.asyncio

_QUESTION = "Welche Unterlagen sind dem Bauansuchen anzuschließen?"


async def test_the_block_carries_every_field_the_grounding_grammar_needs(lookup, catalog):
    output = await lookup.run(question=_QUESTION, instrument="§ 63 Abs 1 BO Wien")

    assert "--- Result 1 ---" in output
    assert "Source: Bauordnung für Wien" in output
    assert f"Source URL: {lookup.WIEN_URL}" in output
    assert "Shelf: base" in output
    assert "Dokumentart: gesetz — Gesetz / Bauordnung" in output
    assert "Punkt: §63Abs1" in output
    assert "Citation: Bauordnung für Wien, § 63 Abs 1" in output
    assert "Content Type: text" in output
    assert "Relevance Score: 1.00" in output
    assert "Dem Ansuchen um Baubewilligung sind anzuschließen" in output
    assert "## Trace-Lanes" in output


async def test_the_knowledge_parser_reads_it_as_evidence(lookup, catalog):
    """The assertion the whole consolidation rests on."""
    output = await lookup.run(question=_QUESTION, instrument="§ 63 Abs 1 BO Wien")

    entries = extract_sources_from_tool_result("ris_lookup", output)

    assert len(entries) == 1
    entry = entries[0]
    assert entry.citation_key == "Bauordnung für Wien, § 63 Abs 1"
    assert entry.punkt == "§63Abs1"
    assert entry.doc_class == "gesetz"
    assert entry.source_type == "knowledge_layer"
    assert entry.shelf == "base"
    assert "Dem Ansuchen um Baubewilligung" in (entry.chunk_text or "")


async def test_only_the_named_absatz_is_returned(lookup, catalog):
    """``Abs 1`` means Abs 1 — the Absätze after it stay out of the passage."""
    output = await lookup.run(question=_QUESTION, instrument="§ 63 Abs 1 BO Wien")

    body = lookup.body_of(output)
    assert "Dem Ansuchen um Baubewilligung" in body
    assert "Die Baupläne müssen von einem hierzu Befugten" not in body


async def test_the_lane_is_the_rechtsquelle_lane_not_unknown(lookup, catalog):
    """``doc_class`` is what ``lane_for_hit`` reads first — so the chip is law, not Web."""
    output = await lookup.run(question=_QUESTION, instrument="§ 63 BO Wien")

    lanes = json.loads(output.split("## Trace-Lanes\n", 1)[1].strip())

    assert [lane["key"] for lane in lanes["lanes"]] == ["baurecht_ris"]
    assert lanes["lanes"][0]["kind"] == "baurecht"


async def test_a_passage_is_never_longer_than_the_knowledge_layer_allows(lookup, catalog):
    """The bound is imported from the knowledge layer, never restated here."""
    from knowledge_layer.register import _CHUNK_TRUNCATE_CHARS

    long_absatz = "\n".join(f"({index}) " + "Text " * 200 for index in range(1, 12))
    lookup.set_text(lookup.WIEN_URL, f"Bauansuchen\n§ 63. {long_absatz}")

    output = await lookup.run(question="Was verlangt § 63 BO Wien?", instrument="BO Wien")

    body = lookup.body_of(output)
    assert len(body) <= _CHUNK_TRUNCATE_CHARS
    # The producer's own truncation marker, which the parser strips back off.
    assert "... [truncated]" in output

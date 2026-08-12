"""The qualifier strings are a WIRE CONTRACT, so both ends must agree.

The legacy qualifier strings are embedded in citation keys that got persisted in
messages. The backend writes them and the frontend parses them back, so a change
on one side alone silently stops every qualified citation from resolving — the
exact class of drift this identity model exists to remove.

The collection-PREFIX parity test that used to live here is gone with
``_COLLECTION_SCOPE_PREFIXES`` (ADR-0047): it policed the agreement of two
guesses rather than removing the guess. The shelf now travels as data, and the
round-trip contract test (``tests/knowledge_layer_tests/test_citation_key_scope.py``
plus ``tests/aiq_agent/knowledge/test_scoping.py``) drives that seam instead.

Parsed rather than exported, because a generated file would be one more thing to
keep in sync; a mismatch here is a two-line fix on whichever side is behind.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aiq_agent.common.source_kinds import _LANE_KIND_PREFIXES
from aiq_agent.common.source_kinds import DEFAULT_SOURCE_KIND
from aiq_agent.common.source_kinds import SOURCE_KINDS
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import shelf_for_qualifier

_MIRROR = Path("frontends/ui/src/features/chat/lib/source-kinds.ts")


@pytest.fixture(scope="module")
def mirror_source() -> str:
    if not _MIRROR.is_file():
        pytest.skip("frontend not present in this checkout")
    return _MIRROR.read_text(encoding="utf-8")


def test_the_legacy_qualifier_strings_resolve_to_the_same_shelf(mirror_source: str):
    """Every legacy qualifier the frontend parses must resolve, on this side, to
    the SAME shelf — those strings are frozen inside keys already persisted.

    One-directional (mirror ⊆ backend): the two runtimes deploy separately, so
    a qualifier the backend knows and the frontend has not learned yet is not a
    contract break. A DISAGREEMENT on a shared string is, and fails here.
    """
    block = re.search(
        r"LEGACY_SCOPE_QUALIFIERS:[^=]*=\s*\[(.*?)\]\n",
        mirror_source,
        re.DOTALL,
    )
    assert block, "LEGACY_SCOPE_QUALIFIERS not found in the frontend mirror"
    mirrored = re.findall(r"\['([^']*)',\s*'([^']*)'\]", block.group(1))
    assert mirrored, "the frontend mirror declares no legacy qualifiers"
    for label, shelf in mirrored:
        assert shelf_for_qualifier(label) == Shelf(shelf), f"{label!r} disagrees across the two runtimes"
    # The persisted vocabulary: keys already written into messages must keep
    # parsing on both ends whatever else either side adds.
    assert {label for label, _ in mirrored} >= {"Büroarchiv", "Projektwissen", "Basiswissen"}


# ---------------------------------------------------------------------------
# The taxonomy itself
# ---------------------------------------------------------------------------
#
# The two tests above guard the strings DERIVED from the source-kind model. The
# model itself — the set of kinds, and the lane→kind table that assigns one to
# every retrieval hit — was mirrored in the same file with nothing checking it,
# even though ADR-0026 makes it the taxonomy that drives ALL rendering (chips,
# Herleitung fan-out, report sources). Adding a fifth kind, or a lane family, on
# one side alone would leave the other silently falling open to `web`: sources
# keep rendering, in the wrong family, with no error anywhere.


def test_the_source_kinds_match(mirror_source: str):
    block = re.search(r"export type SourceKind =([^\n]*)", mirror_source)
    assert block, "the SourceKind union was not found in the frontend mirror"
    assert set(re.findall(r"'([^']+)'", block.group(1))) == set(SOURCE_KINDS)


def test_the_narrowing_set_lists_every_kind(mirror_source: str):
    """`asSourceKind` rejects anything absent from this set, so a kind missing
    here is dropped off the wire even when the union above admits it."""
    block = re.search(r"SOURCE_KINDS:\s*ReadonlySet<SourceKind>\s*=\s*new Set\(\[(.*?)\]\)", mirror_source, re.DOTALL)
    assert block, "the SOURCE_KINDS narrowing set was not found in the frontend mirror"
    assert set(re.findall(r"'([^']+)'", block.group(1))) == set(SOURCE_KINDS)


def test_the_lane_kind_prefixes_match(mirror_source: str):
    block = re.search(
        r"LANE_KIND_PREFIXES:[^=]*=\s*\[(.*?)\]\n",
        mirror_source,
        re.DOTALL,
    )
    assert block, "LANE_KIND_PREFIXES not found in the frontend mirror"
    mirrored = tuple(re.findall(r"\['([^']*)',\s*'([^']*)'\]", block.group(1)))
    assert mirrored == _LANE_KIND_PREFIXES


def test_the_lane_fallback_kinds_match(mirror_source: str):
    """Both classifiers fail open, so they must fail open to the SAME kind."""
    block = re.search(r"export const kindForLane =(.*?)\n\}", mirror_source, re.DOTALL)
    assert block, "kindForLane not found in the frontend mirror"
    fallback = re.search(r"return '([^']+)'\s*$", block.group(1).strip())
    assert fallback, "kindForLane's fail-open return was not found"
    assert fallback.group(1) == DEFAULT_SOURCE_KIND

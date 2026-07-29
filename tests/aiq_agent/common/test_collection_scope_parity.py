"""The collection-scope rule is a WIRE CONTRACT, so both ends must agree.

``SCOPE_QUALIFIERS`` strings are embedded in citation keys that get persisted in
messages, and the collection prefixes decide which shelf a document sits on. The
backend writes them and the frontend parses them back, so a change on one side
alone silently stops every qualified citation from resolving — the exact class of
drift this identity model exists to remove.

Parsed rather than exported, because a generated file would be one more thing to
keep in sync; a mismatch here is a two-line fix on whichever side is behind.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aiq_agent.common.source_kinds import _COLLECTION_SCOPE_PREFIXES
from aiq_agent.common.source_kinds import SCOPE_QUALIFIERS

_MIRROR = Path("frontends/ui/src/features/chat/lib/source-kinds.ts")


@pytest.fixture(scope="module")
def mirror_source() -> str:
    if not _MIRROR.is_file():
        pytest.skip("frontend not present in this checkout")
    return _MIRROR.read_text(encoding="utf-8")


def test_the_qualifier_strings_match(mirror_source: str):
    block = re.search(
        r"SCOPE_QUALIFIERS:\s*Record<CollectionScope,\s*string>\s*=\s*\{(.*?)\}",
        mirror_source,
        re.DOTALL,
    )
    assert block, "SCOPE_QUALIFIERS not found in the frontend mirror"
    mirrored = dict(re.findall(r"(\w+):\s*'([^']*)'", block.group(1)))
    assert mirrored == SCOPE_QUALIFIERS


def test_the_collection_prefixes_match(mirror_source: str):
    block = re.search(
        r"COLLECTION_SCOPE_PREFIXES:[^=]*=\s*\[(.*?)\]\n",
        mirror_source,
        re.DOTALL,
    )
    assert block, "COLLECTION_SCOPE_PREFIXES not found in the frontend mirror"
    mirrored = tuple(re.findall(r"\['([^']*)',\s*'([^']*)'\]", block.group(1)))
    assert mirrored == _COLLECTION_SCOPE_PREFIXES

"""``AgentGroup`` is a WIRE CONTRACT, so both ends must agree on the id set.

An agent group is the granularity at which a platform or org admin re-models the
fleet: the picker writes ``{group: model_id}``, the BFF encodes it into the
``x-grid-model-overrides`` header, and ``parse_model_overrides`` decodes it.

Drift is silent by construction. ``parse_model_overrides`` deliberately "silently
drops unknown group ids" — the right behaviour for a malformed header, and the
wrong one for a group the frontend offers that the backend has never heard of.
The admin saves an override, the UI reports it saved, the row persists, and the
agent keeps using the previous model with nothing logged. The reverse gap is
quieter still: a backend group absent from the registry simply cannot be
configured, so it silently ignores the platform default machinery.

Both sides carried a comment asking the next person to keep the sets in sync.
This is that comment, enforced. Parsed rather than exported, for the same reason
as ``test_collection_scope_parity``: a generated file would be one more thing to
keep in sync, and a mismatch here is a one-line fix on whichever side is behind.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aiq_agent.common.model_overrides import AgentGroup

_MIRROR = Path("frontends/ui/src/lib/model-config/agent-groups.ts")


@pytest.fixture(scope="module")
def mirror_source() -> str:
    if not _MIRROR.is_file():
        pytest.skip("frontend not present in this checkout")
    return _MIRROR.read_text(encoding="utf-8")


def _mirrored_ids(source: str) -> set[str]:
    block = re.search(r"AGENT_GROUPS:\s*AgentGroupDefinition\[\]\s*=\s*\[(.*?)\n\]", source, re.DOTALL)
    assert block, "the AGENT_GROUPS registry was not found in the frontend mirror"
    return set(re.findall(r"^\s*id:\s*'([^']+)'", block.group(1), re.MULTILINE))


def test_the_agent_group_ids_match(mirror_source: str):
    assert _mirrored_ids(mirror_source) == {group.value for group in AgentGroup}


def test_the_mirror_actually_parses(mirror_source: str):
    """Guards the guard: a regex that stopped matching would compare two empty
    sets and pass over nothing at all."""
    assert len(_mirrored_ids(mirror_source)) >= 5

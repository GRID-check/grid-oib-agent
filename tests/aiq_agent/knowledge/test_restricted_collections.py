"""The Python reader of ADR-0078's restricted-folder collection names.

The writer is ``restrictedCollectionName`` in
``frontends/ui/src/lib/authz/folder-access.ts``:
``${projectCollection}_r`` + the first twelve hex digits of the folder uuid,
dashes removed, lowercased. ``_bff_name`` restates that rule so the two sides
are checked against one spelling of it.
"""

from __future__ import annotations

import uuid

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import legacy_shelf_for_collection_name
from aiq_agent.knowledge.restricted_collections import base_collection_of
from aiq_agent.knowledge.restricted_collections import is_restricted_collection
from aiq_agent.knowledge.restricted_collections import restricted_collections_in

PROJECT = "proj_6f1c2a7e-0b9d-4e55-9a51-3c2d7f0e8b14"


def _bff_name(project_collection: str, folder_id: str) -> str:
    return f"{project_collection}_r{folder_id.replace('-', '')[:12].lower()}"


def test_a_name_the_bff_mints_is_restricted_and_reads_back_to_its_project() -> None:
    name = _bff_name(PROJECT, str(uuid.uuid4()).upper())
    assert len(name) == 55
    assert is_restricted_collection(name)
    assert base_collection_of(name) == PROJECT


@pytest.mark.parametrize(
    "name",
    [
        PROJECT,
        "proj_1",
        "oib_knowledge",
        "archiv_org_01HZX4Y8K2M3N5P6Q7R8S9T0VW",  # pragma: allowlist secret
        "s_9b2e1f0a-7c3d-4e5f-8a9b-0c1d2e3f4a5b",
        f"{PROJECT}_r0123456789a",  # eleven digits
        f"{PROJECT}_r0123456789abc",  # thirteen
        f"{PROJECT}_r0123456789ag",  # not hex
        f"{PROJECT}_x0123456789ab",  # not `_r`
        "_r0123456789ab",  # no base at all
        "",
        None,
    ],
)
def test_every_other_collection_is_not(name: str | None) -> None:
    assert not is_restricted_collection(name)
    if name:
        assert base_collection_of(name) == name


def test_case_does_not_open_a_restricted_collection() -> None:
    """A reader that changes case on the way must not turn one into an open collection."""
    assert is_restricted_collection(f"{PROJECT}_r0123456789AB".upper())


def test_a_prefix_reader_still_shelves_it_as_the_project() -> None:
    assert legacy_shelf_for_collection_name(_bff_name(PROJECT, str(uuid.uuid4()))) is Shelf.PROJECT


def test_restricted_collections_in_a_scope() -> None:
    restricted = _bff_name(PROJECT, str(uuid.uuid4()))
    assert restricted_collections_in(["oib_knowledge", PROJECT, restricted, None]) == [restricted]
    assert restricted_collections_in(["oib_knowledge", PROJECT]) == []
    assert restricted_collections_in(None) == []

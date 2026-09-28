"""``find_tmp_upload_names``: the legacy ``tmp[8]_`` spellings a re-upload must replace.

Chroma filters metadata by value, never by pattern, and the prefix is random,
so the re-upload's filtered read learns these names from the metadata rows.
The pattern is LIKE, so a name's own ``_`` and ``%`` must match only themselves.
"""

from __future__ import annotations

import pytest

from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore


@pytest.fixture()
def store(tmp_path):
    store = DocumentMetadataStore(f"sqlite:///{tmp_path / 'summaries.db'}")
    for name in (
        "tmpa1b2c3d4_statik_v2.pdf",
        "tmpa1b2c3d4_statikXv2.pdf",  # `_` in the name is not a wildcard
        "tmpa1b2c3_statik_v2.pdf",  # seven characters, not eight
        "statik_v2.pdf",
        "tmpzzzzzzzz_100%25 Plan.pdf",
        "tmpzzzzzzzz_100 Plan.pdf",
    ):
        store.register("proj_1", name, "summary")
    store.register("proj_2", "tmpa1b2c3d4_statik_v2.pdf", "summary")
    return store


def test_finds_the_prefixed_spelling_of_a_name_and_nothing_else(store):
    assert store.find_tmp_upload_names("proj_1", ["statik_v2.pdf"]) == ["tmpa1b2c3d4_statik_v2.pdf"]


def test_a_percent_in_the_name_matches_only_itself(store):
    assert store.find_tmp_upload_names("proj_1", ["100%25 Plan.pdf"]) == ["tmpzzzzzzzz_100%25 Plan.pdf"]


def test_several_spellings_in_one_query(store):
    found = store.find_tmp_upload_names("proj_1", ["statik_v2.pdf", "100 Plan.pdf"])
    assert sorted(found) == ["tmpa1b2c3d4_statik_v2.pdf", "tmpzzzzzzzz_100 Plan.pdf"]


def test_nothing_asked_nothing_found(store):
    assert store.find_tmp_upload_names("proj_1", []) == []
    assert store.find_tmp_upload_names("proj_3", ["statik_v2.pdf"]) == []

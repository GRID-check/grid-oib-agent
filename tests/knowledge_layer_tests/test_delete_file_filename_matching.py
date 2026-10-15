"""Deletion must match chunks whose stored ``file_name`` metadata diverges from
the requested name.

Documents ingested from a presigned URL had their chunk ``file_name`` metadata
set from the percent-encoded URL path (e.g. ``Z%C3%BCrich%20Plan.pdf``), while
deletion sends the raw DB filename (``Zürich Plan.pdf``). The exact-match query
missed, so the vectors were orphaned. ``delete_file`` URL-decodes (and strips
the temp-upload prefix from) every stored name of the collection, so an
already-ingested document is deletable by its real name.
"""

from __future__ import annotations

import threading

from knowledge_layer.llamaindex import adapter as adapter_mod
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

import aiq_agent.knowledge as knowledge_pkg
from sources.knowledge_layer.tests.qdrant_testing import chunk_texts
from sources.knowledge_layer.tests.qdrant_testing import record
from sources.knowledge_layer.tests.qdrant_testing import write


class _Collection:
    """The test's collection in the real store: ``chunk_id -> stored file_name``, and what is left of it."""

    def __init__(self, chunks: dict[str, dict]):
        write(SCOPE, [record(f"Text {cid}", meta["file_name"], chunk_id=cid) for cid, meta in chunks.items()])

    @property
    def _chunks(self) -> dict[str, str]:
        return chunk_texts(SCOPE)


SCOPE = "proj_test"


def _ingestor(collection: _Collection) -> LlamaIndexIngestor:
    ing = object.__new__(LlamaIndexIngestor)
    ing._lock = threading.RLock()
    return ing


def _patch_side_effects(monkeypatch):
    """Neutralise the persistence side effects delete_file triggers."""
    monkeypatch.setattr(adapter_mod, "bump_collection_version", lambda *_: None)
    monkeypatch.setattr(knowledge_pkg, "unregister_summary", lambda *_, **__: None, raising=False)


def test_delete_matches_percent_encoded_stored_name(monkeypatch, qdrant_store):
    """A chunk stored under the encoded name is deleted by the decoded name."""
    _patch_side_effects(monkeypatch)
    collection = _Collection(
        {
            "c1": {"file_name": "Z%C3%BCrich%20Plan.pdf"},
            "c2": {"file_name": "Z%C3%BCrich%20Plan.pdf"},
            "other": {"file_name": "unrelated.pdf"},
        }
    )
    ing = _ingestor(collection)

    assert ing.delete_file("Zürich Plan.pdf", "proj_test") is True
    # Only the matching chunks are gone; the unrelated one stays.
    assert set(collection._chunks) == {"other"}


def test_delete_matches_tmp_prefixed_encoded_name(monkeypatch, qdrant_store):
    """Temp-upload prefix AND percent-encoding together still resolve."""
    _patch_side_effects(monkeypatch)
    collection = _Collection({"c1": {"file_name": "tmp12345678_Fire%20Safety.pdf"}})
    ing = _ingestor(collection)

    assert ing.delete_file("Fire Safety.pdf", "proj_test") is True
    assert collection._chunks == {}


def test_delete_exact_match_still_works(monkeypatch, qdrant_store):
    """A plainly-named chunk is deleted by exact match (no regression)."""
    _patch_side_effects(monkeypatch)
    collection = _Collection({"c1": {"file_name": "plan.pdf"}})
    ing = _ingestor(collection)

    assert ing.delete_file("plan.pdf", "proj_test") is True
    assert collection._chunks == {}


def test_delete_returns_false_when_no_chunks_match_but_still_forgets_the_file(monkeypatch, qdrant_store):
    """A name that matches nothing (and has no tracking entry) reports failure —
    and still clears the summary row. The early return that
    skipped them left a chunk-less document in the agent's inventory for good:
    the BFF had already dropped its row, and every later delete took the same
    exit."""
    monkeypatch.setattr(adapter_mod, "bump_collection_version", lambda *_: None)
    forgotten: list[tuple[str, str, bool]] = []
    monkeypatch.setattr(
        knowledge_pkg,
        "unregister_summary",
        lambda c, f, permanent=False: forgotten.append((c, f, permanent)),
        raising=False,
    )
    collection = _Collection({"c1": {"file_name": "something-else.pdf"}})
    ing = _ingestor(collection)

    assert ing.delete_file("missing.pdf", "proj_test") is False
    assert set(collection._chunks) == {"c1"}
    assert forgotten == [("proj_test", "missing.pdf", False)]


def test_a_permanent_delete_tells_the_store_so(monkeypatch, qdrant_store):
    """``permanent`` reaches the metadata store on both paths; without it the store keeps a person's Fassung facts."""
    monkeypatch.setattr(adapter_mod, "bump_collection_version", lambda *_: None)
    forgotten: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        knowledge_pkg,
        "unregister_summary",
        lambda _c, f, permanent=False: forgotten.append((f, permanent)),
        raising=False,
    )
    ing = _ingestor(_Collection({"c1": {"file_name": "plan.pdf"}}))

    assert ing.delete_file("plan.pdf", "proj_test", permanent=True) is True
    ing.delete_file("missing.pdf", "proj_test", permanent=True)
    assert forgotten == [("plan.pdf", True), ("missing.pdf", True)]

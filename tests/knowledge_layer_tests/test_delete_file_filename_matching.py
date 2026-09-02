"""Deletion must match chunks whose stored ``file_name`` metadata diverges from
the requested name.

Documents ingested from a presigned URL had their chunk ``file_name`` metadata
set from the percent-encoded URL path (e.g. ``Z%C3%BCrich%20Plan.pdf``), while
deletion sends the raw DB filename (``Zürich Plan.pdf``). The exact-match query
missed, so the vectors were orphaned. ``delete_file`` now URL-decodes (and strips
the temp-upload prefix from) the stored names in its fallback scan, so an
already-ingested document is deletable by its real name.
"""

from __future__ import annotations

import threading

from knowledge_layer.llamaindex import adapter as adapter_mod
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

import aiq_agent.knowledge as knowledge_pkg


class _FakeCollection:
    """Minimal Chroma collection: exact ``where`` match on file_name + delete."""

    def __init__(self, chunks: dict[str, dict]):
        # chunk_id -> metadata
        self._chunks = dict(chunks)

    def get(self, where=None, include=None):  # noqa: ARG002 - signature parity
        if where is None:
            ids = list(self._chunks)
            return {"ids": ids, "metadatas": [self._chunks[i] for i in ids]}
        want = where["file_name"]
        ids = [cid for cid, meta in self._chunks.items() if meta.get("file_name") == want]
        return {"ids": ids, "metadatas": [self._chunks[cid] for cid in ids]}

    def delete(self, ids):
        for cid in ids:
            self._chunks.pop(cid, None)


class _FakeClient:
    def __init__(self, collection: _FakeCollection):
        self._collection = collection

    def get_collection(self, name):  # noqa: ARG002
        return self._collection


def _ingestor(collection: _FakeCollection) -> LlamaIndexIngestor:
    ing = object.__new__(LlamaIndexIngestor)
    ing._files = {}
    ing._lock = threading.RLock()
    ing._get_chroma_client = lambda: _FakeClient(collection)  # type: ignore[method-assign]
    return ing


def _patch_side_effects(monkeypatch):
    """Neutralise the persistence side effects delete_file triggers."""
    monkeypatch.setattr(adapter_mod, "bump_collection_version", lambda *_: None)
    monkeypatch.setattr(knowledge_pkg, "unregister_summary", lambda *_: None, raising=False)


def test_delete_matches_percent_encoded_stored_name(monkeypatch):
    """A chunk stored under the encoded name is deleted by the decoded name."""
    _patch_side_effects(monkeypatch)
    collection = _FakeCollection(
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


def test_delete_matches_tmp_prefixed_encoded_name(monkeypatch):
    """Temp-upload prefix AND percent-encoding together still resolve."""
    _patch_side_effects(monkeypatch)
    collection = _FakeCollection({"c1": {"file_name": "tmp12345678_Fire%20Safety.pdf"}})
    ing = _ingestor(collection)

    assert ing.delete_file("Fire Safety.pdf", "proj_test") is True
    assert collection._chunks == {}


def test_delete_exact_match_still_works(monkeypatch):
    """A plainly-named chunk is deleted by exact match (no regression)."""
    _patch_side_effects(monkeypatch)
    collection = _FakeCollection({"c1": {"file_name": "plan.pdf"}})
    ing = _ingestor(collection)

    assert ing.delete_file("plan.pdf", "proj_test") is True
    assert collection._chunks == {}


def test_delete_returns_false_when_no_chunks_match_but_still_forgets_the_file(monkeypatch):
    """A name that matches nothing (and has no tracking entry) reports failure —
    and still clears the summary row and text mirror. The early return that
    skipped them left a chunk-less document in the agent's inventory for good:
    the BFF had already dropped its row, and every later delete took the same
    exit."""
    monkeypatch.setattr(adapter_mod, "bump_collection_version", lambda *_: None)
    forgotten: list[tuple[str, str]] = []
    monkeypatch.setattr(knowledge_pkg, "unregister_summary", lambda c, f: forgotten.append((c, f)), raising=False)
    collection = _FakeCollection({"c1": {"file_name": "something-else.pdf"}})
    ing = _ingestor(collection)

    assert ing.delete_file("missing.pdf", "proj_test") is False
    assert set(collection._chunks) == {"c1"}
    assert forgotten == [("proj_test", "missing.pdf")]

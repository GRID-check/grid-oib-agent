"""Retention + O(1) correlation for the in-memory per-file tracking dict.

`LlamaIndexIngestor._files` grew for the life of the process (one entry per
upload, never aged out), and `list_files` rescanned it per listed file (O(files²)).
These test the two fixes in isolation — the helpers touch only `_files`/`_lock`,
so a minimally-constructed instance exercises them without a Chroma client.
"""

from __future__ import annotations

import threading
from datetime import UTC
from datetime import datetime
from datetime import timedelta

from knowledge_layer.llamaindex.adapter import FILE_TRACKING_RETENTION_SECONDS
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import FileStatus


def _bare_ingestor() -> LlamaIndexIngestor:
    """An ingestor with just the state the tracking helpers touch (no Chroma)."""
    ing = object.__new__(LlamaIndexIngestor)
    ing._files = {}
    ing._lock = threading.RLock()
    return ing


def _fi(file_id, name, collection, status, *, ingested_days_ago=None, uploaded_days_ago=None):
    def _ago(days):
        return None if days is None else datetime.now(tz=UTC) - timedelta(days=days)

    return FileInfo(
        file_id=file_id,
        file_name=name,
        collection_name=collection,
        status=status,
        uploaded_at=_ago(uploaded_days_ago),
        ingested_at=_ago(ingested_days_ago),
    )


class TestPruneStaleFiles:
    def test_prunes_only_aged_terminal_entries(self):
        ing = _bare_ingestor()
        retention_days = FILE_TRACKING_RETENTION_SECONDS / 86400 + 1
        ing._files = {
            "old-success": _fi("old-success", "a.pdf", "c", FileStatus.SUCCESS, ingested_days_ago=retention_days),
            "old-failed": _fi("old-failed", "b.pdf", "c", FileStatus.FAILED, uploaded_days_ago=retention_days),
            "recent-success": _fi("recent-success", "d.pdf", "c", FileStatus.SUCCESS, ingested_days_ago=0),
            "ingesting": _fi("ingesting", "e.pdf", "c", FileStatus.INGESTING, uploaded_days_ago=retention_days),
            "no-timestamp": _fi("no-timestamp", "f.pdf", "c", FileStatus.SUCCESS),
        }

        ing._prune_stale_files()

        remaining = set(ing._files)
        assert "old-success" not in remaining
        assert "old-failed" not in remaining
        assert remaining == {"recent-success", "ingesting", "no-timestamp"}

    def test_noop_on_empty(self):
        ing = _bare_ingestor()
        ing._prune_stale_files()  # must not raise
        assert ing._files == {}


class TestIndexTrackedFiles:
    def test_indexes_by_name_scoped_to_collection_first_seen_wins(self):
        ing = _bare_ingestor()
        ing._files = {
            "id1": _fi("id1", "dup.pdf", "target", FileStatus.SUCCESS),
            "id2": _fi("id2", "dup.pdf", "target", FileStatus.SUCCESS),  # same name, later -> ignored
            "id3": _fi("id3", "other.pdf", "target", FileStatus.FAILED),
            "id4": _fi("id4", "elsewhere.pdf", "different", FileStatus.SUCCESS),  # other collection
        }

        index = ing._index_tracked_files("target")

        assert set(index) == {"dup.pdf", "other.pdf"}  # scoped to 'target'
        assert index["dup.pdf"][0] == "id1"  # first-seen wins
        assert index["other.pdf"][0] == "id3"

    def test_empty_collection_yields_empty_index(self):
        ing = _bare_ingestor()
        assert ing._index_tracked_files("nothing") == {}

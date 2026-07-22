"""Unit tests for layered, scoped knowledge retrieval.

Covers:
- Collection-set resolution (legacy fixed mode, base+session, project_collections,
  dedup, empty fallback).
- Merge-by-score across multiple RetrievalResults, tolerating failed/empty layers.
- TTL reaper session-prefix exclusion.

All tests are offline: no ChromaDB, no embeddings, no network.
"""

import pytest
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import _merge_results
from knowledge_layer.register import _resolve_target_collections

from aiq_agent.knowledge.base import SESSION_COLLECTION_PREFIX
from aiq_agent.knowledge.base import TTLCleanupMixin
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import CollectionInfo
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult


def _chunk(score: float, name: str = "doc.pdf") -> Chunk:
    return Chunk(
        chunk_id=f"{name}-{score}",
        content=f"content {score}",
        score=score,
        file_name=name,
        display_citation=name,
        content_type=ContentType.TEXT,
    )


def _result(chunks, success=True, error=None, backend="llamaindex", query="q") -> RetrievalResult:
    return RetrievalResult(
        chunks=chunks,
        query=query,
        backend=backend,
        success=success,
        error_message=error,
    )


# =============================================================================
# Collection-set resolution
# =============================================================================


class TestResolveTargetCollections:
    def test_legacy_fixed_collection_ignores_session(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            use_fixed_collection=True,
            include_session_collection=True,
        )
        assert _resolve_target_collections(config, "s_abc") == ["oib_knowledge"]

    def test_base_plus_session(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=True,
            include_session_collection=True,
        )
        assert _resolve_target_collections(config, "s_abc") == ["oib_knowledge", "s_abc"]

    def test_raw_conversation_id_is_normalized_to_session_collection(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=True,
            include_session_collection=True,
        )
        assert _resolve_target_collections(config, "abc") == ["oib_knowledge", "s_abc"]

    def test_session_only_when_base_disabled(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=False,
            include_session_collection=True,
        )
        assert _resolve_target_collections(config, "s_abc") == ["s_abc"]

    def test_project_collections_appended_in_order(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=True,
            include_session_collection=True,
            project_collections=["proj_a", "proj_b"],
        )
        assert _resolve_target_collections(config, "s_abc") == [
            "oib_knowledge",
            "s_abc",
            "proj_a",
            "proj_b",
        ]

    def test_dedup_preserves_order(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=True,
            include_session_collection=True,
            project_collections=["oib_knowledge", "s_abc", "proj_a", "proj_a"],
        )
        assert _resolve_target_collections(config, "s_abc") == ["oib_knowledge", "s_abc", "proj_a"]

    def test_no_session_available(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=True,
            include_session_collection=True,
        )
        assert _resolve_target_collections(config, None) == ["oib_knowledge"]

    def test_empty_falls_back_to_base(self):
        # Nothing selected: no base, no session, no projects -> fall back to base name.
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=False,
            include_session_collection=False,
        )
        assert _resolve_target_collections(config, None) == ["oib_knowledge"]


# =============================================================================
# Merge-by-score
# =============================================================================


class TestMergeResults:
    def test_merges_and_sorts_descending(self):
        r1 = _result([_chunk(0.5, "a.pdf"), _chunk(0.9, "b.pdf")])
        r2 = _result([_chunk(0.7, "c.pdf")])
        merged = _merge_results([r1, r2], query="q", top_k=5, backend_name="llamaindex")
        assert merged.success is True
        assert [c.score for c in merged.chunks] == [0.9, 0.7, 0.5]

    def test_truncates_to_top_k(self):
        r1 = _result([_chunk(0.5), _chunk(0.9), _chunk(0.1)])
        r2 = _result([_chunk(0.7), _chunk(0.8)])
        merged = _merge_results([r1, r2], query="q", top_k=2, backend_name="llamaindex")
        assert [c.score for c in merged.chunks] == [0.9, 0.8]

    def test_tolerates_failed_layer(self):
        ok = _result([_chunk(0.6)])
        failed = _result([], success=False, error="Collection not found")
        merged = _merge_results([ok, failed], query="q", top_k=5, backend_name="llamaindex")
        assert merged.success is True
        assert [c.score for c in merged.chunks] == [0.6]

    def test_tolerates_exception_layer(self):
        ok = _result([_chunk(0.6)])
        merged = _merge_results([ok, RuntimeError("boom")], query="q", top_k=5, backend_name="llamaindex")
        assert merged.success is True
        assert [c.score for c in merged.chunks] == [0.6]

    def test_all_failed_returns_empty_success(self):
        failed = _result([], success=False, error="Collection not found")
        merged = _merge_results([failed, RuntimeError("boom")], query="q", top_k=5, backend_name="llamaindex")
        # success=True with empty chunks so _format_results renders "No relevant documents found"
        assert merged.success is True
        assert merged.chunks == []

    def test_backend_preserved_from_successful_result(self):
        r1 = _result([_chunk(0.6)], backend="foundational_rag")
        merged = _merge_results([r1], query="q", top_k=5, backend_name="fallback")
        assert merged.backend == "foundational_rag"


# =============================================================================
# TTL reaper session-prefix exclusion
# =============================================================================


class _FakeReaper(TTLCleanupMixin):
    """Minimal harness exercising the TTL cleanup logic without threads."""

    backend_name = "fake"

    def __init__(self, collections):
        self._collections = collections
        self.deleted = []
        self._ttl_hours = 24

    def list_collections(self):
        return self._collections

    def delete_collection(self, name):
        self.deleted.append(name)
        return True


def _expired_collection(name: str) -> CollectionInfo:
    from datetime import UTC
    from datetime import datetime
    from datetime import timedelta

    return CollectionInfo(
        name=name,
        backend="fake",
        # Old timestamp so it is well past any TTL threshold.
        updated_at=datetime.now(UTC) - timedelta(days=30),
    )


class TestTTLSessionExclusion:
    def test_prefix_constant(self):
        assert SESSION_COLLECTION_PREFIX == "s_"

    def test_only_session_collections_reaped(self):
        reaper = _FakeReaper(
            [
                _expired_collection("s_session1"),
                _expired_collection("oib_knowledge"),
                _expired_collection("project_corpus"),
            ]
        )
        reaper._cleanup_expired_collections()
        assert reaper.deleted == ["s_session1"]

    def test_non_session_never_deleted_even_when_expired(self):
        reaper = _FakeReaper([_expired_collection("oib_knowledge")])
        reaper._cleanup_expired_collections()
        assert reaper.deleted == []


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))

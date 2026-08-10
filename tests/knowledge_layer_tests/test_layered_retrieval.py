"""Unit tests for layered, scoped knowledge retrieval.

Covers:
- Collection-set resolution (legacy fixed mode, base+session, project_collections,
  dedup, empty fallback).
- Cross-collection rank fusion across multiple RetrievalResults, tolerating
  failed/empty layers.
- TTL reaper session-prefix exclusion.

All tests are offline: no ChromaDB, no embeddings, no network.
"""

import pytest

from aiq_agent.knowledge.base import SESSION_COLLECTION_PREFIX
from aiq_agent.knowledge.base import TTLCleanupMixin
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import CollectionInfo
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig
from sources.knowledge_layer.src.register import _merge_results
from sources.knowledge_layer.src.register import _resolve_target_collections
from sources.knowledge_layer.src.register import _restrict_scope_to_turn


def _chunk(score: float, name: str = "doc.pdf", rank: int | None = None, collection: str | None = None) -> Chunk:
    """Build one hit. ``rank`` is its 0-based rank inside the collection that produced it.

    Rank is what the merge fuses on; ``score`` is the true cosine similarity and is only
    displayed. Leaving ``rank`` unset exercises the fallback where the position in the
    result list is the rank.
    """
    return Chunk(
        chunk_id=f"{collection or ''}-{name}-{score}",
        content=f"content {score}",
        score=score,
        file_name=name,
        display_citation=name,
        content_type=ContentType.TEXT,
        retrieval_rank=rank,
        metadata={"collection": collection} if collection else {},
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
# Turn-level shelf subtraction
# =============================================================================


class TestRestrictScopeToTurn:
    def test_session_focus_drops_archiv_and_base(self):
        from aiq_agent.common.focus_file import set_turn_intent
        from aiq_agent.common.source_kinds import Shelf
        from aiq_agent.knowledge.scoping import ScopedCollection

        set_turn_intent(shelf="session")
        try:
            entries = [
                ScopedCollection("oib_knowledge", Shelf.BASE),
                ScopedCollection("archiv_org", Shelf.ARCHIV),
                ScopedCollection("s_1", Shelf.SESSION),
            ]
            assert [entry.collection for entry in _restrict_scope_to_turn(entries)] == ["s_1"]
        finally:
            set_turn_intent()

    def test_project_preset_drops_archiv(self):
        from aiq_agent.common.focus_file import set_turn_intent
        from aiq_agent.common.source_kinds import Shelf
        from aiq_agent.knowledge.scoping import ScopedCollection

        set_turn_intent(source_preset="project")
        try:
            entries = [
                ScopedCollection("oib_knowledge", Shelf.BASE),
                ScopedCollection("archiv_org", Shelf.ARCHIV),
                ScopedCollection("proj_1", Shelf.PROJECT),
                ScopedCollection("s_1", Shelf.SESSION),
            ]
            assert [entry.collection for entry in _restrict_scope_to_turn(entries)] == [
                "oib_knowledge",
                "proj_1",
                "s_1",
            ]
        finally:
            set_turn_intent()


# =============================================================================
# Merge by cross-collection rank fusion
# =============================================================================


class TestMergeResults:
    def test_merge_orders_by_per_collection_rank_not_by_raw_score(self):
        # Each collection contributes one channel. Both rank-0 hits fuse to the same
        # score, so the base collection (channels[0]) takes the exact tie and the
        # rank-1 hit lands last DESPITE holding the best cosine in the set. Sorting by
        # score here is what used to throw the fusion away.
        r1 = _result([_chunk(0.5, "a.pdf", rank=0), _chunk(0.9, "b.pdf", rank=1)])
        r2 = _result([_chunk(0.7, "c.pdf", rank=0)])
        merged = _merge_results([r1, r2], query="q", top_k=5, backend_name="llamaindex")
        assert merged.success is True
        assert [(c.file_name, c.score) for c in merged.chunks] == [("a.pdf", 0.5), ("c.pdf", 0.7), ("b.pdf", 0.9)]

    def test_focused_file_does_not_pad_with_other_corpora(self, monkeypatch):
        monkeypatch.setattr(
            "aiq_agent.common.focus_file.get_focused_file_name",
            lambda: "upload.pdf",
        )
        monkeypatch.setattr(
            "aiq_agent.common.focus_file.get_focused_shelf",
            lambda: None,
        )
        r1 = _result([_chunk(0.95, "upload.pdf"), _chunk(0.9, "archiv-plan.pdf")])
        merged = _merge_results([r1], query="q", top_k=5, backend_name="llamaindex")
        assert [c.file_name for c in merged.chunks] == ["upload.pdf"]

    def test_truncates_to_top_k_of_the_fused_order(self):
        r1 = _result([_chunk(0.5, "a.pdf", rank=0), _chunk(0.9, "b.pdf", rank=1), _chunk(0.1, "c.pdf", rank=2)])
        r2 = _result([_chunk(0.7, "d.pdf", rank=0), _chunk(0.8, "e.pdf", rank=1)])
        merged = _merge_results([r1, r2], query="q", top_k=2, backend_name="llamaindex")
        # The two rank-0 hits, base collection first — not the two best cosines.
        assert [(c.file_name, c.score) for c in merged.chunks] == [("a.pdf", 0.5), ("d.pdf", 0.7)]

    def test_unranked_layer_falls_back_to_its_position_in_the_result_list(self):
        # Backends that stamp no retrieval_rank (foundational_rag, anything predating
        # the field) must keep behaving as if the returned order were the rank.
        r1 = _result([_chunk(0.5, "a.pdf"), _chunk(0.9, "b.pdf")])
        merged = _merge_results([r1], query="q", top_k=5, backend_name="llamaindex", max_per_document=0)
        assert [(c.file_name, c.score) for c in merged.chunks] == [("a.pdf", 0.5), ("b.pdf", 0.9)]

    def test_merge_records_a_fusion_score_without_touching_the_displayed_similarity(self):
        # _format_results prints `Relevance Score:` from `score`; citation parsing
        # anchors on that literal, so the merge must never overwrite it with a
        # fusion score that is not a similarity at all.
        r1 = _result([_chunk(0.5, "a.pdf", rank=0)])
        merged = _merge_results([r1], query="q", top_k=5, backend_name="llamaindex")
        assert merged.chunks[0].score == 0.5
        assert merged.chunks[0].fusion_score is not None
        assert merged.chunks[0].fusion_score != merged.chunks[0].score

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
# Per-document diversity cap
# =============================================================================


class TestMergeDiversity:
    def test_cap_spreads_across_documents_by_displacing_deeper_ranks(self):
        # 4 hits from one document + 1 from another, all in one collection so the fused
        # order is that collection's own rank order: the second document must take the
        # last slot instead of the first document's rank-2 hit.
        r1 = _result(
            [
                _chunk(0.95, "a.pdf", rank=0),
                _chunk(0.90, "a.pdf", rank=1),
                _chunk(0.85, "a.pdf", rank=2),
                _chunk(0.80, "a.pdf", rank=3),
                _chunk(0.50, "b.pdf", rank=4),
            ]
        )
        merged = _merge_results([r1], query="q", top_k=3, backend_name="llamaindex", max_per_document=2)
        assert [(c.file_name, c.score) for c in merged.chunks] == [("a.pdf", 0.95), ("a.pdf", 0.90), ("b.pdf", 0.50)]

    def test_fill_pass_exceeds_the_cap_when_distinct_documents_run_out(self):
        # Two documents, cap 2, four slots: the cap alone can fill only 3, so the
        # deferred rank-2 hit must come back rather than the merge returning 3 chunks.
        r1 = _result([_chunk(0.9, "a.pdf", rank=0), _chunk(0.8, "a.pdf", rank=1), _chunk(0.7, "a.pdf", rank=2)])
        r2 = _result([_chunk(0.6, "b.pdf", rank=0)])
        merged = _merge_results([r1, r2], query="q", top_k=4, backend_name="llamaindex", max_per_document=2)
        # Fused order is a@0, b@0 (the tie goes to the base collection), a@1, a@2 — and
        # the returned slate is that order, not "selected first, deferred appended".
        assert [(c.file_name, c.score) for c in merged.chunks] == [
            ("a.pdf", 0.9),
            ("b.pdf", 0.6),
            ("a.pdf", 0.8),
            ("a.pdf", 0.7),
        ]

    def test_single_collection_with_cap_matches_plain_truncation(self):
        chunks = [_chunk(score, "a.pdf", rank=rank) for rank, score in enumerate((0.9, 0.8, 0.7, 0.6, 0.5))]
        merged = _merge_results([_result(chunks)], query="q", top_k=4, backend_name="llamaindex", max_per_document=2)
        assert [c.score for c in merged.chunks] == [0.9, 0.8, 0.7, 0.6]

    def test_same_file_name_in_different_collections_counts_separately(self):
        # Same filename on two shelves, cap 1. b.pdf is the discriminator: if the two
        # a.pdf hits shared a document key, the second slot would go to b.pdf instead.
        base = _result([_chunk(0.9, "a.pdf", rank=0, collection="oib_knowledge"), _chunk(0.5, "b.pdf", rank=1)])
        project = _result([_chunk(0.8, "a.pdf", rank=0, collection="proj_123")])
        merged = _merge_results([base, project], query="q", top_k=2, backend_name="llamaindex", max_per_document=1)
        assert [(c.file_name, c.score) for c in merged.chunks] == [("a.pdf", 0.9), ("a.pdf", 0.8)]

    def test_cap_one_keeps_one_chunk_per_document(self):
        # Plain top-2 would return both a.pdf hits; the cap must hand slot 2 to b.pdf.
        r1 = _result([_chunk(0.9, "a.pdf", rank=0), _chunk(0.85, "a.pdf", rank=1), _chunk(0.5, "b.pdf", rank=2)])
        merged = _merge_results([r1], query="q", top_k=2, backend_name="llamaindex", max_per_document=1)
        assert [(c.file_name, c.score) for c in merged.chunks] == [("a.pdf", 0.9), ("b.pdf", 0.5)]

    def test_cap_zero_disables_diversity(self):
        r1 = _result([_chunk(0.9, "a.pdf", rank=0), _chunk(0.8, "a.pdf", rank=1), _chunk(0.5, "b.pdf", rank=2)])
        merged = _merge_results([r1], query="q", top_k=2, backend_name="llamaindex", max_per_document=0)
        assert [(c.file_name, c.score) for c in merged.chunks] == [("a.pdf", 0.9), ("a.pdf", 0.8)]


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


class TestRelevanceFloor:
    """The grounding block must be able to say "nothing here".

    Without a floor, top_k is always filled: a question the corpus cannot answer
    still returns sixteen formatted excerpts carrying page citations and a
    Dokumentart line asserting binding legal force. In a building-law product that
    is the highest-consequence failure available, and it was structurally
    impossible to express before scores became true similarities.
    """

    def test_the_floor_is_disabled_by_default(self) -> None:
        """A floor is a number on one embedding model's cosine distribution.

        Shipping a default would repeat MIN_SURFACE_SCORE's whole history: a value
        calibrated elsewhere, silently wrong here. 0 means "not calibrated yet".
        """
        from aiq_agent.common.retrieval_settings import get_retrieval_setting

        assert get_retrieval_setting("knowledge.relevance_floor_pct", 0) == 0

    def test_the_catalog_allows_a_floor_but_never_a_total_blackout(self) -> None:
        from aiq_agent.common.retrieval_settings import _BOUNDS

        low, high = _BOUNDS["knowledge.relevance_floor_pct"]
        assert low == 0, "0 must remain expressible — it is the disabled state"
        assert high <= 90, "a floor near 1.0 would reject everything the corpus contains"

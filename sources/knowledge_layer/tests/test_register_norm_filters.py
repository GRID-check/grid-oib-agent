"""Base-collection file-exclusion filter (exclude_file_names) and caller-filter merging."""

from knowledge_layer import register as reg
from knowledge_layer.register import KnowledgeRetrievalConfig


class TestBaseCollectionFilters:
    def test_exclusions_become_nin_clause_sorted_and_deduped(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge", exclude_file_names=["b.pdf", "a.pdf", "b.pdf"]
        )
        assert reg._base_collection_filters(config, None) == {"file_name": {"$nin": ["a.pdf", "b.pdf"]}}

    def test_caller_filters_pass_through_when_no_exclusions(self):
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        caller = {"content_type": "text"}
        assert reg._base_collection_filters(config, caller) == caller

    def test_caller_filters_anded_with_exclusions(self):
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", exclude_file_names=["x.pdf"])
        caller = {"content_type": "text"}
        assert reg._base_collection_filters(config, caller) == {"$and": [{"file_name": {"$nin": ["x.pdf"]}}, caller]}

    def test_none_when_nothing_configured(self):
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        assert reg._base_collection_filters(config, None) is None


class TestBaseCollectionProfileRouting:
    """Country-profile base-collection routing — behavior-neutral for Austria.

    The AT profile's ``corpus_collection`` IS the configured ``oib_knowledge``,
    so profile-aware routing returns the same base and leaves the assembled
    collection set unchanged. This guards that the new seam (for country #2)
    does not shift Austria's retrieval scope.
    """

    def test_resolved_base_matches_configured_collection_for_austria(self):
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        assert reg._resolve_base_collection(config) == "oib_knowledge"

    def test_target_collections_unchanged_when_profile_equals_config(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=True,
            include_session_collection=True,
        )
        base = reg._resolve_base_collection(config)
        # profile == config → the profile-resolved base yields the same set as
        # the legacy config-only resolution.
        assert reg._resolve_target_collections(config, "s_abc", base) == reg._resolve_target_collections(
            config, "s_abc"
        )
        assert reg._resolve_target_collections(config, "s_abc", base) == ["oib_knowledge", "s_abc"]

    def test_target_collections_default_base_is_backward_compatible(self):
        # The legacy two-arg call (no base_collection) still resolves to the
        # configured collection_name — existing callers are unaffected.
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=True,
        )
        assert reg._resolve_target_collections(config, None) == ["oib_knowledge"]


def test_explicit_non_default_collection_is_never_rerouted():
    """Test/bench configs pointing at a custom collection keep it verbatim."""
    from knowledge_layer.register import KnowledgeRetrievalConfig
    from knowledge_layer.register import _resolve_base_collection

    config = KnowledgeRetrievalConfig(collection_name="test_collection")
    assert _resolve_base_collection(config) == "test_collection"

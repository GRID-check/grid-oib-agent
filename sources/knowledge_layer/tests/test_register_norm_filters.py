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

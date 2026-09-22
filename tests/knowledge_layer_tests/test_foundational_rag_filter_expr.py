"""The Foundational RAG backend's metadata filter: translated exactly, or refused.

This backend reaches its index through an HTTP service whose filter is a STRING
expression, so the backend-neutral filter dict every caller writes has to be
translated on the way out. It used to be flattened with ``f"{k} == {v}"``
whatever ``v`` was, so the one shape the callers actually send —
``{"punkt_id": {"$eq": "3.5.2"}}``, ``{"chunking": {"$ne": "page"}}``, an
``$and`` group — went out as ``punkt_id == {'$eq': '3.5.2'}``.

That is the worst of the three possible outcomes. The expression cannot match
what it names, and a server that ignores or drops it answers with an
UNFILTERED ranking, which ``read_passage`` then presents as the passage the
model addressed and the model cites under that number. Over-retrieval is
invisible; a raise is not, and every caller turns one into a visible failure.
"""

import pytest
from knowledge_layer.foundational_rag.adapter import FoundationalRagRetriever
from knowledge_layer.foundational_rag.adapter import _filter_expr

OIB = "oib-rl_2_ausgabe_mai_2023.pdf"


class TestWhatTranslates:
    """Flat equality, which is all the server's `filter_expr` can express."""

    def test_a_string_value_is_quoted(self):
        assert _filter_expr({"file_name": OIB}) == f'file_name == "{OIB}"'

    def test_a_number_is_not(self):
        assert _filter_expr({"page": 12}) == "page == 12"

    def test_sibling_keys_are_anded(self):
        assert _filter_expr({"file_name": OIB, "page": 12}) == f'file_name == "{OIB}" and page == 12'

    def test_a_ready_made_expression_passes_through(self):
        assert _filter_expr("file_name == 'a.pdf'") == "file_name == 'a.pdf'"
        assert _filter_expr({"filter_expr": "page == 3"}) == "page == 3"


class TestWhatIsRefused:
    """Every operator node, by name. Silence here is a wrong citation later."""

    @pytest.mark.parametrize(
        "filters",
        [
            {"punkt_id": {"$eq": "3.5.2"}},
            {"chunking": {"$ne": "page"}},
            {"page_label": {"$in": ["1", "2", "3"]}},
            {"file_name": {"$nin": [OIB]}},
        ],
    )
    def test_an_operator_node_raises_rather_than_being_flattened(self, filters):
        with pytest.raises(ValueError) as excinfo:
            _filter_expr(filters)

        message = str(excinfo.value)
        assert next(iter(filters)) in message
        assert "foundational_rag" in message

    @pytest.mark.parametrize(
        "filters",
        [
            {"$and": [{"file_name": OIB}, {"page": 12}]},
            {"$or": [{"file_name": OIB}, {"file_name": "other.pdf"}]},
        ],
    )
    def test_a_group_node_raises(self, filters):
        with pytest.raises(ValueError, match=r"\$and|\$or"):
            _filter_expr(filters)

    def test_the_mangled_expression_is_never_produced(self):
        """The regression itself: `punkt_id == {'$eq': '3.5.2'}` reached the server."""
        with pytest.raises(ValueError):
            _filter_expr({"punkt_id": {"$eq": "3.5.2"}})


class TestTheRaiseReachesTheCaller:
    """`retrieve` catches `requests` failures and returns a failed result for
    them. An untranslatable filter is not one of those: it propagates, so a
    caller cannot mistake it for an empty document."""

    async def test_retrieve_raises_instead_of_searching_unfiltered(self):
        retriever = FoundationalRagRetriever({"rag_url": "http://localhost:8081/v1"})

        def _never_called(*args, **kwargs):  # pragma: no cover - the point is it is not
            raise AssertionError("the request must not be sent with an untranslatable filter")

        retriever.session.post = _never_called

        with pytest.raises(ValueError, match="Unsupported metadata filter"):
            await retriever.retrieve(query="Fluchtweg", collection_name="oib", filters={"chunking": {"$ne": "page"}})

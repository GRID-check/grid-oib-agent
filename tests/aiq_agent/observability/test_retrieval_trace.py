"""The retrieval-picks observation (ADR-0044).

Three things are pinned here:

1. **The payload shape** - what the `retrieve.<tool>` span carries. The value
   of the span is exactly its structured fields (query, collections, budgets,
   picked chunk ids/scores); a field renamed or silently dropped makes
   Langfuse queries return nothing without anything erroring.
2. **Metadata-only content** - no chunk text may ride on the span. It adds no
   information beyond ADR-0029's accepted posture and would widen the blast
   radius of every trace consumer for nothing.
3. **Fail-open emission** - the step pair is balanced (one END per START, same
   UUID) so NAT's span-stack bookkeeping survives, and any failure inside the
   helper is absorbed rather than allowed to break a search.
"""

import json

import pytest

from aiq_agent.observability.retrieval_trace import PICK_LIMIT
from aiq_agent.observability.retrieval_trace import build_retrieval_input
from aiq_agent.observability.retrieval_trace import build_retrieval_output
from aiq_agent.observability.retrieval_trace import emit_retrieval_span


class _Shelf:
    """Stands in for ``aiq_agent.common.source_kinds.Shelf`` (a StrEnum)."""

    def __init__(self, value):
        self.value = value


class _ScopedCollection:
    def __init__(self, collection, shelf=None):
        self.collection = collection
        self.shelf = shelf


class _Chunk:
    """Stands in for ``aiq_agent.knowledge.schema.Chunk`` (attribute access)."""

    def __init__(self, *, chunk_id="c1", file_name="oib-rl-2.pdf", page_number=12, score=0.87, metadata=None):
        self.chunk_id = chunk_id
        self.file_name = file_name
        self.page_number = page_number
        self.score = score
        self.metadata = metadata or {}


class TestRetrievalInput:
    def test_carries_query_budgets_and_collections_with_shelves(self):
        payload = build_retrieval_input(
            query="Fluchtweglänge GK 4",
            retrieval_query="Fluchtweglänge GK 4 Geschoßfläche Gebäudeklasse",
            collections=[_ScopedCollection("oib_knowledge", _Shelf("base")), _ScopedCollection("proj_abc")],
            candidate_k=32,
            top_k=16,
            reranked=True,
            dropped_by_floor=3,
            requery_queries=["Gehweglänge Gebäudeklasse 4"],
        )

        assert payload == {
            "query": "Fluchtweglänge GK 4",
            "retrieval_query": "Fluchtweglänge GK 4 Geschoßfläche Gebäudeklasse",
            "collections": [
                {"collection": "oib_knowledge", "shelf": "base"},
                {"collection": "proj_abc"},
            ],
            "candidate_k": 32,
            "top_k": 16,
            "reranked": True,
            "dropped_by_floor": 3,
            "requery_queries": ["Gehweglänge Gebäudeklasse 4"],
        }

    def test_absent_facts_are_omitted_not_null(self):
        """Langfuse renders whatever it is given; nulls read as real values."""
        payload = build_retrieval_input(
            query="q",
            retrieval_query=None,
            collections=[],
            candidate_k=8,
            top_k=8,
            reranked=False,
            dropped_by_floor=0,
        )
        assert "retrieval_query" not in payload
        # A one-shot search records no loop, rather than an empty one.
        assert "requery_queries" not in payload


class TestRetrievalOutput:
    def test_records_the_picked_chunks_metadata_only(self):
        picks = build_retrieval_output(
            chunks=[
                _Chunk(
                    chunk_id="chk_9",
                    file_name="oib-rl-2.pdf",
                    page_number=7,
                    score=0.9134567,
                    metadata={"collection": "oib_knowledge", "shelf": "base", "doc_class": "oib_richtlinie"},
                ),
                # Chunk TEXT must never appear - only ids and scores. Fields
                # the producer did not set stay absent rather than null.
                _Chunk(chunk_id="chk_10", file_name=None, page_number=None, score=0.5),
            ]
        )

        assert picks == {
            "picked": [
                {
                    "chunk_id": "chk_9",
                    "file": "oib-rl-2.pdf",
                    "page": 7,
                    "score": 0.9135,
                    "collection": "oib_knowledge",
                    "shelf": "base",
                    "doc_class": "oib_richtlinie",
                },
                {"chunk_id": "chk_10", "score": 0.5},
            ]
        }
        assert json.dumps(picks)

    def test_caps_the_pick_list_independently_of_top_k(self):
        chunks = [_Chunk(chunk_id=f"c{i}", score=0.1) for i in range(PICK_LIMIT + 20)]
        picks = build_retrieval_output(chunks=chunks)
        assert len(picks["picked"]) == PICK_LIMIT


class TestEmission:
    @staticmethod
    def _steps(context_state):
        seen = []
        context_state.event_stream.get().subscribe(seen.append)
        return seen

    @pytest.fixture
    def context_state(self):
        from nat.builder.context import ContextState
        from nat.utils.reactive.subject import Subject

        state = ContextState.get()
        state.active_span_id_stack.set(["root"])
        state._event_stream.set(Subject())
        yield state
        state.active_span_id_stack.set(["root"])
        state._event_stream.set(Subject())

    def test_emits_one_balanced_pair_named_for_the_tool(self, context_state):
        steps = self._steps(context_state)

        emit_retrieval_span(
            tool_name="knowledge_search",
            search_input={"query": "q", "top_k": 8},
            picks={"picked": [{"chunk_id": "c1"}]},
        )

        assert [step.payload.event_type.value for step in steps] == ["FUNCTION_START", "FUNCTION_END"]
        assert [step.payload.name for step in steps] == ["retrieve.knowledge_search", "retrieve.knowledge_search"]
        start, end = steps
        assert start.UUID == end.UUID
        body_in = json.loads(start.payload.data.input)
        body_out = json.loads(end.payload.data.output)
        assert body_in == {"query": "q", "top_k": 8}
        assert body_out == {"picked": [{"chunk_id": "c1"}]}
        # The END closes with an output; the START opened with the input only.
        assert end.payload.data.output is not None

    def test_swallows_failures_instead_of_breaking_the_search(self, context_state):
        def _boom(_event):
            raise RuntimeError("stream is unhappy")

        context_state.event_stream.get().subscribe(_boom)

        emit_retrieval_span(tool_name="knowledge_search", search_input={}, picks={})

    def test_no_context_at_all_is_absorbed(self):
        """Outside a NAT run (tests, ingest threads) there is nothing to push to."""
        emit_retrieval_span(tool_name="x", search_input={}, picks={})

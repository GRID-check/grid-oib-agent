"""Named retrieves: which file names get their own filtered query per collection.

Layer 2 of ADR-0048. Similarity is not the only path to a document the user
just handed over — a `file_name`-filtered query per session/project collection
puts its passages in the candidate pool regardless of how the question was
phrased. It is a BOOST and never a filter: it only ever ADDS candidates.

All offline: no ChromaDB, no embeddings, no network.
"""

import pytest
from knowledge_layer.register import _augment_with_named_retrieves
from knowledge_layer.register import _named_retrieve_targets

from aiq_agent.common.focus_file import set_focused_file_name
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.turn_attachments import SessionAttachment
from aiq_agent.common.turn_attachments import set_turn_attachments
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult


@pytest.fixture(autouse=True)
def _clean_turn_signals():
    """Both signals are ContextVars that outlive a turn within a connection."""
    set_focused_file_name(None)
    set_turn_attachments(None)
    yield
    set_focused_file_name(None)
    set_turn_attachments(None)


def _attach(*names, state="ready"):
    set_turn_attachments([SessionAttachment(file_name=n, state=state) for n in names])


def _chunk(name: str, score: float = 0.5) -> Chunk:
    return Chunk(
        chunk_id=f"{name}-{score}",
        content=f"content of {name}",
        score=score,
        file_name=name,
        display_citation=name,
        content_type=ContentType.TEXT,
    )


def _result(chunks, success=True) -> RetrievalResult:
    return RetrievalResult(chunks=list(chunks), query="q", backend="llamaindex", success=success)


class _FakeRetriever:
    """Answers a `file_name` $eq filter out of a per-name chunk table."""

    def __init__(self, by_name=None, raises=False):
        self.by_name = by_name or {}
        self.raises = raises
        self.calls: list[tuple[str, str | None]] = []

    async def retrieve(self, *, query, collection_name, top_k, filters=None):
        name = ((filters or {}).get("file_name") or {}).get("$eq")
        self.calls.append((collection_name, name))
        if self.raises:
            raise RuntimeError("backend down")
        return _result([_chunk(name)] if name in self.by_name else [])


class TestNamedRetrieveTargets:
    def test_attachment_names_get_a_named_retrieve_in_session_collections(self):
        _attach("Statikbericht.pdf", "Einreichplan.pdf")

        assert _named_retrieve_targets(None, is_base_collection=False) == [
            "Statikbericht.pdf",
            "Einreichplan.pdf",
        ]

    def test_explicit_file_name_still_wins_over_attachments(self):
        """The agent named a file. Widening that to the other attachments would
        be a silent bait-and-switch — and `file_name=` is a hard filter anyway,
        so the extra retrieves would be discarded downstream."""
        _attach("Statikbericht.pdf", "Einreichplan.pdf")

        assert _named_retrieve_targets("OIB-RL-2.pdf", is_base_collection=False) == ["OIB-RL-2.pdf"]

    def test_explicit_file_name_also_wins_over_a_focused_file(self):
        set_focused_file_name("Peeked.pdf")

        assert _named_retrieve_targets("Named.pdf", is_base_collection=False) == ["Named.pdf"]

    def test_focus_file_name_wins_over_attachments(self):
        """`focus_file.py` keeps strict precedence: the visible peek is a
        deliberate, current statement of what the user is looking at."""
        set_focused_file_name("Peeked.pdf")
        _attach("Statikbericht.pdf")

        assert _named_retrieve_targets(None, is_base_collection=False) == ["Peeked.pdf"]

    def test_focus_file_name_behaviour_is_unchanged_without_attachments(self):
        set_focused_file_name("Peeked.pdf")

        assert _named_retrieve_targets(None, is_base_collection=False) == ["Peeked.pdf"]
        assert _named_retrieve_targets("Named.pdf", is_base_collection=False) == ["Named.pdf"]
        assert _named_retrieve_targets(None, is_base_collection=True) == []

    def test_nothing_stated_means_no_named_retrieve(self):
        assert _named_retrieve_targets(None, is_base_collection=False) == []

    def test_attachments_are_capped(self):
        _attach("a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf")

        targets = _named_retrieve_targets(None, is_base_collection=False)

        assert targets == ["a.pdf", "b.pdf", "c.pdf"]

    def test_attachments_do_not_filter_base_corpus_hits_out(self):
        """The base corpus never gets a named retrieve, so a turn with an
        attachment searches the shared corpus exactly as it did before."""
        _attach("Statikbericht.pdf")
        set_focused_file_name("Peeked.pdf")

        assert _named_retrieve_targets(None, is_base_collection=True) == []
        assert _named_retrieve_targets("Named.pdf", is_base_collection=True) == []

    def test_it_never_raises(self, monkeypatch):
        monkeypatch.setattr(
            "aiq_agent.common.turn_attachments.get_turn_attachments",
            lambda: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        monkeypatch.setattr(
            "aiq_agent.common.focus_file.get_focused_file_name",
            lambda: (_ for _ in ()).throw(RuntimeError("boom")),
        )

        # The explicit name is the caller's own argument and survives; the
        # unreadable ContextVars simply contribute nothing.
        assert _named_retrieve_targets("Named.pdf", is_base_collection=False) == ["Named.pdf"]
        assert _named_retrieve_targets(None, is_base_collection=False) == []


class TestAugmentWithNamedRetrieves:
    """The retrieves themselves: additive, stamped, and fail-open."""

    async def _augment(self, retriever, base_chunks, targets, shelf=Shelf.SESSION):
        return await _augment_with_named_retrieves(
            retriever,
            _result(base_chunks),
            query="q",
            collection="s_abc",
            shelf=shelf,
            candidate_k=5,
            targets=targets,
        )

    @pytest.mark.asyncio
    async def test_named_hits_are_added_to_the_similarity_hits(self):
        retriever = _FakeRetriever(by_name={"Statikbericht.pdf"})

        merged = await self._augment(retriever, [_chunk("OIB-RL-2.pdf")], ["Statikbericht.pdf"])

        names = [c.file_name for c in merged.chunks]
        assert "Statikbericht.pdf" in names
        # Additive: the similarity hit is still there.
        assert "OIB-RL-2.pdf" in names

    @pytest.mark.asyncio
    async def test_every_target_gets_its_own_query(self):
        retriever = _FakeRetriever(by_name={"a.pdf", "b.pdf"})

        merged = await self._augment(retriever, [], ["a.pdf", "b.pdf"])

        assert [name for _, name in retriever.calls] == ["a.pdf", "b.pdf"]
        assert {c.file_name for c in merged.chunks} == {"a.pdf", "b.pdf"}

    @pytest.mark.asyncio
    async def test_no_targets_means_no_extra_query_and_an_untouched_result(self):
        retriever = _FakeRetriever()
        original = [_chunk("OIB-RL-2.pdf")]

        merged = await self._augment(retriever, original, [])

        assert retriever.calls == []
        assert [c.file_name for c in merged.chunks] == ["OIB-RL-2.pdf"]

    @pytest.mark.asyncio
    async def test_named_chunks_carry_the_collection_and_shelf(self):
        retriever = _FakeRetriever(by_name={"Statikbericht.pdf"})

        merged = await self._augment(retriever, [], ["Statikbericht.pdf"])

        named = next(c for c in merged.chunks if c.file_name == "Statikbericht.pdf")
        assert named.metadata["collection"] == "s_abc"
        assert named.metadata["shelf"] == str(Shelf.SESSION)

    @pytest.mark.asyncio
    async def test_an_unknown_shelf_stamps_no_shelf(self):
        retriever = _FakeRetriever(by_name={"Statikbericht.pdf"})

        merged = await self._augment(retriever, [], ["Statikbericht.pdf"], shelf=None)

        named = next(c for c in merged.chunks if c.file_name == "Statikbericht.pdf")
        assert "shelf" not in named.metadata

    @pytest.mark.asyncio
    async def test_a_failing_named_retrieve_keeps_the_similarity_hits(self):
        retriever = _FakeRetriever(raises=True)

        merged = await self._augment(retriever, [_chunk("OIB-RL-2.pdf")], ["Statikbericht.pdf"])

        assert [c.file_name for c in merged.chunks] == ["OIB-RL-2.pdf"]

    @pytest.mark.asyncio
    async def test_a_target_with_no_hits_changes_nothing(self):
        retriever = _FakeRetriever(by_name={"Other.pdf"})

        merged = await self._augment(retriever, [_chunk("OIB-RL-2.pdf")], ["Missing.pdf"])

        assert [c.file_name for c in merged.chunks] == ["OIB-RL-2.pdf"]

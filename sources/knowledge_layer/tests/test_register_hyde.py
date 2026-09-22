"""HyDE-as-channel wiring (backlog item 14): config defaults, draft seam, fusion.

The production half of the ratchet: the channel is default-off, the draft
seam never calls the model for identifier-shaped queries and degrades to the
baseline on any failure, and hyde channels join the merge APPENDED after the
original query's — the original is always retrieved.
"""

from types import SimpleNamespace

from knowledge_layer import register as reg
from knowledge_layer.register import KnowledgeRetrievalConfig

from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult


class _FakeLLM:
    def __init__(self, reply="", error=None, hang=False):
        self.reply = reply
        self.error = error
        self.hang = hang
        self.calls = 0

    async def ainvoke(self, messages):
        import asyncio

        self.calls += 1
        if self.hang:
            await asyncio.sleep(30.0)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(content=self.reply)


class TestHydeConfig:
    def test_channel_is_default_off(self):
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        assert config.hyde_enabled is False

    def test_timeout_has_a_bounded_default(self):
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge")
        assert 1.0 <= config.hyde_timeout_seconds <= 30.0


_VAGUE = "was weißt du über die oib-richtlinien"


class TestDraftHydeText:
    async def test_disabled_never_calls_the_model(self):
        llm = _FakeLLM(reply="draft")
        assert await reg._draft_hyde_text(llm, _VAGUE, enabled=False, timeout_seconds=5) is None
        assert llm.calls == 0

    async def test_missing_model_never_drafts(self):
        assert await reg._draft_hyde_text(None, _VAGUE, enabled=True, timeout_seconds=5) is None

    async def test_identifier_shaped_query_never_calls_the_model(self):
        llm = _FakeLLM(reply="draft")
        for query in (
            "§ 5.1.1 OIB-RL 2 Gehweglänge",
            "OIB-Richtlinie 4",
            "was weißt du über die oib 2",
            "oib-rl_2_ausgabe_mai_2023.pdf",
            'Suche nach "Fluchtweg Breite"',
            "Was bedeutet Gebäudeklasse 4 für mein Haus?",
        ):
            assert await reg._draft_hyde_text(llm, query, enabled=True, timeout_seconds=5) is None, query
        assert llm.calls == 0

    async def test_vague_query_drafts(self):
        llm = _FakeLLM(reply="hypothetischer Abschnitt")
        draft = await reg._draft_hyde_text(llm, _VAGUE, enabled=True, timeout_seconds=5)
        assert draft == "hypothetischer Abschnitt"
        assert llm.calls == 1

    async def test_model_error_degrades_to_baseline(self):
        llm = _FakeLLM(error=RuntimeError("provider down"))
        assert await reg._draft_hyde_text(llm, _VAGUE, enabled=True, timeout_seconds=5) is None

    async def test_slow_model_degrades_to_baseline(self):
        llm = _FakeLLM(reply="zu spät", hang=True)
        draft = await reg._draft_hyde_text(llm, _VAGUE, enabled=True, timeout_seconds=0.05)
        assert draft is None


def _chunk(chunk_id: str, file_name: str) -> Chunk:
    return Chunk(
        chunk_id=chunk_id,
        content=f"Inhalt von {file_name}",
        file_name=file_name,
        display_citation=file_name,
        content_type=ContentType.TEXT,
    )


def _result(chunks: list[Chunk], *, query: str = "frage") -> RetrievalResult:
    return RetrievalResult(chunks=chunks, query=query, backend="test")


class TestHydeFusion:
    def test_original_chunks_are_always_retrieved(self):
        """The HyDE channels join APPENDED: whatever the baseline retrieved
        survives the widened merge (fused upward when both agree)."""
        baseline = _result([_chunk("a", "a.pdf"), _chunk("b", "b.pdf")])
        hyde = _result([_chunk("b", "b.pdf"), _chunk("c", "c.pdf")])
        merged = reg._merge_results([baseline, hyde], "frage", 16, "test")
        assert merged.success is True
        assert {_chunk_id(chunk) for chunk in merged.chunks} == {"a", "b", "c"}

    def test_hyde_only_failure_keeps_the_baseline(self):
        baseline = _result([_chunk("a", "a.pdf")])
        failed = RetrievalResult(chunks=[], query="entwurf", backend="test", success=False, error_message="boom")
        merged = reg._merge_results([baseline, failed], "frage", 16, "test")
        assert merged.success is True
        assert [_chunk_id(chunk) for chunk in merged.chunks] == ["a"]

    def test_no_hyde_channels_is_the_plain_baseline(self):
        baseline = _result([_chunk("a", "a.pdf"), _chunk("b", "b.pdf")])
        merged = reg._merge_results([baseline], "frage", 16, "test")
        assert [_chunk_id(chunk) for chunk in merged.chunks] == ["a", "b"]


def _chunk_id(chunk) -> str:
    return getattr(chunk, "chunk_id")

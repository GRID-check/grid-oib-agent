"""The retrieval loop: judge the fused pool, re-query when it is not enough.

Two halves. The judge (`knowledge_layer.requery`) is a bounded LLM call that
fails open to "sufficient". The loop in `knowledge_search` retrieves the
judge's alternative formulations from every collection in scope and fuses them
into the same RRF as new channels — one-shot when the judge is unset, silent,
or satisfied.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import knowledge_retrieval
from knowledge_layer.requery import SUFFICIENT
from knowledge_layer.requery import SufficiencyVerdict
from knowledge_layer.requery import _parse_verdict
from knowledge_layer.requery import judge_sufficiency

from aiq_agent.common.retrieval_settings import reset_retrieval_settings_cache


class _FakeLLM:
    def __init__(self, reply: str):
        self.reply = reply
        self.calls: list = []

    async def ainvoke(self, messages):
        self.calls.append(messages)
        return SimpleNamespace(content=self.reply)


class _RaisingLLM:
    async def ainvoke(self, messages):
        raise RuntimeError("provider down")


def _chunk(text: str, chunk_id: str = "c1"):
    # A real Chunk: the merge builds a real RetrievalResult, which validates.
    from aiq_agent.knowledge.schema import Chunk

    return Chunk(
        chunk_id=chunk_id,
        content=text,
        file_name="oib-rl_4.pdf",
        page_number=3,
        score=0.5,
        display_citation="oib-rl_4.pdf p.3",
        content_type="text",
    )


class TestParseVerdict:
    def test_reads_the_contract(self):
        verdict = _parse_verdict(
            '{"sufficient": false, "queries": ["Gehweglänge Fluchtweg", "Fluchtweglänge Gebäudeklasse 4"]}',
            original_query="wie lang darf der Fluchtweg sein",
            max_queries=2,
        )
        assert verdict == SufficiencyVerdict(
            sufficient=False, queries=["Gehweglänge Fluchtweg", "Fluchtweglänge Gebäudeklasse 4"]
        )
        assert verdict.wants_requery

    def test_tolerates_a_fence_and_prose_around_the_object(self):
        raw = 'Here you go:\n```json\n{"sufficient": true, "queries": []}\n```\nHope that helps'
        assert _parse_verdict(raw, original_query="q", max_queries=2) == SufficiencyVerdict(sufficient=True)

    def test_drops_the_original_query_duplicates_blanks_and_non_strings(self):
        verdict = _parse_verdict(
            '{"sufficient": false, "queries": ["  Fluchtweg  GK4 ", "fluchtweg gk4", "", 7, "Gehweglänge"]}',
            original_query="Fluchtweg GK4",
            max_queries=4,
        )
        assert verdict is not None
        assert verdict.queries == ["Gehweglänge"]

    def test_caps_at_max_queries(self):
        verdict = _parse_verdict('{"sufficient": false, "queries": ["a", "b", "c"]}', original_query="q", max_queries=2)
        assert verdict is not None
        assert verdict.queries == ["a", "b"]

    @pytest.mark.parametrize(
        "raw",
        ["not json", "[]", '{"queries": []}', '{"sufficient": "yes"}', '{"sufficient": 1}'],
    )
    def test_refuses_anything_that_is_not_the_contract(self, raw):
        assert _parse_verdict(raw, original_query="q", max_queries=2) is None


class TestJudgeSufficiency:
    async def test_unset_llm_is_sufficient_without_a_call(self):
        assert await judge_sufficiency(None, "q", [_chunk("x")], max_queries=2) is SUFFICIENT

    async def test_returns_the_models_verdict(self):
        llm = _FakeLLM('{"sufficient": false, "queries": ["Gehweglänge"]}')

        verdict = await judge_sufficiency(llm, "Fluchtweg", [_chunk("Brandabschnitt …")], max_queries=2)

        assert verdict.wants_requery
        assert verdict.queries == ["Gehweglänge"]
        system, user = llm.calls[0]
        assert "Fluchtweg" in user[1]
        assert "at most 2" in user[1]

    async def test_an_empty_pool_still_asks_for_alternatives(self):
        llm = _FakeLLM('{"sufficient": false, "queries": ["Gehweglänge"]}')

        verdict = await judge_sufficiency(llm, "Fluchtweg", [], max_queries=2)

        assert verdict.wants_requery
        assert "Candidates: none" in llm.calls[0][1][1]

    async def test_a_provider_error_is_sufficient(self):
        assert await judge_sufficiency(_RaisingLLM(), "q", [_chunk("x")], max_queries=2) is SUFFICIENT

    async def test_a_reply_off_contract_is_sufficient(self):
        assert await judge_sufficiency(_FakeLLM("no idea"), "q", [_chunk("x")], max_queries=2) is SUFFICIENT

    async def test_a_timeout_is_sufficient(self):
        import asyncio

        class _Slow:
            async def ainvoke(self, messages):
                await asyncio.sleep(0.2)
                return SimpleNamespace(content='{"sufficient": false, "queries": ["x"]}')

        assert await judge_sufficiency(_Slow(), "q", [], max_queries=2, timeout_seconds=0.01) is SUFFICIENT


# --- The loop inside knowledge_search ---------------------------------------


class _FakeResult:
    def __init__(self, chunks):
        self.chunks = chunks
        self.success = True
        self.backend = "fake"

    def model_copy(self, update=None):
        clone = _FakeResult(list(self.chunks))
        for key, value in (update or {}).items():
            setattr(clone, key, value)
        return clone


class _FakeRetriever:
    """Answers each query with the chunks a test registered for it."""

    backend_name = "fake"

    def __init__(self, answers: dict[str, list]):
        self.answers = answers
        self.retrieve_calls: list[dict] = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.retrieve_calls.append({"query": query, "collection": collection_name})
        return _FakeResult(list(self.answers.get(query, [])))


def _grounding(merged, query):
    return "|".join(chunk.chunk_id for chunk in merged.chunks) or "no results"


@pytest.fixture
def loop_harness(monkeypatch):
    def install(retriever, judge):
        monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: retriever)
        monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
        monkeypatch.setattr("knowledge_layer.register._format_results", _grounding)
        monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
        monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        reset_retrieval_settings_cache()

        async def _resolve(_builder, name):
            return judge

        monkeypatch.setattr("aiq_agent.common.get_langchain_llm", _resolve)

    return install


def _config(**overrides) -> KnowledgeRetrievalConfig:
    return KnowledgeRetrievalConfig(
        collection_name="oib_knowledge",
        include_base_collection=True,
        include_session_collection=False,
        generate_summary=False,
        top_k=8,
        max_chunks_per_document=0,
        **overrides,
    )


async def _search(config, query="Fluchtweg GK4"):
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(query=query))


class TestRetrievalLoop:
    async def test_no_judge_configured_is_one_shot(self, loop_harness):
        retriever = _FakeRetriever({"Fluchtweg GK4": [_chunk("a", "a")]})
        loop_harness(retriever, None)

        out = await _search(_config())

        assert [call["query"] for call in retriever.retrieve_calls] == ["Fluchtweg GK4"]
        assert out == "a"

    async def test_a_sufficient_pool_is_one_shot(self, loop_harness):
        retriever = _FakeRetriever({"Fluchtweg GK4": [_chunk("a", "a")]})
        loop_harness(retriever, _FakeLLM('{"sufficient": true, "queries": []}'))

        out = await _search(_config(requery_llm="judge"))

        assert [call["query"] for call in retriever.retrieve_calls] == ["Fluchtweg GK4"]
        assert out == "a"

    async def test_an_insufficient_pool_fans_out_and_fuses(self, loop_harness):
        # The original query finds one chunk; the paraphrase finds it AGAIN plus
        # a new one. Fusion must keep the shared chunk once and admit the new one.
        shared = _chunk("shared", "shared")
        retriever = _FakeRetriever(
            {
                "Fluchtweg GK4": [shared],
                "Gehweglänge Gebäudeklasse 4": [_chunk("new", "new"), shared],
            }
        )
        loop_harness(retriever, _FakeLLM('{"sufficient": false, "queries": ["Gehweglänge Gebäudeklasse 4"]}'))

        out = await _search(_config(requery_llm="judge", requery_max_queries=2))

        assert [call["query"] for call in retriever.retrieve_calls] == ["Fluchtweg GK4", "Gehweglänge Gebäudeklasse 4"]
        assert set(out.split("|")) == {"shared", "new"}
        assert out.count("shared") == 1
        # The chunk both formulations reached outranks the one only the paraphrase found.
        assert out.split("|")[0] == "shared"

    async def test_an_empty_first_pool_is_rescued_by_the_loop(self, loop_harness):
        retriever = _FakeRetriever({"Gehweglänge": [_chunk("found", "found")]})
        loop_harness(retriever, _FakeLLM('{"sufficient": false, "queries": ["Gehweglänge"]}'))

        out = await _search(_config(requery_llm="judge"))

        assert out == "found"

    async def test_a_failing_judge_keeps_the_first_pool(self, loop_harness):
        retriever = _FakeRetriever({"Fluchtweg GK4": [_chunk("a", "a")]})
        loop_harness(retriever, _RaisingLLM())

        out = await _search(_config(requery_llm="judge"))

        assert len(retriever.retrieve_calls) == 1
        assert out == "a"

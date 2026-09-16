"""Latency gates: skip the requery judge when the pool is already decisive.

Covers the gate cases (strong scores, known-entity/family lookup,
file-pinned precision lookup) and the hard cap of ONE requery firing per
turn, plus the per-fetch span enrichment and the short-overview card
suppression. Offline: no ChromaDB, no embeddings, no network.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import knowledge_layer.requery as requery_mod
import pytest
from knowledge_layer.requery import _has_narrow_anchor
from knowledge_layer.requery import claim_requery_slot
from knowledge_layer.requery import is_known_entity_lookup
from knowledge_layer.requery import requery_already_fired
from knowledge_layer.requery import reset_requery_slot
from knowledge_layer.requery import reset_requery_slot_for_turn
from knowledge_layer.requery import scores_decisively_strong
from knowledge_layer.requery import should_skip_judge

from aiq_agent.common.retrieval_settings import reset_retrieval_settings_cache


@pytest.fixture(autouse=True)
def _reset_slot():
    reset_requery_slot()
    # The per-turn ledger is process-wide and keyed by turn id; a test that
    # re-uses "turn-1" after another spent it must start from a clean ledger.
    requery_mod._REQUERY_SPENT_TURNS.clear()
    yield
    reset_requery_slot()
    requery_mod._REQUERY_SPENT_TURNS.clear()


def _scored(score: float):
    return SimpleNamespace(score=score)


class TestScoresDecisivelyStrong:
    def test_three_strong_hits_skip(self):
        assert scores_decisively_strong([_scored(0.92), _scored(0.88), _scored(0.85)]) is True

    def test_a_weak_top1_never_skips(self):
        assert scores_decisively_strong([_scored(0.82), _scored(0.80), _scored(0.79)]) is False

    def test_one_strong_hit_beside_two_weak_ones_is_a_neighbour(self):
        assert scores_decisively_strong([_scored(0.95), _scored(0.60), _scored(0.55)]) is False

    def test_fewer_than_three_chunks_never_skip_on_scores(self):
        assert scores_decisively_strong([_scored(0.99), _scored(0.99)]) is False
        assert scores_decisively_strong([]) is False

    def test_unreadable_scores_fail_open_to_the_judge(self):
        assert scores_decisively_strong([SimpleNamespace(), SimpleNamespace(), SimpleNamespace()]) is False
        assert scores_decisively_strong([_scored(float("nan")), _scored(0.9), _scored(0.9)]) is False


class TestIsKnownEntityLookup:
    @pytest.mark.parametrize(
        "query",
        [
            "Was weißt du über die OIB-Richtlinie 2?",
            "OIB-RL 2 Pkt 5.1 Fluchtweg",
            "oib-rl_2_ausgabe_mai_2023.pdf",
            "Siehe Punkt 3.5.2 der Richtlinie",
            "Welche Tabelle gilt für GK 4?",  # Tabelle marker — still addressed
        ],
    )
    def test_addressed_queries_match(self, query):
        assert is_known_entity_lookup(query) is True

    @pytest.mark.parametrize(
        "query",
        [
            "Wie lang darf der Fluchtweg sein?",
            "Was liegt eigentlich alles in unserem Ordner Brandschutz?",
            "",
            "   ",
        ],
    )
    def test_topic_questions_do_not_match(self, query):
        assert is_known_entity_lookup(query) is False


class TestShouldSkipJudge:
    def test_file_pinned_is_the_precision_lookup(self):
        skip, reason = should_skip_judge("anything", [_scored(0.5)], file_name="oib-rl_2.pdf")
        assert (skip, reason) == (True, "file_pinned")

    def test_strong_scores_skip_on_the_calibrated_embedder(self):
        chunks = [_scored(0.92), _scored(0.88), _scored(0.85)]
        assert should_skip_judge(
            "Wie lang darf der Fluchtweg sein?",
            chunks,
            embedding_model="intfloat/multilingual-e5-small",
        ) == (True, "strong_scores")

    def test_strong_scores_do_not_skip_on_an_uncalibrated_embedder(self):
        # The floors are a number on one model's cosine distribution; another
        # model's 0.88 is not the same fact, so the judge stays in.
        chunks = [_scored(0.92), _scored(0.88), _scored(0.85)]
        assert should_skip_judge(
            "Wie lang darf der Fluchtweg sein?",
            chunks,
            embedding_model="nvidia/llama-nemotron-embed-vl-1b-v2",
        ) == (False, "")

    def test_strong_scores_do_not_skip_when_the_model_is_unknown(self):
        chunks = [_scored(0.92), _scored(0.88), _scored(0.85)]
        assert should_skip_judge("Wie lang darf der Fluchtweg sein?", chunks) == (False, "")

    def test_known_entity_skips(self):
        chunks = [_scored(0.5), _scored(0.4), _scored(0.3)]
        assert should_skip_judge("OIB-RL 2 Pkt 5.1", chunks) == (True, "known_entity")

    def test_plain_topic_with_weak_pool_judges(self):
        chunks = [_scored(0.5), _scored(0.4), _scored(0.3)]
        assert should_skip_judge("Wie lang darf der Fluchtweg sein?", chunks) == (False, "")


class TestKnownEntityAnchoring:
    def test_table_topic_without_number_stays_eligible(self):
        chunks = [_scored(0.5), _scored(0.4), _scored(0.3)]
        assert is_known_entity_lookup("Welche Tabelle gilt für GK 4?") is True
        assert _has_narrow_anchor("Welche Tabelle gilt für GK 4?") is False
        assert should_skip_judge("Welche Tabelle gilt für GK 4?", chunks) == (False, "")

    def test_table_with_number_skips(self):
        chunks = [_scored(0.5), _scored(0.4), _scored(0.3)]
        assert should_skip_judge("Tabelle 1b Fluchtwegbreite", chunks) == (True, "known_entity")

    def test_bare_family_without_number_stays_eligible(self):
        chunks = [_scored(0.5), _scored(0.4), _scored(0.3)]
        assert should_skip_judge("Erzähl mir was über OIB-RL", chunks) == (False, "")

    def test_caller_narrow_scope_rescues_bare_mention(self):
        chunks = [_scored(0.5), _scored(0.4), _scored(0.3)]
        assert should_skip_judge("Welche Tabelle gilt?", chunks, doc_class="oib_richtlinie") == (
            True,
            "known_entity",
        )


class TestEmptyPoolForcing:
    def test_empty_pool_with_file_pinned_still_judges(self):
        assert should_skip_judge("OIB-RL 2 Pkt 5.1", [], file_name="oib-rl_2.pdf") == (False, "")

    def test_empty_pool_with_known_entity_still_judges(self):
        assert should_skip_judge("OIB-RL 2 Pkt 5.1", []) == (False, "")

    def test_empty_pool_with_topic_still_judges(self):
        assert should_skip_judge("Wie lang darf der Fluchtweg sein?", []) == (False, "")


class TestRequeryCap:
    def test_first_claim_wins_second_loses(self):
        assert requery_already_fired() is False
        assert claim_requery_slot() is True
        assert requery_already_fired() is True
        assert claim_requery_slot() is False

    def test_reset_opens_a_new_turn(self):
        claim_requery_slot()
        reset_requery_slot()
        assert requery_already_fired() is False
        assert claim_requery_slot() is True


class TestSlotResetPerTurn:
    async def test_concurrent_rounds_of_one_turn_share_the_cap(self):
        # Two retrieval rounds of ONE turn run as parallel tasks, each with a
        # copy of the context: the ContextVar alone let both claim and both
        # widen. The shared ledger is the budget that holds.
        reset_requery_slot_for_turn(turn_id="turn-parallel")

        async def _search():
            return claim_requery_slot()

        claims = await asyncio.gather(_search(), _search())

        assert claims.count(True) == 1
        assert requery_already_fired() is True

    def test_same_turn_id_keeps_the_cap(self):
        reset_requery_slot_for_turn(turn_id="turn-1")
        assert claim_requery_slot() is True
        reset_requery_slot_for_turn(turn_id="turn-1")
        assert claim_requery_slot() is False

    def test_new_turn_id_opens_a_slot(self):
        reset_requery_slot_for_turn(turn_id="turn-1")
        assert claim_requery_slot() is True
        reset_requery_slot_for_turn(turn_id="turn-2")
        assert claim_requery_slot() is True

    def test_stamp_fallback_zero_opens_nonzero_keeps(self):
        reset_requery_slot_for_turn(turn_id="turn-1")
        assert claim_requery_slot() is True
        # Stamp path without a turn id: 1 keeps the spent cap, 0 opens a new one.
        import knowledge_layer.requery as requery_mod

        original = requery_mod._current_turn_id
        requery_mod._current_turn_id = lambda: None
        try:
            reset_requery_slot_for_turn(span_round=1)
            assert claim_requery_slot() is False
            reset_requery_slot_for_turn(span_round=0)
            assert claim_requery_slot() is True
        finally:
            requery_mod._current_turn_id = original

    def test_unstamped_caller_gets_a_slot(self):
        import knowledge_layer.requery as requery_mod

        original = requery_mod._current_turn_id
        requery_mod._current_turn_id = lambda: None
        try:
            assert claim_requery_slot() is True
            reset_requery_slot_for_turn(span_round=None)
            assert claim_requery_slot() is True
        finally:
            requery_mod._current_turn_id = original


# --- The loop inside knowledge_search ---------------------------------------


class _FakeLLM:
    def __init__(self, reply: str):
        self.reply = reply
        self.calls: list = []

    async def ainvoke(self, messages):
        self.calls.append(messages)
        return SimpleNamespace(content=self.reply)


def _chunk(text: str, chunk_id: str = "c1", score: float = 0.5):
    from aiq_agent.knowledge.schema import Chunk

    return Chunk(
        chunk_id=chunk_id,
        content=text,
        file_name="oib-rl_4.pdf",
        page_number=3,
        score=score,
        display_citation="oib-rl_4.pdf p.3",
        content_type="text",
    )


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
    backend_name = "fake"
    #: The score gate is only allowed on a calibrated embedder; the harness
    #: simulates a deployment that runs the one the floors were calibrated on.
    embed_model_name = "multilingual-e5-small"

    def __init__(self, answers: dict[str, list]):
        self.answers = answers
        self.retrieve_calls: list[dict] = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.retrieve_calls.append({"query": query, "collection": collection_name})
        return _FakeResult(list(self.answers.get(query, [])))


@pytest.fixture
def loop_harness(monkeypatch):
    def install(retriever, judge):
        monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: retriever)
        monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
        monkeypatch.setattr(
            "knowledge_layer.register._format_results",
            # The real renderer carries every decoration inside its bytes; the fake does too.
            lambda merged, query, notice="", trailer="", preamble_note="", opened_files=frozenset(): (
                notice + preamble_note + ("|".join(c.chunk_id for c in merged.chunks) or "no results") + trailer
            ),
        )
        monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
        monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        reset_retrieval_settings_cache()

        async def _resolve(_builder, name):
            return judge

        monkeypatch.setattr("aiq_agent.common.get_langchain_llm", _resolve)

    return install


def _config(**overrides):
    from knowledge_layer.register import KnowledgeRetrievalConfig

    return KnowledgeRetrievalConfig(
        collection_name="oib_knowledge",
        include_base_collection=True,
        include_session_collection=False,
        generate_summary=False,
        top_k=8,
        max_chunks_per_document=0,
        **overrides,
    )


async def _search(config, query="Fluchtweg GK4", **scope):
    from knowledge_layer.register import knowledge_retrieval

    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(query=query, **scope))


class TestGateSkipsTheJudge:
    async def test_strong_scores_never_call_the_judge(self, loop_harness):
        strong = [_chunk("a", "a", 0.93), _chunk("b", "b", 0.90), _chunk("c", "c", 0.88)]
        retriever = _FakeRetriever({"Fluchtweg GK4": strong})
        judge = _FakeLLM('{"sufficient": false, "queries": ["Gehweglänge"]}')
        loop_harness(retriever, judge)

        out = await _search(_config(requery_llm="judge"))

        assert judge.calls == []
        assert [call["query"] for call in retriever.retrieve_calls] == ["Fluchtweg GK4"]
        assert "a" in out

    async def test_known_entity_lookup_never_calls_the_judge(self, loop_harness):
        retriever = _FakeRetriever({"OIB-RL 2 Pkt 5.1": [_chunk("a", "a")]})
        judge = _FakeLLM('{"sufficient": false, "queries": ["Gehweglänge"]}')
        loop_harness(retriever, judge)

        out = await _search(_config(requery_llm="judge"), query="OIB-RL 2 Pkt 5.1")

        assert judge.calls == []
        assert [call["query"] for call in retriever.retrieve_calls] == ["OIB-RL 2 Pkt 5.1"]
        assert "a" in out

    async def test_one_firing_per_turn_second_search_is_one_shot(self, loop_harness, monkeypatch):
        # Two sequential searches in one turn (same turn id): the first fires,
        # the second stays one-shot even though its judge would also have asked
        # for more.
        import knowledge_layer.requery as requery_mod

        monkeypatch.setattr(requery_mod, "_current_turn_id", lambda: "turn-1")
        first = [_chunk("a", "a")]
        retriever = _FakeRetriever(
            {
                "erste Frage": first,
                "Gehweglänge": [_chunk("new", "new")],
                "zweite Frage": [_chunk("b", "b")],
                "Fluchtweglänge": [_chunk("new2", "new2")],
            }
        )
        judge = _FakeLLM('{"sufficient": false, "queries": ["Gehweglänge"]}')
        loop_harness(retriever, judge)

        await _search(_config(requery_llm="judge"), query="erste Frage")
        first_judge_calls = len(judge.calls)
        assert first_judge_calls == 1

        judge.reply = '{"sufficient": false, "queries": ["Fluchtweglänge"]}'
        await _search(_config(requery_llm="judge"), query="zweite Frage")

        # The cap held: no second judge call, no second fan-out.
        assert len(judge.calls) == 1
        assert [call["query"] for call in retriever.retrieve_calls].count("Fluchtweglänge") == 0

    async def test_unstamped_searches_each_get_a_slot(self, loop_harness, monkeypatch):
        # No turn id, no round stamp: each caller gets a slot rather than
        # inheriting the previous search's spent cap.
        import knowledge_layer.requery as requery_mod

        monkeypatch.setattr(requery_mod, "_current_turn_id", lambda: None)
        retriever = _FakeRetriever(
            {
                "erste Frage": [_chunk("a", "a")],
                "Gehweglänge": [_chunk("new", "new")],
                "zweite Frage": [_chunk("b", "b")],
                "Fluchtweglänge": [_chunk("new2", "new2")],
            }
        )
        judge = _FakeLLM('{"sufficient": false, "queries": ["Gehweglänge"]}')
        loop_harness(retriever, judge)

        await _search(_config(requery_llm="judge"), query="erste Frage")
        assert len(judge.calls) == 1

        judge.reply = '{"sufficient": false, "queries": ["Fluchtweglänge"]}'
        await _search(_config(requery_llm="judge"), query="zweite Frage")

        assert len(judge.calls) == 2
        assert [call["query"] for call in retriever.retrieve_calls].count("Fluchtweglänge") == 1

    async def test_empty_pool_widens_once_despite_lookup_shape(self, loop_harness, monkeypatch):
        # Empty pool forces the judge even for a lookup-shaped query: the
        # first pool is nothing, so the loop still tries one reformulation.
        import knowledge_layer.requery as requery_mod

        monkeypatch.setattr(requery_mod, "_current_turn_id", lambda: None)
        retriever = _FakeRetriever(
            {
                "OIB-RL 2 Pkt 5.1": [],
                "Gehweglänge": [_chunk("new", "new")],
            }
        )
        judge = _FakeLLM('{"sufficient": false, "queries": ["Gehweglänge"]}')
        loop_harness(retriever, judge)

        out = await _search(_config(requery_llm="judge"), query="OIB-RL 2 Pkt 5.1")

        assert len(judge.calls) == 1
        assert "new" in out


class TestSpanEnrichment:
    def test_normalized_query_folds_whitespace_and_case(self):
        from sources.knowledge_layer.src.register import _normalized_query_for_span

        assert _normalized_query_for_span("  FluchtWEG   GK4\n") == "fluchtweg gk4"

    def test_citation_key_prefers_the_stored_display_citation(self):
        from sources.knowledge_layer.src.register import _citation_key_for_span

        chunk = SimpleNamespace(display_citation="oib-rl_2.pdf p.12", file_name="x.pdf", page_number=5)
        assert _citation_key_for_span(chunk) == "oib-rl_2.pdf p.12"
        chunk = SimpleNamespace(display_citation=None, file_name="Plan.pdf", page_number=4)
        assert _citation_key_for_span(chunk) == "Plan.pdf, p.4"
        assert _citation_key_for_span(SimpleNamespace()) is None

    async def test_search_emits_round_tool_query_and_citation_keys(self, loop_harness, monkeypatch):
        captured: dict = {}

        def _capture(*, tool_name, search_input, picks):
            captured["tool_name"] = tool_name
            captured["input"] = dict(search_input)
            captured["picks"] = dict(picks)

        monkeypatch.setattr("aiq_agent.observability.retrieval_trace.emit_retrieval_span", _capture)
        retriever = _FakeRetriever({"Fluchtweg GK4": [_chunk("a", "a")]})
        loop_harness(retriever, _FakeLLM('{"sufficient": true, "queries": []}'))

        await _search(_config(), query="Fluchtweg GK4")

        assert captured["tool_name"] == "knowledge_search"
        assert captured["input"]["tool"] == "knowledge_search"
        assert captured["input"]["normalized_query"] == "fluchtweg gk4"
        assert captured["picks"]["citation_keys"] == ["oib-rl_4.pdf p.3"]

    async def test_gated_search_records_why_the_judge_did_not_run(self, loop_harness, monkeypatch):
        captured: dict = {}

        def _capture(*, tool_name, search_input, picks):
            captured["input"] = dict(search_input)

        monkeypatch.setattr("aiq_agent.observability.retrieval_trace.emit_retrieval_span", _capture)
        retriever = _FakeRetriever({"OIB-RL 2 Pkt 5.1": [_chunk("a", "a")]})
        loop_harness(retriever, _FakeLLM('{"sufficient": false, "queries": ["x"]}'))

        await _search(_config(requery_llm="judge"), query="OIB-RL 2 Pkt 5.1")

        assert captured["input"]["requery_skipped"] == "known_entity"
        assert captured["input"]["requery_fired"] is False


class TestCardSuppression:
    def test_short_overview_without_verdict_is_suppressed(self):
        from aiq_agent.agents.piloti.answer_pipeline import _should_suppress_meta_cards

        assert _should_suppress_meta_cards("Kurzer Überblick. " * 10, {"takeaways": [{"text": "x"}]}) is True

    def test_long_prose_keeps_its_cards(self):
        from aiq_agent.agents.piloti.answer_pipeline import _should_suppress_meta_cards

        assert _should_suppress_meta_cards("x" * 2000, {"takeaways": [{"text": "x"}]}) is False

    def test_a_copyable_verdict_keeps_its_cards(self):
        from aiq_agent.agents.piloti.answer_pipeline import _should_suppress_meta_cards

        meta = {"verdict": {"value": "40 m", "subject": "Fluchtweglänge"}}
        assert _should_suppress_meta_cards("kurz", meta) is False
        assert _should_suppress_meta_cards("kurz", {"kind": "ruling", "summary": "s"}) is False

    def test_nothing_to_drop_is_not_suppression(self):
        from aiq_agent.agents.piloti.answer_pipeline import _should_suppress_meta_cards

        assert _should_suppress_meta_cards("kurz", None) is False
        assert _should_suppress_meta_cards("kurz", {}) is False

    def test_suppression_clears_the_registry_and_strips_markers(self):
        from aiq_agent.agents.piloti.answer_pipeline import _suppress_cards
        from aiq_agent.cards.registry import CardRegistry
        from aiq_agent.cards.registry import get_card_registry
        from aiq_agent.cards.registry import set_card_registry

        registry = CardRegistry()
        registry.add({"type": "summary", "text": "x"})
        token = set_card_registry(registry)
        try:
            content, meta, suppressed = _suppress_cards(
                "Kurzer Überblick. " * 10 + "\n\n[[card:1]]\n",
                {"takeaways": [{"text": "x"}]},
            )
            assert suppressed is True
            assert meta is None
            assert "[[card:1]]" not in content
            assert get_card_registry() is not None
            assert len(get_card_registry()) == 0
        finally:
            from aiq_agent.cards.registry import reset_card_registry

            reset_card_registry(token)

    def test_no_suppression_leaves_content_and_meta_untouched(self):
        from aiq_agent.agents.piloti.answer_pipeline import _suppress_cards

        content, meta, suppressed = _suppress_cards("x" * 2000, {"takeaways": [{"text": "x"}]})
        assert (suppressed, meta) == (False, {"takeaways": [{"text": "x"}]})
        assert content == "x" * 2000

    def test_system_card_vetoes_suppression(self):
        """A short drafting answer must keep its document_draft card.

        Regression for TestTheThreeDraftingTurnShapes/commission: the floor
        (short direct prose, no verdict) matches a drafting turn exactly, but
        the draft card is the product announcement, not trailer decoration.
        """
        from aiq_agent.agents.piloti.answer_pipeline import _suppress_cards
        from aiq_agent.cards.registry import CardRegistry
        from aiq_agent.cards.registry import get_card_registry
        from aiq_agent.cards.registry import set_card_registry

        registry = CardRegistry()
        registry.add({"type": "document_draft", "title": "t", "path": "/entwuerfe/x.md", "bytes": 3, "version": 1})
        token = set_card_registry(registry)
        try:
            meta = {"v": 1, "kind": "direct"}
            content, out_meta, suppressed = _suppress_cards("Der Aktenvermerk liegt als Entwurf vor.", meta)
            assert suppressed is False
            assert out_meta == meta
            assert len(get_card_registry()) == 1
        finally:
            from aiq_agent.cards.registry import reset_card_registry

            reset_card_registry(token)

"""The backend's own account of a turn's retrieval rounds.

The Herleitung spine must read what happened instead of reconstructing it
from step names: per round what it was asked (query, tools, purpose), what it
returned (docs with title/detail/shelf), and what was NEW. These tests pin
that join — announcements recorded beside ``emit_retrieval`` plus captured
lane hits — through the three shapes that matter: same docs re-opened (fold),
new docs (new layer), and nothing announced (absent, not null).
"""

from types import SimpleNamespace

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.agent import _charge_tool_calls
from aiq_agent.agents.piloti.answer_pipeline import FinalAnswer
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.agents.piloti.ledger import build_retrieval_ledger
from aiq_agent.agents.piloti.models.state import ResearchAgentState


def _announcement(index, tools, corpora, purpose, query=None, reason=None):
    record = {
        "index": index,
        "key": "status.retrieval.withQuery",
        "tools": tools,
        "corpora": corpora,
        "purpose": purpose,
    }
    if query is not None:
        record["query"] = query
    if reason is not None:
        record["reason"] = reason
    return record


def _hit(round_index, name, detail=None):
    hit = {"round": round_index, "name": name}
    if detail is not None:
        hit["detail"] = detail
    return hit


def test_same_docs_reopened_carry_no_new_docs():
    """The reference shape: search finds 4 docs, reads open the same 4."""
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"], "first_search", query="OIB 2"),
        _announcement(1, ["read_passage"], ["knowledge"], "open"),
    ]
    hits = [
        _hit(0, "oib-rl_2.pdf"),
        _hit(0, "oib-rl_2.1.pdf"),
        _hit(1, "oib-rl_2.pdf", "p.12"),
        _hit(1, "oib-rl_2.1.pdf", "p.3"),
    ]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert [entry["index"] for entry in ledger] == [0, 1]
    assert ledger[0]["new_docs"] == ["oib-rl_2.pdf", "oib-rl_2.1.pdf"]
    assert ledger[1]["new_docs"] == []
    assert ledger[1]["documents"] == 2
    assert ledger[0]["query"] == "OIB 2"


def test_new_docs_are_listed_per_round_case_insensitively():
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"], "first_search"),
        _announcement(1, ["knowledge_search"], ["knowledge"], "search"),
    ]
    hits = [_hit(0, "OIB-RL_2.pdf"), _hit(1, "oib-rl_2.pdf"), _hit(1, "Brandschutzkonzept.pdf")]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert ledger[1]["new_docs"] == ["Brandschutzkonzept.pdf"]


def test_no_announcements_means_no_ledger_not_an_empty_one():
    assert build_retrieval_ledger([], [_hit(0, "x.pdf")]) is None
    assert build_retrieval_ledger(None, None) is None


def test_an_announced_round_with_no_hits_stays_a_layer_without_docs():
    """A search that returned nothing is still something the turn did."""
    announcements = [_announcement(0, ["knowledge_search"], ["knowledge"], "first_search")]
    ledger = build_retrieval_ledger(announcements, [])
    assert ledger is not None
    assert ledger[0]["docs"] == []
    assert ledger[0]["new_docs"] == []
    assert ledger[0]["hits"] == 0


def test_unstamped_hits_follow_capture_order_like_stream_order():
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"], "first_search"),
        _announcement(1, ["read_passage"], ["knowledge"], "open"),
    ]
    hits = [_hit(0, "a.pdf"), {"round": None, "name": "b.pdf"}, _hit(1, "c.pdf")]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert [doc["name"] for doc in ledger[0]["docs"]] == ["a.pdf", "b.pdf"]
    assert [doc["name"] for doc in ledger[1]["docs"]] == ["c.pdf"]
    assert ledger[1]["new_docs"] == ["c.pdf"]


def test_duplicate_name_and_detail_pairs_count_once():
    announcements = [_announcement(0, ["knowledge_search"], ["knowledge"], "first_search")]
    hits = [_hit(0, "a.pdf", "p.12"), _hit(0, "a.pdf", "p.12"), _hit(0, "a.pdf", "p.31")]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert ledger[0]["hits"] == 2
    assert ledger[0]["documents"] == 1


def _response(tool_calls, content=""):
    return SimpleNamespace(tool_calls=tool_calls, content=content)


def _state(**overrides):
    return ResearchAgentState(messages=[HumanMessage(content="Was weißt du über die OIB 2?")], **overrides)


def test_charge_threads_two_rounds_with_purposes_first_search_then_open():
    search = [{"name": "knowledge_search", "args": {"query": "OIB 2"}}]
    opens = [{"name": "read_passage", "args": {"document": "oib-rl_2.pdf", "punkt": "3.5.2"}}]
    state = _state()
    research, _interaction, retrieval_round, first = _charge_tool_calls(_response(search), state, 9)
    assert (research, retrieval_round) == (1, 1)
    assert first is not None
    assert first["purpose"] == "first_search"
    state = state.model_copy(
        update={
            "tool_iterations": research,
            "retrieval_round": retrieval_round,
            "retrieval_rounds": [first],
        }
    )
    _research, _interaction, retrieval_round, second = _charge_tool_calls(
        _response(opens, "Die Richtlinie gilt grundsätzlich."), state, 9
    )
    assert retrieval_round == 2
    assert second is not None
    assert second["purpose"] == "open"
    assert second["reason"] == "Die Richtlinie gilt grundsätzlich."


def test_charge_records_nothing_for_action_batches():
    state = _state()
    _research, _interaction, retrieval_round, record = _charge_tool_calls(
        _response([{"name": "remember", "args": {}}]), state, 9
    )
    assert retrieval_round == 0
    assert record is None


def test_assemble_attaches_the_ledger_and_omits_it_without_rounds():
    announcements = [_announcement(0, ["knowledge_search"], ["knowledge"], "first_search")]
    hits = [_hit(0, "oib-rl_2.pdf", "p.12")]
    graph_result = {"retrieval_rounds": announcements, "answer_measurement_grounded": False}
    final = FinalAnswer(messages=[], answered=False)
    with_rounds = assemble_result(graph_result, final, turn_sources=[], turn_measurements=[], lane_hits=hits)
    assert with_rounds.retrieval_ledger is not None
    assert with_rounds.retrieval_ledger[0]["new_docs"] == ["oib-rl_2.pdf"]
    without_rounds = assemble_result(
        {"answer_measurement_grounded": False}, final, turn_sources=[], turn_measurements=[]
    )
    assert without_rounds.retrieval_ledger is None

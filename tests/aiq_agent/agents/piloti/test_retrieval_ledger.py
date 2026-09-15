"""The backend's own account of a turn's retrieval rounds.

The Herleitung will read what happened (phase b — no renderer yet) instead of
reconstructing it from step names: per round what it was asked (query, tools),
what it returned (docs with title/detail/shelf), and what was NEW. These tests
pin that join — announcements recorded beside ``emit_retrieval`` plus captured
lane hits — through the three shapes that matter: same docs re-opened (fold),
new docs (new layer), and nothing announced (absent, not null).
"""

import json
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.agent import _charge_tool_calls
from aiq_agent.agents.piloti.answer_pipeline import FinalAnswer
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.agents.piloti.ledger import build_retrieval_ledger
from aiq_agent.agents.piloti.models.state import ResearchAgentState


def _announcement(index, tools, corpora, query=None, reason=None, key="status.retrieval.withQuery"):
    """An announcement dict shaped like ``record_round_announcement`` output."""
    record = {
        "index": index,
        "key": key,
        "tools": tools,
        "corpora": corpora,
    }
    if query is not None:
        record["query"] = query
    if reason is not None:
        record["reason"] = reason
    return record


def _hit(round_index, name, detail=None):
    """A captured lane hit shaped like the emitter records it."""
    hit = {"round": round_index, "name": name}
    if detail is not None:
        hit["detail"] = detail
    return hit


def test_same_docs_reopened_carry_no_new_docs():
    """The reference shape: search finds 4 docs, reads open the same 4."""
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"], query="OIB 2"),
        _announcement(1, ["read_passage"], ["knowledge"]),
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
    """A later round re-showing a file does not count it as new, whatever the casing."""
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"]),
        _announcement(1, ["knowledge_search"], ["knowledge"]),
    ]
    hits = [_hit(0, "OIB-RL_2.pdf"), _hit(1, "oib-rl_2.pdf"), _hit(1, "Brandschutzkonzept.pdf")]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert ledger[1]["new_docs"] == ["Brandschutzkonzept.pdf"]


def test_no_announcements_means_no_ledger_not_an_empty_one():
    """No rounds announced means no ledger — absent, not an empty list."""
    assert build_retrieval_ledger([], [_hit(0, "x.pdf")]) is None
    assert build_retrieval_ledger(None, None) is None


def test_an_announced_round_with_no_hits_stays_a_layer_without_docs():
    """A search that returned nothing is still something the turn did."""
    announcements = [_announcement(0, ["knowledge_search"], ["knowledge"])]
    ledger = build_retrieval_ledger(announcements, [])
    assert ledger is not None
    assert ledger[0]["docs"] == []
    assert ledger[0]["new_docs"] == []
    assert ledger[0]["hits"] == 0


def test_unstamped_hits_follow_capture_order_like_stream_order():
    """Unstamped hits follow capture order, like the frontend's stream order."""
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"]),
        _announcement(1, ["read_passage"], ["knowledge"]),
    ]
    hits = [_hit(0, "a.pdf"), {"round": None, "name": "b.pdf"}, _hit(1, "c.pdf")]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert [doc["name"] for doc in ledger[0]["docs"]] == ["a.pdf", "b.pdf"]
    assert [doc["name"] for doc in ledger[1]["docs"]] == ["c.pdf"]
    assert ledger[1]["new_docs"] == ["c.pdf"]


def test_duplicate_name_and_detail_pairs_count_once():
    """Identical name+detail pairs count once; one file at two pages counts twice."""
    announcements = [_announcement(0, ["knowledge_search"], ["knowledge"])]
    hits = [_hit(0, "a.pdf", "p.12"), _hit(0, "a.pdf", "p.12"), _hit(0, "a.pdf", "p.31")]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert ledger[0]["hits"] == 2
    assert ledger[0]["documents"] == 1


def _response(tool_calls, content=""):
    """A bare tool-call response for driving ``_charge_tool_calls``."""
    return SimpleNamespace(tool_calls=tool_calls, content=content)


def _state(**overrides):
    """A fresh research state for the reference question."""
    return ResearchAgentState(messages=[HumanMessage(content="Was weißt du über die OIB 2?")], **overrides)


def test_charge_threads_two_rounds_with_their_facts():
    """Two charge calls accumulate rounds with their facts, in slot order."""
    search = [{"name": "knowledge_search", "args": {"query": "OIB 2"}}]
    opens = [{"name": "read_passage", "args": {"document": "oib-rl_2.pdf", "punkt": "3.5.2"}}]
    state = _state()
    research, _interaction, retrieval_round, first = _charge_tool_calls(_response(search), state, 9)
    assert (research, retrieval_round) == (1, 1)
    assert first is not None
    assert first["key"] == "status.retrieval.withQuery"
    assert first["query"] == "OIB 2"
    assert "purpose" not in first
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
    assert second["key"] == "status.retrieval.punkt"
    assert second["reason"] == "Die Richtlinie gilt grundsätzlich."


def test_charge_records_nothing_for_action_batches():
    """Action batches announce no round and advance no counter."""
    state = _state()
    _research, _interaction, retrieval_round, record = _charge_tool_calls(
        _response([{"name": "remember", "args": {}}]), state, 9
    )
    assert retrieval_round == 0
    assert record is None


def test_charge_without_tool_calls_keeps_the_tuple_shape():
    """A tool-free synthesis reply still unpacks in the agent node."""
    state = _state()
    assert _charge_tool_calls(_response([], "Die Antwort."), state, 9) == (0, 0, 0, None)


def test_assemble_attaches_the_ledger_and_omits_it_without_rounds():
    """The ledger attaches when rounds exist and stays absent otherwise."""
    announcements = [_announcement(0, ["knowledge_search"], ["knowledge"])]
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


def test_builder_output_matches_the_wire_fixture():
    """The wire contract, pinned on both sides (see message-retrieval-ledger.ts).

    The frontend sanitizes this exact file; the builder must produce it byte
    for byte from the announcements and hits below, so a renamed key cannot
    ship green on either side.
    """
    fixture = json.loads(
        Path(__file__)
        .parents[4]
        .joinpath("tests/fixtures/herleitung/retrieval_ledger_wire.json")
        .read_text(encoding="utf-8")
    )
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"], query="Fluchtweglänge GK4"),
        _announcement(
            1,
            ["read_passage"],
            ["knowledge"],
            reason="Die Grundregel steht.",
            key="status.retrieval.punkt",
        ),
    ]
    hits = [
        {"round": 0, "name": "OIB-RL_2.pdf", "title": "OIB-Richtlinie 2, Ausgabe Mai 2023"},
        {"round": 0, "name": "Brandschutzkonzept.pdf"},
        {
            "round": 1,
            "name": "OIB-RL_2.pdf",
            "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
            "detail": "p.12",
        },
        {"round": 1, "name": "Brandschutzkonzept.pdf", "detail": "p.3"},
    ]
    assert build_retrieval_ledger(announcements, hits) == fixture

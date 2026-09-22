"""The backend's own account of a turn's retrieval rounds.

The Herleitung will read what happened (phase b — no renderer yet) instead of
reconstructing it from step names: per round what it was asked (query, tools),
what it returned (docs with title/detail/shelf), and what was NEW. These tests
pin that join — announcements recorded beside ``emit_retrieval`` plus captured
lane hits — and, above all, what counts as a REPEAT: the same passage fetched
twice, or a file an earlier round already opened. A search that merely ranked a
document is not work anybody has done yet.
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


def _hit(round_index, name, detail=None, tool=None):
    """A captured lane hit shaped like the emitter records it.

    ``tool`` is the stamp ``lane_tool_scope`` puts on a hit. Left off, the hit
    is the shape a tool that never enters the scope records — which is what
    the ledger's coarse fallback is for.
    """
    hit = {"round": round_index, "name": name}
    if detail is not None:
        hit["detail"] = detail
    if tool is not None:
        hit["tool"] = tool
    return hit


def test_a_search_that_ranked_a_doc_does_not_make_the_later_open_a_repeat():
    """The reference shape: a search lists 2 docs, a later round opens them.

    Listing a file is not reading it. Marking the open as „bereits abgerufen"
    is what made five opens of one Richtlinie after one search read as five
    re-fetches of the same document.
    """
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"], query="OIB 2"),
        _announcement(1, ["read_passage"], ["knowledge"]),
    ]
    hits = [
        _hit(0, "oib-rl_2.pdf"),
        _hit(0, "oib-rl_2.1.pdf"),
        _hit(1, "oib-rl_2.pdf", "Pkt. 3.1"),
        _hit(1, "oib-rl_2.1.pdf", "p.3"),
    ]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert [entry["index"] for entry in ledger] == [0, 1]
    assert ledger[0]["new_docs"] == ["oib-rl_2.pdf", "oib-rl_2.1.pdf"]
    assert ledger[1]["new_docs"] == ["oib-rl_2.pdf", "oib-rl_2.1.pdf"]
    assert [doc["repeat"] for doc in ledger[1]["docs"]] == [False, False]
    assert ledger[1]["documents"] == 2
    assert ledger[0]["query"] == "OIB 2"


def test_a_family_search_opens_its_members_so_the_later_outline_read_is_a_repeat():
    """The family branch of ``knowledge_search`` fetches each member the way
    ``read_passage(document=…)`` does and stamps those hits as the locator's,
    so a member re-opened in the next round is a repeat, not new work."""
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"], query="oib 2"),
        _announcement(1, ["read_passage"], ["knowledge"]),
    ]
    hits = [
        _hit(0, "oib-rl_2.pdf", "p.4", tool="read_passage"),
        _hit(0, "oib-rl_2.1.pdf", "p.4", tool="read_passage"),
        _hit(0, "oib-rl_2.pdf", "Pkt. 3.1 p.12", tool="knowledge_search"),
        _hit(1, "oib-rl_2.pdf", "p.4", tool="read_passage"),
        _hit(1, "oib-rl_2.1.pdf", "p.4", tool="read_passage"),
    ]

    ledger = build_retrieval_ledger(announcements, hits)

    assert [doc["repeat"] for doc in ledger[0]["docs"]] == [False, False, False]
    assert [doc["repeat"] for doc in ledger[1]["docs"]] == [True, True]
    assert ledger[1]["new_docs"] == []


def test_one_document_opened_at_five_punkte_is_one_new_document():
    """Five loci of one file are five hits and ONE document the round did work on."""
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"], query="Fluchtweg"),
        _announcement(1, ["read_passage"], ["knowledge"]),
    ]
    punkte = [f"Pkt. 3.{n}" for n in range(1, 6)]
    hits = [_hit(0, "oib-rl_2.pdf"), *(_hit(1, "oib-rl_2.pdf", punkt) for punkt in punkte)]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert [doc["detail"] for doc in ledger[1]["docs"]] == punkte
    assert ledger[1]["hits"] == 5
    assert ledger[1]["documents"] == 1
    assert ledger[1]["new_docs"] == ["oib-rl_2.pdf"]


def test_a_round_that_re_lists_one_passage_and_finds_another_marks_only_the_first():
    """The case a document-level verdict cannot state.

    Round 0 ranked the file at p.12. Round 1 ranks it there again and reaches
    p.60 for the first time: the round did work, so the document is new, and
    the marker belongs on p.12 alone.
    """
    announcements = [
        _announcement(0, ["knowledge_search"], ["knowledge"], query="Fluchtweg"),
        _announcement(1, ["knowledge_search"], ["knowledge"], query="Treppenraum"),
    ]
    hits = [
        _hit(0, "oib-rl_2.pdf", "p.12"),
        _hit(1, "oib-rl_2.pdf", "p.12"),
        _hit(1, "oib-rl_2.pdf", "p.60"),
    ]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert [(doc["detail"], doc["repeat"]) for doc in ledger[1]["docs"]] == [
        ("p.12", True),
        ("p.60", False),
    ]
    assert ledger[1]["new_docs"] == ["oib-rl_2.pdf"]


def test_a_mixed_round_opens_only_what_its_locator_call_returned():
    """The case the tool stamp exists for.

    Round 0 searched up A and B and opened A in the same batch. Each hit says
    which tool produced it, so A is opened and B is only ranked: reopening A at
    a NEW Punkt in round 1 is a re-fetch, and the first open of B is not.
    Crediting the whole round — all this ledger could do before the stamp —
    marked B as already retrieved on the first time anybody read it.
    """
    announcements = [
        _announcement(0, ["knowledge_search", "read_passage"], ["knowledge"], query="Fluchtweg"),
        _announcement(1, ["read_passage"], ["knowledge"]),
    ]
    hits = [
        _hit(0, "a.pdf", tool="knowledge_search"),
        _hit(0, "b.pdf", tool="knowledge_search"),
        _hit(0, "a.pdf", "Pkt. 1", tool="read_passage"),
        _hit(1, "b.pdf", "Pkt. 2", tool="read_passage"),
        _hit(1, "a.pdf", "Pkt. 2", tool="read_passage"),
    ]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert [(doc["name"], doc["detail"], doc["repeat"]) for doc in ledger[1]["docs"]] == [
        ("b.pdf", "Pkt. 2", False),
        ("a.pdf", "Pkt. 2", True),
    ]
    assert ledger[1]["new_docs"] == ["b.pdf"]


def test_the_tool_stamp_never_reaches_the_wire():
    """``tool`` is how the verdict is derived, not something the reader is shown."""
    announcements = [_announcement(0, ["knowledge_search"], ["knowledge"], query="Fluchtweg")]
    ledger = build_retrieval_ledger(announcements, [_hit(0, "a.pdf", "p.1", tool="knowledge_search")])
    assert ledger is not None
    assert ledger[0]["docs"] == [{"name": "a.pdf", "detail": "p.1", "repeat": False}]


def test_hits_with_no_tool_stamp_fall_back_to_the_coarse_rule():
    """A tool that never enters the scope still gets an honest verdict.

    Nothing here says which call returned what, so a round that both searched
    and opened credits nothing — under-marking, which is the safe direction.
    """
    announcements = [
        _announcement(0, ["knowledge_search", "read_passage"], ["knowledge"], query="Fluchtweg"),
        _announcement(1, ["read_passage"], ["knowledge"]),
    ]
    hits = [_hit(0, "a.pdf"), _hit(0, "b.pdf"), _hit(1, "b.pdf", "Pkt. 2"), _hit(1, "a.pdf", "Pkt. 2")]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert [doc["repeat"] for doc in ledger[1]["docs"]] == [False, False]


def test_an_action_tool_beside_a_locator_still_counts_as_opening():
    """``emit_card`` returns no hits, so it cannot confuse the attribution."""
    announcements = [
        _announcement(0, ["read_passage", "emit_card"], ["knowledge"]),
        _announcement(1, ["read_passage"], ["knowledge"]),
    ]
    hits = [_hit(0, "a.pdf", "Pkt. 1"), _hit(1, "a.pdf", "Pkt. 9")]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert [doc["repeat"] for doc in ledger[1]["docs"]] == [True]


def test_the_same_passage_opened_twice_is_a_repeat():
    """Round 1 opens p.12, round 2 opens p.12: the second did no new work."""
    announcements = [
        _announcement(0, ["read_passage"], ["knowledge"]),
        _announcement(1, ["read_passage"], ["knowledge"]),
    ]
    hits = [_hit(0, "oib-rl_2.pdf", "p.12"), _hit(1, "oib-rl_2.pdf", "p.12")]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert ledger[0]["new_docs"] == ["oib-rl_2.pdf"]
    assert ledger[1]["new_docs"] == []
    assert [doc["repeat"] for doc in ledger[1]["docs"]] == [True]


def test_reopening_a_document_at_another_punkt_is_a_repeat():
    """An earlier round OPENED the file; reading further into it is a re-fetch.

    The reader has the document open already — the distinction the marker
    carries is "we went back to this file", not "we read this exact page".
    """
    announcements = [
        _announcement(0, ["read_passage"], ["knowledge"]),
        _announcement(1, ["knowledge_search"], ["knowledge"], query="Treppenraum"),
        _announcement(2, ["read_passage"], ["knowledge"]),
    ]
    hits = [
        _hit(0, "oib-rl_2.pdf", "Pkt. 3.1"),
        _hit(1, "brandschutz.pdf"),
        _hit(2, "oib-rl_2.pdf", "Pkt. 4.2"),
    ]
    ledger = build_retrieval_ledger(announcements, hits)
    assert ledger is not None
    assert ledger[2]["new_docs"] == []
    assert [doc["repeat"] for doc in ledger[2]["docs"]] == [True]


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
    rounds, retrieval_round, first = _charge_tool_calls(_response(search), state, 9)
    assert (rounds, retrieval_round) == (1, 1)
    assert first is not None
    assert first["key"] == "status.retrieval.withQuery"
    assert first["query"] == "OIB 2"
    assert "purpose" not in first
    state = state.model_copy(
        update={
            "tool_iterations": rounds,
            "retrieval_round": retrieval_round,
            "retrieval_rounds": [first],
        }
    )
    _rounds, retrieval_round, second = _charge_tool_calls(
        _response(opens, "Die Richtlinie gilt grundsätzlich."), state, 9
    )
    assert retrieval_round == 2
    assert second is not None
    assert second["key"] == "status.retrieval.punkt"
    assert second["reason"] == "Die Richtlinie gilt grundsätzlich."


def test_charge_records_nothing_for_action_batches():
    """Action batches announce no round and advance no counter."""
    state = _state()
    _rounds, retrieval_round, record = _charge_tool_calls(_response([{"name": "remember", "args": {}}]), state, 9)
    assert retrieval_round == 0
    assert record is None


def test_charge_without_tool_calls_keeps_the_tuple_shape():
    """A tool-free synthesis reply still unpacks in the agent node."""
    state = _state()
    assert _charge_tool_calls(_response([], "Die Antwort."), state, 9) == (0, 0, None)


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
        _announcement(
            2,
            ["read_passage"],
            ["knowledge"],
            reason="Die Fluchtweglänge hängt an drei Punkten.",
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
        *(
            {
                "round": 2,
                "name": "OIB-RL_2.pdf",
                "title": "OIB-Richtlinie 2, Ausgabe Mai 2023",
                "detail": punkt,
            }
            for punkt in ("Pkt. 3.1", "Pkt. 3.2", "Pkt. 3.3")
        ),
    ]
    assert build_retrieval_ledger(announcements, hits) == fixture

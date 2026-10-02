"""Whether RUN_FINISHED changed the text the reader had already read (ADR-0066), and how `_run` ends.

The answer suite counts the log line (``scripts/turn_census/suite.py``,
``settled_replaced``), so it is asserted where it is written: in the workflow's
own ``_run``, over the bodies it yields.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import types

import pytest

from aiq_agent.agents.piloti import conversation_register as cr
from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import AnswerSnapshot
from aiq_agent.common.wire_v2 import EmptyValue
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import StateSnapshotBody
from aiq_agent.common.wire_v2 import TextMessageContentBody
from aiq_agent.common.wire_v2 import TurnResult
from aiq_agent.turn import answer_stream
from aiq_agent.turn.admission import TurnOutcome
from aiq_agent.turn.streaming import note_settled_replaced


def _snapshot(text: str) -> StateSnapshotBody:
    return StateSnapshotBody(snapshot=AnswerSnapshot(text=text))


def _terminal(text: str) -> RunFinishedBody:
    return RunFinishedBody(outcome="answered", result=TurnResult(message_id="m1", text=text))


def test_a_terminal_that_repeats_the_settled_text_is_not_a_change(caplog):
    with caplog.at_level(logging.INFO):
        assert note_settled_replaced("R 90 [1].\n", "R 90 [1].") is False
    assert "replaced the settled answer" not in caplog.text


def test_a_terminal_that_differs_is_logged_for_the_suite_to_count(caplog):
    with caplog.at_level(logging.INFO):
        assert note_settled_replaced("R 90 [1].", "R 90 [1] [nicht wörtlich].") is True
    assert "terminal frame replaced the settled answer" in caplog.text


def test_nothing_settled_is_nothing_replaced():
    assert note_settled_replaced(None, "Antwort.") is False


@pytest.fixture
def workflow(monkeypatch):
    """``_run`` with the request parse, the setup and the answering run replaced; what it yielded and did."""
    seen: dict = {"order": [], "prose": []}

    async def prepare(*_args, runtime, **_kwargs):
        context = types.SimpleNamespace(stage_facts=types.SimpleNamespace(ws_parent_id="t1", memory_digest=None))
        yield cr._Turn(None, None, None, context, None, types.SimpleNamespace(organization_id=None), runtime)

    @contextlib.asynccontextmanager
    async def registries(*_args, **_kwargs):
        yield None

    async def flush(*_ledgers):
        seen["order"].append("ledgers flushed")

    monkeypatch.setattr(cr.Context, "get", staticmethod(lambda: types.SimpleNamespace(conversation_id="c1")))
    monkeypatch.setattr(cr.GridRequestContext, "from_context", staticmethod(lambda: None))
    monkeypatch.setattr(cr, "extract_turn_inputs", lambda _q: types.SimpleNamespace(query_text="q", data_sources=[]))
    monkeypatch.setattr(cr, "get_scoped_collections_from_context", lambda: None)
    monkeypatch.setattr(cr, "documents_loading_step", lambda _shelves: None)
    monkeypatch.setattr(cr, "turn_identity", lambda *_a: None)
    monkeypatch.setattr(cr, "track_agent_profile", lambda **_kw: contextlib.nullcontext())
    monkeypatch.setattr(cr, "_prepare_turn", prepare)
    monkeypatch.setattr(cr, "turn_registries", registries)
    monkeypatch.setattr(cr, "flush_after_answer", flush)
    monkeypatch.setattr(cr, "answer_message_id", lambda *_a: "m1")
    monkeypatch.setattr(cr, "_finished", lambda outcome, *_a, **_kw: outcome.state)

    def run(bodies, terminal, *, streaming=True):
        async def answer_turn(*_args, **_kwargs):
            seen["prose"].append(answer_stream._PROSE.get())
            for body in bodies:
                yield body
            yield TurnOutcome(state=terminal, refusal=None)

        monkeypatch.setattr(cr, "answer_turn", answer_turn)
        monkeypatch.setattr(cr, "answer_streaming_enabled", lambda: streaming)
        config = types.SimpleNamespace(enable_clarifier=False)
        return cr._turn_runner(object(), config, {})("q")

    seen["run"] = run
    return seen


async def test_the_workflow_logs_a_terminal_that_replaced_the_settled_text(workflow, caplog):
    run = workflow["run"]([_snapshot("R 90 [1].")], _terminal("R 90 [1] [nicht wörtlich]."))
    with caplog.at_level(logging.INFO):
        bodies = [body async for body in run]
    assert bodies[-1].result.text == "R 90 [1] [nicht wörtlich]."
    assert "terminal frame replaced the settled answer" in caplog.text


async def test_a_retraction_is_not_a_settled_answer_the_terminal_replaced(workflow, caplog):
    # A tool round settled its prose, then took it back; the answer streamed later
    # never settled. The terminal replaced nothing the reader was left reading.
    bodies = [_snapshot("Vorläufig [1]."), AnswerRetractedBody(value=EmptyValue())]
    run = workflow["run"](bodies, _terminal("Die eigentliche Antwort [1]."))
    with caplog.at_level(logging.INFO):
        assert [body async for body in run][:2] == bodies
    assert "replaced the settled answer" not in caplog.text


async def test_the_live_prose_is_bound_only_when_the_platform_lets_the_answer_stream(workflow):
    [_ async for _ in workflow["run"]([], _terminal("A."), streaming=True)]
    [_ async for _ in workflow["run"]([], _terminal("A."), streaming=False)]
    on, off = workflow["prose"]
    assert on is not None and on.message_id == "m1" and not on.streamed
    assert off is None


async def test_a_stream_the_reader_abandons_unwinds_the_answer_before_the_ledgers_flush(workflow, monkeypatch):
    """`_run` closes the answer itself; ``async for`` alone would leave it suspended."""
    order = workflow["order"]

    async def answer_turn(*_args, **_kwargs):
        try:
            yield TextMessageContentBody(message_id="m1", delta="Erstes Wort ")
            await asyncio.sleep(3600)
        finally:
            order.append("answer unwound")

    run = workflow["run"]([], _terminal("A."))
    monkeypatch.setattr(cr, "answer_turn", answer_turn)
    await anext(run)
    await run.aclose()  # the reader walked away after the first word

    assert order == ["answer unwound", "ledgers flushed"]

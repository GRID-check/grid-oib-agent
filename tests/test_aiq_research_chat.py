"""The aiq-research skill's `chat` asks over the chat socket, the one route a turn runs through (ADR-0068).

The skill is self-contained and standard-library only, so it speaks RFC 6455 with
a small client of its own. The `websockets` library is the oracle here: a real
server replays a recorded wire v2 turn (`shared/wire/v2/`) and checks every
message the skill sends against the contract's own models.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
from collections.abc import Callable
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from websockets.sync.server import ServerConnection
from websockets.sync.server import serve

from aiq_agent.common import wire_v2

REPO_ROOT = Path(__file__).resolve().parents[1]
WIRE = REPO_ROOT / "shared" / "wire" / "v2"
HELLO = (WIRE / "hello.jsonl").read_text(encoding="utf-8").strip()
SKILL_SCRIPT = REPO_ROOT / "skills" / "aiq-research" / "scripts" / "aiq.py"
SOURCES = {"data_sources": [{"id": "knowledge_layer"}, {"id": "ris"}]}


def _load_skill_script():
    # No bytecode beside the script: apm publishes everything under skills/, so a
    # __pycache__ written there lands in apm.lock.yaml and fails `task agents:audit`.
    spec = importlib.util.spec_from_file_location("aiq_research_skill", SKILL_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    previous, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


aiq = _load_skill_script()


def _recorded(name: str) -> list[dict]:
    return [json.loads(line) for line in (WIRE / name).read_text(encoding="utf-8").splitlines() if line.strip()]


@contextmanager
def _chat_role(handler: Callable[[ServerConnection], None], monkeypatch) -> Iterator[None]:
    """A chat role on a free port whose socket runs ``handler``, with the skill pointed at it."""
    with serve(handler, "127.0.0.1", 0) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        monkeypatch.setattr(aiq, "AIQ_CHAT_URL", f"http://127.0.0.1:{server.socket.getsockname()[1]}")
        monkeypatch.setattr(aiq, "list_data_sources", lambda: SOURCES)
        try:
            yield
        finally:
            server.shutdown()


def _replaying(name: str, sent: list[object], edit: Callable[[list[dict]], list[dict]] = lambda events: events):
    """A socket handler: hello, read the question, answer it with a recorded turn, and read any reply to a prompt."""

    def handler(ws: ServerConnection) -> None:
        assert ws.request.path.startswith("/websocket?v=2&conversationId=aiq-skill-")
        ws.send(HELLO)
        question = wire_v2.CLIENT_MESSAGE.validate_json(ws.recv())
        sent.append(question)
        for event in edit(_recorded(name)):
            event.update(conversation_id=question.conversation_id, turn_id=question.message_id)
            ws.send(json.dumps(event))
            if event.get("name") == "interaction_request":
                sent.append(wire_v2.CLIENT_MESSAGE.validate_json(ws.recv()))

    return handler


def test_a_question_is_one_wire_v2_turn_and_returns_its_result(monkeypatch):
    sent: list[object] = []
    with _chat_role(_replaying("turn-answered.jsonl", sent), monkeypatch):
        result = aiq.chat_request("Wie lang darf der Fluchtweg in GK 4 sein?")

    (question,) = sent
    assert isinstance(question, wire_v2.UserMessage)
    assert question.text == "Wie lang darf der Fluchtweg in GK 4 sein?"
    assert question.data_sources == ["knowledge_layer", "ris"]
    assert result["outcome"] == "answered"
    assert result["text"].startswith("Für **Gebäudeklasse 4**")
    assert result["answer_meta"]["kind"] == "ruling"


def test_a_question_the_turn_stops_to_ask_is_skipped(monkeypatch):
    sent: list[object] = []
    with _chat_role(_replaying("turn-hitl-handoff.jsonl", sent), monkeypatch):
        result = aiq.chat_request("Prüf das Projekt")

    question, answer = sent
    assert isinstance(answer, wire_v2.InteractionResponse)
    assert answer.turn_id == question.message_id
    assert answer.answer == wire_v2.TextAnswer(text=aiq.CLARIFICATION_ANSWER)
    assert result["outcome"] == "handed_off"


def test_a_failed_turn_is_an_error_not_an_answer(monkeypatch):
    with _chat_role(_replaying("turn-error.jsonl", []), monkeypatch):
        with pytest.raises(RuntimeError, match="workflow_error"):
            aiq.chat_request("?")


def test_a_large_message_is_read_whole(monkeypatch):
    def longer(events: list[dict]) -> list[dict]:
        terminal = next(event for event in events if event["type"] == "RUN_FINISHED")
        terminal["result"]["text"] = "x" * 70_000  # past the 16-bit frame length
        return events

    with _chat_role(_replaying("turn-answered.jsonl", [], longer), monkeypatch):
        result = aiq.chat_request("?")

    assert result["text"] == "x" * 70_000


def test_a_ping_is_answered(monkeypatch):
    pongs: list[threading.Event] = []

    def handler(ws: ServerConnection) -> None:
        ws.send(HELLO)
        question = wire_v2.CLIENT_MESSAGE.validate_json(ws.recv())
        pongs.append(ws.ping())
        for event in _recorded("turn-answered.jsonl"):
            event.update(conversation_id=question.conversation_id, turn_id=question.message_id)
            ws.send(json.dumps(event))

    with _chat_role(handler, monkeypatch):
        aiq.chat_request("?")
        # The ping went out before the turn's first event, so the client read it, and answered, first.
        assert pongs[0].wait(timeout=5)


def test_a_server_that_does_not_speak_wire_v2_is_named(monkeypatch):
    def handler(ws: ServerConnection) -> None:
        ws.send(json.dumps({"type": "system_response_message"}))

    with _chat_role(handler, monkeypatch), pytest.raises(RuntimeError, match="wire v2 hello"):
        aiq.chat_request("?")

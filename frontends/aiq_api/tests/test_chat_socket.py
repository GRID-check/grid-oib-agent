"""The chat socket, wire v2 (``aiq_api.chat_socket``, design §c/§d/§g).

Driven through ``ChatSocket.serve`` over an in-memory socket, with NAT's session
API stood in by a fake whose run yields what a turn's ``_run`` yields: wire
bodies. Every frame the socket writes is checked against the contract
(``WIRE_EVENT``), so a frame the reader could not parse fails here.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
from collections.abc import AsyncIterator
from collections.abc import Callable
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from starlette.datastructures import QueryParams
from starlette.websockets import WebSocketDisconnect

from aiq_agent.common.human_prompt import build_human_prompt
from aiq_agent.common.human_prompt import extract_user_response
from aiq_agent.common.wire_v2 import WIRE_EVENT
from aiq_agent.common.wire_v2 import AnswerSnapshot
from aiq_agent.common.wire_v2 import KeyedCard
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import StageValue
from aiq_agent.common.wire_v2 import StateSnapshotBody
from aiq_agent.common.wire_v2 import StatusStep
from aiq_agent.common.wire_v2 import StepFinishedBody
from aiq_agent.common.wire_v2 import TextMessageContentBody
from aiq_agent.common.wire_v2 import TextMessageStartBody
from aiq_agent.common.wire_v2 import TurnResult
from aiq_agent.common.wire_v2 import WireSource
from aiq_agent.turn.response import answer_message_id
from aiq_api import chat_socket
from aiq_api.auth.errors import AuthError
from aiq_api.chat_socket import ChatRegistry
from aiq_api.chat_socket import ChatSocket
from aiq_api.chat_socket import authenticate_websocket_connection
from aiq_api.chat_socket import configure_websocket_auth
from aiq_api.chat_socket import handshake_conversation_binding
from aiq_api.chat_socket import persist_turn_result
from aiq_api.chat_socket import turn_row_metadata
from aiq_api.conversation_bus import ConversationBus
from aiq_api.conversation_bus import force_multi_replica_for_tests
from aiq_api.conversation_bus import reset_bus_for_tests
from nat.plugin_api import InteractionPrompt

CONV = "conv-1"
_SECRET = "test-envelope-secret"  # pragma: allowlist secret (test signing key)
_DISCONNECT = object()
USERS = {"tok-asker": {"sub": "user_asker", "name": "Anna Asker"}, "tok-colleague": {"sub": "user_colleague"}}


# ---------------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------------


class _Validator:
    def can_handle(self, token: str) -> bool:
        return True

    async def validate(self, token: str) -> dict | None:
        user = USERS.get(token)
        return dict(user) if user else None


class FakeSocket:
    """A Starlette WebSocket reduced to what the handler uses; every frame it gets is parsed as a v2 event."""

    def __init__(self, *, token: str | None = "tok-asker", query: str = "v=2", headers: list | None = None) -> None:
        raw = [(b"host", b"aiq-agent"), *(headers or [])]
        if token:
            raw.append((b"authorization", f"Bearer {token}".encode()))
        self.scope = {"type": "websocket", "path": "/websocket", "headers": raw, "client": ("127.0.0.1", 1)}
        self.query_params = QueryParams(query)
        self.inbox: asyncio.Queue[Any] = asyncio.Queue()
        self.sent: list[dict] = []
        self.accepted = False
        self.closed_with: int | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000) -> None:
        self.closed_with = code

    async def receive_json(self) -> Any:
        item = await self.inbox.get()
        if item is _DISCONNECT:
            raise WebSocketDisconnect(1000)
        return item

    async def send_json(self, frame: dict) -> None:
        WIRE_EVENT.validate_python(frame)
        self.sent.append(frame)

    def client(self, **message: Any) -> None:
        self.inbox.put_nowait({"v": 2, "conversation_id": CONV, **message})

    def events(self, turn_id: str = "t1") -> list[dict]:
        return [frame for frame in self.sent if frame["turn_id"] == turn_id and frame["seq"] > 0]

    def rejected(self) -> list[dict]:
        return [frame["value"] for frame in self.sent if frame["seq"] == 0]


Turn = Callable[[Any, Callable], AsyncIterator[Any]]


class FakeSessions:
    """NAT's ``SessionManager``: ``session()`` → ``run()`` → ``result_stream()`` of what ``turn`` yields."""

    def __init__(self, turn: Turn) -> None:
        self.turn = turn
        self.opened: list[dict] = []

    @asynccontextmanager
    async def session(self, **kwargs: Any):
        self.opened.append(kwargs)
        ask = kwargs["user_input_callback"]

        @asynccontextmanager
        async def run(payload):
            yield SimpleNamespace(result_stream=lambda: self.turn(payload, ask))

        yield SimpleNamespace(run=run)


def _finished(request, text: str = "Antwort [1].", outcome: str = "answered", **result: Any) -> RunFinishedBody:
    message_id = answer_message_id(request.conversation_id, request.message_id)
    return RunFinishedBody(outcome=outcome, result=TurnResult(message_id=message_id, text=text, **result))


async def answering(request, ask):
    yield StepFinishedBody(step=StatusStep(id="status:documents", slot="documents", key="status.documents.session"))
    yield TextMessageStartBody(message_id="m")
    yield TextMessageContentBody(message_id="m", delta="Antwort [1].")
    yield _finished(request, sources=[WireSource(content="c", number=1)])


class Gate:
    """A turn that streams, then waits in its 'LLM call' until released, counting the calls it makes."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.calls = 0
        self.torn_down = False

    async def turn(self, request, ask):
        try:
            yield TextMessageStartBody(message_id="m")
            yield TextMessageContentBody(message_id="m", delta="Nach § 87 [2] ")
            while not self.release.is_set():
                self.calls += 1
                await asyncio.sleep(0.01)  # the model call
            yield _finished(request, text="done")
        finally:
            self.torn_down = True


async def until(condition: Callable[[], bool], timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "condition never held"
        await asyncio.sleep(0.005)


def _envelope(payload: dict, *, secret: str = _SECRET) -> list[tuple[bytes, bytes]]:
    raw = json.dumps(payload)
    header = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    signature = hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()
    return [(b"x-grid-request-context", header.encode()), (b"x-grid-request-context-sig", signature.encode())]


@pytest.fixture(autouse=True)
def _wiring(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", _SECRET)
    configure_websocket_auth(validators=[_Validator()], require_auth=True, external_hostnames={"public.test"})
    reset_bus_for_tests()
    persisted: list[dict] = []

    async def post(**kwargs):
        persisted.append(kwargs)
        return True

    monkeypatch.setattr(chat_socket, "post_internal_conversation_message", post)
    yield persisted
    configure_websocket_auth()
    reset_bus_for_tests()


@pytest.fixture
def persisted(_wiring) -> list[dict]:
    return _wiring


class Harness:
    def __init__(self, turn: Turn, registry: ChatRegistry | None = None) -> None:
        self.sessions = FakeSessions(turn)
        self.registry = registry or ChatRegistry()
        self.tasks: list[asyncio.Task] = []

    def connect(self, **socket: Any) -> FakeSocket:
        sock = FakeSocket(**socket)
        self.tasks.append(asyncio.create_task(ChatSocket(sock, self.sessions, self.registry).serve()))
        return sock

    async def close(self) -> None:
        """Stop every socket and turn this test started, and let their persists land, before the next test."""
        turns = [turn.task for turn in self.registry._turns.values() if turn.task is not None]
        for task in [*self.tasks, *turns]:
            task.cancel()
        await asyncio.gather(*self.tasks, *turns, return_exceptions=True)
        await asyncio.gather(*chat_socket._PERSIST_TASKS, return_exceptions=True)


@pytest_asyncio.fixture(loop_scope="function")
async def harness():
    """Sockets and turns, torn down on the test's own loop (the suite's fixture default is the session's)."""
    made: list[Harness] = []

    def make(turn: Turn = answering, registry: ChatRegistry | None = None) -> Harness:
        made.append(Harness(turn, registry))
        return made[-1]

    yield make
    for h in made:
        await h.close()


def _last(sock: FakeSocket, turn_id: str = "t1") -> str | None:
    events = sock.events(turn_id)
    return events[-1]["type"] if events else None


def _types(events: list[dict]) -> list[str]:
    return [event.get("name", event["type"]) for event in events]


# ---------------------------------------------------------------------------
# The route: NAT's socket is off and unpatched, ours is mounted (DoD 5)
# ---------------------------------------------------------------------------


async def test_nat_s_socket_objects_are_nat_s_own_and_the_route_is_ours(monkeypatch):
    from fastapi import FastAPI

    from aiq_api import plugin
    from aiq_api.plugin import AIQAPIConfig
    from aiq_api.plugin import AIQAPIWorker
    from nat.data_models.config import Config
    from nat.data_models.config import GeneralConfig
    from nat.data_models.step_adaptor import StepAdaptorMode
    from nat.front_ends.fastapi import fastapi_front_end_plugin_worker as worker_module
    from nat.front_ends.fastapi import message_handler
    from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorker
    from nat.front_ends.fastapi.routes import websocket as websocket_routes

    config = AIQAPIConfig()
    assert config.workflow.websocket_path is None
    assert config.step_adaptor.mode == StepAdaptorMode.OFF

    monkeypatch.setenv("NAT_CONFIG_FILE", "configs/config_oib_openrouter.yml")
    worker = AIQAPIWorker(Config(general=GeneralConfig(front_end=config)))
    session_manager = object()
    monkeypatch.setattr(worker, "_create_chat_session_manager", AsyncMock(return_value=session_manager))
    monkeypatch.setattr(FastApiFrontEndPluginWorker, "add_routes", AsyncMock())
    monkeypatch.setattr(plugin, "register_job_routes", AsyncMock())
    monkeypatch.setattr(worker, "_schedule_internal_api_check", lambda: None)
    monkeypatch.setattr(worker, "_install_signal_handlers", lambda: None)
    monkeypatch.setenv("AIQ_ENABLE_DEBUG", "false")
    app = FastAPI()

    before = list(app.routes)
    await websocket_routes.add_websocket_routes(worker, app, config.workflow, session_manager)
    assert app.routes == before  # NAT mounts no socket
    await worker.add_routes(app, builder=object())

    sockets = [route for route in app.routes if route.path == "/websocket"]
    assert len(sockets) == 1
    assert sockets[0].endpoint.__module__ == "aiq_api.chat_socket"
    assert websocket_routes.websocket_endpoint.__module__ == "nat.front_ends.fastapi.routes.websocket"
    assert websocket_routes.WebSocketMessageHandler is message_handler.WebSocketMessageHandler
    assert worker_module.WebSocketMessageHandler is message_handler.WebSocketMessageHandler


def test_a_config_that_asks_nat_for_a_socket_is_refused():
    from aiq_api.plugin import AIQAPIConfig

    workflow = {**AIQAPIConfig().workflow.model_dump(), "websocket_path": "/websocket"}
    with pytest.raises(ValueError, match="websocket_path"):
        AIQAPIConfig(workflow=workflow)


# ---------------------------------------------------------------------------
# The handshake: version, identity, conversation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("query", ["", "v=1", "v=3"])
async def test_any_other_wire_version_is_closed_4426(harness, query):
    sock = harness().connect(query=query)
    await until(lambda: sock.closed_with is not None)

    assert sock.accepted  # accepted first, or the browser sees 1006 instead of the code
    assert sock.closed_with == 4426
    assert sock.sent == []


async def test_an_external_caller_without_a_valid_token_is_closed_1008(harness):
    sock = harness().connect(token="tok-forged", headers=[(b"host", b"public.test")])
    await until(lambda: sock.closed_with is not None)

    assert sock.closed_with == 1008


async def test_the_handshake_resolves_the_verified_user():
    sock = FakeSocket(token="tok-asker")
    assert await authenticate_websocket_connection(sock) == ({"sub": "user_asker", "name": "Anna Asker"}, None)

    internal = FakeSocket(token=None)
    assert (await authenticate_websocket_connection(internal))[0]["type"] == "internal"


def test_a_forged_envelope_binds_nothing():
    headers = _envelope({"conversationId": "conv-b"}, secret="not-the-secret")

    assert handshake_conversation_binding({"headers": headers}) == (False, None)


async def test_a_message_for_another_conversation_is_refused_and_runs_nothing(harness):
    h = harness()
    sock = h.connect(headers=_envelope({"conversationId": "conv-a", "userId": "user_asker"}))

    sock.inbox.put_nowait(
        {"v": 2, "type": "user_message", "conversation_id": "conv-b", "message_id": "t1", "text": "?"}
    )
    await until(lambda: sock.rejected())

    assert sock.rejected() == [{"of": "user_message", "code": "conversation_mismatch"}]
    assert h.sessions.opened == []

    sock.inbox.put_nowait(
        {"v": 2, "type": "user_message", "conversation_id": "conv-a", "message_id": "t2", "text": "?"}
    )
    await until(lambda: h.sessions.opened)  # the socket stays open for the right one


async def test_a_signed_socket_without_a_conversation_serves_none(harness):
    h = harness()
    sock = h.connect(headers=_envelope({"userId": "user_asker"}))

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: sock.rejected())

    assert sock.rejected()[0]["code"] == "conversation_mismatch"


async def test_off_the_bff_the_first_named_conversation_binds_the_socket(harness):
    h = harness()
    sock = h.connect(token=None)

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: sock.events())
    sock.inbox.put_nowait({"v": 2, "type": "cancel_turn", "conversation_id": "conv-other", "turn_id": "t1"})
    await until(lambda: sock.rejected())

    assert sock.rejected() == [{"of": "cancel_turn", "code": "conversation_mismatch"}]


async def test_an_expired_token_runs_nothing_and_says_so(harness):
    USERS["tok-expired"] = {"sub": "user_asker", "exp": time.time() - 1}
    h = harness()
    sock = h.connect(token="tok-expired")

    sock.client(type="user_message", message_id="t1", text="?")
    sock.client(type="user_message", message_id="t2", text="?", context_only=True)
    await until(lambda: len(sock.rejected()) == 2)

    assert {value["code"] for value in sock.rejected()} == {"auth_expired"}
    assert h.sessions.opened == []


async def test_a_malformed_message_is_refused_and_an_unknown_one_dropped(harness):
    h = harness()
    sock = h.connect()

    sock.client(type="dance")
    sock.inbox.put_nowait("not an object")
    sock.client(type="user_message", message_id="t1", text="?", include_shelves=["archiv"])
    await until(lambda: sock.rejected())

    assert sock.rejected() == [{"of": "user_message", "code": "invalid_message"}]
    assert h.sessions.opened == []


# ---------------------------------------------------------------------------
# A turn: stamped in order, run as the verified subject, persisted
# ---------------------------------------------------------------------------


async def test_a_turn_is_run_started_then_what_the_workflow_yields_in_seq_order(harness, persisted):
    h = harness()
    sock = h.connect()

    sock.client(type="user_message", message_id="t1", text="Wie lang?")
    await until(lambda: persisted)

    events = sock.events()
    assert [event["seq"] for event in events] == [1, 2, 3, 4, 5]
    assert _types(events) == [
        "RUN_STARTED",
        "STEP_FINISHED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "RUN_FINISHED",
    ]
    assert events[0]["message_id"] == answer_message_id(CONV, "t1")
    opened = h.sessions.opened[0]
    assert opened["user_id"] == "user_asker"  # NAT's Context.user_id and span user.id: the verified subject
    assert (opened["conversation_id"], opened["user_message_id"]) == (CONV, "t1")
    assert persisted[0]["message_id"] == answer_message_id(CONV, "t1")
    assert persisted[0]["metadata"] == {"sources": [{"content": "c", "number": 1}]}


async def test_a_second_message_for_the_running_turn_is_a_duplicate(harness):
    gate = Gate()
    h = harness(gate.turn)
    sock = h.connect()

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: sock.rejected())

    assert sock.rejected() == [{"of": "user_message", "code": "duplicate_turn"}]
    assert len(h.sessions.opened) == 1


async def test_a_newer_question_supersedes_and_stops_the_stale_turn(harness):
    gate = Gate()
    h = harness(gate.turn)
    sock = h.connect()

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    sock.client(type="user_message", message_id="t2", text="!")
    await until(lambda: any(e["type"] == "RUN_FINISHED" for e in sock.events("t1")))

    assert sock.events("t1")[-1]["outcome"] == "cancelled"
    assert sock.events("t2")[0]["type"] == "RUN_STARTED"


@pytest.mark.parametrize(
    ("raised", "code"),
    [(RuntimeError("upstream model timed out"), "workflow_error"), (AuthError("token_expired", "gone"), "auth_error")],
)
async def test_a_failed_turn_ends_with_run_error_and_is_not_persisted(harness, persisted, raised, code):
    async def failing(request, ask):
        yield TextMessageStartBody(message_id="m")
        raise raised

    sock = harness(failing).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: sock.events() and _last(sock) == "RUN_ERROR")

    assert sock.events()[-1]["code"] == code
    assert persisted == []


async def test_a_turn_that_yields_no_result_still_ends(harness):
    async def silent(request, ask):
        yield TextMessageStartBody(message_id="m")

    sock = harness(silent).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: _last(sock) == "RUN_ERROR")

    assert sock.events()[-1]["code"] == "workflow_error"


async def test_a_context_only_line_is_remembered_and_answers_nothing(harness, monkeypatch):
    stored: list[tuple[str, str]] = []

    async def append(thread_id, text):
        stored.append((thread_id, text))
        return True

    monkeypatch.setattr(chat_socket, "append_conversation_context", append)
    h = harness()
    sock = h.connect()

    sock.client(type="user_message", message_id="t1", text="Atrium ist eigen.", context_only=True, author_name="X")
    await until(lambda: stored)

    # The verified name, not the one the client claimed.
    assert stored == [(CONV, "Anna Asker: Atrium ist eigen.")]
    assert h.sessions.opened == []
    assert sock.sent == []


async def test_the_heartbeat_is_stamped_on_the_turn_and_stops_at_the_terminal(harness, monkeypatch):
    monkeypatch.setattr(chat_socket, "TURN_HEARTBEAT_SECONDS", 0.02)
    gate = Gate()
    h = harness(gate.turn)
    sock = h.connect()

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: "heartbeat" in _types(sock.events()))
    gate.release.set()
    await until(lambda: sock.events()[-1]["type"] == "RUN_FINISHED")
    await asyncio.sleep(0.06)

    events = sock.events()
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    assert _types(events)[-1] == "RUN_FINISHED"
    assert next(e for e in events if e.get("name") == "heartbeat")["value"] == {"every_ms": 20}


# ---------------------------------------------------------------------------
# Stop (DoD 6)
# ---------------------------------------------------------------------------


async def test_the_asker_s_stop_cancels_the_run_and_keeps_what_was_read(harness, persisted):
    gate = Gate()
    h = harness(gate.turn)
    sock = h.connect()

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    sock.client(type="cancel_turn", turn_id="t1")
    await until(lambda: persisted)
    calls_at_stop = gate.calls
    await asyncio.sleep(0.05)

    assert gate.torn_down
    assert gate.calls == calls_at_stop  # no model call after the Stop
    terminal = sock.events()[-1]
    assert (terminal["type"], terminal["outcome"]) == ("RUN_FINISHED", "cancelled")
    assert terminal["result"]["text"] == "Nach § 87"  # the pending [2] has no source
    assert persisted[0]["metadata"] == {"stopped": True}
    assert persisted[0]["text"] == "Nach § 87"


async def test_a_colleague_s_stop_is_refused_and_the_turn_runs_on(harness):
    gate = Gate()
    h = harness(gate.turn)
    asker = h.connect()
    colleague = h.connect(token="tok-colleague")

    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    colleague.client(type="cancel_turn", turn_id="t1")
    await until(lambda: colleague.rejected())

    rejected = colleague.sent[-1]
    assert (rejected["seq"], rejected["value"]["code"]) == (0, "not_asker")
    assert not gate.torn_down
    gate.release.set()
    await until(lambda: asker.events()[-1]["type"] == "RUN_FINISHED")
    assert asker.events()[-1]["outcome"] == "answered"


async def test_a_stop_for_no_running_turn_is_turn_not_found(harness):
    sock = harness().connect()
    sock.client(type="cancel_turn", turn_id="t9")
    await until(lambda: sock.rejected())

    assert sock.rejected() == [{"of": "cancel_turn", "code": "turn_not_found"}]


def _replicas() -> tuple[ChatRegistry, ChatRegistry, ConversationBus]:
    """Two replicas on one Dragonfly: the owner on the process bus, the relay on its own."""
    owner_bus = force_multi_replica_for_tests()
    relay_bus = ConversationBus(owner_bus._t, replica_id="relay")
    return ChatRegistry(owner_bus), ChatRegistry(relay_bus), relay_bus


async def test_a_stop_received_by_another_replica_is_authorised_by_the_owner(harness):
    owner, relay, _ = _replicas()
    gate = Gate()
    on_owner = harness(gate.turn, owner)
    on_relay = harness(gate.turn, relay)
    asker = on_owner.connect()
    colleague_elsewhere = on_relay.connect(token="tok-colleague")
    asker_elsewhere = on_relay.connect()

    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    await asyncio.sleep(0.02)  # the owner's input subscription lands
    colleague_elsewhere.client(type="cancel_turn", turn_id="t1")
    await asyncio.sleep(0.05)
    assert not gate.torn_down  # the owner checked the subject again

    asker_elsewhere.client(type="cancel_turn", turn_id="t1")
    await until(lambda: gate.torn_down)
    await until(lambda: asker.events()[-1]["type"] == "RUN_FINISHED")
    assert asker.events()[-1]["outcome"] == "cancelled"


# ---------------------------------------------------------------------------
# HITL
# ---------------------------------------------------------------------------


def _asking(answers: list[str]):
    async def turn(request, ask):
        response = await ask(
            InteractionPrompt(
                id="ask_01",
                timestamp="2026-09-27T10:00:00Z",
                content=build_human_prompt("Welches Modell?", ["Castle.ifc", "Institute.ifc"]),
            )
        )
        answers.append(extract_user_response(SimpleNamespace(content=response)))
        yield _finished(request, text=f"Gewählt: {answers[-1]}")

    return turn


async def test_a_question_goes_out_and_the_asker_s_choice_comes_back(harness):
    answers: list[str] = []
    h = harness(_asking(answers))
    asker = h.connect()
    colleague = h.connect(token="tok-colleague")

    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: "interaction_request" in _types(asker.events()))
    request = asker.events()[-1]["value"]
    assert (request["interaction_id"], request["input"]) == ("ask_01", "choice")  # NAT's prompt id

    colleague.client(type="interaction_response", turn_id="t1", interaction_id="ask_01", answer={"option_id": "1"})
    asker.client(type="interaction_response", turn_id="t1", interaction_id="ask_other", answer={"text": "x"})
    await until(lambda: colleague.rejected() and asker.rejected())
    assert colleague.rejected() == [{"of": "interaction_response", "code": "not_asker"}]
    assert asker.rejected() == [{"of": "interaction_response", "code": "no_pending_interaction"}]

    asker.client(type="interaction_response", turn_id="t1", interaction_id="ask_01", answer={"option_id": "2"})
    await until(lambda: asker.events("t1")[-1]["type"] == "RUN_FINISHED")

    assert answers == ["Institute.ifc"]
    resolved = next(e for e in asker.events() if e.get("name") == "interaction_resolved")
    assert resolved["value"] == {"interaction_id": "ask_01", "outcome": "answered"}


async def test_an_unanswered_question_expires_and_ends_the_turn(harness, monkeypatch):
    monkeypatch.setattr(chat_socket, "HITL_RESPONSE_TIMEOUT_SECONDS", 0.02)
    sock = harness(_asking([])).connect()

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: _last(sock) == "RUN_ERROR")

    assert _types(sock.events())[-3:] == ["interaction_request", "interaction_resolved", "RUN_ERROR"]
    assert sock.events()[-2]["value"]["outcome"] == "expired"
    assert sock.events()[-1]["code"] == "interaction_expired"


async def test_a_stop_while_asking_resolves_the_question_as_cancelled(harness):
    sock = harness(_asking([])).connect()

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: "interaction_request" in _types(sock.events()))
    sock.client(type="cancel_turn", turn_id="t1")
    await until(lambda: sock.events()[-1]["type"] == "RUN_FINISHED")

    assert _types(sock.events())[-2:] == ["interaction_resolved", "RUN_FINISHED"]
    assert sock.events()[-2]["value"]["outcome"] == "cancelled"


# ---------------------------------------------------------------------------
# attach, replay, drop, spectators, stages
# ---------------------------------------------------------------------------


async def test_attach_replays_after_the_cursor_and_then_goes_live(harness):
    gate = Gate()
    h = harness(gate.turn)
    first = h.connect()
    first.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    first.inbox.put_nowait(_DISCONNECT)

    second = h.connect()
    second.client(type="attach", turn_id="t1", after_seq=1)
    await until(lambda: len(second.events()) == 2)
    gate.release.set()
    await until(lambda: second.events()[-1]["type"] == "RUN_FINISHED")

    seqs = [event["seq"] for event in second.events()]
    assert seqs == list(range(2, seqs[-1] + 1))  # no duplicate, no gap


async def test_attach_splices_a_live_frame_that_arrives_during_the_replay(harness, monkeypatch):
    """On another replica the replay is read from the bus while the owner keeps publishing."""
    owner, relay, relay_bus = _replicas()
    gate = Gate()
    on_owner = harness(gate.turn, owner)
    first = on_owner.connect()
    first.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)

    real_replay = relay_bus.replay_turn

    async def slow_replay(conversation_id, turn_id):
        frames = await real_replay(conversation_id, turn_id)
        gate.release.set()  # the terminal is published while the replay is in flight
        await until(lambda: owner.running(CONV) is None)
        return frames

    monkeypatch.setattr(relay_bus, "replay_turn", slow_replay)
    second = harness(gate.turn, relay).connect()
    second.client(type="attach", turn_id="t1", after_seq=0)
    await until(lambda: second.events() and second.events()[-1]["type"] == "RUN_FINISHED")

    seqs = [event["seq"] for event in second.events()]
    assert seqs == list(range(1, seqs[-1] + 1))


async def test_attach_on_another_replica_cannot_miss_a_frame_while_its_relay_subscribes(harness, monkeypatch):
    """The replay is read only once the relay listens: a frame published in between arrives through it."""
    owner, relay, relay_bus = _replicas()
    gate = Gate()
    on_owner = harness(gate.turn, owner)
    asker = on_owner.connect()
    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)

    real_subscribe = relay_bus.subscribe_frames

    async def slow_subscribe(conversation_id, *args, **kwargs):
        await asyncio.sleep(0.1)  # SUBSCRIBE is a round trip, and it ran after the XRANGE
        async for envelope in real_subscribe(conversation_id, *args, **kwargs):
            yield envelope

    monkeypatch.setattr(relay_bus, "subscribe_frames", slow_subscribe)
    elsewhere = harness(gate.turn, relay).connect()
    elsewhere.client(type="attach", turn_id="t1", after_seq=0)
    await until(lambda: elsewhere.events())
    gate.release.set()  # the terminal goes out right after the replay was read

    await until(lambda: "RUN_FINISHED" in _types(elsewhere.events()))
    seqs = [event["seq"] for event in elsewhere.events()]
    assert seqs == list(range(1, seqs[-1] + 1))


async def test_attach_for_a_turn_nobody_has_is_turn_not_found(harness):
    sock = harness().connect()
    sock.client(type="attach", turn_id="t-gone", after_seq=0)
    await until(lambda: sock.rejected())

    assert sock.rejected() == [{"of": "attach", "code": "turn_not_found"}]


async def test_a_dropped_socket_does_not_stop_the_turn_and_the_answer_is_kept(harness, persisted):
    gate = Gate()
    h = harness(gate.turn)
    sock = h.connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)

    sock.inbox.put_nowait(_DISCONNECT)
    await asyncio.sleep(0.02)
    gate.release.set()
    await until(lambda: persisted)

    assert not any(event["type"] == "RUN_FINISHED" for event in sock.events())
    assert persisted[0]["text"] == "done"
    assert persisted[0]["message_id"] == answer_message_id(CONV, "t1")


async def test_every_stamped_frame_reaches_spectators_and_a_rejection_does_not(harness):
    owner, _, spectator_bus = _replicas()
    seen: list[dict] = []

    async def spectate():
        async for envelope in spectator_bus.subscribe_frames(CONV):
            seen.append(envelope.payload)

    spectator = asyncio.create_task(spectate())
    await asyncio.sleep(0.01)
    try:
        h = harness(answering, owner)
        sock = h.connect()
        sock.client(type="user_message", message_id="t1", text="?")
        sock.client(type="cancel_turn", turn_id="t1", surplus=True)
        await until(lambda: len(seen) == 5 and sock.rejected())
    finally:
        spectator.cancel()

    assert seen == sock.events()  # verbatim, the same v2 frames the asker got
    assert all(frame["seq"] > 0 for frame in seen)


async def test_stages_follow_the_terminal_on_the_turn_s_seq(harness, monkeypatch):
    h = harness()
    sock = h.connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: sock.events() and sock.events()[-1]["type"] == "RUN_FINISHED")
    await until(lambda: h.registry.running(CONV) is None)

    delivered = await h.registry.send_stage(CONV, "t1", StageValue(stage="follow_ups", status="empty"))
    wire = h.registry.wire(CONV, "t1")
    assert not await wire.send(chat_socket.HeartbeatBody(value=chat_socket.HeartbeatValue(every_ms=1)))

    assert delivered
    stage = sock.events()[-1]
    assert (stage["seq"], stage["name"], stage["value"]) == (6, "stage", {"stage": "follow_ups", "status": "empty"})
    assert not await h.registry.send_stage(CONV, "t-unknown", StageValue(stage="follow_ups", status="empty"))
    later = time.monotonic() + chat_socket.STAGE_WIRE_TTL_S + 1
    monkeypatch.setattr(chat_socket.time, "monotonic", lambda: later)
    assert not await h.registry.send_stage(CONV, "t1", StageValue(stage="follow_ups", status="failed"))


@pytest.fixture
def one_frame_stage():
    """Only the stage a test declares runs; the built-in ones stay out of the way."""
    from aiq_agent.stages import registry as stages
    from aiq_agent.stages import runner

    saved = dict(stages._STAGES)
    stages._STAGES.clear()
    runner._claimed_keys.clear()
    yield stages
    stages._STAGES.clear()
    stages._STAGES.update(saved)
    runner._claimed_keys.clear()


async def _boom(ctx):
    raise RuntimeError("the model refused")


@pytest.mark.parametrize("handler", [None, _boom, lambda ctx: asyncio.sleep(10)])
async def test_a_failing_stage_never_changes_the_answer_frames(harness, one_frame_stage, handler, monkeypatch):
    """ "A stage can never delay, alter, block or fail an answer" (post-answer-stages.md §2.1).

    The real scheduler, the real sink and the real socket: a turn whose stage
    raises or times out puts the same answer events on the socket as a turn
    with no stage, and its stage event, if any, comes after the terminal.
    """
    from aiq_agent.common.model_overrides import AgentGroup
    from aiq_agent.stages import delivery
    from aiq_agent.stages import runner
    from aiq_agent.stages.spec import GateDecision
    from aiq_agent.stages.spec import StageSpec
    from aiq_agent.stages.spec import TurnFacts

    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN")  # no BFF to ask for the stage model's settings
    if handler is not None:
        one_frame_stage.register_stage(
            StageSpec(
                id="follow_ups",
                agent_group=AgentGroup.MEMORY_REFLECTION,
                flag_slug="probe-stage",
                env_default="GRID_STAGE_PROBE_ENABLED",
                timeout_s=0.05,
                gate=lambda facts: GateDecision.proceed(),
                handler=handler,
                payload_model=None,
                delivery="frame",
                max_output_tokens=None,
            )
        )
    facts = TurnFacts(conversation_id=CONV, ws_parent_id="t1", enabled_stages=frozenset({"follow_ups"}))
    stage_tasks: list[asyncio.Task] = []

    async def turn_with_stages(request, ask):
        # The call site's order: schedule, then deliver the answer, with the stage in flight.
        stage_tasks.extend(runner.schedule_post_answer_stages(facts, llms={AgentGroup.MEMORY_REFLECTION: object()}))
        async for body in answering(request, ask):
            yield body

    h = harness(turn_with_stages)
    delivery.register_stage_frame_sink(h.registry.send_stage)
    try:
        sock = h.connect()
        sock.client(type="user_message", message_id="t1", text="?")
        await until(lambda: "RUN_FINISHED" in _types(sock.events()))
        await asyncio.gather(*stage_tasks)
    finally:
        delivery.register_stage_frame_sink(None)

    answer = [{k: v for k, v in e.items() if k != "ts"} for e in sock.events() if e.get("name") != "stage"]
    assert _types(answer) == [
        "RUN_STARTED",
        "STEP_FINISHED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "RUN_FINISHED",
    ]
    assert answer[-1]["result"]["text"] == "Antwort [1]."
    stages = [e for e in sock.events() if e.get("name") == "stage"]
    assert [stage["value"] for stage in stages] == (
        [] if handler is None else [{"stage": "follow_ups", "status": "failed"}]
    )
    assert all(stage["seq"] > answer[-1]["seq"] for stage in stages)


# ---------------------------------------------------------------------------
# Every turn ends: deadline, places, one terminal, supervised loops, a bus down
# ---------------------------------------------------------------------------


async def _hung(request, ask):
    yield TextMessageStartBody(message_id="m")
    await asyncio.sleep(3600)  # a model call that never returns


async def test_a_hung_turn_ends_at_its_deadline_with_run_error(harness, monkeypatch, persisted):
    monkeypatch.setattr(chat_socket, "TURN_DEADLINE_SECONDS", 0.1)
    torn_down = asyncio.Event()

    async def hung(request, ask):
        try:
            async for body in _hung(request, ask):
                yield body
        finally:
            torn_down.set()

    h = harness(hung)
    sock = h.connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: _last(sock) == "RUN_ERROR")

    terminal = sock.events()[-1]
    assert terminal["code"] == "workflow_error"
    assert terminal["details"].startswith(chat_socket.DEADLINE_DETAILS)
    assert "too long" in terminal["message"]
    assert torn_down.is_set()  # the hung call was cancelled, not abandoned
    assert h.registry.running(CONV) is None
    assert persisted == []


async def test_waiting_on_a_person_does_not_count_against_the_deadline_but_model_work_does(harness, monkeypatch):
    monkeypatch.setattr(chat_socket, "TURN_DEADLINE_SECONDS", 0.15)
    answered = asyncio.Event()

    async def asks_then_hangs(request, ask):
        content = build_human_prompt("Welches?", ["A", "B"])
        await ask(InteractionPrompt(id="ask_01", timestamp="2026-09-27T10:00:00Z", content=content))
        answered.set()
        async for body in _hung(request, ask):
            yield body

    sock = harness(asks_then_hangs).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: "interaction_request" in _types(sock.events()))
    await asyncio.sleep(0.4)  # the asker reads a drawing for longer than the whole deadline
    assert _types(sock.events())[-1] == "interaction_request"

    sock.client(type="interaction_response", turn_id="t1", interaction_id="ask_01", answer={"option_id": "1"})
    await until(answered.is_set)
    await until(lambda: _last(sock) == "RUN_ERROR")
    assert sock.events()[-1]["details"].startswith(chat_socket.DEADLINE_DETAILS)


def test_the_deadline_never_pre_empts_the_in_process_deep_research_budget():
    """The longest legitimate chat turn is the deep-research fallback; its own clock must fire first."""
    from aiq_agent.agents.deep_researcher.agent import DEFAULT_MAX_RUN_SECONDS

    assert chat_socket.TurnDeadline().seconds > DEFAULT_MAX_RUN_SECONDS


async def test_a_base_exception_group_still_ends_the_turn_and_is_logged(harness, caplog):
    async def grouped(request, ask):
        yield TextMessageStartBody(message_id="m")
        raise BaseExceptionGroup("tg", [asyncio.CancelledError()])

    h = harness(grouped)
    sock = h.connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: _last(sock) == "RUN_ERROR")
    await until(lambda: h.registry.running(CONV) is None)
    await asyncio.sleep(0)  # the done-callback runs on the next loop pass

    assert [e["type"] for e in sock.events()].count("RUN_ERROR") == 1
    assert any("ended with an unexpected error" in record.getMessage() for record in caplog.records)


async def test_a_stop_ends_the_turn_even_when_the_workflow_teardown_hangs(harness, monkeypatch, persisted):
    from aiq_api import workflow_stream

    monkeypatch.setattr(workflow_stream, "PRODUCER_TEARDOWN_SECONDS", 0.05)
    started, unstuck = asyncio.Event(), asyncio.Event()

    async def stubborn(request, ask):
        try:
            yield TextMessageStartBody(message_id="m")
            yield TextMessageContentBody(message_id="m", delta="Bis hier")
            started.set()
            await asyncio.sleep(3600)
        finally:
            await asyncio.shield(unstuck.wait())  # a checkpoint flush or an MCP close that hangs

    sock = harness(stubborn).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(started.is_set)
    sock.client(type="cancel_turn", turn_id="t1")
    try:
        await until(lambda: _last(sock) == "RUN_FINISHED")
    finally:
        unstuck.set()

    assert (sock.events()[-1]["outcome"], sock.events()[-1]["result"]["text"]) == ("cancelled", "Bis hier")


async def test_a_dead_relay_loop_is_restarted(harness, monkeypatch):
    monkeypatch.setattr(chat_socket, "_LOOP_RESTART_MIN_S", 0.01)
    owner, relay, relay_bus = _replicas()
    gate = Gate()
    asker = harness(gate.turn, owner).connect()
    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)

    real_subscribe = relay_bus.subscribe_frames
    subscriptions: list[int] = []

    async def drops_once(conversation_id, *args, **kwargs):
        subscriptions.append(1)
        if len(subscriptions) == 1:
            raise ConnectionError("Connection reset by peer")
        async for envelope in real_subscribe(conversation_id, *args, **kwargs):
            yield envelope

    monkeypatch.setattr(relay_bus, "subscribe_frames", drops_once)
    elsewhere = harness(gate.turn, relay).connect()
    elsewhere.client(type="attach", turn_id="t1", after_seq=0)
    await until(lambda: len(subscriptions) == 2)
    await asyncio.sleep(0.02)
    gate.release.set()

    await until(lambda: "RUN_FINISHED" in _types(elsewhere.events()))


def _bus_down(monkeypatch, bus: ConversationBus, *methods: str) -> None:
    """Dragonfly refuses these commands, for every replica on it."""

    async def refused(*args, **kwargs):
        raise ConnectionError("Error 111 connecting to dragonfly:6379. Connection refused.")

    for method in methods:
        monkeypatch.setattr(bus._t, method, refused)


async def test_attach_while_the_bus_is_down_is_answered_and_the_socket_stays(harness, monkeypatch):
    owner, relay, relay_bus = _replicas()
    gate = Gate()
    on_owner = harness(gate.turn, owner)
    asker = on_owner.connect()
    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    _bus_down(monkeypatch, relay_bus, "xrange")

    on_relay = harness(gate.turn, relay)
    elsewhere = on_relay.connect()
    elsewhere.client(type="attach", turn_id="t1", after_seq=0)
    await until(lambda: elsewhere.rejected())

    assert elsewhere.rejected() == [{"of": "attach", "code": "turn_not_found"}]
    assert not on_relay.tasks[0].done()  # answered, not closed 1011

    # The replica running the turn replays it from its own sequencer.
    here = on_owner.connect()
    here.client(type="attach", turn_id="t1", after_seq=0)
    await until(lambda: here.events())
    assert [event["seq"] for event in here.events()] == [1, 2, 3]


async def test_a_stop_the_bus_cannot_carry_is_answered_and_the_socket_stays(harness, monkeypatch):
    owner, relay, relay_bus = _replicas()
    gate = Gate()
    asker = harness(gate.turn, owner).connect()
    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    _bus_down(monkeypatch, relay_bus, "publish")

    on_relay = harness(gate.turn, relay)
    elsewhere = on_relay.connect()
    elsewhere.client(type="cancel_turn", turn_id="t1")
    await until(lambda: elsewhere.rejected())

    assert elsewhere.rejected()[0]["code"] == "turn_not_found"
    assert "cannot be reached" in elsewhere.rejected()[0]["message"]
    assert not on_relay.tasks[0].done()


async def test_a_resent_question_on_another_replica_is_a_duplicate_and_runs_once(harness):
    """The UI resends a question until RUN_STARTED arrives; the resend may reach another replica."""
    owner, relay, _ = _replicas()
    gate = Gate()
    on_owner = harness(gate.turn, owner)
    on_relay = harness(gate.turn, relay)
    first = on_owner.connect()
    first.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)

    resent = on_relay.connect()
    resent.client(type="user_message", message_id="t1", text="?")
    await until(lambda: resent.rejected())

    assert resent.rejected() == [{"of": "user_message", "code": "duplicate_turn"}]
    assert on_relay.sessions.opened == []
    assert len(on_owner.sessions.opened) == 1


async def test_a_resent_question_whose_turn_already_finished_is_a_duplicate(harness, persisted):
    h = harness()
    sock = h.connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: persisted)
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: sock.rejected())

    assert sock.rejected() == [{"of": "user_message", "code": "duplicate_turn"}]
    assert len(h.sessions.opened) == 1


async def test_with_the_bus_down_a_question_still_runs(harness, monkeypatch):
    owner, _, shared = _replicas()
    _bus_down(monkeypatch, shared, "set_nx", "xadd", "publish")
    h = harness(answering, owner)
    sock = h.connect()
    sock.client(type="user_message", message_id="t1", text="?")

    await until(lambda: _last(sock) == "RUN_FINISHED")


async def test_a_newer_question_on_another_replica_stops_the_stale_turn(harness):
    owner, relay, _ = _replicas()
    gate = Gate()
    first = harness(gate.turn, owner).connect()
    first.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    await asyncio.sleep(0.02)  # the owner's input subscription lands

    elsewhere = harness(answering, relay).connect()
    elsewhere.client(type="user_message", message_id="t2", text="!")
    await until(lambda: _last(first) == "RUN_FINISHED")

    assert first.events()[-1]["outcome"] == "cancelled"
    assert gate.torn_down


async def test_the_chat_session_manager_has_no_nat_semaphore(monkeypatch):
    """NAT's semaphore queued a turn after RUN_STARTED, heartbeating, behind turns waiting on a person.

    The one concurrency gate is ADR-0040's admission, which refuses at once.
    """
    from aiq_api import plugin
    from aiq_api.plugin import AIQAPIConfig
    from aiq_api.plugin import AIQAPIWorker
    from nat.data_models.config import Config
    from nat.data_models.config import GeneralConfig

    create = AsyncMock(return_value=object())
    monkeypatch.setattr(plugin.SessionManager, "create", create)
    monkeypatch.setenv("NAT_CONFIG_FILE", "configs/config_oib_openrouter.yml")
    worker = AIQAPIWorker(Config(general=GeneralConfig(front_end=AIQAPIConfig())))

    manager = await worker._create_chat_session_manager(builder=object())

    assert create.await_args.kwargs["max_concurrency"] == 0
    assert manager in worker._session_managers  # shut down with NAT's own


# ---------------------------------------------------------------------------
# The persisted row
# ---------------------------------------------------------------------------


def _result(**fields: Any) -> TurnResult:
    return TurnResult(message_id="m-1", **{"text": "Antwort", **fields})


def test_the_row_is_the_typed_result_in_wire_spelling():
    finished = RunFinishedBody(
        outcome="answered",
        result=_result(
            cards=[KeyedCard(key="k1", card={"type": "fact"})],
            answer_meta={"verdict": "ok"},
            routing_decision="shallow",
            skills_activated=["brandschutz"],
            retry_after_seconds=3,
        ),
    )

    assert turn_row_metadata(finished) == {
        "cards": [{"type": "fact"}],
        "answer_meta": {"verdict": "ok"},
        "routing_decision": "shallow",
        "skills_activated": ["brandschutz"],
    }


def test_the_quote_stamps_are_kept_on_the_row_in_wire_spelling():
    # ``agent-answer-metadata.ts`` reads them back as ``quote_stamps``; an
    # unchecked stamp carries its status and wording alone.
    finished = RunFinishedBody(
        outcome="answered",
        result=_result(
            quote_stamps=[
                {"text": "Wortlaut der Stelle", "status": "verbatim", "number": 1, "file_name": "rl2.pdf", "page": 3},
                {"text": "GK 4", "status": "unchecked"},
            ]
        ),
    )

    assert turn_row_metadata(finished) == {
        "quote_stamps": [
            {"text": "Wortlaut der Stelle", "status": "verbatim", "number": 1, "file_name": "rl2.pdf", "page": 3},
            {"text": "GK 4", "status": "unchecked"},
        ]
    }


@pytest.mark.parametrize(
    "result",
    [
        _result(job_admission_rejected=True, retry_after_seconds=30),  # a transient notice, not an answer
        _result(text="  "),  # nothing to show
        _result(text="", run={"run_id": "r", "run_message_id": "rm"}),  # the run's block is the narration
    ],
)
def test_a_turn_with_nothing_to_keep_writes_no_row(result):
    assert turn_row_metadata(RunFinishedBody(outcome="answered", result=result)) is None


async def test_the_row_goes_to_the_internal_route_under_the_answer_s_id(persisted):
    finished = RunFinishedBody(outcome="cancelled", result=_result())

    assert await persist_turn_result(conversation_id=CONV, organization_id="org-1", finished=finished)
    assert persisted == [
        {
            "conversation_id": CONV,
            "organization_id": "org-1",
            "message_id": "m-1",
            "role": "assistant",
            "text": "Antwort",
            "message_type": "agent_response",
            "metadata": {"stopped": True},
        }
    ]


@pytest.mark.parametrize(
    ("after_settle", "text", "numbers"),
    [("", "Neu [1].", [1]), (" weiter [2]", "Neu. weiter", [])],
)
async def test_a_stopped_turn_keeps_the_settled_text_with_its_sources(
    persisted, monkeypatch, after_settle, text, numbers
):
    """Stopped on the settled text: its citations resolve. Stopped past it: no [N] is left without a source."""
    registry = ChatRegistry()
    turn = chat_socket.RunningTurn(wire=chat_socket.TurnWire(CONV, "t1", registry.publish), asker_subject=None)
    await turn.publish(TextMessageContentBody(message_id="m", delta="alt [1]"))
    snapshot = AnswerSnapshot(text="Neu [1].", sources=[WireSource(content="c", number=1)])
    await turn.publish(StateSnapshotBody(snapshot=snapshot))
    if after_settle:
        await turn.publish(TextMessageContentBody(message_id="m", delta=after_settle))

    await turn.finish_cancelled()
    await asyncio.gather(*chat_socket._PERSIST_TASKS)

    assert persisted[0]["text"] == text
    assert [source["number"] for source in persisted[0]["metadata"].get("sources", [])] == numbers
    assert persisted[0]["metadata"]["stopped"] is True


def test_the_answer_id_is_stable_per_turn():
    assert answer_message_id(CONV, "t1") == answer_message_id(CONV, "t1")
    assert answer_message_id(CONV, "t1") != answer_message_id(CONV, "t2")

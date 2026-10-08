"""The chat socket, wire v2 (``aiq_api.chat_socket``, design §c/§d/§g).

Driven through ``ChatSocket.serve`` over an in-memory socket, with NAT's session
API stood in by a fake whose run yields what a turn's ``_run`` yields: wire
bodies. Every frame the socket writes is checked against the contract
(``HELLO`` for the first, ``WIRE_EVENT`` for the rest), so a frame the reader
could not parse fails here.
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
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.memory import InMemorySaver
from starlette.datastructures import QueryParams
from starlette.websockets import WebSocketDisconnect

from aiq_agent.common.content_screen import ScreeningRules
from aiq_agent.common.fenced_checkpointer import FencedCheckpointer
from aiq_agent.common.human_prompt import build_human_prompt
from aiq_agent.common.human_prompt import extract_user_response
from aiq_agent.common.wire_v2 import HELLO
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
from aiq_agent.common.write_fence import TurnFenced
from aiq_agent.common.write_fence import current_write_fence
from aiq_agent.turn.response import answer_message_id
from aiq_api import chat_socket
from aiq_api import internal_api as chat_socket_internal
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
from aiq_api.internal_api import ChatScreening
from nat.plugin_api import InteractionPrompt

CONV = "conv-1"
_SECRET = "test-envelope-secret"  # pragma: allowlist secret (test signing key)
_DISCONNECT = object()
_NOT_JSON = object()
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
        #: Every frame written, in order, the hello included.
        self.frames: list[dict] = []
        #: The turn events among them: everything but the hello.
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
        if item is _NOT_JSON:
            raise json.JSONDecodeError("Expecting value", "<frame>", 0)
        return item

    async def send_json(self, frame: dict) -> None:
        self.frames.append(frame)
        if frame.get("name") == "hello":
            HELLO.validate_python(frame)
            return
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
    assert sock.frames == []  # no hello: the page is told it is old, not that the server is current


async def test_the_first_frame_is_hello_before_any_client_message(harness, monkeypatch):
    monkeypatch.setenv("GRID_GIT_SHA", "abc1234")
    sock = harness().connect()
    await until(lambda: sock.frames)

    [hello] = sock.frames
    assert hello["v"] == 2
    assert hello["type"] == "CUSTOM"
    assert hello["name"] == "hello"
    assert hello["value"] == {"build": "abc1234"}
    # A connection frame, not a turn's: nothing a fold or a cursor could key on.
    assert not {"conversation_id", "turn_id", "seq"} & hello.keys()
    assert sock.sent == []

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: sock.events())
    assert sock.frames[0] is hello  # and it stays the first


async def test_a_build_without_a_sha_says_unknown_like_health(harness, monkeypatch):
    monkeypatch.delenv("GRID_GIT_SHA", raising=False)
    sock = harness().connect()
    await until(lambda: sock.frames)

    assert sock.frames[0]["value"] == {"build": "unknown"}


async def test_an_unauthenticated_socket_gets_no_hello(harness):
    sock = harness().connect(token="tok-forged", headers=[(b"host", b"public.test")])
    await until(lambda: sock.closed_with is not None)

    assert sock.frames == []


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


async def test_a_malformed_message_is_refused(harness):
    h = harness()
    sock = h.connect()

    sock.client(type="user_message", message_id="t1", text="?", include_shelves=["archiv"])
    await until(lambda: sock.rejected())

    assert sock.rejected() == [{"of": "user_message", "code": "invalid_message"}]
    assert h.sessions.opened == []


async def test_a_message_this_wire_does_not_have_is_answered_never_dropped(harness):
    """NAT's stock socket met a type it did not know with a frame the page could not read; silence is no better."""
    h = harness()
    sock = h.connect()

    sock.client(type="dance", turn_id="t9")
    sock.inbox.put_nowait("not an object")
    sock.inbox.put_nowait(_NOT_JSON)
    await until(lambda: len(sock.rejected()) == 3)

    assert [value["of"] for value in sock.rejected()] == ["unknown"] * 3
    assert {value["code"] for value in sock.rejected()} == {"invalid_message"}
    # The refusal names the turn the message named, so a client can tell which of its messages it was.
    assert sock.sent[0]["turn_id"] == "t9"
    assert h.sessions.opened == []

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: sock.events())  # the socket serves on


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


# ---------------------------------------------------------------------------
# One running turn per conversation across replicas (ADR-0080)
# ---------------------------------------------------------------------------


async def _holder(bus: ConversationBus):
    return await bus.running_holder(CONV)


def _marker_held(bus: ConversationBus) -> bool:
    return bus._t._live_keys().get(f"conv:{CONV}:running") is not None


async def test_a_second_question_on_another_replica_starts_only_after_the_first_turn_stopped(harness):
    owner, relay, relay_bus = _replicas()
    gate = Gate()
    started_after_stop: list[bool] = []

    async def second(request, ask):
        started_after_stop.append(gate.torn_down)  # the stale turn's graph run is gone by now
        async for body in answering(request, ask):
            yield body

    first = harness(gate.turn, owner).connect()
    first.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    await asyncio.sleep(0.02)  # the owner's input subscription lands
    assert (await _holder(relay_bus)).turn_id == "t1"

    elsewhere = harness(second, relay).connect()
    elsewhere.client(type="user_message", message_id="t2", text="!")
    await until(lambda: _last(elsewhere, "t2") == "RUN_FINISHED")

    assert started_after_stop == [True]
    assert first.events("t1")[-1]["outcome"] == "cancelled"
    await until(lambda: not _marker_held(relay_bus))  # the second turn gave the marker back too


async def test_a_question_is_refused_when_the_running_turn_does_not_stop_in_time(harness, monkeypatch):
    """Never run beside a turn that may still write the thread: the question ends refused, runs nothing."""
    monkeypatch.setattr(chat_socket, "SUPERSEDE_WAIT_SECONDS", 0.3)
    owner, relay, relay_bus = _replicas()
    ghost = ConversationBus(relay_bus._t, replica_id="ghost")  # a replica that holds the marker and answers nobody
    await ghost.acquire_running(CONV, "t0")

    h = harness(answering, relay)
    sock = h.connect()
    sock.client(type="user_message", message_id="t2", text="!")
    await until(lambda: _last(sock, "t2") == "RUN_FINISHED")

    finished = sock.events("t2")[-1]
    assert _types(sock.events("t2")) == ["RUN_STARTED", "RUN_FINISHED"]
    assert finished["outcome"] == "refused"
    assert "still finishing the previous answer" in finished["result"]["text"]
    assert finished["result"]["retry_after_seconds"] > 0
    assert h.sessions.opened == []
    assert (await _holder(relay_bus)).replica == "ghost"  # not ours to take or delete


async def test_a_dead_owner_s_marker_expires_and_the_question_runs(harness, monkeypatch):
    from aiq_api import conversation_bus

    monkeypatch.setattr(conversation_bus, "RUNNING_TTL_SECONDS", 0.2)
    owner, relay, relay_bus = _replicas()
    await ConversationBus(relay_bus._t, replica_id="dead").acquire_running(CONV, "t0")

    sock = harness(answering, relay).connect()
    sock.client(type="user_message", message_id="t2", text="!")
    await until(lambda: _last(sock, "t2") == "RUN_FINISHED")

    assert sock.events("t2")[-1]["outcome"] == "answered"


async def test_a_running_turn_keeps_its_marker_past_the_ttl_and_gives_it_back_at_the_end(harness, monkeypatch):
    from aiq_api import conversation_bus

    monkeypatch.setattr(conversation_bus, "RUNNING_TTL_SECONDS", 0.15)
    owner, relay, relay_bus = _replicas()
    gate = Gate()
    sock = harness(gate.turn, owner).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)

    await asyncio.sleep(0.5)  # three TTLs: only the renewals hold it
    assert (await _holder(relay_bus)).turn_id == "t1"

    gate.release.set()
    await until(lambda: _last(sock) == "RUN_FINISHED")
    await until(lambda: not _marker_held(relay_bus))


async def test_a_relay_idle_across_turns_neither_holds_the_marker_nor_blocks_the_next_turn(harness):
    owner, relay, relay_bus = _replicas()
    on_owner = harness(answering, owner)
    on_relay = harness(answering, relay)
    asker = on_owner.connect()
    idle = on_relay.connect()
    idle.client(type="attach", turn_id="t0", after_seq=0)  # a socket that only follows
    await until(lambda: idle.rejected())

    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: _last(idle) == "RUN_FINISHED")
    await until(lambda: not _marker_held(relay_bus))

    idle.client(type="user_message", message_id="t2", text="again")  # the next question lands on the idle replica
    await until(lambda: _last(idle, "t2") == "RUN_FINISHED")

    assert len(on_relay.sessions.opened) == 1
    assert len(on_owner.sessions.opened) == 1
    await until(lambda: _last(asker, "t2") == "RUN_FINISHED")  # the first replica relays what the second runs
    await until(lambda: not _marker_held(relay_bus))


async def test_a_draining_owner_finishes_its_turn_while_another_replica_streams_it(harness):
    owner, relay, relay_bus = _replicas()
    gate = Gate()
    asker = harness(gate.turn, owner).connect()
    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)

    draining = asyncio.create_task(owner.drain(timeout=5))
    reader = harness(answering, relay).connect()  # the socket uvicorn closed reconnects elsewhere
    reader.client(type="attach", turn_id="t1", after_seq=0)
    await until(lambda: reader.events())
    assert not draining.done()  # it waits for the turn, it does not cut it

    gate.release.set()
    await until(lambda: _last(reader) == "RUN_FINISHED")

    assert await draining == 0
    assert reader.events()[-1]["outcome"] == "answered"
    await until(lambda: not _marker_held(relay_bus))


async def test_a_drain_that_runs_out_cancels_the_turn_with_a_terminal(harness):
    owner, relay, relay_bus = _replicas()
    gate = Gate()
    asker = harness(gate.turn, owner).connect()
    asker.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)

    assert await owner.drain(timeout=0.05) == 1

    assert asker.events()[-1]["type"] == "RUN_FINISHED"
    assert asker.events()[-1]["outcome"] == "cancelled"
    assert gate.torn_down
    await until(lambda: not _marker_held(relay_bus))


async def test_with_the_bus_down_and_affinity_on_the_fence_fails_open(harness, monkeypatch):
    owner, _, shared = _replicas()
    monkeypatch.delenv("GRID_CHAT_AFFINITY", raising=False)
    _bus_down(monkeypatch, shared, "set_nx", "get", "publish", "xadd")
    sock = harness(answering, owner).connect()
    sock.client(type="user_message", message_id="t1", text="?")

    await until(lambda: _last(sock) == "RUN_FINISHED")

    assert sock.events()[-1]["outcome"] == "answered"


async def test_with_the_bus_down_and_affinity_off_a_question_is_refused_not_run(harness, monkeypatch):
    owner, _, shared = _replicas()
    monkeypatch.setenv("GRID_CHAT_AFFINITY", "0")
    _bus_down(monkeypatch, shared, "set_nx", "get", "publish", "xadd")
    h = harness(answering, owner)
    sock = h.connect()
    sock.client(type="user_message", message_id="t1", text="?")

    await until(lambda: _last(sock) == "RUN_FINISHED")

    assert sock.events()[-1]["outcome"] == "refused"
    assert h.sessions.opened == []


async def test_a_duplicate_never_asks_the_running_turn_to_stop(harness):
    """A late resend of a question must not cancel the turn that is running for it, or a newer one."""
    owner, relay, _ = _replicas()
    gate = Gate()
    first = harness(gate.turn, owner).connect()
    first.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    await asyncio.sleep(0.02)
    elsewhere = harness(answering, relay).connect()
    elsewhere.client(type="user_message", message_id="t1", text="?")  # resent while t1 runs
    await until(lambda: elsewhere.rejected())

    await asyncio.sleep(0.05)

    assert elsewhere.rejected() == [{"of": "user_message", "code": "duplicate_turn"}]
    assert not gate.torn_down  # t1 was not told to stop


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


# ---------------------------------------------------------------------------
# What may reach the model: the office's chat screening (ADR-0083)
# ---------------------------------------------------------------------------

_IBAN = "AT61 1904 3002 3457 3201"


def _office_envelope() -> list[tuple[bytes, bytes]]:
    return _envelope({"organizationId": "org_1", "userId": "user_asker", "conversationId": CONV})


class OfficeScreening:
    """The BFF's answer for the office's chat screening, and every organization it was asked for."""

    def __init__(self, screening: ChatScreening) -> None:
        self.screening = screening
        self.asked: list[str | None] = []

    async def __call__(self, organization_id: str | None) -> ChatScreening:
        self.asked.append(organization_id)
        return self.screening


@pytest.fixture
def office(monkeypatch) -> OfficeScreening:
    rules = ScreeningRules.build(["Gehaltsabrechnung"], ["iban", "at_svnr", "credit_card"])
    screening = OfficeScreening(ChatScreening(rules=rules, from_office=True))
    monkeypatch.setattr(chat_socket, "chat_screening_for", screening)
    return screening


def _recording(seen: list[str]):
    async def turn(request, ask):
        seen.append(request.text)
        yield _finished(request, text="ok")

    return turn


async def test_a_question_reaches_the_agent_masked(harness, office):
    seen: list[str] = []
    h = harness(_recording(seen))
    sock = h.connect(headers=_office_envelope())

    sock.client(type="user_message", message_id="t1", text=f"Gehaltsabrechnung für Anna, IBAN {_IBAN}")
    await until(lambda: _last(sock) == "RUN_FINISHED")

    # What the workflow ran on is the turn's input, and so what its checkpoint keeps.
    assert seen == ["[Begriff entfernt] für Anna, IBAN [IBAN entfernt]"]
    assert office.asked == ["org_1"]  # the SIGNED organization's policy


async def test_a_colleague_s_line_is_masked_before_the_agent_s_history_keeps_it(harness, office, monkeypatch):
    stored: list[tuple[str, str]] = []

    async def append(thread_id, text):
        stored.append((thread_id, text))
        return True

    monkeypatch.setattr(chat_socket, "append_conversation_context", append)
    sock = harness().connect(headers=_office_envelope())

    sock.client(type="user_message", message_id="t1", text=f"Konto {_IBAN}", context_only=True, author_name="X")
    await until(lambda: stored)

    assert stored == [(CONV, "Anna Asker: Konto [IBAN entfernt]")]


async def test_a_typed_answer_reaches_the_turn_masked_and_a_chosen_option_untouched(harness, office):
    answers: list[str] = []

    async def asking_free_text(request, ask):
        prompt = InteractionPrompt(id="ask_01", timestamp="2026-10-02T10:00:00Z", content=build_human_prompt("Konto?"))
        answers.append(extract_user_response(SimpleNamespace(content=await ask(prompt))))
        yield _finished(request, text="ok")

    h = harness(asking_free_text)
    sock = h.connect(headers=_office_envelope())

    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: "interaction_request" in _types(sock.events()))
    sock.client(type="interaction_response", turn_id="t1", interaction_id="ask_01", answer={"text": f"Es ist {_IBAN}"})
    await until(lambda: _last(sock) == "RUN_FINISHED")

    assert answers == ["Es ist [IBAN entfernt]"]


async def test_a_masked_question_is_masked_once(harness, office):
    seen: list[str] = []
    h = harness(_recording(seen))
    sock = h.connect(headers=_office_envelope())

    sock.client(type="user_message", message_id="t1", text="Bitte überweise an [IBAN entfernt]")
    await until(lambda: _last(sock) == "RUN_FINISHED")

    assert seen == ["Bitte überweise an [IBAN entfernt]"]


async def test_the_focus_file_name_reaches_the_agent_masked(harness, office):
    """The composer's "Asking about <file>" name is client-supplied and the system prompt quotes it."""
    names: list[str | None] = []

    async def turn(request, ask):
        names.append(request.focus_file_name)
        yield _finished(request, text="ok")

    h = harness(turn)
    sock = h.connect(headers=_office_envelope())

    sock.client(
        type="user_message",
        message_id="t1",
        text="Was steht drin?",
        focus_file_name=f"Gehaltsabrechnung {_IBAN}.pdf",
        focus_shelf="project",
    )
    await until(lambda: _last(sock) == "RUN_FINISHED")

    assert names == ["[Begriff entfernt] [IBAN entfernt].pdf"]


async def test_without_the_office_s_policy_every_detector_applies_and_no_term(harness, monkeypatch):
    """Fail closed: no organization to ask (off the BFF), or a BFF that cannot answer."""
    monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
    monkeypatch.delenv("FRONTEND_URL", raising=False)
    seen: list[str] = []
    h = harness(_recording(seen))
    sock = h.connect(headers=_office_envelope())

    sock.client(type="user_message", message_id="t1", text=f"Gehaltsabrechnung, {_IBAN}, 1237 010180")
    await until(lambda: _last(sock) == "RUN_FINISHED")

    assert seen == ["Gehaltsabrechnung, [IBAN entfernt], [SV-Nummer entfernt]"]


async def test_the_fallback_is_asked_again_and_the_office_s_answer_is_kept(harness, monkeypatch):
    rules = ScreeningRules.build(["Gehaltsabrechnung"], [])
    answers = [chat_socket_internal.CHAT_SCREENING_FALLBACK, ChatScreening(rules=rules, from_office=True)]
    asked: list[str | None] = []

    async def screening_for(organization_id):
        asked.append(organization_id)
        return answers[min(len(asked), len(answers)) - 1]

    monkeypatch.setattr(chat_socket, "chat_screening_for", screening_for)
    seen: list[str] = []
    h = harness(_recording(seen))
    sock = h.connect(headers=_office_envelope())

    for turn_id in ("t1", "t2", "t3"):
        sock.client(type="user_message", message_id=turn_id, text=f"Gehaltsabrechnung {_IBAN}")
        await until(lambda turn_id=turn_id: _last(sock, turn_id) == "RUN_FINISHED")

    assert seen == [
        "Gehaltsabrechnung [IBAN entfernt]",  # every detector, no term
        "[Begriff entfernt] AT61 1904 3002 3457 3201",  # the office's own list: a term, no detector
        "[Begriff entfernt] AT61 1904 3002 3457 3201",
    ]
    assert asked == ["org_1", "org_1"]  # the office's answer is kept for the socket's life


async def test_an_office_that_switched_screening_off_is_not_masked(harness, monkeypatch):
    monkeypatch.setattr(chat_socket, "chat_screening_for", OfficeScreening(ChatScreening(rules=None, from_office=True)))
    seen: list[str] = []
    h = harness(_recording(seen))
    sock = h.connect(headers=_office_envelope())

    sock.client(type="user_message", message_id="t1", text=f"IBAN {_IBAN}")
    await until(lambda: _last(sock) == "RUN_FINISHED")

    assert seen == [f"IBAN {_IBAN}"]


# ---------------------------------------------------------------------------
# The owner fences itself (ADR-0080): no write after a newer turn could own the conversation
# ---------------------------------------------------------------------------

#: A short marker TTL and write bound, so the deadline (TTL - margin = 0.7 s) and the expiry (1.0 s) are reachable.
FENCE_TTL = 1.0
FENCE_WRITE_TIMEOUT = 0.2
FENCE_SLACK = 0.1


class WriteLog:
    """What happened to the conversation, in the order it happened, across both replicas."""

    def __init__(self) -> None:
        self.entries: list[tuple[str, str]] = []

    def add(self, who: str, what: str) -> None:
        self.entries.append((who, what))

    def index(self, who: str, what: str) -> int:
        return self.entries.index((who, what))

    def after(self, marker: tuple[str, str]) -> list[tuple[str, str]]:
        return self.entries[self.entries.index(marker) + 1 :]

    def count(self, who: str, what: str) -> int:
        return self.entries.count((who, what))


class LoggingSaver(InMemorySaver):
    """The conversation's thread: every commit is logged when it lands, after the write's own duration."""

    def __init__(self, who: str, log: WriteLog) -> None:
        super().__init__()
        self.who, self.log, self.delay = who, log, 0.0

    async def aput(self, config, checkpoint, metadata, new_versions):
        await asyncio.sleep(self.delay)
        self.log.add(self.who, "write")
        return await super().aput(config, checkpoint, metadata, new_versions)


class FencedReplica:
    """One replica's registry, its fenced checkpointer, and a turn that writes the thread as long as it may."""

    def __init__(self, who: str, registry: ChatRegistry, log: WriteLog) -> None:
        self.who, self.registry, self.log = who, registry, log
        self.saver = LoggingSaver(who, log)
        self.checkpointer = FencedCheckpointer(self.saver)
        self.writes_made = 0

    async def write(self) -> None:
        self.writes_made += 1
        checkpoint = empty_checkpoint()
        checkpoint["id"] = f"{self.who}-{self.writes_made:06d}"
        await self.checkpointer.aput({"configurable": {"thread_id": CONV, "checkpoint_ns": ""}}, checkpoint, {}, {})

    async def turn(self, request, ask):
        """Write every 10 ms. A refused write is logged and tried again: the turn has no idea it is fenced."""
        self.log.add(self.who, f"start {request.message_id}")
        try:
            yield TextMessageStartBody(message_id="m")
            while True:
                try:
                    await self.write()
                except TurnFenced:
                    self.log.add(self.who, "refused")
                await asyncio.sleep(0.01)
        finally:
            self.log.add(self.who, f"end {request.message_id}")


def _fenced_cluster(monkeypatch, log: WriteLog) -> tuple[FencedReplica, FencedReplica, ConversationBus]:
    """Two replicas on one Dragonfly with affinity off, and a log of every time a replica takes the marker."""
    from aiq_api import conversation_bus
    from aiq_api import turn_fence

    monkeypatch.setenv("GRID_CHAT_AFFINITY", "0")
    monkeypatch.setattr(conversation_bus, "RUNNING_TTL_SECONDS", FENCE_TTL)
    monkeypatch.setattr(turn_fence, "GUARDED_WRITE_TIMEOUT_SECONDS", FENCE_WRITE_TIMEOUT)
    monkeypatch.setattr(turn_fence, "FENCE_SLACK_SECONDS", FENCE_SLACK)
    monkeypatch.setattr(chat_socket, "SUPERSEDE_WAIT_SECONDS", 3.0)
    monkeypatch.setattr(chat_socket, "SUPERSEDE_REPUBLISH_SECONDS", 0.1)
    owner_registry, relay_registry, shared = _replicas()
    transport = shared._t
    real_set_nx = transport.set_nx

    async def logged_set_nx(key, value, ttl):
        taken = await real_set_nx(key, value, ttl)
        if taken and key.endswith(":running"):
            holder = json.loads(value)
            log.add("marker", f"{'B' if holder['replica'] == 'relay' else 'A'} took it for {holder['turn_id']}")
        return taken

    monkeypatch.setattr(transport, "set_nx", logged_set_nx)
    return FencedReplica("A", owner_registry, log), FencedReplica("B", relay_registry, log), shared


def _lose_the_cancel_and_the_renewals(replica: FencedReplica) -> None:
    """Both of the old owner's ways of hearing "stop" come late: the renewing task never runs, the message is lost."""

    async def starved(turn) -> None:
        await asyncio.sleep(3600)

    replica.registry.keep_conversation = starved
    replica.registry._supersede_local = lambda *args, **kwargs: None


async def test_an_owner_whose_renewals_and_cancel_are_both_late_writes_nothing_after_the_next_owner_took_over(
    harness, monkeypatch
):
    log = WriteLog()
    a, b, _ = _fenced_cluster(monkeypatch, log)
    _lose_the_cancel_and_the_renewals(a)
    first = harness(a.turn, a.registry).connect()
    first.client(type="user_message", message_id="t1", text="?")
    await until(lambda: a.writes_made >= 3)

    second = harness(b.turn, b.registry).connect()
    second.client(type="user_message", message_id="t2", text="!")  # waits for the marker to run out, then takes it
    taken = ("marker", "B took it for t2")
    await until(lambda: taken in log.entries, timeout=5.0)
    await until(lambda: b.writes_made >= 3)

    assert ("A", "write") not in log.after(taken)  # the old owner never wrote again
    assert ("A", "refused") in log.entries[: log.entries.index(taken)]  # and it was the fence that said no, not luck
    assert ("B", "write") in log.after(taken)
    assert log.count("A", "write") >= 3  # it did write while it was the owner


async def test_a_starved_renewal_task_cannot_leave_a_stale_still_the_owner(harness, monkeypatch):
    """A blocked loop runs no task, the renewal included: the next write must refuse by the clock alone."""
    log = WriteLog()
    a, _, _ = _fenced_cluster(monkeypatch, log)
    seen: dict[str, Any] = {}

    async def turn(request, ask):
        yield TextMessageStartBody(message_id="m")
        await a.write()
        fence = current_write_fence()
        time.sleep(fence.remaining() + 0.05)  # the loop is blocked: the renewal task, due long ago, cannot run
        seen["flagged_by_a_task"] = fence._tripped
        try:
            await a.write()
        except TurnFenced:
            seen["refused"] = True
        yield _finished(request, text="done")

    sock = harness(turn, a.registry).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: _last(sock) == "RUN_FINISHED")

    assert seen == {"flagged_by_a_task": False, "refused": True}
    assert log.count("A", "write") == 1


async def test_a_write_in_flight_when_the_deadline_passes_lands_before_a_new_owner_can_take_the_marker(
    harness, monkeypatch
):
    log = WriteLog()
    a, b, _ = _fenced_cluster(monkeypatch, log)
    _lose_the_cancel_and_the_renewals(a)
    a.saver.delay = FENCE_WRITE_TIMEOUT * 0.75  # the longest write the bound lets through, nearly

    async def turn(request, ask):
        yield TextMessageStartBody(message_id="m")
        fence = current_write_fence()
        await asyncio.sleep(max(0.0, fence.remaining() - 0.02))  # the check passes, and the write outlives the deadline
        await a.write()
        log.add("A", "write returned")
        await asyncio.sleep(3600)

    first = harness(turn, a.registry).connect()
    first.client(type="user_message", message_id="t1", text="?")
    second = harness(answering, b.registry).connect()
    second.client(type="user_message", message_id="t2", text="!")
    taken = ("marker", "B took it for t2")
    await until(lambda: taken in log.entries, timeout=5.0)

    assert ("A", "write returned") in log.entries
    assert log.index("A", "write returned") < log.index(*taken)
    assert ("A", "write") not in log.after(taken)


async def test_one_failed_bus_command_for_another_conversation_does_not_starve_the_renewals(harness, monkeypatch):
    """The fail-fast window refuses commands without I/O; the renewal must not be one of them."""
    from aiq_api.conversation_bus import BusUnavailable

    log = WriteLog()
    a, _, shared = _fenced_cluster(monkeypatch, log)
    gate = Gate()
    sock = harness(gate.turn, a.registry).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    guard = a.registry.running(CONV).guard
    real_xadd = shared._t.xadd

    async def slow_once(*args, **kwargs):
        monkeypatch.setattr(shared._t, "xadd", real_xadd)
        raise TimeoutError("Timeout reading from dragonfly:6379")

    monkeypatch.setattr(shared._t, "xadd", slow_once)
    with pytest.raises(BusUnavailable):
        await a.registry.bus().publish_frame("another-conversation", {"turn_id": "x", "seq": 1})

    await asyncio.sleep(FENCE_TTL * 2)  # the bus stays marked down for 5 s, well past the turn's deadline

    assert not guard.fenced()
    assert sock.events()[-1]["type"] != "RUN_FINISHED"
    gate.release.set()
    await until(lambda: _last(sock) == "RUN_FINISHED")
    assert sock.events()[-1]["outcome"] == "answered"


async def test_a_renewal_that_fails_is_tried_again_before_the_deadline(monkeypatch):
    """After a failed renewal the keeper retries sooner than an interval, never later than the deadline."""
    monkeypatch.setattr(chat_socket, "RENEW_RETRY_SECONDS", 1.0)
    monkeypatch.setattr(chat_socket, "running_renew_interval", lambda: 3.0)

    assert chat_socket._renew_wait(None) == 3.0
    assert chat_socket._renew_wait(None, retrying=True) == 1.0
    guard = SimpleNamespace(remaining=lambda: 0.4)
    assert chat_socket._renew_wait(guard, retrying=True) == 0.4


async def test_a_renewal_that_finds_the_marker_gone_fences_the_turn_and_cancels_it_with_a_terminal(
    harness, monkeypatch, persisted
):
    log = WriteLog()
    a, _, _ = _fenced_cluster(monkeypatch, log)
    gate = Gate()
    sock = harness(gate.turn, a.registry).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    guard = a.registry.running(CONV).guard

    async def lost(conversation_id, turn_id):
        return False

    monkeypatch.setattr(a.registry.bus(), "renew_running", lost)
    await until(lambda: _last(sock) == "RUN_FINISHED")
    await asyncio.gather(*chat_socket._PERSIST_TASKS)

    assert sock.events()[-1]["outcome"] == "cancelled"
    assert gate.torn_down  # the graph run was cancelled, not abandoned
    assert guard.fenced()
    assert persisted == []  # it had streamed prose, and a turn that lost its conversation persists none of it


async def test_an_owner_cut_off_from_dragonfly_past_its_window_cancels_itself_and_sends_only_its_terminal(
    harness, monkeypatch
):
    log = WriteLog()
    a, _, shared = _fenced_cluster(monkeypatch, log)
    gate = Gate()
    sock = harness(gate.turn, a.registry).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    _bus_down(monkeypatch, shared, "expire_if_value", "publish", "xadd", "get")
    heard = len(sock.events())

    await until(lambda: _last(sock) == "RUN_FINISHED", timeout=5.0)

    assert sock.events()[-1]["outcome"] == "cancelled"
    assert gate.torn_down
    assert [event["type"] for event in sock.events()[heard:]] == ["RUN_FINISHED"]  # no frame but the terminal


async def test_two_questions_racing_from_an_empty_marker_never_run_at_once(harness, monkeypatch):
    log = WriteLog()
    a, b, _ = _fenced_cluster(monkeypatch, log)
    first = harness(a.turn, a.registry).connect()
    second = harness(b.turn, b.registry).connect()

    first.client(type="user_message", message_id="t1", text="?")
    second.client(type="user_message", message_id="t2", text="!")  # the same tick, another replica, another turn id
    await until(lambda: sum(what.startswith("start ") for _, what in log.entries) >= 2, timeout=5.0)

    running = 0
    for _, what in log.entries:
        running += what.startswith("start ") - what.startswith("end ")
        assert running <= 1, log.entries  # a second turn started before the first had ended
    takes = [what for who, what in log.entries if who == "marker"]
    assert len(takes) == 2  # one took it, and the other only after that one had stopped and given it back
    first_end = next(entry for entry in log.entries if entry[1].startswith("end "))
    assert log.entries.index(first_end) < log.index("marker", takes[1])


async def test_with_affinity_on_an_owner_that_cannot_renew_keeps_running_as_before(harness, monkeypatch):
    """Affinity keeps both turns of a conversation in one process: the fence fails open, as the bus does."""
    from aiq_api import conversation_bus

    monkeypatch.delenv("GRID_CHAT_AFFINITY", raising=False)
    monkeypatch.setattr(conversation_bus, "RUNNING_TTL_SECONDS", FENCE_TTL)
    owner, _, shared = _replicas()
    gate = Gate()
    sock = harness(gate.turn, owner).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: gate.calls)
    assert owner.running(CONV).guard is None
    _bus_down(monkeypatch, shared, "expire_if_value", "publish", "xadd", "get")

    await asyncio.sleep(FENCE_TTL * 2)  # twice the marker's life, with no renewal getting through

    assert owner.running(CONV) is not None
    assert sock.events()[-1]["type"] != "RUN_FINISHED"
    gate.release.set()
    await until(lambda: _last(sock) == "RUN_FINISHED")
    assert sock.events()[-1]["outcome"] == "answered"


async def test_a_finished_turn_takes_its_fence_off_so_the_stage_frames_behind_it_still_go_out(harness, monkeypatch):
    log = WriteLog()
    a, _, _ = _fenced_cluster(monkeypatch, log)
    sock = harness(answering, a.registry).connect()
    sock.client(type="user_message", message_id="t1", text="?")
    await until(lambda: _last(sock) == "RUN_FINISHED")
    guard = a.registry.wire(CONV, "t1")._guard

    assert guard is not None
    await asyncio.sleep(FENCE_TTL)  # past the old deadline, with nobody renewing any more

    assert not guard.fenced()

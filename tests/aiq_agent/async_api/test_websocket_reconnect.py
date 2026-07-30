"""Unit tests for reconnectable websocket handling."""

# pylint: disable=protected-access

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pytest
from pydantic import BaseModel
from starlette.websockets import WebSocketDisconnect

from aiq_agent.conversation_context import MAX_CONTEXT_MESSAGE_CHARS
from aiq_agent.conversation_context import register_context_appender
from aiq_api import websocket_reconnect
from aiq_api.auth.middleware import get_current_user
from aiq_api.auth.request_trace import get_request_trace_tags
from aiq_api.websocket_reconnect import ReconnectableWebSocketMessageHandler
from aiq_api.websocket_reconnect import WebSocketSessionRegistry
from aiq_api.websocket_reconnect import authenticate_websocket_connection
from aiq_api.websocket_reconnect import configure_websocket_auth
from nat.data_models.api_server import TextContent
from nat.data_models.api_server import UserMessageContent
from nat.data_models.api_server import UserMessageContentRoleType
from nat.data_models.api_server import UserMessages
from nat.data_models.api_server import WebSocketMessageType
from nat.data_models.api_server import WebSocketUserInteractionResponseMessage
from nat.data_models.api_server import WebSocketUserMessage
from nat.data_models.api_server import WorkflowSchemaType


class DummySocket:
    """Minimal websocket stand-in for handler testing."""

    def __init__(
        self,
        messages: list[dict] | None = None,
        raise_on_send: bool = False,
        headers: list[tuple[bytes, bytes]] | None = None,
    ) -> None:
        self._messages = messages or []
        self._index = 0
        self.raise_on_send = raise_on_send
        self.sent: list[dict] = []
        self.closed_with: int | None = None
        self.scope = {"headers": headers or [], "type": "websocket"}

    async def receive_json(self) -> dict:
        if self._index >= len(self._messages):
            raise WebSocketDisconnect(1000)
        value = self._messages[self._index]
        self._index += 1
        return value

    async def send_json(self, payload: dict) -> None:
        if self.raise_on_send:
            raise RuntimeError("send failed")
        self.sent.append(payload)

    async def close(self, code: int) -> None:
        self.closed_with = code


class DummySessionManager:
    """Minimal session manager stub for handler initialization."""

    def get_workflow_single_output_schema(self):
        return None

    def get_workflow_streaming_output_schema(self):
        return None

    @asynccontextmanager
    async def session(self, **_kwargs):
        yield object()


class DummyStepAdaptor:
    """Minimal step adaptor stub."""


class DummyWorker:
    """Minimal FastApiFrontEndPluginWorker stand-in (NAT handler requires worker)."""

    def set_conversation_handler(self, _conversation_id: str, _handler: object) -> None:
        return None

    def get_conversation_handler(self, _conversation_id: str) -> object | None:
        return None

    def remove_conversation_handler(self, _conversation_id: str) -> None:
        return None


class DummyMessage(BaseModel):
    """Simple pydantic message for tests."""

    content: str = "ok"


class DummyValidator:
    def __init__(self, user: dict | None = None) -> None:
        self.user = user
        self.tokens: list[str] = []

    def can_handle(self, token: str) -> bool:
        self.tokens.append(token)
        return True

    async def validate(self, token: str) -> dict | None:
        self.tokens.append(token)
        return self.user


@pytest.fixture(name="event_loop")
def fixture_event_loop() -> AsyncGenerator[asyncio.AbstractEventLoop, None]:
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(name="dummy_socket")
def fixture_dummy_socket() -> DummySocket:
    return DummySocket()


@pytest.mark.asyncio
async def test_registry_set_send_clear_socket(
    dummy_socket: DummySocket,
) -> None:
    registry = WebSocketSessionRegistry()
    await registry.set_socket("conv-1", dummy_socket)

    message = DummyMessage()
    assert await registry.send("conv-1", message) is True
    assert dummy_socket.sent == [message.model_dump()]

    await registry.clear_socket("conv-1", dummy_socket)
    assert await registry.send("conv-1", message) is False


@pytest.mark.asyncio
async def test_registry_clear_socket_mismatch(
    dummy_socket: DummySocket,
) -> None:
    registry = WebSocketSessionRegistry()
    other_socket = DummySocket()
    await registry.set_socket("conv-1", dummy_socket)
    await registry.clear_socket("conv-1", other_socket)

    assert await registry.send("conv-1", DummyMessage()) is True


@pytest.mark.asyncio
async def test_registry_send_handles_missing_and_error() -> None:
    registry = WebSocketSessionRegistry()
    assert await registry.send(None, DummyMessage()) is False
    assert await registry.send("missing", DummyMessage()) is False

    failing_socket = DummySocket(raise_on_send=True)
    await registry.set_socket("conv-1", failing_socket)
    assert await registry.send("conv-1", DummyMessage()) is False


@pytest.mark.asyncio
async def test_registry_pending_interaction_resolve() -> None:
    registry = WebSocketSessionRegistry()
    future: asyncio.Future[TextContent] = asyncio.get_running_loop().create_future()
    await registry.register_pending_interaction("conv-1", future)

    response = TextContent(text="hello")
    assert await registry.resolve_pending_interaction("conv-1", response) is True
    assert future.result() == response
    assert await registry.resolve_pending_interaction("conv-1", response) is False

    await registry.clear_pending_interaction("conv-1")
    assert await registry.resolve_pending_interaction("conv-1", response) is False


@pytest.mark.asyncio
async def test_only_the_person_who_was_asked_may_answer() -> None:
    """A colleague in a shared conversation must not answer a prompt asked of someone else.

    ``_pending_interactions`` is keyed by conversation id, so before this every
    socket registered for the conversation could resolve the future. In a shared
    conversation (ADR-0032) that is a second participant answering a question the
    assistant asked the first — and nothing on the server stopped it. The only thing
    that did was the colleague's browser having no prompt to render, which is a UI
    accident, not an authorization rule.
    """
    registry = WebSocketSessionRegistry()
    future: asyncio.Future[TextContent] = asyncio.get_running_loop().create_future()
    await registry.register_pending_interaction("conv-1", future, "user_matthias")

    response = TextContent(text="ja, passt")

    # A colleague: refused, and the prompt stays open for the person it is for.
    assert await registry.resolve_pending_interaction("conv-1", response, "user_anna") is False
    assert not future.done()

    # An unauthenticated answer cannot stand in for a named one either.
    assert await registry.resolve_pending_interaction("conv-1", response, None) is False
    assert not future.done()

    # The person who was asked: accepted.
    assert await registry.resolve_pending_interaction("conv-1", response, "user_matthias") is True
    assert future.result() == response


@pytest.mark.asyncio
async def test_an_unauthenticated_prompt_stays_answerable() -> None:
    """No verified human was asked, so there is no identity to match.

    Internal and service-token callers are trusted by other means. Requiring a
    subject here would make every internal HITL turn permanently unanswerable —
    closing a hole by breaking a working path.
    """
    registry = WebSocketSessionRegistry()
    future: asyncio.Future[TextContent] = asyncio.get_running_loop().create_future()
    await registry.register_pending_interaction("conv-1", future, None)

    response = TextContent(text="ok")
    assert await registry.resolve_pending_interaction("conv-1", response, None) is True
    assert future.result() == response


@pytest.mark.asyncio
async def test_a_bus_relayed_answer_is_not_re_authorized() -> None:
    """A multi-replica relay carries no subject, and was authorized upstream.

    The replica that accepted the answer from a socket already checked the sender;
    the subject is not on the bus wire. Re-checking here would reject every
    legitimate cross-replica answer.
    """
    registry = WebSocketSessionRegistry()
    future: asyncio.Future[TextContent] = asyncio.get_running_loop().create_future()
    await registry.register_pending_interaction("conv-1", future, "user_matthias")

    response = TextContent(text="ja")
    assert await registry.resolve_pending_interaction("conv-1", response, websocket_reconnect._ANY_SUBJECT) is True
    assert future.result() == response


@pytest.mark.asyncio
async def test_submit_hitl_answer_carries_the_answerer_through() -> None:
    registry = WebSocketSessionRegistry()
    future: asyncio.Future[TextContent] = asyncio.get_running_loop().create_future()
    await registry.register_pending_interaction("conv-1", future, "user_matthias")

    response = TextContent(text="ja")
    assert await registry.submit_hitl_answer("conv-1", response, "user_anna") is False
    assert not future.done()
    assert await registry.submit_hitl_answer("conv-1", response, "user_matthias") is True
    assert future.result() == response


@pytest.mark.asyncio
async def test_handler_create_websocket_message_uses_registry_send(
    monkeypatch,
    dummy_socket: DummySocket,
) -> None:
    handler = ReconnectableWebSocketMessageHandler(
        socket=dummy_socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._conversation_id = "conv-1"

    async def fake_send(_conversation_id, _message):
        return True

    async def fake_resolve_message_type(_data_model):
        return "response"

    async def fake_get_schema(_message_type):
        from nat.data_models.api_server import WebSocketSystemResponseTokenMessage

        return WebSocketSystemResponseTokenMessage

    async def fake_convert_data(_data_model):
        return DummyMessage()

    async def fake_create_response_message(**_kwargs):
        return DummyMessage(content="sent")

    monkeypatch.setattr(
        websocket_reconnect,
        "_registry",
        WebSocketSessionRegistry(),
    )
    monkeypatch.setattr(websocket_reconnect._registry, "send", fake_send)
    monkeypatch.setattr(
        handler._message_validator,
        "resolve_message_type_by_data",
        fake_resolve_message_type,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "get_message_schema_by_type",
        fake_get_schema,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "convert_data_to_message_content",
        fake_convert_data,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "create_system_response_token_message",
        fake_create_response_message,
    )

    await handler.create_websocket_message(data_model=DummyMessage())
    assert dummy_socket.sent == []


@pytest.mark.asyncio
async def test_handler_create_websocket_message_drops_for_disconnected_conversation(
    monkeypatch,
) -> None:
    """When registry.send fails for a valid conversation_id the message is dropped
    instead of falling back to the (likely dead) direct socket."""
    failing_registry = WebSocketSessionRegistry()
    dummy_socket = DummySocket()
    handler = ReconnectableWebSocketMessageHandler(
        socket=dummy_socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._conversation_id = "conv-1"

    async def fake_send(_conversation_id, _message):
        return False

    async def fake_resolve_message_type(_data_model):
        return "response"

    async def fake_get_schema(_message_type):
        from nat.data_models.api_server import WebSocketSystemResponseTokenMessage

        return WebSocketSystemResponseTokenMessage

    async def fake_convert_data(_data_model):
        return DummyMessage()

    async def fake_create_response_message(**_kwargs):
        return DummyMessage(content="sent")

    monkeypatch.setattr(websocket_reconnect, "_registry", failing_registry)
    monkeypatch.setattr(websocket_reconnect._registry, "send", fake_send)
    monkeypatch.setattr(
        handler._message_validator,
        "resolve_message_type_by_data",
        fake_resolve_message_type,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "get_message_schema_by_type",
        fake_get_schema,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "convert_data_to_message_content",
        fake_convert_data,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "create_system_response_token_message",
        fake_create_response_message,
    )

    await handler.create_websocket_message(data_model=DummyMessage())
    assert dummy_socket.sent == []


@pytest.mark.asyncio
async def test_handler_create_websocket_message_falls_back_to_socket_without_conversation(
    monkeypatch,
) -> None:
    """When conversation_id is None, fall back to the direct socket."""
    failing_registry = WebSocketSessionRegistry()
    dummy_socket = DummySocket()
    handler = ReconnectableWebSocketMessageHandler(
        socket=dummy_socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._conversation_id = None

    async def fake_send(_conversation_id, _message):
        return False

    async def fake_resolve_message_type(_data_model):
        return "response"

    async def fake_get_schema(_message_type):
        from nat.data_models.api_server import WebSocketSystemResponseTokenMessage

        return WebSocketSystemResponseTokenMessage

    async def fake_convert_data(_data_model):
        return DummyMessage()

    async def fake_create_response_message(**_kwargs):
        return DummyMessage(content="sent")

    monkeypatch.setattr(websocket_reconnect, "_registry", failing_registry)
    monkeypatch.setattr(websocket_reconnect._registry, "send", fake_send)
    monkeypatch.setattr(
        handler._message_validator,
        "resolve_message_type_by_data",
        fake_resolve_message_type,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "get_message_schema_by_type",
        fake_get_schema,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "convert_data_to_message_content",
        fake_convert_data,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "create_system_response_token_message",
        fake_create_response_message,
    )

    await handler.create_websocket_message(data_model=DummyMessage())
    assert dummy_socket.sent == [{"content": "sent"}]


@pytest.mark.asyncio
async def test_handler_create_websocket_message_handles_socket_failure(
    monkeypatch,
) -> None:
    failing_registry = WebSocketSessionRegistry()
    dummy_socket = DummySocket(raise_on_send=True)
    handler = ReconnectableWebSocketMessageHandler(
        socket=dummy_socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._conversation_id = "conv-1"

    async def fake_send(_conversation_id, _message):
        return False

    async def fake_resolve_message_type(_data_model):
        return "response"

    async def fake_get_schema(_message_type):
        from nat.data_models.api_server import WebSocketSystemResponseTokenMessage

        return WebSocketSystemResponseTokenMessage

    async def fake_convert_data(_data_model):
        return DummyMessage()

    async def fake_create_response_message(**_kwargs):
        return DummyMessage(content="sent")

    monkeypatch.setattr(websocket_reconnect, "_registry", failing_registry)
    monkeypatch.setattr(websocket_reconnect._registry, "send", fake_send)
    monkeypatch.setattr(
        handler._message_validator,
        "resolve_message_type_by_data",
        fake_resolve_message_type,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "get_message_schema_by_type",
        fake_get_schema,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "convert_data_to_message_content",
        fake_convert_data,
    )
    monkeypatch.setattr(
        handler._message_validator,
        "create_system_response_token_message",
        fake_create_response_message,
    )

    await handler.create_websocket_message(data_model=DummyMessage())
    assert dummy_socket.sent == []


@pytest.mark.asyncio
async def test_handler_run_resolves_pending_future(monkeypatch) -> None:
    dummy_socket = DummySocket(messages=[{"ok": True}])
    handler = ReconnectableWebSocketMessageHandler(
        socket=dummy_socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._conversation_id = "conv-1"

    content = UserMessageContent(
        messages=[
            UserMessages(
                role=UserMessageContentRoleType.USER,
                content=[TextContent(text="response")],
            )
        ]
    )
    response_message = WebSocketUserInteractionResponseMessage(
        type=WebSocketMessageType.USER_INTERACTION_MESSAGE,
        id="msg-1",
        thread_id="thread-1",
        parent_id="parent-1",
        conversation_id="conv-1",
        content=content,
    )

    future: asyncio.Future[TextContent] = asyncio.get_running_loop().create_future()
    handler._user_interaction_response = future

    async def fake_validate_message(_message):
        return response_message

    async def fake_set_socket(_conversation_id, _socket):
        return None

    monkeypatch.setattr(
        handler._message_validator,
        "validate_message",
        fake_validate_message,
    )
    monkeypatch.setattr(
        websocket_reconnect._registry,
        "set_socket",
        fake_set_socket,
    )

    await handler.run()
    assert future.done()
    assert future.result().text == "response"


@pytest.mark.asyncio
async def test_handler_run_uses_registry_when_no_future(
    monkeypatch,
) -> None:
    dummy_socket = DummySocket(messages=[{"ok": True}])
    handler = ReconnectableWebSocketMessageHandler(
        socket=dummy_socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._conversation_id = "conv-1"

    content = UserMessageContent(
        messages=[
            UserMessages(
                role=UserMessageContentRoleType.USER,
                content=[TextContent(text="response")],
            )
        ]
    )
    response_message = WebSocketUserInteractionResponseMessage(
        type=WebSocketMessageType.USER_INTERACTION_MESSAGE,
        id="msg-1",
        thread_id="thread-1",
        parent_id="parent-1",
        conversation_id="conv-1",
        content=content,
    )

    async def fake_validate_message(_message):
        return response_message

    async def fake_set_socket(_conversation_id, _socket):
        return None

    async def fake_resolve_pending(_conversation_id, _user_content, _answered_by=None):
        return True

    monkeypatch.setattr(
        handler._message_validator,
        "validate_message",
        fake_validate_message,
    )
    monkeypatch.setattr(
        websocket_reconnect._registry,
        "set_socket",
        fake_set_socket,
    )
    monkeypatch.setattr(
        websocket_reconnect._registry,
        "resolve_pending_interaction",
        fake_resolve_pending,
    )

    await handler.run()


@pytest.mark.asyncio
async def test_handler_run_processes_user_message(monkeypatch) -> None:
    dummy_socket = DummySocket(messages=[{"ok": True}])
    handler = ReconnectableWebSocketMessageHandler(
        socket=dummy_socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )

    content = UserMessageContent(
        messages=[
            UserMessages(
                role=UserMessageContentRoleType.USER,
                content=[TextContent(text="start")],
            )
        ]
    )
    user_message = WebSocketUserMessage(
        type=WebSocketMessageType.USER_MESSAGE,
        schema_type=WorkflowSchemaType.CHAT_STREAM,
        id="msg-1",
        conversation_id="conv-1",
        content=content,
    )
    processed: list[WebSocketUserMessage] = []
    sockets: list[str] = []

    async def fake_validate_message(_message):
        return user_message

    async def fake_process_workflow(_message):
        processed.append(_message)

    async def fake_set_socket(conversation_id, _socket):
        sockets.append(conversation_id)

    monkeypatch.setattr(handler._message_validator, "validate_message", fake_validate_message)
    monkeypatch.setattr(handler, "process_workflow_request", fake_process_workflow)
    monkeypatch.setattr(websocket_reconnect._registry, "set_socket", fake_set_socket)

    await handler.run()

    assert processed == [user_message]
    assert sockets == ["conv-1"]


@pytest.mark.asyncio
async def test_handler_run_survives_disconnect_without_cancelling_workflow(monkeypatch) -> None:
    """A client disconnect must NOT cancel the in-flight workflow.

    Navigating away mid-generation has to keep the turn running so the backend
    can finish it and persist the response server-side; the socket is released
    but the workflow task keeps going.
    """
    dummy_socket = DummySocket()  # no messages → immediate WebSocketDisconnect
    handler = ReconnectableWebSocketMessageHandler(
        socket=dummy_socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._conversation_id = "conv-1"

    # Simulate a long-running workflow task (sleeps forever)
    workflow_task = asyncio.create_task(asyncio.sleep(999))
    handler._running_workflow_task = workflow_task

    # Also register the task in the global registry
    await websocket_reconnect._registry.set_workflow_task("conv-1", workflow_task)

    # Register a socket so we can assert it is released on disconnect.
    await websocket_reconnect._registry.set_socket("conv-1", dummy_socket)

    await handler.run()

    # Let the event loop turn over; the task must still be alive.
    await asyncio.sleep(0)
    assert not workflow_task.cancelled()
    assert not workflow_task.done()
    # The socket is released so a stale reference can't be reused.
    assert not await websocket_reconnect._registry.has_socket("conv-1")

    # Cleanup the still-running task.
    workflow_task.cancel()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_registry_set_workflow_task_cancels_stale() -> None:
    """Registering a new workflow task cancels any previous stale one."""
    registry = WebSocketSessionRegistry()

    stale_task = asyncio.create_task(asyncio.sleep(999))
    await registry.set_workflow_task("conv-1", stale_task)
    await asyncio.sleep(0)
    assert not stale_task.cancelled()

    new_task = asyncio.create_task(asyncio.sleep(999))
    await registry.set_workflow_task("conv-1", new_task)
    await asyncio.sleep(0)  # let cancellation propagate to stale_task

    assert stale_task.cancelled()
    assert not new_task.cancelled()

    new_task.cancel()
    await asyncio.sleep(0)  # let cancellation propagate


@pytest.mark.asyncio
async def test_registry_cancel_workflow_task() -> None:
    """cancel_workflow_task removes and cancels the tracked task."""
    registry = WebSocketSessionRegistry()

    task = asyncio.create_task(asyncio.sleep(999))
    await registry.set_workflow_task("conv-1", task)
    await asyncio.sleep(0)
    assert not task.cancelled()

    await registry.cancel_workflow_task("conv-1")
    await asyncio.sleep(0)  # let cancellation propagate
    assert task.cancelled()

    # Idempotent: calling again is a no-op
    await registry.cancel_workflow_task("conv-1")


@pytest.mark.asyncio
async def test_registry_cancel_workflow_task_noop_for_missing() -> None:
    """cancel_workflow_task is safe for missing conversation IDs."""
    registry = WebSocketSessionRegistry()
    await registry.cancel_workflow_task(None)
    await registry.cancel_workflow_task("nonexistent")


class _FakeResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _FakeAsyncClient:
    """Records POSTs and returns a canned status; stands in for httpx.AsyncClient."""

    calls: list[dict] = []
    status_code = 201
    raise_on_post = False

    def __init__(self, *args, **kwargs) -> None:
        self.init_kwargs = kwargs

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, *args) -> bool:
        return False

    async def post(self, url, json=None, headers=None):
        _FakeAsyncClient.calls.append({"url": url, "json": json, "headers": headers})
        if _FakeAsyncClient.raise_on_post:
            raise RuntimeError("connection refused")
        return _FakeResponse(_FakeAsyncClient.status_code)


@pytest.fixture(autouse=True)
def _reset_fake_client():
    _FakeAsyncClient.calls = []
    _FakeAsyncClient.status_code = 201
    _FakeAsyncClient.raise_on_post = False
    yield


class _RespContent(BaseModel):
    text: str


class _RespMessage(BaseModel):
    content: _RespContent
    cards: list | None = None
    deep_research_job_id: str | None = None
    answer_confidence: str | None = None


@pytest.mark.asyncio
async def test_create_websocket_message_persists_terminal_response_when_client_gone(monkeypatch) -> None:
    """A dropped terminal RESPONSE_MESSAGE with content is persisted server-side."""
    from nat.data_models.api_server import WebSocketMessageType
    from nat.data_models.api_server import WebSocketSystemResponseTokenMessage

    registry = WebSocketSessionRegistry()  # no socket registered → client gone
    monkeypatch.setattr(websocket_reconnect, "_registry", registry)
    monkeypatch.setattr(websocket_reconnect.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")

    handler = ReconnectableWebSocketMessageHandler(
        # server.js forwards the conversation's owning org on the WS upgrade; the
        # internal persist route scopes the conversation lookup by it.
        socket=DummySocket(headers=[(b"x-grid-organization-id", b"org-1")]),
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._conversation_id = "conv-1"
    handler._message_parent_id = "user-msg-1"

    async def fake_get_schema(_message_type):
        return WebSocketSystemResponseTokenMessage

    async def fake_convert_data(_data_model):
        return _RespContent(text="Final answer [1].")

    async def fake_create_response_message(**_kwargs):
        return _RespMessage(content=_RespContent(text="Final answer [1]."), cards=[{"type": "summary", "title": "T"}])

    monkeypatch.setattr(handler._message_validator, "get_message_schema_by_type", fake_get_schema)
    monkeypatch.setattr(handler._message_validator, "convert_data_to_message_content", fake_convert_data)
    monkeypatch.setattr(
        handler._message_validator, "create_system_response_token_message", fake_create_response_message
    )

    await handler.create_websocket_message(
        data_model=DummyMessage(),
        message_type=WebSocketMessageType.RESPONSE_MESSAGE,
    )

    assert len(_FakeAsyncClient.calls) == 1
    call = _FakeAsyncClient.calls[0]
    assert call["url"] == "http://frontend:3000/api/internal/conversations/conv-1/messages"
    body = call["json"]
    assert body["content"] == "Final answer [1]."
    assert body["organizationId"] == "org-1"
    assert body["metadata"]["cards"] == [{"type": "summary", "title": "T"}]
    # Internal service token, not replayed browser cookies.
    assert call["headers"]["X-Grid-Internal-Token"] == "secret-token"
    assert "cookie" not in {k.lower() for k in call["headers"]}


def test_deterministic_assistant_message_id_is_stable_and_turn_scoped() -> None:
    a = websocket_reconnect.deterministic_assistant_message_id("conv-1", "user-msg-1")
    b = websocket_reconnect.deterministic_assistant_message_id("conv-1", "user-msg-1")
    c = websocket_reconnect.deterministic_assistant_message_id("conv-1", "user-msg-2")
    d = websocket_reconnect.deterministic_assistant_message_id("conv-2", "user-msg-1")
    assert a == b  # same turn → same id (double POST no-ops on the conflict key)
    assert a != c  # different turn on same conversation → distinct id
    assert a != d  # different conversation → distinct id


@pytest.mark.asyncio
async def test_persist_assistant_message_posts_expected_payload(monkeypatch) -> None:
    monkeypatch.setattr(websocket_reconnect, "_registry", WebSocketSessionRegistry())
    monkeypatch.setattr(websocket_reconnect.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")

    ok = await websocket_reconnect.persist_assistant_message(
        conversation_id="conv-1",
        parent_id="user-msg-1",
        text="The finished answer [1].",
        organization_id="org-1",
        cards=[{"type": "summary", "title": "T"}],
        deep_research_job_id="job-9",
        answer_confidence="high",
        answer_confidence_reason="Direkt durch OIB-RL 2 belegt",
    )

    assert ok is True
    assert len(_FakeAsyncClient.calls) == 1
    call = _FakeAsyncClient.calls[0]
    # Targets the INTERNAL token-guarded route (not the session-cookie route).
    assert call["url"] == "http://frontend:3000/api/internal/conversations/conv-1/messages"
    assert call["headers"]["X-Grid-Internal-Token"] == "secret-token"
    assert call["headers"]["Content-Type"] == "application/json"
    body = call["json"]
    assert body["organizationId"] == "org-1"
    assert body["role"] == "assistant"
    assert body["content"] == "The finished answer [1]."
    assert body["messageType"] == "agent_response"
    assert body["id"] == websocket_reconnect.deterministic_assistant_message_id("conv-1", "user-msg-1")
    assert body["metadata"]["cards"] == [{"type": "summary", "title": "T"}]
    assert body["metadata"]["deep_research_job_id"] == "job-9"
    assert body["metadata"]["answer_confidence"] == "high"
    assert body["metadata"]["answer_confidence_reason"] == "Direkt durch OIB-RL 2 belegt"


@pytest.mark.asyncio
async def test_persist_assistant_message_skips_when_live_socket(monkeypatch) -> None:
    registry = WebSocketSessionRegistry()
    await registry.set_socket("conv-1", DummySocket())
    monkeypatch.setattr(websocket_reconnect, "_registry", registry)
    monkeypatch.setattr(websocket_reconnect.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")

    ok = await websocket_reconnect.persist_assistant_message(
        conversation_id="conv-1",
        parent_id="user-msg-1",
        text="answer",
        organization_id="org-1",
    )
    assert ok is False
    assert _FakeAsyncClient.calls == []  # dual-write guard: client owns the write


@pytest.mark.asyncio
async def test_persist_assistant_message_warns_only_on_post_failure(monkeypatch) -> None:
    monkeypatch.setattr(websocket_reconnect, "_registry", WebSocketSessionRegistry())
    _FakeAsyncClient.raise_on_post = True
    monkeypatch.setattr(websocket_reconnect.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")

    # Must not raise — the checkpoint still holds the turn.
    ok = await websocket_reconnect.persist_assistant_message(
        conversation_id="conv-1",
        parent_id="user-msg-1",
        text="answer",
        organization_id="org-1",
    )
    assert ok is False


@pytest.mark.asyncio
async def test_persist_assistant_message_non_2xx_returns_false(monkeypatch) -> None:
    monkeypatch.setattr(websocket_reconnect, "_registry", WebSocketSessionRegistry())
    _FakeAsyncClient.status_code = 403
    monkeypatch.setattr(websocket_reconnect.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")

    ok = await websocket_reconnect.persist_assistant_message(
        conversation_id="conv-1",
        parent_id="user-msg-1",
        text="answer",
        organization_id="org-1",
    )
    assert ok is False


@pytest.mark.asyncio
async def test_persist_assistant_message_skips_without_base_url(monkeypatch) -> None:
    monkeypatch.setattr(websocket_reconnect, "_registry", WebSocketSessionRegistry())
    monkeypatch.setattr(websocket_reconnect.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
    monkeypatch.delenv("FRONTEND_URL", raising=False)

    ok = await websocket_reconnect.persist_assistant_message(
        conversation_id="conv-1",
        parent_id="user-msg-1",
        text="answer",
        organization_id="org-1",
    )
    assert ok is False
    assert _FakeAsyncClient.calls == []


def test_org_id_from_scope_reads_forwarded_org_header() -> None:
    scope = {
        "headers": [
            (b"cookie", b"nat-session=abc"),
            (b"x-grid-organization-id", b"org-1"),
            (b"x-other", b"ignored"),
        ]
    }
    assert websocket_reconnect._org_id_from_scope(scope) == "org-1"


def test_org_id_from_scope_returns_none_when_absent() -> None:
    scope = {"headers": [(b"cookie", b"nat-session=abc")]}
    assert websocket_reconnect._org_id_from_scope(scope) is None


def test_internal_persist_headers_none_when_token_unset(monkeypatch) -> None:
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    assert websocket_reconnect._internal_persist_headers() is None


def test_install_reconnectable_handler(monkeypatch) -> None:
    from nat.front_ends.fastapi import fastapi_front_end_plugin_worker as worker_module

    original_handler = worker_module.WebSocketMessageHandler
    monkeypatch.setattr(websocket_reconnect, "_installed", False)
    websocket_reconnect.install_reconnectable_handler()

    assert worker_module.WebSocketMessageHandler is ReconnectableWebSocketMessageHandler
    worker_module.WebSocketMessageHandler = original_handler
    monkeypatch.setattr(websocket_reconnect, "_installed", False)


@pytest.mark.asyncio
async def test_authenticate_websocket_connection_validates_external_token() -> None:
    validator = DummyValidator(user={"type": "oidc", "sub": "user-1", "skip_clarifier": False})
    configure_websocket_auth(validators=[validator], require_auth=True, external_hostnames={"localhost"})
    socket = DummySocket(headers=[(b"host", b"localhost"), (b"cookie", b"idToken=test-token")])

    user, close_code = await authenticate_websocket_connection(socket)

    assert close_code is None
    assert user == {"type": "oidc", "sub": "user-1", "skip_clarifier": False}
    assert validator.tokens == ["test-token", "test-token"]


@pytest.mark.asyncio
async def test_authenticate_websocket_connection_rejects_missing_external_token() -> None:
    configure_websocket_auth(validators=[], require_auth=True, external_hostnames={"localhost"})
    socket = DummySocket(headers=[(b"host", b"localhost")])

    user, close_code = await authenticate_websocket_connection(socket)

    assert user is None
    assert close_code == 1008


@pytest.mark.asyncio
async def test_authenticate_websocket_connection_validates_internal_token_when_present() -> None:
    validator = DummyValidator(user={"type": "oidc", "sub": "user-1", "skip_clarifier": False})
    configure_websocket_auth(validators=[validator], require_auth=True, external_hostnames={"localhost"})
    socket = DummySocket(headers=[(b"host", b"aiq-agent"), (b"cookie", b"idToken=test-token")])

    user, close_code = await authenticate_websocket_connection(socket)

    assert close_code is None
    assert user == {"type": "oidc", "sub": "user-1", "skip_clarifier": False}


@pytest.mark.asyncio
async def test_run_closes_socket_when_websocket_auth_fails() -> None:
    configure_websocket_auth(validators=[], require_auth=True, external_hostnames={"localhost"})
    socket = DummySocket(headers=[(b"host", b"localhost")])
    handler = ReconnectableWebSocketMessageHandler(
        socket=socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )

    await handler.run()

    assert socket.closed_with == 1008


@pytest.mark.asyncio
async def test_run_workflow_binds_authenticated_user_context(monkeypatch) -> None:
    configure_websocket_auth(validators=[], require_auth=False, external_hostnames={"localhost"})
    socket = DummySocket(headers=[(b"host", b"localhost")])
    handler = ReconnectableWebSocketMessageHandler(
        socket=socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._authenticated_user = {"type": "oidc", "sub": "user-1", "skip_clarifier": False}

    seen_users: list[dict] = []

    async def fake_stream(*_args, **_kwargs):
        seen_users.append(get_current_user())
        if False:
            yield None

    monkeypatch.setattr(websocket_reconnect, "generate_streaming_response", fake_stream)

    await handler._run_workflow(payload="hello", conversation_id="conv-1")

    assert seen_users == [{"type": "oidc", "sub": "user-1", "skip_clarifier": False}]


@pytest.mark.asyncio
async def test_process_workflow_request_binds_request_trace_tags(monkeypatch) -> None:
    configure_websocket_auth(validators=[], require_auth=False, external_hostnames={"localhost"})
    socket = DummySocket(headers=[(b"host", b"localhost"), (b"cookie", b"idToken=test-token")])
    handler = ReconnectableWebSocketMessageHandler(
        socket=socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._authenticated_user = {"type": "oidc", "sub": "user-1", "skip_clarifier": False}
    user_message = WebSocketUserMessage(
        type=WebSocketMessageType.USER_MESSAGE,
        schema_type=WorkflowSchemaType.CHAT_STREAM,
        id="msg-1",
        conversation_id="conv-1",
        content=UserMessageContent(
            messages=[
                UserMessages(
                    role=UserMessageContentRoleType.USER,
                    content=[TextContent(text="hello")],
                )
            ]
        ),
    )
    seen_tags: list[dict[str, str]] = []

    async def fake_process_workflow_request(_self, _message):
        seen_tags.append(get_request_trace_tags())

    monkeypatch.setattr(
        websocket_reconnect.WebSocketMessageHandler,
        "process_workflow_request",
        fake_process_workflow_request,
    )

    await handler.process_workflow_request(user_message)

    assert seen_tags == [
        {
            "aiq.caller.type": "oidc",
            "aiq.auth.transport": "cookie",
            "aiq.auth.verified": "true",
            "aiq.access.channel": "ui",
        }
    ]


# ---------------------------------------------------------------------------
# Ingest-only context (ADR-0034 addendum): "always send, never always judge".
#
# The agent's history IS its LangGraph checkpoint, so a human turn that never
# reached the agent could never be referred back to — `@Piloti given that,
# recheck` had nothing to point at. Every human message now reaches the agent,
# tagged with whether it is addressed to it. A `context_only` frame is appended
# to the conversation's state and answered with NOTHING: no workflow, no LLM, no
# system_response, no intermediate or status frame.
# ---------------------------------------------------------------------------


def _context_only_user_message(
    text: str,
    *,
    conversation_id: str | None = "conv-1",
    context_only: bool = True,
    author_name: str | None = "Anna Weber",
) -> WebSocketUserMessage:
    """A `user_message` frame carrying the ingest-only payload the client sends."""
    payload: dict = {"query": text, "data_sources": []}
    if context_only:
        payload["context_only"] = True
    if author_name is not None:
        payload["author_name"] = author_name
    return WebSocketUserMessage(
        type=WebSocketMessageType.USER_MESSAGE,
        schema_type=WorkflowSchemaType.CHAT_STREAM,
        id="msg-ctx-1",
        conversation_id=conversation_id,
        content=UserMessageContent(
            messages=[
                UserMessages(
                    role=UserMessageContentRoleType.USER,
                    content=[TextContent(text=json.dumps(payload))],
                )
            ]
        ),
    )


def _handler_for(message: WebSocketUserMessage, monkeypatch) -> tuple[object, DummySocket, list]:
    """A handler whose single inbound frame is *message*, with the workflow stubbed."""
    socket = DummySocket(messages=[{"ok": True}])
    handler = ReconnectableWebSocketMessageHandler(
        socket=socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    processed: list = []

    async def fake_validate_message(_message):
        return message

    async def fake_process_workflow(_message):
        processed.append(_message)

    async def fake_set_socket(_conversation_id, _socket):
        return None

    monkeypatch.setattr(handler._message_validator, "validate_message", fake_validate_message)
    monkeypatch.setattr(handler, "process_workflow_request", fake_process_workflow)
    monkeypatch.setattr(websocket_reconnect._registry, "set_socket", fake_set_socket)
    return handler, socket, processed


@pytest.fixture(name="captured_context")
def fixture_captured_context():
    """Capture what the handler appends, and never leak the stub between tests."""
    appended: list[tuple[str, str]] = []

    async def appender(thread_id: str, text: str) -> None:
        appended.append((thread_id, text))

    register_context_appender(appender)
    yield appended
    register_context_appender(None)


@pytest.mark.asyncio
async def test_context_only_message_is_ingested_and_invokes_no_workflow(monkeypatch, captured_context) -> None:
    """THE POINT: it lands in the agent's history, and nothing runs or is sent."""
    message = _context_only_user_message("Ja, das Atrium ist ein eigener Abschnitt.")
    handler, socket, processed = _handler_for(message, monkeypatch)

    await handler.run()

    # Appended, attributed to its author.
    assert captured_context == [("conv-1", "Anna Weber: Ja, das Atrium ist ein eigener Abschnitt.")]
    # No LLM: `process_workflow_request` is the ONLY door to the graph and the
    # models behind it, and it was never opened.
    assert processed == []
    # Not one frame back: no system_response, no intermediate, no status, no error.
    assert socket.sent == []


@pytest.mark.asyncio
async def test_an_ordinary_message_still_runs_the_workflow(monkeypatch, captured_context) -> None:
    """A NEW backend reading no flag behaves exactly as it did before this existed."""
    message = _context_only_user_message("Wie breit muss der Fluchtweg sein?", context_only=False)
    handler, _socket, processed = _handler_for(message, monkeypatch)

    await handler.run()

    assert processed == [message]
    assert captured_context == []


@pytest.mark.asyncio
async def test_context_only_prefers_the_verified_principal_over_the_client_name(monkeypatch, captured_context) -> None:
    """A client cannot attribute its text to a colleague in the agent's history."""
    message = _context_only_user_message("Bemerkung", author_name="Matthias Bigl")
    handler, _socket, _processed = _handler_for(message, monkeypatch)
    handler._authenticated_user = {"type": "oidc", "sub": "u-anna", "name": "Anna Weber"}

    await handler.run()

    assert captured_context == [("conv-1", "Anna Weber: Bemerkung")]


@pytest.mark.asyncio
async def test_context_only_body_is_capped(monkeypatch, captured_context) -> None:
    """A pathological paste must not bloat the checkpoint every later turn reads."""
    message = _context_only_user_message("z" * 50_000, author_name=None)
    handler, _socket, processed = _handler_for(message, monkeypatch)

    await handler.run()

    assert processed == []
    assert len(captured_context) == 1
    _thread_id, stored = captured_context[0]
    assert len(stored) == MAX_CONTEXT_MESSAGE_CHARS
    assert stored == "z" * MAX_CONTEXT_MESSAGE_CHARS


@pytest.mark.asyncio
async def test_context_only_without_a_conversation_id_is_dropped_silently(monkeypatch, captured_context) -> None:
    """No thread to append to. Still never an answer, and never an error frame."""
    message = _context_only_user_message("Bemerkung", conversation_id=None)
    handler, socket, processed = _handler_for(message, monkeypatch)

    await handler.run()

    assert captured_context == []
    assert processed == []
    assert socket.sent == []


@pytest.mark.asyncio
async def test_context_only_survives_a_missing_appender(monkeypatch) -> None:
    """Ingestion is best-effort: a lost line of memory must not cost the socket."""
    register_context_appender(None)
    message = _context_only_user_message("Bemerkung")
    handler, socket, processed = _handler_for(message, monkeypatch)

    await handler.run()

    assert processed == []
    assert socket.sent == []


@pytest.mark.asyncio
async def test_context_only_is_refused_under_an_expired_handshake_token(monkeypatch, captured_context) -> None:
    """An expired token buys no write into the checkpoint either."""
    message = _context_only_user_message("Bemerkung")
    handler, socket, processed = _handler_for(message, monkeypatch)
    monkeypatch.setattr(handler, "_is_handshake_token_expired", lambda: True)

    await handler.run()

    assert captured_context == []
    assert processed == []
    # The client is told to reconnect, exactly as for an ordinary message.
    assert [frame.get("type") for frame in socket.sent] == [WebSocketMessageType.ERROR_MESSAGE.value]


def test_latest_user_text_reads_the_last_text_part() -> None:
    message = _context_only_user_message("die Bemerkung")

    raw = websocket_reconnect.latest_user_text(message)

    assert raw is not None
    assert json.loads(raw)["query"] == "die Bemerkung"


@pytest.mark.asyncio
async def test_an_unanswered_hitl_prompt_expires_instead_of_hanging(
    monkeypatch,
    dummy_socket: DummySocket,
) -> None:
    """An abandoned prompt must not pin the turn — or its checkpoint — forever.

    Before this the await had no deadline, and the only thing that ever released it
    was a NEW turn on the same conversation cancelling the stale task. A shared
    conversation makes that worse: the asker can close the tab while colleagues keep
    reading, and nothing ever starts a new turn.
    """
    handler = ReconnectableWebSocketMessageHandler(
        socket=dummy_socket,
        session_manager=DummySessionManager(),
        step_adaptor=DummyStepAdaptor(),
        worker=DummyWorker(),
    )
    handler._conversation_id = "conv-expiry"

    monkeypatch.setattr(websocket_reconnect, "HITL_RESPONSE_TIMEOUT_SECONDS", 0.01)

    sent: list[dict] = []

    async def fake_create_websocket_message(**kwargs):
        sent.append(kwargs)

    monkeypatch.setattr(handler, "create_websocket_message", fake_create_websocket_message)

    class _Prompt:
        content = DummyMessage()

    with pytest.raises(TimeoutError):
        await handler.human_interaction_callback(_Prompt())

    # The prompt WAS delivered; it simply went unanswered.
    assert sent, "the prompt should still have been sent before the wait"
    # And the registry is left clean, so the next turn is not blocked by a stale entry.
    assert (
        await websocket_reconnect._registry.resolve_pending_interaction("conv-expiry", TextContent(text="late"), None)
        is False
    )

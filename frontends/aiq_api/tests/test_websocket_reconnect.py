"""Unit tests for per-message JWT re-authentication on the reconnectable WS handler.

Covers the behavior added for sealing the "long-lived socket trusts an expired
token forever" gap:

* ``_is_handshake_token_expired`` correctly classifies tokens by ``exp``
* ``_send_auth_expired_error`` builds a structured error and writes it to the socket
* the inbound message loop short-circuits user_message / user_interaction
  when the handshake JWT has passed its ``exp`` and emits the auth_expired
  error instead of running the workflow

We construct the handler with ``__new__`` so the heavy NAT base ``__init__``
(session manager, message validator, step adaptor, worker) does not have to be
satisfied by the test environment.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from starlette.datastructures import QueryParams

from aiq_api.websocket_reconnect import ReconnectableWebSocketMessageHandler
from aiq_api.websocket_reconnect import persist_assistant_message
from nat.data_models.api_server import ChatResponseChunk
from nat.data_models.api_server import SystemResponseContent
from nat.data_models.api_server import WebSocketMessageStatus
from nat.data_models.api_server import WebSocketMessageType


def _make_handler(
    *,
    authenticated_user: dict | None,
    socket: MagicMock | None = None,
    message_validator: MagicMock | None = None,
) -> ReconnectableWebSocketMessageHandler:
    """Return a handler instance bypassing the NAT base class __init__."""
    handler = ReconnectableWebSocketMessageHandler.__new__(ReconnectableWebSocketMessageHandler)
    handler._authenticated_user = authenticated_user
    handler._socket = socket or MagicMock()
    handler._message_validator = message_validator or MagicMock()
    return handler


class TestIsHandshakeTokenExpired:
    """``_is_handshake_token_expired`` is the gate that decides re-auth on each message."""

    def test_returns_false_when_no_user(self) -> None:
        handler = _make_handler(authenticated_user=None)
        assert handler._is_handshake_token_expired() is False

    def test_returns_false_for_internal_caller_without_exp(self) -> None:
        # Internal/anonymous callers don't carry JWT claims; we must not
        # treat them as "expired" or we'd reject every internal call.
        handler = _make_handler(authenticated_user={"type": "internal"})
        assert handler._is_handshake_token_expired() is False

    def test_returns_false_when_exp_is_not_a_number(self) -> None:
        # Defensive: malformed exp (e.g. claim was a string) should NOT be
        # interpreted as "expired" -- that would fail closed in a way the
        # client cannot remediate. Treat as "no exp" instead.
        handler = _make_handler(authenticated_user={"exp": "not-a-number"})
        assert handler._is_handshake_token_expired() is False

    def test_returns_false_when_exp_is_in_the_future(self) -> None:
        future = time.time() + 600
        handler = _make_handler(authenticated_user={"exp": future, "sub": "u-1"})
        assert handler._is_handshake_token_expired() is False

    def test_returns_true_when_exp_is_in_the_past(self) -> None:
        past = time.time() - 1
        handler = _make_handler(authenticated_user={"exp": past, "sub": "u-1"})
        assert handler._is_handshake_token_expired() is True


class TestSendAuthExpiredError:
    """The error packet must reach the wire with the contract the client expects."""

    @pytest.mark.asyncio
    async def test_sends_user_auth_error_with_auth_expired_message(self) -> None:
        socket = MagicMock()
        socket.send_json = AsyncMock()

        # The validator builds the payload; we only care that we forwarded
        # an Error with the right shape into it. Echo the produced message
        # back verbatim so we can assert on it.
        message_validator = MagicMock()
        built_message = MagicMock()
        built_message.model_dump.return_value = {
            "type": "error",
            "content": {"code": "user_auth_error", "message": "auth_expired"},
        }
        message_validator.create_system_response_token_message = AsyncMock(return_value=built_message)

        handler = _make_handler(
            authenticated_user={"exp": time.time() - 1},
            socket=socket,
            message_validator=message_validator,
        )

        await handler._send_auth_expired_error("conv-1")

        # The validator must have been asked to build an ERROR_MESSAGE for
        # this conversation, with an Error carrying message="auth_expired".
        call = message_validator.create_system_response_token_message.await_args
        kwargs = call.kwargs
        assert kwargs["conversation_id"] == "conv-1"
        error = kwargs["content"]
        assert error.message == "auth_expired"
        assert error.code.value == "user_auth_error"

        # And the result must have been forwarded to the socket.
        socket.send_json.assert_awaited_once()
        sent_payload = socket.send_json.await_args.args[0]
        assert sent_payload["content"]["message"] == "auth_expired"

    @pytest.mark.asyncio
    async def test_swallows_send_failure_silently(self) -> None:
        # If the socket is already closed, we don't want a second exception
        # crashing the receive loop -- the client will reconnect on its own.
        socket = MagicMock()
        socket.send_json = AsyncMock(side_effect=RuntimeError("socket closed"))

        message_validator = MagicMock()
        message_validator.create_system_response_token_message = AsyncMock(return_value=MagicMock())

        handler = _make_handler(
            authenticated_user={"exp": time.time() - 1},
            socket=socket,
            message_validator=message_validator,
        )

        # Must not raise.
        await handler._send_auth_expired_error("conv-1")


class TestRunWorkflowErrorFrame:
    """A workflow that blows up mid-turn must still notify the client.

    Without a terminal error frame the frontend keeps ``isStreaming=true``
    forever, leaving the composer and session list permanently locked.
    """

    @pytest.mark.asyncio
    async def test_sends_workflow_error_frame_when_workflow_raises(self) -> None:
        socket = MagicMock()
        socket.scope = {"headers": []}

        handler = _make_handler(
            authenticated_user={"type": "internal"},
            socket=socket,
        )
        handler._flow_handler = None
        handler._step_adaptor = MagicMock()
        handler._pending_observability_trace = None
        handler.human_interaction_callback = MagicMock()

        # The workflow session context blows up on enter -- simulates any
        # non-auth exception raised while running the workflow.
        session_cm = MagicMock()
        session_cm.__aenter__ = AsyncMock(side_effect=RuntimeError("kaboom"))
        session_cm.__aexit__ = AsyncMock(return_value=False)
        handler._session_manager = MagicMock()
        handler._session_manager.session = MagicMock(return_value=session_cm)

        # Spy on the frame builder so we can assert on the error we emit.
        handler.create_websocket_message = AsyncMock()

        await handler._run_workflow(payload=MagicMock(), conversation_id="conv-1")

        handler.create_websocket_message.assert_awaited_once()
        kwargs = handler.create_websocket_message.await_args.kwargs
        assert kwargs["message_type"] == WebSocketMessageType.ERROR_MESSAGE
        assert kwargs["status"] == WebSocketMessageStatus.COMPLETE
        error = kwargs["data_model"]
        assert error.code.value == "workflow_error"
        # Original exception text is preserved for debugging in ``details``.
        assert "kaboom" in error.details

    @pytest.mark.asyncio
    async def test_swallows_error_frame_send_failure(self) -> None:
        # If the socket is already gone, the guarded send must not raise a
        # second exception out of the workflow runner.
        socket = MagicMock()
        socket.scope = {"headers": []}

        handler = _make_handler(
            authenticated_user={"type": "internal"},
            socket=socket,
        )
        handler._flow_handler = None
        handler._step_adaptor = MagicMock()
        handler._pending_observability_trace = None
        handler.human_interaction_callback = MagicMock()

        session_cm = MagicMock()
        session_cm.__aenter__ = AsyncMock(side_effect=RuntimeError("kaboom"))
        session_cm.__aexit__ = AsyncMock(return_value=False)
        handler._session_manager = MagicMock()
        handler._session_manager.session = MagicMock(return_value=session_cm)

        handler.create_websocket_message = AsyncMock(side_effect=RuntimeError("socket closed"))

        # Must not raise.
        await handler._run_workflow(payload=MagicMock(), conversation_id="conv-1")


def _chunk(text: str, finish_reason: str | None) -> ChatResponseChunk:
    return ChatResponseChunk.create_streaming_chunk(text, finish_reason=finish_reason)


async def _agen(items):
    for item in items:
        yield item


def _make_streaming_handler() -> ReconnectableWebSocketMessageHandler:
    """A handler wired to run _run_workflow with a succeeding session."""
    socket = MagicMock()
    socket.scope = {"headers": []}
    handler = _make_handler(authenticated_user={"type": "internal"}, socket=socket)
    handler._flow_handler = None
    handler._step_adaptor = MagicMock()
    handler._pending_observability_trace = None
    handler.human_interaction_callback = MagicMock()
    handler._conversation_id = "conv-1"
    handler._message_parent_id = "user-1"
    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(return_value=MagicMock())
    session_cm.__aexit__ = AsyncMock(return_value=False)
    handler._session_manager = MagicMock()
    handler._session_manager.session = MagicMock(return_value=session_cm)
    handler.create_websocket_message = AsyncMock()
    return handler


class TestRunWorkflowStreaming:
    """The streaming loop: deltas are IN_PROGRESS + non-persist-eligible; the
    terminal chunk is the COMPLETE finalizing frame. A single terminal chunk
    (streaming disabled) reproduces the pre-streaming frame pattern exactly."""

    @pytest.mark.asyncio
    async def test_deltas_then_terminal_complete(self) -> None:
        handler = _make_streaming_handler()
        chunks = [_chunk("Hello ", None), _chunk("world!", None), _chunk("Hello world!", "stop")]
        with patch("aiq_api.websocket_reconnect.generate_streaming_response", return_value=_agen(chunks)):
            await handler._run_workflow(payload=MagicMock(), conversation_id="conv-1")

        calls = handler.create_websocket_message.await_args_list
        # 2 delta frames + 1 terminal COMPLETE, and NO extra synthetic frame.
        assert len(calls) == 3
        for call in calls[:2]:
            assert call.kwargs["status"] == WebSocketMessageStatus.IN_PROGRESS
            assert call.kwargs["persist_on_drop"] is False  # never persist a partial
        terminal = calls[2]
        assert terminal.kwargs["status"] == WebSocketMessageStatus.COMPLETE
        assert terminal.kwargs["message_type"] == WebSocketMessageType.RESPONSE_MESSAGE
        # The terminal carries the FULL text (for persistence + card attachment).
        assert terminal.kwargs["data_model"].choices[0].delta.content == "Hello world!"

    @pytest.mark.asyncio
    async def test_single_terminal_chunk_preserves_legacy_pattern(self) -> None:
        handler = _make_streaming_handler()
        chunks = [_chunk("Full answer.", "stop")]
        with patch("aiq_api.websocket_reconnect.generate_streaming_response", return_value=_agen(chunks)):
            await handler._run_workflow(payload=MagicMock(), conversation_id="conv-1")

        calls = handler.create_websocket_message.await_args_list
        # Exactly the pre-streaming pattern: one IN_PROGRESS content frame, then
        # a synthetic empty COMPLETE frame.
        assert len(calls) == 2
        assert calls[0].kwargs["status"] == WebSocketMessageStatus.IN_PROGRESS
        assert calls[0].kwargs["data_model"].choices[0].delta.content == "Full answer."
        assert calls[1].kwargs["status"] == WebSocketMessageStatus.COMPLETE
        assert calls[1].kwargs["message_type"] == WebSocketMessageType.RESPONSE_MESSAGE
        assert isinstance(calls[1].kwargs["data_model"], SystemResponseContent)

    @pytest.mark.asyncio
    async def test_empty_stream_still_closes_turn(self) -> None:
        handler = _make_streaming_handler()
        with patch("aiq_api.websocket_reconnect.generate_streaming_response", return_value=_agen([])):
            await handler._run_workflow(payload=MagicMock(), conversation_id="conv-1")

        calls = handler.create_websocket_message.await_args_list
        assert len(calls) == 1
        assert calls[0].kwargs["status"] == WebSocketMessageStatus.COMPLETE
        assert isinstance(calls[0].kwargs["data_model"], SystemResponseContent)


class TestPersistOnDropGating:
    """A dropped delta (persist_on_drop=False) must NOT persist a partial; a
    dropped terminal must."""

    def _handler_with_validator(self) -> ReconnectableWebSocketMessageHandler:
        handler = _make_handler(authenticated_user={"type": "internal"}, socket=MagicMock())
        handler._conversation_id = "conv-1"
        handler._message_parent_id = "user-1"
        validator = handler._message_validator
        validator.resolve_message_type_by_data = AsyncMock(return_value=WebSocketMessageType.RESPONSE_MESSAGE)
        validator.get_message_schema_by_type = AsyncMock(
            return_value=__import__(
                "nat.data_models.api_server", fromlist=["WebSocketSystemResponseTokenMessage"]
            ).WebSocketSystemResponseTokenMessage
        )
        validator.convert_data_to_message_content = AsyncMock(return_value=MagicMock())
        validator.create_system_response_token_message = AsyncMock(return_value=MagicMock())
        handler._persist_terminal_message_if_client_gone = AsyncMock()
        return handler

    @pytest.mark.asyncio
    async def test_delta_drop_does_not_persist(self) -> None:
        handler = self._handler_with_validator()
        with patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.send = AsyncMock(return_value=False)  # client gone
            await handler.create_websocket_message(
                data_model=_chunk("partial", None),
                status=WebSocketMessageStatus.IN_PROGRESS,
                persist_on_drop=False,
            )
        handler._persist_terminal_message_if_client_gone.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_terminal_drop_persists(self) -> None:
        handler = self._handler_with_validator()
        with patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.send = AsyncMock(return_value=False)  # client gone
            await handler.create_websocket_message(
                data_model=_chunk("full answer", "stop"),
                message_type=WebSocketMessageType.RESPONSE_MESSAGE,
                status=WebSocketMessageStatus.COMPLETE,
            )
        handler._persist_terminal_message_if_client_gone.assert_awaited_once()


class TestTransparencyExtrasLift:
    """WP-A transparency extras are lifted onto the terminal RESPONSE_MESSAGE the
    same way as cards/sources/answer_confidence — each only when present."""

    def _handler(self, built_message: SimpleNamespace) -> ReconnectableWebSocketMessageHandler:
        from nat.data_models.api_server import WebSocketSystemResponseTokenMessage

        handler = _make_handler(authenticated_user={"type": "internal"}, socket=MagicMock())
        handler._conversation_id = "conv-1"
        handler._message_parent_id = "user-1"
        validator = handler._message_validator
        validator.resolve_message_type_by_data = AsyncMock(return_value=WebSocketMessageType.RESPONSE_MESSAGE)
        validator.get_message_schema_by_type = AsyncMock(return_value=WebSocketSystemResponseTokenMessage)
        validator.convert_data_to_message_content = AsyncMock(return_value=MagicMock())
        validator.create_system_response_token_message = AsyncMock(return_value=built_message)
        return handler

    @pytest.mark.asyncio
    async def test_present_extras_are_attached(self) -> None:
        built = SimpleNamespace()
        handler = self._handler(built)
        chunk = _chunk("full answer", "stop")
        chunk.routing_decision = "deep"
        chunk.routing_reason = "needs multi-source synthesis"
        chunk.escalation_reason = "Die erste Antwort war unzureichend."
        chunk.answer_confidence_capped_reason = "ungrounded"
        chunk.citations_removed = {"count": 1, "reasons": ["dead link"]}
        with patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.send = AsyncMock(return_value=True)  # client present, no persist
            await handler.create_websocket_message(
                data_model=chunk,
                message_type=WebSocketMessageType.RESPONSE_MESSAGE,
                status=WebSocketMessageStatus.COMPLETE,
            )
        assert built.routing_decision == "deep"
        assert built.routing_reason == "needs multi-source synthesis"
        assert built.escalation_reason == "Die erste Antwort war unzureichend."
        assert built.answer_confidence_capped_reason == "ungrounded"
        assert built.citations_removed == {"count": 1, "reasons": ["dead link"]}

    @pytest.mark.asyncio
    async def test_absent_extras_are_not_attached(self) -> None:
        built = SimpleNamespace()
        handler = self._handler(built)
        chunk = _chunk("full answer", "stop")  # no extras set
        with patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.send = AsyncMock(return_value=True)
            await handler.create_websocket_message(
                data_model=chunk,
                message_type=WebSocketMessageType.RESPONSE_MESSAGE,
                status=WebSocketMessageStatus.COMPLETE,
            )
        for field in (
            "routing_decision",
            "routing_reason",
            "escalation_reason",
            "answer_confidence_capped_reason",
            "citations_removed",
            "job_admission_rejected",
            "retry_after_seconds",
        ):
            assert not hasattr(built, field)

    @pytest.mark.asyncio
    async def test_job_admission_rejection_lifts_both_fields(self) -> None:
        built = SimpleNamespace()
        handler = self._handler(built)
        chunk = _chunk("The research queue is full. Please retry shortly.", "stop")
        chunk.job_admission_rejected = True
        chunk.retry_after_seconds = 42
        with patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.send = AsyncMock(return_value=True)
            await handler.create_websocket_message(
                data_model=chunk,
                message_type=WebSocketMessageType.RESPONSE_MESSAGE,
                status=WebSocketMessageStatus.COMPLETE,
            )
        assert built.job_admission_rejected is True
        assert built.retry_after_seconds == 42


class TestPersistTerminalMessageIfClientGone:
    """The client-gone persist path writes a finished answer to the BFF so it
    survives a reload — but a job-admission rejection is a transient queue notice
    that must NOT enter history (there is no reader for the marker on rehydrate,
    and it is stale by reload)."""

    def _handler(self) -> ReconnectableWebSocketMessageHandler:
        socket = MagicMock()
        socket.scope = {"headers": []}
        handler = _make_handler(authenticated_user={"type": "internal"}, socket=socket)
        handler._conversation_id = "conv-1"
        handler._message_parent_id = "user-1"
        return handler

    def _message(self, dump: dict) -> MagicMock:
        message = MagicMock()
        message.model_dump.return_value = dump
        return message

    @pytest.mark.asyncio
    async def test_rejection_turn_is_not_persisted(self) -> None:
        handler = self._handler()
        message = self._message(
            {
                "content": {"text": "The research queue is full. Please retry shortly."},
                "job_admission_rejected": True,
                "retry_after_seconds": 42,
            }
        )
        with patch("aiq_api.websocket_reconnect.persist_assistant_message") as persist:
            persist.return_value = True
            await handler._persist_terminal_message_if_client_gone(
                message, WebSocketMessageType.RESPONSE_MESSAGE
            )
        persist.assert_not_called()

    @pytest.mark.asyncio
    async def test_normal_turn_is_persisted(self) -> None:
        handler = self._handler()
        message = self._message({"content": {"text": "Here is your answer."}})
        with patch("aiq_api.websocket_reconnect.persist_assistant_message") as persist:
            persist.return_value = True
            await handler._persist_terminal_message_if_client_gone(
                message, WebSocketMessageType.RESPONSE_MESSAGE
            )
        persist.assert_awaited_once()
        assert persist.await_args.kwargs["text"] == "Here is your answer."


class _FakeRestoreSocket:
    """Minimal socket mirroring starlette's `query_params` caching so the
    override's snake_case injection (`self._socket._query_params = ...`) is
    honored on subsequent reads, exactly as on a real WebSocket."""

    def __init__(self, query_string: str) -> None:
        self.scope: dict = {"headers": []}
        self._qs = query_string

    @property
    def query_params(self) -> QueryParams:
        if not hasattr(self, "_query_params"):
            self._query_params = QueryParams(self._qs)
        return self._query_params


class TestRestoreExecutionStateReattach:
    """FIX 1 — the override must reattach a live turn to a reconnected socket
    even when the client sent only the camelCase `conversationId`, AND wire the
    reconnected socket into Grid's registry (NAT's base restore only swaps the
    disconnected handler's `_socket` attribute)."""

    def _handler(self, query_string: str) -> ReconnectableWebSocketMessageHandler:
        handler = _make_handler(
            authenticated_user={"type": "internal"},
            socket=_FakeRestoreSocket(query_string),
        )
        return handler

    def _disconnected_handler(self) -> MagicMock:
        disconnected = MagicMock()
        disconnected._conversation_id = "conv-1"
        disconnected._user_interaction = None  # no pending HITL prompt to re-send
        disconnected._message_parent_id = "user-1"
        disconnected._workflow_schema_type = "chat_stream"
        disconnected._running_workflow_task = MagicMock()
        return disconnected

    @pytest.mark.asyncio
    async def test_camelcase_only_param_reattaches_and_registers(self) -> None:
        handler = self._handler("conversationId=conv-1")
        disconnected = self._disconnected_handler()
        handler._worker = MagicMock()
        handler._worker.get_conversation_handler = MagicMock(return_value=disconnected)

        with patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.set_socket = AsyncMock()
            await handler._restore_execution_state()

        # NAT's base restore ran: it swapped the disconnected handler's socket
        # to the reconnected one and copied its conversation id across.
        assert disconnected._socket is handler._socket
        assert handler._conversation_id == "conv-1"
        # And the override wired the reconnected socket into Grid's registry so
        # the dual-write guard / live send / HITL routing target it.
        reg.set_socket.assert_awaited_once_with("conv-1", handler._socket)

    @pytest.mark.asyncio
    async def test_snake_case_param_reattaches_and_registers(self) -> None:
        handler = self._handler("conversation_id=conv-1")
        disconnected = self._disconnected_handler()
        handler._worker = MagicMock()
        handler._worker.get_conversation_handler = MagicMock(return_value=disconnected)

        with patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.set_socket = AsyncMock()
            await handler._restore_execution_state()

        assert disconnected._socket is handler._socket
        reg.set_socket.assert_awaited_once_with("conv-1", handler._socket)

    @pytest.mark.asyncio
    async def test_no_running_handler_does_not_register(self) -> None:
        # A plain reconnect with no in-flight turn must NOT register a socket
        # (there is nothing to reattach; the next user_message registers it).
        handler = self._handler("conversationId=conv-1")
        handler._worker = MagicMock()
        handler._worker.get_conversation_handler = MagicMock(return_value=None)

        with patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.set_socket = AsyncMock()
            await handler._restore_execution_state()

        reg.set_socket.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_missing_conversation_id_is_a_noop(self) -> None:
        handler = self._handler("")
        handler._worker = MagicMock()
        handler._worker.get_conversation_handler = MagicMock(return_value=None)

        with patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.set_socket = AsyncMock()
            await handler._restore_execution_state()

        handler._worker.get_conversation_handler.assert_not_called()
        reg.set_socket.assert_not_awaited()


class _CapturingClient:
    """Async-context httpx.AsyncClient stand-in capturing the POST it receives."""

    captured: dict = {}
    status_code = 201

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self) -> _CapturingClient:
        return self

    async def __aexit__(self, *args) -> bool:
        return False

    async def post(self, url, json, headers):  # noqa: A002 - httpx kw name
        _CapturingClient.captured = {"url": url, "json": json, "headers": headers}
        return SimpleNamespace(status_code=type(self).status_code)


class TestPersistAssistantMessageInternalRoute:
    """FIX 4 — persistence targets the INTERNAL token-guarded route with the
    service-token header (not replayed handshake cookies, which expire)."""

    @pytest.mark.asyncio
    async def test_posts_to_internal_route_with_service_token(self, monkeypatch) -> None:
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")
        _CapturingClient.captured = {}
        _CapturingClient.status_code = 201

        with patch("aiq_api.websocket_reconnect.httpx.AsyncClient", _CapturingClient), \
                patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.has_socket = AsyncMock(return_value=False)
            ok = await persist_assistant_message(
                conversation_id="conv-1",
                parent_id="user-1",
                text="Here is your answer.",
                organization_id="org-1",
            )

        assert ok is True
        captured = _CapturingClient.captured
        assert captured["url"] == "http://frontend:3000/api/internal/conversations/conv-1/messages"
        assert captured["headers"]["X-Grid-Internal-Token"] == "secret-token"
        # Org scoping + assistant role travel in the body; NO cookie/authorization.
        assert captured["json"]["organizationId"] == "org-1"
        assert captured["json"]["role"] == "assistant"
        assert captured["json"]["content"] == "Here is your answer."
        assert "cookie" not in {k.lower() for k in captured["headers"]}

    @pytest.mark.asyncio
    async def test_skips_when_service_token_unconfigured(self, monkeypatch) -> None:
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)

        with patch("aiq_api.websocket_reconnect.httpx.AsyncClient", _CapturingClient), \
                patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.has_socket = AsyncMock(return_value=False)
            ok = await persist_assistant_message(
                conversation_id="conv-1", parent_id="user-1", text="x", organization_id="org-1"
            )

        assert ok is False

    @pytest.mark.asyncio
    async def test_skips_when_org_id_unavailable(self, monkeypatch) -> None:
        # Without the org id the internal route would 404; skip the doomed POST.
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")

        with patch("aiq_api.websocket_reconnect.httpx.AsyncClient", _CapturingClient), \
                patch("aiq_api.websocket_reconnect._registry") as reg:
            reg.has_socket = AsyncMock(return_value=False)
            ok = await persist_assistant_message(
                conversation_id="conv-1", parent_id="user-1", text="x", organization_id=None
            )

        assert ok is False

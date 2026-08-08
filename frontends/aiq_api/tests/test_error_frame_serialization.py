"""The workflow ERROR frame must actually serialize and reach the client.

Regression for issue #295, which is the second half of #294: a workflow fails
(a provider 400), the handler builds an ``Error`` frame to unlock the client --
and that frame itself fails validation, so nothing is sent and the frontend's
``isStreaming`` never clears. The user sees a composer locked forever on a turn
that already ended.

Why the existing tests were green through all of it: they assert against a
``MagicMock`` message validator, or mock ``create_websocket_message`` outright,
so they verify that we *called* the sender and never that the frame we built is
a frame the wire schema accepts. These tests drive the real
``MessageValidator``, which is the only thing that could have caught it.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

from aiq_api.websocket_reconnect import ReconnectableWebSocketMessageHandler
from nat.data_models.api_server import Error
from nat.data_models.api_server import ErrorTypes
from nat.data_models.api_server import SystemResponseContent
from nat.data_models.api_server import WebSocketMessageStatus
from nat.data_models.api_server import WebSocketMessageType
from nat.front_ends.fastapi.message_validator import MessageValidator


def _handler() -> ReconnectableWebSocketMessageHandler:
    """A handler wired with the REAL message validator, bypassing NAT's __init__."""
    handler = ReconnectableWebSocketMessageHandler.__new__(ReconnectableWebSocketMessageHandler)
    handler._message_validator = MessageValidator()
    handler._message_parent_id = "parent"
    handler._conversation_id = "conv-1"
    handler._socket = MagicMock()
    return handler


@pytest.mark.asyncio
async def test_workflow_error_frame_is_sent_and_typed_as_an_error() -> None:
    """The frame the client keys on to release its streaming lock."""
    error = Error(
        code=ErrorTypes.WORKFLOW_ERROR,
        message="The assistant hit an unexpected error while handling your request.",
        details="Error code: 400 - Requests ending with a model turn are not supported.",
    )

    with patch("aiq_api.websocket_reconnect._registry") as registry:
        registry.send = AsyncMock(return_value=True)
        await _handler().create_websocket_message(
            data_model=error,
            message_type=WebSocketMessageType.ERROR_MESSAGE,
            status=WebSocketMessageStatus.COMPLETE,
        )

    registry.send.assert_awaited_once()
    sent = registry.send.await_args.args[1]
    assert sent is not None, "the error frame was dropped -- the client would hang forever"
    assert sent.type == WebSocketMessageType.ERROR_MESSAGE
    assert sent.content.code == ErrorTypes.WORKFLOW_ERROR
    assert sent.status == WebSocketMessageStatus.COMPLETE


@pytest.mark.asyncio
async def test_normal_response_frames_still_serialize() -> None:
    """The discriminator fix must not disturb the ordinary answer path."""
    with patch("aiq_api.websocket_reconnect._registry") as registry:
        registry.send = AsyncMock(return_value=True)
        await _handler().create_websocket_message(
            data_model=SystemResponseContent(text="hello"),
            message_type=WebSocketMessageType.RESPONSE_MESSAGE,
            status=WebSocketMessageStatus.COMPLETE,
        )

    sent = registry.send.await_args.args[1]
    assert sent.type == WebSocketMessageType.RESPONSE_MESSAGE
    assert sent.content.text == "hello"


@pytest.mark.asyncio
async def test_an_unbuildable_frame_degrades_to_an_error_frame_rather_than_silence() -> None:
    """A builder that returns None must never mean "send nothing".

    Silence is the one outcome the client cannot recover from, so any future
    content/type mismatch has to surface as a deliverable ERROR frame instead of
    a dropped message.
    """
    handler = _handler()
    handler._message_validator.create_system_response_token_message = AsyncMock(return_value=None)

    with patch("aiq_api.websocket_reconnect._registry") as registry:
        registry.send = AsyncMock(return_value=True)
        await handler.create_websocket_message(
            data_model=SystemResponseContent(text="hello"),
            message_type=WebSocketMessageType.RESPONSE_MESSAGE,
            status=WebSocketMessageStatus.COMPLETE,
        )

    # The fallback path rebuilds through the same (mocked) builder, so what
    # matters here is that the failure was raised and handled rather than
    # silently swallowed on the way to ``finally``.
    assert handler._message_validator.create_system_response_token_message.await_count == 2
    fallback_kwargs = handler._message_validator.create_system_response_token_message.await_args.kwargs
    assert fallback_kwargs["message_type"] == WebSocketMessageType.ERROR_MESSAGE
    assert isinstance(fallback_kwargs["content"], Error)


@pytest.mark.asyncio
async def test_run_workflow_error_frame_survives_real_serialization(monkeypatch) -> None:
    """End-to-end: a failing workflow produces a frame that actually goes out.

    This is the #294 + #295 pair in one test -- the workflow raises the way a
    provider 400 raises, and the client must still be told the turn is over.
    """

    async def _explode(*args, **kwargs):
        if False:  # pragma: no cover - keeps this an async generator
            yield None
        raise RuntimeError("Error code: 400 - Requests ending with a model turn are not supported.")

    monkeypatch.setattr("aiq_api.websocket_reconnect.generate_streaming_response", _explode)

    class _SessionContext:
        async def __aenter__(self):
            return SimpleNamespace()

        async def __aexit__(self, *exc):
            return False

    handler = _handler()
    handler._flow_handler = None
    handler._session_manager = SimpleNamespace(session=lambda **kw: _SessionContext())
    handler._authenticated_user = None
    handler.human_interaction_callback = AsyncMock()
    handler._step_adaptor = None
    handler._pending_observability_trace = None

    with patch("aiq_api.websocket_reconnect._registry") as registry:
        registry.send = AsyncMock(return_value=True)
        await handler._run_workflow(payload={"query": "hello"})

    sent = [call.args[1] for call in registry.send.await_args_list]
    assert any(frame.type == WebSocketMessageType.ERROR_MESSAGE for frame in sent), (
        "workflow failed but no ERROR frame reached the client"
    )


@pytest.mark.asyncio
async def test_the_workflow_stream_is_closed_in_the_task_that_opened_it(monkeypatch) -> None:
    """Regression for issues #334, #337 and #338.

    A `async for` that exits early leaves its generator suspended; the event
    loop finalizes it later from a different task, so NAT's contextvar resets
    fail with "was created in a different Context" and its producer task is left
    holding an unretrieved `QueueClosed`. Driving the stream through
    `contextlib.aclosing` runs that teardown here instead, in the context that
    created the tokens.

    The assertion is on WHERE the close happened, not merely that it happened:
    finalization always happens eventually, and "eventually, elsewhere" is
    precisely the bug.
    """
    closed_in: dict[str, object] = {}

    async def _stream(*args, **kwargs):
        try:
            while True:
                yield SystemResponseContent(text="delta")
        except GeneratorExit:
            closed_in["task"] = asyncio.current_task()
            raise

    monkeypatch.setattr("aiq_api.websocket_reconnect.generate_streaming_response", _stream)

    class _SessionContext:
        async def __aenter__(self):
            return SimpleNamespace()

        async def __aexit__(self, *exc):
            return False

    handler = _handler()
    handler._flow_handler = None
    handler._session_manager = SimpleNamespace(session=lambda **kw: _SessionContext())
    handler._authenticated_user = None
    handler.human_interaction_callback = AsyncMock()
    handler._step_adaptor = None
    handler._pending_observability_trace = None
    # The first send fails, which is how a dropped client actually surfaces:
    # the loop leaves through an exception rather than by exhausting the stream.
    handler.create_websocket_message = AsyncMock(side_effect=RuntimeError("client gone"))

    running = asyncio.current_task()
    with patch("aiq_api.websocket_reconnect._registry") as registry:
        registry.send = AsyncMock(return_value=True)
        await handler._run_workflow(payload={"query": "hello"})

    assert closed_in.get("task") is running, (
        "the workflow stream was not closed inside the task that opened it -- "
        "its contextvar teardown will run in a foreign context"
    )

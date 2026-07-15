"""Reconnectable WebSocket handler for HITL interactions."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any

import httpx
from fastapi import WebSocket
from pydantic import BaseModel
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from aiq_api.auth.errors import AuthError
from aiq_api.auth.middleware import build_request_trace_tags
from aiq_api.auth.middleware import detect_internal_caller
from aiq_api.auth.middleware import resolve_request_user
from aiq_api.auth.middleware import user_context
from aiq_api.auth.request_trace import request_trace_tag_context
from nat.data_models.api_server import Error
from nat.data_models.api_server import ErrorTypes
from nat.data_models.api_server import ResponseObservabilityTrace
from nat.data_models.api_server import SystemResponseContent
from nat.data_models.api_server import TextContent
from nat.data_models.api_server import WebSocketMessageStatus
from nat.data_models.api_server import WebSocketMessageType
from nat.data_models.api_server import WebSocketObservabilityTraceMessage
from nat.data_models.api_server import WebSocketSystemInteractionMessage
from nat.data_models.api_server import WebSocketSystemIntermediateStepMessage
from nat.data_models.api_server import WebSocketSystemResponseTokenMessage
from nat.data_models.api_server import WebSocketUserInteractionResponseMessage
from nat.data_models.api_server import WebSocketUserMessage
from nat.data_models.interactive import HumanPromptNotification
from nat.data_models.interactive import HumanResponse
from nat.data_models.interactive import HumanResponseNotification
from nat.data_models.interactive import InteractionPrompt
from nat.front_ends.fastapi.auth_flow_handlers.websocket_flow_handler import WebSocketAuthenticationFlowHandler
from nat.front_ends.fastapi.message_handler import WebSocketMessageHandler
from nat.front_ends.fastapi.response_helpers import generate_streaming_response

logger = logging.getLogger(__name__)

_auth_validators: list = []
_require_auth = False
_external_hostnames: set[str] | None = None
WS_POLICY_VIOLATION = 1008
SESSION_COOKIE_NAME = "nat-session"


def configure_websocket_auth(
    *,
    validators: list | None = None,
    require_auth: bool = False,
    external_hostnames: set[str] | None = None,
) -> None:
    """Configure WebSocket auth to mirror the HTTP middleware validator chain."""
    global _auth_validators, _require_auth, _external_hostnames
    _auth_validators = list(validators or [])
    _require_auth = require_auth
    _external_hostnames = external_hostnames


async def authenticate_websocket_connection(socket: WebSocket) -> tuple[dict[str, Any] | None, int | None]:
    """Resolve the caller identity for a WebSocket handshake."""
    headers = dict(socket.scope.get("headers", []))
    user, error_status, is_external, _ = await resolve_request_user(
        headers,
        validators=_auth_validators,
        require_auth=_require_auth,
        external_hostnames=_external_hostnames,
    )
    if user is not None:
        return user, None

    if not is_external:
        return detect_internal_caller(headers), None

    if error_status == 401:
        return None, WS_POLICY_VIOLATION

    return None, WS_POLICY_VIOLATION


class WebSocketSessionRegistry:
    """Keep track of active sockets, pending HITL responses, and running workflow tasks."""

    def __init__(self) -> None:
        self._sockets: dict[str, WebSocket] = {}
        self._pending_interactions: dict[str, asyncio.Future[TextContent]] = {}
        self._workflow_tasks: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    async def set_socket(self, conversation_id: str | None, socket: WebSocket) -> None:
        """Register the latest socket for a conversation."""
        if not conversation_id:
            return
        async with self._lock:
            self._sockets[conversation_id] = socket

    async def clear_socket(self, conversation_id: str | None, socket: WebSocket) -> None:
        """Clear the socket only if it matches the current one."""
        if not conversation_id:
            return
        async with self._lock:
            current = self._sockets.get(conversation_id)
            if current is socket:
                self._sockets.pop(conversation_id, None)

    async def has_socket(self, conversation_id: str | None) -> bool:
        """Return True if a live socket is currently registered for a conversation.

        Used as the dual-write guard before server-side persistence: if a client
        has (re)connected we must not also POST the message, or the turn would be
        written twice.
        """
        if not conversation_id:
            return False
        async with self._lock:
            return self._sockets.get(conversation_id) is not None

    async def send(self, conversation_id: str | None, message: BaseModel) -> bool:
        """Send a message to the current socket for a conversation."""
        if not conversation_id:
            return False
        async with self._lock:
            socket = self._sockets.get(conversation_id)
        if not socket:
            return False
        try:
            await socket.send_json(message.model_dump())
            return True
        except Exception as exc:  # pragma: no cover
            logger.warning("Failed to send websocket message after reconnect: %s", exc)
            return False

    async def register_pending_interaction(
        self,
        conversation_id: str | None,
        future: asyncio.Future[TextContent],
    ) -> None:
        """Store the pending HITL future for a conversation."""
        if not conversation_id:
            return
        async with self._lock:
            self._pending_interactions[conversation_id] = future

    async def resolve_pending_interaction(
        self,
        conversation_id: str | None,
        user_content: TextContent,
    ) -> bool:
        """Resolve a pending HITL future if it exists."""
        if not conversation_id:
            return False
        async with self._lock:
            future = self._pending_interactions.get(conversation_id)
            if future is None or future.done():
                return False
            future.set_result(user_content)
            self._pending_interactions.pop(conversation_id, None)
            return True

    async def clear_pending_interaction(self, conversation_id: str | None) -> None:
        """Clear pending interaction state once resolved."""
        if not conversation_id:
            return
        async with self._lock:
            self._pending_interactions.pop(conversation_id, None)

    async def set_workflow_task(self, conversation_id: str | None, task: asyncio.Task) -> None:
        """Register the running workflow task, cancelling any stale one first."""
        if not conversation_id:
            return
        async with self._lock:
            old_task = self._workflow_tasks.get(conversation_id)
            if old_task is not None and not old_task.done():
                old_task.cancel()
                logger.info("Cancelled stale workflow task for conversation %s", conversation_id)
            self._workflow_tasks[conversation_id] = task

    async def cancel_workflow_task(self, conversation_id: str | None) -> None:
        """Cancel and remove the workflow task for a conversation."""
        if not conversation_id:
            return
        async with self._lock:
            task = self._workflow_tasks.pop(conversation_id, None)
            if task is not None and not task.done():
                task.cancel()
                logger.info("Cancelled workflow task for conversation %s", conversation_id)


_registry = WebSocketSessionRegistry()
_installed = False

# httpx timeout for the fail-soft server-side persistence POST.
_PERSIST_TIMEOUT_SECONDS = 10.0


def _internal_base_url() -> str | None:
    """Resolve the BFF base URL for internal server-to-server calls."""
    return os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL")


def deterministic_assistant_message_id(conversation_id: str, parent_id: str | None) -> str:
    """Stable id for a turn's assistant message, keyed on (conversation, turn).

    ``parent_id`` is the id of the user message that opened the turn
    (``_message_parent_id``). Deriving the id deterministically means an
    accidental double POST collides on the messages route's primary key
    (``onConflictDoNothing`` on ``messages.id``) and no-ops, and the id is
    distinct per turn (each user message has its own id).
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"grid:assistant:{conversation_id}:{parent_id or 'default'}"))


def _auth_headers_from_scope(scope: dict[str, Any]) -> dict[str, str]:
    """Replay the browser session credentials the WS handshake forwarded.

    ``server.js`` forwards the browser ``Cookie`` header (which carries the
    WorkOS AuthKit session cookie) and an ``Authorization: Bearer`` header on the
    WebSocket upgrade. The conversations-messages route authenticates the same
    way the client writer does (``withAuth()`` reads the session cookie), so we
    replay those headers verbatim to persist as the same user.
    """
    headers: dict[str, str] = {}
    for raw_name, raw_value in scope.get("headers", []) or []:
        name = raw_name.decode() if isinstance(raw_name, bytes) else str(raw_name)
        if name.lower() not in ("cookie", "authorization"):
            continue
        value = raw_value.decode() if isinstance(raw_value, bytes) else str(raw_value)
        headers[name.lower()] = value
    return headers


async def persist_assistant_message(
    *,
    conversation_id: str,
    parent_id: str | None,
    text: str,
    auth_headers: dict[str, str],
    cards: Any = None,
    deep_research_job_id: Any = None,
    answer_confidence: Any = None,
) -> bool:
    """Persist a finished assistant turn to the BFF when the client is gone.

    Fail-soft: never raises and returns ``False`` on any problem. The langgraph
    checkpoint already holds the completed turn, so a failed POST only means the
    client must wait for a future rehydrate; it is never fatal to the handler.

    Returns ``True`` only when the message was accepted by the BFF.
    """
    base_url = _internal_base_url()
    if not base_url:
        logger.warning(
            "Cannot persist assistant message for %s: FRONTEND_INTERNAL_URL/FRONTEND_URL not configured",
            conversation_id,
        )
        return False

    # Dual-write guard: a client may have (re)connected between the failed send
    # and now. If a live socket exists, the client owns the write — skip.
    if await _registry.has_socket(conversation_id):
        logger.debug(
            "Live socket present for conversation %s; skipping server-side persist",
            conversation_id,
        )
        return False

    metadata: dict[str, Any] = {}
    if cards:
        metadata["cards"] = cards
    if deep_research_job_id:
        metadata["deep_research_job_id"] = deep_research_job_id
    if answer_confidence:
        metadata["answer_confidence"] = answer_confidence

    payload = {
        "id": deterministic_assistant_message_id(conversation_id, parent_id),
        "role": "assistant",
        "content": text,
        "messageType": "agent_response",
        "metadata": metadata,
    }
    url = f"{base_url.rstrip('/')}/api/conversations/{conversation_id}/messages"

    try:
        async with httpx.AsyncClient(timeout=_PERSIST_TIMEOUT_SECONDS) as client:
            response = await client.post(url, json=payload, headers=auth_headers)
        if response.status_code not in (200, 201):
            logger.warning(
                "Server-side persist for conversation %s returned HTTP %s",
                conversation_id,
                response.status_code,
            )
            return False
        logger.info("Persisted assistant message server-side for disconnected conversation %s", conversation_id)
        return True
    except Exception:  # noqa: BLE001 — fail-soft; checkpoint still holds the turn
        logger.warning(
            "Failed to persist assistant message server-side for conversation %s",
            conversation_id,
            exc_info=True,
        )
        return False


class ReconnectableWebSocketMessageHandler(WebSocketMessageHandler):
    """WebSocket handler that supports HITL reconnects per conversation."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._user_interaction_response: asyncio.Future[TextContent] | None = None
        self._authenticated_user: dict[str, Any] | None = None

    def _is_handshake_token_expired(self) -> bool:
        """Return True if the JWT used at handshake has since passed its ``exp``.

        Backend stores verified JWT claims in ``_authenticated_user`` after the
        handshake (see ``JWTValidator.validate``). The ``exp`` claim is seconds
        since epoch. We re-check it on every inbound message so a long-lived
        socket cannot keep accepting work indefinitely under a dead token --
        WebSocket browsers do NOT replay HTTP cookies on subsequent frames, so
        the only way to refresh credentials is to close + reopen the socket.

        Internal/anonymous callers do not carry an ``exp`` claim; for them
        this returns ``False`` (no re-auth required).
        """
        user = self._authenticated_user
        if not user:
            return False
        exp = user.get("exp")
        if not isinstance(exp, (int, float)):
            return False
        return time.time() >= exp

    async def _send_auth_expired_error(self, conversation_id: str | None) -> None:
        """Notify the client that its handshake token has expired.

        The client (frontend) listens for ``message == "auth_expired"`` on the
        ERROR channel and reacts by refreshing the WorkOS AuthKit session,
        closing the socket, and reconnecting. The fresh handshake carries an
        updated access token. After the new socket is open, the client drains
        any buffered outgoing message it had queued during the rotation.
        """
        error = Error(
            code=ErrorTypes.USER_AUTH_ERROR,
            message="auth_expired",
            details="Handshake token has expired; reconnect to refresh credentials.",
        )
        try:
            error_message = await self._message_validator.create_system_response_token_message(
                message_type=WebSocketMessageType.ERROR_MESSAGE,
                conversation_id=conversation_id,
                content=error,
            )
        except Exception:  # pragma: no cover - validator never fails on this contract
            logger.exception("Failed to build auth_expired error message")
            return

        try:
            await self._socket.send_json(error_message.model_dump())
        except Exception as exc:  # pragma: no cover - socket may already be closed
            logger.warning("Failed to send auth_expired: %s", exc)

    async def run(self) -> None:
        """Process websocket messages and allow reconnect HITL responses."""
        if self._authenticated_user is None:
            self._authenticated_user, close_code = await authenticate_websocket_connection(self._socket)
            if close_code is not None:
                await self._socket.close(code=close_code)
                return

        while True:
            try:
                message: dict[str, Any] = await self._socket.receive_json()
                validated_message: BaseModel = await self._message_validator.validate_message(message)

                if isinstance(validated_message, WebSocketUserMessage):
                    # Per-message re-auth: the handshake-time JWT may have
                    # expired since the socket was opened. Reject the work
                    # and ask the client to reconnect with a fresh token.
                    if self._is_handshake_token_expired():
                        logger.info(
                            "Rejecting user_message: handshake token expired (conversation %s)",
                            validated_message.conversation_id,
                        )
                        await self._send_auth_expired_error(validated_message.conversation_id)
                        continue

                    await self.process_workflow_request(validated_message)
                    await _registry.set_socket(validated_message.conversation_id, self._socket)

                elif isinstance(
                    validated_message,
                    WebSocketSystemResponseTokenMessage
                    | WebSocketSystemIntermediateStepMessage
                    | WebSocketSystemInteractionMessage,
                ):
                    pass

                elif isinstance(validated_message, WebSocketUserInteractionResponseMessage):
                    # Same re-auth gate for HITL interaction responses --
                    # otherwise an idle clarification prompt could be
                    # answered hours later under an expired token.
                    if self._is_handshake_token_expired():
                        logger.info(
                            "Rejecting user_interaction: handshake token expired (conversation %s)",
                            validated_message.conversation_id,
                        )
                        await self._send_auth_expired_error(validated_message.conversation_id)
                        continue

                    user_content = await self._process_websocket_user_interaction_response_message(validated_message)
                    await _registry.set_socket(validated_message.conversation_id, self._socket)
                    if self._user_interaction_response is not None:
                        # Guard against a double-submitted answer (client retry
                        # or double-click): a second set_result would raise
                        # InvalidStateError and tear down the whole handler.
                        if not self._user_interaction_response.done():
                            self._user_interaction_response.set_result(user_content)
                        else:
                            logger.warning(
                                "Duplicate HITL response ignored for conversation %s",
                                validated_message.conversation_id,
                            )
                    else:
                        resolved = await _registry.resolve_pending_interaction(
                            validated_message.conversation_id, user_content
                        )
                        if not resolved:
                            logger.warning(
                                "No pending HITL interaction to resume for conversation %s",
                                validated_message.conversation_id,
                            )
            except (asyncio.CancelledError, WebSocketDisconnect):
                # Client disconnect (navigate-away, tab close, dropped socket)
                # must NOT cancel the in-flight workflow. The turn finishes on
                # the backend, the langgraph checkpoint captures it, and the
                # terminal response is persisted server-side (see
                # ``create_websocket_message``) so the finished message is there
                # when the client returns. We only release this socket; a
                # superseding NEW user message on the same conversation still
                # cancels the now-stale turn via ``set_workflow_task``.
                await _registry.clear_socket(self._conversation_id, self._socket)
                break
            except ValidationError as exc:
                logger.warning("Invalid websocket message payload: %s", str(exc))
            except ValueError as exc:
                # receive_json raises json.JSONDecodeError (a ValueError) on a
                # non-JSON text frame; one malformed frame must not tear down
                # the socket handler and orphan the running workflow.
                logger.warning("Malformed websocket frame ignored: %s", str(exc))

    async def process_workflow_request(self, user_message_as_validated_type: WebSocketUserMessage) -> None:
        """Process user messages and register sockets for reconnect."""
        await _registry.set_socket(user_message_as_validated_type.conversation_id, self._socket)
        headers = dict(self._socket.scope.get("headers", []))
        current_user = self._authenticated_user or detect_internal_caller(headers)
        request_trace_tags = build_request_trace_tags(
            headers,
            self._socket.scope,
            current_user,
            external_hostnames=_external_hostnames,
        )
        with user_context(current_user), request_trace_tag_context(request_trace_tags):
            await super().process_workflow_request(user_message_as_validated_type)
        # NAT's message_handler assigns the task and adds its done-callback as
        # two separate statements, so ``_running_workflow_task`` holds a live
        # Task reference here. We register it ONLY so a superseding NEW user
        # message on this conversation can cancel the now-stale turn
        # (``set_workflow_task`` cancels any prior task). A client DISCONNECT
        # deliberately does NOT cancel it — the turn finishes and is persisted
        # server-side.
        task = self._running_workflow_task
        if task is not None and not task.done():
            await _registry.set_workflow_task(user_message_as_validated_type.conversation_id, task)

    async def create_websocket_message(
        self,
        data_model: BaseModel,
        message_type: str | None = None,
        status: WebSocketMessageStatus = WebSocketMessageStatus.IN_PROGRESS,
    ) -> None:
        """Create a websocket message and send via the registry."""
        message: BaseModel | None = None
        try:
            if message_type is None:
                message_type = await self._message_validator.resolve_message_type_by_data(data_model)

            message_schema: type[BaseModel] = await self._message_validator.get_message_schema_by_type(message_type)

            if hasattr(data_model, "id"):
                message_id: str = str(getattr(data_model, "id"))
            else:
                message_id = str(uuid.uuid4())

            content: BaseModel = await self._message_validator.convert_data_to_message_content(data_model)

            # Pull any generated Grid cards from the response payload so they can be
            # attached to the final WebSocket response message.
            cards = getattr(data_model, "cards", None)
            if cards is None and isinstance(data_model, BaseModel):
                cards = data_model.model_extra.get("cards") if data_model.model_extra else None

            # Pull the structured deep-research job id (if this turn dispatched an
            # async job) so the frontend can open the research panel from a real
            # field instead of regex-parsing the response prose.
            deep_research_job_id = getattr(data_model, "deep_research_job_id", None)
            if deep_research_job_id is None and isinstance(data_model, BaseModel):
                deep_research_job_id = (
                    data_model.model_extra.get("deep_research_job_id") if data_model.model_extra else None
                )

            # Pull the model's guarded self-assessed answer confidence (present
            # only on grounded shallow answers that emitted the marker) so the
            # frontend can render the honest self-assessment chip.
            answer_confidence = getattr(data_model, "answer_confidence", None)
            if answer_confidence is None and isinstance(data_model, BaseModel):
                answer_confidence = data_model.model_extra.get("answer_confidence") if data_model.model_extra else None

            if issubclass(message_schema, WebSocketSystemResponseTokenMessage):
                message = await self._message_validator.create_system_response_token_message(
                    message_id=message_id,
                    parent_id=self._message_parent_id,
                    conversation_id=self._conversation_id,
                    content=content,
                    status=status,
                )
                # Attach any generated Grid cards to the final response message.
                if message_type == WebSocketMessageType.RESPONSE_MESSAGE and cards:
                    try:
                        message.cards = cards
                    except Exception:
                        logger.warning("Could not attach cards to websocket message", exc_info=True)
                # Attach the structured deep-research job id to the final message.
                if message_type == WebSocketMessageType.RESPONSE_MESSAGE and deep_research_job_id:
                    try:
                        message.deep_research_job_id = deep_research_job_id
                    except Exception:
                        logger.warning("Could not attach deep_research_job_id to websocket message", exc_info=True)
                # Attach the guarded self-assessed answer confidence, if present.
                if message_type == WebSocketMessageType.RESPONSE_MESSAGE and answer_confidence:
                    try:
                        message.answer_confidence = answer_confidence
                    except Exception:
                        logger.warning("Could not attach answer_confidence to websocket message", exc_info=True)

            elif issubclass(message_schema, WebSocketSystemIntermediateStepMessage):
                message = await self._message_validator.create_system_intermediate_step_message(
                    message_id=message_id,
                    parent_id=await self._message_validator.get_intermediate_step_parent_id(data_model),
                    conversation_id=self._conversation_id,
                    content=content,
                    status=status,
                )

            elif issubclass(message_schema, WebSocketSystemInteractionMessage):
                message = await self._message_validator.create_system_interaction_message(
                    message_id=message_id,
                    parent_id=self._message_parent_id,
                    conversation_id=self._conversation_id,
                    content=content,
                    status=status,
                )

            elif issubclass(message_schema, WebSocketObservabilityTraceMessage):
                message = await self._message_validator.create_observability_trace_message(
                    message_id=message_id,
                    parent_id=self._message_parent_id,
                    conversation_id=self._conversation_id,
                    content=content,
                )

            elif isinstance(content, Error):
                raise ValueError(f"Invalid input data creating websocket message. {data_model.model_dump_json()}")

            elif issubclass(message_schema, Error):
                raise TypeError(f"Invalid message type: {message_type}")

            elif message is None:
                raise ValueError(
                    f"Message type could not be resolved by input data model: {data_model.model_dump_json()}"
                )

        except (ValidationError, ValueError, TypeError) as exc:
            logger.exception("A data validation error occurred creating websocket message: %s", str(exc))
            message = await self._message_validator.create_system_response_token_message(
                message_type=WebSocketMessageType.ERROR_MESSAGE,
                conversation_id=self._conversation_id,
                content=Error(code=ErrorTypes.UNKNOWN_ERROR, message="default", details=str(exc)),
            )

        finally:
            if message is not None:
                sent = await _registry.send(self._conversation_id, message)
                if not sent:
                    if not self._conversation_id:
                        try:
                            await self._socket.send_json(message.model_dump())
                        except Exception as exc:  # pragma: no cover - socket may be closed
                            logger.warning("Failed to send websocket message: %s", exc)
                    else:
                        # The client is gone. For a terminal RESPONSE_MESSAGE
                        # carrying the finished answer (text and/or cards),
                        # persist it server-side so it is there when the client
                        # returns; otherwise it would only live in the langgraph
                        # checkpoint and the frontend would show "interrupted".
                        await self._persist_terminal_message_if_client_gone(message, message_type)
                        logger.debug(
                            "Dropping message for disconnected conversation %s",
                            self._conversation_id,
                        )

    async def _persist_terminal_message_if_client_gone(
        self,
        message: BaseModel,
        message_type: str | None,
    ) -> None:
        """Persist a dropped terminal assistant response to the BFF.

        Only fires for a RESPONSE_MESSAGE that actually carries the finished
        answer (non-empty text and/or cards). The empty COMPLETE frame that
        merely signals turn completion is skipped so no blank bubble is written.
        Fail-soft: never raises.
        """
        try:
            if message_type != WebSocketMessageType.RESPONSE_MESSAGE:
                return
            if not self._conversation_id:
                return

            dump = message.model_dump()
            content_obj = dump.get("content")
            text = content_obj.get("text") if isinstance(content_obj, dict) else None
            cards = dump.get("cards")
            deep_research_job_id = dump.get("deep_research_job_id")
            answer_confidence = dump.get("answer_confidence")

            if not (text and text.strip()) and not cards:
                return

            await persist_assistant_message(
                conversation_id=self._conversation_id,
                parent_id=self._message_parent_id,
                text=text or "",
                auth_headers=_auth_headers_from_scope(getattr(self._socket, "scope", {}) or {}),
                cards=cards,
                deep_research_job_id=deep_research_job_id,
                answer_confidence=answer_confidence,
            )
        except Exception:  # noqa: BLE001 — never let persistence crash the handler
            logger.warning("Unexpected error while persisting terminal message", exc_info=True)

    async def human_interaction_callback(self, prompt: InteractionPrompt) -> HumanResponse:
        """
        Handle HITL prompts and register response futures for reconnect.
        """
        human_response_future: asyncio.Future[TextContent] = asyncio.get_running_loop().create_future()
        self._user_interaction_response = human_response_future
        await _registry.register_pending_interaction(self._conversation_id, human_response_future)

        try:
            await self.create_websocket_message(
                data_model=prompt.content,
                message_type=WebSocketMessageType.SYSTEM_INTERACTION_MESSAGE,
                status=WebSocketMessageStatus.IN_PROGRESS,
            )

            if isinstance(prompt.content, HumanPromptNotification):
                return HumanResponseNotification()

            text_content: TextContent = await human_response_future
            interaction_response: HumanResponse = await self._message_validator.convert_text_content_to_human_response(
                text_content, prompt.content
            )
            return interaction_response
        finally:
            await _registry.clear_pending_interaction(self._conversation_id)
            self._user_interaction_response = None

    async def _run_workflow(
        self,
        payload: Any,
        user_message_id: str | None = None,
        conversation_id: str | None = None,
        result_type: type | None = None,
        output_type: type | None = None,
    ) -> None:
        """Run the workflow without breaking reconnect message delivery."""
        socket_scope = getattr(getattr(self, "_socket", None), "scope", {})
        current_user = self._authenticated_user or detect_internal_caller(dict(socket_scope.get("headers", [])))
        with user_context(current_user):
            try:
                auth_callback = self._flow_handler.authenticate if self._flow_handler else None
                async with self._session_manager.session(
                    user_message_id=user_message_id,
                    conversation_id=conversation_id,
                    http_connection=self._socket,
                    user_input_callback=self.human_interaction_callback,
                    user_authentication_callback=auth_callback,
                ) as session:
                    async for value in generate_streaming_response(
                        payload,
                        session=session,
                        streaming=True,
                        step_adaptor=self._step_adaptor,
                        result_type=result_type,
                        output_type=output_type,
                    ):
                        if isinstance(value, ResponseObservabilityTrace):
                            if self._pending_observability_trace is None:
                                self._pending_observability_trace = value
                        else:
                            await self.create_websocket_message(
                                data_model=value,
                                status=WebSocketMessageStatus.IN_PROGRESS,
                            )

                await self.create_websocket_message(
                    data_model=SystemResponseContent(),
                    message_type=WebSocketMessageType.RESPONSE_MESSAGE,
                    status=WebSocketMessageStatus.COMPLETE,
                )

                if self._pending_observability_trace:
                    await self.create_websocket_message(
                        data_model=self._pending_observability_trace,
                        message_type=WebSocketMessageType.OBSERVABILITY_TRACE_MESSAGE,
                    )
                    self._pending_observability_trace = None
            except Exception as exc:
                # Build a structured ERROR frame for BOTH auth and non-auth
                # failures. Previously a non-auth exception was logged and
                # swallowed with a bare ``return`` -- no frame ever reached the
                # client, so the frontend kept ``isStreaming=true`` forever and
                # the composer + session list stayed permanently locked. Always
                # emitting a terminal error frame lets the client release the
                # streaming lock (see ``onError`` in use-websocket-chat.ts).
                if isinstance(exc, AuthError):
                    logger.warning("Auth error during workflow: %s", exc)
                    error = Error(
                        code=ErrorTypes.UNKNOWN_ERROR,
                        message=exc.error_code,
                        details=str(exc),
                    )
                else:
                    logger.exception("Error running workflow")
                    # ``code`` is the stable, machine-routable identity the
                    # frontend keys on (-> ERROR_REGISTRY['agent.workflow_error']);
                    # ``message`` is user-facing body copy, ``details`` keeps the
                    # raw exception text for debugging.
                    error = Error(
                        code=ErrorTypes.WORKFLOW_ERROR,
                        message="The assistant hit an unexpected error while handling your request. Please try again.",
                        details=str(exc),
                    )

                # Guard the send itself: the socket may already be gone (the
                # very failure we're reporting can be a dropped connection).
                try:
                    await self.create_websocket_message(
                        data_model=error,
                        message_type=WebSocketMessageType.ERROR_MESSAGE,
                        status=WebSocketMessageStatus.COMPLETE,
                    )
                except Exception:  # pragma: no cover - socket may already be closed
                    logger.warning("Failed to send workflow error frame", exc_info=True)


def install_reconnectable_handler() -> None:  # TODO: upstream to NAT
    """Monkeypatch NAT to use reconnectable websocket handler."""
    global _installed
    if _installed:
        return
    from nat.front_ends.fastapi import fastapi_front_end_plugin_worker as worker_module
    from nat.front_ends.fastapi.routes import websocket as websocket_routes

    worker_module.WebSocketMessageHandler = ReconnectableWebSocketMessageHandler
    websocket_routes.WebSocketMessageHandler = ReconnectableWebSocketMessageHandler

    def patched_websocket_endpoint(*, worker: Any, session_manager: Any):
        """Build websocket endpoint handler with reconnect support and verified auth."""

        async def _websocket_endpoint(websocket: WebSocket):
            session_id = websocket.query_params.get("session")
            if session_id and not websocket_routes._SAFE_SESSION_ID_RE.match(session_id):
                logger.warning("WebSocket: Rejected session ID with unsafe characters")
                await websocket.close(code=WS_POLICY_VIOLATION, reason="Invalid session ID")
                return

            if session_id:
                headers = list(websocket.scope.get("headers", []))
                cookie_header = f"{SESSION_COOKIE_NAME}={session_id}"

                cookie_exists = False
                existing_session_cookie = False

                for i, (name, value) in enumerate(headers):
                    if name != b"cookie":
                        continue

                    cookie_exists = True
                    cookie_str = value.decode()

                    if f"{SESSION_COOKIE_NAME}=" in cookie_str:
                        existing_session_cookie = True
                        logger.info("WebSocket: Session cookie already present in headers (same-origin)")
                    else:
                        headers[i] = (name, f"{cookie_str}; {cookie_header}".encode())
                        logger.info(
                            "WebSocket: Added session cookie to existing cookie header: %s",
                            session_id[:10] + "...",
                        )
                    break

                if not cookie_exists and not existing_session_cookie:
                    headers.append((b"cookie", cookie_header.encode()))
                    logger.info("WebSocket: Added new session cookie header: %s", session_id[:10] + "...")

                websocket.scope["headers"] = headers

            user, close_code = await authenticate_websocket_connection(websocket)
            if close_code is not None:
                await websocket.close(code=close_code)
                return

            async with ReconnectableWebSocketMessageHandler(
                websocket,
                session_manager,
                worker.get_step_adaptor(),
                worker,
            ) as handler:
                handler._authenticated_user = user
                flow_handler = WebSocketAuthenticationFlowHandler(worker._add_flow, worker._remove_flow, handler)
                handler.set_flow_handler(flow_handler)
                with user_context(user or detect_internal_caller(dict(websocket.scope.get("headers", [])))):
                    await handler.run()

        return _websocket_endpoint

    websocket_routes.websocket_endpoint = patched_websocket_endpoint
    _installed = True

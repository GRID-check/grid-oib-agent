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
from starlette.datastructures import QueryParams
from starlette.websockets import WebSocketDisconnect

from aiq_api.auth.errors import AuthError
from aiq_api.auth.middleware import build_request_trace_tags
from aiq_api.auth.middleware import detect_internal_caller
from aiq_api.auth.middleware import resolve_request_user
from aiq_api.auth.middleware import user_context
from aiq_api.auth.request_trace import request_trace_tag_context
from aiq_api.conversation_bus import get_bus
from aiq_api.conversation_bus import is_multi_replica_bus
from nat.data_models.api_server import ChatResponseChunk
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
        # Multi-replica bus (ADR-0028): background subscribers that relay bus
        # frames onto a locally-held socket, and that resolve a locally-held HITL
        # future from a bus answer. Empty / unused unless is_multi_replica_bus().
        self._relay_tasks: dict[str, asyncio.Task] = {}
        self._input_tasks: dict[str, asyncio.Task] = {}

    async def set_socket(self, conversation_id: str | None, socket: WebSocket) -> None:
        """Register the latest socket for a conversation."""
        if not conversation_id:
            return
        async with self._lock:
            self._sockets[conversation_id] = socket
        # In multi-replica mode this socket may be served by a replica that is
        # NOT running the turn; subscribe to the conversation's event channel and
        # relay published frames onto it. No-op single-replica.
        if is_multi_replica_bus():
            await self._start_relay(conversation_id, socket)

    async def clear_socket(self, conversation_id: str | None, socket: WebSocket) -> None:
        """Clear the socket only if it matches the current one."""
        if not conversation_id:
            return
        async with self._lock:
            current = self._sockets.get(conversation_id)
            if current is socket:
                self._sockets.pop(conversation_id, None)
                self._cancel_task(self._relay_tasks, conversation_id)

    @staticmethod
    def _cancel_task(registry: dict[str, asyncio.Task], conversation_id: str) -> None:
        task = registry.pop(conversation_id, None)
        if task is not None and not task.done():
            task.cancel()

    async def _start_relay(self, conversation_id: str, socket: WebSocket) -> None:
        """Relay bus frames for this conversation onto the locally-held socket."""
        self._cancel_task(self._relay_tasks, conversation_id)

        async def _loop() -> None:
            try:
                async for env in get_bus().subscribe_frames(conversation_id):
                    try:
                        await socket.send_json(env.payload)
                    except Exception:
                        logger.debug("Relay socket write failed for %s; stopping relay", conversation_id)
                        return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("Relay loop error for conversation %s", conversation_id, exc_info=True)

        self._relay_tasks[conversation_id] = asyncio.create_task(_loop())

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
        """Send a message to the current socket for a conversation.

        In multi-replica mode the frame is ALSO published to the conversation's
        bus channel so a relay on another replica can display it (the owner
        running the turn may not hold the socket). The local write remains as the
        co-located fast path; the relay subscriber filters frames it published
        itself, so a co-located owner==relay never double-writes.
        """
        if not conversation_id:
            return False
        if is_multi_replica_bus():
            try:
                await get_bus().publish_frame(conversation_id, message.model_dump())
            except Exception:
                logger.warning("Bus publish failed for conversation %s", conversation_id, exc_info=True)
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

    async def submit_hitl_answer(self, conversation_id: str | None, user_content: TextContent) -> bool:
        """Deliver a HITL answer to the awaiting turn.

        Resolves a locally-held future first (co-located owner==relay). If none is
        local and the bus spans replicas, publish the answer so the owning replica
        (subscribed via ``_start_owner_input``) resolves its future.
        """
        if not conversation_id:
            return False
        if await self.resolve_pending_interaction(conversation_id, user_content):
            return True
        if is_multi_replica_bus():
            try:
                await get_bus().publish_answer(conversation_id, user_content.model_dump())
                return True
            except Exception:
                logger.warning("Bus answer publish failed for %s", conversation_id, exc_info=True)
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
        # Owner side: while awaiting the answer, subscribe to the input channel so
        # an answer published by a relay on another replica resolves this future.
        if is_multi_replica_bus():
            self._start_owner_input(conversation_id)

    def _start_owner_input(self, conversation_id: str) -> None:
        self._cancel_task(self._input_tasks, conversation_id)

        async def _loop() -> None:
            from aiq_api.conversation_bus import HITL_ANSWER

            try:
                async for env in get_bus().subscribe_input(conversation_id):
                    if env.type != HITL_ANSWER:
                        continue
                    try:
                        content = TextContent.model_validate(env.payload)
                    except Exception:
                        logger.warning("Malformed bus HITL answer for %s", conversation_id, exc_info=True)
                        continue
                    if await self.resolve_pending_interaction(conversation_id, content):
                        return  # answer delivered; stop listening
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("Owner input loop error for %s", conversation_id, exc_info=True)

        self._input_tasks[conversation_id] = asyncio.create_task(_loop())

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
            self._cancel_task(self._input_tasks, conversation_id)
            return True

    async def clear_pending_interaction(self, conversation_id: str | None) -> None:
        """Clear pending interaction state once resolved."""
        if not conversation_id:
            return
        async with self._lock:
            self._pending_interactions.pop(conversation_id, None)
            self._cancel_task(self._input_tasks, conversation_id)

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


def _chunk_finish_reason(value: Any) -> str | None:
    """The finish_reason of a ChatResponseChunk, or None for anything else.

    ``"stop"`` marks the terminal chunk of a streamed answer (and the only chunk
    when streaming is disabled). Deltas carry ``None``. Any non-chunk value also
    yields ``None`` so callers treat it as "not a terminal answer frame".
    """
    if not isinstance(value, ChatResponseChunk):
        return None
    try:
        return value.choices[0].finish_reason
    except (AttributeError, IndexError):
        return None


# Transparency extras (WP-A) lifted onto the terminal response the same way as
# answer_confidence / deep_research_job_id. Each is surfaced only when present.
_TRANSPARENCY_EXTRA_FIELDS = (
    "routing_decision",
    "routing_reason",
    "escalation_reason",
    "answer_confidence_capped_reason",
    "answer_confidence_reason",
    "citations_removed",
    "job_admission_rejected",
    "retry_after_seconds",
)


def _pull_response_extra(data_model: Any, name: str) -> Any:
    """Read an extra field off the workflow response (attr or pydantic model_extra)."""
    value = getattr(data_model, name, None)
    if value is None and isinstance(data_model, BaseModel):
        value = data_model.model_extra.get(name) if data_model.model_extra else None
    return value


def deterministic_assistant_message_id(conversation_id: str, parent_id: str | None) -> str:
    """Stable id for a turn's assistant message, keyed on (conversation, turn).

    ``parent_id`` is the id of the user message that opened the turn
    (``_message_parent_id``). Deriving the id deterministically means an
    accidental double POST collides on the messages route's primary key
    (``onConflictDoNothing`` on ``messages.id``) and no-ops, and the id is
    distinct per turn (each user message has its own id).
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"grid:assistant:{conversation_id}:{parent_id or 'default'}"))


INTERNAL_TOKEN_HEADER = "X-Grid-Internal-Token"
_ORG_ID_HEADER = "x-grid-organization-id"


def _org_id_from_scope(scope: dict[str, Any]) -> str | None:
    """Read the conversation's owning org id off the WS upgrade scope.

    ``server.js`` forwards the resolved ``x-grid-organization-id`` header on the
    WebSocket upgrade. The internal persist route scopes the conversation lookup
    by this org, so a fail-soft persist for a conversation whose org we cannot
    determine simply no-ops (returns 404) rather than writing cross-tenant.
    """
    for raw_name, raw_value in scope.get("headers", []) or []:
        name = raw_name.decode() if isinstance(raw_name, bytes) else str(raw_name)
        if name.lower() != _ORG_ID_HEADER:
            continue
        return raw_value.decode() if isinstance(raw_value, bytes) else str(raw_value)
    return None


def _internal_persist_headers() -> dict[str, str] | None:
    """Service-token headers for the internal persist POST, or None if unset.

    Mirrors the ``remember`` tool's internal-endpoint pattern
    (``project_memory.py``): authenticate the backend→BFF call with the shared
    ``GRID_INTERNAL_API_TOKEN`` rather than replaying the browser's handshake
    cookie, which expires on long deep-research turns and would silently 401.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        return None
    return {"Content-Type": "application/json", INTERNAL_TOKEN_HEADER: token}


async def persist_assistant_message(
    *,
    conversation_id: str,
    parent_id: str | None,
    text: str,
    organization_id: str | None,
    cards: Any = None,
    deep_research_job_id: Any = None,
    answer_confidence: Any = None,
    answer_confidence_reason: Any = None,
    answer_confidence_capped_reason: Any = None,
    sources: Any = None,
) -> bool:
    """Persist a finished assistant turn to the BFF when the client is gone.

    Posts to the INTERNAL token-guarded route
    (``/api/internal/conversations/{id}/messages``) authenticated with
    ``GRID_INTERNAL_API_TOKEN`` — NOT the browser's handshake cookie. A long
    deep-research turn can outlive the browser access token that was replayed at
    handshake time, so the old cookie-replay POST silently 401'd and the answer
    vanished; the service token does not expire mid-turn.

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

    headers = _internal_persist_headers()
    if headers is None:
        logger.warning(
            "Cannot persist assistant message for %s: GRID_INTERNAL_API_TOKEN not configured",
            conversation_id,
        )
        return False

    if not organization_id:
        # The internal route scopes the conversation lookup by org; without it
        # the write would 404. Skip rather than issue a doomed POST.
        logger.warning(
            "Cannot persist assistant message for %s: organization id unavailable on the handshake scope",
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
    if answer_confidence_reason:
        metadata["answer_confidence_reason"] = answer_confidence_reason
    if answer_confidence_capped_reason:
        metadata["answer_confidence_capped_reason"] = answer_confidence_capped_reason
    if sources:
        metadata["sources"] = sources

    payload = {
        "organizationId": organization_id,
        "id": deterministic_assistant_message_id(conversation_id, parent_id),
        "role": "assistant",
        "content": text,
        "messageType": "agent_response",
        "metadata": metadata,
    }
    url = f"{base_url.rstrip('/')}/api/internal/conversations/{conversation_id}/messages"

    try:
        async with httpx.AsyncClient(timeout=_PERSIST_TIMEOUT_SECONDS) as client:
            response = await client.post(url, json=payload, headers=headers)
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

    async def _restore_execution_state(self) -> None:
        """Reattach a reconnected socket to a still-running handler.

        Extends NAT's base restore (``__aenter__`` calls it on every new socket)
        with two defect fixes:

        * NAT reads ONLY the snake_case ``conversation_id`` query param, but the
          frontend scopes on camelCase ``conversationId``. If only the camelCase
          key arrives the base lookup silently no-ops and the live turn never
          reattaches. Tolerate both keys here.
        * NAT's base restore swaps the disconnected handler's ``_socket`` attr
          but never touches Grid's ``WebSocketSessionRegistry``. The socket was
          cleared from the registry on disconnect, so without re-registering it
          the ``has_socket`` dual-write guard still reads "client gone" and the
          running workflow's terminal frame is persisted server-side instead of
          streamed live down the reconnected socket (and HITL prompts/live
          sends would not route). Re-register so live delivery, the dual-write
          guard, and HITL routing all target the new connection.
        """
        params = self._socket.query_params
        conversation_id = params.get("conversation_id") or params.get("conversationId")

        # NAT's base restore reads only `conversation_id`. When the client sent
        # only the camelCase key, make the resolved id visible to it without
        # mutating the wire scope (starlette caches parsed params on `_query_params`).
        if conversation_id and not params.get("conversation_id"):
            self._socket._query_params = QueryParams({**dict(params), "conversation_id": conversation_id})

        await super()._restore_execution_state()

        # Only when a disconnected handler was actually restored: wire the new
        # socket into the registry so live send + the dual-write guard + HITL
        # routing target this reconnected connection.
        if conversation_id and self._worker.get_conversation_handler(conversation_id):
            await _registry.set_socket(conversation_id, self._socket)

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
                        # No local future on THIS handler. Resolve a locally-held
                        # registry future, or (multi-replica) publish the answer so
                        # the owning replica resolves it over the bus.
                        resolved = await _registry.submit_hitl_answer(validated_message.conversation_id, user_content)
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
        persist_on_drop: bool = True,
    ) -> None:
        """Create a websocket message and send via the registry.

        ``persist_on_drop`` gates the client-gone persistence path. Streamed
        answer *deltas* pass ``False`` so a mid-stream disconnect never persists
        a partial answer (persistence keys on a per-turn id with
        onConflictDoNothing, so the first persisted frame would win and drop the
        finished answer + cards). Only the terminal frame persists.
        """
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

            sources = getattr(data_model, "sources", None)
            if sources is None and isinstance(data_model, BaseModel):
                sources = data_model.model_extra.get("sources") if data_model.model_extra else None

            # Pull the transparency extras (WP-A) the same way (attr or pydantic
            # model_extra). Each rides the terminal-chunk extras lift set by the
            # chat_researcher register and is surfaced only when present, never
            # null-spammed. See docs/architecture/backend-deep-dive.md.
            transparency_extras = {
                name: value
                for name in _TRANSPARENCY_EXTRA_FIELDS
                if (value := _pull_response_extra(data_model, name)) is not None
            }

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
                if message_type == WebSocketMessageType.RESPONSE_MESSAGE and sources:
                    try:
                        message.sources = sources
                    except Exception:
                        logger.warning("Could not attach sources to websocket message", exc_info=True)
                # Attach the transparency extras (WP-A) to the final message, each
                # only when applicable — same lift as cards/sources/confidence.
                if message_type == WebSocketMessageType.RESPONSE_MESSAGE and transparency_extras:
                    for _name, _value in transparency_extras.items():
                        try:
                            setattr(message, _name, _value)
                        except Exception:
                            logger.warning("Could not attach %s to websocket message", _name, exc_info=True)

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
                    elif persist_on_drop:
                        # The client is gone. For a terminal RESPONSE_MESSAGE
                        # carrying the finished answer (text and/or cards),
                        # persist it server-side so it is there when the client
                        # returns; otherwise it would only live in the langgraph
                        # checkpoint and the frontend would show "interrupted".
                        # Streamed deltas pass persist_on_drop=False and are
                        # skipped here — only the terminal frame persists.
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

            # A job-admission rejection ("queue full") is a TRANSIENT notice, not
            # a research answer. It is surfaced live as a warning banner with no
            # reader for the marker on rehydrate, so persisting it would resurrect
            # it as a fake answer in history. It is also stale by the time the
            # client reloads. Never persist it — drop it entirely.
            if dump.get("job_admission_rejected"):
                return

            content_obj = dump.get("content")
            text = content_obj.get("text") if isinstance(content_obj, dict) else None
            cards = dump.get("cards")
            deep_research_job_id = dump.get("deep_research_job_id")
            answer_confidence = dump.get("answer_confidence")
            answer_confidence_reason = dump.get("answer_confidence_reason")
            answer_confidence_capped_reason = dump.get("answer_confidence_capped_reason")
            sources = dump.get("sources")

            if not (text and text.strip()) and not cards:
                return

            await persist_assistant_message(
                conversation_id=self._conversation_id,
                parent_id=self._message_parent_id,
                text=text or "",
                organization_id=_org_id_from_scope(getattr(self._socket, "scope", {}) or {}),
                cards=cards,
                deep_research_job_id=deep_research_job_id,
                answer_confidence=answer_confidence,
                answer_confidence_reason=answer_confidence_reason,
                answer_confidence_capped_reason=answer_confidence_capped_reason,
                sources=sources,
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
                    # Streaming answer delivery. The workflow may yield the answer
                    # as many ChatResponseChunks: incremental deltas
                    # (finish_reason=None) followed by a terminal chunk
                    # (finish_reason="stop") carrying the full text + cards/sources.
                    # We forward deltas as IN_PROGRESS frames the client
                    # accumulates, and the terminal as the COMPLETE frame that
                    # finalizes + persists. When the workflow yields only a single
                    # terminal chunk (streaming disabled), the pre-streaming
                    # pattern — one IN_PROGRESS content frame + a synthetic empty
                    # COMPLETE — is preserved exactly.
                    saw_content_delta = False
                    saw_terminal = False
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
                            continue

                        finish_reason = _chunk_finish_reason(value)
                        if finish_reason == "stop":
                            saw_terminal = True
                            if saw_content_delta:
                                # Streaming mode: the terminal is the finalizing
                                # frame (full text + cards/sources), sent COMPLETE.
                                await self.create_websocket_message(
                                    data_model=value,
                                    message_type=WebSocketMessageType.RESPONSE_MESSAGE,
                                    status=WebSocketMessageStatus.COMPLETE,
                                )
                            else:
                                # Single-response mode (streaming disabled):
                                # reproduce the pre-streaming frame pattern exactly.
                                await self.create_websocket_message(
                                    data_model=value,
                                    status=WebSocketMessageStatus.IN_PROGRESS,
                                )
                                await self.create_websocket_message(
                                    data_model=SystemResponseContent(),
                                    message_type=WebSocketMessageType.RESPONSE_MESSAGE,
                                    status=WebSocketMessageStatus.COMPLETE,
                                )
                        elif isinstance(value, ChatResponseChunk):
                            # A streamed answer delta — accumulate on the client,
                            # never persist a partial on disconnect.
                            saw_content_delta = True
                            await self.create_websocket_message(
                                data_model=value,
                                status=WebSocketMessageStatus.IN_PROGRESS,
                                persist_on_drop=False,
                            )
                        else:
                            # Non-chunk streamed value — preserve prior behavior.
                            await self.create_websocket_message(
                                data_model=value,
                                status=WebSocketMessageStatus.IN_PROGRESS,
                            )

                # If the workflow never produced a terminal chunk (empty stream or
                # an error surfaced elsewhere), still close the turn with the
                # synthetic COMPLETE so the client releases the streaming lock.
                if not saw_terminal:
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

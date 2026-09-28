"""The chat socket: chat wire v2 over one WebSocket per conversation (ADR-0068).

The design is ``docs/design/chat-wire-v2.md`` §c/§d, the contract
``aiq_agent.common.wire_v2``, and the protocol page
``docs/api/websocket-protocol.md``.

NAT's WebSocket route is off (``websocket_path: null``, ``plugin.AIQAPIConfig``)
and this module is mounted at ``/websocket`` instead. It runs the workflow
through NAT's public session API (``SessionManager.session`` →
``Session.run`` → ``Runner.result_stream``, via ``workflow_stream``) and
consumes what the turn's ``_run`` yields: wire bodies. Every body is stamped
here, by the turn's sequencer (:class:`TurnWire`), because only the socket owns
``seq``: the heartbeat, HITL, the stage events and the errors are its own, and
they share the counter with everything the workflow yields.

The first frame on every socket is ``hello`` (:class:`~aiq_agent.common.wire_v2.Hello`),
sent once the version and the caller have passed; the client sends nothing
before it. Every client message gets an answer or a turn: one this wire does not
describe, unknown type or not JSON at all, is ``rejected{invalid_message}``.

What a socket holds, in order of the checks on every client message:

* **Who.** The handshake is authenticated like an HTTP request
  (:func:`authenticate_websocket_connection`), and every message re-checks the
  token's ``exp``: a browser does not replay cookies on a frame, so a socket
  would otherwise work forever under a dead token.
* **Which conversation.** Only the one the BFF signed into the context envelope
  (:func:`handshake_conversation_binding`). Every per-conversation key follows a
  message's ``conversation_id``, so a message naming another is refused.
* **Whose turn.** Stop and a HITL answer are the asker's (:func:`may_act_for`).
  In a shared conversation (ADR-0032) a colleague is a different subject.

A turn outlives its socket: a dropped socket does not cancel it, its frames keep
going to the conversation's stream (``conversation_bus``), a reconnect reads
them back with ``attach``, and the finished answer is persisted server-side with
a deterministic id, so the browser's own write of it is a no-op.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Mapping
from dataclasses import dataclass
from dataclasses import field
from typing import TYPE_CHECKING
from typing import Any

from fastapi import WebSocket
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from aiq_agent.common.human_prompt import human_response
from aiq_agent.common.human_prompt import interaction_request
from aiq_agent.common.wire_v2 import CLIENT_MESSAGE
from aiq_agent.common.wire_v2 import CLOSE_CLIENT_OUTDATED
from aiq_agent.common.wire_v2 import WIRE_VERSION
from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import Attach
from aiq_agent.common.wire_v2 import CancelTurn
from aiq_agent.common.wire_v2 import EventBody
from aiq_agent.common.wire_v2 import HeartbeatBody
from aiq_agent.common.wire_v2 import HeartbeatValue
from aiq_agent.common.wire_v2 import Hello
from aiq_agent.common.wire_v2 import HelloValue
from aiq_agent.common.wire_v2 import InteractionRequestBody
from aiq_agent.common.wire_v2 import InteractionResolvedBody
from aiq_agent.common.wire_v2 import InteractionResolvedValue
from aiq_agent.common.wire_v2 import InteractionResponse
from aiq_agent.common.wire_v2 import RejectedBody
from aiq_agent.common.wire_v2 import RejectedValue
from aiq_agent.common.wire_v2 import RunErrorBody
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import RunStartedBody
from aiq_agent.common.wire_v2 import StageBody
from aiq_agent.common.wire_v2 import StageValue
from aiq_agent.common.wire_v2 import StateSnapshotBody
from aiq_agent.common.wire_v2 import TurnResult
from aiq_agent.common.wire_v2 import UserMessage
from aiq_agent.common.wire_v2 import WireSource
from aiq_agent.common.wire_v2 import stamp
from aiq_agent.common.wire_v2 import to_frame
from aiq_agent.conversation_context import ContextOnlyMessage
from aiq_agent.conversation_context import append_conversation_context
from aiq_agent.conversation_context import format_context_turn
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from aiq_agent.project_context import GridRequestContext
from aiq_agent.turn.response import answer_message_id
from aiq_agent.turn.streaming import TurnTextFold
from aiq_api.auth.errors import AuthError
from aiq_api.auth.middleware import build_request_trace_tags
from aiq_api.auth.middleware import detect_internal_caller
from aiq_api.auth.middleware import resolve_request_user
from aiq_api.auth.middleware import user_context
from aiq_api.auth.request_trace import request_trace_tag_context
from aiq_api.conversation_bus import CANCEL
from aiq_api.conversation_bus import FRAME
from aiq_api.conversation_bus import HITL_ANSWER
from aiq_api.conversation_bus import ConversationBus
from aiq_api.conversation_bus import get_bus
from aiq_api.conversation_bus import is_multi_replica_bus
from aiq_api.internal_api import post_internal_conversation_message
from aiq_api.startup_banner import deployed_sha
from aiq_api.workflow_stream import stream_workflow
from nat.plugin_api import HumanResponse
from nat.plugin_api import InteractionPrompt

if TYPE_CHECKING:
    from nat.runtime.session import SessionManager

logger = logging.getLogger(__name__)

WS_POLICY_VIOLATION = 1008

#: How often a running turn says it is still running, in seconds. It travels on
#: the event (``every_ms``), so the client's tolerance is a multiple of what the
#: server keeps rather than a constant both tiers hold.
TURN_HEARTBEAT_SECONDS = 20.0

#: How long a HITL prompt stays open before the turn gives up. Generous, because
#: a clarifying question can sit while somebody checks a drawing, but finite:
#: an unanswered prompt used to pin a turn and its checkpoint forever.
HITL_RESPONSE_TIMEOUT_SECONDS = float(os.getenv("GRID_HITL_RESPONSE_TIMEOUT_SECONDS", "1800"))

#: How long a finished turn keeps its sequencer for the stage events that follow
#: its terminal (``docs/architecture/post-answer-stages.md`` §4).
STAGE_WIRE_TTL_S = 600.0

_ORG_ID_HEADER = "x-grid-organization-id"
_NOT_ASKER_STOP = "Only the person who asked can stop this turn."

_auth_validators: list = []
_require_auth = False
_external_hostnames: set[str] | None = None


# ---------------------------------------------------------------------------
# Who holds the socket
# ---------------------------------------------------------------------------


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
    """The caller identity for a WebSocket handshake, or the close code that refuses it."""
    headers = dict(socket.scope.get("headers", []))
    user, _, is_external, _ = await resolve_request_user(
        headers,
        validators=_auth_validators,
        require_auth=_require_auth,
        external_hostnames=_external_hostnames,
    )
    if user is not None:
        return user, None
    if not is_external:
        return detect_internal_caller(headers), None
    return None, WS_POLICY_VIOLATION


def verified_subject(user: Mapping[str, Any]) -> str | None:
    """The stable identity of the human holding the socket, from VERIFIED claims.

    Internal and anonymous callers carry none; they are trusted by other means
    (a service token, not a user), see :func:`may_act_for`.
    """
    for key in ("sub", "user_id", "id"):
        value = user.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def verified_display_name(user: Mapping[str, Any]) -> str | None:
    """The display name from the verified claims, preferred over a client-supplied ``author_name``."""
    for key in ("name", "email"):
        value = user.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def token_expired(user: Mapping[str, Any]) -> bool:
    """Whether the handshake token has passed its ``exp``. Callers without one never expire."""
    exp = user.get("exp")
    return isinstance(exp, int | float) and time.time() >= exp


def may_act_for(asker: str | None, actor: str | None, *, internal: bool) -> bool:
    """Whether ``actor`` may stop, or answer a question of, a turn ``asker`` asked.

    An internal caller may. A turn with no verified asker (an internal or
    anonymous caller asked) has no identity to match. Everyone else must be the
    asker: in a shared conversation a colleague is a different subject, and the
    assistant asked one person.
    """
    return internal or asker is None or actor == asker


def handshake_conversation_binding(scope: Mapping[str, Any]) -> tuple[bool, str | None]:
    """The conversation the BFF authorized for this socket, read at the handshake.

    Returns ``(envelope_present, conversation_id)``. The id comes ONLY from the
    signed ``X-Grid-Request-Context`` envelope: ``server.js`` signs the id that
    ``/api/auth/websocket-scope`` ran ``authorizeConversationScope`` on, and
    nothing else on the upgrade is authorized. ``envelope_present`` is False
    only off the BFF (an internal caller, anonymous mode):
    ``GridContextEnvelopeMiddleware`` closes an authenticated user's socket that
    arrives without a valid envelope.
    """
    headers: dict[str, str] = {}
    for raw_name, raw_value in scope.get("headers", []) or []:
        with contextlib.suppress(AttributeError, UnicodeDecodeError):
            headers[raw_name.decode("latin-1").lower()] = raw_value.decode("latin-1")
    envelope = GridRequestContext.from_envelope(
        headers.get(REQUEST_CONTEXT_ENVELOPE_HEADER),
        headers.get(REQUEST_CONTEXT_ENVELOPE_SIG_HEADER),
        os.environ.get("GRID_INTERNAL_API_TOKEN"),
    )
    if envelope is None:
        return False, None
    return True, envelope.conversation_id


def _org_id_from_scope(scope: Mapping[str, Any]) -> str | None:
    """The conversation's owning org, as ``server.js`` forwarded it on the upgrade.

    The internal persist route scopes its lookup by it, so a persist for a
    conversation whose org is unknown no-ops rather than writing cross-tenant.
    """
    for raw_name, raw_value in scope.get("headers", []) or []:
        name = raw_name.decode() if isinstance(raw_name, bytes) else str(raw_name)
        if name.lower() == _ORG_ID_HEADER:
            return raw_value.decode() if isinstance(raw_value, bytes) else str(raw_value)
    return None


# ---------------------------------------------------------------------------
# Persistence: the finished answer is the server's to keep
# ---------------------------------------------------------------------------

#: What the row does not keep: its id and text travel as columns, cards are
#: stored unkeyed, and a queue notice or a run hand-off is not an answer.
_NOT_METADATA = {"message_id", "text", "cards", "job_admission_rejected", "retry_after_seconds", "run"}

#: Background persists still in flight (the loop holds only weak references).
_PERSIST_TASKS: set[asyncio.Task[bool]] = set()


def turn_row_metadata(finished: RunFinishedBody) -> dict[str, Any] | None:
    """The message row's metadata for a finished turn, or None when nothing is written.

    Pure, from the typed result alone, in the wire spellings
    ``agent-answer-metadata.ts`` maps. A job-admission rejection is a transient
    notice, and a turn with no text and no cards (a run hand-off) has nothing
    to show.
    """
    result = finished.result
    if result.job_admission_rejected or not (result.text.strip() or result.cards):
        return None
    metadata = result.model_dump(mode="json", exclude_defaults=True, exclude=_NOT_METADATA)
    if result.cards:
        metadata["cards"] = [keyed.card for keyed in result.cards]
    if finished.outcome == "cancelled":
        metadata["stopped"] = True
    return metadata


async def persist_turn_result(*, conversation_id: str, organization_id: str | None, finished: RunFinishedBody) -> bool:
    """Write a finished turn to the BFF, whether or not a socket took its frame. Fail-soft."""
    metadata = turn_row_metadata(finished)
    if metadata is None:
        return False
    return await post_internal_conversation_message(
        conversation_id=conversation_id,
        organization_id=organization_id,
        message_id=finished.result.message_id,
        role="assistant",
        text=finished.result.text,
        message_type="agent_response",
        metadata=metadata,
    )


def _persist_in_background(conversation_id: str, organization_id: str | None, finished: RunFinishedBody) -> None:
    """Persist off the frame's path: the stage events behind it must not wait on the BFF."""
    task = asyncio.create_task(
        persist_turn_result(conversation_id=conversation_id, organization_id=organization_id, finished=finished)
    )
    _PERSIST_TASKS.add(task)
    task.add_done_callback(_PERSIST_TASKS.discard)


# ---------------------------------------------------------------------------
# One turn: its sequencer, its partial answer, its pending question
# ---------------------------------------------------------------------------


def _now_ms() -> int:
    return int(time.time() * 1000)


class TurnWire:
    """One turn's sequencer: every body the socket sends for this turn is stamped here, in order.

    The lock makes stamp-and-publish one step, so the stream and every socket
    see ``seq`` in order even with the heartbeat and the workflow sending at
    once. Stage events are the only events after the terminal, and never
    before it: a stage that finishes while the answer is still streaming is
    held and goes out right behind the terminal.
    """

    def __init__(self, conversation_id: str, turn_id: str, publish: Callable[[str, dict], Awaitable[bool]]) -> None:
        self.conversation_id = conversation_id
        self.turn_id = turn_id
        self.seq = 0
        self.finished = False
        self._publish = publish
        self._lock = asyncio.Lock()
        self._held_stages: list[StageBody] = []

    async def send(self, body: EventBody) -> bool:
        """Stamp ``body`` with the next ``seq`` and publish it. Whether a local socket took it.

        A stage held for the terminal counts as taken: it is sent the moment
        the turn ends, which is when a reader could first see it anyway.
        """
        async with self._lock:
            if isinstance(body, StageBody) and not self.finished:
                self._held_stages.append(body)
                return True
            if self.finished and not isinstance(body, StageBody):
                logger.debug("Dropping %s after the terminal of turn %s", type(body).__name__, self.turn_id)
                return False
            delivered = await self._stamp_and_publish(body)
            if isinstance(body, RunFinishedBody | RunErrorBody):
                self.finished = True
                for stage in self._held_stages:
                    await self._stamp_and_publish(stage)
                self._held_stages.clear()
            return delivered

    async def _stamp_and_publish(self, body: EventBody) -> bool:
        self.seq += 1
        event = stamp(body, conversation_id=self.conversation_id, turn_id=self.turn_id, seq=self.seq, ts=_now_ms())
        return await self._publish(self.conversation_id, to_frame(event))


class InteractionExpired(TimeoutError):
    """Nobody answered the turn's question in time. A ``TimeoutError``, so ``ask_user`` recovers from it."""


@dataclass
class PendingInteraction:
    prompt: InteractionPrompt
    answer: asyncio.Future[HumanResponse]


@dataclass
class RunningTurn:
    wire: TurnWire
    asker_subject: str | None
    organization_id: str | None = None
    task: asyncio.Task[None] | None = None
    #: The prose so far, for a stopped turn's result, and the sources of the
    #: last settle, which are the ones a settled text's ``[N]`` resolve to.
    fold: TurnTextFold = field(default_factory=TurnTextFold)
    settled_sources: list[WireSource] = field(default_factory=list)
    pending: PendingInteraction | None = None

    @property
    def message_id(self) -> str:
        return answer_message_id(self.wire.conversation_id, self.wire.turn_id)

    async def publish(self, body: EventBody) -> None:
        """Send one body the workflow yielded; the terminal is also persisted."""
        self.fold.add(body)
        if isinstance(body, StateSnapshotBody | AnswerRetractedBody):
            self.settled_sources = list(body.snapshot.sources) if isinstance(body, StateSnapshotBody) else []
        if isinstance(body, RunFinishedBody):
            await self.finish(body)
            return
        await self.wire.send(body)

    async def finish(self, finished: RunFinishedBody) -> None:
        """Send the turn's one terminal and persist it, whether or not a socket took it."""
        if self.wire.finished:
            logger.warning("Turn %s already ended; a second terminal is dropped", self.wire.turn_id)
            return
        await self.wire.send(finished)
        _persist_in_background(self.wire.conversation_id, self.organization_id, finished)

    async def ask(self, prompt: InteractionPrompt) -> HumanResponse:
        """NAT's ``user_input_callback``: put the prompt to the asker and wait for their answer."""
        expires_at = _now_ms() + int(HITL_RESPONSE_TIMEOUT_SECONDS * 1000)
        self.pending = PendingInteraction(prompt=prompt, answer=asyncio.get_running_loop().create_future())
        await self.wire.send(InteractionRequestBody(value=interaction_request(prompt, expires_at=expires_at)))
        try:
            response = await asyncio.wait_for(self.pending.answer, timeout=HITL_RESPONSE_TIMEOUT_SECONDS)
        except TimeoutError:
            await self._resolved(prompt, "expired")
            raise InteractionExpired(f"interaction {prompt.id} expired unanswered") from None
        except asyncio.CancelledError:
            await self._resolved(prompt, "cancelled")
            raise
        finally:
            self.pending = None
        await self._resolved(prompt, "answered")
        return response

    async def _resolved(self, prompt: InteractionPrompt, outcome: str) -> None:
        value = InteractionResolvedValue(interaction_id=prompt.id, outcome=outcome)
        await self.wire.send(InteractionResolvedBody(value=value))

    def answer(self, message: InteractionResponse, *, subject: str | None, internal: bool) -> str | None:
        """Resolve the pending question with ``message``. The refusal code, or None when it was taken."""
        pending = self.pending
        if pending is None or pending.prompt.id != message.interaction_id or pending.answer.done():
            return "no_pending_interaction"
        if not may_act_for(self.asker_subject, subject, internal=internal):
            return "not_asker"
        try:
            response = human_response(pending.prompt.content, message.answer)
        except ValueError:
            return "invalid_message"
        pending.answer.set_result(response)
        return None

    def cancel(self, *, subject: str | None, internal: bool) -> str | None:
        """Stop the turn's task. The refusal code, or None when it was cancelled."""
        if not may_act_for(self.asker_subject, subject, internal=internal):
            return "not_asker"
        if self.task is not None:
            self.task.cancel()
        return None

    async def finish_cancelled(self) -> None:
        """The terminal of a stopped turn: what the reader saw when they pressed Stop, persisted and marked stopped."""
        text = self.fold.partial().strip()
        sources = self.settled_sources if text == (self.fold.settled or "").strip() else []
        result = TurnResult(message_id=self.message_id, text=text, sources=sources)
        await self.finish(RunFinishedBody(outcome="cancelled", result=result))


# ---------------------------------------------------------------------------
# The registry: sockets, running turns, and the bus between replicas
# ---------------------------------------------------------------------------


class _Outlet:
    """The socket a conversation's frames go to. It holds them while an ``attach`` replays."""

    def __init__(self, socket: WebSocket, *, holding: bool = False) -> None:
        self.socket = socket
        self.held: list[dict[str, Any]] | None = [] if holding else None

    async def deliver(self, frame: dict[str, Any]) -> bool:
        if self.held is not None:
            self.held.append(frame)
            return True
        return await _write(self.socket, frame)


async def _write(socket: WebSocket, frame: dict[str, Any]) -> bool:
    """Write one frame. A closed socket is normal, not an error: the frame is in the conversation's stream."""
    try:
        await socket.send_json(frame)
    except (RuntimeError, OSError, WebSocketDisconnect):
        logger.debug("Socket write failed; the frame stays in the conversation stream", exc_info=True)
        return False
    return True


class ChatRegistry:
    """Sockets, running turns and finished turns' sequencers, per conversation, in this process.

    One socket per conversation (the latest). Between replicas (ADR-0028) the
    turn's owner publishes every frame and listens for answers and Stops that a
    relay replica received; the relay subscribes and writes frames to its socket.
    """

    def __init__(self, bus: ConversationBus | None = None) -> None:
        self._bus = bus
        self._outlets: dict[str, _Outlet] = {}
        self._turns: dict[str, RunningTurn] = {}
        self._finished: dict[tuple[str, str], tuple[TurnWire, float]] = {}
        self._relays: dict[str, asyncio.Task[None]] = {}
        self._inputs: dict[str, asyncio.Task[None]] = {}

    def bus(self) -> ConversationBus:
        """The bus this registry publishes on: the process bus, or a replica's own in a test."""
        return self._bus or get_bus()

    # ---- sockets ---------------------------------------------------------
    def set_socket(self, conversation_id: str, socket: WebSocket, *, holding: bool = False) -> _Outlet:
        current = self._outlets.get(conversation_id)
        if current is not None and current.socket is socket and not holding:
            return current
        outlet = _Outlet(socket, holding=holding)
        self._outlets[conversation_id] = outlet
        if is_multi_replica_bus():
            _restart(self._relays, conversation_id, self._relay(conversation_id))
        return outlet

    def clear_socket(self, conversation_id: str | None, socket: WebSocket) -> None:
        outlet = self._outlets.get(conversation_id or "")
        if outlet is None or outlet.socket is not socket:
            return
        del self._outlets[conversation_id]
        _stop(self._relays, conversation_id)

    async def publish(self, conversation_id: str, frame: dict[str, Any]) -> bool:
        """Append ``frame`` to the conversation's stream (relays, spectators, ``attach``), then write it here."""
        try:
            await self.bus().publish_frame(conversation_id, frame)
        except Exception:  # noqa: BLE001 — fail-open: the local socket still gets the frame
            logger.warning("Bus publish failed for conversation %s", conversation_id, exc_info=True)
        outlet = self._outlets.get(conversation_id)
        return await outlet.deliver(frame) if outlet is not None else False

    async def attach(self, conversation_id: str, socket: WebSocket, turn_id: str, after_seq: int) -> bool:
        """Replay one turn from ``after_seq + 1`` onto ``socket``, then go live. False when nothing is known of it.

        Live frames are held while the replay is read, then flushed above the
        last replayed ``seq``, so a frame that arrives both ways is sent once.
        """
        outlet = self.set_socket(conversation_id, socket, holding=True)
        frames = await self.bus().replay_turn(conversation_id, turn_id)
        last = after_seq
        for frame in (frame for frame in frames if frame["seq"] > after_seq):
            await _write(socket, frame)
            last = frame["seq"]
        await _flush(outlet, turn_id, last)
        return bool(frames) or self.wire(conversation_id, turn_id) is not None

    async def _relay(self, conversation_id: str) -> None:
        async for envelope in self.bus().subscribe_frames(conversation_id):
            outlet = self._outlets.get(conversation_id)
            if envelope.type == FRAME and outlet is not None:
                await outlet.deliver(envelope.payload)

    # ---- turns -----------------------------------------------------------
    def running(self, conversation_id: str, turn_id: str | None = None) -> RunningTurn | None:
        turn = self._turns.get(conversation_id)
        if turn is None or (turn_id is not None and turn.wire.turn_id != turn_id):
            return None
        return turn

    def start_turn(self, turn: RunningTurn) -> None:
        """Register ``turn`` as the conversation's running turn; a stale one is superseded and stopped."""
        conversation_id = turn.wire.conversation_id
        stale = self._turns.get(conversation_id)
        if stale is not None and stale.task is not None and not stale.task.done():
            logger.info("Superseding turn %s in conversation %s", stale.wire.turn_id, conversation_id)
            stale.task.cancel()
        self._turns[conversation_id] = turn
        if is_multi_replica_bus():
            _restart(self._inputs, conversation_id, self._owner_input(conversation_id))

    def finish_turn(self, turn: RunningTurn) -> None:
        """The turn ended: keep its sequencer for the stage events until ``STAGE_WIRE_TTL_S``."""
        conversation_id = turn.wire.conversation_id
        if self._turns.get(conversation_id) is turn:
            del self._turns[conversation_id]
            _stop(self._inputs, conversation_id)
        now = time.monotonic()
        self._finished = {key: entry for key, entry in self._finished.items() if entry[1] > now}
        self._finished[(conversation_id, turn.wire.turn_id)] = (turn.wire, now + STAGE_WIRE_TTL_S)

    def wire(self, conversation_id: str, turn_id: str) -> TurnWire | None:
        turn = self.running(conversation_id, turn_id)
        if turn is not None:
            return turn.wire
        wire, expires = self._finished.get((conversation_id, turn_id), (None, 0.0))
        return wire if expires > time.monotonic() else None

    async def send_stage(self, conversation_id: str, turn_id: str, value: StageValue) -> bool:
        """The ``StageFrameSink``: a stage event on the turn's own ``seq``. False when no socket took it."""
        wire = self.wire(conversation_id, turn_id)
        if wire is None:
            return False
        return await wire.send(StageBody(value=value))

    async def _owner_input(self, conversation_id: str) -> None:
        """While a turn runs here, take the answers and Stops a relay replica received for it."""
        async for envelope in self.bus().subscribe_input(conversation_id):
            if envelope.type in {HITL_ANSWER, CANCEL}:
                self.relayed(envelope.payload)

    def relayed(self, payload: dict[str, Any]) -> None:
        """A relay's message for a turn running here, authorised here: the relay does not know the asker."""
        try:
            message = CLIENT_MESSAGE.validate_python(payload["message"])
        except (ValidationError, KeyError):
            logger.warning("Dropping a malformed relayed message", exc_info=True)
            return
        subject, internal = payload.get("subject"), bool(payload.get("internal"))
        turn = self.running(message.conversation_id, message.turn_id)
        if turn is None or not isinstance(message, InteractionResponse | CancelTurn):
            return
        refusal = (
            turn.cancel(subject=subject, internal=internal)
            if isinstance(message, CancelTurn)
            else turn.answer(message, subject=subject, internal=internal)
        )
        if refusal is not None:
            logger.warning("Refused a relayed %s for turn %s: %s", message.type, message.turn_id, refusal)


async def _flush(outlet: _Outlet, turn_id: str, last: int) -> None:
    """Send what was held during a replay, minus what the replay already sent, then go live."""
    while outlet.held:
        frame = outlet.held.pop(0)
        if frame.get("turn_id") != turn_id or frame["seq"] > last:
            await _write(outlet.socket, frame)
    outlet.held = None


def _restart(tasks: dict[str, asyncio.Task[None]], key: str, loop: Awaitable[None]) -> None:
    _stop(tasks, key)
    tasks[key] = asyncio.ensure_future(loop)


def _stop(tasks: dict[str, asyncio.Task[None]], key: str) -> None:
    task = tasks.pop(key, None)
    if task is not None and not task.done():
        task.cancel()


_registry = ChatRegistry()


async def send_stage(conversation_id: str, turn_id: str, value: StageValue) -> bool:
    """The ``aiq_agent.stages.delivery.StageFrameSink`` this front end publishes."""
    return await _registry.send_stage(conversation_id, turn_id, value)


# ---------------------------------------------------------------------------
# Running a turn
# ---------------------------------------------------------------------------


async def _beat(wire: TurnWire) -> None:
    """A heartbeat every ``TURN_HEARTBEAT_SECONDS`` while the turn runs. Sleeps first: a short turn sends none."""
    body = HeartbeatBody(value=HeartbeatValue(every_ms=int(TURN_HEARTBEAT_SECONDS * 1000)))
    while True:
        await asyncio.sleep(TURN_HEARTBEAT_SECONDS)
        await wire.send(body)


async def _relay_workflow(turn: RunningTurn, request: UserMessage, session: Any) -> None:
    """Send every body the turn's ``_run`` yields, in order; the stream closes in this task."""
    async with contextlib.aclosing(stream_workflow(request, session=session)) as bodies:
        async for body in bodies:
            await turn.publish(body)


async def _drive(
    turn: RunningTurn,
    request: UserMessage,
    *,
    session_manager: SessionManager,
    socket: WebSocket,
    caller: dict[str, Any],
) -> None:
    """Run the workflow in a NAT session bound to this turn: the verified subject, the question, the HITL callback."""
    headers = dict(socket.scope.get("headers", []))
    tags = build_request_trace_tags(headers, socket.scope, caller, external_hostnames=_external_hostnames)
    with user_context(caller), request_trace_tag_context(tags):
        async with session_manager.session(
            # Never None: NAT would then derive an id from the unverified headers.
            user_id=turn.asker_subject or caller.get("type"),
            user_message_id=request.message_id,
            conversation_id=request.conversation_id,
            http_connection=socket,
            user_input_callback=turn.ask,
        ) as session:
            await _relay_workflow(turn, request, session)


def _error_for(exc: Exception) -> RunErrorBody:
    if isinstance(exc, InteractionExpired):
        return RunErrorBody(code="interaction_expired", message="The question was not answered in time.")
    if isinstance(exc, AuthError):
        return RunErrorBody(code="auth_error", message=exc.error_code, details=str(exc))
    return RunErrorBody(
        code="workflow_error",
        message="The assistant hit an unexpected error while handling your request. Please try again.",
        details=str(exc),
    )


async def run_turn(turn: RunningTurn, request: UserMessage, *, registry: ChatRegistry, **drive: Any) -> None:
    """The turn's task: drive the workflow, then make sure the turn has exactly one terminal.

    A Stop (or a superseding question) cancels this task: the cancel unwinds
    the workflow through ``aclosing`` in ``stream_workflow``, so the graph run is
    cancelled and no LLM call follows, and the prose so far is the result.
    """
    heartbeat = asyncio.create_task(_beat(turn.wire))
    try:
        await _drive(turn, request, **drive)
        if not turn.wire.finished:
            await turn.wire.send(RunErrorBody(code="workflow_error", message="The turn ended without a result."))
    except asyncio.CancelledError:
        # Taken, not re-raised: the cancel was ours (Stop, or a newer question),
        # and the turn still owes its reader a terminal.
        asyncio.current_task().uncancel()
        await turn.finish_cancelled()
    except Exception as exc:  # noqa: BLE001 — every failure ends the turn with a RUN_ERROR the client can act on
        logger.warning("Turn %s failed", turn.wire.turn_id, exc_info=True)
        await turn.wire.send(_error_for(exc))
    finally:
        heartbeat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat
        registry.finish_turn(turn)


# ---------------------------------------------------------------------------
# One socket
# ---------------------------------------------------------------------------


def _client_type(raw: object) -> str | None:
    kind = raw.get("type") if isinstance(raw, dict) else None
    return kind if kind in {"user_message", "interaction_response", "cancel_turn", "attach"} else None


class ChatSocket:
    """One connection: authenticated, bound to one conversation, serving the four client messages."""

    def __init__(self, socket: WebSocket, session_manager: SessionManager, registry: ChatRegistry) -> None:
        self.socket = socket
        self.session_manager = session_manager
        self.registry = registry
        self.caller: dict[str, Any] = {}
        self.envelope_present, self.bound = handshake_conversation_binding(socket.scope)

    @property
    def subject(self) -> str | None:
        return verified_subject(self.caller)

    @property
    def internal(self) -> bool:
        return self.caller.get("type") == "internal"

    async def serve(self) -> None:
        """Accept, gate on the version and the caller, say hello, then serve messages until the socket closes.

        The hello is the server's half of the version gate. ``4426`` tells an
        old page it is old; the hello tells a current page the server is
        current, because a server that predates this wire accepts the upgrade,
        ignores ``?v=2`` and would otherwise leave the page waiting on silence.
        """
        await self.socket.accept()
        if self.socket.query_params.get("v") != str(WIRE_VERSION):
            await self.socket.close(code=CLOSE_CLIENT_OUTDATED)
            return
        user, close_code = await authenticate_websocket_connection(self.socket)
        if user is None:
            await self.socket.close(code=close_code or WS_POLICY_VIOLATION)
            return
        self.caller = user
        try:
            await self.socket.send_json(to_frame(Hello(ts=_now_ms(), value=HelloValue(build=deployed_sha()))))
            await self._serve_messages()
        except WebSocketDisconnect:
            logger.debug("Chat socket closed for conversation %s", self.bound)
        finally:
            # A dropped socket never cancels its turn: it finishes and is persisted.
            self.registry.clear_socket(self.bound, self.socket)

    async def _serve_messages(self) -> None:
        while True:
            try:
                raw = await self.socket.receive_json()
            except ValueError:
                await self._reject(None, "unknown", "invalid_message", "Not a JSON message.")
                continue
            await self._receive(raw)

    async def _receive(self, raw: object) -> None:
        kind = _client_type(raw)
        if kind is None:
            # Answered, never dropped: a client that sent something this wire
            # does not have must hear so, or it waits on silence.
            await self._reject(raw, "unknown", "invalid_message", "Unknown message type.")
            return
        try:
            message = CLIENT_MESSAGE.validate_python(raw)
        except ValidationError:
            await self._reject(raw, kind, "invalid_message")
            return
        if token_expired(self.caller):
            await self._reject(raw, kind, "auth_expired")
            return
        if not self._admit(message.conversation_id):
            await self._reject(raw, kind, "conversation_mismatch")
            return
        handlers = {
            UserMessage: self.on_user_message,
            InteractionResponse: self.on_interaction_response,
            CancelTurn: self.on_cancel,
            Attach: self.on_attach,
        }
        await handlers[type(message)](message)

    def _admit(self, conversation_id: str) -> bool:
        """Whether a message naming ``conversation_id`` may be served on this socket.

        Behind the BFF: exactly the signed id, and nothing when none was signed.
        Off the BFF (internal caller, anonymous mode): the first id a message
        names binds the socket.
        """
        if self.bound is None and not self.envelope_present:
            self.bound = conversation_id
        return conversation_id == self.bound

    async def _reject(self, raw: object, of: str, code: str, message: str | None = None) -> None:
        """An out-of-band ``rejected`` (seq 0) to this socket only: never published, never replayed."""
        fields = raw if isinstance(raw, dict) else {}
        body = RejectedBody(value=RejectedValue(of=of, code=code, message=message))
        event = stamp(
            body,
            conversation_id=str(fields.get("conversation_id") or self.bound or "unknown"),
            turn_id=str(fields.get("turn_id") or fields.get("message_id") or "unknown"),
            seq=0,
            ts=_now_ms(),
        )
        logger.info("Rejected %s on conversation %s: %s", of, self.bound, code)
        with contextlib.suppress(Exception):
            await self.socket.send_json(to_frame(event))

    async def on_user_message(self, message: UserMessage) -> None:
        if message.context_only:
            await self._ingest(message)
            return
        conversation_id = message.conversation_id
        if self.registry.running(conversation_id, message.message_id) is not None:
            await self._reject(message.model_dump(), "user_message", "duplicate_turn")
            return
        self.registry.set_socket(conversation_id, self.socket)
        wire = TurnWire(conversation_id, message.message_id, self.registry.publish)
        turn = RunningTurn(wire=wire, asker_subject=self.subject, organization_id=_org_id_from_scope(self.socket.scope))
        await wire.send(RunStartedBody(message_id=turn.message_id))
        turn.task = asyncio.create_task(
            run_turn(
                turn,
                message,
                registry=self.registry,
                session_manager=self.session_manager,
                socket=self.socket,
                caller=self.caller,
            )
        )
        self.registry.start_turn(turn)

    async def on_interaction_response(self, message: InteractionResponse) -> None:
        self.registry.set_socket(message.conversation_id, self.socket)
        turn = self.registry.running(message.conversation_id, message.turn_id)
        if turn is None:
            await self._to_owner(HITL_ANSWER, message)
            return
        refusal = turn.answer(message, subject=self.subject, internal=self.internal)
        if refusal is not None:
            await self._reject(message.model_dump(), "interaction_response", refusal)

    async def on_cancel(self, message: CancelTurn) -> None:
        turn = self.registry.running(message.conversation_id, message.turn_id)
        if turn is None:
            await self._to_owner(CANCEL, message)
            return
        refusal = turn.cancel(subject=self.subject, internal=self.internal)
        if refusal is not None:
            await self._reject(
                message.model_dump(), "cancel_turn", refusal, "Only the person who asked can stop this turn."
            )

    async def on_attach(self, message: Attach) -> None:
        known = await self.registry.attach(message.conversation_id, self.socket, message.turn_id, message.after_seq)
        if not known:
            await self._reject(message.model_dump(), "attach", "turn_not_found")

    async def _to_owner(self, input_type: str, message: InteractionResponse | CancelTurn) -> None:
        """A message for a turn this replica is not running: the owner authorises it, or nobody runs it."""
        of = message.type
        if not is_multi_replica_bus():
            await self._reject(message.model_dump(), of, "turn_not_found")
            return
        payload = {"message": message.model_dump(mode="json"), "subject": self.subject, "internal": self.internal}
        await self.registry.bus().publish_input(message.conversation_id, input_type, payload)

    async def _ingest(self, message: UserMessage) -> None:
        """Put a colleague's line into the agent's history and generate NOTHING (ADR-0034 addendum).

        No workflow, no LLM, no event. Failures are logged and never surfaced:
        the message is already persisted by the BFF, so the worst case is a gap
        in the agent's memory, which must not cost anyone their socket.
        """
        line = ContextOnlyMessage(text=message.text, author=message.author_name)
        text = format_context_turn(line, author=verified_display_name(self.caller))
        with user_context(self.caller):
            stored = await append_conversation_context(message.conversation_id, text)
        if not stored:
            logger.warning("Ingest-only message not stored for conversation %s", message.conversation_id)


def chat_socket_endpoint(
    session_manager: SessionManager, registry: ChatRegistry = _registry
) -> Callable[[WebSocket], Awaitable[None]]:
    """The ``/websocket`` route: one :class:`ChatSocket` per connection."""

    async def _chat_socket(websocket: WebSocket) -> None:
        await ChatSocket(websocket, session_manager, registry).serve()

    return _chat_socket

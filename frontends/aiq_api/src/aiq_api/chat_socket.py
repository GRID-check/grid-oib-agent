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

Every turn ends, because the heartbeat keeps the reader waiting for as long as
it runs: exactly one terminal is guaranteed by ``run_turn``'s ``finally``, a
deadline on the turn's own clock (:class:`TurnDeadline`) ends a turn that
would never return, and a turn id runs on one replica (``claim_turn``).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from collections import deque
from collections.abc import AsyncIterator
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
from aiq_api.conversation_bus import SUPERSEDE
from aiq_api.conversation_bus import BusUnavailable
from aiq_api.conversation_bus import ConversationBus
from aiq_api.conversation_bus import Envelope
from aiq_api.conversation_bus import get_bus
from aiq_api.conversation_bus import is_multi_replica_bus
from aiq_api.internal_api import post_internal_conversation_message
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

#: The turn's deadline, in seconds of its own clock: from RUN_STARTED, minus the
#: time spent waiting on a person (:class:`TurnDeadline`); 0 disables it. The
#: longest legitimate chat turn is the in-process deep-research fallback, which
#: its own clock ends at ``deep_researcher.agent.DEFAULT_MAX_RUN_SECONDS``
#: (2400 s) with an answer; this sits above that so it never pre-empts a clean
#: cut-off, and bounds everything else: a model call, tool or graph that never
#: returns. How many turns run at once is not decided here: ADR-0040's
#: admission (``GRID_MAX_ACTIVE_TURNS``) refuses a turn it has no slot for at
#: once, and NAT's own semaphore, which queued it silently, is off
#: (``plugin.AIQAPIWorker._create_chat_session_manager``).
TURN_DEADLINE_SECONDS = float(os.getenv("GRID_CHAT_TURN_DEADLINE_SECONDS", "2700"))

#: How many of its own frames a turn's sequencer keeps for ``attach``, so the
#: replica running a turn can replay it without the bus. The bus stream keeps
#: the same number per conversation (``GRID_CONV_STREAM_MAXLEN``'s default).
LOCAL_REPLAY_FRAMES = 2000

#: How soon a dead bus loop (a relay's frames, an owner's inputs) is restarted,
#: doubling per failure up to the maximum.
_LOOP_RESTART_MIN_S = 0.5
_LOOP_RESTART_MAX_S = 30.0

#: How long an ``attach`` waits for its relay's subscription before reading the
#: stream anyway (the bus's own command bound).
BUS_READY_TIMEOUT_S = 1.0

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
        self._frames: deque[dict[str, Any]] = deque(maxlen=LOCAL_REPLAY_FRAMES)

    def replay(self) -> list[dict[str, Any]]:
        """Every frame this sequencer stamped (the last ``LOCAL_REPLAY_FRAMES``), in ``seq`` order."""
        return list(self._frames)

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
        frame = to_frame(event)
        self._frames.append(frame)
        return await self._publish(self.conversation_id, frame)


class InteractionExpired(TimeoutError):
    """Nobody answered the turn's question in time. A ``TimeoutError``, so ``ask_user`` recovers from it."""


class TurnDeadlineExceeded(Exception):
    """The turn used up its own clock (``TURN_DEADLINE_SECONDS``) without a result."""


class TurnDeadline:
    """A turn's clock: wall time from its start, except the time it waits on a person.

    A model call, tool or graph that never returns ends the turn when the clock
    runs out. A turn waiting on its asker's answer does not tick
    (:meth:`pause` / :meth:`resume` around :meth:`RunningTurn.ask`): that wait
    has its own bound (``HITL_RESPONSE_TIMEOUT_SECONDS``), and a person reading
    a drawing is not a fault to cut short. Built on ``asyncio.timeout``, whose
    ``reschedule`` is the pause; the timeout cancels the turn's own task, so the
    cancel unwinds the workflow exactly as a Stop does.
    """

    def __init__(self, seconds: float | None = None) -> None:
        self.seconds = TURN_DEADLINE_SECONDS if seconds is None else seconds
        self._timeout: asyncio.Timeout | None = None
        self._left: float | None = None

    @contextlib.asynccontextmanager
    async def running(self) -> AsyncIterator[None]:
        """Run the body on the clock; running out is :class:`TurnDeadlineExceeded`, any other timeout passes."""
        timeout = asyncio.timeout(self.seconds if self.seconds > 0 else None)
        try:
            async with timeout:
                self._timeout = timeout
                yield
        except TimeoutError as exc:
            if not timeout.expired():
                raise  # the workflow's own, e.g. InteractionExpired
            raise TurnDeadlineExceeded(f"no result within the turn's {self.seconds:.0f}s") from exc
        finally:
            self._timeout = None

    def pause(self) -> None:
        """Stop the clock, keeping what is left of it."""
        timeout = self._timeout
        if timeout is None or timeout.expired() or self._left is not None or timeout.when() is None:
            return
        self._left = max(0.0, timeout.when() - asyncio.get_running_loop().time())
        timeout.reschedule(None)

    def resume(self) -> None:
        """Start the clock again with what was left when it stopped."""
        timeout, left = self._timeout, self._left
        self._left = None
        if timeout is None or left is None or timeout.expired():
            return
        timeout.reschedule(asyncio.get_running_loop().time() + left)


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
    deadline: TurnDeadline = field(default_factory=TurnDeadline)

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
            response = await self._wait_for_person(self.pending.answer)
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

    async def _wait_for_person(self, answer: asyncio.Future[HumanResponse]) -> HumanResponse:
        """Await the asker's answer with the turn's clock stopped: that wait has its own bound, and is not a fault."""
        self.deadline.pause()
        try:
            return await asyncio.wait_for(answer, timeout=HITL_RESPONSE_TIMEOUT_SECONDS)
        finally:
            self.deadline.resume()

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
    A turn id is claimed on the bus before it runs, so it runs on one replica.
    """

    def __init__(self, bus: ConversationBus | None = None) -> None:
        self._bus = bus
        self._outlets: dict[str, _Outlet] = {}
        self._turns: dict[str, RunningTurn] = {}
        self._finished: dict[tuple[str, str], tuple[TurnWire, float]] = {}
        self._relays: dict[str, asyncio.Task[None]] = {}
        self._relay_ready: dict[str, asyncio.Event] = {}
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
            ready = self._relay_ready[conversation_id] = asyncio.Event()
            relay = _supervise("relay", conversation_id, lambda: self._relay(conversation_id, ready))
            _restart(self._relays, conversation_id, relay)
        return outlet

    def clear_socket(self, conversation_id: str | None, socket: WebSocket) -> None:
        outlet = self._outlets.get(conversation_id or "")
        if outlet is None or outlet.socket is not socket:
            return
        del self._outlets[conversation_id]
        self._relay_ready.pop(conversation_id, None)
        _stop(self._relays, conversation_id)

    async def publish(self, conversation_id: str, frame: dict[str, Any]) -> bool:
        """Append ``frame`` to the conversation's stream (relays, spectators, ``attach``), then write it here."""
        try:
            await self.bus().publish_frame(conversation_id, frame)
        except BusUnavailable:
            # Fail-open: the local socket still gets the frame, and the bus has said it is down.
            logger.debug("Bus publish skipped for conversation %s", conversation_id, exc_info=True)
        outlet = self._outlets.get(conversation_id)
        return await outlet.deliver(frame) if outlet is not None else False

    async def attach(self, conversation_id: str, socket: WebSocket, turn_id: str, after_seq: int) -> bool:
        """Replay one turn from ``after_seq + 1`` onto ``socket``, then go live. False when nothing is known of it.

        Live frames are held while the replay is read, then flushed above the
        last replayed ``seq``, so a frame that arrives both ways is sent once.
        A turn this replica runs (or just ran) is replayed from its own
        sequencer: complete, and needing no bus. Any other turn is read from
        the bus once this socket's relay is subscribed, so a frame published
        between the read and the subscription reaches it through the relay.
        """
        outlet = self.set_socket(conversation_id, socket, holding=True)
        wire = self.wire(conversation_id, turn_id)
        frames = wire.replay() if wire is not None else await self._replay_from_bus(conversation_id, turn_id)
        last = after_seq
        for frame in (frame for frame in frames if frame["seq"] > after_seq):
            await _write(socket, frame)
            last = frame["seq"]
        await _flush(outlet, turn_id, last)
        return bool(frames) or wire is not None

    async def _replay_from_bus(self, conversation_id: str, turn_id: str) -> list[dict[str, Any]]:
        """The turn's frames from the stream; nothing, and so ``turn_not_found``, when the bus cannot be read."""
        ready = self._relay_ready.get(conversation_id)
        if ready is not None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(ready.wait(), timeout=BUS_READY_TIMEOUT_S)
        try:
            return await self.bus().replay_turn(conversation_id, turn_id)
        except BusUnavailable:
            logger.warning("Could not replay turn %s of conversation %s from the bus", turn_id, conversation_id)
            return []

    async def _relay(self, conversation_id: str, ready: asyncio.Event) -> None:
        try:
            async for envelope in self.bus().subscribe_frames(conversation_id, ready):
                await self._deliver_relayed(conversation_id, envelope)
        finally:
            ready.clear()  # until the restarted loop subscribes again

    async def _deliver_relayed(self, conversation_id: str, envelope: Envelope) -> None:
        outlet = self._outlets.get(conversation_id)
        if envelope.type == FRAME and outlet is not None:
            await outlet.deliver(envelope.payload)

    # ---- turns -----------------------------------------------------------
    def running(self, conversation_id: str, turn_id: str | None = None) -> RunningTurn | None:
        turn = self._turns.get(conversation_id)
        if turn is None or (turn_id is not None and turn.wire.turn_id != turn_id):
            return None
        return turn

    async def claim_turn(self, conversation_id: str, turn_id: str) -> bool:
        """Whether ``turn_id`` may run here: nobody runs it locally, and no replica has claimed it.

        The UI resends a question until its ``RUN_STARTED`` arrives, and the
        resend may reach another replica; checking only this process ran the
        turn twice there, interleaving two ``seq`` streams of one turn and
        paying for the answer twice. With the bus down, the claim fails open to
        the local check: a second replica cannot be asked, and the turn must run.
        """
        if self.running(conversation_id, turn_id) is not None:
            return False
        try:
            return await self.bus().claim_turn(conversation_id, turn_id)
        except BusUnavailable:
            logger.warning("Turn %s runs unclaimed: the bus is down", turn_id)
            return True

    async def supersede_elsewhere(self, conversation_id: str, newer_turn_id: str) -> None:
        """Ask the replica running a stale turn of the conversation to stop it, as :meth:`start_turn` does here.

        Two turns of one conversation on two replicas would write one
        LangGraph thread at once. Best-effort: with the bus down there is no
        other replica to reach.
        """
        if not is_multi_replica_bus():
            return
        with contextlib.suppress(BusUnavailable):
            await self.bus().publish_input(conversation_id, SUPERSEDE, {"turn_id": newer_turn_id})

    def _supersede_local(self, conversation_id: str, newer_turn_id: str) -> None:
        stale = self._turns.get(conversation_id)
        if stale is None or stale.wire.turn_id == newer_turn_id or stale.task is None or stale.task.done():
            return
        logger.info("Superseding turn %s in conversation %s", stale.wire.turn_id, conversation_id)
        stale.task.cancel()

    def start_turn(self, turn: RunningTurn) -> None:
        """Register ``turn`` as the conversation's running turn; a stale one is superseded and stopped."""
        conversation_id = turn.wire.conversation_id
        self._supersede_local(conversation_id, turn.wire.turn_id)
        self._turns[conversation_id] = turn
        if is_multi_replica_bus():
            owner_input = _supervise("owner input", conversation_id, lambda: self._owner_input(conversation_id))
            _restart(self._inputs, conversation_id, owner_input)

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
            self._take_input(conversation_id, envelope)

    def _take_input(self, conversation_id: str, envelope: Envelope) -> None:
        if envelope.type in {HITL_ANSWER, CANCEL}:
            self.relayed(envelope.payload)
        elif envelope.type == SUPERSEDE and envelope.origin != self.bus().replica_id:
            self._supersede_local(conversation_id, str((envelope.payload or {}).get("turn_id")))

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


def _log_unexpected_end(task: asyncio.Task[Any]) -> None:
    """A background task's done-callback: read how it ended, and say so loudly when it failed.

    Without it a failure is only asyncio's "Task exception was never
    retrieved", at garbage collection, with no turn or conversation named.
    """
    if task.cancelled() or task.exception() is None:
        return
    logger.error("Task %s ended with an unexpected error", task.get_name(), exc_info=task.exception())


async def _supervise(what: str, conversation_id: str, loop: Callable[[], Awaitable[None]]) -> None:
    """Keep a bus loop running for as long as it is wanted: one that dies is logged and started again.

    A dead relay loop left its socket silent about turns running on other
    replicas, and a dead owner loop left their Stops and answers unheard. What
    was published while it was down is not lost to the reader: the client
    ``attach``es on a ``seq`` gap, or when its heartbeat watchdog gives up, and
    the stream replays it.
    """
    delay = _LOOP_RESTART_MIN_S
    while True:
        started = time.monotonic()
        await _run_loop_once(what, conversation_id, loop)
        if time.monotonic() - started > _LOOP_RESTART_MAX_S:
            delay = _LOOP_RESTART_MIN_S  # it ran healthy for a while: a new outage starts the backoff over
        await asyncio.sleep(delay)
        delay = min(delay * 2, _LOOP_RESTART_MAX_S)


async def _run_loop_once(what: str, conversation_id: str, loop: Callable[[], Awaitable[None]]) -> None:
    try:
        await loop()
    except Exception:
        logger.warning("The %s loop of conversation %s failed; restarting it", what, conversation_id, exc_info=True)
        return
    logger.warning("The %s loop of conversation %s ended; restarting it", what, conversation_id)


def _restart(tasks: dict[str, asyncio.Task[None]], key: str, loop: Awaitable[None]) -> None:
    _stop(tasks, key)
    task = tasks[key] = asyncio.ensure_future(loop)
    task.add_done_callback(_log_unexpected_end)


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


#: ``RUN_ERROR.details`` of a turn its deadline ended, so a log line or a client
#: can tell it from a workflow fault without a new wire code.
DEADLINE_DETAILS = "turn_deadline_exceeded"


def _error_for(exc: Exception) -> RunErrorBody:
    if isinstance(exc, InteractionExpired):
        return RunErrorBody(code="interaction_expired", message="The question was not answered in time.")
    if isinstance(exc, AuthError):
        return RunErrorBody(code="auth_error", message=exc.error_code, details=str(exc))
    if isinstance(exc, TurnDeadlineExceeded):
        return RunErrorBody(
            code="workflow_error",
            message="The answer took too long and was stopped. Please ask again, perhaps more narrowly.",
            details=f"{DEADLINE_DETAILS}: {exc}",
        )
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

    The terminal is guaranteed by the ``finally``, not by the ``except``
    clauses: whatever escapes :func:`_end_turn` (a ``BaseExceptionGroup`` from a
    task group, anything else no clause names) still leaves the reader a
    ``RUN_ERROR`` before it propagates to the task's done-callback, which logs
    it. A turn with no terminal is a spinner that never stops.
    """
    heartbeat = asyncio.create_task(_beat(turn.wire))
    try:
        await _end_turn(turn, request, **drive)
    finally:
        heartbeat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat
        await _ensure_terminal(turn)
        registry.finish_turn(turn)


async def _end_turn(turn: RunningTurn, request: UserMessage, **drive: Any) -> None:
    """Run the turn on its clock, and send the terminal every expected ending owes."""
    try:
        async with turn.deadline.running():
            await _drive(turn, request, **drive)
    except asyncio.CancelledError:
        # Taken, not re-raised: the cancel was ours (Stop, or a newer question),
        # and the turn still owes its reader a terminal.
        asyncio.current_task().uncancel()
        await turn.finish_cancelled()
    except Exception as exc:  # noqa: BLE001 — every failure ends the turn with a RUN_ERROR the client can act on
        logger.warning("Turn %s failed", turn.wire.turn_id, exc_info=True)
        await turn.wire.send(_error_for(exc))


async def _ensure_terminal(turn: RunningTurn) -> None:
    """The last line of the one-terminal rule: a turn that has none yet gets a RUN_ERROR."""
    if turn.wire.finished:
        return
    await turn.wire.send(RunErrorBody(code="workflow_error", message="The turn ended without a result."))


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
        """Accept, gate on the version and the caller, then serve messages until the socket closes."""
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
                logger.warning("Dropping a non-JSON frame on conversation %s", self.bound)
                continue
            await self._receive(raw)

    async def _receive(self, raw: object) -> None:
        kind = _client_type(raw)
        if kind is None:
            logger.warning("Dropping a client message of unknown type on conversation %s", self.bound)
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
        if not await self.registry.claim_turn(conversation_id, message.message_id):
            # Running or ran, here or on another replica: the client attaches instead.
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
            ),
            name=f"chat turn {message.message_id} of {conversation_id}",
        )
        turn.task.add_done_callback(_log_unexpected_end)
        self.registry.start_turn(turn)
        await self.registry.supersede_elsewhere(conversation_id, message.message_id)

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
        """A message for a turn this replica is not running: the owner authorises it, or nobody runs it.

        When the bus cannot carry it, the turn is as good as not found from
        here, and the client is told so rather than left waiting: it ends the
        turn and asks the server for the finished answer, which the owner
        still persists.
        """
        of = message.type
        if not is_multi_replica_bus():
            await self._reject(message.model_dump(), of, "turn_not_found")
            return
        payload = {"message": message.model_dump(mode="json"), "subject": self.subject, "internal": self.internal}
        try:
            await self.registry.bus().publish_input(message.conversation_id, input_type, payload)
        except BusUnavailable:
            unreachable = "The replica running this turn cannot be reached right now."
            await self._reject(message.model_dump(), of, "turn_not_found", unreachable)

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

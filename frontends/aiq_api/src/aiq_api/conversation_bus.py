"""Dragonfly (Redis) pub/sub conversation event bus — the stateless-agent target.

A running turn holds loop-bound state in one process: its task, its pending HITL
future, its sequencer (``chat_socket.RunningTurn``). The socket that watches it
may sit on another replica, so the bus decouples two roles (ADR-0028):

* **owner** — the replica running the turn. It appends every stamped v2 frame
  to the conversation's stream and publishes it.
* **relay** — a replica holding a socket for the conversation. It subscribes
  and writes frames to its socket, and hands ``interaction_response`` and
  ``cancel_turn`` to the owner on the input channel, with who sent them, so the
  owner authorises them itself.

Spectators (ADR-0039) are one more subscriber of the events channel (the BFF's
``/live`` route), and ``attach`` reads a turn back from the stream by its own
``(turn_id, seq)``.

**Fail-open.** With no ``REDIS_URL`` (dev / single node / tests) the bus uses an
in-process transport: publish delivers to same-process subscribers only, and
the stream is a bounded in-process buffer, which is still enough for ``attach``
on the replica that ran the turn. Nothing here is the source of truth — the
persisted answer is; the stream is best-effort (Dragonfly is cache-only,
ADR-0020).

The transport is injectable so the whole protocol is unit-testable over the
in-memory transport with two ``ConversationBus`` instances standing in for two
replicas — no live cluster, no fakeredis dependency.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from typing import Protocol

logger = logging.getLogger(__name__)

# Message types on the envelope (see Envelope.type).
FRAME = "frame"  # owner -> relays: a stamped chat wire v2 event (payload = the frame)
HITL_ANSWER = "hitl_answer"  # relay -> owner: an interaction_response, with who sent it
CANCEL = "cancel"  # relay -> owner: a cancel_turn, with who sent it

# Per-conversation channel / key names. Mirrors ADR-0020's ``citations:{id}`` style.
_EVENTS = "conv:{id}:events"  # owner publishes, relays and spectators subscribe
_INPUT = "conv:{id}:input"  # relays publish, owner subscribes
_STREAM = "conv:{id}:stream"  # Redis stream: replayable copy of every frame, read by `attach`

# Every frame of a turn lands here, and a socket that `attach`es reads back what
# it missed by `(turn_id, seq)`. A v2 turn is a few dozen frames, so the cap
# holds many turns; the TTL bounds a conversation nobody comes back to.
_STREAM_MAXLEN = int(os.environ.get("GRID_CONV_STREAM_MAXLEN", "2000") or "2000")
_STREAM_TTL_SECONDS = int(os.environ.get("GRID_CONV_STREAM_TTL_SECONDS", "3600") or "3600")


@dataclass(frozen=True)
class Envelope:
    """A bus message. The frame it carries names its own turn and ``seq``; the
    envelope only routes it (``origin`` lets a replica skip what it published)."""

    conv: str
    type: str
    payload: Any
    origin: str = ""

    def encode(self) -> str:
        return json.dumps({"conv": self.conv, "origin": self.origin, "type": self.type, "payload": self.payload})

    @staticmethod
    def decode(raw: str) -> Envelope:
        d = json.loads(raw)
        return Envelope(
            conv=d.get("conv", ""), type=d.get("type", ""), payload=d.get("payload"), origin=d.get("origin", "")
        )


class BusTransport(Protocol):
    """Minimal transport the bus needs. Two impls: in-memory and Redis."""

    async def publish(self, channel: str, data: str) -> None: ...
    def subscribe(self, channel: str) -> AsyncIterator[str]: ...
    async def xadd(self, stream: str, data: str, maxlen: int, ttl: int) -> None: ...
    async def xrange(self, stream: str) -> list[str]: ...
    async def close(self) -> None: ...


#: How many conversations' streams the in-process transport keeps. It has no
#: TTL, so without a cap a long-lived single-node process would keep every
#: conversation it ever served; the oldest-written stream is dropped first.
_IN_MEMORY_STREAMS = 256


class InMemoryTransport:
    """Process-local transport. This IS the fail-open / single-node path, and the
    test double for multi-replica (two ConversationBus instances share this one
    module-global broker, so a publish on one is delivered to the other)."""

    def __init__(self) -> None:
        self._subs: dict[str, list[asyncio.Queue[str]]] = {}
        self._streams: OrderedDict[str, list[str]] = OrderedDict()

    async def publish(self, channel: str, data: str) -> None:
        for q in list(self._subs.get(channel, ())):
            q.put_nowait(data)

    async def subscribe(self, channel: str) -> AsyncIterator[str]:
        q: asyncio.Queue[str] = asyncio.Queue()
        self._subs.setdefault(channel, []).append(q)
        try:
            while True:
                yield await q.get()
        finally:
            subs = self._subs.get(channel)
            if subs and q in subs:
                subs.remove(q)

    async def xadd(self, stream: str, data: str, maxlen: int, ttl: int) -> None:
        buf = self._streams.setdefault(stream, [])
        self._streams.move_to_end(stream)
        buf.append(data)
        del buf[: max(0, len(buf) - maxlen)]
        while len(self._streams) > _IN_MEMORY_STREAMS:
            self._streams.popitem(last=False)

    async def xrange(self, stream: str) -> list[str]:
        return list(self._streams.get(stream, ()))

    async def close(self) -> None:
        return None


class RedisTransport:
    """redis.asyncio-backed transport for real multi-replica operation.

    ``client`` may be injected (a redis.asyncio-compatible client, e.g. fakeredis)
    so the transport is testable against real Redis semantics without a server.
    """

    def __init__(self, url: str | None = None, *, client: Any = None) -> None:
        if client is not None:
            # Tests inject a single client; reuse it for both roles.
            self._redis = client
            self._sub_redis = client
            self._owns_clients = False
        else:
            from redis.asyncio import Redis

            # Command client: a short read timeout so publish/xadd fail fast
            # (and the bus fails open) instead of hanging the request path.
            self._redis = Redis.from_url(url, decode_responses=True, socket_timeout=1.0, socket_connect_timeout=1.0)
            # Pub/sub client: subscribe reads BLOCK waiting for the next message,
            # so they must NOT inherit the 1s command timeout — that raised
            # "Timeout reading from <host>" every second and tore down the relay
            # loop. No read timeout here; a periodic health check still detects a
            # genuinely dead connection.
            self._sub_redis = Redis.from_url(
                url,
                decode_responses=True,
                socket_timeout=None,
                socket_connect_timeout=1.0,
                health_check_interval=30,
            )
            self._owns_clients = True

    async def publish(self, channel: str, data: str) -> None:
        await self._redis.publish(channel, data)

    async def subscribe(self, channel: str) -> AsyncIterator[str]:
        pubsub = self._sub_redis.pubsub()
        await pubsub.subscribe(channel)
        try:
            async for msg in pubsub.listen():
                if msg.get("type") == "message":
                    yield msg["data"]
        finally:
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe(channel)
                await pubsub.aclose()

    async def xadd(self, stream: str, data: str, maxlen: int, ttl: int) -> None:
        # One round trip for both: this runs for every frame.
        async with self._redis.pipeline(transaction=False) as pipe:
            pipe.xadd(stream, {"d": data}, maxlen=maxlen, approximate=True)
            pipe.expire(stream, ttl)
            await pipe.execute()

    async def xrange(self, stream: str) -> list[str]:
        entries = await self._redis.xrange(stream)
        return [fields["d"] for _id, fields in entries if "d" in fields]

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            await self._redis.aclose()
        if self._owns_clients:
            with contextlib.suppress(Exception):
                await self._sub_redis.aclose()


class ConversationBus:
    """High-level per-replica handle over a transport. One per process."""

    def __init__(self, transport: BusTransport, replica_id: str | None = None) -> None:
        self._t = transport
        self.replica_id = replica_id or f"{os.environ.get('HOSTNAME', 'local')}:{uuid.uuid4().hex[:8]}"

    # ---- owner -> relays (outbound frames) ------------------------------
    async def publish_frame(self, conv: str, frame: dict[str, Any]) -> None:
        """Append a stamped v2 frame to the replay stream, then publish it to relays and spectators."""
        env = Envelope(conv=conv, type=FRAME, payload=frame, origin=self.replica_id).encode()
        await self._t.xadd(_STREAM.format(id=conv), env, _STREAM_MAXLEN, _STREAM_TTL_SECONDS)
        await self._t.publish(_EVENTS.format(id=conv), env)

    async def subscribe_frames(self, conv: str) -> AsyncIterator[Envelope]:
        """Relay side: yield outbound frames as they are published by the owner.
        Frames this replica itself published are filtered (owner==relay fast
        path writes the socket directly), preventing double delivery."""
        async for raw in self._t.subscribe(_EVENTS.format(id=conv)):
            env = Envelope.decode(raw)
            if env.origin == self.replica_id:
                continue
            yield env

    async def replay_turn(self, conv: str, turn_id: str) -> list[dict[str, Any]]:
        """`attach`: every frame of one turn the stream still holds, in ``seq`` order.

        The cursor is the frame's own ``(turn_id, seq)``, so the stream entry id
        never reaches a client and a turn is read back the same from any replica.
        """
        frames = [Envelope.decode(raw).payload for raw in await self._t.xrange(_STREAM.format(id=conv))]
        mine = [frame for frame in frames if isinstance(frame, dict) and frame.get("turn_id") == turn_id]
        return sorted(mine, key=lambda frame: frame["seq"])

    # ---- relays -> owner (answers / control) ----------------------------
    async def publish_input(self, conv: str, input_type: str, payload: dict[str, Any]) -> None:
        """A relay hands a client message to the owner: ``HITL_ANSWER`` or ``CANCEL``."""
        env = Envelope(conv=conv, type=input_type, payload=payload, origin=self.replica_id)
        await self._t.publish(_INPUT.format(id=conv), env.encode())

    async def subscribe_input(self, conv: str) -> AsyncIterator[Envelope]:
        """Owner side: yield answers + control messages from relays."""
        async for raw in self._t.subscribe(_INPUT.format(id=conv)):
            yield Envelope.decode(raw)

    async def close(self) -> None:
        await self._t.close()


# ---------------------------------------------------------------------------
# Process-global bus. Redis-backed (the stateless architecture) whenever
# REDIS_URL is set and the bus is not explicitly disabled — ON by default. With
# no REDIS_URL it uses the in-process transport (single-process, byte-identical
# to the pre-bus path); the Redis path fails open to local delivery on error.
# Opt out with GRID_CONVERSATION_BUS=0.
# ---------------------------------------------------------------------------
_bus: ConversationBus | None = None
_in_memory_singleton: InMemoryTransport | None = None
_force_multi_for_tests = False


def _bus_enabled() -> bool:
    # Default ON: the stateless conversation bus is the intended architecture.
    # Explicit falsey values opt out (the tier then falls back to affinity /
    # single-process local delivery, byte-identical to the pre-bus path).
    val = os.environ.get("GRID_CONVERSATION_BUS", "1").strip().lower()
    return val not in ("0", "false", "no", "off", "")


def get_bus() -> ConversationBus:
    """Return the process bus. Redis-backed when enabled + REDIS_URL is set,
    else the in-process fail-open transport (identical to pre-bus behavior)."""
    global _bus, _in_memory_singleton
    if _bus is not None:
        return _bus
    url = os.environ.get("REDIS_URL")
    if _bus_enabled() and url:
        try:
            _bus = ConversationBus(RedisTransport(url))
            logger.info("Conversation bus: Redis transport (multi-replica stateless mode)")
            return _bus
        except Exception:
            logger.warning("Conversation bus: Redis init failed; using in-process fallback", exc_info=True)
    if _in_memory_singleton is None:
        _in_memory_singleton = InMemoryTransport()
    _bus = ConversationBus(_in_memory_singleton)
    return _bus


def is_multi_replica_bus() -> bool:
    """True when the bus actually spans replicas (Redis-backed + enabled)."""
    return _force_multi_for_tests or (_bus_enabled() and bool(os.environ.get("REDIS_URL")))


def force_multi_replica_for_tests(transport: InMemoryTransport | None = None) -> ConversationBus:
    """Force multi-replica mode over an in-memory transport (tests only). Returns
    the process bus; peers sharing its transport stand in for other replicas."""
    global _bus, _in_memory_singleton, _force_multi_for_tests
    _in_memory_singleton = transport or InMemoryTransport()
    _bus = ConversationBus(_in_memory_singleton, replica_id="test-owner")
    _force_multi_for_tests = True
    return _bus


def reset_bus_for_tests() -> None:
    global _bus, _in_memory_singleton, _force_multi_for_tests
    _bus = None
    _in_memory_singleton = None
    _force_multi_for_tests = False

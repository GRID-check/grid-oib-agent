"""Dragonfly (Redis) pub/sub conversation event bus — the stateless-agent target.

Today a chat conversation is pinned to one aiq-agent replica because three
pieces of live state live in process memory: the WebSocket handle, the HITL
response ``Future``, and the running LangGraph ``Task`` (see
``websocket_reconnect.WebSocketSessionRegistry``). Conversation affinity
(ADR-0028) hashes each conversation to a fixed replica so reconnect/HITL land
where that state is.

This bus removes the pin by decoupling two roles:

* **owner** — the replica running the turn; it holds the loop-bound ``Future``
  and ``Task`` and *publishes* every outbound frame + HITL prompt.
* **relay** — the replica holding the client's socket; it *subscribes* and
  writes frames to the socket, and *publishes* HITL answers / cancels back.

So any replica can serve any conversation's socket → the tier is stateless.

**Fail-open.** With no ``REDIS_URL`` (dev / single node / tests) the bus uses an
in-process transport: publish delivers to same-process subscribers only, which
is exactly the pre-bus single-replica behavior. Nothing here is the source of
truth — the Postgres LangGraph checkpoint is; the Redis stream buffer used for
reconnect replay is best-effort (Dragonfly is cache-only, ADR-0020).

The transport is injectable so the whole protocol (fan-out ordering, HITL
round-trip, supersede/cancel, reconnect replay, owner election) is unit-testable
over the in-memory transport with two ``ConversationBus`` instances standing in
for two replicas — no live cluster, no fakeredis dependency.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from typing import Protocol

logger = logging.getLogger(__name__)

# Message types on the envelope (see Envelope.type).
FRAME = "frame"  # owner -> relays: an outbound WS frame (payload = the WS message dict)
HITL_ANSWER = "hitl_answer"  # relay -> owner: a human-in-the-loop answer (payload = TextContent dict)
CANCEL = "cancel"  # relay -> owner: cancel the running turn
SUPERSEDE = "supersede"  # relay -> owner: a newer turn is starting; drop the old one
RECONNECT = "reconnect"  # relay -> owner: a socket reattached; re-emit any pending HITL prompt
TURN_END = "turn_end"  # owner -> relays: the turn produced its terminal frame

# Per-conversation channel / key names. Mirrors ADR-0020's ``citations:{id}`` style.
_EVENTS = "conv:{id}:events"  # owner publishes, relays subscribe
_INPUT = "conv:{id}:input"  # relays publish, owner subscribes
_OWNER = "conv:{id}:owner"  # SET NX EX — which replica runs the turn
_STREAM = "conv:{id}:stream"  # Redis stream: replayable copy of events for reconnect

_STREAM_MAXLEN = int(os.environ.get("GRID_CONV_STREAM_MAXLEN", "500") or "500")
_OWNER_TTL_SECONDS = int(os.environ.get("GRID_CONV_OWNER_TTL_SECONDS", "15") or "15")


@dataclass(frozen=True)
class Envelope:
    """A bus message. ``seq`` is monotonic per conversation from the owner, used
    to order live frames and to dedupe a replay/live splice on reconnect."""

    conv: str
    type: str
    payload: Any
    seq: int = 0
    origin: str = ""
    v: int = 1

    def encode(self) -> str:
        return json.dumps(
            {
                "v": self.v,
                "conv": self.conv,
                "seq": self.seq,
                "origin": self.origin,
                "type": self.type,
                "payload": self.payload,
            }
        )

    @staticmethod
    def decode(raw: str) -> Envelope:
        d = json.loads(raw)
        return Envelope(
            conv=d.get("conv", ""),
            type=d.get("type", ""),
            payload=d.get("payload"),
            seq=int(d.get("seq", 0) or 0),
            origin=d.get("origin", ""),
            v=int(d.get("v", 1) or 1),
        )


class BusTransport(Protocol):
    """Minimal transport the bus needs. Two impls: in-memory and Redis."""

    async def publish(self, channel: str, data: str) -> None: ...
    def subscribe(self, channel: str) -> AsyncIterator[str]: ...
    async def xadd(self, stream: str, data: str, maxlen: int) -> None: ...
    async def xrange(self, stream: str) -> list[str]: ...
    async def set_nx_ex(self, key: str, value: str, ttl: int) -> bool: ...
    async def renew(self, key: str, value: str, ttl: int) -> bool: ...
    async def get(self, key: str) -> str | None: ...
    async def delete_if(self, key: str, value: str) -> None: ...
    async def close(self) -> None: ...


class InMemoryTransport:
    """Process-local transport. This IS the fail-open / single-node path, and the
    test double for multi-replica (two ConversationBus instances share this one
    module-global broker, so a publish on one is delivered to the other)."""

    def __init__(self) -> None:
        self._subs: dict[str, list[asyncio.Queue[str]]] = {}
        self._streams: dict[str, list[str]] = {}
        self._keys: dict[str, str] = {}
        self._lock = asyncio.Lock()

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

    async def xadd(self, stream: str, data: str, maxlen: int) -> None:
        buf = self._streams.setdefault(stream, [])
        buf.append(data)
        if len(buf) > maxlen:
            del buf[: len(buf) - maxlen]

    async def xrange(self, stream: str) -> list[str]:
        return list(self._streams.get(stream, ()))

    async def set_nx_ex(self, key: str, value: str, ttl: int) -> bool:
        async with self._lock:
            if key in self._keys:
                return False
            self._keys[key] = value
            return True

    async def renew(self, key: str, value: str, ttl: int) -> bool:
        async with self._lock:
            if self._keys.get(key) == value:
                return True
            if key not in self._keys:
                self._keys[key] = value
                return True
            return False

    async def get(self, key: str) -> str | None:
        return self._keys.get(key)

    async def delete_if(self, key: str, value: str) -> None:
        async with self._lock:
            if self._keys.get(key) == value:
                self._keys.pop(key, None)

    async def close(self) -> None:
        return None


class RedisTransport:
    """redis.asyncio-backed transport for real multi-replica operation."""

    def __init__(self, url: str) -> None:
        from redis.asyncio import Redis

        self._redis = Redis.from_url(url, decode_responses=True, socket_timeout=1.0, socket_connect_timeout=1.0)

    async def publish(self, channel: str, data: str) -> None:
        await self._redis.publish(channel, data)

    async def subscribe(self, channel: str) -> AsyncIterator[str]:
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(channel)
        try:
            async for msg in pubsub.listen():
                if msg.get("type") == "message":
                    yield msg["data"]
        finally:
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe(channel)
                await pubsub.aclose()

    async def xadd(self, stream: str, data: str, maxlen: int) -> None:
        await self._redis.xadd(stream, {"d": data}, maxlen=maxlen, approximate=True)

    async def xrange(self, stream: str) -> list[str]:
        entries = await self._redis.xrange(stream)
        return [fields["d"] for _id, fields in entries if "d" in fields]

    async def set_nx_ex(self, key: str, value: str, ttl: int) -> bool:
        return bool(await self._redis.set(key, value, nx=True, ex=ttl))

    async def renew(self, key: str, value: str, ttl: int) -> bool:
        # Renew only if we still own it (or claim if vacant). Best-effort.
        current = await self._redis.get(key)
        if current is None:
            return bool(await self._redis.set(key, value, nx=True, ex=ttl))
        if current == value:
            await self._redis.expire(key, ttl)
            return True
        return False

    async def get(self, key: str) -> str | None:
        return await self._redis.get(key)

    async def delete_if(self, key: str, value: str) -> None:
        current = await self._redis.get(key)
        if current == value:
            await self._redis.delete(key)

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            await self._redis.aclose()


class ConversationBus:
    """High-level per-replica handle over a transport. One per process."""

    def __init__(self, transport: BusTransport, replica_id: str | None = None) -> None:
        self._t = transport
        self.replica_id = replica_id or f"{os.environ.get('HOSTNAME', 'local')}:{uuid.uuid4().hex[:8]}"
        self._seq: dict[str, int] = {}

    # ---- owner election -------------------------------------------------
    async def claim_owner(self, conv: str) -> bool:
        """Try to become the turn owner for ``conv`` (SET NX EX). True on success."""
        return await self._t.set_nx_ex(_OWNER.format(id=conv), self.replica_id, _OWNER_TTL_SECONDS)

    async def renew_owner(self, conv: str) -> bool:
        return await self._t.renew(_OWNER.format(id=conv), self.replica_id, _OWNER_TTL_SECONDS)

    async def get_owner(self, conv: str) -> str | None:
        return await self._t.get(_OWNER.format(id=conv))

    async def release_owner(self, conv: str) -> None:
        await self._t.delete_if(_OWNER.format(id=conv), self.replica_id)
        self._seq.pop(conv, None)

    # ---- owner -> relays (outbound frames) ------------------------------
    async def publish_frame(self, conv: str, frame: dict, *, terminal: bool = False) -> int:
        """Publish an outbound WS frame; also append to the replay stream. Returns
        the assigned seq. Called from the emit choke point on the owner."""
        seq = self._seq.get(conv, 0) + 1
        self._seq[conv] = seq
        env = Envelope(conv=conv, type=TURN_END if terminal else FRAME, payload=frame, seq=seq, origin=self.replica_id)
        raw = env.encode()
        await self._t.xadd(_STREAM.format(id=conv), raw, _STREAM_MAXLEN)
        await self._t.publish(_EVENTS.format(id=conv), raw)
        return seq

    async def subscribe_frames(self, conv: str) -> AsyncIterator[Envelope]:
        """Relay side: yield outbound frames as they are published by the owner.
        Frames this replica itself published are filtered (owner==relay fast
        path writes the socket directly), preventing double delivery."""
        async for raw in self._t.subscribe(_EVENTS.format(id=conv)):
            env = Envelope.decode(raw)
            if env.origin == self.replica_id:
                continue
            yield env

    async def replay_frames(self, conv: str, after_seq: int = 0) -> list[Envelope]:
        """Reconnect: frames buffered in the stream with seq > after_seq, ordered."""
        out = [Envelope.decode(raw) for raw in await self._t.xrange(_STREAM.format(id=conv))]
        return [e for e in out if e.seq > after_seq]

    # ---- relays -> owner (answers / control) ----------------------------
    async def publish_answer(self, conv: str, text_content: dict) -> None:
        await self._t.publish(
            _INPUT.format(id=conv),
            Envelope(conv=conv, type=HITL_ANSWER, payload=text_content, origin=self.replica_id).encode(),
        )

    async def publish_control(self, conv: str, control_type: str) -> None:
        """control_type in {CANCEL, SUPERSEDE, RECONNECT}."""
        await self._t.publish(
            _INPUT.format(id=conv),
            Envelope(conv=conv, type=control_type, payload=None, origin=self.replica_id).encode(),
        )

    async def subscribe_input(self, conv: str) -> AsyncIterator[Envelope]:
        """Owner side: yield answers + control messages from relays."""
        async for raw in self._t.subscribe(_INPUT.format(id=conv)):
            yield Envelope.decode(raw)

    async def close(self) -> None:
        await self._t.close()


# ---------------------------------------------------------------------------
# Process-global bus. In-memory (fail-open) unless REDIS_URL is set AND the bus
# is explicitly enabled — so multi-replica routing is opt-in until live-validated
# (ADR-0028), and every existing single-replica test/path is byte-unchanged.
# ---------------------------------------------------------------------------
_bus: ConversationBus | None = None
_in_memory_singleton: InMemoryTransport | None = None


def _bus_enabled() -> bool:
    return os.environ.get("GRID_CONVERSATION_BUS", "").lower() in ("1", "true", "yes")


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
    return _bus_enabled() and bool(os.environ.get("REDIS_URL"))


def reset_bus_for_tests() -> None:
    global _bus, _in_memory_singleton
    _bus = None
    _in_memory_singleton = None

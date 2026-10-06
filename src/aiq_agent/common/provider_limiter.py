"""One fleet-wide limiter every model call passes: priority classes, an adaptive limit (ADR-0080).

Chat, research, ingestion and embeddings call models on ONE OpenRouter key, and
each used to bring its own ceiling or none. When the key saturates, nothing
decided that a person waiting on an answer goes before a bulk reindex, and
scaling a worker tier out only added callers. This is the one pool they all
draw from.

## The pool

A Dragonfly sorted set of leases, one per call in flight, sharing the pruning of
``common.lease_slots``: a holder that dies never releases its slot, its lease
ages out instead. What it adds is the ORDER of the wait. A caller that finds the
pool full takes a ticket in the set of its class, and a free slot goes to the
oldest ticket of the highest class waiting (``lease_slots.RANKED_ADMISSION_LUA``):

    chat  >  interactive  >  research  >  bulk

Order is therefore decided by the tickets, not by who happens to poll first, so
a ``bulk`` waiter yields to a ``chat`` waiter however the polls interleave, and
inside a class the longest waiter wins. A waiter that stops polling loses its
ticket after ``TICKET_SECONDS``, so a cancelled task never holds back the class
below it.

## The limit

The pool's size is not a number we know. The provider's real ceiling moves, and
differs by model, so the limit is AIMD, the shape TCP settled on:

* a 429 halves it (not below ``GRID_PROVIDER_LIMIT_FLOOR``), once per
  ``CUT_COOLDOWN_SECONDS``, so the dozen calls that fail together count once;
* each ``GRID_PROVIDER_LIMIT_INTERVAL_SECONDS`` with no 429 adds one (not above
  ``GRID_PROVIDER_LIMIT_CEILING``, where it starts).

It lives in Dragonfly next to the leases, so the whole fleet shares it and a
fresh replica starts at the fleet's value, not at the ceiling.

## The class

A call site does not pass it. The entry point of the work sets it for the task
(``provider_class``): the chat turn is ``chat``, a research job ``research``,
an ingest job ``interactive`` or ``bulk`` by its priority, and anything that
sets nothing is ``interactive``.

## Where it sits

At the two seams every model call already passes (ADR-0074, ``common.openrouter``):
the chat-model contract subclass in ``llm_factory`` (every LangChain call, streamed
or not) and the pinned HTTP transport (the OpenAI SDK clients the embeddings, the
vision model and the reranker use). The VLM lease pool stays outside it as the
narrower ceiling of ingestion: its holder waits for a provider slot only once it
has the right to call.

Never call a model while holding a slot: the pool is finite, and a holder that
waits on another slot can wait on itself.

## A 429

The slot is given back FIRST, the call's ``Retry-After`` is waited out outside
it, and only then does the caller's own retry queue up again, so a rate-limited
call never holds capacity another call could use once the limit lifts. The SDK
clients of the transport retry on their own with that header; the chat seam
sleeps it before re-raising, because the retry layer above it does not read it.

## Failing open

Without the shared store (no ``REDIS_URL``, an outage, a script the server
refuses) every call proceeds, as in every other layer but the budget: a limiter
that turns a cache outage into stalled answers is worse than one that over-admits
for as long as the outage lasts. ``GRID_PROVIDER_LIMITER=off`` turns it off.

Meters (OpenTelemetry API only; the provider is wired in ``aiq_agent.observability``):
``grid.provider.inflight``, ``grid.provider.limit``,
``grid.provider.wait_seconds{class}``, ``grid.provider.throttled_total{model}``.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import logging
import os
import random
import threading
import time
import uuid
from collections.abc import AsyncIterator
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Iterator
from contextlib import asynccontextmanager
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from typing import ParamSpec
from typing import TypeVar

from aiq_agent.common import cache
from aiq_agent.common import lease_slots

logger = logging.getLogger(__name__)

P = ParamSpec("P")
R = TypeVar("R")

CHAT = "chat"
INTERACTIVE = "interactive"
RESEARCH = "research"
BULK = "bulk"
#: Served first to last: a free slot goes to the earliest class with a waiter.
CLASSES = (CHAT, INTERACTIVE, RESEARCH, BULK)
DEFAULT_CLASS = INTERACTIVE

#: The pool of the OpenRouter key. A name, so a second provider key is a second pool.
POOL = "openrouter"

#: How long a lease survives without its holder vouching for it. A held slot is
#: renewed every third of this, so it only has to outlast a few missed renewals.
LEASE_SECONDS = 60.0
#: A slot nobody released is no longer renewed after this: a leak ages out.
MAX_HOLD_SECONDS = 1800.0
#: How long a waiter's ticket lives without a poll.
TICKET_SECONDS = 5.0
#: How often a waiter asks. Ticket order decides who wins, so polls need no jitter.
POLL_SECONDS = 0.15
#: Calls that fail together count as one 429 for the limit.
CUT_COOLDOWN_SECONDS = 2.0
#: The limit forgets itself after this long without traffic.
STATE_TTL_SECONDS = 3600
#: The longest a chat call sleeps a provider's Retry-After before it re-raises.
RETRY_AFTER_CAP_SECONDS = 30.0
_WAIT_WARNING_SECONDS = 30.0

# @environment_variable GRID_PROVIDER_LIMITER
# @category Server
# @type str
# @default on
# @required false
# The fleet-wide model-call limiter (ADR-0080). `off` lets every call through.
# It also lets every call through, by design, when the shared cache is down.
_ENABLED_ENV = "GRID_PROVIDER_LIMITER"

# @environment_variable GRID_PROVIDER_LIMIT_CEILING
# @category Server
# @type int
# @default 128
# @required false
# Model calls in flight across the whole fleet when the provider is not
# rate-limiting: where the adaptive limit starts and the most it recovers to.
_CEILING_ENV = "GRID_PROVIDER_LIMIT_CEILING"

# @environment_variable GRID_PROVIDER_LIMIT_FLOOR
# @category Server
# @type int
# @default 8
# @required false
# The least the adaptive limit falls to however often the provider says 429.
_FLOOR_ENV = "GRID_PROVIDER_LIMIT_FLOOR"

# @environment_variable GRID_PROVIDER_LIMIT_INTERVAL_SECONDS
# @category Server
# @type float
# @default 5
# @required false
# Each interval without a 429 adds one call to the adaptive limit, up to the ceiling.
_INTERVAL_ENV = "GRID_PROVIDER_LIMIT_INTERVAL_SECONDS"

_DEFAULT_CEILING = 128
_DEFAULT_FLOOR = 8
_DEFAULT_INTERVAL_SECONDS = 5.0


class ProviderWaitTimeout(TimeoutError):
    """A call gave up waiting for a provider slot before its own deadline."""


# --------------------------------------------------------------------- config


def enabled() -> bool:
    """Whether the limiter runs at all (``GRID_PROVIDER_LIMITER``)."""
    return os.environ.get(_ENABLED_ENV, "on").strip().lower() not in {"off", "false", "0", "no"}


def _env_number(name: str, default: float, minimum: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return max(minimum, float(raw))
    except ValueError:
        logger.warning("Ignoring %s=%r: not a number", name, raw)
        return default


def limit_ceiling() -> int:
    """Where the adaptive limit starts and the most it recovers to."""
    return int(_env_number(_CEILING_ENV, _DEFAULT_CEILING, 1))


def limit_floor() -> int:
    """The least the adaptive limit falls to, never above the ceiling."""
    return min(int(_env_number(_FLOOR_ENV, _DEFAULT_FLOOR, 1)), limit_ceiling())


def limit_interval_seconds() -> float:
    """How long without a 429 before the limit gains one."""
    return _env_number(_INTERVAL_ENV, _DEFAULT_INTERVAL_SECONDS, 0.0)


# ---------------------------------------------------------------------- class

_CLASS: contextvars.ContextVar[str] = contextvars.ContextVar("grid_provider_class", default=DEFAULT_CLASS)


def current_class() -> str:
    """The priority class of the current task; ``interactive`` when nothing set one."""
    return _CLASS.get()


def _checked(cls: str) -> str:
    if cls not in CLASSES:
        raise ValueError(f"unknown provider class {cls!r}; expected one of {', '.join(CLASSES)}")
    return cls


def class_for_priority(priority: object) -> str:
    """The class of an ingest job's priority: ``bulk`` for ``"bulk"``, otherwise ``interactive``."""
    return BULK if priority == "bulk" else INTERACTIVE


@contextmanager
def provider_class(cls: str) -> Iterator[str]:
    """Run a block, and every task it starts, in priority class ``cls``.

    Work handed to a thread pool inside the block must carry the context along
    (``pool.submit(contextvars.copy_context().run, fn, ...)``); a thread that
    lost it reads the default, ``interactive``.
    """
    token = _CLASS.set(_checked(cls))
    try:
        yield cls
    finally:
        try:
            _CLASS.reset(token)
        except ValueError:
            # Closed from another context (an async generator finalised by the
            # event loop): there is no token to give back, so put the default back.
            _CLASS.set(DEFAULT_CLASS)


@contextmanager
def priority_scope(priority: object) -> Iterator[str]:
    """Run a block in the class of an ingest job's ``priority``; unchanged when the job names none.

    ``interactive`` and ``bulk`` map to the classes of the same name. A job
    without a priority leaves the class its caller set, which is ``interactive``
    when nobody did.
    """
    if priority is None:
        yield current_class()
        return
    with provider_class(class_for_priority(priority)) as cls:
        yield cls


def with_provider_class(cls: str) -> Callable[[Callable[P, Awaitable[R]]], Callable[P, Awaitable[R]]]:
    """Decorate an async entry point so everything it awaits runs in class ``cls``."""
    _checked(cls)

    def decorate(fn: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
        @functools.wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            with provider_class(cls):
                return await fn(*args, **kwargs)

        return wrapper

    return decorate


# ---------------------------------------------------------------------- Lua

# The adaptive limit, then the ranked admission of lease_slots under it.
# KEYS: leases, polls, one ticket set per class (CLASSES order), limit state.
# ARGV: now, lease, ticket ttl, member, rank, floor, ceiling, interval, state ttl.
#
# A limit stamped in the future by a clock that ran ahead is clamped to `now`,
# or it would stop the limit recovering until the rest of the fleet caught up.
ACQUIRE_LUA = (
    """
local classes = 4
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local ticket_ttl = tonumber(ARGV[3])
local member = ARGV[4]
local rank = tonumber(ARGV[5])
local floor_limit = tonumber(ARGV[6])
local ceiling = tonumber(ARGV[7])
local interval = tonumber(ARGV[8])
local state_ttl = tonumber(ARGV[9])
local state = KEYS[3 + classes]

local stored = redis.call('HMGET', state, 'limit', 'changed')
local limit = tonumber(stored[1]) or ceiling
local changed = tonumber(stored[2]) or now
if limit > ceiling then limit = ceiling end
if limit < floor_limit then limit = floor_limit end
if changed > now then changed = now end
if limit < ceiling and now - changed >= interval then
  limit = limit + 1
  redis.call('HSET', state, 'limit', limit, 'changed', now)
  redis.call('EXPIRE', state, state_ttl)
end
"""
    + lease_slots.RANKED_ADMISSION_LUA
)

# The cut: halve the limit unless one already happened within the cooldown.
# KEYS: limit state. ARGV: now, floor, ceiling, cooldown, state ttl. Returns the limit.
THROTTLE_LUA = """
local state = KEYS[1]
local now = tonumber(ARGV[1])
local floor_limit = tonumber(ARGV[2])
local ceiling = tonumber(ARGV[3])
local cooldown = tonumber(ARGV[4])
local state_ttl = tonumber(ARGV[5])

local stored = redis.call('HMGET', state, 'limit', 'cut')
local limit = tonumber(stored[1]) or ceiling
local cut = tonumber(stored[2]) or 0
if limit > ceiling then limit = ceiling end
if cut <= now and now - cut < cooldown then
  return limit
end
limit = math.max(floor_limit, math.floor(limit / 2))
redis.call('HSET', state, 'limit', limit, 'changed', now, 'cut', now)
redis.call('EXPIRE', state, state_ttl)
return limit
"""


def _now() -> float:
    return time.time()


def _keys(pool: str) -> dict[str, Any]:
    base = f"grid:provider:{{{pool}}}"
    return {
        "leases": f"{base}:leases",
        "polls": f"{base}:polls",
        "tickets": [f"{base}:tickets:{cls}" for cls in CLASSES],
        "state": f"{base}:limit",
    }


# -------------------------------------------------------------------- meters

_last_limit: int | None = None
_instruments: tuple[Any, Any, Any] | None = None
_instruments_lock = threading.Lock()


def _meter() -> Any:
    from opentelemetry import metrics

    return metrics.get_meter("aiq_agent.provider_limiter")


def _observe_limit(_options: Any) -> list[Any]:
    from opentelemetry.metrics import Observation

    return [Observation(_last_limit)] if _last_limit is not None else []


def _meters() -> tuple[Any, Any, Any] | None:
    """(inflight, wait seconds, throttled) instruments; None when OpenTelemetry cannot make them."""
    global _instruments
    if _instruments is not None:
        return _instruments
    with _instruments_lock:
        if _instruments is not None:
            return _instruments
        try:
            meter = _meter()
            meter.create_observable_gauge(
                "grid.provider.limit",
                callbacks=[_observe_limit],
                description="The fleet's adaptive limit of model calls in flight",
            )
            _instruments = (
                meter.create_up_down_counter("grid.provider.inflight", description="Model calls holding a slot"),
                meter.create_histogram(
                    "grid.provider.wait_seconds", unit="s", description="Time a call waited for a slot"
                ),
                meter.create_counter("grid.provider.throttled_total", description="Calls the provider answered 429"),
            )
        except Exception:  # noqa: BLE001 - a meter must never fail a model call
            logger.debug("Provider limiter meters unavailable", exc_info=True)
            return None
    return _instruments


def _reset_meters() -> None:
    """Forget the instruments, so the next call builds them from the current meter. Tests only."""
    global _instruments, _last_limit
    with _instruments_lock:
        _instruments = None
        _last_limit = None


def _record(index: int, method: str, value: float, attributes: dict[str, str]) -> None:
    instruments = _meters()
    if instruments is None:
        return
    try:
        getattr(instruments[index], method)(value, attributes)
    except Exception:  # noqa: BLE001 - see _meters
        logger.debug("Provider limiter meter failed", exc_info=True)


def _remember_limit(limit: int) -> None:
    global _last_limit
    _last_limit = limit
    _meters()


# ------------------------------------------------------------------ renewing

_held: dict[str, tuple[str, float]] = {}
_held_lock = threading.Lock()
_renewer: threading.Thread | None = None


def _renew_held() -> None:
    now = time.monotonic()
    with _held_lock:
        stale = [m for m, (_, taken) in _held.items() if now - taken > MAX_HOLD_SECONDS]
        for member in stale:
            del _held[member]
        held = list(_held.items())
    for member in stale:
        logger.warning("Provider slot %s held past %.0fs; no longer renewed", member, MAX_HOLD_SECONDS)
    for member, (leases_key, _) in held:
        cache.eval_script(lease_slots.RENEW_LUA, [leases_key], [_now(), LEASE_SECONDS, member])


def _renew_forever() -> None:
    while True:
        time.sleep(LEASE_SECONDS / 3)
        try:
            _renew_held()
        except Exception:  # noqa: BLE001 - the thread outlives one bad round
            logger.debug("Provider slot renewal failed", exc_info=True)


def _ensure_renewer() -> None:
    """Start the process's one renewal thread; again in a forked child, where the parent's is gone."""
    global _renewer
    if _renewer is not None and _renewer.is_alive():
        return
    with _held_lock:
        if _renewer is not None and _renewer.is_alive():
            return
        _renewer = threading.Thread(target=_renew_forever, daemon=True, name="provider-limiter-renew")
        _renewer.start()


# --------------------------------------------------------------------- leases


@dataclass
class Lease:
    """A held slot, or nothing to give back (the limiter was off or the store was down)."""

    member: str
    cls: str
    held: bool = False
    waited_seconds: float = 0.0
    pool: str = POOL
    _released: bool = False

    def release(self) -> None:
        """Give the slot back. Idempotent; never raises."""
        if not self.held or self._released:
            return
        self._released = True
        with _held_lock:
            _held.pop(self.member, None)
        _record(0, "add", -1, {})
        try:
            cache.eval_script(lease_slots.RELEASE_LUA, [_keys(self.pool)["leases"]], [self.member])
        except Exception:  # noqa: BLE001 - the lease ages out
            logger.debug("Could not release provider slot %s", self.member, exc_info=True)

    async def arelease(self) -> None:
        """:meth:`release` off the event loop, and finished even when the caller is cancelled."""
        if not self.held or self._released:
            return
        await asyncio.shield(asyncio.to_thread(self.release))


def _unheld(cls: str) -> Lease:
    return Lease(member="", cls=cls)


@dataclass(frozen=True)
class _Attempt:
    taken: bool
    limit: int
    in_flight: int


def _attempt(member: str, cls: str, pool: str = POOL) -> _Attempt | None:
    """One try at a slot. None means there is no usable store: fail open."""
    keys = _keys(pool)
    result = cache.eval_script(
        ACQUIRE_LUA,
        [keys["leases"], keys["polls"], *keys["tickets"], keys["state"]],
        [
            _now(),
            LEASE_SECONDS,
            TICKET_SECONDS,
            member,
            CLASSES.index(cls) + 1,
            limit_floor(),
            limit_ceiling(),
            limit_interval_seconds(),
            STATE_TTL_SECONDS,
        ],
    )
    try:
        taken, limit, in_flight = (int(float(v)) for v in result)
    except (TypeError, ValueError):
        return None
    return _Attempt(taken == 1, limit, in_flight)


def _abandon(member: str, pool: str = POOL) -> None:
    """Withdraw a waiter's tickets, and a slot it may have taken as it was cancelled."""
    keys = _keys(pool)
    cache.eval_script(lease_slots.CANCEL_TICKET_LUA, [keys["polls"], *keys["tickets"]], [member])
    cache.eval_script(lease_slots.RELEASE_LUA, [keys["leases"]], [member])


def _granted(member: str, cls: str, attempt: _Attempt, started: float) -> Lease:
    waited = time.monotonic() - started
    with _held_lock:
        _held[member] = (_keys(POOL)["leases"], time.monotonic())
    _ensure_renewer()
    _remember_limit(attempt.limit)
    _record(0, "add", 1, {})
    _record(1, "record", waited, {"class": cls})
    return Lease(member=member, cls=cls, held=True, waited_seconds=waited)


def _check_wait(member: str, cls: str, started: float, max_wait_seconds: float | None, warned: list[float]) -> None:
    """Raise once the caller's deadline passes; otherwise say, now and then, that it is still waiting."""
    waited = time.monotonic() - started
    if max_wait_seconds is not None and waited >= max_wait_seconds:
        raise ProviderWaitTimeout(f"waited {waited:.1f}s for a {cls} provider slot")
    if waited - warned[0] >= _WAIT_WARNING_SECONDS:
        warned[0] = waited
        logger.warning("Still waiting for a %s provider slot after %.0fs", cls, waited)


def acquire(*, cls: str | None = None, max_wait_seconds: float | None = None) -> Lease:
    """Wait for a slot in ``cls`` (default: the task's class) and return it; give it back with ``release``.

    Waits for as long as the pool stays full, or ``max_wait_seconds`` when the
    caller has a latency budget of its own, then raises :class:`ProviderWaitTimeout`.
    Never bypasses a full pool: only a missing store returns an unheld lease.
    """
    cls = _checked(cls) if cls else current_class()
    if not enabled():
        return _unheld(cls)
    member = uuid.uuid4().hex
    started = time.monotonic()
    warned = [0.0]
    try:
        while True:
            attempt = _attempt(member, cls)
            if attempt is None:
                return _unheld(cls)
            if attempt.taken:
                return _granted(member, cls, attempt, started)
            _check_wait(member, cls, started, max_wait_seconds, warned)
            time.sleep(POLL_SECONDS)
    except BaseException:
        _abandon(member)
        raise


async def aacquire(*, cls: str | None = None, max_wait_seconds: float | None = None) -> Lease:
    """:func:`acquire` that waits without blocking the event loop.

    ``asyncio.to_thread`` cannot cancel its worker, so a task cancelled
    mid-attempt would leave a slot it never knew it took. Each attempt is
    therefore shielded and the clean-up chained onto its completion, the shape
    ``turn_admission.admit_turn_async`` settled on for the same reason.
    """
    cls = _checked(cls) if cls else current_class()
    if not enabled():
        return _unheld(cls)
    member = uuid.uuid4().hex
    started = time.monotonic()
    warned = [0.0]
    attempt_future: asyncio.Future[_Attempt | None] | None = None
    try:
        while True:
            attempt_future = asyncio.ensure_future(asyncio.to_thread(_attempt, member, cls))
            attempt = await asyncio.shield(attempt_future)
            if attempt is None:
                return _unheld(cls)
            if attempt.taken:
                return _granted(member, cls, attempt, started)
            _check_wait(member, cls, started, max_wait_seconds, warned)
            await asyncio.sleep(POLL_SECONDS)
    except BaseException:
        _abandon_after(attempt_future, member)
        raise


def _abandon_after(attempt: asyncio.Future | None, member: str) -> None:
    """Withdraw ``member`` once its in-flight attempt has landed, off the event loop."""

    def withdraw(_future: object = None) -> None:
        try:
            asyncio.get_running_loop().run_in_executor(None, _abandon, member)
        except RuntimeError:  # the loop is closing: the ticket and lease age out
            logger.debug("Could not withdraw provider waiter %s", member)

    if attempt is None or attempt.done():
        withdraw()
        return
    attempt.add_done_callback(withdraw)


# ---------------------------------------------------------------------- 429s


def _chain(exc: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def is_rate_limited(exc: BaseException) -> bool:
    """Whether ``exc`` (or what it wraps) is the provider answering 429.

    Also the rate limit that arrives inside a stream as an ``error`` event:
    langchain-openai raises that as a bare error with no status code, which only
    its message names (``rate_limit_exceeded``).
    """
    for error in _chain(exc):
        response = getattr(error, "response", None)
        if 429 in (getattr(error, "status_code", None), getattr(response, "status_code", None)):
            return True
        if "rate_limit_exceeded" in str(error).lower():
            return True
    return False


def retry_after_seconds(exc: BaseException) -> float:
    """The provider's ``Retry-After`` of a 429, capped; 0 when it states none."""
    for error in _chain(exc):
        headers = getattr(getattr(error, "response", None), "headers", None)
        if headers is None:
            continue
        for name, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
            try:
                stated = float(headers.get(name, "")) * scale
            except (TypeError, ValueError):
                continue
            return min(max(stated, 0.0), RETRY_AFTER_CAP_SECONDS)
    return 0.0


def throttle(model: str | None = None) -> None:
    """Record a 429: halve the fleet's limit (once per cooldown). Never raises."""
    _record(2, "add", 1, {"model": model or "unknown"})
    if not enabled():
        return
    try:
        limit = cache.eval_script(
            THROTTLE_LUA,
            [_keys(POOL)["state"]],
            [_now(), limit_floor(), limit_ceiling(), CUT_COOLDOWN_SECONDS, STATE_TTL_SECONDS],
        )
        if limit is not None:
            _remember_limit(int(float(limit)))
            logger.info("Provider answered 429 (%s); the fleet limit is now %s", model or "unknown", limit)
    except Exception:  # noqa: BLE001 - recording a 429 must not fail the call that met it
        logger.debug("Could not record a provider 429", exc_info=True)


async def athrottle(model: str | None = None) -> None:
    """:func:`throttle` off the event loop."""
    await asyncio.shield(asyncio.to_thread(throttle, model))


def _backoff_before_retry(exc: BaseException) -> float:
    """Seconds to sit out a 429, with a little jitter so the callers it stopped do not return together."""
    wait = retry_after_seconds(exc)
    return wait * (0.9 + 0.2 * random.random()) if wait else 0.0


# ---------------------------------------------------------- the one-call forms


@contextmanager
def slot(*, cls: str | None = None, model: str | None = None, max_wait_seconds: float | None = None) -> Iterator[Lease]:
    """Hold a slot for the ``with`` body; a 429 out of it gives the slot back and waits its Retry-After."""
    lease = acquire(cls=cls, max_wait_seconds=max_wait_seconds)
    try:
        yield lease
    except BaseException as exc:
        if is_rate_limited(exc):
            throttle(model)
            lease.release()
            wait = _backoff_before_retry(exc)
            if wait:
                time.sleep(wait)
        raise
    finally:
        lease.release()


@asynccontextmanager
async def aslot(
    *, cls: str | None = None, model: str | None = None, max_wait_seconds: float | None = None
) -> AsyncIterator[Lease]:
    """:func:`slot` for async code."""
    lease = await aacquire(cls=cls, max_wait_seconds=max_wait_seconds)
    try:
        yield lease
    except BaseException as exc:
        if is_rate_limited(exc):
            await athrottle(model)
            await lease.arelease()
            wait = _backoff_before_retry(exc)
            if wait:
                await asyncio.sleep(wait)
        raise
    finally:
        await lease.arelease()

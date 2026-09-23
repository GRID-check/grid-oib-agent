"""A decision model where a decision is a decision: typed answers over a state, never text.

TypeSafe's Jev (a "System One" model, ADR-0064) takes a STATE — a string, a
JSON object or an array — and a map of typed QUESTIONS, and returns one
typed answer per question with a calibrated probability: a ``noul`` is a
yes/no as a probability, a ``choice`` one option of up to 255 with the whole
distribution, a ``score`` a level on an ordered rubric. It generates nothing.
It answers in 70-500 ms for ~$0.04 per million input tokens, which is the
shape of every yes/no this agent used to pay a generative frontier call for:
"is this pool of passages enough to answer the question", "which Richtlinie
does this question need", "does this answer earn a table". Reached through
OpenRouter's alpha Decisions endpoint (``POST /api/alpha/decisions``, model
``typesafe/jev-1.13``) on the key every deployment already holds.

THE RULE EVERY CALLER OBEYS (ADR-0052, restated for a classifier): a decision
made before the answer may only ADD — a fetch run early, a shape attached, a
skill body read in place — and never withhold a tool, a corpus or a round.
A wrong answer costs tokens or a wasted fetch; it must never cost a
capability the answer turns out to need. That is why every function here
returns ``None`` on any failure and why no caller may treat ``None`` as
anything but "run as today".

Two more things are structural rather than advisory. The endpoint is alpha,
so a circuit breaker takes it out of the path after repeated failures
instead of paying a timeout per call; and the state is built from
STRUCTURED FIELDS the caller chose, never from a raw transcript: the vendor
documents that unrelated state degrades accuracy and that adversarial text
in the state can move the answer, and a tool result is data, not an
instruction to the decider.

Language: Jev's primary training language is English; German is "accepted
but currently [of] lower accuracy" (vendor docs, *State*). So instructions
and criteria are written in English and the STATE carries the user's German
verbatim, and the decision eval (``scripts/decision_eval.py``) measures the
result on the loop-eval questions before a use is adopted (ADR-0064).

Not a ZDR route: an org that enforces zero-data-retention routing skips
every decision, as does an org whose own key (BYOK) points anywhere but
OpenRouter, since the endpoint is OpenRouter's.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import threading
import time
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

# @environment_variable GRID_DECISIONS_ENABLED
# @category Agent
# @type bool
# @default true
# @required false
# Whether the decision model (Jev, ADR-0064) is consulted at all. `false`
# runs every turn exactly as it ran before the decisions existed.
ENABLED_ENV = "GRID_DECISIONS_ENABLED"

# @environment_variable GRID_DECISIONS_MODEL
# @category Agent
# @type str
# @default typesafe/jev-1.13
# @required false
# The decision model id on OpenRouter's Decisions endpoint.
MODEL_ENV = "GRID_DECISIONS_MODEL"

# @environment_variable GRID_DECISIONS_URL
# @category Agent
# @type str
# @default https://openrouter.ai/api/alpha/decisions
# @required false
# The Decisions endpoint. Only needed to point at a mock or a proxy; the
# default is derived from the resolved OpenRouter base URL.
URL_ENV = "GRID_DECISIONS_URL"

# @environment_variable GRID_DECISIONS_API_KEY
# @category Agent
# @type str
# @default (OPENROUTER_API_KEY)
# @required false
# A dedicated key for the Decisions endpoint. Falls back to OPENROUTER_API_KEY
# through the shared credential resolver, BYOK first.
DEDICATED_ENV = "GRID_DECISIONS_API_KEY"  # pragma: allowlist secret

DEFAULT_MODEL = "typesafe/jev-1.13"
DEFAULT_PATH = "/api/alpha/decisions"
_FALLBACK_KEY_ENV = "OPENROUTER_API_KEY"
_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
_OPENROUTER_HOST = "openrouter.ai"

#: Upper bound on one decision call. The vendor's envelope is 70-500 ms; a
#: call past this is a call the reader would feel, and the answer it would
#: have given is worth strictly less than the second.
DEFAULT_TIMEOUT_S = 1.5

#: How many decisions ``decide_many`` keeps in flight. TypeSafe's own
#: re-ranking cookbook ran twelve.
DEFAULT_CONCURRENCY = 12

#: The cost-ledger role a decision is filed under (``cost_tracking``): the
#: calls do not go through LangChain, so they are recorded by hand, like the
#: reranker's.
USAGE_ROLE_DECISION = "decision"

#: Why a decision was not made. Stable tokens for the technical record.
SKIPPED_DISABLED = "disabled"
SKIPPED_NO_KEY = "no_key"
SKIPPED_ZDR = "zdr"
SKIPPED_BYOK_HOST = "byok_host"
SKIPPED_BREAKER = "breaker"
SKIPPED_TIMEOUT = "timeout"
SKIPPED_ERROR = "error"

#: Consecutive failures before the breaker opens, and how long it stays open.
#: Module-level: the failure is the endpoint's, not one caller's.
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN_S = 300.0
_breaker_lock = threading.Lock()
_consecutive_failures = 0
_breaker_open_until = 0.0


# ---------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------


def noul(instructions: str, *, true: str, false: str) -> dict[str, Any]:
    """A yes/no question. ``true``/``false`` are the criteria the vendor asks for."""
    return {"type": "noul", "instructions": instructions, "criteria": {"true": true, "false": false}}


def choice(instructions: str, options: Mapping[str, str]) -> dict[str, Any]:
    """One option of ``options`` (key → description); at most 255, single select."""
    if not options or len(options) > 255:
        raise ValueError("a choice needs between 1 and 255 options")
    return {"type": "choice", "instructions": instructions, "criteria": dict(options)}


def score(instructions: str, levels: Sequence[str]) -> dict[str, Any]:
    """A level on an ordered rubric of 2-10 descriptions."""
    if not 2 <= len(levels) <= 10:
        raise ValueError("a score needs between 2 and 10 levels")
    return {"type": "score", "instructions": instructions, "criteria": list(levels)}


# ---------------------------------------------------------------------------
# Answers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Decision:
    """One request's typed answers, with what it cost and how long it took."""

    answers: Mapping[str, Mapping[str, Any]]
    model: str = ""
    latency_ms: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None
    request_id: str | None = None

    def noul(self, key: str) -> float | None:
        """The probability of "yes", or ``None`` when the question was not answered."""
        answer = self.answers.get(key)
        return _probability(answer.get("noul")) if isinstance(answer, Mapping) else None

    def choice(self, key: str) -> tuple[str | None, dict[str, float]]:
        """The chosen option and the whole distribution (empty when unanswered)."""
        answer = self.answers.get(key)
        if not isinstance(answer, Mapping):
            return None, {}
        raw = answer.get("probabilities")
        distribution = (
            {str(option): p for option, value in raw.items() if (p := _probability(value)) is not None}
            if isinstance(raw, Mapping)
            else {}
        )
        chosen = answer.get("choice")
        return (str(chosen) if isinstance(chosen, str) and chosen else None), distribution

    def score(self, key: str) -> float | None:
        answer = self.answers.get(key)
        if not isinstance(answer, Mapping):
            return None
        value = answer.get("score")
        return float(value) if isinstance(value, (int, float)) and math.isfinite(float(value)) else None

    def summary(self) -> dict[str, Any]:
        """The answers as numbers only — what the technical record carries."""
        out: dict[str, Any] = {}
        for key, answer in self.answers.items():
            if not isinstance(answer, Mapping):
                continue
            kind = answer.get("type")
            if kind == "noul":
                out[key] = self.noul(key)
            elif kind == "choice":
                chosen, distribution = self.choice(key)
                out[key] = {"choice": chosen, "p": round(distribution.get(chosen or "", 0.0), 3)}
            elif kind == "score":
                out[key] = self.score(key)
        return out


def _probability(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return min(1.0, max(0.0, number))


# ---------------------------------------------------------------------------
# The call
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Endpoint:
    url: str
    api_key: str
    model: str
    byok: bool = False


@dataclass
class _Outcome:
    """What one attempt produced, for the aggregated record of ``decide_many``."""

    decision: Decision | None = None
    skipped: str | None = None
    detail: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def enabled() -> bool:
    """Whether decisions are switched on for this process (env, default on)."""
    return os.environ.get(ENABLED_ENV, "true").strip().lower() not in {"0", "false", "off", "no"}


def _breaker_open() -> bool:
    with _breaker_lock:
        return time.monotonic() < _breaker_open_until


def _record_failure() -> None:
    global _consecutive_failures, _breaker_open_until
    with _breaker_lock:
        _consecutive_failures += 1
        if _consecutive_failures >= _BREAKER_THRESHOLD:
            _breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_S
            _consecutive_failures = 0
            logger.warning(
                "Decision endpoint failed %d times in a row; off for %.0fs", _BREAKER_THRESHOLD, _BREAKER_COOLDOWN_S
            )


def _record_success() -> None:
    global _consecutive_failures
    with _breaker_lock:
        _consecutive_failures = 0


def reset_breaker() -> None:
    """Close the breaker (tests, and an operator after a fix)."""
    global _consecutive_failures, _breaker_open_until
    with _breaker_lock:
        _consecutive_failures = 0
        _breaker_open_until = 0.0


def _resolve_endpoint_blocking(organization_id: str | None) -> tuple[_Endpoint | None, str | None]:
    """The key, URL and model this decision runs with, or why it cannot run.

    Through the shared credential resolver (BYOK first, then the dedicated
    env, then ``OPENROUTER_API_KEY``), like every other bespoke call site.
    Blocking on a cold BYOK lookup, so the caller runs it off the loop.
    """
    model = os.environ.get(MODEL_ENV, "").strip() or DEFAULT_MODEL
    try:
        from aiq_agent.common.credential_resolution import resolve_llm_credential

        resolved = resolve_llm_credential(
            primary_env=DEDICATED_ENV,
            fallback_envs=(_FALLBACK_KEY_ENV,),
            default_base_url=_DEFAULT_BASE_URL,
            default_model=model,
            organization_id=organization_id,
        )
        api_key, base_url, byok = resolved.api_key, resolved.base_url, resolved.source == "byok"
    except Exception:  # noqa: BLE001 — type only; the message can carry the key
        logger.warning("Decision credential resolution failed; trying the environment directly")
        api_key = os.environ.get(DEDICATED_ENV, "") or os.environ.get(_FALLBACK_KEY_ENV, "")
        base_url, byok = _DEFAULT_BASE_URL, False
    if not api_key:
        return None, SKIPPED_NO_KEY
    parts = urlsplit(base_url or _DEFAULT_BASE_URL)
    if byok and parts.hostname != _OPENROUTER_HOST:
        return None, SKIPPED_BYOK_HOST
    url = (
        os.environ.get(URL_ENV, "").strip()
        or f"{parts.scheme or 'https'}://{parts.netloc or _OPENROUTER_HOST}{DEFAULT_PATH}"
    )
    return _Endpoint(url=url, api_key=api_key, model=model, byok=byok), None


def _zdr_only_blocking() -> bool:
    try:
        from aiq_agent.common.model_overrides import get_zdr_only_from_context

        return bool(get_zdr_only_from_context())
    except Exception:  # noqa: BLE001 — an unknown policy is not a ZDR policy
        return False


async def _endpoint(organization_id: str | None) -> tuple[_Endpoint | None, str | None]:
    if not enabled():
        return None, SKIPPED_DISABLED
    if _breaker_open():
        return None, SKIPPED_BREAKER
    zdr = await asyncio.to_thread(_zdr_only_blocking)
    if zdr:
        return None, SKIPPED_ZDR
    return await asyncio.to_thread(_resolve_endpoint_blocking, organization_id or _context_organization_id())


def _context_organization_id() -> str | None:
    """The request's organization, for a caller that did not name one.

    The knowledge layer decides without an organization id in hand; without
    this, the resolver would skip BYOK and send that org's passages to the
    platform endpoint under the platform key, the one thing the BYOK-host
    guard exists to prevent.
    """
    try:
        from aiq_agent.project_context import get_organization_id_from_context

        return get_organization_id_from_context()
    except Exception:  # noqa: BLE001 — no request context is no organization
        return None


#: The keep-alive client, one per event loop. Measured on 2026-09-22 against
#: the live endpoint: a client built per call answered in ~430 ms, of which
#: ~370 ms was the TLS handshake; the same call on a warm connection took
#: ~60 ms. Keyed by loop because an httpx client is bound to the loop that
#: opened its connections, and the test runner opens a new loop per test.
_shared_client: tuple[Any, Any] | None = None


def _client(timeout: float, transport: Any) -> tuple[Any, bool]:
    """The client for one call, and whether the caller must close it.

    A ``transport`` (tests) gets a throwaway client around it; everything
    else shares the loop's keep-alive client.
    """
    import httpx

    if transport is not None:
        return httpx.AsyncClient(timeout=timeout, transport=transport), True
    global _shared_client
    loop = asyncio.get_running_loop()
    if _shared_client is None or _shared_client[0] is not loop or _shared_client[1].is_closed:
        _shared_client = (
            loop,
            httpx.AsyncClient(
                timeout=timeout,
                limits=httpx.Limits(max_keepalive_connections=8, keepalive_expiry=60.0),
            ),
        )
    return _shared_client[1], False


async def _post(
    endpoint: _Endpoint,
    state: Any,
    questions: Mapping[str, Mapping[str, Any]],
    *,
    timeout: float,
    transport: Any,
) -> _Outcome:
    import httpx

    body = {"model": endpoint.model, "state": state, "questions": dict(questions)}
    started = time.monotonic()
    client, owned = _client(timeout, transport)
    try:
        try:
            response = await client.post(
                endpoint.url,
                json=body,
                timeout=timeout,
                headers={"Authorization": f"Bearer {endpoint.api_key}", "Content-Type": "application/json"},
            )
        finally:
            if owned:
                await client.aclose()
    except httpx.TimeoutException:
        _record_failure()
        return _Outcome(skipped=SKIPPED_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 — a decision is worth less than the turn
        _record_failure()
        return _Outcome(skipped=SKIPPED_ERROR, detail=type(exc).__name__)
    latency_ms = int((time.monotonic() - started) * 1000)
    if response.status_code != 200:
        # 4xx is ours (a malformed question) and must not open the breaker
        # against the endpoint; 5xx/429/529 is theirs and does.
        if response.status_code >= 500 or response.status_code == 429:
            _record_failure()
        logger.warning("Decision endpoint answered HTTP %s", response.status_code)
        return _Outcome(skipped=SKIPPED_ERROR, detail=f"http_{response.status_code}")
    try:
        payload = response.json()
        answers = payload["answers"]
        if not isinstance(answers, Mapping):
            raise TypeError("answers is not an object")
    except Exception as exc:  # noqa: BLE001
        _record_failure()
        return _Outcome(skipped=SKIPPED_ERROR, detail=f"payload_{type(exc).__name__}")
    _record_success()
    usage = payload.get("usage") if isinstance(payload.get("usage"), Mapping) else {}
    cost = usage.get("cost")
    decision = Decision(
        answers=answers,
        model=str(payload.get("model") or endpoint.model),
        latency_ms=latency_ms,
        input_tokens=int(usage.get("input_tokens") or 0),
        output_tokens=int(usage.get("output_tokens") or 0),
        cost_usd=float(cost) if isinstance(cost, (int, float)) else None,
        request_id=str(payload["id"]) if payload.get("id") else None,
    )
    _record_cost(decision, byok=endpoint.byok)
    return _Outcome(decision=decision)


def _record_cost(decision: Decision, *, byok: bool) -> None:
    try:
        from aiq_agent.common.cost_tracking import record_usage_event

        record_usage_event(
            model=decision.model,
            role=USAGE_ROLE_DECISION,
            prompt_tokens=decision.input_tokens,
            completion_tokens=decision.output_tokens,
            cost_usd=decision.cost_usd or 0.0,
            cost_source="provider" if decision.cost_usd is not None else "estimate",
            is_byok=byok,
        )
    except Exception:  # noqa: BLE001 — accounting never takes a decision down
        logger.debug("Decision usage not recorded", exc_info=True)


def _record(slot: str, values: dict[str, Any]) -> None:
    """The technical record of a decision: numbers, never the reader's text."""
    try:
        from aiq_agent.common.turn_status import CHANNEL_TECHNICAL
        from aiq_agent.common.turn_status import push_custom_step

        push_custom_step(
            f"status:decision:{slot}",
            {"kind": "status", "channel": CHANNEL_TECHNICAL, "slot": f"decision:{slot}", "values": values},
        )
    except Exception:  # noqa: BLE001
        logger.debug("Decision record for %s not emitted", slot, exc_info=True)


async def decide(
    state: Any,
    questions: Mapping[str, Mapping[str, Any]],
    *,
    slot: str,
    timeout: float = DEFAULT_TIMEOUT_S,
    organization_id: str | None = None,
    transport: Any = None,
) -> Decision | None:
    """One request: every question over one state; ``None`` on any failure.

    ``slot`` names the decision in the technical record (``status:decision:<slot>``),
    which carries the answers as numbers, the latency, and — when nothing was
    decided — why. ``transport`` is for tests (an ``httpx.MockTransport``).
    """
    if not questions:
        return None
    endpoint, skipped = await _endpoint(organization_id)
    if endpoint is None:
        _record(slot, {"skipped": skipped})
        return None
    outcome = await _post(endpoint, state, questions, timeout=timeout, transport=transport)
    if outcome.decision is None:
        _record(slot, {"skipped": outcome.skipped, **({"detail": outcome.detail} if outcome.detail else {})})
        return None
    decision = outcome.decision
    _record(
        slot,
        {"answers": decision.summary(), "latencyMs": decision.latency_ms, "inputTokens": decision.input_tokens},
    )
    return decision


async def decide_many(
    states: Sequence[Any],
    questions: Mapping[str, Mapping[str, Any]],
    *,
    slot: str,
    timeout: float = DEFAULT_TIMEOUT_S,
    concurrency: int = DEFAULT_CONCURRENCY,
    organization_id: str | None = None,
    transport: Any = None,
) -> list[Decision | None]:
    """The same questions over each state, in parallel; one record for the batch.

    One endpoint resolution for the batch, then at most ``concurrency`` calls
    in flight. A state whose call failed is ``None`` at its index, so a
    caller that scores candidates keeps the unscored ones in their input
    order (the reranker's contract), and a batch that could not run at all is
    all ``None``.
    """
    if not states or not questions:
        return [None] * len(states)
    endpoint, skipped = await _endpoint(organization_id)
    if endpoint is None:
        _record(slot, {"skipped": skipped, "count": len(states)})
        return [None] * len(states)
    gate = asyncio.Semaphore(max(1, concurrency))

    async def _one(state: Any) -> _Outcome:
        async with gate:
            return await _post(endpoint, state, questions, timeout=timeout, transport=transport)

    started = time.monotonic()
    outcomes = await asyncio.gather(*(_one(state) for state in states))
    decided = [outcome.decision for outcome in outcomes]
    made = [d for d in decided if d is not None]
    values: dict[str, Any] = {
        "count": len(states),
        "decided": len(made),
        "latencyMs": int((time.monotonic() - started) * 1000),
        "inputTokens": sum(d.input_tokens for d in made),
    }
    failed = [o.skipped for o in outcomes if o.decision is None and o.skipped]
    if failed:
        values["skipped"] = failed[0]
    _record(slot, values)
    return decided

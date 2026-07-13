# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Unified LLM cost capture and budget enforcement.

One handler, zero per-agent wiring: ``GridCostTracker`` is installed through
LangChain's ``register_configure_hook`` seam, which adds the handler held in a
ContextVar to *every* callback manager configured inside the active context.
Every ``ainvoke``/``astream`` of every chat model in every agent therefore
reports through the same code path — new agents are covered automatically
(the DRY requirement; see docs/architecture/usage-budgets.md and ADR-0015).

Cost source of truth is OpenRouter's usage accounting: every chat completion
response carries a ``usage`` object including ``cost`` (USD),
``prompt_tokens_details.cached_tokens`` and
``completion_tokens_details.reasoning_tokens``; for streaming it arrives on
the final SSE chunk. langchain-openai surfaces that object verbatim as
``llm_output["token_usage"]``. The response/generation id is recorded so any
row can be reconciled against ``GET /api/v1/generation?id=`` after the fact.

Events are written to the auditable ``llm_usage_events`` ledger via the
token-guarded internal BFF endpoint ``POST /api/internal/usage`` — the
``grid_app`` database keeps exactly one writer (the BFF), mirroring the
project-memory client.

Budget enforcement: the BFF resolves the caller's remaining budget at the WS
upgrade and forwards it as ``X-Grid-Budget`` (base64url JSON). The tracker
accumulates in-flight spend and refuses to *start* the next LLM call once the
remaining budget is exhausted (``BudgetExceededError``). A call already in
flight is never cut off, so a single turn can slightly overshoot — a
deliberate soft-limit semantic, documented in the architecture doc.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from threading import Lock
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler

logger = logging.getLogger(__name__)

BUDGET_HEADER = "x-grid-budget"
USER_ID_HEADER = "x-grid-user-id"

_REQUEST_TIMEOUT_SECONDS = 5
_FLUSH_BATCH_SIZE = 5

# Single background worker so ledger writes never block the answer path and
# arrive in order. Daemon thread — a lost final batch on hard shutdown is
# acceptable (the ledger is reconcilable via OpenRouter's generation API).
_flush_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="grid-usage-flush")


class BudgetExceededError(RuntimeError):
    """Raised before an LLM call would start with the budget already exhausted."""

    def __init__(self, scope: str, message: str | None = None) -> None:
        self.scope = scope
        super().__init__(
            message
            or (
                "The organization's LLM budget is exhausted "
                f"(limit scope: {scope}). An org admin can raise limits under Organization → Usage & budgets."
            )
        )


@dataclass
class BudgetSnapshot:
    """Remaining budget (USD) for every scope that applies to this request.

    ``None`` means "no limit configured for that scope". Computed by the BFF
    from the ledger + active budget policies at the WS upgrade / job submit.
    """

    remaining_org_usd: float | None = None
    remaining_user_usd: float | None = None
    remaining_project_usd: float | None = None

    @classmethod
    def from_header(cls, raw: str | None) -> BudgetSnapshot | None:
        if not raw:
            return None
        try:
            padded = raw + "=" * (-len(raw) % 4)
            data = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        except Exception:
            logger.warning("Ignoring malformed %s header", BUDGET_HEADER, exc_info=True)
            return None
        if not isinstance(data, dict):
            return None

        def _num(key: str) -> float | None:
            value = data.get(key)
            return float(value) if isinstance(value, int | float) else None

        return cls(
            remaining_org_usd=_num("remainingOrgUsd"),
            remaining_user_usd=_num("remainingUserUsd"),
            remaining_project_usd=_num("remainingProjectUsd"),
        )

    def exhausted_scope(self, pending_cost_usd: float) -> str | None:
        """The first scope whose remaining budget is used up, if any."""
        for scope, remaining in (
            ("organization", self.remaining_org_usd),
            ("member", self.remaining_user_usd),
            ("project", self.remaining_project_usd),
        ):
            if remaining is not None and pending_cost_usd >= remaining:
                return scope
        return None


@dataclass
class UsageEvent:
    """One LLM generation, as recorded in the ``llm_usage_events`` ledger."""

    model: str | None
    requested_model: str | None
    generation_id: str | None
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    cost_usd: float
    cost_source: str  # 'usage_field' | 'missing'
    is_byok: bool | None

    def to_payload(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "requestedModel": self.requested_model,
            "generationId": self.generation_id,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "totalTokens": self.total_tokens,
            "cachedTokens": self.cached_tokens,
            "reasoningTokens": self.reasoning_tokens,
            "costUsd": self.cost_usd,
            "costSource": self.cost_source,
            "isByok": self.is_byok,
        }


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def extract_usage_event(response: Any) -> UsageEvent | None:
    """Build a UsageEvent from a LangChain ``LLMResult``.

    Reads the OpenRouter usage-accounting object that langchain-openai passes
    through as ``llm_output["token_usage"]`` (extra provider fields such as
    ``cost``/``cost_details`` survive the SDK's ``model_dump``). Returns None
    when the result carries no usage information at all (e.g. cached or
    mocked generations).
    """
    llm_output = getattr(response, "llm_output", None) or {}
    usage = llm_output.get("token_usage") or llm_output.get("usage") or {}

    generation_id = None
    message = None
    try:
        generation = response.generations[0][0]
        message = getattr(generation, "message", None)
    except (AttributeError, IndexError):
        generation = None
    if message is not None:
        generation_id = getattr(message, "id", None)
        response_metadata = getattr(message, "response_metadata", None) or {}
        if not usage:
            usage = response_metadata.get("token_usage") or {}
        # usage_metadata is LangChain's normalized fallback (no cost field).
        if not usage:
            usage_metadata = getattr(message, "usage_metadata", None) or {}
            if usage_metadata:
                usage = {
                    "prompt_tokens": usage_metadata.get("input_tokens", 0),
                    "completion_tokens": usage_metadata.get("output_tokens", 0),
                    "total_tokens": usage_metadata.get("total_tokens", 0),
                }

    if not usage:
        return None

    prompt_details = usage.get("prompt_tokens_details") or {}
    completion_details = usage.get("completion_tokens_details") or {}
    raw_cost = usage.get("cost")
    cost_usd = float(raw_cost) if isinstance(raw_cost, int | float) else 0.0

    return UsageEvent(
        model=llm_output.get("model_name"),
        requested_model=None,  # filled by the tracker from invocation params
        generation_id=generation_id,
        prompt_tokens=_as_int(usage.get("prompt_tokens")),
        completion_tokens=_as_int(usage.get("completion_tokens")),
        total_tokens=_as_int(usage.get("total_tokens")),
        cached_tokens=_as_int(prompt_details.get("cached_tokens")),
        reasoning_tokens=_as_int(completion_details.get("reasoning_tokens")),
        cost_usd=cost_usd,
        cost_source="usage_field" if isinstance(raw_cost, int | float) else "missing",
        is_byok=usage.get("is_byok") if isinstance(usage.get("is_byok"), bool) else None,
    )


class GridCostTracker(BaseCallbackHandler):
    """Request-scoped callback: capture every generation's cost, enforce budget.

    Sync ``BaseCallbackHandler`` methods are invoked for async runs as well
    (LangChain dispatches them via the running loop's executor), so one
    implementation covers ``invoke``/``ainvoke``/``astream`` across all agents.
    """

    # Never swallowed by LangChain's callback error handling:
    raise_error = True
    run_inline = True

    def __init__(
        self,
        *,
        organization_id: str | None,
        user_id: str | None = None,
        project_id: str | None = None,
        conversation_id: str | None = None,
        job_id: str | None = None,
        budget: BudgetSnapshot | None = None,
    ) -> None:
        self.organization_id = organization_id
        self.user_id = user_id
        self.project_id = project_id
        self.conversation_id = conversation_id
        self.job_id = job_id
        self.budget = budget
        self._lock = Lock()
        self._pending: list[UsageEvent] = []
        self._events_recorded = 0
        self._turn_cost_usd = 0.0
        # Requested model per LLM run: deep research fires concurrent LLM
        # calls (possibly on different models), so a single shared slot would
        # attribute one call's usage to whichever model started last. Keyed by
        # the callback run_id; the last-seen value is kept as a fallback for
        # callers that don't propagate run_id.
        self._requested_models: dict[Any, str] = {}
        self._requested_model: str | None = None

    # -- budget gate ---------------------------------------------------------

    def _check_budget(self) -> None:
        if self.budget is None:
            return
        scope = self.budget.exhausted_scope(self._turn_cost_usd)
        if scope is not None:
            logger.warning(
                "Budget exhausted (scope=%s, org=%s, user=%s, project=%s, turn_cost=%.6f USD) — refusing LLM call",
                scope,
                self.organization_id,
                self.user_id,
                self.project_id,
                self._turn_cost_usd,
            )
            raise BudgetExceededError(scope)

    def on_llm_start(self, serialized: dict[str, Any], prompts: list[str], **kwargs: Any) -> None:
        self._capture_requested_model(kwargs)
        self._check_budget()

    def on_chat_model_start(self, serialized: dict[str, Any], messages: Any, **kwargs: Any) -> None:
        self._capture_requested_model(kwargs)
        self._check_budget()

    def _capture_requested_model(self, kwargs: dict[str, Any]) -> None:
        params = kwargs.get("invocation_params") or {}
        model = params.get("model") or params.get("model_name")
        if isinstance(model, str):
            run_id = kwargs.get("run_id")
            with self._lock:
                if run_id is not None:
                    self._requested_models[run_id] = model
                self._requested_model = model

    # -- capture ---------------------------------------------------------------

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        run_id = kwargs.get("run_id")
        with self._lock:
            requested = self._requested_models.pop(run_id, None) if run_id is not None else None
        try:
            event = extract_usage_event(response)
        except Exception:
            logger.warning("Failed to extract LLM usage from response", exc_info=True)
            return
        if event is None:
            return
        event.requested_model = requested or self._requested_model
        with self._lock:
            self._pending.append(event)
            self._events_recorded += 1
            self._turn_cost_usd += event.cost_usd
            should_flush = len(self._pending) >= _FLUSH_BATCH_SIZE
        if should_flush:
            self.flush(wait=False)

    def on_llm_error(self, error: BaseException, **kwargs: Any) -> None:
        # Drop the per-run model entry so failed runs don't accumulate.
        run_id = kwargs.get("run_id")
        if run_id is not None:
            with self._lock:
                self._requested_models.pop(run_id, None)

    # -- ledger flush ----------------------------------------------------------

    @property
    def turn_cost_usd(self) -> float:
        return self._turn_cost_usd

    @property
    def events_recorded(self) -> int:
        return self._events_recorded

    def flush(self, *, wait: bool) -> None:
        """Send pending events to the internal ledger endpoint.

        ``wait=False`` hands the batch to the background worker (answer path);
        ``wait=True`` posts inline (end of turn / job teardown).
        """
        with self._lock:
            batch, self._pending = self._pending, []
        if not batch:
            return
        payload = {
            "organizationId": self.organization_id,
            "userId": self.user_id,
            "projectId": self.project_id,
            "conversationId": self.conversation_id,
            "jobId": self.job_id,
            "events": [event.to_payload() for event in batch],
        }
        if wait:
            _post_usage_events(payload)
        else:
            _flush_executor.submit(_post_usage_events, payload)


def _post_usage_events(payload: dict[str, Any]) -> None:
    """POST one batch to the BFF ledger endpoint. Best-effort, never raises."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        logger.warning("GRID_INTERNAL_API_TOKEN not configured — dropping %d usage events", len(payload["events"]))
        return
    base_url = (
        os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    ).rstrip("/")
    request = urllib.request.Request(
        f"{base_url}/api/internal/usage",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-grid-internal-token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            if response.status not in (200, 201, 202):
                logger.warning("Internal usage endpoint returned %s", response.status)
    except urllib.error.HTTPError as error:
        logger.warning("Internal usage endpoint rejected batch: HTTP %s", error.code)
    except Exception:
        logger.warning("Failed to post usage events to internal endpoint", exc_info=True)


# -- activation ----------------------------------------------------------------

# register_configure_hook adds the handler held here to every callback manager
# LangChain configures while the var is set (inheritable across sub-runs) —
# the single seam that makes cost capture agent-agnostic.
grid_cost_tracker_var: ContextVar[GridCostTracker | None] = ContextVar("grid_cost_tracker", default=None)

try:
    from langchain_core.tracers.context import register_configure_hook

    register_configure_hook(grid_cost_tracker_var, inheritable=True)
    _CONFIGURE_HOOK_INSTALLED = True
except Exception:  # pragma: no cover - defensive against langchain-core API drift
    logger.exception("Could not install LangChain configure hook; LLM cost tracking is DISABLED")
    _CONFIGURE_HOOK_INSTALLED = False


def _read_identity_from_context() -> dict[str, str | None]:
    from aiq_agent.project_context import _read_header
    from aiq_agent.project_context import get_conversation_id_from_context
    from aiq_agent.project_context import get_organization_id_from_context
    from aiq_agent.project_context import get_project_id_from_context

    user_id = _read_header(USER_ID_HEADER)
    return {
        "organization_id": get_organization_id_from_context(),
        "user_id": user_id.strip() if user_id else None,
        "project_id": get_project_id_from_context(),
        "conversation_id": get_conversation_id_from_context(),
    }


def capture_usage_context() -> dict[str, Any] | None:
    """Snapshot identity + raw budget header for handoff to async Dask workers.

    Workers have no live request headers, so the submitting request captures
    both while its context is alive; the runner feeds them back into
    ``track_llm_costs``. Returns None when there is nothing to carry over.
    """
    try:
        from aiq_agent.project_context import _read_header

        identity = _read_identity_from_context()
        raw_budget = _read_header(BUDGET_HEADER)
        if not any(identity.values()) and not raw_budget:
            return None
        return {"identity": identity, "budget_header": raw_budget}
    except Exception:
        logger.debug("Could not capture usage context for async job", exc_info=True)
        return None


@contextmanager
def track_llm_costs(
    *,
    job_id: str | None = None,
    identity: dict[str, str | None] | None = None,
    budget: BudgetSnapshot | None = None,
):
    """Activate cost tracking for the enclosed request/turn.

    Identity and budget default to the live request headers. Yields the
    tracker (also for tests); pending events are flushed on exit. Never lets
    tracking setup/teardown failures break the answer path.
    """
    tracker: GridCostTracker | None = None
    token = None
    try:
        from aiq_agent.project_context import _read_header

        resolved_identity = identity if identity is not None else _read_identity_from_context()
        resolved_budget = budget if budget is not None else BudgetSnapshot.from_header(_read_header(BUDGET_HEADER))
        tracker = GridCostTracker(
            organization_id=resolved_identity.get("organization_id"),
            user_id=resolved_identity.get("user_id"),
            project_id=resolved_identity.get("project_id"),
            conversation_id=resolved_identity.get("conversation_id"),
            job_id=job_id,
            budget=resolved_budget,
        )
        token = grid_cost_tracker_var.set(tracker)
    except Exception:
        logger.warning("Could not activate LLM cost tracking", exc_info=True)
    try:
        yield tracker
    finally:
        if token is not None:
            grid_cost_tracker_var.reset(token)
        if tracker is not None:
            try:
                # Inline post at teardown: a wait=False flush would hand the
                # final batch to the daemon executor, which a worker exiting
                # right after this turn can strand — dropping the last (often
                # largest) cost events. _post_usage_events never raises and is
                # bounded by _REQUEST_TIMEOUT_SECONDS.
                tracker.flush(wait=True)
            except Exception:
                logger.warning("Failed to flush usage events at end of turn", exc_info=True)

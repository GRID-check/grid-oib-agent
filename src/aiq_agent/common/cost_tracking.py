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
the final SSE chunk (no request flag asks for it — OpenRouter's
``usage: {include: true}`` is deprecated and always-on). langchain-openai
surfaces that object verbatim as ``llm_output["token_usage"]`` — on the
**chat-completions** path only. A role on ``api_type: responses`` gets the same
``cost`` and ``is_byok`` on ``response.usage``, but langchain-openai builds a
``ChatResult`` with no ``llm_output`` and a ``response_metadata`` that omits
``usage``, keeping only the normalized token counts. Recording those rows at
``cost: 0`` would make the main answer role (``research_llm``) free on the
ledger and in every budget, so :func:`install_responses_cost_carrier` copies the
provider's accounting onto ``response_metadata`` under
:data:`RESPONSES_ACCOUNTING_KEY`, and :func:`extract_usage_event` reads it
back beside ``usage_metadata``. A row still says ``costSource: missing`` when
the provider sent no cost at all.

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
import functools
import json
import logging
import math
import os
import urllib.error
import urllib.request
from concurrent.futures import Future
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import ContextVar
from contextvars import copy_context
from dataclasses import dataclass
from threading import Lock
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler

logger = logging.getLogger(__name__)

BUDGET_HEADER = "x-grid-budget"
USER_ID_HEADER = "x-grid-user-id"

#: Where a Responses-API message keeps the provider's accounting, which
#: langchain-openai would otherwise drop (see install_responses_cost_carrier).
RESPONSES_ACCOUNTING_KEY = "grid_usage_accounting"
#: The fields of OpenRouter's usage object the ledger prices from.
_ACCOUNTING_FIELDS = ("cost", "is_byok")

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
    """Remaining budget for every scope that applies to this request.

    Two families, one per billing unit (ADR-0053): USD of platform-billed cost
    for an organization the platform bills, tokens for one on its own provider
    key. ``None`` means "no limit configured for that scope and unit". Computed
    by the BFF from the rollup + active budget policies at the WS upgrade /
    job submit. The tracker meters both cost and tokens off the same usage
    object, so it needs no pricing knowledge to enforce either.
    """

    remaining_org_usd: float | None = None
    remaining_user_usd: float | None = None
    remaining_project_usd: float | None = None
    remaining_org_tokens: float | None = None
    remaining_user_tokens: float | None = None
    remaining_project_tokens: float | None = None

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
            remaining_org_tokens=_num("remainingOrgTokens"),
            remaining_user_tokens=_num("remainingUserTokens"),
            remaining_project_tokens=_num("remainingProjectTokens"),
        )

    def exhausted_scope(self, pending_cost_usd: float, pending_tokens: int = 0) -> str | None:
        """The first scope whose remaining budget is used up, in either unit."""
        for scope, remaining_usd, remaining_tokens in (
            ("organization", self.remaining_org_usd, self.remaining_org_tokens),
            ("member", self.remaining_user_usd, self.remaining_user_tokens),
            ("project", self.remaining_project_usd, self.remaining_project_tokens),
        ):
            if remaining_usd is not None and pending_cost_usd >= remaining_usd:
                return scope
            if remaining_tokens is not None and pending_tokens >= remaining_tokens:
                return scope
        return None


#: ``role`` for the calls that are not chat completions and therefore never
#: reach the LangChain callback path. The reranker is the first: one
#: frontier-model call per ``knowledge_search``, on the answer's critical path,
#: which otherwise appears on no ledger at all.
USAGE_ROLE_RERANK = "rerank"

#: Roles for the model calls a document ingestion job makes (``activity`` =
#: ``ingest`` on the ledger). Vision: captions and drawing analysis.
#: Transcription: OCR of scanned or garbled pages. Embedding: the vectors a
#: chunk is stored under (and, inside a chat turn, a query's).
USAGE_ROLE_INGEST_VISION = "ingest_vision"
USAGE_ROLE_INGEST_TRANSCRIPTION = "ingest_transcription"
USAGE_ROLE_EMBEDDING = "embedding"

#: ``activity`` of a document ingestion job's spend (the ledger's CHECK lists it).
USAGE_ACTIVITY_INGEST = "ingest"


@dataclass
class UsageEvent:
    """One model call, as recorded in the ``llm_usage_events`` ledger."""

    model: str | None
    requested_model: str | None
    generation_id: str | None
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    cost_usd: float
    cost_source: str  # 'usage_field' | 'estimate' | 'missing'
    is_byok: bool | None
    #: What the call was FOR, for the events that are not a chat completion by
    #: an agent. ``None`` for those, which is every event the callback path
    #: produces: their role is the agent group the turn already carries.
    role: str | None = None

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
            # Stored as the ledger's `agent_group`. The internal endpoint
            # declares every key (`app/api/internal/usage/route.ts`), and
            # `test_payload_shape_matches_internal_endpoint` reads that file, so
            # a key here the route would silently drop fails the test instead.
            "role": self.role,
        }


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _usage_from_langchain_metadata(usage_metadata: Any, accounting: Any = None) -> dict[str, Any]:
    """LangChain's normalized ``usage_metadata``, reshaped as a provider usage object.

    The token counts a Responses-API call carries. ``_construct_lc_result_from_responses_api``
    returns a ``ChatResult`` with no ``llm_output`` at all and a
    ``response_metadata`` that excludes ``usage``; what survives is this
    normalized view, in which OpenRouter's ``input_tokens_details.cached_tokens``
    has become ``input_token_details.cache_read``. Reading only the three
    scalars is what would silently zero ``cachedTokens`` on every row written by
    an ``api_type: responses`` role.

    ``accounting`` is the provider's ``cost`` and ``is_byok``, which
    :func:`install_responses_cost_carrier` keeps on ``response_metadata``.
    Without it the cost stays absent and is reported as ``missing``.
    """
    if not usage_metadata:
        return {}
    input_details = usage_metadata.get("input_token_details") or {}
    output_details = usage_metadata.get("output_token_details") or {}
    usage: dict[str, Any] = {
        "prompt_tokens": usage_metadata.get("input_tokens", 0),
        "completion_tokens": usage_metadata.get("output_tokens", 0),
        "total_tokens": usage_metadata.get("total_tokens", 0),
        "prompt_tokens_details": {"cached_tokens": input_details.get("cache_read", 0)},
        "completion_tokens_details": {"reasoning_tokens": output_details.get("reasoning", 0)},
    }
    if isinstance(accounting, dict):
        usage.update({key: accounting[key] for key in _ACCOUNTING_FIELDS if key in accounting})
    return usage


def _reported_cost(raw: Any, generation_id: str | None) -> float | None:
    """The provider's ``cost`` in USD when it is a real one, else ``None`` (recorded as ``missing``).

    ``bool`` is an ``int`` in Python, so ``cost: true`` would book $1.00; NaN
    disables the budget gate (every comparison with it is false); and the BFF
    rejects a non-finite or negative cost, dropping the whole batch with it.
    A present value that is none of those is logged, never booked, so a
    malformed field is visible rather than indistinguishable from an absent one.
    """
    if raw is None:
        return None
    if isinstance(raw, int | float) and not isinstance(raw, bool) and math.isfinite(raw) and raw >= 0:
        return float(raw)
    logger.warning("Ignoring malformed provider cost %r on generation %s; recorded as missing", raw, generation_id)
    return None


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
    response_metadata: dict[str, Any] = {}
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
        # usage_metadata is LangChain's normalized fallback: the Responses path,
        # whose cost the carrier kept beside it.
        if not usage:
            usage = _usage_from_langchain_metadata(
                getattr(message, "usage_metadata", None), response_metadata.get(RESPONSES_ACCOUNTING_KEY)
            )

    if not usage:
        return None

    prompt_details = usage.get("prompt_tokens_details") or {}
    completion_details = usage.get("completion_tokens_details") or {}
    cost_usd = _reported_cost(usage.get("cost"), generation_id)

    return UsageEvent(
        # The Responses path has no llm_output; its model is on response_metadata.
        model=llm_output.get("model_name") or response_metadata.get("model_name"),
        requested_model=None,  # filled by the tracker from invocation params
        generation_id=generation_id,
        prompt_tokens=_as_int(usage.get("prompt_tokens")),
        completion_tokens=_as_int(usage.get("completion_tokens")),
        total_tokens=_as_int(usage.get("total_tokens")),
        cached_tokens=_as_int(prompt_details.get("cached_tokens")),
        reasoning_tokens=_as_int(completion_details.get("reasoning_tokens")),
        cost_usd=cost_usd if cost_usd is not None else 0.0,
        cost_source="usage_field" if cost_usd is not None else "missing",
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
        message_id: str | None = None,
        budget: BudgetSnapshot | None = None,
        activity: str | None = None,
    ) -> None:
        self.organization_id = organization_id
        self.user_id = user_id
        self.project_id = project_id
        self.conversation_id = conversation_id
        self.job_id = job_id
        #: The answer this spend belongs to (``turn.response.answer_message_id``),
        #: so the answer's details can show what it cost in the tenant's unit.
        #: ``None`` off the chat path (jobs, the CLI).
        self.message_id = message_id
        #: What kind of work the whole scope is (``USAGE_ACTIVITY_INGEST`` for an
        #: ingestion job); ``None`` for a chat turn, a stage or a research job.
        self.activity = activity
        self.budget = budget
        self._lock = Lock()
        self._pending: list[UsageEvent] = []
        self._events_recorded = 0
        self._turn_cost_usd = 0.0
        #: Provenance tally per ``UsageEvent.cost_source``. The per-event split
        #: stays in ``llm_usage_events``; this exists so the turn's rollup can
        #: say whether its dollar number was reported, estimated, or a mix,
        #: rather than re-inferring provenance from a positive cost.
        self._cost_sources: dict[str, int] = {}
        # Token totals alongside the cost total. The ledger keeps the per-call
        # detail; these exist so an in-process caller that wraps a bounded piece
        # of work — a post-answer stage — can put what it spent on its own
        # telemetry, which `llm_usage_events` cannot answer because it has no
        # stage dimension.
        self._prompt_tokens = 0
        self._completion_tokens = 0
        #: Prompt tokens the provider served from its cache. Summarised once at
        #: the end of the turn — the per-call numbers are in the ledger, but
        #: "did this turn's prefix stay cached across its iterations" is a
        #: question about the turn, and nothing else answers it in the log.
        self._cached_tokens = 0
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
        turn_tokens = self._prompt_tokens + self._completion_tokens
        scope = self.budget.exhausted_scope(self._turn_cost_usd, turn_tokens)
        if scope is not None:
            logger.warning(
                "Budget exhausted (scope=%s, org=%s, user=%s, project=%s, turn_cost=%.6f USD, turn_tokens=%d)"
                " — refusing LLM call",
                scope,
                self.organization_id,
                self.user_id,
                self.project_id,
                self._turn_cost_usd,
                turn_tokens,
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
        self.record(event)

    def record(self, event: UsageEvent) -> None:
        """Put one event on the turn's ledger batch and its running totals.

        The callback path reaches this through :meth:`on_llm_end`; a bespoke
        call site that is not a chat completion — the cross-encoder reranker —
        reaches it through :func:`record_usage_event`. One accumulator either
        way, so a turn's cost is the whole turn's cost and the budget gate sees
        every unit it is supposed to bound.
        """
        with self._lock:
            self._pending.append(event)
            self._events_recorded += 1
            self._turn_cost_usd += event.cost_usd
            self._prompt_tokens += event.prompt_tokens
            self._completion_tokens += event.completion_tokens
            self._cached_tokens += event.cached_tokens
            source = event.cost_source
            self._cost_sources[source] = self._cost_sources.get(source, 0) + 1
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

    @property
    def prompt_tokens(self) -> int:
        """Prompt tokens across every call tracked in this scope."""
        return self._prompt_tokens

    @property
    def completion_tokens(self) -> int:
        """Completion tokens (reasoning included) across every call tracked."""
        return self._completion_tokens

    @property
    def cached_tokens(self) -> int:
        """Prompt tokens read from the provider's prompt cache across this scope."""
        return self._cached_tokens

    def log_prompt_cache_summary(self) -> None:
        """One INFO line per turn: how much of the input the provider had cached.

        Counts only — no prompt text, no identity beyond the org already on
        every other line of this module (ADR-0045). A turn that reports 0 cached
        of a large input is the symptom indexed in
        ``docs/contributing/gotchas.md``: the prefix is being re-read in full on
        every iteration.
        """
        with self._lock:
            prompt_tokens = self._prompt_tokens
            cached = self._cached_tokens
            calls = self._events_recorded
        if prompt_tokens <= 0:
            return
        share = 100.0 * cached / prompt_tokens
        logger.info(
            "[PromptCache] %d call(s): %d/%d input tokens served from cache (%.1f%%), %d uncached",
            calls,
            cached,
            prompt_tokens,
            share,
            prompt_tokens - cached,
        )

    @property
    def cost_source(self) -> str | None:
        """The turn's aggregated provenance: ``usage_field``, ``estimate``, ``mixed``, or ``None``.

        ``mixed`` when the events disagree — a turn that mixes a provider
        cost with an estimate must not claim either alone. ``None`` when
        nothing was recorded, which the caller reads as "infer it yourself"
        rather than as a fabricated provenance.
        """
        with self._lock:
            sources = {source for source, count in self._cost_sources.items() if count}
        if not sources:
            return None
        if len(sources) == 1:
            return next(iter(sources))
        return "mixed"

    def flush(self, *, wait: bool) -> Future[None] | None:
        """Send pending events to the internal ledger endpoint.

        ``wait=False`` hands the batch to the background worker (answer path)
        and returns its future, so a caller that wants the post to have landed
        can await it later; ``wait=True`` posts inline (end of turn / job
        teardown) and returns ``None``. Nothing pending returns ``None``.
        """
        with self._lock:
            batch, self._pending = self._pending, []
        if not batch:
            return None
        payload = {
            "organizationId": self.organization_id,
            "userId": self.user_id,
            "projectId": self.project_id,
            "conversationId": self.conversation_id,
            "jobId": self.job_id,
            "messageId": self.message_id,
            "activity": self.activity,
            "events": [event.to_payload() for event in batch],
        }
        if wait:
            _post_usage_events(payload)
            return None
        return _flush_executor.submit(_post_usage_events, payload)


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


def _provider_accounting(usage: Any) -> dict[str, Any] | None:
    """``cost`` and ``is_byok`` off a Responses ``usage``, SDK model or plain dict."""
    if usage is None:
        return None
    raw = usage if isinstance(usage, dict) else getattr(usage, "model_extra", None) or {}
    if not isinstance(raw, dict):
        return None
    accounting = {key: raw[key] for key in _ACCOUNTING_FIELDS if raw.get(key) is not None}
    return accounting or None


def install_responses_cost_carrier() -> bool:
    """Keep OpenRouter's ``cost`` on the Responses path. ``True`` once installed.

    OpenRouter sends ``usage.cost`` and ``usage.is_byok`` on every Responses
    reply, streamed or not. langchain-openai builds both paths' message in
    ``_construct_lc_result_from_responses_api`` and keeps only the token counts
    from ``usage``. That dropped cost is what the ledger prices credits from.
    Without it every ``research_llm`` call (the main answer) is recorded at
    zero: an answer's details would show only its post-answer stages, and the
    budget would never be charged for the answer itself.

    The wrapper copies the two fields onto each message's ``response_metadata``
    under :data:`RESPONSES_ACCOUNTING_KEY`. The streaming path copies that
    metadata onto its last chunk, so both paths reach ``on_llm_end`` with it.
    Patched at module level because the streaming path calls the function by
    its global name. Idempotent. When langchain-openai renames the function
    this logs an error and returns ``False``;
    ``test_the_carrier_is_installed`` fails on that before a deploy does.
    """
    try:
        from langchain_openai.chat_models import base as lc_openai
    except ImportError:
        return False
    original = getattr(lc_openai, "_construct_lc_result_from_responses_api", None)
    if original is None:
        logger.error("langchain-openai has no _construct_lc_result_from_responses_api; Responses calls record no cost")
        return False
    if getattr(original, "__grid_cost_carrier__", False):
        return True

    @functools.wraps(original)
    def construct(response: Any, *args: Any, **kwargs: Any) -> Any:
        result = original(response, *args, **kwargs)
        try:
            accounting = _provider_accounting(getattr(response, "usage", None))
            if accounting:
                for generation in result.generations:
                    generation.message.response_metadata[RESPONSES_ACCOUNTING_KEY] = dict(accounting)
        except Exception:  # noqa: BLE001 - accounting must never break an answer
            logger.warning("Could not carry the Responses usage cost", exc_info=True)
        return result

    construct.__grid_cost_carrier__ = True  # type: ignore[attr-defined]
    lc_openai._construct_lc_result_from_responses_api = construct
    return True


_RESPONSES_COST_CARRIER_INSTALLED = install_responses_cost_carrier()


def record_usage_event(
    *,
    model: str | None,
    role: str,
    prompt_tokens: int,
    completion_tokens: int = 0,
    total_tokens: int | None = None,
    cost_usd: float = 0.0,
    cost_source: str = "estimate",
    is_byok: bool | None = None,
) -> bool:
    """Record a model call that does NOT go through LangChain. ``True`` if it landed.

    The tracker is installed for every chat completion by a hook on LangChain's
    callback manager, so a call that is not a chat completion never reaches it.
    The cross-encoder rerank is one such call: one frontier-model call per
    ``knowledge_search``, made with `httpx` against a `/rerank` endpoint, which
    would otherwise appear on no ledger, in no budget, and under no org's own
    key.

    Attribution is the ambient tracker's: organization, user, project and
    conversation are the turn's, resolved once by :func:`track_llm_costs`. A
    call made outside a turn (an ingest thread, a CLI run) has no tracker and
    is not recorded — the same answer the callback path gives, and the reason
    this returns a bool instead of raising.

    ``cost_source`` defaults to ``estimate`` on purpose: a rerank endpoint that
    reports no usage still costs money, and a row that says "estimate" is
    honest about which number it is, where a zero would read as free.
    """
    tracker = grid_cost_tracker_var.get()
    if tracker is None:
        return False
    try:
        tracker.record(
            UsageEvent(
                model=model,
                requested_model=model,
                generation_id=None,
                prompt_tokens=max(0, prompt_tokens),
                completion_tokens=max(0, completion_tokens),
                total_tokens=max(0, total_tokens if total_tokens is not None else prompt_tokens + completion_tokens),
                cached_tokens=0,
                reasoning_tokens=0,
                cost_usd=max(0.0, cost_usd),
                cost_source=cost_source,
                is_byok=is_byok,
                role=role,
            )
        )
    except Exception:  # noqa: BLE001 - accounting must never take a search down
        logger.warning("Could not record a %s usage event", role, exc_info=True)
        return False
    return True


def _usage_event_from_openai(response: Any, *, role: str, requested_model: str | None) -> UsageEvent | None:
    """A UsageEvent from a raw ``openai`` SDK response (chat completion or embedding), or None."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    raw = usage.model_dump() if hasattr(usage, "model_dump") else dict(usage) if isinstance(usage, dict) else {}
    generation_id = getattr(response, "id", None)
    prompt_details = raw.get("prompt_tokens_details") or {}
    completion_details = raw.get("completion_tokens_details") or {}
    prompt_tokens = _as_int(raw.get("prompt_tokens"))
    completion_tokens = _as_int(raw.get("completion_tokens"))
    cost_usd = _reported_cost(raw.get("cost"), generation_id)
    is_byok = raw.get("is_byok")
    return UsageEvent(
        model=getattr(response, "model", None) or requested_model,
        requested_model=requested_model,
        generation_id=generation_id if isinstance(generation_id, str) else None,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=_as_int(raw.get("total_tokens")) or prompt_tokens + completion_tokens,
        cached_tokens=_as_int(prompt_details.get("cached_tokens") if isinstance(prompt_details, dict) else 0),
        reasoning_tokens=_as_int(
            completion_details.get("reasoning_tokens") if isinstance(completion_details, dict) else 0
        ),
        cost_usd=cost_usd if cost_usd is not None else 0.0,
        cost_source="usage_field" if cost_usd is not None else "missing",
        is_byok=is_byok if isinstance(is_byok, bool) else None,
        role=role,
    )


def _metered(create: Any, role: str) -> Any:
    @functools.wraps(create)
    def call(*args: Any, **kwargs: Any) -> Any:
        response = create(*args, **kwargs)
        tracker = grid_cost_tracker_var.get()
        if tracker is not None:
            try:
                event = _usage_event_from_openai(response, role=role, requested_model=kwargs.get("model"))
                if event is not None:
                    tracker.record(event)
            except Exception:  # noqa: BLE001 - accounting must never fail the call it measures
                logger.warning("Could not record a %s usage event", role, exc_info=True)
        return response

    call.__grid_metered__ = True  # type: ignore[attr-defined]
    return call


def meter_openai_client(client: Any, *, role: str) -> Any:
    """Record the usage of every chat completion and embedding ``client`` makes; returns it.

    The calls that never pass LangChain (ingestion's vision and transcription
    calls, the embeddings llama-index makes through its own ``openai`` client)
    would reach no ledger: the response's ``usage``, with OpenRouter's ``cost``
    in it, would be read for nothing and dropped. This wraps the client's two create
    methods in place. Attribution is the ambient tracker's, as for
    :func:`record_usage_event`: inside an ingestion job that is the job's
    organization, project and uploader under ``activity = ingest``; inside a
    chat turn (a query embedding) it is the turn's; with no tracker nothing is
    recorded. Idempotent.
    """
    for resource_name in ("chat.completions", "embeddings"):
        try:
            resource = client
            for part in resource_name.split("."):
                resource = getattr(resource, part)
        except AttributeError:
            continue
        create = getattr(resource, "create", None)
        if create is None or getattr(create, "__grid_metered__", False):
            continue
        resource.create = _metered(create, role)
    return client


def submit_in_context(executor: Any, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:
    """``executor.submit`` that runs ``fn`` in a copy of the caller's context.

    A pool thread starts with an empty context, so the cost tracker (a
    ContextVar) does not reach the work handed to it: without the copy, every
    vision call an ingestion job fans out to its pool would run with no ledger. One copy per call,
    because a single ``Context`` cannot be entered by two threads at once.
    """
    return executor.submit(copy_context().run, fn, *args, **kwargs)


def _read_identity_from_context() -> dict[str, str | None]:
    from aiq_agent.project_context import _read_header
    from aiq_agent.project_context import get_conversation_id_from_context
    from aiq_agent.project_context import get_organization_id_from_context
    from aiq_agent.project_context import get_project_id_from_context
    from aiq_agent.project_context import get_signed_request_context

    # The user the spend is booked to, and whose per-user budget it draws on:
    # signed when an envelope arrived, like the organization beside it.
    envelope = get_signed_request_context()
    user_id = envelope.user_id if envelope is not None else _read_header(USER_ID_HEADER)
    return {
        "organization_id": get_organization_id_from_context(),
        "user_id": user_id.strip() if user_id else None,
        "project_id": get_project_id_from_context(),
        "conversation_id": get_conversation_id_from_context(),
    }


def _read_budget_header_from_context() -> str | None:
    """The budget snapshot in its header encoding, from the signed envelope first.

    The header shape (base64url JSON) is kept because it is what
    ``capture_usage_context`` hands a worker and ``BudgetSnapshot.from_header``
    reads. A client that could set the unsigned header could have given itself
    an unlimited budget; with an envelope present that header is never read.
    """
    from aiq_agent.project_context import _read_header
    from aiq_agent.project_context import get_signed_request_context

    envelope = get_signed_request_context()
    if envelope is None:
        return _read_header(BUDGET_HEADER)
    if not envelope.budget:
        return None
    raw = json.dumps(envelope.budget, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def capture_usage_context() -> dict[str, Any] | None:
    """Snapshot identity + raw budget header for handoff to async Dask workers.

    Workers have no live request headers, so the submitting request captures
    both while its context is alive; the runner feeds them back into
    ``track_llm_costs``. Returns None when there is nothing to carry over.
    """
    try:
        identity = _read_identity_from_context()
        raw_budget = _read_budget_header_from_context()
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
    inline_flush: bool = True,
    activity: str | None = None,
):
    """Activate cost tracking for the enclosed request/turn.

    Identity and budget default to the live request headers. Yields the
    tracker (also for tests); pending events are flushed on exit. Never lets
    tracking setup/teardown failures break the answer path.

    ``inline_flush=False`` leaves the final batch pending for the caller to
    post once the answer is on the wire (``profiler.flush_after_answer``);
    the chat turn uses it so the ledger POST stays off the event loop between the
    finished answer and its first delta. Every other caller keeps
    the inline post, which is what a worker about to exit needs.
    """
    tracker: GridCostTracker | None = None
    token = None
    try:
        resolved_identity = identity if identity is not None else _read_identity_from_context()
        resolved_budget = budget
        if resolved_budget is None:
            resolved_budget = BudgetSnapshot.from_header(_read_budget_header_from_context())
        tracker = GridCostTracker(
            organization_id=resolved_identity.get("organization_id"),
            user_id=resolved_identity.get("user_id"),
            project_id=resolved_identity.get("project_id"),
            conversation_id=resolved_identity.get("conversation_id"),
            job_id=job_id,
            message_id=resolved_identity.get("message_id"),
            budget=resolved_budget,
            activity=activity,
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
            tracker.log_prompt_cache_summary()
        if tracker is not None and inline_flush:
            try:
                # Inline post at teardown: a wait=False flush would hand the
                # final batch to the daemon executor, which a worker exiting
                # right after this turn can strand — dropping the last (often
                # largest) cost events. _post_usage_events never raises and is
                # bounded by _REQUEST_TIMEOUT_SECONDS.
                tracker.flush(wait=True)
            except Exception:
                logger.warning("Failed to flush usage events at end of turn", exc_info=True)

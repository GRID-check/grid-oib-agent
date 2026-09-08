"""Custom middleware for the deep research agent."""

import asyncio
import logging
from collections.abc import Iterable
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware import ToolRetryMiddleware
from langchain.agents.middleware.types import ModelResponse
from langchain.agents.structured_output import ProviderStrategy
from langchain_core.messages import AIMessage
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphBubbleUp

from aiq_agent.common import get_source_id_for_tool
from aiq_agent.common.budget_guard import RunBudgetExceededError
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import _normalize_url
from aiq_agent.common.citation_verification import _parse_citation_key
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.citation_verification import get_session_registry
from aiq_agent.common.cost_tracking import BudgetExceededError
from aiq_agent.common.deferred_tool_loading import tool_payload_name

logger = logging.getLogger(__name__)


def is_retryable_tool_error(exc: Exception) -> bool:
    """Return whether a tool exception represents a transient failure worth retrying.

    ValueError is the deliberate "invalid input / invalid result" signal used by
    our tools (e.g. run_research_batch rejecting oversized batches, researcher
    workers returning malformed ResearchNotes). Re-executing the same call
    cannot fix it — the MODEL has to change its input — so it must reach the
    model immediately instead of burning retries.

    Budget exhaustion (the per-run completion-token ceiling
    ``RunBudgetExceededError`` and the USD-denominated
    ``cost_tracking.BudgetExceededError``) is likewise never retryable, but for
    the opposite reason: it is TERMINAL, not model-fixable. Retrying burns the
    very tokens that are gone — and inside ``run_research_batch`` the tracker
    stays exceeded, so every resubmission fails again and the orchestrator loops
    to the wall-clock cutoff. Budget errors must propagate, never become a
    resubmittable error ToolMessage.
    """
    if isinstance(exc, (RunBudgetExceededError, BudgetExceededError)):
        return False
    return not isinstance(exc, ValueError)


class SelectiveToolRetryMiddleware(ToolRetryMiddleware):
    """ToolRetryMiddleware that never re-executes designated tools.

    Some tools raise errors as deliberate signals for the MODEL (e.g.
    run_research_batch raises RuntimeError on partial failure so the
    orchestrator can resubmit only the failed queries). Blindly re-executing
    such a tool re-runs all its already-successful expensive work below the
    LLM. Tools listed in ``no_retry_tools`` are executed exactly once; their
    failures are converted to error ToolMessages immediately so the model can
    react.
    """

    def __init__(self, *, no_retry_tools: Iterable[str] = (), **kwargs) -> None:
        super().__init__(**kwargs)
        self.no_retry_tools = set(no_retry_tools)

    @staticmethod
    def _request_tool_name(request) -> str:
        return request.tool.name if request.tool else request.tool_call["name"]

    def _handle_failure(self, tool_name: str, tool_call_id: str | None, exc: Exception, attempts_made: int):
        """Never convert budget exhaustion into a resubmittable error ToolMessage.

        The base retry loop calls this only after exhausting retries, and the
        ``no_retry_tools`` path below calls it directly — both would otherwise
        turn a terminal budget error into "Please try again" for the model.
        Re-raise so the run aborts to the salvage path instead of looping to
        the wall clock. This is the safety net regardless of caller; the
        ``except`` clauses below re-raise first for clarity.
        """
        if isinstance(exc, (RunBudgetExceededError, BudgetExceededError)):
            raise exc
        return super()._handle_failure(tool_name, tool_call_id, exc, attempts_made)

    def wrap_tool_call(self, request, handler):
        """Run tools so failures reach the model as error ToolMessages, not crashes.

        ``no_retry_tools`` are executed exactly once. Other tools go through the
        base retry loop. In langchain>=1.x the base loop *re-raises* a
        non-retryable tool error (one ``retry_on`` rejects, e.g. our deliberate
        ValueError signal) instead of returning it as an error ToolMessage, so
        we convert it here — the MODEL has to change its input, and it can only
        do that if the error reaches it. Control-flow signals (``GraphBubbleUp``:
        interrupts, parent Commands) must always propagate. Budget-exhaustion
        errors (token ceiling or USD budgets) are terminal and likewise always
        propagate — never a retryable ToolMessage, regardless of tool.
        """
        tool_name = self._request_tool_name(request)
        try:
            if tool_name in self.no_retry_tools:
                return handler(request)
            return super().wrap_tool_call(request, handler)
        except GraphBubbleUp:
            raise
        except (RunBudgetExceededError, BudgetExceededError):
            raise
        except Exception as exc:  # noqa: BLE001 - converted to an error ToolMessage for the model
            return self._handle_failure(tool_name, request.tool_call["id"], exc, 1)

    async def awrap_tool_call(self, request, handler):
        """Async mirror of :meth:`wrap_tool_call`."""
        tool_name = self._request_tool_name(request)
        try:
            if tool_name in self.no_retry_tools:
                return await handler(request)
            return await super().awrap_tool_call(request, handler)
        except GraphBubbleUp:
            raise
        except (RunBudgetExceededError, BudgetExceededError):
            raise
        except Exception as exc:  # noqa: BLE001 - converted to an error ToolMessage for the model
            return self._handle_failure(tool_name, request.tool_call["id"], exc, 1)


def _replace_tool_content(msg: ToolMessage, content: str) -> ToolMessage:
    """A copy of ``msg`` carrying ``content``, keeping the identity fields."""
    return ToolMessage(content=content, tool_call_id=msg.tool_call_id, name=getattr(msg, "name", None), id=msg.id)


class EmptyContentFixMiddleware(AgentMiddleware):
    """
    Middleware that fixes empty ToolMessage content.

    Some LLM APIs (e.g., NVIDIA, OpenAI) reject messages with empty content.
    This middleware ensures all ToolMessages have non-empty content by
    replacing empty strings with a placeholder.
    """

    def __init__(self, placeholder: str = "empty content received."):
        """
        Initialize the middleware.

        Args:
            placeholder: Text to use when ToolMessage content is empty.
        """
        self.placeholder = placeholder

    async def awrap_model_call(self, request, handler):
        """Fix empty ToolMessage content before sending to the model."""
        fixed_messages = [
            _replace_tool_content(msg, self.placeholder) if isinstance(msg, ToolMessage) and not msg.content else msg
            for msg in request.messages
        ]
        return await handler(request.override(messages=fixed_messages))


# Common hallucinated tool name mappings
_TOOL_NAME_ALIASES: dict[str, str] = {
    "open_file": "read_file",
    "find": "grep",
    "find_file": "glob",
}


class ToolNameSanitizationMiddleware(AgentMiddleware):
    """
    Middleware that sanitizes corrupted tool names in LLM responses.

    LLMs sometimes generate malformed tool calls with suffixes like
    <|channel|>commentary or .exec, or hallucinate tool names like
    open_file or find. This middleware intercepts the model response
    and fixes tool names before the framework dispatches them.
    """

    def __init__(self, valid_tool_names: list[str]):
        self.valid_tool_names = set(valid_tool_names)

    def _sanitize_tool_name(self, name: str) -> str:
        """Sanitize a potentially corrupted tool name.

        Returns the cleaned name if it maps to a valid tool,
        otherwise returns the original name unchanged.
        """
        # 1. Strip <|channel|> and everything after
        if "<|channel|>" in name:
            candidate = name.split("<|channel|>", maxsplit=1)[0]
            if candidate in self.valid_tool_names:
                logger.info("Sanitized tool name: '%s' -> '%s'", name, candidate)
                return candidate

        # 2. Strip dot suffix if base name is valid
        if "." in name:
            candidate = name.split(".", maxsplit=1)[0]
            if candidate in self.valid_tool_names:
                logger.info("Sanitized tool name: '%s' -> '%s'", name, candidate)
                return candidate

        # 3. Map common hallucinated names
        if name in _TOOL_NAME_ALIASES:
            mapped = _TOOL_NAME_ALIASES[name]
            if mapped in self.valid_tool_names:
                logger.info("Mapped tool name: '%s' -> '%s'", name, mapped)
                return mapped

        return name

    def _sanitize_message(self, msg: Any) -> Any:
        """The message with its tool-call names sanitised, or the same object when clean.

        ``model_copy`` preserves usage_metadata, additional_kwargs and
        response_metadata — rebuilding the AIMessage from scratch dropped them
        and broke usage accounting downstream.
        """
        if not isinstance(msg, AIMessage) or not msg.tool_calls:
            return msg
        tool_calls = [{**tc, "name": self._sanitize_tool_name(tc["name"])} for tc in msg.tool_calls]
        if all(new["name"] == old["name"] for new, old in zip(tool_calls, msg.tool_calls, strict=True)):
            return msg
        return msg.model_copy(update={"tool_calls": tool_calls})

    async def awrap_model_call(self, request, handler):
        """Intercept model response and sanitize tool names."""
        response = await handler(request)
        result = [self._sanitize_message(msg) for msg in response.result]
        if all(new is old for new, old in zip(result, response.result, strict=True)):
            return response
        return ModelResponse(result=result, structured_response=response.structured_response)


class DeferredStructuredOutputMiddleware(AgentMiddleware):
    """Apply a strict structured-output contract only on the agent's exit turn.

    ``create_agent(response_format=ProviderStrategy(..., strict=True))`` binds
    ``response_format: json_schema strict`` on EVERY model call of the tool
    loop. OpenRouter/DeepSeek-class endpoints do not reliably combine tools
    with a strict schema: the constrained decoder satisfies the schema
    immediately — a schema-valid but empty (or hallucinated) structured answer
    with no tool calls on turn 1 — so the agent never researches (backlog
    T2-8; reproduced live against deepseek/deepseek-v4-flash, where the
    "researched" notes were fabricated from model memory).

    This middleware decouples the two concerns. The tool loop runs with no
    ``response_format`` at all; only when the model stops calling tools is the
    call re-issued once — draft message appended, strict schema applied — so
    the model formats the answer it already researched instead of deciding
    whether to research under a decoding constraint. The parsed object lands
    in ``structured_response`` exactly as with
    ``create_agent(response_format=...)``.

    If the formatting call itself fails (e.g. a provider schema rejection),
    the draft response is returned unchanged so downstream content-based
    recovery (``extract_json`` in ``tools/research.py``) still applies.
    """

    def __init__(self, schema: Any) -> None:
        self.strategy = ProviderStrategy(schema, strict=True)

    async def awrap_model_call(self, request, handler):
        """Keep the tool loop format-free; re-issue the exit turn with the strict schema."""
        response = await handler(request)
        draft = response.result[-1] if response.result else None
        if not isinstance(draft, AIMessage) or draft.tool_calls:
            return response
        try:
            return await handler(
                request.override(
                    messages=[*request.messages, draft],
                    response_format=self.strategy,
                )
            )
        except Exception:
            logger.warning(
                "Structured-output formatting call failed; returning unformatted draft",
                exc_info=True,
            )
            return response


def _request_tool_name(tool: object) -> str | None:
    """Return a LangChain model-request tool name across common tool shapes.

    One implementation, in ``common.deferred_tool_loading``, because the
    deferred-tool payload builder has to read tool identity out of exactly the
    same three shapes and a second traversal would drift from this one.
    """
    return tool_payload_name(tool)


class ToolVisibilityMiddleware(AgentMiddleware):
    """Hide selected tools from model requests without removing scaffolding middleware."""

    def __init__(self, hidden_tool_names: set[str]) -> None:
        self.hidden_tool_names = hidden_tool_names

    def _filter_tools(self, tools: list[object]) -> list[object]:
        if not self.hidden_tool_names:
            return tools
        return [tool for tool in tools if _request_tool_name(tool) not in self.hidden_tool_names]

    def wrap_model_call(self, request, handler):
        """Filter hidden tools before a synchronous model call."""
        return handler(request.override(tools=self._filter_tools(request.tools)))

    async def awrap_model_call(self, request, handler):
        """Filter hidden tools before an asynchronous model call."""
        return await handler(request.override(tools=self._filter_tools(request.tools)))


class SourceRegistryMiddleware(AgentMiddleware):
    """Intercepts tool call results to build a registry of actual sources.

    ``awrap_tool_call`` captures URLs/citation keys from tool results;
    ``get_source_entries`` hands the writer's ``get_verified_sources`` tool
    (``tools/source_registry.py``, which renders the list) the compact or full
    set. The registry is also what ``verify_citations()`` strips fabricated,
    stale, or intermediate-artifact citations against.

    Source capture is gated only by the agent's loaded tool set
    (``source_tool_names``). Internal scratchpad/runtime tools (think,
    write_file, read_file, etc.) are added by deepagents itself and never
    appear in that set, so they are implicitly excluded. Tools registered as
    configured data sources additionally carry a ``source_id`` label, but a
    tool does *not* have to be declared under ``data_sources`` to contribute
    sources — agents can be passed citable tools directly.

    A fresh instance is constructed for every deep research run
    (``DeepResearcherAgent._prepare_run``, ADR-0018), so the instance
    registry and the compact ResearchNotes key set are run-scoped by
    construction. In conversation mode the session-scoped registry (bound by
    the chat entrypoint) still spans turns via ``active_registry()``.
    """

    def __init__(self, source_tool_names: set[str] | None = None) -> None:
        self.registry = SourceRegistry()
        self._source_tool_names = source_tool_names or set()
        self._compact_source_keys: set[str] = set()
        self._lock = asyncio.Lock()

    def active_registry(self) -> SourceRegistry:
        """Return the session-scoped registry if set, otherwise the instance registry."""
        return get_session_registry() or self.registry

    def has_sources(self) -> bool:
        """Return True when the active source registry contains captured sources."""
        return bool(self.active_registry().all_sources())

    @staticmethod
    def _locator_key(locator: str) -> str:
        """Return the comparable key used for source locators and registry entries.

        Knowledge-layer locators carry page suffixes ("handbuch.pdf, p.12"),
        but the registry dedups those entries per file and keeps whichever
        page it saw first ("handbuch.pdf, p.3"). Comparing full strings would
        drop a registered document from the compact whitelist whenever a
        research note cites a different page, so non-URL locators are keyed by
        their page-stripped, lowercased filename.
        """
        locator = locator.strip()
        if locator.startswith(("http://", "https://")):
            return _normalize_url(locator)
        filename, _ = _parse_citation_key(locator)
        return filename.lower()

    @classmethod
    def _entry_key(cls, entry: SourceEntry) -> str | None:
        """Return the comparable key for a registered source entry."""
        if entry.url:
            return cls._locator_key(entry.url)
        if entry.citation_key:
            return cls._locator_key(entry.citation_key)
        return None

    def register_research_note_sources(self, notes: list[object]) -> None:
        """Mark ResearchNotes source locators as the compact writer-facing citation set."""
        locators = (
            getattr(source, "locator", "") for note in notes for source in (getattr(note, "sources", None) or [])
        )
        self._compact_source_keys.update(
            self._locator_key(locator) for locator in locators if isinstance(locator, str) and locator.strip()
        )

    async def awrap_tool_call(self, request, handler):
        """Capture sources from tool results after execution.

        Tools that resolve to a configured data source via
        :func:`get_source_id_for_tool` get a ``source_id`` label. Tools passed
        directly to the agent without a data-source declaration are still
        captured — their results are real, citable evidence even when
        ``data_source_registry`` does not know about them — but their entries
        carry no ``source_id``.
        """
        result = await handler(request)
        if not isinstance(result, ToolMessage) or not result.content:
            return result
        tool_call = getattr(request, "tool_call", None)
        tool_name = tool_call.get("name", "") if isinstance(tool_call, dict) else ""
        if tool_name not in self._source_tool_names:
            return result
        source_id = get_source_id_for_tool(tool_name)
        sources = extract_sources_from_tool_result(tool_name, str(result.content), source_id=source_id)
        async with self._lock:
            active_registry = self.active_registry()
            for source in sources:
                active_registry.add(source)
        if sources:
            logger.info(
                "[CitationRegistry] Captured %d source(s) from %s: %s",
                len(sources),
                tool_name,
                [s.url or s.citation_key for s in sources],
            )
        return result

    def get_source_entries(self, mode: str = "compact") -> list[SourceEntry]:
        """Return the source entries represented by the writer-facing source list.

        Compact mode is the subset of registered sources that researcher
        workers actually carried forward in structured ResearchNotes (the
        whole registry when no note named any). Full mode is the registry.
        """
        sources = self.active_registry().all_sources()
        if mode == "full" or not self._compact_source_keys:
            return sources
        compact_sources = [source for source in sources if self._entry_key(source) in self._compact_source_keys]
        return compact_sources or sources


_TRUNCATION_SUFFIX = "\n\n[... truncated ...]"


def _truncated(msg: ToolMessage, max_chars: int) -> str:
    return str(msg.content)[:max_chars] + _TRUNCATION_SUFFIX


def _evictions(
    messages: Sequence[Any],
    *,
    keep_last_n: int,
    max_chars: int,
    total_char_budget: int,
    already: Mapping[str, str],
) -> dict[str, str]:
    """Which oversized tool results to truncate now, as ``message id → content``.

    Two passes. The last-N window: every oversized ToolMessage that fell out of
    the last ``keep_last_n`` is evicted. The total-char budget: if the oversized
    results still inside the window together exceed ``total_char_budget``, the
    oldest of them are evicted until under budget, so the writer's context
    cannot grow unbounded across many research notes. Messages in ``already``
    are never decided twice (monotonicity), and only messages with an id can
    be remembered at all.
    """
    oversized = [
        msg for msg in messages if isinstance(msg, ToolMessage) and msg.content and len(str(msg.content)) > max_chars
    ]
    window_start = max(len(oversized) - keep_last_n, 0)
    evicted = {msg.id: _truncated(msg, max_chars) for msg in oversized[:window_start] if msg.id is not None}
    evicted = {msg_id: content for msg_id, content in evicted.items() if msg_id not in already}
    if total_char_budget <= 0:
        return evicted
    window = oversized[window_start:]
    total = sum(len(already.get(msg.id, str(msg.content))) for msg in window)
    for msg in window:
        if total <= total_char_budget:
            break
        if msg.id is None or msg.id in already:
            continue
        evicted[msg.id] = _truncated(msg, max_chars)
        total += len(evicted[msg.id]) - len(str(msg.content))
    return evicted


class ToolResultPruningMiddleware(AgentMiddleware):
    """Truncates older tool results to keep context manageable — cache-stably.

    Keeps the last N oversized tool results intact and truncates older ones to
    reduce "lost in the middle" degradation. Operates on awrap_model_call so
    the full results are still available for SourceRegistryMiddleware.

    Truncation is MONOTONIC: once a message has been sent truncated, it is
    sent in exactly that truncated form on every later call. A naive
    sliding window recomputed per call changes message bytes mid-history on
    almost every turn, which invalidates the provider's prompt-prefix cache
    (OpenRouter/DeepSeek) from that point on — on ~80k-token deep-research
    contexts that meant re-processing the full prompt every single turn.
    Decisions are recorded per message id; entries are deterministic and
    idempotent, so the plain dict is safe even when one middleware instance
    is shared across concurrently-running subagents (concurrent writers can
    only ever write the same value for the same id).

    Only messages whose content exceeds max_chars occupy window slots:
    trivial results (``think``'s "Thought recorded.", ``ls`` listings) need
    no truncation, and letting them consume protected slots would churn the
    window — and thus the cache — for zero context savings.
    """

    _TRUNCATION_SUFFIX = _TRUNCATION_SUFFIX

    def __init__(self, keep_last_n: int = 3, max_chars: int = 500, total_char_budget: int = 0):
        self.keep_last_n = keep_last_n
        self.max_chars = max_chars
        self.total_char_budget = total_char_budget
        # message id -> permanently truncated content for that message.
        self._truncated_by_id: dict[str, str] = {}

    def _pruned(self, msg: Any) -> Any:
        truncated = self._truncated_by_id.get(msg.id) if isinstance(msg, ToolMessage) else None
        return msg if truncated is None else _replace_tool_content(msg, truncated)

    async def awrap_model_call(self, request, handler):
        """Truncate older oversized ToolMessage content before sending to the model."""
        self._truncated_by_id.update(
            _evictions(
                request.messages,
                keep_last_n=self.keep_last_n,
                max_chars=self.max_chars,
                total_char_budget=self.total_char_budget,
                already=self._truncated_by_id,
            )
        )
        if not self._truncated_by_id:
            return await handler(request)
        pruned = [self._pruned(msg) for msg in request.messages]
        if all(new is old for new, old in zip(pruned, request.messages, strict=True)):
            return await handler(request)
        return await handler(request.override(messages=pruned))

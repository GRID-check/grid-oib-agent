"""Closes NAT LangChain profiler spans on error so retries stop corrupting the
step stack.

``nat.plugins.langchain.callback_handler.LangchainProfilerHandler`` (the
callback NAT wires up for Phoenix/OTel observability) implements
``on_llm_start``/``on_chat_model_start``/``on_llm_end``/``on_tool_start``/
``on_tool_end`` but not ``on_llm_error`` or ``on_tool_error``. Every one of
those ``on_*_start`` calls pushes an ``IntermediateStepPayload`` START event
that ``IntermediateStepManager`` (``nat/builder/intermediate_step_manager.py``)
records as an *open* frame on the run's ``active_span_id_stack`` and in its
``_outstanding_start_steps`` map, to be popped by the matching END event.

When a LangChain call is wrapped with ``.with_retry()`` (as our LLMs are, see
``aiq_agent.common.llm_factory``), each retry attempt gets its **own**
``run_id`` and its own ``on_llm_start``/(``on_llm_end`` or ``on_llm_error``)
pair. An errored attempt therefore pushes a START that is never matched by an
END -- because the handler has no ``on_llm_error`` -- and the frame is leaked
on the stack forever. The *next* legitimate END that closes around that
leaked frame then has to pop more than one entry to reach its real parent,
which is exactly the ``IntermediateStepManager`` warning this fixes::

    Step id ... not the last step in the stack. Removing it from the stack
    but this is likely an error.

``SpanClosingProfilerHandler`` subclasses the installed handler and adds
``on_llm_error``/``on_tool_error`` overrides that push the matching END event
for the run_id that just errored, mirroring the field-for-field construction
of the corresponding ``on_llm_end``/``on_tool_end`` implementations (same
``UUID``, ``span_event_timestamp`` bookkeeping, zeroed token usage) so
``IntermediateStepManager`` pops exactly one frame -- keeping ``pop_count``
at 1 for the *next* real END, instead of the leaked frame's parent needing to
be swept out from under it.

It also implements ``on_retry`` -- but deliberately as a log-only, non-pushing
override (see that method's docstring for why pushing an END there would
itself be wrong).

Finally, it implements ``for_new_run()`` -- the duck-typed protocol used by
``aiq_agent.common.callbacks.VerboseTraceCallback`` and consumed in
``deep_researcher/agent.py`` and ``deep_researcher/tools/research.py``
(``cb.for_new_run() if hasattr(cb, "for_new_run") else cb for cb in
callbacks``) -- so a fresh instance is handed out per researcher worker
instead of one ``LangchainProfilerHandler`` (with its per-``run_id``
bookkeeping dicts) being shared and mutated concurrently across all of a
job's parallel workers.
"""

from __future__ import annotations

import logging
import time
from typing import Any
from uuid import UUID

from nat.builder.framework_enum import LLMFrameworkEnum
from nat.data_models.intermediate_step import IntermediateStepPayload
from nat.data_models.intermediate_step import IntermediateStepType
from nat.data_models.intermediate_step import StreamEventData
from nat.data_models.intermediate_step import TraceMetadata
from nat.data_models.intermediate_step import UsageInfo
from nat.data_models.token_usage import TokenUsageBaseModel
from nat.plugins.langchain.callback_handler import LangchainProfilerHandler

logger = logging.getLogger(__name__)


class SpanClosingProfilerHandler(LangchainProfilerHandler):
    """``LangchainProfilerHandler`` that also closes LLM/tool spans on error.

    All happy-path behavior (``on_llm_start``/``on_chat_model_start``/
    ``on_llm_end``/``on_tool_start``/``on_tool_end``/``on_llm_new_token``) is
    inherited unchanged. Only the error paths, retry logging, and per-run
    isolation are added here. See the module docstring for the root cause
    this addresses.
    """

    def for_new_run(self) -> SpanClosingProfilerHandler:
        """Return a fresh instance for one job/worker run.

        Mirrors the ``for_new_run()`` protocol on
        ``aiq_agent.common.callbacks.VerboseTraceCallback`` so this handler
        participates in the same per-worker callback isolation already used
        in ``deep_researcher/agent.py`` and
        ``deep_researcher/tools/research.py``
        (``cb.for_new_run() if hasattr(cb, "for_new_run") else cb``).
        ``LangchainProfilerHandler`` keeps per-``run_id`` bookkeeping dicts
        (``_run_id_to_model_name``, ``_run_id_to_llm_input``,
        ``_run_id_to_tool_input``, ``_run_id_to_start_time``) exactly like
        ``VerboseTraceCallback`` keeps ``active_chains``/``depth`` -- a single
        shared instance across up-to-``max_research_concurrency`` concurrent
        researcher workers would let one worker's run_id bookkeeping race
        with another's.
        """
        return SpanClosingProfilerHandler()

    async def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        """Close the LLM span left open by an errored (then-retried) call.

        Mirrors ``LangchainProfilerHandler.on_llm_end``'s construction of the
        LLM_END ``IntermediateStepPayload`` field for field: same ``UUID`` (so
        ``IntermediateStepManager`` matches it to the START pushed by
        ``on_llm_start``/``on_chat_model_start``), the same
        ``span_event_timestamp`` bookkeeping, and the same lock scope. Token
        usage is zeroed (no completion was produced) and the error text takes
        the place of the generated content in ``data.output``.
        """
        run_id_str = str(run_id)
        model_name = self._run_id_to_model_name.get(run_id_str, "")
        error_text = f"{type(error).__name__}: {error}"

        with self._lock:
            usage_stat = IntermediateStepPayload(
                span_event_timestamp=self._run_id_to_start_time.get(run_id_str, time.time()),
                event_type=IntermediateStepType.LLM_END,
                framework=LLMFrameworkEnum.LANGCHAIN,
                name=model_name,
                UUID=run_id_str,
                data=StreamEventData(
                    input=self._run_id_to_llm_input.get(run_id_str, ""),
                    output=error_text,
                ),
                usage_info=UsageInfo(token_usage=TokenUsageBaseModel()),
                metadata=TraceMetadata(error=error_text, error_type=type(error).__name__),
            )

            self.step_manager.push_intermediate_step(usage_stat)

        self._state = IntermediateStepType.LLM_END

    async def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        """Close the tool span left open by an errored (then-retried) call.

        Mirrors ``LangchainProfilerHandler.on_tool_end``'s construction of the
        TOOL_END payload field for field (including reading the tool name off
        ``kwargs["name"]`` the same way ``on_tool_end`` does), with the error
        text standing in for the tool output and zeroed token usage. Unlike
        ``on_llm_end``, the upstream ``on_tool_end`` does not take ``_lock``,
        so this mirrors that too.
        """
        run_id_str = str(run_id)
        tool_name = kwargs.get("name", "")
        error_text = f"{type(error).__name__}: {error}"

        stats = IntermediateStepPayload(
            event_type=IntermediateStepType.TOOL_END,
            span_event_timestamp=self._run_id_to_start_time.get(run_id_str, time.time()),
            framework=LLMFrameworkEnum.LANGCHAIN,
            name=tool_name,
            UUID=run_id_str,
            metadata=TraceMetadata(tool_outputs=error_text, error=error_text, error_type=type(error).__name__),
            usage_info=UsageInfo(token_usage=TokenUsageBaseModel()),
            data=StreamEventData(
                input=self._run_id_to_tool_input.get(run_id_str, ""),
                output=error_text,
                payload=error_text,
            ),
        )

        self.step_manager.push_intermediate_step(stats)

    async def on_retry(self, retry_state: Any, *, run_id: UUID, **kwargs: Any) -> None:
        """Log a retry without touching the span stack.

        This is deliberately NOT a span-closing push. LangChain fires
        ``on_retry`` from two different places, and they need opposite
        treatment:

        - ``.with_retry()`` (``RunnableRetry``, used by our LLM factory) gives
          each attempt its own ``run_id`` and its own on_llm_start/(on_llm_end
          or on_llm_error) pair; ``on_retry`` is not invoked at the LLM-run
          level for this path, so there is nothing to close here -- that case
          is already handled by ``on_llm_error`` above, which fires before the
          *next* attempt's ``on_llm_start``.
        - The legacy completion-style LLM retry decorator
          (``langchain_core.language_models.llms.create_base_retry_decorator``)
          calls ``on_retry`` with the SAME ``run_id`` as the still-open
          ``on_llm_start`` span, mid-attempt, before sleeping and trying
          again. That span has not finished -- pushing an END here would pop
          it prematurely, and the genuine ``on_llm_end``/``on_llm_error`` that
          eventually fires for the same run_id would then find no outstanding
          start step (the *other* ``IntermediateStepManager`` warning: "Step
          id ... not found in outstanding start steps").

        So this override exists to make retries observable without risking a
        double-close; it must not push to ``step_manager``.
        """
        logger.debug("LangChain run %s retrying: %s", run_id, retry_state)

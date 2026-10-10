"""One Langfuse generation per decision-model call (ADR-0064, ADR-0089).

Jev's calls bypass LangChain and NAT's LLM callbacks, so until this module they
reached Langfuse not at all: the turn decision, the passage judge, the
injection flag, the upload tags, the reference fit — every typed answer the
agent acts on lived only in the opt-in technical panel and the cost ledger.
A trace could not say why round 0 searched what it searched.

Each call (or each ``decide_many`` batch) is now one ``decide.<slot>`` step,
nested under whatever step is open, which ``trace_context.observation_type``
renders as a *generation*. Its input names the questions and how many states
were asked, never a state: a state carries the reader's words, and the
technical record's rule — numbers, never the reader's text — holds here too.
Its output is the answers as numbers, the served model, the latency and the
provider's usage object, which ``UsageAttributeProcessor`` stamps as the
generation's tokens and cost (:func:`decision_usage`).

Fail-open like every observation: a failure here never reaches a decision.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

#: The step-name prefix every decision observation carries; ``trace_context`` keys its type off it.
DECISION_SPAN_PREFIX = "decide."


def decision_observation(
    *,
    questions: Sequence[str],
    states: int,
    answers: Sequence[Mapping[str, Any]] = (),
    model: str | None = None,
    latency_ms: int | None = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_usd: float | None = None,
    decided: int | None = None,
    skipped: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The observation's input and output. Pure, so the shape is pinned without NAT.

    ``answers`` holds one summary per decided state (``Decision.summary``), in
    state order, capped by the caller. ``usage`` is written in OpenRouter's
    own key names, the shape the usage processor already reads.
    """
    body_in: dict[str, Any] = {"questions": list(questions), "states": states}
    body_out: dict[str, Any] = {"decided": states if decided is None else decided}
    if skipped:
        body_out["skipped"] = skipped
    if answers:
        body_out["answers"] = [dict(answer) for answer in answers]
    if model:
        body_out["model"] = model
    if latency_ms is not None:
        body_out["latency_ms"] = latency_ms
    if input_tokens or output_tokens or cost_usd is not None:
        usage: dict[str, Any] = {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        }
        if cost_usd is not None:
            usage["cost"] = cost_usd
        body_out["usage"] = usage
    return body_in, body_out


def emit_decision_span(slot: str, body_in: dict[str, Any], body_out: dict[str, Any]) -> None:
    """Push the ``decide.<slot>`` step pair. Never raises."""
    from aiq_agent.observability.retrieval_trace import emit_step_span

    emit_step_span(f"{DECISION_SPAN_PREFIX}{slot}", body_in, body_out)


def is_decision_span(name: str | None) -> bool:
    return bool(name) and str(name).startswith(DECISION_SPAN_PREFIX)


def decision_usage(attributes: Mapping[str, Any]) -> dict[str, Any] | None:
    """A decision span's tokens, cost and model, read off its output, or None.

    The output is the JSON :func:`decision_observation` wrote, under NAT's
    ``output.value`` (whatever prefix the exporter puts before it). Pure.
    """
    raw = next((value for key, value in attributes.items() if key.endswith("output.value")), None)
    if not isinstance(raw, str):
        return None
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    usage = body.get("usage") if isinstance(body, Mapping) else None
    if not isinstance(usage, Mapping):
        return None
    cost = usage.get("cost")
    return {
        "prompt_tokens": int(usage.get("prompt_tokens") or 0),
        "completion_tokens": int(usage.get("completion_tokens") or 0),
        "total_tokens": int(usage.get("total_tokens") or 0),
        "cost_usd": cost if isinstance(cost, int | float) and not isinstance(cost, bool) else None,
        "model": body.get("model") if isinstance(body.get("model"), str) else None,
    }

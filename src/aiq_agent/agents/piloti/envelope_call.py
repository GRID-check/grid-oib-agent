"""The envelope-enforced LLM call, shared by forced synthesis and the repair.

Provider enforcement for the ```answer_json envelope, strongest first:

1. OpenRouter STRUCTURED OUTPUTS (``json_schema``, strict): the reply is one
   schema-valid JSON object, derived from the same Pydantic models as the
   validator (``render_envelope_response_format``). The envelope is a small,
   flat schema, so strict mode is expressible, unlike the 20-way card union
   that pushed ``cards/generate.py`` down to ``json_object``.
2. ``json_object``: syntactic validity only, widely honored.
3. A plain call: the fenced contract taught in the prompt, parsed by the
   fail-open extractor.

Each rung is bound per call with a fallback to the next, never at
construction: a provider that rejects a parameter must degrade to the next
rung, not to a failed turn. The deterministic gates stay the editorial
enforcement either way.
"""

from __future__ import annotations

import logging
from typing import Any

from aiq_agent.common.answer_envelope import render_envelope_response_format

logger = logging.getLogger(__name__)

_ENVELOPE_RESPONSE_FORMATS: tuple[dict[str, Any], ...] = (
    render_envelope_response_format(),
    {"type": "json_object"},
)

#: The statuses a provider answers with when it rejects the request's SHAPE
#: (an unsupported ``response_format``). Never auth (401/403), quota (429),
#: a server fault (5xx) or a transport error: those fail the same way on every
#: rung, and retrying them under a different ``response_format`` only logs the
#: real error as "response_format failed" three times over.
_PARAMETER_REJECTION_STATUSES = frozenset({400, 422})


def is_parameter_rejection(exc: BaseException) -> bool:
    """Whether ``exc`` is the provider refusing the request's parameters.

    Duck-typed on the status code so it holds for ``openai.APIStatusError``
    (``status_code``), ``httpx.HTTPStatusError`` and ``requests.HTTPError``
    (``response.status_code``) alike.
    """
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    return status in _PARAMETER_REJECTION_STATUSES


def _fall_through(exc: BaseException, response_format: dict[str, Any]) -> None:
    """Let a parameter rejection drop to the next rung; re-raise anything else."""
    if not is_parameter_rejection(exc):
        raise exc
    logger.warning(
        "Envelope response_format %s rejected by the provider (%s); falling back",
        response_format.get("type"),
        str(exc).split("\n")[0],
    )


async def ainvoke_with_envelope_json_mode(llm: Any, messages: list[Any]) -> Any:
    """Invoke ``llm`` down the envelope-enforcement ladder, strongest first.

    Accepts both the bare researcher LLM and a tool-bound RunnableBinding
    (``bind`` merges kwargs on either). Only a parameter rejection drops to
    the next rung; everything else propagates from the rung it happened on.

    The fallback catches the LOUD failure only. OpenRouter's other mode,
    accepting the parameter and silently degrading (dropping tool calls, or
    routing to a provider that ignores it), is invisible here by nature, which
    is why enforcement defaults to the tool-FREE forced-synthesis call and
    rides tool-bound iterations only behind ``envelope_json_mode_with_tools``.
    """
    for response_format in _ENVELOPE_RESPONSE_FORMATS:
        try:
            return await llm.bind(response_format=response_format).ainvoke(messages)
        except Exception as exc:  # noqa: BLE001 - re-raised unless it is the provider rejecting the parameter
            _fall_through(exc, response_format)
    return await llm.ainvoke(messages)

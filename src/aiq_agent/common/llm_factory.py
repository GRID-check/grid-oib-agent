"""Fleet-wide LangChain LLM acquisition.

Every agent resolves its chat models through :func:`get_langchain_llm` instead
of calling ``builder.get_llm`` directly, so the OpenRouter response-healing
default is forced on in exactly one place (DRY) and any new agent inherits it
automatically:

- ``plugins: [{"id": "response-healing"}]``: repair malformed / markdown-fenced
  JSON provider-side before it reaches us (activates only on json_schema /
  json_object requests; a no-op on plain calls).

This is an OpenRouter-specific request-body field, so it is applied only to LLMs
whose ``base_url`` points at OpenRouter — non-OpenRouter deployments (e.g.
NVIDIA-hosted models) are returned untouched.

We deliberately do NOT force ``provider.require_parameters``: being
request-scoped, it hard-fails (``404 No endpoints found that can handle the
requested parameters``) whenever a group is re-pointed at a model whose
endpoints don't advertise every param we send — see
_with_openrouter_structured_defaults.

See https://openrouter.ai/docs/guides/features/structured-outputs and
https://openrouter.ai/docs/guides/features/plugins/response-healing
"""

from __future__ import annotations

import logging
from typing import Any

from nat.builder.framework_enum import LLMFrameworkEnum

logger = logging.getLogger(__name__)

_OPENROUTER_HOST = "openrouter.ai"
_RESPONSE_HEALING_PLUGIN = {"id": "response-healing"}


def _llm_base_url(llm: Any) -> str:
    """Best-effort base URL for a LangChain chat model."""
    for attr in ("openai_api_base", "base_url"):
        value = getattr(llm, attr, None)
        if value:
            return str(value)
    client = getattr(llm, "async_client", None) or getattr(llm, "client", None)
    base = getattr(client, "base_url", None)
    return str(base) if base else ""


def _with_openrouter_structured_defaults(extra_body: Any) -> dict[str, Any]:
    """Merge the response-healing plugin into an existing extra_body.

    Idempotent and non-destructive: preserves any pre-existing plugins, only
    ensuring the response-healing plugin is present exactly once.

    NOTE: We deliberately do NOT set ``provider.require_parameters``. It is
    request-scoped — OpenRouter drops every provider that doesn't support ALL
    params in the request — so the moment a group is re-pointed (via an org
    model override) at a model whose endpoints don't advertise one of the params
    we send (json_schema, tools, reasoning, …), the call hard-fails with
    ``404 No endpoints found that can handle the requested parameters`` instead
    of degrading. Structured-output reliability comes instead from the strict
    json_schema we send, this response-healing plugin (repairs fenced/malformed
    JSON provider-side), and the client-side extract_json fallback.
    """
    merged: dict[str, Any] = dict(extra_body) if isinstance(extra_body, dict) else {}

    plugins = list(merged.get("plugins") or [])
    if not any(isinstance(p, dict) and p.get("id") == _RESPONSE_HEALING_PLUGIN["id"] for p in plugins):
        plugins.append(dict(_RESPONSE_HEALING_PLUGIN))
    merged["plugins"] = plugins

    return merged


def apply_openrouter_structured_defaults(llm: Any) -> Any:
    """Force OpenRouter structured-output routing + JSON healing on an LLM.

    No-op for non-OpenRouter models. Mutates the resolved instance in place so
    NAT's retry-patched bound methods are preserved (a ``model_copy`` would risk
    dropping them); the defaults are identical for every caller, so sharing a
    resolved instance is safe.
    """
    if _OPENROUTER_HOST not in _llm_base_url(llm):
        return llm
    if not hasattr(llm, "extra_body"):
        return llm

    merged = _with_openrouter_structured_defaults(getattr(llm, "extra_body", None))
    if merged == getattr(llm, "extra_body", None):
        return llm
    try:
        llm.extra_body = merged
    except Exception:  # noqa: BLE001 - never let hardening break model resolution
        logger.warning("Could not apply OpenRouter structured defaults to %s", type(llm).__name__, exc_info=True)
    return llm


# NOTE on reasoning_effort: we deliberately do NOT translate effort values
# per model family app-side. Configs use the OpenRouter/OpenAI-standard
# vocabulary (none/minimal/low/medium/high/xhigh) and the value is passed
# through verbatim — OpenRouter's unified reasoning API maps a requested
# effort to the nearest level each model supports, per model, server-side
# (https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). An
# app-side mapping table would duplicate (and inevitably drift from) that
# contract; provider-native tier names like DeepSeek's "max" must NOT appear
# in configs — OpenRouter rejects/ignores them (use "xhigh").


async def get_langchain_llm(builder: Any, ref: Any) -> Any:
    """Resolve a LangChain chat model with fleet-wide OpenRouter defaults applied.

    Drop-in replacement for ``builder.get_llm(ref, wrapper_type=LANGCHAIN)``.
    """
    llm = await builder.get_llm(ref, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
    return apply_openrouter_structured_defaults(llm)


def strict_response_format(schema: Any) -> Any:
    """Return a ``create_agent`` response_format that forces native strict json_schema.

    Wraps ``schema`` in ``ProviderStrategy(strict=True)`` so ``create_agent``
    always emits the ``response_format: {type: json_schema, strict: true}`` wire
    format instead of ``AutoStrategy``'s model-name-gated tool-call fallback
    (which no OpenRouter/DeepSeek slug matches, silently downgrading to an
    unenforced synthetic tool call). Use this for every ``create_agent`` agent
    that returns structured output. Requires the schema to be strict-valid
    (all properties required; optionals expressed as nullable).
    """
    from langchain.agents.structured_output import ProviderStrategy

    return ProviderStrategy(schema, strict=True)


def strict_json_response_format(schema: Any) -> dict[str, Any]:
    """Return the OpenRouter strict json_schema ``response_format`` dict for ``llm.bind()``.

    The ``.bind()`` counterpart of :func:`strict_response_format`, for agents
    that call the model directly (not via ``create_agent``) and want native
    structured output — e.g. ``llm.bind(response_format=strict_json_response_format(Model))``.
    Reuses the same ``ProviderStrategy`` wire generation, so the emitted
    ``{"type": "json_schema", "json_schema": {..., "strict": true}}`` is identical.
    Requires ``schema`` to be strict-valid (all properties required; optionals nullable).
    """
    return strict_response_format(schema).to_model_kwargs()["response_format"]

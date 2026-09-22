"""Fleet-wide LangChain LLM acquisition.

Every agent resolves its chat models through :func:`get_langchain_llm` instead
of calling ``builder.get_llm`` directly, so cross-cutting request hardening is
forced on in exactly one place (DRY) and any new agent inherits it
automatically:

- ``plugins: [{"id": "response-healing"}]``: repair malformed / markdown-fenced
  JSON provider-side before it reaches us (activates only on json_schema /
  json_object requests; a no-op on plain calls).
- the provider-portable chat-request contract (see
  :mod:`aiq_agent.common.message_contract`): a request must never end on an
  assistant turn, because Google rejects that shape while OpenAI-compatible
  providers accept it, and OpenRouter picks the provider per request.
- prompt-cache affinity (see :mod:`aiq_agent.common.prompt_caching`): a
  ``session_id`` + ``prompt_cache_key`` derived from the request's own stable
  prefix, so the 3-6 calls of one turn land on the endpoint that cached it
  instead of being spread across a model's providers.
- ``use_previous_response_id=False`` on the Responses path (see
  :func:`disable_previous_response_id`): OpenRouter's Responses API is
  stateless and rejects the field, while NAT turns it on for every
  ``api_type: responses`` client.

Every one of these is OpenRouter-specific, so each is applied only to LLMs
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

from aiq_agent.common.message_contract import normalize_chat_request
from nat.builder.framework_enum import LLMFrameworkEnum

logger = logging.getLogger(__name__)

_OPENROUTER_HOST = "openrouter.ai"
_RESPONSE_HEALING_PLUGIN = {"id": "response-healing"}

#: Marks a chat-model class as already carrying the request contract, so
#: resolving the same model twice does not stack wrappers.
_CONTRACT_MARKER = "__grid_request_contract__"

#: One contract subclass per base chat-model class, not per instance — keeps
#: ``type(llm)`` stable and cheap across the fleet's many resolutions.
_CONTRACT_SUBCLASSES: dict[type, type] = {}


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


def llm_targets_openrouter(llm: Any) -> bool:
    """True when a LangChain chat model's traffic goes to OpenRouter.

    Shared with the per-request ZDR seam (``model_overrides``) so both use the
    same base-URL detection.
    """
    return _OPENROUTER_HOST in _llm_base_url(llm)


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


def disable_previous_response_id(llm: Any) -> Any:
    """Stop an OpenRouter-bound Responses-API client from sending ``previous_response_id``.

    NAT builds every ``api_type: responses`` client with
    ``use_previous_response_id=True`` (``nat/plugins/langchain/llm.py``), and
    langchain-openai then fills the field in from the most recent ``AIMessage``
    whose id starts with ``resp_`` and truncates the request to the messages
    after it. OpenRouter cannot serve that:

        "Requests that set ``store: true`` or a non-null
        ``previous_response_id`` are rejected with a ``400`` error."
        -- https://openrouter.ai/docs/api_reference/responses/overview

    It is dormant only because OpenRouter does not currently hand back ids of
    that shape; its own documented examples are ``resp_…``, so the day it does,
    every follow-up call inside a turn 400s at once.

    Flipping the flag off does not leave the Responses path: NAT sets
    ``use_responses_api=True`` explicitly alongside it. No-op off OpenRouter,
    where the field is the provider's own state handle and works as documented.
    """
    if not llm_targets_openrouter(llm):
        return llm
    if not getattr(llm, "use_previous_response_id", False):
        return llm
    try:
        llm.use_previous_response_id = False
    except Exception:  # noqa: BLE001 - never let hardening break model resolution
        logger.warning("Could not disable previous_response_id on %s", type(llm).__name__, exc_info=True)
    return llm


def _request_organization_id() -> str | None:
    """The caller's org id, or None outside a request (a CLI run, an ingest thread)."""
    try:
        from aiq_agent.project_context import get_organization_id_from_context

        return get_organization_id_from_context()
    except Exception:  # noqa: BLE001 - identity is a cache-key ingredient, never a precondition
        logger.debug("Could not read the organization id for the prompt-cache key", exc_info=True)
        return None


def prepare_request(llm: Any, messages: Any, kwargs: dict[str, Any]) -> Any:
    """Apply both request-shaping rules to one outgoing call, in place on ``kwargs``.

    Returns the messages to send and mutates the call's ``kwargs`` with the
    prompt-cache routing fields. Both halves are no-ops where they do not
    apply — a non-OpenRouter model keeps its body untouched, and a call with no
    leading system message gets no key.

    The merge order matters: the instance's own ``extra_body`` (the
    response-healing plugin, ZDR provider routing) is the base, a per-call
    ``extra_body`` from a binding layers over it, and only then are the cache
    fields filled in — so nothing this adds can drop what was already there.
    """
    normalized = normalize_chat_request(messages)
    if not llm_targets_openrouter(llm):
        return normalized
    from aiq_agent.common.prompt_caching import prompt_cache_extra_body

    base = getattr(llm, "extra_body", None)
    merged_base = {**(dict(base) if isinstance(base, dict) else {}), **(kwargs.get("extra_body") or {})}
    extra_body = prompt_cache_extra_body(
        normalized,
        kwargs,
        extra_body=merged_base,
        organization_id=_request_organization_id(),
        model=getattr(llm, "model_name", None) or getattr(llm, "model", None),
    )
    if extra_body is not None:
        kwargs["extra_body"] = extra_body
    return normalized


def _contract_subclass(base: type) -> type:
    """Build (once per base class) a subclass that normalizes outgoing requests.

    The override sits on ``_generate``/``_agenerate``/``_stream``/``_astream``
    because that is the single point every public entry point converges on —
    ``invoke``, ``ainvoke``, ``stream``, ``astream``, ``batch``, and everything
    layered on top of them (``bind``, ``bind_tools``, ``with_structured_output``,
    ``create_agent``) delegates down to these four. Wrapping ``ainvoke`` instead
    would be bypassed by the streaming and structured-output paths, which is
    where the failures actually happened.
    """
    cached = _CONTRACT_SUBCLASSES.get(base)
    if cached is not None:
        return cached

    from langchain_core.language_models.chat_models import BaseChatModel

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        prepared = prepare_request(self, messages, kwargs)
        return base._generate(self, prepared, stop=stop, run_manager=run_manager, **kwargs)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        prepared = prepare_request(self, messages, kwargs)
        return await base._agenerate(self, prepared, stop=stop, run_manager=run_manager, **kwargs)

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        prepared = prepare_request(self, messages, kwargs)
        yield from base._stream(self, prepared, stop=stop, run_manager=run_manager, **kwargs)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        prepared = prepare_request(self, messages, kwargs)
        async for chunk in base._astream(self, prepared, stop=stop, run_manager=run_manager, **kwargs):
            yield chunk

    namespace: dict[str, Any] = {_CONTRACT_MARKER: True, "_generate": _generate, "_agenerate": _agenerate}
    # LangChain decides whether a model can stream by comparing these attributes
    # against BaseChatModel's (`_should_stream`). Defining them unconditionally
    # would advertise streaming for models that do not implement it, so each
    # override is added only when the base class actually provides one.
    if base._stream is not BaseChatModel._stream:
        namespace["_stream"] = _stream
    if base._astream is not BaseChatModel._astream:
        namespace["_astream"] = _astream

    subclass = type(f"RequestContract{base.__name__}", (base,), namespace)
    _CONTRACT_SUBCLASSES[base] = subclass
    return subclass


def enforce_chat_request_contract(llm: Any) -> Any:
    """Make ``llm`` incapable of sending a provider-invalid message sequence.

    Re-points the instance at a contract subclass of its own class, so every
    call it serves — directly, tool-bound, or wrapped in structured output —
    passes through :func:`~aiq_agent.common.message_contract.normalize_chat_request`
    first. ``isinstance`` checks against ``BaseChatModel`` and friends keep
    working, and ``model_copy`` (how the per-request override seam produces
    per-org instances) carries the contract along with the copy.

    Idempotent, and never fatal: a model class that cannot be subclassed is
    returned untouched rather than failing model resolution.
    """
    base = type(llm)
    if getattr(base, _CONTRACT_MARKER, False):
        return llm
    try:
        llm.__class__ = _contract_subclass(base)
    except Exception:  # noqa: BLE001 - hardening must never break model resolution
        logger.warning("Could not enforce the chat-request contract on %s", base.__name__, exc_info=True)
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

    NOTE: this runs at workflow BUILD time (once, shared across tenants), so
    per-org variation — model overrides AND Zero-Data-Retention routing — is
    applied later at the per-request seam in ``model_overrides`` (which copies
    the instance), never here.
    """
    llm = await builder.get_llm(ref, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
    hardened = disable_previous_response_id(apply_openrouter_structured_defaults(llm))
    return enforce_chat_request_contract(hardened)


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

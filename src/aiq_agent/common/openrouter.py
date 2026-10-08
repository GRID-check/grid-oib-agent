"""The one OpenRouter seam: where a request goes, and what it may leave behind.

Every call this process makes to OpenRouter carries tenant content: a question,
a document chunk, a drawing, a transcript. Zero Data Retention (ZDR,
Organization → Models, ADR-0014) is on for every organization unless its admin
switched it off, and it is owed on EVERY such call, not only the chat answer.
Applied call site by call site, the pin is missed by most of them: embeddings,
reranking, drawing captions, titles, summaries and the whole async job worker
would go out unpinned. This module is the one place that
knows

- whether a URL is OpenRouter (:func:`targets_openrouter`),
- what the pin is (:data:`ZDR_PROVIDER_ROUTING`, merged by :meth:`DataPolicy.apply`),
- which policy an organization is under (:func:`data_policy_for`).

Two kinds of model, two rules:

- A model the organization can choose (the chat agent groups, the ingest vision
  override, a BYOK credential) follows the organization's policy, because an
  organization that switched ZDR off may choose a model without a ZDR endpoint.
- A model the platform fixes (embeddings, the cross-encoder, the decision
  model, the knowledge layer's judge and summary models) is ALWAYS pinned
  (:data:`PLATFORM_FIXED`). Every one of them has a ZDR endpoint, so pinning
  costs nothing, and it keeps them independent of any request context.

A call site picks the adapter for its shape and never writes its own merge:

- a LangChain chat model: :func:`pin_chat_model`;
- a JSON body it builds (``httpx``): ``policy.apply(body)``, or
  ``ResolvedCredential.request_body`` when it resolved its endpoint through
  :func:`aiq_agent.common.credential_resolution.resolve_llm_credential`;
- an OpenAI SDK client: :func:`openai_client`;
- a client that builds its own body (llama-index's embedding client):
  :func:`pinned_http_client` / :func:`pinned_async_http_client`.

Detached work with no request (an ingest job) enters its organization's
policy with :func:`data_policy_scope`; code that reads it with
:func:`scoped_data_policy` and finds no scope pins.

``tests/aiq_agent/common/test_openrouter_call_sites.py`` fails when a module
talks to OpenRouter without going through one of them.

The organization's policy FAILS CLOSED: when it cannot be read, the request is
pinned. A pinned request to a model without a ZDR endpoint fails loudly; an
unpinned one for a ZDR tenant leaks silently, and only the first is
recoverable. See https://openrouter.ai/docs/guides/features/zdr.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
from collections.abc import Iterator
from collections.abc import Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

OPENROUTER_HOST = "openrouter.ai"

#: OpenRouter provider preferences that make a request zero-data-retention.
#: ``zdr`` routes only to endpoints with a ZDR policy; ``data_collection:
#: deny`` additionally skips providers that store or train on inputs.
ZDR_PROVIDER_ROUTING: Mapping[str, object] = {"zdr": True, "data_collection": "deny"}

#: The substring OpenRouter's refusal carries when no endpoint satisfies the
#: data policy. The UI matches on it to tell the asker what to do.
DATA_POLICY_REFUSAL_MARKER = "data policy"

# @environment_variable OPENROUTER_PREFERRED_PROVIDERS
# @category Agent
# @type str
# @default azure/eu,google-vertex/europe,google-vertex/eu,amazon-bedrock/eu-west-1,mistral/eu,azure/swedencentral
# @required false
# Comma-separated OpenRouter endpoint slugs tried FIRST on every
# zero-data-retention request (`provider.order`, fallbacks allowed): EU hosting
# is preferred, never required. A model with none of them is served by its
# other ZDR endpoints. Empty turns the preference off. A guarantee of EU
# processing is the `eu.openrouter.ai` base URL instead (Business/Enterprise).
PREFERRED_PROVIDERS_ENV = "OPENROUTER_PREFERRED_PROVIDERS"
_DEFAULT_PREFERRED_PROVIDERS = (
    "azure/eu",
    "google-vertex/europe",
    "google-vertex/eu",
    "amazon-bedrock/eu-west-1",
    "mistral/eu",
    "azure/swedencentral",
)


def preferred_providers() -> tuple[str, ...]:
    """The endpoint slugs a zero-data-retention request tries first (EU by default)."""
    raw = os.environ.get(PREFERRED_PROVIDERS_ENV)
    if raw is None:
        return _DEFAULT_PREFERRED_PROVIDERS
    return tuple(slug.strip() for slug in raw.split(",") if slug.strip())


def targets_openrouter(url: object) -> bool:
    """True when ``url`` (a base URL or a full request URL) is OpenRouter's."""
    if not url:
        return False
    text = str(url)
    host = urlsplit(text).hostname if "://" in text else None
    return OPENROUTER_HOST in (host or text)


@dataclass(frozen=True)
class DataPolicy:
    """What a model provider may keep of a request."""

    zdr: bool = False

    def apply(self, body: Mapping[str, Any] | None) -> dict[str, Any]:
        """Return a NEW request body carrying this policy's provider routing.

        Adds the EU-first ``order`` (:func:`preferred_providers`) unless the body
        already names one. Non-destructive: other ``provider`` keys and every
        other field survive. A fresh dict, so a shared build-time body is never
        mutated. Without ZDR it is a plain copy.
        """
        merged: dict[str, Any] = dict(body) if isinstance(body, Mapping) else {}
        if not self.zdr:
            return merged
        existing = merged.get("provider")
        provider = dict(existing) if isinstance(existing, Mapping) else {}
        provider.update(ZDR_PROVIDER_ROUTING)
        order = preferred_providers()
        if order and "order" not in provider:
            provider["order"] = list(order)
            provider.setdefault("allow_fallbacks", True)
        merged["provider"] = provider
        return merged

    def is_applied_to(self, body: Mapping[str, Any] | None) -> bool:
        """Whether ``body`` already carries everything this policy requires."""
        if not self.zdr:
            return True
        provider = body.get("provider") if isinstance(body, Mapping) else None
        return isinstance(provider, Mapping) and all(provider.get(k) == v for k, v in ZDR_PROVIDER_ROUTING.items())


NO_RETENTION_LIMITS = DataPolicy(zdr=False)
ZERO_DATA_RETENTION = DataPolicy(zdr=True)

#: The policy of a model no organization can choose. See the module docstring.
PLATFORM_FIXED = ZERO_DATA_RETENTION


def data_policy_for(organization_id: str | None) -> DataPolicy:
    """The policy an organization's requests run under. Blocking; fails CLOSED.

    No organization means no tenant content to protect (the shared corpus, a
    CLI run), so no restriction. Any failure to read an organization's setting
    pins it: see the module docstring.
    """
    if not organization_id:
        return NO_RETENTION_LIMITS
    try:
        from aiq_agent.common.model_overrides import resolve_org_zdr_only

        return ZERO_DATA_RETENTION if resolve_org_zdr_only(organization_id) else NO_RETENTION_LIMITS
    except Exception:  # noqa: BLE001 - fails closed, and says so
        logger.error("ZDR policy lookup failed for org %s; pinning ZDR routing", organization_id, exc_info=True)
        return ZERO_DATA_RETENTION


class ZdrRoutingError(RuntimeError):
    """A ZDR policy applied to an OpenRouter request that could not carry it."""


def is_data_policy_refusal(exc: BaseException) -> bool:
    """Whether ``exc`` (or what it wraps) is OpenRouter refusing a pinned request.

    OpenRouter answers 404 "No endpoints found matching your data policy" when
    no endpoint of the model satisfies the request's ZDR routing. It is not a
    fault to retry: the model has to change. Walks ``__cause__`` /
    ``__context__`` because LangChain and NAT's retry wrappers re-raise.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        text = str(current).lower()
        if DATA_POLICY_REFUSAL_MARKER in text or ("no endpoints found" in text and "retention" in text):
            return True
        current = current.__cause__ or current.__context__
    return False


def pin_chat_model(llm: object, policy: DataPolicy) -> object:
    """A LangChain chat model whose requests carry ``policy``.

    Returns ``llm`` itself when there is nothing to do (no ZDR, not OpenRouter,
    already pinned). Otherwise a ``model_copy`` with the merged ``extra_body``,
    sharing the HTTP client and with NAT's retry wrappers rebound to the copy,
    so the shared build-time instance is never mutated.

    Raises :class:`ZdrRoutingError` when a ZDR policy cannot be applied to an
    OpenRouter model: returning the unpinned model would send the request anyway.
    """
    if not policy.zdr:
        return llm
    from aiq_agent.common.llm_factory import llm_targets_openrouter

    if not llm_targets_openrouter(llm):
        return llm
    current = getattr(llm, "extra_body", None)
    if policy.is_applied_to(current):
        return llm
    if not hasattr(llm, "extra_body") or not hasattr(llm, "model_copy"):
        raise ZdrRoutingError(f"cannot pin {type(llm).__name__} to ZDR endpoints: no extra_body")
    try:
        pinned = llm.model_copy(update={"extra_body": policy.apply(current)})
    except Exception as exc:
        raise ZdrRoutingError(f"cannot pin {type(llm).__name__} to ZDR endpoints") from exc

    from aiq_agent.common.model_overrides import _rebind_instance_method_patches

    _rebind_instance_method_patches(llm, pinned)
    return pinned


def _pinned_request(request: httpx.Request, policy: DataPolicy) -> httpx.Request:
    """``request`` with ``policy`` merged into its JSON body."""
    if not policy.zdr or request.method != "POST" or not targets_openrouter(str(request.url)):
        return request
    try:
        body = json.loads(request.content or b"null")
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise ZdrRoutingError(f"cannot pin a non-JSON request to {request.url.path} to ZDR endpoints")
    if policy.is_applied_to(body):
        return request
    headers = {k: v for k, v in request.headers.items() if k.lower() != "content-length"}
    return httpx.Request(
        request.method,
        request.url,
        headers=headers,
        content=json.dumps(policy.apply(body)).encode("utf-8"),
        extensions=request.extensions,
    )


class _PinningTransport(httpx.BaseTransport):
    def __init__(self, policy: DataPolicy) -> None:
        self._policy = policy
        self._inner = httpx.HTTPTransport()

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        return self._inner.handle_request(_pinned_request(request, self._policy))

    def close(self) -> None:
        self._inner.close()


class _AsyncPinningTransport(httpx.AsyncBaseTransport):
    def __init__(self, policy: DataPolicy) -> None:
        self._policy = policy
        self._inner = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return await self._inner.handle_async_request(_pinned_request(request, self._policy))

    async def aclose(self) -> None:
        await self._inner.aclose()


_scoped_policy: contextvars.ContextVar[DataPolicy | None] = contextvars.ContextVar(
    "grid_openrouter_data_policy", default=None
)


@contextmanager
def data_policy_scope(policy: DataPolicy) -> Iterator[DataPolicy]:
    """Run a block of detached work (an ingest job) under its organization's policy.

    Work handed to a thread pool inside the block must carry the context along
    (``pool.submit(contextvars.copy_context().run, fn, ...)``); a thread that
    lost it reads :func:`scoped_data_policy`'s default, which pins.
    """
    token = _scoped_policy.set(policy)
    try:
        yield policy
    finally:
        _scoped_policy.reset(token)


def scoped_data_policy() -> DataPolicy:
    """The policy of the enclosing :func:`data_policy_scope`; pinned when there is none."""
    scoped = _scoped_policy.get()
    return scoped if scoped is not None else ZERO_DATA_RETENTION


def openai_client(*, base_url: str, api_key: str, policy: DataPolicy, **kwargs: Any):
    """An OpenAI SDK client whose OpenRouter requests all carry ``policy``.

    For a bespoke call site that talks the OpenAI SDK directly (the ingest VLM,
    page transcription): the pin rides on the transport, so no call made with
    this client can forget it.
    """
    from openai import OpenAI

    return OpenAI(base_url=base_url, api_key=api_key, http_client=pinned_http_client(policy), **kwargs)


def pinned_http_client(policy: DataPolicy = PLATFORM_FIXED, **kwargs: Any) -> httpx.Client:
    """An ``httpx.Client`` whose OpenRouter POSTs all carry ``policy``.

    For an SDK client that builds its own request body (llama-index's
    ``NVIDIAEmbedding`` hard-codes ``extra_body``): hand it this as its
    ``http_client``.
    """
    return httpx.Client(transport=_PinningTransport(policy), **kwargs)


def pinned_async_http_client(policy: DataPolicy = PLATFORM_FIXED, **kwargs: Any) -> httpx.AsyncClient:
    """The async twin of :func:`pinned_http_client`."""
    return httpx.AsyncClient(transport=_AsyncPinningTransport(policy), **kwargs)

"""Cross-encoder reranking over OpenRouter's reranking endpoint.

A cross-encoder scores the query and a candidate *together*, so unlike the
bi-encoder that retrieved them it can see whether a chunk actually answers the
question rather than whether it occupies a similar region of embedding space.
That is the whole job of the rerank stage, and a dedicated model does it in
tens of milliseconds against the full chunk — where the LLM judge in
:mod:`knowledge_layer.rerank` needs a second-scale call and, historically, a
truncated excerpt to fit its reply budget.

One provider, on purpose. OpenRouter is the host every deployment already
holds a key for (``OPENROUTER_API_KEY``) and its ``POST /api/v1/rerank`` takes
``{model, query, documents: [str], top_n}`` and answers
``{results: [{index, relevance_score}]}``. This module used to carry adapters
for Cohere, Voyage, Jina and NVIDIA's hosted NIM as well; none of them was
ever configured, and NVIDIA's hosted URL had gone (HTTP 410) by the time the
feature was switched on. A self-hosted reranker that speaks the same shape
still fits through ``AIQ_RERANKER_BASE_URL``.

Fail-open, like every other retrieval enhancement in this package: any
transport error, timeout, unknown provider name, or unparseable body returns
``None`` and the caller keeps the order it already had. The reference config
turns it on (``reranker_provider: openrouter``); the env default stays
``none`` so a bare process acquires no outbound dependency it did not ask for.
"""

from __future__ import annotations

import logging
import math
import os
from typing import Any

logger = logging.getLogger(__name__)

PROVIDER = "openrouter"
_PATH = "/rerank"
_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
_DEFAULT_MODEL = "cohere/rerank-v3.5"
_KEY_ENV = "OPENROUTER_API_KEY"
_RESULTS_KEY = "results"
_SCORE_KEY = "relevance_score"


def _env_float(name: str, fallback: float) -> float:
    """Read a positive float from the environment, falling back on anything unusable.

    Module-scope ``float(os.environ[...])`` would make a typo'd env var raise at
    IMPORT time, taking down the whole knowledge layer -- the exact opposite of the
    fail-open contract this module is built on. A misconfiguration must degrade to
    the default, not to an unimportable module.
    """
    raw = os.environ.get(name, "")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        if raw:
            logger.warning("%s=%r is not a number; using %s", name, raw, fallback)
        return fallback
    if value <= 0 or not math.isfinite(value):
        logger.warning("%s=%r must be positive and finite; using %s", name, raw, fallback)
        return fallback
    return value


# @environment_variable AIQ_RERANKER_PROVIDER
# @category Knowledge Layer
# @type str
# @default none
# @required false
# Cross-encoder reranking: none | openrouter. `none` (the env default) leaves
# reranking to the LLM judge configured by `rerank_llm`; the reference config's
# `reranker_provider` field sets `openrouter`, which makes the cross-encoder
# primary and the judge the fallback.
DEFAULT_PROVIDER = os.environ.get("AIQ_RERANKER_PROVIDER", "none").strip().lower()

# @environment_variable AIQ_RERANKER_MODEL
# @category Knowledge Layer
# @type str
# @default cohere/rerank-v3.5
# @required false
# Reranking model id on OpenRouter. The corpus is German, so a multilingual
# model is not optional.
DEFAULT_MODEL = os.environ.get("AIQ_RERANKER_MODEL", "").strip()

# @environment_variable AIQ_RERANKER_BASE_URL
# @category Knowledge Layer
# @type str
# @default https://openrouter.ai/api/v1
# @required false
# Override the host (a gateway, a self-hosted reranker speaking the same
# request and response shape, a test double).
DEFAULT_BASE_URL = os.environ.get("AIQ_RERANKER_BASE_URL", "").strip()

# @environment_variable AIQ_RERANKER_TIMEOUT_SECONDS
# @category Knowledge Layer
# @type float
# @default 10.0
# @required false
# Per-request timeout. Cross-encoders answer in ~100ms; 10s is already a generous
# bound on a provider having a bad day, and reranking must never hold a turn open
# longer than the retrieval it is improving.
DEFAULT_TIMEOUT_SECONDS = _env_float("AIQ_RERANKER_TIMEOUT_SECONDS", 10.0)

# @environment_variable AIQ_RERANKER_MAX_DOC_CHARS
# @category Knowledge Layer
# @type int
# @default 4000
# @required false
# Per-document character budget sent to the reranker. Current cross-encoders take
# 8k-32k tokens per document, so a full 1024-token chunk fits comfortably; the cap
# exists to bound a pathological chunk, not to summarise.
#: At least one character. `_env_float` accepts any positive finite value, so
#: AIQ_RERANKER_MAX_DOC_CHARS=0.5 truncated to 0 and every document was sliced to
#: "" — the provider then ranked empty strings and returned a meaningless order,
#: with a successful HTTP status and nothing in the logs.
DEFAULT_MAX_DOC_CHARS = max(1, int(_env_float("AIQ_RERANKER_MAX_DOC_CHARS", 4000.0)))


def available_providers() -> tuple[str, ...]:
    """Provider names this module can talk to (excluding ``none``)."""
    return (PROVIDER,)


def _resolve_api_key(base_url: str, model: str, organization_id: str | None) -> str:
    """Resolve the reranker key through the shared resolver, with a local fallback.

    ``AIQ_RERANKER_API_KEY`` wins, then ``OPENROUTER_API_KEY``, then host
    inference — the same chain every other bespoke call site in this deployment
    uses, so an org's BYOK key reaches reranking for free on the hosts the
    resolver knows.
    """
    try:
        from aiq_agent.common.credential_resolution import resolve_llm_credential

        resolved = resolve_llm_credential(
            primary_env="AIQ_RERANKER_API_KEY",
            fallback_envs=(_KEY_ENV,),
            default_base_url=base_url,
            default_model=model,
            organization_id=organization_id,
        )
        if resolved.api_key:
            return resolved.api_key
    except ImportError:
        # knowledge_layer is usable without the aiq_agent package.
        logger.debug("credential_resolution unavailable; falling back to a direct env read")
    except Exception as e:
        # Type only, never the message. This is the credential-resolution path, so the
        # exception text can carry the key itself, a signed URL or a request body from
        # whatever backend resolved it — none of which belongs in a log line that exists
        # only to say "that route did not work, trying the environment".
        # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure
        logger.warning("Reranker credential resolution failed (%s); trying the env directly", type(e).__name__)

    return os.environ.get("AIQ_RERANKER_API_KEY", "") or os.environ.get(_KEY_ENV, "")


def _parse_rankings(payload: Any, candidate_count: int) -> list[int] | None:
    """Extract validated 0-based candidate indices, best first, or ``None``.

    Applies the same scepticism as the LLM judge's parser: an index outside the
    candidate range or repeated means the reply is not about the documents that
    were sent, and a ranking that mentions none of them is discarded rather than
    absorbed as an empty result.
    """
    if not isinstance(payload, dict):
        return None
    entries = payload.get(_RESULTS_KEY)
    if not isinstance(entries, list) or not entries:
        return None

    # (score, position, index). The provider returns its results already sorted,
    # so `position` is the tie-break and the fallback ordering when a score is
    # missing or non-numeric -- a scoreless-but-ordered reply still ranks
    # correctly. NaN is excluded by the isfinite check, because a single NaN
    # makes every comparison against it false and the sort order undefined.
    ordered: list[tuple[float, int, int]] = []
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        index = entry.get("index")
        if isinstance(index, bool) or not isinstance(index, int):
            continue
        if not 0 <= index < candidate_count:
            continue
        score = entry.get(_SCORE_KEY)
        usable = isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(float(score))
        ordered.append((float(score) if usable else 0.0, position, index))

    if not ordered:
        return None

    ordered.sort(key=lambda entry: (-entry[0], entry[1]))

    seen: set[int] = set()
    indices: list[int] = []
    for _, _, index in ordered:
        if index in seen:
            continue
        seen.add(index)
        indices.append(index)
    return indices or None


class CrossEncoderReranker:
    """Reranks chunks against a query via OpenRouter's reranking endpoint.

    Construct with :func:`resolve_cross_encoder`, which returns ``None`` when no
    provider is configured — so the caller never has to branch on config.
    """

    def __init__(
        self,
        provider: str = PROVIDER,
        *,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_doc_chars: int = DEFAULT_MAX_DOC_CHARS,
        organization_id: str | None = None,
    ):
        if provider != PROVIDER:
            raise ValueError(f"Unknown reranker provider {provider!r}; expected one of {available_providers()}")
        self.provider = provider
        self.base_url = (base_url or DEFAULT_BASE_URL or _DEFAULT_BASE_URL).rstrip("/")
        self.model = model or DEFAULT_MODEL or _DEFAULT_MODEL
        self.timeout_seconds = timeout_seconds
        self.max_doc_chars = max_doc_chars
        self._api_key = api_key if api_key is not None else _resolve_api_key(self.base_url, self.model, organization_id)

    @property
    def configured(self) -> bool:
        """True when a key resolved — without one every call would 401."""
        return bool(self._api_key)

    def _build_body(self, query: str, documents: list[str], top_n: int | None) -> dict[str, Any]:
        body: dict[str, Any] = {"model": self.model, "query": query, "documents": documents}
        # Non-positive means "no trim", matching `_trim` in rerank.py. `if top_n:` was
        # true for a negative value and `min()` kept it negative, so the provider was
        # asked for top_n=-1.
        if top_n and top_n > 0:
            body["top_n"] = min(top_n, len(documents))
        return body

    async def rerank(self, query: str, chunks: list[Any], *, top_n: int | None = None) -> list[Any] | None:
        """Return ``chunks`` re-ordered by cross-encoder relevance, or ``None``.

        ``None`` means "no opinion" — an unconfigured key, a transport failure, or
        a reply that could not be trusted. The caller keeps its existing order.
        """
        if not chunks or not query:
            return None
        if not self.configured:
            logger.warning("Cross-encoder provider %r has no API key resolved; skipping", self.provider)
            return None

        documents = [str(getattr(chunk, "content", ""))[: self.max_doc_chars] for chunk in chunks]
        url = f"{self.base_url}{_PATH}"
        try:
            # Imported inside the guard: httpx is an optional transitive dependency, and
            # an ImportError here must degrade to "no opinion" like every other failure.
            import httpx

            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    json=self._build_body(query, documents, top_n),
                )
                response.raise_for_status()
                payload = response.json()
        except Exception as e:
            logger.warning(
                "Cross-encoder rerank via %s failed (%s: %s); keeping retrieval order",
                self.provider,
                type(e).__name__,
                e,
            )
            return None

        indices = _parse_rankings(payload, len(chunks))
        if indices is None:
            logger.warning("Cross-encoder %s returned no usable ranking; keeping retrieval order", self.provider)
            return None

        ranked = [chunks[i] for i in indices]
        # A provider honouring top_n returns a subset. The unranked remainder keeps
        # its retrieval order behind the ranked head rather than being dropped, so
        # a small top_n can never shrink the candidate pool the caller expects.
        if len(ranked) < len(chunks):
            ranked.extend(chunk for position, chunk in enumerate(chunks) if position not in set(indices))
        return ranked


def resolve_cross_encoder(
    provider: str | None = None,
    *,
    model: str | None = None,
    base_url: str | None = None,
    timeout_seconds: float | None = None,
    max_doc_chars: int | None = None,
    organization_id: str | None = None,
) -> CrossEncoderReranker | None:
    """Build the configured cross-encoder, or ``None`` when reranking stays with the judge.

    Returns ``None`` — never raises — for ``none``/empty, an unknown provider name,
    or a key that does not resolve, so a misconfiguration degrades to the
    previous behaviour instead of taking retrieval down.
    """
    candidate = provider if provider is not None else DEFAULT_PROVIDER
    if not isinstance(candidate, str):
        logger.warning("Reranker provider %r is not a string; falling back to the LLM judge.", candidate)
        return None
    name = (candidate or "none").strip().lower()
    if name in {"", "none", "off", "false", "0", "llm_judge"}:
        return None
    if name != PROVIDER:
        logger.warning(
            "Unknown reranker provider %r; expected one of %s. Falling back to the LLM judge.",
            name,
            available_providers(),
        )
        return None

    reranker = CrossEncoderReranker(
        name,
        model=model,
        base_url=base_url,
        timeout_seconds=timeout_seconds if timeout_seconds is not None else DEFAULT_TIMEOUT_SECONDS,
        max_doc_chars=max_doc_chars if max_doc_chars is not None else DEFAULT_MAX_DOC_CHARS,
        organization_id=organization_id,
    )
    if not reranker.configured:
        # Logs the provider name and the NAME of the environment variable that was not
        # set — never a value. Suppressed rather than reworded so the message keeps
        # naming the variable an operator has to set.
        # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure
        logger.warning(
            "Reranker provider %r is configured but no API key resolved (AIQ_RERANKER_API_KEY / %s); "
            "falling back to the LLM judge.",
            name,
            _KEY_ENV,
        )
        return None
    logger.info("Cross-encoder reranking via %s (%s)", name, reranker.model)
    return reranker

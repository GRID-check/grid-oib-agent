"""Unified LLM credential resolution for the bespoke, non-NAT call sites.

Six credential paths grew up outside the NAT ``LLMProvider``/BYOK system (the
VLM captioner, the embeddings client, the tag-backfill script, and the two
BFF-invoked FastAPI routes — consistency-check and generate-summary). Each had
its own hand-rolled env chain, and none could reach an org's bring-your-own-key
(BYOK) credential. This module gives them ONE resolver so the same deployment
key (the org's OpenRouter/BYOK key) powers everything, exactly like the NAT
agents already do.

Resolution order (see :func:`resolve_llm_credential`):

  1. **BYOK** — when an ``organization_id`` is supplied, the org's bring-your-own
     credential from the BFF's internal endpoint wins. Mirroring ADR-0022/0014,
     a BYOK swap replaces ``api_key`` + ``base_url`` ONLY — never the model.
  2. **primary_env** — the call site's explicit override env var.
  3. **fallback_envs** — additional env vars, in order.
  4. **provider inference** — map the RESOLVED ``base_url`` host to that
     provider's conventional key env var (e.g. an ``openrouter.ai`` base URL
     pulls ``OPENROUTER_API_KEY``). This is what lets "just set OPENROUTER_API_KEY
     and point the base URL at OpenRouter" light up every call site with no
     per-site env plumbing.

Every env read goes through :func:`read_api_key_env`, which treats an
unresolved ``${...}`` placeholder as unset — docker compose ``env_file`` does
NOT interpolate ``${VAR}`` references, so a line like
``AIQ_VLM_API_KEY=${OPENROUTER_API_KEY}`` reaches the process as a literal
placeholder rather than a key.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)


def read_api_key_env(name: str) -> str:
    """Read an env var, treating an unresolved ``${...}`` placeholder as unset.

    docker compose ``env_file`` does not interpolate ``${VAR}`` references, so a
    line like ``AIQ_VLM_API_KEY=${OPENROUTER_API_KEY}`` reaches the process as a
    literal placeholder string rather than a resolved value. Returning ``""`` for
    such values keeps a mis-wired compose file from being read as a configured
    key/URL (which would, e.g., make ``vlm_available`` lie).
    """
    value = os.environ.get(name, "")
    if value.startswith("${") and value.endswith("}"):
        logger.error("%s contains an unresolved placeholder %r - treating as unset", name, value)
        return ""
    return value


# Map a resolved base-URL host -> the env var conventionally holding that
# provider's API key. Small and extensible on purpose: add a row when a new
# OpenAI-compatible provider is deployed. Matched by host substring (see
# :func:`_infer_provider_key_env`) so subdomains/paths do not matter.
PROVIDER_KEY_ENV_BY_HOST: dict[str, str] = {
    "openrouter.ai": "OPENROUTER_API_KEY",
    "integrate.api.nvidia.com": "NVIDIA_API_KEY",
    "api.openai.com": "OPENAI_API_KEY",
}


@dataclass(frozen=True)
class ResolvedCredential:
    """The outcome of a resolution.

    ``source`` labels WHERE ``api_key`` came from: ``'byok'`` (org credential),
    ``'env'`` (primary or fallback env var), ``'provider-default'`` (inferred
    from the base-URL host), or ``'none'`` (nothing resolved — ``api_key`` is
    ``""``). ``base_url``/``model`` are always populated (from env/defaults; a
    BYOK hit overrides ``base_url`` but never ``model``). ``api_key`` must never
    be logged.
    """

    api_key: str
    base_url: str
    model: str
    source: str


def _infer_provider_key_env(base_url: str) -> str | None:
    """Return the conventional key env var for ``base_url``'s host, or ``None``.

    Matches by host substring against :data:`PROVIDER_KEY_ENV_BY_HOST` so that,
    e.g., ``https://openrouter.ai/api/v1`` resolves to ``OPENROUTER_API_KEY``.
    """
    host = urlsplit(base_url).hostname or ""
    if not host:
        return None
    for needle, env_name in PROVIDER_KEY_ENV_BY_HOST.items():
        if needle in host:
            return env_name
    return None


def resolve_llm_credential(
    *,
    primary_env: str,
    fallback_envs: tuple[str, ...] = (),
    default_base_url: str,
    default_model: str,
    base_url_env: str | None = None,
    model_env: str | None = None,
    organization_id: str | None = None,
) -> ResolvedCredential:
    """Resolve an LLM credential for a bespoke (non-NAT) call site.

    See the module docstring for the resolution order. ``base_url`` and
    ``model`` are resolved first (from ``base_url_env``/``model_env`` when given,
    else the defaults) because the resolved ``base_url`` drives provider
    inference and both are returned to the caller.

    A BYOK hit (``organization_id`` given and the org has a credential) swaps
    ``api_key`` + ``base_url`` only — the model is left as resolved from
    env/defaults, matching the NAT model/credential separation (ADR-0022/0014).
    """
    base_url = (read_api_key_env(base_url_env) if base_url_env else "") or default_base_url
    base_url = base_url.rstrip("/")
    model = (read_api_key_env(model_env) if model_env else "") or default_model

    # 1. BYOK — the org's bring-your-own credential wins when we know the org.
    #    Fail-open lives in resolve_org_llm_credential (a BYOK hiccup returns
    #    None, so we fall through to the env chain below).
    if organization_id:
        from aiq_agent.common.llm_credentials import resolve_org_llm_credential

        credential = resolve_org_llm_credential(organization_id)
        if credential is not None:
            return ResolvedCredential(
                api_key=credential.api_key,
                base_url=credential.base_url.rstrip("/"),
                model=model,
                source="byok",
            )

    # 2. primary env override.
    key = read_api_key_env(primary_env) if primary_env else ""
    if key:
        return ResolvedCredential(api_key=key, base_url=base_url, model=model, source="env")

    # 3. fallback envs, in order.
    for name in fallback_envs:
        key = read_api_key_env(name)
        if key:
            return ResolvedCredential(api_key=key, base_url=base_url, model=model, source="env")

    # 4. provider inference: the key env for whatever provider base_url points
    #    at. This never changes base_url — it only picks the KEY for the
    #    already-configured endpoint.
    inferred_env = _infer_provider_key_env(base_url)
    if inferred_env:
        key = read_api_key_env(inferred_env)
        if key:
            return ResolvedCredential(api_key=key, base_url=base_url, model=model, source="provider-default")

    return ResolvedCredential(api_key="", base_url=base_url, model=model, source="none")

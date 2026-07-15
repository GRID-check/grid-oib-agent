"""Per-organization BYOK LLM credentials (ADR-0022).

Enterprise organizations can bring their own LLM provider key. The key lives
in WorkOS Vault (or the local encrypted store) behind the BFF; this module
pulls it **just in time** from the internal endpoint::

    GET {FRONTEND_INTERNAL_URL}/api/internal/llm-credential?organizationId=…
    x-grid-internal-token: {GRID_INTERNAL_API_TOKEN}

Design constraints (why pull, not push): the plaintext key must never ride
WebSocket-upgrade headers, Dask ``job_args`` (persisted in the job store), or
any shared cache. The org id — which already flows on every request
(``x-grid-organization-id``) and inside worker ``usage_context`` — is all the
backend needs.

Resolution is cached in-process (60 s positive / 30 s negative) and fails
OPEN to the workflow-YAML platform credential: a BYOK hiccup must never take
chat down. Key material is never logged; log lines carry only the
fingerprint the BFF computed.
"""

import logging
import os
import threading
import time
from dataclasses import dataclass
from dataclasses import field

logger = logging.getLogger(__name__)

POSITIVE_TTL_SECONDS = 60.0
NEGATIVE_TTL_SECONDS = 30.0
_REQUEST_TIMEOUT_SECONDS = 3.0

# Pydantic field names langchain chat models use for the credential pair.
# Checked in order; the first present on the model wins.
_API_KEY_FIELDS = ("openai_api_key", "api_key")
_BASE_URL_FIELDS = ("openai_api_base", "base_url")

# Client objects are rebuilt by the constructor's validators — carrying them
# into the new instance would keep traffic on the OLD credential.
_CLIENT_FIELDS = {"client", "root_client", "async_client", "root_async_client", "http_client", "http_async_client"}


@dataclass(frozen=True)
class OrgLLMCredential:
    """A resolved tenant credential. ``api_key`` must never be logged."""

    credential_id: str
    provider: str
    base_url: str
    api_key: str = field(repr=False)
    key_fingerprint: str = ""


class _CacheEntry:
    __slots__ = ("credential", "expires_at")

    def __init__(self, credential: OrgLLMCredential | None, ttl: float) -> None:
        self.credential = credential
        self.expires_at = time.monotonic() + ttl


_cache: dict[str, _CacheEntry] = {}
_cache_lock = threading.Lock()


def reset_credential_cache() -> None:
    """Test hook: clear the in-process resolution cache."""
    with _cache_lock:
        _cache.clear()


def _internal_base_url() -> str:
    return (os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000").rstrip("/")


def _fetch_credential(organization_id: str) -> OrgLLMCredential | None:
    """One HTTP round-trip to the BFF's internal resolution endpoint."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        # No internal-token trust channel — BYOK cannot be resolved securely.
        return None

    import httpx

    response = httpx.get(
        f"{_internal_base_url()}/api/internal/llm-credential",
        params={"organizationId": organization_id},
        headers={"x-grid-internal-token": token},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    data = payload.get("credential") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    api_key = data.get("apiKey")
    base_url = data.get("baseUrl")
    if not isinstance(api_key, str) or not api_key or not isinstance(base_url, str) or not base_url:
        return None
    return OrgLLMCredential(
        credential_id=str(data.get("id") or ""),
        provider=str(data.get("provider") or "custom"),
        base_url=base_url,
        api_key=api_key,
        key_fingerprint=str(data.get("keyFingerprint") or ""),
    )


def resolve_org_llm_credential(organization_id: str | None) -> OrgLLMCredential | None:
    """The org's active BYOK credential, or None for the platform default.

    In-process TTL cache keeps the hot path free of network calls; errors are
    negative-cached and fail OPEN (platform credential) with a warning that
    carries no key material.
    """
    if not organization_id:
        return None

    now = time.monotonic()
    with _cache_lock:
        entry = _cache.get(organization_id)
        if entry is not None and entry.expires_at > now:
            return entry.credential

    try:
        credential = _fetch_credential(organization_id)
        ttl = POSITIVE_TTL_SECONDS if credential else NEGATIVE_TTL_SECONDS
    except Exception as exc:  # noqa: BLE001 - fail open by design
        logger.warning("BYOK credential resolution failed for org %s: %s", organization_id, type(exc).__name__)
        credential = None
        ttl = NEGATIVE_TTL_SECONDS

    with _cache_lock:
        _cache[organization_id] = _CacheEntry(credential, ttl)
        # Bounded: one entry per org this process has served recently.
        if len(_cache) > 512:
            expired = [key for key, value in _cache.items() if value.expires_at <= now]
            for key in expired:
                _cache.pop(key, None)

    if credential is not None:
        logger.info(
            "BYOK credential active for org %s (provider=%s, fingerprint=%s)",
            organization_id,
            credential.provider,
            credential.key_fingerprint,
        )
    return credential


def get_org_llm_credential_from_context() -> OrgLLMCredential | None:
    """Resolve the BYOK credential for the current request's organization."""
    from aiq_agent.project_context import get_organization_id_from_context

    return resolve_org_llm_credential(get_organization_id_from_context())


def apply_org_credential(llm: object, credential: OrgLLMCredential | None = None) -> object:
    """Return ``llm`` re-pointed at the tenant's provider + key.

    Unlike the model-id override (``override_model``), a credential swap
    cannot use ``model_copy``: langchain chat models bind their HTTP clients
    at construction, so a copied model would silently keep calling with the
    OLD key. The model is therefore reconstructed through its constructor
    (client fields dropped, credential fields replaced), which re-runs the
    validators that build the clients. Fails open to the original ``llm``.
    """
    if credential is None:
        credential = get_org_llm_credential_from_context()
    if credential is None:
        return llm

    fields = getattr(type(llm), "model_fields", None)
    if not fields:
        logger.warning("Cannot apply BYOK credential to %s: not a pydantic model", type(llm).__name__)
        return llm

    key_field = next((name for name in _API_KEY_FIELDS if name in fields), None)
    base_field = next((name for name in _BASE_URL_FIELDS if name in fields), None)
    if key_field is None or base_field is None:
        logger.warning("Cannot apply BYOK credential to %s: no credential fields", type(llm).__name__)
        return llm

    try:
        data = {}
        for name in fields:
            if name in _CLIENT_FIELDS:
                continue
            try:
                data[name] = getattr(llm, name)
            except AttributeError:
                continue
        data[key_field] = credential.api_key
        data[base_field] = credential.base_url
        return type(llm)(**data)
    except Exception:
        logger.warning(
            "Failed to apply BYOK credential (fingerprint=%s) to %s; using platform credential",
            credential.key_fingerprint,
            type(llm).__name__,
            exc_info=True,
        )
        return llm

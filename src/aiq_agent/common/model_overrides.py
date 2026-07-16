"""Per-organization runtime model overrides (``X-Grid-Model-Overrides``).

Org admins can re-point each *agent group* at a different OpenRouter model at
runtime (see docs/architecture/org-model-configuration.md and ADR-0014). The
BFF resolves the org's active configuration version at the WebSocket upgrade
and forwards it as the base64url-encoded JSON header::

    X-Grid-Model-Overrides: base64url({"shallow_research": "vendor/model", ...})

The backend treats the header as advisory *model selection only*: every other
generation parameter (max_tokens, reasoning_effort, base_url, api_key) still
comes from the workflow YAML, so an override can never re-point traffic at a
different provider or credential. Unknown groups and malformed ids are
dropped; a missing/broken header means "use the YAML defaults" (fail-open to
defaults, never an error — model selection must not take chat down).
"""

import base64
import json
import logging
import os
import re
import threading
import time
import types
from enum import StrEnum

logger = logging.getLogger(__name__)

MODEL_OVERRIDES_HEADER = "x-grid-model-overrides"

# Org-scoped fallback resolution (mirrors llm_credentials): endpoints the BFF
# does not front carry no override header, and the WebSocket-scope injection is
# best-effort — in both cases the backend can still resolve the org's active
# overrides itself from the internal endpoint, keyed by the org id that already
# flows on every request.
_POSITIVE_TTL_SECONDS = 60.0
_NEGATIVE_TTL_SECONDS = 30.0
_REQUEST_TIMEOUT_SECONDS = 3.0

# Model ids are OpenRouter's `author/slug` (optional `:variant` suffix, e.g.
# `meta-llama/llama-4:free`) OR — for orgs on a BYOK credential (ADR-0022) —
# a provider-native id without a slash (`gpt-4o`, `ft:gpt-4o:acme::abc`,
# Azure deployment names). Anything else is dropped — defense in depth
# behind the BFF's catalog validation. Mirrors MODEL_ID_PATTERN in
# `frontends/ui/src/lib/model-config/agent-groups.ts`.
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}(/[A-Za-z0-9_.:-]{1,128})?$")


class AgentGroup(StrEnum):
    """Semantic agent groups an org admin can independently re-model.

    Groups deliberately sit *above* the YAML LLM names: they are stable,
    user-meaningful override points, while the YAML remains free to reshuffle
    which named LLM serves which role. The registry mirror lives in
    ``frontends/ui/src/lib/model-config/agent-groups.ts`` (which additionally
    carries the OpenRouter capability requirements per group) — keep the two
    id sets in sync.
    """

    INTENT = "intent"
    CLARIFIER = "clarifier"
    SHALLOW_RESEARCH = "shallow_research"
    DEEP_RESEARCH = "deep_research"
    DEEP_RESEARCH_ROUTER = "deep_research_router"
    MEMORY_REFLECTION = "memory_reflection"


def parse_model_overrides(raw: str | None) -> dict[str, str]:
    """Decode and sanitize a raw header value into ``{group: model_id}``.

    Tolerates padded/unpadded base64url. Silently drops unknown group ids and
    model ids that don't look like OpenRouter slugs.
    """
    if not raw:
        return {}
    try:
        padded = raw + "=" * (-len(raw) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        data = json.loads(decoded)
    except Exception:
        logger.warning("Ignoring malformed %s header", MODEL_OVERRIDES_HEADER, exc_info=True)
        return {}
    return sanitize_model_overrides(data)


def sanitize_model_overrides(data: object) -> dict[str, str]:
    """Reduce an untrusted mapping to ``{known_group: plausible_model_id}``."""
    if not isinstance(data, dict):
        logger.warning("Ignoring model overrides: expected JSON object, got %s", type(data).__name__)
        return {}

    valid_groups = {g.value for g in AgentGroup}
    overrides: dict[str, str] = {}
    for group, model_id in data.items():
        if group not in valid_groups:
            logger.debug("Dropping model override for unknown agent group %r", group)
            continue
        if not isinstance(model_id, str) or not _MODEL_ID_RE.match(model_id):
            logger.warning("Dropping invalid model id %r for agent group %r", model_id, group)
            continue
        overrides[group] = model_id
    return overrides


class _OverridesCacheEntry:
    __slots__ = ("expires_at", "overrides")

    def __init__(self, overrides: dict[str, str], ttl: float) -> None:
        self.overrides = overrides
        self.expires_at = time.monotonic() + ttl


_overrides_cache: dict[str, _OverridesCacheEntry] = {}
_overrides_cache_lock = threading.Lock()


def reset_overrides_cache() -> None:
    """Test hook: clear the in-process resolution cache."""
    with _overrides_cache_lock:
        _overrides_cache.clear()


def _fetch_org_overrides(organization_id: str) -> dict[str, str]:
    """One HTTP round-trip to the BFF's internal model-overrides endpoint."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        # No internal-token trust channel — fall back to YAML defaults.
        return {}

    import httpx

    base_url = (os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000").rstrip("/")
    response = httpx.get(
        f"{base_url}/api/internal/model-overrides",
        params={"organizationId": organization_id},
        headers={"x-grid-internal-token": token},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    overrides = payload.get("overrides") if isinstance(payload, dict) else None
    return sanitize_model_overrides(overrides) if overrides else {}


def resolve_org_model_overrides(organization_id: str | None) -> dict[str, str]:
    """The org's active model overrides, resolved by org id.

    In-process TTL cache (60 s positive / 30 s negative) keeps the hot path
    free of network calls; errors are negative-cached and fail OPEN to the
    YAML defaults — model selection must never take chat down.
    """
    if not organization_id:
        return {}

    now = time.monotonic()
    with _overrides_cache_lock:
        entry = _overrides_cache.get(organization_id)
        if entry is not None and entry.expires_at > now:
            return entry.overrides

    try:
        overrides = _fetch_org_overrides(organization_id)
        ttl = _POSITIVE_TTL_SECONDS if overrides else _NEGATIVE_TTL_SECONDS
    except Exception as exc:  # noqa: BLE001 - fail open by design
        logger.warning("Model-override resolution failed for org %s: %s", organization_id, type(exc).__name__)
        overrides = {}
        ttl = _NEGATIVE_TTL_SECONDS

    with _overrides_cache_lock:
        _overrides_cache[organization_id] = _OverridesCacheEntry(overrides, ttl)
        if len(_overrides_cache) > 512:
            expired = [key for key, value in _overrides_cache.items() if value.expires_at <= now]
            for key in expired:
                _overrides_cache.pop(key, None)

    return overrides


def get_model_overrides_from_context() -> dict[str, str]:
    """The current request's model overrides.

    Reads the ``x-grid-model-overrides`` header first (present on BFF-fronted
    requests; a WebSocket connection keeps its upgrade-time value, preserving
    the documented per-conversation pinning). When the header is absent —
    endpoints the BFF does not front, or a failed best-effort injection — falls
    back to resolving the org's active overrides via the internal endpoint,
    mirroring BYOK credential resolution.

    Returns ``{}`` when no overrides apply — callers then use the
    YAML-configured models unchanged.
    """
    from aiq_agent.project_context import _read_header

    raw = _read_header(MODEL_OVERRIDES_HEADER)
    if raw:
        return parse_model_overrides(raw)

    from aiq_agent.project_context import get_organization_id_from_context

    return resolve_org_model_overrides(get_organization_id_from_context())


def _rebind_instance_method_patches(original: object, copy_obj: object) -> None:
    """Rebind instance-level method wrappers (e.g. NAT ``patch_with_retry``) to the copy.

    NAT's LLM builders wrap every public method of the chat model with retry
    wrappers stored in the instance ``__dict__`` as ``types.MethodType`` bound
    to the *original* instance. Pydantic ``model_copy`` shallow-copies
    ``__dict__``, so without rebinding every call on the override copy keeps
    executing against the original instance — the copied ``model_name`` field
    looks overridden, but the request payload still carries the original's
    model. Rebind any such instance-level bound methods to the copy.
    """
    try:
        attrs = list(vars(copy_obj).items())
    except TypeError:
        return
    for name, attr in attrs:
        if isinstance(attr, types.MethodType) and attr.__self__ is original:
            object.__setattr__(copy_obj, name, types.MethodType(attr.__func__, copy_obj))


def override_model(llm: object, model_id: str) -> object:
    """Return a copy of a LangChain chat model pointed at ``model_id``.

    Uses pydantic ``model_copy`` so the returned object is a real chat model
    (``bind_tools``/``with_structured_output`` keep working) that shares the
    underlying HTTP client with the original — the model name only changes the
    per-request payload. Returns the original llm unchanged when it doesn't
    expose a recognizable model field.
    """
    field = None
    if hasattr(llm, "model_name"):
        field = "model_name"
    elif hasattr(llm, "model"):
        field = "model"
    if field is None or not hasattr(llm, "model_copy"):
        logger.warning("Cannot apply model override to %s: no model field/model_copy", type(llm).__name__)
        return llm
    # reasoning_effort is deliberately NOT touched here: configs hold
    # OpenRouter-standard values and OpenRouter maps them to the nearest level
    # the overridden model supports (see the note in llm_factory).
    try:
        overridden = llm.model_copy(update={field: model_id})
    except Exception:
        logger.warning("Failed to apply model override %r to %s", model_id, type(llm).__name__, exc_info=True)
        return llm
    _rebind_instance_method_patches(llm, overridden)
    return overridden


def apply_model_override(llm: object, group: AgentGroup, overrides: dict[str, str] | None = None) -> object:
    """Apply the current request's override for ``group`` to ``llm``, if any.

    ``overrides`` may be passed explicitly when the caller already read them
    (e.g. captured before scheduling background work); defaults to reading the
    live request context.
    """
    if overrides is None:
        overrides = get_model_overrides_from_context()
    model_id = overrides.get(group.value)
    if not model_id:
        return llm
    logger.info("Model override active: agent group %s -> %s", group.value, model_id)
    return override_model(llm, model_id)

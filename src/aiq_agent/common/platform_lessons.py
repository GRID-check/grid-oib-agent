"""Platform lessons — the injected digest of user-reported failure patterns.

The product's own correction ratchet (docs/contributing/correction-ratchet.md
applied to the product itself: "human intervention is a failure signal"). The
BFF distills down-votes into anonymized, deduplicated lessons
(docs/architecture/platform-failure-learning.md); this module resolves the
bounded digest of ACTIVE lessons through the same token-guarded internal
channel as the retrieval settings (``GET /api/internal/platform-lessons/digest``),
TTL-cached and fail-open.

Platform-wide by design — no org layer and no per-request header: a lesson is
anonymized fleet knowledge, identical for every tenant. Fail-open by design: a
BFF outage must never take answering down, so every error path returns None
and the prompt simply renders no lessons block.
"""

import hashlib
import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

# In-process cache TTLs, same rationale as retrieval_settings: a curation
# change reaches the fleet within a minute; failures are retried sooner so a
# BFF blip does not suppress the lessons for long.
_POSITIVE_TTL_SECONDS = 60.0
_NEGATIVE_TTL_SECONDS = 30.0
_REQUEST_TIMEOUT_SECONDS = 3.0

# Hard ceiling on what this module will inject, whatever the BFF sent. The BFF
# bounds the digest to 1600 chars (lib/platform-lessons/service.ts); this is
# the read-side seatbelt, not the budget.
_MAX_DIGEST_CHARS = 2400

_EXPECTED_HEADER = "PLATFORM_LESSONS"


class _CacheEntry:
    __slots__ = ("digest", "expires_at")

    def __init__(self, digest: str | None, ttl: float) -> None:
        self.digest = digest
        self.expires_at = time.monotonic() + ttl


_cache: _CacheEntry | None = None
_cache_lock = threading.Lock()


def reset_platform_lessons_cache() -> None:
    """Test hook: clear the in-process resolution cache."""
    global _cache
    with _cache_lock:
        _cache = None


def sanitize_lessons_digest(value: object) -> str | None:
    """Reduce an untrusted payload to a bounded, well-formed digest or None."""
    if not isinstance(value, str):
        return None
    digest = value.strip()
    if not digest or not digest.startswith(_EXPECTED_HEADER):
        return None
    if len(digest) > _MAX_DIGEST_CHARS:
        digest = digest[:_MAX_DIGEST_CHARS]
    return digest


def _fetch_digest() -> str | None:
    """One HTTP round-trip to the BFF's internal platform-lessons endpoint."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        # No internal-token trust channel — no lessons, and no error.
        return None

    import httpx

    base_url = (os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000").rstrip("/")
    response = httpx.get(
        f"{base_url}/api/internal/platform-lessons/digest",
        headers={"x-grid-internal-token": token},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return None
    return sanitize_lessons_digest(payload.get("digest"))


def is_in_holdout_slice(conversation_id: str, holdout_pct: int) -> bool:
    """Whether this conversation is in the lessons control group.

    The Python twin of ``isInHoldoutSlice`` in
    ``frontends/ui/src/lib/platform-lessons/holdout.ts``: sha256 of the
    conversation id, first four bytes, modulo 100. Both tiers must reach the
    same verdict from the same key with no shared state — this tier decides
    whether to INJECT, the BFF decides how to LABEL the resulting vote, and a
    disagreement would silently mislabel every measurement.

    Keyed on the conversation so a thread stays in one arm: a user must not get
    a lesson-shaped answer and a lesson-free one to the same follow-up.
    """
    if holdout_pct <= 0 or not conversation_id:
        return False
    if holdout_pct >= 100:
        return True
    digest = hashlib.sha256(conversation_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % 100 < holdout_pct


def get_platform_lessons_digest(conversation_id: str | None = None) -> str | None:
    """The active-lessons digest, or None when there is none to inject.

    Returns None for a conversation in the holdout slice — the control group
    that receives no lessons at all, so the two down-vote rates can be
    compared (``lessons.holdout_pct``, default 0 = measurement off).

    Never raises. Called once per turn (register layer); the TTL cache keeps
    the per-turn cost at zero between refreshes. Blocking I/O — call it via
    ``asyncio.to_thread`` from async code, like ``fetch_memory_digest``.
    """
    if conversation_id:
        try:
            from aiq_agent.common.retrieval_settings import get_retrieval_setting

            holdout_pct = get_retrieval_setting("lessons.holdout_pct", 0)
            if is_in_holdout_slice(conversation_id, holdout_pct):
                return None
        except Exception:  # noqa: BLE001 - fail open: measurement never blocks answering
            logger.debug("Holdout resolution failed; treating this turn as treated", exc_info=True)
    global _cache
    now = time.monotonic()
    with _cache_lock:
        if _cache is not None and _cache.expires_at > now:
            return _cache.digest

    try:
        digest = _fetch_digest()
        ttl = _POSITIVE_TTL_SECONDS if digest else _NEGATIVE_TTL_SECONDS
    except Exception as exc:  # noqa: BLE001 - fail open by design
        logger.warning("Platform-lessons resolution failed: %s", type(exc).__name__)
        digest, ttl = None, _NEGATIVE_TTL_SECONDS

    with _cache_lock:
        _cache = _CacheEntry(digest, ttl)
    return digest


#: The framing that travels WITH the lessons, rendered once here rather than
#: copied into each agent's template.
#:
#: The wording is load-bearing and was the subject of an explicit review: a
#: lesson is a META process caution with zero factual authority, most turns it
#: does not apply, and everything else the agent has — retrieval, documents,
#: the project profile, the live conversation — outranks it. Two prompts
#: carrying two versions of that caveat is how one of them quietly becomes
#: "helpful background knowledge", which is exactly the failure the meta-only
#: rule exists to prevent.
_LESSONS_BLOCK_HEADER = (
    "### PLATFORM_LESSONS — process cautions from reported failures. Meta-level only.\n"
    "A `PLATFORM_LESSONS v1` block follows. Each line is a caution distilled from answers users "
    "reported as bad — anonymized, deduplicated, tagged `[category | Nx]` (N = how often reported).\n"
    "\n"
    "These are **meta-level process cautions, not knowledge, and most turns they simply do not "
    "apply**. A lesson may adjust HOW you work — what to double-check, when to retrieve deeper, "
    "when to ask — and never WHAT is true. They carry zero factual authority: never cite one, "
    "never treat one as evidence about any norm, document or project, and never let one override "
    "retrieval, uploaded documents, the project profile or the current conversation — every one of "
    "those outranks every lesson. Do not mention lessons in answers or go looking for ways to apply "
    "them; act on one only when its failure pattern exactly matches the turn in front of you, and "
    "otherwise ignore this block entirely.\n"
)


def render_lessons_block(digest: str | None) -> str | None:
    """The full prompt section for ``digest``, or None when there is nothing.

    Returning None rather than an empty string is what lets every template
    guard it with a plain truthiness test and render no heading at all.
    """
    if not digest or not digest.strip():
        return None
    return f"{_LESSONS_BLOCK_HEADER}\n{digest.strip()}\n"

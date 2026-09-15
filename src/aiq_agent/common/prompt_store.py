"""The platform prompt, served from Langfuse, with the committed file as the floor.

WHAT IS MANAGED, AND WHY ONLY THAT HALF
=======================================
Piloti's system prompt is two halves split at the ``KV CACHE BOUNDARY`` marker
in ``agents/piloti/prompts/piloti.j2``: a STATIC half that is byte-identical
for every tenant and every turn, and a DYNAMIC half Jinja renders per turn from
that turn's state. Only the static half is worth managing remotely — it is the
half a prompt author wants to change without shipping a release, and the half
whose bytes must not move for a provider's prefix cache to hit.

**Langfuse is the source of truth for that half.** It is authored there,
versioned there and labelled there, and this module PULLS it at render time.
Nothing in this repository writes to it.

``agents/piloti/prompts/piloti_static.md`` is the BUNDLED FALLBACK, not the
original: the text a process renders when prompt management is off, when the
credentials are absent, when Langfuse is unreachable, or when it holds no such
prompt. It is allowed to lag the live version — an image that has been running
a month carries a month-old fallback — and ``scripts/prompts_pull.py``
(``task prompts:pull``) is how a maintainer refreshes it when the drift gets
uncomfortable. A file that differs from Langfuse is not a failure, so nothing
checks it and no CI job gates on it.

That is the same shape as the admin-controlled model default (ADR-0014): the
committed value is the boot fallback, and the live value is set somewhere an
operator can reach without a deploy.

AVAILABILITY = FLAG AND CAPABILITY
==================================
Two env vars, and the house's capability doctrine says which is which
(``docs/contributing/code-conventions.md``):

* ``LANGFUSE_PROMPTS_ENABLED`` is the **product decision** — whether a remote
  store is allowed to be the authority for the text this fleet reasons with.
* ``LANGFUSE_PUBLIC_KEY`` / ``LANGFUSE_SECRET_KEY`` (+ ``LANGFUSE_HOST``) are
  the **dependency**, from which the capability is derived. They are Langfuse's
  own env names, read by its SDK, and they carry the same project keys the
  deployment already stores for the trace exporter (``public-key`` /
  ``secret-key`` in the Langfuse Secret, see ``deploy/pulumi/src/platform/langfuse.ts``).

Unset or disabled: this module returns the caller's fallback and touches no
network at all.

THE SDK, NOT A HAND-WRITTEN CLIENT
==================================
"Buy, don't build" says the ~80-line REST client is only the honest answer when
the library's shape does not answer our question. Here it does, once one
question is settled: **can the Langfuse SDK be constructed without installing
its own global OpenTelemetry tracer provider?** This process already exports
spans to Langfuse through NAT's pipeline and an OTel collector; a second
provider — or a second span processor on ours — is the failure to avoid.

Verified against langfuse 4.15.3, not remembered. ``LangfuseResourceManager``
guards the whole tracing block on the constructor's ``tracing_enabled``::

    # OTEL Tracer
    if tracing_enabled:
        tracer_provider = tracer_provider or _init_tracer_provider(...)
        ...
        tracer_provider.add_span_processor(langfuse_processor)

With ``tracing_enabled=False`` neither ``set_tracer_provider`` nor
``add_span_processor`` is reached, and the process's global provider is left
exactly as it was. That is asserted by a test rather than trusted, because it
is the assumption the whole choice rests on and an SDK minor could move it.

What the SDK's shape did drag in, and we accept: three daemon threads (media
upload and score ingestion) for features we do not use, an ``atexit`` handler
and a fork handler. What we get for them is ``get_prompt``'s TTL cache,
stale-while-revalidate, retry/timeout budget and fallback — plus the label
lookup ``scripts/prompts_pull.py`` needs, which is the second endpoint we would
otherwise have hand-written.

ONE THING THE SDK DOES NOT DO, AND WE ADD
=========================================
A FAILED fetch is not cached. ``Langfuse.get_prompt`` returns the fallback
(or raises) without writing anything to its cache, so with Langfuse unreachable
every single call re-attempts the network and logs its own error. On a per-turn
call path that is a network round-trip and a log line on every turn. So this
store mutes a name for the cache TTL after a failure: the first failed turn
pays one bounded attempt, the next ones pay nothing, and the failure is logged
once per class rather than once per turn.

The budget, therefore: at most one attempt per TTL window, each bounded by
``FETCH_TIMEOUT_SECONDS`` with retries off, and nothing raises into a turn.

WHY NO CACHE-KEY CHANGE IS NEEDED
=================================
``common/prompt_caching.py`` derives the provider cache-shard key by hashing
the RENDERED system prompt. A new Langfuse version therefore rolls the shard by
itself, the first turn that renders it: nothing there has to learn what a
prompt version is.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from typing import Protocol

logger = logging.getLogger(__name__)

#: The product decision: may a remote store be the authority for the prompt.
ENABLED_ENV = "LANGFUSE_PROMPTS_ENABLED"
#: Which label to serve. Other labels exist for experiments; production is what runs.
LABEL_ENV = "LANGFUSE_PROMPT_LABEL"
#: How long a fetched version is served before a background refresh is started.
CACHE_TTL_ENV = "LANGFUSE_PROMPT_CACHE_TTL_SECONDS"
#: The dependency. Langfuse's own env names, read by its SDK as well as by us.
PUBLIC_KEY_ENV = "LANGFUSE_PUBLIC_KEY"
SECRET_KEY_ENV = "LANGFUSE_SECRET_KEY"  # pragma: allowlist secret
HOST_ENV = "LANGFUSE_HOST"

DEFAULT_LABEL = "production"
DEFAULT_CACHE_TTL_SECONDS = 60
#: A turn waits at most this long on the first fetch, and never retries within it.
FETCH_TIMEOUT_SECONDS = 2
#: Retries are the SDK's default 2 with exponential backoff; a turn cannot pay that.
FETCH_MAX_RETRIES = 0

_TRUTHY = frozenset({"1", "true", "yes", "on"})


@dataclass(frozen=True)
class ResolvedPrompt:
    """One prompt text plus the identity a trace should be able to name.

    ``version`` is a string rather than an int because the two authorities
    number differently: Langfuse counts versions from 1, and a fallback render
    is identified by the git blob hash of the committed file. A trace filter
    reads both as opaque labels.
    """

    text: str
    name: str
    version: str
    is_fallback: bool = False


class PromptFetcher(Protocol):
    """The slice of ``langfuse.Langfuse`` this store uses.

    Narrow on purpose: a test fake implements one method, and the store cannot
    quietly start using the rest of the SDK without this line changing.
    """

    def get_prompt(
        self,
        name: str,
        *,
        label: str,
        cache_ttl_seconds: int,
        fallback: str,
        max_retries: int,
        fetch_timeout_seconds: int,
    ) -> Any: ...


def git_blob_version(path: Path) -> str:
    """The short git blob hash of a file, computed the way ``git hash-object`` does.

    Used as the version of a prompt served from the committed file, so a trace
    says WHICH text the answer was produced with and an operator can find it
    with ``git cat-file -p <hash>``. Computed from the bytes rather than by
    shelling out: this runs in a container that has no git and no ``.git``.
    """
    data = path.read_bytes()
    # SHA-1 is what a git blob id IS; a different algorithm would compute a
    # hash `git cat-file` cannot find. It identifies a text, it signs nothing.
    # nosemgrep: python.lang.security.insecure-hash-algorithms.insecure-hash-algorithm-sha1
    digest = hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False)
    return digest.hexdigest()[:7]


def prompt_management_enabled() -> bool:
    """Whether a remote store may be the authority for prompt text.

    Defaults to FALSE, so a deployment that has not opted in renders exactly
    the bytes in its image.
    """
    return os.environ.get(ENABLED_ENV, "").strip().lower() in _TRUTHY


def configured_label() -> str:
    """The label to serve. ``production`` unless the deployment says otherwise."""
    return os.environ.get(LABEL_ENV, "").strip() or DEFAULT_LABEL


def configured_cache_ttl_seconds() -> int:
    """Seconds a fetched version is served before a background refresh starts."""
    raw = os.environ.get(CACHE_TTL_ENV, "").strip()
    if not raw:
        return DEFAULT_CACHE_TTL_SECONDS
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("%s is not an integer (%r); using %ss", CACHE_TTL_ENV, raw, DEFAULT_CACHE_TTL_SECONDS)
        return DEFAULT_CACHE_TTL_SECONDS


def build_langfuse_client() -> PromptFetcher | None:
    """The Langfuse SDK client, or None when the credentials are not present.

    ``tracing_enabled=False`` is the load-bearing argument: it is what keeps the
    SDK from registering a global tracer provider or hanging its own span
    processor on ours. See the module docstring, and
    ``tests/aiq_agent/common/test_prompt_store.py`` for the assertion.
    """
    public_key = os.environ.get(PUBLIC_KEY_ENV, "").strip()
    secret_key = os.environ.get(SECRET_KEY_ENV, "").strip()
    if not public_key or not secret_key:
        return None
    from langfuse import Langfuse

    return Langfuse(
        public_key=public_key,
        secret_key=secret_key,
        host=os.environ.get(HOST_ENV, "").strip() or None,
        tracing_enabled=False,
        timeout=FETCH_TIMEOUT_SECONDS,
    )


class PromptStore:
    """Serves prompt text from Langfuse, falling back to what the caller committed.

    Never raises into a turn and never blocks one beyond a single bounded
    attempt per TTL window. Construct it with a ``client_factory`` and a
    ``clock`` to test it without a network or a wall clock.
    """

    def __init__(
        self,
        *,
        client_factory: Callable[[], PromptFetcher | None] = build_langfuse_client,
        clock: Callable[[], float] = time.monotonic,
        enabled: bool | None = None,
        label: str | None = None,
        cache_ttl_seconds: int | None = None,
    ) -> None:
        self._client_factory = client_factory
        self._clock = clock
        self._enabled = prompt_management_enabled() if enabled is None else enabled
        self._label = label or configured_label()
        self._cache_ttl_seconds = configured_cache_ttl_seconds() if cache_ttl_seconds is None else cache_ttl_seconds
        self._client: PromptFetcher | None = None
        self._client_resolved = False
        self._muted_until: dict[str, float] = {}
        self._logged: set[str] = set()

    def get(self, name: str, *, fallback: ResolvedPrompt) -> ResolvedPrompt:
        """The live text for ``name``, or ``fallback`` for every reason it is not available.

        Disabled, uncredentialed, muted after a recent failure, or the fetch
        failed or returned something unusable — all of them return the caller's
        fallback, which is the text that shipped in the image.
        """
        if not self._enabled:
            return fallback
        if self._clock() < self._muted_until.get(name, 0.0):
            return fallback
        fetcher = self._fetcher()
        if fetcher is None:
            return fallback
        return self._fetch(fetcher, name, fallback) or fallback

    def _fetcher(self) -> PromptFetcher | None:
        """The client, built at most once. A failed build is not retried."""
        if self._client_resolved:
            return self._client
        self._client_resolved = True
        try:
            self._client = self._client_factory()
        except Exception:
            self._client = None
            logger.warning("Langfuse prompt client could not be built; serving committed prompts", exc_info=True)
            return None
        if self._client is None:
            logger.info("Langfuse prompt management is on but %s/%s are unset", PUBLIC_KEY_ENV, SECRET_KEY_ENV)
        return self._client

    def _fetch(self, fetcher: PromptFetcher, name: str, fallback: ResolvedPrompt) -> ResolvedPrompt | None:
        """One bounded fetch, or None with the name muted for the TTL window."""
        try:
            fetched = fetcher.get_prompt(
                name,
                label=self._label,
                cache_ttl_seconds=self._cache_ttl_seconds,
                fallback=fallback.text,
                max_retries=FETCH_MAX_RETRIES,
                fetch_timeout_seconds=FETCH_TIMEOUT_SECONDS,
            )
        except Exception:
            self._mute(name, "fetch-failed", exc_info=True)
            return None
        # The SDK answers an unreachable API with the fallback we handed it
        # rather than an exception, so a served fallback is a failure report.
        if getattr(fetched, "is_fallback", False):
            self._mute(name, "fetch-failed")
            return None
        text = getattr(fetched, "prompt", None)
        if not isinstance(text, str) or not text.strip():
            self._mute(name, "unusable-prompt")
            return None
        version = str(getattr(fetched, "version", "") or "unknown")
        return ResolvedPrompt(text=text, name=name, version=version, is_fallback=False)

    def _mute(self, name: str, reason: str, *, exc_info: bool = False) -> None:
        """Stop asking for ``name`` until the TTL window passes, and say so once.

        Once per failure CLASS, not once per turn: the log line is the signal
        that a fleet is running on its committed prompt, and a line per turn
        would bury it in itself.
        """
        self._muted_until[name] = self._clock() + max(self._cache_ttl_seconds, DEFAULT_CACHE_TTL_SECONDS)
        key = f"{name}:{reason}"
        if key in self._logged:
            return
        self._logged.add(key)
        logger.warning(
            "Langfuse prompt %r unavailable (%s); serving the committed prompt for the next %ss",
            name,
            reason,
            max(self._cache_ttl_seconds, DEFAULT_CACHE_TTL_SECONDS),
            exc_info=exc_info,
        )


_STORE: PromptStore | None = None


def prompt_store() -> PromptStore:
    """The process's store, built on first use.

    Module-level like the registries NAT populates at boot, and for the same
    reason: the SDK client, its TTL cache and its threads are per-process, not
    per-turn. :func:`reset_prompt_store` is how a test gets a blank slate.
    """
    global _STORE
    if _STORE is None:
        _STORE = PromptStore()
    return _STORE


def reset_prompt_store() -> None:
    """Drop the process store so the next call re-reads the environment. Test-only."""
    global _STORE
    _STORE = None

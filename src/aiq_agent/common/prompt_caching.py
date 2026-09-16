"""Provider prompt-cache affinity: keep one turn's stable prefix on one shard.

WHAT THE PROVIDER ALREADY DOES, AND WHAT IT NEEDS FROM US
========================================================
Every research turn re-sends the same ~35 KB of prefix — the system prompt
(rendered once per run and cached on the agent state) plus the bound tool
schemas — on each of its 3-6 model calls. Providers in the OpenAI family cache
that prefix **automatically**: "Prompt caching with OpenAI is automated and does
not require any additional configuration. There is a minimum prompt size of 1024
tokens." (https://openrouter.ai/docs/features/prompt-caching). Nothing in the
request body turns it on, and no ``cache_control`` breakpoint is needed — those
are Anthropic's and Alibaba's explicit mechanism, not OpenAI's.

What caching *does* need is landing on the same upstream endpoint twice. A cache
lives inside one provider; OpenRouter load-balances a model across several. Its
answer is sticky routing, and the key it sticks on is ours to supply::

    For more explicit control over sticky routing, you can pass a `session_id`
    in your request. When a `session_id` is present, OpenRouter uses it directly
    as the sticky routing key instead of deriving one from message hashing.
    […] When `session_id` is set, sticky routing activates on any successful
    request — even before cache usage is observed […]. Without `session_id`,
    sticky routing only activates after a cache hit is detected.

Without a key, OpenRouter derives one by hashing the first system message and
the first non-system message, and only starts pinning **after** it has seen a
hit — which a fleet spread over several endpoints may never produce. That is the
chicken-and-egg this module breaks.

``prompt_cache_key`` rides along for the same reason one layer up: it is
OpenAI's own cache-shard hint ("Use separate keys to maintain separate cache
accounting for customers or users"), and OpenRouter falls back to it as the
sticky key when no ``session_id`` is present, so sending both is coherent rather
than redundant. Both are declared top-level fields of OpenRouter's ChatRequest
*and* its Responses request, so the gateway parses them itself and no upstream
provider can reject them as unknown parameters — which is what makes this safe
for a model an admin re-points us at (ADR-0014).

WHAT WE DELIBERATELY DO NOT SEND
================================
- ``provider.order``: "Sticky routing is not used when you specify a manual
  provider order via ``provider.order`` — in that case, your explicit ordering
  takes priority." Pinning the provider ourselves would *disable* the mechanism
  we are trying to use, and would hard-fail whenever an override lands on a
  model that provider does not serve.
- ``usage: {include: true}``: "The ``usage: { include: true }`` and
  ``stream_options: { include_usage: true }`` parameters are deprecated and have
  no effect. Full usage details are now always included automatically in every
  response." (https://openrouter.ai/docs/use-cases/usage-accounting). Cached
  token counts arrive whether or not we ask.
- ``cache_control`` breakpoints: automatic caching covers the OpenAI family, and
  a breakpoint is a per-block edit of the prompt payload — a change to the
  cached prefix itself, which belongs to whoever owns the prompt.

THE KEY IS THE PREFIX, NOT THE CONVERSATION
===========================================
:func:`prompt_cache_key` hashes exactly what the cached prefix is made of — the
tenant, the model, the system prompt and the tool set — and nothing that varies
within a turn. Two consequences, both wanted:

* every call of one turn shares a key, so iteration 2 lands where iteration 1
  wrote its cache;
* two turns of the same tenant with the same prompt and tools share it too, so
  the cache survives across turns for as long as the provider keeps it.

The tenant is in the hash rather than left out of it because a cache key is also
an accounting boundary, and because OpenAI advises partitioning traffic across
keys ("aim for about 15 requests per minute in total across all prefixes using
each key") — one key for the whole fleet would be exactly the funnel that
advice warns about.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

logger = logging.getLogger(__name__)

#: OpenRouter's sticky-routing key (body field; ``x-session-id`` is the header
#: spelling). Capped at 256 characters by the API — ours is 32.
SESSION_ID_FIELD = "session_id"

#: OpenAI's cache-shard hint, forwarded by OpenRouter and used as the sticky
#: key when no ``session_id`` is present.
PROMPT_CACHE_KEY_FIELD = "prompt_cache_key"

#: Prefix on the emitted key so a value showing up in a provider dashboard is
#: attributable without a lookup.
_KEY_PREFIX = "grid"

_DIGEST_CHARS = 24


def _canonical(value: Any) -> str:
    """A stable text rendering of one hash input, whatever shape it arrived in.

    ``json.dumps`` with sorted keys makes a tool payload independent of dict
    insertion order, so two builds of the same tool set hash alike even if a
    schema converter reorders a mapping. Anything unserializable falls back to
    ``repr``, which is stable for the tuples and strings this is actually given.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        return repr(value)


def stable_prefix_digest(*parts: Any) -> str:
    """A short, deterministic digest of the parts that make up a cached prefix.

    Parts are joined with a separator that cannot occur in the digest alphabet,
    so ``("ab", "c")`` and ``("a", "bc")`` cannot collide. Pure: the same inputs
    give the same digest in every process and every release.
    """
    joined = "\x1e".join(_canonical(part) for part in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:_DIGEST_CHARS]


def prompt_cache_key(
    *,
    system_prompt: str | None,
    tools: Any = None,
    organization_id: str | None = None,
    model: str | None = None,
) -> str:
    """The cache/sticky-routing key for one stable prefix.

    Identical for every call that shares a tenant, a model, a system prompt and
    a tool set — which is every call of one research turn, and every later turn
    whose prefix has not changed. Different the moment any of those four
    differ, because a changed prefix is a different cache entry and pinning it
    to the old shard would only send misses to a warm endpoint.
    """
    digest = stable_prefix_digest(organization_id or "-", model or "-", system_prompt or "", tools)
    return f"{_KEY_PREFIX}-{digest}"


def with_prompt_cache_routing(extra_body: Any, key: str) -> dict[str, Any]:
    """Return a NEW ``extra_body`` carrying the cache/sticky-routing fields.

    Non-destructive, like the ZDR merge it sits beside: the response-healing
    plugin, ``provider`` routing and anything else already present are copied
    through untouched. A caller that already set either field wins — an
    explicit key from a call site is a decision, not something to overwrite.
    """
    merged: dict[str, Any] = dict(extra_body) if isinstance(extra_body, Mapping) else {}
    merged.setdefault(SESSION_ID_FIELD, key)
    merged.setdefault(PROMPT_CACHE_KEY_FIELD, key)
    return merged


def _system_text(messages: Any) -> str | None:
    """The leading system message's content, or None when a call has no system turn.

    Only the FIRST message counts: a system message anywhere else is not part
    of the cacheable prefix, and hashing it would split the key for calls that
    in fact share a prefix.
    """
    if not isinstance(messages, Sequence) or isinstance(messages, str | bytes) or not messages:
        return None
    first = messages[0]
    if getattr(first, "type", None) != "system":
        return None
    content = getattr(first, "content", None)
    return content if isinstance(content, str) else _canonical(content)


def prompt_cache_extra_body(
    messages: Any,
    kwargs: Mapping[str, Any],
    *,
    extra_body: Any = None,
    organization_id: str | None = None,
    model: str | None = None,
) -> dict[str, Any] | None:
    """The ``extra_body`` override that pins one call to its prefix's shard.

    Returns ``None`` when there is nothing to pin: a call with no leading
    system message has no prefix worth a key (and the prompt is then too short
    to reach any provider's caching minimum anyway).

    ``kwargs`` is the per-call binding — ``bind(tools=…)``, ``bind(response_format=…)``
    — and is read, never mutated: the tool payload and the response format both
    sit in the cached prefix, so both go into the key.
    """
    system_prompt = _system_text(messages)
    if system_prompt is None:
        return None
    key = prompt_cache_key(
        system_prompt=system_prompt,
        tools=(kwargs.get("tools"), kwargs.get("response_format")),
        organization_id=organization_id,
        model=model,
    )
    return with_prompt_cache_routing(extra_body, key)

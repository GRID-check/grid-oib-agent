"""Grid cross-cutting request-context headers (backlog T3-9).

The Next.js BFF sends a family of internal ``X-Grid-*`` headers on every
submission path (WS upgrade in ``server.js``, the async-jobs REST proxy, the
workflow-scheduler's internal submit) carrying the caller's org/project
identity, collection scope, project context/memory, per-org model overrides,
budget snapshot, and org-disabled data sources. In Python/NAT these headers
are accessed lowercased via ``Context`` metadata.

``GridRequestContext`` (below) is the single dataclass + parse function that
reads ALL of them in one place, mirroring the TS builder at
``frontends/ui/src/lib/request-context.ts`` (see that module's docstring for
the full header-inventory table and encodings). The two are pinned together
by the cross-language contract fixture ``tests/fixtures/grid_request_context.json``::

    X-Grid-Project-Context: base64url(<project context string>)

When a header is missing the system falls back to ``None``/defaults, and
prompt templates skip the corresponding context block.

Canonical *runtime* parsers for ``collection_scope``, ``model_overrides``,
``budget``, and ``disabled_sources`` continue to live in their own modules —
``knowledge/scoping.py``, ``common/model_overrides.py``,
``common/cost_tracking.py``, ``common/data_sources.py`` respectively. Those
modules are owned elsewhere; ``GridRequestContext`` parses the same headers
independently (not by importing them) purely so the contract fixture can pin
the wire format from the Python side without creating a dependency on
modules this file doesn't own. Agent code that needs model overrides,
budget, or disabled sources should keep calling those modules' own
accessors, not ``GridRequestContext``.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
from dataclasses import dataclass
from typing import Any

PROJECT_CONTEXT_HEADER = "x-grid-project-context"
PROJECT_MEMORY_HEADER = "x-grid-project-memory"
PROJECT_ID_HEADER = "x-grid-project-id"
MEMORY_REFLECTION_FEATURE_HEADER = "x-grid-feature-memory-reflection"
ORGANIZATION_ID_HEADER = "x-grid-organization-id"
USER_ID_HEADER = "x-grid-user-id"

# Consolidated signed context envelope (backlog T3-9 follow-up, 2026-07-16).
# `X-Grid-Request-Context` carries base64url(JSON) of the SAME fields the
# individual x-grid-* headers above carry (minus the internal token, which is
# deliberately out of scope — see the module docstring), and
# `X-Grid-Request-Context-Sig` carries the hex HMAC-SHA256 of the raw JSON
# keyed on GRID_INTERNAL_API_TOKEN. Minted in one place on the TS side
# (`buildGridRequestContextEnvelope` in `frontends/ui/src/lib/request-context.ts`,
# duplicated with a pinning comment in `server.js` because it is plain
# CommonJS). Producers DUAL-WRITE: the envelope is sent ALONGSIDE the
# individual headers during the transition; `from_context`/`from_headers`
# below prefer the envelope when present+valid, mirroring the individual
# headers otherwise.
REQUEST_CONTEXT_ENVELOPE_HEADER = "x-grid-request-context"
REQUEST_CONTEXT_ENVELOPE_SIG_HEADER = "x-grid-request-context-sig"

# Mirrored (not imported) from their owning modules — see the module
# docstring above for why. Values must stay byte-identical to
# knowledge/scoping.py, common/model_overrides.py, common/cost_tracking.py,
# and common/data_sources.py; the contract fixture is what catches drift.
COLLECTION_SCOPE_HEADER = "x-grid-collection-scope"
MODEL_OVERRIDES_HEADER = "x-grid-model-overrides"
BUDGET_HEADER = "x-grid-budget"
DISABLED_SOURCES_HEADER = "x-grid-disabled-sources"

# `bundesland` (backlog T3-9 follow-up, 2026-07-16, user-mandated): the
# validated jurisdiction token the intake wizard collects (PR #71) as a
# structured project-profile fact, carried STRUCTURED on the signed envelope
# instead of being re-parsed out of the `project_context` prompt text. This
# is ENVELOPE-ONLY by design — unlike the headers above there never was an
# individual `X-Grid-Bundesland` header to dual-write (see
# `frontends/ui/src/lib/request-context.ts`'s module docstring for the TS
# side of this decision), so `from_context`/`from_headers`'s legacy
# individual-header fallback path simply has no source for it and leaves it
# `None` — a pre-envelope caller falls through to
# `aiq_agent.common.ris_catalog.extract_bundesland`'s existing prompt-text
# parsing exactly as before this field existed.
#
# Vocabulary mirrored (not imported) from `ris_catalog.py`'s
# `_BUNDESLAND_TOKENS` / the intake wizard's `bundesland` question options
# (`frontends/ui/src/lib/project-profile/intake-definition.ts`) — same
# "parse independently, don't import" rationale as the headers above. An
# unrecognized token is treated as absent (debug-logged, not raised): a
# forward-incompatible token from a newer frontend must degrade to "no
# structured signal" rather than break the request.
_BUNDESLAND_TOKENS = frozenset(
    {
        "wien",
        "niederoesterreich",
        "oberoesterreich",
        "steiermark",
        "kaernten",
        "salzburg",
        "tirol",
        "vorarlberg",
        "burgenland",
        "ausserhalb_oesterreichs",
    }
)

logger = logging.getLogger(__name__)


def _normalize_bundesland(value: Any) -> str | None:
    """Validate a raw envelope `bundesland` value against the token vocabulary.

    Anything that isn't a known token — wrong type, typo, stale/unknown value
    from a future frontend — is treated as absent (debug-logged) so a caller
    always gets either a trustworthy token or `None`, never a raw
    unvalidated string.
    """
    if not isinstance(value, str):
        return None
    token = value.strip().lower()
    if token in _BUNDESLAND_TOKENS:
        return token
    if token:
        logger.debug("GridRequestContext: unknown bundesland token %r — treating as absent", token)
    return None


def normalize_project_context(value: str | None, *, max_chars: int = 4000) -> str | None:
    """Normalize and limit project context string."""
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > max_chars:
        value = value[:max_chars]
        value = value.rsplit("\n", 1)[0]
    return value


def _read_header(name: str) -> str | None:
    """Read a raw header value from NAT Context metadata."""
    try:
        from nat.builder.context import Context

        ctx = Context.get()
        if ctx is None or ctx.metadata is None:
            return None
        return ctx.metadata.headers.get(name)
    except Exception:
        logger.debug("Failed to read %s from NAT context", name, exc_info=True)
        return None


def _base64url_decode_text(raw: str) -> str:
    """Base64url-decode *raw* to text, falling back to *raw* unchanged if
    decoding — or the decoded bytes not being valid UTF-8 — fails (older
    proxy sending a raw, unencoded value).
    """
    try:
        padded = raw + "=" * (-len(raw) % 4)
        return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except Exception:
        return raw


def _read_encoded_header(name: str) -> str | None:
    """Read a base64url-encoded multi-line header (falls back to raw).

    ``x-grid-project-context`` and ``x-grid-project-memory`` carry MULTI-LINE
    text; server.js base64url-encodes them because Node rejects newlines in
    header values. Decode here; if decoding fails (older proxy sending raw
    single-line values), fall back to the raw string.
    """
    raw = _read_header(name)
    if not raw:
        return None
    return _base64url_decode_text(raw)


def _read_json_header(name: str) -> Any | None:
    """Base64url-decode + JSON-parse a structured header value.

    Absent or malformed values decode to ``None`` — a caller asking "what did
    the org configure" must never see an exception just because a header was
    missing or mangled; that must read the same as "nothing configured".
    """
    raw = _read_header(name)
    if not raw:
        return None
    try:
        return json.loads(_base64url_decode_text(raw))
    except Exception:
        logger.debug("Failed to decode/parse %s as JSON", name, exc_info=True)
        return None


def _normalize_raw_id(value: str | None) -> str | None:
    """Trim a raw single-value header (org/user/project id) to None-or-str."""
    if not value:
        return None
    value = value.strip()
    return value or None


def _as_str_list(value: Any) -> list[str] | None:
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    return None


def _as_str_dict(value: Any) -> dict[str, str] | None:
    if isinstance(value, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
        return value
    return None


def _as_dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _read_memory_reflection_flag() -> bool:
    """Fails closed: absent/anything-but-'true' header → False, so a missing
    header (older proxy, non-WS entrypoint) keeps the stage off rather than
    silently on.
    """
    raw = _read_header(MEMORY_REFLECTION_FEATURE_HEADER)
    return (raw or "").strip().lower() == "true"


@dataclass(frozen=True)
class GridRequestContext:
    """Every ``X-Grid-*`` cross-cutting context header for one request,
    parsed in one place. See the module docstring for scope/ownership notes
    and the TS twin (``frontends/ui/src/lib/request-context.ts``).
    """

    organization_id: str | None = None
    user_id: str | None = None
    project_id: str | None = None
    collection_scope: list[str] | None = None
    project_context: str | None = None
    project_memory: str | None = None
    model_overrides: dict[str, str] | None = None
    budget: dict[str, Any] | None = None
    disabled_sources: list[str] | None = None
    memory_reflection_enabled: bool = False
    bundesland: str | None = None

    @classmethod
    def from_context(cls) -> "GridRequestContext":
        """Read every ``X-Grid-*`` header from the current NAT Context in one
        pass. This is the low-level parse the module-level accessor
        functions below (``get_project_id_from_context`` etc.) delegate to —
        call this directly when you need more than one field, so the request
        is only walked once.

        The signed ``X-Grid-Request-Context`` envelope (see
        ``from_envelope``) takes precedence when present and valid: an
        invalid signature is treated as an ABSENT envelope (logged as a
        WARNING — a tamper signal) and this method falls back to parsing the
        individual headers below, exactly as before the envelope existed.
        """
        envelope = cls.from_envelope(
            _read_header(REQUEST_CONTEXT_ENVELOPE_HEADER),
            _read_header(REQUEST_CONTEXT_ENVELOPE_SIG_HEADER),
            os.environ.get("GRID_INTERNAL_API_TOKEN"),
        )
        if envelope is not None:
            return envelope

        return cls(
            organization_id=_normalize_raw_id(_read_header(ORGANIZATION_ID_HEADER)),
            user_id=_normalize_raw_id(_read_header(USER_ID_HEADER)),
            project_id=_normalize_raw_id(_read_header(PROJECT_ID_HEADER)),
            collection_scope=_as_str_list(_read_json_header(COLLECTION_SCOPE_HEADER)),
            project_context=normalize_project_context(_read_encoded_header(PROJECT_CONTEXT_HEADER)),
            project_memory=normalize_project_context(_read_encoded_header(PROJECT_MEMORY_HEADER), max_chars=2000),
            model_overrides=_as_str_dict(_read_json_header(MODEL_OVERRIDES_HEADER)),
            budget=_as_dict(_read_json_header(BUDGET_HEADER)),
            disabled_sources=_as_str_list(_read_json_header(DISABLED_SOURCES_HEADER)),
            memory_reflection_enabled=_read_memory_reflection_flag(),
        )

    @classmethod
    def from_envelope(
        cls,
        header_value: str | None,
        sig: str | None,
        secret: str | None,
    ) -> "GridRequestContext | None":
        """Parse + verify the signed ``X-Grid-Request-Context`` envelope.

        Returns ``None`` (treated as ABSENT by every caller — ``from_context``
        falls back to the individual headers, and the enforcement middleware
        in ``aiq_api`` treats it as "no envelope") when:

        - ``header_value`` is missing/blank;
        - the base64url payload fails to decode or does not parse as a JSON
          object;
        - ``secret`` is configured (the normal, production case) and ``sig``
          is missing or does not match the HMAC-SHA256 of the raw JSON —
          logged as a WARNING, since a present-but-wrong signature is a
          tamper signal worth surfacing, not routine absence.

        When ``secret`` is falsy (``GRID_INTERNAL_API_TOKEN`` unset — dev
        only), signature verification is skipped and the envelope is
        accepted on shape alone: the token is how the two BFF/backend
        processes share a secret, so without it there is nothing to verify
        against, but that must not silently disable the envelope mechanism
        itself. The enforcement middleware documents the same fail-open
        choice at its call site: envelope PRESENCE is still required for
        authenticated requests even when signature verification is skipped.
        """
        if not header_value:
            return None

        try:
            raw_json = _base64url_decode_text(header_value)
        except Exception:
            logger.warning("Failed to base64url-decode X-Grid-Request-Context envelope", exc_info=True)
            return None

        if secret:
            expected = hmac.new(secret.encode("utf-8"), raw_json.encode("utf-8"), hashlib.sha256).hexdigest()
            if not sig or not hmac.compare_digest(expected, sig):
                logger.warning(
                    "X-Grid-Request-Context envelope signature missing or invalid; "
                    "treating the envelope as absent (possible tamper)"
                )
                return None

        try:
            payload = json.loads(raw_json)
        except Exception:
            logger.warning("Failed to JSON-parse X-Grid-Request-Context envelope", exc_info=True)
            return None
        if not isinstance(payload, dict):
            logger.warning("X-Grid-Request-Context envelope JSON is not an object; ignoring")
            return None

        return cls(
            organization_id=_normalize_raw_id(payload.get("organizationId")),
            user_id=_normalize_raw_id(payload.get("userId")),
            project_id=_normalize_raw_id(payload.get("projectId")),
            collection_scope=_as_str_list(payload.get("collectionScope")),
            project_context=normalize_project_context(payload.get("projectContext"), max_chars=4000),
            project_memory=normalize_project_context(payload.get("projectMemory"), max_chars=2000),
            model_overrides=_as_str_dict(payload.get("modelOverrides")),
            budget=_as_dict(payload.get("budget")),
            disabled_sources=_as_str_list(payload.get("disabledSources")),
            memory_reflection_enabled=bool(payload.get("memoryReflectionEnabled", False)),
            bundesland=_normalize_bundesland(payload.get("bundesland")),
        )

    @classmethod
    def from_headers(cls, headers: dict[str, str], *, secret: str | None = None) -> "GridRequestContext":
        """Parse a ``GridRequestContext`` from an explicit header map instead
        of a live NAT Context.

        This is the cross-language contract-test entry point: the fixture at
        ``tests/fixtures/grid_request_context.json`` carries
        ``{name, input, headers}`` cases; the TS side asserts
        ``buildGridRequestContextHeaders(input) == headers`` and the Python
        side (``tests/aiq_agent/test_project_context.py``) asserts
        ``GridRequestContext.from_headers(headers)`` matches ``input``. A
        producer that forgets a header, or that encodes one differently,
        fails this fixture instead of silently degrading in production.

        Header names are matched case-insensitively, mirroring how the
        ASGI/WS layer populates ``Context.metadata.headers``.

        When the header map carries a signed envelope
        (``X-Grid-Request-Context`` / ``-Sig``), it takes precedence over the
        individual headers, exactly like ``from_context`` — pass ``secret``
        to verify it (omit/None to skip verification, e.g. when a test case
        only exercises the individual-header path).
        """
        lower = {k.lower(): v for k, v in headers.items()}

        def raw(name: str) -> str | None:
            return lower.get(name)

        envelope = cls.from_envelope(
            raw(REQUEST_CONTEXT_ENVELOPE_HEADER),
            raw(REQUEST_CONTEXT_ENVELOPE_SIG_HEADER),
            secret,
        )
        if envelope is not None:
            return envelope

        def json_field(name: str) -> Any | None:
            value = raw(name)
            if not value:
                return None
            try:
                return json.loads(_base64url_decode_text(value))
            except Exception:
                return None

        def text_field(name: str, max_chars: int) -> str | None:
            value = raw(name)
            if not value:
                return None
            return normalize_project_context(_base64url_decode_text(value), max_chars=max_chars)

        return cls(
            organization_id=_normalize_raw_id(raw(ORGANIZATION_ID_HEADER)),
            user_id=_normalize_raw_id(raw(USER_ID_HEADER)),
            project_id=_normalize_raw_id(raw(PROJECT_ID_HEADER)),
            collection_scope=_as_str_list(json_field(COLLECTION_SCOPE_HEADER)),
            project_context=text_field(PROJECT_CONTEXT_HEADER, 4000),
            project_memory=text_field(PROJECT_MEMORY_HEADER, 2000),
            model_overrides=_as_str_dict(json_field(MODEL_OVERRIDES_HEADER)),
            budget=_as_dict(json_field(BUDGET_HEADER)),
            disabled_sources=_as_str_list(json_field(DISABLED_SOURCES_HEADER)),
            memory_reflection_enabled=(raw(MEMORY_REFLECTION_FEATURE_HEADER) or "").strip().lower() == "true",
        )


def get_profile_context_from_context() -> str | None:
    """Read just the intake-profile context (``X-Grid-Project-Context``).

    The profile changes rarely and via a fresh handshake, so the connection-time
    header value is fine. Memory, by contrast, is re-served per turn (see
    ``compose_project_context``).
    """
    return GridRequestContext.from_context().project_context


def get_memory_digest_from_context() -> str | None:
    """Read the memory digest that rode the WS-upgrade header.

    This is the connection-time snapshot; it is frozen for the connection's life.
    The chat entrypoint re-fetches a live digest each turn and only falls back to
    this header value when the live fetch is unavailable.
    """
    return GridRequestContext.from_context().project_memory


def compose_project_context(context: str | None, memory: str | None) -> str | None:
    """Combine intake-profile context and the memory digest into one blob.

    Composed in one place so every caller and prompt template picks memory up
    transparently as part of the single ``project_context`` value.
    """
    if context and memory:
        return f"{context}\n\n{memory}"
    return context or memory


def get_project_context_from_context() -> str | None:
    """Compose the injected agent context from the request headers.

    Combines the intake-profile context (``X-Grid-Project-Context``) with the
    connection-time project memory core digest (``X-Grid-Project-Memory``, see
    docs/architecture/project-memory-design.md). Used as the fallback when a
    per-turn live memory fetch is not available.
    """
    ctx = GridRequestContext.from_context()
    return compose_project_context(ctx.project_context, ctx.project_memory)


def get_project_id_from_context() -> str | None:
    """Read the current project's id (``X-Grid-Project-Id``).

    Used by project-scoped tools (e.g. ``remember``) to write rows for the
    right project. None outside a project-scoped conversation.
    """
    return GridRequestContext.from_context().project_id


def get_organization_id_from_context() -> str | None:
    """Read the caller's organization id (``X-Grid-Organization-Id``).

    Set by server.js on the WS upgrade for authenticated sessions. Used by
    organization-scoped memory writes. None in anonymous mode.
    """
    return GridRequestContext.from_context().organization_id


def get_memory_reflection_enabled_from_context() -> bool:
    """Whether the async memory-reflection stage is enabled for this request.

    The BFF evaluates the ``memory-reflection`` WorkOS feature flag per-org (or an
    env fallback) at the WS upgrade and forwards the result as
    ``x-grid-feature-memory-reflection``. Fails closed: absent/anything-but-'true'
    header → False, so a missing header (older proxy, non-WS entrypoint) keeps the
    stage off rather than silently on.
    """
    return GridRequestContext.from_context().memory_reflection_enabled


def get_conversation_id_from_context() -> str | None:
    """Best-effort read of the active conversation id for provenance."""
    try:
        from nat.builder.context import Context

        ctx = Context.get()
        if ctx is None:
            return None
        conversation_id = getattr(ctx, "conversation_id", None)
        return str(conversation_id) if conversation_id else None
    except Exception:
        logger.debug("Failed to read conversation id from NAT context", exc_info=True)
        return None

"""Project context extraction from the ``X-Grid-Project-Context`` header.

The Next.js BFF sends an internal header::

    X-Grid-Project-Context: <project context string>

In Python/NAT this header is accessed lowercased via ``Context`` metadata.
When the header is missing the system falls back to returning ``None``, and
prompt templates skip the project context block.
"""

import logging

PROJECT_CONTEXT_HEADER = "x-grid-project-context"
PROJECT_MEMORY_HEADER = "x-grid-project-memory"
PROJECT_ID_HEADER = "x-grid-project-id"
MEMORY_REFLECTION_FEATURE_HEADER = "x-grid-feature-memory-reflection"

logger = logging.getLogger(__name__)


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
    try:
        import base64

        padded = raw + "=" * (-len(raw) % 4)
        return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except Exception:
        return raw


def get_profile_context_from_context() -> str | None:
    """Read just the intake-profile context (``X-Grid-Project-Context``).

    The profile changes rarely and via a fresh handshake, so the connection-time
    header value is fine. Memory, by contrast, is re-served per turn (see
    ``compose_project_context``).
    """
    return normalize_project_context(_read_encoded_header(PROJECT_CONTEXT_HEADER))


def get_memory_digest_from_context() -> str | None:
    """Read the memory digest that rode the WS-upgrade header.

    This is the connection-time snapshot; it is frozen for the connection's life.
    The chat entrypoint re-fetches a live digest each turn and only falls back to
    this header value when the live fetch is unavailable.
    """
    return normalize_project_context(_read_encoded_header(PROJECT_MEMORY_HEADER), max_chars=2000)


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
    return compose_project_context(
        get_profile_context_from_context(),
        get_memory_digest_from_context(),
    )


def get_project_id_from_context() -> str | None:
    """Read the current project's id (``X-Grid-Project-Id``).

    Used by project-scoped tools (e.g. ``remember``) to write rows for the
    right project. None outside a project-scoped conversation.
    """
    raw = _read_header(PROJECT_ID_HEADER)
    if not raw:
        return None
    raw = raw.strip()
    return raw or None


def get_organization_id_from_context() -> str | None:
    """Read the caller's organization id (``X-Grid-Organization-Id``).

    Set by server.js on the WS upgrade for authenticated sessions. Used by
    organization-scoped memory writes. None in anonymous mode.
    """
    raw = _read_header("x-grid-organization-id")
    if not raw:
        return None
    raw = raw.strip()
    return raw or None


def get_memory_reflection_enabled_from_context() -> bool:
    """Whether the async memory-reflection stage is enabled for this request.

    The BFF evaluates the ``memory-reflection`` WorkOS feature flag per-org (or an
    env fallback) at the WS upgrade and forwards the result as
    ``x-grid-feature-memory-reflection``. Fails closed: absent/anything-but-'true'
    header → False, so a missing header (older proxy, non-WS entrypoint) keeps the
    stage off rather than silently on.
    """
    raw = _read_header(MEMORY_REFLECTION_FEATURE_HEADER)
    return (raw or "").strip().lower() == "true"


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

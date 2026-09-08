"""
Collection scope resolution from the ``X-Grid-Collection-Scope`` header.

The Next.js BFF sends an internal header::

    X-Grid-Collection-Scope: base64url(JSON.stringify([...]))

Two payload shapes are accepted (ADR-0047):

- **Current** — an array of objects carrying the SHELF explicitly::

      [{"collection": "s_9f2a", "shelf": "session"},
       {"collection": "proj_alpha", "shelf": "project"}]

- **Legacy** — a bare array of collection names (``["s_9f2a", "proj_alpha"]``).
  A bare string states no shelf, so the shelf is **unknown**; it is never
  guessed back from the collection-id prefix, and an unknown shelf renders
  unattributed rather than defaulting to ``base``/``baurecht``.

In Python/NAT this header is accessed lowercased via ``Context`` metadata.
When the header is missing the system falls back to legacy config-based
collection resolution.
"""

import base64
import json
import logging
from dataclasses import dataclass
from typing import Any

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import parse_shelf
from nat.builder.context import Context

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ScopedCollection:
    """One collection a turn may read, plus the shelf it sits on.

    ``shelf`` is ``None`` when the producer did not state one (legacy
    bare-string scope entry). Unknown is a first-class value: the consumer
    renders such a hit unattributed instead of inventing a shelf for it.

    ``project_id``/``project_name`` name the PROJECT a ``project``-shelf entry
    belongs to (ADR-0054). In a project chat one project is the whole scope and
    naming it adds nothing; in the Büro several mounted projects sit in one
    turn's scope, and "Projektwissen" alone no longer says whose. They travel
    from here onto every chunk's metadata and out to the wire citation, because
    this is the last point at which they are known for free. Both are ``None``
    for every non-project entry and for a producer that predates the fields.
    """

    collection: str
    shelf: Shelf | None = None
    project_id: str | None = None
    project_name: str | None = None


def _normalize_collection_name(name: str) -> str:
    """Normalize known collection names while preserving custom collections."""
    while name.startswith("s_s_"):
        name = name[2:]
    return name


def _base64url_decode(value: str) -> bytes:
    """Base64url-decode *value*, adding padding if necessary."""
    padding = 4 - len(value) % 4
    if padding != 4:
        value += "=" * padding
    return base64.urlsafe_b64decode(value)


class _UnreadableScopeEntry:
    """Verdict sentinel: a scope entry in NEITHER wire shape.

    Kept distinct from ``None`` because the two verdicts differ in kind, not in
    degree — see :func:`_parse_scope_entry`.
    """

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid only
        return "<unreadable scope entry>"


_UNREADABLE = _UnreadableScopeEntry()


def _optional_text(value: Any) -> str | None:
    """A decorative string field of a scope entry, or ``None``.

    ``projectId``/``projectName`` are ATTRIBUTION, not authorization: the entry's
    ``collection`` is what a turn is allowed to read. A missing or wrong-typed
    value therefore costs a label and never voids the entry — unlike a
    non-string ``collection``, which makes the entry unreadable.
    """
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _parse_scope_entry(item: Any) -> ScopedCollection | _UnreadableScopeEntry | None:
    """One decoded scope entry → :class:`ScopedCollection`, or a verdict on why not.

    Accepts both wire shapes and distinguishes the two ways an entry can fail:

    - :data:`_UNREADABLE` — the entry is in NEITHER wire shape (a number, an
      object whose ``collection`` is not a string). We cannot know what was
      meant, so the caller voids the whole payload rather than honoring a
      partially-read authorization boundary.
    - ``None`` — the entry IS in a known wire shape and simply names no
      collection (an empty or whitespace-only name). It is readable; it just
      selects nothing, so the caller skips this entry alone.
    """
    if isinstance(item, str):
        name = item.strip()
        # A bare string states no shelf — unknown, never inferred from the name.
        return ScopedCollection(_normalize_collection_name(name)) if name else None
    if isinstance(item, dict):
        raw_name = item.get("collection")
        if not isinstance(raw_name, str):
            return _UNREADABLE
        name = raw_name.strip()
        if not name:
            return None
        return ScopedCollection(
            _normalize_collection_name(name),
            parse_shelf(item.get("shelf")),
            project_id=_optional_text(item.get("projectId")),
            project_name=_optional_text(item.get("projectName")),
        )
    return _UNREADABLE


def _parse_scope_payload(scope: Any) -> list[ScopedCollection] | None:
    """Decoded header/envelope value → deduplicated scoped collections.

    Fails CLOSED on anything UNREADABLE — a non-list payload, or a list holding
    an entry in neither wire shape, yields ``None`` rather than a partially-read
    authorization boundary (ADR-0047).

    ``None`` means "no readable scope", NOT "deny this turn". Callers read it as
    ABSENT: :func:`get_scoped_collections_from_context_or` falls back to the
    config-derived layers, so a rejected payload ends up resolving against the
    legacy layers rather than blocking retrieval. Nobody should read rejection
    here as denial.

    A BLANK collection name is deliberately NOT treated as unreadable. It is
    well-formed and simply names no collection, so no guessing is required to
    handle it and skipping it removes exactly zero authority — the remaining
    entries stay precisely what the producer stated. Voiding the whole payload
    over one blank name would do the opposite of failing closed in practice,
    because ``None`` hands the turn to the config-derived fallback above, which
    can be WIDER than the scope actually sent. Fail-closed means refusing to
    guess at an entry we cannot parse; a blank name needs no guess. This matches
    ``aiq_agent.project_context._as_scope_entries``/``_scope_names``, the twin
    parser on the envelope side, which likewise keeps the payload and drops only
    the blank entry.

    De-duplication keeps the FIRST entry for a collection name, so a stated
    shelf is not lost to a later bare-string repeat of the same collection.
    """
    if not isinstance(scope, list):
        return None
    entries: list[ScopedCollection] = []
    seen: set[str] = set()
    for item in scope:
        parsed = _parse_scope_entry(item)
        if isinstance(parsed, _UnreadableScopeEntry):
            logger.debug("Unreadable collection-scope entry, ignoring the whole scope: %r", item)
            return None
        if parsed is None:
            logger.debug("Blank collection name in collection-scope, skipping this entry only: %r", item)
            continue
        if parsed.collection in seen:
            continue
        seen.add(parsed.collection)
        entries.append(parsed)
    return entries


def _raw_collection_scope_from_header() -> list[Any] | None:
    """Decode the UNVERIFIED ``X-Grid-Collection-Scope`` header.

    Fallback used only when the signed request-context envelope cannot be parsed
    (e.g. ``aiq_agent.project_context`` is unavailable to import). Returns the raw
    decoded list (bare strings and/or ``{collection, shelf}`` objects), or
    ``None`` when the header is missing or malformed. Not normalized — the
    public functions normalize their result.
    """
    try:
        ctx = Context.get()
        if ctx is None:
            return None
        metadata = ctx.metadata
        if metadata is None:
            return None
        raw = metadata.headers.get("x-grid-collection-scope")
        if raw is None:
            return None
    except Exception:
        logger.debug("Failed to read X-Grid-Collection-Scope from context", exc_info=True)
        return None

    try:
        decoded = _base64url_decode(raw)
        scope: Any = json.loads(decoded)
    except Exception:
        logger.debug("Failed to decode X-Grid-Collection-Scope header", exc_info=True)
        return None

    if not isinstance(scope, list):
        logger.debug("X-Grid-Collection-Scope is not a list: %s", scope)
        return None

    return scope


def _with_turn_mounts(entries: list[ScopedCollection]) -> list[ScopedCollection]:
    """Union this turn's verified mounts onto *entries*, keeping the first name.

    A mount widens the CEILING for the rest of the turn (ADR-0054): it is what
    `open_project` bought with a signed grant. It is appended rather than
    prepended so the header's own entries keep their order and their stated
    shelf — a mount for a collection the header already carries changes nothing,
    which is exactly right, since the header entry came from the same
    re-authorization the grant did.

    Importing :mod:`aiq_agent.knowledge.mounts` lazily keeps the scope parser
    free of an import cycle (mounts holds ``ScopedCollection`` values) and keeps
    a turn with no mounts paying nothing.
    """
    try:
        from aiq_agent.knowledge.mounts import get_turn_mounts

        mounts = get_turn_mounts()
    except Exception:  # pragma: no cover - defensive: mounts must never break scoping
        logger.debug("Turn-mount read failed; continuing with the header scope alone", exc_info=True)
        return entries
    if not mounts:
        return entries
    seen = {entry.collection for entry in entries}
    widened = list(entries)
    for mount in mounts:
        if mount.collection in seen:
            continue
        seen.add(mount.collection)
        widened.append(mount)
    return widened


def get_scoped_collections_from_context() -> list[ScopedCollection] | None:
    """The caller's collection scope WITH each collection's shelf.

    Same authorization semantics as :func:`get_collection_scope_from_context`
    (which is this function's names-only projection): the SIGNED envelope wins,
    the raw header is honored only when no valid envelope is present. On top of
    that, the projects this very turn mounted through ``open_project`` are
    unioned on — see :func:`_with_turn_mounts`.

    Returns:
        Deduplicated, normalized ``(collection, shelf)`` entries (possibly
        empty), or ``None`` when no readable scope is present. ``shelf`` is
        ``None`` for a legacy bare-string entry — unknown, not guessed.
    """
    scope: Any = None
    try:
        from aiq_agent.project_context import GridRequestContext

        ctx = GridRequestContext.from_context()
        scope = ctx.collection_scope_entries if ctx.collection_scope_entries is not None else ctx.collection_scope
    except Exception:
        # project_context unavailable — fall back to the raw header so scoping
        # still functions (parity with pre-envelope behavior).
        logger.debug("Verified collection-scope read failed; falling back to raw header", exc_info=True)
        scope = _raw_collection_scope_from_header()

    entries = _parse_scope_payload(scope)
    # No readable scope stays NO READABLE SCOPE, mounts or not: ``None`` sends
    # the caller to the config-derived layers (see
    # :func:`get_scoped_collections_from_context_or`, which unions the mounts
    # onto THAT list). Returning the mounts alone here would answer "the scope
    # is exactly this one project" and silently drop the base corpus.
    return entries if entries is None else _with_turn_mounts(entries)


def get_collection_scope_from_context() -> list[str] | None:
    """Read the caller's collection scope, preferring the SIGNED envelope.

    The collection scope is an authorization boundary: it selects which document
    collections a turn may read — the shared corpus, per-project stores, and the
    per-conversation ``s_<conversation_id>`` upload store. Because collection
    names are guessable, an attacker who could set a raw ``X-Grid-Collection-Scope``
    header would read another conversation's or tenant's documents.

    The BFF computes the scope server-side from the authenticated session and
    signs it into the ``X-Grid-Request-Context`` envelope (HMAC). We therefore
    consume the envelope's VERIFIED ``collection_scope``; the raw header is
    honored only when no valid envelope is present (anonymous / internal-service
    / dev / legacy) — exactly ``GridRequestContext.from_context()``'s
    envelope-preferring fallback, and the aiq_api enforcement middleware
    fail-closes authenticated turns that lack a valid envelope, so an
    authenticated request always resolves against the signed value. In legitimate
    traffic the BFF dual-writes identical values to both header and envelope, so
    this is behavior-neutral; it diverges only when a raw header is forged to
    differ from the signed envelope — the case we must not honor.

    Returns:
        Deduplicated, normalized list of collection names, or ``None`` when no
        scope is present. Callers that need the shelf each collection sits on
        want :func:`get_scoped_collections_from_context` instead.
    """
    entries = get_scoped_collections_from_context()
    return None if entries is None else [entry.collection for entry in entries]


def get_scoped_collections_from_context_or(
    config: Any,
    session_id: str | None,
) -> list[ScopedCollection]:
    """
    Try context-based collection scope, falling back to legacy resolution.

    Args:
        config: A :class:`knowledge_layer.register.KnowledgeRetrievalConfig`.
        session_id: Resolved per-session collection name, if any.

    Returns:
        Ordered, de-duplicated scoped collections (never empty). The legacy
        fallback knows each layer's shelf STRUCTURALLY (it builds the layers),
        so it states one rather than guessing from the name.
    """
    scope = get_scoped_collections_from_context()
    if scope:
        return scope
    from knowledge_layer.register import _resolve_scoped_collections

    # The legacy layers are a ceiling too, so a turn that mounted a project
    # while running without a header scope (an internal/CLI entry point) still
    # reads it. Unioned here rather than inside the resolver: the resolver
    # BUILDS the configured layers and knows nothing about a turn.
    return _with_turn_mounts(_resolve_scoped_collections(config, session_id))


def get_collection_scope_from_context_or(
    config: Any,
    session_id: str | None,
) -> list[str]:
    """Names-only projection of :func:`get_scoped_collections_from_context_or`.

    Returns:
        Ordered, de-duplicated list of collection names (never empty).
    """
    return [entry.collection for entry in get_scoped_collections_from_context_or(config, session_id)]


def scope_entries_to_wire(entries: list[ScopedCollection]) -> list[dict[str, str]]:
    """:class:`ScopedCollection` values back to the wire objects they came from.

    The inverse of :func:`_parse_scope_entry`, and here for the same reason that
    parser is: this module owns the shape of a scope entry, so the one place
    that re-emits one is next to the one place that reads one. Keys are the
    BFF's (``collection``, ``shelf``, ``projectId``, ``projectName``), because
    what is produced here is read back by this same parser after crossing a
    process boundary — the deep-research escalation hands its scope to a worker,
    which re-injects it as ``X-Grid-Collection-Scope`` (ADR-0054, spec DR-1).

    An unknown shelf and an absent project are OMITTED rather than sent as
    ``null``: absent is how this parser spells unknown, and a key present with
    no value would be a producer stating one.
    """
    wire: list[dict[str, str]] = []
    for entry in entries:
        item: dict[str, str] = {"collection": entry.collection}
        if entry.shelf is not None:
            item["shelf"] = str(entry.shelf)
        if entry.project_id:
            item["projectId"] = entry.project_id
        if entry.project_name:
            item["projectName"] = entry.project_name
        wire.append(item)
    return wire

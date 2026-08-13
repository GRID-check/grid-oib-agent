"""Canonical source-kind taxonomy — the single classification every source is
rendered through (the "Belegt durch" chips, the Herleitung fan-out, the report
sources section).

The product surfaces four *coarse* source kinds, mirroring the click-dummy
``TYPES`` registry:

- ``baurecht`` — authoritative building law: the OIB Richtlinien corpus **and**
  RIS (Bauordnung, Verordnungen, Bundes-/Landesrecht) **and** external Normen.
  OIB corpus hits and RIS hits are the *same* kind — they differ only in the
  fine sub-lane, never in the pathway or the chip.
- ``buero`` — Büroarchiv (the organization's standards, details, experience).
- ``projekt`` — Projektwissen (this project's plans, Bescheide, uploads).
- ``web`` — web-search results.

``auto`` exists in the click-dummy as a *selection mode* ("Piloti wählt die
passende Quelle selbst") — it is never a rendered citation and so is not part of
this taxonomy.

The finer lane classification (``norm_registry.lane_for_hit`` — OIB-Richtlinie
vs. Bundesrecht vs. Verordnung …) is preserved as a *sub-label* within a kind;
this module maps those lanes up to the coarse kind that drives the chip colour
and the detail badge. This keeps the rich, deterministic hierarchy in the
registry/filenames while giving every surface one coarse taxonomy to render.

Presentation colours live on the frontend (CSS custom properties keyed by
``css_token`` → ``var(--source-{css_token})``); the backend owns only the
taxonomy + German labels, so both ends share one source of truth.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


@dataclass(frozen=True)
class SourceKind:
    """One coarse source kind and its stable presentation metadata."""

    key: str
    label: str
    description: str
    # Frontend CSS custom-property family: ``var(--source-{css_token})`` /
    # ``-tint`` / ``-text``. Keeps the colour tokens named consistently on both
    # ends without shipping colours from the backend.
    css_token: str


#: The canonical registry. Extend here (and add the matching ``--source-*`` CSS
#: tokens + the mirror in ``frontends/ui/.../source-kinds.ts``) to introduce a
#: new kind — every rendering surface picks it up automatically.
SOURCE_KINDS: dict[str, SourceKind] = {
    "baurecht": SourceKind(
        key="baurecht",
        label="Baurecht & Richtlinien",
        description="Bauordnung, OIB-Richtlinien, Normen.",
        css_token="baurecht",
    ),
    "buero": SourceKind(
        key="buero",
        label="Büroarchiv",
        description="Standards, Details und Erfahrung deines Büros.",
        css_token="buero",
    ),
    "projekt": SourceKind(
        key="projekt",
        label="Projektwissen",
        description="Pläne, Bescheide und Unterlagen dieses Projekts.",
        css_token="projekt",
    ),
    "web": SourceKind(
        key="web",
        label="Web",
        description="Rechercheergebnisse aus dem Web.",
        css_token="web",
    ),
}

#: Fail-open kind for an unclassifiable source, matching ``lane_for_hit``'s
#: ``("web", "Web")`` fallback.
DEFAULT_SOURCE_KIND = "web"

#: ``SourceEntry.source_type`` of the non-URL capture fallback: a tool that
#: produced output but named no document and no URL, registered under its own
#: tool name (``extract_sources_from_tool_result``).
TOOL_RESULT_SOURCE_TYPE = "tool_result"

# Fine lane stratum-key → coarse source kind. A prefix match on the lane family
# keeps this table small and forward-compatible: any new ``baurecht_*`` sub-lane
# (a new OIB document class, a new RIS rank) maps to ``baurecht`` without a code
# change here. Kept in sync with ``norm_registry``'s ``_RANK_LANES`` /
# ``_OIB_CLASS_LANES`` and ``lane_for_hit``.
_LANE_KIND_PREFIXES: tuple[tuple[str, str], ...] = (
    ("baurecht", "baurecht"),  # baurecht_oib*, baurecht_ris, baurecht_bund/land/verordnung
    ("behoerde", "baurecht"),  # behördliche Information — authoritative building law
    ("norm_extern", "baurecht"),  # externe Normen belong to the Baurecht kind
    ("buero", "buero"),
    ("projekt", "projekt"),
    ("web", "web"),
)


def kind_for_lane(lane_key: str | None) -> str:
    """Map a fine lane stratum-key (``lane_for_hit``) to a coarse source kind.

    Fail-open to :data:`DEFAULT_SOURCE_KIND` for unknown inputs, mirroring the
    lane classifier so the two never disagree on the fallback.
    """
    key = (lane_key or "").strip().lower()
    for prefix, kind in _LANE_KIND_PREFIXES:
        if key == prefix or key.startswith(f"{prefix}_"):
            return kind
    return DEFAULT_SOURCE_KIND


def source_kind(key: str | None) -> SourceKind:
    """Look up a :class:`SourceKind` by key, fail-open to the default kind."""
    return SOURCE_KINDS.get((key or "").strip().lower(), SOURCE_KINDS[DEFAULT_SOURCE_KIND])


# ---------------------------------------------------------------------------
# Shelf — where a retrieved chunk came from (ADR-0047)
# ---------------------------------------------------------------------------
#
# A document is identified by ``(collection, filename)``: that is the PRIMARY KEY
# of ``document_metadata`` and the only pair that is actually unique. A filename
# alone is not — one knowledge_search fans out across the base corpus, the
# session collection and the project collections concurrently, so `Plan.pdf` from
# a project upload and `Plan.pdf` from the Büroarchiv can arrive in the SAME
# result set and are different documents.
#
# The SHELF is the coarse half of that identity: the org-wide Archiv, a project,
# a private chat session, or the base corpus. ADR-0047 makes it TRAVEL AS DATA —
# it is carried explicitly in the ``X-Grid-Collection-Scope`` header, in chunk
# metadata and in the knowledge-tool citation payload. Nothing downstream may
# recover it by inspecting a collection-id prefix or a German display label; the
# prefix table that used to do that is deleted, and its absence is this ADR's
# acceptance test.
#
# A missing/unknown shelf reads as UNKNOWN and renders unattributed. It is never
# defaulted to ``base``/``baurecht`` — the old fail-open let an unrecognised
# collection claim to be authoritative building law.


class Shelf(StrEnum):
    """The shelf a retrieved chunk came from. The wire vocabulary of ADR-0047.

    Deliberately its OWN enum, not a subset of :data:`SOURCE_KINDS`: the display
    taxonomy (``baurecht | buero | projekt | web``) is a different axis, and
    conflating the two is what folded private session attachments into
    "Projektwissen".

    The TypeScript twin declares the same four members
    (``frontends/ui/src/features/chat/lib/source-kinds.ts``); neither runtime
    imports the other's — three constants declared twice is looser coupling than
    a generated artifact on the core retrieval path.
    """

    ARCHIV = "archiv"
    PROJECT = "project"
    SESSION = "session"
    BASE = "base"


def parse_shelf(value: object) -> Shelf | None:
    """Narrow a wire value to a :class:`Shelf`; ``None`` when unknown.

    Fails CLOSED: anything that is not one of the four members — a missing
    field, a stale label, a collection id — is unknown, never ``base``.
    """
    if isinstance(value, Shelf):
        return value
    if not isinstance(value, str):
        return None
    try:
        return Shelf(value.strip().lower())
    except ValueError:
        return None


#: Shelf → the short German qualifier a citation key uses
#: (`Plan.pdf (Projektwissen), p.3`). RENDERING ONLY — the shelf itself is what
#: travels. Deliberately shorter than ``SourceKind.label`` ("Baurecht &
#: Richtlinien" reads badly inside a parenthetical) and stable: the strings are
#: embedded in citation keys already persisted in messages, so changing one
#: invalidates those keys.
SHELF_QUALIFIERS: dict[Shelf, str] = {
    Shelf.ARCHIV: "Büroarchiv",
    Shelf.PROJECT: "Projektwissen",
    Shelf.SESSION: "Private Sitzung",
    Shelf.BASE: "Basiswissen",
}

#: LEGACY citation-key vocabulary → qualifier. The keys are the pre-ADR-0047
#: coarse-kind scopes (``buero``/``projekt``/``baurecht``) that qualified keys
#: persisted in existing messages were written against; they are kept so those
#: keys keep PARSING. ``session`` never existed in that vocabulary, so it takes
#: the shelf's own name. Do not treat this table as transport.
SCOPE_QUALIFIERS: dict[str, str] = {
    "buero": SHELF_QUALIFIERS[Shelf.ARCHIV],
    "projekt": SHELF_QUALIFIERS[Shelf.PROJECT],
    "baurecht": SHELF_QUALIFIERS[Shelf.BASE],
    "session": SHELF_QUALIFIERS[Shelf.SESSION],
}

_QUALIFIER_SCOPES: dict[str, str] = {label.lower(): scope for scope, label in SCOPE_QUALIFIERS.items()}

_QUALIFIER_SHELVES: dict[str, Shelf] = {label.lower(): shelf for shelf, label in SHELF_QUALIFIERS.items()}


def shelf_qualifier(shelf: Shelf | str | None) -> str | None:
    """The citation-key qualifier for ``shelf``; ``None`` when the shelf is unknown.

    Exhaustive over :class:`Shelf`: the final ``case`` is a guard, so adding a
    member without deciding how it renders raises here instead of silently
    rendering as unattributed.
    """
    match parse_shelf(shelf):
        case Shelf.ARCHIV:
            return SHELF_QUALIFIERS[Shelf.ARCHIV]
        case Shelf.PROJECT:
            return SHELF_QUALIFIERS[Shelf.PROJECT]
        case Shelf.SESSION:
            return SHELF_QUALIFIERS[Shelf.SESSION]
        case Shelf.BASE:
            return SHELF_QUALIFIERS[Shelf.BASE]
        case None:
            # Unknown shelf → unattributed. NEVER `base`/`baurecht`.
            return None
        case other:  # pragma: no cover — unreachable until a member is added
            raise AssertionError(f"unhandled shelf: {other!r}")


def shelf_for_qualifier(qualifier: str | None) -> Shelf | None:
    """Inverse of :func:`shelf_qualifier` — read a key's qualifier back to a shelf.

    Accepts the legacy qualifiers unchanged (they are the same four strings), so
    a citation key persisted before ADR-0047 still resolves.
    """
    return _QUALIFIER_SHELVES.get((qualifier or "").strip().lower())


def scope_for_qualifier(qualifier: str | None) -> str | None:
    """LEGACY: a key's qualifier back to the pre-ADR-0047 coarse-scope token.

    Kept for readers that still speak the old ``buero``/``projekt``/``baurecht``
    vocabulary. New code wants :func:`shelf_for_qualifier`.
    """
    return _QUALIFIER_SCOPES.get((qualifier or "").strip().lower())


def legacy_shelf_for_collection_name(collection: str | None) -> Shelf | None:
    """LEGACY ROLLOUT FALLBACK — guess a shelf from a collection id. REMOVE ME.

    ADR-0047 deletes shelf-by-prefix inference. This is the ONE place the guess
    survives, for exactly one reason: payloads produced BEFORE the shelf
    travelled (an old BFF sending a bare-string scope header, a citation payload
    persisted by a previous deploy) carry a collection name and nothing else.
    Delete this function — and every call to it — once no such producer is left.

    Returns ``None`` for anything it does not recognise. The predecessor
    (``collection_scope``) fell OPEN to ``baurecht``, so an unknown collection
    claimed to be authoritative building law; unknown now means unknown, and an
    unknown shelf renders unattributed.
    """
    key = (collection or "").strip().lower()
    if key.startswith("archiv_"):
        return Shelf.ARCHIV
    if key.startswith("proj_"):
        return Shelf.PROJECT
    if key.startswith("s_"):
        return Shelf.SESSION
    return None

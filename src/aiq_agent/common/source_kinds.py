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

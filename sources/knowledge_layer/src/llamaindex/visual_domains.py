"""Domain profiles for visual extraction — the vocabulary, not the schema.

The extraction schema (:mod:`visual_analysis`) is domain-neutral: a visual is
segments; a segment holds entities, compositions, states, quantities,
relations and annotations. What a domain CALLS those things lives here, as
data.

Why the split exists
--------------------
The first version of this schema had ``rooms``, ``circulation``, ``envelope``
and ``building_physics`` as top-level fields. That reads well for a floor plan
and has nowhere to put a site plan's planting, a schematic's components or a
product photo's parts — so every non-architectural upload degraded to a
paragraph of prose, and adding a domain meant editing the schema, the parser
and the UI together. Here, a room is an entity whose category is ``space`` in
the ``architecture`` domain: architecture loses nothing, and a new domain is a
:class:`Domain` in :data:`DOMAINS` rather than a schema migration.

One image, several domains
--------------------------
A domain is chosen PER SEGMENT, not per image. Real sheets mix: a plan sheet
carries a floor plan, a construction detail, a legend, a site photo and an
energy chart; a services drawing overlays an architectural background. Making
the domain a property of the image would force one of those to be mislabelled,
and the mislabelling is not cosmetic — it decides which vocabulary the
entities are validated against and how the chunk is typed for citation. So the
model is given every enabled domain's vocabulary and picks one per segment.

Adding a domain must not require a schema change, a parser change or a UI
change. If it does, the thing it needs belongs in the kernel schema instead.

Language
--------
Every identifier and instruction here is English: these are business-logic
terms, and a vocabulary that is half German is a vocabulary nobody can extend.
Free-text fields (summaries, entity names read off the sheet) are written in
the language of the DOCUMENT, because that is what retrieval has to match —
a German plan must stay searchable in German.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass
from dataclasses import field
from typing import Any

logger = logging.getLogger(__name__)


class SegmentRole:
    """What a segment type IS, independent of the domain that names it.

    The role — not the type — decides how a chunk is typed and cited, so every
    domain answers the question "is this the thing the reader came for?" in the
    same three words rather than each inventing its own rule.
    """

    #: The domain's own primary artifact: a floor plan, a schematic, a map.
    PRIMARY = "primary"
    #: A data graphic: chart, diagram, table of values.
    CHART = "chart"
    #: A picture: photograph, rendering, screenshot.
    PICTORIAL = "pictorial"


#: Chunk ``content_type`` per role. ``drawing`` is the type whose citation
#: format names the kind of drawing, which is why PRIMARY maps to it.
_ROLE_CONTENT_TYPES = {
    SegmentRole.PRIMARY: "drawing",
    SegmentRole.CHART: "chart",
    SegmentRole.PICTORIAL: "image",
}

#: Precedence when one image mixes roles. A sheet carrying a plan AND a chart
#: is a plan sheet: the reader came for the plan, and the chart is on it.
_ROLE_PRECEDENCE = (SegmentRole.PRIMARY, SegmentRole.CHART, SegmentRole.PICTORIAL)


#: A term that is no longer offered to the model but still resolves, so a
#: record extracted under it keeps rendering. Terms are deprecated, never
#: deleted: the key is what stored payloads reference.
ACTIVE = "active"
DEPRECATED = "deprecated"


@dataclass(frozen=True)
class SegmentType:
    """One kind of depiction a domain expects to meet."""

    key: str
    label: str
    role: str = SegmentRole.PRIMARY
    status: str = ACTIVE
    #: Key that supersedes this one, for a term that was split or renamed.
    replaced_by: str | None = None


@dataclass(frozen=True)
class EntityCategory:
    """One kind of thing a domain expects to find, in the domain's own words.

    ``key`` is stable and travels into stored payloads, so it must never be
    renamed casually; ``label`` is what the model and the reader see; ``hint``
    is the short list of examples that makes the difference between a model
    returning circulation elements and returning nothing.
    """

    key: str
    label: str
    hint: str = ""
    status: str = ACTIVE
    replaced_by: str | None = None


@dataclass(frozen=True)
class Domain:
    """A domain's vocabulary for reading images."""

    id: str
    label: str
    #: What one depiction can BE, in this domain's words.
    segment_types: tuple[SegmentType, ...]
    #: What can be named inside one.
    entity_categories: tuple[EntityCategory, ...]
    #: Lifecycle values an entity can carry, where the domain has such a notion.
    states: tuple[str, ...] = ()
    #: What "scale" is called here — a plan has a scale, a micrograph has a
    #: magnification, a photo has neither.
    measure_label: str = "scale"
    #: One sentence telling the model when this domain applies.
    applies_to: str = ""
    #: Domain rules appended to the shared ones, each already a sentence.
    guidance: tuple[str, ...] = field(default_factory=tuple)

    @property
    def segment_type_keys(self) -> frozenset[str]:
        """Every type that RESOLVES, deprecated ones included — a stored record
        referencing one must keep rendering."""
        return frozenset(segment_type.key for segment_type in self.segment_types)

    @property
    def category_keys(self) -> frozenset[str]:
        return frozenset(category.key for category in self.entity_categories)

    @property
    def active_segment_types(self) -> tuple[SegmentType, ...]:
        """Types OFFERED to the model. Deprecated ones are withheld so nothing
        new is written under them, while old records still read."""
        return tuple(t for t in self.segment_types if t.status == ACTIVE)

    @property
    def active_entity_categories(self) -> tuple[EntityCategory, ...]:
        return tuple(c for c in self.entity_categories if c.status == ACTIVE)

    def role_of(self, segment_type_key: str) -> str:
        for segment_type in self.segment_types:
            if segment_type.key == segment_type_key:
                return segment_type.role
        return SegmentRole.PICTORIAL


# ---------------------------------------------------------------------------
# Shared vocabulary
#
# Categories every domain gets for free. `other` exists so a thing the model
# genuinely recognised is filed loosely rather than dropped — losing it
# because the domain has no word for it is the worse failure.
# ---------------------------------------------------------------------------

_UNIVERSAL_CATEGORIES = (
    EntityCategory("material", "Materials", "what things are made of"),
    EntityCategory("other", "Other", ""),
)

_PICTORIAL_TYPES = (
    SegmentType("photo", "Photograph or rendering", SegmentRole.PICTORIAL),
    SegmentType("diagram", "Diagram or chart", SegmentRole.CHART),
    SegmentType("table", "Table or schedule", SegmentRole.CHART),
    SegmentType("legend", "Legend or key", SegmentRole.PICTORIAL),
    SegmentType("other", "Something else", SegmentRole.PICTORIAL),
)


# ---------------------------------------------------------------------------
# Architecture — the deployment default, and the domain this product is for.
# ---------------------------------------------------------------------------

ARCHITECTURE = Domain(
    id="architecture",
    label="Architecture",
    segment_types=(
        SegmentType("floor_plan", "Floor plan"),
        SegmentType("section", "Section"),
        SegmentType("elevation", "Elevation"),
        SegmentType("detail", "Construction detail"),
        SegmentType("site_plan", "Site plan"),
        SegmentType("perspective", "Perspective"),
        SegmentType("axonometric", "Axonometric"),
        *_PICTORIAL_TYPES,
    ),
    entity_categories=(
        EntityCategory("space", "Spaces and uses", "rooms, apartments, studios, plant rooms"),
        EntityCategory("circulation", "Circulation", "stairs, ramps, lifts, access decks"),
        EntityCategory("structure", "Structure", "columns, beams, slabs, grids, span direction"),
        EntityCategory("envelope", "Envelope", "facade, roof, windows, solar shading"),
        EntityCategory("services", "Building services", "heating, heat pump, ventilation, PV"),
        EntityCategory("building_physics", "Building physics", "acoustics, thermal mass, summer heat protection"),
        EntityCategory("finish", "Finishes", "plaster, exposed concrete, coatings"),
        EntityCategory("landscape", "Outdoor space", "courtyard, terrace, planting, paving"),
        *_UNIVERSAL_CATEGORIES,
    ),
    states=("existing", "new", "demolished", "reused", "transformed"),
    measure_label="scale",
    applies_to="architectural drawings, plan sheets and building documentation",
    guidance=(
        "Keep the project title, its subtitle and any graphic headline strictly apart "
        "(document.title / document.subtitle / document.slogans).",
        "Record design strategies (for example demountability, prefabrication, retaining "
        "existing fabric) in document.strategies, and ordered process steps in "
        "document.process_steps.",
    ),
)


# ---------------------------------------------------------------------------
# General — the honest fallback for content no enabled domain claims.
# ---------------------------------------------------------------------------

GENERAL = Domain(
    id="general",
    label="General",
    segment_types=(
        SegmentType("drawing", "Technical drawing"),
        SegmentType("map", "Map"),
        SegmentType("screenshot", "Screenshot", SegmentRole.PICTORIAL),
        *_PICTORIAL_TYPES,
    ),
    entity_categories=(
        EntityCategory("object", "Objects", "the things depicted"),
        EntityCategory("part", "Parts", "what an object is made up of"),
        EntityCategory("person", "People and roles", ""),
        EntityCategory("place", "Places", ""),
        *_UNIVERSAL_CATEGORIES,
    ),
    applies_to="anything the other domains do not cover",
)


#: Every domain this build knows about. A deployment enables a subset.
DOMAINS: dict[str, Domain] = {domain.id: domain for domain in (ARCHITECTURE, GENERAL)}

#: Always enabled: it is what a segment falls back to, so it can never be off.
FALLBACK_DOMAIN_ID = GENERAL.id

# @environment_variable AIQ_VISUAL_DOMAINS
# @category Knowledge Layer
# @type str
# @default architecture,general
# @required false
# Comma-separated domain vocabularies offered to the vision model when reading
# uploaded images. The schema is the same whichever are enabled; the domains
# decide what the model is asked to look for and what the extracted categories
# are called. "general" is always enabled as the fallback.
DEFAULT_DOMAIN_IDS = os.environ.get("AIQ_VISUAL_DOMAINS", f"{ARCHITECTURE.id},{GENERAL.id}")


@dataclass(frozen=True)
class DomainRegistry:
    """The domains offered for one analysis, and everything derived from them.

    A registry is the unit the prompt, the JSON Schema and the parser all agree
    on, so they cannot drift: change the enabled set and all three follow.
    """

    domains: tuple[Domain, ...]

    @property
    def id(self) -> str:
        """Human-readable identity of this vocabulary set."""
        return "+".join(domain.id for domain in self.domains)

    @property
    def content_hash(self) -> str:
        """Digest of what the enabled domains actually CONTAIN.

        The id names which domains are on; this names what they say. The
        difference does not matter while the vocabulary is code — a deploy
        changes both together — and matters completely the moment it is
        editable: renaming a category or rewriting a hint changes what the
        model is asked to look for, and a cache keyed only on the id would
        serve the old reading for the whole TTL. Stamped onto every extracted
        payload too, so "which records were produced under the old vocabulary"
        is a query rather than a guess.
        """
        canonical = [
            {
                "id": domain.id,
                "measure": domain.measure_label,
                "applies_to": domain.applies_to,
                "guidance": list(domain.guidance),
                "states": list(domain.states),
                "types": [[t.key, t.label, t.role] for t in domain.active_segment_types],
                "categories": [[c.key, c.label, c.hint] for c in domain.active_entity_categories],
            }
            for domain in self.domains
        ]
        payload = json.dumps(canonical, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]

    @property
    def fingerprint(self) -> str:
        """``id@hash`` — readable in a log, exact in a cache key."""
        return f"{self.id}@{self.content_hash}"

    def get(self, domain_id: str | None) -> Domain:
        for domain in self.domains:
            if domain.id == domain_id:
                return domain
        return self.fallback

    @property
    def fallback(self) -> Domain:
        for domain in self.domains:
            if domain.id == FALLBACK_DOMAIN_ID:
                return domain
        return self.domains[-1]

    @property
    def domain_ids(self) -> tuple[str, ...]:
        return tuple(domain.id for domain in self.domains)

    def segment_type_keys(self) -> tuple[str, ...]:
        """Every ACTIVE segment type across enabled domains, de-duplicated.

        Flat rather than per-domain because structured-output implementations
        constrain a field to ONE enum, and the strict subsets reject the
        `if`/`then` that would make it conditional; which types are legal for
        which domain is checked when normalising, where the domain is known.
        Deprecated terms are excluded so nothing new is written under them.
        """
        seen: dict[str, None] = {}
        for domain in self.domains:
            for segment_type in domain.active_segment_types:
                seen.setdefault(segment_type.key, None)
        return tuple(seen)

    def category_keys(self) -> tuple[str, ...]:
        seen: dict[str, None] = {}
        for domain in self.domains:
            for category in domain.active_entity_categories:
                seen.setdefault(category.key, None)
        return tuple(seen)

    def state_keys(self) -> tuple[str, ...]:
        seen: dict[str, None] = {}
        for domain in self.domains:
            for state in domain.states:
                seen.setdefault(state, None)
        return tuple(seen)

    def content_type_for(self, segments: list[dict[str, Any]]) -> str:
        """``drawing`` / ``chart`` / ``image`` for a set of analysed segments.

        Each segment's role comes from ITS OWN domain, then precedence picks
        one for the image — so a plan sheet carrying a chart is still typed as
        a drawing, and a photo sheet carrying a small diagram is not.
        """
        roles = {
            self.get(segment.get("domain")).role_of(segment.get("segment_type", ""))
            for segment in segments or []
        }
        for role in _ROLE_PRECEDENCE:
            if role in roles:
                return _ROLE_CONTENT_TYPES[role]
        return "image"


def resolve_registry(domain_ids: str | None = None) -> DomainRegistry:
    """The domains to analyse with. Unknown ids are skipped, loudly.

    Never raises: a typo in one deployment's env must degrade to a working
    vocabulary rather than fail every upload on that deployment.
    """
    requested = [part.strip().lower() for part in (domain_ids or DEFAULT_DOMAIN_IDS or "").split(",")]
    selected: list[Domain] = []
    for domain_id in requested:
        if not domain_id:
            continue
        domain = DOMAINS.get(domain_id)
        if domain is None:
            logger.warning("Unknown visual domain %r; ignoring", domain_id)
        elif domain not in selected:
            selected.append(domain)

    fallback = DOMAINS[FALLBACK_DOMAIN_ID]
    if fallback not in selected:
        selected.append(fallback)
    return DomainRegistry(tuple(selected))

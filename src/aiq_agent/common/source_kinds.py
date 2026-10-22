"""Canonical source-kind taxonomy — the single classification every source is
rendered through (the "Belegt durch" chips, the Herleitung fan-out, the report
sources section).

The product surfaces five *coarse* source kinds, four of them mirroring the
click-dummy ``TYPES`` registry:

- ``building_law`` — authoritative building law: the OIB Richtlinien corpus **and**
  RIS (Bauordnung, Verordnungen, Bundes-/Landesrecht) **and** external Normen.
  OIB corpus hits and RIS hits are the *same* kind — they differ only in the
  fine sub-lane, never in the pathway or the chip.
- ``office`` — Büroablage (the organization's standards, details, experience).
- ``project`` — Projektwissen (this project's plans, Bescheide, uploads).
- ``web`` — web-search results.
- ``measurement`` — a value measured off the project's BIM model.

``measurement`` is the odd one out and deliberately so. The first four are
RETRIEVED PASSAGES: a chunk of a document that a citation resolves to, captured
into :class:`~aiq_agent.common.citation_verification.SourceRegistry` and
verifiable by reading the passage back. A measurement has no passage. It
carries something else — the GlobalIds it was derived from, the operator
expression, an absolute tolerance and a provenance
(:class:`ifc_spatial.envelope.Answer`) — and it is REPRODUCIBLE, which no
quotation is.

That difference is why a measurement is a KIND here and is **not** a
``SourceEntry``. ``citation_grounded`` is derived from the registry's contents,
and it is the one signal that lets an answer surface "high"; the normative
brake in ``piloti.grounding`` is gated on its ABSENCE. A
measurement that entered the registry would therefore hand an answer's uncited
legal verdict the evidence of its own basement measurement — the laundering
path the grounding module exists to close. So measurements travel their own
channel (:mod:`aiq_agent.tools.bim.measurement_sources`) and meet the
retrieved sources only on the wire, where this taxonomy is all that is left of
either. See ``tests/aiq_agent/agents/piloti/test_agent.py::
TestMeasurementSourcesDoNotGroundCitations``.

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
    "building_law": SourceKind(
        key="building_law",
        label="Baurecht & Richtlinien",
        description="Bauordnung, OIB-Richtlinien, Normen.",
        css_token="building_law",
    ),
    "office": SourceKind(
        key="office",
        label="Büroablage",
        description="Standards, Details und Erfahrung deines Büros.",
        css_token="office",
    ),
    "project": SourceKind(
        key="project",
        label="Projektwissen",
        description="Unterlagen, Bescheide und Dateien dieses Projekts.",
        css_token="project",
    ),
    "web": SourceKind(
        key="web",
        label="Web",
        description="Rechercheergebnisse aus dem Web.",
        css_token="web",
    ),
    "measurement": SourceKind(
        key="measurement",
        label="Modellmessung",
        description="Am BIM-Modell gemessen — mit Herkunft, Toleranz und Methode.",
        # The one kind whose ``css_token`` is honest about the promise this
        # field's docstring makes: ``--source-model`` really exists on the
        # frontend. The older four predate the `--source-*` families and name
        # the KIND (`building_law`) where the token names the SIGNAL (`law`); they
        # are left alone rather than renamed, because the tokens are what
        # `KIND_TO_SIGNAL` resolves to and nothing reads this field.
        css_token="model",
    ),
}

#: The fine lane of a PUBLISHED, human-approved, agent-authored document, and
#: the German sub-label it renders as. An ``office`` kind — office knowledge, in
#: the office colour — with its own lane inside that kind, because "the office
#: approved this" and "Piloti wrote it and the office approved it" are different
#: claims and only the second one needs the reader to be told.
#:
#: NOT a ``doc_class``: that vocabulary describes a document's role in the norm
#: hierarchy and fails open into law blue (see ``common/provenance.py`` for the
#: full argument). NOT a shelf either — such a document sits on the project or
#: the Archiv shelf like any other, which is exactly why the lane must beat the
#: shelf in ``norm_registry.lane_for_hit``: on the project shelf it would
#: otherwise wear the Projektwissen chip and lose its author.
#:
#: The label is the SUB-LABEL only. The approver is appended by whoever renders
#: it (the grounding block via ``provenance.provenance_label``, the frontend
#: from the ``provenance`` payload), so the lane table stays a taxonomy rather
#: than a sentence with a hole in it.
AGENT_AUTHORED_LANE = "office_piloti"
AGENT_AUTHORED_LANE_LABEL = "Piloti-Dokument"

#: The ``source_format`` a mail thread's chunks carry: the E-Mail-Verlauf, one
#: Markdown section per message, rendered by the BFF from the messages a person
#: filed (``frontends/ui/src/lib/mail-thread/render.ts``, ADR-0134). A FORMAT,
#: not a document type: the type is ``correspondence``, which a scanned letter
#: shares, and the format is what tells a reader that each section is a
#: message whose heading names its sender and whether that sender's domain was
#: confirmed.
MAIL_SOURCE_FORMAT = "mail"

#: The fine lanes of a mail thread, and the sub-label they render as. A
#: project's thread is Projektwissen and an office's is Büroablage: the kind
#: stays the shelf's, so a mail never wears the building-law colour, not even
#: one from ``ma37.wien.gv.at`` (a clerk's e-mail is not a Bescheid). The lane
#: is the sub-label inside that kind, the way ``office_piloti`` is. Mirrored in
#: ``frontends/ui/src/features/chat/lib/source-kinds.ts``.
MAIL_LANE = "project_mail"
OFFICE_MAIL_LANE = "office_mail"
MAIL_LANE_LABEL = "E-Mail"

#: The kind a model-derived measurement renders as. Named rather than spelled
#: out at the call sites so the one place that decides "this is a measurement,
#: not a retrieved passage" is greppable.
MEASUREMENT_SOURCE_KIND = "measurement"

#: Fail-open kind for an unclassifiable source, matching ``lane_for_hit``'s
#: ``("web", "Web")`` fallback.
DEFAULT_SOURCE_KIND = "web"

#: ``SourceEntry.source_type`` of the non-URL capture fallback: a tool that
#: produced output but named no document and no URL, registered under its own
#: tool name (``extract_sources_from_tool_result``).
TOOL_RESULT_SOURCE_TYPE = "tool_result"

# Fine lane stratum-key → coarse source kind. A prefix match on the lane family
# keeps this table small and forward-compatible: any new ``building_law_*`` sub-lane
# (a new OIB document class, a new RIS rank) maps to ``building_law`` without a code
# change here. Kept in sync with ``norm_registry``'s ``_RANK_LANES`` /
# ``_OIB_CLASS_LANES`` and ``lane_for_hit``.
_LANE_KIND_PREFIXES: tuple[tuple[str, str], ...] = (
    ("building_law", "building_law"),  # building_law_oib*, _ris, _federal/_state/_ordinance
    ("authority", "building_law"),  # behördliche Information — authoritative building law
    ("external_standard", "building_law"),  # externe Normen belong to the Baurecht kind
    ("office", "office"),
    ("project", "project"),
    ("web", "web"),
    # No retrieval lane maps here — ``lane_for_hit`` cannot produce it, because
    # nothing retrieves a measurement. The measurement channel stamps this lane
    # on itself, and the entry exists so the two ends agree when it does.
    ("measurement", "measurement"),
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
# a project upload and `Plan.pdf` from the Büroablage can arrive in the SAME
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

    OFFICE_SHELF = "office_shelf"
    PROJECT = "project"
    SESSION = "session"
    BASE = "base"


#: The shelf's wire value before it had an English name. A peer that has not
#: rolled yet (an old BFF, a conversation or citation stored by an earlier build)
#: still says ``archiv``; it reads as the office shelf and nothing writes it.
#: The TypeScript twin is ``LEGACY_SHELF`` in ``features/chat/lib/source-kinds.ts``.
#: Remove after one release.
LEGACY_SHELF_VALUES: dict[str, str] = {"archiv": Shelf.OFFICE_SHELF.value}


def canonical_shelf_value(value: str) -> str:
    """A shelf wire value in its current spelling (trimmed, lower-cased, legacy names mapped)."""
    key = value.strip().lower()
    return LEGACY_SHELF_VALUES.get(key, key)


#: Collection-name prefix of an office's shelf. The value is a stored name, not a
#: spelling: every point of the shelf carries ``scope = <prefix><organization id>``
#: in Qdrant (ADR-0116) and every document row ``collection_name`` the same, so
#: the prefix changes only together with a re-tag of both
#: (``docs/deployment/office-shelf-rename-runbook.md``). Until an operator has
#: run it, writers keep the ACTIVE prefix; readers accept every one in
#: :data:`OFFICE_SHELF_COLLECTION_PREFIXES`. The TypeScript twin is
#: ``OFFICE_SHELF_COLLECTION_PREFIX`` in ``frontends/ui/src/lib/office-shelf/collection.ts``;
#: ``frontends/ui/src/lib/office-shelf/collection-prefix.spec.ts`` holds the two equal.
OFFICE_SHELF_COLLECTION_PREFIX = "archiv_"
#: The prefix the shelf's collections take once re-tagged (the next release's value).
OFFICE_SHELF_TARGET_COLLECTION_PREFIX = "office_shelf_"
#: Every prefix a reader recognises as an office shelf. Remove the legacy entry
#: after the re-tag has run everywhere.
OFFICE_SHELF_COLLECTION_PREFIXES: tuple[str, ...] = (
    OFFICE_SHELF_TARGET_COLLECTION_PREFIX,
    OFFICE_SHELF_COLLECTION_PREFIX,
)


def is_office_shelf_collection(collection: str | None) -> bool:
    """Whether ``collection`` names an office's shelf (either prefix)."""
    return (collection or "").strip().lower().startswith(OFFICE_SHELF_COLLECTION_PREFIXES)


def office_shelf_organization_id(collection: str | None) -> str | None:
    """The organization id behind an office shelf collection name; ``None`` for any other name."""
    name = (collection or "").strip()
    for prefix in OFFICE_SHELF_COLLECTION_PREFIXES:
        if name.lower().startswith(prefix):
            return name[len(prefix) :] or None
    return None


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
        return Shelf(canonical_shelf_value(value))
    except ValueError:
        return None


#: Shelf → the short German qualifier a citation key uses
#: (`Plan.pdf (Projektwissen), p.3`). RENDERING ONLY — the shelf itself is what
#: travels. Deliberately shorter than ``SourceKind.label`` ("Baurecht &
#: Richtlinien" reads badly inside a parenthetical) and stable: the strings are
#: embedded in citation keys already persisted in messages, so changing one
#: invalidates those keys unless the old string stays readable. The office
#: shelf was renamed from „Büroarchiv" to „Büroablage" (product decision,
#: 6 Oct 2026); the old qualifier lives on in :data:`RETIRED_SHELF_QUALIFIERS`.
SHELF_QUALIFIERS: dict[Shelf, str] = {
    Shelf.OFFICE_SHELF: "Büroablage",
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
    "buero": SHELF_QUALIFIERS[Shelf.OFFICE_SHELF],
    "projekt": SHELF_QUALIFIERS[Shelf.PROJECT],
    "baurecht": SHELF_QUALIFIERS[Shelf.BASE],
    "session": SHELF_QUALIFIERS[Shelf.SESSION],
}

#: Qualifiers no writer emits any more and every reader still parses: citation
#: keys persisted under a shelf's old name. READ-ONLY — never rendered, never
#: shown to the model. The frontend mirror lists the same strings in
#: ``CITATION_KEY_QUALIFIERS``.
RETIRED_SHELF_QUALIFIERS: dict[str, Shelf] = {
    "Büroarchiv": Shelf.OFFICE_SHELF,
}

#: Every qualifier a reader strips from a key: what writers emit now, then the
#: retired names.
READABLE_QUALIFIERS: tuple[str, ...] = (*dict.fromkeys(SCOPE_QUALIFIERS.values()), *RETIRED_SHELF_QUALIFIERS)

_QUALIFIER_SCOPES: dict[str, str] = {label.lower(): scope for scope, label in SCOPE_QUALIFIERS.items()}
# A retired name reads back through the label that replaced it.
_QUALIFIER_SCOPES.update(
    {
        retired.lower(): _QUALIFIER_SCOPES[SHELF_QUALIFIERS[shelf].lower()]
        for retired, shelf in RETIRED_SHELF_QUALIFIERS.items()
    }
)

_QUALIFIER_SHELVES: dict[str, Shelf] = {
    **{label.lower(): shelf for shelf, label in SHELF_QUALIFIERS.items()},
    **{label.lower(): shelf for label, shelf in RETIRED_SHELF_QUALIFIERS.items()},
}


def shelf_qualifier(shelf: Shelf | str | None) -> str | None:
    """The citation-key qualifier for ``shelf``; ``None`` when the shelf is unknown.

    Exhaustive over :class:`Shelf`: the final ``case`` is a guard, so adding a
    member without deciding how it renders raises here instead of silently
    rendering as unattributed.
    """
    match parse_shelf(shelf):
        case Shelf.OFFICE_SHELF:
            return SHELF_QUALIFIERS[Shelf.OFFICE_SHELF]
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
    if is_office_shelf_collection(key):
        return Shelf.OFFICE_SHELF
    if key.startswith("proj_"):
        return Shelf.PROJECT
    if key.startswith("s_"):
        return Shelf.SESSION
    return None

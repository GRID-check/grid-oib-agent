"""Norm registry: the typed spine for building-relevant norms (rank, role, editions, relations).

Successor of the flat curated RIS catalog (``ris_catalog.py``, kept as a backward-compat
shim). The registry is a set of per-country YAML files (``configs/norms/<country>/registry.yml``,
override the root via the ``GRID_NORMS_DIR`` env var) covering BOTH RIS-sourced laws
(Bauordnungen, federal acts) and corpus-sourced OIB documents (Richtlinien, Leitfäden,
Erläuterungen, Referenzdokumente), with:

- ``rank`` — where the document sits in the legal hierarchy (Bundesgesetz down to plan/parcel),
- ``role`` — how its content may be used (normativ/anwendend/erklaerend/definierend/diff),
- ``editions`` — with status (current/superseded) and a source (RIS pointer or corpus file),
- ``relations`` — exactly three types with named consumers: ``implements``,
  ``declares_binding``, ``supersedes``,
- ``applicability`` — data-driven rules for the applicability engine (Phase 4).

Consumers: prompt lane rendering (``render_prompt_block`` / ``render_block_for_prompt``),
``ris_catalog_lookup`` relations, ingestion-time chunk stamping (Phase 2), the retrieval
default filter, citation verification, and the compliance checker.

Failure semantics: a missing/invalid registry FAILS OPEN (feature disabled, warning) —
except OIB-family id-convention violations, which FAIL LOUD in strict mode (config bug,
not runtime data). See docs/superpowers/specs/2026-07-17-norm-registry-design.md.
"""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError

from aiq_agent.common.country_packs import DEFAULT_COUNTRY
from aiq_agent.common.country_packs import get_country_pack
from aiq_agent.common.country_packs.base import normalize_legal_text

logger = logging.getLogger(__name__)

DEFAULT_NORMS_DIR = "configs/norms"
ENV_NORMS_DIR = "GRID_NORMS_DIR"

# OGD-RIS applications the registry may point into (subset of the applications the
# ris_adapter supports; see ris_adapter.client.CONTROLLER_FOR_APPLICATION).
KNOWN_APPLICATIONS = frozenset(
    {
        "BrKons",
        "LrKons",
        "BgblAuth",
        "LgblAuth",
        "Begut",
        "RegV",
        "Vfgh",
        "Vwgh",
        "Justiz",
        "Bvwg",
        "Lvwg",
        "Dsk",
        "Erlaesse",
        "Vbl",
        "Lgbl",
    }
)

NormRank = Literal[
    "bundesgesetz",
    "landesgesetz",
    "verordnung",
    "oib_richtlinie",
    "oib_leitfaden",
    "oib_erklaerung",
    "oib_referenz",
    "behoerdliche_info",
    "norm_extern",
    "plan_parzelle",
]
NormRole = Literal["normativ", "anwendend", "erklaerend", "definierend", "diff"]
RelationType = Literal["implements", "declares_binding", "supersedes"]
RelationStatus = Literal["verified", "unknown"]
EditionStatus = Literal["current", "superseded"]
SourceKind = Literal["corpus", "ris"]

# Canonical Bundesland names and intake-token vocabulary live in the Austria
# country pack (country_packs/at.py); the public helpers below delegate there.
# `ausserhalb_oesterreichs` maps to None on purpose: the project is explicitly
# outside Austria, so no state's law should be prioritized.

# Structured `country=<iso>` fact line (future intake-wizard country field).
_STRUCTURED_COUNTRY_RE = re.compile(r"\bcountry=([a-z]{2})")

# Terms shorter than this never match (guards against noise words).
_MIN_TOPIC_LENGTH = 4


class Jurisdiction(BaseModel):
    """Where the norm applies. country = ISO 3166-1 alpha-2; state = intake token."""

    country: str
    state: str | None = None


class EditionSource(BaseModel):
    """Where an edition's text comes from: the local corpus or a RIS pointer."""

    kind: SourceKind
    file: str = ""  # kind=corpus: file name under data/oib (or the country corpus dir)
    application: str = ""  # kind=ris: OGD-RIS application (e.g. LrKons, BrKons)
    document_number: str = ""
    citation_url: str = ""
    full_law_url: str = ""


class Edition(BaseModel):
    """One edition of a norm. `role` overrides the entry-level role (diff editions)."""

    id: str
    label: str
    status: EditionStatus = "current"
    role: NormRole | None = None
    source: EditionSource


class Relation(BaseModel):
    """A typed edge to another registry entry. Unverifiable legal facts are status=unknown."""

    type: RelationType
    target: str
    edition: str = ""
    status: RelationStatus = "unknown"
    note: str = ""


class Access(BaseModel):
    """Marks norms whose full text is not licensed/available (e.g. ÖNORM Bezugsnormen)."""

    kind: Literal["unavailable"]
    note: str = ""


class ApplicabilityCondition(BaseModel):
    fact: str
    op: Literal["eq", "in", "defined", "undefined", "gt", "gte", "lt", "lte"]
    value: object = None  # scalar (eq/gt/...) or list (in); ignored for defined/undefined


class ApplicabilityWhen(BaseModel):
    all: list[ApplicabilityCondition] = Field(default_factory=list)
    any: list[ApplicabilityCondition] = Field(default_factory=list)


class ApplicabilityRule(BaseModel):
    """First-match-wins rule (document order); no match -> the standard is omitted."""

    when: ApplicabilityWhen
    verdict: Literal["required", "likely", "check"]
    reason_de: str
    reason_en: str


class NormEntry(BaseModel):
    """One norm: a law, ordinance, OIB document, or external standard."""

    id: str
    title: str
    short: str
    rank: NormRank
    role: NormRole
    jurisdiction: Jurisdiction
    aliases: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    relevance: str = ""
    editions: list[Edition] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)
    applicability: list[ApplicabilityRule] = Field(default_factory=list)
    access: Access | None = None
    verified_at: str = ""


class NormsFile(BaseModel):
    """One per-country registry file (configs/norms/<country>/registry.yml)."""

    version: int = 1
    country: str
    entries: list[NormEntry] = Field(default_factory=list)


class NormRegistry(BaseModel):
    """The merged multi-country view."""

    entries: list[NormEntry] = Field(default_factory=list)

    def by_id(self, entry_id: str) -> NormEntry | None:
        for entry in self.entries:
            if entry.id == entry_id:
                return entry
        return None


def _normalize(text: str) -> str:
    """Lowercase and expand umlauts so matching tolerates spelling variants."""
    return normalize_legal_text(text)


def _norms_dir(path: str | None) -> Path:
    return Path(path or os.environ.get(ENV_NORMS_DIR, DEFAULT_NORMS_DIR))


def _validate_id_convention(entries: list[NormEntry]) -> list[str]:
    """Country-pack id-convention checks (AT: OIB-family base-entry rule)."""
    problems: list[str] = []
    checked: set[str] = set()
    for entry in entries:
        country = entry.jurisdiction.country
        if country in checked:
            continue
        checked.add(country)
        pack = get_country_pack(country)
        if pack is not None:
            problems.extend(pack.validate_ids(entries))
    return problems


def _registry_signature(files: list[Path]) -> str:
    """Cache-invalidation signature over the registry files (path + mtime)."""
    return "|".join(f"{p}:{p.stat().st_mtime_ns}" for p in files)


@lru_cache(maxsize=8)
def _load_cached(resolved_dir: str, signature: str) -> tuple[NormRegistry, list[str]]:
    del signature  # cache key only: a changed registry file invalidates itself
    root = Path(resolved_dir)
    merged: list[NormEntry] = []
    pack_problems: list[str] = []
    for file_path in sorted(root.glob("*/registry.yml")):
        try:
            raw = file_path.read_text(encoding="utf-8")
        except OSError:
            logger.warning("norm_registry: registry file not readable at %s — skipped", file_path)
            continue
        try:
            data = yaml.safe_load(raw)
            norms_file = NormsFile.model_validate(data)
        except (yaml.YAMLError, ValidationError) as exc:
            logger.warning("norm_registry: invalid registry at %s (%s) — file skipped", file_path, exc)
            continue
        kept = []
        for entry in norms_file.entries:
            if entry.jurisdiction.country != norms_file.country:
                logger.warning(
                    "norm_registry: entry '%s' jurisdiction country '%s' != file country '%s' — entry skipped",
                    entry.id,
                    entry.jurisdiction.country,
                    norms_file.country,
                )
                continue
            pack = get_country_pack(entry.jurisdiction.country)
            if pack is None:
                problem = f"entry '{entry.id}': no country pack registered for '{entry.jurisdiction.country}'"
                logger.warning("norm_registry: %s — entry skipped", problem)
                pack_problems.append(problem)
                continue
            if entry.jurisdiction.state is not None and entry.jurisdiction.state not in pack.states:
                problem = (
                    f"entry '{entry.id}': unknown state token '{entry.jurisdiction.state}' "
                    f"for country '{entry.jurisdiction.country}'"
                )
                logger.warning("norm_registry: %s — entry skipped", problem)
                pack_problems.append(problem)
                continue
            kept.append(entry)
        merged.extend(kept)
    seen: set[str] = set()
    unique: list[NormEntry] = []
    for entry in merged:
        if entry.id in seen:
            logger.warning("norm_registry: duplicate entry id '%s' — later copy dropped", entry.id)
            continue
        seen.add(entry.id)
        unique.append(entry)
    dropped = {
        edition.source.application
        for entry in unique
        for edition in entry.editions
        if edition.source.kind == "ris"
        and edition.source.application
        and edition.source.application not in KNOWN_APPLICATIONS
    }
    if dropped:
        logger.warning("norm_registry: entries reference unknown RIS applications: %s", sorted(dropped))
    return NormRegistry(entries=unique), pack_problems


def load_registry(norms_dir: str | None = None, *, strict: bool = False) -> NormRegistry | None:
    """Load and merge all per-country registries; None when unavailable (fail-open).

    With ``strict=True`` (build script, tests) id-convention violations raise
    ValueError instead of disabling the registry.
    """
    root = _norms_dir(norms_dir)
    files = sorted(root.glob("*/registry.yml")) if root.is_dir() else []
    if not files:
        logger.warning("norm_registry: no registry files under %s — registry disabled", root)
        if strict:
            raise ValueError(f"norm_registry: no registry files under {root}")
        return None
    signature = _registry_signature(files)
    registry, pack_problems = _load_cached(str(root), signature)
    if pack_problems and strict:
        raise ValueError(f"norm_registry: country-pack violations: {pack_problems}")
    if registry is None or not registry.entries:
        if strict:
            raise ValueError(f"norm_registry: no valid registry entries under {root}")
        return None
    # Config bug, not runtime data: never silently orphan a Leitfaden. Strict
    # mode (build script, tests) raises; runtime fails open with a critical
    # log so one typo cannot take chat down.
    problems = _validate_id_convention(registry.entries)
    if problems:
        if strict:
            raise ValueError(f"norm_registry: OIB id-convention violations: {problems}")
        logger.critical("norm_registry: OIB id-convention violations: %s — registry disabled", problems)
        return None
    return registry


def reset_registry_cache() -> None:
    """Drop the cached registry (tests, and after regenerating registry files)."""
    _load_cached.cache_clear()


def _entry_needles(entry: NormEntry) -> list[str]:
    return [needle for needle in (entry.title, entry.short, *entry.aliases, *entry.topics) if needle]


def match_entries(registry: NormRegistry, query: str) -> list[NormEntry]:
    """Entries whose title, short name, alias, or topic term appears in the query.

    Deterministic: both sides are normalized (lowercased, umlauts expanded) and a
    term matches when it is a substring of the query. No LLM, no fuzzy scoring.
    """
    normalized_query = _normalize(query)
    if not normalized_query:
        return []
    matches: list[NormEntry] = []
    for entry in registry.entries:
        for needle in _entry_needles(entry):
            term = _normalize(needle)
            if len(term) >= _MIN_TOPIC_LENGTH and term in normalized_query:
                matches.append(entry)
                break
    return matches


def extract_bundesland(text: str | None) -> str | None:
    """The Bundesland the text points at, or None (delegates to the Austria pack).

    Pure text-matching, with no awareness of the structured envelope field —
    see ``resolve_bundesland`` for the full precedence chain that prefers it.
    The structured `bundesland=<token>` fact line (written by the intake wizard
    into the project-context prompt view) is authoritative when present — name
    probing must not override it, or a mention like "Wiener Neustadt" (a Lower
    Austrian town) would flip the jurisdiction to Wien. Free text without the
    token falls back to probing for state names (spelling variants tolerated).
    """
    return get_country_pack(DEFAULT_COUNTRY).extract_state(text)


def resolve_bundesland(text: str | None) -> str | None:
    """The Bundesland to focus/rank the registry on, structured-first.

    Precedence (backlog T3-9 follow-up, user-mandated — jurisdiction is a
    cross-cutting request fact and must travel STRUCTURED, not be re-parsed
    from prompt text):

    1. ``GridRequestContext.from_context().bundesland`` — the validated token
       carried on the signed ``X-Grid-Request-Context`` envelope. ``None``
       (``ausserhalb_oesterreichs``) is FINAL — no fall-through to probing.
    2. ``extract_bundesland(text)`` — the structured prompt-text line, then
       free-text state-name probing (no live request context).
    """
    return get_country_pack(DEFAULT_COUNTRY).resolve_state(text)


def resolve_country(text: str | None) -> str | None:
    """The ISO country code for the project, from a structured `country=<iso>` fact.

    Defaults to ``DEFAULT_COUNTRY`` when no fact is present (Austria-only
    intake today; the intake-wizard country question ships with the first
    second country — see spec §7).
    """
    if text:
        match = _STRUCTURED_COUNTRY_RE.search(text.lower())
        if match:
            return match.group(1)
    return DEFAULT_COUNTRY


def state_token_to_name(token: str | None) -> str | None:
    """Canonical Bundesland name for an intake state token, or None."""
    return get_country_pack(DEFAULT_COUNTRY).state_token_to_name(token)


def state_name_to_token(name: str | None) -> str | None:
    """Intake state token for a canonical Bundesland name, or None."""
    return get_country_pack(DEFAULT_COUNTRY).state_name_to_token(name)


def _entry_state_name(entry: NormEntry) -> str | None:
    """Canonical Bundesland name for the entry's jurisdiction state token."""
    return state_token_to_name(entry.jurisdiction.state)


def focus_entries(entries: list[NormEntry], bundesland: str | None) -> list[NormEntry]:
    """Restrict matches to the known Bundesland and put that state's law first.

    State-law entries of OTHER states are dropped — a Tyrolean project must
    never be handed the Viennese Bauordnung. Federal/stateless entries always
    stay. With no known Bundesland this is a no-op.
    """
    if not bundesland:
        return entries
    kept = [entry for entry in entries if _entry_state_name(entry) in (None, bundesland)]
    return sorted(kept, key=lambda entry: 0 if _entry_state_name(entry) == bundesland else 1)


def default_norm_filters(registry: NormRegistry | None, bundesland: str | None = None) -> dict | None:
    """Default retrieval filters for norm collections (spec §5.1).

    - ``role: diff`` is always excluded (Änderungsdokumente state no requirements).
    - ``edition_status: superseded`` is excluded, EXCEPT editions that a verified
      ``declares_binding`` relation from any state still points at — an edition can
      be superseded by the OIB and still be the binding one in a given state.
    - Jurisdiction preference: when ``bundesland`` is known and a verified binding
      from that state exists for a document, that document is restricted to the
      bound edition(s). ``status: unknown`` relations are never acted on.
    """
    if registry is None:
        return None

    clauses: list[dict] = [{"role": {"$nin": ["diff"]}}]

    superseded = {
        (entry.id, edition.id)
        for entry in registry.entries
        for edition in entry.editions
        if edition.status == "superseded"
    }
    bound: set[tuple[str, str]] = set()
    state_bound: dict[str, set[str]] = {}
    for entry in registry.entries:
        for relation in entry.relations:
            if relation.type != "declares_binding" or relation.status != "verified" or not relation.edition:
                continue
            bound.add((relation.target, relation.edition))
            if bundesland and entry.jurisdiction.state == bundesland:
                state_bound.setdefault(relation.target, set()).add(relation.edition)

    if superseded:
        spared = sorted(superseded & bound)
        if spared:
            clauses.append(
                {
                    "$or": [
                        {"edition_status": {"$ne": "superseded"}},
                        *[{"doc_id": doc_id, "edition": edition} for doc_id, edition in spared],
                    ]
                }
            )
        else:
            clauses.append({"edition_status": {"$nin": ["superseded"]}})

    for target in sorted(state_bound):
        clauses.append(
            {
                "$or": [
                    {"doc_id": {"$ne": target}},
                    {"doc_id": target, "edition": {"$in": sorted(state_bound[target])}},
                ]
            }
        )

    return {"$and": clauses}


def _ris_source(entry: NormEntry) -> EditionSource | None:
    for edition in entry.editions:
        if edition.source.kind == "ris":
            return edition.source
    return None


def _current_corpus_edition(entry: NormEntry) -> Edition | None:
    for edition in entry.editions:
        if edition.source.kind == "corpus" and edition.status == "current" and edition.role != "diff":
            return edition
    return None


def _oib_children(registry: NormRegistry, base_id: str) -> list[NormEntry]:
    """OIB-family grouping derived from the id convention, never hand-authored."""
    prefix = base_id + "-"
    children = [entry for entry in registry.entries if entry.id.startswith(prefix)]
    return sorted(children, key=lambda entry: entry.id)


_LANE_ORDER: dict[str, int] = {
    "bundesgesetz": 0,
    "verordnung": 1,  # federal verordnung (state=None) sorts with federal law
    "landesgesetz": 2,
    "oib_richtlinie": 3,
    "oib_leitfaden": 4,
    "oib_erklaerung": 5,
    "oib_referenz": 6,
    "behoerdliche_info": 7,
    "norm_extern": 8,
    "plan_parzelle": 9,
}


def _is_federal(entry: NormEntry) -> bool:
    return entry.jurisdiction.state is None and entry.rank in ("bundesgesetz", "verordnung")


def _is_state_law(entry: NormEntry) -> bool:
    return entry.rank in ("landesgesetz", "verordnung") and entry.jurisdiction.state is not None


def _render_ris_line(entry: NormEntry, source: EditionSource) -> str:
    line = f"- {entry.short} — {entry.title} [{source.application}/{source.document_number}]"
    state = _entry_state_name(entry)
    if state:
        line += f" ({state})"
    if source.full_law_url:
        line += f" Gesamt: {source.full_law_url}"
    return line


def render_prompt_block(registry: NormRegistry, bundesland: str | None = None, country: str | None = None) -> str:
    """Lane-rendered prompt block: federal, then state law (own state first), then OIB lanes.

    Rank and role are annotated so the model can apply the Normenhierarchie doctrine.
    The doctrine header comes from the country pack (``country`` defaults to AT).
    """
    pack = get_country_pack(country or DEFAULT_COUNTRY)
    lines = list(pack.doctrine_lines()) if pack else []
    federal = sorted(
        (entry for entry in registry.entries if _is_federal(entry)),
        key=lambda entry: (_LANE_ORDER[entry.rank], entry.short.lower()),
    )
    if federal:
        lines.append("")
        lines.append("Bundesrecht:")
        for entry in federal:
            source = _ris_source(entry)
            if source:
                lines.append(_render_ris_line(entry, source))
    state_law: dict[str, list[NormEntry]] = {}
    for entry in registry.entries:
        if _is_state_law(entry):
            state_law.setdefault(_entry_state_name(entry) or "", []).append(entry)
    state_order = pack.state_order if pack else ()
    ordered_states = [land for land in state_order if land in state_law]
    ordered_states.extend(sorted(state for state in state_law if state not in ordered_states))
    if bundesland and bundesland in state_law:
        ordered_states.remove(bundesland)
        ordered_states.insert(0, bundesland)
    for state in ordered_states:
        lines.append("")
        lines.append(f"Landesrecht — {state}:" if state == bundesland else f"Landesrecht — {state} (other state):")
        for entry in sorted(state_law[state], key=lambda item: item.short.lower()):
            source = _ris_source(entry)
            if source:
                lines.append(_render_ris_line(entry, source))
    richtlinien = sorted(
        (entry for entry in registry.entries if entry.rank == "oib_richtlinie"),
        key=lambda entry: entry.id,
    )
    if richtlinien:
        lines.append("")
        lines.append("OIB-Richtlinien (Basis-Korpus):")
        for entry in richtlinien:
            edition = _current_corpus_edition(entry)
            edition_label = f", {edition.label}" if edition else ""
            lines.append(f"- {entry.short} — {entry.title} [{entry.role}{edition_label}]")
            for child in _oib_children(registry, entry.id):
                child_edition = _current_corpus_edition(child)
                child_label = f", {child_edition.label}" if child_edition else ""
                lines.append(f"  - {child.short} [{child.role}{child_label}]")
    referenzen = sorted(
        (entry for entry in registry.entries if entry.rank == "oib_referenz"),
        key=lambda entry: entry.id,
    )
    if referenzen:
        lines.append("")
        lines.append("OIB-Referenzdokumente:")
        for entry in referenzen:
            edition = _current_corpus_edition(entry)
            edition_label = f", {edition.label}" if edition else ""
            lines.append(f"- {entry.short} — {entry.title} [{entry.role}{edition_label}]")
    externe = sorted(
        (entry for entry in registry.entries if entry.rank == "norm_extern"),
        key=lambda entry: entry.id,
    )
    if externe:
        lines.append("")
        lines.append("Externe Normen (Bezugsnormen — kein Volltext verfügbar, ehrlich kennzeichnen):")
        for entry in externe:
            lines.append(f"- {entry.short} — {entry.title} [{entry.role}]")
    return "\n".join(lines)


def render_block_for_prompt(
    project_context: str | None, norms_dir: str | None = None, country: str | None = None
) -> str | None:
    """Prompt-ready block, jurisdiction-aware when detectable; None when the registry is unavailable.

    Bundesland resolution prefers the structured envelope field over prompt
    text — see ``resolve_bundesland``. Country comes from the structured
    ``country=<iso>`` fact (default AT) — see ``resolve_country``.
    """
    registry = load_registry(norms_dir)
    if registry is None or not registry.entries:
        return None
    resolved_country = country or resolve_country(project_context)
    block = render_prompt_block(registry, bundesland=resolve_bundesland(project_context), country=resolved_country)
    if block is None:
        return None
    from aiq_agent.common.applicability import facts_from_project_context
    from aiq_agent.common.applicability import render_applicability_block

    facts = facts_from_project_context(project_context or "")
    if facts:
        section = render_applicability_block(registry, facts)
        if section is not None:
            return block.rstrip() + "\n\n" + section
    return block

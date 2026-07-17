"""Backward-compatible shim over ``aiq_agent.common.norm_registry``.

The curated RIS catalog (flat ``configs/ris_catalog.yml``) was superseded by the
per-country norm registry (``configs/norms/<country>/registry.yml``) — see
docs/superpowers/specs/2026-07-17-norm-registry-design.md and ADR-0025. This
module keeps the old import path and API working:

- ``load_catalog()`` with an explicit path (or the deprecated ``RIS_CATALOG_PATH``
  env var) still loads a legacy flat catalog file, with a deprecation warning.
- ``load_catalog()`` without arguments derives the RIS-pointer view from the norm
  registry (only entries with a ``kind: ris`` edition source appear).
- Matching, Bundesland resolution, focus/sort, and the flat prompt block are
  unchanged. New consumers should use ``norm_registry`` directly (lane rendering,
  relations, roles/editions).

Everything here stays fail-open: a missing or invalid source disables the feature
with a warning and never breaks the existing live-search path.
"""

from __future__ import annotations

import logging
import os
import warnings
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel
from pydantic import Field

logger = logging.getLogger(__name__)

DEFAULT_CATALOG_PATH = "configs/ris_catalog.yml"
ENV_CATALOG_PATH = "RIS_CATALOG_PATH"

# Re-exported so existing imports keep working; norm_registry is the source of truth.
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


class CatalogEntry(BaseModel):
    """One curated norm: a verified pointer into a RIS application (legacy flat view)."""

    id: str
    title: str
    short: str
    application: str
    document_number: str
    citation_url: str = ""
    full_law_url: str = ""
    bundesland: str = ""
    topics: list[str] = Field(default_factory=list)
    relevance: str = ""
    verified_at: str = ""


class RisCatalog(BaseModel):
    version: int = 1
    entries: list[CatalogEntry] = Field(default_factory=list)


def _norm_registry():
    """Lazy import: keeps this module importable standalone (build script)."""
    from aiq_agent.common import norm_registry

    return norm_registry


def _normalize(text: str) -> str:
    """Lowercase and expand umlauts so matching tolerates spelling variants."""
    return text.strip().lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")


def catalog_from_registry(registry) -> RisCatalog:
    """Flatten a NormRegistry into the legacy RIS-pointer view.

    Only entries with at least one ``kind: ris`` edition source appear; the
    OIB corpus entries are corpus-sourced and not RIS pointers.
    """
    nr = _norm_registry()
    entries: list[CatalogEntry] = []
    for entry in registry.entries:
        source = next((e.source for e in entry.editions if e.source.kind == "ris"), None)
        if source is None or not source.application:
            continue
        entries.append(
            CatalogEntry(
                id=entry.id,
                title=entry.title,
                short=entry.short,
                application=source.application,
                document_number=source.document_number,
                citation_url=source.citation_url,
                full_law_url=source.full_law_url,
                bundesland=nr.state_token_to_name(entry.jurisdiction.state) or "",
                topics=list(entry.topics),
                relevance=entry.relevance,
                verified_at=entry.verified_at,
            )
        )
    return RisCatalog(version=1, entries=entries)


def _load_legacy_file(resolved: Path) -> RisCatalog | None:
    import yaml
    from pydantic import ValidationError

    try:
        raw = resolved.read_text(encoding="utf-8")
    except OSError:
        logger.warning("ris_catalog: catalog file not readable at %s — catalog disabled", resolved)
        return None
    try:
        data = yaml.safe_load(raw)
        catalog = RisCatalog.model_validate(data)
    except (yaml.YAMLError, ValidationError) as exc:
        logger.warning("ris_catalog: invalid catalog at %s (%s) — catalog disabled", resolved, exc)
        return None
    unknown = {entry.application for entry in catalog.entries} - KNOWN_APPLICATIONS
    if unknown:
        logger.warning("ris_catalog: dropping entries with unknown applications: %s", sorted(unknown))
        catalog = catalog.model_copy(
            update={"entries": [entry for entry in catalog.entries if entry.application in KNOWN_APPLICATIONS]}
        )
    return catalog


@lru_cache(maxsize=8)
def _load_legacy_cached(resolved: str, mtime_ns: int) -> RisCatalog | None:
    """mtime-keyed cache: a regenerated file (new mtime) is reloaded."""
    del mtime_ns
    return _load_legacy_file(Path(resolved))


def load_catalog(path: str | None = None) -> RisCatalog | None:
    """Load the curated catalog; None when missing/invalid (fail-open).

    Default source is the norm registry (configs/norms/*/registry.yml). An
    explicit ``path`` or the deprecated ``RIS_CATALOG_PATH`` env var loads a
    legacy flat catalog file instead (deprecation warning).
    """
    if path is None and os.environ.get(ENV_CATALOG_PATH):
        path = os.environ[ENV_CATALOG_PATH]
    if path is not None:
        warnings.warn(
            "RIS_CATALOG_PATH / explicit catalog paths are deprecated; migrate to the norm registry "
            "(configs/norms/<country>/registry.yml, GRID_NORMS_DIR).",
            DeprecationWarning,
            stacklevel=2,
        )
        resolved = Path(path)
        try:
            mtime = resolved.stat().st_mtime_ns
        except OSError:
            mtime = -1
        return _load_legacy_cached(str(resolved), mtime)
    registry = _norm_registry().load_registry()
    if registry is None:
        return None
    catalog = catalog_from_registry(registry)
    return catalog if catalog.entries else None


def reset_catalog_cache() -> None:
    """Drop cached catalog/registry state (tests, and after regenerating files)."""
    _load_legacy_cached.cache_clear()
    _norm_registry().reset_registry_cache()


def _entry_needles(entry: CatalogEntry) -> list[str]:
    return [needle for needle in (entry.title, entry.short, *entry.topics) if needle]


def match_entries(catalog: RisCatalog, query: str) -> list[CatalogEntry]:
    """Entries whose title, short name, or a topic term appears in the query.

    Deterministic: both sides are normalized (lowercased, umlauts expanded) and a
    term matches when it is a substring of the query. No LLM, no fuzzy scoring.
    """
    normalized_query = _normalize(query)
    if not normalized_query:
        return []
    matches: list[CatalogEntry] = []
    for entry in catalog.entries:
        for needle in _entry_needles(entry):
            term = _normalize(needle)
            if len(term) >= 4 and term in normalized_query:
                matches.append(entry)
                break
    return matches


def extract_bundesland(text: str | None) -> str | None:
    """The Bundesland the text points at, or None (delegates to norm_registry)."""
    return _norm_registry().extract_bundesland(text)


def resolve_bundesland(text: str | None) -> str | None:
    """The Bundesland to focus/rank the catalog on, structured-first (delegates)."""
    return _norm_registry().resolve_bundesland(text)


def focus_entries(entries: list[CatalogEntry], bundesland: str | None) -> list[CatalogEntry]:
    """Restrict matches to the known Bundesland and put that state's law first.

    State-law entries of OTHER states are dropped — a Tyrolean project must
    never be handed the Viennese Bauordnung. Federal/stateless entries always
    stay. With no known Bundesland this is a no-op.
    """
    if not bundesland:
        return entries
    kept = [entry for entry in entries if not entry.bundesland or entry.bundesland == bundesland]
    return sorted(kept, key=lambda entry: 0 if entry.bundesland == bundesland else 1)


def _sort_entries(entries: list[CatalogEntry], bundesland: str | None) -> list[CatalogEntry]:
    def key(entry: CatalogEntry) -> tuple[int, str, str]:
        if entry.bundesland == "":
            group = 0  # federal norms first
        elif bundesland and entry.bundesland == bundesland:
            group = 1  # the project's own state next
        else:
            group = 2
        return (group, entry.bundesland.lower(), entry.short.lower())

    return sorted(entries, key=key)


def render_prompt_block(catalog: RisCatalog, bundesland: str | None = None) -> str:
    """One compact line per entry; federal first, then the given Bundesland, then the rest.

    Legacy flat rendering — new consumers should use the lane rendering in
    ``norm_registry.render_prompt_block`` instead.
    """
    lines = [
        "Curated RIS index (verified pointers to the building-relevant Austrian norms).",
        "For these norms do NOT use RIS search: fetch the document directly via the RIS fetch",
        "tool using the document number or the 'Gesamt' URL. For topic search in this index,",
        "use the RIS catalog lookup tool listed among your available tools.",
    ]
    for entry in _sort_entries(catalog.entries, bundesland):
        line = f"- {entry.short} — {entry.title} [{entry.application}/{entry.document_number}]"
        if entry.bundesland:
            line += f" ({entry.bundesland})"
        if entry.full_law_url:
            line += f" Gesamt: {entry.full_law_url}"
        lines.append(line)
    return "\n".join(lines)


def render_block_for_prompt(project_context: str | None, path: str | None = None) -> str | None:
    """Prompt-ready block, Bundesland-aware when detectable; None when unavailable.

    Legacy flat rendering kept for the two researcher templates still consuming
    this module; ``norm_registry.render_block_for_prompt`` is the lane-rendered
    successor.
    """
    catalog = load_catalog(path)
    if catalog is None or not catalog.entries:
        return None
    return render_prompt_block(catalog, bundesland=resolve_bundesland(project_context))

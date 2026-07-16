"""Curated RIS catalog: deterministic pointers to the building-relevant Austrian norms.

RIS is the Rechtsinformationssystem des Bundes (Austrian federal legal information
system). The live ``ris_search`` tool is keyword-blind: it guesses one of ~40 OGD-RIS
application silos and fires a full-text query. This module provides the deterministic
alternative — a curated, version-controlled pointer index
(``configs/ris_catalog.yml``, override via the ``RIS_CATALOG_PATH`` env var) mapping
building-law topics to exact RIS locations (application, NOR document number,
citation URL, full-law URL, Bundesland scope).

The catalog is a POINTER index only: full texts are still fetched live via
``ris_fetch_document``. Consumers:

- ``ris_catalog_lookup`` / ``ris_search`` (ris_adapter): tool-time lookup and
  short-circuit,
- the researcher agents: ``render_block_for_prompt`` injects the index into prompts.

Everything here is fail-open: a missing or invalid catalog disables the feature with
a warning and never breaks the existing live-search path.
"""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError

logger = logging.getLogger(__name__)

DEFAULT_CATALOG_PATH = "configs/ris_catalog.yml"
ENV_CATALOG_PATH = "RIS_CATALOG_PATH"

# OGD-RIS applications the curated catalog may point into (subset of the applications
# the adapter supports; see ris_adapter.client.CONTROLLER_FOR_APPLICATION).
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

# Canonical Bundesland names, in the order extract_bundesland probes them.
_BUNDESLAENDER = (
    "Wien",
    "Niederösterreich",
    "Oberösterreich",
    "Steiermark",
    "Kärnten",
    "Salzburg",
    "Tirol",
    "Vorarlberg",
    "Burgenland",
)

# Structured `bundesland` fact tokens (intake wizard vocabulary, see
# frontends/ui/src/lib/project-profile/intake-definition.ts) -> canonical names.
# `ausserhalb_oesterreichs` maps to None on purpose: the project is explicitly
# outside Austria, so no state's law should be prioritized.
_BUNDESLAND_TOKENS: dict[str, str | None] = {
    "wien": "Wien",
    "niederoesterreich": "Niederösterreich",
    "oberoesterreich": "Oberösterreich",
    "steiermark": "Steiermark",
    "kaernten": "Kärnten",
    "salzburg": "Salzburg",
    "tirol": "Tirol",
    "vorarlberg": "Vorarlberg",
    "burgenland": "Burgenland",
    "ausserhalb_oesterreichs": None,
}

# `- bundesland=wien` line from the structured project-context prompt view
# (confirmed fact or backfilled assumption — both use the same line format).
_STRUCTURED_BUNDESLAND_RE = re.compile(r"\bbundesland=([a-z_]+)")

# Terms shorter than this never match (guards against noise words).
_MIN_TOPIC_LENGTH = 4


class CatalogEntry(BaseModel):
    """One curated norm: a verified pointer into a RIS application."""

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


def _normalize(text: str) -> str:
    """Lowercase and expand umlauts so matching tolerates spelling variants."""
    return (
        text.strip()
        .lower()
        .replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
        .replace("ß", "ss")
    )


def _catalog_path(path: str | None) -> Path:
    return Path(path or os.environ.get(ENV_CATALOG_PATH, DEFAULT_CATALOG_PATH))


@lru_cache(maxsize=8)
def _load_cached(resolved_path: str, mtime_ns: int) -> RisCatalog | None:
    del mtime_ns  # cache key only: a regenerated catalog file invalidates itself
    try:
        raw = Path(resolved_path).read_text(encoding="utf-8")
    except OSError:
        logger.warning("ris_catalog: catalog file not readable at %s — catalog disabled", resolved_path)
        return None
    try:
        data = yaml.safe_load(raw)
        catalog = RisCatalog.model_validate(data)
    except (yaml.YAMLError, ValidationError) as exc:
        logger.warning("ris_catalog: invalid catalog at %s (%s) — catalog disabled", resolved_path, exc)
        return None
    unknown = {entry.application for entry in catalog.entries} - KNOWN_APPLICATIONS
    if unknown:
        logger.warning("ris_catalog: dropping entries with unknown applications: %s", sorted(unknown))
        catalog = catalog.model_copy(
            update={"entries": [entry for entry in catalog.entries if entry.application in KNOWN_APPLICATIONS]}
        )
    return catalog


def load_catalog(path: str | None = None) -> RisCatalog | None:
    """Load and validate the curated catalog; None when missing/invalid (fail-open)."""
    resolved = _catalog_path(path)
    try:
        mtime_ns = resolved.stat().st_mtime_ns
    except OSError:
        mtime_ns = -1
    return _load_cached(str(resolved), mtime_ns)


def reset_catalog_cache() -> None:
    """Drop the cached catalog (tests, and after regenerating the catalog file)."""
    _load_cached.cache_clear()


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
            if len(term) >= _MIN_TOPIC_LENGTH and term in normalized_query:
                matches.append(entry)
                break
    return matches


def extract_bundesland(text: str | None) -> str | None:
    """The Bundesland the text points at, or None.

    The structured `bundesland=<token>` fact line (written by the intake wizard
    into the project-context prompt view) is authoritative when present — name
    probing must not override it, or a mention like "Wiener Neustadt" (a Lower
    Austrian town) would flip the jurisdiction to Wien. Free text without the
    token falls back to probing for state names (spelling variants tolerated).
    """
    if not text:
        return None
    normalized = _normalize(text)
    structured = _STRUCTURED_BUNDESLAND_RE.search(normalized)
    if structured:
        return _BUNDESLAND_TOKENS.get(structured.group(1))
    for land in _BUNDESLAENDER:
        if _normalize(land) in normalized:
            return land
    return None


def focus_entries(entries: list[CatalogEntry], bundesland: str | None) -> list[CatalogEntry]:
    """Restrict matches to the known Bundesland and put that state's law first.

    State-law entries of OTHER states are dropped — a Tyrolean project must
    never be handed the Viennese Bauordnung. Federal/stateless entries always
    stay. With no known Bundesland this is a no-op (the caller keeps every
    match rather than guessing).
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
    """One compact line per entry; federal first, then the given Bundesland, then the rest."""
    lines = [
        "Curated RIS index (verified pointers to the building-relevant Austrian norms).",
        "For these norms do NOT use ris_search: fetch directly with ris_fetch_document using the",
        "document number or the 'Gesamt' URL. Use ris_catalog_lookup for topic search in this index.",
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
    """Prompt-ready block, Bundesland-aware when detectable; None when the catalog is unavailable."""
    catalog = load_catalog(path)
    if catalog is None or not catalog.entries:
        return None
    return render_prompt_block(catalog, bundesland=extract_bundesland(project_context))

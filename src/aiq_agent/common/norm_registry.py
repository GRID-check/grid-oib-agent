"""Curated norm catalog: verified RIS pointers + the legal facts the corpus cannot supply.

The registry is deliberately a FLAT catalog (successor of ``ris_catalog.yml``, reduced
from the typed-graph experiment of ADR-0025v1 — see the ADR for why). One entry per
legal norm, three jobs:

1. Pointer index: topic -> exact RIS location (application, document number, URLs),
   so the agent fetches the right law instead of blind-searching.
2. Prose facts the knowledge base cannot answer: ``binding_note`` (e.g. how the WBTV
   makes the OIB-Richtlinien binding in Vienna) rendered into researcher prompts.
3. Open verification questions: ``review_note`` — surfaced as a TODO queue in the
   platform admin UI, never rendered into prompts as fact.

The OIB corpus itself (data/oib/) is NOT listed here: the knowledge base is its
source of truth. What a corpus document *is* (Richtlinie/Leitfaden/Erläuterung)
derives from its filename — see ``oib_doc_class``/``lane_for_hit``.

Storage: the YAML seed at ``configs/norms/at/registry.yml`` (override the root via
``GRID_NORMS_DIR``), optionally superseded at runtime by the admin-managed store
(``set_db_loader`` — the store registers itself; the YAML remains the seed).

Failure semantics: a missing/invalid registry FAILS OPEN (feature disabled, warning).
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import yaml
from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError

logger = logging.getLogger(__name__)

DEFAULT_NORMS_DIR = "configs/norms"
ENV_NORMS_DIR = "GRID_NORMS_DIR"

# OGD-RIS applications the catalog may point into (subset of the applications the
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

# Legal rank: the lane an entry renders under. Law ranks carry RIS pointers;
# `behoerdliche_info` (MA-37 Merkblätter etc. — practice guidance, never new law)
# and `norm_extern` (ÖNORM/TRVB/EU-Normen — usually no accessible full text)
# cover the diagram lanes that are NOT in RIS. The OIB corpus itself stays out
# of the registry (knowledge base is its source of truth).
NormRank = Literal["bundesgesetz", "landesgesetz", "verordnung", "behoerdliche_info", "norm_extern"]

# Canonical Bundesland names, in free-text probe order.
BUNDESLAENDER: tuple[str, ...] = (
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
BUNDESLAND_TOKENS: dict[str, str | None] = {
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

_STRUCTURED_BUNDESLAND_RE = re.compile(r"\bbundesland=([a-z_]+)")

# Terms shorter than this never match (guards against noise words).
_MIN_TOPIC_LENGTH = 4

# The Normenhierarchie doctrine, injected into researcher/planner/writer prompts as
# {{ norm_doctrine }} — ONE copy, rendered by the prompt factories. Reasoning rules
# belong in the prompt; data (pointers, notes) belongs in the registry entries.
NORM_DOCTRINE = """## Normenhierarchie & Dokumentrollen

**Autoritätsordnung ≠ Abrufreihenfolge.** Welche Quelle eine Frage BEANTWORTET (Bundesgesetz >
Landesgesetz/Verordnung > OIB-Richtlinie > Leitfaden/Erläuterung) ist nicht dieselbe Ordnung, in der Quellen
ABGERUFEN werden (Projektdokumente → RIS → Web).

**Dokumentrollen beachten:**
- Anforderungen („muss", „darf nicht", Mindestwerte) stammen ausschließlich aus NORMATIVEN Dokumenten (Gesetz,
  Verordnung, OIB-Richtlinie, verbindlich erklärte Norm).
- Leitfäden beschreiben die ANWENDUNG einer Richtlinie — sie begründen keine neuen Anforderungen.
- Erläuterungen liefern BEGRÜNDUNGEN und Auslegungshilfen — ebenfalls keine neuen Anforderungen.
- Behördliche Informationen (z. B. MA 37) zeigen behördliche Praxis — niemals als neue Norm zitieren.
- Rechtskommentare stehen nicht zur Verfügung. Wenn danach gefragt wird, offen sagen — keine Kommentar-Kenntnis
  simulieren.

**Abweichungsdisziplin:** Eine OIB-Richtlinie gilt nur in der vom Bundesland verbindlich erklärten Edition und nur
ohne landesrechtliche Abweichungen. Das prüfen, soweit die Quellen es hergeben — sonst ausdrücklich als offen
kennzeichnen. Zitiert wird die verbindlich erklärte Edition, nie automatisch die neueste.

**Parzellen-Fragen zuerst am Grundstück klären.** Widmung, Bauklasse, Gebäudehöhe, Fluchtlinien u. Ä. beantworten
Flächenwidmungs- und Bebauungsplan des Grundstücks — nicht OIB oder Bauordnung allgemein. Liegt der Plan nicht in
der Wissensbasis, das offen sagen (wien.gv.at/flaechenwidmung/public) statt generisch zu antworten.

**Begriffe folgen der Ebene der Frage.** Derselbe Begriff kann in OIB, Landesrecht und Bundesrecht unterschiedlich
definiert sein (Beispiel: „Gebäudehöhe"). Die verwendete Definitionsebene immer mitnennen.

**ÖNORM-Ehrlichkeit:** ÖNORMen sind Bezugsnormen ohne Volltext in den verfügbaren Quellen. Sie nur als Verweis
nennen (soweit aus anderen Dokumenten bekannt) und offenlegen, dass der Volltext nicht verfügbar ist — niemals
ÖNORM-Inhalte aus dem Gedächtnis wiedergeben.

**Bestand/Übergangsrecht:** Wenn das Projekt kein Neubau ist (Sanierung, Zubau, Änderung), darauf hinweisen, dass
Bestandsschutz/Übergangsbestimmungen gelten können und dies baurechtlich zu prüfen ist."""

# The jurisdiction + project-hard-limits grounding, injected into every deep-research
# prompt as {{ jurisdiction_grounding }} — ONE copy, rendered by the prompt factories
# (same pattern as NORM_DOCTRINE). Keep the rendered prompts long and specific; only
# the authorship is deduplicated here so the four prompts cannot drift apart.
JURISDICTION_GROUNDING = """## Jurisdiction & Country Handling

The project context (injected at the bottom of this prompt) carries a `country=<cc>` line: an ISO-2 country
code (e.g. `at`, `de`, `ch`) or the sentinel `other` for any country without a dedicated pipeline. When the
line is absent the country is UNCONFIRMED: default to the Austrian pipeline but treat it as provisional (see
below), never as a confirmed `country=at`. For Austrian projects there is also a `bundesland=<token>` line
naming the state.

- **country=at (confirmed)**: Full Austrian building-regulation pipeline applies. OIB-Richtlinien,
  Landesbauordnung, and RIS are authoritative; cite ÖNORM only as a reference unless its binding incorporation
  and applicable text are verified; never reproduce ÖNORM full text as binding. Answer with binding-law
  precision, name the exact regulation/edition/Punkt, and state the applicable Bundesland.
- **country != at** (any other ISO-2 code, or the `other` sentinel): The OIB corpus and RIS tools are
  Austrian-only. Provide general/comparative guidance based on available sources, but clearly state that the
  answer draws on Austrian law and may not be binding in the project's jurisdiction. Always recommend local
  verification by a qualified professional. Do NOT cite OIB/RIS findings as binding for a non-AT jurisdiction.
- **country absent (unconfirmed)**: Use the Austrian pipeline provisionally, but do NOT present
  OIB/RIS/Landesbauordnung findings as binding. State that the jurisdiction is unconfirmed, ask for (or
  explicitly flag the assumption of) `country=at`, and add the same local-verification disclaimer as for a
  non-AT project.
- The `bundesland=ausserhalb_oesterreichs` token means the project is outside Austria (functionally the same
  as `country != at`), even when no explicit non-AT country line is present.

## Project Hard Limits & Grounding

The project context includes confirmed facts (hard constraints), unknowns (gaps), and assumptions
(provisional). Use them as follows:

- **Confirmed facts** are binding — never contradict them. If research sources conflict with a confirmed
  fact, flag the conflict and explain.
- **Unknowns** are known gaps — if a critical fact for the answer (especially building-class relevant:
  fluchtniveau_m, geschosse, bgf, nutzungen, bundesland) is flagged unknown, the answer must either ask for
  it or state the gap clearly.
- **Assumptions** are provisional estimates — treat as likely but note the uncertainty.
- Wizard facts that constrain building-regulation outputs: **fluchtniveau_m** → Gebäudeklasse per OIB-RL 2;
  **geschosse_oberirdisch / geschosse_unterirdisch**; **max_gebaeudehoehe**; **bgf_oberirdisch**;
  **vorhabensart** (neubau/zubau/umbau/sanierung/...); **nutzungen** (wohnen/büro/handel/...); **bauweise**;
  **aufzug**; **konditionierung**; **feuerstaetten**; **publikumsverkehr**; **gefahrenzonen**;
  **brandschutz_anlagen**; **waermeversorgung**; **pv**; **lueftung**; **kuehlung**; **versickerung**.
- Keys with `@bwN` suffix apply to a specific building; keys with `@zone` suffix to a use zone.
- When the plan or synthesis concerns a building-regulation question, cross-check the projected output
  against the project's hard limits. If the research produces a requirement that contradicts a confirmed
  fact, note the contradiction in the output rather than blindly repeating both."""


class VerifySeed(BaseModel):
    """Live-verification seed for scripts/build_ris_catalog.py (and the admin verify API)."""

    title_query: str
    expect: str = ""
    exclude: list[str] = Field(default_factory=list)
    gesetzesnummer: str = ""


class NormEntry(BaseModel):
    """One curated norm: a RIS pointer, a plain web source, or a known-but-unavailable stub.

    Exactly one source shape per entry:
    - RIS-sourced law: ``application`` + ``document_number`` (+ URLs), live-verifiable.
    - Non-RIS source (MA-37 Merkblätter, …): ``source_url`` — a plain link.
    - Unavailable norm (ÖNORM/TRVB …): no pointer at all — the entry documents that
      the norm exists and is rendered with an explicit "kein Volltext" marker so the
      agent references it honestly instead of guessing.
    """

    id: str
    title: str
    short: str
    rank: NormRank = "landesgesetz"
    bundesland: str = ""  # canonical name ("Wien"); "" = federal/stateless
    topics: list[str] = Field(default_factory=list)
    relevance: str = ""
    application: str = ""  # OGD-RIS application; empty for non-RIS entries
    document_number: str = ""
    citation_url: str = ""
    full_law_url: str = ""
    source_url: str = ""  # direct link for non-RIS sources (wien.gv.at, oib.or.at, …)
    aliases: list[str] = Field(default_factory=list)
    binding_note: str = ""  # prose legal fact, rendered into the prompt block
    review_note: str = ""  # open verification TODO (admin UI only, never prompt fact)
    verify: VerifySeed | None = None
    verified_at: str = ""

    @property
    def is_ris(self) -> bool:
        return bool(self.application and self.document_number)


class NormsFile(BaseModel):
    """The registry file (configs/norms/<country>/registry.yml) / admin-store payload.

    ``corpus_collection`` is the RAG-side seam for country expansion: it names the
    knowledge-base base collection holding this country's norm corpus full texts
    (AT: ``oib_knowledge``). A second country ships its own registry file + corpus
    collection; retrieval scope selection then keys off this field instead of a
    hardcoded collection name. The catalog (pointers/notes) and the corpus (full
    texts in the RAG, managed via the platform Base-Knowledge surface) are the two
    halves of the same per-country knowledge plane.
    """

    version: int = 1
    corpus_collection: str = "oib_knowledge"
    # Optional CountryProfile data overrides (empty = code defaults win; see
    # aiq_agent.common.country_profile). Admin-editable through the norms store.
    language: str = ""
    states: dict[str, str | None] = Field(default_factory=dict)
    corpus_note: str = ""
    doctrine: str = ""
    parcel_tags: list[str] = Field(default_factory=list)
    entries: list[NormEntry] = Field(default_factory=list)


class NormRegistry(BaseModel):
    """The loaded catalog view handed to consumers."""

    entries: list[NormEntry] = Field(default_factory=list)

    def by_id(self, entry_id: str) -> NormEntry | None:
        for entry in self.entries:
            if entry.id == entry_id:
                return entry
        return None


def _normalize(text: str) -> str:
    """Lowercase and expand umlauts so matching tolerates spelling variants."""
    return text.strip().lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")


# ---------------------------------------------------------------------------
# Loading. YAML seed by default; the admin-managed store may register itself as
# the runtime source via set_db_loader (the YAML stays the seed / fallback).
# ---------------------------------------------------------------------------

_db_loader: Callable[[], NormsFile | None] | None = None
# Optional callback that drops the db loader's own cache. The admin store
# memoizes its parsed payload with a short TTL for the hot path; registering its
# invalidator here lets ``reset_registry_cache`` (called after admin edits) flush
# that cache too, so a fresh registry is observed immediately rather than within
# the TTL.
_db_cache_reset: Callable[[], None] | None = None


def set_db_loader(
    loader: Callable[[], NormsFile | None] | None,
    cache_reset: Callable[[], None] | None = None,
) -> None:
    """Register the admin store as the runtime registry source (None to unset).

    The loader returns the stored NormsFile, or None to fall back to the YAML
    seed. Must never raise; the store is expected to fail open itself. The
    optional ``cache_reset`` drops the loader's own memo and is invoked by
    :func:`reset_registry_cache` (so admin writes flush it immediately).
    """
    global _db_loader, _db_cache_reset
    _db_loader = loader
    _db_cache_reset = cache_reset
    reset_registry_cache()


# The repository root, three levels above this file (src/aiq_agent/common/).
# Only meaningful for a source checkout; an installed wheel has no seed beside it.
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _norms_dir(path: str | None) -> Path:
    """The norms seed directory: explicit ``path``, else ``$GRID_NORMS_DIR``, else the default.

    The default is relative to the working directory, which is the repo root
    everywhere the seed is loaded on purpose. When it is NOT there — a test run
    from a package directory such as ``frontends/aiq_api`` — resolve it against
    the repository root instead, so the seed does not silently vanish and every
    caller downstream sees an empty registry.
    """
    if path:
        return Path(path)
    env_value = os.environ.get(ENV_NORMS_DIR)
    if env_value:
        return Path(env_value)
    default = Path(DEFAULT_NORMS_DIR)
    if default.is_dir():
        return default
    from_root = _REPO_ROOT / DEFAULT_NORMS_DIR
    return from_root if from_root.is_dir() else default


def _validated_entries(norms_file: NormsFile, origin: str) -> list[NormEntry]:
    """Drop invalid entries fail-open (unknown application / state / duplicate id)."""
    kept: list[NormEntry] = []
    seen: set[str] = set()
    for entry in norms_file.entries:
        if entry.id in seen:
            logger.warning("norm_registry: duplicate entry id '%s' in %s — later copy dropped", entry.id, origin)
            continue
        if entry.application and entry.application not in KNOWN_APPLICATIONS:
            logger.warning(
                "norm_registry: entry '%s' has unknown RIS application '%s' — entry dropped",
                entry.id,
                entry.application,
            )
            continue
        if entry.rank in ("bundesgesetz", "landesgesetz", "verordnung") and not entry.is_ris:
            logger.warning(
                "norm_registry: law entry '%s' (rank %s) has no RIS pointer — entry dropped",
                entry.id,
                entry.rank,
            )
            continue
        if entry.bundesland and entry.bundesland not in BUNDESLAENDER:
            logger.warning(
                "norm_registry: entry '%s' has unknown Bundesland '%s' — entry dropped",
                entry.id,
                entry.bundesland,
            )
            continue
        seen.add(entry.id)
        kept.append(entry)
    return kept


@lru_cache(maxsize=8)
def _load_yaml_cached(resolved: str, mtime_ns: int) -> NormsFile | None:
    """mtime-keyed cache: a regenerated file (new mtime) is reloaded."""
    del mtime_ns
    path = Path(resolved)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        logger.warning("norm_registry: registry file not readable at %s — registry disabled", path)
        return None
    try:
        data = yaml.safe_load(raw)
        return NormsFile.model_validate(data)
    except (yaml.YAMLError, ValidationError) as exc:
        logger.warning("norm_registry: invalid registry at %s (%s) — registry disabled", path, exc)
        return None


def registry_yaml_files(norms_dir: str | None = None) -> list[Path]:
    """The YAML seed files under the norms dir (one per country directory)."""
    root = _norms_dir(norms_dir)
    return sorted(root.glob("*/registry.yml")) if root.is_dir() else []


def load_registry(norms_dir: str | None = None) -> NormRegistry | None:
    """Load the catalog; None when unavailable (fail-open).

    Runtime source precedence: the admin store (when registered and non-empty),
    then the YAML seed files. An explicit ``norms_dir`` always reads YAML —
    that is the seed/build-script path.
    """
    if norms_dir is None and _db_loader is not None:
        try:
            stored = _db_loader()
        except Exception:  # noqa: BLE001 — the hot path must never break on store errors
            logger.warning("norm_registry: admin-store loader failed — falling back to YAML seed", exc_info=True)
            stored = None
        if stored is not None and stored.entries:
            entries = _validated_entries(stored, "admin store")
            return NormRegistry(entries=entries) if entries else None
    files = registry_yaml_files(norms_dir)
    if not files:
        logger.warning("norm_registry: no registry files under %s — registry disabled", _norms_dir(norms_dir))
        return None
    merged: list[NormEntry] = []
    for file_path in files:
        try:
            mtime = file_path.stat().st_mtime_ns
        except OSError:
            mtime = -1
        norms_file = _load_yaml_cached(str(file_path), mtime)
        if norms_file is not None:
            merged.extend(_validated_entries(norms_file, str(file_path)))
    return NormRegistry(entries=merged) if merged else None


def reset_registry_cache() -> None:
    """Drop cached registry state (tests, and after writes/regeneration)."""
    _load_yaml_cached.cache_clear()
    if _db_cache_reset is not None:
        try:
            _db_cache_reset()
        except Exception:  # noqa: BLE001 — cache invalidation must never break callers
            logger.warning("norm_registry: db loader cache reset failed", exc_info=True)


# ---------------------------------------------------------------------------
# Matching and jurisdiction (unchanged semantics from the proven flat catalog).
# ---------------------------------------------------------------------------


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
    """The Bundesland the text points at, or None. Pure text matching.

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
        return BUNDESLAND_TOKENS.get(structured.group(1))
    for state in BUNDESLAENDER:
        if _normalize(state) in normalized:
            return state
    return None


def resolve_bundesland(text: str | None) -> str | None:
    """The Bundesland to focus/rank the catalog on, structured-first.

    Precedence (jurisdiction is a cross-cutting request fact and must travel
    STRUCTURED, not be re-parsed from prompt text):

    1. ``GridRequestContext.from_context().bundesland`` — the validated token
       carried on the signed ``X-Grid-Request-Context`` envelope. ``None``
       (``ausserhalb_oesterreichs``) is FINAL — no fall-through to probing.
    2. ``extract_bundesland(text)`` — the structured prompt-text line, then
       free-text state-name probing (no live request context).
    """
    from aiq_agent.project_context import GridRequestContext

    structured_token = GridRequestContext.from_context().bundesland
    if structured_token is not None:
        return BUNDESLAND_TOKENS.get(structured_token)
    return extract_bundesland(text)


_STRUCTURED_COUNTRY_RE = re.compile(r"\bcountry=([a-z]{2})\b")


def resolve_country(text: str | None) -> str:
    """ISO country code for the project: structured `country=<cc>` fact, else 'at'.

    Austria-only intake today; the structured fact ships with the first second
    country. Consumer: CountryProfile selection (doctrine, corpus note, parcel
    tags, retrieval base collection).
    """
    if text:
        match = _STRUCTURED_COUNTRY_RE.search(text.lower())
        if match:
            return match.group(1)
    return "at"


def load_norms_file(country: str = "at") -> NormsFile | None:
    """The raw NormsFile for a country (store-first for the default country).

    Used by CountryProfile to apply admin-edited data overrides. The admin
    store currently keys the default country; other countries read their YAML
    seed directly (the store grows a country column with country #2).
    """
    if country == "at" and _db_loader is not None:
        try:
            stored = _db_loader()
        except Exception:  # noqa: BLE001
            stored = None
        if stored is not None and stored.entries:
            return stored
    path = _norms_dir(None) / country / "registry.yml"
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return None
    return _load_yaml_cached(str(path), mtime)


def doctrine_for(project_context: str | None) -> str:
    """The Normenhierarchie doctrine for the project's country (fail-open to AT)."""
    try:
        from aiq_agent.common.country_profile import get_country_profile

        profile = get_country_profile(resolve_country(project_context))
        if profile is not None:
            return profile.doctrine
    except Exception:  # noqa: BLE001 — prompt building must never break on profile lookup
        logger.warning("norm_registry: doctrine profile lookup failed", exc_info=True)
    return NORM_DOCTRINE


def focus_entries(entries: list[NormEntry], bundesland: str | None) -> list[NormEntry]:
    """Restrict matches to the known Bundesland and put that state's law first.

    State-law entries of OTHER states are dropped — a Tyrolean project must
    never be handed the Viennese Bauordnung. Federal/stateless entries always
    stay. With no known Bundesland this is a no-op.
    """
    if not bundesland:
        return entries
    kept = [entry for entry in entries if not entry.bundesland or entry.bundesland == bundesland]
    return sorted(kept, key=lambda entry: 0 if entry.bundesland == bundesland else 1)


# ---------------------------------------------------------------------------
# Prompt rendering: doctrine lives in NORM_DOCTRINE; this block is the data —
# federal lane, the project's own state lane (other states are dropped), prose
# binding notes, and a static pointer at the OIB corpus in the knowledge base.
# ---------------------------------------------------------------------------

_BLOCK_HEADER = (
    "Kuratierter Normenkatalog (verifizierte RIS-Verweise).\n"
    "Für diese Normen KEINE RIS-Suche verwenden: das Dokument direkt über das RIS-Fetch-Tool\n"
    "(Dokumentnummer oder 'Gesamt'-URL) laden. Für Themensuche im Katalog das\n"
    "RIS-Catalog-Lookup-Tool verwenden."
)

OIB_CORPUS_NOTE = (
    "OIB-Korpus (bereits in der Wissensbasis, keine RIS-Abfrage nötig): OIB-Richtlinien 1–6\n"
    "samt Leitfäden, Erläuterungen, Begriffsbestimmungen und zitierten Normen, Ausgabe Mai 2023.\n"
    'Zitieren als "OIB-RL <N>, Pkt <x>, Ausgabe Mai 2023". Anforderungen nur aus der Richtlinie\n'
    "selbst — Leitfaden/Erläuterung sind Auslegungshilfen."
)


_LAW_RANKS = ("bundesgesetz", "landesgesetz", "verordnung")


def _render_entry_line(entry: NormEntry) -> str:
    if entry.is_ris:
        line = f"- {entry.short} — {entry.title} [{entry.application}/{entry.document_number}]"
    else:
        line = f"- {entry.short} — {entry.title}"
    if entry.bundesland:
        line += f" ({entry.bundesland})"
    # Render BOTH URLs when both are set (e.g. a consolidated law plus a curated
    # annex link) — an `elif` here silently dropped a populated ``source_url``
    # whenever ``full_law_url`` was also present.
    if entry.full_law_url:
        line += f" Gesamt: {entry.full_law_url}"
    if entry.source_url:
        line += f" Quelle: {entry.source_url}"
    if not entry.full_law_url and not entry.source_url and not entry.is_ris:
        line += " (kein Volltext verfügbar — nur referenzieren)"
    return line


def render_prompt_block(registry: NormRegistry, bundesland: str | None = None, corpus_note: str | None = None) -> str:
    """Compact catalog block: federal lane, then the focused state lane.

    Other states' law is dropped entirely (same rule as ``focus_entries``) —
    with no known Bundesland, all state lanes render, grouped by state.
    """
    lines = [_BLOCK_HEADER, ""]
    focused = focus_entries(registry.entries, bundesland)
    law = [entry for entry in focused if entry.rank in _LAW_RANKS]
    federal = [entry for entry in law if not entry.bundesland]
    if federal:
        lines.append("Bundesrecht:")
        lines.extend(_render_entry_line(entry) for entry in sorted(federal, key=lambda e: e.short.lower()))
    by_state: dict[str, list[NormEntry]] = {}
    for entry in law:
        if entry.bundesland:
            by_state.setdefault(entry.bundesland, []).append(entry)
    for state in sorted(by_state, key=lambda s: (s != bundesland, s)):
        lines.append("")
        lines.append(f"Landesrecht — {state}:")
        lines.extend(_render_entry_line(entry) for entry in sorted(by_state[state], key=lambda e: e.short.lower()))
    behoerdlich = [entry for entry in focused if entry.rank == "behoerdliche_info"]
    if behoerdlich:
        lines.append("")
        lines.append("Behördliche Informationen (Praxis-Hinweise — nur Ergänzungen, niemals neue Normen):")
        lines.extend(_render_entry_line(entry) for entry in sorted(behoerdlich, key=lambda e: e.short.lower()))
    extern = [entry for entry in focused if entry.rank == "norm_extern"]
    if extern:
        lines.append("")
        lines.append("Externe Normen (Bezugsnormen — Volltext i. d. R. nicht verfügbar, ehrlich kennzeichnen):")
        lines.extend(_render_entry_line(entry) for entry in sorted(extern, key=lambda e: e.short.lower()))
    notes = [entry for entry in focused if entry.binding_note]
    if notes:
        lines.append("")
        lines.append("Rechtliche Hinweise (kuratiert):")
        for entry in notes:
            lines.append(f"- {entry.short}: {entry.binding_note}")
    lines.append("")
    lines.append(corpus_note or OIB_CORPUS_NOTE)
    return "\n".join(lines)


def render_block_for_prompt(project_context: str | None, norms_dir: str | None = None) -> str | None:
    """Prompt-ready catalog block, Bundesland-aware when detectable; None when unavailable."""
    registry = load_registry(norms_dir)
    if registry is None or not registry.entries:
        return None
    corpus_note = None
    try:
        from aiq_agent.common.country_profile import get_country_profile

        profile = get_country_profile(resolve_country(project_context))
        corpus_note = profile.corpus_note if profile else None
    except Exception:  # noqa: BLE001
        logger.warning("norm_registry: corpus-note profile lookup failed", exc_info=True)
    block = render_prompt_block(registry, bundesland=resolve_bundesland(project_context), corpus_note=corpus_note)
    try:
        from aiq_agent.common.applicability import render_project_block

        section = render_project_block(project_context or "")
    except Exception:  # noqa: BLE001 — applicability must never break prompt building
        logger.warning("norm_registry: applicability block failed — omitted", exc_info=True)
        section = None
    if section:
        return block.rstrip() + "\n\n" + section
    return block


# ---------------------------------------------------------------------------
# Parcel plane: Flächenwidmungs-/Bebauungsplan documents live INSIDE the RAG
# (project collection, tag-classified at ingestion). When present they are the
# per-parcel source of truth — this note flips the doctrine's "ask for the
# plan" rule into "the plan is HERE, use it first".
# ---------------------------------------------------------------------------

_PARCEL_TAGS = ("Bebauungsplan", "Flächenwidmungsplan")


def _parcel_tags_for(country: str | None) -> tuple[str, ...]:
    try:
        from aiq_agent.common.country_profile import get_country_profile

        profile = get_country_profile(country)
        if profile is not None:
            return tuple(profile.parcel_tags)
    except Exception:  # noqa: BLE001
        logger.warning("norm_registry: parcel-tag profile lookup failed", exc_info=True)
    return _PARCEL_TAGS


def parcel_note(available_documents: list[dict] | None, country: str | None = None) -> str | None:
    """Prompt note naming the project's parcel documents as the governing source.

    ``available_documents`` are the per-turn document dicts (file_name/summary/
    tags). Returns None when the project holds no tagged parcel document — the
    static doctrine rule (demand the plan / point at the public portal) then
    applies unchanged.
    """
    if not available_documents:
        return None
    parcel_tags = _parcel_tags_for(country)
    by_tag: dict[str, list[str]] = {}
    for doc in available_documents:
        tags = doc.get("tags") or []
        name = doc.get("file_name")
        if not name:
            continue
        for tag in parcel_tags:
            if tag in tags:
                by_tag.setdefault(tag, []).append(name)
    if not by_tag:
        return None
    lines = ["## Parzellen-Quellen dieses Projekts (maßgeblich für Widmung, Bauklasse, Gebäudehöhe, Fluchtlinien)"]
    for tag in parcel_tags:
        if tag in by_tag:
            files = ", ".join(sorted(by_tag[tag]))
            lines.append(f"- {tag}: {files}")
    lines.append(
        "Diese Dokumente sind für parzellenbezogene Fragen die maßgebliche Quelle — VOR OIB und Bauordnung "
        "heranziehen (knowledge_search). Generische Antworten auf Parzellen-Fragen sind unzulässig, solange "
        "diese Dokumente nicht geprüft wurden."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Lane classification for research-source events (fan-out UI). Deterministic
# tagging: the hierarchy stays in the registry/filenames, the UI gets labels.
# ---------------------------------------------------------------------------

# data/oib filename prefixes -> OIB document class.
_OIB_CLASS_PREFIXES: tuple[tuple[str, str], ...] = (
    ("aenderungen_", "aenderungen"),
    ("erlaeuterungen_", "erlaeuterungen"),
    ("oib-rl_begriffsbestimmungen", "begriffsbestimmungen"),
    ("oib-rl_zitierte_normen", "zitierte_normen"),
)

_RANK_LANES: dict[str, tuple[str, str]] = {
    "bundesgesetz": ("baurecht_bund", "Bundesrecht"),
    "landesgesetz": ("baurecht_land", "Landesrecht"),
    "verordnung": ("baurecht_verordnung", "Verordnung"),
    "behoerdliche_info": ("behoerde", "Behördliche Information"),
    "norm_extern": ("norm_extern", "Externe Norm"),
}

_OIB_CLASS_LANES: dict[str, tuple[str, str]] = {
    "richtlinie": ("baurecht_oib", "OIB-Richtlinie"),
    "leitfaden": ("baurecht_oib_leitfaden", "OIB-Leitfaden"),
    "erlaeuterungen": ("baurecht_oib_erlaeuterung", "OIB-Erläuterung"),
    "begriffsbestimmungen": ("baurecht_oib_begriffe", "OIB-Begriffsbestimmungen"),
    "zitierte_normen": ("baurecht_oib_referenz", "OIB-Referenzdokument"),
    "aenderungen": ("baurecht_oib_diff", "OIB-Änderungsdokument"),
}

# Label for a lane key, aggregated from the OIB-class + rank tables plus the
# lanes only reachable through an explicit doc_class: ``baurecht_ris`` (a
# generic RIS legal source) and ``baurecht_basis`` (the NEW neutral base lane,
# coarse kind ``baurecht`` via the prefix in ``source_kinds._LANE_KIND_PREFIXES``).
_LANE_LABELS: dict[str, str] = {
    **{key: label for key, label in _OIB_CLASS_LANES.values()},
    **{key: label for key, label in _RANK_LANES.values()},
    "baurecht_ris": "Rechtsquelle (RIS)",
    "baurecht_basis": "Basisdokument",
}


def oib_doc_class(file_name: str) -> str | None:
    """OIB document class derived from the corpus filename convention, or None."""
    name = file_name.lower()
    if not (name.startswith("oib-rl_") or name.startswith("aenderungen_") or name.startswith("erlaeuterungen_")):
        return None
    for prefix, doc_class in _OIB_CLASS_PREFIXES:
        if name.startswith(prefix):
            return doc_class
    if "leitfaden" in name:
        return "leitfaden"
    return "richtlinie"


# Maps the coarse ``oib_doc_class`` filename guess to the explicit doc_class
# vocabulary key (``document_classification.DOCUMENT_CLASSES``).
_OIB_CLASS_TO_DOC_CLASS: dict[str, str] = {
    "richtlinie": "oib_richtlinie",
    "leitfaden": "oib_leitfaden",
    "erlaeuterungen": "oib_erlaeuterung",
    "begriffsbestimmungen": "oib_begriffe",
    "zitierte_normen": "oib_referenz",
    "aenderungen": "oib_aenderung",
}


def guess_doc_class(file_name: str) -> str:
    """Pre-fill guess for the explicit doc_class, derived from the filename.

    Wraps :func:`oib_doc_class` and maps its OIB filename class onto the
    doc_class vocabulary. An unknown filename (no OIB hint) resolves to the
    neutral :data:`~aiq_agent.knowledge.document_classification.DEFAULT_DOC_CLASS`
    so ingestion always has a real value to store and stamp. Import is local to
    avoid an import cycle with the knowledge package.
    """
    from aiq_agent.knowledge.document_classification import DEFAULT_DOC_CLASS

    raw = oib_doc_class(Path(file_name).name) if file_name else None
    return _OIB_CLASS_TO_DOC_CLASS.get(raw, DEFAULT_DOC_CLASS)


# German role prefixes derived from the corpus filename convention. These seed a
# *default* display title only — the stored value in the document_metadata store
# is authoritative and admin-overridable, so an odd future filename never shows a
# wrong name forever (worst case: a mediocre default an admin corrects once).
_OIB_TITLE_ROLE_PREFIXES: tuple[tuple[str, str], ...] = (
    ("erlaeuterungen_", "Erläuterungen zu "),
    ("aenderungen_", "Änderungen zu "),
)

# The edition as the corpus files spell it: ``ausgabe_<monat>_<jahr>`` or
# ``ausgabe_<jahr>``. The month is any word, the year any four digits — the
# shipped corpus is all "Mai 2023", but a title parser that only knows one
# edition mislabels the next one as the one it knows, or refuses it.
_OIB_EDITION_RE = re.compile(r"ausgabe[_-](?:([^\W\d_]+)[_-])?(\d{4})")
# Filenames write German umlauts as digraphs (``maerz``); the title writes them
# as letters. A structural transliteration rather than a table of month names.
_UMLAUT_DIGRAPHS = (("ae", "ä"), ("oe", "ö"), ("ue", "ü"))
_OIB_REVISION_RE = re.compile(r"rev[_.]?(\d+)")
_OIB_NUMBER_RE = re.compile(r"^(\d+(?:\.\d+)?)")


def _render_edition(month: str | None, year: str) -> str:
    """``("mai", "2023")`` -> ``"Ausgabe Mai 2023"``; ``(None, "2019")`` -> ``"Ausgabe 2019"``."""
    if not month:
        return f"Ausgabe {year}"
    word = month
    for digraph, letter in _UMLAUT_DIGRAPHS:
        word = word.replace(digraph, letter)
    return f"Ausgabe {word.capitalize()} {year}"


def guess_display_title(file_name: str) -> str | None:
    """Derive a human display title for an OIB corpus document from its filename.

    This is the DEFAULT seed stamped at ingestion; the stored
    ``display_title`` (document_metadata store) overrides it and is the
    user-editable source of truth. Returns ``None`` for a filename this cannot
    confidently render (any non-OIB upload, or an unrecognised OIB structure) —
    callers then keep the document's existing name rather than showing a mangled
    guess.

    Examples::

        oib-rl_2_ausgabe_mai_2023.pdf        -> "OIB-Richtlinie 2, Ausgabe Mai 2023"
        oib-rl_2.3_ausgabe_mai_2023.pdf      -> "OIB-Richtlinie 2.3, Ausgabe Mai 2023"
        oib-rl_6-leitfaden_...pdf            -> "OIB-Richtlinie 6 – Leitfaden, Ausgabe Mai 2023"
        erlaeuterungen_oib-rl_2_...pdf       -> "Erläuterungen zu OIB-Richtlinie 2, Ausgabe Mai 2023"
    """
    if not file_name:
        return None
    stem = Path(Path(file_name).name).stem
    # Normalise the one known separator inconsistency (`6-leitfaden` vs
    # `2_leitfaden`) so the rest of the parse is uniform.
    low = stem.lower().replace("-leitfaden", "_leitfaden")

    role_prefix = ""
    for marker, german in _OIB_TITLE_ROLE_PREFIXES:
        if low.startswith(marker):
            role_prefix = german
            low = low[len(marker) :]
            break

    if not low.startswith("oib-rl_"):
        return None
    low = low[len("oib-rl_") :]

    edition = ""
    edition_match = _OIB_EDITION_RE.search(low)
    if edition_match:
        edition = _render_edition(edition_match.group(1), edition_match.group(2))
        low = (low[: edition_match.start()] + low[edition_match.end() :]).strip("_")

    revision = ""
    revision_match = _OIB_REVISION_RE.search(low)
    if revision_match:
        revision = f"Rev. {revision_match.group(1)}"
        low = (low[: revision_match.start()] + low[revision_match.end() :]).strip("_")

    is_leitfaden = "leitfaden" in low
    low = low.replace("leitfaden", "").strip("_")

    if low.startswith("begriffsbestimmungen"):
        subject = "OIB-Richtlinie Begriffsbestimmungen"
    elif low.startswith("zitierte_normen"):
        subject = "OIB-Richtlinie – Zitierte Normen und sonstige technische Regelwerke"
    elif not low:
        subject = "OIB-Richtlinie"
    else:
        number_match = _OIB_NUMBER_RE.match(low)
        if not number_match:
            return None
        subject = f"OIB-Richtlinie {number_match.group(1)}"

    if is_leitfaden:
        subject += " – Leitfaden"

    title = f"{role_prefix}{subject}"
    tail = ", ".join(part for part in (edition, revision) if part)
    return f"{title}, {tail}" if tail else title


def _host_matches(source_url: str | None, domain: str) -> bool:
    """True when *source_url*'s host is ``domain`` or a subdomain of it.

    Lanes are provenance labels, so they must key off the real host: a substring
    test would also accept lookalike hosts (``wien.gv.at.evil.example``) and mere
    path/query text (``evil.example/?q=wien.gv.at``). Mirrors ``isHost`` in the
    frontend ``trace-lanes`` client.
    """
    raw = (source_url or "").strip()
    if not raw:
        return False
    if "://" not in raw:
        raw = f"https://{raw}"
    try:
        host = (urlparse(raw).hostname or "").lower()
    except ValueError:
        return False
    return host == domain or host.endswith(f".{domain}")


def lane_for_hit(
    *,
    doc_class: str | None = None,
    file_name: str | None = None,
    source_url: str | None = None,
    collection: str | None = None,
    registry: NormRegistry | None = None,
    shelf: object = None,
) -> tuple[str, str]:
    """(stratum_key, human label) for a retrieval/citation hit — display tagging only.

    Strata match the product's data placement: Baurecht (authority: registry law +
    OIB corpus), Projektwissen (project/session collections), Büroarchiv (org
    archiv), Web. Unknown inputs land in ("web", "Web") fail-open.

    An explicit, human-set ``doc_class`` (the "Dokumentart") is FIRST priority:
    when valid it fully determines the lane, overriding every collection/filename/
    url heuristic below. This is the authoritative signal the filename guess only
    approximates. The one exception is the DEFAULT class on a user's own shelf:
    ``sonstiges`` is what ingestion stamps on a file nobody classified, and on a
    project, session or Büroarchiv document it says nothing a person decided —
    it must not turn the user's plan into a "Basisdokument" in law blue.

    ``shelf`` is the shelf the caller knows the hit came from; without it the
    collection id is read the legacy way (ADR-0047).
    """
    from aiq_agent.common.source_kinds import Shelf
    from aiq_agent.common.source_kinds import legacy_shelf_for_collection_name
    from aiq_agent.common.source_kinds import parse_shelf

    known_shelf = parse_shelf(shelf) or legacy_shelf_for_collection_name(collection)
    users_shelf = known_shelf in (Shelf.ARCHIV, Shelf.PROJECT, Shelf.SESSION)
    if doc_class:
        from aiq_agent.knowledge.document_classification import DEFAULT_DOC_CLASS
        from aiq_agent.knowledge.document_classification import DOCUMENT_CLASS_LANES
        from aiq_agent.knowledge.document_classification import is_valid_doc_class

        if is_valid_doc_class(doc_class) and not (doc_class == DEFAULT_DOC_CLASS and users_shelf):
            lane_key = DOCUMENT_CLASS_LANES[doc_class]
            return (lane_key, _LANE_LABELS.get(lane_key, "Baurecht"))
    if known_shelf is Shelf.ARCHIV:
        return ("buero", "Büroarchiv")
    if known_shelf is Shelf.PROJECT:
        return ("projekt", "Projektwissen")
    if known_shelf is Shelf.SESSION:
        return ("projekt", "Private Sitzung")
    if file_name:
        doc_class = oib_doc_class(Path(file_name).name)
        if doc_class:
            return _OIB_CLASS_LANES[doc_class]
    if _host_matches(source_url, "ris.bka.gv.at"):
        if registry:
            for entry in registry.entries:
                if entry.document_number and entry.document_number in source_url:
                    return _RANK_LANES[entry.rank]
        return ("baurecht_ris", "Rechtsquelle (RIS)")
    # wien.gv.at is the curated MA-37 (Baupolizei Wien) registry pointer —
    # official municipal building information, Baurecht family, never Web.
    # Mirrors the frontend laneForHitClient so both render paths agree.
    if _host_matches(source_url, "wien.gv.at"):
        return ("behoerde", "Behördliche Information")
    if collection:  # a named KB collection that is not project/archiv: the base corpus
        return ("baurecht_oib", "OIB-Richtlinie")
    return ("web", "Web")


def lane_for_knowledge_hit(
    *,
    doc_class: str | None = None,
    file_name: str | None = None,
    source_url: str | None = None,
    collection: str | None = None,
    registry: NormRegistry | None = None,
) -> tuple[str, str]:
    """:func:`lane_for_hit` for a hit that came from the KNOWLEDGE LAYER.

    Identical, except that such a hit can never be Web. A retrieved document is
    by definition something we hold — a project upload, the Büroarchiv, the base
    corpus — so ``("web", "Web")`` is not a classification, it is the fail-open
    value meaning "none of the signals matched" (no doc_class, no recognizable
    collection prefix, no OIB filename). Those land in Projektwissen.

    This exists so the two consumers of the rule cannot drift: the citation
    chips (``citation_verification.source_lane``) and the Herleitung fan-out
    (``knowledge_layer.register._trace_lanes_json``) used to apply it
    separately, and only the former actually did — so the same document showed
    as "Projektwissen" on a chip and "Web" in the fan-out of the same answer.
    """
    lane = lane_for_hit(
        doc_class=doc_class,
        file_name=file_name,
        source_url=source_url,
        collection=collection,
        registry=registry,
    )
    return ("projekt", "Projektwissen") if lane == ("web", "Web") else lane

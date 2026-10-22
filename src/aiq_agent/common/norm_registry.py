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
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import yaml
from pydantic import AliasChoices
from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError
from pydantic import field_validator

from aiq_agent.common.source_kinds import AGENT_AUTHORED_LANE
from aiq_agent.common.source_kinds import AGENT_AUTHORED_LANE_LABEL
from aiq_agent.common.source_kinds import MAIL_LANE
from aiq_agent.common.source_kinds import MAIL_LANE_LABEL
from aiq_agent.common.source_kinds import MAIL_SOURCE_FORMAT
from aiq_agent.common.source_kinds import OFFICE_MAIL_LANE
from aiq_agent.profile_names import normalize_profile_token

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
# `authority_info` (MA-37 Merkblätter etc. — practice guidance, never new law)
# and `external_standard` (ÖNORM/TRVB/EU-Normen — usually no accessible full text)
# cover the diagram lanes that are NOT in RIS. The OIB corpus itself stays out
# of the registry (knowledge base is its source of truth).
NormRank = Literal["federal_law", "state_law", "ordinance", "authority_info", "external_standard"]

# The German ranks a stored registry (the admin-edited row in the knowledge
# database, a seed file not yet re-saved) still carries. Read-only: nothing
# writes these, and the next admin save stores the English ones.
LEGACY_NORM_RANK: dict[str, str] = {
    "bundesgesetz": "federal_law",
    "landesgesetz": "state_law",
    "verordnung": "ordinance",
    "behoerdliche_info": "authority_info",
    "norm_extern": "external_standard",
}

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

# Structured `federal_state` fact tokens (intake wizard vocabulary, see
# frontends/ui/src/lib/project-profile/intake-definition.ts) -> canonical names.
# `outside_austria` maps to None on purpose: the project is explicitly
# outside Austria, so no state's law should be prioritized.
FEDERAL_STATE_TOKENS: dict[str, str | None] = {
    "vienna": "Wien",
    "lower_austria": "Niederösterreich",
    "upper_austria": "Oberösterreich",
    "styria": "Steiermark",
    "carinthia": "Kärnten",
    "salzburg": "Salzburg",
    "tyrol": "Tirol",
    "vorarlberg": "Vorarlberg",
    "burgenland": "Burgenland",
    "outside_austria": None,
}

# `bundesland=` is the line a prompt view an older pod stored still carries (migration 0159).
_STRUCTURED_FEDERAL_STATE_RE = re.compile(r"\b(?:federal_state|bundesland)=([a-z_]+)")

# Terms shorter than this never match (guards against noise words).
_MIN_TOPIC_LENGTH = 4

# The Normenhierarchie doctrine, injected into researcher/planner/writer prompts as
# {{ norm_doctrine }} — ONE copy, rendered by the prompt factories. Reasoning rules
# belong in the prompt; data (pointers, notes) belongs in the registry entries.
NORM_DOCTRINE = """## Norm hierarchy & document roles

**Order of authority ≠ order of retrieval.** Which source ANSWERS a question (federal law >
state law/ordinance > OIB guideline > guide/explanatory note) is not the same order in which sources are
RETRIEVED (knowledge base — project documents AND base knowledge — → RIS → web). The knowledge base comes
first, even when the question sounds like one about a guideline: its binding text is there, citable with
page. RIS comes when the knowledge base does not carry the level (law, ordinance, case law).

**Respect document roles:**
- Requirements („muss", „darf nicht", minimum values) come exclusively from NORMATIVE documents (law,
  ordinance, OIB guideline, norm declared binding).
- Guides (Leitfäden) describe the APPLICATION of a guideline — they establish no new requirements.
- Explanatory notes (Erläuterungen) provide RATIONALES and aids to interpretation — likewise no new requirements.
- Authority information (e.g. MA 37) shows authority practice — never cite it as a new norm.
- Legal commentaries are not available. When asked for them, say so openly — do not simulate knowledge of
  commentaries.

**Discipline on deviations:** An OIB guideline applies only in the edition the Bundesland has declared binding, and only
without deviations in state law. Check that as far as the sources allow — otherwise flag it expressly as
open. Cite the edition declared binding, never automatically the newest.

**Parcel questions: settle them at the plot first.** Zoning (Widmung), building class (Bauklasse), building
height, building lines (Fluchtlinien) and the like are answered by the plot's zoning plan and development
plan (Flächenwidmungs- und Bebauungsplan) — not by OIB or the building code in general. If the plan is not in
the knowledge base, say so openly (wien.gv.at/flaechenwidmung/public) instead of answering generically.
**Terms follow the level of the question.** The same term can be defined differently in OIB, state law and federal
law (example: „Gebäudehöhe"). Always name the definition level used.

**ÖNORM honesty:** ÖNORMs are reference norms without full text in the available sources. Name them only as a
reference (as far as known from other documents) and disclose that the full text is not available — never
reproduce ÖNORM content from memory.

**Existing buildings/transitional law:** If the project is not a new build (refurbishment, extension,
alteration), point out that grandfathering (Bestandsschutz) and transitional provisions may apply and that
this must be checked under building law."""
# The jurisdiction + project-hard-limits grounding, injected into every deep-research
# prompt as {{ jurisdiction_grounding }} — ONE copy, rendered by the prompt factories
# (same pattern as NORM_DOCTRINE). Keep the rendered prompts long and specific; only
# the authorship is deduplicated here so the four prompts cannot drift apart.
JURISDICTION_GROUNDING = """## Jurisdiction & Country Handling

The project context (injected at the bottom of this prompt) carries a `country=<cc>` line: an ISO-2 country
code (e.g. `at`, `de`, `ch`) or the sentinel `other` for any country without a dedicated pipeline. When the
line is absent the country is UNCONFIRMED: default to the Austrian pipeline but treat it as provisional (see
below), never as a confirmed `country=at`. For Austrian projects there is also a `federal_state=<token>` line
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
- The `federal_state=outside_austria` token means the project is outside Austria (functionally the same
  as `country != at`), even when no explicit non-AT country line is present.

## Project Hard Limits & Grounding

The project context includes confirmed facts (hard constraints), unknowns (gaps), and assumptions
(provisional). Use them as follows:

- **Confirmed facts** are binding — never contradict them. If research sources conflict with a confirmed
  fact, flag the conflict and explain.
- **Unknowns** are known gaps — if a critical fact for the answer (especially building-class relevant:
  escape_level_m, storeys, gfa, uses, federal_state) is flagged unknown, the answer must either ask for
  it or state the gap clearly.
- **Assumptions** are provisional estimates — treat as likely but note the uncertainty.
- Wizard facts that constrain building-regulation outputs: **escape_level_m** → Gebäudeklasse per OIB-RL 2;
  **storeys_above_ground / storeys_below_ground**; **max_building_height**; **gfa_above_ground**;
  **work_type** (new_build/extension/conversion/refurbishment/...); **uses** (residential/office/retail/...);
  **construction_method**; **elevator**; **conditioning**; **fireplaces**; **public_access**; **hazard_zones**;
  **fire_safety_systems**; **heat_supply**; **further_technology** (pv/ventilation/cooling/infiltration).
- Keys with `@bldgN` suffix apply to a specific building; keys with `@zone` suffix to a use zone.
- When the plan or synthesis concerns a building-regulation question, cross-check the projected output
  against the project's hard limits. If the research produces a requirement that contradicts a confirmed
  fact, note the contradiction in the output rather than blindly repeating both."""


class VerifySeed(BaseModel):
    """Live-verification seed for scripts/build_ris_catalog.py (and the admin verify API)."""

    title_query: str
    expect: str = ""
    exclude: list[str] = Field(default_factory=list)
    # A stored registry (the admin-edited row, a seed file not yet re-saved) calls it
    # `gesetzesnummer`; read for one release (remove after), the next save stores `statute_number`.
    statute_number: str = Field(default="", validation_alias=AliasChoices("statute_number", "gesetzesnummer"))


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
    rank: NormRank = "state_law"

    @field_validator("rank", mode="before")
    @classmethod
    def _legacy_rank(cls, value: object) -> object:
        return LEGACY_NORM_RANK.get(value, value) if isinstance(value, str) else value

    # canonical name ("Wien"); "" = federal/stateless. A registry stored before the English names
    # (the admin-edited row, a seed file not yet re-saved) calls it `bundesland`; read-only, the
    # next save stores `federal_state`.
    federal_state: str = Field(default="", validation_alias=AliasChoices("federal_state", "bundesland"))
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

    @field_validator("states", mode="before")
    @classmethod
    def _legacy_state_tokens(cls, value: object) -> object:
        """A stored registry keys ``states`` by the German token (``wien``); the English one replaces it."""
        if not isinstance(value, dict):
            return value
        return {normalize_profile_token("federal_state", str(token)): name for token, name in value.items()}

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
        if entry.rank in ("federal_law", "state_law", "ordinance") and not entry.is_ris:
            logger.warning(
                "norm_registry: law entry '%s' (rank %s) has no RIS pointer — entry dropped",
                entry.id,
                entry.rank,
            )
            continue
        if entry.federal_state and entry.federal_state not in BUNDESLAENDER:
            logger.warning(
                "norm_registry: entry '%s' has unknown Bundesland '%s' — entry dropped",
                entry.id,
                entry.federal_state,
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


def extract_federal_state(text: str | None) -> str | None:
    """The Bundesland the text points at, or None. Pure text matching.

    The structured `federal_state=<token>` fact line (written by the intake wizard
    into the project-context prompt view) is authoritative when present — name
    probing must not override it, or a mention like "Wiener Neustadt" (a Lower
    Austrian town) would flip the jurisdiction to Wien. Free text without the
    token falls back to probing for state names (spelling variants tolerated).
    """
    if not text:
        return None
    normalized = _normalize(text)
    structured = _STRUCTURED_FEDERAL_STATE_RE.search(normalized)
    if structured:
        return FEDERAL_STATE_TOKENS.get(normalize_profile_token("federal_state", structured.group(1)))
    for state in BUNDESLAENDER:
        if _normalize(state) in normalized:
            return state
    return None


def resolve_federal_state(text: str | None) -> str | None:
    """The Bundesland to focus/rank the catalog on, structured-first.

    Precedence (jurisdiction is a cross-cutting request fact and must travel
    STRUCTURED, not be re-parsed from prompt text):

    1. ``GridRequestContext.from_context().federal_state`` — the validated token
       carried on the signed ``X-Grid-Request-Context`` envelope. ``None``
       (``outside_austria``) is FINAL — no fall-through to probing.
    2. ``extract_federal_state(text)`` — the structured prompt-text line, then
       free-text state-name probing (no live request context).
    """
    from aiq_agent.project_context import GridRequestContext

    structured_token = GridRequestContext.from_context().federal_state
    if structured_token is not None:
        return FEDERAL_STATE_TOKENS.get(structured_token)
    return extract_federal_state(text)


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


def focus_entries(entries: list[NormEntry], federal_state: str | None) -> list[NormEntry]:
    """Restrict matches to the known Bundesland and put that state's law first.

    State-law entries of OTHER states are dropped — a Tyrolean project must
    never be handed the Viennese Bauordnung. Federal/stateless entries always
    stay. With no known Bundesland this is a no-op.
    """
    if not federal_state:
        return entries
    kept = [entry for entry in entries if not entry.federal_state or entry.federal_state == federal_state]
    return sorted(kept, key=lambda entry: 0 if entry.federal_state == federal_state else 1)


# ---------------------------------------------------------------------------
# Prompt rendering: doctrine lives in NORM_DOCTRINE; this block is the data —
# federal lane, the project's own state lane (other states are dropped), prose
# binding notes, and a static pointer at the OIB corpus in the knowledge base.
# ---------------------------------------------------------------------------

_BLOCK_HEADER = (
    "Curated norm catalogue (verified RIS references).\n"
    "The RIS tools know this catalogue and resolve a reference themselves; an entry here\n"
    "is an address that can be named in the call, not a source location."
)

OIB_CORPUS_NOTE = (
    "OIB corpus (already in the knowledge base, no RIS query needed): OIB guidelines 1–6\n"
    "with guides, explanatory notes, definitions and cited norms, edition May 2023.\n"
    'Cite as "OIB-RL <N>, Pkt <x>, Ausgabe Mai 2023". Requirements only from the guideline\n'
    "itself — guide/explanatory note are aids to interpretation."
)


_LAW_RANKS = ("federal_law", "state_law", "ordinance")


def _render_entry_line(entry: NormEntry) -> str:
    if entry.is_ris:
        line = f"- {entry.short} — {entry.title} [{entry.application}/{entry.document_number}]"
    else:
        line = f"- {entry.short} — {entry.title}"
    if entry.federal_state:
        line += f" ({entry.federal_state})"
    # Render BOTH URLs when both are set (e.g. a consolidated law plus a curated
    # annex link) — an `elif` here silently dropped a populated ``source_url``
    # whenever ``full_law_url`` was also present.
    if entry.full_law_url:
        line += f" Full text: {entry.full_law_url}"
    if entry.source_url:
        line += f" Source: {entry.source_url}"
    if not entry.full_law_url and not entry.source_url and not entry.is_ris:
        line += " (no full text available — reference only)"
    return line


def render_prompt_block(
    registry: NormRegistry, federal_state: str | None = None, corpus_note: str | None = None
) -> str:
    """Compact catalog block: federal lane, then the focused state lane.

    Other states' law is dropped entirely (same rule as ``focus_entries``) —
    with no known Bundesland, all state lanes render, grouped by state.
    """
    lines = [_BLOCK_HEADER, ""]
    focused = focus_entries(registry.entries, federal_state)
    law = [entry for entry in focused if entry.rank in _LAW_RANKS]
    federal = [entry for entry in law if not entry.federal_state]
    if federal:
        lines.append("Federal law (Bundesrecht):")
        lines.extend(_render_entry_line(entry) for entry in sorted(federal, key=lambda e: e.short.lower()))
    by_state: dict[str, list[NormEntry]] = {}
    for entry in law:
        if entry.federal_state:
            by_state.setdefault(entry.federal_state, []).append(entry)
    for state in sorted(by_state, key=lambda s: (s != federal_state, s)):
        lines.append("")
        lines.append(f"State law (Landesrecht) — {state}:")
        lines.extend(_render_entry_line(entry) for entry in sorted(by_state[state], key=lambda e: e.short.lower()))
    behoerdlich = [entry for entry in focused if entry.rank == "authority_info"]
    if behoerdlich:
        lines.append("")
        lines.append("Authority information (practice notes — supplements only, never new norms):")
        lines.extend(_render_entry_line(entry) for entry in sorted(behoerdlich, key=lambda e: e.short.lower()))
    extern = [entry for entry in focused if entry.rank == "external_standard"]
    if extern:
        lines.append("")
        lines.append("External standards (referenced standards — full text usually unavailable, say so plainly):")
        lines.extend(_render_entry_line(entry) for entry in sorted(extern, key=lambda e: e.short.lower()))
    notes = [entry for entry in focused if entry.binding_note]
    if notes:
        lines.append("")
        lines.append("Legal notes (curated):")
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
    block = render_prompt_block(registry, federal_state=resolve_federal_state(project_context), corpus_note=corpus_note)
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

    The note is the FILE LIST and nothing else. What to do with a parcel
    question is standing doctrine and lives in the system prompt
    (``prompts/piloti_static.md``, ``<building_law>``), so the per-turn
    block carries only what varies: which documents this project has.
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
    lines = [
        "## Parcel sources of this project (authoritative for zoning, building class, building height, building lines)"
    ]
    for tag in parcel_tags:
        if tag in by_tag:
            files = ", ".join(sorted(by_tag[tag]))
            lines.append(f"- {tag}: {files}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Lane classification for research-source events (fan-out UI). Deterministic
# tagging: the hierarchy stays in the registry/filenames, the UI gets labels.
# ---------------------------------------------------------------------------

# data/oib filename prefixes -> OIB document class.
_OIB_CLASS_PREFIXES: tuple[tuple[str, str], ...] = (
    ("aenderungen_", "amendment"),
    ("erlaeuterungen_", "explanatory_note"),
    ("oib-rl_begriffsbestimmungen", "definitions"),
    ("oib-rl_zitierte_normen", "referenced_standards"),
)

_RANK_LANES: dict[str, tuple[str, str]] = {
    "federal_law": ("building_law_federal", "Bundesrecht"),
    "state_law": ("building_law_state", "Landesrecht"),
    "ordinance": ("building_law_ordinance", "Verordnung"),
    "authority_info": ("authority", "Behördliche Information"),
    "external_standard": ("external_standard", "Externe Norm"),
}

_OIB_CLASS_LANES: dict[str, tuple[str, str]] = {
    "guideline": ("building_law_oib", "OIB-Richtlinie"),
    "guide": ("building_law_oib_guide", "OIB-Leitfaden"),
    "explanatory_note": ("building_law_oib_explanatory_note", "OIB-Erläuterung"),
    "definitions": ("building_law_oib_definitions", "OIB-Begriffsbestimmungen"),
    "referenced_standards": ("building_law_oib_reference", "OIB-Referenzdokument"),
    "amendment": ("building_law_oib_amendment", "OIB-Änderungsdokument"),
}

# Label for a lane key, aggregated from the OIB-class + rank tables plus the
# lanes only reachable through an explicit doc_class: ``building_law_ris`` (a
# generic RIS legal source) and ``building_law_base`` (the NEW neutral base lane,
# coarse kind ``building_law`` via the prefix in ``source_kinds._LANE_KIND_PREFIXES``).
_LANE_LABELS: dict[str, str] = {
    **{key: label for key, label in _OIB_CLASS_LANES.values()},
    **{key: label for key, label in _RANK_LANES.values()},
    "building_law_ris": "Rechtsquelle (RIS)",
    "building_law_base": "Basisdokument",
    # Reachable only through stated PROVENANCE (``authored_by: agent``), never
    # through a doc_class — see :data:`~aiq_agent.common.source_kinds.AGENT_AUTHORED_LANE`.
    AGENT_AUTHORED_LANE: AGENT_AUTHORED_LANE_LABEL,
    # Reachable only through the chunk's ``source_format`` (a filed mail thread).
    MAIL_LANE: MAIL_LANE_LABEL,
    OFFICE_MAIL_LANE: MAIL_LANE_LABEL,
}


# The OIB does not publish its corpus under one spelling. Most 2023 files are
# ``oib-rl_<n>_…``, ``erlaeuterungen_oib-rl_<n>_…`` and
# ``aenderungen_oib-rl_<n>_…``, but OIB-RL 2.2 ships as
# ``oib-richtlinie_2.2_…``, ``erlaeuterungen-zu-oib-richtlinie_2.2_…`` and
# ``aenderungen_oib-richtlinie_2.2_…`` (oib.or.at, Ausgabe Mai 2023). Every
# filename reader below parses the canonical form this rewrites to, so a
# spelling variant is one alternation here rather than a branch in each reader.
# Anchored at the start and bound to the ``oib-`` stem, so only a name that
# already says it is an OIB-Richtlinie is rewritten.
_OIB_PUBLISHED_STEM_RE = re.compile(r"^(?:(erlaeuterungen|aenderungen)(?:_|-zu-))?oib-(?:rl|richtlinie)_")


def canonical_oib_file_name(file_name: str) -> str:
    """Lower-cased ``file_name`` with a published OIB spelling rewritten to ``oib-rl_``.

    ``oib-richtlinie_2.2_ausgabe_mai_2023.pdf`` -> ``oib-rl_2.2_ausgabe_mai_2023.pdf``;
    ``erlaeuterungen-zu-oib-richtlinie_2.2_…`` -> ``erlaeuterungen_oib-rl_2.2_…``.
    Any other name comes back lower-cased and otherwise unchanged.
    """
    low = file_name.lower()
    match = _OIB_PUBLISHED_STEM_RE.match(low)
    if not match:
        return low
    role = f"{match.group(1)}_" if match.group(1) else ""
    return f"{role}oib-rl_{low[match.end() :]}"


def oib_doc_class(file_name: str) -> str | None:
    """OIB document class derived from the corpus filename convention, or None."""
    name = canonical_oib_file_name(file_name)
    if not (name.startswith("oib-rl_") or name.startswith("aenderungen_") or name.startswith("erlaeuterungen_")):
        return None
    for prefix, doc_class in _OIB_CLASS_PREFIXES:
        if name.startswith(prefix):
            return doc_class
    if "leitfaden" in name:
        return "guide"
    return "guideline"


# Maps the coarse ``oib_doc_class`` filename guess to the explicit doc_class
# vocabulary key (``document_classification.DOCUMENT_CLASSES``).
_OIB_CLASS_TO_DOC_CLASS: dict[str, str] = {
    "guideline": "oib_guideline",
    "guide": "oib_guide",
    "explanatory_note": "oib_explanatory_note",
    "definitions": "oib_definitions",
    "referenced_standards": "oib_reference",
    "amendment": "oib_amendment",
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
        oib-richtlinie_2.2_...pdf            -> "OIB-Richtlinie 2.2, Ausgabe Mai 2023"
        erlaeuterungen-zu-oib-richtlinie_2.2_...pdf -> "Erläuterungen zu OIB-Richtlinie 2.2, Ausgabe Mai 2023"
    """
    if not file_name:
        return None
    stem = Path(Path(file_name).name).stem
    # Normalise the one known separator inconsistency (`6-leitfaden` vs
    # `2_leitfaden`) so the rest of the parse is uniform.
    low = canonical_oib_file_name(stem).replace("-leitfaden", "_leitfaden")

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

    is_guide = "leitfaden" in low
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

    if is_guide:
        subject += " – Leitfaden"

    title = f"{role_prefix}{subject}"
    tail = ", ".join(part for part in (edition, revision) if part)
    return f"{title}, {tail}" if tail else title


# ---------------------------------------------------------------------------
# Families: which Richtlinien belong together, derived from what is INDEXED.
#
# "OIB-Richtlinien 1–6" is a range, and a range names no members. OIB-RL 2 is
# four separate documents — 2, 2.1 (Betriebsbauten), 2.2 (Garagen), 2.3
# (Hochhäuser) — and the prompt never said so, so an overview question ("Was
# weißt du über die OIB 2?") could open three of them, forget the fourth, and
# read as complete. Nothing structural noticed, because nothing knew the family
# had four members.
#
# Membership is DERIVED, never listed: a deployment whose corpus holds no 2.3
# must not be told it has one, and a corpus that grows a 2.4 must not need this
# file edited. The only input is the set of indexed filenames.
# ---------------------------------------------------------------------------

#: The Richtlinie number inside an OIB corpus filename, after the `oib-rl_`
#: prefix (a published `oib-richtlinie_` spelling is canonicalised first):
#: `2`, `2.1`, `6`. Anchored, so an edition or a revision that follows cannot
#: be read as part of the number.
_OIB_FAMILY_NUMBER_RE = re.compile(r"^(\d+(?:\.\d+)?)(?:[_-]|$)")


@dataclass(frozen=True)
class NormFamily:
    """One Richtlinie and every part of it the corpus actually holds.

    ``key`` is the family number (``"2"``), ``members`` the part numbers in
    numeric order (``("2", "2.1", "2.2", "2.3")``) and ``files`` the indexed
    filename of each, parallel to ``members``. A family with one member is
    still a family — that is what "OIB-RL 3 has no parts" looks like, and it is
    a different statement from "we do not know".
    """

    key: str
    members: tuple[str, ...]
    files: tuple[str, ...]

    @property
    def label(self) -> str:
        return f"OIB-Richtlinie {self.key}"


def oib_family_member(file_name: str) -> str | None:
    """The Richtlinie part number a corpus filename IS, or ``None``.

    Only the Richtlinie itself. A Leitfaden, an Erläuterung, an Änderungs-
    dokument, the Begriffsbestimmungen and the Zitierte Normen are not members:
    they are read WITH a Richtlinie, and counting them as parts of it would
    make an overview answer look complete for having opened a reading aid.
    """
    name = canonical_oib_file_name(Path(file_name or "").name)
    if oib_doc_class(name) != "guideline":
        return None
    match = _OIB_FAMILY_NUMBER_RE.match(name[len("oib-rl_") :])
    return match.group(1) if match else None


def _member_sort_key(member: str) -> tuple[int, ...]:
    return tuple(int(part) for part in member.split("."))


def oib_families(file_names: Iterable[str]) -> list[NormFamily]:
    """Group indexed corpus filenames into families, in numeric order.

    Duplicates collapse on the part number, so a corpus carrying two editions of
    OIB-RL 2 still reports one member `2` — the family is about which
    requirements exist, not about how many files carry them.
    """
    by_family: dict[str, dict[str, str]] = {}
    for file_name in file_names:
        member = oib_family_member(file_name)
        if member is None:
            continue
        by_family.setdefault(member.split(".")[0], {}).setdefault(member, Path(file_name).name)
    families: list[NormFamily] = []
    for key in sorted(by_family, key=lambda k: int(k) if k.isdigit() else 0):
        members = sorted(by_family[key], key=_member_sort_key)
        families.append(NormFamily(key=key, members=tuple(members), files=tuple(by_family[key][m] for m in members)))
    return families


# ---------------------------------------------------------------------------
# Family-shaped queries: a question that names a Richtlinie and nothing else.
#
# "Was weißt du über die OIB 2?" asks for the family, not for a passage inside
# it. Semantic search answers it with whatever two documents ranked highest,
# and the model then opens the rest one at a time. Detected here, the retrieval
# layer can answer it with every member the corpus holds in ONE round.
#
# Detection is pure and lives beside :func:`oib_families`, which turns the
# number this returns into the members. It reads the anchor vocabulary the
# requery gate reads (``knowledge_layer.requery._NARROW_ANCHOR_PATTERNS``) and
# adds the bare ``OIB 2`` spelling, which is how the question is usually asked.
# ---------------------------------------------------------------------------

#: An OIB Richtlinie named by number, however a question spells it: ``OIB 2``,
#: ``OIB-RL 2``, ``OIB-Richtlinie 2.1``, ``Richtlinie 2``, ``RL 4``. The number
#: is captured; :func:`family_query_number` reduces ``2.1`` to its family.
_FAMILY_ANCHOR_RE = re.compile(
    r"\b(?:oib[-\s]*(?:rl|richtlinie)?|rl|richtlinie)[-\s]*(\d+(?:\.\d+)?)\b",
    re.IGNORECASE,
)

#: A second family key joined to an anchor without repeating it: the ``und 4``
#: in "OIB 2 und 4", the ``, 4`` in "OIB 2, 4". One or two digits (or a part
#: number), so a printing year ("OIB 2 2023", "OIB 2, 2023") is never read as a
#: key. A full stop after the key ends the sentence, not the number: only a
#: digit after it continues one. Matched right after an anchor, never on its own.
_FAMILY_JOINED_KEY_RE = re.compile(
    r"\s*(?:,|/|&|\bund\b|\boder\b|\bbzw\.?)\s*(\d{1,2}(?:\.\d+)?)(?!\d|\.\d)",
    re.IGNORECASE,
)

#: What makes a query a LOCATOR rather than a question about the whole
#: Richtlinie. A Punkt, a paragraph, a page or a table is addressed inside one
#: document, and a file name names one file: each is already answered better by
#: the ordinary path, and none of them wants four documents back.
_FAMILY_BLOCKER_RE = re.compile(
    "|".join(
        (
            r"\bpkt\.?\s*\d",
            r"\bpunkt\w*\s*\d",
            r"§",
            r"\babs\.?\s*\d",
            r"\bseite\s*\d",
            r"\bpage\s*\d",
            r"\btabelle",
            r"\banhang",
            r"\.pdf\b",
            r"oib-rl_",
            r"oib-richtlinie_",
        )
    ),
    re.IGNORECASE,
)

#: Every word a family-shaped question may hold BESIDES its anchor: question
#: words, articles, pronouns, the verbs that ask what a document is for, the
#: overview nouns, and the edition words that name a printing rather than a
#: topic. A token outside this set is a TOPIC, and a topic question is an
#: ordinary search. "OIB 2 Fluchtweglänge GK 4" must come back as passages.
#:
#: Casefolded spellings: ``str.casefold`` writes "weißt" as "weisst", so that is
#: the form listed here.
_FAMILY_QUERY_STOPWORDS = frozenset(
    """
    was wer wie wo welche welcher welches welchem welchen warum wieso weshalb worum wofuer wofür
    wozu ob der die das den dem des ein eine einer eines einem einen und oder aber in im zu zum
    zur von vom ueber über um an am auf aus bei fuer für mit nach es ich du mir mich dir dich sie
    man sich bitte mal denn noch schon alles etwas mehr kurz genau eigentlich ueberhaupt überhaupt
    gibt gibts gib ist sind war waren hat haben habe hast kannst kann koennen können sagen sagst
    sag sage erzaehl erzähl erzaehle erzähle zeig zeige zeigen weisst weiss wissen kennst kennen
    lies lesen geht gehts handelt steht regelt regeln behandelt enthaelt enthält umfasst
    beinhaltet beschreibt bedeutet sagt drin darin dazu davon nenn nenne liste fasse fass zusammen
    erklaer erklär erklaere erkläre brauche moechte möchte will
    ueberblick überblick uebersicht übersicht inhalt inhalte inhalts gliederung aufbau struktur
    thema themen punkte kapitel teil teile teilen zusammenfassung zusammenfassen allgemein
    allgemeine allgemeines
    ausgabe ausgaben edition fassung version aktuell aktuelle aktueller aktuellen gueltige gültige
    geltende stand rev revision
    jaenner jänner januar februar maerz märz april mai juni juli august september oktober november
    dezember
    oib rl richtlinie richtlinien
    what do you know about the tell me is of on a an and give show summarize summarise please it
    its overview summary contents scope
    """.split()
)

#: A word or a number, with punctuation and separators dropped.
_FAMILY_TOKEN_RE = re.compile(r"[^\W\d_]+|\d+(?:[.,]\d+)?")


def _is_topic_free(text: str) -> bool:
    """True when nothing in ``text`` names a topic.

    Digits pass: what is left of "OIB 2 Ausgabe Mai 2023" once the anchor and
    the edition words are gone is a year, and a year is a printing.
    """
    return all(
        token.isdigit() or token in _FAMILY_QUERY_STOPWORDS for token in _FAMILY_TOKEN_RE.findall(text.casefold())
    )


def _joined_keys(text: str, start: int) -> list[re.Match[str]]:
    """The further keys chained onto the anchor ending at ``start``, in order.

    "OIB 2 und 4" names two families as surely as "OIB 2 und OIB 4"; without
    this the bare ``4`` falls into the leftover, where a number passes as a
    printing and the query came back as family 2 alone.
    """
    found: list[re.Match[str]] = []
    while (joined := _FAMILY_JOINED_KEY_RE.match(text, start)) is not None:
        found.append(joined)
        start = joined.end()
    return found


def family_query_number(query: str) -> str | None:
    """The Richtlinien-family a query asks about AS A WHOLE, or ``None``.

    ``"was weißt du über die OIB 2"`` and ``"OIB-Richtlinie 2.1"`` both answer
    ``"2"``: the family key, which :func:`oib_families` turns into the members
    the corpus holds. A part number resolves to its family on purpose: a
    reader who asks about 2.1 is asking inside a Richtlinie whose other parts
    they are unlikely to know exist.

    ``None`` for everything else, and that is the common answer. A query that
    still names a topic once the anchor is removed is an ordinary search; so is
    one that addresses a Punkt, a paragraph, a page, a table or a file; and so
    is one naming two families, because a single overview cannot be both,
    including when the second key is chained on without its anchor ("OIB 2
    und 4", "OIB 2, 4").
    """
    text = (query or "").strip()
    if not text or _FAMILY_BLOCKER_RE.search(text):
        return None
    keys: set[str] = set()
    rest: list[str] = []
    cursor = 0
    for match in _FAMILY_ANCHOR_RE.finditer(text):
        keys.add(match.group(1).split(".")[0])
        rest.append(text[cursor : match.start()])
        cursor = match.end()
        for joined in _joined_keys(text, cursor):
            keys.add(joined.group(1).split(".")[0])
            cursor = joined.end()
    rest.append(text[cursor:])
    if len(keys) != 1 or not _is_topic_free(" ".join(rest)):
        return None
    return keys.pop()


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
    authored_by: str | None = None,
    source_format: str | None = None,
) -> tuple[str, str]:
    """(stratum_key, human label) for a retrieval/citation hit — display tagging only.

    Strata match the product's data placement: Baurecht (authority: registry law +
    OIB corpus), Projektwissen (project/session collections), Büroablage (org
    office shelf), Web. Unknown inputs land in ("web", "Web") fail-open.

    An explicit, human-set ``doc_class`` (the "Dokumentart") is FIRST priority:
    when valid it fully determines the lane, overriding every collection/filename/
    url heuristic below. This is the authoritative signal the filename guess only
    approximates. The one exception is the DEFAULT class on a user's own shelf:
    ``other`` is what ingestion stamps on a file nobody classified, and on a
    project, session or Büroablage document it says nothing a person decided —
    it must not turn the user's plan into a "Basisdokument" in law blue.

    ``shelf`` is the shelf the caller knows the hit came from; without it the
    collection id is read the legacy way (ADR-0047).

    ``authored_by`` is the stated PROVENANCE of the document
    (``common/provenance.py``), and it outranks everything else here — the
    doc_class included. A published Piloti document is filed on the project or
    the Archiv shelf like any other document, so every rule below would place
    it as Projektwissen or Büroablage and lose the one fact a reader must not
    miss; and a doc_class stamped on it by ingest would place it in the norm
    hierarchy, in law blue, under the ``"Baurecht"`` label fallback. Who wrote
    a document is not a guess any of those signals can overturn.

    ``source_format`` comes next: ``mail`` is a filed E-Mail-Verlauf
    (:data:`~aiq_agent.common.source_kinds.MAIL_SOURCE_FORMAT`), and it
    outranks the doc_class and every URL rule for the same reason. A mail from
    ``ma37.wien.gv.at`` is a clerk's message, never the curated authority lane,
    and a doc_class a person set on the thread names what the thread is about,
    not who wrote each section. The kind stays the shelf's
    (``project_mail`` is Projektwissen, ``office_mail`` Büroablage).
    """
    from aiq_agent.common.provenance import is_agent_author
    from aiq_agent.common.source_kinds import Shelf
    from aiq_agent.common.source_kinds import legacy_shelf_for_collection_name
    from aiq_agent.common.source_kinds import parse_shelf

    if is_agent_author(authored_by):
        return (AGENT_AUTHORED_LANE, AGENT_AUTHORED_LANE_LABEL)
    known_shelf = parse_shelf(shelf) or legacy_shelf_for_collection_name(collection)
    if source_format == MAIL_SOURCE_FORMAT:
        return (OFFICE_MAIL_LANE if known_shelf is Shelf.OFFICE_SHELF else MAIL_LANE, MAIL_LANE_LABEL)
    users_shelf = known_shelf in (Shelf.OFFICE_SHELF, Shelf.PROJECT, Shelf.SESSION)
    if doc_class:
        from aiq_agent.knowledge.document_classification import DEFAULT_DOC_CLASS
        from aiq_agent.knowledge.document_classification import DOCUMENT_CLASS_LANES
        from aiq_agent.knowledge.document_classification import canonical_doc_class

        # A hit from a point written before the English keys still carries the German one.
        doc_class = canonical_doc_class(doc_class)
        if doc_class and not (doc_class == DEFAULT_DOC_CLASS and users_shelf):
            lane_key = DOCUMENT_CLASS_LANES[doc_class]
            return (lane_key, _LANE_LABELS.get(lane_key, "Baurecht"))
    if known_shelf is Shelf.OFFICE_SHELF:
        return ("office", "Büroablage")
    if known_shelf is Shelf.PROJECT:
        return ("project", "Projektwissen")
    if known_shelf is Shelf.SESSION:
        return ("project", "Private Sitzung")
    if file_name:
        doc_class = oib_doc_class(Path(file_name).name)
        if doc_class:
            return _OIB_CLASS_LANES[doc_class]
    if _host_matches(source_url, "ris.bka.gv.at"):
        if registry:
            for entry in registry.entries:
                if entry.document_number and entry.document_number in source_url:
                    return _RANK_LANES[entry.rank]
        return ("building_law_ris", "Rechtsquelle (RIS)")
    # wien.gv.at is the curated MA-37 (Baupolizei Wien) registry pointer —
    # official municipal building information, Baurecht family, never Web.
    # The frontend renders the lane and label it is sent; only the kind is
    # derived there (`kindForLane` in source-kinds.ts mirrors `kind_for_lane`).
    if _host_matches(source_url, "wien.gv.at"):
        return ("authority", "Behördliche Information")
    if collection:  # a named KB collection that is not project/office_shelf: the base corpus
        return ("building_law_oib", "OIB-Richtlinie")
    return ("web", "Web")


def lane_for_knowledge_hit(
    *,
    doc_class: str | None = None,
    file_name: str | None = None,
    source_url: str | None = None,
    collection: str | None = None,
    registry: NormRegistry | None = None,
    shelf: object = None,
    authored_by: str | None = None,
    source_format: str | None = None,
) -> tuple[str, str]:
    """:func:`lane_for_hit` for a hit that came from the KNOWLEDGE LAYER.

    Identical, except that such a hit can never be Web. A retrieved document is
    by definition something we hold — a project upload, the Büroablage, the base
    corpus — so ``("web", "Web")`` is not a classification, it is the fail-open
    value meaning "none of the signals matched" (no doc_class, no recognizable
    collection prefix, no OIB filename). Those land in Projektwissen.

    This exists so the two consumers of the rule cannot drift: the citation
    chips (``citation_verification.source_lane``) and the Herleitung fan-out
    (``knowledge_layer.register._trace_lanes_for_hits``) used to apply it
    separately, and only the former actually did — so the same document showed
    as "Projektwissen" on a chip and "Web" in the fan-out of the same answer.
    """
    lane = lane_for_hit(
        doc_class=doc_class,
        file_name=file_name,
        source_url=source_url,
        collection=collection,
        registry=registry,
        shelf=shelf,
        authored_by=authored_by,
        source_format=source_format,
    )
    return ("project", "Projektwissen") if lane == ("web", "Web") else lane

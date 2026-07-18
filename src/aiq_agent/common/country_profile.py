"""CountryProfile: the binding contract a supported country implements. Austria is #1.

Design rule (learned the hard way — see ADR-0025 Context): **every field on this
contract has a named consumer that exists today.** Adding a field without wiring
its consumer in the same change is forbidden; that is how the previous country
abstraction became dead code.

The contract is DATA-FIRST: everything that is vocabulary, prose, or pointers
lives in the per-country registry file (``configs/norms/<cc>/registry.yml``,
admin-editable through the platform norms surface) and merely *defaults* from
the code constants below. Only two things are code: the applicability resolver
and the corpus filename classifier — behavior that genuinely differs per legal
system. The country's legal-database access (RIS for Austria) is deliberately
NOT part of this contract: it is a source adapter (``sources/ris_adapter``)
registered through the normal NAT tool mechanism; the profile only *names* the
tools so prompts and docs can reference them.

Adding a country therefore means:
1. ``configs/norms/<cc>/registry.yml`` — catalog entries + states/doctrine/
   corpus_note/parcel_tags/language overrides (data, admin-editable),
2. a corpus collection with that country's norm texts (platform upload),
3. a source adapter for its legal database (the one real code artifact),
4. registering a ``CountryProfile`` instance below with its two code hooks.

Consumers (kept current — update when re-pointing):
- ``states``/``state_probe_order`` → ``norm_registry.extract_bundesland``/``resolve_bundesland``
- ``doctrine`` → ``{{ norm_doctrine }}`` in researcher/planner/writer prompts
- ``corpus_collection`` → retrieval base-collection routing + admin store passthrough
- ``corpus_note`` → ``norm_registry.render_prompt_block`` corpus section
- ``parcel_tags`` → ``norm_registry.parcel_note`` (per-parcel source-of-truth signal)
- ``legal_source_tools`` → tool-name references in rendered prompt blocks/docs
- ``applicability`` → ``applicability.render_project_block`` + compliance Stage-1 scoping
- ``corpus_doc_class`` → ``norm_registry.lane_for_hit`` display tagging
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_COUNTRY = "at"


@dataclass(frozen=True)
class CountryProfile:
    """Everything that varies per country, with data-first defaults."""

    country: str
    language: str
    states: dict[str, str | None]  # intake token -> canonical name (None = "outside" sentinel)
    state_probe_order: tuple[str, ...]  # canonical names, free-text probing order
    corpus_collection: str  # RAG base collection holding this country's norm texts
    corpus_note: str  # prompt paragraph describing the corpus + citation format
    doctrine: str  # Normenhierarchie doctrine text ({{ norm_doctrine }})
    parcel_tags: tuple[str, ...]  # document tags naming the per-parcel source of truth
    legal_source_tools: tuple[str, ...]  # tool names of the country's legal-DB adapter
    applicability: Callable[[dict], list[Any]] | None = None  # facts -> verdicts
    corpus_doc_class: Callable[[str], str | None] | None = None  # corpus filename -> doc class

    def with_overrides(self, **overrides: Any) -> CountryProfile:
        """Profile with non-empty registry-file overrides applied (data wins over code)."""
        cleaned = {k: v for k, v in overrides.items() if v}
        if not cleaned:
            return self
        from dataclasses import replace

        return replace(self, **cleaned)


_PROFILES: dict[str, CountryProfile] = {}


def register_country_profile(profile: CountryProfile) -> None:
    _PROFILES[profile.country] = profile


def get_country_profile(country: str | None = None) -> CountryProfile | None:
    """The profile for a country code, with registry-file overrides applied.

    Data overrides (states/doctrine/corpus_note/parcel_tags/language/
    corpus_collection) come from the country's registry file so admins can
    evolve them without a deploy; the code hooks always come from the
    registered instance. Unknown country → None (callers fail open to the
    default profile or skip the feature).
    """
    code = (country or DEFAULT_COUNTRY).lower()
    base = _PROFILES.get(code)
    if base is None:
        return None
    try:
        from aiq_agent.common import norm_registry

        norms_file = norm_registry.load_norms_file(code)
    except Exception:  # noqa: BLE001 — profile lookup must never break the hot path
        logger.warning("country_profile: registry overrides unavailable for '%s'", code, exc_info=True)
        norms_file = None
    if norms_file is None:
        return base
    return base.with_overrides(
        language=norms_file.language,
        states=dict(norms_file.states) if norms_file.states else None,
        corpus_collection=norms_file.corpus_collection,
        corpus_note=norms_file.corpus_note,
        doctrine=norms_file.doctrine,
        parcel_tags=tuple(norms_file.parcel_tags) if norms_file.parcel_tags else None,
    )


def _register_austria() -> None:
    """Austria: implementation #1 of the contract. Defaults live in norm_registry."""
    from aiq_agent.common import applicability as at_applicability
    from aiq_agent.common import norm_registry as nr

    register_country_profile(
        CountryProfile(
            country="at",
            language="de-AT",
            states=dict(nr.BUNDESLAND_TOKENS),
            state_probe_order=tuple(nr.BUNDESLAENDER),
            corpus_collection="oib_knowledge",
            corpus_note=nr.OIB_CORPUS_NOTE,
            doctrine=nr.NORM_DOCTRINE,
            parcel_tags=("Bebauungsplan", "Flächenwidmungsplan"),
            legal_source_tools=("ris_search", "ris_fetch_document", "ris_catalog_lookup"),
            applicability=at_applicability.resolve_oib_applicability,
            corpus_doc_class=nr.oib_doc_class,
        )
    )


_register_austria()

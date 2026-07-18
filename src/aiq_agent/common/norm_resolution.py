"""Resolve free-text norm citations against the norm registry (norm-registry Phase 5).

The LLM authors NormReference.document/edition as free text; this module is the
deterministic resolver that stamps the trust-chain fields (norm_id/rank/
binding/via) afterwards. Unresolvable references stay free text.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from aiq_agent.common.norm_registry import NormEntry
from aiq_agent.common.norm_registry import NormRegistry

_BINDING_ROLES = {"normativ", "anwendend", "erklaerend"}

_UMLAUTS = str.maketrans({"ä": "a", "ö": "o", "ü": "u", "Ä": "a", "Ö": "o", "Ü": "u", "ß": "ss"})


def _normalize(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text.strip().lower().translate(_UMLAUTS))
    return re.sub(r"\s+", " ", folded)


@dataclass(frozen=True)
class ResolvedNorm:
    norm_id: str
    rank: str
    binding: str | None
    via: str | None


def _document_candidates(entry: NormEntry) -> list[str]:
    candidates = [entry.id, entry.short, entry.title, *entry.aliases]
    return [_normalize(c) for c in candidates if c]


def _match_entry(document: str, registry: NormRegistry) -> NormEntry | None:
    needle = _normalize(document)
    if not needle:
        return None
    scored: list[tuple[int, int, NormEntry]] = []
    for entry in registry.entries:
        for candidate in _document_candidates(entry):
            if candidate == needle:
                scored.append((2, len(candidate), entry))
                break
            if needle in candidate or candidate in needle:
                scored.append((1, len(candidate), entry))
                break
    if not scored:
        return None
    # Exact match beats containment; longer candidate strings are more specific
    # ("oib-rl 2 leitfaden" wins over "oib-rl 2").
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return scored[0][2]


def _match_edition(entry: NormEntry, edition: str | None):
    if not entry.editions:
        return None
    if edition:
        needle = _normalize(edition)
        for ed in entry.editions:
            if _normalize(ed.id) == needle or _normalize(ed.label) == needle:
                return ed
        for ed in entry.editions:
            if needle and (needle in _normalize(ed.label) or _normalize(ed.label) in needle):
                return ed
        return None
    current = [ed for ed in entry.editions if ed.status == "current" and ed.role != "diff"]
    return current[0] if current else entry.editions[0]


def _binding_for(entry: NormEntry, edition) -> str | None:
    role = (edition.role if edition and edition.role else entry.role) or None
    return role if role in _BINDING_ROLES else None


def _via_for(entry: NormEntry, registry: NormRegistry, bundesland: str | None) -> str | None:
    sources = [
        candidate
        for candidate in registry.entries
        if any(
            rel.type == "declares_binding" and rel.target == entry.id and rel.status == "verified"
            for rel in candidate.relations
        )
    ]
    if not sources:
        return None
    if bundesland:
        for candidate in sources:
            if candidate.jurisdiction.state == bundesland:
                return candidate.short
    return sources[0].short


def resolve_norm_reference(
    document: str,
    edition: str | None,
    registry: NormRegistry,
    bundesland: str | None = None,
) -> ResolvedNorm | None:
    """Resolve a free-text (document, edition) citation to registry trust-chain data."""
    entry = _match_entry(document, registry)
    if entry is None:
        return None
    matched_edition = _match_edition(entry, edition)
    if edition and matched_edition is None:
        return None
    return ResolvedNorm(
        norm_id=entry.id,
        rank=entry.rank,
        binding=_binding_for(entry, matched_edition),
        via=_via_for(entry, registry, bundesland),
    )

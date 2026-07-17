"""Austria (`at`) country pack: Bundesland vocabulary, doctrine, OIB id convention.

The vocabulary and resolution logic moved here from ``norm_registry`` (which
keeps thin backward-compat delegates). The OIB-family id convention
(``oib-rl-<N>-<suffix>`` requires base entry ``oib-rl-<N>``) is AT-specific and
lives here as the pack's ``validate_ids`` implementation.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from aiq_agent.common.country_packs.base import StructuredTokenStateResolution

if TYPE_CHECKING:
    from aiq_agent.common.norm_registry import NormEntry

# Canonical Bundesland names, in the order extract_state probes them.
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

# OIB-family id convention: `oib-rl-<N>-<suffix>` requires base entry `oib-rl-<N>`.
_OIB_FAMILY_RE = re.compile(r"^(oib-rl-\d+(?:\.\d+)?)-\S+$")


class AustriaPack(StructuredTokenStateResolution):
    """CountryPack for Austria."""

    country = "at"

    def __init__(self) -> None:
        super().__init__(BUNDESLAND_TOKENS, BUNDESLAENDER)

    def doctrine_lines(self) -> list[str]:
        return [
            "Curated norm registry (verified entries — legal rank and role are annotated).",
            "For RIS-sourced norms do NOT use RIS search: fetch the document directly via the RIS fetch",
            "tool using the document number or the 'Gesamt' URL. OIB corpus entries are already in the",
            'knowledge base — cite them as "OIB-RL <N>, Pkt <x>, <edition label>".',
        ]

    def validate_ids(self, entries: list[NormEntry]) -> list[str]:
        """OIB-family ids (`oib-rl-<N>-<suffix>`) require a base entry `oib-rl-<N>`."""
        ids = {entry.id for entry in entries}
        problems = []
        for entry in entries:
            match = _OIB_FAMILY_RE.match(entry.id)
            if match and match.group(1) not in ids:
                problems.append(f"entry '{entry.id}' has no base entry '{match.group(1)}'")
        return problems

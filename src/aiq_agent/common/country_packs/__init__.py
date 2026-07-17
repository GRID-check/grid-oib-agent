"""Country pack registry: ISO country code -> CountryPack instance.

Every country with a ``configs/norms/<country>/registry.yml`` MUST have a pack
registered here — the norm-registry loader rejects entries whose
``jurisdiction.country`` has no pack (config bug: fail-open per-entry at
runtime, raises in strict mode).
"""

from __future__ import annotations

from aiq_agent.common.country_packs.at import AustriaPack
from aiq_agent.common.country_packs.base import CountryPack

COUNTRY_PACKS: dict[str, CountryPack] = {
    "at": AustriaPack(),
}

DEFAULT_COUNTRY = "at"


def get_country_pack(country: str | None) -> CountryPack | None:
    """The pack for an ISO country code; None when the country has no pack."""
    if not country:
        return None
    return COUNTRY_PACKS.get(country)

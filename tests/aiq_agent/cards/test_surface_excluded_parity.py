"""Parity guard: which card types may not be a leaf of a surface (ADR-0065).

``SURFACE_EXCLUDED_LEAVES`` is kept by hand twice: in ``cards/models.py``, which
refuses the surface when it is written, and in ``features/a2ui/catalog.tsx``,
which refuses it before drawing. A system card, an envelope shape or an
interactive card missing from either set would sit inside a surface, where an
interactive card's decision has no message position to be keyed by.
"""

import re
from pathlib import Path

from aiq_agent.cards.catalog import ENVELOPE_CARD_TYPES
from aiq_agent.cards.catalog import INTERACTIVE_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.models import SURFACE_EXCLUDED_LEAVES

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_CATALOG = REPO_ROOT / "frontends" / "ui" / "src" / "features" / "a2ui" / "catalog.tsx"


def _ts_excluded_leaves() -> set[str]:
    """The string literals of ``SURFACE_EXCLUDED_LEAVES`` in the frontend catalog."""
    source = TS_CATALOG.read_text(encoding="utf-8")
    match = re.search(
        r"export const SURFACE_EXCLUDED_LEAVES: ReadonlySet<string> = new Set\(\[(.*?)\]\)",
        source,
        re.DOTALL,
    )
    assert match, f"SURFACE_EXCLUDED_LEAVES not found in {TS_CATALOG}"
    return set(re.findall(r"'([^']+)'", match.group(1)))


def test_every_system_envelope_and_interactive_type_is_excluded():
    required = SYSTEM_CARD_TYPES | ENVELOPE_CARD_TYPES | INTERACTIVE_CARD_TYPES
    assert required - SURFACE_EXCLUDED_LEAVES == set()


def test_a_surface_is_not_a_leaf():
    assert "surface" in SURFACE_EXCLUDED_LEAVES


def test_backend_and_frontend_exclude_the_same_leaves():
    assert _ts_excluded_leaves() == set(SURFACE_EXCLUDED_LEAVES)

"""CountryPack: the per-country contract for the norm registry.

Every supported country implements this protocol exactly once
(``country_packs/<country>.py``). Adding a country = implement the pack + add
``configs/norms/<country>/`` — never a second backend. The pack owns everything
that legitimately varies per country:

- the intake state-token vocabulary (``states``),
- jurisdiction resolution (``extract_state`` / ``resolve_state``),
- the legal-hierarchy doctrine header of the lane-rendered prompt block,
- country-specific registry id-convention checks (``validate_ids``),
- optionally a corpus grammar (Phase 2: filename conventions, Punkt/§/Art.
  parsing, citation label formats).

``load_registry`` validates every entry against the pack for its
``jurisdiction.country`` (unknown country / unknown state token = config bug:
dropped fail-open at runtime, raises in strict mode). See ADR-0025 and
docs/superpowers/specs/2026-07-17-norm-registry-design.md §7.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING
from typing import Protocol

if TYPE_CHECKING:
    from aiq_agent.common.norm_registry import NormEntry


class CountryPack(Protocol):
    """The per-country contract every registry country must satisfy."""

    country: str
    """ISO 3166-1 alpha-2 code this pack answers for."""

    states: dict[str, str | None]
    """Intake state-token vocabulary: token -> canonical name.

    A token mapping to None is an explicit "outside this country" sentinel
    (e.g. AT's ``ausserhalb_oesterreichs``): no state's law is prioritized.
    """

    state_order: tuple[str, ...]
    """Canonical state names in probe order (longest-known first is fine)."""

    def state_token_to_name(self, token: str | None) -> str | None:
        """Canonical state name for an intake token, or None."""
        ...

    def state_name_to_token(self, name: str | None) -> str | None:
        """Intake token for a canonical state name, or None."""
        ...

    def extract_state(self, text: str | None) -> str | None:
        """The state the text points at, or None (structured line first, then probing)."""
        ...

    def resolve_state(self, text: str | None) -> str | None:
        """The state to focus/rank on: structured envelope fact first, then ``extract_state``."""
        ...

    def doctrine_lines(self) -> list[str]:
        """Header lines of the lane-rendered registry prompt block (legal doctrine)."""
        ...

    def validate_ids(self, entries: list[NormEntry]) -> list[str]:
        """Country-specific registry id-convention violations (empty = valid)."""
        ...


def normalize_legal_text(text: str) -> str:
    """Lowercase and expand umlauts so matching tolerates spelling variants."""
    return text.strip().lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")


class StructuredTokenStateResolution:
    """Shared jurisdiction-resolution implementation for packs with a token vocabulary.

    Precedence (jurisdiction is a cross-cutting request fact and must travel
    STRUCTURED, not be re-parsed from prompt text):

    1. ``GridRequestContext.from_context().bundesland`` — the validated token on
       the signed ``X-Grid-Request-Context`` envelope. A token that maps to None
       (outside-country sentinel) is FINAL — no fall-through to probing.
    2. The structured ``bundesland=<token>`` fact line in the prompt text.
    3. Free-text state-name probing (spelling variants tolerated).
    """

    states: dict[str, str | None]
    state_order: tuple[str, ...]
    _structured_state_re: re.Pattern[str]

    def __init__(self, states: dict[str, str | None], state_order: tuple[str, ...], fact_key: str = "bundesland"):
        self.states = states
        self.state_order = state_order
        self._name_to_token: dict[str, str] = {name: token for token, name in states.items() if name}
        self._structured_state_re = re.compile(rf"\b{re.escape(fact_key)}=([a-z_]+)")

    def state_token_to_name(self, token: str | None) -> str | None:
        if not token:
            return None
        return self.states.get(token)

    def state_name_to_token(self, name: str | None) -> str | None:
        if not name:
            return None
        return self._name_to_token.get(name)

    def extract_state(self, text: str | None) -> str | None:
        if not text:
            return None
        normalized = normalize_legal_text(text)
        structured = self._structured_state_re.search(normalized)
        if structured:
            return self.states.get(structured.group(1))
        for state in self.state_order:
            if normalize_legal_text(state) in normalized:
                return state
        return None

    def resolve_state(self, text: str | None) -> str | None:
        # Local import: keeps country packs importable standalone (build script).
        from aiq_agent.project_context import GridRequestContext

        structured_token = GridRequestContext.from_context().bundesland
        if structured_token is not None:
            return self.states.get(structured_token)
        return self.extract_state(text)

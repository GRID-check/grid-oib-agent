"""Parity guard: which cards are INTERACTIVE must agree across the stack.

An interactive card (one that asks the user to decide something and then acts
on the answer) carries an obligation the rest of the catalog does not: the
answer exists nowhere but in that click, so the frontend must persist it on the
message. See ``docs/adr/0029-interactive-card-decisions-persist-on-the-message.md``.

The classification is declared twice on purpose — once for the emission side
(``aiq_agent.cards.catalog.INTERACTIVE_CARD_TYPES``) and once for the rendering
side (``CARD_INTERACTIVITY`` in ``card-decision.ts``, whose exhaustive typing
makes a NEW card type fail ``tsc`` until someone classifies it). These tests
fail if the two ever disagree, so the obligation cannot be quietly dropped on
one side.
"""

import re
from pathlib import Path

from aiq_agent.cards.catalog import INTERACTIVE_CARD_TYPES
from aiq_agent.cards.models import GridCard

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_CARD_DECISION = REPO_ROOT / "frontends" / "ui" / "src" / "features" / "grid-cards" / "card-decision.ts"


def _card_types() -> set[str]:
    """Every ``type`` discriminator in the card union."""
    return {getattr(card_cls.model_fields["type"].annotation, "__args__", ("?",))[0] for card_cls in GridCard.__args__}


def _ts_interactive_types() -> set[str]:
    """The card types classified ``'interactive'`` in CARD_INTERACTIVITY."""
    source = TS_CARD_DECISION.read_text(encoding="utf-8")
    match = re.search(
        r"export const CARD_INTERACTIVITY: Record<GridCard\['type'\], CardInteractivity> = \{(.*?)^\}",
        source,
        re.DOTALL | re.MULTILINE,
    )
    assert match, f"CARD_INTERACTIVITY not found in {TS_CARD_DECISION}"
    return set(re.findall(r"^\s*(\w+):\s*'interactive'", match.group(1), re.MULTILINE))


def test_interactive_types_are_real_card_types():
    """A renamed card must not orphan its interactivity declaration."""
    assert INTERACTIVE_CARD_TYPES <= _card_types()


def test_backend_and_frontend_agree_on_which_cards_are_interactive():
    assert _ts_interactive_types() == set(INTERACTIVE_CARD_TYPES)


def test_every_card_type_is_classified_in_the_frontend():
    """The TS map is exhaustive, so a new card type cannot skip classification.

    ``tsc`` already enforces this, but the check is repeated here so a backend
    author who adds a card type without running the frontend typecheck still
    sees the obligation fail in the backend suite.
    """
    source = TS_CARD_DECISION.read_text(encoding="utf-8")
    match = re.search(
        r"export const CARD_INTERACTIVITY: Record<GridCard\['type'\], CardInteractivity> = \{(.*?)^\}",
        source,
        re.DOTALL | re.MULTILINE,
    )
    assert match, f"CARD_INTERACTIVITY not found in {TS_CARD_DECISION}"
    classified = set(re.findall(r"^\s*(\w+):\s*'(?:interactive|presentational)'", match.group(1), re.MULTILINE))
    missing = _card_types() - classified
    assert not missing, (
        f"Card type(s) {sorted(missing)} are not classified in CARD_INTERACTIVITY "
        f"({TS_CARD_DECISION}). Decide whether each one asks the user to commit to "
        "something; if it does, its answer must be persisted on the message."
    )

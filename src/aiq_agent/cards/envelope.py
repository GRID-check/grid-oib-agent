"""Cards as a field of the answer envelope — the model's own cards, without a round.

``emit_card`` is a tool call, and a tool call ends a message: a model that
emitted its cards had to be called AGAIN to write the prose, re-sending the
whole context (40-80k tokens on a researched turn) for text it could have
written in the same breath, and a third time when a shape was wrong. That was
the one round on every card-bearing answer that bought the reader no evidence,
and it was structural — no prompt sentence removes it.

The envelope already made the same move for the verdict, the takeaways and
the callout (``common/answer_envelope.py``, header): emission through a tool
was "optional twice — the model had to recognise the trigger AND spend a tool
call". Cards are the last of the model's own output on the tool channel. So the
envelope carries ``cards``: the same card objects ``emit_card`` takes, in the
same message as the answer, validated here by the same adapter and the same two
closed channels, and registered in the same per-turn ``CardRegistry`` the
frontend already reads. Nothing on the wire changes.

Two things stay on the tool channel, on purpose. SYSTEM cards are pushed by
the tool that did the work (``document_draft`` by ``write_file``,
``document_grid`` by ``surface_documents``, …) and were never the model's to
compose; and ``emit_card`` stays bound for deep research. Piloti (chat) no
longer binds it: its cards travel in the envelope's ``cards`` field only.

A shape the model got wrong is not a round any more either: the pipeline hands
the failed object, the validator's clauses and the type's full shape to a
bounded call on the small card model (``cards/repair.py``) — a few thousand
tokens instead of a full-context round — and registers what comes back, or
drops the card and records that it did (``status:card:invalid``). Never the
answer: a card is an enhancement of an answer that already exists.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from aiq_agent.cards.catalog import ENVELOPE_CARD_TYPES
from aiq_agent.cards.catalog import MARKDOWN_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_doctrine
from aiq_agent.cards.catalog import render_card_index
from aiq_agent.cards.catalog import shape_hint_for
from aiq_agent.cards.models import SURFACE_MAX_CHILDREN
from aiq_agent.cards.models import SURFACE_MAX_LEAVES
from aiq_agent.cards.models import SURFACE_MAX_TABS
from aiq_agent.cards.models import SURFACE_TEXT_MAX
from aiq_agent.common.tool_errors import render_error_detail

logger = logging.getLogger(__name__)

#: The card types whose FULL shape the envelope contract teaches up front.
#:
#: The whole catalog's shapes are ~23 000 tokens (measured with ``o200k_base``),
#: far too much for a prefix re-sent on every call. These three are the cards
#: an answer earns most that Markdown cannot show: the Fundstelle as a
#: quotable excerpt, a decision on one factor, a Verfahren the reader walks.
#: Until 2026-09-24 the list also carried the five table- and list-shaped
#: cards; their content is now written in the answer's Markdown
#: (``catalog.MARKDOWN_CARD_TYPES``), which took ~2 000 tokens of shape out
#: of every call and the repair round their nested building blocks invited.
#: Every other type keeps its index line, and a miss on one of those is
#: repaired by the small model rather than by a round.
ENVELOPE_SHAPE_TYPES: tuple[str, ...] = (
    "legal_basis",
    "condition_tree",
    "process_map",
)

#: The redirect for a model that reached for one of the envelope's OWN fields
#: as a card type. Same sentence ``emit_card`` gives, because it is the same
#: mistake on the same surface.
ENVELOPE_REFUSAL = (
    "card type '{card_type}' is not a card: put its content into the matching field of the "
    "answer envelope (verdict, summary, takeaways, callout)."
)

#: Composition (ADR-0065). Taught as prose plus one worked shape rather than
#: through `render_card_details`: the model's `components` field is an A2UI
#: list of objects, and the rendered field line ("list[object]") says nothing
#: a model could fill it from.
_COMPOSE_RULE = (
    "COMPOSE. Variants the reader picks ONE of to read (two designs, two Bundesländer, Bestand "
    "against Umbau, Außentreppe against zweites Treppenhaus) travel as ONE `surface` card, an A2UI "
    "v0.9 component list with a `Tabs` root, one tab per variant. A tab holds a card, or a `Text` "
    "holding the Markdown you would otherwise write for that variant: its table, its Status column, "
    "its steps, its [N]. What holds for every variant stays in the prose above the tabs, and the "
    "prose names the difference that decides between them; the tabs carry the detail. `Row` (side "
    "by side where the screen is wide) and `Column` (in order) put cards that read together into "
    'one slot. The container has id "root"; every other component is a card named by its type with '
    'that card\'s own fields, or `{"id", "component": "Text", "text": "<Markdown>"}`; children are '
    "referenced by id, each in ONE place (no id listed twice, no leaf in two tabs). Limits: a `Row` or "
    f"`Column` holds 2 to {SURFACE_MAX_CHILDREN} children, `Tabs` 2 to {SURFACE_MAX_TABS} tabs, the "
    f"surface 2 to {SURFACE_MAX_LEAVES} leaves; a `Text` is at most {SURFACE_TEXT_MAX} characters and "
    "carries no card or callout marker (those are placed from the prose). Never an interactive or "
    "tool card inside, nor an envelope field (verdict, summary, takeaways, callout), and a surface "
    "counts as one card against the ceiling. Two tabs that say nearly the same are one answer, not "
    "variants.\n"
    '{"type": "surface", "title": "Zweiter Fluchtweg — zwei Varianten", "components": ['
    '{"id": "root", "component": "Tabs", "tabs": [{"title": "Außentreppe", "child": "a"}, '
    '{"title": "Zweites Treppenhaus", "child": "b"}]}, '
    '{"id": "a", "component": "Text", '
    '"text": "| Kriterium | Anforderung | Status | Fundstelle |\\n|---|---|---|---|\\n…"}, '
    '{"id": "b", "component": "process_map", "title": "…", "steps": […]}]}'
)

#: The marker rule the envelope's cards carry. Stated once, here, and rendered
#: into the taught schema: it is about the ANSWER (where a card is drawn), and
#: the envelope is where the answer is written.
_MARKER_RULE = (
    "PLACEMENT. `[[card:N]]` alone on a line of `answer` draws the N-th card of your `cards` array at "
    "that point; a card with no marker lands after the whole answer. N counts your array from 1 — "
    "unless a tool handed you such a marker earlier this turn (a filed draft, a document "
    "grid): those numbers are taken, so continue after the highest one. Several cards are one "
    "array; two content cards is a turn's ceiling."
)


def render_envelope_cards_contract() -> str:
    """The whole contract for the envelope's ``cards`` field, for the taught schema.

    The doctrine (which trigger takes which card, the craft, the honesty rule,
    the ceiling), the index of every type the model may emit, the full shapes
    of :data:`ENVELOPE_SHAPE_TYPES`, and the placement rule. One home: the
    ``emit_card`` description points here rather than carrying a second copy,
    which is the register's row-8 rule (a trigger table that exists twice
    disagrees with itself) applied to the move that made the tool secondary.
    """
    shapes = render_card_details(ENVELOPE_SHAPE_TYPES)
    return "\n\n".join(
        part
        for part in (
            render_card_doctrine(markdown_first=True),
            render_card_index(exclude=MARKDOWN_CARD_TYPES),
            (
                "SHAPES. The exact shape of the cards answers most often earn follows; fill them "
                "from these, and fill any other type from its index line above — a field you get wrong is "
                "repaired, never a reason to skip a card the answer called for. Fields marked * are "
                "required; omit optional ones rather than passing null. Numbers are plain JSON numbers.\n\n" + shapes
            )
            if shapes
            else "",
            _COMPOSE_RULE,
            _MARKER_RULE,
        )
        if part
    )


#: Why a card was refused. Stable tokens: the two channels word their
#: refusals differently (a tool tells the model what to call next, the
#: pipeline tells the repair what to fix) and both read the kind.
REFUSED_NOT_AN_OBJECT = "not_an_object"
REFUSED_SHAPE = "shape"
REFUSED_SYSTEM_TYPE = "system_type"
REFUSED_ENVELOPE_TYPE = "envelope_type"


@dataclass(frozen=True)
class CardRefusal:
    """What the validator could not accept about one card, and why."""

    kind: str
    #: The declared ``type``, ``"?"`` when the payload declared none.
    card_type: str
    #: One clause per rejected field on a shape miss; empty otherwise.
    detail: str = ""
    #: The type's FULL shape on a shape miss — what a retry or a repair needs.
    hint: str | None = None

    @property
    def message(self) -> str:
        """One sentence naming the fault, without a channel's own advice around it."""
        if self.kind == REFUSED_NOT_AN_OBJECT:
            return "card_json must be a JSON object with a 'type' field, or an array of them."
        if self.kind == REFUSED_SHAPE:
            return f"card of type '{self.card_type}' failed validation: {self.detail}."
        if self.kind == REFUSED_SYSTEM_TYPE:
            return f"card type '{self.card_type}' is system-emitted: the tool that does the work pushes it."
        return ENVELOPE_REFUSAL.format(card_type=self.card_type)

    def for_repair(self) -> str:
        """The refusal as the repair model reads it: the clauses, then the shape."""
        return self.message + (f"\n\n{self.hint}" if self.hint else "")


def validate_model_card(payload: object) -> tuple[dict[str, Any] | None, CardRefusal | None]:
    """One card object through the shape check and the two closed channels.

    The ONE validator for a card the MODEL composes, whichever channel it came
    by: an ``emit_card`` argument, an element of its array, or an element of
    the envelope's ``cards``. A channel that validated more softly would be a
    channel worth routing every card through, so there is one. Returns
    ``(validated, None)`` or ``(None, refusal)``; a shape refusal carries the
    validator's clauses and the type's full shape — what a retry or a repair
    needs, and nothing a reader must not see (no traceback, no documentation
    link: ``common/tool_errors``). Every exit logs, the refusals as warnings:
    a turn that came back with no card must be tellable from one that never
    reached for a card, and the two call for opposite fixes.
    """
    from aiq_agent.cards.models import grid_card_adapter

    if not isinstance(payload, dict):
        logger.warning("card rejected: card_json is a %s, not a JSON object", type(payload).__name__)
        return None, CardRefusal(REFUSED_NOT_AN_OBJECT, type(payload).__name__)

    card_type = str(payload.get("type", "?"))
    try:
        validated = grid_card_adapter.validate_python(payload).model_dump(exclude_none=True)
    except Exception as exc:
        detail = render_error_detail(exc)
        logger.warning("card rejected: a '%s' card failed validation: %s", card_type, detail)
        return None, CardRefusal(REFUSED_SHAPE, card_type, detail=detail, hint=_repair_hint(payload, card_type))

    if validated["type"] in SYSTEM_CARD_TYPES:
        logger.warning("card rejected: '%s' is system-emitted", validated["type"])
        return None, CardRefusal(REFUSED_SYSTEM_TYPE, validated["type"])
    if validated["type"] in ENVELOPE_CARD_TYPES:
        logger.warning("card rejected: '%s' is an envelope field", validated["type"])
        return None, CardRefusal(REFUSED_ENVELOPE_TYPE, validated["type"])
    return validated, None


def _repair_hint(payload: dict[str, Any], card_type: str) -> str | None:
    """The full shape a retry or repair of ``payload`` needs.

    A surface's own hint is the COMPOSE rule, which names no card's fields; a
    leaf that failed its card model is fixed from that card's shape, so the
    shapes of the card types the surface holds ride with it.
    """
    if card_type != "surface":
        return shape_hint_for(card_type)
    components = payload.get("components")
    leaves = [
        component["component"]
        for component in (components if isinstance(components, list) else ())
        if isinstance(component, dict) and isinstance(component.get("component"), str)
    ]
    return render_card_details(["surface", *leaves]) or None


def envelope_card_objects(raw: Sequence[Any] | None) -> list[Any]:
    """The envelope's ``cards`` as objects: a JSON string element is parsed, the rest passed through.

    A model that learned ``emit_card`` writes a card as a JSON STRING; one that
    reads the schema writes an object. Both are the same card. Anything that
    is neither parses to itself and is refused by the validator with its type
    named, so a stray string is a counted refusal rather than a silent drop.
    """
    objects: list[Any] = []
    for element in raw or ():
        if isinstance(element, str):
            try:
                objects.append(json.loads(element, strict=False))
            except (json.JSONDecodeError, TypeError):
                objects.append(element)
            continue
        objects.append(element)
    return objects


def compose_rule() -> str:
    """How a ``surface`` is composed, with its worked example: the rule its shape hint is."""
    return _COMPOSE_RULE

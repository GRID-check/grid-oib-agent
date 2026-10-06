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

from aiq_agent.cards.catalog import RETIRED_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_doctrine
from aiq_agent.cards.catalog import render_card_index
from aiq_agent.cards.catalog import retired_refusal
from aiq_agent.cards.catalog import shape_hint_for
from aiq_agent.cards.models import SURFACE_MAX_CHILDREN
from aiq_agent.cards.models import SURFACE_MAX_LEAVES
from aiq_agent.cards.models import SURFACE_MAX_TABS
from aiq_agent.cards.models import SURFACE_TEXT_MAX
from aiq_agent.common.tool_errors import render_error_detail

logger = logging.getLogger(__name__)

#: The card types whose FULL shape the envelope contract teaches up front.
#:
#: The whole catalog's shapes are far too much for a prefix re-sent on every
#: call. `calculation` is the one content card an answer earns that Markdown
#: cannot carry and whose shape is easy to get wrong (operands, a `factor`, a
#: limit, no result field). The cards that stood here before they were
#: deleted (`legal_basis`, `condition_tree`, `process_map`) are written in the
#: answer's Markdown now (``catalog.RETIRED_CARD_TYPES``). Every other type
#: keeps its index line, and a miss on one of those is repaired by the small
#: model rather than by a round.
ENVELOPE_SHAPE_TYPES: tuple[str, ...] = ("calculation",)

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
    '{"id": "b", "component": "Text", "text": "1. …\\n2. …"}]}'
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
            render_card_doctrine(chat=True),
            render_card_index(),
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
REFUSED_RETIRED_TYPE = "retired_type"
REFUSED_CONFINED = "confined"

#: Card types a turn whose scope holds a restricted folder's collection may not
#: compose (ADR-0078): accepting one writes something the whole project reads.
#: A ``project_profile_patch`` writes the project profile. (``memory_proposal``
#: is a system card, and the ``remember`` tool never pushes one for a restricted
#: finding.)
CONFINED_CARD_TYPES = frozenset({"project_profile_patch"})


def _turn_is_confined() -> bool:
    """Whether this turn may draw on, or its conversation already drew on, a restricted folder; False outside a request.

    The scope read is already narrowed to what the turn may draw on
    (:func:`aiq_agent.knowledge.scoping.get_scoped_collections_from_context`);
    the bound use adds what the conversation recorded (ADR-0078, ADR-0079).
    """
    from aiq_agent.knowledge.restricted_collections import restricted_collections_in
    from aiq_agent.knowledge.restricted_use import current_restricted_use
    from aiq_agent.knowledge.scoping import get_collection_scope_from_context

    try:
        use = current_restricted_use()
        if use is not None and use.confined:
            return True
        return bool(restricted_collections_in(get_collection_scope_from_context()))
    except Exception:  # noqa: BLE001 - an unreadable scope must not let the card through
        logger.warning("card check: the turn's scope could not be read; treating it as confined", exc_info=True)
        return True


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
        if self.kind == REFUSED_CONFINED:
            return (
                f"card type '{self.card_type}' is not offered in a conversation that reads folders with "
                "restricted access: what it writes is read by everyone in the project."
            )
        return retired_refusal(self.card_type)

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
    # The closed channels first: a system card, or a type that no longer
    # exists, is refused by its declared type, before a shape miss could send
    # it to the repair model with nothing to repair it into.
    if card_type in SYSTEM_CARD_TYPES:
        logger.warning("card rejected: '%s' is system-emitted", card_type)
        return None, CardRefusal(REFUSED_SYSTEM_TYPE, card_type)
    if card_type in RETIRED_CARD_TYPES:
        logger.warning("card rejected: '%s' no longer exists", card_type)
        return None, CardRefusal(REFUSED_RETIRED_TYPE, card_type)
    if card_type in CONFINED_CARD_TYPES and _turn_is_confined():
        logger.warning("card rejected: '%s' in a turn whose scope holds a restricted folder", card_type)
        return None, CardRefusal(REFUSED_CONFINED, card_type)
    try:
        validated = grid_card_adapter.validate_python(payload).model_dump(exclude_none=True)
    except Exception as exc:
        detail = render_error_detail(exc)
        logger.warning("card rejected: a '%s' card failed validation: %s", card_type, detail)
        return None, CardRefusal(REFUSED_SHAPE, card_type, detail=detail, hint=_repair_hint(payload, card_type))

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

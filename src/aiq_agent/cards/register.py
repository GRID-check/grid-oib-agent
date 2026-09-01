"""``emit_card`` tool — the agent's first-class channel for rich UI cards.

The answering agent calls this mid-turn whenever a structured element (a legal
basis, a dimension/stair diagram, a summary, …) communicates better than
prose. The card is validated against the shared card schema and pushed into
the conversation-scoped :class:`~aiq_agent.cards.registry.CardRegistry`; the
chat entrypoint reads that registry after the turn and attaches the cards to
the response.

This is the SYNCHRONOUS card channel: the answering agent emits cards from full
context, as a visible tool step, on the shallow chat path. The async
deep-research job runner has no card registry bound in its Dask worker, so it
still derives cards post-hoc from the finished report via
:func:`aiq_agent.cards.generate.generate_cards`. Both surfaces describe the same
schema AND the same trigger doctrine to the model through the shared
:mod:`aiq_agent.cards.catalog`; each adds only what is true of itself.
"""

import json
import logging

# Importing this module runs its ``@register_function`` so NAT discovers the
# ``surface_documents`` tool through the same ``aiq_cards`` entry point that
# imports this file — no extra plugin entry needed.
from aiq_agent.cards import surface_documents as _surface_documents  # noqa: F401

# Re-exported so the shape-hint retry loop and tests keep importing them from
# here; the definitions live in the framing-free catalog module.
from aiq_agent.cards.catalog import CARD_EXAMPLES as _CARD_EXAMPLES  # noqa: F401
from aiq_agent.cards.catalog import ENVELOPE_CARD_TYPES
from aiq_agent.cards.catalog import ENVELOPE_NOTE
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_doctrine
from aiq_agent.cards.catalog import render_card_index
from aiq_agent.cards.catalog import shape_hint_for as _shape_hint_for
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)


# What only THIS surface can promise: a marker comes back from the tool call, and writing it into
# the answer puts the card at that point in the text. Post-hoc generation is handed a report that
# is already written, so it has nothing to place into — which is why this paragraph stays here and
# the trigger table it follows does not (see `catalog.render_card_doctrine`).
_PLACEMENT_CONTRACT = """\
WHERE IT GOES. Every emit_card call hands you back a marker like [[card:2]]. Put that marker on a
line of its own at the point in your answer the card belongs to, and the card is drawn there —
the stair diagram beside the paragraph about the stair, not three screens above it. A marker you
never write puts its card after the whole answer, which is also where every card lands if you
place none: the reader scrolls past the drawings to reach the answer they asked for."""

# The CONTRACT of the tool, and only that: which trigger takes which card, when to emit none, and
# where a card lands. Every line here is paid on every turn whether or not a card is emitted, so
# the CRAFT — which card actually improves an ordinary answer, and how to tell the three
# table-shaped cards apart — lives in the `<cards>` section of the researcher's system prompt
# (`shallow_researcher/prompts/researcher.j2`), where the `piloti-cards` platform skill used to
# carry it before the house skills were folded into the prompts. A new card type earns a trigger
# line in the shared doctrine; its craft paragraph belongs in that prompt section. The doctrine
# itself moved to `catalog.py` when the post-hoc generator started rendering it too — a trigger
# table that exists twice is a trigger table that will disagree with itself.
#
# The envelope redirect rides here and not in the shared doctrine: this is the surface where a
# model that recognised "this answer has a verdict" could reach for a tool call, and the note
# points it at the answer envelope's field instead. The post-hoc surface produces no envelope
# cards and has no envelope, so it gets neither triggers nor note.
_CARD_DOCTRINE = render_card_doctrine() + "\n\n" + ENVELOPE_NOTE + "\n\n" + _PLACEMENT_CONTRACT


def _build_tool_description() -> str:
    """Frame ``emit_card`` with the card INDEX; shapes are fetched on demand.

    Rendering every shape and worked example here costs ~5,200 tokens on every
    turn whether or not a card is emitted, and grows ~190 per card type we add.
    The index plus ``describe_card`` costs ~700 and ~23 respectively, which is
    what makes a growing vocabulary affordable on a cost-optimised model tier.
    """
    return (
        "Render a rich UI card alongside your answer, in addition to your written reply — always "
        "write the prose too. You may call this several times to attach several cards.\n\n"
        + _CARD_DOCTRINE
        + "\n\nHOW. Pass `card_json`: a JSON object with a `type` field plus that type's fields. "
        "Unless a card's exact shape is already in this conversation, call `describe_card` with the "
        "type first — one call, several type names at once, so looking a shape up is never a reason "
        "to skip a card the answer called for. Fields marked * are "
        "required; omit optional ones rather than passing null. Numbers are plain JSON numbers. For "
        "schematic cards, supply the measured/actual value from the question or project profile and "
        "the OIB limit in `required`; if a value is unknown, omit it and set that check's status to "
        '"needs_input" — never estimate.\n\n' + render_card_index()
    )


_DESCRIBE_DESCRIPTION = (
    "Return the exact JSON shape, the shared building blocks and a worked example for one or more "
    "card types, so you can fill `emit_card` in correctly on the first attempt. Pass `card_types`: "
    "one type name, or several separated by commas. Call this once for the types you intend to "
    "emit; the shapes stay in context afterwards."
)


class EmitCardConfig(FunctionBaseConfig, name="emit_card"):
    """Configuration for the ``emit_card`` tool."""


@register_function(config_type=EmitCardConfig)
async def emit_card(tool_config: EmitCardConfig, builder: Builder):
    from aiq_agent.cards.models import grid_card_adapter
    from aiq_agent.cards.registry import get_card_registry

    async def _emit(card_json: str) -> str:
        """Validate and register one Grid response card.

        Every exit logs, including the refusals. A turn that came back with no
        card used to be indistinguishable, after the fact, between "the model
        never called this" and "the model called it and we refused": only the
        success at the bottom wrote a line, so both left the same silence. Those
        two call for opposite fixes — a doctrine that does not get the card
        named, versus a shape the model cannot fill in — and a triage that
        cannot tell them apart picks by guess. Refusals are ``warning`` because
        each one is a card the reader was supposed to get and did not.
        """
        try:
            # strict=False: a raw newline inside a JSON string is how a model
            # writes the ONE card whose payload is a multi-line mermaid source.
            # Refusing it as "not valid JSON" rejected every diagram the field
            # produced while every short-fielded card sailed through.
            payload = json.loads(card_json, strict=False) if isinstance(card_json, str) else card_json
        except (json.JSONDecodeError, TypeError) as exc:
            logger.warning("emit_card rejected a card: card_json is not valid JSON (%s)", exc)
            return f"Error: card_json is not valid JSON ({exc}). Pass a single JSON object with a 'type' field."

        if not isinstance(payload, dict):
            logger.warning("emit_card rejected a card: card_json is a %s, not a JSON object", type(payload).__name__)
            return "Error: card_json must be a single JSON object with a 'type' field."

        try:
            validated = grid_card_adapter.validate_python(payload).model_dump(exclude_none=True)
        except Exception as exc:
            card_type = payload.get("type", "?")
            hint = _shape_hint_for(card_type)
            # The TYPE is the load-bearing half: it says which card the model
            # knew it wanted, which is exactly what a silent turn cannot tell
            # you. The validation message rides along on one line so the shape
            # it tripped over is readable without reproducing the turn.
            logger.warning("emit_card rejected a '%s' card: it failed validation: %s", card_type, exc)
            return (
                f"Error: card of type '{card_type}' failed validation: {exc}. "
                + (f"Expected shape — {hint} " if hint else "")
                + "Fix the fields and try again, or skip the card."
            )

        # System cards (e.g. memory_proposal) are emitted only by their owning
        # tool on a sanctioned path — the model must never emit one directly.
        if validated["type"] in SYSTEM_CARD_TYPES:
            logger.warning("emit_card rejected a '%s' card: that type is system-emitted", validated["type"])
            return (
                f"Error: card type '{validated['type']}' is system-emitted and cannot be created with "
                "emit_card. Do not emit this card type."
            )

        # Envelope shapes are answer-envelope fields; the refusal names the
        # right channel so a model that correctly recognised "this answer has a
        # verdict" is redirected rather than merely refused.
        if validated["type"] in ENVELOPE_CARD_TYPES:
            logger.warning("emit_card rejected a '%s' card: that type is trailer-materialized", validated["type"])
            return (
                f"Error: card type '{validated['type']}' is not emitted as a card. Put its content into "
                "the matching field of your ```answer_json answer envelope instead (see the answer contract)."
            )

        registry = get_card_registry()
        if registry is None:
            # No conversation context bound (e.g. an unusual entrypoint). The
            # answer still stands; the card simply cannot be delivered.
            logger.info("emit_card called with no active card registry; card of type %s dropped", validated["type"])
            return "Noted, but no card channel is available in this context; continue with your written answer."

        registry.add(validated)
        # The marker names the card by its POSITION in this turn's registry, which
        # is the same 1-based index the frontend counts with — the registry keeps
        # emission order, and the response carries the cards in that order. Cards
        # gained no id field for this: an id would have to survive validation,
        # persistence and the deep-research path that builds cards post-hoc.
        position = len(registry)
        logger.info("emit_card registered a '%s' card as card %d", validated["type"], position)
        return (
            f"Card '{validated['type']}' will be shown with your answer, as card {position}. "
            f"Write [[card:{position}]] on a line of its own at the point in your answer where the "
            "card belongs, and it is drawn there instead of after the whole answer. Leave the marker "
            "out and the card lands at the end."
        )

    yield FunctionInfo.from_fn(_emit, description=_build_tool_description())


class DescribeCardConfig(FunctionBaseConfig, name="describe_card"):
    """Configuration for the ``describe_card`` tool."""


@register_function(config_type=DescribeCardConfig)
async def describe_card(tool_config: DescribeCardConfig, builder: Builder):
    """L2 of the card vocabulary: shapes on demand, so L1 can stay one line each."""

    async def _describe(card_types: str) -> str:
        requested = [t.strip() for t in str(card_types).replace(" ", ",").split(",") if t.strip()]
        if not requested:
            return "Error: pass at least one card type name, e.g. 'stair_diagram'."

        known = model_facing_card_types()
        # Report the unknown names rather than rendering only what resolved: a
        # silently shorter answer reads as "that card does not exist", and the
        # model's next move would be to invent a shape for it.
        unknown = [t for t in requested if t not in known]
        detail = render_card_details(requested)

        if not detail:
            return f"No such card type: {', '.join(unknown)}. Available types: {', '.join(sorted(known))}."
        if unknown:
            detail += f"\n\nNot a card type, ignored: {', '.join(unknown)}."
        return detail

    yield FunctionInfo.from_fn(_describe, description=_DESCRIBE_DESCRIPTION)

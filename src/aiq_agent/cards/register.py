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
schema to the model through the shared :mod:`aiq_agent.cards.catalog`.
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
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_index
from aiq_agent.cards.catalog import shape_hint_for as _shape_hint_for
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)


_CARD_DOCTRINE = """\
WHEN TO EMIT ONE. An answer that turns on a dimension gets its card by default, not on request.
A measurement written as a sentence makes the reader re-draw it in their head; the card is the
drawing they would have made. The trigger, then the card:
  a riser, tread or stair width            -> stair_diagram
  a clear width, ramp or turning circle    -> dimension_diagram
  an escape route with segments            -> egress_diagram
  a fall height, railing or opening        -> guardrail_check
  a U-value, HWB or energy class           -> thermal_envelope / energy_performance
  a fire compartment area                  -> fire_compartment
  the Richtlinie or norm the answer rests on -> legal_basis
  three or more pass/fail criteria         -> requirement_checklist
  two or more options weighed against each other -> comparison_table

WHEN NOT TO. A one-line factual answer gets no card: one that repeats the sentence above it costs
the reader a second pass over the same fact. Never fabricate a field, a reference or a number to
fill a card out — a card with an invented limit in it is worse than the prose alone, because it is
the part that gets screenshotted into a submission. Two cards in a turn is plenty; more than that
and the written answer stops being the answer."""


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
        "type first — guessing the nesting wastes a turn on a validation error. Fields marked * are "
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
        """Validate and register one Grid response card."""
        try:
            payload = json.loads(card_json) if isinstance(card_json, str) else card_json
        except (json.JSONDecodeError, TypeError) as exc:
            return f"Error: card_json is not valid JSON ({exc}). Pass a single JSON object with a 'type' field."

        if not isinstance(payload, dict):
            return "Error: card_json must be a single JSON object with a 'type' field."

        try:
            validated = grid_card_adapter.validate_python(payload).model_dump(exclude_none=True)
        except Exception as exc:
            card_type = payload.get("type", "?")
            hint = _shape_hint_for(card_type)
            return (
                f"Error: card of type '{card_type}' failed validation: {exc}. "
                + (f"Expected shape — {hint} " if hint else "")
                + "Fix the fields and try again, or skip the card."
            )

        # System cards (e.g. memory_proposal) are emitted only by their owning
        # tool on a sanctioned path — the model must never emit one directly.
        if validated["type"] in SYSTEM_CARD_TYPES:
            return (
                f"Error: card type '{validated['type']}' is system-emitted and cannot be created with "
                "emit_card. Do not emit this card type."
            )

        registry = get_card_registry()
        if registry is None:
            # No conversation context bound (e.g. an unusual entrypoint). The
            # answer still stands; the card simply cannot be delivered.
            logger.info("emit_card called with no active card registry; card of type %s dropped", validated["type"])
            return "Noted, but no card channel is available in this context; continue with your written answer."

        registry.add(validated)
        logger.info("emit_card registered a '%s' card", validated["type"])
        return f"Card '{validated['type']}' will be shown with your answer."

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

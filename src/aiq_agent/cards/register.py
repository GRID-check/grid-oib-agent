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

# Re-exported so the shape-hint retry loop and tests keep importing them from
# here; the definitions live in the framing-free catalog module.
from aiq_agent.cards.catalog import CARD_EXAMPLES as _CARD_EXAMPLES  # noqa: F401
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import render_card_catalog
from aiq_agent.cards.catalog import shape_hint_for as _shape_hint_for
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)


def _build_tool_description() -> str:
    """Describe every card type, its exact nested shape, and worked examples."""
    return (
        "Render a rich UI card alongside your answer. Call this when a STRUCTURED element "
        "communicates better than prose — e.g. the legal basis grounding an answer, a "
        "dimension/stair/egress diagram, or a concise summary of a longer reply. Emit a card "
        "only when it adds real value; never fabricate fields or references. You may call this "
        "multiple times to attach several cards. The card renders in addition to your normal "
        "written answer, so still write your prose reply.\n\n"
        "Pass `card_json`: a JSON object with a `type` field plus that type's fields. Fields "
        "marked * are required; every other field is optional and may be omitted (do NOT pass "
        "null for optional objects — omit them). Numbers are plain JSON numbers. For schematic "
        "cards, supply measured/actual values from the question or project profile and the OIB "
        "limit in `required`; if a value is unknown, omit it and set that check's status to "
        '"needs_input" — never estimate.\n\n' + render_card_catalog()
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

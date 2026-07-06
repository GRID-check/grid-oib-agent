"""``emit_card`` tool — the agent's first-class channel for rich UI cards.

The answering agent calls this mid-turn whenever a structured element (a legal
basis, a dimension/stair diagram, a summary, …) communicates better than
prose. The card is validated against the shared card schema and pushed into
the conversation-scoped :class:`~aiq_agent.cards.registry.CardRegistry`; the
chat entrypoint reads that registry after the turn and attaches the cards to
the response. This replaces the old post-hoc "re-derive cards from the finished
prose" LLM call — the agent now emits cards from full context, as a visible
tool step, on both the shallow and (future) deep paths.
"""

import json
import logging

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)


def _build_tool_description() -> str:
    """Describe every card type and its fields from the shared schema."""
    from aiq_agent.cards.models import GridCard

    lines: list[str] = []
    for card_cls in GridCard.__args__:
        type_literal = card_cls.model_fields["type"].annotation
        # Literal["legal_basis"] -> "legal_basis"
        type_value = getattr(type_literal, "__args__", ("?",))[0]
        field_descs: list[str] = []
        for field_name, field_info in card_cls.model_fields.items():
            if field_name == "type":
                continue
            required = field_info.is_required()
            desc = field_info.description or field_name
            field_descs.append(f"{field_name}{'*' if required else ''} ({desc})")
        doc = (card_cls.__doc__ or "").strip().split("\n")[0]
        line = f'  - "{type_value}": {doc}'
        if field_descs:
            line += f"\n      fields: {', '.join(field_descs)}"
        lines.append(line)

    return (
        "Render a rich UI card alongside your answer. Call this when a STRUCTURED element "
        "communicates better than prose — e.g. the legal basis grounding an answer, a "
        "dimension/stair/egress diagram, or a concise summary of a longer reply. Emit a card "
        "only when it adds real value; never fabricate fields or references. You may call this "
        "multiple times to attach several cards. The card renders in addition to your normal "
        "written answer, so still write your prose reply.\n\n"
        "Pass `card_json`: a JSON object with a `type` field (one of the types below) plus that "
        "type's fields. Fields marked * are required.\n\n"
        "Card types:\n" + "\n".join(lines)
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
            return (
                f"Error: card of type '{card_type}' failed validation: {exc}. "
                "Check the required fields for this type and try again, or skip the card."
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

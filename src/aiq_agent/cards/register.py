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
import types
import typing
from typing import Literal

from pydantic import BaseModel
from pydantic_core import PydanticUndefined

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

# One worked example per hard-to-nest card, so the model sees the exact shape
# instead of discovering it through repeated validation failures. Keys are the
# card ``type`` values; values are validated in the card model tests.
_CARD_EXAMPLES: dict[str, dict] = {
    "daylight_incidence": {
        "type": "daylight_incidence",
        "title": "Belichtung – freier Lichteinfall (Gästezimmer)",
        "room_floor_area_m2": 25,
        "glass_area": {
            "label": "Lichteintrittsfläche",
            "value": 3.0,
            "required": 2.5,
            "unit": "m²",
            "comparator": ">=",
            "status": "pass",
        },
        "window_sill_height_m": 0.9,
        "window_head_height_m": 2.4,
        "obstruction": None,
        "reference": {
            "document": "OIB-Richtlinie 3",
            "section": "Pkt. 9.1.1",
            "edition": "Ausgabe Mai 2023",
        },
    },
    "building_section": {
        "type": "building_section",
        "title": "Gebäudeschnitt – Höhenprüfung",
        "storeys": [
            {"label": "KG", "height_m": 3.0, "below_grade": True},
            {"label": "EG", "height_m": 3.5},
            {"label": "1.OG", "height_m": 3.2},
        ],
        "markers": [{"label": "Fluchtniveau", "height_m": 9.8, "kind": "fluchtniveau"}],
        "reference": {
            "document": "OIB-Richtlinie 2",
            "section": "Pkt. 2 (Gebäudeklassen)",
            "edition": "Ausgabe Mai 2023",
        },
    },
    "fire_compartment": {
        "type": "fire_compartment",
        "title": "Brandabschnitte – Regelgeschoss",
        "storey_label": "2.OG",
        "gebaeudeklasse": "GK 5",
        "compartments": [
            {
                "label": "BA 1",
                "use": "Wohnen",
                "area": {
                    "label": "BA 1",
                    "value": 1200,
                    "required": 1600,
                    "unit": "m²",
                    "comparator": "<=",
                    "status": "pass",
                },
            },
            {
                "label": "BA 2",
                "use": "Büro",
                "area": {
                    "label": "BA 2",
                    "value": 1850,
                    "required": 1600,
                    "unit": "m²",
                    "comparator": "<=",
                    "status": "fail",
                },
            },
        ],
        "reference": {"document": "OIB-Richtlinie 2", "section": "Pkt. 3.1", "edition": "Ausgabe Mai 2023"},
    },
    "thermal_envelope": {
        "type": "thermal_envelope",
        "title": "Wärmeschutz – U-Werte der Gebäudehülle",
        "components": [
            {
                "label": "Außenwand",
                "kind": "wall",
                "u_value": {
                    "label": "Außenwand",
                    "value": 0.28,
                    "required": 0.35,
                    "unit": "W/(m²K)",
                    "comparator": "<=",
                    "status": "pass",
                },
            },
            {
                "label": "Fenster",
                "kind": "window",
                "u_value": {
                    "label": "Fenster",
                    "value": 1.4,
                    "required": 1.4,
                    "unit": "W/(m²K)",
                    "comparator": "<=",
                    "status": "pass",
                },
            },
        ],
        "reference": {"document": "OIB-Richtlinie 6", "section": "Tabelle 3", "edition": "Ausgabe Mai 2023"},
    },
    "parking_requirement": {
        "type": "parking_requirement",
        "title": "Stellplatznachweis – Wohnbau",
        "basis": "1 Stpl. je 100 m² BGF",
        "car_spaces": {
            "label": "Kfz-Stellplätze",
            "value": 8,
            "required": 10,
            "unit": "Stpl.",
            "comparator": ">=",
            "status": "fail",
        },
        "bicycle_spaces": {
            "label": "Fahrradabstellplätze",
            "value": 20,
            "required": 16,
            "unit": "Stpl.",
            "comparator": ">=",
            "status": "pass",
        },
        "reference": {"document": "Wiener Garagengesetz", "section": "§ 48"},
    },
    "project_profile_patch": {
        "type": "project_profile_patch",
        "title": "Projektkontext aktualisieren: Fluchtniveau",
        "rationale": (
            "Sie haben angegeben, dass das oberste Fluchtniveau bei 25 m liegt — damit ist das "
            "Gebäude ein Hochhaus (> 22 m) und OIB-Richtlinie 2.3 wird anwendbar."
        ),
        "patch": [{"op": "add", "path": "/facts/fluchtniveau", "value": ">22m"}],
        "preview": [{"label": "Escape level", "before": "11–22m", "after": "> 22m"}],
    },
    "requirement_checklist": {
        "type": "requirement_checklist",
        "title": "Anforderungen GK 4 – Brandschutz",
        "items": [
            {
                "label": "Tragende Bauteile REI 60",
                "status": "pass",
                "detail": "Stahlbetondecken erfüllen REI 90.",
                "reference": {"document": "OIB-Richtlinie 2", "section": "Tabelle 1b"},
            },
            {
                "label": "Zweiter Fluchtweg oder Anleiterbarkeit",
                "status": "needs_input",
                "detail": "Anleiterbarkeit der Nordfassade noch nicht geklärt.",
            },
        ],
        "reference": {"document": "OIB-Richtlinie 2", "edition": "Ausgabe Mai 2023"},
    },
    "comparison_table": {
        "type": "comparison_table",
        "title": "GK 4 vs. GK 5 – wesentliche Anforderungen",
        "options": ["GK 4", "GK 5"],
        "rows": [
            {"label": "Fluchtniveau", "values": ["≤ 11 m", "≤ 22 m"], "highlight_index": 0},
            {"label": "Tragende Bauteile", "values": ["REI 60", "REI 90"], "highlight_index": 0},
        ],
        "recommendation": "Mit Fluchtniveau 9,8 m bleibt das Projekt in GK 4.",
        "reference": {"document": "OIB-Richtlinie 2", "section": "Tabelle 1b", "edition": "Ausgabe Mai 2023"},
    },
}


def _annotation_str(annotation: object, nested: list[type]) -> str:
    """Render a field annotation as a compact JSON-ish type string.

    Nested pydantic models are shown by name and collected into ``nested`` so
    their full shape is defined once in a shared "building blocks" section.
    """
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)

    if origin in (typing.Union, types.UnionType):
        non_none = [a for a in args if a is not type(None)]
        return " | ".join(_annotation_str(a, nested) for a in non_none)
    if origin in (list, typing.List):  # noqa: UP006
        return f"[{_annotation_str(args[0], nested)}]"
    if origin is Literal:
        return " | ".join(json.dumps(a, ensure_ascii=False) for a in args)
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        if annotation not in nested:
            nested.append(annotation)
        return annotation.__name__
    return {str: "string", float: "number", int: "integer", bool: "boolean"}.get(
        annotation, getattr(annotation, "__name__", str(annotation))
    )


def _field_constraints(field_info: object) -> list[str]:
    """Extract human-readable constraints (>0, non-empty, defaults) from a field."""
    out: list[str] = []
    for meta in getattr(field_info, "metadata", []) or []:
        gt = getattr(meta, "gt", None)
        ge = getattr(meta, "ge", None)
        min_length = getattr(meta, "min_length", None)
        if gt is not None:
            out.append(f"> {gt}")
        elif ge is not None:
            out.append(f">= {ge}")
        if min_length:
            out.append("non-empty")
    default = getattr(field_info, "default", PydanticUndefined)
    if default not in (PydanticUndefined, None) and not field_info.is_required():
        out.append(f"default {json.dumps(default, ensure_ascii=False)}")
    return out


def _shape(model_cls: type, nested: list[type], *, with_desc: bool) -> str:
    """Render a model's fields as `{ name*: type (desc; constraints), ... }`."""
    parts: list[str] = []
    for field_name, field_info in model_cls.model_fields.items():
        if field_name == "type":
            continue
        req = "*" if field_info.is_required() else ""
        type_str = _annotation_str(field_info.annotation, nested)
        notes: list[str] = []
        if with_desc and field_info.description:
            notes.append(field_info.description)
        notes.extend(_field_constraints(field_info))
        suffix = f" ({'; '.join(notes)})" if notes else ""
        parts.append(f"{field_name}{req}: {type_str}{suffix}")
    return "{ " + ", ".join(parts) + " }"


def _card_shape(card_cls: type, nested: list[type]) -> str:
    """The one-line shape spec for a card body (top-level fields, no descriptions)."""
    return _shape(card_cls, nested, with_desc=False)


def _shape_hint_for(card_type: str) -> str | None:
    """Return the expected shape (plus referenced building blocks) for one card type."""
    from aiq_agent.cards.models import GridCard

    for card_cls in GridCard.__args__:
        type_value = getattr(card_cls.model_fields["type"].annotation, "__args__", ("?",))[0]
        if type_value != card_type:
            continue
        nested: list[type] = []
        body = _card_shape(card_cls, nested)
        seen: set[type] = set()
        blocks: list[str] = []
        i = 0
        while i < len(nested):
            model_cls = nested[i]
            i += 1
            if model_cls in seen:
                continue
            seen.add(model_cls)
            blocks.append(f"{model_cls.__name__} = {_shape(model_cls, nested, with_desc=True)}")
        hint = f"{card_type}: {body}"
        if blocks:
            hint += " where " + "; ".join(blocks)
        example = _CARD_EXAMPLES.get(card_type)
        if example:
            hint += f". Example: {json.dumps(example, ensure_ascii=False)}"
        return hint
    return None


def _build_tool_description() -> str:
    """Describe every card type, its exact nested shape, and worked examples."""
    from aiq_agent.cards.models import GridCard

    nested: list[type] = []
    card_lines: list[str] = []
    for card_cls in GridCard.__args__:
        type_value = getattr(card_cls.model_fields["type"].annotation, "__args__", ("?",))[0]
        doc = (card_cls.__doc__ or "").strip().split("\n")[0]
        shape = _card_shape(card_cls, nested)
        card_lines.append(f'  - "{type_value}": {doc}\n      shape: {shape}')

    # Define every shared building block ONCE (with field descriptions), so a
    # card body can reference e.g. `DimensionCheck` by name without repetition.
    # `nested` grows while rendering card shapes; expand transitively.
    seen: set[type] = set()
    block_lines: list[str] = []
    i = 0
    while i < len(nested):
        model_cls = nested[i]
        i += 1
        if model_cls in seen:
            continue
        seen.add(model_cls)
        block_lines.append(f"  {model_cls.__name__} = {_shape(model_cls, nested, with_desc=True)}")

    examples = "\n".join(
        f"  {type_value}:\n    {json.dumps(payload, ensure_ascii=False)}"
        for type_value, payload in _CARD_EXAMPLES.items()
    )

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
        '"needs_input" — never estimate.\n\n'
        "Building blocks (reused object shapes):\n" + "\n".join(block_lines) + "\n\n"
        "Card types:\n" + "\n".join(card_lines) + "\n\n"
        "Worked examples (copy the nesting exactly):\n" + examples
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

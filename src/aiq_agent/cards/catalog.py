"""Single, framing-agnostic description of the card catalog for the LLM.

Grid describes the SAME discriminated-union card schema to the model on two
surfaces — the mid-turn ``emit_card`` tool (:mod:`aiq_agent.cards.register`) and
the post-hoc batch generator (:mod:`aiq_agent.cards.prompt` /
:mod:`aiq_agent.cards.generate`). This module owns the one representation they
share: compact per-type shapes, shared building blocks defined once, and worked
examples for the hard-to-nest types. Each surface adds only its own framing
(tool-call vs batch), so the schema description can never drift between them.

Deliberately free of NAT/tooling imports so it can be imported from either
surface without triggering tool registration side effects.
"""

import json
import types
import typing
from typing import Literal

from pydantic import BaseModel
from pydantic_core import PydanticUndefined

# Card types that are SYSTEM-emitted (by a tool, on a sanctioned path) and must
# never be advertised to the model — it must not be able to fabricate them. They
# remain valid union members for validation/serialization/rendering; only their
# description in the model-facing catalog is suppressed.
SYSTEM_CARD_TYPES = frozenset({"memory_proposal", "document_grid"})

# Card types that ASK THE USER TO DECIDE something and act on the answer. They
# are a different kind of object from the rest of the catalog: a presentational
# card can be re-rendered from its payload forever, but an interactive card's
# ANSWER is state that exists nowhere else, so the frontend must persist it on
# the message (see
# docs/adr/0029-interactive-card-decisions-persist-on-the-message.md).
#
# Adding a card type here is a contract with the frontend, not a label:
#   - `frontends/ui/src/features/grid-cards/card-decision.ts` must classify it
#     `'interactive'` in CARD_INTERACTIVITY (that map is exhaustive, so `tsc`
#     fails until you do);
#   - its renderer must drive its lifecycle from `useCardDecision`, never from
#     component-local `useState`;
#   - every terminal outcome it can reach must be a member of `CARD_DECISIONS`.
#
# Emit an interactive card ONLY for an action that is not safely repeatable
# (a memory write, a profile patch). If the action is idempotent and cheap,
# prefer a presentational card — there is then nothing to remember.
INTERACTIVE_CARD_TYPES = frozenset({"project_profile_patch", "memory_proposal"})

# One worked example per hard-to-nest card, so the model sees the exact shape
# instead of discovering it through repeated validation failures. Keys are the
# card ``type`` values; values are validated in the card model tests.
CARD_EXAMPLES: dict[str, dict] = {
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


def shape_hint_for(card_type: str) -> str | None:
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
        example = CARD_EXAMPLES.get(card_type)
        if example:
            hint += f". Example: {json.dumps(example, ensure_ascii=False)}"
        return hint
    return None


def render_card_catalog() -> str:
    """The shared catalog body: building blocks, per-card shapes, worked examples.

    Framing-free — callers wrap it in tool-call or batch instructions. This is
    the single source both card surfaces render from, so a new card type is
    documented identically to the model on both paths.
    """
    from aiq_agent.cards.models import GridCard

    nested: list[type] = []
    card_lines: list[str] = []
    for card_cls in GridCard.__args__:
        type_value = getattr(card_cls.model_fields["type"].annotation, "__args__", ("?",))[0]
        # System cards are emitted by tools on sanctioned paths, never by the
        # model — omit them so the model can't fabricate them.
        if type_value in SYSTEM_CARD_TYPES:
            continue
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
        for type_value, payload in CARD_EXAMPLES.items()
    )

    # Interactive cards ASK THE USER TO AUTHORIZE A REAL WRITE, so they cost the
    # user a decision rather than just screen space. Say so explicitly: without
    # it the model treats them like any other presentational card and emits them
    # speculatively, which turns the answer into a pile of consent prompts.
    # System cards are excluded here for the same reason they are excluded above
    # — the model must not learn they exist.
    interactive = sorted(INTERACTIVE_CARD_TYPES - SYSTEM_CARD_TYPES)
    interactive_note = (
        "\n\nCards that ask the user to CONFIRM something (" + ", ".join(f'"{t}"' for t in interactive) + "):\n"
        "  These are not presentation — they ask the user to authorize a real, persisted change, and\n"
        "  their answer is remembered. Emit one only when you have a SPECIFIC change worth interrupting\n"
        "  for, grounded in something the user actually said in this conversation. At most one per turn.\n"
        "  Never emit one speculatively, to ask a question you could ask in prose, or to restate a\n"
        "  change the user already confirmed."
        if interactive
        else ""
    )

    return (
        "Building blocks (reused object shapes):\n" + "\n".join(block_lines) + "\n\n"
        "Card types:\n" + "\n".join(card_lines) + interactive_note + "\n\n"
        "Worked examples (copy the nesting exactly):\n" + examples
    )

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

import functools
import json
import types
import typing
from typing import Any
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
# docs/adr/0030-interactive-card-decisions-persist-on-the-message.md).
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

# Card types whose fields must be COPIED from a tool result and cannot be
# derived from prose: every one of them is addressed by IFC GlobalId, rule id
# or file name, and an id that was not returned by ``ifc_query`` in the same
# turn does not identify anything.
#
# They stay in the catalog for the ``emit_card`` tool, whose caller has the tool
# rows in context. They are withheld from POST-HOC generation
# (:func:`aiq_agent.cards.prompt.build_card_generation_prompt`), which sees only
# the question and the finished answer text — no tool output at all. From that
# context the only ids available are whatever survived into the prose, so a
# model card generated there is built from leftovers or invented outright, and
# an unresolvable GlobalId renders as a missing element, which tells the user
# their model is broken when it is not.
MODEL_BACKED_CARD_TYPES = frozenset({"ifc_viewer", "ifc_element", "ifc_compliance", "ifc_schedule", "ifc_diff"})

# One worked example per hard-to-nest card, so the model sees the exact shape
# instead of discovering it through repeated validation failures. Keys are the
# card ``type`` values; values are validated in the card model tests.
CARD_EXAMPLES: dict[str, dict] = {
    # The one card whose element ids must be REAL: they come from ifc_query in
    # the same turn, and an invented GlobalId highlights nothing. Worth an
    # example so the model sees that `global_ids` is a list of opaque strings it
    # copies, not a value it composes.
    "ifc_compliance": {
        "type": "ifc_compliance",
        "title": "Offene Anforderungen — Brandschutz",
        "model_file": "haus-a.ifc",
        # Ids exactly as ifc_query operation='compliance' reported them. The
        # card reports any that do not resolve rather than dropping them, so an
        # invented id is visible instead of silently narrowing the list.
        "rule_ids": ["oib2-feuerwiderstand-tragend"],
        "note": "Orientierende Prüfung, kein Nachweis.",
    },
    # Shows BOTH selectors, because the choice between them is the thing that
    # is easy to get wrong. The first group is a SET — reusing the exact filter
    # the count came from, so all of it highlights however large it is. The
    # second names two walls the answer actually discussed, which is the only
    # case where transcribing ids is the right move.
    "ifc_viewer": {
        "type": "ifc_viewer",
        "title": "Brandabschnitte – Erdgeschoss",
        "model_file": "haus-a.ifc",
        "storey": "Erdgeschoss",
        "highlights": [
            {
                "match": {
                    "ifc_types": ["IfcWall"],
                    "storeys": ["Erdgeschoss"],
                    "properties": [{"set": "Pset_WallCommon", "name": "FireRating", "operator": "missing"}],
                },
                "label": "Keine Feuerwiderstandsklasse hinterlegt",
                "status": "fail",
            },
            {
                "global_ids": ["1kTvXnbbzCWw8lcMd1dR4o", "0RSwXnbbzCWw8lcMd1dR9z"],
                "label": "REI 90 erfüllt",
                "status": "pass",
            },
        ],
        "note": "Die hervorgehobenen Wände stammen aus der Modellabfrage, nicht aus dem Plan.",
    },
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


def _card_type_of(card_cls: type) -> str:
    """The ``type`` literal of a card class (``"summary"``, …)."""
    return getattr(card_cls.model_fields["type"].annotation, "__args__", ("?",))[0]


@functools.lru_cache(maxsize=1)
def model_facing_card_types() -> frozenset[str]:
    """Every card ``type`` the model may be ASKED to produce.

    The union minus :data:`SYSTEM_CARD_TYPES` — i.e. exactly the set
    :func:`render_card_catalog` advertises. It is exposed separately because
    other surfaces need to answer "may a skill/author name this card?" without
    parsing the rendered catalog text: the skills substrate validates
    ``grid-cards`` against it (see :mod:`aiq_agent.skills.models`), and the
    editor's picker derives the same set from the generated Zod schemas. One
    definition of "advertisable", so a new card type appears everywhere at once
    and a system card can never be requested by name.
    """
    from aiq_agent.cards.models import GridCard

    return frozenset(_card_type_of(c) for c in GridCard.__args__) - SYSTEM_CARD_TYPES


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


def _field_specs(model_cls: type, nested: list[type]) -> list[dict[str, Any]]:
    """The same per-field information ``_shape`` renders as prose, as data."""
    specs: list[dict[str, Any]] = []
    for field_name, field_info in model_cls.model_fields.items():
        if field_name == "type":
            continue
        specs.append(
            {
                "name": field_name,
                "type": _annotation_str(field_info.annotation, nested),
                "required": field_info.is_required(),
                "description": field_info.description or "",
                "constraints": _field_constraints(field_info),
            }
        )
    return specs


def describe_card_catalog() -> dict[str, Any]:
    """The card catalog as data, for surfaces that show it to PEOPLE.

    :func:`render_card_catalog` renders the same models as prose for the model
    and omits the system cards, because a model that reads about them can
    fabricate them. A human catalog has the opposite need: it must list every
    card the product can render — a platform owner asking "can Grid show me X?"
    is not served by a list with holes in it — so system cards are included and
    flagged (``emittedBy``) rather than hidden.

    Derived from the Pydantic union like every other card surface, so a new card
    type appears here the moment it is added to ``GridCard`` and cannot drift.
    Keys are camelCase because this is a wire shape, not a Python one.
    """
    from aiq_agent.cards.models import GridCard

    nested: list[type] = []
    cards: list[dict[str, Any]] = []
    for card_cls in GridCard.__args__:
        type_value = getattr(card_cls.model_fields["type"].annotation, "__args__", ("?",))[0]
        doc = (card_cls.__doc__ or "").strip()
        cards.append(
            {
                "type": type_value,
                "model": card_cls.__name__,
                # First paragraph only: the rest of a card docstring is guidance
                # for contributors, not a description of what the card shows.
                "summary": " ".join(doc.split("\n\n")[0].split()),
                "emittedBy": "system" if type_value in SYSTEM_CARD_TYPES else "agent",
                "interaction": ("interactive" if type_value in INTERACTIVE_CARD_TYPES else "presentational"),
                "fields": _field_specs(card_cls, nested),
                "example": CARD_EXAMPLES.get(type_value),
            }
        )

    # Shapes the card bodies reference by name (NormReference, DimensionCheck,
    # …), each defined once. `nested` grows while the cards above are described
    # and again while the blocks themselves are, so walk it as a queue.
    seen: set[type] = set()
    building_blocks: dict[str, list[dict[str, Any]]] = {}
    i = 0
    while i < len(nested):
        model_cls = nested[i]
        i += 1
        if model_cls in seen:
            continue
        seen.add(model_cls)
        building_blocks[model_cls.__name__] = _field_specs(model_cls, nested)

    return {"cards": cards, "buildingBlocks": building_blocks}


def shape_hint_for(card_type: str) -> str | None:
    """Return the expected shape (plus referenced building blocks) for one card type."""
    from aiq_agent.cards.models import GridCard

    for card_cls in GridCard.__args__:
        if _card_type_of(card_cls) != card_type:
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


def render_card_catalog(*, include_model_backed: bool = True) -> str:
    """The shared catalog body: building blocks, per-card shapes, worked examples.

    Framing-free — callers wrap it in tool-call or batch instructions. This is
    the single source both card surfaces render from, so a new card type is
    documented identically to the model on both paths.

    Args:
        include_model_backed: Whether to advertise the cards in
            :data:`MODEL_BACKED_CARD_TYPES`. The ``emit_card`` tool leaves this
            on — its caller has the ``ifc_query`` rows in context. Post-hoc
            generation turns it off, because it has no tool output to copy ids
            from and would have to invent them.
    """
    from aiq_agent.cards.models import GridCard

    withheld = SYSTEM_CARD_TYPES if include_model_backed else SYSTEM_CARD_TYPES | MODEL_BACKED_CARD_TYPES

    nested: list[type] = []
    card_lines: list[str] = []
    for card_cls in GridCard.__args__:
        type_value = _card_type_of(card_cls)
        # System cards are emitted by tools on sanctioned paths, never by the
        # model — omit them so the model can't fabricate them. Model-backed
        # cards are omitted on the path that cannot supply their ids.
        if type_value in withheld:
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

    # An example is a card description too: leaving a worked `ifc_viewer` in
    # place would advertise the exact shape of a card the surrounding text just
    # withheld, which is the one thing more misleading than either alone.
    examples = "\n".join(
        f"  {type_value}:\n    {json.dumps(payload, ensure_ascii=False)}"
        for type_value, payload in CARD_EXAMPLES.items()
        if type_value not in withheld
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

    # A number on a card outlives the sentence next to it. The card is what gets
    # screenshotted into a submission, so it is the surface most likely to be
    # forwarded without the qualifier that made it true — which is why the rule
    # is stated here rather than left to the field descriptions alone.
    measured_note = (
        "\n\nNumbers that came from a MEASUREMENT (`ifc_measure`):\n"
        "  Every ifc_measure answer says HOW it was obtained. When you put one of its numbers on a\n"
        "  card, carry that with it — on DimensionCheck, set `provenance` to the answer's own\n"
        "  provenance, and for a 'computed' one set `tolerance` to the ± band in the SAME unit.\n"
        "  Copy them; never infer them. Marking our own measurement 'declared' turns our tolerance\n"
        "  into the architect's claim, and a measured dimension shown without its band reads as\n"
        "  exact — which is what decides whether 2,47 m clears a 2,50 m minimum.\n"
        "  Leave both null for a number that did not come from the model: a figure the user typed,\n"
        "  or a limit read out of the Bestimmung. Null means 'not stated', never 'declared'.\n"
        "  When the answer came back `decidable: false`, the dimension is status 'needs_input' with\n"
        "  `value` null and `missing` set to that answer's missing.remedy, VERBATIM — that sentence\n"
        "  is what the architect changes in their CAD. A blank slot instead of it reads as a fact\n"
        "  about the building, when it is a finding about the export."
    )

    return (
        "Building blocks (reused object shapes):\n" + "\n".join(block_lines) + "\n\n"
        "Card types:\n" + "\n".join(card_lines) + interactive_note + measured_note + "\n\n"
        "Worked examples (copy the nesting exactly):\n" + examples
    )

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
import textwrap
import types
import typing
from collections.abc import Iterable
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic_core import PydanticUndefined

# Card types the MODEL MAY NOT EMIT because a TOOL owns them. They remain valid
# union members for validation/serialization/rendering, and only their
# description in the model-facing catalog is suppressed. Every emission path
# reads this set: the envelope's `cards` and `emit_card` (`validate_model_card`
# in `cards/envelope.py`), post-hoc batch generation (`validate_cards` in
# `cards/models.py`) and the DSML salvage (`piloti/dsml.py`).
#
# A tool on a sanctioned path owns each card and the model must not be able to
# fabricate it (`memory_proposal` from `remember`, `document_grid` from
# `surface_documents`, `document_draft` from the working directory's
# `write_file`/`edit_file`, whose card names a file that has to exist,
# `task_created` from `create_task`, whose card names a task row the BFF has
# already written, `file_operation_proposal` from the four write-side workspace
# tools, whose card names files the reader actually has).
SYSTEM_CARD_TYPES = frozenset(
    {
        "memory_proposal",
        "document_grid",
        "document_draft",
        # `task_created` from `create_task`: the card is proof that a task ROW
        # exists, and a model that could fabricate one could announce delegated
        # work nobody queued — which is exactly the sentence the tool was added
        # to stop the model writing on its own.
        "task_created",
        "file_operation_proposal",
    }
)

#: Card types that no longer exist, each with what carries its content now. They
#: were deleted from the `GridCard` union (an answer is Markdown prose; a card
#: must carry an interaction, geometry drawn to scale, a computed number or a
#: live model binding that Markdown cannot), so no channel can register one.
#: This map only makes the refusal useful: a model that reaches for one by name
#: is told the Markdown (or the card) that replaced it, instead of a validator's
#: "unknown discriminator" that would send it to the repair model. The dialect
#: names (`:::pruefung`, …) are the ones `piloti_static.md` <formatting> teaches.
RETIRED_CARD_REPLACEMENTS: dict[str, str] = {
    "summary": "the answer's first sentence, or the `summary` field of your ```answer_json envelope",
    "verdict_header": "the `verdict` field of your ```answer_json envelope",
    "key_takeaways": "the `takeaways` field of your ```answer_json envelope",
    "callout": "the `callout` field of your ```answer_json envelope",
    "follow_ups": "nothing: follow-up questions are computed after the answer",
    "typed_table": "a Markdown table in the answer",
    "comparison_table": "a `:::vergleich` block: a table with a column per variant",
    "requirement_checklist": "a `:::pruefung` block: a table with a Status column",
    "document_checklist": "a table with a Status column (erforderlich, bedingt, vorhanden, fehlt)",
    "deadline_timeline": "a `:::verfahren` block: a numbered list, each Frist in bold as the Bestimmung words it",
    "norm_chain": "a table of the instruments, or a ```mermaid flowchart TD with the binding one on top",
    "change_impact": "a table with a row per consequence and its Fundstelle",
    "diagram": "a ```mermaid fence in the answer",
    "condition_tree": "a `:::faelle` block: a table of the cases, this project's row with Status `trifft zu`",
    "process_map": "a `:::verfahren` block around a numbered list; a ```mermaid flowchart TD if it forks",
    "legal_basis": "a cited blockquote in the answer: > „<the passage verbatim>“ [N]",
    "fire_compartment": "a `:::pruefung` block; a calculation card where the area is worked out",
    "thermal_envelope": "a `:::pruefung` block (Bauteil | U-Wert | Anforderung | Status | Fundstelle)",
    "energy_performance": "a `:::kennzahlen` block, the class as :klasse[B]",
    "acoustic_check": "a `:::pruefung` block (Bauteil | Nachweis | Anforderung | Status | Fundstelle)",
    "parking_requirement": "a `:::kennzahlen` block; a calculation card where the count is worked out",
    "density_check": "a setback_plan card with `coverage` / `density`",
    "elevator_requirement": "a dimension_diagram card with shape `lift_cabin`",
}
RETIRED_CARD_TYPES: frozenset[str] = frozenset(RETIRED_CARD_REPLACEMENTS)


def retired_refusal(card_type: str) -> str:
    """The one sentence every channel refuses a retired card type with: what to write instead."""
    return f"card type '{card_type}' no longer exists: write {RETIRED_CARD_REPLACEMENTS[card_type]} instead."


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
#   - every terminal outcome it can reach must be a member of `CARD_DECISIONS`;
#   - it must also be in SURFACE_EXCLUDED_LEAVES: a leaf inside a surface has
#     no message position for its decision to be keyed by. `cards/models.py`
#     derives that set from this one (and from SYSTEM_CARD_TYPES), so Python
#     needs no edit; the frontend's copy in
#     `frontends/ui/src/features/a2ui/catalog.tsx` is kept by hand, and
#     `tests/aiq_agent/cards/test_surface_excluded_parity.py` holds it to the
#     derived set.
#
# Emit an interactive card ONLY for an action that is not safely repeatable
# (a memory write, a profile patch). If the action is idempotent and cheap,
# prefer a presentational card — there is then nothing to remember.
#
# `diagram` was briefly a member for a filing button the release review cut; the
# card is gone now (RETIRED_CARD_TYPES), and a ```mermaid fence in the prose
# carries what it drew. There is no second set here (a `CONSENT_CARD_TYPES`
# briefly existed and left with the button): two constants equal by
# construction are two things to keep in sync.
#
# `document_draft` joined when `file_draft` gave it something to act on. It is a
# borderline case worth stating: the card is emitted by a WRITE that already
# happened (the draft exists), so emitting it costs the reader no decision — but
# a FILED card offers „Zur Freigabe einreichen", and that is a non-idempotent
# write which opens an inbox item on a colleague. The rule above is about the
# answer, not about the emission, so it is a member. Its OTHER control, on an
# unfiled card, writes nothing at all: it prefills the composer.
INTERACTIVE_CARD_TYPES = frozenset(
    {"project_profile_patch", "memory_proposal", "file_operation_proposal", "document_draft"}
)

# Card types offered on the chat envelope only. A `surface` is taught by the
# envelope's COMPOSE rule (its field line alone says nothing a model could fill
# it from), and its `Text` leaves carry `[N]` that only the chat pipeline holds
# to the answer's verified citations (`cards/surface_citations.py`). The
# `emit_card` index and the post-hoc prompt have neither, so they withhold it,
# and the `emit_card` tool, `describe_card` and the post-hoc validator
# (`models.validate_cards`) refuse it.
CHAT_ONLY_CARD_TYPES = frozenset({"surface"})

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

# The shared card DOCTRINE: what Markdown carries, which trigger takes which card, and when to emit
# none.
#
# It lives here, with the shapes, because every surface that asks a model for a card needs it and
# none may hold its own copy: the chat envelope (`cards/envelope.py`), `emit_card` for deep research
# (`cards/register.py`) and the post-hoc batch pass (`cards/prompt.py`). A rule kept twice disagrees
# with itself.
#
# The CRAFT rides WITH the triggers, one indented block per row, because the trigger and how the
# card is filled well are one decision. `include_craft=False` renders the rows alone, for the
# post-hoc surface, which has its own short craft in `prompt.py`.
#
# What stays OUT of this module is what only the answering PROMPT can say: the `[[card:N]]`
# placement contract, and the envelope's own fields (verdict, takeaways, callout).
#
# MARKDOWN FIRST leads, on every surface. An answer is Markdown prose; a table, a list, a flowchart
# fence and a verified blockquote carry what the retired cards (RETIRED_CARD_TYPES) carried, and a
# card is left for what Markdown cannot hold: an interaction, geometry drawn to scale, a number the
# card computes, a live binding to the building model, variants in tabs. So the table below is
# short, and a match is a REASON, not an obligation: the clause about carrying more than the
# sentence beside it puts the restatement test (anti-goal D.8) in the invitation itself.
#
# The NAMING clause closes the one gap the table cannot reach: field transcripts showed the model
# recognising the right card and then writing prose anyway. Not "you must", but "you have already
# decided".
_MARKDOWN_FIRST = """\
MARKDOWN FIRST. The answer's own Markdown carries rows of values, cases and options (a table; a
Status column renders its words as marks, and `trifft zu` marks the row that holds for this
project), a Verfahren or a run of Fristen (a numbered list, or a ```mermaid flowchart TD when it
forks), and the wording an answer turns on (a cited blockquote > „…“ [N]). A card is only for what
Markdown cannot carry: an interaction, geometry drawn to scale from measurements, a number the card
computes (calculation), a live binding to the building model, or variants in tabs (surface)."""

_CARD_TRIGGER_HEAD = """\
WHEN TO EMIT ONE. A row that matches your answer is a reason to reach for that card — a stair, a
clear width or an escape route written out as prose makes the reader rebuild in their head the
drawing the card would have shown them. Emit it where the match is clear and the card
carries more than the sentence beside it. Naming the card IS the decision: once you can say which
card this answer is, emitting it is the step that follows, not a second judgement."""

# The picker's CRAFT, indented under its trigger row like every other card's. The row and this note
# travel together and are withheld together: the shape stays in the catalog on every surface — the
# card carries a heading and nothing else, so there is no id to invent (which is why it is not, and
# must not become, a member of MODEL_BACKED_CARD_TYPES). What does not transfer is the instruction.
# It fires on a live intent in the turn being answered, and it tells the model to emit the card
# INSTEAD of writing the file names in prose. On the post-hoc path the prose is already written and
# cannot be unwritten, so that trade is not on offer.
_MODEL_PICKER_NOTE = """\
The ifc_model_picker is the answer to "zeig mir das Modell" / "welches Modell soll ich öffnen":
emit it INSTEAD of writing the file names as a prose bullet list. It renders the project's models
as tiles the user clicks to open the viewer directly — you supply only the heading, never the file
names, so there is nothing to get wrong. You do not need to call ifc_query first to list them."""

#: ``(trigger, card, craft)``. The trigger says WHICH card; the craft, indented under it, says how
#: that card is filled well. A card type with no craft entry is one the renderer already constrains:
#: the schematic cards draw to scale from `DimensionCheck` rows, so getting the fields in is the
#: whole of getting the card right.
_CARD_TRIGGERS: tuple[tuple[str, str, str], ...] = (
    ("a riser, tread or stair width", "stair_diagram", ""),
    ("a clear width, ramp or turning circle", "dimension_diagram", ""),
    ("an escape route with segments", "egress_diagram", ""),
    ("a fall height, railing or opening", "guardrail_check", ""),
    (
        "a distance to a parcel edge, or Bebauungsgrad, Bebauungsdichte or GFZ",
        "setback_plan",
        "For coverage and GFZ, give `coverage` / `density` with the Bebauungsplan's limit in `required` "
        "and leave `value` empty: the card derives it from the areas (`parcel_area_m2`, "
        "`footprint_area_m2` where the plot is not the drawn rectangle, `gross_floor_area_m2` for the "
        "GFZ). A pure density question leaves `sides` empty; a limit the Bebauungsplan did not give "
        "you stays out.",
    ),
    (
        "a barrier-free lift: cabin width, cabin depth, door",
        "dimension_diagram",
        "shape `lift_cabin`, with Kabinenbreite, Kabinentiefe and lichte Türbreite as its dimensions. "
        "Whether a lift is required at all is a sentence with its Fundstelle, not a field.",
    ),
    (
        "a number the answer WORKED OUT rather than looked up",
        "calculation",
        "Supply the operands (label, value, unit) and the rule's limit; the card computes, rounds "
        "and judges, and there is no result field, on purpose. The rule's multiplier is a "
        "`factor`, never a second operand, and an operand you do not have stays empty — the card "
        'renders „nicht berechenbar". Never for a number merely cited: one operand is the '
        "sentence beside it, typeset twice.",
    ),
)

#: Withheld from the post-hoc surface, row and craft together (`include_ifc_triggers=False`).
_MODEL_PICKER_ROW = (
    "the user wants to SEE or OPEN the building and the project may hold several models",
    "ifc_model_picker",
    _MODEL_PICKER_NOTE,
)

# The anti-fabrication rule: the reason a card can be worse than no card at all, and the ONE
# instruction here that outranks a trigger. Stated on its own, away from the volume rule, so a
# model that discounts "two is plenty" as tone does not discount "never fabricate" with it. The
# post-hoc path states it a second time, in stronger terms (see `prompt.py`).
_CARD_HONESTY = """\
WHAT MAY GO ON ONE. Never fabricate a field, a reference or a number to fill a card out — a card
with an invented limit in it is worse than the prose alone, because it is the part that gets
screenshotted into a submission. A value you do not have is left out or marked "needs_input", never
estimated to make the card look finished. This rule outranks every trigger above."""

# The volume rule, and only that — a CEILING, said as a ceiling (anti-goal D.8: no card that
# restates the prose beside it).
_CARD_RESTRAINT = """\
WHEN NOT TO. One card is usually the right number, two the ceiling, none the normal case. A
one-line factual answer earns none: the card would only repeat the sentence above it. A card that
shows what a table or a sentence in the prose already shows is a restatement: keep the prose, cut
the card."""

# One worked example per hard-to-nest card, so the model sees the exact shape
# instead of discovering it through repeated validation failures. Keys are the
# card ``type`` values; values are validated in the card model tests.
CARD_EXAMPLES: dict[str, dict] = {
    # The one card whose shape is a GRAPH (ADR-0065): a container with id
    # "root" and the cards it holds, each referenced by id. The example is the
    # shape the COMPOSE rule in `cards/envelope.py` teaches, filled in.
    "surface": {
        "type": "surface",
        "title": "Zweiter Fluchtweg — zwei Varianten",
        "components": [
            {
                "id": "root",
                "component": "Tabs",
                "tabs": [
                    {"title": "Außentreppe", "child": "aussen"},
                    {"title": "Zweites Treppenhaus", "child": "innen"},
                ],
            },
            {
                "id": "aussen",
                "component": "Text",
                "text": (
                    "| Kriterium | Anforderung | Status | Fundstelle |\n|---|---|---|---|\n"
                    "| Abstand zu Öffnungen | ≥ 2,0 m | offen | [1] |\n"
                    "| Baustoff | A2 | erfüllt | [1] |"
                ),
            },
            {
                "id": "innen",
                "component": "Text",
                "text": (
                    "| Kriterium | Anforderung | Status | Fundstelle |\n|---|---|---|---|\n"
                    "| Wände des Treppenhauses | REI 90 | erfüllt | [1] |\n"
                    "| Rauchabzug | ≥ 1 m² | nicht erfüllt | [1] |"
                ),
            },
        ],
    },
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
    # Carries no file names on purpose — the renderer lists the project's real
    # models. The example exists to show that the payload is just a heading, so
    # the model does not try to fill in a `models` array that does not exist.
    "ifc_model_picker": {
        "type": "ifc_model_picker",
        "title": "Welches Modell möchten Sie öffnen?",
        "note": "Ein Klick öffnet das Modell im 3D-Viewer.",
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
    # The example the model copies has to make the one hard rule obvious: there
    # is NO result field. It shows the Schrittmaßregel because that is the
    # arithmetic every Austrian architect knows by heart — 2 × 17 + 30 = 64
    # against 59–65 — so a model that fills this in wrongly is visibly wrong,
    # and a reader who sees the card knows immediately what it is claiming to
    # have done. The rule's own multiplier rides as `factor` rather than as a
    # second operand, because 2 is part of the Bestimmung and not a quantity
    # anybody measured, and only a `factor` can say that.
    "calculation": {
        "type": "calculation",
        "title": "Schrittmaßregel – Treppenlauf Haus A",
        "steps": [
            {
                "label": "Schrittmaß",
                "operation": "sum",
                "unit": "cm",
                "operands": [
                    {
                        "label": "Steigung",
                        "value": 17.0,
                        "unit": "cm",
                        "factor": 2,
                        "provenance": "computed",
                        "tolerance": 0.5,
                        "source": "Einreichplan, Schnitt A-A",
                    },
                    {"label": "Auftritt", "value": 30.0, "unit": "cm", "provenance": "declared"},
                ],
            }
        ],
        "limit": {
            "comparator": "between",
            "value": 59,
            "upper": 65,
            "label": "Schrittmaßregel",
            "reference": {"document": "OIB-Richtlinie 4", "section": "Pkt. 3.2", "edition": "Ausgabe Mai 2023"},
        },
    },
}


def _card_type_of(card_cls: type) -> str:
    """The ``type`` literal of a card class (``"summary"``, …)."""
    return getattr(card_cls.model_fields["type"].annotation, "__args__", ("?",))[0]


@functools.lru_cache(maxsize=1)
def model_facing_card_types() -> frozenset[str]:
    """Every card ``type`` the ANSWERING model may be ASKED to produce.

    The union minus :data:`SYSTEM_CARD_TYPES`.
    It is exposed separately because other surfaces need to answer "may a
    skill/author name this card?" without parsing the rendered catalog text:
    the skills substrate validates ``grid-cards`` against it (see
    :mod:`aiq_agent.skills.models`), and the editor's picker derives the same
    set from the generated Zod schemas. One definition of "advertisable", so a
    new card type appears everywhere at once and a system card can never be
    requested by name.
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


def _is_discriminator(field_name: str, field_info: Any) -> bool:
    """Whether a field is a card's ``type`` tag — the one field the model never fills.

    A card's ``type`` is a single-value ``Literal`` that the union switches on;
    the shape already names it. A building block may have a field CALLED
    ``type`` that is a choice (``TypedColumn.type``: mass, norm, verdict, …),
    and that one is the model's to fill — the renderer hid it for a release
    while the validator required it, so every ``typed_table`` written from the
    shape failed on its first attempt.
    """
    if field_name != "type":
        return False
    return len(getattr(field_info.annotation, "__args__", ())) == 1


def _shape(model_cls: type, nested: list[type], *, with_desc: bool) -> str:
    """Render a model's fields as `{ name*: type (desc; constraints), ... }`."""
    parts: list[str] = []
    for field_name, field_info in model_cls.model_fields.items():
        if _is_discriminator(field_name, field_info):
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
        if _is_discriminator(field_name, field_info):
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
    """The FULL L2 entry for one card type — what a failed ``emit_card`` hands back.

    This used to be a one-line abbreviation of :func:`render_card_details`: the
    shape and its building blocks joined with "where", and the worked example
    appended after a full stop. The abbreviation was the problem. A model that
    had just got a field wrong was handed a denser rendering of the same
    information and no field rules at all, so its second attempt was a guess
    too, and the only way to actually learn a shape was a charged
    ``describe_card`` round trip the tool description had to talk it into paying
    in advance — on every turn, for every card, including the ones it would have
    filled in correctly.

    So the retry carries the whole thing instead: the same shapes, blocks,
    field rules and worked example ``describe_card`` returns, for the one type
    that failed. It is the cheapest moment to spend those tokens, because it is
    the only moment we know they are needed and know which type needs them.

    ``None`` for a type the model may not emit at all — an unknown name, a
    system card, a retired type. Teaching one of those a shape would be
    teaching a card the next validator refuses; the caller's refusal message
    names the right channel instead.

    A ``surface``'s entry is the COMPOSE rule (:func:`render_card_details`).
    """
    return render_card_details([card_type]) or None


def render_card_catalog(*, include_model_backed: bool = True, exclude: frozenset[str] = frozenset()) -> str:
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
        exclude: Further types to leave out (:data:`CHAT_ONLY_CARD_TYPES` on
            a path that is not the chat envelope).

    The system types are withheld unconditionally: a tool owns each one.
    """
    from aiq_agent.cards.models import GridCard

    withheld = SYSTEM_CARD_TYPES | exclude
    if not include_model_backed:
        withheld |= MODEL_BACKED_CARD_TYPES

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

    interactive_note = _interactive_note()
    measured_note = _measured_note()

    return (
        "Building blocks (reused object shapes):\n" + "\n".join(block_lines) + "\n\n"
        "Card types:\n" + "\n".join(card_lines) + interactive_note + measured_note + _plain_text_note() + "\n\n"
        "Worked examples (copy the nesting exactly):\n" + examples
    )


def _interactive_note() -> str:
    # Consent cards ASK THE USER TO AUTHORIZE A REAL WRITE, so they cost the
    # user a decision rather than just screen space. Say so explicitly: without
    # it the model treats them like any other presentational card and emits them
    # speculatively, which turns the answer into a pile of consent prompts.
    # System cards are excluded here for the same reason they are excluded above
    # — the model must not learn they exist.
    interactive = sorted(INTERACTIVE_CARD_TYPES - SYSTEM_CARD_TYPES)
    return (
        "\n\nCards that ask the user to CONFIRM something (" + ", ".join(f'"{t}"' for t in interactive) + "):\n"
        "  These are not presentation — they ask the user to authorize a real, persisted change, and\n"
        "  their answer is remembered. Emit one only when you have a SPECIFIC change worth interrupting\n"
        "  for, grounded in something the user actually said in this conversation. At most one per turn.\n"
        "  Never emit one speculatively, to ask a question you could ask in prose, or to restate a\n"
        "  change the user already confirmed."
        if interactive
        else ""
    )


def _measured_note() -> str:
    # A number on a card outlives the sentence next to it. The card is what gets
    # screenshotted into a submission, so it is the surface most likely to be
    # forwarded without the qualifier that made it true — which is why the rule
    # is stated here rather than left to the field descriptions alone.
    return (
        "\n\nNumbers that came from a MEASUREMENT (`ifc_measure`):\n"
        "  Every ifc_measure answer says HOW it was obtained. When you put one of its numbers on a\n"
        "  card, carry that with it — on DimensionCheck, set `provenance` to the answer's own\n"
        "  provenance, and for a 'computed' one set `tolerance` to the ± band in the SAME unit.\n"
        "  Copy them; never infer them. Marking our own measurement 'declared' turns our tolerance\n"
        "  into the architect's claim, and a measured dimension shown without its band reads as\n"
        "  exact — which is what decides whether 2.47 m clears a 2.50 m minimum.\n"
        "  Leave both null for a number that did not come from the model: a figure the user typed,\n"
        "  or a limit read out of the Bestimmung. Null means 'not stated', never 'declared'.\n"
        "  When the answer came back `decidable: false`, the dimension is status 'needs_input' with\n"
        "  `value` null and `missing` set to that answer's missing.remedy, VERBATIM — that sentence\n"
        "  is what the architect changes in their CAD. A blank slot instead of it reads as a fact\n"
        "  about the building, when it is a finding about the export."
    )


def _plain_text_note() -> str:
    # Rides with the SHAPES rather than with the doctrine, for the same reason
    # the measured-numbers rule does: it is a rule about filling a field in, and
    # the doctrine is paid on every turn whether or not a card is ever emitted
    # (see `register._build_tool_description`). A model that has just been handed
    # the shapes is the one about to write these strings.
    #
    # The validator in `cards.models.CardModel` strips these delimiters anyway,
    # so nothing here is load-bearing for correctness — it is here so the field
    # holds what the model meant instead of the wreckage of a link the model
    # should never have written. A card once shipped
    # „[OIB-Richtlinie ansehen](https://www.oib.or.at/de/oib-richtlinien)“ into a
    # field beside the card's OWN working link to that same page.
    return (
        "\n\nEvery text field is PLAIN TEXT:\n"
        "  No card renders markdown. Write the words, not the markup — no [text](url) links, no\n"
        "  **bold**, no `code`. A card that needs a link to its source already has one: the card\n"
        "  builds it from the fields you filled in, so writing one yourself adds a second, unchecked\n"
        "  claim next to the checked one."
    )


def _render_trigger_table(*, include_ifc_triggers: bool, include_craft: bool) -> str:
    """The head, then one row per trigger with its craft indented beneath it."""
    rows = (*_CARD_TRIGGERS, _MODEL_PICKER_ROW) if include_ifc_triggers else _CARD_TRIGGERS
    lead = (
        "The trigger, the card, and under it what fills that card well:"
        if include_craft
        else "The trigger, then the card:"
    )

    lines = [_CARD_TRIGGER_HEAD, lead]
    for trigger, card, craft in rows:
        # ljust reproduces the aligned arrow column for the short triggers and
        # gets out of the way for the long ones, which run past it anyway.
        lines.append(f"  {trigger.ljust(40)} -> {card}")
        if craft and include_craft:
            lines.append(textwrap.fill(craft, width=99, initial_indent=" " * 6, subsequent_indent=" " * 6))

    return "\n".join(lines)


def render_card_doctrine(*, include_ifc_triggers: bool = True, include_craft: bool = True) -> str:
    """Markdown first, the trigger table, the craft that fills each card, and the negative default.

    Framing-free in the same sense as :func:`render_card_catalog`: it says which
    content takes which card, how that card is filled well, and when to emit
    none, and leaves each surface to add what only it can promise — where a
    marker puts a card, or what a batch of them may be built out of.

    Args:
        include_ifc_triggers: Whether to carry the ``ifc_model_picker`` row and
            its note. The ``emit_card`` tool leaves this on. Post-hoc generation
            turns it off: that trigger is a live "show me the model" intent in
            the turn being answered, and it directs the model to emit the card
            instead of writing the file names as prose — a trade only a surface
            that is still writing the answer can make. The picker's SHAPE is not
            withheld anywhere, because it names no file and invents nothing.
        include_craft: Whether each row carries the paragraph that says how that
            card is filled well. The ``emit_card`` tool leaves this on — it is
            the whole point of the tool owning its own contract. Post-hoc
            generation turns it off and states its own short craft instead
            (``prompt.py``): half of what is written here is an instruction
            about an answer still being written, which that path cannot act on.

    MARKDOWN FIRST leads on every surface: what the retired cards carried
    (:data:`RETIRED_CARD_TYPES`) is written in the answer's own Markdown.
    """
    table = _render_trigger_table(include_ifc_triggers=include_ifc_triggers, include_craft=include_craft)
    return "\n\n".join((_MARKDOWN_FIRST, table, _CARD_HONESTY, _CARD_RESTRAINT))


def render_card_index(*, include_model_backed: bool = True, exclude: frozenset[str] = frozenset()) -> str:
    """L1: one line per card type — name and purpose, no shapes, no examples.

    The always-on half of the card vocabulary. Rendering every shape and worked
    example costs ~5,200 tokens on EVERY turn whether or not a card is ever
    emitted, and each new card type adds ~190 to that permanently — the exact
    "load everything upfront" failure that dilutes attention on a long turn and
    scales linearly with a vocabulary we intend to keep growing.

    An index plus :func:`render_card_details` on demand costs ~580 tokens and
    ~23 per new type. The reasoning is already written down one module over, on
    ``_preferred_cards_block``: a card description is worth nothing until the
    card is actually in play.

    The system types are withheld unconditionally: a tool owns each one.
    """
    from aiq_agent.cards.models import GridCard

    withheld = SYSTEM_CARD_TYPES | exclude
    if not include_model_backed:
        withheld |= MODEL_BACKED_CARD_TYPES

    lines: list[str] = []
    for card_cls in GridCard.__args__:
        type_value = _card_type_of(card_cls)
        if type_value in withheld:
            continue
        doc = (card_cls.__doc__ or "").strip().split("\n")[0]
        lines.append(f'  - "{type_value}": {doc}')

    return "Card types:\n" + "\n".join(lines) + _interactive_note()


def card_index_entries(
    *, include_model_backed: bool = False, exclude: frozenset[str] = frozenset()
) -> list[tuple[str, str]]:
    """``(type, first docstring line)`` per content card the answering model may emit.

    The same rows :func:`render_card_index` prints, as data: what a decision
    over "which card would this answer earn" (``agents/piloti/decisions.py``)
    needs as its criteria, without parsing the rendered index back.
    """
    from aiq_agent.cards.models import GridCard

    withheld = SYSTEM_CARD_TYPES | exclude
    if not include_model_backed:
        withheld |= MODEL_BACKED_CARD_TYPES
    entries: list[tuple[str, str]] = []
    for card_cls in GridCard.__args__:
        type_value = _card_type_of(card_cls)
        if type_value in withheld:
            continue
        entries.append((type_value, (card_cls.__doc__ or "").strip().split("\n")[0]))
    return entries


def render_card_details(card_types: Iterable[str]) -> str:
    """L2: the exact shape, building blocks and worked example for named types.

    Unknown and system types are skipped rather than raising: this is fed from
    a model-supplied name and from skill metadata, and a stale name must not
    take down the turn that mentioned it.
    """
    from aiq_agent.cards.models import GridCard

    by_type = {_card_type_of(c): c for c in GridCard.__args__}
    withheld = SYSTEM_CARD_TYPES
    wanted = [t for t in dict.fromkeys(card_types) if t in by_type and t not in withheld]
    # A surface's entry is the rule the answer contract teaches it by, worked
    # example included: its `components` renders as a list of objects nobody
    # could fill in, and the generic rules below (plain text, no Markdown)
    # contradict its `Text` leaves.
    compose = ""
    if "surface" in wanted:
        from aiq_agent.cards.envelope import compose_rule  # envelope imports this module

        wanted.remove("surface")
        compose = compose_rule()
    if not wanted:
        return compose

    nested: list[type] = []
    card_lines = [f'  - "{t}"\n      shape: {_card_shape(by_type[t], nested)}' for t in wanted]

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
        f"  {t}:\n    {json.dumps(CARD_EXAMPLES[t], ensure_ascii=False)}" for t in wanted if t in CARD_EXAMPLES
    )

    out = ""
    if block_lines:
        out += "Building blocks (reused object shapes):\n" + "\n".join(block_lines) + "\n\n"
    out += "Card types:\n" + "\n".join(card_lines)
    # The provenance rule only applies where a DimensionCheck can carry one, so
    # it rides with the shapes that have the field rather than with every card.
    if any("DimensionCheck" in line for line in block_lines + card_lines):
        out += _measured_note()
    # Unconditional, unlike the provenance rule: every card type here has text
    # fields, so there is no shape this one fails to apply to.
    out += _plain_text_note()
    if examples:
        out += "\n\nWorked examples (copy the nesting exactly):\n" + examples
    if compose:
        out += "\n\nA surface's `Text` leaf is the one exception to plain text: it holds Markdown.\n\n" + compose
    return out

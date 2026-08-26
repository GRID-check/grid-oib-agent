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
from collections.abc import Iterable
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic_core import PydanticUndefined

# Card types the MODEL MAY NOT EMIT. They remain valid union members for
# validation/serialization/rendering — every card ever stored keeps parsing and
# keeps rendering — and only their description in the model-facing catalog is
# suppressed. Every emission path reads this set: `emit_card`
# (`cards/register.py`), post-hoc batch generation (`validate_cards` in
# `cards/models.py`) and the DSML salvage (`shallow_researcher/dsml.py`).
#
# Two kinds of member, one mechanism:
#
#   * SYSTEM-emitted — a tool on a sanctioned path owns the card and the model
#     must not be able to fabricate it (`memory_proposal` from `remember`,
#     `document_grid` from `surface_documents`).
#   * RETIRED — the content moved off the card path entirely and the card only
#     survives so that stored ones keep rendering. `follow_ups` is the first:
#     the post-answer `follow_ups` STAGE now computes the questions after the
#     answer is written, gated by deterministic Python rather than by the
#     model's opinion of its own answer, and delivers them as a
#     `grid_stage_message` frame rendered BELOW the answer
#     (`aiq_agent/stages/follow_ups.py`, docs/architecture/post-answer-stages.md
#     §7.10). An old thread still renders its stored chips inside the answer
#     where they were; a new one renders them below it.
#
# Retiring rather than deleting is deliberate and is what this constant is for:
# dropping the type from the union would make `validateGridCards`
# (`shared/cards/schemas.ts`) reject every stored `follow_ups` card, so every
# historical thread would lose its chips and log a warning per card.
SYSTEM_CARD_TYPES = frozenset({"memory_proposal", "document_grid", "follow_ups"})

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
#
# `diagram` was briefly a member and is deliberately not one. It was added for a
# filing button beside the drawing („Im Projekt ablegen" → two `documents` rows),
# and the release review cut that button from v1: the card SHOWS a drawing and
# offers nothing, so there is no answer to persist. The route, the SVG validator,
# the PDF conversion and migration 0065 stay in the tree unreached, and the day
# the button comes back this set is the first thing that has to change — together
# with `CARD_INTERACTIVITY` in `card-decision.ts`, which
# `tests/aiq_agent/cards/test_interactive_card_parity.py` holds to this one.
#
# There is no second set here (a `CONSENT_CARD_TYPES` briefly existed for the
# same reason and left with the button). "Must the frontend persist an answer?"
# and "does emitting it cost the reader a decision?" only ever named different
# sets while `diagram` sat between them, and two constants that are equal by
# construction are two things to keep in sync, of which one stops being
# maintained. A card that is genuinely one and not the other is the reason to
# split them again — and then the split has to be argued at that card.
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

# The shared card DOCTRINE: which trigger takes which card, and when to emit none.
#
# It lives here, with the shapes, because BOTH surfaces that ask a model for a card need it and
# neither may hold its own copy. "Emit a card only when it adds real value" was the whole
# instruction once, and fifteen working diagram renderers sat unused behind it, because a
# disclaimer is not an instruction. A second copy of the cure is a second thing to keep in sync,
# and the copy that stops being maintained is the one that goes back to being a disclaimer.
#
# Only what is true on BOTH surfaces belongs here. The `[[card:N]]` placement contract is tool
# mechanics and stays in `register.py`: post-hoc generation is handed a finished report, so it has
# no answer to place a marker into. The CRAFT — which of the generic cards actually improves an
# ordinary answer — lives in the `piloti-cards` platform skill for the answering agents, and in a
# post-hoc-truthful short form in `prompt.py` for the batch generator, which has no skill runtime.
#
# The HEAD of this table is calibrated, and both directions of miscalibration have now been seen in
# the field. It once said "an answer that turns on a DIMENSION gets its card by default" — a default
# scoped to six of the twenty-odd rows below, which left `process_map` matching its trigger almost
# word for word and still coming back as a numbered prose list. Generalising that default is the
# fix, and the first attempt at it overcorrected: "a match IS a card, by default and unasked", plus
# an instruction that not emitting was an exception needing a justification, read as an obligation
# across every row. The product owner's reading of the fleet is that emission is broadly fine, so
# the general rate was never the problem and pushing on it can only buy restatement — the one thing
# anti-goal D.8 exists to forbid.
#
# So a match is a REASON, not an obligation, and the clause about carrying more than the sentence
# beside it puts the restatement test in the invitation itself rather than leaving it all to
# `_CARD_RESTRAINT`. The cards actually observed missing are pushed where it costs nothing
# general: `process_map` (and `calculation`, `callout`, `key_takeaways`) by the "Emit for …"
# imperative each already carries in the always-on L1 index. `follow_ups` was the other one and it
# is no longer a card the model emits at all — it moved to the post-answer stage, so its push, its
# rule and its trigger row all left with it.
#
# The NAMING clause is the one thing the dial-back took out that had to come back. Its predecessor
# read "if you can NAME the card that fits, emit it: knowing which one fits and writing the answer
# as prose anyway is this tool's one failure mode" — and it went out with the obligation framing it
# happened to sit next to, which is why it is restated here on its own. It carries no duty; it
# closes a gap the rest of the table cannot reach. Every other sentence here is about RECOGNISING
# the card, and the two transcripts that produced this pass show recognition working and emission
# not following it: asked again in plainer words, the model named the right card and built it well
# on the first attempt. The step being lost is between knowing and doing, so that is the step this
# sentence names — not "you must", but "you have already decided".
_CARD_TRIGGER_TABLE = """\
WHEN TO EMIT ONE. This table maps content to card. A row that matches your answer is a reason to
reach for that card rather than mere permission — a measurement, an ordered Verfahren or a set of
criteria written out as prose makes the reader rebuild in their head what the card would have
shown them. Emit it where the match is clear and the card
carries more than the sentence beside it. Naming the card IS the decision: once you can say which
card this answer is, emitting it is the step that follows, not a second judgement.
The trigger, then the card:
  a riser, tread or stair width            -> stair_diagram
  a clear width, ramp or turning circle    -> dimension_diagram
  an escape route with segments            -> egress_diagram
  a fall height, railing or opening        -> guardrail_check
  a U-value, HWB or energy class           -> thermal_envelope / energy_performance
  a fire compartment area                  -> fire_compartment
  the Richtlinie or norm the answer rests on -> legal_basis
  a chain of norms, one binding, the rest interpreting -> norm_chain
  three or more pass/fail criteria         -> requirement_checklist
  two or more options weighed against each other -> comparison_table
  the answer's single headline number or ruling, at the top -> verdict_header
  an answer turning on ONE factor whose cases exclude each other, at most one of them the reader's -> condition_tree
  rows that are all true at once (parts of one building, not cases of one project) -> typed_table
  a tabular answer no purpose-built card covers -> typed_table
  a number the answer WORKED OUT rather than looked up -> calculation
  a Verfahren, Ablauf or „wie läuft das ab" -> process_map
  ANY ask for a Diagramm, Schaubild, Grafik, chart or mermaid — and any path that forks and REJOINS -> diagram
  „welche Unterlagen brauche ich" — the list is STATES, not names -> document_checklist
  several Fristen in sequence — the order and what starts each clock is the answer -> deadline_timeline
  „was passiert, wenn X sich ändert" — what a move COSTS, not which case applies -> change_impact
  the two to five points the reader must leave with -> key_takeaways
  one caveat, deadline or tip that changes what the reader DOES -> callout"""

# The picker's trigger, not its shape. The shape stays in the catalog on every surface — the card
# carries a heading and nothing else, so there is no id to invent (which is why it is not, and must
# not become, a member of MODEL_BACKED_CARD_TYPES). What does not transfer is the instruction: it
# fires on a live intent in the turn being answered, and it tells the model to emit the card
# INSTEAD of writing the file names in prose. On the post-hoc path the prose is already written and
# cannot be unwritten, so that trade is not on offer.
_MODEL_PICKER_TRIGGER = """
  the user wants to SEE or OPEN the building and the project may hold several models
                                           -> ifc_model_picker"""

# `_FOLLOW_UPS_RULE` stood here. It is gone rather than moved: the post-answer
# `follow_ups` stage carries what it said, and the two exceptions it named
# ("a conversational or off-topic turn" / "an answer that already ends by asking
# the user something") became GATE CONDITIONS in `stages/follow_ups.py` —
# `routing_meta`, `intent_out_of_scope` and `answer_ends_in_question` — because a
# condition the gate enforces is a number on a dashboard while the same condition
# in a prompt is a hope. Nothing on the card path needs it any more: the model
# cannot emit the card at all (`SYSTEM_CARD_TYPES` above).

_MODEL_PICKER_NOTE = """\
The ifc_model_picker is the answer to "zeig mir das Modell" / "welches Modell soll ich öffnen":
emit it INSTEAD of writing the file names as a prose bullet list. It renders the project's models
as tiles the user clicks to open the viewer directly — you supply only the heading, never the file
names, so there is nothing to get wrong. You do not need to call ifc_query first to list them."""

# The anti-fabrication rule: the reason a card can be worse than no card at all, and the ONE
# instruction here that outranks a trigger. It is stated on its own, away from the volume rule,
# because the two were one paragraph and read as one mood — and a model that discounts "two is
# plenty" as tone discounts "never fabricate" with it. Both surfaces pay for this one; the post-hoc
# path states it a second time, in stronger terms, because there it is the only thing standing
# between a report and an invented limit (see `prompt.py`).
_CARD_HONESTY = """\
WHAT MAY GO ON ONE. Never fabricate a field, a reference or a number to fill a card out — a card
with an invented limit in it is worse than the prose alone, because it is the part that gets
screenshotted into a submission. A value you do not have is left out or marked "needs_input", never
estimated to make the card look finished. This rule outranks every trigger above."""

# The volume rule, and only that — a CEILING, said as a ceiling. It briefly read as "a budget and
# it is there to be SPENT", which is the one framing this rule must not have: the charter names
# this constant as where anti-goal D.8 ("no card that restates the prose beside it") is enforced,
# and a rule that invites spending cannot enforce a restatement veto. What it keeps from that pass
# are the two cases where none is right.
#
# The `follow_ups` exemption ("follow_ups does not count against it") went with the card. It existed
# to stop a model spending one of its two slots on the chips; a model that cannot emit them has
# nothing to exempt, and a clause naming a card the catalog no longer describes is an invitation to
# go looking for it.
#
# The restatement veto is real and it stays. What it needed was a SCOPE, because as written it read
# on the wrong cases: an answer whose prose already enumerates its cases shares every fact with the
# card that would show them, so "says what the prose says" vetoed exactly the answers a card helps
# most. Both field transcripts are that shape. The discriminator is form against facts — a table of
# three Lagen with their Anforderung and Fundstelle is not three sentences said again, it is three
# sentences the reader no longer has to align by hand — so sharing facts with the paragraph is
# stated here as never sufficient on its own. Same words in the same shape still loses the card.
#
# It no longer carries the anti-fabrication rule, which moved to `_CARD_HONESTY`: sharing a
# paragraph meant a model discounting "two is plenty" as tone discounted "never fabricate" with it.
_CARD_RESTRAINT = """\
WHEN NOT TO. Two content cards is a turn's ceiling and one is often the right number.
None is right in two cases: a one-line factual answer, where the card
only repeats the sentence above it, and a card that would say what the prose beside it
says in the same words — cut the card, keep the sentence. That second case is about FORM, not
facts: three Lagen with their Anforderung and Fundstelle as a table is not a restatement of three
sentences, it is the same facts in a shape prose cannot hold. Shared facts alone never cut a card."""

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
    # `lane` and `edition` are the whole reason this card carries an example.
    # Neither is guessable from the shape line alone: `lane` is a controlled
    # vocabulary whose members read as opaque keys, and `edition` is the field
    # that separates a citation an architect can look up from one they cannot.
    "legal_basis": {
        "type": "legal_basis",
        "law": "OIB-Richtlinie 2",
        "lane": "baurecht_oib",
        "edition": "Ausgabe Mai 2023",
        "article": "3.1.1",
        "section": "Tabelle 1a",
        "summary": "Die maximale Brandabschnittsfläche für oberirdische Geschosse in GK 4 beträgt 1.200 m².",
        "original_text": (
            "Brandabschnitte dürfen eine Nettogrundfläche von höchstens 1.200 m² und eine "
            "Längenausdehnung von höchstens 60 m aufweisen."
        ),
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
    "verdict_header": {
        "type": "verdict_header",
        "verdict": "1,10 m",
        "subject": "Erforderliche Geländerhöhe",
        "reference": {"document": "OIB-Richtlinie 4", "section": "Pkt. 4.3", "edition": "Ausgabe Mai 2023"},
        "confidence": "high",
    },
    "condition_tree": {
        "type": "condition_tree",
        "title": "Erforderliche Feuerwiderstandsklasse tragender Bauteile",
        "question": "Gebäudeklasse",
        "branches": [
            {"condition": "GK 1–3", "outcome": "REI 30 (bzw. R 30)"},
            {"condition": "GK 4", "outcome": "REI 60", "active": True},
            {"condition": "GK 5", "outcome": "REI 90"},
        ],
        "reference": {"document": "OIB-Richtlinie 2", "section": "Tabelle 1b", "edition": "Ausgabe Mai 2023"},
    },
    "typed_table": {
        "type": "typed_table",
        "title": "Mindestmaße barrierefreie Erschließung",
        "columns": [
            {"label": "Bauteil", "type": "text"},
            {"label": "Mindestmaß", "type": "mass"},
            {"label": "Grundlage", "type": "norm"},
            {"label": "Erfüllt", "type": "verdict"},
        ],
        "rows": [
            ["Türdurchgangsbreite", "90 cm", "ÖNORM B 1600 Pkt. 5.1", "erfüllt"],
            ["Rampenneigung", "6 %", "OIB-Richtlinie 4 Pkt. 3.2", "nicht erfüllt"],
        ],
        "reference": {"document": "ÖNORM B 1600", "edition": "Ausgabe 2020"},
    },
    "norm_chain": {
        "type": "norm_chain",
        "title": "Normenkette – Absturzsicherung",
        "links": [
            {
                "label": "Wiener Bautechnikverordnung",
                "rank": "verordnung",
                "note": "erklärt die OIB-Richtlinien für verbindlich",
            },
            {"label": "OIB-Richtlinie 4", "rank": "oib_richtlinie", "note": "regelt die erforderliche Geländerhöhe"},
            {"label": "ÖNORM B 1600", "rank": "oenorm", "note": "konkretisiert die barrierefreie Ausführung"},
        ],
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
    # The `detail` is the field this example exists for: without one to copy,
    # the model writes the qualification into `text` and the block stops being
    # scannable, which is the only thing this card is for. Note the third
    # takeaway carries none — a takeaway that needs no footnote should not get
    # an expander that opens onto a restatement.
    "key_takeaways": {
        "type": "key_takeaways",
        "title": "Gebäudeklasse 4 – was daraus folgt",
        "items": [
            {
                "text": "Fluchtniveau 9,80 m → Gebäudeklasse 4",
                "detail": "Maßgeblich ist das oberste Fluchtniveau; die Grenze zu GK 5 liegt bei 11 m.",
            },
            {
                "text": "Tragende Bauteile mindestens REI 60",
                "detail": "In Kellergeschossen gilt REI 90, unabhängig von der Gebäudeklasse.",
            },
            {"text": "Barrierefreier Aufzug ab drei oberirdischen Geschossen"},
        ],
    },
    # Shows the shape at its smallest useful size — a kind, one sentence, and
    # the background folded behind it. A title is deliberately absent: the
    # example the model copies should not suggest that every callout needs one.
    "callout": {
        "type": "callout",
        "kind": "frist",
        "text": "Die Bauverhandlung ist binnen sechs Wochen nach Einreichung anzuberaumen.",
        "detail": "Die Frist ruht, solange die Behörde eine Ergänzung des Einreichplans verlangt hat.",
    },
    # The example carries the two properties that decide whether this card is
    # worth a click: every question names something the answer itself put on the
    # table (das Fluchtniveau, die GK-4-Einstufung, REI 60), and the four are
    # four DIFFERENT moves — measure it, apply it to my project, compare the
    # neighbouring class, act on it. Four rewordings of "Wie ist das mit der
    # Gebäudeklasse?" would validate just as happily, which is exactly why the
    # example has to show the spread rather than describe it. Note also that
    # every `question` is a full sentence with a question mark: it is sent as
    # written, so a topic label would arrive in the composer as a fragment.
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
    # Two things this example exists to teach. The steps carry their `requires`
    # and `produces` — a map that only names the stations is the numbered list
    # it replaces, and the click then opens onto nothing. And `current_step` is
    # SET here, so the model sees that a project's position is a field it may
    # fill; the description is where it learns to omit it rather than guess.
    "process_map": {
        "type": "process_map",
        "title": "Baubewilligungsverfahren – Wien",
        "current_step": 2,
        "steps": [
            {
                "label": "Einreichung",
                "summary": "Einreichunterlagen werden bei der Baubehörde eingebracht.",
                "actor": "Bauwerber",
                "requires": ["Einreichplan", "Baubeschreibung", "Energieausweis"],
                "produces": ["Aktenzeichen"],
                "reference": {"document": "Wiener Bauordnung", "section": "§ 63"},
            },
            {
                "label": "Bauverhandlung",
                "summary": "Mündliche Verhandlung mit den Nachbarn und den Amtssachverständigen.",
                "actor": "Baubehörde",
                "duration": "binnen sechs Wochen nach Einreichung",
                "produces": ["Verhandlungsschrift"],
                "reference": {"document": "Wiener Bauordnung", "section": "§ 70"},
            },
            {
                "label": "Baubewilligung",
                "summary": "Bescheid mit den Auflagen aus der Verhandlung.",
                "actor": "Baubehörde",
                "produces": ["Baubewilligungsbescheid"],
            },
            {
                "label": "Baubeginnsanzeige",
                "summary": "Baubeginn ist der Behörde anzuzeigen.",
                "actor": "Bauwerber",
                "requires": ["rechtskräftige Baubewilligung"],
            },
            {
                "label": "Fertigstellungsanzeige",
                "summary": "Nach Fertigstellung mit den Ausführungsbestätigungen.",
                "actor": "Bauwerber",
                "requires": ["Ausführungsbestätigungen der Fachplaner"],
            },
        ],
        "reference": {"document": "Wiener Bauordnung", "section": "§§ 60 ff."},
    },
    # The list this replaces is a row of names, so the example has to be a row
    # of STATES: two documents that are always required, one that is only needed
    # in a defined case (and says which), and one the conversation established
    # the reader already holds. Most entries carry NO `status` on purpose — an
    # example where every row is answered would teach the model to answer every
    # row, which is precisely the invention this card is shaped against.
    "document_checklist": {
        "type": "document_checklist",
        "title": "Einreichunterlagen – Neubau Wohngebäude, Wien",
        "items": [
            {
                "label": "Einreichplan",
                "requirement": "required",
                "issuer": "Ziviltechniker:in",
                "status": "present",
                "note": "dreifach, im Maßstab 1:100",
                "reference": {"document": "Wiener Bauordnung", "section": "§ 63 Abs. 1 lit. a"},
            },
            {
                "label": "Baubeschreibung",
                "requirement": "required",
                "issuer": "Ziviltechniker:in",
                "reference": {"document": "Wiener Bauordnung", "section": "§ 63 Abs. 1 lit. b"},
            },
            {
                "label": "Energieausweis",
                "requirement": "required",
                "issuer": "befugte Fachperson",
                "status": "missing",
                "reference": {"document": "OIB-Richtlinie 6", "section": "Pkt. 6", "edition": "Ausgabe Mai 2023"},
            },
            {
                "label": "Grundbuchsauszug",
                "requirement": "conditional",
                "condition": "nur wenn der Bauwerber nicht Eigentümer der Liegenschaft ist",
                "issuer": "Bauwerber",
            },
            {
                "label": "Gutachten der MA 19",
                "requirement": "conditional",
                "condition": "nur im Schutzzonenbereich oder bei einem Gebäude in einer Schutzzone",
                "issuer": "Baubehörde",
            },
        ],
        "reference": {"document": "Wiener Bauordnung", "section": "§ 63"},
    },
    # Three clocks that run from three different events — which is the whole
    # reason this is not four callouts. Every `period` is the Bestimmung's own
    # wording and every `starts_from` names the event, so the example cannot be
    # copied into a card carrying a date: the model sees „ab Zustellung" in the
    # slot where it might otherwise have written one.
    "deadline_timeline": {
        "type": "deadline_timeline",
        "title": "Fristen im Bauverfahren – Wien",
        "deadlines": [
            {
                "label": "Beschwerdefrist",
                "period": "binnen vier Wochen",
                "starts_from": "ab Zustellung des Baubewilligungsbescheids",
                "actor": "Nachbar oder Bauwerber",
                "consequence": "Der Bescheid wird rechtskräftig.",
                "reference": {"document": "VwGVG", "section": "§ 7 Abs. 4"},
            },
            {
                "label": "Geltungsdauer der Baubewilligung",
                "period": "binnen vier Jahren ist mit dem Bau zu beginnen",
                "starts_from": "ab Rechtskraft der Baubewilligung",
                "actor": "Bauwerber",
                "consequence": "Die Baubewilligung erlischt.",
                "reference": {"document": "Wiener Bauordnung", "section": "§ 74 Abs. 1"},
            },
            {
                "label": "Fertigstellungsanzeige",
                "period": "unverzüglich",
                "starts_from": "ab Fertigstellung des Bauvorhabens",
                "actor": "Bauwerber",
                "reference": {"document": "Wiener Bauordnung", "section": "§ 128"},
            },
        ],
    },
    # Two things this example teaches. Every consequence carries its OWN
    # Fundstelle, because that is the field the model is most tempted to hand up
    # to the card and leave off the rows. And one row is `unchanged` with a
    # `before` equal to its `after` — the answer to half of „was ändert sich" is
    # naming the requirement a planner expects to move and saying that it does
    # not. The lift row omits `before`, so the model sees that the current state
    # is optional where the conversation never established it.
    "change_impact": {
        "type": "change_impact",
        "title": "Fluchtniveau über 11 m – was sich ändert",
        "factor": "Fluchtniveau",
        "from_value": "7 bis 11 m",
        "to_value": "über 11 m",
        "consequences": [
            {
                "aspect": "Gebäudeklasse",
                "before": "GK 4",
                "after": "GK 5",
                "direction": "tightens",
                "reference": {"document": "OIB-Begriffsbestimmungen", "section": "Gebäudeklassen"},
            },
            {
                "aspect": "Feuerwiderstand tragender Bauteile",
                "before": "R 60",
                "after": "R 90",
                "direction": "tightens",
                "detail": "Die Anforderung gilt für die tragenden Bauteile der oberirdischen Geschoße.",
                "reference": {"document": "OIB-Richtlinie 2", "section": "Tabelle 1", "edition": "Ausgabe Mai 2023"},
            },
            {
                "aspect": "Aufzug",
                "after": "Aufzug erforderlich",
                "direction": "tightens",
                "reference": {"document": "OIB-Richtlinie 4", "section": "Pkt. 3", "edition": "Ausgabe Mai 2023"},
            },
            {
                "aspect": "Schallschutz zwischen den Wohnungen",
                "before": "DnT,w mindestens 55 dB",
                "after": "DnT,w mindestens 55 dB",
                "direction": "unchanged",
                "detail": "Der Schallschutz hängt an der Nutzung, nicht an der Gebäudeklasse.",
                "reference": {"document": "OIB-Richtlinie 5", "section": "Tabelle 1", "edition": "Ausgabe Mai 2023"},
            },
        ],
        "reference": {"document": "OIB-Begriffsbestimmungen", "section": "Gebäudeklassen"},
    },
    # The example has to teach the DISCRIMINATION, not the syntax: this is a
    # shape `process_map` cannot hold. Three parties hand an Akt back and forth
    # and the answer is who gives what to whom, which a rail of stations cannot
    # show. Note what it does NOT carry — no duration, no Frist, no measurement —
    # and note the caption, which says what the drawing leaves out rather than
    # repeating the title. The Fundstelle is the procedure's own, at the whole-
    # procedure altitude the process_map example already uses.
    "diagram": {
        "type": "diagram",
        "title": "Baubewilligungsverfahren – wer wem was übergibt",
        "diagram_type": "sequence",
        "source": (
            "sequenceDiagram\n"
            "  participant BW as Bauwerber\n"
            "  participant BB as Baubehörde\n"
            "  participant ASV as Amtssachverständige\n"
            "  BW->>BB: Einreichunterlagen\n"
            "  BB->>ASV: Befassung zur Begutachtung\n"
            "  ASV-->>BB: Gutachten\n"
            "  BB-->>BW: Verbesserungsauftrag\n"
            "  BW->>BB: ergänzte Unterlagen\n"
            "  BB-->>BW: Baubewilligungsbescheid"
        ),
        "caption": "Die Fristen zeigt die Grafik nicht — sie steht für die Reihenfolge der Übergaben.",
        "reference": {"document": "Wiener Bauordnung", "section": "§§ 60 ff."},
    },
    "follow_ups": {
        "type": "follow_ups",
        "items": [
            {"question": "Wie wird das Fluchtniveau genau gemessen?", "hint": "Messpunkt und Bezugsebene"},
            {"question": "Welche Anforderungen gelten für mein Projekt konkret?"},
            {"question": "Was wäre bei Gebäudeklasse 5 anders?", "hint": "Vergleich der beiden Klassen"},
            {"question": "Wie weise ich REI 60 im Einreichplan nach?"},
        ],
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

    interactive_note = _interactive_note()
    measured_note = _measured_note()
    # The diagram boundary rides with the shapes for the same reason the
    # measured-numbers rule does: it is a rule about filling a field in, and this
    # is the surface that renders every field.
    diagram_note = _diagram_note() if "diagram" not in withheld else ""

    return (
        "Building blocks (reused object shapes):\n" + "\n".join(block_lines) + "\n\n"
        "Card types:\n"
        + "\n".join(card_lines)
        + interactive_note
        + measured_note
        + diagram_note
        + _plain_text_note()
        + "\n\n"
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


def _diagram_note() -> str:
    # The BOUNDARY of the one card whose renderer cannot check it, stated where
    # the model reads it at the moment it is about to write a diagram — beside
    # the shape, exactly as the measured-numbers rule is. Not in the always-on
    # index, which has room for one line per type; and deliberately not left to
    # the `diagrams` skill either, because a skill body only reaches
    # the model if the model calls `use_skill`, while this text arrives with the
    # shape it cannot emit the card without.
    #
    # Fifteen schematic cards hold their invariant by having the renderer do the
    # geometry. This card has no such invariant available: mermaid text IS the
    # geometry. So the boundary is drawn around the SUBJECT — a drawing that
    # claims no measurement has nothing on it that can be measurably wrong — and
    # a rule about subject can only be carried in words.
    return (
        "\n\nWhat a `diagram` may draw, and what it may not:\n"
        "  This card is mermaid, and the source IS the geometry: nothing computes it, so nothing can\n"
        "  catch it being wrong. Draw only what makes NO dimensional claim — a Verfahrensablauf, an\n"
        "  Einreichungssequenz, a decision that forks and rejoins, a Zuständigkeits- or\n"
        "  Abhängigkeitskarte. Anything MEASURED — a section, a stair, an escape route, a fire\n"
        "  compartment, a setback — belongs to the schematic cards, where the renderer draws to scale\n"
        "  and cannot disagree with its own numbers. A mermaid box with „40 m\u201c typed inside it is\n"
        "  precisely the artefact those cards exist to prevent, and it is the one that gets\n"
        "  screenshotted into an Einreichung. Naming a threshold in a branch condition\n"
        "  („Fluchtniveau > 22 m\u201c) is not that artefact: it is a label the answer has already\n"
        "  grounded, and nobody reads a rounded rectangle as a section.\n"
        "  Four grammars are verified end to end: flowchart, sequence, state, pie. A journey is\n"
        "  refused before the reader sees it — mermaid emits a foreignObject element for it whatever\n"
        "  htmlLabels says, the SVG allow-list refuses that element, and the diagram degrades to its\n"
        "  own source text in the middle of your answer. The rest are untested through the PDF\n"
        "  converter, and a drawing that previews and then prints blank is worse than none.\n"
        "  At most ONE per answer. A diagram earns its place by showing a fork, an ordering or a\n"
        "  dependency that prose cannot hold; a decorative one in a compliance answer costs the\n"
        "  reader trust in every drawing beside it. Labels in the answer's language and in Sie-Form,\n"
        "  and no label may carry a claim the answer has not grounded — the drawing leaves the page\n"
        "  without the paragraph that qualified it.\n"
        "  When the user asks for a Diagramm, Schaubild or Grafik BY NAME, a drawing card answers\n"
        "  it — this one, or the purpose-built card whose shape fits (`process_map` for a line,\n"
        "  `condition_tree` for a fan). Never prose alone, never ASCII art, never a raw fence."
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
    # should never have written. A `legal_basis` card shipped
    # „[OIB-Richtlinie ansehen](https://www.oib.or.at/de/oib-richtlinien)“ into a
    # field beside the card's OWN working link to that same page.
    return (
        "\n\nEvery text field is PLAIN TEXT:\n"
        "  No card renders markdown. Write the words, not the markup — no [text](url) links, no\n"
        "  **bold**, no `code`. A card that needs a link to its source already has one: the card\n"
        "  builds it from the fields you filled in, so writing one yourself adds a second, unchecked\n"
        "  claim next to the checked one."
    )


def render_card_doctrine(*, include_ifc_triggers: bool = True) -> str:
    """The trigger table and the negative default, shared by both card surfaces.

    Framing-free in the same sense as :func:`render_card_catalog`: it says which
    content takes which card and when to emit none, and leaves each surface to
    add what only it can promise — where a marker puts a card, or what a batch
    of them may be built out of.

    Args:
        include_ifc_triggers: Whether to carry the ``ifc_model_picker`` trigger.
            The ``emit_card`` tool leaves this on. Post-hoc generation turns it
            off: that trigger is a live "show me the model" intent in the turn
            being answered, and it directs the model to emit the card instead of
            writing the file names as prose — a trade only a surface that is
            still writing the answer can make. The picker's SHAPE is not
            withheld anywhere, because it names no file and invents nothing.
    """
    parts = [_CARD_TRIGGER_TABLE + (_MODEL_PICKER_TRIGGER if include_ifc_triggers else "")]
    if include_ifc_triggers:
        parts.append(_MODEL_PICKER_NOTE)
    parts.extend((_CARD_HONESTY, _CARD_RESTRAINT))
    return "\n\n".join(parts)


def render_card_index(*, include_model_backed: bool = True) -> str:
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
    """
    from aiq_agent.cards.models import GridCard

    withheld = SYSTEM_CARD_TYPES if include_model_backed else SYSTEM_CARD_TYPES | MODEL_BACKED_CARD_TYPES

    lines: list[str] = []
    for card_cls in GridCard.__args__:
        type_value = _card_type_of(card_cls)
        if type_value in withheld:
            continue
        doc = (card_cls.__doc__ or "").strip().split("\n")[0]
        lines.append(f'  - "{type_value}": {doc}')

    return "Card types:\n" + "\n".join(lines) + _interactive_note()


def render_card_details(card_types: Iterable[str]) -> str:
    """L2: the exact shape, building blocks and worked example for named types.

    Unknown and system types are skipped rather than raising: this is fed from a
    model-supplied name and from skill metadata, and a stale name must not take
    down the turn that mentioned it.
    """
    from aiq_agent.cards.models import GridCard

    by_type = {_card_type_of(c): c for c in GridCard.__args__}
    wanted = [t for t in dict.fromkeys(card_types) if t in by_type and t not in SYSTEM_CARD_TYPES]
    if not wanted:
        return ""

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
    # Same conditional logic, one type instead of a building block: the boundary
    # is only instruction where the card it bounds is in play.
    if "diagram" in wanted:
        out += _diagram_note()
    # Unconditional, unlike the provenance rule: every card type here has text
    # fields, so there is no shape this one fails to apply to.
    out += _plain_text_note()
    if examples:
        out += "\n\nWorked examples (copy the nesting exactly):\n" + examples
    return out

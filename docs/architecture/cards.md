# Cards — the agent's rich-UI presentation layer

> How GRID's agent returns structured, rendered UI instead of plain prose when
> that serves the user better. See also [ADR-0012](../adr/0012-cards-as-rich-ui-layer.md).

## What a card is

A **card** is a typed, structured piece of an answer that the frontend renders as
rich UI rather than markdown. Cards are the agent's **presentation vocabulary** —
not a citations feature. The agent answers in markdown by default and emits a card
whenever structure helps the reader. `LegalBasisCard` is one instance; the set is
meant to grow.

## Current card types

Defined in `src/aiq_agent/cards/models.py` as a discriminated union (`GridCard`):

| Type | Purpose | Key fields |
|---|---|---|
| `SummaryCard` | A short overview / key points | `title`, `content`, `key_points` |
| `LegalBasisCard` | An OIB legal-basis citation | `law`, `article`, `section`, `summary`, `original_text` |
| `ProjectProfilePatchCard` | A proposed change to the project profile | JSON-Patch `ops` (restricted to `/facts`, `/goals`, `/unknowns`, `/assumptions`) + before/after preview |

`validate_cards()` validates against the union and drops null fields.

## How generation works

Card generation is a model-driven step in the chat workflow: after the graph
produces an answer, `ChatResearcherAgent._generate_cards(query, context)` prompts a
card LLM (`card_generator_llm`) with a schema-derived system prompt
(`cards/prompt.py` introspects the union so the prompt stays in sync with the
models), parses the JSON, and validates it. The result rides `ChatResponse.cards`,
which the monkeypatched WS handler lifts onto the top-level message so the frontend
reads it at `message.cards`.

Generation is **skipped when the turn only dispatched an async deep-research job**
(the answer is just the job stub — cards for the real answer belong to the job
pipeline).

## How cards render

The frontend validates the wire cards (`validateGridCards`) and renders them
through the `features/grid-cards/` component set — one renderer per card type.

## Design intent (why it's a layer, not a feature)

Adding a new card type should be: **define the model** (`cards/models.py`) → **add
a renderer** (`features/grid-cards/`). No pipeline surgery. That keeps the set open
to future types (requirement checklists, comparison tables, applicability panels)
without re-plumbing generation or transport.

## Card catalog

Three base cards plus fifteen **schematic** cards — programmatically-drawn technical
diagrams (SVG kit in `features/grid-cards/schematics/`, Rough.js sketch stroke).
The schematic cards emit **parameters only**; the renderer draws to scale and does
any geometry/ratio math. Every required limit carries a `NormReference`; unknown
values render "fehlende Angabe", never a guess. See
[ADR-0012](../adr/0012-cards-as-rich-ui-layer.md).

| `type` | Shows | Domain |
|---|---|---|
| `summary` | prose overview / key points | any |
| `legal_basis` | a cited OIB/norm excerpt | any |
| `project_profile_patch` | a reviewable profile change | intake |
| `building_section` | to-scale cross-section: storeys, ground line, Fluchtniveau/GK/Hochhaus markers | height / GK |
| `stair_diagram` | stair drawn to scale + 2R+G comfort + OIB 4 limits | stairs |
| `dimension_diagram` | door/ramp/corridor/turning-circle/threshold/parking schematic w/ dimension arrows | accessibility |
| `setback_plan` | top-down parcel + footprint + setback envelopes | site / Abstandsflächen |
| `egress_diagram` | traced Fluchtweg path, total length vs 40 m | fire / escape |
| `daylight_incidence` | window section + 45° free-light line + obstruction + glass-area ratio | daylight (OIB 3) |
| `guardrail_check` | railing elevation, height/opening/gap checks, Kletterschutz band | Absturzsicherung (OIB 4) |
| `density_check` | parcel + footprint, Bebauungsgrad/GFZ bars | zoning density |
| `fire_access_plan` | Feuerwehrzufahrt site plan, route/Aufstellfläche/80 m reach | fire access (OIB 2) |
| `acoustic_check` | direction-aware dB gauges (airborne ↑ / impact ↓) | Schallschutz (OIB 5) |
| `fire_compartment` | storey plan split into Brandabschnitte, each area vs the max Brandabschnittsfläche | fire compartments (OIB 2) |
| `thermal_envelope` | building-envelope section + per-component U-value bars | Wärmeschutz (OIB 6) |
| `energy_performance` | Heizwärmebedarf on the A++–G energy-class ladder + HWB/fGEE bars | Energieausweis (OIB 6) |
| `elevator_requirement` | served-storey stack + lift shaft, requirement verdict + cabin/door checks | barrier-free lift (OIB 4) |
| `parking_requirement` | slot grid (required vs provided) + count bars for cars/bikes | Stellplatznachweis (Bauordnung) |

The card-generation LLM is `card_llm` (config `reasoning_effort: medium`). Adding a
card type = define the Pydantic model (`cards/models.py`), regenerate the schema
(`scripts/generate_card_schema.py` → `npm run generate:cards`), add a renderer, and
wire the `GridCards` dispatcher. Next phases: a 3D massing card (three.js/R3F) and
the IFC/BIM viewer (`docs/roadmap/ifc-viewer-card-spec.md`).

## Known rough edges

- Card-generation logic is duplicated between `cards/generate.py` and the inline
  `ChatResearcherAgent._generate_cards` — candidate for consolidation.
- Deep-research (async job) answers do not yet carry cards end-to-end.
- A silent card-generation failure is currently indistinguishable from "no cards";
  emission should surface failures.

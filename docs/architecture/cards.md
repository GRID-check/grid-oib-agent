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
| `RequirementChecklistCard` | Several pass/fail criteria for one question, each with verdict + own norm reference | `title`, `items[]` (`label`, `status`, `detail`, `reference`), `reference`, `note` |
| `ComparisonTableCard` | Side-by-side comparison of a small number of options (columns) across criteria (rows) | `title`, `options[]`, `rows[]` (`label`, `values[]`, `highlight_index`), `recommendation`, `reference`, `note` |

`validate_cards()` validates against the union and drops null fields.

## How generation works

Cards are emitted by the answering agent itself via the **`emit_card` tool**
(`cards/register.py`): mid-turn, with full context, the agent calls the tool
whenever a structured element communicates better than prose. The tool
description is derived from the Pydantic union (including nested shapes and
worked examples per hard-to-nest type — see `_CARD_EXAMPLES`), the card is
validated against the shared schema, and pushed into the conversation-scoped
`CardRegistry`. The chat entrypoint snapshots that registry after the turn and
attaches the cards to `ChatResponse.cards`, which the monkeypatched WS handler
lifts onto the top-level message so the frontend reads it at `message.cards`.
(The older post-hoc "re-derive cards from the finished prose" LLM call in
`cards/generate.py` / `cards/prompt.py` remains as a fallback path.)

**System cards** (`SYSTEM_CARD_TYPES` in `cards/catalog.py`) are a variant the
**model must never fabricate**: `emit_card` refuses them and they are omitted
from the model-facing catalog. They are emitted only by a specific tool on a
sanctioned path, carrying **real** data:

- `memory_proposal` — emitted by the `remember` tool when an org-scoped memory
  write needs human confirmation.
- `document_grid` — emitted by the **`surface_documents`** tool
  (`cards/surface_documents.py`). When the user wants to *find or browse* their
  own material (a project they worked on, files on a topic, references for an
  idea), the answering agent calls the tool with a topic `query`; the tool runs
  a **deterministic vector search** over the in-scope project + Büroarchiv
  collections (never the base OIB corpus), aggregates one hit per file above a
  relevance floor, enriches each with its document-level summary + tags
  (metadata only — never full text) so the agent can introduce the results
  conversationally, and pushes a `document_grid` card of the **real** files.
  The frontend resolves each file name to its live document row and renders the
  raised "project-selector" preview cards (`DocumentPreviewCard`), which open
  the document via the shared `PdfViewerDialog`. This is the difference between
  *citing* a document and *surfacing* it for the user to open. See
  [ADR-0026](../adr/) for the source-kind doctrine the provenance chips follow.

## How cards render

The frontend validates the wire cards (`validateGridCards`) and renders them
through the `features/grid-cards/` component set — one renderer per card type.

## Design intent (why it's a layer, not a feature)

Adding a new card type should be: **define the model** (`cards/models.py`) → **add
a renderer** (`features/grid-cards/`). No pipeline surgery. That keeps the set open
to future types (requirement checklists, comparison tables, applicability panels)
without re-plumbing generation or transport.

## Card catalog

Five structured cards plus fifteen **schematic** cards — programmatically-drawn technical
diagrams (SVG kit in `features/grid-cards/schematics/`, Rough.js sketch stroke).
The schematic cards emit **parameters only**; the renderer draws to scale and does
any geometry/ratio math. Every required limit carries a `NormReference`; unknown
values render "fehlende Angabe", never a guess. See
[ADR-0012](../adr/0012-cards-as-rich-ui-layer.md).

| `type` | Shows | Domain |
|---|---|---|
| `summary` | prose overview / key points | any |
| `legal_basis` | a cited OIB/norm excerpt | any |
| `project_profile_patch` | a proposed Project Brief update (hard facts / assumptions) — Accept applies it via `POST /api/projects/{id}/profile/patches`, which wraps bare values with `user_confirmed` provenance and retires answered unknowns | intake / brief |
| `requirement_checklist` | pass/fail criteria list, per-item verdict + reference | any |
| `comparison_table` | options as columns, criteria as rows, optional per-row highlight + recommendation | any |
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
| `document_grid` *(system)* | a grid of REAL project/Büroarchiv files surfaced for browsing (thumbnail, provenance chip, summary), each opening the document | document discovery |

The card-generation LLM is `card_llm` (config `reasoning_effort: medium`). Adding a
card type = define the Pydantic model (`cards/models.py`), regenerate the schema
(`scripts/generate_card_schema.py` → `npm run generate:cards`), add a renderer, and
wire the `GridCards` dispatcher. A dev-only gallery at `/dev/cards`
(`src/app/dev/cards/page.tsx`, 404 outside development) renders every card type
with realistic fixtures for visual review; `/dev/document-grid` previews the
backend-free `document_grid` surfacing card. Both are captured by the screenshot
harness (`npm run screenshots`, see `docs/ux/visual-screenshots.md`).
For a system card emitted by a tool (`document_grid`), that tool must be added to
the agent's `tools:` list in the config (e.g. `shallow_research_agent`) and its
`_type` registered — see `surface_documents` in `configs/config_oib_openrouter.yml`. Next phases: a 3D massing card
(three.js/R3F) and the IFC/BIM viewer (`docs/roadmap/ifc-viewer-card-spec.md`).

## Known rough edges

- The post-hoc generation path (`cards/generate.py` / `cards/prompt.py`) is
  deliberately kept next to the `emit_card` tool: async deep-research jobs use
  it (`jobs/runner.py::_generate_grid_cards`) because the conversation-scoped
  `CardRegistry` behind `emit_card` does not exist inside a Dask worker.
- Async deep-research answers carry cards (generated post-hoc from the final
  report in the job runner); synchronous inline deep research (no Dask) does
  not yet.
- A silent card-generation failure is currently indistinguishable from "no cards";
  emission should surface failures.

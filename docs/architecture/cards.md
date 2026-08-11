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
| `IfcViewerCard` | The project's IFC model in 3D with findings highlighted on the real geometry (ADR-0045) | `title`, `model_file`, `highlights[]` (`global_ids` **XOR** `match`, plus `label`, `status`), `storey`, `note` |
| `IfcScheduleCard` | The Raumbuch, optionally for one storey | `title`, `model_file`, `storey`, `note` |
| `IfcElementCard` | One element with its own property sets and quantities | `title`, `global_id`, `model_file`, `note` |
| `IfcDiffCard` | What changed between two revisions | `title`, `base_model_file`, `model_file`, `note` |
| `IfcComplianceCard` | The Prüfbuch: OIB requirements with their verdict | `title`, `model_file`, `rule_ids[]`, `note` |

`validate_cards()` validates against the union and drops null fields.

### The four IFC cards carry identifiers, not numbers

`IfcViewerCard` is the only card that points at data the model did not supply:
`global_ids` must be IFC GlobalIds returned by `ifc_query` in the same turn. The
frontend resolves them against the loaded model and **reports how many did not
resolve** — colouring two of three walls while saying nothing would turn a
partly wrong answer into a confidently wrong picture. The model is named by FILE
NAME (the string `ifc_query` reports), never by id, so a hallucinated UUID is
not a failure mode it has.

`IfcComplianceCard` carries rule IDS and no verdicts, so an answer cannot state
that a requirement is met; the component runs the catalogue when it renders. Ids
that do not resolve are REPORTED rather than dropped — silently narrowing the
list would turn a hallucinated id into a shorter, cleaner-looking Prüfbuch,
which is the one direction that card must not fail in. It also carries the
orientation caveat inline, because a card leaves the page in a screenshot and
the caveat has to travel with it.

The four data cards go one step further: their payload is a file name, a
GlobalId or a pair of revisions **and nothing else**, and the component fetches
the figures from the model when it renders
(`features/grid-cards/components/IfcDataCards.tsx`). The agent therefore cannot
state a floor area, get a fire rating wrong or invent a delta, because it never
supplies one — the worst it can do is point at the wrong table, which is visible
immediately. That also keeps a card honest after the fact: re-open a
conversation a month later and the card shows the model as it is now, not as it
was summarised then.

Every row that names an element links into the model page at that element
(`buildModelHref`), so a card is a way *into* the building rather than a
screenshot of it. That includes both sides of a revision delta: the diff card
lists what was ADDED and what was REMOVED as openable rows, not only as counts
— a delta you cannot open is a number rather than an answer — and a removed
element links into the BASE revision, since it has no GlobalId in the new one.

The requirement card runs the catalogue with the project brief's facts
(`useProjectRuleFacts`), the same ones the model page uses. Without them the
fire-resistance rules stand down in chat and produce a verdict on the model
page, and the same building answers two ways depending on which surface it is
read from. It also renders the BCF download itself rather than leaving the path
to the answer text: the agent is told to repeat that URL, and a model asked to
reproduce a URL will eventually reproduce a wrong one. All five are `presentational` in `CARD_INTERACTIVITY`: sorting
a schedule, downloading its CSV or orbiting the viewport starts no commitment,
so there is nothing to persist on the message.

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

**Model-backed cards** (`MODEL_BACKED_CARD_TYPES` in `cards/catalog.py`) —
`ifc_viewer`, `ifc_element`, `ifc_compliance`, `ifc_schedule`, `ifc_diff` — are
a second, softer restriction, and they cut the other way: the model *may* emit
them, but only on the surface that can supply their contents. Every field that
identifies something in them is an IFC GlobalId, a rule id or a model file name,
all of which have to be **copied from an `ifc_query` row in the same turn**.

- `emit_card` advertises them in full. Its caller has the tool rows in context.
- **Post-hoc generation does not.** `cards/generate.py` is handed only the
  question and the finished answer TEXT, so the only ids available there are
  whatever survived into the prose — the rest would be invented, and an
  unresolvable GlobalId renders as a missing element, telling the user their
  model is broken when it is not. `build_card_generation_prompt()` therefore
  calls `render_card_catalog(include_model_backed=False)`, which withholds both
  the shapes *and* the worked examples.

`ifc_viewer` takes this a step further. A highlight group carries **either**
`global_ids` **or** `match` — and `match` is the same filter object the agent
already passed to `ifc_query`, replayed by the browser
(`features/bim/lib/card-highlights.ts` respells it into the query API's
`camelCase`, then `useBimHighlightGroups` walks the pages). An id list can only
carry what fits in the model's context, so a card about 420 external walls used
to colour the handful that were transcribed while the legend claimed the whole
set; a filter resolves against the model, so it is exact at any size and costs
the model nothing it has not already written. A group giving both is refused by
the Pydantic validator — the renderer would have to pick, and either choice
silently discards half the request.

Emitting one is not optional politeness: the shallow researcher's `<cards>`
block asks for the matching card by default on any answer that came from
`ifc_query`, and the tool description names which card goes with which
operation. Before that existed, all five renderers were reachable only if the
model happened to pick one unprompted out of the catalog — and the `ifc_query`
description actively steered it the other way, toward markdown element links.
The result was that a question about a 150 MB building was answered with three
lines of prose.

## How cards render

The frontend validates the wire cards (`validateGridCards`) and renders them
through the `features/grid-cards/` component set — one renderer per card type.

## Interactive cards: the answer MUST be persisted

> ⚠️ Full rationale: [ADR-0030](../adr/0030-interactive-card-decisions-persist-on-the-message.md).
> **Read this before adding, editing, or reviewing any card that has a button
> which writes something.**

Most cards are pure presentation: same payload in, same pixels out, nothing to
remember. **Two are not.** `project_profile_patch` and `memory_proposal` ask the
user to authorize a write (`propose, never auto-apply` —
`project-memory-design.md` §11.7), which makes the user's click the only place
that outcome exists.

If that click lives in component-local `useState`, it dies on reload — and
because the card *payload* persists perfectly, the card comes back looking
untouched, with a live button that applies the patch or writes the memory **a
second time**. Neither endpoint is idempotent. This is a data-integrity bug, not
a cosmetic one.

**The rule:** a decision on a card is conversation history, so it is stored on
the `ChatMessage` that owns the card — exactly like `isPromptResponded` for a
HITL prompt.

| piece | where |
|---|---|
| The stored decision | `ChatMessage.cardInteractions: Record<cardKey, { decision, decidedAt }>` |
| The closed set of outcomes | `CARD_DECISIONS` in `features/grid-cards/card-decision.ts` |
| Card identity within a message | `` cardKey(card, index) `` → `` `${type}-${index}` `` (also the React key) |
| Keeping keys honest mid-stream | `reconcileCardInteractions` — a streaming turn replaces `cards` wholesale, so a decision is kept only while the card at its index is byte-identical to the one it was made about |
| Read/write from a renderer | `useCardDecision(messageId, cardKey)` — not a hand-rolled `useState` (the hook keeps one mount-scoped fallback for when the store write cannot land) |
| → localStorage | the chat store's `persist` middleware (rides the message) |
| → Postgres | `_persistCardInteractions` → `PATCH /api/conversations/{id}/messages/{messageId}` → `messages.metadata.cardInteractions` |
| ← rehydrate | `server-message-mapper.ts` via `sanitizeCardInteractions` |

Server mirroring is **not** optional polish: a history rehydrated from the
server (localStorage quota wipe, new device) is precisely the path that would
otherwise resurrect a settled card as pending. `mergeMessageMetadata` merges the
map **per card key**, so a second client PATCHing the decisions it knows about
cannot erase one it never saw.

**Scope today:** cards rendered in a chat answer. The deep-research **report**
panel is deliberately not wired — its cards come from transient
`deepResearchCards` with no reliable owning message id, and recording a decision
onto the wrong message is worse than not recording one. ADR-0030 §Open Questions
lists what has to change first.

Transient state stays local — a submit spinner, a request error, an open preview
dialog. Those describe an *attempt*, not a *decision*.

### Is my new card interactive?

Yes, if answering it **starts a commitment that is not safely repeatable**: an
API write, a store mutation, a decision the user would be annoyed to make twice.

No, if it only opens a read-only view. `legal_basis` opens a PDF and
`document_grid` opens a file dialog — both hold local `useState` and both are
correctly classified `presentational`, because nothing is committed.

Prefer designing a card to be presentational. If it must be interactive, make
its endpoint idempotent too — persistence stops the UI from *offering* the
duplicate, it does not stop a determined double-POST.

### You cannot skip this by accident

Three guards, on both sides of the stack:

1. **`tsc` fails on an unclassified card type.** `CARD_INTERACTIVITY`
   (`card-decision.ts`) is `Record<GridCard['type'], …>`, so the moment
   `npm run generate:cards` adds a type, the build breaks until you classify it.
2. **A vitest guard fails on a classified-but-unwired card.**
   `card-interactivity.spec.tsx` renders every `'interactive'` type through
   `GridCards`, clicks it, and asserts the decision reached the store.
3. **A pytest parity guard fails on cross-stack drift.**
   `INTERACTIVE_CARD_TYPES` (`aiq_agent/cards/catalog.py`) must agree with the
   TS map — `tests/aiq_agent/cards/test_interactive_card_parity.py`.

## Design intent (why it's a layer, not a feature)

Adding a new card type should be: **define the model** (`cards/models.py`) → **add
a renderer** (`features/grid-cards/`). No pipeline surgery. That keeps the set open
to future types (requirement checklists, comparison tables, applicability panels)
without re-plumbing generation or transport.

### Checklist: adding a card type

1. Define the Pydantic model in `src/aiq_agent/cards/models.py` and add it to the
   `GridCard` union.
2. Regenerate the schema: `uv run python scripts/generate_card_schema.py`, then
   `cd frontends/ui && npm run generate:cards`.
3. **Classify it in `CARD_INTERACTIVITY`** (`features/grid-cards/card-decision.ts`).
   `tsc` fails until you do — see [Interactive cards](#interactive-cards-the-answer-must-be-persisted)
   for how to decide, and for what an `'interactive'` classification obliges.
4. Add the renderer under `features/grid-cards/` and wire the `GridCards`
   dispatcher (interactive cards get `messageId={messageId} cardKey={key}`).
5. Add a fixture to the `/dev/cards` gallery and a `visual/registry.mjs` target,
   then capture screenshot evidence (`npm run screenshots`).
6. For a **system** card (tool-emitted, never model-emitted): add it to
   `SYSTEM_CARD_TYPES` and register the emitting tool in the agent's `tools:`
   list in the config.

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
| `project_profile_patch` **(interactive)** | a proposed Project Brief update (hard facts / assumptions) — Accept applies it via `POST /api/projects/{id}/profile/patches`, which wraps bare values with `user_confirmed` provenance and retires answered unknowns | intake / brief |
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
| `memory_proposal` *(system)* **(interactive)** | a finding the `remember` tool wants written to org- or project-scoped memory — the user completes the write through their own session | memory |

**(interactive)** marks a card whose answer is a commitment and is therefore
persisted on the message; see [Interactive cards](#interactive-cards-the-answer-must-be-persisted).

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
`_type` registered — see `surface_documents` in `configs/config_oib_openrouter.yml`.
If the new card is one the MODEL may emit and its contents must be **copied
from a tool result** rather than written from the answer, add its type to
`MODEL_BACKED_CARD_TYPES` as well, and say in a prompt when to emit it — a
renderer nobody is asked for is a renderer nobody sees. This does not apply to
a system card: `document_grid`'s contents also come from a tool, but the model
never emits it at all, so `SYSTEM_CARD_TYPES` and its emitting tool govern it
instead. Next phases: a 3D massing card
(three.js/R3F) and the IFC/BIM viewer (`docs/roadmap/ifc-viewer-card-spec.md`).

## Known rough edges

- The post-hoc generation path (`cards/generate.py` / `cards/prompt.py`) is
  deliberately kept next to the `emit_card` tool: async deep-research jobs use
  it (`jobs/runner.py::_generate_grid_cards`) because the conversation-scoped
  `CardRegistry` behind `emit_card` does not exist inside a Dask worker.
- Async deep-research answers carry cards (generated post-hoc from the final
  report in the job runner); synchronous inline deep research (no Dask) does
  not yet.
- **An async deep-research answer therefore carries no model card**, because
  post-hoc generation is not shown the IFC types (above) and the deep
  researcher's own prompts have no `<cards>` block at all — it holds `emit_card`
  with nothing but the tool description to go on. A deep answer about the
  building comes back as prose with element links. Closing this means giving
  the deep researcher the same `<cards>` guidance the shallow one now has, not
  relaxing the post-hoc restriction, which would only license invented ids.
- A silent card-generation failure is currently indistinguishable from "no cards";
  emission should surface failures.

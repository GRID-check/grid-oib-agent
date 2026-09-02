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

Defined in `src/aiq_agent/cards/models.py` as a discriminated union (`GridCard`)
— **41 types in four families**: 34 the answering model may emit through
`emit_card`, three it may not on any surface (`SYSTEM_CARD_TYPES` — the
tool-owned cards and the retired `follow_ups`), and four **envelope types**
(`ENVELOPE_CARD_TYPES`: `summary`, `verdict_header`, `key_takeaways`,
`callout`) that stopped being cards anywhere new: a research answer is
generated as one JSON envelope (```answer_json — see
`src/aiq_agent/common/answer_envelope.py`) whose optional fields carry the
summary, the verdict, the takeaways and the callout as NATIVE answer anatomy,
validated and gated platform-side and rendered FLAT by the frontend as answer
typography (`features/chat/components/AnswerAnatomy.tsx`): the masthead above
the prose (the earned verdict value plus the near-universal `summary`
standfirst, which then holds the lede emphasis alone — the first paragraph's
automatic lede styling is suppressed), the takeaways as its closing block, the
callout as
an accent-ruled aside — beside the paragraph the model anchored it to with an
own-line `[[callout]]` marker in the `answer` prose
(`answer_envelope.CALLOUT_MARKER`; the backend keeps at most the first
placeable marker and strips them all when the callout is gated out), or after
the prose when unanchored. No generator — `emit_card`, the DSML salvage, or
the post-hoc deep pass — produces these types as cards any more; the union
members survive only so stored threads keep rendering, and the flat variants
live on the same components (`flat` prop) so the two renderings cannot drift
(`features/chat/lib/answer-meta-cards.ts` maps the shapes). On the generation
side the envelope is REQUESTED from the provider too, not only taught: the
shallow agent walks an enforcement ladder per call — OpenRouter structured
outputs (`json_schema`, strict, derived from the same Pydantic models by
`render_envelope_response_format`), then `json_object`, then a plain request —
on the tool-free forced-synthesis call, and on tool-bound iterations only
behind the `envelope_json_mode_with_tools` config flag, because some routed
providers accept the parameter and silently stop emitting tool calls.
The families are not decoration: each answers
"where does a number on this card come from?" differently, and that answer is
what decides whether the model may emit the card at all, on which surface, and
what it is allowed to write into it.

**Structured cards.** The model writes the content itself, grounded in the
answer it has just written.

| `type` | Purpose | Key fields |
|---|---|---|
| `summary` **(envelope)** | A short overview / key points. Retired as a card: the envelope's `summary` field carries the answer-in-brief on basically every reply, rendered as the masthead's standfirst (≤ 320 chars, gated); the card type survives for stored threads | `title`, `content`, `key_points` |
| `legal_basis` | An OIB/norm legal-basis citation | `law`, `article`, `section`, `summary`, `original_text` |
| `project_profile_patch` **(interactive)** | A proposed change to the project brief | `title`, `rationale`, `patch[]` — JSON-Patch ops restricted to `/facts`, `/goals`, `/unknowns`, `/assumptions` (the before/after rows are built from the patch and the live profile, never from the model) |
| `requirement_checklist` | Several pass/fail criteria for one question, each with verdict + own norm reference | `title`, `items[]` (`label`, `status`, `detail`, `reference`), `reference`, `note` |
| `comparison_table` | Side-by-side comparison of a small number of options (columns) across criteria (rows) | `title`, `options[]`, `rows[]` (`label`, `values[]`, `highlight_index`), `recommendation`, `reference`, `note` |
| `verdict_header` **(envelope)** | The answer's single headline ruling, set at the top — the value the reader came for. Fed by the envelope's `verdict` field (gated: a copyable ≤ 60-char VALUE) and rendered above the prose as answer anatomy, never as a card in the array | `verdict`, `subject`, `reference`, `confidence`, `confidence_reason` |
| `condition_tree` | An answer that forks on one factor (typically the Gebäudeklasse): the question, each branch's condition and outcome, the branch this project sits on marked `active` | `title`, `question`, `branches[]` (`condition`, `outcome`, `active`, `reference`), `reference` |
| `typed_table` | A tabular answer no purpose-built card covers. Columns are TYPED (`mass`, `norm`, `verdict`, `date`, `text`) so the renderer can align, format and colour them instead of printing five strings | `title`, `columns[]` (`label`, `type`), `rows[]`, `reference`, `note` |
| `norm_chain` | A chain of norms with what binds and what only interprets: each link carries its `rank` (`bundesgesetz` → `leitfaden`), which is the whole point of the card | `title`, `links[]` (`label`, `rank`, `note`) |
| `key_takeaways` **(envelope)** | „Das Wichtigste" — the 2–5 points the reader must leave with; a row with a `detail` expands, a row without one is not a button. Fed by the envelope's `takeaways` field, gated on answer length (≥ 600 chars of prose) and 2–5 items, rendered after the prose | `title`, `items[]` (`text`, `detail`) |
| `callout` **(envelope)** | ONE remark that changes what the reader does — a `hinweis`, `achtung`, `frist` or `tipp`. Fed by the envelope's `callout` field, which holds at most one by shape, rendered after the prose | `kind`, `text`, `title`, `detail` |
| `follow_ups` **(retired)** | 2–4 next questions, each anchored to something this answer introduced. Clicking one PREFILLS the composer — the user still presses send, and nothing reaches the backend on click. **The model can no longer emit this**: it is a member of `SYSTEM_CARD_TYPES`, and the post-answer `follow_ups` STAGE produces the questions instead, rendered as a rail BELOW the answer (`aiq_agent/stages/follow_ups.py`, `docs/architecture/post-answer-stages.md` §7.10). The type, its Zod schema and `FollowUpsCard.tsx` all stay, so the cards stored on historical threads keep rendering — see *Retiring a card type* below | `title`, `items[]` (`question`, `hint`) |
| `calculation` | The derivation behind a computed number — the Schrittmaßregel, a GFZ, a Brandlast, a U-value from its resistances. **There is no result field**: the model supplies operands, an operation from a closed set (`sum`, `product`, `quotient`, `percent_of`, `percent_ratio`) and the limit; the renderer computes, propagates the ± band, rounds and judges | `title`, `steps[]` (`label`, `operation`, `operands[]`, `unit`), `limit`, `reference`, `note` |
| `process_map` | An ordered procedure — Einreichung → Bauverhandlung → Baubewilligung → Fertigstellungsanzeige — with the step this project stands at, and what each step requires and produces revealed on click | `title`, `steps[]` (`label`, `summary`, `actor`, `duration`, `requires[]`, `produces[]`, `reference`), `current_step`, `reference`, `note` |
| `document_checklist` | „Welche Unterlagen brauche ich" — each entry a STATE (`required` / `conditional` with its condition, and whether the reader already holds it), not a name in a list | `title`, `items[]` (`label`, `requirement`, `condition`, `issuer`, `status`, `note`, `reference`), `reference` |
| `deadline_timeline` | Several Fristen in sequence, each with the event that starts its clock and what happens when it runs out. Carries the Bestimmung's own wording („binnen vier Wochen"), never a calendar date | `title`, `deadlines[]` (`label`, `period`, `starts_from`, `actor`, `consequence`, `reference`) |
| `change_impact` | „Was passiert, wenn X sich ändert" — one moving fact, its two values, and what each consequence COSTS, each marked as tightening or relaxing | `title`, `factor`, `from_value`, `to_value`, `consequences[]`, `reference`, `note` |
| `diagram` | Any ask for a Diagramm, Schaubild, Grafik, chart or mermaid — and a relationship prose cannot hold: a Verfahren that forks and rejoins, Stellen exchanging in order, a Nachweis others depend on — drawn as mermaid. Never anything measured, and the card renders rather than files; see [The `diagram` card](#the-diagram-card-the-one-drawing-whose-renderer-cannot-check-it) | `title`, `diagram_type` (`flowchart` / `sequence` / `state` / `pie`), `source`, `caption`, `reference` |

**Schematic cards** — fifteen programmatically-drawn technical diagrams (SVG kit
in `features/grid-cards/schematics/`, Rough.js sketch stroke). The model emits
**parameters only**; the renderer draws to scale and does every piece of
geometry and ratio arithmetic itself, so a card cannot show a diagram that
disagrees with its own numbers. Each measured dimension is a `DimensionCheck`
(`value`, `required`, `unit`, `comparator`, `status`), every required limit
carries a `NormReference`, and an unknown value is omitted with
`status: "needs_input"` rather than estimated — the renderer prints "fehlende
Angabe", never a guess. A `value` lifted off an `ifc_measure` answer additionally
carries that answer's own `provenance` (`declared` / `computed` / `inferred`)
and, when computed, its `tolerance` — the card is the part that gets
screenshotted into a submission, so it is the surface least able to afford
dropping the qualifier that made the number true.

| `type` | Draws | Domain |
|---|---|---|
| `building_section` | storeys stacked to scale, the ground line, dashed Fluchtniveau/GK/Hochhaus marker lines | height / Gebäudeklasse |
| `stair_diagram` | the step profile to scale, riser/going/width, and the 2×Steigung + Auftritt comfort rule | stairs (OIB 4) |
| `dimension_diagram` | one of six templates — door, ramp, corridor, turning circle, threshold, parking space — with a dimension arrow drawn where each is measured | accessibility (OIB 4 / ÖNORM B 1600) |
| `setback_plan` | the parcel, the footprint and the required-setback envelope, one distance arrow per edge | Abstandsflächen / Bauwich |
| `egress_diagram` | the escape path run by run from the worst-case point, total length vs the OIB limit (typically 40 m) | fire / escape routes (OIB 2) |
| `daylight_incidence` | a window section, the 45° free-light line, any obstruction, and the glass-vs-floor-area check | daylight (OIB 3) |
| `guardrail_check` | a railing elevation with height, max opening and bottom-gap checks, and the no-climb band shaded | Absturzsicherung (OIB 4) |
| `density_check` | parcel + shaded footprint with Bebauungsgrad and GFZ bars (the renderer derives both ratios) | zoning density |
| `fire_access_plan` | a Feuerwehrzufahrt site plan: access route, Aufstellfläche beside the facade, reach to the farthest entrance | fire access (OIB 2 / TRVB) |
| `acoustic_check` | direction-aware dB gauges — airborne (`DnTw`, higher is better) and impact (`LnTw`, lower is better) drawn opposite ways | Schallschutz (OIB 5) |
| `fire_compartment` | a storey split into Brandabschnitte, width proportional to area, each read against the max Brandabschnittsfläche | fire compartments (OIB 2) |
| `thermal_envelope` | a building-envelope section with one U-value bar per component | Wärmeschutz (OIB 6) |
| `energy_performance` | the Heizwärmebedarf on the A++–G energy-class ladder, plus HWB and optional fGEE bars | Energieausweis (OIB 6) |
| `elevator_requirement` | the served-storey stack with a lift shaft, the requirement verdict, and cabin/door clearances | barrier-free lift (OIB 4) |
| `parking_requirement` | a slot grid (outline = required, filled = provided) with count bars for cars and bicycles | Stellplatznachweis (Bauordnung / StPl-VO) |

**Model-backed cards** — the five that address the architect's actual IFC model.
Every identifying field has to be **copied from an `ifc_query` row in the same
turn**; the model supplies no figures at all (`MODEL_BACKED_CARD_TYPES` in
`cards/catalog.py`).

`ifc_model_picker` sits beside them and is deliberately NOT one of the five: it
carries a heading and nothing else. The project's models are enumerated by the
frontend, so there is no file name for the agent to get wrong and no `ifc_query`
call to make first. It exists because "zeig mir das Modell" was being answered
with a prose bullet list of file names for the user to retype — the tiles open
the viewer on click instead.

| `type` | Shows | Key fields |
|---|---|---|
| `ifc_viewer` | the project's IFC model in 3D with findings highlighted on the real geometry (ADR-0045) | `title`, `model_file`, `highlights[]` (`global_ids` **XOR** `match`, plus `label`, `status`), `storey`, `note` |
| `ifc_schedule` | the Raumbuch, optionally for one storey | `title`, `model_file`, `storey`, `note` |
| `ifc_element` | one element with its own property sets and quantities | `title`, `global_id`, `model_file`, `note` |
| `ifc_diff` | what changed between two revisions | `title`, `base_model_file`, `model_file`, `note` |
| `ifc_compliance` | the Prüfbuch: OIB requirements with their verdict | `title`, `model_file`, `rule_ids[]` (≤ 20), `note` |
| `ifc_model_picker` | the project's IFC models as tiles that open the viewer — the answer to "which model do you mean?" | `title`, `note` |

**System cards** — emitted by a specific tool on a sanctioned path, never by the
model (`SYSTEM_CARD_TYPES`; `emit_card` refuses them and the model-facing
catalog omits them entirely).

| `type` | Shows | Emitted by |
|---|---|---|
| `document_grid` | project/Büroarchiv files the user asked to see — the same raised `FileCard` the Files grid uses | the `surface_documents` tool |
| `memory_proposal` **(interactive)** | a finding to be written to org- or project-scoped memory, for the user to confirm | the `remember` tool |

**(interactive)** marks a card whose answer is a commitment and is therefore
persisted on the message; see
[Interactive cards](#interactive-cards-the-answer-must-be-persisted).

`validate_cards()` validates against the union and drops null fields.

### `calculation` has nowhere to put a wrong answer

The schematic cards hold their invariant by having the renderer do every piece of
geometry and ratio arithmetic itself, so a drawing cannot disagree with its own
numbers. `calculation` is the same idea applied to arithmetic the answer states
in words, and it is enforced by ABSENCE: there is no result field anywhere on the
wire. The model supplies the operands, the operation and the limit; the renderer
produces the result, the propagated tolerance and the verdict. A stated result
that disagrees with its own operands is the worst artefact this product can make,
because a card is the part that gets screenshotted into an Einreichung — so the
schema simply offers no place to write one.

The operation is a closed set of five shapes rather than an expression the
renderer parses. A grammar would hand the model arbitrary formulas and hand the
renderer the job of re-deriving intent, and the first ambiguous parse —
precedence, a unit inside the expression, a stray bracket — puts a confident
wrong number on the card. `quotient` covers `U = 1 ÷ R` with a numerator of 1,
which is why there is no separate `reciprocal`. A derivation needing two stages
writes two steps, the second naming the first by index; the reference must point
strictly backwards, so a card that cannot be computed never reaches the client.

Three consequences worth knowing before changing it:

- **The ± band travels.** `sum` scales it by |factor|, `product` and `quotient`
  add relative errors: 2 × (17 ± 0,5) + 30 → 64 ± 1,0. A band on a `declared`
  figure is ignored, because that is the file's claim and not our measurement.
- **Undecidable is not partial.** A missing operand yields no result and the
  missing-value phrase, never a partial sum, and it propagates down the chain.
- **The display yields, the arithmetic does not.** House precision is two
  decimals unless rounding to it would move the value across the limit — 0,2506
  W/(m²K) against „≤ 0,25" prints 0,251, not „0,25 — nicht erfüllt".

### The `diagram` card: the one drawing whose renderer cannot check it

Every other drawing in the catalog is a schematic: the model emits parameters and
the renderer computes the geometry, so a card cannot show a diagram that
disagrees with its own numbers. `diagram` carries mermaid source, and **mermaid
text IS the geometry** — whatever the model writes is what is drawn, with no
arithmetic between the claim and the picture and therefore nothing to catch a
disagreement. That guarantee is not weakened here; it is simply unavailable, and
no amount of care in the renderer can create it.

So the boundary is drawn around the **subject** instead: a diagram that makes no
dimensional claim has nothing on it that can be measurably wrong. A
Verfahrensablauf, an Einreichungssequenz, a Zuständigkeits- or
Abhängigkeitskarte. Anything measured — a section, a stair, an escape route, a
fire compartment, a setback — belongs to the fifteen schematic cards. A mermaid
box with „40 m" typed inside it is precisely the artefact the card system exists
to prevent, and it is the one that gets screenshotted into an Einreichung. That
seam is stated in three places that must agree: `cards/models.py`,
[diagrams.md](diagrams.md) and the frontend's own
`lib/diagrams/diagram-sources.ts`.

Naming a threshold in a branch condition („Fluchtniveau > 22 m → GK 5") is not
that artefact and is not refused: nobody reads a rounded rectangle as a section,
and the number there is a label the answer has already grounded. No regular
expression separates those two — the same „22 m" appears in both — which is why
the rule is prose in the catalog rather than a validator.

**What the card does check**, because it is the one invariant available: the
`diagram_type` field is a closed set of the four grammars verified end to end
(`flowchart`, `sequence`, `state`, `pie`) and a model validator reads the
source's own declaration line back. That catches the failure that actually
bites — a source declaring nothing, where mermaid has no grammar to parse the
rest with and the whole block collapses to a grey code box mid-answer — and it
refuses a `journey` by name, which would otherwise pass every other check and
then be refused in the reader's browser, because mermaid emits `<foreignObject>`
for it whatever `htmlLabels` says and the SVG allow-list refuses that element.

**Why it is presentational, and where filing lives.** The card renders the
drawing and commits nothing. It was designed with an „Im Projekt ablegen" button
of its own, which would have made it interactive — and that button is not in v1,
for a reason that is worth keeping rather than re-litigating. A decision stored
on a message is a `CardDecision` plus a timestamp and **nothing else**
(`CardInteraction`), and the thing worth remembering about a filed diagram is the
ID of the document it became — the answer's one pointer into the Files pane.
Storing `filed` would record that filing happened and lose where it went,
permanently, because the card would then stop offering the button that returns
the id. Filing is idempotent (the run id is the answer id plus a hash of the
source), so *not* persisting leaves a reader who reloads with a live button that
hands the link back — a recoverable loss where the other is not, and ADR-0030's
own test is "a decision the user would be annoyed to make twice".

So filing stays where it already works: on the **fence**. `MermaidDiagram`
offers „Im Projekt ablegen" wherever a surface supplies a `DiagramFilingTarget`
(`AgentResponse` supplies one for any answer inside a project), and the route,
the SVG validator, the PDF conversion and migration 0065 are all reached from
there. The day `CardInteraction` can carry a payload, the card can have the
button and `CARD_INTERACTIVITY` flips to `'interactive'` — that entry in
`card-decision.ts` carries this same note.

**The markdown fence stays.** A ```` ```mermaid ```` fence in an answer is still
drawn (`MarkdownRenderer` → `MermaidDiagram`) and is the fallback for everything
the card refuses. What the card adds is the three things a fence cannot have: a
catalog entry, which is how the model learns a card exists at all; a payload
`validate_cards()` checks before it reaches a browser; and a filing decision that
persists on the message instead of in component-local React state.

### The five IFC cards carry identifiers, not numbers

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
whenever a structured element communicates better than prose. The card is
validated against the shared schema and pushed into the conversation-scoped
`CardRegistry`. The chat entrypoint snapshots that registry after the turn and
attaches the cards to `ChatResponse.cards`, which the monkeypatched WS handler
lifts onto the top-level message so the frontend reads it at `message.cards`.
(The older post-hoc "re-derive cards from the finished prose" LLM call in
`cards/generate.py` / `cards/prompt.py` remains as a fallback path.)

### The vocabulary is two levels: an index, then shapes on demand

The tool description used to be the whole catalog — every type's shape, every
shared building block, and a worked example per hard-to-nest type, all rendered
out of the Pydantic union by `render_card_catalog()`. That was right about the
schema and wrong about the economics. It is ~5,200 tokens sitting in context on
**every** turn whether or not a card is ever emitted, and it grows ~190 tokens
for each type added — permanently, and linearly with a vocabulary we intend to
keep growing. The fifteen schematic cards alone were carrying ~2,900 tokens of
nesting into conversations that will never draw a stair.

So the catalog is split the way the skills runtime already splits instructions
(`agent-skills.md` § Selection & progressive disclosure):

| level | what it is | where |
|---|---|---|
| **L1 — always on** | one line per model-facing type: the `type` value and the first line of the card model's docstring, plus the interactive-card note. No shapes, no building blocks, no examples. | `render_card_index()`, rendered into the `emit_card` description |
| **L2 — on demand** | the exact shape for the named types, the shared building blocks (`NormReference`, `DimensionCheck`, …) each defined once with field descriptions, the measurement note where a `DimensionCheck` is in play, and the worked example | `render_card_details(types)`, served by the **`describe_card`** tool |

That took the `emit_card` description from ~5,209 to ~1,205 tokens per turn, and
the marginal cost of a new card type from ~190 tokens on every turn to ~23. It is
what makes a growing card vocabulary affordable on a cost-optimised model tier —
and what stops the always-on half from diluting attention on a long turn.

`render_card_catalog()` still exists and is still the one rendering both card
surfaces share. Post-hoc generation keeps taking it whole
(`build_card_generation_prompt()`): it is a single batch call with no tool loop,
so there is nothing there that could fetch L2 later.

`describe_card` **reports the names it did not recognise** rather than quietly
rendering only what resolved — a silently shorter answer reads as "that card
does not exist", and the model's next move would be to invent a shape for it.
Inside `render_card_details` an unknown or system type is skipped rather than
raised on, because the same function is also fed from skill metadata, and a
stale name in a tenant's skill must not take down the turn that mentioned it.

The skills runtime is that third consumer. When a skill declaring `grid-cards`
is loaded, `_preferred_cards_block` (`skills/runtime.py`) appends the **shapes**
of the types it names, not just their names. A skill naming its cards is the
moment we know which of the shapes this turn could possibly need, so it is
the moment to spend context on them — and it saves the activated turn a
`describe_card` round-trip it would otherwise always pay.

That makes `grid-cards` do two things at once, and only the first is obvious: it
states the author's preference AND it decides which shapes are already in context
at the moment the model would emit. The `piloti-cards` standard skill used to be
the heaviest user of this — six shapes inlined on every answering turn — until
migration `0071` retired it together with `piloti-voice`: the card craft moved
into the `<cards>` section of the researcher's system prompt, and the rhetorical
shapes it inlined became `answer_meta` trailer fields. Today the mechanism
serves the genre skills (e.g. `oib/brandschutz` inlines its five), which pay
for their shapes only on the turns that activate them.

Taking a retired type OUT of the list is not tidiness. `preferred_cards` filters
`grid-cards` against `model_facing_card_types()`, so a name left behind is dropped
silently on every read — a seed naming a card the runtime never sees, which is the
drift `test_seeded_grid_cards_survive_the_read_path` exists to catch.

### Retiring a card type

`SYSTEM_CARD_TYPES` in `cards/catalog.py` is the lever, and it has two kinds of
member: cards a TOOL owns and the model must not fabricate (`memory_proposal`,
`document_grid`), and cards that have been RETIRED because their content moved
somewhere else (`follow_ups`, whose questions the post-answer stage now produces).
One mechanism, because the requirement is the same either way: the model may not
emit one, and everything already stored keeps working.

Adding a type to the set does five things at once. All three emission paths refuse
it — `emit_card` (`cards/register.py`), post-hoc batch generation (`validate_cards`
in `cards/models.py`) and the DSML salvage (`shallow_researcher/dsml.py`) — and
`model_facing_card_types()` drops it from every advertised surface, so `L1`
(`render_card_index`), `L2` (`render_card_details`, hence `describe_card` AND the
`grid-cards` shapes block) and the worked example all go together.

What it deliberately does NOT do is remove the union member. `validateGridCards`
(`shared/cards/schemas.ts`) drops anything failing the union and logs a warning per
card, so deleting the type would cost every historical thread its chips and fill
the console doing it. Retiring one is therefore a checklist:

1. add the type to `SYSTEM_CARD_TYPES`;
2. remove its prompt weight everywhere it is written by hand — the trigger row and
   any rule of its own in `catalog.py`, its paragraph in `cards/prompt.py`'s
   post-hoc craft note, and any clause elsewhere that names it;
3. remove it from `grid-cards` in the seeded skill, and its craft section from the
   skill body, in a new md5-guarded migration (`0062` is the worked example);
4. leave the pydantic model, the Zod schema, `CARD_INTERACTIVITY` and the renderer
   branch alone, and pin that with a test that mounts a STORED card;
5. decide what the export does with it — `CARD_EXPORT` in
   `lib/answer-export/cards.ts` is exhaustive over the union, so `tsc` makes you.

### `emit_card` carries the doctrine, not a disclaimer

The description used to say "emit a card only when it adds real value". That is
a disclaimer, not an instruction, and fifteen diagram renderers sat behind it —
while eight lines away in `researcher.j2` the IFC block named a trigger and gave
a reason, which is exactly why the IFC cards were emitted and the schematics
were not.

The doctrine now states the default positively and names the trigger for
each card: a riser, tread or stair width → `stair_diagram`; a clear width, ramp
or turning circle → `dimension_diagram`; an escape route with segments →
`egress_diagram`; a fall height, railing or opening → `guardrail_check`; a
U-value, HWB or energy class → `thermal_envelope` / `energy_performance`; a fire
compartment area → `fire_compartment`; the Richtlinie the answer rests on →
`legal_basis`; three or more pass/fail criteria → `requirement_checklist`; two
or more options weighed against each other → `comparison_table`; a path that
forks and REJOINS, several Stellen exchanging in order, or a Nachweis others
depend on → `diagram`. The reason
travels with the rule: an answer that turns on a dimension gets its card by
default rather than on request, because a measurement written as a sentence
makes the reader re-draw it in their head, and the card is the drawing they
would have made.

### Where the doctrine lives, and which surface gets which half

The text is assembled by `render_card_doctrine()` in `cards/catalog.py` — the
framing-free module that already owns `render_card_index` / `render_card_details`
— because there are TWO surfaces that produce cards and only one of them used to
be taught how to choose.

`register.py` composes `render_card_doctrine()` with the envelope redirect note
and the `[[card:N]]` placement contract, and exports the result as
`_CARD_DOCTRINE`, which is what `emit_card`'s description carries. The
rhetorical triggers left the table with their card types: a model that
recognises "this answer has a verdict" is pointed at the ```answer_json
envelope, on every surface.

`cards/prompt.py` composes `render_card_doctrine(include_ifc_triggers=False)`
for the post-hoc path that derives cards from a finished deep-research report.
That path used to carry the disclaimer this section describes replacing — on the
surface producing the LONGEST answers, the ones that most need a takeaway block
and a callout. Three parts are deliberately withheld from it, and the
reason is the same each time: they are not true there.

- The **`[[card:N]]` placement contract**. The job runner emits the report
  unchanged and attaches the returned list, so there is no text to place into.
  List order is render order, so the doctrine gets an ordering rule to refer to
  instead — the verdict first, the substance after it.
- **`describe_card`**. There is no tool loop; the shapes are already inline.
- The **`ifc_model_picker` trigger**, though not its shape. That trigger fires on
  a live "zeig mir das Modell" intent and says to emit the card *instead of*
  writing the file names as prose — a trade that is no longer available once the
  prose is written. Note the picker is still NOT in `MODEL_BACKED_CARD_TYPES`:
  that set means "every identifying field must be copied from an `ifc_query`
  row", and the picker names no file and invents nothing. Withholding a trigger
  and withholding a shape are different decisions with different reasons, and
  conflating them would put the wrong reason on the wrong set.

The CRAFT — which card actually improves an ordinary answer, and how the
verdict divides the ruling with the answer's first sentence — is in neither
rendering. It lives in the `<cards>` and `<answer_meta>` sections of the
researcher's system prompt (`shallow_researcher/prompts/researcher.j2`), where
the retired `piloti-cards` platform skill used to carry it: a forced skill's
body only reached the model through a `use_skill` call it could skip, and the
prompt is unconditional. The post-hoc path cannot read a prompt meant for the
answering agent, so it carries the subset of that judgement which is a test
over a finished text rather than an instruction about how to write one
(`_POST_HOC_CRAFT` in `cards/prompt.py`).

A positive trigger that strong needs an **explicit negative default** beside it
or it produces card spam, so the doctrine states that too: a one-line factual
answer gets no card; a card that repeats the sentence above it costs the reader
a second pass over the same fact; two cards in a turn is plenty, and past that
the written answer stops being the answer; and no field, reference or number may
be fabricated to fill a card out — a card with an invented limit in it is worse
than the prose alone, because it is the part that gets screenshotted into a
submission.

### What a card costs the turn, and what it used to cost

Two content cards is the doctrine's ceiling. For a long time it was also
unreachable, for a reason that had nothing to do with the doctrine.

The shallow agent forces synthesis at `tool_iteration_ceiling`
(`max_tool_iterations`, five in production, plus a reserve sized to the standard
skills the deployment forces on every turn), and every tool call was charged to
it — `emit_card` and `describe_card` included. Those are the answer's OUTPUT
channel, and they are called last, after the searching is done, so on any turn
that actually researched, the ceiling landed on the cards rather than on the
research. The forced-synthesis anchor then says "Do not attempt any further tool
calls", which made the second card unreachable by construction: the model had
already decided to draw it, and nothing in the answer, the log or the
`research_truncated` note said what had been lost.

So the interaction tools have their own allowance
(`_INTERACTION_TOOL_ALLOWANCE`, six — one shape lookup, three `emit_card` calls,
a `remember`, and one spare for the retry a validation failure invites), spent
before the research budget is touched. It is sized at the doctrine's most
generous reading on purpose: it decides only when a card starts costing
research, never how many cards an answer should carry. It is a CEILING on the
exemption rather than a second budget: a call past it is charged to research
again, so the tool loop still terminates where it always did. The counter is
`interaction_iterations` on the shallow agent's state, per turn.

The rule this leaves is the one that was always meant to be in force: how many
cards an answer carries is a judgement about the answer, decided by the doctrine
and the prompt's card craft — never a leftover of how much searching the
question happened to need.

### Which turns may emit a card

Every turn. `emit_card` and `describe_card` are bound on every turn like every
other tool (ADR-0052: there is no classifier and no narrowed "meta" binding in
front of the answering agent), so whether a turn ships a card is decided by
what the answer has to show, never by a label given before the answer.

This used to be contradictory rather than decided: when the intent classifier
still existed, the shallow prompt's meta output contract said "no tool calls"
while the `<cards>` block six lines below sat outside both `requires_sources`
guards and told the model to emit one. The mandatory-sounding half won, and a
Baurecht question that classified `meta` — „Wie läuft das
Baubewilligungsverfahren in Wien ab?", retyped in plain words after a research
plan was refused — shipped as prose twice. Deleting the classifier removed the
contradiction with it.

What bounds it now is the prompt: **it says what a direct reply may put on a
card.** A subject-matter question that merely landed in a short reply earns the
card its content calls for; small talk, a formatting or memory request, a shelf
listing and an off-topic decline get none. The always-on doctrine and the L1
index ride in `emit_card`'s description on every turn — enough to NAME the
right card; the shape costs one `describe_card` call. Skills, too, are bound on
every turn (`use_skill`); there is no `requires_sources or force_skills` gate
in front of the skill runtime any more, so a greeting that loads no skill is
the model's judgment, pinned by the prompt.

### Every `emit_card` outcome is logged, refusals included

A turn that shipped without its card used to look identical after the fact
whether the model never called `emit_card` or called it and was refused — only
the success path wrote a log line. Those have opposite fixes (a doctrine that
never got the card named, versus a shape the model cannot fill in), so every exit
in `_emit` now logs: refusals at `warning` naming the card TYPE the model reached
for, the success at `info` as before.

Because the doctrine lives on the tool, the shallow researcher's `<cards>` block
no longer restates it. It points at the `emit_card` description and keeps only
what is true of cards but not of the tool — cards are in addition to the written
answer, so always write the prose too; and if asked whether Grid can render
cards, say yes and demonstrate by emitting one. Two copies of a trigger list is
two things to keep in step, and the prompt copy is the one that would silently
fall behind the union.

### System cards: never the model's to fabricate

`SYSTEM_CARD_TYPES` (`cards/catalog.py`) marks the variant the **model must
never fabricate**: `emit_card` refuses them and they are omitted from the
model-facing catalog and from the index. They are emitted only by a specific tool on a
sanctioned path, carrying **real** data:

- `memory_proposal` — emitted by the `remember` tool when an org-scoped memory
  write needs human confirmation.
- `document_grid` — emitted by the **`surface_documents`** tool
  (`cards/surface_documents.py`). Discovery, not evidence: files the user
  asked to *see* or *browse*. One payload (`documents[]`). The card is
  the same raised `FileCard` (thumbnail well) the Files grid uses — not
  a filename list. One file peeks beside chat; several close same-kind
  matches are a short grid (hard cap 3). There is no second card type
  for the one-file case. Citations of exactly one project/Büro file
  already peek (`useCitationPeek`) without this card. **`filename=`**
  opens a named file; **`mode=one` + `query`** opens the best match;
  **`mode=many`** only when two or three files of the same kind are
  nearly tied. **`shelf=archiv` / `shelf=project`** keeps the search on
  one shelf so a Büroarchiv browse cannot pull project files. A question
  that only *lists* what is on a shelf ("welche Dateien hast du im
  Büroarchiv") is answered from the shelf-grouped inventory, not this
  tool. Never invent names. See [ADR-0026](../adr/) for
  source-kind doctrine.

### Model-backed cards: copied from a tool result, never composed

`MODEL_BACKED_CARD_TYPES` (`cards/catalog.py`) — `ifc_viewer`, `ifc_element`,
`ifc_compliance`, `ifc_schedule`, `ifc_diff` — is a second, softer restriction,
and it cuts the other way: the model *may* emit them, but only on the surface
that can supply their contents. Every field that
identifies something in them is an IFC GlobalId, a rule id or a model file name,
all of which have to be **copied from an `ifc_query` row in the same turn**.

- `emit_card` advertises them — in the index, with their shapes one
  `describe_card` call away. Its caller has the `ifc_query` rows in context.
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
`ifc_query`, and names which card goes with which operation. That is the one
part of the trigger doctrine that stayed in the prompt rather than moving to the
`emit_card` description, because it turns on what `ifc_query` returned this turn
— which ids exist to copy — rather than on the card catalog. Before that
existed, all five renderers were reachable only if the model happened to pick
one unprompted out of the catalog — and the `ifc_query`
description actively steered it the other way, toward markdown element links.
The result was that a question about a 150 MB building was answered with three
lines of prose.

## How cards render

The frontend validates the wire cards (`validateGridCards`) and renders them
through the `features/grid-cards/` component set — one renderer per card type.

### Where a card lands: `[[card:N]]`

Cards used to be drawn as a block, all of them, after the whole answer — so the
stair diagram sat three screens below the paragraph about the stair, and a reader
had to scroll past every drawing to reach the sentence they asked for.

Each `emit_card` call now returns a marker naming the card by its POSITION in
this turn's registry (`[[card:2]]` for the second card emitted). A marker written
on a line of its own in the answer body is consumed by a remark plugin
(`grid-cards/card-markers.ts`) and the card is spliced in at that point; the
cards no marker claimed still follow the prose as a block, which is also what
happens when the answer places none. Position is used rather than an id because
an id would have to survive validation, persistence AND the deep-research path,
which builds its cards post-hoc from a finished report and has no emission order
to refer back to.

The contract is stated in `researcher.j2` as well as in the tool return, and
deliberately so: a marker the model only learns about from the tool result
arrives after it has already committed to the paragraph the card belongs to, so
placement could only ever be retrofitted. Named up front, it can be planned.

### Type sizes: six classes, and lint per card

`docs/design/grid-card-charter.md` §A2 fixes the card type scale at six steps
and one figure. They exist as classes in `src/app/globals.css`, declared in
`@layer components` so any Tailwind utility still overrides them:

| Step | Class | Spec |
|---|---|---|
| Eyebrow | `card-eyebrow` (via `SectionLabel`) | 10.5 / 500 / uppercase / +0.05em |
| Meta | `card-meta` | 11 / 500 / tabular-nums |
| Caption | `card-caption` | 12 / 400 |
| Body | `card-body` | 13.5 / 400 / 1.55 |
| Title | `card-title` | 14 / 600 |
| Headline | `card-headline` | 17 / 600 — `summary`'s title only, the one §A2 exemption |
| Figure | `card-figure-15/20/24/30` | 600 / tabular-nums — **one per card, and it must be the card's answer** |

Reach for a step; never write a `text-*` size in a card. The audit behind the
charter counted thirteen distinct sizes in `features/grid-cards/`, ten of them
arbitrary values, with `text-[12px]` beside `text-xs`.

`grid/card-type-scale` (`eslint-rules/card-type-scale.mjs`) makes that an error
— **per file**, listed as `CARDS_ON_THE_TYPE_RAMP` in `eslint.config.mjs`. The
charter migrates a card when a sprint touches it rather than in one flag day, so
a card joins the list when it is clean, and a card already on it cannot regress.
Adding a new card? Put it on the list from the start.

One cross-card rule exists and only one: `summary` drops its 17px headline to
`card-title` when the answer also carries a `verdict_header`, so the two do not
both claim the top. It reads `features/grid-cards/card-set.tsx`, whose provider
must wrap anything that renders cards — `GridCards` does it, and so does
`AgentResponse`'s inline `[[card:N]]` slot, because neither sees the whole
answer's card array on its own.

## Interactive cards: the answer MUST be persisted

> ⚠️ Full rationale: [ADR-0030](../adr/0030-interactive-card-decisions-persist-on-the-message.md).
> **Read this before adding, editing, or reviewing any card that has a button
> which writes something.**

Most cards are pure presentation: same payload in, same pixels out, nothing to
remember. **Two are not.** `project_profile_patch` and `memory_proposal` ask the
user to authorize a write (`propose, never auto-apply` —
`project-memory-design.md` §11.7), which makes the user's click the only place
that outcome exists.

`diagram` was briefly a third and is deliberately not one — see
[the card's own section](#the-diagram-card-the-one-drawing-whose-renderer-cannot-check-it)
for why the drawing ships without a filing button and what would have to change
first. A `CONSENT_CARD_TYPES` was split out of `INTERACTIVE_CARD_TYPES` at the
same time, to keep the model from being told a drawing "asks the user to
authorize a real, persisted change" — true then, and it would have suppressed the
card on exactly the answers it exists for. It left with the button: "must the
frontend persist an answer?" and "does emitting it cost the reader a decision?"
only ever named different sets while `diagram` sat between them, and two
constants equal by construction are two things to keep in sync, of which one
stops being maintained.

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
   `GridCard` union. **The docstring's first line is the L1 index entry** the
   model reads on every turn — write it as a trigger ("Emit for … questions"),
   not as a label, because the index is all the model has to go on before it
   spends a `describe_card` call. Nothing else is needed to advertise the type:
   the index, the shapes, the human catalog endpoint and the gallery are all
   derived from the union.
2. Regenerate the schema: `uv run python scripts/generate_card_schema.py`, then
   `cd frontends/ui && npm run generate:cards`.
3. **Classify it in `CARD_INTERACTIVITY`** (`features/grid-cards/card-decision.ts`).
   `tsc` fails until you do — see [Interactive cards](#interactive-cards-the-answer-must-be-persisted)
   for how to decide, and for what an `'interactive'` classification obliges.
4. Add the renderer under `features/grid-cards/` and wire the `GridCards`
   dispatcher (interactive cards get `messageId={messageId} cardKey={key}`).
   Type it with the [`card-*` ramp](#type-sizes-six-classes-and-lint-per-card)
   and add the file to `CARDS_ON_THE_TYPE_RAMP` in `eslint.config.mjs`.
5. Add a fixture to the `/dev/cards` gallery and a `visual/registry.mjs` target,
   then capture screenshot evidence (`npm run screenshots`).
6. **Give it a trigger in the doctrine** (`render_card_doctrine` in
   `cards/catalog.py`) — which question calls for it, in the same
   "trigger → card" form as the rest. A type that is only listed in the index is
   a renderer nobody is asked for, which is a renderer nobody sees; that is
   exactly how fifteen schematic cards sat behind a disclaimer. A trigger line,
   and only a trigger line: the paragraph explaining when the card earns its
   place belongs in the `<cards>` section of the researcher prompt
   (`shallow_researcher/prompts/researcher.j2`). A token ceiling on the tool
   description fails if the doctrine drifts back into carrying craft.
7. For a **system** card (tool-emitted, never model-emitted): add it to
   `SYSTEM_CARD_TYPES` and register the emitting tool in the agent's `tools:`
   list in the config.
8. For an **envelope** field (native answer anatomy, never a tool call): add
   a model, a registry entry and a gate in `common/answer_envelope.py` (the
   taught schema renders itself from the models), an earned-when line in the
   prompt's `<answer_envelope>` section, a sanitizer clause in
   `lib/conversations/message-answer-meta.ts`, and a layout slot in
   `AgentResponse`. Retire the card type into `ENVELOPE_CARD_TYPES` only when
   one existed. The bar is high on purpose: an envelope field is paid for in
   contract complexity on EVERY research answer, so it is for shapes almost
   every answer could carry, not for domain cards.

## Card catalog

The catalog is the forty-one types tabulated under
[Current card types](#current-card-types) — eighteen structured, fifteen
schematic, six model-facing IFC and two system — and that is the only place in this document
where they are listed, on purpose: a card type appearing in two tables means one
of them is already wrong. See
[ADR-0012](../adr/0012-cards-as-rich-ui-layer.md).

Two details that belong with the catalog rather than with a row in it.
`project_profile_patch`'s Accept applies the patch through
`POST /api/projects/{id}/profile/patches`, which wraps bare values with
`user_confirmed` provenance and retires the unknowns the patch answered — the
model supplies the plain value and nothing about how it is recorded. And a
system card's entry is a statement about who emits it, not about who may see it:
`document_grid` and `memory_proposal` render exactly like any other card once
they arrive.

### The live catalog: `GET /api/platform/cards`

The tables in this document are prose and go stale between edits; the
endpoint does not.
`GET /api/platform/cards` (platform owners; backend `GET /v1/platform/cards`,
`routes/cards.py`) serves the catalog **derived from the `GridCard` union**:
every type with its purpose, its fields (type, requiredness, description,
constraints), the shapes those fields reference, and the worked example where
one exists. Adding a card type to the union is the only step needed to make it
appear there.

Two differences from the model-facing catalog (`render_card_catalog`), which is
rendered from the same models for the `emit_card` tool: system cards are
**included** and flagged `emittedBy: "system"` rather than hidden (a model that
learns they exist can fabricate them; a person asking "can Grid show me X?" is
misled by a list with holes in it), and every entry is data rather than prose.

The response also carries `featureRequest` — the repository plus a link to the
enhancement issue form — because the question that follows "here is what Grid
can render" is "and how do I get the one thing that is missing?".

### The gallery: Platform → cards

`/app/platform/cards` is that catalog as a page (platform owners; nav entry
between "Answer quality" and "Base knowledge"). Every entry is a **real render**
— the sample card goes through the same `GridCards` dispatcher chat uses — so
the page cannot advertise a card the renderers do not produce, and a platform
owner's visual question ("can Grid show me a Stellplatznachweis?") gets a visual
answer. The values each card carries expand underneath, straight from the
endpoint, and the request-a-card link sits in the header and again at the foot.

| piece | where |
|---|---|
| The page | `src/app/app/platform/cards/page.tsx` + `platform-cards.tsx` |
| The sample cards | `features/grid-cards/preview-fixtures.ts` — authored in schema-INPUT shape, then run through `validateGridCards`, so a fixture that stops matching the union is dropped rather than rendered |
| Coverage guard | `preview-fixtures.spec.ts` — every type in `CARD_INTERACTIVITY` needs a fixture or an entry in `PREVIEW_EXCLUDED` |
| Not previewed | all five IFC cards + `document_grid`: they carry identifiers resolved against a loaded model or real document rows, and a fabricated preview would show a building that does not exist |
| Preview evidence | `/dev/platform-cards` + the `platform-cards` screenshot target |

**Previews are inert.** `memory_proposal`'s "Yes" writes an org-scoped memory and
`project_profile_patch`'s "Accept" applies a JSON Patch. In a gallery those
buttons are decoration, so the preview subtree is removed from hit-testing,
focus order and the accessibility tree (`inert`) — `pointer-events-none` alone
would leave them keyboard-reachable, and a tabbed-to "Yes" still writes.

The card-generation LLM is `card_llm` (config `reasoning_effort: medium`). Adding a
card type = define the Pydantic model (`cards/models.py`), regenerate the schema
(`scripts/generate_card_schema.py` → `npm run generate:cards`), add a renderer, and
wire the `GridCards` dispatcher. A dev-only gallery at `/dev/cards`
(`src/app/dev/cards/page.tsx`, 404 outside development) renders every card type
with realistic fixtures for visual review; `/dev/document-grid` previews the
backend-free `document_grid` surfacing card. Both are captured by the screenshot
harness (`npm run screenshots`, see `docs/ux/visual-screenshots.md`).
For a system card emitted by a tool (`document_grid`), that tool must be added to
the agent's `tools:` list in the config (both `shallow_research_agent` and
`deep_research_agent` bind it) and its `_type` registered — see `surface_documents`
in `configs/config_oib_openrouter.yml`; `tests/aiq_agent/test_config_tool_wiring.py`
is the gate.
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
  it (`jobs/runner.py::_generate_grid_cards`) for the cards derived from the
  finished report. The job runner ALSO binds a fresh `CardRegistry` around the
  run (`_bound_card_registry`), so `emit_card` and `surface_documents` called
  by a researcher worker during the run deliver — a deep answer can show a
  `document_grid` card. `_merge_job_cards` puts the emitted cards FIRST, in
  emission order, then the post-hoc ones: `[[card:N]]` resolves positionally,
  and only the emitted cards were ever addressed by a marker.
- Which subagent holds the tools: everything in the deep agent's `tools:` list
  goes to the RESEARCHER workers (`factory.py::build_deep_research_tool_set`);
  the writer holds helper and skill tools only, and the orchestrator the
  research batch tool. So an emitted card is a researcher's, and its marker
  never reaches the report the writer produces — the card lands after the
  report, which is where an unaddressed card goes anyway.
- Async deep-research answers carry cards (generated post-hoc from the final
  report in the job runner); synchronous inline deep research (no Dask) does
  not run the post-hoc pass yet, though it inherits the chat turn's registry
  and so does deliver emitted cards.
- **An async deep-research answer therefore carries no model card**, because
  post-hoc generation is not shown the IFC types (above) and the deep
  researcher's own prompts have no `<cards>` block at all — it holds `emit_card`
  with nothing but the tool description to go on. That description is a much
  better thing to hold since it gained the doctrine, but the doctrine names no
  IFC trigger (that guidance stayed in the shallow prompt, above), so a deep
  answer about the building still comes back as prose with element links.
  Closing this means giving
  the deep researcher the same `<cards>` guidance the shallow one now has, not
  relaxing the post-hoc restriction, which would only license invented ids.
- A silent card-generation failure is currently indistinguishable from "no cards";
  emission should surface failures.

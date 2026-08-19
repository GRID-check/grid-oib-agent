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
— **35 model-facing types plus 2 system types**, in four families. The families
are not decoration: each answers
"where does a number on this card come from?" differently, and that answer is
what decides whether the model may emit the card at all, on which surface, and
what it is allowed to write into it.

**Structured cards.** The model writes the content itself, grounded in the
answer it has just written.

| `type` | Purpose | Key fields |
|---|---|---|
| `summary` | A short overview / key points | `title`, `content`, `key_points` |
| `legal_basis` | An OIB/norm legal-basis citation | `law`, `article`, `section`, `summary`, `original_text` |
| `project_profile_patch` **(interactive)** | A proposed change to the project brief | `title`, `rationale`, `patch[]` — JSON-Patch ops restricted to `/facts`, `/goals`, `/unknowns`, `/assumptions` (the before/after rows are built from the patch and the live profile, never from the model) |
| `requirement_checklist` | Several pass/fail criteria for one question, each with verdict + own norm reference | `title`, `items[]` (`label`, `status`, `detail`, `reference`), `reference`, `note` |
| `comparison_table` | Side-by-side comparison of a small number of options (columns) across criteria (rows) | `title`, `options[]`, `rows[]` (`label`, `values[]`, `highlight_index`), `recommendation`, `reference`, `note` |
| `verdict_header` | The answer's single headline ruling, set at the top — the value the reader came for | `verdict`, `subject`, `reference`, `confidence`, `confidence_reason` |
| `condition_tree` | An answer that forks on one factor (typically the Gebäudeklasse): the question, each branch's condition and outcome, the branch this project sits on marked `active` | `title`, `question`, `branches[]` (`condition`, `outcome`, `active`, `reference`), `reference` |
| `typed_table` | A tabular answer no purpose-built card covers. Columns are TYPED (`mass`, `norm`, `verdict`, `date`, `text`) so the renderer can align, format and colour them instead of printing five strings | `title`, `columns[]` (`label`, `type`), `rows[]`, `reference`, `note` |
| `norm_chain` | A chain of norms with what binds and what only interprets: each link carries its `rank` (`bundesgesetz` → `leitfaden`), which is the whole point of the card | `title`, `links[]` (`label`, `rank`, `note`) |
| `key_takeaways` | „Das Wichtigste" — the 2–5 points the reader must leave with. The generic card for an answer with no dimension and no fork in it; a row with a `detail` expands, a row without one is not a button | `title`, `items[]` (`text`, `detail`) |
| `callout` | ONE remark that changes what the reader does — a `hinweis`, `achtung`, `frist` or `tipp`. Deliberately small; at most one per answer, because a second puts both back at the weight of the prose around them | `kind`, `text`, `title`, `detail` |
| `follow_ups` | 2–4 next questions, each anchored to something this answer introduced. Clicking one PREFILLS the composer — the user still presses send, and nothing reaches the backend on click | `title`, `items[]` (`question`, `hint`) |
| `calculation` | The derivation behind a computed number — the Schrittmaßregel, a GFZ, a Brandlast, a U-value from its resistances. **There is no result field**: the model supplies operands, an operation from a closed set (`sum`, `product`, `quotient`, `percent_of`, `percent_ratio`) and the limit; the renderer computes, propagates the ± band, rounds and judges | `title`, `steps[]` (`label`, `operation`, `operands[]`, `unit`), `limit`, `reference`, `note` |
| `process_map` | An ordered procedure — Einreichung → Bauverhandlung → Baubewilligung → Fertigstellungsanzeige — with the step this project stands at, and what each step requires and produces revealed on click | `title`, `steps[]` (`label`, `summary`, `actor`, `duration`, `requires[]`, `produces[]`, `reference`), `current_step`, `reference`, `note` |

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
at the moment the model would emit. `piloti-cards` is `delivery: standard`, so
its list is paid on every answering turn — 2,157 cl100k tokens for the seven
inlined since migration `0061` (`verdict_header`, `condition_tree`, `typed_table`,
`key_takeaways`, `callout`, `process_map`, `follow_ups`). `typed_table` and
`process_map` joined for +265 and +693 respectively, because they are the two
cards the doctrine spends its words redirecting TO and both were a round trip
away while `condition_tree`'s shape sat already rendered. The ceiling on that
block is asserted in `test_seeded_platform_skills.py`; widening it is a priced
decision, not a preference.

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
or more options weighed against each other → `comparison_table`. The reason
travels with the rule: an answer that turns on a dimension gets its card by
default rather than on request, because a measurement written as a sentence
makes the reader re-draw it in their head, and the card is the drawing they
would have made.

### Where the doctrine lives, and which surface gets which half

The text is assembled by `render_card_doctrine()` in `cards/catalog.py` — the
framing-free module that already owns `render_card_index` / `render_card_details`
— because there are TWO surfaces that produce cards and only one of them used to
be taught how to choose.

`register.py` composes `render_card_doctrine()` with the `[[card:N]]` placement
contract and exports the result as `_CARD_DOCTRINE`, which is what `emit_card`'s
description carries.

`cards/prompt.py` composes `render_card_doctrine(include_ifc_triggers=False)`
for the post-hoc path that derives cards from a finished deep-research report.
That path used to carry the disclaimer this section describes replacing — on the
surface producing the LONGEST answers, the ones that most need a takeaway block,
a callout and follow-ups. Three parts are deliberately withheld from it, and the
reason is the same each time: they are not true there.

- The **`[[card:N]]` placement contract**. The job runner emits the report
  unchanged and attaches the returned list, so there is no text to place into.
  List order is render order, and the doctrine's "put `follow_ups` last" gets an
  ordering rule to refer to instead.
- **`describe_card`**. There is no tool loop; the shapes are already inline.
- The **`ifc_model_picker` trigger**, though not its shape. That trigger fires on
  a live "zeig mir das Modell" intent and says to emit the card *instead of*
  writing the file names as prose — a trade that is no longer available once the
  prose is written. Note the picker is still NOT in `MODEL_BACKED_CARD_TYPES`:
  that set means "every identifying field must be copied from an `ifc_query`
  row", and the picker names no file and invents nothing. Withholding a trigger
  and withholding a shape are different decisions with different reasons, and
  conflating them would put the wrong reason on the wrong set.

The CRAFT — which of the generic cards actually improves an ordinary answer, and
how `verdict_header` divides the ruling with the answer's first sentence — is in
neither. It lives in the `piloti-cards` platform skill, a database row applied on
every answering turn and editable without a deploy. The post-hoc path cannot
reach a skill runtime, so it carries the subset of that judgement which is a test
over a finished text rather than an instruction about how to write one.

A positive trigger that strong needs an **explicit negative default** beside it
or it produces card spam, so the doctrine states that too: a one-line factual
answer gets no card; a card that repeats the sentence above it costs the reader
a second pass over the same fact; two cards in a turn is plenty, and past that
the written answer stops being the answer; and no field, reference or number may
be fabricated to fill a card out — a card with an invented limit in it is worse
than the prose alone, because it is the part that gets screenshotted into a
submission.

### Which turns may emit a card

Every turn, including one the intent classifier routed as `meta`. This used to be
contradictory rather than decided: the shallow prompt's meta output contract said
"no tool calls" while the `<cards>` block six lines below sat outside both
`{% if requires_sources %}` guards and told the model to emit one. The
mandatory-sounding half won, and a Baurecht question that classified `meta` —
„Wie läuft das Baubewilligungsverfahren in Wien ab?", retyped in plain words
after a research plan was refused — shipped as prose twice.

Resolved toward allowing it, on the grounds that `_meta_tool_binding`
(`shallow_researcher/agent.py`) has always kept `remember`, `emit_card` and
`describe_card` bound on that turn. "No tool calls" was never a description of
what the turn could do; it was a prompt line disagreeing with its own runtime.
Classification decides whether the turn needs SOURCES, not whether the answer has
anything worth showing.

Two things bound it:

- **The prompt says what a meta turn may put on a card.** A subject-matter
  question that merely landed in this shape earns the card its content calls for;
  small talk, a formatting or memory request, a shelf listing and an off-topic
  decline get none. The off-topic shape still reads "No tool calls".
- **The skill gate stays shut.** `register.py` builds a `SkillRuntime` only when
  `requires_sources or force_skills`, so a meta turn does NOT get the
  `piloti-cards` body. Opening it would cost ~7,400 cl100k tokens on every
  greeting (5,239 for the body plus the inlined shapes). What the turn keeps is
  the always-on doctrine and the L1 index, which ride in `emit_card`'s
  description regardless — enough to NAME the right card. The shape costs one
  `describe_card` call, which is why `describe_card` is pinned into
  `_INTERACTION_TOOL_BASENAMES` rather than surviving by having no data source.

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
   place belongs in the `piloti-cards` skill. Both halves are asserted against
   each other, and a token ceiling on the tool description fails if the doctrine
   drifts back into carrying craft.
7. For a **system** card (tool-emitted, never model-emitted): add it to
   `SYSTEM_CARD_TYPES` and register the emitting tool in the agent's `tools:`
   list in the config.

## Card catalog

The catalog is the thirty-seven types tabulated under
[Current card types](#current-card-types) — fourteen structured, fifteen
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
  with nothing but the tool description to go on. That description is a much
  better thing to hold since it gained the doctrine, but the doctrine names no
  IFC trigger (that guidance stayed in the shallow prompt, above), so a deep
  answer about the building still comes back as prose with element links.
  Closing this means giving
  the deep researcher the same `<cards>` guidance the shallow one now has, not
  relaxing the post-hoc restriction, which would only license invented ids.
- A silent card-generation failure is currently indistinguishable from "no cards";
  emission should surface failures.

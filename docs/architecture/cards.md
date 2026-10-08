# Cards — the agent's rich-UI presentation layer

> How GRID's agent returns structured, rendered UI instead of plain prose when
> that serves the user better. See also [ADR-0012](../adr/0012-cards-as-rich-ui-layer.md).

## What a card is

A **card** is a typed, structured piece of an answer that the frontend renders as
rich UI rather than markdown. The answer itself is Markdown prose, and a card
earns its place only by carrying what Markdown cannot: an **interaction** (a
decision to confirm), **geometry drawn to scale** (the schematic cards), a
**number the card computes** (`calculation`), a **live binding to the building
model** (the IFC cards), or **variants in tabs** (`surface`). A table, a list,
a status mark, a flowchart or a quoted Fundstelle is Markdown, and the renderer
draws it richly (see *Markdown carries the rest* below). `StairDiagramCard` is
one instance.

### Cards and A2UI: one thing, two layers

A2UI did not replace cards; it is how cards are drawn. A **card** is WHAT the
answer states: a typed, validated object (`calculation`, `stair_diagram`,
`ifc_viewer`), checked by its Pydantic model and stored on the message.
**A2UI** is HOW it reaches the screen: the protocol and renderer
([ADR-0065](../adr/0065-a2ui-renders-every-card.md)) that draws a component
list from a catalog. Our catalog IS the card types, one A2UI component per
type, plus A2UI's own `Row`, `Column`, `Tabs` and `Text` to arrange them.

So "card" is our word for a component in our A2UI catalog, and a `surface`
card is an A2UI component list of them. What A2UI added is composition and a
standard wire format; what the card layer keeps is the part A2UI knows
nothing about: which content earns which card, validation against the
sources, and the persisted decisions of interactive cards.

## Current card types

Defined in `src/aiq_agent/cards/models.py` as a discriminated union (`GridCard`)
— **22 types in four families**: 17 the answering model may emit, 16 of them
through `emit_card` too; the 17th is `surface` (ADR-0065), a composition whose
leaves are content cards or `Text`, offered on the chat envelope only
(`CHAT_ONLY_CARD_TYPES`: `emit_card`, `describe_card` and the post-hoc
validator refuse it, because only the chat pipeline recites its `[N]`); and
five it may not on any surface (`SYSTEM_CARD_TYPES`, the tool-owned cards).

Twenty-three former types were **deleted** from the union in 2026-09
(`catalog.RETIRED_CARD_TYPES`, before launch, so no stored message needed
them): the table-, list- and quote-shaped cards (`typed_table`,
`comparison_table`, `requirement_checklist`, `document_checklist`,
`deadline_timeline`, `norm_chain`, `change_impact`, `condition_tree`,
`process_map`, `legal_basis`, `diagram`), the domain gauges whose content is a
check table (`fire_compartment`, `thermal_envelope`, `energy_performance`,
`acoustic_check`, `parking_requirement`), `density_check` (now `setback_plan`'s
coverage/GFZ readout), `elevator_requirement` (now `dimension_diagram`'s
`lift_cabin` template), `follow_ups` (the post-answer stage), and the four
envelope twins `summary`, `verdict_header`, `key_takeaways`, `callout`. Those
four are native answer anatomy: a research answer is generated as one JSON
envelope (```answer_json — `src/aiq_agent/common/answer_envelope.py`) whose
optional fields carry the summary, the verdict, the takeaways and the callout,
validated and gated platform-side and rendered as answer typography
(`features/chat/components/AnswerAnatomy.tsx`); the callout sits beside the
paragraph the model anchored it to with an own-line `[[callout]]` marker
(`answer_envelope.CALLOUT_MARKER`), or after the prose when unanchored. A
model that still reaches for a deleted type by name is refused on every
channel with the Markdown that replaced it (`RETIRED_CARD_REPLACEMENTS`,
`retired_refusal`). On the generation side the envelope is REQUESTED from the provider too, not only taught: Piloti
walks an enforcement ladder per call — OpenRouter structured
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
| `project_profile_patch` **(interactive)** | A proposed change to the project brief | `title`, `rationale`, `patch[]` — JSON-Patch ops restricted to `/facts`, `/goals`, `/unknowns`, `/assumptions` (the before/after rows are built from the patch and the live profile, never from the model) |
| `calculation` | The derivation behind a computed number — the Schrittmaßregel, a GFZ, a Brandlast, a U-value from its resistances. **There is no result field**: the model supplies operands, an operation from a closed set (`sum`, `product`, `quotient`, `percent_of`, `percent_ratio`) and the limit; the renderer computes, propagates the ± band, rounds and judges | `title`, `steps[]` (`label`, `operation`, `operands[]`, `unit`), `limit`, `reference`, `note` |
| `surface` | Variants the reader picks one of, or cards that read together in one slot (ADR-0065). An A2UI v0.9 component list: a `Row`, `Column` or `Tabs` root whose leaves are content cards or `Text`; see [Every card is drawn through A2UI](#every-card-is-drawn-through-a2ui) | `title`, `components[]` |

**Schematic cards** — eight programmatically-drawn technical diagrams (SVG kit
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
| `dimension_diagram` | one of seven templates — door, ramp, corridor, turning circle, threshold, parking space, lift cabin (Kabinenbreite, Kabinentiefe, lichte Türbreite; took over from `elevator_requirement`) — with a dimension arrow drawn where each is measured | accessibility (OIB 4 / ÖNORM B 1600) |
| `setback_plan` | the parcel, the footprint and the required-setback envelope, one distance arrow per edge; with `coverage` / `density` also the Bebauungsgrad and GFZ read against the Bebauungsplan's limits, the ratios derived by the renderer from the areas (took over from `density_check`) | Abstandsflächen / Bauwich / zoning density |
| `egress_diagram` | the escape path run by run from the worst-case point, total length vs the OIB limit (typically 40 m) | fire / escape routes (OIB 2) |
| `daylight_incidence` | a window section, the 45° free-light line, any obstruction, and the glass-vs-floor-area check | daylight (OIB 3) |
| `guardrail_check` | a railing elevation with height, max opening and bottom-gap checks, and the no-climb band shaded | Absturzsicherung (OIB 4) |
| `fire_access_plan` | a Feuerwehrzufahrt site plan: access route, Aufstellfläche beside the facade, reach to the farthest entrance | fire access (OIB 2 / TRVB) |

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
| `document_grid` | project/Büroablage files the user asked to see — the same raised `FileCard` the Files grid uses | the `surface_documents` tool |
| `memory_proposal` **(interactive)** | a finding to be written to org- or project-scoped memory, for the user to confirm | the `remember` tool |
| `document_draft` | a document written into this conversation's working directory — title, path, `v{n}` and size, with the Files feature's „Von Piloti erstellt" byline. Its „Ins Projekt übernehmen" is drawn **inert**: filing is a later slice, and until it is wired the card reports the draft rather than offering to move it | the working directory's `write_file` / `edit_file` |
| `task_created` | work Piloti has taken on, as a task row somebody can come back to — title, goal, due date and a link to the run's thread. Informational: the task is already queued when it renders, so there is no Accept | the `create_task` tool |
| `file_operation_proposal` **(interactive)** | a workspace change the agent PROPOSED and did not make — a move, a rename, a new folder, an assignment. One card type for four verbs, discriminated by `operation`, carrying a capped LIST so an „organise the Einreichung" turn is one decision and not four. Accepting runs the operations in order through the routes the Files pane uses, in the reader's own session, and reports each one — a batch where the third fails says three landed and one did not (`partiallyApplied`) | the four write-side tools under `src/aiq_agent/tools/files/` (a Dokumentart proposal waits for a project-scoped doc_class route) |

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

### Markdown carries the rest

A drawing whose geometry nobody computes is a ```` ```mermaid ```` fence in the
prose, not a card: the `diagram` card was deleted with the other retired types,
and a fence draws through the same renderer (`MarkdownRenderer` →
`MermaidDiagram`) and files through the same button. A Verfahren that forks or
returns is a `flowchart TD` with the Fristen on its edges. Anything measured
stays with the schematic cards, where the renderer draws to scale
([diagrams.md](diagrams.md)).

The rest of what the retired cards carried is Markdown the model declares with
a small directive dialect, taught in `piloti_static.md` <formatting> (RICH
BLOCKS) and drawn by the frontend: `:::check` around a check table (a value
against a `≥`/`≤` limit draws as a bar), `:::procedure` around a straight
Verfahren's numbered list (the current step marked `:current`, its Unterlagen in
an indented `:::details`), `:::cases` around a table of cases (this project's
row carries Status `trifft zu`), `:::metrics` for two to four key numbers,
`:::compare` for variants as columns, `:::details[…]` for detail, `:energy-class[B]`
for an Energieeffizienzklasse, and a cited quote line `> „…“ [N]` for the
wording an answer turns on, verified against the source like every quote
(`verify_quoted_spans`). The backend treats the directive lines as inert text:
citation verification, renumbering, quote verification and the report hygiene
pass keep them byte-equal (`tests/aiq_agent/agents/piloti/test_answer_pipeline_directives.py`;
the hygiene pass keeps a line's leading indentation and never pulls the space
out of „Klasse :energy-class[B]").

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

**Since 2026-09 the model's own cards travel in the answer envelope.** The
`cards` field of the ```answer_json object carries the card objects in the
same message as the answer (`common/answer_envelope.py`, `cards/envelope.py`);
the pipeline validates each one with the same adapter and the same two closed
channels `emit_card` runs, registers them in the same per-turn `CardRegistry`
after whatever the tools pushed, and moves the prose's `[[card:N]]` markers
from array numbers to registry positions. A shape the validator refuses is
repaired once on the small card model (`cards/repair.py`, `card_repair_llm`),
or dropped and recorded (`status:card:invalid:N`). The reason is the round:
`emit_card` is a tool call, a tool call ends a message, and every card-bearing
answer paid one more full-context call to write the prose after it — and a
third on a wrong shape. Nothing on the wire changed. The taught envelope
schema carries the doctrine, the index and the full shape of the one content
card whose shape is easy to get wrong and that answers earn most
(`ENVELOPE_SHAPE_TYPES`: `calculation`), COMPOSE and the placement rule,
cached with the prefix; every other shape stays on demand.

**The answer's own Markdown comes first, on every surface.** The doctrine
(`render_card_doctrine`) opens with MARKDOWN FIRST: tables, lists, flowchart
fences and verified quotes carry what the retired cards carried, and a card is
only for an interaction, geometry to scale, a computed number, a live model
binding or tabs. The renderer meets the prose halfway: in a table's Status
column (headed `status`, `erfüllt`, `ergebnis`, `bewertung` or `result`), a
cell that holds exactly one status word renders as a toned mark
(`MarkdownRenderer/status-marks.ts`), and the column's tally above the rows
counts each word however it is capitalised (`MarkdownRenderer/table-shape.ts`);
the same word in any other column stays a word. The details:
`docs/design/answer-visuals.md`. The shape rules for the prose (first line
answers, `###` headings that state, a Fundstelle column, the status vocabulary
including `trifft zu` and `aktuell`, the directive dialect) live in the
`<formatting>` block of `piloti_static.md`.

Deep research can still emit cards via the **`emit_card` tool**
(`cards/register.py`); Piloti (chat) no longer binds it, and its cards travel
in the envelope's `cards` field only. Mid-turn, with full context, the
researcher calls the tool whenever a structured element communicates better
than prose. The card is
validated against the shared schema and pushed into the conversation-scoped
`CardRegistry`. System cards (`document_draft`, `document_grid`,
`file_operation_proposal`, `task_created`, `memory_proposal`) are pushed by the
tool that did the work and never by the model, on either channel. The chat entrypoint snapshots that registry after the turn and
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
keep growing. The schematic cards alone were carrying ~2,900 tokens of
nesting into conversations that will never draw a stair.

So the catalog is split the way the skills runtime already splits instructions
(`agent-skills.md` § Selection & progressive disclosure):

| level | what it is | where |
|---|---|---|
| **L1 — always on** | one line per model-facing type: the `type` value and the first line of the card model's docstring, plus the interactive-card note. No shapes, no building blocks, no examples. | `render_card_index()`, rendered into the `emit_card` description |
| **L2 — on demand** | the exact shape for the named types, the shared building blocks (`NormReference`, `DimensionCheck`, …) each defined once with field descriptions, the measurement note where a `DimensionCheck` is in play, and the worked example | `render_card_details(types)` — returned by a **failed `emit_card`** for the type that failed, by the **`describe_card`** tool (registered, bound to no agent today), and by a skill declaring `grid-cards` |

That took the `emit_card` description from ~5,209 to ~1,205 tokens per turn, and
the marginal cost of a new card type from ~190 tokens on every turn to ~23. It is
what makes a growing card vocabulary affordable on a cost-optimised model tier —
and what stops the always-on half from diluting attention on a long turn.

`render_card_catalog()` still exists and is still the one rendering both card
surfaces share. Post-hoc generation keeps taking it whole
(`build_card_generation_prompt()`): it is a single batch call with no tool loop,
so there is nothing there that could fetch L2 later.

L2 is no longer fetched in advance on the chat path. `describe_card` was a
charged round trip, and `emit_card`'s description had to talk the model into
paying it on every turn, for every card — including the ones it would have
filled in correctly. But a shape is only ever needed when the first attempt
would have been wrong, so the RETRY carries it: a failed `emit_card` returns the
same L2 entry for the type that failed, and `shape_hint_for` is now one line
delegating to `render_card_details`, whose entry for `surface` is the COMPOSE
rule. A surface whose leaf fails its card model is repaired from the rule plus
the shapes of the card types it holds. A card that was going to be right pays
nothing; one that was not pays the same single round trip, knowing which field
was wrong. `describe_card` stays registered but is bound to no
agent today (see its comment in `configs/config_oib_openrouter.yml`); deep
research, which composes one long report, would pay the lookup once where a
chat turn paid it per turn.

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
into the `<cards>` section of Piloti's system prompt, and the rhetorical
shapes it inlined became `answer_meta` trailer fields. Today the mechanism
serves the genre skills (e.g. `oib/brandschutz` inlines its five), which pay
for their shapes only on the turns that activate them.

Taking a retired type OUT of the list is not tidiness. `preferred_cards` filters
`grid-cards` against `model_facing_card_types()`, so a name left behind is dropped
silently on every read — a seed naming a card the runtime never sees, which is the
drift `test_seeded_grid_cards_survive_the_read_path` exists to catch.

### Retiring a card type

A card type is retired by **deleting** it: the pydantic model leaves the
`GridCard` union, the generated schemas are regenerated, and the frontend drops
its renderer. The name moves into `RETIRED_CARD_REPLACEMENTS` in
`cards/catalog.py` with one line saying what carries its content now. That map
is the whole of what survives, and it exists for the model, not for stored
data: `validate_model_card` (the envelope's `cards` and `emit_card`) refuses a
retired name by its declared type, before the shape check could send it to the
repair model, and answers with that line (`retired_refusal`); a `surface` leaf
of a retired type is refused with the same sentence and told to use a `Text`
leaf. Post-hoc generation (`validate_cards`) and the DSML salvage drop it as
the unknown type it is, and a skill's `grid-cards` naming it is a parse error
for a SKILL.md and a logged drop for an org row. The frontend meets any card
its schema no longer knows with a generic fallback rather than a hole.

The checklist:

1. delete the model from `cards/models.py` (and from `GridCard`, `__all__`,
   `CARD_EXAMPLES`, the trigger table and any craft or note naming it);
2. add its name and replacement to `RETIRED_CARD_REPLACEMENTS`;
3. regenerate: `uv run python scripts/generate_card_schema.py`, then
   `npm run generate:cards` in `frontends/ui`;
4. remove it from every builtin skill's `grid-cards` and body, then run
   `node frontends/ui/scripts/sync-platform-skills.mjs`;
5. remove the renderer, its `CARD_INTERACTIVITY` entry, its export mapping and
   its entry in the frontend's `SURFACE_EXCLUDED_LEAVES` if it had one
   (`test_interactive_card_parity.py` and `test_surface_excluded_parity.py`
   hold the two halves together);
6. teach the replacement in `piloti_static.md` if it is Markdown.

`tests/aiq_agent/cards/test_retired_card_types.py` holds every retired name to
every channel.

### `emit_card` carries the doctrine, not a disclaimer

The description used to say "emit a card only when it adds real value". That is
a disclaimer, not an instruction, and fifteen diagram renderers sat behind it —
while eight lines away in `piloti.j2` the IFC block named a trigger and gave
a reason, which is exactly why the IFC cards were emitted and the schematics
were not.

The doctrine opens with MARKDOWN FIRST (what the prose carries), then names
the trigger for each remaining card: a riser, tread or stair width →
`stair_diagram`; a clear width, ramp or turning circle → `dimension_diagram`;
an escape route with segments → `egress_diagram`; a fall height, railing or
opening → `guardrail_check`; a distance to a parcel edge, or Bebauungsgrad,
Bebauungsdichte or GFZ → `setback_plan`; a barrier-free lift's cabin →
`dimension_diagram` (`lift_cabin`); a number the answer worked out →
`calculation`. The reason travels with the rule: a measurement written as a
sentence makes the reader re-draw it in their head, and the card is the drawing
they would have made. A match is a reason, not an obligation.

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
  instead — the substance the report turns on first.
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
rendering. It lives in the `<cards>` and `<answer_meta>` sections of
Piloti's system prompt (`piloti/prompts/piloti.j2`), where
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

Piloti forces synthesis at `tool_iteration_ceiling` (`max_tool_iterations`,
seven in production — one number, with nothing reserved on top of it since no
skill is forced on a turn), and every tool CALL used to be charged to it —
`emit_card` and `describe_card` included. Those are the answer's OUTPUT
channel, and they are called last, after the searching is done, so on any turn
that actually researched, the ceiling landed on the cards rather than on the
research. The forced-synthesis anchor then says "Do not attempt any further tool
calls", which made the second card unreachable by construction: the model had
already decided to draw it, and nothing in the answer, the log or the
`research_truncated` note said what had been lost.

The fix was the UNIT, not an exemption. The budget counts tool-calling ROUNDS
now — one LLM decision that emitted tool calls, costing one whatever it asked
for — so a round that draws a shape lookup and both cards costs exactly what
the search before it cost, and the card channel needs no allowance of its own.
The separate `_INTERACTION_TOOL_ALLOWANCE` and its `interaction_iterations`
counter are gone with the per-call budget they existed to survive: a second
currency is a second thing to keep in step, and this one now buys nothing.

The rule this leaves is the one that was always meant to be in force: how many
cards an answer carries is a judgement about the answer, decided by the doctrine
and the prompt's card craft — never a leftover of how much searching the
question happened to need.

### Which turns may emit a card

Every turn. On chat the answer envelope's `cards` field is part of every
answer (ADR-0052: there is no classifier and no narrowed "meta" binding in
front of the answering agent), so whether a turn ships a card is decided by
what the answer has to show, never by a label given before the answer. Piloti
no longer binds `emit_card`; only deep research does.

This used to be contradictory rather than decided: when the intent classifier
still existed, Piloti's prompt's meta output contract said "no tool calls"
while the `<cards>` block six lines below sat outside both `requires_sources`
guards and told the model to emit one. The mandatory-sounding half won, and a
Baurecht question that classified `meta` — „Wie läuft das
Baubewilligungsverfahren in Wien ab?", retyped in plain words after a research
plan was refused — shipped as prose twice. Deleting the classifier removed the
contradiction with it.

What bounds it now is the prompt: **it says what a direct reply may put on a
card.** A subject-matter question that merely landed in a short reply earns the
structure its content calls for; small talk, a formatting or memory request, a shelf
listing and an off-topic decline get none. On chat the doctrine, the L1 index
and the shapes of `ENVELOPE_SHAPE_TYPES` ride in the envelope contract
(`render_envelope_cards_contract`, `cards/envelope.py`) on every turn —
enough to name the right card AND to build it, with a card the validator
refuses handed to the small repair model (`cards/repair.py`) rather than back
to the answering agent. Deep research still reads the doctrine in
`emit_card`'s description, and gets the shape on the retry. Skills, too, are bound on
every turn (`use_skill`); there is no gate in front of the skill runtime any
more, and no way to require a skill either, so a greeting that loads no skill is
the model's judgment, pinned by the prompt.

### Every `emit_card` outcome is logged, refusals included

A turn that shipped without its card used to look identical after the fact
whether the model never called `emit_card` or called it and was refused — only
the success path wrote a log line. Those have opposite fixes (a doctrine that
never got the card named, versus a shape the model cannot fill in), so every exit
in `_emit` now logs: refusals at `warning` naming the card TYPE the model reached
for, the success at `info` as before.

Because the doctrine lives on the tool, Piloti's `<cards>` block
no longer restates it — and since the craft moved there too, it no longer
restates that either. The prompt points at the `emit_card` description and keeps
only what the tool cannot say, because it is a fact about the ANSWER rather than
about the tool: the `[[card:N]]` placement marker contract, and that a verdict,
the key takeaways and the callout are `answer_json` envelope fields rather than
cards. Two copies of a rule is two things to keep in step, and the prompt copy
is the one that silently falls behind — which is exactly what happened while the
craft lived there.

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
  one shelf so a Büroablage browse cannot pull project files. A question
  that only *lists* what is on a shelf ("welche Dateien hast du im
  Büroablage") is answered from the shelf-grouped inventory, not this
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

Emitting one is not optional politeness: Piloti's `<cards>`
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

### Every card is drawn through A2UI

Since ADR-0065 a card reaches the screen through
[A2UI](https://a2ui.org) v0.9: `GridCardItem` hands it to `A2uiCard`
(`features/a2ui/`), which turns it into an A2UI surface (a stored card is a
one-component surface whose root is the card) and draws it with
`@a2ui/react` on the Piloti catalog. The catalog registers one A2UI component
per card type, named by the type and validated by that card's generated Zod
schema, plus `Row`, `Column`, `Tabs` and `Text` in the basic catalog's shapes. Each
card component calls back into `GridCardView`, the per-type dispatch that used
to be `GridCardItem`, so the pixels are the same components as before.

- **Composition.** A `surface` card carries an A2UI component list: a
  container with id `root` and the content cards it holds. `SurfaceCard` in
  `cards/models.py` checks the structure with `a2ui-core` (unique ids, a root,
  no dangling reference, no cycle, no orphan) and each card with its own
  model; tool, interactive and envelope cards may not be leaves. The model is
  taught the shape in the envelope contract's COMPOSE paragraph. A `Row` sits
  side by side above 44rem of its own width and stacks below it (a narrow
  window, a side panel); `Tabs` show one variant at a time.
- **Limits.** `SurfaceCard` holds 2 to 6 leaves (`SURFACE_MAX_LEAVES`). A
  `Row` or `Column` has 2 to 4 children (`SURFACE_MAX_CHILDREN`), and its
  `justify` / `align`, when set, take only the values the frontend's `RowApi`
  takes (`SURFACE_JUSTIFY`, `SURFACE_ALIGN`). `Tabs` has 2 to 6 tabs
  (`SURFACE_MAX_TABS`), each exactly `{title, child}`. A `Text` holds at most
  4000 characters (`SURFACE_TEXT_MAX`). The root must be a layout: a surface of one
  card is that card. The prompt (`_COMPOSE_RULE` in `cards/envelope.py`)
  counts a surface as one card against the turn's two-card ceiling.
- **`Text`: the answer's Markdown inside a surface.** A leaf
  `{"id", "component": "Text", "text": <Markdown>}` is drawn by the renderer
  the prose is drawn by. It exists because the Markdown-first doctrine puts
  tables, checks and steps in the prose and never on a card, so without it a
  tab could hold none of what a variant actually consists of. Its `[N]` are
  held to the answer's citations (`cards/surface_citations.py`). A `[N]` whose
  source verification removed is dropped, never renumbered onto the source
  that now holds N: sanitize's map lists only survivors. An empty map leaves
  numbers as they are, and each is kept only if it is cited (applied in
  `answer_pipeline.py` on the settled frame and after sanitisation). Code is
  left alone: `S[1]` in a mermaid fence or `x[1]` in inline code is not a
  citation. A `Text` left blank is dropped with its tab or child; when the
  surface cannot stand without it, the one card left becomes the card, and
  failing that the leaf reads `—` (`surface_citations.BLANK_TEXT`). The stored
  card never keeps its unrecited numbers, and its registry position never
  moves. The frontend parses them with the answer's
  citation plugin through `NestedMarkdownPluginsProvider`, and the Word
  export prints them as prose.
- **Never the library's placeholder.** `A2uiSurface` cannot render on the
  server and draws "[Loading root...]" for its first frame, so the card is
  drawn directly until A2UI's copy, mounted invisibly behind it, reports its
  first component from a layout effect; the two swap before paint.
- **Never a card lost to the library.** `preflight` checks every component
  against the catalog before A2UI sees it (A2UI would draw an unknown one as
  red text), and refuses a surface that is not one tree under `root`: ids
  unique, `root` present, every child and tab id resolves, each id referenced
  once, no cycle, every component reachable (`structuralRefusal`, the same
  checks `SurfaceCard` runs in `cards/models.py`). A render that throws inside
  A2UI falls back to the direct component. A refused surface falls back to its
  cards stacked in order, leaving out any leaf in `SURFACE_EXCLUDED_LEAVES`.
  That list refuses a leaf only inside a surface: a lone card of such a type
  (a stored `summary`, a `memory_proposal`) is drawn through the catalog.
- **An observer reads, never acts.** A spectated turn draws cards read-only
  (`AgentResponse`'s `readOnly`): an observer cannot answer the asker's
  decision cards or file their diagrams.
- **Export** walks a surface from its root and prints its cards in order, a
  tab's title as a heading one level below the surface's and its card one
  level lower (levels 3–5); a `Text` leaf's headings never outrank the surface
  title (`answer-export/cards.ts`, kind `composite`).
- `/dev/a2ui` draws every fixture and two compositions through this path;
  each section says whether A2UI drew it.

### Where a card lands: `[[card:N]]`

Cards used to be drawn as a block, all of them, after the whole answer — so the
stair diagram sat three screens below the paragraph about the stair, and a reader
had to scroll past every drawing to reach the sentence they asked for.

Each `emit_card` call now returns a marker naming the card by its POSITION in
this turn's registry (`[[card:2]]` for the second card emitted). A marker written
on a line of its own in the answer body is consumed by a remark plugin
(`grid-cards/card-markers.ts`) and the card is spliced in at that point; the
cards no marker claimed still follow the prose as a block, which is also what
happens when the answer places none. While the answer streams, that block is
drawn as soon as "unplaced" is final: a live frame carries cards only once the
envelope's `answer` string has closed (the tools' cards of the turn go out at
that moment, ahead of the envelope's and numbered as the terminal numbers
them, `LiveAnswer.place`), so an answer that holds cards has all
its prose, and once the paced reveal has shown it no marker is still to come
(`unplacedIsFinal` in `features/chat/components/AgentResponse.tsx`). It used to
wait for the terminal frame, after verification and the rest of the pipeline. Position is used rather than an id because
an id would have to survive validation, persistence AND the deep-research path,
which builds its cards post-hoc from a finished report and has no emission order
to refer back to.

The contract is stated in `piloti.j2` as well as in the tool return, and
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

No cross-card rule is left. The one there was (`summary` dropping its 17px
headline under a `verdict_header`) left with both types (ADR-0069), and with it
the provider that let a card read its neighbours: a card's look depends on its
own payload alone.

## Interactive cards: the answer MUST be persisted

> ⚠️ Full rationale: [ADR-0030](../adr/0030-interactive-card-decisions-persist-on-the-message.md).
> **Read this before adding, editing, or reviewing any card that has a button
> which writes something.**

Most cards are pure presentation: same payload in, same pixels out, nothing to
remember. **Two are not.** `project_profile_patch` and `memory_proposal` ask the
user to authorize a write (`propose, never auto-apply` —
`project-memory-design.md` §11.7), which makes the user's click the only place
that outcome exists.

`diagram` was briefly a third and was never made one; the card has since been
retired for a ```` ```mermaid ```` fence (see
[Markdown carries the rest](#markdown-carries-the-rest)). A `CONSENT_CARD_TYPES` was split out of `INTERACTIVE_CARD_TYPES` at the
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

No, if it only opens a read-only view. `document_grid` opens a file dialog —
it holds local `useState` and is correctly classified `presentational`,
because nothing is committed.

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
5. Add a fixture to the `/dev/cards` gallery, then capture it and attach the
   capture to the PR (`docs/ux/visual-screenshots.md`).
6. **Give it a trigger in the doctrine** (`render_card_doctrine` in
   `cards/catalog.py`) — which question calls for it, in the same
   "trigger → card" form as the rest. A type that is only listed in the index is
   a renderer nobody is asked for, which is a renderer nobody sees; that is
   exactly how the schematic cards once sat behind a disclaimer. The trigger row
   and its CRAFT go in together, as one `_CARD_TRIGGERS` entry: "which card" and
   "how that card is filled well" are a question and its answer, and the years
   they spent in two files are why the prompt's copy grew a second budget and a
   second restatement test beside the doctrine's. A generic shape needs craft; a
   schematic one usually does not, because its renderer draws to scale from the
   fields. A token ceiling on the tool description watches the total.
7. For a **system** card (tool-emitted, never model-emitted): add it to
   `SYSTEM_CARD_TYPES` and register the emitting tool in the agent's `tools:`
   list in the config.
8. Before any of this, ask whether Markdown already carries it. A card must
   carry an interaction, geometry to scale, a computed number, a live model
   binding or tabs; anything else is a table, a list, a fence or a directive
   block in the prose.
9. For an **envelope** field (native answer anatomy, never a tool call): add
   a model, a registry entry and a gate in `common/answer_envelope.py` (the
   taught schema renders itself from the models), an earned-when line in the
   prompt's `<answer_envelope>` section, a sanitizer clause in
   `lib/conversations/message-answer-meta.ts`, and a layout slot in
   `AgentResponse`. The bar is high on purpose: an envelope field is paid for in
   contract complexity on EVERY research answer, so it is for shapes almost
   every answer could carry, not for domain cards.

## Card catalog

The catalog is the twenty-two types tabulated under
[Current card types](#current-card-types) — three structured
(`project_profile_patch`, `calculation`, `surface`), eight schematic, six
model-facing IFC and five system — and that is the only place in this document
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
| The sample cards | `features/grid-cards/preview-fixtures.ts` — authored in schema-INPUT shape, then run through `validateGridCards`, so a fixture that stops matching the union is holed (absent from the map) rather than rendered |
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
backend-free `document_grid` surfacing card. Capture either with the
`agent-browser` skill and attach it to the PR that changes it — no image files
are committed (see `docs/ux/visual-screenshots.md`).
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
  and only the emitted cards were ever addressed by a marker. Positions hold
  end to end because `validateGridCards` never compacts the array: a card the
  frontend schema rejects leaves an `undefined` hole at its wire index, so a
  marker after the hole still names the card it was written for (a marker
  pointing AT the hole renders nothing), and a persisted `cardKey` decision
  stays bound to its proposal across reloads.
- Which subagent holds the tools: everything in the deep agent's `tools:` list
  goes to the RESEARCHER workers (`factory.py::build_deep_research_tool_set`);
  the writer holds helper and skill tools only, and the orchestrator the
  research batch tool. So an emitted card is a researcher's, and its marker
  never reaches the report the writer produces — the card lands after the
  report, which is where an unaddressed card goes anyway.
- Async deep-research answers carry cards (generated post-hoc from the final
  report in the job runner); synchronous inline deep research (`use_async_deep_research` off) does
  not run the post-hoc pass yet, though it inherits the chat turn's registry
  and so does deliver emitted cards.
- **An async deep-research answer therefore carries no model card**, because
  post-hoc generation is not shown the IFC types (above) and the deep
  researcher's own prompts have no `<cards>` block at all — it holds `emit_card`
  with nothing but the tool description to go on. That description is a much
  better thing to hold since it gained the doctrine, but the doctrine names no
  IFC trigger (that guidance stayed in Piloti's prompt, above), so a deep
  answer about the building still comes back as prose with element links.
  Closing this means giving
  the deep researcher the same `<cards>` guidance Piloti now has, not
  relaxing the post-hoc restriction, which would only license invented ids.
- A silent card-generation failure is currently indistinguishable from "no cards";
  emission should surface failures.

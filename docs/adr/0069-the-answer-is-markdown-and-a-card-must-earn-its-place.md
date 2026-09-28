---
status: accepted
date: 2026-09-28
decision-makers: Grid engineering, product owner
consulted:
informed: everyone working in this repo
---

# The answer is Markdown, drawn richly, and a card must carry what Markdown cannot

## Context and Problem Statement

An answer is an envelope: a masthead, Markdown prose with `[N]` citations,
tables and mermaid fences, and typed cards. The card catalogue grew one type
per content shape until ~35 of its 45 types were model-emittable, and the
model's answers showed what that costs:

- **One fact, two forms.** Measured 2026-09-28 with the real static prompt: a
  `legal_basis` card on 59 of 64 rulings, quoting the passage the `[N]` chip
  already opens; a mindmap repeating its own table on 12 of 24 overviews
  (`answer-visuals.md`); a `process_map` on 11 of 24 procedure answers beside
  the prose that walked the same steps.
- **The card is the unverified copy.** Prose quotes are checked against the
  retrieved passage and repaired (ADR-0067). `legal_basis.original_text`, the
  quote presented as the answer's proof, was checked by nothing.
- **Withheld is not refused.** The chat prompt stopped teaching the table-like
  cards on 2026-09-24, but the validator still accepted them, and deep
  research still offered them.
- **Cards do not travel.** Copy takes the prose alone, and filing and other
  clients see nothing of a card. A Markdown table goes everywhere the answer
  goes.
- **The prompt contradicted itself** about which form a Verfahren, a
  conditional requirement or an overview takes, because every form existed
  twice.

What the leading products do (researched 2026-09-28, sources in the PR):
the answer is Markdown prose; citations are inline markers whose popover
holds the verbatim passage (Anthropic's Citations API returns `cited_text`,
Harvey reads "the relevant passage next to the claim", CoCounsel and Lexis
put a validity signal on the citation, not a quote block beside it);
components are kept for an action or commitment, for data text holds badly
(maps, live data, 3D) and for workspaces. OpenAI's Apps SDK states the test:
"would replacing every custom widget with plain text meaningfully degrade the
user experience?" Microsoft tells Copilot plugin authors to skip Adaptive
Cards "for the vast majority of citation scenarios". A2UI v0.9 shrank its
catalogue to "Basic" because front ends "already have a design system".
No public study compares cards with Markdown for cited professional answers;
the positions above are practice, not measurement.

## Considered Options

1. **Keep the catalogue, fix the prompt.** One card per content shape, with
   sharper triggers.
2. **Plain Markdown, richness inferred.** Tables and lists only; the renderer
   reads header words („Ist/Soll", „Status") to decide how to draw them.
3. **Markdown with a small directive dialect.** The model declares the
   block (`:::pruefung`, `:::verfahren`, …) around ordinary Markdown; the
   renderer draws it; copy and export strip it.
4. **Model-generated pages.** The model writes HTML or a bespoke layout per
   answer (Gemini's dynamic view, Claude's inline visuals).

## Decision Outcome

Chosen: **option 3**. Option 1 keeps every failure measured above: the cost
of a card is a schema, so the model either skips it or pairs it with the
prose that already says the same. Option 2 is the right substrate but loses
its drawing to a synonym or a typo, and cannot say "this is the project's
case". Option 4 is what consumer products are exploring; it takes a minute
per answer, has no verification story for a cited legal claim, and cannot
be checked server-side.

**The answer is Markdown. A card is emitted only when it carries one of:**

1. **An action or commitment**: `project_profile_patch`, `memory_proposal`,
   `file_operation_proposal`, `document_draft`, `task_created`,
   `document_grid`.
2. **Geometry drawn to scale**: the schematics (`building_section`,
   `stair_diagram`, `dimension_diagram`, `setback_plan`, `egress_diagram`,
   `guardrail_check`, `daylight_incidence`, `fire_access_plan`). "Never a
   measurement in a fence" stands.
3. **Arithmetic the renderer computes**: `calculation`, which has no result
   field, so the model cannot state a wrong one.
4. **A live binding to the model**: the `ifc_*` cards.
5. **Layout Markdown has no form for**: `surface` (tabs for variants), whose
   leaves are mostly Markdown `Text`.

**Retired from emission, on every channel** (chat envelope, `emit_card`,
deep research's card pass, DSML, `validate_cards`, skills' preferred cards):
the anatomy cards already superseded by the masthead (`summary`,
`verdict_header`, `key_takeaways`, `callout`, `follow_ups`); the tables
(`typed_table`, `comparison_table`, `requirement_checklist`,
`document_checklist`, `deadline_timeline`, `norm_chain`, `change_impact`);
`diagram` (a mermaid fence is the same drawing); `condition_tree`,
`process_map` and `legal_basis`; and the "plans" that are bars, not geometry
(`fire_compartment`, `thermal_envelope`, `energy_performance`,
`acoustic_check`, `parking_requirement`, `density_check`,
`elevator_requirement`). A refusal names the Markdown that replaces it.

**What replaces them is a small Markdown dialect the renderer draws richly.**
Richness is declared, not guessed: a guessed table (a renderer reading header
words) loses its drawing to a synonym or a typo. The dialect is GFM + math +
mermaid + a handful of `remark-directive` blocks (the generic-directive
syntax Docusaurus and others use), each a container around ordinary Markdown:

- `:::pruefung`: a check table; status pills, a value-vs-limit bar per row,
  „Dazu fragen" on an open row.
- `:::verfahren`: a straight Verfahren as a step rail; the step the project
  stands at marked, a step's documents in a nested `:::details`.
- `:::faelle`: cases (Gebäudeklasse, Lage), this project's marked `trifft zu`.
- `:::kennzahlen`: two to four key numbers as tiles.
- `:::vergleich`: variants as columns, the recommended one marked.
- `:::details[…]`: anything that is detail, not answer.
- `:klasse[B]`: an Energieeffizienzklasse as its colour chip.
- `> „…" [N]`: the wording that decides the answer, verified like every quote.

A Verfahren that forks or returns is a `flowchart TD` fence. Every block keeps
its `[N]` chips inside it, streams as it is written, and strips to plain
Markdown for copy and export. The bar is that the answer ends up **richer**
than the card catalogue made it, not equal: blocks that cost the model a line
of syntax appear wherever the content has the shape, where a card cost a
schema and appeared rarely. The answer is composed as a page (masthead, then
designed blocks in one typographic system), not text in a bubble.

**Pre-launch, retired types are deleted outright**: models, schemas,
renderers, fixtures and tests. No stored conversation has to survive, so no
render-only layer is kept. After launch, retiring a type needs a read-time
degrader instead.

**Direction beyond this change.** Collapse the surviving types into a few
versioned primitives (a `figure` over the schematic kinds, a `model_viewer`,
a `proposal`, `surface`), each carrying a Markdown fallback that copy,
export, filing and other clients use. A new block is a directive before it
is a card; a new card needs the Apps SDK test above and an answer-suite
result, not a trigger row.

### Consequences

- Good: one form per fact; the quote the reader trusts is the verified one;
  the model-facing contract shrinks by ~20 types; an answer copied, filed or
  exported loses nothing.
- Good: a new content shape becomes a Markdown convention with a renderer
  treatment, not a model, a schema, a renderer, an export mapping, an
  interactivity entry and a trigger row.
- Good: `process_map`'s click-to-reveal and `condition_tree`'s marked branch
  survive as `:::details` and `trifft zu`, now with citations inside them.
- Bad: a renderer dialect is ours to keep: every directive needs a renderer,
  a copy/export stripping rule and a prompt line, and an unknown directive
  must degrade to its content.
- Neutral: A2UI (ADR-0065) stays the draw layer; its catalogue gets smaller.

### Confirmation

- The retired types no longer exist in the union, and a model that names one
  is refused with the Markdown that replaces it (`tests/aiq_agent/cards`).
- Every directive renders, streams, and strips to plain Markdown
  (MarkdownRenderer specs).
- Before and after with the real static prompt: rich blocks per answer (up),
  duplicate forms per answer (zero), and `task be:eval:answer-suite` once the
  corpus is at hand.

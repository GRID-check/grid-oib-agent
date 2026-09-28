---
status: accepted
date: 2026-09-28
decision-makers: Grid engineering, product owner
consulted:
informed: everyone working in this repo
---

# The answer is Markdown, and a card must carry what Markdown cannot

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

## Decision

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

**What replaces them is Markdown the renderer draws well**, each a plain
Markdown construct that degrades to itself in copy and export:

- A **row mark**: a table row whose Status cell says `trifft zu` or `aktuell`
  is tinted. It is the marked branch of `condition_tree` and the "hier stehen
  Sie" of `process_map`, in a table that also carries `[N]`.
- **Numeric columns** right-aligned in tabular figures.
- A **Fundstelle excerpt**: a blockquote ending in `[N]` is drawn as an
  excerpt with its source in the margin, and is verified like every quote in
  the prose. It is `legal_basis`, checked.
- A Verfahren is a numbered list or a table; one that forks or returns is a
  `flowchart TD` fence.

**Stored messages are never rewritten.** Retired types stay in the union,
render-only, and the front end degrades any type it no longer knows to a
Markdown table through the export walker instead of a hole. Only then are
models and renderers deleted, in a later change.

**Direction beyond this change.** Collapse the surviving types into a few
versioned primitives (a `figure` over the schematic kinds, a `model_viewer`,
a `proposal`, `surface`), each carrying a Markdown fallback that copy,
export, filing and other clients use. A new card type needs the Apps SDK
test above and an answer-suite result, not a trigger row.

## Consequences

- Good: one form per fact; the quote the reader trusts is the verified one;
  the model-facing contract shrinks by ~20 types; an answer copied, filed or
  exported loses nothing.
- Good: a new content shape becomes a Markdown convention with a renderer
  treatment, not a model, a schema, a renderer, an export mapping, an
  interactivity entry and a trigger row.
- Bad: the interactive affordances of `process_map` (a step's requirements on
  click) and `condition_tree` (other cases on click) are gone; a table shows
  them all at once. Accepted: those were rarely populated (`current_step`
  only "where the conversation established it").
- Bad: until the later phase deletes them, ~20 render-only models and
  renderers remain in the tree.
- Neutral: A2UI (ADR-0065) stays the draw layer; its catalogue gets smaller.

### Confirmation

- Every retired type is refused on every emission channel
  (`tests/aiq_agent/cards`); a stored card of an unknown type renders its
  content (`retired-cards.spec.tsx`).
- Before and after with the real static prompt: cards per answer, duplicate
  forms per answer (quote card beside a chip, table beside a drawing, list
  beside a card), and `task be:eval:answer-suite` once the corpus is at hand.

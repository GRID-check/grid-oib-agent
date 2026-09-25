# Visuals in an answer: what each one is for

An answer is read by someone in a planning office who has to *do* something
with it: copy a value into an Einreichung, check a design against a rule, plan
the next weeks, or explain a decision to a Bauherr. A visual earns its place
only when it answers one of those jobs faster than a sentence. Everything else
is decoration, and decoration in a compliance answer costs trust in the parts
that are evidence.

## The reader's jobs, and the form that serves each

| The reader wants to… | The shape of the content | Drawn as | Why not prose |
|---|---|---|---|
| copy the value | one value with its condition | the verdict masthead | the value must be findable in a second |
| know which case is theirs | cases that exclude each other, one factor | `condition_tree`, or a table by Lage | the reader must see the case they are NOT in, too |
| check a design | criteria × status × Fundstelle | a table whose Status cells are marks | status must be scannable down a column |
| follow a Verfahren | steps in order, with forks and returns | **flow** (a `flowchart` fence) | a return loop cannot be written as a list |
| know who hands what to whom | parties × messages in order | **handoff** (a `sequenceDiagram` fence) | the parties are the structure, not the verbs |
| see how a Regelwerk hangs together | a tree: parts, and what each covers | **map** (a `mindmap` fence) | an overview is a tree before it is a text |
| plan the weeks | phases on dates a document states | **schedule** (a `gantt` fence) | overlap and sequence are the content |
| see a split | shares of one whole | **shares** (a `pie` fence) | proportions compared by length, not angle |
| compare variants | the same card, twice | a `surface` with Tabs | the reader switches, not scrolls |
| see geometry | measured dimensions | the schematic cards, drawn to scale | a measurement must match its drawing |

## How a diagram is drawn

The model writes the diagram as a ```mermaid fence: it knows the syntax, the
prompt teaches no new one, and the fence sits in the Markdown where it
belongs. **Mermaid is only the parser.** Its own renderer produces a generic
SVG — grey boxes, its own type, a radial mind map that wastes the column — and
none of it is this product's design. `features/diagrams/model.ts` turns the
parsed diagram into a typed model, and each model is drawn by a component
built from the same atoms as every card:

- **flow** — `FlowDiagram`, on `@xyflow/react` with a `@dagrejs/dagre`
  layout: HTML nodes in the card style (a step, a decision, an end), labelled
  edges as chips, dashed for "erläutert"/"verweist". The canvas is read-only
  and 1:1, sized from measured nodes, the way the Herleitung is. Below
  28rem of column it becomes a stepped outline: two readable branches do not
  fit side by side on a phone, so each decision writes out "ja: …", "nein: …".
- **map** — `MapDiagram`: the Regelwerk as a left-to-right tree on
  `@xyflow/react` where the column is wide enough, and as an indented outline
  where it is not. Never radial.
- **handoff** — `HandoffDiagram`: one column per party, one row per hand-over,
  the arrow drawn between the two columns; a numbered list on a phone. A
  one-way dotted arrow is a reply and drawn dashed; `<<-->>` goes both ways
  and is not.
- **schedule** — `ScheduleDiagram`: bars on a date axis, milestones as marks,
  sections as bands; labels above the bars on a phone. The axis names up to
  five whole days, each once, so a schedule of a day or two gets two or three.
- **shares** — `SharesDiagram`: horizontal bars with the share written out,
  because a length is read more exactly than an angle.

A grammar the model should not use, or a source the parser refuses, still
falls back to Mermaid's SVG and then to the source itself: the reader never
loses the content, only the design. So does anything a view would draw wrong:
a flowchart with a `subgraph`, a state diagram with a composite state, a label
in any of the five grammars with markup other than `<br>` and inline formatting
(`plainLabel` in `model.ts`), and a graph of more than 80 nodes (`MAX_GRAPH_NODES`), where
dagre's layout costs more than a reader waits.

A schedule's dates are the calendar dates the source wrote, whatever the
reader's time zone, and a task's label names its last day: mermaid's end is
exclusive, so `2026-10-01, 14d` reads „01.10.–14.10.".

## What stays SVG

The fifteen schematic cards (a section, a stair, a setback, …) are drawings
to scale, computed from their parameters: geometry is what SVG is for. A
filed diagram is an SVG and a PDF, because a file must stand on its own; the
file is still Mermaid's render, made only when the reader files it.

## Tables: the prompt and the renderer read the same words

A table in an answer is shaped by a rehype pass,
`shared/components/MarkdownRenderer/table-shape.ts`, and that pass reads the
table by what the prompt told the model to write. Change one side and the
other silently stops matching.

- **Columns are recognised by header name.** A Fundstelle column is one headed
  `fundstelle`, `quelle`, `grundlage`, `source`, `reference` or `references`.
  A Status column is one headed `status`, `erfüllt`, `ergebnis`, `bewertung`
  or `result`. Any other header is an ordinary column.
- **A table stacks at every width** when any cell holds more than 140
  characters (`PROSE_CELL_CHARS`): a sentence in a narrow column is a tower of
  short lines.
- **Status words become marks** only in a Status column, and only when the
  whole cell is one word from `status-marks.ts`: „open" in a Bemerkung column
  stays a word. The tally counts a word however it is capitalised, under its
  first spelling, and reads the cell after a citation its row's Fundstelle
  repeats has been dropped. That list accepts more than the prompt teaches: also
  `zulässig`, `unzulässig`, `zu prüfen`, `unklar`, `nicht anwendbar`, `n/a`,
  the ASCII spellings `erfuellt` and `nicht erfuellt`, and English
  equivalents. The extra words are tolerance, not vocabulary.

The status words are listed in `piloti_static.md` `<formatting>`; change both
together.

## Audit, September 2026: the whole answer, not the diagrams

Every catalog card through A2UI, and four answer turns (the verdict anatomy,
a Markdown-first check, two placed cards, a verdict lede), each in light and
dark at 900px and 390px. What was wrong, and what became of it:

| Found | Why it mattered | Now |
|---|---|---|
| A surface could only hold **cards**, while the Markdown-first doctrine keeps tables, checks and steps **out** of cards | Variants as tabs, the one thing composition is for, could not carry a variant's table; the worked example taught tabs of two `legal_basis` cards that differ by one value, which is one table | `Text` leaf (ADR-0065 amended), its `[N]` held to the prose's citations; prompt and example teach "a table per variant in tabs" versus "one table, a column per variant" |
| A Fundstelle column of the same `[1]` on every row | Five identical chips, nothing learnt per row, and the column costs a quarter of a phone | Lifted into one line under the table: „Fundstelle für alle Zeilen: [1]" |
| A check table did not say its outcome | The reader counts the chips to learn whether the concept passes | A tally above the rows: „2 erfüllt · 1 teilweise · 1 nicht erfüllt" |
| A four-column table on a phone scrolled sideways | Status and Fundstelle, the cells a reader came for, sat behind the edge | Below 30rem of its own container a row stacks, each cell named by its column |
| Takeaways stepped 6px further right per rank | Read as misregistration, not as rank; the ordinal and the first row's figure already carry it | One text column (charter §A5 updated) |
| „Schematisch — ohne Maßangabe." under a flowchart | A disclaimer about measurements on a drawing with no geometry | Only on Mermaid's own SVG fallback and in a filed copy |
| „Skizze" on the acoustic and energy cards | Neither has a sketch: bars and a label scale | „Prüfung" |
| Answer footer on three lines | Copy, „Antwortdetails" and feedback each took a line | One line; the details open full-width below it |

What was looked at and deliberately kept, so it is not relitigated without
new evidence:

- **Monospace for § and Pkt. identifiers.** Design language principle 3,
  "authority through precision": an identifier the reader copies into an
  Einreichung is set as one.
- **The rough stroke on the schematic cards.** It says "generated schematic,
  not a certified CAD drawing" (`schematics/rough.tsx`); the measurement layer
  stays crisp.
- **The eyebrow on every card.** The charter demotes it to a caption on
  purpose; the first 40px of geometry identify a card.
- **The 46ch callout.** A margin note at a reading measure, not a banner.
- **The tinted active branch in `condition_tree` / `process_map`.** Charter:
  it is what a screenshot of the card keeps as "this project's branch".

## Live census, September 2026

Three reference questions through the real agent (`task be:eval:turn-census`,
`openai/gpt-6-luna`): the OIB 2 overview, a ruling (Geländerhöhe at 13 m), and
two design variants (Außentreppe or zweites Treppenhaus). What the fixtures
could not show:

| Found live | Cause | Now |
|---|---|---|
| Every `summary` restated the prose's opening paragraph, directly above it (content-word overlap 0.46–0.53) | The prose is told to open with the answer, and the summary is shown above it; the prompt's "consequence, not restatement" rule was not followed | Gated: a summary on a reply of two sentences or fewer, or sharing ≥ 40% of its words with the opening, is dropped (`answer_envelope._summary_redundant`) |
| The overview drew a mindmap of the table's rows, and after the prompt asked for a level beneath the parts, a level repeating each part's number | The worked example itself drew the table's parts as a flowchart | The example now draws what each part covers; a mindmap whose words are ≥ 70% a table's words is removed (`piloti/answer_shape.py`) |
| Every row cited twice: `Betriebsbauten [2] \| [2]` | Nothing said the Fundstelle column is the row's only citation | Prompt says so; the table pass drops the repeated trailing `[N]` |
| The variants answer was one table, a row per design, a paragraph per cell | The rule "variants with a body of their own → tabs" was too abstract | Rule names its trigger (two or more requirements per variant) and the shape it replaces. **Rerun: the model answered with `Tabs`, one `Text` table per variant.** A table with sentence cells stacks at every width |
| One reply in three wrote the whole answer twice, loose and inside the fence | — | The fence already wins; `answer_prose_outside_envelope` now logs every occurrence so the cost is counted |

The value under a verdict appearing again in the first sentence is kept: the
prose must stand alone when copied or exported, and the prompt asks only that
it be worded differently.

Still open:

- **Research depth varies run to run.** The variants question took four
  research calls (67 s) on one run and five (80 s) on the next, at ~75k input
  tokens each. That is the model's depth decision, not the answer's shape.
- **A task list is not yet a task, and should not become one.** A project
  "task" here is delegated agent work (ADR-0051), so `- [ ] Brandschutzkonzept
  nachreichen`, which a person does, has no primitive to land in. Whether it
  gets one (ticks remembered per answer, or a project to-do list) is an open
  product decision.

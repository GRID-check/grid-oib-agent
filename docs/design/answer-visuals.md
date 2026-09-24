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
  the arrow drawn between the two columns; a numbered list on a phone.
- **schedule** — `ScheduleDiagram`: bars on a date axis, milestones as marks,
  sections as bands; labels above the bars on a phone.
- **shares** — `SharesDiagram`: horizontal bars with the share written out,
  because a length is read more exactly than an angle.

A grammar the model should not use, or a source the parser refuses, still
falls back to Mermaid's SVG and then to the source itself: the reader never
loses the content, only the design.

## What stays SVG

The fifteen schematic cards (a section, a stair, a setback, …) are drawings
to scale, computed from their parameters: geometry is what SVG is for. A
filed diagram is an SVG and a PDF, because a file must stand on its own; the
file is still Mermaid's render, made only when the reader files it.

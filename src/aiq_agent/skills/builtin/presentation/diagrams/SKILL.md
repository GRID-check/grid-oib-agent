---
name: diagrams
description: >
  Load the moment a diagram is in play at all: the user says Diagramm, diagram,
  Schaubild, Grafik, chart, flowchart, mermaid, visualisieren, zeichnen, "stell
  es dar", "draw it" — or the answer shows who hands what to whom, what depends
  on what, a stage a Verfahren returns to — or you are about to emit a
  `diagram` card. Carries this deployment's hard limits, which are stricter
  than mermaid. Not for measured geometry (Maß, Fläche, Höhe): schematic cards
  own those.
metadata:
  grid-agents: researcher
  grid-cards: diagram
---

# Getting a drawing on screen

This deployment's contract only. Mermaid itself you already know.

## Route

- A line of stations with Fristen and where this project stands:
  `process_map`. A decision on one factor with this project's branch marked:
  `condition_tree`. Anything measured: a schematic card, never mermaid.
- Everything else — a fork that rejoins, parties exchanging in order, a stage
  that loops back, the chain of instruments, the parts of a Regelwerk, a
  Bauzeitplan — is a ```mermaid fence IN the answer, where it belongs. It draws
  through the same renderer as the `diagram` card and files with the same
  button. The card is only for a surface without an answer to put a fence in.
- A named diagram request is answered by a drawing. Never prose alone, never
  ASCII art.

## Hard limits

- Six grammars survive screen, SVG check and PDF: `flowchart`,
  `sequenceDiagram`, `stateDiagram-v2`, `pie`, `gantt`, `mindmap`. `journey`,
  `block-beta` and `sankey-beta` degrade to a grey source box; `timeline` lays
  out sideways, wider than the answer column. Write prose or a table instead.
- `flowchart TD`, not LR, past four boxes in a row: the column is 680 px.
- `gantt` only on dates a project document states, never dates computed from
  a Frist.
- A parse error draws nothing; a styling error draws anyway, silently dropped.
  Meaning goes in edge labels (`-->|abgelehnt|`), never in colour.
- Quote every label (`A["Einreichung (§ 63)"]`). Never name a node `end`. No
  `click`, no HTML, no `<br>`.
- No label may claim what the answer has not grounded: the reader files the
  drawing as SVG/PDF without the paragraph that qualified it. Labels in the
  answer's language, Sie-Form.
- Five to twelve nodes. One drawing per answer, two for a long overview.

## Emit

A fence: ```` ```mermaid ````, the grammar on its first line, placed in the
answer where the drawing belongs, next to the table that carries the values.
Only without an answer to hold it: `emit_card` with `type: "diagram"`,
`diagram_type`, `source`, `reference` to the Bestimmung.

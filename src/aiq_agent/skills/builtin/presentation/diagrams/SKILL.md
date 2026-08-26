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
  grid-agents: shallow_researcher
  grid-cards: diagram
---

# Getting a drawing on screen

This deployment's contract only. Mermaid itself you already know.

## Route

- A line of stations: `process_map`. A fan on one factor: `condition_tree`.
  "Was ändert sich, wenn X": `change_impact`. Anything measured: a schematic
  card, never mermaid. The rest — fork that rejoins, parties exchanging, a
  stage that loops back, a dependency — is the `diagram` card.
- A named diagram request is answered by a drawing card. Never prose alone,
  ASCII art, or a raw fence.

## Hard limits

- Four grammars survive screen, SVG check and PDF: `flowchart`,
  `sequenceDiagram`, `stateDiagram-v2`, `pie`. `diagram_type` must match the
  source's first line or the card is refused. Everything else (`journey`,
  `gantt`, `mindmap`, ...) degrades to a grey source box — write prose instead.
- A parse error draws nothing; a styling error draws anyway, silently dropped.
  Meaning goes in edge labels (`-->|abgelehnt|`), never in colour.
- Quote a label carrying (), :, a comma or #. Never name a node `end`.
- No label may claim what the answer has not grounded: the reader files the
  drawing as SVG/PDF without the paragraph that qualified it. Labels in the
  answer's language, Sie-Form.
- Five to nine nodes; the caption says what is left out. One diagram per
  answer.

## Emit

`emit_card` with `type: "diagram"`, `diagram_type`, `source`; `caption` only
where it adds; `reference` to the Bestimmung (a Verfahren differs by Land).
`[[card:N]]` on its own line where the drawing belongs. Always write the prose
too; no duplicate mermaid fence of the same drawing.

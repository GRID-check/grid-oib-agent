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
- Everything else is a ```mermaid fence IN the answer, where it belongs: a
  fork that rejoins, parties exchanging in order, a stage that loops back, the
  chain of instruments, the parts of a Regelwerk, a Bauzeitplan. The `diagram`
  card is only for a surface without an answer to hold a fence.
- A named diagram request is answered by a drawing, never prose or ASCII art.

## How it is drawn

The fence becomes this product's own diagram, and shape is meaning:

- flowchart: `{…}` a decision, `([…])` an outcome, any other box a step,
  `-.->` a dashed relation that is not the flow. `flowchart TD` past four
  boxes in a row.
- mindmap: the Regelwerk at the root, three to six parts, one level beneath.
- sequenceDiagram: two to five participants, `participant B as Bauwerber`.
- gantt only on dates a project document states; pie for shares of a whole.
- stateDiagram-v2 for stages a Verfahren returns to. No other grammar.

## Hard limits

- A parse error draws the source. Meaning goes in edge labels
  (`-->|abgelehnt|`), never in colour or `style`.
- Quote every label (`A["Einreichung (§ 63)"]`); no node named `end`, no
  `click`, no HTML, no `<br>`.
- No label may claim what the answer has not grounded: the drawing is filed
  without the paragraph that qualified it. Labels in the answer's language.
- Five to twelve nodes. One drawing per answer, two for a long overview.

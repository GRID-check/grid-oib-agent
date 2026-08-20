---
name: verfahrensdiagramm
description: >
  Load before drawing an Ablauf, a Zuständigkeit or a Reihenfolge — that is,
  before emitting a `diagram` card or writing a mermaid fence. The situations
  this product actually has: a Verfahren whose stages fork and rejoin
  (Einreichung, Verbesserungsauftrag, Bauverhandlung, Bescheid), a
  Genehmigungskette across Bauwerber, Baubehörde and Amtssachverständige, a
  decision that forks on the Gebäudeklasse or the Widmung and then comes back
  together, a Nachweis that other Nachweise depend on, a Bescheid that can send
  a Verfahren back a stage. It carries the mermaid syntax that decides whether
  the drawing appears at all: which line declares the type, how a label survives
  a colon or a Klammer, and why an unknown word kills the whole diagram while a
  bad parameter fails in silence. Not for a Maß, a Fläche or a Höhe — those are
  the schematic cards, where the renderer draws to scale.
metadata:
  grid-agents: shallow_researcher
  grid-cards: diagram
---

# Drawing a Verfahren so that it actually appears

## First: is this a diagram at all?

Three cards already own three shapes, and each of them draws better than
mermaid because the renderer, not you, decides what the picture looks like.

- An ordered Verfahren — Einreichung → Bauverhandlung → Baubewilligung — is a
  `process_map`. It is a LINE, and the map opens each station on click.
- An answer that forks on ONE factor whose cases exclude each other — the
  Gebäudeklasse, the Widmung — is a `condition_tree`. It is a FAN.
- „Was ändert sich, wenn X sich ändert" is a `change_impact`.

A diagram is what is left: a GRAPH. It forks **and rejoins**. It has three
parties passing something back and forth. It has a stage a Verfahren can return
to. It has a Nachweis that two other Nachweise wait on. Nothing on that list
fits a line or a fan, which is why the card exists — and if your answer does fit
one, take the purpose-built card instead.

And never a measurement. A Schnitt, a Treppe, a Fluchtweg, ein Brandabschnitt,
ein Abstand: those are the schematic cards, where the renderer computes the
geometry so the drawing cannot disagree with its own numbers. Here the text IS
the geometry — whatever you type is what is drawn, with nothing in between to
catch you. Naming a threshold in a branch („Fluchtniveau über 22 m") is fine;
it is a label your answer has already grounded. Drawing something that asks to
be read as scaled is not.

## The first line decides whether anything is drawn

Mermaid needs to know which grammar to read the rest with. Without a
declaration on the first real line, there is no partial drawing and no warning —
the whole block collapses into a grey box of source text in the middle of your
answer, which reads to the architect as Piloti being unable to draw.

Four grammars are supported end to end. Declare the same one in
`diagram_type`: the card is refused if the two disagree, so the field is a
check on the source rather than a label on it.

| declaration | `diagram_type` | what it is for |
|---|---|---|
| `flowchart TD` or `flowchart LR` | `flowchart` | a path that forks and rejoins; a dependency between requirements |
| `sequenceDiagram` | `sequence` | Bauwerber, Behörde and Sachverständige handing an Akt back and forth |
| `stateDiagram-v2` | `state` | Zustände eines Verfahrens, including one it can return to |
| `pie` | `pie` | a split the answer has already established |

`TD` is top-down, `LR` is left-to-right. A Verfahren with more than about five
stations reads better as `LR`.

A flowchart, whole, so the pieces are visible together:

```
flowchart TD
  %% Ablauf nach der Wiener Bauordnung
  A[Bauanzeige einbringen] --> B{Unterlagen vollständig?}
  B -->|nein| C[Verbesserungsauftrag]
  C --> A
  B -->|ja| D[Prüfung durch die Baubehörde]
  D --> E{Untersagung?}
  E -->|ja| F[Bewilligungsverfahren erforderlich]
  E -->|nein| G[Baubeginn zulässig]
```

`A` and `B` are ids the edges refer to; the text in the brackets is what the
reader sees. `{...}` is the Entscheidung shape, `|nein|` is the edge label, and
the `C --> A` line is the rejoin — the reason this is a diagram and not a
`process_map`.

Everything else mermaid can draw — `journey`, `gantt`, `erDiagram`,
`classDiagram`, `mindmap` — either fails the SVG check before the reader sees it
or has never been through the PDF converter. `journey` is the one to remember:
mermaid emits an HTML element for it that the validator refuses, so it degrades
to its source no matter how correct it is. Write prose instead.

## Unknown words kill the diagram; bad parameters fail in silence

This is the asymmetry that costs the most time, and it is worth knowing which
half you are in before you write.

**The grammar is strict.** An unrecognised keyword, a malformed arrow, an
unclosed bracket — the parse aborts and nothing at all is drawn. `flowchart TX`
draws nothing. `A ->> B` inside a flowchart (that arrow belongs to a sequence
diagram) draws nothing. `end` as a lowercase node id draws nothing, because
mermaid reserves the word for closing a `subgraph`.

**The configuration is best-effort.** `%%{init: ...}%%`, `classDef`, `style`
and `linkStyle` are applied where they are understood and ignored where they are
not. A colour name mermaid does not know, a class you defined and never applied,
a key that does not exist: no error, no warning, and the diagram draws — just
without the thing you meant.

The conclusion is not "be careful with styling". It is: **never let colour or
style carry meaning.** If the ablehnende Pfad is marked red and nothing else,
and the style is silently dropped, the reader gets a diagram in which the two
paths look identical — and no sign that anything is missing. Put the meaning in
the label, `-->|abgelehnt|`, and let styling be decoration you can afford to
lose. In a compliance answer that is not a preference; it is the difference
between a drawing that is incomplete and one that is wrong.

## Labels

- The id is not the label. `E[Einreichung bei der Baubehörde]` — `E` is what
  edges refer to, the text in brackets is what the reader sees.
- Quote a label containing a Klammer, a Doppelpunkt, a Beistrich or `#`:
  `E["Einreichung (Wien): § 63"]`. Unquoted, those characters end the label
  early or abort the parse.
- Umlaute and ß are fine unquoted. Do not reach for line-break markup to fit a
  long label in: shorten the label, and put the detail in the `caption` or in
  the prose, where it can be read.
- Labels in the language of the answer, and in Sie-Form where a label addresses
  the reader.
- **No label may carry a claim the answer has not grounded.** The drawing is
  filed as an SVG and a PDF and attached to an Einreichung; it leaves the page
  without the paragraph that qualified it.

## Comments

`%%` starts a comment line — use one to record which Bauordnung the Verfahren
follows, so a filed diagram carries its own provenance in its source. But
`%%{...}%%` is a **directive**, not a comment: mermaid reads it. Do not put
prose inside those braces.

## Keep it small

Five to nine nodes. Past that the reader stops seeing the shape and starts
reading a wiring diagram, and the whole reason to draw instead of writing was
that the shape is graspable at a glance. If the Verfahren genuinely has fifteen
stations, draw the part your answer is about and say in the caption what the
drawing leaves out.

## Emitting it

Call `emit_card` with `type: "diagram"`, the `diagram_type` and the `source`.
Add a `caption` where it says something the title does not — which Bundesland,
which case, what is left out — and a `reference` to the Bestimmung the Verfahren
rests on, because a Verfahren differs by Land and a drawing of one without its
Fundstelle is a procedure from nowhere.

Then write `[[card:N]]` on its own line at the point in the answer the diagram
belongs to, and always write the prose as well: the diagram is in addition to
the answer, never instead of it.

**One per answer.** A diagram earns its place by showing a fork, an ordering or
a dependency that prose cannot hold. A second one puts both back at the weight
of the paragraphs around them, and a decorative diagram in a compliance answer
costs the reader trust in every drawing beside it.

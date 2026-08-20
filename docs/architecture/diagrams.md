# Diagrams — drawn in the browser, filed by the BFF

> How Piloti produces a diagram an architect can read in an answer, and then
> keep as a real file in the project. See also
> [agent-authored documents](../superpowers/specs/2026-08-20-agent-authored-documents-design.md)
> (the pipeline this is the second and third producer of),
> [cards.md](cards.md) (the doctrine this must not break) and
> [ADR-0042](../adr/0042-object-storage-durability-and-quota.md).

## The doctrine, first, because it is the constraint everything else obeys

This repository has fifteen **schematic cards**
(`frontends/ui/src/features/grid-cards/schematics/`) where the model emits
**parameters only** and the renderer does every piece of geometry. `cards.md`
states what that buys: *"a card cannot show a diagram that disagrees with its
own numbers."* It exists because the card is what gets screenshotted into an
Einreichung.

**A model writing raw mermaid loses that guarantee entirely.** The source IS the
geometry: whatever the model writes is what is drawn, with no arithmetic between
the claim and the picture and therefore nothing to catch a disagreement.

So the rule for this pipeline is a rule about SUBJECT:

| | |
|---|---|
| **Allowed** | Diagrams that make **no dimensional claim** — process flows, sequences, decision trees, state machines, org and relationship maps, Zuständigkeiten, Verfahrensschritte. Nothing on such a diagram is a measurement, so nothing on it can be measurably wrong. |
| **Not allowed, and deliberately not built** | Anything dimensional — a section, a stair, an escape route, a fire compartment, a setback, a daylight angle. Those belong to the schematic renderers, whose geometry is computed. |

The seam between the two is **named and left open**: a schematic card that wants
to become a filed file needs a renderer that serialises the card's own computed
SVG — the same `fileDiagramDocuments` call with the card's geometry instead of a
model's text. That is a new caller, not a new pipeline, and it is not built.

The rule is also visible to the reader rather than only written here: every
drawn diagram carries the line „Schematisch — ohne Maßangabe." / "Schematic — no
dimensions are claimed.", and the PDF repeats it in its provenance block.

## Why the browser draws and the server files

Mermaid and excalidraw both **lay out** a graph — they measure text, run a
layout, and only then emit geometry — and measuring text needs a document.
**There is no browser in production**: `playwright-core` is a devDependency, and
putting Chromium into the production image is a deployment decision nobody has
made. So:

```
model writes ```mermaid          browser (has a DOM)                 BFF (owns the write)
        │                                │                                   │
        └── MarkdownRenderer ────────────┤                                   │
                                         │  mermaid.render → SVG string      │
                                         │  flatten the cascade onto attrs   │
                                         │  parse + re-serialise through     │
                                         │  the SERVER'S own validator       │
                                         │        │                          │
                                         │        ├── shown in the answer     │
                                         │        └── POST /api/projects/{id}/diagrams
                                         │                                   │
                                         │                     acceptDiagram (validate,
                                         │                     allow-list, embed source)
                                         │                                   │
                                         │                     fileGeneratedDocument × 2
                                         │                       diagram_svg → .svg
                                         │                       diagram_pdf → .pdf
```

**One render, two uses.** The SVG shown in the answer is byte-for-byte the SVG
that is filed. A second render for filing would be a second chance for the file
to disagree with the picture, and "what got filed is not what I saw" is not a
defect a Ziviltechniker can spot before signing.

The bytes therefore arrive from an authenticated user's browser. **That is the
same trust posture every upload already has** — and it is stated rather than
assumed, because nothing on the server can assert that the SVG is a faithful
drawing of the source text beside it. What the server *can* assert is that the
file is inert.

## Trust: what the server does with client bytes

`lib/diagrams/svg.ts` does two things, and neither is redundant:

1. **Refuses, by name.** `<script>`, `<foreignObject>`, `<style>`, `on*`
   handlers, any `href`/`url()` that is not a fragment, DOCTYPE and entity
   declarations (which is what makes XXE and billion-laughs *unrepresentable*
   rather than mitigated), unsupported elements, a missing viewport, and
   anything over the size caps. Named, because a client that gets
   `foreign-object` back can fix its renderer config.
2. **Re-serialises from an allow-list.** What is stored is written by that
   module out of a table of permitted elements and attributes — never copied
   from the request. (1) is a deny-list and deny-lists are only as complete as
   the day they were written; (2) is what holds when (1) has a gap.

There is no XML library: the Node runtime has no `DOMParser`, and a general
parser's job is to accept while this one's job is to refuse.

`<style>` is refused rather than sanitised — a CSS parser would be a second
place external references can hide, and `@react-pdf/renderer` cannot apply CSS
at any price. The **producer** flattens the cascade onto presentation attributes
before it posts, so a `<style>` arriving at the server means some producer
skipped that step.

**The existing serving posture already closes the classic SVG hole**, and this
work depends on it: `image/svg+xml` is in `PREVIEW_CONTENT_TYPES` (a presigned,
**cross-origin** object-store URL) and deliberately excluded from the
same-origin `/api/documents/{id}/file` stream, whose own comment says an SVG
"must never be served inline same-origin because it can carry script into this
origin". The validation here is defence in depth on top of that, not instead of
it.

## Two rows, and why not one

A diagram is two artifacts and they are not substitutes:

- the **SVG** previews in the Files pane today, is what a reader opens, and
  carries the diagram's own source in its `<metadata>`;
- the **PDF** is what gets attached to an Einreichung.

One row cannot be both — a row has one storage key and one content type — and a
sibling object under the first row's prefix is exactly what ADR-0042 forbids:
bytes written outside the document service have no row and are invisible to the
quota ledger. So: two rows, two producers (`diagram_svg`, `diagram_pdf`), one
`fileGeneratedDocument` call each, no second insert path.

That collided with **migration 0064**, which allowed one machine-authored
document per (organization, project, run). **Migration 0065** widens that unique
index and `findDocumentAuthoredByRun` *together* — which is the move 0064's own
header prescribes — so the rule is now one document per (organization, project,
run, **producer**). A producer is a KIND OF DELIVERABLE, and a run owes at most
one of each kind. `deep_research` is unaffected.

The alternative — two synthetic run ids, `{run}:svg` and `{run}:pdf` — needed no
migration and was rejected: `authored_by_run_id` exists so somebody can later ask
what wrote a file and in which run, and a key that joins back to no real run is
what the schema calls *"an audit trail in appearance only"*.

**Where the source lives: inside the SVG's `<metadata>`.** It has to travel WITH
the artifact, because the person who needs to regenerate or hand-edit the drawing
is the person who has the file — possibly a year later, possibly outside this
product. A third `documents` row would be a `.mmd` nobody asked for with its own
quota charge and its own `Zuweisen`; a new column would not survive the download;
the audit record is a compliance trail, not a store you regenerate artefacts
from. Any `<metadata>` the client sent is discarded first, so the recorded source
is the one the server validated.

**Partial filing is recoverable, not rolled back.** The two calls are not one
transaction. The SVG is filed first because it is the half that carries the
source; if the PDF fails, filing again finds the SVG `alreadyFiled` and files
only the PDF. Idempotency per (run, producer) is what makes the retry the
compensation.

## Every rule of the existing feature still applies

`authored_by='agent'`, `status='stored'`, **never ingested** (`dispatchDocument`
refuses these rows by reading the row, not by trusting an argument), zero
assignees so the file arrives `Unvergeben`, the „Von Piloti erstellt" provenance
line in the Files pane, and one `document.generated` audit event per row.

## Rendering in an answer

A ```` ```mermaid ```` fence in an answer is drawn instead of printed
(`MarkdownRenderer`'s `code` override → `MermaidDiagram`). Three states:

- **streaming** — a code block. The markdown stabiliser auto-closes an odd
  number of fences, so a half-arrived diagram *looks* complete on every token;
  drawing it would flash a parse error per token.
- **failed** — a code block plus one quiet line. The model writes broken mermaid
  regularly and that must cost the reader nothing they did not already have.
  Never a red box, never a throw inside an answer.
- **drawn** — the SVG, the „Schematisch" line, and (only where the surface
  supplied a filing target, i.e. inside a project) „Im Projekt ablegen".

`securityLevel: 'strict'` and `htmlLabels: false` everywhere: the source is
model-authored text, mermaid has a history of label-based XSS, and
`<foreignObject>` is both refused by the server and undrawable in the PDF.
`suppressErrorRendering: true`, because mermaid's own failure path otherwise
appends a "Syntax error in text" graphic to the document and leaves it there,
outside React's tree.

**The drawing sits on a light surface in both themes.** It is the preview of a
document that is filed, converted to PDF and attached on white — the Files pane
already previews a PDF the same way — and a themed render would mean the reader
is not looking at what gets filed.

## Measured cost of the dependency

Bundled with esbuild, minified, gzipped, in this repository:

| package | min | gzip |
|---|---|---|
| mermaid 11.17.0 — first flowchart render (entry + 25 chunks) | 801 KB | **214 KB** |
| mermaid 11.17.0 — every diagram type | 3.45 MB | 947 KB |
| mermaid 11.17.0 — what a dynamic `import()` pulls first | 28.6 KB | 11.1 KB |
| mermaid — added to the main bundle | **0** | **0** |
| `@excalidraw/excalidraw` 0.18.1 | 8.40 MB | 2.53 MB |
| `@excalidraw/utils` 0.1.3-test32 (`latest`) | 19.56 MB | 14.03 MB |
| `@excalidraw/utils` 0.1.2 (last non-prerelease) | 1.49 MB | 423 KB |

`mermaid` is a production dependency, imported dynamically through
`next/dynamic` so a reader whose answer contains no fence downloads none of it.
It has two consumers — the answer and the file.

**Excalidraw does not ship in this vertical.** The editor package costs 11.8× a
mermaid first render to obtain one export function; `@excalidraw/utils`, the
package that exists to be the cheap path, is measurably worse than the editor at
its published `latest`, and that `latest` is `0.1.3-test32` — a prerelease, last
published sixteen months ago, with 32 of 38 published versions carrying a
`-test` suffix. `0.1.2` is cheap and does export `exportToSvg`, but predates
today's scene schema. The kind stays in the vocabulary (`DIAGRAM_SOURCE_KINDS`)
and the server already accepts it, so adding a renderer later is one entry in
`DIAGRAM_RENDERERS`, not a vocabulary migration over stored rows.

## Known limits

- **`journey` diagrams do not draw.** Mermaid emits `<foreignObject>` for them
  regardless of `htmlLabels`, so they are refused and degrade to their source.
  Flowchart, sequence, state and pie were verified end to end.
- **Typefaces are not preserved in the PDF.** `@react-pdf/renderer` knows the
  standard PDF fonts and nothing else; every `font-family` lands on Helvetica,
  varying only weight and slant. Asking it for mermaid's `"trebuchet ms"` throws
  at render time, so a diagram would otherwise fail to become a PDF over a font.
- **Arrowheads are computed, not referenced.** `@react-pdf/renderer` exports a
  `Marker` component whose renderer cannot resolve an SVG `url(#id)` reference,
  so `svg-to-pdf.tsx` draws the heads itself from each edge's own end tangent. A
  path using a command other than `M`/`L`/`C` gets no head rather than one
  pointing the wrong way.
- **Drop shadows, `<use>`/`<symbol>` icons and CSS are dropped by the producer**,
  because none of them survives into the PDF — and the answer, the stored SVG
  and the PDF have to show the same drawing.
- **An answer containing a mermaid fence still exports raw mermaid source into
  the `.docx`** (`lib/answer-export/markdown.ts` maps every `code` token to a
  monospace paragraph). Not fixed here; see the note in that file's owner's area.

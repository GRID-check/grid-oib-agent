# IFC models — talking to your building

> For architects and Bauträger using GRID. What happens when you upload an IFC
> file, what you can ask, and — just as important — what the answers do and do
> not cover.

## Uploading a model

Drop a `.ifc` (or `.ifczip`) into **Files**, exactly like a PDF. GRID does not
treat it like a PDF: it reads the model, indexes every element with its
properties, quantities, materials and classifications, and writes a summary of
the building into the knowledge base.

While that runs the file shows **Modell wird gelesen…**. A typical single-building
model takes a few seconds; a large federated one takes longer. When it finishes,
a **Modell** entry appears in the project navigation.

Models above 250 MB are refused with a message rather than half-read.

## The model page

**Modellübersicht** — what the file says about itself: project, site and
building names, the IFC schema, which application exported it and when, plus
the counts and areas read from the model.

**Modellprüfung** — the validation report (below). Read it before trusting a
number.

**Räumliche Struktur** — the Project → Site → Building → Storey → Space tree.
Click a storey to filter everything else to it.

**Bauteile** — every element, searchable by name and filterable by type. Click a
row to see its full property sets and quantities, and to highlight it in 3D.

**3D-Ansicht** — the model itself. Drag to orbit, Shift-drag to pan, scroll to
zoom, click to select. The viewer needs **WebGPU** (Chrome and Edge today,
Safari and Firefox depending on version). Without it you get a short note in
place of the picture and *everything else on the page still works* — the
structure, the elements, the properties, the quantities, and every answer the
assistant gives.

**Stände vergleichen** — see below.

## Asking questions in chat

In a project chat, ask about the building the way you would ask a colleague:

- *"Wie viele Außenwände gibt es im Erdgeschoss?"*
- *"Netto-Grundfläche pro Geschoss?"*
- *"Welche Wände haben keine Feuerwiderstandsklasse hinterlegt?"*
- *"Welchen U-Wert haben die Fenster?"*
- *"Welche Türen sind als Fluchttür gekennzeichnet?"*

These are answered by **querying the model**, not by reading text about it — the
counts and sums are computed, not estimated. When the answer is about specific
parts of the building, the assistant can show them highlighted on the 3D model.

Questions about *regulations* ("was verlangt OIB 2 für Fluchtwege") are answered
from the OIB corpus as before. A question that combines the two — "which of my
walls fall short of what OIB 2 requires" — uses both: the requirement comes from
the Richtlinie, the elements come from the model.

## Modellprüfung — why your model is checked

A BIM model is whatever your authoring tool exported, and the common defects are
silent. Elements assigned to no storey are missing from every per-storey figure.
Rooms with no published area make an area total quietly short. None of that stops
an answer from appearing; it stops the answer from being true.

So GRID checks the model once and reports what it finds, grouped into five
stages:

| Stage | Looks for |
|---|---|
| Schema | Missing or superseded IFC version |
| Identität | Missing, duplicated or malformed GlobalIds |
| Räumliche Struktur | Elements in no storey, rooms without a storey, storeys without a height, two storeys at the same height |
| Property Sets | Elements without their standard `Pset_*Common`, models with only application-specific sets |
| Vollständigkeit | Rooms without an area, elements without a name, materials or classification |

**Errors** mean an answer can be wrong. **Warnings** narrow what can be
answered. **Notes** mark information that is absent — a model without
classifications is not broken, it just cannot answer questions about
classifications.

When a model has structural gaps, the assistant says so in the answer itself:
*"Hinweis zum Modell: 43 Bauteile sind keinem Geschoss zugeordnet und fehlen
daher in jeder geschossweisen Auswertung."* That sentence is not boilerplate —
it appears only when it applies.

## Comparing revisions

Upload the new version of a model alongside the old one and use **Stände
vergleichen**, or ask in chat: *"Was hat sich gegenüber dem letzten Stand
geändert?"*

The comparison matches elements by their **IFC GlobalId**, which survives
re-export. A model re-exported with no changes reports no changes, even though
every internal number in the file is different. What you get is:

- **Neu** — elements that were not in the older version
- **Entfallen** — elements that are gone
- **Geändert** — with the actual before/after values: a wall that moved storey,
  a fire rating that dropped from REI 90 to REI 30, an area that grew by 1.5 m²
- **Unverändert** — the count

This is the question two plan sets cannot answer: a drawing redone from a changed
model looks different everywhere and identical where it matters.

## What GRID does not do with your model

- **It never changes it.** There is no authoring, no repair and no migration
  path. The file you uploaded is the file that stays.
- **It does not verify geometry.** Clash detection, IDS conformance and
  buildingSMART certification are not part of this. The checks above are about
  whether the model can answer questions, not whether it is certifiable.
- **It does not replace your own review.** Every number is traceable to the
  element it came from — use that, do not take the summary on faith.

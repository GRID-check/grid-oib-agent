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
model takes a few seconds; a large federated one takes longer. The card updates
itself — you do not have to reload to find out whether it finished — and when it
does, a message says the model has been read and the building can now be asked
about. A **Modell** entry appears in the project navigation at the same time.

Models above 250 MB are refused with a message rather than half-read.

## Opening a model from Files

An `.ifc` opens like every other file — click it in **Dateien** and the preview
shows the **building**, turnable, in the pane where a PDF shows its pages.

The column beside it leads with **Aus dem Modell**: storeys, Bauteile, Räume,
the IFC schema, and the net floor area *if the export published one*. A quantity
your export does not carry is left out of that list rather than shown as `0` —
an absent area is not an area of nothing. Below it sits the ordinary metadata:
summary, tags, size, status.

The preview is deliberately just the picture. Everything you *analyse* — the
tabs, the element table, the requirement check, the Raumbuch — is one click
away on **Im Modellbereich öffnen**, which opens this model (not whichever one
the page would default to) in the model page below.

While the model is still being read the preview says so, and a file whose
extraction failed says that instead — the two are never the same message.

## The model page

The 3D view is always on the right. The left half has four tabs.

### Überblick

**Modellübersicht** — what the file says about itself: project, site and
building names, the IFC schema, which application exported it and when, plus
the counts and areas read from the model.

**Modellprüfung** — the validation report (below). Read it before trusting a
number. Each finding has a **Bauteile zeigen** action that highlights the
offending elements in 3D and puts that view in the address bar, so a finding is
something you can send someone.

**Projektangaben aus dem Modell** — the facts your project brief asks for, read
back out of the model: storeys above and below ground, the Fluchtniveau band,
the main use, the room count. Each one shows the evidence it came from and how
confident it is. Nothing is written to the brief from here — **Über den
Assistenten übernehmen** takes them into the chat, where you confirm each change
the way you confirm every other proposed change to the project data. A derived
`Geschosse oberirdisch` picks a Gebäudeklasse, and a Gebäudeklasse decides what
the fire-safety answer is; that is not a value a page should set behind a
checkbox.

### Anforderungen

**Anforderungsprüfung** — the OIB rule catalogue run against the values your
model publishes. Per requirement: how many elements meet it, how many do not,
and how many **cannot be decided** because the model does not carry the value.

Three things this screen does deliberately:

- **Every row shows the threshold it applied**, not just the verdict —
  *"2h + b = 63 cm, Schwellwert 59–65 cm"*. You check the rule, not only the
  result.
- **"Nicht entscheidbar" has the same weight as a failure.** It is not a gap in
  the report; it is the reason the report is not finished. **Was dem Modell
  fehlt** turns those into a list of exact property paths to add in your CAD —
  add `Pset_WallCommon.FireRating` to 34 walls and two requirements become
  decidable.
- **A rule that did not apply says why.** "Gebäudeklasse nicht gesetzt" is
  fixable; hiding the row would make an under-configured project look clean.

**Manuell bestätigen** is for everything the model cannot settle. You read the
plan, or you ask the Brandschutzplaner, and you record that here with a note.
Two rules about it worth knowing:

- A confirmation **sits beside** the machine verdict, it does not replace it.
  Confirming a failing rule says "I know, and it is fine" — the next reader
  still sees what the model actually says.
- A confirmation is recorded **against the revision you looked at**. Upload a
  new one and the confirmation stays but is marked *älterer Stand*: it was true
  of the building you checked and says nothing about the one that replaced it.
  Re-confirm to carry it forward deliberately.

**Offene Punkte als BCF** hands the whole thing back to the tool the model
came from. The button downloads a BCF 2.1 file — the format ArchiCAD, Revit,
Solibri and BIMcollab all read — with one topic per requirement that still
has work in it. Open it in your CAD and each topic selects the elements it is
about: the two doors that are too narrow, the thirty-four walls with no fire
rating. The topic carries the threshold, the clause, what was read, and the
exact property paths to author.

Three details that matter in practice:

- **One topic per requirement, not per element.** Thirty-four walls missing a
  fire rating is one piece of work, and thirty-four issues would bury every
  other requirement.
- **Re-exporting after a new revision updates the same topics** rather than
  duplicating the list, because a topic's identity comes from the project and
  the requirement — not from the file you exported it from.
- **A requirement you confirmed manually arrives closed**, with your note as a
  comment. If the confirmation was made about an older revision it arrives
  open, and the comment says so — a signature does not silently follow the
  building into its next version.

There is no snapshot image in the file. GRID renders your model in the
browser, so the server has no camera to take one with, and a blank thumbnail
would read as "nothing to see here".

It reads **no geometry**. Fluchtweglängen, Geländerhöhen, Brandabschnittsgrößen
and Belichtung per room are not checked at all, and the screen says so. This is
an *orientierende Prüfung* — not a Nachweis and not legal advice.

Ask in chat too: *"Prüfe das Modell gegen die OIB-Anforderungen"*, or
*"Was hat sich seit dem letzten Stand am Erfüllungsgrad geändert?"* — the second
reports only the requirements whose status moved, including one that stopped
being checkable because a re-export dropped a property. The first ends with a
link to the same BCF download, so you never have to come back to this page to
get the file.

### Struktur

**Räumliche Struktur** — the Project → Site → Building → Storey → Space tree.
Click a storey to filter everything else to it.

**Bauteile** — every element, searchable by name and filterable by type. Click a
row to see its full property sets and quantities, and to highlight it in 3D.

### Mengen

**Raumbuch** — every room with its storey, area and volume, totalled per storey
and for the building, downloadable as a semicolon-separated CSV that opens
straight into Austrian Excel. Rooms that publish no area are **listed and
counted, never silently dropped**: the banner says how many rooms the totals
exclude, and each storey heading repeats it. A Flächenaufstellung that is short
by four rooms and does not say so is the one number in this product that could
do real damage.

**Massenermittlung** — one quantity (`NetSideArea`, `NetVolume`, …) summed per
element type, optionally split by material for a Kostenschätzung. Same rule:
each row states how many of its elements publish no value.

### Revisionen

**Revisionen** — see below.

**Stände vergleichen** — see below.

### The 3D view

Drag to orbit, Shift-drag to pan, scroll to zoom, click to select.
**Röntgen** ghosts everything that is not selected or highlighted, so a wall
inside a building is still findable.

Orbit is the least of it. The toolbar stands the model square and cuts it:

- **Grundriss, Nord, Süd, Ost, West** snap the camera to a plan or one of the
  four elevations. **Nord** means looking *at* the north facade — you are
  standing to the north.
- **Parallel** switches off perspective, and picking any of those views
  switches it off for you. A plan in perspective is a picture: parallel walls
  converge and nothing on it can be measured. **Frei** hands perspective back.
- **Schnitt** cuts the building horizontally. It lands a metre above the floor
  of the storey you have selected — where a Grundriss is cut, high enough to
  pass through doors and windows, low enough to stay under the lintel — and the
  slider moves it. **Blick nach unten / oben** flips which half you keep. The
  cut face is hatched, so it reads as a section rather than as a model with a
  wall deleted.
- **Einpassen** re-frames the whole building without reloading it. The viewer needs **WebGPU** (Chrome and
Edge today, Safari and Firefox depending on version). Without it you get a short
note in place of the picture and *everything else on the page still works* — the
structure, the elements, the properties, the quantities, the schedules, and
every answer the assistant gives.

A browser can also have WebGPU and still not be able to draw: a blocked or
blocklisted graphics driver, a virtual machine, a remote-desktop session, or an
interrupted download of a very large model. That produces the same kind of note
— what is missing, what is unaffected, and the technical reason underneath, so
a support message can quote it.

### Every view is a link

Which model, which tab, which storey, which element, what is highlighted,
whether x-ray is on — and now the camera direction, the projection and the cut
height — all live in the address bar. *"Schnitt bei +2,60 m, Blick nach Norden,
diese drei Wände markiert"* is something you send, not something you talk
someone through. **Ansicht kopieren** copies the
current one. That is what makes "the third wall on the left in the ground floor"
unnecessary: you send the wall.

## Asking questions in chat

Once a model is readable, an empty chat in that project offers two questions
about **your building** — marked with the model glyph — ahead of the usual
Richtlinien examples. They are there because nothing else on that screen tells
you the building can be counted and checked at all; clicking one fills the
composer, it does not send.

In a project chat, ask about the building the way you would ask a colleague:

- *"Wie viele Außenwände gibt es im Erdgeschoss?"*
- *"Netto-Grundfläche pro Geschoss?"*
- *"Welche Wände haben keine Feuerwiderstandsklasse hinterlegt?"*
- *"Welchen U-Wert haben die Fenster?"*
- *"Welche Türen sind als Fluchttür gekennzeichnet?"*

These are answered by **querying the model**, not by reading text about it — the
counts and sums are computed, not estimated. When the answer is about specific
parts of the building, the assistant can show them highlighted on the 3D model.

**Element names in an answer are links.** When the assistant names a wall, the
name is a chip — click it and the model opens with that wall selected,
highlighted and, where it helps, with everything else ghosted. It goes the other
way too: with an element selected on the model page, **Assistenten fragen**
starts a chat about exactly that element, carrying its GlobalId so the
assistant queries the same one you are looking at rather than one it guessed
from a description.

The assistant can also answer with a **card**: a Raumbuch for one storey, one
element with its property sets, or the diff between two revisions. Those cards
carry only an identifier — the numbers on them are fetched from the model when
they render, so the assistant cannot state a floor area at all, and every row
links into the model at that element.

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

## Revisions

Upload `Haus-A_V2.ifc` next to `Haus-A.ifc` and the **Revisionen** tab shows them
as one series rather than two files. GRID reads the revision marker out of the
file name — `_V2`, `-rev3`, `(2)`, a trailing date stamp — so the sequence
appears without anyone maintaining it. Names that are merely similar are *not*
merged: `Bauteil 2.ifc` and `Bauteil 3.ifc` stay two buildings, because reporting
one as a 340-element deletion of the other would be worse than showing no
timeline.

Each step carries what changed between it and the one before: elements, rooms,
storeys, net floor area and the Modellqualität score, signed. Those come from the
stored summaries, so the whole timeline costs nothing to show — and `±0` means
*measured and unchanged*, while `—` means one of the two revisions publishes no
such figure. A revision that failed to parse says so instead of reporting a total
loss.

They are deltas between two **exports**, not between two buildings: an office
that re-exports with a different mapping can move hundreds of elements without
touching the design. That is why the element-level comparison is one click away
rather than replaced by these numbers.

## Comparing revisions

Use **Mit … vergleichen** on a timeline step, **Stände vergleichen** for any two
models, or ask in chat: *"Was hat sich gegenüber dem letzten Stand geändert?"*

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

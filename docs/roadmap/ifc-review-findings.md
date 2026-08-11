# IFC/BIM — open review findings

A review fleet went over the IFC branch across seven dimensions (OIB domain
correctness, BCF/IFC standards conformance, React and accessibility, data layer
and performance, security and tenancy, test quality, and product honesty). Most
of what it found is fixed. This file is the part that is **not**, so it does not
have to be rediscovered.

Each entry names the file and the failure, not just the topic. Severity is about
what a user would experience, not how hard it is to fix.

## Fixed, recorded so the reasoning is not lost

These were real and are closed. The reasoning lives in the code comments and the
regression tests named beside them.

| Finding | Where | Test |
|---|---|---|
| Reading rounded while the comparison used the raw value — `0.795` rendered `0,80 m` on a row that said *nicht erfüllt* | `lib/bim/rules.ts` `measure()` | `rules.spec.ts` › *a reading never contradicts the verdict printed beside it* |
| Gross `Qto_SpaceBaseQuantities.Height` accepted as *lichte* Raumhöhe — a room finishing at 2,42 m passed | `lib/bim/rules.ts` `oib3-raumhoehe` | `rules.spec.ts` › *will not pass a room on its GROSS height* |
| Room markers matched as bare substrings — `store` ⊂ `storey`, `bad` ⊂ `Badminton`, `wc` ⊂ `showcase`; those rooms produced no row at all | `lib/bim/rules.ts` `isOccupiedSpace` | `rules.spec.ts` › *room names are matched by word, not by substring* |
| Mixed decimal separators in one string — `0.7 m — Schwellwert ≥ 0,80 m` | `lib/bim/rules.ts` `decimal()` | same as the first row |
| Fire resistance demanded `REI` of columns and beams, where OIB 2 Tabelle 1b row 1 asks `R` | `lib/bim/rules.ts` | `rules.spec.ts` › OIB 2 Tabelle 1b |
| `NOTDEFINED` / `SPACE` silently out of scope — the majority of every real model's rooms | `lib/bim/rules.ts` `UNINFORMATIVE_SPACE_TYPES` | `rules.spec.ts` › *checks a room whose PredefinedType says nothing* |
| Door judged on nominal width against a *lichte Durchgangsbreite* threshold | `lib/bim/rules.ts` `oib4-tuer-durchgangsbreite` | `rules.spec.ts` › *reads the CLEAR width* |
| BCF emitted `<File IfcProject="">` and `IfcGuid="express:1421"` — both schema-invalid | `lib/bim/bcf.ts` | `bcf.spec.ts` |
| `AcousticRating` passed on any non-empty string — a wall reading *siehe Beilage* was reported **erfüllt** under an `OIB 5` caption | `lib/bim/rules.ts` `ratedSoundReduction()` | `rules.spec.ts` › *refuses prose as a declaration* / *accepts a rated value however the exporter labelled it* |
| `slug()` could not decompose `ß`, so `Beispielstraße` downloaded as `Beispielstra-e` — a hole in the name of roughly half of all Viennese projects | `lib/bim/bcf.ts` `GERMAN_TRANSLITERATION` | `bcf.spec.ts` › *spells an Austrian project name instead of punching holes in it* |
| BCF zip carried no directory entries — the spec's own *Incorrect* example | `lib/bim/zip.ts`, `bcf.ts` | `bcf.spec.ts` › the folder entry is asserted in the archive layout test |
| The model download was never aborted; leaving mid-download still transferred the whole file | `features/bim/components/ifc-viewer-canvas.tsx` | `viewer-camera` specs + the `AbortController` at `ifc-viewer-canvas.tsx:335` |
| `ifc_viewer` could only highlight ids that fit in the answer's context, so a card about 420 external walls coloured a handful under a legend claiming all of them | `IfcHighlight.match` (`cards/models.py`), `useBimHighlightGroups`, `features/bim/lib/card-highlights.ts` | `use-bim-highlight-groups.spec.tsx` › *pages past the API cap* / `card-highlights.spec.ts` |

The acoustic fix is worth a note, because the cause was subtler than the
symptom: `numericProperty` anchors its number at the START of the string, so it
parsed neither `Rw 30 dB` nor `siehe Beilage` — and everything it failed to
parse fell through to `pass`. Only a literal `0` avoided passing. The rule now
requires a rated figure in decibels (found anywhere in the string, comma
decimals included); prose and `≤ 0` are `undecidable` and name what to author,
so the declaration is counted only when it was actually made.

## Open — correctness

**The U-value rules imply a Nachweis that OIB 6 does not perform.**
`U ≤ 0,35 W/m²K` is the höchstzulässiger Bauteilwert. Meeting it on every wall
does not make a building OIB 6 compliant, and missing it does not make it
non-compliant — the balance compensates. The row currently reads as a verdict on
the building.

**Clause number on the door rule.** `rules.ts` cites OIB 4 Punkt 3 for the
0,80 m *nutzbare Durchgangslichte*. That figure is the Barrierefreiheit
requirement and a separate 0,80 m applies to doors on Fluchtwege. Verify against
the adopted Ausgabe before an Einreichung leans on it.

## Open — standards conformance

- **No `<AssignedTo>`, `<DueDate>` or `<Stage>` on any topic.** In a real BCF
  loop the first action is routing *FireRating fehlt* to the Bauzeichner and
  *Schalldämmung* to the Bauphysiker. Topic-per-requirement is the right call,
  but it needs assignment to be usable.
- **No camera in the viewpoint.** The selection travels, so elements highlight,
  but double-clicking a topic in ArchiCAD restores nothing — you land wherever
  your camera was, on a whole-building view with 34 things lit up somewhere
  inside it. Every topic also shows a blank thumbnail (no snapshot).
- **The IFC test fixture violates three where-rules** —
  `IfcRelContainedInSpatialStructure.WR31` and `IfcSpatialStructureElement.WR41`
  (twice) in `tests/fixtures/ifc/sample-building-geometry.ifc`. It fails the
  buildingSMART validation service and `ifcopenshell.validate --rules`, and the
  spaces land outside the spatial tree — which is exactly what `walkSpatial` and
  the room rules read.

## Open — frontend

- **No live region for viewer load status**, while every toolbar control is
  `disabled` until `ready` — focus drops to `<body>` if a re-parse starts.
- **Duplicate React keys in the highlight legend** — `key={highlight.label}`
  over three translated labels, so `?hl=fail:A&hl=fail:B` collides.
- **`bg-background/85 backdrop-blur` overlays fall below AA** over a dark scene
  in light theme (measured 3.27–3.93 against `text-muted-foreground`).
  `backdrop-blur` does not change mean luminance.
- **A section-slider drag issues one `router.replace` per step** (39 for a
  40-step drag). No debounce between the input and the URL.

## Open — test coverage

Twenty-seven guards were removed one at a time; **nine survived** with the suite
still green.

- `ifc-viewer-canvas.tsx` — 476 lines, **no spec at all**. Removing all five
  `ready` gates changed nothing. This is also why the two viewer findings above
  went unnoticed.
- `lib/bim/model-service.ts` — six survivors clustered here: `gebaeudeklasse`
  and `hauptnutzung` dropped before `runBimQuery`, the Archiv allowance
  (`projectId !== null`), the confirmations project, and the catalogue model id.
  `model-service.bcf.spec.ts` pins the export *header* rather than the verdicts,
  so the facts can be wrong and the assertions still hold.
- `zip.ts` — the fixed DOS timestamp can be replaced with a real clock and no
  test notices, which is the reproducible-export guarantee.
- `model-service.ts` — exact-match-before-substring ordering in model name
  resolution is untested.

## Open — the chat surface

- **The deep researcher is never asked for a model card.** Its prompts have no
  `<cards>` block, and the async path generates cards post-hoc from the answer
  text, which is deliberately not shown the IFC card types (it has no tool rows
  to copy ids from). So a deep answer about the building is prose with element
  links. Fix by giving `deep_researcher/prompts/` the same guidance the shallow
  researcher now carries — not by relaxing the post-hoc restriction.
- **No camera in a viewer card.** `buildModelHref` encodes and parses one
  (`model-link.ts:67`), and `ifc-viewer-card-spec.md:54` specifies it, but the
  card model has no field and the renderer never sets one. The user lands on a
  whole-building view with the highlights somewhere inside it.
- **Agent deep links are always `hl=info:`** (`register.py:178`), so a failing
  element and a neutral selection highlight the same colour even though
  `pass|fail|warning|info` are all wired.

## Open — product

- **Not one of the eight viewport screenshots shows rendered geometry.** They
  capture the WebGPU-unavailable message and empty panels. The visual regression
  suite therefore cannot catch a regression in section hatching or parallel
  projection, and the commit that added them is titled *the viewport makes
  drawings, not just orbits*.
- **WebGPU-only is a commercial fact worth stating out loud.** Safari on macOS
  is a large share of Austrian architecture offices.
- **Austrian register.** The overall German is good — `Befunde`,
  `nicht einschlägig`, `Massenermittlung`, `Fluchtniveau` are all correct
  professional usage — but there are German-German forms and a few outright
  wrong strings, and the English locale is a partial translation rather than a
  locale.

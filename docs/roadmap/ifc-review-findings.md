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

## Open — correctness

**`AcousticRating` passes on any non-empty string.** `lib/bim/rules.ts`,
`oib5-schalldaemmung-deklariert`. `0` and empty are now `undecidable`, but
`'siehe Beilage'` and `'keine Anforderung'` still return `pass` and land in the
same *Erfüllt* counter as the numeric threshold rules, under a row captioned
`OIB 5`. The rule is honestly titled (*deklariert*), which is not the same as
being honestly counted. Either parse `Rw ≥ n dB` and judge it, or give
declaration-only rules their own counter that is not called *erfüllt*.

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

- **BCF zip has no directory entries.** The BCF 2.1 spec's own *Incorrect*
  example is the shape we emit. Readers tolerate it; validators may not.
- **No `<AssignedTo>`, `<DueDate>` or `<Stage>` on any topic.** In a real BCF
  loop the first action is routing *FireRating fehlt* to the Bauzeichner and
  *Schalldämmung* to the Bauphysiker. Topic-per-requirement is the right call,
  but it needs assignment to be usable.
- **No camera in the viewpoint.** The selection travels, so elements highlight,
  but double-clicking a topic in ArchiCAD restores nothing — you land wherever
  your camera was, on a whole-building view with 34 things lit up somewhere
  inside it. Every topic also shows a blank thumbnail (no snapshot).
- **`slug()` does not decompose `ß` under NFKD**, so `Beispielstraße` becomes
  `Beispielstra-e` in the download filename. Roughly half of Viennese project
  names contain *straße*. `lib/bim/bcf.ts`.
- **The IFC test fixture violates three where-rules** —
  `IfcRelContainedInSpatialStructure.WR31` and `IfcSpatialStructureElement.WR41`
  (twice) in `tests/fixtures/ifc/sample-building-geometry.ifc`. It fails the
  buildingSMART validation service and `ifcopenshell.validate --rules`, and the
  spaces land outside the spatial tree — which is exactly what `walkSpatial` and
  the room rules read.

## Open — frontend

- **The model download is never aborted.** `features/bim/components/ifc-viewer-canvas.tsx`
  — `fetch(sourceUrl)` takes no `AbortSignal`; cleanup only sets a boolean.
  Navigating away mid-download transfers the whole model anyway, which on the
  large models this feature exists for is tens to hundreds of MB per abandoned
  visit.
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

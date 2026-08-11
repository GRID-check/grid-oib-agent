# The viewer, against what ifc-lite actually offers

An audit of `@ifc-lite/renderer@1.44`, `@ifc-lite/geometry@2.13`,
`@ifc-lite/parser@3.15` and `@ifc-lite/data@3.2` against what
`features/bim` uses, written by reading the packages' own type
declarations and shipped JavaScript rather than their README.

It exists because the viewer's whole defect history is of one shape: an
API used at the wrong end. `xrayContextIds` was not a key the renderer
reads, so the see-through control was inert for a release.
`sectionPlane.position` is a percentage of the model's extent and was
being handed metres, so the cut plane never went where the slider said.
Neither is visible in a screenshot. Both were an assumption about a
library nobody had read.

Since then the viewport's renderer handle is typed with `Pick<>`s of the
package's own `Renderer`, `Camera` and `Scene`, so a misspelled option is
a compile error. That closes the class. This document is the other half:
knowing what is *there*.

## What is wired up

| capability | API | where |
|---|---|---|
| streamed parse | `GeometryProcessor.processAdaptive` | `ifc-viewer-canvas.tsx` |
| orbit / pan / zoom-to-cursor / pinch, with inertia | `Camera.orbit/pan/zoom/update` | canvas input |
| named views + parallel projection | `setPresetView`, `setProjectionMode` | `viewer-camera.ts` |
| adaptive home framing | `fitBoundsAdaptive` | `fitModel` |
| frame selection | `frameBounds` | selection effect |
| GPU pick + CPU raycast hover | `pick`, `raycastScene` | canvas input |
| highlight colours | `Scene.setColorOverrides` | `model-index.ts` |
| x-ray context | `ghostExceptIds` | `frameOptions` |
| horizontal section | `sectionPlane` (explicit normal + distance) | `viewer-camera.ts` |
| storey isolation, hide, isolate | `isolatedIds`, `hiddenIds` | `model-index.ts` |
| measuring, with vertex/edge/face snap | `raycastScene({snapOptions})`, `Camera.projectToScreen` | `viewer-measure.ts`, `measure-overlay.ts` |
| lighting + edge/contact/separation passes | `environment`, `visualEnhancement` | `viewer-scene.ts` |
| quantized vertices, LOD1, contribution culling | `enableQuantizedBatches`, `Scene.setLodBuildsEnabled`, `contributionCull`, `lod` | `viewer-performance.ts` |
| view capture | `captureScreenshot` + `restoreEvictedForCapture` | `viewer-performance.ts` |

## What is there and unused

Ordered by what a reviewer of an Austrian submission would miss first.

### 1. The section cap — the biggest visual gap

A cut currently shows open rooms, not a poché section. The renderer WILL
draw a hatched, outlined cap (`sectionPlane.showCap` / `showOutlines`,
`capStyle` with hatch pattern, spacing, angle) — but only over polygons
the host uploads through `uploadSection2DOverlay(polygons, lines, axis,
position, …)`. `render-section-draw.js` gates the cap on
`cap.hasGeometry()`, so the two flags we already pass are inert.

The polygons come from a `SectionCutter` that lives in ifc-lite's own
app and is **not published** in any of the four packages. So this is
ours to compute: intersect each batch's triangles with the plane, chain
the resulting segments into closed loops, project them onto the plane
basis (`planeBasis`, which IS exported, and is the same basis the cap
shader expects). Cost is proportional to the triangle count, so it wants
to run off the interaction path — recompute on cut-change and on
cut-release, not per frame.

Worth doing: it is the difference between "a model with a wall deleted"
and "a Schnitt".

### 2. A section box

`RenderOptions.clipBox` is an axis-aligned six-plane clip, real geometry
clipping in the shader, independent of `sectionPlane` and live at the
same time. Nothing uses it.

The high-value shape is not six sliders: it is **cut to this storey** —
a box spanning the selected level's elevation to the next level's, and
the model's full extent horizontally. That answers what a reviewer
filtering to a floor actually wants, and it is immune to the two failure
modes the current name-matched element filter has (elements assigned to
no storey vanish; a curtain wall spanning three floors appears whole).

Caveat to design around: storey elevations come from the server-side
extraction in IFC coordinates, and the renderer's world is Y-up and
**RTC-shifted** for models far from the origin
(`CoordinateHandler.needsShift`). The band must be validated against
`getModelBounds()` and the feature must decline rather than blank the
building when they do not intersect.

### 3. Walking the building

`Camera.enableFirstPersonMode` / `moveFirstPerson` exist. For a product
whose subject is escape routes, clear widths and head heights, walking a
corridor at eye height is not a demo feature — it is the review.

### 4. Grid axes and level lines

`GeometryProcessor.parseGridAxes(buffer)` returns the IFC grid, and
`Renderer.uploadGridLines3D(vertices)` draws it without expanding the
model bounds (unlike `uploadAnnotationLines3D`, which does — that is why
the measurement overlay is DOM and not GPU). Architects orient by grid
references; we show none.

Needs the source bytes after the parse, which the canvas currently drops
— see §7.

### 5. Multi-select

`pickRect(x0, y0, x1, y1)` returns the set of ids in a rubber band, and
`RenderOptions.selectedIds` highlights a set rather than one. Today
selection is strictly single, so "hide these fourteen" is fourteen
actions.

### 6. Snapshots in BCF

`lib/bim/bcf.ts` deliberately writes no viewpoint image, and the reason
given is sound: the export runs on the server, which has no kernel, no
camera and no way to render. A fabricated thumbnail would be worse than
none.

But the browser now has `captureScreenshot`, and the stage can already
put an arbitrary set of elements on screen from a finding. A viewpoint
image per topic is reachable by capturing in the client at export time.
It is a real architectural change (export becomes client-assisted), not
a flag.

### 7. Exports the kernel already implements

`GeometryProcessor` exposes `exportGlb`, `exportObj`, `exportCsv`,
`exportJson`, `exportJsonld`, `exportStep`, `exportIfcx`, `exportMerged`
and `exportKmz`, all taking the source buffer and honouring hidden /
isolated id sets. "Give me the visible selection as GLB" and "give me
the element table as CSV" are single calls.

All of them, and §4, need the `.ifc` bytes to still be around. The
canvas frees the buffer after `processAdaptive` on purpose — these are
100–200 MB files. Retaining it must be a deliberate, bounded decision
(re-fetch on demand through the presigned URL is the cheaper default).

### 8. Diagnostics

`getFrameStats()`, `getDiagnostics()` and
`onPersistentRenderDegradation` report frame timings, resident GPU
bytes, dropped frames and a renderer that is quietly failing. We surface
none of it, which means a user reporting "it is slow" gives us nothing
to work with.

### 9. Federation and point clouds

`FederationRegistry`, multi-model ranges, `setPointClouds` and
`computeDeviations` (scan-versus-model deviation) are a whole product
surface. Out of scope until federated review is a thing this product
does, but worth knowing it is already under the floor.

## Things the packages settle that are easy to get wrong

Written down because each one has already cost a defect, or is one
assumption away from costing one.

- **`sectionPlane.position` is a percentage**, `0..100`, of the model's
  extent along the cut normal: `distance = min + position/100 * (max -
  min)`. An explicit `normal` + `distance` bypasses it entirely and is
  what the viewport uses. The cap, however, still reads
  `axis`/`position`/`min`/`max`, so both must agree.
- **`isolatedIds`: `null` draws everything, an EMPTY set draws
  nothing.** One keystroke apart, a whole building apart.
  `hiddenIds` has no such trap — an empty set is a no-op.
- **The kernel emits Y-up, RTC-shifted, unit-scaled metres.** IFC is
  Z-up; anything read from the server-side extraction is in the file's
  own frame and does not automatically agree with the renderer's.
- **`uploadAnnotationLines3D` and `uploadAlignmentLines3D` expand the
  model bounds**; `uploadGridLines3D` does not. Bounds feed Home
  framing, the camera's near/far planes and the cut slider's range.
- **`enableQuantizedBatches` and `setLodBuildsEnabled` only affect
  batches built afterwards.** They must run before the first
  `addMeshes`.
- **`contributionCull` and `lod` must be absent, not zeroed, for a
  capture render**, and `restoreEvictedForCapture` is what rebuilds
  batches the residency budget aged out.
- **`Renderer.render` never throws for a lost device** — it latches and
  fires `onDeviceLost`. A frozen picture with no error is what happens
  if nobody listens.

## How this gets verified

None of the above can be checked by looking at the viewport: a wrong
option is a silent no-op and a wrong unit is a plausible number. Two
mechanisms replace the eyeball:

1. `RendererLike` / `CameraLike` / `SceneLike` are `Pick<>`s of the
   package's own classes. A renamed or misspelled member is a type
   error at the call site.
2. `ifc-viewer-canvas.spec.tsx` stands a deliberately faithful fake
   ifc-lite behind the component and asserts on the options handed to
   `render()`, on the ORDER of the load path, and on the interaction
   sequences. Its fake is the contract as read from the package; when
   the package is upgraded, that file is what to re-read it against.

---

# Audit backlog

Seven parallel audits ran over the viewer, the agent, the data path, the
analytical drawer, the chat round trip, the wording and accessibility.
What they found and what is fixed is in the git history; this is what is
**not** fixed, kept because each item was verified against the code and
is cheaper to act on than to re-find.

Ordered by what a user loses.

## Data and answers

1. **`ifcTypes` filters do not normalise `…StandardCase`.**
   `query.ts` matches `lower(ifc_type)` exactly, so on an IFC4 export
   where every wall is an `IfcWallStandardCase`, `aggregate
   {"ifcTypes":["IfcWall"]}` answers *"Kein Bauteil erfüllt die
   Abfrage"* and the agent reports the building has no walls. `rules.ts`
   already fixes exactly this, with a comment about ArchiCAD doors
   matching zero times; the query layer never got it.
2. **Unknown filter keys are stripped, not rejected.** `bimFilterSchema`
   is not `.strict()`, so `{"storey":…}` (singular; the real key is
   `storeys`) silently becomes "the whole building" and the agent
   reports a filtered count that was never filtered.
3. **`aggregate sum`/`avg` skip elements with no quantity but report the
   full element count** — "250 m² über 100 Bauteile" when ninety of them
   published nothing. `buildQuantityTakeoff` and `buildRoomSchedule`
   both carry a `missing` count for this reason; `aggregate`, the
   operation the tool description calls "how you answer how much", does
   not.
4. **`aggregate` groups are capped at 25 with no truncation signal**, so
   a thirty-storey building returns twenty-five storeys as a complete
   Flächenaufstellung. `limit` is also undocumented in the tool
   description, so the model cannot raise it.
5. **`groupBy: "property"` is advertised and unusable** — there is no
   `group_property` tool argument, the query runs ungrouped, and the
   renderer still takes the grouped path, so the grand total is printed
   as one group named "(ohne Angabe)".
6. **`summary.truncatedAt` never reaches the agent.** Only
   `complianceRun` reads it. `overview` quotes the true total while
   `types` and `aggregate` count only the stored rows, and the agent can
   put both in one answer.
7. **`aggregate` and `takeoff` report bare numbers with no unit** —
   `const unit = request.metric === 'count' ? '' : ''`, a placeholder
   never filled. A model in millimetres yields "4 120 000" and the agent
   writes m².
8. **Gebäudeklasse never parses.** The brief stores `"GK4"`;
   `useProjectRuleFacts` does `Number(raw.gebaeudeklasse?.value)` → NaN
   → null, so every card-side rule stands down as "nicht einschlägig"
   while the agent — which passes `4` — returns real verdicts. The spec
   pins the broken behaviour.
9. **Every 4xx reaches the agent as "the model service is
   unavailable".** A `group_by` typo, or the deliberate "gt/gte need a
   numeric value" message, is flattened into a transport failure the
   agent cannot correct.
10. **Storey names are matched exactly with no guidance.** The tool
    description warns emphatically about guessing property names and
    says nothing about storeys, whose real-world spellings are `EG`,
    `00 Erdgeschoss`, `Level 0`. A miss reads as "das Erdgeschoss hat
    keine Wände".

## The data path

11. **A failed `/source` presign is indistinguishable from loading** in
    the stage (a progress veil forever) and is rendered as *"Der Viewer
    benötigt WebGPU"* in the preview, where WebGPU has already been
    ruled out one branch earlier.
12. **No re-sign and no retry.** The URL is minted once with a 600 s
    TTL; a device loss, a blip or an expiry is terminal until the stage
    is closed and reopened. `reload()` exists on the hook and has no
    caller; `bim.loadFailed.action` ("Erneut versuchen") is in both
    dictionaries and is rendered nowhere.
13. **A failed element walk renders as "Kein Bauteil entspricht diesem
    Filter".** One bad page out of two hundred rejects the whole
    `Promise.all` and discards every page already collected.
14. **`/source` sets no `Cache-Control`** while every comparable route
    in the repo sets one explicitly. A URL that expires in ten minutes
    must never be reusable from a cache.
15. **The internal query route turns every server failure into a 400**,
    which as an `ApiError` also skips the handler's logging — a
    statement timeout is reported to the agent as a malformed request
    and to the operator as nothing at all.

## The drawer

16. **`truncated` is dropped for the Raumbuch, the Massenermittlung and
    the compliance diff.** The query computes it; the hooks discard it.
    "Keine Anforderung hat ihren Status geändert" therefore reads
    identically for "nothing regressed" and "we compared half of each
    revision".
17. **The element table's "300 von 10.000" has a capped denominator**,
    and the type filter is built from the loaded rows, so a type that
    exists only past the cap is missing from the filter entirely.
18. **A collapsed Raumbuch drops whole storeys, subtotals included**,
    under a grand total that still counts them.
19. **The Massenermittlung renders every row unbounded** — thousands of
    groups in a 26 rem drawer once "nach Material trennen" is on — and
    is the one table here with neither a cap nor a total.
20. **Revision numbers are upload order, not the numbers in the
    filenames**, so re-uploading an older export labels it as the newest
    revision and the compliance diff reports the rollback as progress.
21. **Timeline deltas colour every metric green when positive** —
    `+300 Bauteile` is not good news, and the file's own header warns
    that a re-export can move 300 elements without touching the design.
22. **A confirmation is keyed per (org, project, rule)** with no notion
    of a revision series, so two unrelated buildings in one project
    share one confirmation and each labels the other's as "Älterer
    Stand".
23. **Switching drawer tabs destroys a comparison** that just read two
    full element sets, and refires the gated queries the code says are
    "fetched only once".
24. **The Raumbuch CSV writes `24.5`** into a semicolon-separated file
    declared for Austrian Excel, which reads it as text.

## Flow and chrome

25. **The advanced drawer covers the dock, including its own toggle.**
    The inspector was taught to step aside; the dock was not. On a phone
    the drawer covers every viewer control.
26. **The browser back button leaves the Files page** instead of closing
    the stage — `openModel` uses `replace`, so the stage pushes no
    history entry, and on a phone back is how anyone dismisses a
    full-screen overlay.
27. **Two dock buttons are called "Show everything"**, one of which
    fits the camera and the other of which restores hidden geometry —
    and the second does not clear the storey filter.
28. **The drawer's open state is half in the URL**: closing it leaves
    `tab=`, so a copied link opens a drawer the sender had shut, and
    selecting Überblick deletes the parameter so the link loses the
    drawer entirely.
29. **A link with view parameters but no `?model=` opens the file
    browser**, silently — and `?model=` naming a file the project does
    not have falls back to the newest model with no notice. The
    documented rename fallback (`includes`) does not fire for the
    filenames links actually carry.
30. **Highlight labels do not survive a link.** Only `status:ids` is
    encoded, so "Fluchtweg > 40 m (12)" becomes "Fehler (12)"; and the
    `unresolved` count the card shows is computed by the stage and
    rendered nowhere.
31. **Highlight groups are capped at 60 ids in a link** while the card
    resolves the full set, so "Open model" quietly shows 60 of 420.
32. **A malformed percent-escape in a chat link throws during render**
    — `decodeURIComponent` unguarded in `parseElementLink`, called from
    an answer's citation renderer.

## Wording

33. **"Sie bleibt als Nachweis erhalten"** in the stale-confirmation
    hint, two lines under a disclaimer promising "kein Nachweis". The
    English says "record" and is right.
34. **"Abgeleitet aus Geschoßhöhen"** — the profile derives from storey
    ELEVATIONS; an architect reads Geschoßhöhe as clear height.
35. **"Erfüllungsgrad vergleichen"** names a metric nothing computes.
36. **Geschoß vs Geschoss** — the dictionary and the OIB catalogue use
    the Austrian spelling; `profile.ts`, `schedule.ts`,
    `validate.ts`, the CSV headers and `ifc-element-chip.tsx` use the
    German one, and they render side by side.
37. **"Grid" appears in four strings**; the product is Piloti
    everywhere else in all 23 dictionaries.
38. Twelve dictionary keys are defined in both locales and referenced
    nowhere, including `loadFailed.action` and `empty.action` — the two
    the error states need (item 12).

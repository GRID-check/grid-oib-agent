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

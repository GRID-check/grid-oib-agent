/**
 * What the camera is looking at, and where the building is cut.
 *
 * Orbit alone is a demo. What an architect actually does with a model is stand
 * it up square — plan, north elevation, section at door-handle height — and
 * that is not a camera nicety, it is the drawing set. Until the viewport can
 * produce those, "we have a 3D view" means "we have something that spins".
 *
 * Two commitments this module exists to keep:
 *
 * 1. **A view is a link.** `model-link.ts` already puts model, storey, element
 *    and highlights in the query string; a camera and a cut belong there for
 *    exactly the same reason. "Schnitt bei +2,60 m, Blick nach Norden, die drei
 *    Wände markiert" is a thing one person needs to send another, and a
 *    screenshot cannot be clicked.
 *
 * 2. **A plan is orthographic.** A perspective "top view" is a picture of a
 *    building, not a Grundriss: parallel walls converge and nothing measures.
 *    So picking a cardinal view implies parallel projection unless the reader
 *    deliberately says otherwise, and the state model encodes that rather than
 *    leaving it to whoever wires the toolbar.
 *
 * Pure: no renderer, no React. The imperative half lives in the canvas, which
 * translates these values into `Camera.setPresetView` / `setProjectionMode` and
 * a `sectionPlane` render option.
 */

// Type-only, so this module stays free of the renderer at runtime — but the
// section plane it builds is checked against the renderer's own declaration
// rather than against a restatement of it that can drift.
import type { SectionPlane } from '@ifc-lite/renderer'

/**
 * The named directions the viewport can snap to.
 *
 * `iso` is the free view — the one orbit leaves you in — and is the default, so
 * it never appears in a URL. The rest map onto ifc-lite's own preset vocabulary
 * except for the names: the renderer says `front`/`back`/`left`/`right`, which
 * mean nothing about a building until you know which way it was modelled. We
 * say what the reader sees.
 */
export const BIM_CAMERA_VIEWS = ['iso', 'top', 'north', 'south', 'east', 'west'] as const
export type BimCameraView = (typeof BIM_CAMERA_VIEWS)[number]

const VIEWS = new Set<string>(BIM_CAMERA_VIEWS)

/** ifc-lite's preset name for each of ours. `iso` has none — it fits instead. */
const RENDERER_PRESET: Record<Exclude<BimCameraView, 'iso'>, 'top' | 'front' | 'back' | 'left' | 'right'> =
  {
    top: 'top',
    // Looking AT the north facade means standing to the north — the renderer's
    // `back`. Getting this pair the wrong way round produces a view that is
    // plausible, mirrored, and wrong in a submission drawing.
    north: 'back',
    south: 'front',
    east: 'right',
    west: 'left',
  }

export function rendererPreset(view: BimCameraView): 'top' | 'front' | 'back' | 'left' | 'right' | null {
  return view === 'iso' ? null : RENDERER_PRESET[view]
}

/**
 * Whether this view should be drawn with parallel projection by default.
 *
 * Every cardinal view: a plan or an elevation in perspective is not a drawing.
 * `iso` keeps perspective, because a free orbit in parallel projection is
 * disorienting — there is no depth cue left to orbit against.
 */
export function impliesOrthographic(view: BimCameraView): boolean {
  return view !== 'iso'
}

/** A horizontal cut through the building, in metres above the model origin. */
export interface BimSection {
  /** Cut height in metres. */
  atMetres: number
  /** Look down at the cut (a Grundriss) or up at it. */
  flipped: boolean
}

/**
 * Where a Grundriss is cut, by convention: 1 m above the finished floor.
 *
 * Austrian practice puts the horizontal section high enough to pass through
 * doors and windows and low enough to stay under a lintel. A cut at the storey
 * elevation itself would slice the floor slab and show nothing.
 */
export const GRUNDRISS_CUT_ABOVE_FLOOR_M = 1

/**
 * The default cut for a storey, or for the building when no storey is chosen.
 *
 * A storey with no published elevation cannot produce a cut height — the
 * caller gets `null` and offers the manual slider instead, rather than cutting
 * at zero and showing the reader an empty view they will read as "the model is
 * broken".
 */
export function defaultCutForStorey(elevationMetres: number | null | undefined): number | null {
  if (typeof elevationMetres !== 'number' || !Number.isFinite(elevationMetres)) return null
  return round(elevationMetres + GRUNDRISS_CUT_ABOVE_FLOOR_M)
}

/** Centimetre precision: below that, a slider step is noise in a URL. */
function round(metres: number): number {
  return Math.round(metres * 100) / 100
}

/** Clamp a cut into the model's own vertical extent, in metres. */
export function clampCut(atMetres: number, bounds: { minY: number; maxY: number }): number {
  if (!Number.isFinite(atMetres)) return round(bounds.minY)
  return round(Math.min(Math.max(atMetres, bounds.minY), bounds.maxY))
}

/**
 * ifc-lite's `sectionPlane` render option, built from a cut in metres.
 *
 * ## Why this is not just `{ position: atMetres }`
 *
 * `SectionPlane.position` is NOT a height. The renderer resolves it as a
 * PERCENTAGE of the model's extent along the cut normal:
 *
 * ```
 * distance = min + (position / 100) * (max - min)
 * ```
 *
 * Handing it metres is what made the cut inert. On a 12 m building "cut at
 * 3 m" resolved to 3% of 12 m — 0.36 m — so the whole slider travelled the
 * bottom eighth of the ground floor, the readout said one thing and the plane
 * did another, and every height above knee level looked identical.
 *
 * ## What is passed instead
 *
 * The plane goes over the way the renderer's own face-pick path sends one: an
 * explicit world-space `normal` + `distance`, which the clip shader uses
 * verbatim (`dot(worldPos, normal) - distance`), ignoring `axis`, `position`,
 * `min` and `max`. `distance` is then literally the metre the slider displays,
 * with no bounds arithmetic in between that could disagree with it — and the
 * cut survives the renderer's own bounds being a slightly different box from
 * the one the slider was ranged over.
 *
 * The cardinal fields are filled in consistently anyway: the cut CAP still
 * reads `axis`/`position`/`min`/`max`, and a percentage that agrees with the
 * explicit plane is the difference between a cap on the cut and a cap floating
 * somewhere else in the building.
 *
 * `normal` is `[0, 1, 0]` because the geometry kernel emits Y-up meshes — see
 * the axes note in `ifc-viewer-canvas.tsx`. A horizontal cut in an IFC file is
 * a Z plane; by the time it reaches the renderer it is a Y plane.
 */
export type RendererSectionPlane = SectionPlane

/** Percent of `[minY, maxY]` that `atMetres` sits at, clamped to 0..100. */
export function cutPercent(
  atMetres: number,
  bounds: { minMetres: number; maxMetres: number } | null
): number {
  if (!bounds) return 50
  const range = bounds.maxMetres - bounds.minMetres
  // A degenerate range makes every percentage the same plane, so the value is
  // arbitrary — but it must not be NaN, which would reach the GPU uniform.
  if (!Number.isFinite(range) || range <= 0) return 50
  const percent = ((atMetres - bounds.minMetres) / range) * 100
  if (!Number.isFinite(percent)) return 50
  return Math.min(100, Math.max(0, percent))
}

export function rendererSectionPlane(
  section: BimSection,
  bounds: { minMetres: number; maxMetres: number } | null
): RendererSectionPlane {
  // A non-finite height would be written straight into the clip uniform as
  // NaN, and every fragment test against NaN is false — the cut would silently
  // stop cutting rather than fail loudly.
  const atMetres = Number.isFinite(section.atMetres) ? section.atMetres : (bounds?.minMetres ?? 0)
  return {
    axis: 'down',
    position: cutPercent(atMetres, bounds),
    enabled: true,
    flipped: section.flipped,
    normal: [0, 1, 0],
    distance: atMetres,
    ...(bounds ? { min: bounds.minMetres, max: bounds.maxMetres } : {}),
    // The hatched cap is what makes a section read as a drawing rather than as
    // a model with its front wall deleted.
    showCap: true,
    showOutlines: true,
  }
}

// ---------------------------------------------------------------------------
// URL encoding
// ---------------------------------------------------------------------------

/**
 * `view=north`, `cut=2.6&cutup=0`, `persp=1` to keep perspective on a cardinal
 * view.
 *
 * ## Why the sign no longer carries the direction
 *
 * It used to: `cut=-2.6` meant "2.6 m, looking up", on the reasoning that a
 * height and a direction in two parameters invites the two to disagree. The
 * reasoning was fine and the encoding was lossy, because it quietly assumed a
 * cut height is never negative.
 *
 * It often is. The renderer's world is metres from the MODEL's origin, and
 * plenty of buildings put that origin at the ground floor with a basement
 * below it — the viewport reports bounds like -3.00 m to +9.00 m and ranges
 * the slider over them. Under the old encoding every one of those heights came
 * back through `Math.abs` as its positive mirror, so the bottom quarter of the
 * building could not be cut at all: drag below zero and the plane jumped to
 * the other side of the ground floor.
 *
 * So `cut` is now the signed height and `cutup` is the direction. The pair
 * cannot disagree because neither is derivable from the other.
 *
 * ## Reading links written by the old encoding
 *
 * `cutup` doubles as the marker for which encoding wrote the link, because the
 * old one emitted it in exactly one case (a flipped cut at exactly zero, where
 * a sign cannot be written) and the new one always emits it. So:
 *
 * - `cutup` present → the signed reading. `cut` is the height.
 * - `cutup` absent → the old reading. `|cut|` is the height and the sign is
 *   the direction.
 *
 * Every link the old encoding could produce still resolves to the view it was
 * copied from, including `cut=0&cutup=1`, which both readings agree on. "A
 * view is a link" is only true if a link keeps working.
 */
export interface BimViewerCameraState {
  view: BimCameraView
  section: BimSection | null
  /** Set only when it disagrees with {@link impliesOrthographic}. */
  orthographic: boolean
}

export function defaultCameraState(): BimViewerCameraState {
  return { view: 'iso', section: null, orthographic: false }
}

export function encodeCameraState(state: BimViewerCameraState, params: URLSearchParams): void {
  if (state.view !== 'iso') params.set('view', state.view)
  if (state.section) {
    // `-0` would serialise as "-0" and read back as a negative zero, which is
    // a height nobody typed and a needless difference between two links to the
    // same view.
    params.set('cut', String(round(state.section.atMetres) || 0))
    // Always, not only when flipped: its presence is what tells the parser
    // this link was written by the signed encoding rather than the one that
    // put the direction in the sign.
    params.set('cutup', state.section.flipped ? '1' : '0')
  }
  if (state.orthographic !== impliesOrthographic(state.view)) {
    params.set('proj', state.orthographic ? 'ortho' : 'persp')
  }
}

export function parseCameraState(params: URLSearchParams): BimViewerCameraState {
  const rawView = params.get('view')?.trim()
  const view = rawView && VIEWS.has(rawView) ? (rawView as BimCameraView) : 'iso'

  let section: BimSection | null = null
  const rawCut = params.get('cut')
  if (rawCut !== null && rawCut.trim() !== '') {
    const cut = Number(rawCut)
    if (Number.isFinite(cut)) {
      const direction = params.get('cutup')
      section =
        direction === null
          ? // No direction parameter: a link from the encoding that put the
            // direction in the sign. Read it the way it was written.
            { atMetres: round(Math.abs(cut)), flipped: cut < 0 }
          : { atMetres: round(cut), flipped: direction === '1' }
    }
  }

  const proj = params.get('proj')?.trim()
  const orthographic =
    proj === 'ortho' ? true : proj === 'persp' ? false : impliesOrthographic(view)

  return { view, section, orthographic }
}

/**
 * A wheel event's zoom step, normalised across the three `deltaMode` units.
 *
 * Browsers do not agree on what a wheel notch is. A mouse in Chrome reports
 * PIXELS, Firefox's line mode reports LINES, and a page-mode wheel reports
 * SCREENS. Reading `deltaY` raw treats "3 lines" as three pixels, which is why
 * the viewport barely moved for anyone on a trackpad or on Firefox while
 * feeling fine on the machine it was built on.
 *
 * Extracted from the canvas because it is the one part of the wheel handler
 * that is arithmetic rather than WebGPU: the component cannot run in CI (no GPU
 * adapter), and this can.
 */
export function wheelZoomDelta(
  deltaY: number,
  deltaMode: number,
  canvasHeight: number,
  /** Multiplier taking normalised pixels to the camera's zoom units. */
  scale = 0.01
): number {
  // 1 = lines (≈ one text line), 2 = pages (one viewport). 0 = pixels already.
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(canvasHeight, 1) : 1
  return deltaY * unit * scale
}

/**
 * One keypress, as a camera move.
 *
 * The viewport is a `<canvas>`: to a keyboard it is a picture with no controls
 * at all, so every gesture the mouse has needs a key that does the same thing.
 * The bindings are the ones this audience already has in their fingers from
 * Revit, Navisworks and every game engine — arrows turn, `+`/`-` close in.
 *
 * Direction is in SCREEN terms, matching the drag it stands in for: `ArrowUp`
 * is the same as dragging the pointer up. Whether that tips the camera or the
 * model is the renderer's convention, and it must stay the same for both
 * input methods or the two disagree on the same screen.
 *
 * Pure so the mapping is pinned without a GPU: the component that consumes it
 * cannot run in CI, and this is the half that carries the decisions.
 */
export type CameraKeyStep =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'zoom'; amount: number }

/** Zoom units per keypress. Roughly one wheel notch — a press should be a step, not a leap. */
const KEY_ZOOM_STEP = 0.6

export function keyboardCameraStep(key: string): CameraKeyStep | null {
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'move', x: -1, y: 0 }
    case 'ArrowRight':
      return { kind: 'move', x: 1, y: 0 }
    case 'ArrowUp':
      return { kind: 'move', x: 0, y: -1 }
    case 'ArrowDown':
      return { kind: 'move', x: 0, y: 1 }
    // Both faces of the same physical key, so a reader does not have to hold
    // shift to zoom in on a keyboard where `+` is shifted.
    case '+':
    case '=':
      // Negative delta is toward the model — the renderer's sign convention.
      return { kind: 'zoom', amount: -KEY_ZOOM_STEP }
    case '-':
    case '_':
      return { kind: 'zoom', amount: KEY_ZOOM_STEP }
    default:
      return null
  }
}

/**
 * The centre of an element's bounding box — the point orbit should rotate
 * about when that element is selected.
 *
 * The renderer's default pivot is the camera target, which on a building is the
 * middle of the whole model: inspecting a stair core in one corner swung the
 * camera in a wide arc and threw the element off screen on every drag.
 */
export function boundsCentre(box: {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}): { x: number; y: number; z: number } {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  }
}

/**
 * Read a response body to completion, reporting real progress as it arrives.
 *
 * `response.arrayBuffer()` returns the same bytes in the same time, but it
 * yields nothing until the last one lands — so a 149 MB model showed an
 * indeterminate spinner for a minute, which is indistinguishable from a hang.
 * Streaming does not make the download faster; it makes it legible, and on a
 * file this size that is the difference between waiting and giving up.
 *
 * `Content-Length` is absent under chunked transfer encoding, and behind a
 * proxy that recompresses it can even disagree with the decoded byte count.
 * Progress is therefore reported as `null` when there is no length to divide
 * by, and clamped when there is, rather than allowed to exceed 100.
 */
export async function downloadWithProgress(
  response: { headers: { get(name: string): string | null }; body: unknown; arrayBuffer(): Promise<ArrayBuffer> },
  onProgress: (percent: number | null) => void
): Promise<Uint8Array> {
  const body = response.body as {
    getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> }
  } | null
  const reader = body?.getReader?.()
  // No streaming body (an older browser, or a mocked response): fall back to
  // the buffered read rather than failing the load for want of a progress bar.
  if (!reader) {
    const buffered = new Uint8Array(await response.arrayBuffer())
    onProgress(null)
    return buffered
  }

  // The source is served gzipped (see `writeCompressedSource`), and on a
  // gzipped response `Content-Length` is the COMPRESSED size while a streaming
  // reader counts DECODED bytes. Dividing one by the other sends the bar to
  // 100% at a seventh of the file and leaves it there. The uncompressed length
  // travels as user metadata for exactly this; without it — an older model with
  // no gzip sibling, or a header CORS will not expose — an encoded response
  // reports indeterminate rather than wrong.
  const encoded = (response.headers.get('Content-Encoding') ?? '').trim() !== ''
  const declaredRaw =
    response.headers.get('x-amz-meta-uncompressed-length') ??
    (encoded ? null : response.headers.get('Content-Length'))
  const declared = Number(declaredRaw ?? '')
  const total = Number.isFinite(declared) && declared > 0 ? declared : 0
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    received += value.length
    onProgress(total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null)
  }

  const buffer = new Uint8Array(received)
  let at = 0
  for (const chunk of chunks) {
    buffer.set(chunk, at)
    at += chunk.length
  }
  return buffer
}

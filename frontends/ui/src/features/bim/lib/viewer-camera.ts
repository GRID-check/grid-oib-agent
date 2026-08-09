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

// ---------------------------------------------------------------------------
// URL encoding
// ---------------------------------------------------------------------------

/**
 * `view=north`, `cut=2.6`, `cut=-2.6` for an upward cut, `persp=1` to keep
 * perspective on a cardinal view.
 *
 * The sign carries `flipped` rather than a second parameter: a cut is a height
 * and a direction, the direction has two values, and a URL that reads
 * `cut=2.6&cutUp=1` invites the two to disagree. A cut at exactly 0 is encoded
 * as `0` and read as looking down, which is the only reading a bare zero can
 * have.
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
    const magnitude = round(Math.abs(state.section.atMetres))
    params.set('cut', String(state.section.flipped ? -magnitude || 0 : magnitude))
    // A flipped cut at exactly zero cannot be signed, so it needs the flag.
    if (state.section.flipped && magnitude === 0) params.set('cutup', '1')
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
      const flipped = cut < 0 || (Object.is(cut, 0) && params.get('cutup') === '1')
      section = { atMetres: round(Math.abs(cut)), flipped }
    }
  }

  const proj = params.get('proj')?.trim()
  const orthographic =
    proj === 'ortho' ? true : proj === 'persp' ? false : impliesOrthographic(view)

  return { view, section, orthographic }
}

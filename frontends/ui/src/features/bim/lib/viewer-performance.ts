/**
 * What the viewport does to survive a real building.
 *
 * ifc-lite ships four separate mechanisms for scaling to models that do not
 * fit comfortably on a GPU, and this viewport used none of them: every frame
 * drew every batch at full detail with f32 vertices. That is fine on the
 * 8 MB test file and it is the difference between usable and not on the
 * 150 MB ones this product is actually pointed at — a Revit export of a
 * hospital is millions of triangles, most of them screws and pipe hangers
 * that project to less than a pixel.
 *
 * The four, and what each is for:
 *
 * | mechanism | when it applies | what it saves |
 * |---|---|---|
 * | quantized batches | at load | half the vertex memory (12 B/vertex, not 28) |
 * | LOD1 index ranges | at load, drawn per frame | vertex work on distant batches |
 * | contribution culling | per frame | whole draw calls for sub-pixel batches |
 * | GPU residency budget | per frame | VRAM, by evicting cold batches |
 *
 * Only the first three are used. The residency budget is deliberately left
 * alone: it evicts batches and restores them asynchronously, so the failure
 * mode is geometry popping in as the camera moves, and choosing a budget
 * without measuring on the target hardware would trade a real problem
 * (running out of VRAM on a huge model) for a visible one (a building that
 * assembles itself while you orbit) on every model. It belongs behind a
 * measurement, not behind a guess.
 *
 * ## Why the thresholds are what they are
 *
 * Contribution culling drops a batch whose bounding sphere projects below a
 * pixel radius. At rest the threshold is ONE device pixel: below that the
 * batch cannot contribute more than a flicker of a single pixel, so dropping
 * it is as close to lossless as a heuristic gets. While the camera is moving
 * it rises, because quality matters least mid-gesture and that is exactly when
 * the renderer is under the most pressure — the same policy Cesium and
 * xeokit-class viewers use.
 *
 * LOD's threshold is far more conservative than the cull's. A simplified index
 * range is visible if you look at it, so it only kicks in for batches already
 * small enough that the simplification cannot change the silhouette.
 */

import type { ContributionCullOptions, RenderOptions } from '@ifc-lite/renderer'

/** Below one device pixel of projected radius, a batch is not visible at all. */
const CULL_AT_REST_PX = 1
/** Mid-gesture. Never below the resting threshold — motion must not cull less. */
const CULL_WHILE_MOVING_PX = 3

/**
 * Projected radius below which a batch draws its simplified index range.
 *
 * Twelve device pixels is roughly a glyph. A batch that small is a bracket or
 * a pipe hanger, and its simplified silhouette is indistinguishable from its
 * real one at that size.
 */
const LOD_BELOW_PX = 12

export const CONTRIBUTION_CULL: ContributionCullOptions = {
  pixelRadius: CULL_AT_REST_PX,
  interactingPixelRadius: CULL_WHILE_MOVING_PX,
}

/**
 * The scaling options for an interactive frame.
 *
 * Split from the capture options below because they are opposites: an
 * interactive frame trades completeness for latency sixty times a second, and
 * a capture must not trade it at all.
 */
export function interactiveFrameOptions(): Pick<RenderOptions, 'contributionCull' | 'lod'> {
  return {
    contributionCull: CONTRIBUTION_CULL,
    lod: { screenPx: LOD_BELOW_PX },
  }
}

/**
 * The options for a frame someone is going to keep.
 *
 * A screenshot is looked at for minutes, printed, and attached to a finding —
 * every shortcut that is invisible at 60 fps is visible there. So culling and
 * LOD are OFF (absent, which the renderer documents as the exhaustive
 * default), and any batch the residency budget aged out is rebuilt
 * synchronously first. `restoreEvictedForCapture` costs frame time in
 * proportion to the evicted set, which is exactly why it must never appear on
 * the interactive path.
 */
export function captureFrameOptions(): Pick<
  RenderOptions,
  'contributionCull' | 'lod' | 'restoreEvictedForCapture' | 'isInteracting' | 'isStreaming'
> {
  return {
    contributionCull: undefined,
    lod: undefined,
    restoreEvictedForCapture: true,
    // A capture is never mid-gesture and never mid-load, whatever the
    // interactive loop last thought: both hints make the renderer shed work
    // that a kept image needs.
    isInteracting: false,
    isStreaming: false,
  }
}

/**
 * What a captured view is called when it lands in someone's downloads.
 *
 * The model's own name first, because that is what the reader will search
 * for, and a timestamp after it, because they will capture the same model
 * from four angles in one sitting and `model.png (3)` tells them nothing about
 * which is which. Seconds are included for the same reason.
 */
export function screenshotFilename(modelFilename: string | null, when: Date): string {
  const base = (modelFilename ?? 'modell')
    .replace(/\.(ifc|ifczip|zip)$/i, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  const stamp = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
    '-',
    String(when.getHours()).padStart(2, '0'),
    String(when.getMinutes()).padStart(2, '0'),
    String(when.getSeconds()).padStart(2, '0'),
  ].join('')
  return `${base || 'modell'}-${stamp}.png`
}

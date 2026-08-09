/**
 * Turning pdf.js text items into positioned chunks the passage matcher can use.
 *
 * `getTextContent` hands back each run of text with a transformation matrix in
 * PDF user space, where the origin is BOTTOM-left and y grows upward. Every
 * rectangle the viewer draws is in CSS space, where the origin is top-left and y
 * grows downward. Composing the run's matrix with the page viewport's is what
 * bridges the two, and it is the only place in the highlight path that touches
 * PDF geometry — kept here, pure and matrix-in/rects-out, so it can be tested
 * without a PDF, a canvas or a worker.
 */

import type { TextChunk } from './passage-highlight'

/** The fields of a pdf.js `TextItem` this conversion needs. */
export interface RawTextItem {
  str: string
  width: number
  height: number
  /** The run's 6-element matrix, in PDF user space. */
  transform: number[]
}

/**
 * Compose two 2×3 affine matrices, `outer` applied after `inner` — the same
 * multiplication pdf.js's own `Util.transform` performs, inlined so this module
 * stays free of the pdf.js runtime (and so it can run in a plain unit test).
 */
export const composeTransform = (outer: number[], inner: number[]): number[] => {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = outer
  const [g = 0, h = 0, i = 0, j = 0, k = 0, l = 0] = inner
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ]
}

/**
 * Position one text run in viewport space.
 *
 * The composed matrix puts the run's BASELINE at `[4], [5]`, so the box's top
 * edge is one glyph height above it — the same correction pdf.js's own text
 * layer applies. Height comes from the matrix rather than `item.height`, which
 * several producers emit as 0.
 */
export const textItemToChunk = (item: RawTextItem, viewportTransform: number[]): TextChunk => {
  const tx = composeTransform(viewportTransform, item.transform)
  const height = Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || item.height
  // `item.width` already carries the font size — pdf.js measures it in PDF user
  // space — so the only thing still missing is the VIEWPORT's scale. Taking the
  // scale off the composed matrix instead would multiply the font size in a
  // second time and stretch every highlight by roughly a factor of twelve.
  const scale = Math.hypot(viewportTransform[0] ?? 0, viewportTransform[1] ?? 0) || 1
  return {
    text: item.str,
    x: tx[4] ?? 0,
    y: (tx[5] ?? 0) - height,
    width: item.width * scale,
    height,
  }
}

/**
 * Convert a page's text items, dropping the ones that cannot contribute to a
 * highlight: whitespace-only runs (they carry no letters to match) and runs with
 * no measurable box (nothing to draw).
 */
export const pageTextChunks = (items: RawTextItem[], viewportTransform: number[]): TextChunk[] =>
  items
    .map((item) => textItemToChunk(item, viewportTransform))
    .filter((chunk) => chunk.text.trim().length > 0 && chunk.width > 0 && chunk.height > 0)

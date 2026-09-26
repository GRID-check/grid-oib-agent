/**
 * How wide a drawn diagram is shown — its own size, never blown up, and never
 * shrunk past legibility.
 *
 * Mermaid sizes its SVG with `width="100%"` plus `style="max-width: Npx"`. The
 * SVG allow-list (`lib/diagrams/svg.ts`) refuses the `style` attribute, for
 * reasons that are right for a filed file, so on screen every diagram took the
 * column's width whatever its own: a four-state `stateDiagram` (236 px wide)
 * came out 2.6× with 36 px labels, and a five-entry `timeline` (1 390 px) came
 * out at 0.44× with 6 px labels. Measured in Chromium on `/dev/answer-blocks`.
 *
 * The fix is on the screen, not in the bytes: the SVG stays exactly what gets
 * filed, and its wrapper gets the width the viewBox states, capped by the
 * column. A diagram wider than the column shrinks to at most
 * {@link MIN_SCALE} of its size (14 px labels stay ≥ 10.5 px) and scrolls
 * sideways beyond that, inside the figure's `overflow-x-auto` frame.
 */

/** The smallest scale a diagram is shown at before it scrolls instead. */
export const MIN_SCALE = 0.75

/** The viewBox width of a serialised SVG, or `null` when it states none. */
export function viewBoxWidth(svg: string): number | null {
  const match =
    /<svg\b[^>]*\bviewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+[\d.e]+\s*"/i.exec(svg)
  if (!match) return null
  const width = Number.parseFloat(match[1])
  return Number.isFinite(width) && width > 0 ? width : null
}

/**
 * The wrapper style for a drawn SVG: its own width, down to {@link MIN_SCALE}
 * of it when the column is narrower. `undefined` leaves the old full-width
 * behaviour for an SVG without a viewBox, which mermaid never emits.
 */
export function diagramFrameStyle(svg: string): { width: string; maxWidth: string } | undefined {
  const width = viewBoxWidth(svg)
  if (width === null) return undefined
  const rounded = Math.ceil(width)
  return { width: `${rounded}px`, maxWidth: `max(100%, ${Math.ceil(rounded * MIN_SCALE)}px)` }
}

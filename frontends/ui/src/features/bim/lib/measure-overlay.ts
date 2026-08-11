/**
 * The measurement drawing, over the model.
 *
 * ## Why this is DOM and not GPU
 *
 * ifc-lite can draw 3D lines (`uploadAnnotationLines3D`) and even glyphs, and
 * both were the wrong tool here. Annotation lines are folded into the model's
 * bounds, so every measurement would grow the box that Home frames and that
 * the cut slider is ranged over — measure across a room and the section slider
 * silently re-scales. And a dimension line is not part of the building: it must
 * be readable through a wall, at a constant weight regardless of zoom, in the
 * app's own type. That is a description of an overlay, not of geometry.
 *
 * So: an `<svg>` for the lines and ticks, absolutely-positioned `<div>`s for
 * the labels, both driven from `Camera.projectToScreen`.
 *
 * ## Why it is imperative
 *
 * It is updated every frame the camera moves. Routing sixty position updates a
 * second through React would re-render the whole stage — the rail, the dock,
 * the inspector — to move two line ends. The nodes are created when the set of
 * measurements changes (rare) and only their coordinates are written per frame
 * (constant work, no allocation, no reconciliation).
 *
 * Kept out of the canvas component so it can be driven by a fake projector in
 * a test, which is the only way to assert that a measurement lands where the
 * camera says it does.
 */

import {
  distanceMetres,
  formatMetres,
  horizontalMetres,
  isSkew,
  midpoint,
  verticalMetres,
  type MeasureAnchor,
  type MeasurePoint,
  type Measurement,
  type MeasureSnapKind,
} from './viewer-measure'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** World point → canvas pixel, or null when the point is behind the camera. */
export type Projector = (point: MeasurePoint) => { x: number; y: number } | null

/**
 * Wording the overlay needs, injected rather than imported.
 *
 * The overlay is created inside the canvas, which is behind `next/dynamic` and
 * has no translation context of its own at construction time. Two short
 * strings are cheaper to pass than a whole i18n dependency, and it keeps this
 * module a pure function of its inputs.
 */
export interface MeasureOverlayLabels {
  /** e.g. `horizontal` / `horizontal` — prefixes the run component. */
  horizontal: string
  /** e.g. `vertical` / `vertikal` — prefixes the rise component. */
  vertical: string
}

/** Radius of the tick drawn at each placed end, in CSS pixels. */
const TICK_RADIUS = 4
/** The snap marker under the cursor is bigger — it is a target, not a record. */
const CURSOR_RADIUS = 6

/**
 * How each snap kind is drawn.
 *
 * A corner, a point on an edge and a point on a face are three different
 * strengths of claim, and a reader has to be able to tell them apart at a
 * glance — a "1.20 m" taken between two face points is a rougher number than
 * the same one taken between two corners. Shape rather than colour, because
 * colour in this viewport already means compliance status.
 */
const SNAP_SHAPE: Record<MeasureSnapKind, 'square' | 'diamond' | 'circle'> = {
  vertex: 'square',
  edge: 'diamond',
  face: 'circle',
  face_center: 'circle',
  point_cloud: 'circle',
  none: 'circle',
}

interface MeasurementNodes {
  line: SVGLineElement
  from: SVGPathElement
  to: SVGPathElement
  label: HTMLDivElement
  measurement: Measurement
}

/** The marker path for a snap kind, centred on the origin. */
function markerPath(kind: MeasureSnapKind, radius: number): string {
  switch (SNAP_SHAPE[kind]) {
    case 'square':
      return `M ${-radius} ${-radius} H ${radius} V ${radius} H ${-radius} Z`
    case 'diamond':
      return `M 0 ${-radius} L ${radius} 0 L 0 ${radius} L ${-radius} 0 Z`
    default:
      return `M ${-radius} 0 a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`
  }
}

/** The full readout for one measurement. */
export function measurementText(
  measurement: Measurement,
  labels: MeasureOverlayLabels
): string {
  const { from, to } = measurement
  const total = formatMetres(distanceMetres(from.point, to.point))
  if (!isSkew(from.point, to.point)) return total
  const run = formatMetres(horizontalMetres(from.point, to.point))
  const rise = formatMetres(Math.abs(verticalMetres(from.point, to.point)))
  return `${total} · ${labels.horizontal} ${run} · ${labels.vertical} ${rise}`
}

export class MeasureOverlay {
  private readonly svg: SVGSVGElement
  private readonly labelLayer: HTMLElement
  private readonly labels: MeasureOverlayLabels
  private nodes: MeasurementNodes[] = []

  /** The rubber band: a placed first point, and wherever the cursor is now. */
  private pendingLine: SVGLineElement | null = null
  private pendingMarker: SVGPathElement | null = null
  private pendingLabel: HTMLDivElement | null = null
  private cursorMarker: SVGPathElement | null = null
  private anchor: MeasureAnchor | null = null
  private cursor: MeasureAnchor | null = null

  constructor(svg: SVGSVGElement, labelLayer: HTMLElement, labels: MeasureOverlayLabels) {
    this.svg = svg
    this.labelLayer = labelLayer
    this.labels = labels
  }

  /**
   * Replace the drawn set.
   *
   * Rebuilds nodes wholesale rather than diffing: the list changes when a
   * reader finishes a measurement, which is a human-speed event, and a diff
   * here would be code that runs rarely and is wrong the one time it matters.
   */
  setMeasurements(measurements: readonly Measurement[]): void {
    for (const node of this.nodes) {
      node.line.remove()
      node.from.remove()
      node.to.remove()
      node.label.remove()
    }
    this.nodes = measurements.map((measurement) => {
      const line = this.svg.appendChild(document.createElementNS(SVG_NS, 'line'))
      line.setAttribute('stroke', 'var(--foreground)')
      line.setAttribute('stroke-width', '1.5')
      // Halo: a hairline over a dark facade is invisible, and a measurement
      // you cannot see is worse than one you never took.
      line.setAttribute('paint-order', 'stroke')
      line.setAttribute('vector-effect', 'non-scaling-stroke')

      const from = this.appendMarker(measurement.from.snap, TICK_RADIUS)
      const to = this.appendMarker(measurement.to.snap, TICK_RADIUS)

      const label = document.createElement('div')
      label.className =
        'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-background/95 px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap tabular-nums shadow-sm'
      label.textContent = measurementText(measurement, this.labels)
      this.labelLayer.appendChild(label)

      return { line, from, to, label, measurement }
    })
  }

  /** The in-progress measurement: a placed anchor and the live cursor. */
  setPending(anchor: MeasureAnchor | null, cursor: MeasureAnchor | null): void {
    this.anchor = anchor
    this.cursor = cursor

    if (anchor && !this.pendingLine) {
      this.pendingLine = this.svg.appendChild(document.createElementNS(SVG_NS, 'line'))
      this.pendingLine.setAttribute('stroke', 'var(--foreground)')
      this.pendingLine.setAttribute('stroke-width', '1.5')
      // Dashed while it is a proposal. The moment it is committed it becomes a
      // solid line, which is the only feedback that the second click landed.
      this.pendingLine.setAttribute('stroke-dasharray', '4 3')
      this.pendingMarker = this.appendMarker(anchor.snap, TICK_RADIUS)
      this.pendingLabel = document.createElement('div')
      this.pendingLabel.className =
        'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-background/95 px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap tabular-nums shadow-sm'
      this.labelLayer.appendChild(this.pendingLabel)
    }
    if (!anchor) this.clearPending()

    // The cursor marker exists whenever measuring is live, anchor or not: it
    // is what tells the reader the tool has locked onto a corner BEFORE they
    // commit to it, which is the difference between measuring and guessing.
    if (cursor && !this.cursorMarker) {
      this.cursorMarker = this.appendMarker(cursor.snap, CURSOR_RADIUS)
    } else if (cursor && this.cursorMarker) {
      this.cursorMarker.setAttribute('d', markerPath(cursor.snap, CURSOR_RADIUS))
    } else if (!cursor && this.cursorMarker) {
      this.cursorMarker.remove()
      this.cursorMarker = null
    }
  }

  /**
   * Move everything to where the camera now says it is.
   *
   * Called once per drawn frame. A point the camera cannot see — behind it, or
   * off the near plane — hides its whole measurement rather than clamping it
   * to an edge, because a dimension line stretching to a screen corner is a
   * measurement of something that is not there.
   */
  update(project: Projector): void {
    for (const node of this.nodes) {
      const from = project(node.measurement.from.point)
      const to = project(node.measurement.to.point)
      if (!from || !to) {
        this.hide(node.line, node.from, node.to)
        node.label.style.display = 'none'
        continue
      }
      this.place(node.line, from, to)
      this.placeMarker(node.from, from)
      this.placeMarker(node.to, to)
      const centre = project(midpoint(node.measurement.from.point, node.measurement.to.point))
      if (centre) {
        node.label.style.display = ''
        node.label.style.left = `${centre.x}px`
        node.label.style.top = `${centre.y}px`
      } else {
        node.label.style.display = 'none'
      }
    }

    const anchor = this.anchor ? project(this.anchor.point) : null
    const cursor = this.cursor ? project(this.cursor.point) : null

    if (this.pendingLine && this.pendingMarker) {
      if (anchor && cursor) {
        this.place(this.pendingLine, anchor, cursor)
        this.placeMarker(this.pendingMarker, anchor)
      } else {
        this.hide(this.pendingLine, this.pendingMarker)
      }
    }
    if (this.pendingLabel) {
      if (this.anchor && this.cursor && anchor && cursor) {
        this.pendingLabel.style.display = ''
        this.pendingLabel.textContent = formatMetres(
          distanceMetres(this.anchor.point, this.cursor.point)
        )
        this.pendingLabel.style.left = `${(anchor.x + cursor.x) / 2}px`
        this.pendingLabel.style.top = `${(anchor.y + cursor.y) / 2}px`
      } else {
        this.pendingLabel.style.display = 'none'
      }
    }
    if (this.cursorMarker) {
      if (cursor) this.placeMarker(this.cursorMarker, cursor)
      else this.hide(this.cursorMarker)
    }
  }

  destroy(): void {
    this.setMeasurements([])
    this.setPending(null, null)
  }

  private appendMarker(kind: MeasureSnapKind, radius: number): SVGPathElement {
    const marker = this.svg.appendChild(document.createElementNS(SVG_NS, 'path'))
    marker.setAttribute('d', markerPath(kind, radius))
    marker.setAttribute('fill', 'var(--background)')
    marker.setAttribute('stroke', 'var(--foreground)')
    marker.setAttribute('stroke-width', '1.5')
    return marker
  }

  private clearPending(): void {
    this.pendingLine?.remove()
    this.pendingMarker?.remove()
    this.pendingLabel?.remove()
    this.pendingLine = null
    this.pendingMarker = null
    this.pendingLabel = null
  }

  private place(
    line: SVGLineElement,
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): void {
    line.style.display = ''
    line.setAttribute('x1', String(from.x))
    line.setAttribute('y1', String(from.y))
    line.setAttribute('x2', String(to.x))
    line.setAttribute('y2', String(to.y))
  }

  private placeMarker(marker: SVGPathElement, at: { x: number; y: number }): void {
    marker.style.display = ''
    marker.setAttribute('transform', `translate(${at.x} ${at.y})`)
  }

  private hide(...elements: (SVGElement | null)[]): void {
    for (const element of elements) {
      if (element) element.style.display = 'none'
    }
  }
}

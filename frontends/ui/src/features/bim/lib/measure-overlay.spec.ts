/**
 * The measurement drawing.
 *
 * Driven by a fake projector, which is the whole point: a dimension line's
 * correctness is "it is where the camera says the point is", and that is a
 * claim about coordinates, not about pixels. The failures this catches are the
 * ones that look fine in a screenshot taken from one angle — a line that stops
 * following the model when a point goes behind the camera, a label left over
 * from a measurement that was cleared, a stale readout after the picks moved.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MeasureOverlay, measurementText, type Projector } from './measure-overlay'
import { completeMeasurement, type MeasureAnchor, type Measurement } from './viewer-measure'

const LABELS = { horizontal: 'horizontal', vertical: 'vertical' }

const at = (x: number, y: number, z: number, snap: MeasureAnchor['snap'] = 'vertex'): MeasureAnchor => ({
  point: { x, y, z },
  snap,
})

/** A projector that flattens the world onto the screen, ignoring Z. */
const flat: Projector = (point) => ({ x: point.x * 10, y: point.y * 10 })

/** Nothing is on screen — every point is behind the camera. */
const behind: Projector = () => null

function build(): {
  svg: SVGSVGElement
  labels: HTMLDivElement
  overlay: MeasureOverlay
} {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const labels = document.createElement('div')
  document.body.append(svg, labels)
  return { svg, labels, overlay: new MeasureOverlay(svg, labels, LABELS) }
}

const measurement = (from: MeasureAnchor, to: MeasureAnchor): Measurement => {
  const built = completeMeasurement(from, to)
  if (!built) throw new Error('the fixture is a zero-length measurement')
  return built
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('what the overlay draws', () => {
  it('puts the line where the camera projects the two picks', () => {
    const { svg, overlay } = build()
    overlay.setMeasurements([measurement(at(0, 0, 0), at(2, 3, 0))])
    overlay.update(flat)

    // Two elements per dimension line: a wide `--background` halo and the
    // hairline over it. Both are asserted, because a halo that stops tracking
    // the line it protects is a smear across the model.
    const [halo, line] = [...svg.querySelectorAll('line')]
    for (const element of [halo, line]) {
      expect(element.getAttribute('x1')).toBe('0')
      expect(element.getAttribute('y1')).toBe('0')
      expect(element.getAttribute('x2')).toBe('20')
      expect(element.getAttribute('y2')).toBe('30')
    }
    expect(halo.getAttribute('stroke')).toBe('var(--background)')
    expect(line.getAttribute('stroke')).toBe('var(--foreground)')
  })

  it('keeps a hairline readable over a facade of the same tone', () => {
    // The model's colours are the model's: a dark render in light mode
    // swallows a `--foreground` line entirely, and a measurement you cannot
    // see is worse than one you never took. The halo has to be WIDER than the
    // line it sits under, or it is not a halo.
    const { svg, overlay } = build()
    overlay.setMeasurements([measurement(at(0, 0, 0), at(1, 0, 0))])

    const [halo, line] = [...svg.querySelectorAll('line')]
    expect(Number(halo.getAttribute('stroke-width'))).toBeGreaterThan(
      Number(line.getAttribute('stroke-width'))
    )
  })

  it('follows the camera when it moves', () => {
    const { svg, overlay } = build()
    overlay.setMeasurements([measurement(at(0, 0, 0), at(1, 0, 0))])
    overlay.update(flat)
    overlay.update((point) => ({ x: point.x * 100, y: point.y * 100 }))

    expect(svg.querySelector('line')?.getAttribute('x2')).toBe('100')
  })

  it('marks each end with the shape of the thing it snapped to', () => {
    // A corner and a point on a face are two different strengths of claim,
    // and a reader has to be able to tell them apart without reading a legend.
    const { svg, overlay } = build()
    overlay.setMeasurements([measurement(at(0, 0, 0, 'vertex'), at(1, 0, 0, 'face'))])
    overlay.update(flat)

    const [from, to] = [...svg.querySelectorAll('path')]
    // A square for a vertex, a circle (arc path) for a face.
    expect(from?.getAttribute('d')).toContain('H')
    expect(to?.getAttribute('d')).toContain('a')
  })

  it('writes the length beside the line', () => {
    const { labels, overlay } = build()
    overlay.setMeasurements([measurement(at(0, 0, 0), at(3, 4, 0))])
    overlay.update(flat)

    expect(labels.textContent).toContain('5.00 m')
  })

  it('places the label at the midpoint the camera projects', () => {
    const { labels, overlay } = build()
    overlay.setMeasurements([measurement(at(0, 0, 0), at(2, 0, 0))])
    overlay.update(flat)

    const label = labels.firstElementChild as HTMLElement
    expect(label.style.left).toBe('10px')
    expect(label.style.top).toBe('0px')
  })
})

describe('when a measurement is not on screen', () => {
  it('hides the whole thing rather than clamping it to an edge', () => {
    // A dimension line stretching to a screen corner is a measurement of
    // something that is not there, which is worse than no line at all.
    const { svg, labels, overlay } = build()
    overlay.setMeasurements([measurement(at(0, 0, 0), at(1, 0, 0))])
    overlay.update(behind)

    for (const line of svg.querySelectorAll('line')) expect(line.style.display).toBe('none')
    expect((labels.firstElementChild as HTMLElement).style.display).toBe('none')
  })

  it('comes back when the camera does', () => {
    const { svg, overlay } = build()
    overlay.setMeasurements([measurement(at(0, 0, 0), at(1, 0, 0))])
    overlay.update(behind)
    overlay.update(flat)

    for (const line of svg.querySelectorAll('line')) expect(line.style.display).toBe('')
  })
})

describe('the measurement in progress', () => {
  it('draws a dashed rubber band from the anchor to the cursor', () => {
    // Dashed while it is a proposal: the switch to a solid line is the only
    // feedback that the second click landed.
    const { svg, overlay } = build()
    overlay.setPending(at(0, 0, 0), at(1, 1, 0, 'edge'))
    overlay.update(flat)

    // The halo is dashed with it. A solid halo under a dashed stroke reads as
    // a solid line with a shadow — i.e. as a committed measurement.
    const [halo, line] = [...svg.querySelectorAll('line')]
    expect(halo.getAttribute('stroke-dasharray')).toBe('4 3')
    expect(line.getAttribute('stroke-dasharray')).toBe('4 3')
    expect(line.getAttribute('x2')).toBe('10')
  })

  it('reads out the distance as the cursor moves', () => {
    const { labels, overlay } = build()
    overlay.setPending(at(0, 0, 0), at(3, 4, 0))
    overlay.update(flat)
    expect(labels.textContent).toContain('5.00 m')

    overlay.setPending(at(0, 0, 0), at(6, 8, 0))
    overlay.update(flat)
    expect(labels.textContent).toContain('10.00 m')
  })

  it('shows the snap target before a point is placed at all', () => {
    // This is what separates measuring from guessing: the reader can see the
    // cursor has locked onto a corner BEFORE committing to it.
    const { svg, overlay } = build()
    overlay.setPending(null, at(1, 1, 0, 'vertex'))
    overlay.update(flat)

    expect(svg.querySelectorAll('path')).toHaveLength(1)
  })

  it('takes the rubber band away when the measurement is cancelled', () => {
    const { svg, labels, overlay } = build()
    overlay.setPending(at(0, 0, 0), at(1, 1, 0))
    overlay.update(flat)
    overlay.setPending(null, null)
    overlay.update(flat)

    expect(svg.querySelectorAll('line')).toHaveLength(0)
    expect(labels.children).toHaveLength(0)
  })
})

describe('replacing the drawn set', () => {
  it('leaves nothing behind when the measurements are cleared', () => {
    // A label orphaned by a clear is the classic imperative-overlay leak, and
    // it is invisible until someone clears a measurement they were looking at.
    const { svg, labels, overlay } = build()
    overlay.setMeasurements([
      measurement(at(0, 0, 0), at(1, 0, 0)),
      measurement(at(0, 0, 0), at(0, 2, 0)),
    ])
    overlay.update(flat)
    expect(labels.children).toHaveLength(2)

    overlay.setMeasurements([])
    expect(svg.children).toHaveLength(0)
    expect(labels.children).toHaveLength(0)
  })

  it('tears everything down on destroy', () => {
    const { svg, labels, overlay } = build()
    overlay.setMeasurements([measurement(at(0, 0, 0), at(1, 0, 0))])
    overlay.setPending(at(0, 0, 0), at(1, 1, 0))
    overlay.destroy()

    expect(svg.children).toHaveLength(0)
    expect(labels.children).toHaveLength(0)
  })
})

describe('the readout', () => {
  it('is one number when the measurement is square', () => {
    const square = measurement(at(0, 2, 0), at(2.4, 2, 0))
    expect(measurementText(square, LABELS)).toBe('2.40 m')
  })

  it('breaks a diagonal into run and rise, which is what answers the question', () => {
    // A diagonal's straight-line length answers neither "how wide" nor "how
    // high", and those are the only two questions anyone measures a building
    // to answer.
    const skew = measurement(at(0, 0, 0), at(3, 4, 0))
    expect(measurementText(skew, LABELS)).toBe('5.00 m · horizontal 3.00 m · vertical 4.00 m')
  })
})

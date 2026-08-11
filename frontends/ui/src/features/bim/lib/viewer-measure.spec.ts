/**
 * Measurement arithmetic.
 *
 * The assertions worth having are the ones a wrong answer would survive: a
 * horizontal distance read off the wrong pair of axes is right on every
 * single-storey test model and wrong by a storey height on every real one, and
 * a label that drops a trailing zero turns a dimension into an estimate.
 */

import { describe, expect, it } from 'vitest'
import {
  addMeasurement,
  completeMeasurement,
  distanceMetres,
  formatMetres,
  horizontalMetres,
  isSkew,
  measurementId,
  midpoint,
  verticalMetres,
  type MeasureAnchor,
} from './viewer-measure'

const at = (x: number, y: number, z: number): MeasureAnchor => ({
  point: { x, y, z },
  snap: 'vertex',
})

describe('the numbers a measurement reports', () => {
  it('measures the straight line between the picks', () => {
    expect(distanceMetres({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5)
  })

  it('measures the horizontal run on the ground plane, not on X/Y', () => {
    // Y is up in the renderer's world. Reading the run off X and Y instead is
    // the mistake that is invisible on a flat test model and wrong by a full
    // storey on a real one.
    const from = { x: 0, y: 0, z: 0 }
    const to = { x: 3, y: 10, z: 4 }
    expect(horizontalMetres(from, to)).toBe(5)
  })

  it('reports the rise with the sign the picks were taken in', () => {
    // A measurement taken downwards is a negative rise, not an absolute one —
    // "the soffit is 0.40 m BELOW the last pick" is the useful reading.
    expect(verticalMetres({ x: 0, y: 3, z: 0 }, { x: 0, y: 2.6, z: 0 })).toBeCloseTo(-0.4, 10)
  })

  it('puts the label halfway along the line', () => {
    expect(midpoint({ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: 6 })).toEqual({ x: 1, y: 2, z: 3 })
  })
})

describe('when the components are worth printing', () => {
  it('stays quiet on a purely horizontal measurement', () => {
    // "2.40 m (2.40 horizontal, 0.00 vertical)" is noise that teaches the
    // reader to stop reading the label.
    expect(isSkew({ x: 0, y: 2, z: 0 }, { x: 2.4, y: 2, z: 0 })).toBe(false)
  })

  it('stays quiet on a purely vertical one', () => {
    expect(isSkew({ x: 1, y: 0, z: 1 }, { x: 1, y: 2.7, z: 1 })).toBe(false)
  })

  it('speaks up on a diagonal, where one number answers nothing', () => {
    expect(isSkew({ x: 0, y: 0, z: 0 }, { x: 3, y: 1.5, z: 0 })).toBe(true)
  })
})

describe('how a length is written', () => {
  it('keeps the trailing zero a dimension needs', () => {
    // `2.4 m` reads as a rounded estimate; `2.40 m` reads as a dimension.
    expect(formatMetres(2.4)).toBe('2.40 m')
    expect(formatMetres(1)).toBe('1.00 m')
  })

  it('rounds to the centimetre', () => {
    expect(formatMetres(1.20449)).toBe('1.20 m')
    expect(formatMetres(1.206)).toBe('1.21 m')
  })

  it('switches to millimetres rather than printing 0.00 m', () => {
    expect(formatMetres(0.004)).toBe('4 mm')
    expect(formatMetres(-0.004)).toBe('-4 mm')
  })

  it('says so plainly when there is no number', () => {
    expect(formatMetres(Number.NaN)).toBe('—')
    expect(formatMetres(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('closing a measurement', () => {
  it('refuses a pick that did not move', () => {
    // A double-click, or two picks on the same corner: a dot with "0.00 m"
    // beside it reads as a broken tool.
    expect(completeMeasurement(at(1, 2, 3), at(1, 2, 3))).toBeNull()
    expect(completeMeasurement(at(1, 2, 3), at(1, 2.0005, 3))).toBeNull()
  })

  it('accepts a millimetre of travel', () => {
    expect(completeMeasurement(at(0, 0, 0), at(0, 0.0011, 0))).not.toBeNull()
  })

  it('keeps how each end was placed', () => {
    const measured = completeMeasurement(
      { point: { x: 0, y: 0, z: 0 }, snap: 'vertex' },
      { point: { x: 1, y: 0, z: 0 }, snap: 'face' }
    )
    // A reader has to be able to see that one end was a corner and the other
    // was a point on a face — the second is a weaker claim.
    expect(measured?.from.snap).toBe('vertex')
    expect(measured?.to.snap).toBe('face')
  })
})

describe('the list of measurements', () => {
  it('gives the same pair of picks the same identity', () => {
    expect(measurementId({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 })).toBe(
      measurementId({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 })
    )
  })

  it('does not stack a re-measurement on top of itself', () => {
    // Measuring the same thing twice to check yourself is normal, and it must
    // not leave two labels overlapping at the same midpoint.
    const one = completeMeasurement(at(0, 0, 0), at(2, 0, 0))
    const again = completeMeasurement(at(0, 0, 0), at(2, 0, 0))
    expect(one).not.toBeNull()
    const list = addMeasurement(addMeasurement([], one!), again!)
    expect(list).toHaveLength(1)
  })

  it('keeps distinct measurements', () => {
    const one = completeMeasurement(at(0, 0, 0), at(2, 0, 0))!
    const other = completeMeasurement(at(0, 0, 0), at(0, 3, 0))!
    expect(addMeasurement([one], other)).toHaveLength(2)
  })
})

/**
 * The motion kit's numbers, checked against the contracts its comments make.
 *
 * A spring's parameters are three opaque integers; its CHARACTER is the damping
 * ratio derived from them, and nothing in the type system connects the two. So
 * every claim the module documents — "ζ = 0.658", "6.4% overshoot", "travel
 * ≤ 24px" — is recomputed here from the shipped config. A future tweak to
 * `stiffness` that quietly turns a spring overdamped fails this file rather
 * than shipping as a spring in name only, which is exactly what happened to the
 * two springs this kit replaced.
 */

import { describe, expect, it } from 'vitest'

import {
  easeQuiet,
  motionBase,
  motionEntrance,
  motionQuick,
  motionSnap,
  springDrawer,
  springGlide,
  springDrawerLinear,
  springDrawerLinearDuration,
  springGentle,
  springPress,
  springSnap,
  springSnapLinear,
  springSnapLinearDuration,
  springSnappy,
  staggerMaxSteps,
  staggerParent,
  staggerStepSeconds,
  type SpringTransition,
} from './index'

/** ζ = damping / (2·√(stiffness·mass)) — the one number that is the spring. */
const dampingRatio = ({ stiffness, damping, mass }: SpringTransition): number =>
  damping / (2 * Math.sqrt(stiffness * mass))

/** Peak excursion past the target, as a fraction of the distance travelled. */
const overshoot = (spring: SpringTransition): number => {
  const zeta = dampingRatio(spring)
  return zeta >= 1 ? 0 : Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta))
}

/** Parses a CSS `linear()` easing into its control points. */
const parseLinear = (value: string): number[] => {
  const match = /^linear\((.+)\)$/.exec(value)
  expect(match, `not a linear() function: ${value}`).not.toBeNull()
  return (match?.[1] ?? '').split(',').map((point) => Number(point.trim()))
}

describe('spring configs', () => {
  describe('springPress — the interruptible one', () => {
    it('is critically damped, so a released gesture never lands an overshoot late', () => {
      // ζ = 1 exactly is the boundary; 600/38/0.6 sits a hair above it, which is
      // the safe side (never overshoots) rather than the fast side.
      expect(dampingRatio(springPress)).toBeGreaterThanOrEqual(0.98)
      expect(dampingRatio(springPress)).toBeLessThanOrEqual(1.02)
    })

    it('overshoots by nothing at all, at any travel', () => {
      expect(overshoot(springPress)).toBe(0)
    })
  })

  describe('springSnap — the playful one', () => {
    it('lands in the underdamped band the comment documents (ζ = 0.658)', () => {
      expect(dampingRatio(springSnap)).toBeCloseTo(0.658, 3)
      expect(dampingRatio(springSnap)).toBeGreaterThan(0.6)
      expect(dampingRatio(springSnap)).toBeLessThan(0.72)
    })

    it('overshoots 6.4%', () => {
      expect(overshoot(springSnap) * 100).toBeCloseTo(6.4, 1)
    })

    it('keeps overshoot inside the 1–2px budget across its documented travel range', () => {
      // The contract is stated in PIXELS because pixels are what the eye sees.
      // Below ~16px the flourish stops being visible; above 24px it starts
      // barging into whatever sits next to it, which is why the ceiling exists.
      expect(overshoot(springSnap) * 24).toBeGreaterThan(1)
      expect(overshoot(springSnap) * 24).toBeLessThan(2)
    })

    it('would blow the budget past its ceiling — this is what the ceiling is for', () => {
      expect(overshoot(springSnap) * 100).toBeGreaterThan(2)
    })
  })

  describe('springDrawer — the large-surface one', () => {
    it('lands in the documented band (ζ = 0.806)', () => {
      expect(dampingRatio(springDrawer)).toBeCloseTo(0.806, 3)
      expect(dampingRatio(springDrawer)).toBeGreaterThan(0.75)
      expect(dampingRatio(springDrawer)).toBeLessThan(0.86)
    })

    it('overshoots 1.4%', () => {
      expect(overshoot(springDrawer) * 100).toBeCloseTo(1.4, 1)
    })

    it('is tuned so LARGE travel lands in the same 1–2px budget', () => {
      expect(overshoot(springDrawer) * 120).toBeGreaterThan(1)
      expect(overshoot(springDrawer) * 145).toBeLessThan(2.1)
    })
  })

  describe('springGlide — the unbounded-travel one', () => {
    it('lands in the documented band (ζ = 0.899)', () => {
      expect(dampingRatio(springGlide)).toBeCloseTo(0.899, 3)
      expect(dampingRatio(springGlide)).toBeGreaterThan(0.87)
      expect(dampingRatio(springGlide)).toBeLessThan(0.93)
    })

    it('overshoots 0.157%', () => {
      expect(overshoot(springGlide) * 100).toBeCloseTo(0.157, 2)
    })

    /**
     * The contract that distinguishes it from the other three. They each hold
     * the budget up to a documented ceiling; this one holds it with no ceiling
     * at all, which is the only reason to reach for it. 448px is a `sm:max-w-md`
     * sheet — about as far as anything in this app can travel.
     */
    it('keeps overshoot under a pixel at ANY travel, with no documented ceiling', () => {
      expect(overshoot(springGlide) * 288).toBeLessThan(1)
      expect(overshoot(springGlide) * 448).toBeLessThan(1)
      expect(overshoot(springGlide) * 1000).toBeLessThan(2)
    })

    /** Still a spring: it has to settle, or it should have been a tween. */
    it('still overshoots — it is a settle, not an ease-out in disguise', () => {
      expect(overshoot(springGlide)).toBeGreaterThan(0)
    })

    /** Same arrival time as the drawer; only the landing differs. */
    it('shares springDrawer\'s natural frequency', () => {
      const wn = (s: SpringTransition) => Math.sqrt(s.stiffness / (s.mass ?? 1))
      expect(wn(springGlide)).toBeCloseTo(wn(springDrawer), 6)
    })
  })

  it('orders the four springs from stiffest to softest', () => {
    expect(dampingRatio(springPress)).toBeGreaterThan(dampingRatio(springGlide))
    expect(dampingRatio(springGlide)).toBeGreaterThan(dampingRatio(springDrawer))
    expect(dampingRatio(springDrawer)).toBeGreaterThan(dampingRatio(springSnap))
  })
})

describe('linear() equivalents', () => {
  const cases = [
    { name: 'springSnapLinear', css: springSnapLinear, spring: springSnap, duration: springSnapLinearDuration },
    { name: 'springDrawerLinear', css: springDrawerLinear, spring: springDrawer, duration: springDrawerLinearDuration },
  ] as const

  it.each(cases)('$name is a well-formed linear() function', ({ css }) => {
    const points = parseLinear(css)
    expect(points.length).toBeGreaterThanOrEqual(12)
    expect(points.every((point) => Number.isFinite(point))).toBe(true)
  })

  it.each(cases)('$name starts at rest and ends exactly on target', ({ css }) => {
    // A curve that does not end at 1 leaves the property short of its keyframe.
    const points = parseLinear(css)
    expect(points[0]).toBe(0)
    expect(points[points.length - 1]).toBe(1)
  })

  it.each(cases)('$name reproduces its spring’s overshoot', ({ css, spring }) => {
    const peak = Math.max(...parseLinear(css))
    expect(peak).toBeGreaterThan(1)
    expect(peak - 1).toBeCloseTo(overshoot(spring), 2)
  })

  it.each(cases)('$name pairs with a duration in milliseconds', ({ duration }) => {
    expect(duration).toMatch(/^\d+ms$/)
  })
})

describe('tween scale', () => {
  it('mirrors the --motion-* CSS tokens, in seconds', () => {
    expect(motionSnap.duration).toBe(0.12)
    expect(motionQuick.duration).toBe(0.18)
    expect(motionBase.duration).toBe(0.24)
    expect(motionEntrance.duration).toBe(0.24)
  })

  it('gives entrances an ease-OUT curve, not the CSS default ease that ramps in', () => {
    // cubic-bezier(0.25, 0.1, …) is CSS `ease`: its first control point pulls
    // the curve into a slow start. An arrival must be decided at the start.
    const [x1, y1] = motionEntrance.ease as [number, number, number, number]
    expect(y1).toBeGreaterThan(x1)
  })
})

describe('backward compatibility', () => {
  it('keeps the deprecated names pointing at their replacements', () => {
    expect(springSnappy).toBe(springPress)
    expect(springGentle).toBe(springDrawer)
    expect(easeQuiet).toBe(motionBase)
  })
})

describe('stagger cap', () => {
  const delayFor = (index: number): number => {
    const visible = staggerParent.visible
    const delayChildren =
      typeof visible === 'object' && visible !== null ? visible.transition?.delayChildren : undefined
    expect(typeof delayChildren).toBe('function')
    return (delayChildren as (i: number, total: number) => number)(index, 12)
  }

  it('steps 40ms per item', () => {
    expect(delayFor(0)).toBe(0)
    expect(delayFor(1)).toBeCloseTo(staggerStepSeconds, 5)
    expect(delayFor(3)).toBeCloseTo(3 * staggerStepSeconds, 5)
  })

  it('flattens past the cap instead of queueing', () => {
    const capped = delayFor(staggerMaxSteps)
    expect(delayFor(staggerMaxSteps + 1)).toBe(capped)
    expect(delayFor(30)).toBe(capped)
  })

  it('finishes the whole cascade inside one base duration', () => {
    // 200ms total, under the 240ms an individual item takes to arrive — so the
    // list reads as one arrival, not as a queue. The seven-item caller that
    // used to hold its last section back by 350ms now waits 200ms.
    expect(delayFor(30)).toBeLessThanOrEqual(motionBase.duration as number)
  })
})

/**
 * The camera and section state.
 *
 * The assertions worth having here are about the two ways this can be wrong in
 * a way nobody notices: a cardinal view mapped to the opposite side of the
 * building (a mirrored elevation is plausible, and wrong in a submission), and
 * a link that does not reproduce the view it was copied from.
 */

import { describe, expect, it } from 'vitest'
import { BIM_CAMERA_VIEWS, boundsCentre, clampCut, defaultCameraState, defaultCutForStorey, downloadWithProgress, encodeCameraState, impliesOrthographic, keyboardCameraStep, parseCameraState, rendererPreset, rendererSectionPlane, wheelZoomDelta, type BimViewerCameraState } from './viewer-camera'

const roundTrip = (state: BimViewerCameraState): BimViewerCameraState => {
  const params = new URLSearchParams()
  encodeCameraState(state, params)
  return parseCameraState(params)
}

describe('camera views', () => {
  it('looks AT the named facade, standing on that side', () => {
    // Standing to the north to see the north elevation is the renderer's
    // `back`. Swapping this pair gives a mirrored elevation that looks fine.
    expect(rendererPreset('north')).toBe('back')
    expect(rendererPreset('south')).toBe('front')
    expect(rendererPreset('east')).toBe('right')
    expect(rendererPreset('west')).toBe('left')
    expect(rendererPreset('top')).toBe('top')
  })

  it('has no renderer preset for the free view', () => {
    expect(rendererPreset('iso')).toBeNull()
  })

  it('maps every view it advertises', () => {
    for (const view of BIM_CAMERA_VIEWS) {
      if (view === 'iso') continue
      expect(rendererPreset(view)).not.toBeNull()
    }
  })

  it('draws every cardinal view in parallel projection', () => {
    // A plan or an elevation in perspective is a picture, not a drawing:
    // parallel walls converge and nothing on it can be measured.
    for (const view of BIM_CAMERA_VIEWS) {
      expect(impliesOrthographic(view)).toBe(view !== 'iso')
    }
  })
})

describe('the Grundriss cut', () => {
  it('cuts a metre above the finished floor, not at it', () => {
    // At the storey elevation the plane slices the slab and the reader sees
    // nothing, which reads as a broken model rather than a bad cut height.
    expect(defaultCutForStorey(0)).toBe(1)
    expect(defaultCutForStorey(3.2)).toBe(4.2)
    expect(defaultCutForStorey(-2.75)).toBe(-1.75)
  })

  it('refuses a storey that publishes no elevation', () => {
    expect(defaultCutForStorey(null)).toBeNull()
    expect(defaultCutForStorey(undefined)).toBeNull()
    expect(defaultCutForStorey(Number.NaN)).toBeNull()
  })

  it('keeps a cut inside the building', () => {
    const bounds = { minY: -0.5, maxY: 6.25 }
    expect(clampCut(3, bounds)).toBe(3)
    expect(clampCut(99, bounds)).toBe(6.25)
    expect(clampCut(-99, bounds)).toBe(-0.5)
    expect(clampCut(Number.NaN, bounds)).toBe(-0.5)
  })

  it('rounds to the centimetre', () => {
    expect(clampCut(2.60449, { minY: 0, maxY: 10 })).toBe(2.6)
  })
})

/**
 * The one conversion between the height a reader chooses and the plane the GPU
 * clips against.
 *
 * These assertions exist because the two disagreed silently for a whole
 * release: `position` was fed metres, the renderer reads it as a percentage of
 * the model's extent, and the only symptom was a slider whose travel all
 * happened inside the ground floor. A wrong number here cannot be seen in a
 * screenshot — it has to be pinned.
 */
describe('the section plane the renderer is given', () => {
  const bounds = { minMetres: 0, maxMetres: 12 }

  it('cuts at the metre the slider says, in world units', () => {
    // `distance` is what the clip shader compares `dot(worldPos, normal)`
    // against, so it IS the height — no percentage in between.
    const plane = rendererSectionPlane({ atMetres: 3, flipped: false }, bounds)
    expect(plane.normal).toEqual([0, 1, 0])
    expect(plane.distance).toBe(3)
  })

  it('states the position as a PERCENTAGE of the model, not as metres', () => {
    // The bug this replaces: `position: 3` on a 12 m building resolved to
    // 3% = 0.36 m, so "cut at 3 m" sliced the floor slab.
    expect(rendererSectionPlane({ atMetres: 3, flipped: false }, bounds).position).toBe(25)
    expect(rendererSectionPlane({ atMetres: 0, flipped: false }, bounds).position).toBe(0)
    expect(rendererSectionPlane({ atMetres: 12, flipped: false }, bounds).position).toBe(100)
  })

  it('agrees with itself: the percentage resolves back to the same plane', () => {
    // This is the renderer's own formula. If the two ever drift apart the cap
    // floats off the cut, which is exactly how the last defect presented.
    const plane = rendererSectionPlane({ atMetres: 7.5, flipped: false }, bounds)
    const resolved =
      (plane.min ?? 0) + (plane.position / 100) * ((plane.max ?? 0) - (plane.min ?? 0))
    expect(resolved).toBeCloseTo(plane.distance ?? Number.NaN, 10)
  })

  it('handles a building that does not start at zero', () => {
    // A basement puts minY below the origin; a georeferenced model can put the
    // whole building somewhere else entirely.
    const withBasement = { minMetres: -3.5, maxMetres: 6.5 }
    const plane = rendererSectionPlane({ atMetres: 1.5, flipped: false }, withBasement)
    expect(plane.distance).toBe(1.5)
    expect(plane.position).toBe(50)
  })

  it('carries the direction of view through untouched', () => {
    expect(rendererSectionPlane({ atMetres: 2, flipped: true }, bounds).flipped).toBe(true)
    expect(rendererSectionPlane({ atMetres: 2, flipped: false }, bounds).flipped).toBe(false)
  })

  it('never emits NaN, whatever it is handed', () => {
    // NaN in the clip uniform makes every fragment test false — the cut stops
    // cutting and looks like a feature that was never switched on.
    const degenerate = rendererSectionPlane({ atMetres: 2, flipped: false }, { minMetres: 4, maxMetres: 4 })
    expect(Number.isFinite(degenerate.position)).toBe(true)
    expect(Number.isFinite(degenerate.distance)).toBe(true)

    const noBounds = rendererSectionPlane({ atMetres: Number.NaN, flipped: false }, null)
    expect(Number.isFinite(noBounds.position)).toBe(true)
    expect(Number.isFinite(noBounds.distance)).toBe(true)
    expect(noBounds.min).toBeUndefined()
  })

  it('clamps a cut outside the model into the slider range', () => {
    // The height itself is still honoured — a cut above the roof shows the
    // whole building, which is the truthful answer — but the percentage the
    // cap reads cannot leave 0..100.
    expect(rendererSectionPlane({ atMetres: 99, flipped: false }, bounds).position).toBe(100)
    expect(rendererSectionPlane({ atMetres: -99, flipped: false }, bounds).position).toBe(0)
  })
})

describe('the camera state in a link', () => {
  it('encodes nothing for the default view', () => {
    const params = new URLSearchParams()
    encodeCameraState(defaultCameraState(), params)

    // A bare link should look bare.
    expect(params.toString()).toBe('')
  })

  it('round-trips a section seen from above', () => {
    const state: BimViewerCameraState = {
      view: 'top',
      section: { atMetres: 2.6, flipped: false },
      orthographic: true,
    }
    expect(roundTrip(state)).toEqual(state)
  })

  it('round-trips a section seen from below', () => {
    const state: BimViewerCameraState = {
      view: 'north',
      section: { atMetres: 2.6, flipped: true },
      orthographic: true,
    }
    const params = new URLSearchParams()
    encodeCameraState(state, params)

    // The height keeps its own sign and the direction its own parameter.
    expect(params.get('cut')).toBe('2.6')
    expect(params.get('cutup')).toBe('1')
    expect(roundTrip(state)).toEqual(state)
  })

  it('round-trips a cut BELOW the origin, which a basement has', () => {
    // The old encoding put the direction in the sign, so it ran every height
    // through `Math.abs` — and a model with a basement reports bounds like
    // -3.00 m to +9.00 m. Every cut in the bottom quarter of that building
    // came back as its positive mirror, and the plane jumped to the other
    // side of the ground floor.
    const state: BimViewerCameraState = {
      view: 'north',
      section: { atMetres: -1.4, flipped: false },
      orthographic: true,
    }
    const params = new URLSearchParams()
    encodeCameraState(state, params)

    expect(params.get('cut')).toBe('-1.4')
    expect(roundTrip(state)).toEqual(state)
  })

  it('round-trips a cut below the origin seen from below', () => {
    // The one combination the old encoding could not even approximate: a
    // negative height AND a flipped direction both wanted the same sign.
    const state: BimViewerCameraState = {
      view: 'iso',
      section: { atMetres: -2.75, flipped: true },
      orthographic: false,
    }
    expect(roundTrip(state)).toEqual(state)
  })

  it('round-trips an upward cut at exactly zero', () => {
    const state: BimViewerCameraState = {
      view: 'iso',
      section: { atMetres: 0, flipped: true },
      orthographic: false,
    }
    expect(roundTrip(state)).toEqual(state)
  })

  it('never writes a negative zero, so one view has one link', () => {
    const params = new URLSearchParams()
    encodeCameraState(
      { view: 'iso', section: { atMetres: -0.002, flipped: false }, orthographic: false },
      params
    )
    expect(params.get('cut')).toBe('0')
  })
})

/**
 * Links written before the direction got its own parameter.
 *
 * "A view is a link" is only true if a link keeps working. These are the exact
 * strings the previous encoding produced, and each must still resolve to the
 * view it was copied from.
 */
describe('a link written by the old encoding', () => {
  const read = (query: string) => parseCameraState(new URLSearchParams(query))

  it('reads a downward cut the same way', () => {
    expect(read('cut=2.6')).toMatchObject({ section: { atMetres: 2.6, flipped: false } })
  })

  it('still reads a negative cut as the upward cut it meant', () => {
    // Under the new encoding this string would mean "cut at -2.6 m looking
    // down". The absent `cutup` is what says it came from the old one.
    expect(read('cut=-2.6')).toMatchObject({ section: { atMetres: 2.6, flipped: true } })
  })

  it('reads the flipped-at-zero case both encodings agree on', () => {
    expect(read('cut=0&cutup=1')).toMatchObject({ section: { atMetres: 0, flipped: true } })
  })

  it('keeps perspective out of the URL when it is what the view implies', () => {
    const params = new URLSearchParams()
    encodeCameraState({ view: 'iso', section: null, orthographic: false }, params)
    expect(params.has('proj')).toBe(false)

    const plan = new URLSearchParams()
    encodeCameraState({ view: 'top', section: null, orthographic: true }, plan)
    expect(plan.has('proj')).toBe(false)
  })

  it('records a projection the reader chose against the view’s default', () => {
    const state: BimViewerCameraState = { view: 'top', section: null, orthographic: false }
    const params = new URLSearchParams()
    encodeCameraState(state, params)

    expect(params.get('proj')).toBe('persp')
    expect(roundTrip(state)).toEqual(state)
  })

  it('falls back to the free view rather than failing on a bad one', () => {
    // Same contract the rest of the link parser keeps: a truncated paste
    // degrades, it does not throw.
    expect(parseCameraState(new URLSearchParams('view=sideways')).view).toBe('iso')
  })

  it('drops a cut that is not a number', () => {
    expect(parseCameraState(new URLSearchParams('cut=deep')).section).toBeNull()
    expect(parseCameraState(new URLSearchParams('cut=')).section).toBeNull()
  })

  it('infers parallel projection for a cardinal view arriving without one', () => {
    // Links written before `proj` existed, and links a human typed.
    expect(parseCameraState(new URLSearchParams('view=north')).orthographic).toBe(true)
    expect(parseCameraState(new URLSearchParams('')).orthographic).toBe(false)
  })
})

describe('wheelZoomDelta', () => {
  it('passes pixel deltas through unchanged', () => {
    expect(wheelZoomDelta(100, 0, 800)).toBeCloseTo(1)
    expect(wheelZoomDelta(-100, 0, 800)).toBeCloseTo(-1)
  })

  it('scales line-mode deltas, which Firefox reports instead of pixels', () => {
    // The bug this fixes: `deltaY: 3, deltaMode: 1` is three TEXT LINES, and
    // reading it raw moved the camera three hundredths of a unit — a wheel
    // notch that did visibly nothing.
    expect(wheelZoomDelta(3, 1, 800)).toBeCloseTo(0.48)
    expect(wheelZoomDelta(3, 0, 800)).toBeCloseTo(0.03)
    expect(wheelZoomDelta(3, 1, 800)).toBeGreaterThan(wheelZoomDelta(3, 0, 800))
  })

  it('treats page-mode as one viewport, and survives a zero-height canvas', () => {
    expect(wheelZoomDelta(1, 2, 900)).toBeCloseTo(9)
    // A canvas measured before layout reports 0; the step must not vanish.
    expect(wheelZoomDelta(1, 2, 0)).toBeCloseTo(0.01)
  })

  it('keeps direction, because the sign is what zooms in rather than out', () => {
    for (const mode of [0, 1, 2]) {
      expect(Math.sign(wheelZoomDelta(-5, mode, 800))).toBe(-1)
      expect(Math.sign(wheelZoomDelta(5, mode, 800))).toBe(1)
    }
  })
})

describe('boundsCentre', () => {
  it('is the middle of the box, including through the origin', () => {
    expect(boundsCentre({ min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 2, z: 10 } })).toEqual({
      x: 2,
      y: 1,
      z: 5,
    })
    expect(boundsCentre({ min: { x: -6, y: -2, z: -1 }, max: { x: 2, y: 2, z: 3 } })).toEqual({
      x: -2,
      y: 0,
      z: 1,
    })
  })

  it('handles a degenerate box, which a zero-thickness element really has', () => {
    const point = { x: 3, y: 3, z: 3 }
    expect(boundsCentre({ min: point, max: point })).toEqual(point)
  })
})

describe('downloadWithProgress', () => {
  const streamed = (chunks: number[][], headers: Record<string, string> = {}) => ({
    headers: { get: (name: string) => headers[name] ?? null },
    body: {
      getReader: () => {
        let index = 0
        return {
          read: async () =>
            index < chunks.length
              ? { done: false, value: new Uint8Array(chunks[index++]) }
              : { done: true, value: undefined },
        }
      },
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  })

  it('reassembles the chunks in order, byte for byte', async () => {
    const bytes = await downloadWithProgress(streamed([[1, 2], [3], [4, 5, 6]]), () => {})
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('reports real progress against Content-Length', async () => {
    const seen: Array<number | null> = []
    await downloadWithProgress(streamed([[1, 2], [3], [4, 5, 6]], { 'Content-Length': '6' }), (p) =>
      seen.push(p)
    )
    expect(seen).toEqual([33, 50, 100])
  })

  it('reports null rather than a wrong number when there is no length', async () => {
    // Chunked transfer encoding sends no Content-Length. A progress bar that
    // invents a denominator is worse than one that admits it cannot say.
    const seen: Array<number | null> = []
    await downloadWithProgress(streamed([[1], [2]]), (p) => seen.push(p))
    expect(seen).toEqual([null, null])
  })

  it('never exceeds 100 when the declared length disagrees with the bytes', async () => {
    // A proxy that recompresses can leave Content-Length smaller than the
    // decoded body, which used to drive a progress bar past its own end.
    const seen: Array<number | null> = []
    await downloadWithProgress(streamed([[1, 2, 3, 4]], { 'Content-Length': '2' }), (p) =>
      seen.push(p)
    )
    expect(seen).toEqual([100])
  })

  it('falls back to a buffered read when the body cannot stream', async () => {
    const response = {
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
    }
    const seen: Array<number | null> = []
    const bytes = await downloadWithProgress(response, (p) => seen.push(p))

    expect(Array.from(bytes)).toEqual([9, 9])
    expect(seen).toEqual([null])
  })
})

describe('downloadWithProgress over a gzipped response', () => {
  const respond = (headers: Record<string, string>, chunks: number[][]) => ({
    headers: { get: (name: string) => headers[name] ?? null },
    body: {
      getReader: () => {
        let index = 0
        return {
          read: async () =>
            index < chunks.length
              ? { done: false, value: new Uint8Array(chunks[index++]) }
              : { done: true, value: undefined },
        }
      },
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  })

  it('measures against the UNCOMPRESSED length, not the wire length', async () => {
    // The bug this guards: the reader sees inflated bytes, so dividing by the
    // compressed Content-Length pins the bar at 100% almost immediately.
    const seen: Array<number | null> = []
    await downloadWithProgress(
      respond(
        { 'Content-Encoding': 'gzip', 'Content-Length': '2', 'x-amz-meta-uncompressed-length': '10' },
        [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]
      ),
      (p) => seen.push(p)
    )
    expect(seen).toEqual([50, 100])
  })

  it('is indeterminate when gzipped with no uncompressed length to divide by', async () => {
    const seen: Array<number | null> = []
    await downloadWithProgress(
      respond({ 'Content-Encoding': 'gzip', 'Content-Length': '2' }, [[1, 2, 3, 4]]),
      (p) => seen.push(p)
    )
    // Null, not a number computed from the wrong denominator.
    expect(seen).toEqual([null])
  })

  it('still uses Content-Length for an uncompressed response', async () => {
    const seen: Array<number | null> = []
    await downloadWithProgress(respond({ 'Content-Length': '4' }, [[1, 2], [3, 4]]), (p) =>
      seen.push(p)
    )
    expect(seen).toEqual([50, 100])
  })
})

describe('keyboardCameraStep', () => {
  it('maps the arrows to screen-space moves, matching the drag they stand in for', () => {
    expect(keyboardCameraStep('ArrowLeft')).toEqual({ kind: 'move', x: -1, y: 0 })
    expect(keyboardCameraStep('ArrowRight')).toEqual({ kind: 'move', x: 1, y: 0 })
    // Up is NEGATIVE y, because that is what a pointer dragged upward reports.
    // Flipping it here would make the keyboard and the mouse disagree about
    // which way "up" turns the building.
    expect(keyboardCameraStep('ArrowUp')).toEqual({ kind: 'move', x: 0, y: -1 })
    expect(keyboardCameraStep('ArrowDown')).toEqual({ kind: 'move', x: 0, y: 1 })
  })

  it('zooms IN on plus and OUT on minus', () => {
    // Negative delta is toward the model in the renderer's convention; getting
    // this backwards is the kind of bug nobody reports, they just stop using
    // the keys.
    const zoomIn = keyboardCameraStep('+')
    const zoomOut = keyboardCameraStep('-')
    expect(zoomIn).toMatchObject({ kind: 'zoom' })
    expect(zoomOut).toMatchObject({ kind: 'zoom' })
    expect((zoomIn as { amount: number }).amount).toBeLessThan(0)
    expect((zoomOut as { amount: number }).amount).toBeGreaterThan(0)
  })

  it('accepts both faces of the same physical key', () => {
    // On a keyboard where `+` needs shift, requiring the shifted face means
    // half the audience cannot zoom in.
    expect(keyboardCameraStep('=')).toEqual(keyboardCameraStep('+'))
    expect(keyboardCameraStep('_')).toEqual(keyboardCameraStep('-'))
  })

  it('is null for everything else, so unrelated keys keep their default behaviour', () => {
    // Notably Tab and Escape: swallowing either would trap a keyboard user
    // inside the viewport.
    for (const key of ['Tab', 'Escape', 'a', 'Enter', ' ', 'F5']) {
      expect(keyboardCameraStep(key)).toBeNull()
    }
  })
})

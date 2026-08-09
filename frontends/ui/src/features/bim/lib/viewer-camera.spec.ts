/**
 * The camera and section state.
 *
 * The assertions worth having here are about the two ways this can be wrong in
 * a way nobody notices: a cardinal view mapped to the opposite side of the
 * building (a mirrored elevation is plausible, and wrong in a submission), and
 * a link that does not reproduce the view it was copied from.
 */

import { describe, expect, it } from 'vitest'
import {
  BIM_CAMERA_VIEWS,
  clampCut,
  defaultCameraState,
  defaultCutForStorey,
  encodeCameraState,
  impliesOrthographic,
  parseCameraState,
  rendererPreset,
  type BimViewerCameraState,
} from './viewer-camera'

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
    // The sign carries the direction; a second `cutUp` parameter could
    // disagree with the height and there would be no way to say which won.
    const state: BimViewerCameraState = {
      view: 'north',
      section: { atMetres: 2.6, flipped: true },
      orthographic: true,
    }
    const params = new URLSearchParams()
    encodeCameraState(state, params)

    expect(params.get('cut')).toBe('-2.6')
    expect(roundTrip(state)).toEqual(state)
  })

  it('round-trips an upward cut at exactly zero, which no sign can carry', () => {
    const state: BimViewerCameraState = {
      view: 'iso',
      section: { atMetres: 0, flipped: true },
      orthographic: false,
    }
    expect(roundTrip(state)).toEqual(state)
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

/**
 * The lighting is a design decision, so it is pinned like one.
 *
 * These assertions are not "the renderer works" — they are the handful of
 * relationships that stop a future tweak from quietly breaking the look:
 * the sun stays above the horizon and in front of the camera, the ground stays
 * darker than the sky so the building stands on something, and dark mode keeps
 * its rim light, which is the only thing separating a dark model from a dark
 * background.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  readViewerTheme,
  VIEWER_CLEAR_COLOR,
  viewerEnhancement,
  viewerEnhancementCompact,
  viewerEnvironment,
} from './viewer-scene'

/** Rough relative brightness — enough to order two bands of the same gradient. */
const luminance = (channels?: readonly number[]): number =>
  (channels ?? []).reduce((sum, value) => sum + value, 0)

describe('viewerEnvironment', () => {
  it('lights from above and in front, the way an elevation drawing assumes', () => {
    const [x, y, z] = viewerEnvironment('light').sunDirection ?? [0, 0, 0]
    expect(y).toBeGreaterThan(0.5) // high
    expect(x).toBeLessThan(0) // over the left shoulder
    expect(z).toBeGreaterThan(0) // toward the camera, so the near facade is lit
  })

  it('is not a sun at the zenith, which would flatten every vertical surface', () => {
    const [, y] = viewerEnvironment('light').sunDirection ?? [0, 1, 0]
    expect(y).toBeLessThan(0.95)
  })

  it.each(['light', 'dark'] as const)(
    'puts the ground darker than the horizon in %s, so the model stands on something',
    (theme) => {
      const sky = viewerEnvironment(theme).sky
      expect(luminance(sky?.ground)).toBeLessThan(luminance(sky?.horizon))
    }
  )

  it('brightens upward on paper and toward the horizon on charcoal', () => {
    // Not the same gradient inverted. On paper the light comes from above, so
    // the zenith is the brightest band and the model reads against a lit sky.
    // On charcoal that would put the darkest value directly behind the roof
    // and lose the silhouette, so dark mode keeps a lighter band AT the
    // horizon — a soft glow the building stands in front of.
    const light = viewerEnvironment('light').sky
    expect(luminance(light?.horizon)).toBeLessThan(luminance(light?.zenith))

    const dark = viewerEnvironment('dark').sky
    expect(luminance(dark?.zenith)).toBeLessThan(luminance(dark?.horizon))
  })

  it('keeps enough ambient that a north facade is still readable', () => {
    // A physically honest ambient leaves interiors black. This is a viewer:
    // an architect has to be able to see the thing they clicked.
    expect(viewerEnvironment('light').ambientIntensity ?? 0).toBeGreaterThan(0.3)
    expect(viewerEnvironment('dark').ambientIntensity ?? 0).toBeGreaterThan(0.3)
  })

  it('gives dark mode a stronger rim than light mode', () => {
    const dark = viewerEnvironment('dark').rimIntensity ?? 0
    const light = viewerEnvironment('light').rimIntensity ?? 0
    expect(dark).toBeGreaterThan(light)
  })

  it('draws the sky, rather than clearing to a flat fill', () => {
    expect(viewerEnvironment('light').skyEnabled).toBe(true)
  })
})

describe('VIEWER_CLEAR_COLOR', () => {
  it('is opaque in both themes — a translucent clear composites the page through the model', () => {
    expect(VIEWER_CLEAR_COLOR.light[3]).toBe(1)
    expect(VIEWER_CLEAR_COLOR.dark[3]).toBe(1)
  })

  it('is light on paper and dark on charcoal', () => {
    expect(VIEWER_CLEAR_COLOR.light[0]).toBeGreaterThan(0.8)
    expect(VIEWER_CLEAR_COLOR.dark[0]).toBeLessThan(0.2)
  })
})

describe('viewerEnhancement', () => {
  it('turns on the three passes that make geometry read as architecture', () => {
    const enhancement = viewerEnhancement()
    expect(enhancement.enabled).toBe(true)
    expect(enhancement.edgeContrast?.enabled).toBe(true)
    expect(enhancement.contactShading?.quality).toBe('high')
    expect(enhancement.separationLines?.enabled).toBe(true)
  })

  it('cheapens contact shading and drops separation lines for a card-sized viewport', () => {
    const compact = viewerEnhancementCompact()
    expect(compact.contactShading?.quality).toBe('low')
    expect(compact.separationLines?.enabled).toBe(false)
    expect(compact.edgeContrast?.enabled).toBe(true)
  })
})

describe('readViewerTheme', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark')
  })

  it('reads the theme class the page already carries', () => {
    expect(readViewerTheme()).toBe('light')
    document.documentElement.classList.add('dark')
    expect(readViewerTheme()).toBe('dark')
  })
})

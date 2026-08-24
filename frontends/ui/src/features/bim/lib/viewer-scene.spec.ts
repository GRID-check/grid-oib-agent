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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  observeViewerTheme,
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

/**
 * The observer runs against a stand-in rather than the real thing.
 *
 * happy-dom ships a `MutationObserver` that never delivers attribute records,
 * so observing `<html>` for real here would assert nothing while looking like
 * it asserted everything — the worst kind of green. The stand-in gives the
 * test the one control it needs: deliver a record, now. What is under test is
 * this module's own logic — that it observes the right node and attribute,
 * that it reports only an actual theme CHANGE, and that disconnecting stops it
 * — and none of that depends on the DOM implementation.
 */
describe('observeViewerTheme', () => {
  let deliver: (() => void) | null = null
  let observed: { target: unknown; options: MutationObserverInit } | null = null
  let disconnected = false

  class FakeObserver {
    constructor(private readonly callback: () => void) {
      deliver = () => this.callback()
    }
    observe(target: unknown, options: MutationObserverInit): void {
      observed = { target, options }
    }
    disconnect(): void {
      disconnected = true
      deliver = null
    }
  }

  beforeEach(() => {
    deliver = null
    observed = null
    disconnected = false
    vi.stubGlobal('MutationObserver', FakeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove('dark')
  })

  it('watches the class on the element the theme actually lives on', () => {
    observeViewerTheme(() => {})
    expect(observed?.target).toBe(document.documentElement)
    // Filtered, so the app's other classes do not wake the viewport.
    expect(observed?.options.attributeFilter).toEqual(['class'])
  })

  it('reports a switch that happens under an open viewport', () => {
    // The theme can be `system`, in which case this fires at sunset with
    // nobody touching anything. Reading it once at load left the model lit for
    // the wrong environment, with no control on screen to correct it.
    const seen: string[] = []
    observeViewerTheme((theme) => seen.push(theme))

    document.documentElement.classList.add('dark')
    deliver?.()
    expect(seen).toEqual(['dark'])

    document.documentElement.classList.remove('dark')
    deliver?.()
    expect(seen).toEqual(['dark', 'light'])
  })

  it('stays quiet when the class changed but the theme did not', () => {
    // The callback redraws the viewport. Every unrelated class the app writes
    // onto `<html>` would otherwise cost a frame.
    const seen: string[] = []
    observeViewerTheme((theme) => seen.push(theme))

    deliver?.()
    deliver?.()
    expect(seen).toEqual([])
  })

  it('stops watching when the viewport goes away', () => {
    const seen: string[] = []
    const stop = observeViewerTheme((theme) => seen.push(theme))
    stop()

    expect(disconnected).toBe(true)
    document.documentElement.classList.add('dark')
    expect(seen).toEqual([])
  })
})

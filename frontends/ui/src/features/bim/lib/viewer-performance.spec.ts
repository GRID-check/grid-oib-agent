/**
 * The speed/quality trades, and the one place they must not apply.
 *
 * These are cheap assertions on a small module, and they exist because the
 * failure they guard against is silent in both directions: culling that is
 * accidentally disabled costs frames nobody attributes to a config value, and
 * culling that is accidentally left ON during a capture puts holes in an image
 * somebody attaches to a Befund.
 */

import { describe, expect, it } from 'vitest'
import {
  captureFrameOptions,
  CONTRIBUTION_CULL,
  interactiveFrameOptions,
  screenshotFilename,
} from './viewer-performance'

describe('the interactive frame', () => {
  it('culls sub-pixel batches and simplifies distant ones', () => {
    const options = interactiveFrameOptions()
    expect(options.contributionCull?.pixelRadius).toBeGreaterThan(0)
    expect(options.lod?.screenPx).toBeGreaterThan(0)
  })

  it('never culls LESS while the camera is moving than at rest', () => {
    // The renderer clamps a lower interacting threshold up to the resting one,
    // so getting this backwards is silently ignored rather than reported —
    // which is exactly the kind of setting that stays wrong for a year.
    expect(CONTRIBUTION_CULL.interactingPixelRadius ?? 0).toBeGreaterThanOrEqual(
      CONTRIBUTION_CULL.pixelRadius
    )
  })

  it('keeps LOD far more conservative than the cull', () => {
    // A culled batch was invisible; a simplified one is visible if you look at
    // it. The thresholds must not be tuned as if they were the same decision.
    expect(interactiveFrameOptions().lod?.screenPx ?? 0).toBeGreaterThan(
      CONTRIBUTION_CULL.pixelRadius
    )
  })
})

describe('the frame behind a screenshot', () => {
  it('turns every shortcut off', () => {
    // The renderer documents ABSENT (not zero, not false) as the exhaustive
    // default for both, so this asserts on the key being undefined rather than
    // on a disabling value that would read as "configured off".
    const options = captureFrameOptions()
    expect(options.contributionCull).toBeUndefined()
    expect(options.lod).toBeUndefined()
  })

  it('rebuilds evicted geometry first', () => {
    // Without this a batch aged out under the residency budget is simply
    // missing from the PNG — a hole in the building, in an image someone
    // attaches to a finding.
    expect(captureFrameOptions().restoreEvictedForCapture).toBe(true)
  })

  it('tells the renderer this frame is neither mid-gesture nor mid-load', () => {
    // Both hints make the renderer shed work. Whatever the interactive loop
    // last believed, a capture is neither.
    expect(captureFrameOptions().isInteracting).toBe(false)
    expect(captureFrameOptions().isStreaming).toBe(false)
  })
})

describe('what a captured view is called', () => {
  const when = new Date(2026, 7, 11, 9, 5, 3)

  it('leads with the model, so the reader can find it by searching', () => {
    expect(screenshotFilename('Wohnhaus-Nord.ifc', when)).toBe('Wohnhaus-Nord-20260811-090503.png')
  })

  it('drops the IFC extension rather than burying it mid-name', () => {
    expect(screenshotFilename('haus.ifczip', when)).toContain('haus-')
    expect(screenshotFilename('haus.ifczip', when)).not.toContain('ifczip')
  })

  it('distinguishes four captures taken in one sitting', () => {
    // Seconds are in the stamp for exactly this: `model.png (3)` says nothing
    // about which angle it was.
    const first = screenshotFilename('a.ifc', new Date(2026, 7, 11, 9, 5, 3))
    const second = screenshotFilename('a.ifc', new Date(2026, 7, 11, 9, 5, 41))
    expect(first).not.toBe(second)
  })

  it('keeps letters a filesystem and a reader can both handle', () => {
    // German model names are normal here, and so are spaces and slashes.
    expect(screenshotFilename('Grundriss OG/Rev 2.ifc', when)).toBe(
      'Grundriss-OG-Rev-2-20260811-090503.png'
    )
    expect(screenshotFilename('Bürogebäude.ifc', when)).toContain('Bürogebäude')
  })

  it('still produces a name when the model has none', () => {
    expect(screenshotFilename(null, when)).toBe('modell-20260811-090503.png')
    expect(screenshotFilename('///.ifc', when)).toBe('modell-20260811-090503.png')
  })
})

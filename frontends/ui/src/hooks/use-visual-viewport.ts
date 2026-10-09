'use client'

import { useEffect } from 'react'

/**
 * The CSS variable the app shell sizes itself by while the on-screen keyboard
 * covers part of the screen: `h-[var(--visual-viewport-height,100dvh)]`.
 * Absent the rest of the time, so the shell falls back to `100dvh`.
 */
export const VISUAL_VIEWPORT_HEIGHT_VAR = '--visual-viewport-height'

/**
 * Below this much occlusion the visual viewport counts as the whole layout
 * viewport. Sub-pixel rounding differs between the two, and a variable that
 * flickers on and off by half a pixel is a reflow for nothing.
 */
const OCCLUSION_THRESHOLD_PX = 1

/** Pinch zoom also shrinks the visual viewport; that is not a keyboard. */
const ZOOM_EPSILON = 0.01

/**
 * Sizes the app shell to the part of the screen the keyboard leaves visible,
 * on browsers that do not do it themselves.
 *
 * `interactiveWidget: 'resizes-content'` (app/layout.tsx) makes Chromium shrink
 * the layout viewport when the keyboard opens, so `100dvh` already means "above
 * the keyboard" there. iOS Safari ignores that setting: the keyboard shrinks
 * only the VISUAL viewport, `100dvh` keeps the full screen, the composer sits
 * behind the keyboard, and Safari pans the whole document up to reveal the
 * focused field — the shell's own chrome half off-screen and the transcript at
 * a position nothing in our code chose.
 *
 * While the visual viewport is shorter than the layout viewport (and not
 * because of pinch zoom), this publishes its height as
 * {@link VISUAL_VIEWPORT_HEIGHT_VAR} on `<html>` and scrolls the document back
 * to the top, which cancels Safari's pan: the shell now fits above the keyboard
 * and nothing is left to reveal. When the keyboard closes the variable is
 * removed. On Chromium with `resizes-content` the two viewports shrink
 * together, so this never engages; on desktop they are equal; where
 * `visualViewport` does not exist it does nothing at all.
 *
 * Writes go straight to the DOM, coalesced to one per frame, with no React
 * state: the keyboard animates over ~250ms and fires a resize per frame, and a
 * re-render of the whole shell per frame would be the jank this removes. Mount
 * it ONCE, in the shell (`AppShellChrome`) — the variable is document-global.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const root = document.documentElement
    let frame = 0

    const apply = (): void => {
      frame = 0
      const layoutHeight = root.clientHeight
      const occluded =
        Math.abs(viewport.scale - 1) < ZOOM_EPSILON &&
        layoutHeight - viewport.height > OCCLUSION_THRESHOLD_PX
      if (!occluded) {
        root.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_VAR)
        return
      }
      root.style.setProperty(VISUAL_VIEWPORT_HEIGHT_VAR, `${viewport.height}px`)
      if (window.scrollY !== 0 || viewport.offsetTop !== 0) window.scrollTo(0, 0)
    }

    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(apply)
    }

    apply()
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    return () => {
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      if (frame !== 0) cancelAnimationFrame(frame)
      root.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_VAR)
    }
  }, [])
}

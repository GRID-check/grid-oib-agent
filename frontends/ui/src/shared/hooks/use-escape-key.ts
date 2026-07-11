'use client'

import { useEffect } from 'react'

/**
 * Runs `onEscape` when the user presses Escape, but only while `enabled`.
 *
 * Extracted from the app-sidebar drawer effect so every modal-like surface
 * (the docked side panels, the research panel) shares one correct
 * implementation: a single window `keydown` listener that is attached only
 * while the surface is open and removed on close/unmount. It therefore never
 * double-registers and is fully inert when `enabled` is `false`.
 *
 * Nested controls that own Escape (e.g. the session-rename input, which cancels
 * an edit on Escape, or a Radix dialog) call `preventDefault()`; we honour that
 * by ignoring already-handled events so the outer panel does not close out from
 * under them.
 *
 * SSR-safe: the listener is attached inside an effect, which never runs on the
 * server.
 */
export function useEscapeKey(enabled: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // A nested handler already dealt with this Escape — leave it alone.
      if (event.defaultPrevented) return
      onEscape()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, onEscape])
}

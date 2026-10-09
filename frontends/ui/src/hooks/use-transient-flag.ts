/**
 * Two flags that change on a clock, written once.
 *
 * `useTransientFlag` — "Kopiert" for a moment, then back. Every copy control in
 * the answer hand-rolled `setCopied(true); setTimeout(() => setCopied(false),
 * 1500)`, and none of them cleared the timer: a second click inside the window
 * was cut short by the first click's timeout (the check vanished 300ms after
 * the reader pressed again), and a control unmounted mid-window set state on
 * nothing. The timer is one per flag here, restarted on every raise and
 * cleared on unmount.
 *
 * `useDelayedFlag` — "busy", but only once the wait is long enough to notice.
 * A spinner that appears for 60ms and vanishes is a flicker the reader cannot
 * read and has to wonder about; below the Doherty threshold the honest
 * feedback for a click is the press itself. So a busy state is shown only once
 * it has lasted {@link BUSY_REVEAL_DELAY_MS}, and the fast path shows nothing
 * at all.
 *
 * These are HOLD times, not animation durations: how long a state stays on
 * screen to be read, which no `--motion-*` token describes.
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/** Long enough to read a one-word receipt ("Kopiert") without hunting for it. */
export const TRANSIENT_FLAG_MS = 1500

/** Below this a wait reads as instant, and a spinner would only flicker. */
export const BUSY_REVEAL_DELAY_MS = 150

/**
 * A boolean that turns itself off `durationMs` after the last `raise()`.
 * Raising again while on restarts the window rather than racing the old one.
 */
export function useTransientFlag(durationMs: number = TRANSIENT_FLAG_MS): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const timer = useRef<number | null>(null)

  const clear = useCallback((): void => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
  }, [])

  const raise = useCallback((): void => {
    clear()
    setOn(true)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setOn(false)
    }, durationMs)
  }, [clear, durationMs])

  useEffect(() => clear, [clear])

  return [on, raise]
}

/**
 * `active`, but only after it has held for `delayMs`; false again the moment
 * `active` is. For a busy indicator that should not flash on a fast answer.
 */
export function useDelayedFlag(active: boolean, delayMs: number = BUSY_REVEAL_DELAY_MS): boolean {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => setShown(true), delayMs)
    return () => {
      window.clearTimeout(timer)
      setShown(false)
    }
  }, [active, delayMs])

  return active && shown
}

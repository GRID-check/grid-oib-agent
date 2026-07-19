/**
 * useElapsedSeconds
 *
 * Whole seconds elapsed since `active` most recently became true. Ticks once a
 * second while active and resets to 0 when it goes inactive, so a status line
 * can surface a live "12s" during a slow response and set the user's
 * expectation that work is ongoing.
 *
 * The start instant is captured on activation (not on mount), so toggling
 * active restarts the count cleanly.
 */

'use client'

import { useEffect, useRef, useState } from 'react'

export const useElapsedSeconds = (active: boolean): number => {
  const [seconds, setSeconds] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      startRef.current = null
      setSeconds(0)
      return
    }
    startRef.current = Date.now()
    setSeconds(0)
    const id = setInterval(() => {
      if (startRef.current != null) {
        setSeconds(Math.floor((Date.now() - startRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [active])

  return seconds
}

/**
 * Compact elapsed label: `8s` under a minute, `1:05` at or above one minute.
 * Kept locale-agnostic (bare digits) — it's a lightweight progress cue, not a
 * clock time.
 */
export const formatElapsed = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

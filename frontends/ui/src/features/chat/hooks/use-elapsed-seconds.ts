/**
 * useElapsedSeconds
 *
 * Whole seconds elapsed while `active`, ticking once a second, so a status
 * line can surface a live "12s" during a slow response and set the user's
 * expectation that work is ongoing. 0 until it has been active; when it goes
 * inactive it FREEZES on its last figure rather than dropping to 0, so a
 * finished turn's header does not lose its timer in the frame it lands.
 *
 * The count runs from `since` when the caller has a start instant of its own
 * (a turn's question was sent at its message's timestamp), and otherwise from
 * the moment `active` became true. `since` is what keeps the figure continuous
 * across a remount: the live turn's status line is one element from the send
 * to the settle, but anything that remounts it (a list re-key, a restored live
 * turn) would otherwise start again at 0 in front of a reader who has been
 * watching it count.
 */

'use client'

import { useEffect, useState } from 'react'

/** A start instant as callers hold one: a `Date`, an ISO string, epoch ms. */
export type ElapsedSince = Date | string | number

const startOf = (since: ElapsedSince | undefined): number | null => {
  if (since === undefined) return null
  const ms = since instanceof Date ? since.getTime() : new Date(since).getTime()
  return Number.isFinite(ms) ? ms : null
}

const secondsSince = (start: number): number =>
  Math.max(0, Math.floor((Date.now() - start) / 1000))

export const useElapsedSeconds = (active: boolean, since?: ElapsedSince): number => {
  const sinceMs = startOf(since)
  // Seeded at mount, so a status line that mounts mid-turn shows the true
  // figure in its first paint rather than 0 for a second.
  const [seconds, setSeconds] = useState(() =>
    active && sinceMs !== null ? secondsSince(sinceMs) : 0
  )

  useEffect(() => {
    if (!active) return
    const start = sinceMs ?? Date.now()
    setSeconds(secondsSince(start))
    const id = setInterval(() => setSeconds(secondsSince(start)), 1000)
    return () => clearInterval(id)
  }, [active, sinceMs])

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

/**
 * useRunClock — „now", ticking once a second while a run is live.
 *
 * The block's elapsed pill is `elapsedMs(ledger, now)`: the ledger's own
 * `startedAt` against the clock, so a reload shows the same figure the reader
 * left, not a counter that restarted at zero (which is what
 * `useElapsedSeconds` does, correctly, for a turn that has no start instant of
 * its own).
 *
 * `null` until mount. `Date.now()` on the server and on the client's first pass
 * differ, and rendering the difference is a hydration mismatch — the same
 * reason `TimeAgo` renders the absolute time first. A terminal run needs no
 * clock at all (its end is on the ledger), so the caller renders its figure
 * from the first paint and only the live one waits a tick.
 */

'use client'

import { useEffect, useState } from 'react'

export function useRunClock(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

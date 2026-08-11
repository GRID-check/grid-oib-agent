'use client'

import { useEffect, useRef, useState } from 'react'
import { TransferRateEstimator } from '../lib/upload-progress'

/**
 * How often the transfer readout re-computes while something is in flight.
 *
 * A second is the resolution a person reads a countdown at, and it is also what
 * keeps the estimate honest when progress STOPS: without a tick of its own the
 * readout would freeze on the last number a progress event produced, which is
 * precisely the "it's stuck" impression the whole surface exists to avoid.
 */
const TICK_MS = 1_000

export interface TransferRate {
  /** Current speed, or `null` when there is not yet enough signal to say. */
  bytesPerSecond: number | null
  /** Seconds until the remaining bytes are sent, or `null` when unknowable. */
  etaSeconds: number | null
}

/**
 * Live transfer rate and ETA over a sliding window.
 *
 * The maths lives in {@link TransferRateEstimator} (pure, tested without a
 * clock); this hook only owns the sampling and the tick.
 */
export function useTransferRate(uploadedBytes: number, remainingBytes: number, active: boolean): TransferRate {
  const estimatorRef = useRef<TransferRateEstimator | null>(null)
  estimatorRef.current ??= new TransferRateEstimator()
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (!active) {
      estimatorRef.current?.reset()
      return
    }
    estimatorRef.current?.sample(uploadedBytes, Date.now())
  }, [uploadedBytes, active])

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => forceTick((n) => n + 1), TICK_MS)
    return () => clearInterval(timer)
  }, [active])

  const estimator = estimatorRef.current
  if (!active || !estimator) return { bytesPerSecond: null, etaSeconds: null }
  return {
    bytesPerSecond: estimator.bytesPerSecond(),
    etaSeconds: estimator.etaSeconds(remainingBytes),
  }
}

/**
 * Seconds since `startedAt`, re-read once a second while `active`.
 *
 * The counterpart to a percentage for a phase that has none: an indexing pass
 * cannot say how far along it is, but it can always say how long it has been
 * going, and a number that visibly moves is the difference between "working"
 * and "hung".
 */
export function useElapsedSeconds(startedAt: number | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active || startedAt === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active, startedAt])

  if (startedAt === null) return 0
  return Math.max(0, (now - startedAt) / 1000)
}

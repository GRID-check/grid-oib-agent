'use client'

/**
 * Watching freshly uploaded or re-indexed base documents until they finish.
 *
 * The backend ingests in the background, so an upload answers `pending` and
 * the corpus status has to be polled until each watched file reaches a
 * terminal state. This is that poll, as ONE loop:
 *
 * - A second upload while a tick is in flight joins the running loop instead
 *   of starting a second one beside it. Two loops used to share one watched
 *   set, and whichever finished first cleared it under the other.
 * - Every loop carries a generation. Unmounting, or starting over, bumps it, so
 *   a tick that was awaiting the status when that happened drops its result and
 *   schedules nothing. Clearing the timer alone missed exactly that tick, which
 *   then set state and armed a new timer after unmount.
 * - A watched file the status never lists is not "still working" forever. After
 *   {@link MISSING_AFTER_MS} it is reported as missing, so a rejected or lost
 *   upload ends the loop instead of spinning until the ceiling.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  KnowledgeBaseStatus,
  KnowledgeFile,
  KnowledgeFileState,
} from '@/lib/knowledge/service'

/** 3.5 s × 60 ≈ 3.5 minutes, then the loop stops and offers a refresh. */
export const POLL_INTERVAL_MS = 3_500
export const MAX_POLLS = 60
/** How long an accepted file may be absent from the status before it counts as missing. */
export const MISSING_AFTER_MS = 45_000

export type WatchItemPhase = 'working' | 'done' | 'missing'

export interface WatchItem {
  name: string
  phase: WatchItemPhase
  /** The file's lifecycle state once the status lists it. */
  state: KnowledgeFileState | null
}

/**
 * Where each watched file stands in `files`. Pure, so the loop and the render
 * read the same answer. `watched` maps a name to when watching it began.
 */
export function classifyWatched(
  files: readonly KnowledgeFile[],
  watched: ReadonlyMap<string, number>,
  now: number
): WatchItem[] {
  const byName = new Map(files.map((file) => [file.fileName, file]))
  return [...watched].map(([name, since]) => {
    const file = byName.get(name)
    if (file)
      return { name, phase: file.state === 'pending' ? 'working' : 'done', state: file.state }
    return { name, phase: now - since >= MISSING_AFTER_MS ? 'missing' : 'working', state: null }
  })
}

export interface IngestWatch {
  /** Watched files with their phase, in the order they were added. */
  items: WatchItem[]
  /** The loop hit {@link MAX_POLLS} with files still working. */
  timedOut: boolean
  /** Files that never appeared, from the last finished loop. */
  missing: string[]
  /** Add files to the watch and (re)start the single loop. */
  watch: (names: readonly string[]) => void
  /** Give the still-watched files a fresh window after a timeout. */
  rearm: () => void
  dismissMissing: () => void
}

export function useIngestWatch(
  fetchStatus: () => Promise<KnowledgeBaseStatus>,
  onStatus: (status: KnowledgeBaseStatus) => void,
  /** The latest status the caller holds, so the render can classify without waiting a tick. */
  files: readonly KnowledgeFile[]
): IngestWatch {
  const [watched, setWatched] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [timedOut, setTimedOut] = useState(false)
  const [missing, setMissing] = useState<string[]>([])
  const [now, setNow] = useState(() => Date.now())

  const watchedRef = useRef<ReadonlyMap<string, number>>(new Map())
  const generationRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchRef = useRef(fetchStatus)
  const onStatusRef = useRef(onStatus)
  useEffect(() => {
    fetchRef.current = fetchStatus
    onStatusRef.current = onStatus
  }, [fetchStatus, onStatus])

  const cancel = useCallback(() => {
    generationRef.current += 1
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  useEffect(() => cancel, [cancel])

  const setWatchedBoth = useCallback((next: ReadonlyMap<string, number>) => {
    watchedRef.current = next
    setWatched(next)
  }, [])

  const run = useCallback(() => {
    cancel()
    const generation = generationRef.current
    let polls = 0
    setTimedOut(false)

    const tick = async (): Promise<void> => {
      timerRef.current = null
      polls += 1
      let status: KnowledgeBaseStatus | null = null
      try {
        status = await fetchRef.current()
      } catch {
        // A transient failure: keep polling until the ceiling.
      }
      if (generation !== generationRef.current) return

      const at = Date.now()
      setNow(at)
      if (status) onStatusRef.current(status)

      // Without a status there is nothing to classify against; keep going.
      const items = status ? classifyWatched(status.files, watchedRef.current, at) : null
      if (items && !items.some((item) => item.phase === 'working')) {
        setMissing(items.filter((item) => item.phase === 'missing').map((item) => item.name))
        setWatchedBoth(new Map())
        return
      }
      if (polls >= MAX_POLLS) {
        // Keep the watched set so the caller can swap progress for a notice.
        setTimedOut(true)
        return
      }
      timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS)
    }

    timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS)
  }, [cancel, setWatchedBoth])

  const watch = useCallback(
    (names: readonly string[]) => {
      if (names.length === 0) return
      const at = Date.now()
      const next = new Map(watchedRef.current)
      for (const name of names) next.set(name, at)
      setWatchedBoth(next)
      setNow(at)
      setMissing((prev) => prev.filter((name) => !names.includes(name)))
      run()
    },
    [run, setWatchedBoth]
  )

  const rearm = useCallback(() => {
    if (watchedRef.current.size === 0) return
    const at = Date.now()
    setWatchedBoth(new Map([...watchedRef.current.keys()].map((name) => [name, at])))
    setNow(at)
    run()
  }, [run, setWatchedBoth])

  const dismissMissing = useCallback(() => setMissing([]), [])

  return {
    items: watched.size === 0 ? [] : classifyWatched(files, watched, now),
    timedOut,
    missing,
    watch,
    rearm,
    dismissMissing,
  }
}

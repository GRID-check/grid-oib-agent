'use client'

/**
 * ChunkReloadGuard
 *
 * During a rolling deploy, N frontend replicas (different build ids) briefly
 * serve traffic behind one load balancer with no session affinity. A client
 * that loaded HTML from an OLD pod can then request a JS/CSS chunk that a NEW
 * pod no longer serves -> `ChunkLoadError` / a failed dynamic import, i.e. a
 * broken page for the deploy window. This listens for that specific error and
 * reloads once to pick up the new build's HTML + matching chunks.
 *
 * Loop-safe: it reloads at most once per `MIN_RELOAD_GAP_MS` (a timestamp in
 * sessionStorage), and if sessionStorage is unavailable it skips the reload
 * rather than risk a loop (the user can refresh manually). Renders nothing.
 */

import { useEffect } from 'react'

const RELOAD_TS_KEY = 'grid:chunk-reload-ts'
const MIN_RELOAD_GAP_MS = 10_000

/** True for the transient chunk/dynamic-import load failures a rollout causes. */
export function isChunkLoadError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null | undefined
  const message = e?.message ?? ''
  return e?.name === 'ChunkLoadError' || /Loading (chunk|CSS chunk)|dynamically imported module/i.test(message)
}

export function ChunkReloadGuard(): null {
  useEffect(() => {
    const reloadOnce = (): void => {
      try {
        const last = Number(window.sessionStorage.getItem(RELOAD_TS_KEY) || '0')
        if (Date.now() - last < MIN_RELOAD_GAP_MS) return // reloaded very recently — don't loop
        window.sessionStorage.setItem(RELOAD_TS_KEY, String(Date.now()))
      } catch {
        return // no sessionStorage (private mode etc.) — skip rather than risk a loop
      }
      window.location.reload()
    }

    const onError = (event: ErrorEvent): void => {
      if (isChunkLoadError(event.error)) reloadOnce()
    }
    const onRejection = (event: PromiseRejectionEvent): void => {
      if (isChunkLoadError(event.reason)) reloadOnce()
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return null
}

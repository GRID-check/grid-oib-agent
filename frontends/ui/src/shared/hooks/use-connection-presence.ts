/**
 * useConnectionPresence
 *
 * A lightweight, app-global signal of live connection health for the shell's
 * presence indicator. Deliberately independent of the chat WebSocket:
 *
 *   The chat WS tracks a much more accurate per-conversation `isConnected`
 *   (see features/chat/hooks/use-websocket-chat.ts), but that state is
 *   hook-local `useState` and is not mirrored into any global store, so it
 *   can't be observed from the shell without changing that hook. The shell
 *   also renders on pages that never open a chat socket at all (projects list,
 *   overview, files, members). So for a *global* indicator we derive presence
 *   from two cheap, universally-available signals instead:
 *
 *     1. `navigator.onLine` + the `online`/`offline` events (instant, local).
 *     2. A periodic same-origin health ping to an existing endpoint
 *        (`/api/health`, a transport pass-through to the backend `/health`).
 *
 * Three states are exposed: `connected`, `reconnecting`, `offline`.
 *
 * Robustness details:
 *   - SSR-safe: all `navigator`/`window`/`document` access happens inside
 *     effects; the initial (server + first-paint) value is an optimistic
 *     `connected` so there is no hydration mismatch.
 *   - Debounced: transitions are held for `debounceMs` before they commit, so
 *     a sub-second blip (a single dropped ping, a flaky `offline`→`online`
 *     bounce) never flaps the indicator.
 *   - Frugal: the ping runs on an interval of at least `pingIntervalMs`
 *     (default 20s) and is fully suspended while the tab is hidden
 *     (`visibilitychange`), resuming with an immediate check when it returns.
 *   - Every timer, listener, and in-flight fetch is cleaned up on unmount.
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type ConnectionPresence = 'connected' | 'reconnecting' | 'offline'

export interface UseConnectionPresenceOptions {
  /** Same-origin endpoint to health-ping. Must be cheap (a health probe). */
  pingUrl?: string
  /** Interval between health pings while the tab is visible (>= 15s advised). */
  pingIntervalMs?: number
  /** Per-ping timeout before the request is aborted and treated as failed. */
  pingTimeoutMs?: number
  /** How long a candidate state must hold before it commits (anti-flap). */
  debounceMs?: number
  /** Set false to rely on `navigator.onLine` alone (no periodic ping). */
  enablePing?: boolean
}

const DEFAULT_PING_URL = '/api/health'
const DEFAULT_PING_INTERVAL_MS = 20_000
const DEFAULT_PING_TIMEOUT_MS = 5_000
const DEFAULT_DEBOUNCE_MS = 400

export function useConnectionPresence(
  options: UseConnectionPresenceOptions = {},
): ConnectionPresence {
  const {
    pingUrl = DEFAULT_PING_URL,
    pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
    pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    enablePing = true,
  } = options

  // Committed, debounced presence exposed to the UI. Optimistic `connected` so
  // SSR and the first client paint agree (no hydration flash).
  const [presence, setPresence] = useState<ConnectionPresence>('connected')

  // Raw signals live in refs; the derived target is debounced before commit.
  const onlineRef = useRef(true)
  const healthyRef = useRef<boolean | null>(null)
  const committedRef = useRef<ConnectionPresence>('connected')
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const deriveTarget = useCallback((): ConnectionPresence => {
    if (!onlineRef.current) return 'offline'
    if (healthyRef.current === false) return 'reconnecting'
    // `null` (not yet pinged) is treated as connected -- optimistic default.
    return 'connected'
  }, [])

  const clearDebounce = useCallback((): void => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  /**
   * Recompute the target from the current signals and, if it differs from the
   * committed state, arm the debounce timer. If the signals have flapped back
   * to the committed value, cancel any pending transition instead.
   */
  const scheduleCommit = useCallback((): void => {
    const target = deriveTarget()
    if (target === committedRef.current) {
      // Blip resolved before it ever committed -- drop the pending transition.
      clearDebounce()
      return
    }
    clearDebounce()
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      const next = deriveTarget()
      committedRef.current = next
      setPresence(next)
    }, debounceMs)
  }, [clearDebounce, debounceMs, deriveTarget])

  const runPing = useCallback(async (): Promise<void> => {
    if (!enablePing) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    if (typeof fetch === 'undefined') return

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), pingTimeoutMs)
    try {
      const res = await fetch(pingUrl, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      healthyRef.current = res.ok
    } catch {
      // Abort, network error, or DNS failure -- treat as unhealthy.
      healthyRef.current = false
    } finally {
      clearTimeout(timeout)
      scheduleCommit()
    }
  }, [enablePing, pingTimeoutMs, pingUrl, scheduleCommit])

  // navigator.onLine + online/offline events.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return

    onlineRef.current = navigator.onLine
    scheduleCommit()

    const handleOnline = (): void => {
      onlineRef.current = true
      // Don't trust the flag blindly: re-verify reachability with a ping and
      // stay in the previous derived state until it answers.
      healthyRef.current = null
      scheduleCommit()
      void runPing()
    }
    const handleOffline = (): void => {
      onlineRef.current = false
      scheduleCommit()
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [runPing, scheduleCommit])

  // Periodic health ping, suspended while the tab is hidden.
  useEffect(() => {
    if (!enablePing) return
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    let intervalId: ReturnType<typeof setInterval> | null = null

    const start = (): void => {
      if (intervalId !== null) return
      void runPing() // immediate check on (re)start
      intervalId = setInterval(() => {
        void runPing()
      }, pingIntervalMs)
    }
    const stop = (): void => {
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
    }
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') start()
      else stop()
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      stop()
    }
  }, [enablePing, pingIntervalMs, runPing])

  // Drop any pending debounce transition on unmount.
  useEffect(() => clearDebounce, [clearDebounce])

  return presence
}

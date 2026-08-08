'use client'

/**
 * Subscribe to live collaboration events, with the fallbacks that make the
 * feature correct when live delivery is unavailable (spec RT-3, RT-4).
 *
 * The contract for every consumer: **an event is a signal to re-read, not data to
 * apply.** These hooks therefore hand you a callback and a `connected` flag, and
 * deliberately hold no server state of their own.
 *
 * Three triggers, because any one of them can be the only one that fires:
 *   1. a live event (fast path);
 *   2. window focus / tab becoming visible (covers "was offline", "laptop slept",
 *      and every dropped event);
 *   3. a slow interval when the live channel is NOT connected (covers a missing
 *      cache tier, a proxy that eats SSE, a gated feature).
 */

import { useEffect, useRef, useState } from 'react'
import type { CollaborationEvent } from '@/lib/events/types'
import { subscribeToConnection, subscribeToEvents } from '../lib/event-hub'

/** Poll cadence while the live channel is down. Slow on purpose — it is a safety net. */
const DISCONNECTED_POLL_MS = 60_000

export interface UseLiveEventsOptions {
  /** Off when the feature is disabled, so a gated org opens no connection at all. */
  enabled?: boolean
  /** Called for every event. Keep it cheap; it runs on the shared connection. */
  onEvent?: (event: CollaborationEvent) => void
  /**
   * Called when the consumer should re-read from the server: on focus, and on the
   * fallback interval while disconnected.
   */
  onRefresh?: () => void
}

export interface UseLiveEventsResult {
  /** Whether the live channel is up. Consumers may show a subtle degraded hint. */
  connected: boolean
}

export function useLiveEvents(options: UseLiveEventsOptions = {}): UseLiveEventsResult {
  const { enabled = true, onEvent, onRefresh } = options
  const [connected, setConnected] = useState(false)

  // Latest callbacks without re-subscribing on every render: a consumer passing an
  // inline arrow would otherwise tear the shared connection down and back up on
  // each keystroke elsewhere in the tree.
  const onEventRef = useRef(onEvent)
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onEventRef.current = onEvent
    onRefreshRef.current = onRefresh
  }, [onEvent, onRefresh])

  useEffect(() => {
    if (!enabled) {
      setConnected(false)
      return
    }
    const unsubscribeEvents = subscribeToEvents((event) => onEventRef.current?.(event))
    const unsubscribeConnection = subscribeToConnection(setConnected)
    return () => {
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [enabled])

  // Focus / visibility refresh. This is the trigger that makes a dropped event a
  // latency problem instead of a correctness problem.
  useEffect(() => {
    if (!enabled) return
    const refresh = () => onRefreshRef.current?.()
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled])

  // Fallback polling ONLY while disconnected — with a healthy channel this costs
  // nothing, which is why the cadence can afford to be conservative.
  useEffect(() => {
    if (!enabled || connected) return
    const timer = setInterval(() => onRefreshRef.current?.(), DISCONNECTED_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, connected])

  return { connected }
}

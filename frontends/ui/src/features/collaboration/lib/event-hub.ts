/**
 * Browser-side event hub: ONE `EventSource` per tab, many listeners.
 *
 * Why a module-level singleton rather than a connection per hook: the inbox
 * badge, the inbox list and every open shared thread all want live updates. If
 * each opened its own `EventSource` a single tab would hold four or five server
 * connections, each with its own Redis subscriber on the server side. One
 * connection, fanned out locally, is the only sane shape.
 *
 * **This hub is an accelerator, never a source of truth** (spec RT-4). Every
 * listener is expected to respond to an event by RE-READING from the server, not
 * by trusting the payload. That is what makes the whole feature correct when the
 * connection is dead, the cache tier is down, or the user was offline — which is
 * also why there is no resume cursor here: reconnecting just means "fetch again".
 */

import { createRetryLadder } from '@/shared/utils/backoff'
import type { CollaborationEvent } from '@/lib/events/types'

export type { CollaborationEvent }

type Listener = (event: CollaborationEvent) => void

const listeners = new Set<Listener>()

let source: EventSource | null = null
let connected = false
const connectionListeners = new Set<(connected: boolean) => void>()

/**
 * Exponential backoff, capped and jittered — a server restart must not become a
 * stampede. The cap alone bounds the retry *rate*; the jitter is what stops
 * every tab dropped by the same pod from returning on an identical schedule.
 *
 * Unbounded on purpose, unlike the per-turn spectator stream: this connection
 * carries every collaboration event in the product, so giving up on it is worse
 * than waiting thirty seconds for it.
 *
 * `baseMs` is 2s rather than the 1s that was written here before, and the ladder
 * is unchanged by that: the old hand-rolled version incremented its counter
 * BEFORE reading the delay, so its first rung was already `1_000 * 2**1`. The
 * schedule is the same 2s, 4s, 8s … 30s; only the off-by-one is gone.
 */
const reconnect = createRetryLadder({ baseMs: 2_000, maxMs: 30_000 })

function setConnected(next: boolean): void {
  if (connected === next) return
  connected = next
  for (const listener of connectionListeners) {
    try {
      listener(next)
    } catch {
      // A listener throwing must not break the others.
    }
  }
}

function open(): void {
  if (source || typeof window === 'undefined') return

  source = new EventSource('/api/stream')

  source.onopen = () => {
    // The load-bearing reset: a connection that opened is evidence the route
    // works, so the next failure starts at the base step rather than inheriting
    // the ceiling from an outage the tab already rode out.
    reconnect.reset()
    setConnected(true)
  }

  source.onmessage = (message) => {
    // Envelope shape: { id, at, event }. Anything malformed is dropped — a bad
    // frame must never take the connection down, because the fallback path
    // (refetch) is what actually guarantees correctness.
    try {
      const parsed = JSON.parse(message.data) as { event?: CollaborationEvent }
      if (!parsed?.event?.kind) return
      for (const listener of listeners) {
        try {
          listener(parsed.event)
        } catch (error) {
          console.warn('[event-hub] listener threw:', error)
        }
      }
    } catch {
      // Ignore unparseable frames (heartbeat comments never reach onmessage).
    }
  }

  source.onerror = () => {
    // EventSource retries on its own, but only for transport errors; an auth
    // failure or a 403 from the feature gate closes it for good. Take control:
    // close, then reconnect with our own backoff, so a disabled feature settles
    // into "not connected" instead of hammering the route.
    setConnected(false)
    close()
    if (listeners.size === 0) return
    reconnect.schedule(open)
  }
}

function close(): void {
  // `cancel`, never `reset`: this is called from the error path too, and a
  // failure must not be allowed to look like evidence the connection works.
  reconnect.cancel()
  if (source) {
    source.close()
    source = null
  }
  setConnected(false)
}

/**
 * Register a listener, opening the shared connection on the first one and closing
 * it after the last unsubscribes. Returns the unsubscribe function.
 */
export function subscribeToEvents(listener: Listener): () => void {
  listeners.add(listener)
  if (listeners.size === 1) open()
  return () => {
    listeners.delete(listener)
    if (listeners.size !== 0) return
    close()
    // Reset on a DELIBERATE teardown (never inside `close()`, which the error
    // path also calls) so the next subscriber starts from a clean count rather
    // than inheriting the last one's. Belt and braces: `onopen` above is what
    // actually keeps a healthy tab off the ceiling.
    reconnect.reset()
  }
}

/** Observe transport health, so a consumer can switch to polling (spec RT-3). */
export function subscribeToConnection(listener: (connected: boolean) => void): () => void {
  connectionListeners.add(listener)
  listener(connected)
  return () => {
    connectionListeners.delete(listener)
  }
}

export function isConnected(): boolean {
  return connected
}

/** Test seam: drop all state between cases. */
export function __resetEventHub(): void {
  listeners.clear()
  connectionListeners.clear()
  close()
  reconnect.reset()
}

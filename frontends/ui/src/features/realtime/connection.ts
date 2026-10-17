/**
 * The tab's one live connection (ADR-0110): ONE `EventSource` carrying every
 * channel the tab has open, demultiplexed by `ch`, and one POST path up.
 *
 * Channels are ref-counted: two components in one document's room are one
 * channel on the wire. When the set of channels changes, the connection is
 * reopened with the new `?ch=` list, debounced so a page that mounts five
 * channels in one render reconnects once. A channel the server answers with
 * `revoked` or `unsupported` leaves the list until whoever joined it joins
 * again, so a reconnect never asks for it twice.
 *
 * Like the per-user hub (`features/collaboration/lib/event-hub.ts`) this is an
 * accelerator, never a source of truth: nothing a channel carries is state a
 * tab has to converge on, so a reconnect does not replay.
 *
 * A page that is hidden or offline (`adapters/api/page-lifecycle.ts`) tries
 * nothing: a phone that locked kills the stream, and a retry it cannot see
 * through only climbs the ladder. When the page is back the stream reopens at
 * once, from the first rung, instead of waiting out the rung it was on.
 *
 * Up, a message is either motion (a pointer, a scroll: the throttled lanes of
 * `useChannel`) or a claim (presence, a selection). The server spends them from
 * separate budgets. When it refuses motion (429), the channel's motion pauses
 * for the `Retry-After` instead of hammering on; claims go on regardless. Only
 * a `gone` goes out as `keepalive`, so it still leaves while the page unloads:
 * the browser bounds what keepalive requests may have in flight, and a stream
 * of pointers in that quota could crowd the one message that must arrive.
 */

import { browserPageLifecycle, isActive, type PageLifecycle } from '@/adapters/api/page-lifecycle'
import { createRetryLadder, type RetryLadder } from '@/shared/utils/backoff'
import {
  realtimeFrameSchema,
  realtimeStreamPath,
  REALTIME_SEND_PATH,
  type ChannelEvent,
  type RealtimeSelf,
} from '@/lib/realtime/types'

export type ChannelStatus = 'connecting' | 'live' | 'offline'

/** What a channel's joiner hears. */
export interface ChannelHandlers {
  onEvent(event: ChannelEvent): void
  /** Who the server takes this reader to be, on every (re)connect that carries the channel. */
  onWelcome?(self: RealtimeSelf): void
  /** The server dropped the channel: the reader may no longer be in it, or it does not exist. */
  onClosed?(reason: 'revoked' | 'unsupported'): void
  onStatus?(status: ChannelStatus): void
}

/** How a message goes up. */
export interface ChannelPostOptions {
  /** Motion: shed while the server refuses the channel's motion, and the first thing a refusal pauses. */
  motion?: boolean
}

/** What the send path answered, as far as backing off needs. */
export interface PostOutcome {
  status: number
  /** The `Retry-After`, in ms; 0 when there is none. */
  retryAfterMs: number
}

export interface RealtimeConnection {
  /** Join a channel. Returns the leave, which is idempotent. */
  join(ch: string, handlers: ChannelHandlers): () => void
  /**
   * Say something in a channel. Fire and forget: a refusal is dropped, the
   * next message is on its way. Motion refused with a 429 pauses the channel's
   * motion for the `Retry-After`; the latest motion asked for meanwhile is sent
   * once the pause ends, while the channel is still joined.
   */
  send(ch: string, msg: unknown, options?: ChannelPostOptions): void
  /** The status of one channel now. */
  status(ch: string): ChannelStatus
  /** Close everything: for tests. */
  dispose(): void
}

interface EventSourceLike {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  close(): void
}

export interface ConnectionOptions {
  createSource?: (url: string) => EventSourceLike
  /** Send one message. Its outcome, when it has one, is what the motion backoff reads. */
  post?: (path: string, body: string, init: { keepalive: boolean }) => Promise<PostOutcome | undefined> | void
  /** How long a change of the channel set waits for more before reconnecting. */
  debounceMs?: number
  ladder?: RetryLadder
  /** Whether the page is visible and online, and when it is again. The browser's by default. */
  lifecycle?: PageLifecycle
}

/** The longest a refusal pauses motion, whatever the header says. */
const MAX_MOTION_PAUSE_MS = 60_000
/** The shortest: a refusal without a usable `Retry-After` still backs off a moment. */
const MIN_MOTION_PAUSE_MS = 1_000

const retryAfterMs = (header: string | null) => {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0
}

const defaultPost = (path: string, body: string, { keepalive }: { keepalive: boolean }) => {
  if (typeof fetch !== 'function') return
  // One catch after the read, not beside it: a throw while reading the answer
  // is as much a lost post as a failed fetch, never an unhandled rejection.
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive })
    .then((response): PostOutcome => ({ status: response.status, retryAfterMs: retryAfterMs(response.headers.get('retry-after')) }))
    .catch(() => undefined)
}

/** A presence withdrawal: the one message that must leave even as the page unloads. */
const isGone = (msg: unknown) =>
  typeof msg === 'object' && msg !== null && (msg as { presence?: unknown }).presence === 'gone'

const defaultSource = (url: string): EventSourceLike | null =>
  typeof EventSource === 'undefined' ? null : (new EventSource(url) as unknown as EventSourceLike)

export function createRealtimeConnection({
  createSource,
  post = defaultPost,
  debounceMs = 250,
  ladder = createRetryLadder({ baseMs: 1_000, maxMs: 30_000 }),
  lifecycle = browserPageLifecycle(),
}: ConnectionOptions = {}): RealtimeConnection {
  const joined = new Map<string, Set<ChannelHandlers>>()
  /** Channels the server closed; not asked for again until joined anew. */
  const dropped = new Set<string>()
  let source: EventSourceLike | null = null
  /** The channels the open (or opening) source carries. */
  let carried = new Set<string>()
  let live = false
  let self: RealtimeSelf | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  /** Per channel, until when its motion is paused: the server refused it. */
  const motionPausedUntil = new Map<string, number>()
  /**
   * Per channel, the latest motion asked for during its pause, and the timer
   * that sends it when the pause ends. The last message of a burst is often the
   * one that clears something (a pointer leaving the page, a finished box, a
   * cursor-chat line going); dropped, the room keeps showing it.
   */
  const heldMotion = new Map<string, unknown>()
  const heldTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const wanted = () => [...joined.keys()].filter((ch) => !dropped.has(ch)).sort()

  const status = (ch: string): ChannelStatus => {
    if (dropped.has(ch)) return 'offline'
    if (live && carried.has(ch)) return 'live'
    return source || debounce ? 'connecting' : 'offline'
  }

  const each = (ch: string, run: (handlers: ChannelHandlers) => void) => {
    for (const handlers of [...(joined.get(ch) ?? [])]) {
      try {
        run(handlers)
      } catch (error) {
        console.warn('[realtime] channel handler threw:', error)
      }
    }
  }
  const announceStatus = () => {
    for (const ch of joined.keys()) {
      const now = status(ch)
      each(ch, (handlers) => handlers.onStatus?.(now))
    }
  }

  const closeSource = () => {
    if (!source) return
    source.onopen = source.onerror = source.onmessage = null
    source.close()
    source = null
    live = false
  }

  const open = (): void => {
    const channels = wanted()
    closeSource()
    carried = new Set(channels)
    if (channels.length === 0) {
      ladder.reset()
      announceStatus()
      return
    }
    const next = (createSource ?? defaultSource)(realtimeStreamPath(channels))
    if (!next) {
      announceStatus()
      return
    }
    source = next
    next.onopen = () => {
      ladder.reset()
      live = true
      announceStatus()
    }
    next.onerror = () => {
      // Take control, as the per-user hub does: EventSource retries only some
      // failures by itself, and a 4xx would close it for good. Our ladder backs
      // off with jitter instead of letting a fleet reconnect in step.
      closeSource()
      announceStatus()
      // Away, nothing is tried: the page's return reopens it (`resume`).
      if (wanted().length > 0 && isActive(lifecycle)) ladder.schedule(() => (isActive(lifecycle) ? open() : undefined))
    }
    next.onmessage = (message) => {
      let raw: unknown
      try {
        raw = JSON.parse(message.data)
      } catch {
        return
      }
      const parsed = realtimeFrameSchema.safeParse(raw)
      if (!parsed.success) return
      const frame = parsed.data
      if (frame.kind === 'welcome') {
        self = frame.self
        live = true
        for (const ch of carried) each(ch, (handlers) => handlers.onWelcome?.(frame.self))
        announceStatus()
      } else if (frame.kind === 'event') {
        if (carried.has(frame.ch)) each(frame.ch, (handlers) => handlers.onEvent(frame.event))
      } else {
        dropped.add(frame.ch)
        carried.delete(frame.ch)
        each(frame.ch, (handlers) => handlers.onClosed?.(frame.kind))
        each(frame.ch, (handlers) => handlers.onStatus?.('offline'))
        // The server ends a stream left with nothing; reopen for the rest, without it.
        schedule()
      }
    }
    announceStatus()
  }

  /** Reopen with the current channel set, once things settle. */
  const schedule = () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      const now = wanted()
      const same = now.length === carried.size && now.every((ch) => carried.has(ch))
      if (same && source) return
      ladder.cancel()
      open()
    }, debounceMs)
  }

  // Back from a lock, the camera or the network: reopen now, from the first
  // rung. A stream that is live is left alone.
  const stopListening = lifecycle.subscribe({
    resume: () => {
      if (wanted().length === 0 || (source && live) || debounce) return
      ladder.reset()
      open()
    },
  })

  function send(ch: string, msg: unknown, { motion = false }: ChannelPostOptions = {}): void {
    const pausedUntil = motionPausedUntil.get(ch) ?? 0
    if (motion && pausedUntil > Date.now()) {
      heldMotion.set(ch, msg)
      if (!heldTimers.has(ch)) {
        heldTimers.set(
          ch,
          setTimeout(() => {
            heldTimers.delete(ch)
            const held = heldMotion.get(ch)
            heldMotion.delete(ch)
            if (held !== undefined && joined.has(ch)) send(ch, held, { motion: true })
          }, pausedUntil - Date.now())
        )
      }
      return
    }
    const outcome = post(REALTIME_SEND_PATH, JSON.stringify({ ch, msg }), { keepalive: isGone(msg) })
    if (!motion || !outcome) return
    void outcome.then((result) => {
      if (result?.status !== 429) return
      const pause = Math.min(MAX_MOTION_PAUSE_MS, Math.max(MIN_MOTION_PAUSE_MS, result.retryAfterMs))
      motionPausedUntil.set(ch, Date.now() + pause)
    })
  }

  return {
    join(ch, handlers) {
      let set = joined.get(ch)
      if (!set) {
        set = new Set()
        joined.set(ch, set)
        dropped.delete(ch)
        schedule()
      }
      set.add(handlers)
      handlers.onStatus?.(status(ch))
      if (live && self && carried.has(ch)) handlers.onWelcome?.(self)
      let left = false
      return () => {
        if (left) return
        left = true
        const current = joined.get(ch)
        if (!current?.delete(handlers) || current.size > 0) return
        joined.delete(ch)
        dropped.delete(ch)
        schedule()
      }
    },
    send,
    status,
    dispose() {
      stopListening()
      if (debounce) clearTimeout(debounce)
      debounce = null
      ladder.cancel()
      closeSource()
      joined.clear()
      dropped.clear()
      motionPausedUntil.clear()
      for (const timer of heldTimers.values()) clearTimeout(timer)
      heldTimers.clear()
      heldMotion.clear()
      carried = new Set()
    },
  }
}

let shared: RealtimeConnection | null = null

/** The tab's connection, made on first use. */
export function getRealtimeConnection(): RealtimeConnection {
  return (shared ??= createRealtimeConnection())
}

/** Test seam: drop the tab's connection. */
export function __resetRealtimeConnection(): void {
  shared?.dispose()
  shared = null
}

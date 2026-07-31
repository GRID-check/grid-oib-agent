'use client'

/**
 * Watch a colleague's turn as it happens.
 *
 * Opens `GET /api/conversations/:id/live` **only while somebody else's turn is
 * running** and closes it the moment that turn ends. That gating is the whole
 * cost argument: a token stream is expensive relative to everything else in the
 * collaboration feature, so it exists for the ninety seconds it is worth
 * something and not one second longer. In particular:
 *
 *  - a private thread never opens it (there is nobody to watch);
 *  - the ASKER never opens it — they already have the frames on their own agent
 *    socket, and a second copy would render the answer twice;
 *  - a gated org never opens it (spec NF-8).
 *
 * **Degrades to today's behaviour, never to a broken one.** The server answers
 * `unsupported` when there is no shared cache tier to read frames from, and this
 * hook then reports nothing at all — the caller keeps rendering the static turn
 * banner it rendered before this existed, and the finished answer still arrives
 * over the ordinary persisted-message path (spec RT-4). The same is true of a
 * connection that drops mid-turn: what was on screen stays, and the real answer
 * replaces it when it lands.
 */

import { useEffect, useRef, useState } from 'react'
import { backoffWithJitter } from '@/shared/utils/backoff'
import {
  EMPTY_SPECTATED_TURN,
  reduceSpectatedFrame,
  type SpectatedTurnState,
} from '../lib/spectator-frames'

export interface UseSpectatedTurnOptions {
  conversationId: string | null
  /**
   * Whether a turn worth watching is running. The caller owns this decision
   * because it is the caller that knows whose turn it is — pass false for the
   * asker's own turn, for a private thread, and for a gated org.
   */
  enabled: boolean
}

export interface UseSpectatedTurnResult {
  /** The turn so far, or null when nothing is being watched. */
  turn: SpectatedTurnState | null
  /** True once frames are actually flowing — the caller swaps the banner for this. */
  live: boolean
}

/**
 * Reconnect policy for the per-turn stream.
 *
 * The server sends `retry: 2000`, so left alone the browser reconnects every two
 * seconds forever — in lockstep across every observer, since the interval is a
 * constant. Each attempt costs an authorization read and a fresh cache
 * subscriber server-side, which is exactly the herd this project's shared
 * backoff helper exists to prevent. Giving up after a few tries is safe: the
 * static banner and the persisted answer are both still there.
 */
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 20_000
const MAX_RECONNECTS = 4

/** What the SSE route sends. Anything else is ignored. */
type LiveEvent =
  | { kind: 'frame'; seq?: number; payload?: unknown }
  | { kind: 'unsupported' }
  | { kind: 'revoked' }

export function useSpectatedTurn(options: UseSpectatedTurnOptions): UseSpectatedTurnResult {
  const { conversationId, enabled } = options
  const [turn, setTurn] = useState<SpectatedTurnState | null>(null)
  const [live, setLive] = useState(false)

  /**
   * Frames the server has already sent us, so a reconnect that re-delivers one
   * cannot append the same tokens twice. Sequence numbers are monotonic per
   * conversation and assigned by the turn's owner, which is exactly what they are
   * there for.
   */
  const lastSeqRef = useRef(0)

  useEffect(() => {
    if (!enabled || !conversationId) {
      // Clear on the way out rather than on the way in: a stale half-written
      // answer must not be on screen when the next turn starts.
      setTurn(null)
      setLive(false)
      lastSeqRef.current = 0
      return
    }

    // A runtime with no `EventSource` (a test environment, a hardened embedder)
    // gets the fallback rather than a thrown constructor: this feature is a
    // luxury on top of a thread that works without it, and it must never be the
    // reason a conversation fails to render.
    if (typeof EventSource === 'undefined') {
      setTurn(null)
      setLive(false)
      return
    }

    let source: EventSource | null = null
    let cancelled = false
    /** Set once the stream says there is nothing more to come, so a late error
        on the closed source cannot start the ladder again. */
    let terminated = false
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    lastSeqRef.current = 0
    setTurn({ ...EMPTY_SPECTATED_TURN })
    setLive(false)

    const close = (): void => {
      source?.close()
      source = null
    }

    const connect = (): void => {
      if (cancelled) return
      reconnectTimer = null
      source = new EventSource(`/api/conversations/${encodeURIComponent(conversationId)}/live`)
      attachHandlers()
    }

    const attachHandlers = (): void => {
      if (!source) return

      source.onmessage = (event: MessageEvent<string>) => {
        if (cancelled) return
        let parsed: LiveEvent
        try {
          parsed = JSON.parse(event.data) as LiveEvent
        } catch {
          return
        }

        // A frame arrived, so this connection works. Reset the ladder — without
        // this, four failures spread over a long turn with healthy stretches
        // between them exhaust the budget and the observer loses the live view
        // for the rest of the turn. (The shared event hub had the same bug.)
        attempt = 0

        if (parsed.kind === 'unsupported' || parsed.kind === 'revoked') {
          // Nothing more is coming. Close so EventSource does not reconnect into a
          // stream that will answer the same way, and report nothing so the caller
          // falls back to the static banner.
          terminated = true
          close()
          setLive(false)
          setTurn(null)
          return
        }

        if (parsed.kind !== 'frame') return
        const seq = typeof parsed.seq === 'number' ? parsed.seq : 0
        // seq 0 means the publisher did not number this frame; take it rather than
        // dropping it, since the dedupe is an optimisation and a lost token is not.
        if (seq > 0 && seq <= lastSeqRef.current) return
        if (seq > 0) lastSeqRef.current = seq

        setTurn((previous) => {
          const next = reduceSpectatedFrame(previous ?? EMPTY_SPECTATED_TURN, parsed.payload)
          // "Live" the moment there is something to show, not merely on connect:
          // an empty bubble replacing the banner reads as a stall.
          if (next.answer || next.steps.length > 0 || next.waitingOn) setLive(true)
          return next
        })
      }

      /*
      A drop is not an error worth surfacing — what is already on screen stays
      until the persisted answer replaces it — but it must not be left to the
      browser either. EventSource reconnects on the server's `retry:` interval,
      a fixed 2s with no backoff and no jitter, and every attempt costs an
      authorization read plus a dedicated cache subscriber on the server. A
      rolling deploy or a brief cache blip therefore had every observer of every
      running turn retrying in lockstep, twice a second, for as long as the turn
      lasted. Reconnect on the shared backoff instead, and give up rather than
      hammer: the static banner and the persisted answer are both still there.
    */
      source.onerror = () => {
        if (cancelled || terminated) return
        close()
        if (attempt >= MAX_RECONNECTS) {
          setLive(false)
          return
        }
        const delay = backoffWithJitter(attempt, {
          baseMs: RECONNECT_BASE_MS,
          maxMs: RECONNECT_MAX_MS,
        })
        attempt += 1
        reconnectTimer = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      close()
    }
  }, [conversationId, enabled])

  return { turn, live }
}
